import {
    createRawHDRCapabilityFixture,
    RAW_HDR_CAPABILITY_FIXTURE_CODED_HEIGHT,
    RAW_HDR_CAPABILITY_FIXTURE_CODED_WIDTH
} from './RawHDRCapabilityFixtures';
import H264ProfileCapabilityProbe, {
    type H264ProfileCapabilities
} from './H264ProfileCapabilities';
import {
    probeBundledHEVCExactCapabilities,
    type BundledHEVCExactCapabilities
} from './HEVCExactCapabilityProbe';
import { createHEVCExactCapabilityWorkerTierRequests } from './HEVCExactCapabilityFixtures';

export const CUSTOM_VIDEO_CODECS = [ 'h264', 'hevc', 'vp8', 'vp9', 'av1' ] as const;
export const CUSTOM_WEB_CODECS_AUDIO_CODECS = [ 'aac', 'opus', 'flac', 'mp3', 'vorbis' ] as const;
export const CUSTOM_BUNDLED_AUDIO_CODECS = [ 'ac3', 'eac3' ] as const;
export const CUSTOM_AUDIO_CODECS = [
    ...CUSTOM_WEB_CODECS_AUDIO_CODECS,
    ...CUSTOM_BUNDLED_AUDIO_CODECS
] as const;
export const CUSTOM_RAW_HDR_VIDEO_CODECS = [ 'hevc', 'vp9', 'av1' ] as const;
export const CUSTOM_NATIVE_VIDEO_BIT_DEPTH = 8;
export const CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT = 1_080;
export const CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH = 1_920;
export const CUSTOM_RAW_HDR_VIDEO_MAXIMUM_FRAMES_PER_SECOND = 24;

export type CustomVideoCodec = typeof CUSTOM_VIDEO_CODECS[number];
export type CustomAudioCodec = typeof CUSTOM_AUDIO_CODECS[number];
export type CustomBundledAudioCodec = typeof CUSTOM_BUNDLED_AUDIO_CODECS[number];
export type CustomRawHDRVideoCodec = typeof CUSTOM_RAW_HDR_VIDEO_CODECS[number];
export type CustomDecodeCodec = CustomAudioCodec | CustomVideoCodec;
export type CustomDecodeCapabilityStatus = 'supported' | 'unsupported' | 'unknown';
export type CustomDecodeCapabilityReason =
    | 'api-unavailable'
    | 'build-disabled'
    | 'bundled-software-decoder'
    | 'config-supported'
    | 'config-unsupported'
    | 'probe-exception'
    | 'probe-timeout';

export type CustomDecodeCodecCapability<Codec extends CustomDecodeCodec> = {
    codec: Codec
    codecString: string
    reason: CustomDecodeCapabilityReason
    status: CustomDecodeCapabilityStatus
};

export type CustomDecodeProbeReason =
    | 'api-unavailable'
    | 'complete'
    | 'partial-api'
    | 'probe-exceptions';

export type CustomDecodeProbeTelemetry = {
    audioProbeCount: number
    bundledAudioCodecCount: number
    rawHDRVideoProbeCount: number
    reason: CustomDecodeProbeReason
    supportedAudioCodecCount: number
    supportedRawHDRVideoCodecCount: number
    supportedVideoCodecCount: number
    unknownAudioCodecCount: number
    unknownVideoCodecCount: number
    videoProbeCount: number
};

export type CustomDecodeCapabilities = {
    audio: Readonly<Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>>
    bundledHEVC?: BundledHEVCExactCapabilities
    h264Profiles?: H264ProfileCapabilities
    rawHDRVideo: Readonly<Record<CustomRawHDRVideoCodec, CustomRawHDRVideoCodecCapability>>
    telemetry: Readonly<CustomDecodeProbeTelemetry>
    video: Readonly<Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>>
};

export type CustomRawHDRVideoCapabilityReason =
    | 'api-unavailable'
    | 'bundled-software-decoder'
    | 'config-unsupported'
    | 'output-copy-supported'
    | 'output-copy-unsupported'
    | 'probe-exception'
    | 'probe-timeout'
    | 'runtime-insufficient'
    | 'runtime-unavailable';

export type CustomRawHDRVideoCodecCapability = {
    bitDepth: 10
    codec: CustomRawHDRVideoCodec
    codecString: string
    format: 'I420P10'
    maximumCodedHeight: number
    maximumCodedWidth: number
    reason: CustomRawHDRVideoCapabilityReason
    status: CustomDecodeCapabilityStatus
};

export type RawHDRVideoOutputProbeRequest = {
    codec: CustomRawHDRVideoCodec
    configuration: VideoDecoderConfig
    encodedKeyFrame: Uint8Array
    expectedCodedHeight: number
    expectedCodedWidth: number
    expectedDecodedFrameFingerprint: number
    expectedFormat: 'I420P10'
};

