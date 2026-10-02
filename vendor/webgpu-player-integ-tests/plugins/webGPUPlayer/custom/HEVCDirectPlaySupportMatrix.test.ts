import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import { VideoRangeType } from '@jellyfin/sdk/lib/generated-client/models/video-range-type';
import { describe, expect, it } from 'vitest';

import {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_RAW_HDR_VIDEO_CODECS,
    CUSTOM_VIDEO_CODECS,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomDecodeCodecCapability,
    type CustomRawHDRVideoCodec,
    type CustomRawHDRVideoCodecCapability,
    type CustomVideoCodec
} from 'webgpu-player/custom/CustomDecodeCapabilities';
import {
    augmentDeviceProfileForCustomDecode,
    type CustomDeviceProfileOptions
} from 'plugins/webGPUPlayer/custom/CustomDeviceProfile';
import {
    getCustomPlaybackEligibility,
    type CustomPlaybackEligibility,
    type CustomPlaybackEligibilityOptions,
    type CustomPlaybackIneligibilityReason
} from 'webgpu-player/custom/CustomPlaybackEligibility';
import type { CustomPlaybackRuntimeAvailability } from 'webgpu-player/custom/CustomPlaybackRuntime';
import type {
    CustomDecodeRawVideoFrameFormat,
    CustomDecodeVideoDecoderBackend,
    CustomDecodeVideoOutputMode
} from 'webgpu-player/custom/DecodeWorkerProtocol';
import {
    HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS,
    HEVC_RANGE_EXTENSION_VARIANTS,
    type HEVCRangeExtensionCapability,
    type HEVCRangeExtensionVariant
} from 'webgpu-player/custom/HEVCRangeExtensionCapabilities';
import { isSameSessionNativePlaybackCompatible } from 'plugins/webGPUPlayer/custom/NativeDirectPlayCompatibility';
import {
    RAW_HDR_AUTHORIZATION_ROUTE_KEYS,
    type RawHDRAuthorizationRouteKey
} from 'webgpu-player/validation/RawHDRPresentationAuthorization';

// Mirrors Jellyfin.Data/Enums/VideoRangeType.cs in the backend checkout
const JELLYFIN_VIDEO_RANGE_TYPES = [
    'Unknown',
    'SDR',
    'HDR10',
    'HLG',
    'DOVI',
    'DOVIWithHDR10',
    'DOVIWithHLG',
    'DOVIWithSDR',
    'DOVIWithEL',
    'DOVIWithHDR10Plus',
    'DOVIWithELHDR10Plus',
    'DOVIInvalid',
    'HDR10Plus'
] as const;

/** Orders strings for order-insensitive list comparisons. */
function compareStrings(first: string, second: string): number {
    return first.localeCompare(second);
}

type JellyfinVideoRangeType = typeof JELLYFIN_VIDEO_RANGE_TYPES[number];

const STATIC_HEVC_VIDEO_RANGE_TYPES = [
    'SDR',
    'HDR10',
    'HLG',
    'HDR10Plus'
] as const satisfies readonly JellyfinVideoRangeType[];

const DOLBY_VISION_HEVC_VIDEO_RANGE_TYPES = [
    'DOVI',
    'DOVIWithHDR10',
    'DOVIWithHLG',
    'DOVIWithSDR',
    'DOVIWithEL',
    'DOVIWithHDR10Plus',
    'DOVIWithELHDR10Plus'
] as const satisfies readonly JellyfinVideoRangeType[];

const STATIC_HEVC_VIDEO_RANGE_TYPE_SET = new Set<JellyfinVideoRangeType>(
    STATIC_HEVC_VIDEO_RANGE_TYPES
);
const DOLBY_VISION_HEVC_VIDEO_RANGE_TYPE_SET = new Set<JellyfinVideoRangeType>(
    DOLBY_VISION_HEVC_VIDEO_RANGE_TYPES
);

// The eligibility fields that select the decoder backend and WebGPU presentation pipeline
type ExpectedHEVCRoute = Readonly<{
    dolbyVisionProfile: 5 | 7 | 8 | null
    hdr: boolean
    nativeHDRTransfer: 'hlg' | 'pq' | null
    neutralizeHDRColorMetadata: boolean
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    videoOutputMode: CustomDecodeVideoOutputMode
}>;

type HEVCDirectPlayMatrixRow = Readonly<{
    deviceProfileAdvertised: boolean
    directPlaySupported: boolean
    expectedIneligibilityReason?: CustomPlaybackIneligibilityReason
    expectedRoute?: ExpectedHEVCRoute
    label: string
    runtimeEligible: boolean
    videoStream: Readonly<Record<string, unknown>>
}>;

type HEVCRouteFallbackRow = Readonly<{
    label: string
    rawPresentationRoute: ExpectedHEVCRoute | null
    softwareDecodeRoute: ExpectedHEVCRoute | null
    videoStream: Readonly<Record<string, unknown>>
}>;

const NATIVE_SDR_VIDEO_FRAME_ROUTE: ExpectedHEVCRoute = {
    dolbyVisionProfile: null,
    hdr: false,
    nativeHDRTransfer: null,
    neutralizeHDRColorMetadata: false,
    rawVideoFrameFormat: null,
    videoDecoderBackend: 'native',
    videoOutputMode: 'video-frame'
};

const BUNDLED_SDR_VIDEO_FRAME_ROUTE: ExpectedHEVCRoute = {
    ...NATIVE_SDR_VIDEO_FRAME_ROUTE,
    videoDecoderBackend: 'bundled-hevc'
};

// Also the Dolby Vision native-base route: the compatible base presents as static HDR
const NATIVE_EXTERNAL_PQ_ROUTE: ExpectedHEVCRoute = {
    dolbyVisionProfile: null,
    hdr: true,
    nativeHDRTransfer: 'pq',
    neutralizeHDRColorMetadata: true,
    rawVideoFrameFormat: null,
    videoDecoderBackend: 'native',
    videoOutputMode: 'video-frame'
};

