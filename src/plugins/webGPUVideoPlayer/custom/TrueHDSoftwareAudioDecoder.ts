import type { Microseconds } from '../MediaTime';
import type { FFmpegTrueHDModule } from '../../../lib/ffmpeg-truehd/ffmpeg-truehd.mjs';
import {
    getQualifiedCustomWaveChannelLayout,
    type QualifiedCustomWaveChannelLayout
} from './CustomWaveChannelLayout';
import { requireMicroseconds } from './TimeMath';

const TRUEHD_MAXIMUM_PACKET_SIZE = 2 * 1024 * 1024;
const TRUEHD_MAXIMUM_DECODED_FRAME_COUNT = 16_384;
const TRUEHD_MAXIMUM_OUTPUT_COUNT_PER_PACKET = 16;
const TRUEHD_SEND_STATUS_FATAL = -1;
const TRUEHD_SEND_STATUS_NO_OUTPUT = 0;
const TRUEHD_RECEIVE_STATUS_FATAL = -1;
const TRUEHD_RECEIVE_STATUS_NO_OUTPUT = 0;
const TRUEHD_AV_SAMPLE_FORMAT_S16 = 1;
const TRUEHD_AV_SAMPLE_FORMAT_S32 = 2;
const TRUEHD_ATMOS_PROFILE = 30;
const TRUEHD_FNV1A_OFFSET_BASIS = 2_166_136_261;
const TRUEHD_FNV1A_PRIME = 16_777_619;
const TRUEHD_QUALIFIED_CHANNEL_COUNTS = new Set<number>([ 2, 6, 8 ]);
const TRUEHD_QUALIFIED_SAMPLE_RATES = new Set<number>([ 48_000, 96_000, 192_000 ]);
const TRUEHD_SUPPORTED_BITS_PER_SAMPLE = new Set<number>([ 16, 20, 24 ]);

export const TRUEHD_CODEC_MLP = 0;
export const TRUEHD_CODEC_TRUEHD = 1;

export type TrueHDDecoderCodec = 'mlp' | 'truehd';
export type TrueHDDecodedAudioOutput = Readonly<{
    bitsPerSample: 16 | 20 | 24
    channelData: readonly Float32Array[]
    channelLayout: QualifiedCustomWaveChannelLayout['layout']
    channelMask: number
    codec: TrueHDDecoderCodec
    containsAtmosMetadata: boolean
    frameCount: number
    losslessChannelBed: true
    mediaTimeMicroseconds: Microseconds
    objectAudioRendered: false
    pcmFingerprint: number
    sampleRate: 48_000 | 96_000 | 192_000
}>;

type FFmpegTrueHDFunctionTable = {
    clear: (decoder: number) => void
    configurePacket: (decoder: number, size: number) => number
    create: (codec: number) => number
    destroy: (decoder: number) => void
    getBitsPerRawSample: (decoder: number) => number
    getBytesPerSample: (decoder: number) => number
    getChannelCount: (decoder: number) => number
    getChannelMask: (decoder: number) => number
    getData: (decoder: number) => number
    getProfile: (decoder: number) => number
    getPTS: (decoder: number) => number
    getSampleCount: (decoder: number) => number
    getSampleFormat: (decoder: number) => number
    getSampleRate: (decoder: number) => number
    getVersion: () => number
    receiveFrame: (decoder: number) => number
    sendPacket: (decoder: number, mediaTimeMicroseconds: number) => number
};

export type TrueHDDecoderModuleFactory = () => Promise<FFmpegTrueHDModule>;

let defaultModulePromise: Promise<FFmpegTrueHDModule> | null = null;

async function loadDefaultTrueHDDecoderModule(): Promise<FFmpegTrueHDModule> {
    if (!defaultModulePromise) {
        defaultModulePromise = import(
            '../../../lib/ffmpeg-truehd/ffmpeg-truehd.mjs'
        ).then(async moduleNamespace => moduleNamespace.default());
    }
    return defaultModulePromise;
}