export type RawHDRVideoOutputProbe = (
    probeRequest: RawHDRVideoOutputProbeRequest
) => Promise<boolean>;

type RawHDRVideoFrameCopyToOptions = Omit<VideoFrameCopyToOptions, 'format'> & {
    format: 'I420P10'
};

export type WebCodecsCapabilityEnvironment = {
    audioDecoder?: Pick<typeof AudioDecoder, 'isConfigSupported'> | null
    bundledAC3SoftwareDecoder?: boolean
    bundledHEVCExactProbe?: { probe: () => Promise<BundledHEVCExactCapabilities> } | null
    h264ProfileProbe?: Pick<H264ProfileCapabilityProbe, 'probe'> | null
    rawHDRVideoOutputProbe?: RawHDRVideoOutputProbe | null
    videoDecoder?: Pick<typeof VideoDecoder, 'isConfigSupported'> | null
};

type VideoProbeDefinition = {
    codec: CustomVideoCodec
    config: VideoDecoderConfig
};

type AudioProbeDefinition = {
    codec: Exclude<CustomAudioCodec, CustomBundledAudioCodec>
    config: AudioDecoderConfig
};

type BundledAudioCodecDefinition = {
    codec: CustomBundledAudioCodec
    codecString: 'ac-3' | 'ec-3'
};

type RawHDRVideoProbeDefinition = {
    codec: CustomRawHDRVideoCodec
    config: VideoDecoderConfig
    encodedKeyFrame: Uint8Array
    expectedDecodedFrameFingerprint: number
};

type DecoderCapabilityAPI<Config> = {
    isConfigSupported: (config: Config) => Promise<{ supported?: boolean }>
};

type CodecProbeDefinition<Codec extends CustomDecodeCodec, Config extends { codec: string }> = {
    codec: Codec
    config: Config
};

const REPRESENTATIVE_RAW_HDR_VIDEO_WIDTH = RAW_HDR_CAPABILITY_FIXTURE_CODED_WIDTH;
const REPRESENTATIVE_RAW_HDR_VIDEO_HEIGHT = RAW_HDR_CAPABILITY_FIXTURE_CODED_HEIGHT;
const RAW_HDR_OUTPUT_PROBE_TIMEOUT_MILLISECONDS = 2_000;
const RAW_HDR_OUTPUT_PROBE_WARMUP_FRAME_COUNT = 1;
const RAW_HDR_OUTPUT_PROBE_MEASURED_FRAME_COUNT = 4;
const RAW_HDR_OUTPUT_PROBE_MINIMUM_FRAMES_PER_SECOND =
    CUSTOM_RAW_HDR_VIDEO_MAXIMUM_FRAMES_PER_SECOND;
const RAW_HDR_OUTPUT_PROBE_FRAME_INTERVAL_MICROSECONDS = 41_667;
const RAW_HDR_FINGERPRINT_COLUMN_SAMPLE_COUNT = 64;
const RAW_HDR_FINGERPRINT_ROW_SAMPLE_COUNT = 36;
const RAW_HDR_FNV1A_OFFSET_BASIS = 2_166_136_261;
const RAW_HDR_FNV1A_PRIME = 16_777_619;
const HEVC_MAIN10_BLACK_DECODED_FRAME_FINGERPRINT = 3_873_342_648;
const CAPABILITY_PROBE_TIMEOUT = Symbol('custom-decode-capability-probe-timeout');
const defaultH264ProfileCapabilityProbe = new H264ProfileCapabilityProbe();
const defaultBundledHEVCExactProbe = {
    probe: probeBundledHEVCExactCapabilities
};

function waitForCapabilityProbe<Value>(
    promise: Promise<Value>
): Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT> {
    return new Promise<Value | typeof CAPABILITY_PROBE_TIMEOUT>((resolve, reject) => {
        let settled = false;
        const timeout = globalThis.setTimeout((): void => {
            if (settled) {
                return;
            }
            settled = true;
            resolve(CAPABILITY_PROBE_TIMEOUT);
        }, RAW_HDR_OUTPUT_PROBE_TIMEOUT_MILLISECONDS);
        promise.then((value: Value): void => {
            if (settled) {
                return;
            }
            settled = true;
            globalThis.clearTimeout(timeout);
            resolve(value);
        }, (error: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            globalThis.clearTimeout(timeout);
            reject(error);
        });
    });
}
const REPRESENTATIVE_AUDIO_SAMPLE_RATE = 48_000;
const REPRESENTATIVE_AUDIO_CHANNEL_COUNT = 2;
const REPRESENTATIVE_FLAC_STREAM_INFO_BYTES = 34;