const NATIVE_EXTERNAL_HLG_ROUTE: ExpectedHEVCRoute = {
    ...NATIVE_EXTERNAL_PQ_ROUTE,
    nativeHDRTransfer: 'hlg'
};

const NATIVE_DOLBY_VISION_PROFILE_5_ROUTE: ExpectedHEVCRoute = {
    dolbyVisionProfile: 5,
    hdr: true,
    nativeHDRTransfer: null,
    neutralizeHDRColorMetadata: false,
    rawVideoFrameFormat: null,
    videoDecoderBackend: 'native',
    videoOutputMode: 'video-frame'
};

function createRawPlaneRoute(
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat,
    hdr: boolean,
    videoDecoderBackend: CustomDecodeVideoDecoderBackend = 'native'
): ExpectedHEVCRoute {
    return {
        dolbyVisionProfile: null,
        hdr,
        nativeHDRTransfer: null,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat,
        videoDecoderBackend,
        videoOutputMode: 'raw-planes'
    };
}

function createRawDolbyVisionRoute(
    dolbyVisionProfile: 5 | 7 | 8,
    videoDecoderBackend: CustomDecodeVideoDecoderBackend = 'native'
): ExpectedHEVCRoute {
    return {
        ...createRawPlaneRoute('I420P10', true, videoDecoderBackend),
        dolbyVisionProfile
    };
}

function getStaticHEVCRoute(range: JellyfinVideoRangeType): ExpectedHEVCRoute | undefined {
    switch (range) {
        case 'SDR':
            return NATIVE_SDR_VIDEO_FRAME_ROUTE;
        case 'HDR10':
        case 'HDR10Plus':
            return NATIVE_EXTERNAL_PQ_ROUTE;
        case 'HLG':
            return NATIVE_EXTERNAL_HLG_ROUTE;
        default:
            return undefined;
    }
}

function getEligibleRoute(eligibility: CustomPlaybackEligibility): ExpectedHEVCRoute | null {
    if (!eligibility.eligible) {
        return null;
    }
    return {
        dolbyVisionProfile: eligibility.dolbyVisionProfile,
        hdr: eligibility.hdr,
        nativeHDRTransfer: eligibility.nativeHDRTransfer ?? null,
        neutralizeHDRColorMetadata: eligibility.neutralizeHDRColorMetadata,
        rawVideoFrameFormat: eligibility.rawVideoFrameFormat,
        videoDecoderBackend: eligibility.videoDecoderBackend,
        videoOutputMode: eligibility.videoOutputMode
    };
}

const AVAILABLE_RUNTIME: CustomPlaybackRuntimeAvailability = {
    available: true,
    environment: {
        animationFrame: true,
        audioContext: true,
        audioData: true,
        audioDecoder: true,
        audioWorklet: true,
        secureContext: true,
        videoDecoder: true,
        videoFrame: true,
        webGPU: true,
        worker: true
    },
    reason: null
};

const EXTERNAL_HDR_ROUTE_KEYS = [
    'external-hevc-main10-bt709-limited:pq-v1',
    'external-hevc-main10-bt709-limited:hlg-v1'
] as const;

const RAW_HDR_ROUTE_KEYS: readonly RawHDRAuthorizationRouteKey[] =
    RAW_HDR_AUTHORIZATION_ROUTE_KEYS;

const FULL_ROUTE_OPTIONS: CustomDeviceProfileOptions = {
    allowDolbyVision: true,
    allowDolbyVisionProfile7: true,
    allowDolbyVisionProfile7HDR10Base: true,
    allowNativeDolbyVision: true,
    allowNativeDolbyVisionProfile7HDR10Base: true,
    allowNativeDolbyVisionProfile8HDR10Base: true,
    allowNativeDolbyVisionProfile8HLGBase: true,
    allowNativeHDR: true,
    allowRawHDR: true,
    allowRawSDR: true,
    authorizedExternalHDRRouteKeys: EXTERNAL_HDR_ROUTE_KEYS,
    authorizedRawHDRRouteKeys: RAW_HDR_ROUTE_KEYS
};

const FULL_ELIGIBILITY_OPTIONS: CustomPlaybackEligibilityOptions = {
    allowDolbyVision: true,
    allowDolbyVisionProfile7: true,
    allowNativeDolbyVision: true,
    allowNativeDolbyVisionProfile7HDR10Base: true,
    allowNativeDolbyVisionProfile8HDR10Base: true,
    allowNativeDolbyVisionProfile8HLGBase: true,
    allowNativeHDR: true,
    allowRawHDR: true,
    allowRawSDR: true,
    authorizedExternalHDRRouteKeys: EXTERNAL_HDR_ROUTE_KEYS,
    authorizedRawHDRRouteKeys: RAW_HDR_ROUTE_KEYS,
    runtimeAvailability: AVAILABLE_RUNTIME
};

function createCodecCapability<Codec extends CustomAudioCodec | CustomVideoCodec>(
    codec: Codec,
    supported: boolean
): CustomDecodeCodecCapability<Codec> {
    return {
        codec,
        codecString: codec,
        reason: supported ? 'decode-output-verified' : 'config-unsupported',
        status: supported ? 'supported' : 'unsupported'
    };
}

function createRawHDRCapability(
    codec: CustomRawHDRVideoCodec,
    supported: boolean
): CustomRawHDRVideoCodecCapability {
    return {
        bitDepth: 10,
        codec,
        codecString: codec === 'hevc' ? 'hvc1.2.4.L153.B0' : codec,
        format: 'I420P10',
        reason: supported ? 'output-copy-supported' : 'output-copy-unsupported',
        status: supported ? 'supported' : 'unsupported'
    };
}

function createHEVCRangeExtensionCapability(
    variant: HEVCRangeExtensionVariant
): HEVCRangeExtensionCapability {
    const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
    return {
        bitDepth: definition.bitDepth,
        chromaFormat: definition.chromaFormat,
        codec: 'hevc',
        codecString: definition.config.codec,
        format: definition.format,
        jellyfinProfile: definition.jellyfinProfile,
        pixelFormat: definition.pixelFormat,
        reason: 'output-copy-supported',
        status: 'supported',
        variant
    };
}

