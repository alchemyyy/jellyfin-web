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
import { createHEVCExactCapabilityAccessUnit } from './HEVCExactCapabilityFixtures';
import { getCustomDecodeHardwareAcceleration } from './DecodeWorkerProtocol';
import {
    createNativeAudioCapabilityFixture,
    type NativeAudioCapabilityFixture
} from './NativeAudioCapabilityFixtures';
import {
    createNativeSurroundAudioCapabilityFixture,
    NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT,
    NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CODECS,
    NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE,
    type NativeSurroundAudioCapabilityFixture
} from './NativeSurroundAudioCapabilityFixtures';
import {
    createNativeUltraHDVideoCapabilityFixture,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODECS,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_HEIGHT,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_WIDTH,
    type NativeUltraHDVideoCapabilityFixture
} from './NativeUltraHDVideoCapabilityFixtures';
import { createNativeVideoCapabilityFixture } from './NativeVideoCapabilityFixtures';

export const CUSTOM_VIDEO_CODECS = [ 'h264', 'hevc', 'vp8', 'vp9', 'av1' ] as const;
export const CUSTOM_WEB_CODECS_AUDIO_CODECS = [ 'aac', 'opus', 'flac', 'mp3', 'vorbis' ] as const;
export const CUSTOM_BUNDLED_AUDIO_CODECS = [ 'ac3', 'eac3' ] as const;
export const CUSTOM_AUDIO_CODECS = [
    ...CUSTOM_WEB_CODECS_AUDIO_CODECS,
    ...CUSTOM_BUNDLED_AUDIO_CODECS
] as const;
export const CUSTOM_RAW_HDR_VIDEO_CODECS = [ 'hevc', 'vp9', 'av1' ] as const;
export const CUSTOM_NATIVE_SURROUND_AUDIO_CODECS =
    NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CODECS;
export const CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS =
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODECS;
export const CUSTOM_NATIVE_VIDEO_BIT_DEPTH = 8;
export const CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT = 1_080;
export const CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH = 1_920;
export const CUSTOM_NATIVE_DOLBY_VISION_HEVC_MAXIMUM_BITRATE = 40_000_000;
export const CUSTOM_NATIVE_DOLBY_VISION_HEVC_MAXIMUM_CODED_HEIGHT = 2_160;
export const CUSTOM_NATIVE_DOLBY_VISION_HEVC_MAXIMUM_CODED_WIDTH = 3_840;
export const CUSTOM_NATIVE_DOLBY_VISION_HEVC_MAXIMUM_LEVEL = 153;
export const CUSTOM_RAW_HDR_VIDEO_MAXIMUM_FRAMES_PER_SECOND = 24;

export type CustomVideoCodec = typeof CUSTOM_VIDEO_CODECS[number];
export type CustomAudioCodec = typeof CUSTOM_AUDIO_CODECS[number];
export type CustomBundledAudioCodec = typeof CUSTOM_BUNDLED_AUDIO_CODECS[number];
export type CustomRawHDRVideoCodec = typeof CUSTOM_RAW_HDR_VIDEO_CODECS[number];
export type CustomNativeSurroundAudioCodec =
    typeof CUSTOM_NATIVE_SURROUND_AUDIO_CODECS[number];
export type CustomNativeUltraHDVideoCodec =
    typeof CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS[number];
export type CustomDecodeCodec = CustomAudioCodec | CustomVideoCodec;
export type CustomDecodeCapabilityStatus = 'supported' | 'unsupported' | 'unknown';
export type CustomDecodeCapabilityReason =
    | 'api-unavailable'
    | 'build-disabled'
    | 'bundled-software-decoder'
    | 'config-supported'
    | 'config-unsupported'
    | 'decode-output-missing'
    | 'decode-output-verified'
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
    nativeSurroundAudioProbeCount: number
    nativeUltraHDVideoProbeCount: number
    rawHDRVideoProbeCount: number
    reason: CustomDecodeProbeReason
    supportedAudioCodecCount: number
    supportedNativeSurroundAudioCodecCount: number
    supportedNativeUltraHDVideoCodecCount: number
    supportedRawHDRVideoCodecCount: number
    supportedVideoCodecCount: number
    unknownAudioCodecCount: number
    unknownNativeSurroundAudioCodecCount: number
    unknownNativeUltraHDVideoCodecCount: number
    unknownVideoCodecCount: number
    videoProbeCount: number
};

export type CustomDecodeCapabilities = {
    audio: Readonly<Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>>
    bundledHEVC?: BundledHEVCExactCapabilities
    h264Profiles?: H264ProfileCapabilities
    nativeDolbyVisionHEVC?: CustomNativeDolbyVisionHEVCCapability
    nativeSurroundAudio?: Readonly<Record<
        CustomNativeSurroundAudioCodec,
        CustomNativeSurroundAudioCodecCapability
    >>
    nativeUltraHDVideo?: Readonly<Record<
        CustomNativeUltraHDVideoCodec,
        CustomNativeUltraHDVideoCodecCapability
    >>
    rawHDRVideo: Readonly<Record<CustomRawHDRVideoCodec, CustomRawHDRVideoCodecCapability>>
    telemetry: Readonly<CustomDecodeProbeTelemetry>
    video: Readonly<Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>>
};

export type CustomNativeSurroundAudioCodecCapability =
    CustomDecodeCodecCapability<CustomNativeSurroundAudioCodec> & {
        inputChannelCount: typeof NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT
        sampleRate: typeof NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE
    };

export type CustomNativeUltraHDVideoCodecCapability =
    CustomDecodeCodecCapability<CustomNativeUltraHDVideoCodec> & {
        bitDepth: typeof CUSTOM_NATIVE_VIDEO_BIT_DEPTH
        maximumCodedHeight: typeof NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_HEIGHT
        maximumCodedWidth: typeof NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_WIDTH
    };