function requireFunction<FunctionType extends (...arguments_: never[]) => unknown>(
    module: FFmpegTrueHDModule,
    name: string,
    argumentCount: number
): FunctionType {
    const argumentTypes: 'number'[] = [];
    for (let argumentIndex = 0; argumentIndex < argumentCount; argumentIndex += 1) {
        argumentTypes.push('number');
    }
    const functionValue = module.cwrap(name, 'number', argumentTypes);
    if (typeof functionValue !== 'function') {
        throw new Error(`FFmpeg TrueHD export ${name} is unavailable`);
    }
    return functionValue as unknown as FunctionType;
}

function createFunctionTable(
    module: FFmpegTrueHDModule
): FFmpegTrueHDFunctionTable {
    return {
        clear: requireFunction(module, 'jellyfin_truehd_clear', 1),
        configurePacket: requireFunction(module, 'jellyfin_truehd_configure_packet', 2),
        create: requireFunction(module, 'jellyfin_truehd_create', 1),
        destroy: requireFunction(module, 'jellyfin_truehd_destroy', 1),
        getBitsPerRawSample: requireFunction(
            module,
            'jellyfin_truehd_get_bits_per_raw_sample',
            1
        ),
        getBytesPerSample: requireFunction(
            module,
            'jellyfin_truehd_get_bytes_per_sample',
            1
        ),
        getChannelCount: requireFunction(module, 'jellyfin_truehd_get_channel_count', 1),
        getChannelMask: requireFunction(module, 'jellyfin_truehd_get_channel_mask', 1),
        getData: requireFunction(module, 'jellyfin_truehd_get_interleaved_data', 1),
        getProfile: requireFunction(module, 'jellyfin_truehd_get_profile', 1),
        getPTS: requireFunction(module, 'jellyfin_truehd_get_pts', 1),
        getSampleCount: requireFunction(module, 'jellyfin_truehd_get_sample_count', 1),
        getSampleFormat: requireFunction(module, 'jellyfin_truehd_get_sample_format', 1),
        getSampleRate: requireFunction(module, 'jellyfin_truehd_get_sample_rate', 1),
        getVersion: requireFunction(module, 'jellyfin_truehd_library_version', 0),
        receiveFrame: requireFunction(module, 'jellyfin_truehd_receive_frame', 1),
        sendPacket: requireFunction(module, 'jellyfin_truehd_send_packet', 2)
    };
}

function requirePositiveSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
    }
    return value;
}

function getCodecID(codec: TrueHDDecoderCodec): number {
    switch (codec) {
        case 'mlp':
            return TRUEHD_CODEC_MLP;
        case 'truehd':
            return TRUEHD_CODEC_TRUEHD;
    }
}

function getPCMByteFingerprint(data: Uint8Array): number {
    let fingerprint = TRUEHD_FNV1A_OFFSET_BASIS;
    for (const byte of data) {
        fingerprint ^= byte;
        fingerprint = Math.imul(fingerprint, TRUEHD_FNV1A_PRIME) >>> 0;
    }
    return fingerprint;
}

/** Owns one bounded FFmpeg TrueHD or MLP decoder in the custom decode worker. */
export default class TrueHDSoftwareAudioDecoder {
    public readonly libraryVersion: number;

    private closed = false;
    private readonly codec: TrueHDDecoderCodec;
    private readonly decoder: number;
    private readonly functions: FFmpegTrueHDFunctionTable;
    private readonly module: FFmpegTrueHDModule;

    private constructor(module: FFmpegTrueHDModule, codec: TrueHDDecoderCodec) {
        this.module = module;
        this.functions = createFunctionTable(module);
        this.libraryVersion = requirePositiveSafeInteger(
            this.functions.getVersion(),
            'FFmpeg libavcodec version'
        );
        this.codec = codec;
        this.decoder = this.functions.create(getCodecID(codec));
        if (!Number.isSafeInteger(this.decoder) || this.decoder <= 0) {
            throw new Error(`Unable to create the bundled ${codec} decoder`);
        }
    }