function createFullyQualifiedHEVCCapabilities(): CustomDecodeCapabilities {
    const audio = {} as Record<
        CustomAudioCodec,
        CustomDecodeCodecCapability<CustomAudioCodec>
    >;
    for (const codec of CUSTOM_AUDIO_CODECS) {
        audio[codec] = createCodecCapability(codec, codec === 'aac');
    }

    const video = {} as Record<
        CustomVideoCodec,
        CustomDecodeCodecCapability<CustomVideoCodec>
    >;
    for (const codec of CUSTOM_VIDEO_CODECS) {
        video[codec] = createCodecCapability(codec, codec === 'hevc');
    }

    const rawHDRVideo = {} as Record<
        CustomRawHDRVideoCodec,
        CustomRawHDRVideoCodecCapability
    >;
    for (const codec of CUSTOM_RAW_HDR_VIDEO_CODECS) {
        rawHDRVideo[codec] = createRawHDRCapability(codec, codec === 'hevc');
    }

    const hevcRangeExtensions = {} as Record<
        HEVCRangeExtensionVariant,
        HEVCRangeExtensionCapability
    >;
    for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
        hevcRangeExtensions[variant] = createHEVCRangeExtensionCapability(variant);
    }

    return {
        audio,
        bundledHEVC: {
            qualifications: {
                'main-1080p': {
                    bitDepth: 8,
                    codecString: 'hvc1.1.6.L120.B0',
                    fixture: 'main-1080p',
                    format: 'I420',
                    profile: 'main',
                    reason: 'decode-output-verified',
                    status: 'supported'
                },
                'main10-1080p': {
                    bitDepth: 10,
                    codecString: 'hvc1.2.4.L120.B0',
                    fixture: 'main10-1080p',
                    format: 'I420P10',
                    profile: 'main10',
                    reason: 'decode-output-verified',
                    status: 'supported'
                },
                'main10-4k': {
                    bitDepth: 10,
                    codecString: 'hvc1.2.4.L153.B0',
                    fixture: 'main10-4k',
                    format: 'I420P10',
                    profile: 'main10',
                    reason: 'decode-output-verified',
                    status: 'supported'
                }
            },
            reason: 'complete'
        },
        hevcRangeExtensions,
        nativeDolbyVisionHEVC: {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hev1.2.4.H150.B0',
            profile: 5,
            reason: 'decode-output-verified',
            status: 'supported'
        },
        nativeHDRHEVC: {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            reason: 'decode-output-verified',
            status: 'supported'
        },
        rawHDRVideo,
        telemetry: {
            audioProbeCount: CUSTOM_AUDIO_CODECS.length,
            bundledAudioCodecCount: 0,
            nativeSurroundAudioProbeCount: 0,
            nativeHDRVideoProbeCount: 1,
            nativeUltraHDVideoProbeCount: 0,
            rawHDRVideoProbeCount: CUSTOM_RAW_HDR_VIDEO_CODECS.length,
            reason: 'complete',
            supportedAudioCodecCount: 1,
            supportedNativeSurroundAudioCodecCount: 0,
            supportedNativeHDRVideoCodecCount: 1,
            supportedNativeUltraHDVideoCodecCount: 0,
            supportedRawHDRVideoCodecCount: 1,
            supportedVideoCodecCount: 1,
            unknownAudioCodecCount: 0,
            unknownNativeSurroundAudioCodecCount: 0,
            unknownNativeHDRVideoCodecCount: 0,
            unknownNativeUltraHDVideoCodecCount: 0,
            unknownVideoCodecCount: 0,
            videoProbeCount: CUSTOM_VIDEO_CODECS.length
        },
        video
    };
}

function createSDRHEVCStream(
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    return {
        BitDepth: 8,
        Codec: 'hevc',
        ColorPrimaries: 'bt709',
        ColorRange: 'tv',
        ColorSpace: 'bt709',
        ColorTransfer: 'bt709',
        Height: 1_080,
        Index: 0,
        IsInterlaced: false,
        Level: 120,
        Profile: 'Main',
        Type: 'Video',
        VideoRange: 'SDR',
        VideoRangeType: 'SDR',
        Width: 1_920,
        ...overrides
    };
}

function createHDRHEVCStream(
    videoRangeType: JellyfinVideoRangeType,
    transfer: 'hlg' | 'pq',
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    return createSDRHEVCStream({
        BitDepth: 10,
        ColorPrimaries: 'bt2020',
        ColorSpace: 'bt2020nc',
        ColorTransfer: transfer === 'pq' ? 'smpte2084' : 'arib-std-b67',
        Height: 2_160,
        Level: 153,
        Profile: 'Main 10',
        VideoRange: 'HDR',
        VideoRangeType: videoRangeType,
        Width: 3_840,
        ...overrides
    });
}

function createDolbyVisionHEVCStream(
    profile: number,
    compatibilityID: number | null,
    videoRangeType: JellyfinVideoRangeType,
    transfer: 'hlg' | 'pq',
    enhancementLayerPresent: boolean,
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    return createHDRHEVCStream(videoRangeType, transfer, {
        BlPresentFlag: true,
        DvProfile: profile,
        ElPresentFlag: enhancementLayerPresent,
        RpuPresentFlag: true,
        ...(compatibilityID === null ? {} : {
            DvBlSignalCompatibilityId: compatibilityID
        }),
        ...overrides
    });
}