export type CustomNativeDolbyVisionHEVCCapability =
    CustomDecodeCodecCapability<'hevc'> & {
        bitDepth: 10
        maximumBitrate: number
        maximumCodedHeight: number
        maximumCodedWidth: number
        maximumLevel: number
        profile: 5
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

export type NativeDolbyVisionVideoOutputProbeRequest = {
    configuration: VideoDecoderConfig
    encodedKeyFrame: Uint8Array
    expectedCodedHeight: number
    expectedCodedWidth: number
};

export type NativeDolbyVisionVideoOutputProbe = (
    probeRequest: NativeDolbyVisionVideoOutputProbeRequest
) => Promise<boolean>;

export type NativeVideoOutputProbeRequest = {
    codec: CustomVideoCodec
    configuration: VideoDecoderConfig
    encodedKeyFrame: Uint8Array
    expectedCodedHeight: number
    expectedCodedWidth: number
    expectedDisplayHeight: number
    expectedDisplayWidth: number
    expectedTimestamp: number
};

export type NativeVideoOutputProbe = (
    probeRequest: NativeVideoOutputProbeRequest
) => Promise<boolean>;

export type NativeAudioOutputProbeRequest = {
    codec: Exclude<CustomAudioCodec, CustomBundledAudioCodec>
    configuration: AudioDecoderConfig
    encodedChunks: readonly Readonly<{
        data: Uint8Array
        duration: number
        timestamp: number
    }>[]
    expectedNumberOfChannels: number
    expectedNumberOfFrames: number
    expectedSampleRate: number
    expectedTimestamp: number
};

export type NativeAudioOutputProbe = (
    probeRequest: NativeAudioOutputProbeRequest
) => Promise<boolean>;

type RawHDRVideoFrameCopyToOptions = Omit<VideoFrameCopyToOptions, 'format'> & {
    format: 'I420P10'
};

export type WebCodecsCapabilityEnvironment = {
    audioDecoder?: Pick<typeof AudioDecoder, 'isConfigSupported'> | null
    bundledAC3SoftwareDecoder?: boolean
    bundledHEVCExactProbe?: { probe: () => Promise<BundledHEVCExactCapabilities> } | null
    h264ProfileProbe?: Pick<H264ProfileCapabilityProbe, 'probe'> | null
    nativeAudioOutputProbe?: NativeAudioOutputProbe | null
    nativeDolbyVisionVideoOutputProbe?: NativeDolbyVisionVideoOutputProbe | null
    nativeVideoOutputProbe?: NativeVideoOutputProbe | null
    rawHDRVideoOutputProbe?: RawHDRVideoOutputProbe | null
    videoDecoder?: Pick<typeof VideoDecoder, 'isConfigSupported'> | null
};

type VideoProbeDefinition = {
    codec: CustomVideoCodec
    config: VideoDecoderConfig
    outputFixture?: {
        encodedKeyFrame: Uint8Array
        expectedCodedHeight: number
        expectedCodedWidth: number
        expectedDisplayHeight: number
        expectedDisplayWidth: number
    }
};

type DecodedVideoProbeDefinition = VideoProbeDefinition & {
    outputFixture: NonNullable<VideoProbeDefinition['outputFixture']>
};

type NativeUltraHDVideoProbeDefinition = DecodedVideoProbeDefinition & {
    codec: CustomNativeUltraHDVideoCodec
};

function hasDecodedVideoOutputFixture(
    definition: VideoProbeDefinition
): definition is DecodedVideoProbeDefinition {
    return definition.outputFixture !== undefined;
}

type AudioProbeDefinition = {
    codec: Exclude<CustomAudioCodec, CustomBundledAudioCodec>
    config: AudioDecoderConfig
    outputFixture: {
        encodedChunks: NativeAudioCapabilityFixture['encodedChunks']
            | NativeSurroundAudioCapabilityFixture['encodedChunks']
        expectedNumberOfChannels: number
        expectedNumberOfFrames: number
        expectedSampleRate: number
        expectedTimestamp: number
    }
};

type NativeSurroundAudioProbeDefinition = AudioProbeDefinition & {
    codec: CustomNativeSurroundAudioCodec
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
const NATIVE_VIDEO_MAXIMUM_HORIZONTAL_CODED_ALIGNMENT = 256;
const NATIVE_VIDEO_MAXIMUM_VERTICAL_CODED_ALIGNMENT = 64;
const NATIVE_AUDIO_MAXIMUM_ABSOLUTE_SILENCE_SAMPLE = 0.000_001;
const HEVC_MAIN10_BLACK_DECODED_FRAME_FINGERPRINT = 3_873_342_648;
const NATIVE_HEVC_SDR_ACCESS_UNIT = createHEVCExactCapabilityAccessUnit('main-1080p');
const NATIVE_DOLBY_VISION_HEVC_ACCESS_UNIT = createHEVCExactCapabilityAccessUnit(
    'main10-4k'
);
const NATIVE_AV1_SDR_FIXTURE = createNativeVideoCapabilityFixture('av1');
const NATIVE_VP8_SDR_FIXTURE = createNativeVideoCapabilityFixture('vp8');
const NATIVE_VP9_SDR_FIXTURE = createNativeVideoCapabilityFixture('vp9');
const NATIVE_ULTRA_HD_HEVC_FIXTURE: NativeUltraHDVideoCapabilityFixture =
    createNativeUltraHDVideoCapabilityFixture('hevc');
const NATIVE_ULTRA_HD_VP9_FIXTURE: NativeUltraHDVideoCapabilityFixture =
    createNativeUltraHDVideoCapabilityFixture('vp9');
const NATIVE_ULTRA_HD_AV1_FIXTURE: NativeUltraHDVideoCapabilityFixture =
    createNativeUltraHDVideoCapabilityFixture('av1');
const NATIVE_AAC_AUDIO_FIXTURE: NativeAudioCapabilityFixture =
    createNativeAudioCapabilityFixture('aac');
const NATIVE_OPUS_AUDIO_FIXTURE: NativeAudioCapabilityFixture =
    createNativeAudioCapabilityFixture('opus');
const NATIVE_FLAC_AUDIO_FIXTURE: NativeAudioCapabilityFixture =
    createNativeAudioCapabilityFixture('flac');
const NATIVE_MP3_AUDIO_FIXTURE: NativeAudioCapabilityFixture =
    createNativeAudioCapabilityFixture('mp3');
const NATIVE_VORBIS_AUDIO_FIXTURE: NativeAudioCapabilityFixture =
    createNativeAudioCapabilityFixture('vorbis');
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
        },
        outputFixture: {
            encodedKeyFrame: new Uint8Array(NATIVE_HEVC_SDR_ACCESS_UNIT),
            expectedCodedHeight: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT,
            expectedCodedWidth: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH,
            expectedDisplayHeight: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT,
            expectedDisplayWidth: CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH
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
        },
        outputFixture: {
            encodedKeyFrame: NATIVE_VP8_SDR_FIXTURE.encodedKeyFrame,
            expectedCodedHeight: NATIVE_VP8_SDR_FIXTURE.codedHeight,
            expectedCodedWidth: NATIVE_VP8_SDR_FIXTURE.codedWidth,
            expectedDisplayHeight: NATIVE_VP8_SDR_FIXTURE.codedHeight,
            expectedDisplayWidth: NATIVE_VP8_SDR_FIXTURE.codedWidth
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
        },
        outputFixture: {
            encodedKeyFrame: NATIVE_VP9_SDR_FIXTURE.encodedKeyFrame,
            expectedCodedHeight: NATIVE_VP9_SDR_FIXTURE.codedHeight,
            expectedCodedWidth: NATIVE_VP9_SDR_FIXTURE.codedWidth,
            expectedDisplayHeight: NATIVE_VP9_SDR_FIXTURE.codedHeight,
            expectedDisplayWidth: NATIVE_VP9_SDR_FIXTURE.codedWidth
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
        },
        outputFixture: {
            encodedKeyFrame: NATIVE_AV1_SDR_FIXTURE.encodedKeyFrame,
            expectedCodedHeight: NATIVE_AV1_SDR_FIXTURE.codedHeight,
            expectedCodedWidth: NATIVE_AV1_SDR_FIXTURE.codedWidth,
            expectedDisplayHeight: NATIVE_AV1_SDR_FIXTURE.codedHeight,
            expectedDisplayWidth: NATIVE_AV1_SDR_FIXTURE.codedWidth
        }
    }
];