const VIDEO_PROBE_DEFINITIONS: readonly VideoProbeDefinition[] = [
    {
        codec: 'h264',
        config: {
            codec: 'avc1.640028',
            codedHeight: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT,
            codedWidth: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH,
            hardwareAcceleration: 'no-preference',
            optimizeForLatency: true
        }
    },
    {
        codec: 'hevc',
        config: {
            codec: 'hvc1.1.6.L120.B0',
            codedHeight: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT,
            codedWidth: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH,
            hardwareAcceleration: 'no-preference',
            optimizeForLatency: true
        }
    },
    {
        codec: 'vp8',
        config: {
            codec: 'vp8',
            codedHeight: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT,
            codedWidth: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH,
            hardwareAcceleration: 'no-preference',
            optimizeForLatency: true
        }
    },
    {
        codec: 'vp9',
        config: {
            codec: 'vp09.00.10.08',
            codedHeight: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT,
            codedWidth: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH,
            hardwareAcceleration: 'no-preference',
            optimizeForLatency: true
        }
    },
    {
        codec: 'av1',
        config: {
            codec: 'av01.0.08M.08',
            codedHeight: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT,
            codedWidth: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH,
            hardwareAcceleration: 'no-preference',
            optimizeForLatency: true
        }
    }
];

const AUDIO_PROBE_DEFINITIONS: readonly AudioProbeDefinition[] = [
    {
        codec: 'aac',
        config: {
            codec: 'mp4a.40.2',
            numberOfChannels: REPRESENTATIVE_AUDIO_CHANNEL_COUNT,
            sampleRate: REPRESENTATIVE_AUDIO_SAMPLE_RATE
        }
    },
    {
        codec: 'opus',
        config: {
            codec: 'opus',
            numberOfChannels: REPRESENTATIVE_AUDIO_CHANNEL_COUNT,
            sampleRate: REPRESENTATIVE_AUDIO_SAMPLE_RATE
        }
    },
    {
        codec: 'flac',
        config: {
            codec: 'flac',
            // WebCodecs requires a STREAMINFO description to probe FLAC
            description: new Uint8Array(REPRESENTATIVE_FLAC_STREAM_INFO_BYTES),
            numberOfChannels: REPRESENTATIVE_AUDIO_CHANNEL_COUNT,
            sampleRate: REPRESENTATIVE_AUDIO_SAMPLE_RATE
        }
    },
    {
        codec: 'mp3',
        config: {
            codec: 'mp3',
            numberOfChannels: REPRESENTATIVE_AUDIO_CHANNEL_COUNT,
            sampleRate: REPRESENTATIVE_AUDIO_SAMPLE_RATE
        }
    },
    {
        codec: 'vorbis',
        config: {
            codec: 'vorbis',
            // Decoder availability can be probed with a non-empty description;
            // the selected track supplies its exact private data before decode
            description: new Uint8Array([0]),
            numberOfChannels: REPRESENTATIVE_AUDIO_CHANNEL_COUNT,
            sampleRate: REPRESENTATIVE_AUDIO_SAMPLE_RATE
        }
    }
];
const BUNDLED_AUDIO_CODEC_DEFINITIONS: readonly BundledAudioCodecDefinition[] = [
    { codec: 'ac3', codecString: 'ac-3' },
    { codec: 'eac3', codecString: 'ec-3' }
];

const VP9_PROFILE_2_FIXTURE = createRawHDRCapabilityFixture('vp9');
const AV1_MAIN_10_FIXTURE = createRawHDRCapabilityFixture('av1');
const HEVC_MAIN10_FIXTURE = createHEVCExactCapabilityWorkerTierRequests().find(
    fixture => fixture.tier === 'main10-4k'
);
if (!HEVC_MAIN10_FIXTURE) {
    throw new Error('The HEVC Main10 capability fixture is unavailable');
}
const RAW_HDR_VIDEO_PROBE_DEFINITIONS: readonly RawHDRVideoProbeDefinition[] = [
    {
        codec: 'hevc',
        config: {
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: REPRESENTATIVE_RAW_HDR_VIDEO_HEIGHT,
            codedWidth: REPRESENTATIVE_RAW_HDR_VIDEO_WIDTH,
            hardwareAcceleration: 'prefer-software',
            optimizeForLatency: true
        },
        encodedKeyFrame: new Uint8Array(HEVC_MAIN10_FIXTURE.accessUnit),
        expectedDecodedFrameFingerprint: HEVC_MAIN10_BLACK_DECODED_FRAME_FINGERPRINT
    },
    {
        codec: 'vp9',
        config: {
            codec: 'vp09.02.10.10',
            codedHeight: REPRESENTATIVE_RAW_HDR_VIDEO_HEIGHT,
            codedWidth: REPRESENTATIVE_RAW_HDR_VIDEO_WIDTH,
            hardwareAcceleration: 'prefer-software',
            optimizeForLatency: true
        },
        encodedKeyFrame: VP9_PROFILE_2_FIXTURE.encodedKeyFrame,
        expectedDecodedFrameFingerprint: VP9_PROFILE_2_FIXTURE.decodedFrameFingerprint
    },
    {
        codec: 'av1',
        config: {
            codec: 'av01.0.08M.10',
            codedHeight: REPRESENTATIVE_RAW_HDR_VIDEO_HEIGHT,
            codedWidth: REPRESENTATIVE_RAW_HDR_VIDEO_WIDTH,
            hardwareAcceleration: 'prefer-software',
            optimizeForLatency: true
        },
        encodedKeyFrame: AV1_MAIN_10_FIXTURE.encodedKeyFrame,
        expectedDecodedFrameFingerprint: AV1_MAIN_10_FIXTURE.decodedFrameFingerprint
    }
];