function createHEVCStreamForRangeType(
    videoRangeType: JellyfinVideoRangeType,
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    switch (videoRangeType) {
        case 'SDR':
            return createSDRHEVCStream(overrides);
        case 'HLG':
        case 'DOVIWithHLG':
            return createHDRHEVCStream(videoRangeType, 'hlg', overrides);
        case 'DOVIWithSDR':
            return createSDRHEVCStream({
                VideoRangeType: videoRangeType,
                ...overrides
            });
        case 'HDR10Plus':
        case 'DOVIWithHDR10Plus':
        case 'DOVIWithELHDR10Plus':
            return createHDRHEVCStream(videoRangeType, 'pq', {
                Hdr10PlusPresentFlag: true,
                ...overrides
            });
        case 'Unknown':
        case 'HDR10':
        case 'DOVI':
        case 'DOVIWithHDR10':
        case 'DOVIWithEL':
        case 'DOVIInvalid':
            return createHDRHEVCStream(videoRangeType, 'pq', overrides);
    }
}

type HEVCRangeExtensionRange = 'HDR10' | 'HDR10Plus' | 'HLG' | 'SDR';

function createHEVCRangeExtensionStream(
    variant: HEVCRangeExtensionVariant,
    range: HEVCRangeExtensionRange,
    overrides: Readonly<Record<string, unknown>> = {}
): Readonly<Record<string, unknown>> {
    const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
    const rangeExtensionMetadata = {
        BitDepth: definition.bitDepth,
        PixelFormat: definition.pixelFormat,
        Profile: 'Rext',
        ...overrides
    };
    switch (range) {
        case 'SDR':
            return createSDRHEVCStream(rangeExtensionMetadata);
        case 'HLG':
            return createHDRHEVCStream('HLG', 'hlg', rangeExtensionMetadata);
        case 'HDR10':
            return createHDRHEVCStream('HDR10', 'pq', rangeExtensionMetadata);
        case 'HDR10Plus':
            return createHDRHEVCStream('HDR10Plus', 'pq', {
                Hdr10PlusPresentFlag: true,
                ...rangeExtensionMetadata
            });
    }
}

function createHEVCRangeExtensionSupportMatrix(): HEVCDirectPlayMatrixRow[] {
    const rows: HEVCDirectPlayMatrixRow[] = [];
    for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
        const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
        for (const range of JELLYFIN_VIDEO_RANGE_TYPES) {
            const supported = STATIC_HEVC_VIDEO_RANGE_TYPE_SET.has(range)
                && (range === 'SDR' || definition.bitDepth >= 10);
            rows.push({
                deviceProfileAdvertised: supported,
                directPlaySupported: supported,
                ...(supported ? {
                    expectedRoute: createRawPlaneRoute(definition.format, range !== 'SDR')
                } : {}),
                label: `${range} Rext ${definition.bitDepth}-bit ${definition.chromaFormat} ${definition.pixelFormat}`,
                runtimeEligible: supported,
                videoStream: createHEVCStreamForRangeType(range, {
                    BitDepth: definition.bitDepth,
                    PixelFormat: definition.pixelFormat,
                    Profile: 'Rext'
                })
            });
        }
    }
    return rows;
}

function createOrdinaryHEVCSupportMatrix(): HEVCDirectPlayMatrixRow[] {
    const rows: HEVCDirectPlayMatrixRow[] = [];
    const profiles = [
        { bitDepth: 8, label: 'Main', profile: 'Main' },
        { bitDepth: 10, label: 'Main 10', profile: 'Main 10' }
    ] as const;
    for (const profile of profiles) {
        for (const range of JELLYFIN_VIDEO_RANGE_TYPES) {
            const staticRangeSupported = STATIC_HEVC_VIDEO_RANGE_TYPE_SET.has(range)
                && (profile.bitDepth === 10 || range === 'SDR');
            const deviceProfileAdvertised = staticRangeSupported
                || (
                    profile.bitDepth === 10
                    && DOLBY_VISION_HEVC_VIDEO_RANGE_TYPE_SET.has(range)
                );
            const expectedRoute = staticRangeSupported ? getStaticHEVCRoute(range) : undefined;
            rows.push({
                deviceProfileAdvertised,
                directPlaySupported: staticRangeSupported,
                ...(expectedRoute ? { expectedRoute } : {}),
                label: `${range} ${profile.label} ${profile.bitDepth}-bit without Dolby Vision descriptor`,
                runtimeEligible: staticRangeSupported,
                videoStream: createHEVCStreamForRangeType(range, {
                    BitDepth: profile.bitDepth,
                    Profile: profile.profile
                })
            });
        }
    }
    return rows;
}

function createPlaybackOptions(
    videoStream: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
    return {
        mediaSource: {
            Container: 'mkv',
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
                videoStream,
                {
                    Channels: 2,
                    Codec: 'aac',
                    Index: 1,
                    SampleRate: 48_000,
                    Type: 'Audio'
                }
            ],
            RunTimeTicks: 60_000_000,
            SupportsDirectPlay: true
        },
        playMethod: 'DirectPlay',
        playerStartPositionTicks: 0,
        url: '/Videos/item/stream.mkv'
    };
}

const HEVC_ORDINARY_RANGE_MATRIX: readonly HEVCDirectPlayMatrixRow[] =
    createOrdinaryHEVCSupportMatrix();

