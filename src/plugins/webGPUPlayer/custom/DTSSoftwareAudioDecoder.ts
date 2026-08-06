import type { Microseconds } from '../MediaTime';
import type { CustomAudioChannelLayout } from './CustomAudioChannelLayout';
import { isSupportedCustomAudioSampleRate } from './CustomAudioSampleRate';
import { getQualifiedDTSChannelLayout } from './DTSChannelLayout';
import { requireMicroseconds } from './TimeMath';
import type { LibDCADECModule } from '../../../lib/libdcadec/libdcadec.mjs';

const DTS_MAXIMUM_PACKET_SIZE = 2 * 1024 * 1024;
const DTS_MAXIMUM_DECODED_FRAME_COUNT = 16_384;
const DTS_HIGH_SAMPLE_RATE_SUPPORTED_CHANNEL_COUNTS = new Set<number>([ 2, 6 ]);
const DTS_SUPPORTED_BITS_PER_SAMPLE = new Set<number>([ 16, 24 ]);
const DTS_FNV1A_OFFSET_BASIS = 2_166_136_261;
const DTS_FNV1A_PRIME = 16_777_619;

export const DTS_DECODER_NO_SYNC_STATUS = -5;

export const DTS_PROFILE_DIGITAL_SURROUND = 0x01;
export const DTS_PROFILE_DIGITAL_SURROUND_96_24 = 0x02;
export const DTS_PROFILE_DIGITAL_SURROUND_ES = 0x04;
export const DTS_PROFILE_HD_HIGH_RESOLUTION = 0x08;
export const DTS_PROFILE_HD_MASTER_AUDIO = 0x10;

export type DTSDecodedProfile =
    | typeof DTS_PROFILE_DIGITAL_SURROUND
    | typeof DTS_PROFILE_DIGITAL_SURROUND_96_24
    | typeof DTS_PROFILE_DIGITAL_SURROUND_ES
    | typeof DTS_PROFILE_HD_HIGH_RESOLUTION
    | typeof DTS_PROFILE_HD_MASTER_AUDIO;

export type DTSDecodedAudioOutput = Readonly<{
    bitsPerSample: 16 | 24
    channelData: readonly Float32Array[]
    channelLayout: CustomAudioChannelLayout
    channelMask: number
    filterStatus: number
    frameCount: number
    lossless: boolean
    mediaTimeMicroseconds: Microseconds
    parseStatus: number
    profile: DTSDecodedProfile
    sampleRate: number
}>;

/** Identifies libdcadec's stateful XLL synchronization wait. */
export class DTSDecoderSynchronizationError extends Error {
    public readonly status: number = DTS_DECODER_NO_SYNC_STATUS;

    public constructor() {
        super(`Bundled DTS decode is awaiting synchronization with status ${DTS_DECODER_NO_SYNC_STATUS}`);
        this.name = 'DTSDecoderSynchronizationError';
    }
}

type LibDCADECFunctionTable = {
    clear: (decoder: number) => void
    configurePacket: (decoder: number, size: number) => number
    create: () => number
    decodePacket: (decoder: number, size: number) => number
    destroy: (decoder: number) => void
    getBitsPerSample: (decoder: number) => number
    getChannelMask: (decoder: number) => number
    getFilterStatus: (decoder: number) => number
    getParseStatus: (decoder: number) => number
    getPlane: (decoder: number, plane: number) => number
    getProfile: (decoder: number) => number
    getSampleCount: (decoder: number) => number
    getSampleRate: (decoder: number) => number
    getVersion: () => number
};

export type DTSDecoderModuleFactory = () => Promise<LibDCADECModule>;

let defaultModulePromise: Promise<LibDCADECModule> | null = null;

async function loadDefaultDTSDecoderModule(): Promise<LibDCADECModule> {
    if (!defaultModulePromise) {
        defaultModulePromise = import('../../../lib/libdcadec/libdcadec.mjs').then(
            async moduleNamespace => moduleNamespace.default()
        );
    }
    return defaultModulePromise;
}

function requireFunction<FunctionType extends (...arguments_: never[]) => unknown>(
    module: LibDCADECModule,
    name: string,
    argumentCount: number
): FunctionType {
    const argumentTypes: 'number'[] = [];
    for (let argumentIndex = 0; argumentIndex < argumentCount; argumentIndex += 1) {
        argumentTypes.push('number');
    }
    const functionValue = module.cwrap(name, 'number', argumentTypes);
    if (typeof functionValue !== 'function') {
        throw new Error(`libdcadec export ${name} is unavailable`);
    }
    return functionValue as unknown as FunctionType;
}