function mixRawHDRFingerprintValue(fingerprint: number, value: number): number {
    let mixedFingerprint = Math.imul(
        (fingerprint ^ (value & 0xFF)) >>> 0,
        RAW_HDR_FNV1A_PRIME
    ) >>> 0;
    mixedFingerprint = Math.imul(
        (mixedFingerprint ^ ((value >>> 8) & 0xFF)) >>> 0,
        RAW_HDR_FNV1A_PRIME
    ) >>> 0;
    return mixedFingerprint;
}

function mixRawHDRPlaneFingerprint(
    fingerprint: number,
    destination: Uint8Array,
    layout: PlaneLayout,
    width: number,
    height: number
): number | null {
    const minimumStride = width * Uint16Array.BYTES_PER_ELEMENT;
    const finalByteOffset = layout.offset
        + ((height - 1) * layout.stride)
        + minimumStride;
    if (!Number.isSafeInteger(layout.offset)
        || layout.offset < 0
        || !Number.isSafeInteger(layout.stride)
        || layout.stride < minimumStride
        || finalByteOffset > destination.byteLength) {
        return null;
    }

    let mixedFingerprint = mixRawHDRFingerprintValue(fingerprint, width);
    mixedFingerprint = mixRawHDRFingerprintValue(mixedFingerprint, height);
    for (
        let rowSampleIndex = 0;
        rowSampleIndex < RAW_HDR_FINGERPRINT_ROW_SAMPLE_COUNT;
        rowSampleIndex += 1
    ) {
        const rowIndex = Math.floor(
            rowSampleIndex * (height - 1) / (RAW_HDR_FINGERPRINT_ROW_SAMPLE_COUNT - 1)
        );
        for (
            let columnSampleIndex = 0;
            columnSampleIndex < RAW_HDR_FINGERPRINT_COLUMN_SAMPLE_COUNT;
            columnSampleIndex += 1
        ) {
            const columnIndex = Math.floor(
                columnSampleIndex * (width - 1)
                    / (RAW_HDR_FINGERPRINT_COLUMN_SAMPLE_COUNT - 1)
            );
            const byteOffset = layout.offset
                + (rowIndex * layout.stride)
                + (columnIndex * Uint16Array.BYTES_PER_ELEMENT);
            const sample = destination[byteOffset]
                | (destination[byteOffset + 1] << 8);
            mixedFingerprint = mixRawHDRFingerprintValue(mixedFingerprint, sample);
        }
    }
    return mixedFingerprint;
}

function createRawHDRFrameFingerprint(
    destination: Uint8Array,
    layouts: readonly PlaneLayout[],
    width: number,
    height: number
): number | null {
    if (layouts.length !== 3) {
        return null;
    }
    const chromaWidth = Math.ceil(width / 2);
    const chromaHeight = Math.ceil(height / 2);
    const lumaFingerprint = mixRawHDRPlaneFingerprint(
        RAW_HDR_FNV1A_OFFSET_BASIS,
        destination,
        layouts[0],
        width,
        height
    );
    if (lumaFingerprint === null) {
        return null;
    }
    const chromaBlueFingerprint = mixRawHDRPlaneFingerprint(
        lumaFingerprint,
        destination,
        layouts[1],
        chromaWidth,
        chromaHeight
    );
    if (chromaBlueFingerprint === null) {
        return null;
    }
    return mixRawHDRPlaneFingerprint(
        chromaBlueFingerprint,
        destination,
        layouts[2],
        chromaWidth,
        chromaHeight
    );
}