const HEVC_VIDEO_RANGE_MATRIX: readonly HEVCDirectPlayMatrixRow[] = [
    ...HEVC_ORDINARY_RANGE_MATRIX,
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: NATIVE_DOLBY_VISION_PROFILE_5_ROUTE,
        label: 'Dolby Vision Profile 5 with compatibility ID 0',
        runtimeEligible: true,
        videoStream: createDolbyVisionHEVCStream(5, 0, 'DOVI', 'pq', false)
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: NATIVE_DOLBY_VISION_PROFILE_5_ROUTE,
        label: 'Dolby Vision Profile 5 with absent compatibility ID',
        runtimeEligible: true,
        videoStream: createDolbyVisionHEVCStream(5, null, 'DOVI', 'pq', false)
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: NATIVE_EXTERNAL_PQ_ROUTE,
        label: 'Dolby Vision Profile 7 with compatibility ID 6, MEL or FEL',
        runtimeEligible: true,
        videoStream: createDolbyVisionHEVCStream(7, 6, 'DOVIWithEL', 'pq', true)
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: false,
        expectedIneligibilityReason: 'video-track-unavailable',
        label: 'Dolby Vision Profile 7 with a non-6 compatibility ID',
        runtimeEligible: false,
        videoStream: createDolbyVisionHEVCStream(7, 1, 'DOVIWithEL', 'pq', true)
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: false,
        expectedIneligibilityReason: 'video-track-unavailable',
        label: 'Dolby Vision Profile 7 without an enhancement layer',
        runtimeEligible: false,
        videoStream: createDolbyVisionHEVCStream(7, 6, 'DOVIWithEL', 'pq', false)
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: false,
        expectedIneligibilityReason: 'video-track-unavailable',
        label: 'Dolby Vision Profile 5 with a nonzero compatibility ID',
        runtimeEligible: false,
        videoStream: createDolbyVisionHEVCStream(5, 1, 'DOVI', 'pq', false)
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: false,
        expectedIneligibilityReason: 'video-track-unavailable',
        label: 'Dolby Vision Profile 8.1 with an enhancement layer',
        runtimeEligible: false,
        videoStream: createDolbyVisionHEVCStream(8, 1, 'DOVIWithHDR10', 'pq', true)
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: NATIVE_EXTERNAL_PQ_ROUTE,
        label: 'Dolby Vision Profile 8 with compatibility ID 1, HDR10 base',
        runtimeEligible: true,
        videoStream: createDolbyVisionHEVCStream(8, 1, 'DOVIWithHDR10', 'pq', false)
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: NATIVE_EXTERNAL_HLG_ROUTE,
        label: 'Dolby Vision Profile 8 with compatibility ID 4, HLG base',
        runtimeEligible: true,
        videoStream: createDolbyVisionHEVCStream(8, 4, 'DOVIWithHLG', 'hlg', false)
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        // No native SDR base route exists, so Profile 8.2 always reconstructs from the RPU
        expectedRoute: createRawDolbyVisionRoute(8),
        label: 'Dolby Vision Profile 8 with compatibility ID 2, SDR base',
        runtimeEligible: true,
        videoStream: createDolbyVisionHEVCStream(8, 2, 'DOVIWithSDR', 'pq', false, {
            ColorPrimaries: 'bt709',
            ColorSpace: 'bt709',
            ColorTransfer: 'bt709',
            VideoRange: 'SDR'
        })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: NATIVE_EXTERNAL_PQ_ROUTE,
        label: 'Dolby Vision Profile 8 with compatibility ID 1 plus HDR10+ metadata',
        runtimeEligible: true,
        videoStream: createDolbyVisionHEVCStream(8, 1, 'DOVIWithHDR10Plus', 'pq', false, {
            Hdr10PlusPresentFlag: true
        })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: NATIVE_EXTERNAL_PQ_ROUTE,
        label: 'Dolby Vision Profile 7 with compatibility ID 6 plus HDR10+ metadata',
        runtimeEligible: true,
        videoStream: createDolbyVisionHEVCStream(7, 6, 'DOVIWithELHDR10Plus', 'pq', true, {
            Hdr10PlusPresentFlag: true
        })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'video-track-unavailable',
        label: 'Dolby Vision invalid Profile 8 compatibility ID',
        runtimeEligible: false,
        videoStream: createDolbyVisionHEVCStream(8, 6, 'DOVIInvalid', 'pq', false)
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: false,
        expectedIneligibilityReason: 'video-track-unavailable',
        label: 'Dolby Vision Profile 4',
        runtimeEligible: false,
        videoStream: createDolbyVisionHEVCStream(4, 2, 'SDR', 'pq', true, {
            ColorPrimaries: 'bt709',
            ColorSpace: 'bt709',
            ColorTransfer: 'bt709',
            VideoRange: 'SDR'
        })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: false,
        expectedIneligibilityReason: 'video-track-unavailable',
        label: 'Dolby Vision Profile 20',
        runtimeEligible: false,
        videoStream: createDolbyVisionHEVCStream(
            20,
            1,
            'DOVIWithHDR10',
            'pq',
            false
        )
    }
];

const HEVC_RANGE_EXTENSION_MATRIX: readonly HEVCDirectPlayMatrixRow[] =
    createHEVCRangeExtensionSupportMatrix();