function createFunctionTable(module: LibDCADECModule): LibDCADECFunctionTable {
    return {
        clear: requireFunction(module, 'jellyfin_dts_clear', 1),
        configurePacket: requireFunction(module, 'jellyfin_dts_configure_packet', 2),
        create: requireFunction(module, 'jellyfin_dts_create', 0),
        decodePacket: requireFunction(module, 'jellyfin_dts_decode_packet', 2),
        destroy: requireFunction(module, 'jellyfin_dts_destroy', 1),
        getBitsPerSample: requireFunction(module, 'jellyfin_dts_get_bits_per_sample', 1),
        getChannelMask: requireFunction(module, 'jellyfin_dts_get_channel_mask', 1),
        getFilterStatus: requireFunction(module, 'jellyfin_dts_get_filter_status', 1),
        getParseStatus: requireFunction(module, 'jellyfin_dts_get_parse_status', 1),
        getPlane: requireFunction(module, 'jellyfin_dts_get_plane', 2),
        getProfile: requireFunction(module, 'jellyfin_dts_get_profile', 1),
        getSampleCount: requireFunction(module, 'jellyfin_dts_get_sample_count', 1),
        getSampleRate: requireFunction(module, 'jellyfin_dts_get_sample_rate', 1),
        getVersion: requireFunction(module, 'jellyfin_dts_library_version', 0)
    };
}

function isSupportedProfile(profile: number): profile is DTSDecodedProfile {
    switch (profile) {
        case DTS_PROFILE_DIGITAL_SURROUND:
        case DTS_PROFILE_DIGITAL_SURROUND_96_24:
        case DTS_PROFILE_DIGITAL_SURROUND_ES:
        case DTS_PROFILE_HD_HIGH_RESOLUTION:
        case DTS_PROFILE_HD_MASTER_AUDIO:
            return true;
        default:
            return false;
    }
}

function isQualifiedDTSOutputEnvelope(
    profile: DTSDecodedProfile,
    sampleRate: number,
    channelCount: number
): boolean {
    if (sampleRate <= 96_000) {
        return true;
    }
    return profile === DTS_PROFILE_HD_MASTER_AUDIO
        && DTS_HIGH_SAMPLE_RATE_SUPPORTED_CHANNEL_COUNTS.has(channelCount);
}

function requirePositiveSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
    }
    return value;
}

function requireSuccessfulDTSDecodeStatus(decodeStatus: number): void {
    if (decodeStatus === DTS_DECODER_NO_SYNC_STATUS) {
        throw new DTSDecoderSynchronizationError();
    }
    if (decodeStatus < 0) {
        throw new Error(`Bundled DTS decode failed with status ${decodeStatus}`);
    }
}

/** Fingerprints exact integer PCM output in stable channel-major order. */
export function getDTSDecodedAudioFingerprint(output: DTSDecodedAudioOutput): number {
    const sampleScale = 2 ** (output.bitsPerSample - 1);
    let fingerprint = DTS_FNV1A_OFFSET_BASIS;
    for (const channel of output.channelData) {
        for (const sample of channel) {
            const integerSample = Math.round(sample * sampleScale);
            for (let byteIndex = 0; byteIndex < Int32Array.BYTES_PER_ELEMENT; byteIndex += 1) {
                fingerprint ^= (integerSample >>> (byteIndex * 8)) & 0xff;
                fingerprint = Math.imul(fingerprint, DTS_FNV1A_PRIME) >>> 0;
            }
        }
    }
    return fingerprint;
}

/** Owns one bounded libdcadec context inside the existing custom decode worker. */
export default class DTSSoftwareAudioDecoder {
    public readonly libraryVersion: number;

    private closed = false;
    private readonly decoder: number;
    private readonly functions: LibDCADECFunctionTable;
    private readonly module: LibDCADECModule;

    private constructor(module: LibDCADECModule) {
        this.module = module;
        this.functions = createFunctionTable(module);
        this.libraryVersion = requirePositiveSafeInteger(
            this.functions.getVersion(),
            'libdcadec version'
        );
        this.decoder = this.functions.create();
        if (!Number.isSafeInteger(this.decoder) || this.decoder <= 0) {
            throw new Error('Unable to create the bundled DTS decoder');
        }
    }

    /** Creates one decoder after lazy WebAssembly initialization. */
    public static async create(
        moduleFactory: DTSDecoderModuleFactory = loadDefaultDTSDecoderModule
    ): Promise<DTSSoftwareAudioDecoder> {
        const module = await moduleFactory();
        if (!(module.HEAPU8 instanceof Uint8Array)
            || !(module.HEAP32 instanceof Int32Array)) {
            throw new Error('The bundled DTS decoder memory views are unavailable');
        }
        return new DTSSoftwareAudioDecoder(module);
    }