/** Creates the bounded multi-frame raw HDR output and throughput qualification. */
export function createRawHDRVideoOutputProbe(): RawHDRVideoOutputProbe | null {
    if (typeof globalThis.VideoDecoder !== 'function'
        || typeof globalThis.EncodedVideoChunk !== 'function') {
        return null;
    }

    return async (probeRequest: RawHDRVideoOutputProbeRequest): Promise<boolean> => {
        let acceptingFrame = true;
        let pendingFrameReject: ((reason: unknown) => void) | null = null;
        let pendingFrameResolve: ((frame: VideoFrame) => void) | null = null;
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        const decoder = new VideoDecoder({
            error: (error: DOMException): void => pendingFrameReject?.(error),
            output: (frame: VideoFrame): void => {
                const resolveFrame = pendingFrameResolve;
                if (!acceptingFrame || !resolveFrame) {
                    frame.close();
                    return;
                }
                pendingFrameReject = null;
                pendingFrameResolve = null;
                resolveFrame(frame);
            }
        });
        let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
        try {
            decoder.configure({ ...probeRequest.configuration });
            const runThroughputProbe = async (): Promise<boolean> => {
                const totalFrameCount = RAW_HDR_OUTPUT_PROBE_WARMUP_FRAME_COUNT
                    + RAW_HDR_OUTPUT_PROBE_MEASURED_FRAME_COUNT;
                const copyOptions: RawHDRVideoFrameCopyToOptions = {
                    format: probeRequest.expectedFormat
                };
                const browserCopyOptions = copyOptions as unknown as VideoFrameCopyToOptions;
                let destination: Uint8Array | null = null;
                let measurementStartMilliseconds = 0;
                for (let frameIndex = 0; frameIndex < totalFrameCount; frameIndex += 1) {
                    const framePromise = new Promise<VideoFrame>((resolve, reject) => {
                        pendingFrameReject = reject;
                        pendingFrameResolve = resolve;
                    });
                    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
                    decoder.decode(new EncodedVideoChunk({
                        data: probeRequest.encodedKeyFrame,
                        timestamp: frameIndex * RAW_HDR_OUTPUT_PROBE_FRAME_INTERVAL_MICROSECONDS,
                        type: 'key'
                    }));
                    await decoder.flush();
                    const decodedFrame = await framePromise;
                    try {
                        if (
                            String(decodedFrame.format) !== probeRequest.expectedFormat
                            || decodedFrame.codedHeight !== probeRequest.expectedCodedHeight
                            || decodedFrame.codedWidth !== probeRequest.expectedCodedWidth
                        ) {
                            return false;
                        }
                        const allocationSize = decodedFrame.allocationSize(browserCopyOptions);
                        if (!destination || destination.byteLength !== allocationSize) {
                            destination = new Uint8Array(allocationSize);
                        }
                        let layouts: readonly PlaneLayout[];
                        try {
                            layouts = await decodedFrame.copyTo(destination, browserCopyOptions);
                        } catch (error) {
                            if (String(decodedFrame.format) !== probeRequest.expectedFormat) {
                                throw error;
                            }
                            // Current Chromium can reject an explicit native format
                            layouts = await decodedFrame.copyTo(destination);
                        }
                        if (createRawHDRFrameFingerprint(
                            destination,
                            layouts,
                            probeRequest.expectedCodedWidth,
                            probeRequest.expectedCodedHeight
                        ) !== probeRequest.expectedDecodedFrameFingerprint) {
                            return false;
                        }
                    } finally {
                        decodedFrame.close();
                    }
                    if (frameIndex + 1 === RAW_HDR_OUTPUT_PROBE_WARMUP_FRAME_COUNT) {
                        measurementStartMilliseconds = globalThis.performance.now();
                    }
                }
                const measuredMilliseconds = globalThis.performance.now()
                    - measurementStartMilliseconds;
                const maximumMeasuredMilliseconds = (
                    RAW_HDR_OUTPUT_PROBE_MEASURED_FRAME_COUNT * 1_000
                ) / RAW_HDR_OUTPUT_PROBE_MINIMUM_FRAMES_PER_SECOND;
                return measuredMilliseconds <= maximumMeasuredMilliseconds;
            };
            return await Promise.race([
                runThroughputProbe(),
                new Promise<boolean>(resolve => {
                    timeout = globalThis.setTimeout(
                        () => resolve(false),
                        RAW_HDR_OUTPUT_PROBE_TIMEOUT_MILLISECONDS
                    );
                })
            ]);
        } finally {
            acceptingFrame = false;
            pendingFrameReject = null;
            pendingFrameResolve = null;
            if (timeout !== null) {
                globalThis.clearTimeout(timeout);
            }
            decoder.close();
        }
    };
}

function getDefaultEnvironment(): WebCodecsCapabilityEnvironment {
    return {
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        audioDecoder: typeof globalThis.AudioDecoder === 'function' ? globalThis.AudioDecoder : null,
        bundledAC3SoftwareDecoder: __ENABLE_BUNDLED_AC3_SOFTWARE_DECODER__,
        bundledHEVCExactProbe: defaultBundledHEVCExactProbe,
        h264ProfileProbe: defaultH264ProfileCapabilityProbe,
        rawHDRVideoOutputProbe: createRawHDRVideoOutputProbe(),
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        videoDecoder: typeof globalThis.VideoDecoder === 'function' ? globalThis.VideoDecoder : null
    };
}