const HEVC_PROFILE_BOUNDARY_MATRIX: readonly HEVCDirectPlayMatrixRow[] = [
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'codec-unsupported',
        label: 'SDR Main Still Picture',
        runtimeEligible: false,
        videoStream: createSDRHEVCStream({ Profile: 'Main Still Picture' })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawPlaneRoute('I420P12', false),
        label: 'Named Main 12 alias with exact 12-bit 4:2:0 pixel format',
        runtimeEligible: true,
        videoStream: createHEVCRangeExtensionStream('main12-420', 'SDR', {
            Profile: 'Main 12'
        })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawPlaneRoute('I420P12', true),
        label: 'Named Main 12 HDR10 alias with exact 12-bit 4:2:0 pixel format',
        runtimeEligible: true,
        videoStream: createHEVCRangeExtensionStream('main12-420', 'HDR10', {
            Profile: 'Main 12'
        })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: false,
        expectedIneligibilityReason: 'codec-unsupported',
        label: 'Rext pixel format contradicts explicit bit depth',
        runtimeEligible: false,
        videoStream: createHEVCRangeExtensionStream('main422-12', 'SDR', {
            BitDepth: 10
        })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'codec-unsupported',
        label: 'Main 10 profile with 8-bit SDR output remains unqualified',
        runtimeEligible: false,
        videoStream: createSDRHEVCStream({ Profile: 'Main 10' })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'codec-unsupported',
        label: 'Main profile with 10-bit SDR output remains unqualified',
        runtimeEligible: false,
        videoStream: createSDRHEVCStream({ BitDepth: 10 })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'hdr-codec-unsupported',
        label: 'Main 10 profile with 12-bit HDR10 output remains unqualified',
        runtimeEligible: false,
        videoStream: createHDRHEVCStream('HDR10', 'pq', { BitDepth: 12 })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'hdr-codec-unsupported',
        label: 'Generic Rext does not inherit Dolby Vision Profile 8 support',
        runtimeEligible: false,
        videoStream: createDolbyVisionHEVCStream(
            8,
            1,
            'DOVIWithHDR10',
            'pq',
            false,
            {
                PixelFormat: 'yuv420p10le',
                Profile: 'Rext'
            }
        )
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'video-track-unavailable',
        label: 'Named Main 12 does not inherit Dolby Vision Profile 8 support',
        runtimeEligible: false,
        videoStream: createDolbyVisionHEVCStream(
            8,
            1,
            'DOVIWithHDR10',
            'pq',
            false,
            {
                BitDepth: 12,
                PixelFormat: 'yuv420p12le',
                Profile: 'Main 12'
            }
        )
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: true,
        expectedRoute: createRawPlaneRoute('I444P10', false),
        label: 'Generic Rext Intra constraint uses the qualified 10-bit 4:4:4 tuple',
        runtimeEligible: true,
        videoStream: createHEVCRangeExtensionStream('main444-10', 'SDR', {
            HEVCIntraConstraintFlag: true
        })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'codec-unsupported',
        label: 'Exact named Rext Intra alias is not emitted by current Jellyfin metadata',
        runtimeEligible: false,
        videoStream: createHEVCRangeExtensionStream('main444-10', 'SDR', {
            Profile: 'Main 4:4:4 10 Intra'
        })
    },
    {
        deviceProfileAdvertised: true,
        directPlaySupported: false,
        expectedIneligibilityReason: 'codec-unsupported',
        label: 'Generic Rext monochrome output cannot be distinguished during negotiation',
        runtimeEligible: false,
        videoStream: createSDRHEVCStream({
            BitDepth: 12,
            PixelFormat: 'gray12le',
            Profile: 'Rext'
        })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'codec-unsupported',
        label: 'Rext 14-bit extension remains unsupported',
        runtimeEligible: false,
        videoStream: createSDRHEVCStream({
            BitDepth: 14,
            PixelFormat: 'yuv444p14le',
            Profile: 'Rext'
        })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'codec-unsupported',
        label: 'Rext 16-bit extension remains unsupported',
        runtimeEligible: false,
        videoStream: createSDRHEVCStream({
            BitDepth: 16,
            PixelFormat: 'yuv444p16le',
            Profile: 'Rext'
        })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'codec-unsupported',
        label: 'High Throughput 4:4:4 10 extension remains unsupported',
        runtimeEligible: false,
        videoStream: createSDRHEVCStream({
            BitDepth: 10,
            PixelFormat: 'yuv444p10le',
            Profile: 'High Throughput 4:4:4 10'
        })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'codec-unsupported',
        label: 'Screen-Extended Main 4:4:4 10 extension remains unsupported',
        runtimeEligible: false,
        videoStream: createSDRHEVCStream({
            BitDepth: 10,
            PixelFormat: 'yuv444p10le',
            Profile: 'Screen-Extended Main 4:4:4 10'
        })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        // Runtime infers the exact depth from PixelFormat; required VideoBitDepth cannot match
        expectedRoute: createRawPlaneRoute('I422P12', false),
        label: 'Rext with omitted BitDepth is runtime-exact but not negotiable',
        runtimeEligible: true,
        videoStream: createHEVCRangeExtensionStream('main422-12', 'SDR', {
            BitDepth: null
        })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'interlaced-video-unsupported',
        label: 'Interlaced HDR10 Main 10',
        runtimeEligible: false,
        videoStream: createHDRHEVCStream('HDR10', 'pq', { IsInterlaced: true })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'interlaced-video-unsupported',
        label: 'Interlaced SDR Main',
        runtimeEligible: false,
        videoStream: createSDRHEVCStream({ IsInterlaced: true })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'interlaced-video-unsupported',
        label: 'Interlaced SDR Rext 10-bit 4:2:2',
        runtimeEligible: false,
        videoStream: createHEVCRangeExtensionStream('main422-10', 'SDR', {
            IsInterlaced: true
        })
    },
    {
        deviceProfileAdvertised: false,
        directPlaySupported: false,
        expectedIneligibilityReason: 'interlaced-video-unsupported',
        label: 'Interlaced Dolby Vision Profile 8.1',
        runtimeEligible: false,
        videoStream: createDolbyVisionHEVCStream(8, 1, 'DOVIWithHDR10', 'pq', false, {
            IsInterlaced: true
        })
    }
];