function createNativeUltraHDVideoProbeDefinition(
    fixture: NativeUltraHDVideoCapabilityFixture
): NativeUltraHDVideoProbeDefinition {
    return {
        codec: fixture.codec,
        config: {
            codec: fixture.codecString,
            codedHeight: fixture.codedHeight,
            codedWidth: fixture.codedWidth,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration('video-frame'),
            optimizeForLatency: true
        },
        outputFixture: {
            encodedKeyFrame: fixture.encodedKeyFrame,
            expectedCodedHeight: fixture.codedHeight,
            expectedCodedWidth: fixture.codedWidth,
            expectedDisplayHeight: fixture.codedHeight,
            expectedDisplayWidth: fixture.codedWidth
        }
    };
}

const NATIVE_ULTRA_HD_VIDEO_PROBE_DEFINITIONS: readonly NativeUltraHDVideoProbeDefinition[] = [
    createNativeUltraHDVideoProbeDefinition(NATIVE_ULTRA_HD_HEVC_FIXTURE),
    createNativeUltraHDVideoProbeDefinition(NATIVE_ULTRA_HD_VP9_FIXTURE),
    createNativeUltraHDVideoProbeDefinition(NATIVE_ULTRA_HD_AV1_FIXTURE)
];

const NATIVE_DOLBY_VISION_HEVC_PROBE_DEFINITION = {
    codec: 'hevc',
    config: {
        codec: 'hev1.2.4.H150.B0',
        codedHeight: CUSTOM_NATIVE_DOLBY_VISION_HEVC_MAXIMUM_CODED_HEIGHT,
        codedWidth: CUSTOM_NATIVE_DOLBY_VISION_HEVC_MAXIMUM_CODED_WIDTH,
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: true
    }
} as const satisfies VideoProbeDefinition;

function createAudioProbeDefinition(
    fixture: NativeAudioCapabilityFixture | NativeSurroundAudioCapabilityFixture
): AudioProbeDefinition {
    return {
        codec: fixture.codec,
        config: {
            codec: fixture.codecString,
            ...(fixture.description ? { description: fixture.description.slice() } : {}),
            numberOfChannels: fixture.numberOfChannels,
            sampleRate: fixture.sampleRate
        },
        outputFixture: {
            encodedChunks: fixture.encodedChunks,
            expectedNumberOfChannels: fixture.numberOfChannels,
            expectedNumberOfFrames: fixture.expectedOutputFrameCount,
            expectedSampleRate: fixture.sampleRate,
            expectedTimestamp: fixture.expectedOutputTimestamp
        }
    };
}

const AUDIO_PROBE_DEFINITIONS: readonly AudioProbeDefinition[] = [
    createAudioProbeDefinition(NATIVE_AAC_AUDIO_FIXTURE),
    createAudioProbeDefinition(NATIVE_OPUS_AUDIO_FIXTURE),
    createAudioProbeDefinition(NATIVE_FLAC_AUDIO_FIXTURE),
    createAudioProbeDefinition(NATIVE_MP3_AUDIO_FIXTURE),
    createAudioProbeDefinition(NATIVE_VORBIS_AUDIO_FIXTURE)
];