    /** Decodes one Mediabunny-demuxed DTS access unit into owned planar PCM. */
    public decode(
        data: Uint8Array,
        mediaTimeMicroseconds: Microseconds
    ): DTSDecodedAudioOutput {
        this.requireOpen();
        requireMicroseconds(mediaTimeMicroseconds, 'DTS packet timestamp');
        if (!(data instanceof Uint8Array)
            || data.byteLength <= 0
            || data.byteLength > DTS_MAXIMUM_PACKET_SIZE) {
            throw new RangeError('DTS packet size is outside the bounded decoder envelope');
        }

        const packetPointer = this.functions.configurePacket(this.decoder, data.byteLength);
        if (!Number.isSafeInteger(packetPointer)
            || packetPointer <= 0
            || packetPointer + data.byteLength > this.module.HEAPU8.length) {
            throw new Error('Unable to allocate the bounded DTS packet buffer');
        }
        this.module.HEAPU8.set(data, packetPointer);
        const decodeStatus = this.functions.decodePacket(this.decoder, data.byteLength);
        requireSuccessfulDTSDecodeStatus(decodeStatus);

        const frameCount = this.functions.getSampleCount(this.decoder);
        if (!Number.isSafeInteger(frameCount)
            || frameCount <= 0
            || frameCount > DTS_MAXIMUM_DECODED_FRAME_COUNT) {
            throw new RangeError('Bundled DTS output frame count is invalid');
        }
        const sampleRate = this.functions.getSampleRate(this.decoder);
        if (!isSupportedCustomAudioSampleRate(sampleRate)) {
            throw new RangeError(
                `Bundled DTS output sample rate ${sampleRate} Hz is outside the supported range`
            );
        }
        const bitsPerSample = this.functions.getBitsPerSample(this.decoder);
        if (!DTS_SUPPORTED_BITS_PER_SAMPLE.has(bitsPerSample)) {
            throw new RangeError(`Bundled DTS output depth ${bitsPerSample} is unsupported`);
        }
        const profile = this.functions.getProfile(this.decoder);
        if (!isSupportedProfile(profile)) {
            throw new RangeError(`Bundled DTS decoded profile ${profile} is unsupported`);
        }
        const channelMask = this.functions.getChannelMask(this.decoder);
        const channelLayout = getQualifiedDTSChannelLayout(channelMask);
        if (!channelLayout) {
            throw new RangeError(
                `Bundled DTS channel mask 0x${channelMask.toString(16)} is unqualified`
            );
        }
        if (!isQualifiedDTSOutputEnvelope(
            profile,
            sampleRate,
            channelLayout.channelCount
        )) {
            throw new RangeError(
                'Bundled DTS high-sample-rate output is outside the supported Master Audio envelope'
            );
        }

        const channelData: Float32Array[] = [];
        const sampleScale = 2 ** (bitsPerSample - 1);
        for (let channelIndex = 0;
            channelIndex < channelLayout.channelCount;
            channelIndex += 1) {
            const planePointer = this.functions.getPlane(this.decoder, channelIndex);
            const firstSampleIndex = planePointer / Int32Array.BYTES_PER_ELEMENT;
            if (!Number.isSafeInteger(firstSampleIndex)
                || firstSampleIndex <= 0
                || firstSampleIndex + frameCount > this.module.HEAP32.length) {
                throw new RangeError('Bundled DTS output plane is outside decoder memory');
            }
            const sourcePlane = this.module.HEAP32.subarray(
                firstSampleIndex,
                firstSampleIndex + frameCount
            );
            const outputPlane = new Float32Array(frameCount);
            for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
                outputPlane[frameIndex] = sourcePlane[frameIndex] / sampleScale;
            }
            channelData.push(outputPlane);
        }

        const parseStatus = this.functions.getParseStatus(this.decoder);
        const filterStatus = this.functions.getFilterStatus(this.decoder);
        return {
            bitsPerSample: bitsPerSample as 16 | 24,
            channelData,
            channelLayout: channelLayout.layout,
            channelMask,
            filterStatus,
            frameCount,
            lossless: profile === DTS_PROFILE_HD_MASTER_AUDIO
                && parseStatus === 0
                && filterStatus === 0,
            mediaTimeMicroseconds,
            parseStatus,
            profile,
            sampleRate
        };
    }

    /** Clears inter-frame history before an out-of-order packet or seek. */
    public clear(): void {
        this.requireOpen();
        this.functions.clear(this.decoder);
    }

    /** Releases the decoder exactly once. */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.functions.destroy(this.decoder);
    }

    private requireOpen(): void {
        if (this.closed) {
            throw new Error('Bundled DTS decoder is closed');
        }
    }
}