// Representative eligible variants; native VideoFrame routes are preferred when authorized
const HEVC_ROUTE_FALLBACK_MATRIX: readonly HEVCRouteFallbackRow[] = [
    {
        label: 'SDR Main 8-bit',
        rawPresentationRoute: NATIVE_SDR_VIDEO_FRAME_ROUTE,
        softwareDecodeRoute: BUNDLED_SDR_VIDEO_FRAME_ROUTE,
        videoStream: createSDRHEVCStream()
    },
    {
        label: 'SDR Main 10 10-bit',
        rawPresentationRoute: NATIVE_SDR_VIDEO_FRAME_ROUTE,
        softwareDecodeRoute: null,
        videoStream: createSDRHEVCStream({ BitDepth: 10, Profile: 'Main 10' })
    },
    {
        label: 'HDR10 Main 10',
        rawPresentationRoute: createRawPlaneRoute('I420P10', true),
        softwareDecodeRoute: createRawPlaneRoute('I420P10', true, 'bundled-hevc'),
        videoStream: createHDRHEVCStream('HDR10', 'pq')
    },
    {
        label: 'HDR10+ Main 10',
        rawPresentationRoute: createRawPlaneRoute('I420P10', true),
        softwareDecodeRoute: createRawPlaneRoute('I420P10', true, 'bundled-hevc'),
        videoStream: createHDRHEVCStream('HDR10Plus', 'pq', { Hdr10PlusPresentFlag: true })
    },
    {
        label: 'HLG Main 10',
        rawPresentationRoute: createRawPlaneRoute('I420P10', true),
        softwareDecodeRoute: createRawPlaneRoute('I420P10', true, 'bundled-hevc'),
        videoStream: createHDRHEVCStream('HLG', 'hlg')
    },
    {
        label: 'Dolby Vision Profile 5',
        rawPresentationRoute: createRawDolbyVisionRoute(5),
        softwareDecodeRoute: createRawDolbyVisionRoute(5, 'bundled-hevc'),
        videoStream: createDolbyVisionHEVCStream(5, 0, 'DOVI', 'pq', false)
    },
    {
        label: 'Dolby Vision Profile 7 with compatibility ID 6',
        rawPresentationRoute: createRawDolbyVisionRoute(7),
        softwareDecodeRoute: createRawDolbyVisionRoute(7, 'bundled-hevc'),
        videoStream: createDolbyVisionHEVCStream(7, 6, 'DOVIWithEL', 'pq', true)
    },
    {
        label: 'Dolby Vision Profile 7 plus HDR10+ metadata',
        rawPresentationRoute: createRawDolbyVisionRoute(7),
        softwareDecodeRoute: createRawDolbyVisionRoute(7, 'bundled-hevc'),
        videoStream: createDolbyVisionHEVCStream(7, 6, 'DOVIWithELHDR10Plus', 'pq', true, {
            Hdr10PlusPresentFlag: true
        })
    },
    {
        label: 'Dolby Vision Profile 8.1',
        rawPresentationRoute: createRawDolbyVisionRoute(8),
        softwareDecodeRoute: createRawDolbyVisionRoute(8, 'bundled-hevc'),
        videoStream: createDolbyVisionHEVCStream(8, 1, 'DOVIWithHDR10', 'pq', false)
    },
    {
        label: 'Dolby Vision Profile 8.1 plus HDR10+ metadata',
        rawPresentationRoute: createRawDolbyVisionRoute(8),
        softwareDecodeRoute: createRawDolbyVisionRoute(8, 'bundled-hevc'),
        videoStream: createDolbyVisionHEVCStream(8, 1, 'DOVIWithHDR10Plus', 'pq', false, {
            Hdr10PlusPresentFlag: true
        })
    },
    {
        label: 'Dolby Vision Profile 8.2',
        rawPresentationRoute: createRawDolbyVisionRoute(8),
        softwareDecodeRoute: createRawDolbyVisionRoute(8, 'bundled-hevc'),
        videoStream: createDolbyVisionHEVCStream(8, 2, 'DOVIWithSDR', 'pq', false, {
            ColorPrimaries: 'bt709',
            ColorSpace: 'bt709',
            ColorTransfer: 'bt709',
            VideoRange: 'SDR'
        })
    },
    {
        label: 'Dolby Vision Profile 8.4',
        rawPresentationRoute: createRawDolbyVisionRoute(8),
        softwareDecodeRoute: createRawDolbyVisionRoute(8, 'bundled-hevc'),
        videoStream: createDolbyVisionHEVCStream(8, 4, 'DOVIWithHLG', 'hlg', false)
    },
    {
        label: 'SDR Rext 8-bit 4:2:2',
        rawPresentationRoute: createRawPlaneRoute('I422', false),
        softwareDecodeRoute: null,
        videoStream: createHEVCRangeExtensionStream('main422-8', 'SDR')
    },
    {
        label: 'HDR10 Rext 12-bit 4:4:4',
        rawPresentationRoute: createRawPlaneRoute('I444P12', true),
        softwareDecodeRoute: null,
        videoStream: createHEVCRangeExtensionStream('main444-12', 'HDR10')
    }
];

// Withholds only native VideoFrame HDR and Dolby Vision presentation authorization
const RAW_PRESENTATION_OVERRIDES = {
    allowNativeDolbyVision: false,
    allowNativeDolbyVisionProfile7HDR10Base: false,
    allowNativeDolbyVisionProfile8HDR10Base: false,
    allowNativeDolbyVisionProfile8HLGBase: false,
    allowNativeHDR: false,
    authorizedExternalHDRRouteKeys: []
} as const;

const RAW_PRESENTATION_ROUTE_OPTIONS: CustomDeviceProfileOptions = {
    ...FULL_ROUTE_OPTIONS,
    ...RAW_PRESENTATION_OVERRIDES
};

const RAW_PRESENTATION_ELIGIBILITY_OPTIONS: CustomPlaybackEligibilityOptions = {
    ...FULL_ELIGIBILITY_OPTIONS,
    ...RAW_PRESENTATION_OVERRIDES
};

/** Removes every native HEVC decode path; only the bundled WASM decoder remains. */
function createSoftwareDecodeHEVCCapabilities(): CustomDecodeCapabilities {
    const capabilities = createFullyQualifiedHEVCCapabilities();
    const hevcRangeExtensions = {} as Record<
        HEVCRangeExtensionVariant,
        HEVCRangeExtensionCapability
    >;
    for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
        hevcRangeExtensions[variant] = {
            ...createHEVCRangeExtensionCapability(variant),
            reason: 'config-unsupported',
            status: 'unsupported'
        };
    }
    return {
        ...capabilities,
        hevcRangeExtensions,
        nativeDolbyVisionHEVC: capabilities.nativeDolbyVisionHEVC && {
            ...capabilities.nativeDolbyVisionHEVC,
            reason: 'config-unsupported',
            status: 'unsupported'
        },
        nativeHDRHEVC: capabilities.nativeHDRHEVC && {
            ...capabilities.nativeHDRHEVC,
            reason: 'config-unsupported',
            status: 'unsupported'
        },
        rawHDRVideo: {
            ...capabilities.rawHDRVideo,
            hevc: {
                ...createRawHDRCapability('hevc', true),
                reason: 'bundled-software-decoder'
            }
        },
        video: {
            ...capabilities.video,
            hevc: createCodecCapability('hevc', false)
        }
    };
}