function createUnavailableCapability<Codec extends CustomDecodeCodec>(
    codec: Codec,
    codecString: string
): CustomDecodeCodecCapability<Codec> {
    return Object.freeze({
        codec,
        codecString,
        reason: 'api-unavailable',
        status: 'unknown'
    });
}

function createBundledHEVCRawHDRCapability(
    exactCapabilities: BundledHEVCExactCapabilities | null | undefined
): CustomRawHDRVideoCodecCapability {
    const main10FullHDTier = exactCapabilities?.tiers['main10-1080p'];
    const main10UltraHDTier = exactCapabilities?.tiers['main10-4k'];
    let supportedTier = main10UltraHDTier?.status === 'supported' ?
        main10UltraHDTier : null;
    supportedTier ??= main10FullHDTier?.status === 'supported' ?
        main10FullHDTier : null;
    const representativeTier = supportedTier ?? main10UltraHDTier ?? main10FullHDTier;
    const baseCapability = {
        bitDepth: 10 as const,
        codec: 'hevc' as const,
        codecString: representativeTier?.codecString ?? 'hvc1.2.4.L153.B0',
        format: 'I420P10' as const
    };
    if (!representativeTier) {
        return Object.freeze({
            ...baseCapability,
            maximumCodedHeight: 0,
            maximumCodedWidth: 0,
            reason: 'runtime-unavailable',
            status: 'unknown'
        });
    }
    if (!supportedTier) {
        return Object.freeze({
            ...baseCapability,
            maximumCodedHeight: 0,
            maximumCodedWidth: 0,
            reason: 'runtime-insufficient',
            status: 'unsupported'
        });
    }
    return Object.freeze({
        ...baseCapability,
        maximumCodedHeight: supportedTier.maximumCodedHeight,
        maximumCodedWidth: supportedTier.maximumCodedWidth,
        reason: 'bundled-software-decoder',
        status: 'supported'
    });
}

function selectHEVCRawHDRCapability(
    nativeCapability: CustomRawHDRVideoCodecCapability,
    bundledCapability: CustomRawHDRVideoCodecCapability
): CustomRawHDRVideoCodecCapability {
    if (nativeCapability.status === 'supported') {
        return nativeCapability;
    }
    if (bundledCapability.status === 'supported') {
        return bundledCapability;
    }
    if (nativeCapability.reason === 'api-unavailable') {
        return bundledCapability;
    }
    if (nativeCapability.status === 'unknown') {
        return nativeCapability;
    }
    if (bundledCapability.status === 'unknown') {
        return bundledCapability;
    }
    return nativeCapability;
}

function createRawHDRVideoCapabilities(
    probedCapabilities: readonly CustomRawHDRVideoCodecCapability[],
    bundledHEVC: BundledHEVCExactCapabilities | null
): Record<CustomRawHDRVideoCodec, CustomRawHDRVideoCodecCapability> {
    const capabilities = {} as Record<
        CustomRawHDRVideoCodec,
        CustomRawHDRVideoCodecCapability
    >;
    const bundledHEVCCapability = createBundledHEVCRawHDRCapability(bundledHEVC);
    for (const capability of probedCapabilities) {
        switch (capability.codec) {
            case 'hevc':
                capabilities.hevc = selectHEVCRawHDRCapability(
                    capability,
                    bundledHEVCCapability
                );
                break;
            case 'vp9':
                capabilities.vp9 = capability;
                break;
            case 'av1':
                capabilities.av1 = capability;
                break;
        }
    }
    return capabilities;
}

async function probeBundledHEVC(
    exactProbe: WebCodecsCapabilityEnvironment['bundledHEVCExactProbe']
): Promise<BundledHEVCExactCapabilities | null> {
    if (!exactProbe) {
        return null;
    }
    try {
        return await exactProbe.probe();
    } catch {
        return null;
    }
}

function createBundledAudioCapability(
    definition: BundledAudioCodecDefinition,
    bundledAC3SoftwareDecoder: boolean
): CustomDecodeCodecCapability<CustomAudioCodec> {
    if (!bundledAC3SoftwareDecoder) {
        return Object.freeze({
            codec: definition.codec,
            codecString: definition.codecString,
            reason: 'build-disabled',
            status: 'unsupported'
        });
    }
    return Object.freeze({
        codec: definition.codec,
        codecString: definition.codecString,
        reason: 'bundled-software-decoder',
        status: 'supported'
    });
}

async function probeH264Profiles(
    profileProbe: Pick<H264ProfileCapabilityProbe, 'probe'> | null | undefined
): Promise<H264ProfileCapabilities> {
    if (profileProbe) {
        try {
            return await profileProbe.probe();
        } catch {
            // Fall through to the immutable unavailable result
        }
    }
    return new H264ProfileCapabilityProbe({
        outputProbe: null,
        videoDecoder: null
    }).probe();
}