    /** Creates one decoder after lazy WebAssembly initialization. */
    public static async create(
        codec: TrueHDDecoderCodec = 'truehd',
        moduleFactory: TrueHDDecoderModuleFactory = loadDefaultTrueHDDecoderModule
    ): Promise<TrueHDSoftwareAudioDecoder> {
        const module = await moduleFactory();
        if (!(module.HEAPU8 instanceof Uint8Array)
            || !(module.HEAP16 instanceof Int16Array)
            || !(module.HEAP32 instanceof Int32Array)) {
            throw new Error('The bundled TrueHD decoder memory views are unavailable');
        }
        return new TrueHDSoftwareAudioDecoder(module, codec);
    }

    /** Decodes one Mediabunny-demuxed access unit into zero or more owned PCM blocks. */
    public decode(
        data: Uint8Array,
        mediaTimeMicroseconds: Microseconds
    ): readonly TrueHDDecodedAudioOutput[] {
        this.requireOpen();
        requireMicroseconds(mediaTimeMicroseconds, 'TrueHD packet timestamp');
        if (!(data instanceof Uint8Array)
            || data.byteLength <= 0
            || data.byteLength > TRUEHD_MAXIMUM_PACKET_SIZE) {
            throw new RangeError('TrueHD packet size is outside the bounded decoder envelope');
        }

        const packetPointer = this.functions.configurePacket(this.decoder, data.byteLength);
        if (!Number.isSafeInteger(packetPointer)
            || packetPointer <= 0
            || packetPointer + data.byteLength > this.module.HEAPU8.length) {
            throw new Error('Unable to allocate the bounded TrueHD packet buffer');
        }
        this.module.HEAPU8.set(data, packetPointer);
        const sendStatus = this.functions.sendPacket(
            this.decoder,
            mediaTimeMicroseconds
        );
        if (sendStatus === TRUEHD_SEND_STATUS_NO_OUTPUT) {
            return [];
        }
        if (sendStatus <= TRUEHD_SEND_STATUS_FATAL) {
            throw new Error(`Bundled TrueHD packet submission failed with status ${sendStatus}`);
        }

        const outputs: TrueHDDecodedAudioOutput[] = [];
        for (let outputIndex = 0;
            outputIndex < TRUEHD_MAXIMUM_OUTPUT_COUNT_PER_PACKET;
            outputIndex += 1) {
            const receiveStatus = this.functions.receiveFrame(this.decoder);
            if (receiveStatus === TRUEHD_RECEIVE_STATUS_NO_OUTPUT) {
                return outputs;
            }
            if (receiveStatus <= TRUEHD_RECEIVE_STATUS_FATAL) {
                throw new Error(
                    `Bundled TrueHD frame receive failed with status ${receiveStatus}`
                );
            }
            outputs.push(this.copyCurrentOutput(mediaTimeMicroseconds));
        }
        throw new RangeError('Bundled TrueHD output exceeded the per-packet bound');
    }

    /** Clears inter-frame prediction state before a source change or seek. */
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