function createNativeSurroundAudioProbeDefinitions():
readonly NativeSurroundAudioProbeDefinition[] {
    const definitions: NativeSurroundAudioProbeDefinition[] = [];
    for (const codec of NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CODECS) {
        const fixture = createNativeSurroundAudioCapabilityFixture(codec);
        definitions.push({
            ...createAudioProbeDefinition(fixture),
            codec
        });
    }
    return definitions;
}

const NATIVE_SURROUND_AUDIO_PROBE_DEFINITIONS:
readonly NativeSurroundAudioProbeDefinition[] =
    createNativeSurroundAudioProbeDefinitions();

const BUNDLED_AUDIO_CODEC_DEFINITIONS: readonly BundledAudioCodecDefinition[] = [
    { codec: 'ac3', codecString: 'ac-3' },
    { codec: 'eac3', codecString: 'ec-3' }
];

const VP9_PROFILE_2_FIXTURE = createRawHDRCapabilityFixture('vp9');
const AV1_MAIN_10_FIXTURE = createRawHDRCapabilityFixture('av1');
const HEVC_MAIN10_ACCESS_UNIT = createHEVCExactCapabilityAccessUnit('main10-4k');
const RAW_HDR_VIDEO_PROBE_DEFINITIONS: readonly RawHDRVideoProbeDefinition[] = [
    {
        codec: 'hevc',
        config: {
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: REPRESENTATIVE_RAW_HDR_VIDEO_HEIGHT,
            codedWidth: REPRESENTATIVE_RAW_HDR_VIDEO_WIDTH,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration(
                'raw-planes',
                'native'
            ),
            optimizeForLatency: true
        },
        encodedKeyFrame: new Uint8Array(HEVC_MAIN10_ACCESS_UNIT),
        expectedDecodedFrameFingerprint: HEVC_MAIN10_BLACK_DECODED_FRAME_FINGERPRINT
    },
    {
        codec: 'vp9',
        config: {
            codec: 'vp09.02.10.10',
            codedHeight: REPRESENTATIVE_RAW_HDR_VIDEO_HEIGHT,
            codedWidth: REPRESENTATIVE_RAW_HDR_VIDEO_WIDTH,
            hardwareAcceleration: getCustomDecodeHardwareAcceleration(
                'raw-planes',
                'native'
            ),
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
            hardwareAcceleration: getCustomDecodeHardwareAcceleration(
                'raw-planes',
                'native'
            ),
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

type CopiedRawHDRFrame = Readonly<{
    destination: Uint8Array
    layouts: readonly PlaneLayout[]
}>;

async function copyDecodedRawHDRFrame(
    decodedFrame: VideoFrame,
    expectedFormat: 'I420P10',
    destination: Uint8Array | null
): Promise<CopiedRawHDRFrame | null> {
    const copyOptions: RawHDRVideoFrameCopyToOptions = { format: expectedFormat };
    const browserCopyOptions = copyOptions as unknown as VideoFrameCopyToOptions;
    let allocationSize: number;
    try {
        allocationSize = decodedFrame.allocationSize(browserCopyOptions);
    } catch {
        return null;
    }
    let output = destination?.byteLength === allocationSize ?
        destination :
        new Uint8Array(allocationSize);
    try {
        return {
            destination: output,
            layouts: await decodedFrame.copyTo(output, browserCopyOptions)
        };
    } catch {
        if (String(decodedFrame.format) !== expectedFormat) {
            return null;
        }
    }

    // Current Chromium can reject an explicit native format
    const nativeAllocationSize = decodedFrame.allocationSize();
    if (output.byteLength !== nativeAllocationSize) {
        output = new Uint8Array(nativeAllocationSize);
    }
    return {
        destination: output,
        layouts: await decodedFrame.copyTo(output)
    };
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
                            decodedFrame.codedHeight !== probeRequest.expectedCodedHeight
                            || decodedFrame.codedWidth !== probeRequest.expectedCodedWidth
                        ) {
                            return false;
                        }
                        const copiedFrame = await copyDecodedRawHDRFrame(
                            decodedFrame,
                            probeRequest.expectedFormat,
                            destination
                        );
                        if (!copiedFrame) {
                            return false;
                        }
                        destination = copiedFrame.destination;
                        if (createRawHDRFrameFingerprint(
                            destination,
                            copiedFrame.layouts,
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

function nativeAudioDataMatchesRequest(
    audioData: AudioData,
    probeRequest: NativeAudioOutputProbeRequest
): boolean {
    const expectedDuration: number = Math.round(
        (probeRequest.expectedNumberOfFrames * 1_000_000)
        / probeRequest.expectedSampleRate
    );
    if (
        audioData.numberOfChannels !== probeRequest.expectedNumberOfChannels
        || audioData.numberOfFrames !== probeRequest.expectedNumberOfFrames
        || audioData.sampleRate !== probeRequest.expectedSampleRate
        || audioData.timestamp !== probeRequest.expectedTimestamp
        || audioData.duration !== expectedDuration
    ) {
        return false;
    }

    try {
        for (
            let channelIndex = 0;
            channelIndex < probeRequest.expectedNumberOfChannels;
            channelIndex += 1
        ) {
            const samples: Float32Array = new Float32Array(
                probeRequest.expectedNumberOfFrames
            );
            audioData.copyTo(samples, {
                format: 'f32-planar',
                planeIndex: channelIndex
            });
            for (const sample of samples) {
                if (!Number.isFinite(sample)
                    || Math.abs(sample) > NATIVE_AUDIO_MAXIMUM_ABSOLUTE_SILENCE_SAMPLE) {
                    return false;
                }
            }
        }
    } catch {
        return false;
    }
    return true;
}

/** Creates the exact decoded AudioData probe for native WebCodecs audio. */
export function createNativeAudioOutputProbe(): NativeAudioOutputProbe | null {
    if (typeof globalThis.AudioDecoder !== 'function'
        || typeof globalThis.EncodedAudioChunk !== 'function') {
        return null;
    }

    return async (probeRequest: NativeAudioOutputProbeRequest): Promise<boolean> => {
        let acceptingOutput = true;
        let decoderError: DOMException | null = null;
        let outputCount = 0;
        let outputMatches = true;
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        const decoder: AudioDecoder = new AudioDecoder({
            error: (error: DOMException): void => {
                decoderError = error;
            },
            output: (audioData: AudioData): void => {
                try {
                    if (!acceptingOutput) {
                        return;
                    }
                    outputCount += 1;
                    outputMatches = outputMatches
                        && nativeAudioDataMatchesRequest(audioData, probeRequest);
                } finally {
                    audioData.close();
                }
            }
        });
        let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
        try {
            decoder.configure({ ...probeRequest.configuration });
            const runOutputProbe = async (): Promise<boolean> => {
                for (const chunk of probeRequest.encodedChunks) {
                    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
                    decoder.decode(new EncodedAudioChunk({
                        data: chunk.data,
                        duration: chunk.duration,
                        timestamp: chunk.timestamp,
                        type: 'key'
                    }));
                }
                await decoder.flush();
                return decoderError === null && outputCount === 1 && outputMatches;
            };
            return await Promise.race([
                runOutputProbe(),
                new Promise<boolean>(resolve => {
                    timeout = globalThis.setTimeout(
                        () => resolve(false),
                        RAW_HDR_OUTPUT_PROBE_TIMEOUT_MILLISECONDS
                    );
                })
            ]);
        } finally {
            acceptingOutput = false;
            if (timeout !== null) {
                globalThis.clearTimeout(timeout);
            }
            if (decoder.state !== 'closed') {
                decoder.close();
            }
        }
    };
}

function nativeVideoFrameMatchesRequest(
    frame: VideoFrame,
    probeRequest: NativeVideoOutputProbeRequest
): boolean {
    const visibleRectangle = frame.visibleRect;
    const maximumCodedHeight = Math.ceil(
        probeRequest.expectedCodedHeight / NATIVE_VIDEO_MAXIMUM_VERTICAL_CODED_ALIGNMENT
    ) * NATIVE_VIDEO_MAXIMUM_VERTICAL_CODED_ALIGNMENT;
    const maximumCodedWidth = Math.ceil(
        probeRequest.expectedCodedWidth / NATIVE_VIDEO_MAXIMUM_HORIZONTAL_CODED_ALIGNMENT
    ) * NATIVE_VIDEO_MAXIMUM_HORIZONTAL_CODED_ALIGNMENT;
    return visibleRectangle !== null
        && visibleRectangle.x === 0
        && visibleRectangle.y === 0
        && visibleRectangle.height === probeRequest.expectedCodedHeight
        && visibleRectangle.width === probeRequest.expectedCodedWidth
        && frame.codedHeight >= probeRequest.expectedCodedHeight
        && frame.codedHeight <= maximumCodedHeight
        && frame.codedWidth >= probeRequest.expectedCodedWidth
        && frame.codedWidth <= maximumCodedWidth
        && frame.displayHeight === probeRequest.expectedDisplayHeight
        && frame.displayWidth === probeRequest.expectedDisplayWidth
        && frame.timestamp === probeRequest.expectedTimestamp;
}

/** Creates the exact decoded-frame probe for ordinary native SDR codecs. */
export function createNativeVideoOutputProbe(): NativeVideoOutputProbe | null {
    if (typeof globalThis.VideoDecoder !== 'function'
        || typeof globalThis.EncodedVideoChunk !== 'function') {
        return null;
    }

    return async (probeRequest: NativeVideoOutputProbeRequest): Promise<boolean> => {
        let acceptingFrame = true;
        let decoderError: DOMException | null = null;
        let outputCount = 0;
        let outputMatches = true;
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        const decoder = new VideoDecoder({
            error: (error: DOMException): void => {
                decoderError = error;
            },
            output: (frame: VideoFrame): void => {
                try {
                    if (!acceptingFrame) {
                        return;
                    }
                    outputCount += 1;
                    outputMatches = outputMatches
                        && nativeVideoFrameMatchesRequest(frame, probeRequest);
                } finally {
                    frame.close();
                }
            }
        });
        let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
        try {
            decoder.configure({ ...probeRequest.configuration });
            const runOutputProbe = async (): Promise<boolean> => {
                // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
                decoder.decode(new EncodedVideoChunk({
                    data: probeRequest.encodedKeyFrame,
                    timestamp: probeRequest.expectedTimestamp,
                    type: 'key'
                }));
                await decoder.flush();
                return decoderError === null && outputCount === 1 && outputMatches;
            };
            return await Promise.race([
                runOutputProbe(),
                new Promise<boolean>(resolve => {
                    timeout = globalThis.setTimeout(
                        () => resolve(false),
                        RAW_HDR_OUTPUT_PROBE_TIMEOUT_MILLISECONDS
                    );
                })
            ]);
        } finally {
            acceptingFrame = false;
            if (timeout !== null) {
                globalThis.clearTimeout(timeout);
            }
            if (decoder.state !== 'closed') {
                decoder.close();
            }
        }
    };
}

/** Creates the exact decoded-frame probe for the native Profile 5 base layer. */
export function createNativeDolbyVisionVideoOutputProbe():
NativeDolbyVisionVideoOutputProbe | null {
    if (typeof globalThis.VideoDecoder !== 'function'
        || typeof globalThis.EncodedVideoChunk !== 'function') {
        return null;
    }

    return async (
        probeRequest: NativeDolbyVisionVideoOutputProbeRequest
    ): Promise<boolean> => {
        let acceptingFrame = true;
        let outputReject: ((reason: unknown) => void) | null = null;
        let outputResolve: ((supported: boolean) => void) | null = null;
        const outputPromise = new Promise<boolean>((resolve, reject) => {
            outputReject = reject;
            outputResolve = resolve;
        });
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        const decoder = new VideoDecoder({
            error: (error: DOMException): void => outputReject?.(error),
            output: (frame: VideoFrame): void => {
                if (!acceptingFrame || !outputResolve) {
                    frame.close();
                    return;
                }
                const resolveOutput = outputResolve;
                outputReject = null;
                outputResolve = null;
                const supported = frame.codedHeight === probeRequest.expectedCodedHeight
                    && frame.codedWidth === probeRequest.expectedCodedWidth
                    && frame.displayHeight > 0
                    && frame.displayWidth > 0;
                frame.close();
                resolveOutput(supported);
            }
        });
        let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
        try {
            decoder.configure({ ...probeRequest.configuration });
            const runOutputProbe = async (): Promise<boolean> => {
                // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
                decoder.decode(new EncodedVideoChunk({
                    data: probeRequest.encodedKeyFrame,
                    timestamp: 0,
                    type: 'key'
                }));
                await decoder.flush();
                return outputPromise;
            };
            return await Promise.race([
                runOutputProbe(),
                new Promise<boolean>(resolve => {
                    timeout = globalThis.setTimeout(
                        () => resolve(false),
                        RAW_HDR_OUTPUT_PROBE_TIMEOUT_MILLISECONDS
                    );
                })
            ]);
        } finally {
            acceptingFrame = false;
            outputReject = null;
            outputResolve = null;
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
        nativeAudioOutputProbe: createNativeAudioOutputProbe(),
        nativeDolbyVisionVideoOutputProbe: createNativeDolbyVisionVideoOutputProbe(),
        nativeVideoOutputProbe: createNativeVideoOutputProbe(),
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

async function probeNativeAudioConfig(
    definition: AudioProbeDefinition,
    decoder: DecoderCapabilityAPI<AudioDecoderConfig> | null | undefined,
    outputProbe: NativeAudioOutputProbe | null | undefined
): Promise<CustomDecodeCodecCapability<Exclude<CustomAudioCodec, CustomBundledAudioCodec>>> {
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
        if (support.supported !== true) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'config-unsupported',
                status: 'unsupported'
            });
        }
        if (!outputProbe) {
            return createUnavailableCapability(definition.codec, definition.config.codec);
        }

        const fixture: AudioProbeDefinition['outputFixture'] = definition.outputFixture;
        const encodedChunks: Array<{
            data: Uint8Array
            duration: number
            timestamp: number
        }> = [];
        for (const chunk of fixture.encodedChunks) {
            encodedChunks.push({
                data: chunk.data.slice(),
                duration: chunk.duration,
                timestamp: chunk.timestamp
            });
        }
        const outputSupported = await waitForCapabilityProbe(outputProbe({
            codec: definition.codec,
            configuration: { ...definition.config },
            encodedChunks,
            expectedNumberOfChannels: fixture.expectedNumberOfChannels,
            expectedNumberOfFrames: fixture.expectedNumberOfFrames,
            expectedSampleRate: fixture.expectedSampleRate,
            expectedTimestamp: fixture.expectedTimestamp
        }));
        if (outputSupported === CAPABILITY_PROBE_TIMEOUT) {
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
            reason: outputSupported ? 'decode-output-verified' : 'decode-output-missing',
            status: outputSupported ? 'supported' : 'unsupported'
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

async function probeNativeSurroundAudioConfig(
    definition: NativeSurroundAudioProbeDefinition,
    decoder: DecoderCapabilityAPI<AudioDecoderConfig> | null | undefined,
    outputProbe: NativeAudioOutputProbe | null | undefined
): Promise<CustomNativeSurroundAudioCodecCapability> {
    const capability = await probeNativeAudioConfig(
        definition,
        decoder,
        outputProbe
    );
    return Object.freeze({
        codec: definition.codec,
        codecString: capability.codecString,
        inputChannelCount: NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT,
        reason: capability.reason,
        sampleRate: NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE,
        status: capability.status
    });
}

function createNativeSurroundAudioProbePromises(
    environment: WebCodecsCapabilityEnvironment
): Array<Promise<CustomNativeSurroundAudioCodecCapability>> {
    const probePromises: Array<Promise<CustomNativeSurroundAudioCodecCapability>> = [];
    for (const definition of NATIVE_SURROUND_AUDIO_PROBE_DEFINITIONS) {
        probePromises.push(probeNativeSurroundAudioConfig(
            definition,
            environment.audioDecoder,
            environment.nativeAudioOutputProbe
        ));
    }
    return probePromises;
}

function createNativeSurroundAudioCapabilities(
    capabilities: readonly CustomNativeSurroundAudioCodecCapability[]
): Readonly<Record<
        CustomNativeSurroundAudioCodec,
        CustomNativeSurroundAudioCodecCapability
    >> {
    const capabilitiesByCodec = {} as Record<
        CustomNativeSurroundAudioCodec,
        CustomNativeSurroundAudioCodecCapability
    >;
    for (const capability of capabilities) {
        capabilitiesByCodec[capability.codec] = capability;
    }
    return Object.freeze(capabilitiesByCodec);
}

function getNativeSurroundAudioProbeCount(
    environment: WebCodecsCapabilityEnvironment
): number {
    return environment.audioDecoder && environment.nativeAudioOutputProbe ?
        NATIVE_SURROUND_AUDIO_PROBE_DEFINITIONS.length :
        0;
}

async function probeNativeVideoConfig(
    definition: DecodedVideoProbeDefinition,
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: NativeVideoOutputProbe | null | undefined
): Promise<CustomDecodeCodecCapability<CustomVideoCodec>> {
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
        if (support.supported !== true) {
            return Object.freeze({
                codec: definition.codec,
                codecString: definition.config.codec,
                reason: 'config-unsupported',
                status: 'unsupported'
            });
        }
        if (!outputProbe) {
            return createUnavailableCapability(definition.codec, definition.config.codec);
        }

        const fixture = definition.outputFixture;
        const outputSupported = await waitForCapabilityProbe(outputProbe({
            codec: definition.codec,
            configuration: {
                ...definition.config,
                codedHeight: fixture.expectedCodedHeight,
                codedWidth: fixture.expectedCodedWidth
            },
            encodedKeyFrame: fixture.encodedKeyFrame.slice(),
            expectedCodedHeight: fixture.expectedCodedHeight,
            expectedCodedWidth: fixture.expectedCodedWidth,
            expectedDisplayHeight: fixture.expectedDisplayHeight,
            expectedDisplayWidth: fixture.expectedDisplayWidth,
            expectedTimestamp: 0
        }));
        if (outputSupported === CAPABILITY_PROBE_TIMEOUT) {
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
            reason: outputSupported ? 'decode-output-verified' : 'decode-output-missing',
            status: outputSupported ? 'supported' : 'unsupported'
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

async function probeNativeUltraHDVideoConfig(
    definition: NativeUltraHDVideoProbeDefinition,
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: NativeVideoOutputProbe | null | undefined
): Promise<CustomNativeUltraHDVideoCodecCapability> {
    const capability: CustomDecodeCodecCapability<CustomVideoCodec> =
        await probeNativeVideoConfig(definition, decoder, outputProbe);
    return Object.freeze({
        bitDepth: CUSTOM_NATIVE_VIDEO_BIT_DEPTH,
        codec: definition.codec,
        codecString: capability.codecString,
        maximumCodedHeight: NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_HEIGHT,
        maximumCodedWidth: NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_WIDTH,
        reason: capability.reason,
        status: capability.status
    });
}

function createNativeUltraHDVideoProbePromises(
    environment: WebCodecsCapabilityEnvironment
): Array<Promise<CustomNativeUltraHDVideoCodecCapability>> {
    const probePromises: Array<Promise<CustomNativeUltraHDVideoCodecCapability>> = [];
    for (const definition of NATIVE_ULTRA_HD_VIDEO_PROBE_DEFINITIONS) {
        probePromises.push(probeNativeUltraHDVideoConfig(
            definition,
            environment.videoDecoder,
            environment.nativeVideoOutputProbe
        ));
    }
    return probePromises;
}

function createNativeUltraHDVideoCapabilities(
    capabilities: readonly CustomNativeUltraHDVideoCodecCapability[]
): Readonly<Record<
        CustomNativeUltraHDVideoCodec,
        CustomNativeUltraHDVideoCodecCapability
    >> {
    const capabilitiesByCodec = {} as Record<
        CustomNativeUltraHDVideoCodec,
        CustomNativeUltraHDVideoCodecCapability
    >;
    for (const capability of capabilities) {
        capabilitiesByCodec[capability.codec] = capability;
    }
    return Object.freeze(capabilitiesByCodec);
}

function getNativeUltraHDVideoProbeCount(
    environment: WebCodecsCapabilityEnvironment
): number {
    return environment.videoDecoder && environment.nativeVideoOutputProbe ?
        NATIVE_ULTRA_HD_VIDEO_PROBE_DEFINITIONS.length :
        0;
}

async function probeNativeDolbyVisionHEVC(
    decoder: DecoderCapabilityAPI<VideoDecoderConfig> | null | undefined,
    outputProbe: NativeDolbyVisionVideoOutputProbe | null | undefined
): Promise<CustomNativeDolbyVisionHEVCCapability> {
    const baseCapability = {
        codec: NATIVE_DOLBY_VISION_HEVC_PROBE_DEFINITION.codec,
        codecString: NATIVE_DOLBY_VISION_HEVC_PROBE_DEFINITION.config.codec,
        bitDepth: 10 as const,
        maximumBitrate: CUSTOM_NATIVE_DOLBY_VISION_HEVC_MAXIMUM_BITRATE,
        maximumCodedHeight: CUSTOM_NATIVE_DOLBY_VISION_HEVC_MAXIMUM_CODED_HEIGHT,
        maximumCodedWidth: CUSTOM_NATIVE_DOLBY_VISION_HEVC_MAXIMUM_CODED_WIDTH,
        maximumLevel: CUSTOM_NATIVE_DOLBY_VISION_HEVC_MAXIMUM_LEVEL,
        profile: 5 as const
    };
    if (!decoder || !outputProbe) {
        return Object.freeze({
            ...baseCapability,
            reason: 'api-unavailable',
            status: 'unknown'
        });
    }

    try {
        const support = await waitForCapabilityProbe(decoder.isConfigSupported({
            ...NATIVE_DOLBY_VISION_HEVC_PROBE_DEFINITION.config
        }));
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

        const outputSupported = await waitForCapabilityProbe(outputProbe({
            configuration: NATIVE_DOLBY_VISION_HEVC_PROBE_DEFINITION.config,
            encodedKeyFrame: new Uint8Array(NATIVE_DOLBY_VISION_HEVC_ACCESS_UNIT),
            expectedCodedHeight: CUSTOM_NATIVE_DOLBY_VISION_HEVC_MAXIMUM_CODED_HEIGHT,
            expectedCodedWidth: CUSTOM_NATIVE_DOLBY_VISION_HEVC_MAXIMUM_CODED_WIDTH
        }));
        if (outputSupported === CAPABILITY_PROBE_TIMEOUT) {
            return Object.freeze({
                ...baseCapability,
                reason: 'probe-timeout',
                status: 'unknown'
            });
        }
        return Object.freeze({
            ...baseCapability,
            reason: outputSupported ? 'decode-output-verified' : 'decode-output-missing',
            status: outputSupported ? 'supported' : 'unsupported'
        });
    } catch {
        return Object.freeze({
            ...baseCapability,
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
            videoProbePromises.push(hasDecodedVideoOutputFixture(definition) ?
                probeNativeVideoConfig(
                    definition,
                    environment.videoDecoder,
                    environment.nativeVideoOutputProbe
                ) :
                probeConfig(definition, environment.videoDecoder));
        }
        const nativeUltraHDVideoProbePromises: Array<Promise<
            CustomNativeUltraHDVideoCodecCapability
        >> =
            createNativeUltraHDVideoProbePromises(environment);
        const audioProbePromises: Array<Promise<CustomDecodeCodecCapability<CustomAudioCodec>>> = [];
        for (const definition of AUDIO_PROBE_DEFINITIONS) {
            audioProbePromises.push(probeNativeAudioConfig(
                definition,
                environment.audioDecoder,
                environment.nativeAudioOutputProbe
            ));
        }
        const nativeSurroundAudioProbePromises: Array<Promise<
            CustomNativeSurroundAudioCodecCapability
        >> = createNativeSurroundAudioProbePromises(environment);
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
            bundledHEVC,
            nativeDolbyVisionHEVC,
            nativeSurroundAudioCapabilities,
            nativeUltraHDVideoCapabilities
        ] = await Promise.all([
            Promise.all(videoProbePromises),
            Promise.all(audioProbePromises),
            Promise.all(rawHDRVideoProbePromises),
            probeH264Profiles(environment.h264ProfileProbe),
            probeBundledHEVC(environment.bundledHEVCExactProbe),
            probeNativeDolbyVisionHEVC(
                environment.videoDecoder,
                environment.nativeDolbyVisionVideoOutputProbe
            ),
            Promise.all(nativeSurroundAudioProbePromises),
            Promise.all(nativeUltraHDVideoProbePromises)
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
        const nativeUltraHDVideo: Readonly<Record<
            CustomNativeUltraHDVideoCodec,
            CustomNativeUltraHDVideoCodecCapability
        >> = createNativeUltraHDVideoCapabilities(nativeUltraHDVideoCapabilities);
        const nativeSurroundAudio: Readonly<Record<
            CustomNativeSurroundAudioCodec,
            CustomNativeSurroundAudioCodecCapability
        >> = createNativeSurroundAudioCapabilities(nativeSurroundAudioCapabilities);

        const allCapabilities: Array<CustomDecodeCodecCapability<CustomDecodeCodec>> = [];
        allCapabilities.push(
            ...videoCapabilities,
            ...audioCapabilities,
            nativeDolbyVisionHEVC,
            ...nativeSurroundAudioCapabilities,
            ...nativeUltraHDVideoCapabilities
        );
        const telemetry = Object.freeze({
            audioProbeCount: environment.audioDecoder ? AUDIO_PROBE_DEFINITIONS.length : 0,
            bundledAudioCodecCount: bundledAC3SoftwareDecoder ?
                BUNDLED_AUDIO_CODEC_DEFINITIONS.length :
                0,
            nativeSurroundAudioProbeCount: getNativeSurroundAudioProbeCount(environment),
            nativeUltraHDVideoProbeCount: getNativeUltraHDVideoProbeCount(environment),
            rawHDRVideoProbeCount: environment.videoDecoder && environment.rawHDRVideoOutputProbe ?
                RAW_HDR_VIDEO_PROBE_DEFINITIONS.length :
                0,
            reason: getProbeReason(environment, allCapabilities),
            supportedAudioCodecCount: audioCapabilities.filter(capability => capability.status === 'supported').length,
            supportedNativeSurroundAudioCodecCount: nativeSurroundAudioCapabilities.filter(
                capability => capability.status === 'supported'
            ).length,
            supportedNativeUltraHDVideoCodecCount: nativeUltraHDVideoCapabilities.filter(
                capability => capability.status === 'supported'
            ).length,
            supportedRawHDRVideoCodecCount: Object.values(rawHDRVideo).filter(capability => (
                capability.status === 'supported'
            )).length,
            supportedVideoCodecCount: getSupportedVideoCodecCount(
                video,
                h264Profiles,
                bundledHEVC
            ),
            unknownAudioCodecCount: audioCapabilities.filter(capability => capability.status === 'unknown').length,
            unknownNativeSurroundAudioCodecCount: nativeSurroundAudioCapabilities.filter(
                capability => capability.status === 'unknown'
            ).length,
            unknownNativeUltraHDVideoCodecCount: nativeUltraHDVideoCapabilities.filter(
                capability => capability.status === 'unknown'
            ).length,
            unknownVideoCodecCount: videoCapabilities.filter(capability => capability.status === 'unknown').length,
            videoProbeCount: environment.videoDecoder ?
                VIDEO_PROBE_DEFINITIONS.length
                    + NATIVE_ULTRA_HD_VIDEO_PROBE_DEFINITIONS.length
                    + 1 :
                0
        });

        return Object.freeze({
            audio: Object.freeze(audio),
            ...(bundledHEVC ? { bundledHEVC } : {}),
            h264Profiles,
            nativeDolbyVisionHEVC,
            nativeSurroundAudio,
            nativeUltraHDVideo,
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