async function probeRawHDRVideoConfig(
    definition: RawHDRVideoProbeDefinition,
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: RawHDRVideoOutputProbe | null | undefined
): Promise<CustomRawHDRVideoCodecCapability> {
    const baseCapability = {
        bitDepth: 10 as const,
        codec: definition.codec,
        codecString: definition.config.codec,
        format: 'I420P10' as const,
        maximumCodedHeight: REPRESENTATIVE_RAW_HDR_VIDEO_HEIGHT,
        maximumCodedWidth: REPRESENTATIVE_RAW_HDR_VIDEO_WIDTH
    };
    if (!decoder || !outputProbe) {
        return Object.freeze({
            ...baseCapability,
            reason: 'api-unavailable',
            status: 'unknown'
        });
    }

    try {
        const support = await waitForCapabilityProbe(
            decoder.isConfigSupported({ ...definition.config })
        );
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                ...baseCapability,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        if (support.supported !== true) {
            return Object.freeze({
                ...baseCapability,
                reason: 'config-unsupported',
                status: 'unsupported'
            });
        }
        const outputCopySupported = await waitForCapabilityProbe(outputProbe({
            codec: definition.codec,
            configuration: definition.config,
            encodedKeyFrame: definition.encodedKeyFrame.slice(),
            expectedCodedHeight: REPRESENTATIVE_RAW_HDR_VIDEO_HEIGHT,
            expectedCodedWidth: REPRESENTATIVE_RAW_HDR_VIDEO_WIDTH,
            expectedDecodedFrameFingerprint: definition.expectedDecodedFrameFingerprint,
            expectedFormat: 'I420P10'
        }));
        if (outputCopySupported === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                ...baseCapability,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        return Object.freeze({
            ...baseCapability,
            reason: outputCopySupported ? 'output-copy-supported' : 'output-copy-unsupported',
            status: outputCopySupported ? 'supported' : 'unsupported'
        });
    } catch {
        return Object.freeze({
            ...baseCapability,
            reason: 'probe-exception',
            status: 'unknown'
        });
    }
}

async function probeConfig<Codec extends CustomDecodeCodec, Config extends { codec: string }>(
    definition: CodecProbeDefinition<Codec, Config>,
    decoder: DecoderCapabilityAPI<Config> | null | undefined
): Promise<CustomDecodeCodecCapability<Codec>> {
    if (!decoder) {
        return createUnavailableCapability(definition.codec, definition.config.codec);
    }

    try {
        const support = await waitForCapabilityProbe(
            decoder.isConfigSupported({ ...definition.config })
        );
        if (support === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        return Object.freeze({
            codec: definition.codec,
            codecString: definition.config.codec,
            reason: support.supported ? 'config-supported' : 'config-unsupported',
            status: support.supported ? 'supported' : 'unsupported'
        });
    } catch {
        return Object.freeze({
            codec: definition.codec,
            codecString: definition.config.codec,
            reason: 'probe-exception',
            status: 'unknown'
        });
    }
}

function getProbeReason(
    environment: WebCodecsCapabilityEnvironment,
    capabilities: readonly CustomDecodeCodecCapability<CustomDecodeCodec>[]
): CustomDecodeProbeReason {
    if (capabilities.some(capability => (
        capability.reason === 'probe-exception'
        || capability.reason === 'probe-timeout'
    ))) {
        return 'probe-exceptions';
    }
    if (!environment.audioDecoder && !environment.videoDecoder) {
        return 'api-unavailable';
    }
    if (!environment.audioDecoder || !environment.videoDecoder) {
        return 'partial-api';
    }
    return 'complete';
}

function getSupportedVideoCodecCount(
    video: Readonly<Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>>,
    h264Profiles: H264ProfileCapabilities,
    bundledHEVC: BundledHEVCExactCapabilities | null
): number {
    let supportedCount = 0;
    for (const codec of CUSTOM_VIDEO_CODECS) {
        switch (codec) {
            case 'h264':
                if (Object.values(h264Profiles).some(capability => (
                    capability.status === 'supported'
                    && capability.evidence === 'decoded-output'
                ))) {
                    supportedCount += 1;
                }
                break;
            case 'hevc':
                if (
                    video.hevc.status === 'supported'
                    || bundledHEVC?.tiers['main-1080p'].status === 'supported'
                ) {
                    supportedCount += 1;
                }
                break;
            default:
                if (video[codec].status === 'supported') {
                    supportedCount += 1;
                }
                break;
        }
    }
    return supportedCount;
}

/** Performs one cached, coarse WebCodecs decoder capability probe. */
export default class CustomDecodeCapabilityProbe {
    private cachedProbe: Promise<CustomDecodeCapabilities> | null = null;
    private readonly environment: WebCodecsCapabilityEnvironment | null;

    public constructor(environment: WebCodecsCapabilityEnvironment | null = null) {
        this.environment = environment;
    }

    /** Returns the same cached capability result for all calls. */
    public probe(): Promise<CustomDecodeCapabilities> {
        if (!this.cachedProbe) {
            this.cachedProbe = this.runProbe(this.environment ?? getDefaultEnvironment());
        }
        return this.cachedProbe;
    }

    private async runProbe(environment: WebCodecsCapabilityEnvironment): Promise<CustomDecodeCapabilities> {
        const videoProbePromises: Array<Promise<CustomDecodeCodecCapability<CustomVideoCodec>>> = [];
        for (const definition of VIDEO_PROBE_DEFINITIONS) {
            videoProbePromises.push(probeConfig(definition, environment.videoDecoder));
        }
        const audioProbePromises: Array<Promise<CustomDecodeCodecCapability<CustomAudioCodec>>> = [];
        for (const definition of AUDIO_PROBE_DEFINITIONS) {
            audioProbePromises.push(probeConfig(definition, environment.audioDecoder));
        }
        const rawHDRVideoProbePromises: Array<Promise<CustomRawHDRVideoCodecCapability>> = [];
        for (const definition of RAW_HDR_VIDEO_PROBE_DEFINITIONS) {
            rawHDRVideoProbePromises.push(probeRawHDRVideoConfig(
                definition,
                environment.videoDecoder,
                environment.rawHDRVideoOutputProbe
            ));
        }

        const [
            videoCapabilities,
            probedAudioCapabilities,
            rawHDRVideoProbeCapabilities,
            h264Profiles,
            bundledHEVC
        ] = await Promise.all([
            Promise.all(videoProbePromises),
            Promise.all(audioProbePromises),
            Promise.all(rawHDRVideoProbePromises),
            probeH264Profiles(environment.h264ProfileProbe),
            probeBundledHEVC(environment.bundledHEVCExactProbe)
        ]);
        const audioCapabilities: Array<CustomDecodeCodecCapability<CustomAudioCodec>> = [];
        audioCapabilities.push(...probedAudioCapabilities);
        const bundledAC3SoftwareDecoder = environment.bundledAC3SoftwareDecoder === true;
        for (const definition of BUNDLED_AUDIO_CODEC_DEFINITIONS) {
            audioCapabilities.push(createBundledAudioCapability(
                definition,
                bundledAC3SoftwareDecoder
            ));
        }
        const video = {} as Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>;
        for (const capability of videoCapabilities) {
            video[capability.codec] = capability;
        }
        const audio = {} as Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>;
        for (const capability of audioCapabilities) {
            audio[capability.codec] = capability;
        }
        const rawHDRVideo = createRawHDRVideoCapabilities(
            rawHDRVideoProbeCapabilities,
            bundledHEVC
        );

        const allCapabilities: Array<CustomDecodeCodecCapability<CustomDecodeCodec>> = [];
        allCapabilities.push(...videoCapabilities, ...audioCapabilities);
        const telemetry = Object.freeze({
            audioProbeCount: environment.audioDecoder ? AUDIO_PROBE_DEFINITIONS.length : 0,
            bundledAudioCodecCount: bundledAC3SoftwareDecoder ?
                BUNDLED_AUDIO_CODEC_DEFINITIONS.length :
                0,
            rawHDRVideoProbeCount: environment.videoDecoder && environment.rawHDRVideoOutputProbe ?
                RAW_HDR_VIDEO_PROBE_DEFINITIONS.length :
                0,
            reason: getProbeReason(environment, allCapabilities),
            supportedAudioCodecCount: audioCapabilities.filter(capability => capability.status === 'supported').length,
            supportedRawHDRVideoCodecCount: Object.values(rawHDRVideo).filter(capability => (
                capability.status === 'supported'
            )).length,
            supportedVideoCodecCount: getSupportedVideoCodecCount(
                video,
                h264Profiles,
                bundledHEVC
            ),
            unknownAudioCodecCount: audioCapabilities.filter(capability => capability.status === 'unknown').length,
            unknownVideoCodecCount: videoCapabilities.filter(capability => capability.status === 'unknown').length,
            videoProbeCount: environment.videoDecoder ? VIDEO_PROBE_DEFINITIONS.length : 0
        });

        return Object.freeze({
            audio: Object.freeze(audio),
            ...(bundledHEVC ? { bundledHEVC } : {}),
            h264Profiles,
            rawHDRVideo: Object.freeze(rawHDRVideo),
            telemetry,
            video: Object.freeze(video)
        });
    }
}

const defaultCapabilityProbe = new CustomDecodeCapabilityProbe();

/** Probes the current runtime once and reuses that result for later sessions. */
export function probeCustomDecodeCapabilities(): Promise<CustomDecodeCapabilities> {
    return defaultCapabilityProbe.probe();
}