    private copyCurrentOutput(
        fallbackMediaTimeMicroseconds: Microseconds
    ): TrueHDDecodedAudioOutput {
        const frameCount = this.functions.getSampleCount(this.decoder);
        if (!Number.isSafeInteger(frameCount)
            || frameCount <= 0
            || frameCount > TRUEHD_MAXIMUM_DECODED_FRAME_COUNT) {
            throw new RangeError('Bundled TrueHD output frame count is invalid');
        }
        const sampleRate = this.functions.getSampleRate(this.decoder);
        if (!TRUEHD_QUALIFIED_SAMPLE_RATES.has(sampleRate)) {
            throw new RangeError(
                `Bundled TrueHD output sample rate ${sampleRate} Hz is unqualified`
            );
        }
        const bitsPerSample = this.functions.getBitsPerRawSample(this.decoder);
        if (!TRUEHD_SUPPORTED_BITS_PER_SAMPLE.has(bitsPerSample)) {
            throw new RangeError(
                `Bundled TrueHD output depth ${bitsPerSample} is unsupported`
            );
        }
        const channelCount = this.functions.getChannelCount(this.decoder);
        const channelMask = this.functions.getChannelMask(this.decoder) >>> 0;
        const qualifiedLayout = getQualifiedCustomWaveChannelLayout(channelMask);
        if (!qualifiedLayout
            || qualifiedLayout.channelCount !== channelCount
            || !TRUEHD_QUALIFIED_CHANNEL_COUNTS.has(channelCount)) {
            throw new RangeError(
                `Bundled TrueHD channel mask 0x${channelMask.toString(16)} is unqualified`
            );
        }

        const sampleFormat = this.functions.getSampleFormat(this.decoder);
        const bytesPerSample = this.functions.getBytesPerSample(this.decoder);
        let expectedBytesPerSample = 0;
        switch (sampleFormat) {
            case TRUEHD_AV_SAMPLE_FORMAT_S16:
                expectedBytesPerSample = Int16Array.BYTES_PER_ELEMENT;
                break;
            case TRUEHD_AV_SAMPLE_FORMAT_S32:
                expectedBytesPerSample = Int32Array.BYTES_PER_ELEMENT;
                break;
        }
        if (bytesPerSample !== expectedBytesPerSample || expectedBytesPerSample === 0) {
            throw new RangeError(
                `Bundled TrueHD sample format ${sampleFormat} is unsupported`
            );
        }

        const interleavedSampleCount = frameCount * channelCount;
        const byteLength = interleavedSampleCount * bytesPerSample;
        const dataPointer = this.functions.getData(this.decoder);
        if (!Number.isSafeInteger(dataPointer)
            || dataPointer <= 0
            || dataPointer + byteLength > this.module.HEAPU8.length
            || dataPointer % bytesPerSample !== 0) {
            throw new RangeError('Bundled TrueHD output is outside decoder memory');
        }

        const outputBytes = new Uint8Array(byteLength);
        outputBytes.set(this.module.HEAPU8.subarray(dataPointer, dataPointer + byteLength));
        const channelData: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            channelData.push(new Float32Array(frameCount));
        }
        if (sampleFormat === TRUEHD_AV_SAMPLE_FORMAT_S16) {
            const firstSampleIndex = dataPointer / Int16Array.BYTES_PER_ELEMENT;
            const sourceSamples = this.module.HEAP16.subarray(
                firstSampleIndex,
                firstSampleIndex + interleavedSampleCount
            );
            this.copyInterleavedPCM(sourceSamples, channelData, 2 ** 15);
        } else {
            const firstSampleIndex = dataPointer / Int32Array.BYTES_PER_ELEMENT;
            const sourceSamples = this.module.HEAP32.subarray(
                firstSampleIndex,
                firstSampleIndex + interleavedSampleCount
            );
            this.copyInterleavedPCM(sourceSamples, channelData, 2 ** 31);
        }

        const decodedPTS = this.functions.getPTS(this.decoder);
        const mediaTimeMicroseconds = Number.isSafeInteger(decodedPTS)
            && decodedPTS >= 0 ?
            requireMicroseconds(decodedPTS, 'Decoded TrueHD timestamp') :
            fallbackMediaTimeMicroseconds;
        return {
            bitsPerSample: bitsPerSample as 16 | 20 | 24,
            channelData,
            channelLayout: qualifiedLayout.layout,
            channelMask,
            codec: this.codec,
            containsAtmosMetadata: this.functions.getProfile(this.decoder)
                === TRUEHD_ATMOS_PROFILE,
            frameCount,
            losslessChannelBed: true,
            mediaTimeMicroseconds,
            objectAudioRendered: false,
            pcmFingerprint: getPCMByteFingerprint(outputBytes),
            sampleRate: sampleRate as 48_000 | 96_000 | 192_000
        };
    }

    private copyInterleavedPCM(
        sourceSamples: Int16Array | Int32Array,
        channelData: readonly Float32Array[],
        sampleScale: number
    ): void {
        const channelCount = channelData.length;
        const frameCount = channelData[0]?.length ?? 0;
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
            const interleavedFrameOffset = frameIndex * channelCount;
            for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
                channelData[channelIndex][frameIndex] =
                    sourceSamples[interleavedFrameOffset + channelIndex] / sampleScale;
            }
        }
    }

    private requireOpen(): void {
        if (this.closed) {
            throw new Error('Bundled TrueHD decoder is closed');
        }
    }
}