function createMatrixProfile(
    capabilities: CustomDecodeCapabilities,
    options: CustomDeviceProfileOptions
): DeviceProfile {
    return augmentDeviceProfileForCustomDecode(
        {
            CodecProfiles: [ {
                Codec: 'hevc',
                Conditions: [
                    {
                        Condition: 'EqualsAny',
                        IsRequired: false,
                        Property: 'VideoProfile',
                        Value: 'main|main 10'
                    },
                    {
                        Condition: 'EqualsAny',
                        IsRequired: false,
                        Property: 'VideoRangeType',
                        Value: 'SDR'
                    },
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: false,
                        Property: 'VideoLevel',
                        Value: '153'
                    }
                ],
                Type: 'Video'
            } ]
        },
        capabilities,
        options
    ).profile;
}

const fullyQualifiedCapabilities = createFullyQualifiedHEVCCapabilities();
const fullyQualifiedProfile: DeviceProfile = createMatrixProfile(
    fullyQualifiedCapabilities,
    FULL_ROUTE_OPTIONS
);
const rawPresentationProfile: DeviceProfile = createMatrixProfile(
    fullyQualifiedCapabilities,
    RAW_PRESENTATION_ROUTE_OPTIONS
);
const softwareDecodeCapabilities = createSoftwareDecodeHEVCCapabilities();
const softwareDecodeProfile: DeviceProfile = createMatrixProfile(
    softwareDecodeCapabilities,
    FULL_ROUTE_OPTIONS
);

/** Asserts negotiation, runtime ownership, their conjunction, and the exact selected route. */
function expectFullyQualifiedMatrixRow(row: HEVCDirectPlayMatrixRow): void {
    const playbackOptions = createPlaybackOptions(row.videoStream);
    const deviceProfileAdvertised = isSameSessionNativePlaybackCompatible(
        playbackOptions,
        fullyQualifiedProfile
    );
    const eligibility = getCustomPlaybackEligibility(
        playbackOptions,
        fullyQualifiedCapabilities,
        FULL_ELIGIBILITY_OPTIONS
    );

    expect(deviceProfileAdvertised).toBe(row.deviceProfileAdvertised);
    expect(eligibility.eligible).toBe(row.runtimeEligible);
    expect(deviceProfileAdvertised && eligibility.eligible).toBe(
        row.directPlaySupported
    );
    expect(getEligibleRoute(eligibility)).toEqual(row.expectedRoute ?? null);
    if (!eligibility.eligible && row.expectedIneligibilityReason) {
        expect(eligibility.reason).toBe(row.expectedIneligibilityReason);
    }
}

/** A null route means the configuration offers no DirectPlay route for the variant. */
function expectFallbackRoute(
    videoStream: Readonly<Record<string, unknown>>,
    profile: DeviceProfile,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    expectedRoute: ExpectedHEVCRoute | null
): void {
    const playbackOptions = createPlaybackOptions(videoStream);
    const deviceProfileAdvertised = isSameSessionNativePlaybackCompatible(
        playbackOptions,
        profile
    );
    const eligibility = getCustomPlaybackEligibility(
        playbackOptions,
        capabilities,
        eligibilityOptions
    );

    expect(deviceProfileAdvertised && eligibility.eligible).toBe(expectedRoute !== null);
    if (expectedRoute !== null) {
        expect(getEligibleRoute(eligibility)).toEqual(expectedRoute);
    }
}

describe('HEVC DirectPlay support matrix', () => {
    it('matches the complete generated Jellyfin VideoRangeType contract', () => {
        expect([ ...JELLYFIN_VIDEO_RANGE_TYPES ].sort(compareStrings)).toEqual(
            Object.values(VideoRangeType).sort(compareStrings)
        );
    });

    it('contains a direct-play-positive exact descriptor for every valid Dolby Vision range', () => {
        const supportedDolbyVisionRanges = new Set<string>();
        for (const row of HEVC_VIDEO_RANGE_MATRIX) {
            if (!row.directPlaySupported) {
                continue;
            }
            const videoRangeType = row.videoStream.VideoRangeType;
            if (typeof videoRangeType === 'string'
                && DOLBY_VISION_HEVC_VIDEO_RANGE_TYPE_SET.has(
                    videoRangeType as JellyfinVideoRangeType
                )) {
                supportedDolbyVisionRanges.add(videoRangeType);
            }
        }

        expect([ ...supportedDolbyVisionRanges ].sort(compareStrings)).toEqual(
            [ ...DOLBY_VISION_HEVC_VIDEO_RANGE_TYPES ].sort(compareStrings)
        );
    });

    it.each(HEVC_VIDEO_RANGE_MATRIX)(
        '$label: distinguishes profile advertisement from runtime ownership',
        expectFullyQualifiedMatrixRow
    );

    it.each(HEVC_RANGE_EXTENSION_MATRIX)(
        '$label: requires exact decode-copy and GPU presentation authorization',
        expectFullyQualifiedMatrixRow
    );

    it.each(HEVC_PROFILE_BOUNDARY_MATRIX)(
        '$label: preserves the exact implemented HEVC boundary',
        expectFullyQualifiedMatrixRow
    );
});

describe('HEVC DirectPlay route fallbacks', () => {
    it.each(HEVC_ROUTE_FALLBACK_MATRIX)(
        '$label: falls back to raw planes without native VideoFrame HDR presentation',
        row => {
            expectFallbackRoute(
                row.videoStream,
                rawPresentationProfile,
                fullyQualifiedCapabilities,
                RAW_PRESENTATION_ELIGIBILITY_OPTIONS,
                row.rawPresentationRoute
            );
        }
    );

    it.each(HEVC_ROUTE_FALLBACK_MATRIX)(
        '$label: uses only the bundled WASM decoder without native HEVC decode',
        row => {
            expectFallbackRoute(
                row.videoStream,
                softwareDecodeProfile,
                softwareDecodeCapabilities,
                FULL_ELIGIBILITY_OPTIONS,
                row.softwareDecodeRoute
            );
        }
    );
});
