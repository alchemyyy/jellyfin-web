import type { CodecProfile } from '@jellyfin/sdk/lib/generated-client/models/codec-profile';
import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
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
import { augmentDeviceProfileForCustomDecode } from 'plugins/webGPUPlayer/custom/CustomDeviceProfile';
import {
    getCustomPlaybackEligibility,
    hasPotentialCustomPlaybackVideoRoute
} from 'webgpu-player/custom/CustomPlaybackEligibility';
import type { CustomPlaybackRuntimeAvailability } from 'webgpu-player/custom/CustomPlaybackRuntime';
import { isSameSessionNativePlaybackCompatible } from 'plugins/webGPUPlayer/custom/NativeDirectPlayCompatibility';
import {
    HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS,
    HEVC_RANGE_EXTENSION_VARIANTS,
    type HEVCRangeExtensionCapability,
    type HEVCRangeExtensionVariant
} from 'webgpu-player/custom/HEVCRangeExtensionCapabilities';
import type { RawHDRAuthorizationRouteKey } from 'webgpu-player/validation/RawHDRPresentationAuthorization';

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

const JELLYFIN_HEVC_VIDEO_RANGE_TYPES = [
    'SDR',
    'HDR10',
    'HLG',
    'DOVI',
    'DOVIWithHDR10',
    'DOVIWithHLG',
    'DOVIWithSDR',
    'DOVIWithHDR10Plus',
    'DOVIWithEL',
    'DOVIWithELHDR10Plus',
    'DOVIInvalid',
    'HDR10Plus'
] as const;

function createCodecCapability<Codec extends CustomAudioCodec | CustomVideoCodec>(
    codec: Codec,
    supported = false
): CustomDecodeCodecCapability<Codec> {
    return {
        codec,
        codecString: codec,
        reason: supported ? 'config-supported' : 'config-unsupported',
        status: supported ? 'supported' : 'unsupported'
    };
}

function createRangeExtensionCapability(
    variant: HEVCRangeExtensionVariant,
    supported: boolean
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
        reason: supported ? 'output-copy-supported' : 'output-copy-unsupported',
        status: supported ? 'supported' : 'unsupported',
        variant
    };
}

function createCapabilities(
    supportedVariants: ReadonlySet<HEVCRangeExtensionVariant> = new Set(
        HEVC_RANGE_EXTENSION_VARIANTS
    )
): CustomDecodeCapabilities {
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
        video[codec] = createCodecCapability(codec);
    }
    const rawHDRVideo = {} as Record<
        CustomRawHDRVideoCodec,
        CustomRawHDRVideoCodecCapability
    >;
    for (const codec of CUSTOM_RAW_HDR_VIDEO_CODECS) {
        rawHDRVideo[codec] = {
            bitDepth: 10,
            codec,
            codecString: codec,
            format: 'I420P10',
            reason: 'output-copy-unsupported',
            status: 'unsupported'
        };
    }
    const hevcRangeExtensions = {} as Record<
        HEVCRangeExtensionVariant,
        HEVCRangeExtensionCapability
    >;
    for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
        hevcRangeExtensions[variant] = createRangeExtensionCapability(
            variant,
            supportedVariants.has(variant)
        );
    }
    return {
        audio,
        hevcRangeExtensions,
        rawHDRVideo,
        telemetry: {
            audioProbeCount: 0,
            bundledAudioCodecCount: 0,
            nativeHDRVideoProbeCount: 0,
            nativeSurroundAudioProbeCount: 0,
            nativeUltraHDVideoProbeCount: 0,
            rawHDRVideoProbeCount: 0,
            reason: 'complete',
            supportedAudioCodecCount: 1,
            supportedNativeHDRVideoCodecCount: 0,
            supportedNativeSurroundAudioCodecCount: 0,
            supportedNativeUltraHDVideoCodecCount: 0,
            supportedRawHDRVideoCodecCount: 0,
            supportedVideoCodecCount: 0,
            unknownAudioCodecCount: 0,
            unknownNativeHDRVideoCodecCount: 0,
            unknownNativeSurroundAudioCodecCount: 0,
            unknownNativeUltraHDVideoCodecCount: 0,
            unknownVideoCodecCount: 0,
            videoProbeCount: 0
        },
        video
    };
}

function createBaseProfile(): DeviceProfile {
    return {
        CodecProfiles: [],
        ContainerProfiles: [],
        DirectPlayProfiles: [],
        Name: 'Range-extension test profile',
        SubtitleProfiles: [],
        TranscodingProfiles: []
    };
}

function createSDRRouteKeys(): RawHDRAuthorizationRouteKey[] {
    const routeKeys: RawHDRAuthorizationRouteKey[] = [];
    for (const variant of HEVC_RANGE_EXTENSION_VARIANTS) {
        const format = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant].format;
        const limitedRouteKey = `${format}:bt709:bt709:limited:sdr` as const;
        const fullRouteKey = `${format}:bt709:bt709:full:sdr` as const;
        if (!routeKeys.includes(limitedRouteKey)) {
            routeKeys.push(limitedRouteKey, fullRouteKey);
        }
    }
    return routeKeys;
}

function getConditionValue(
    profile: CodecProfile,
    property: string
): string | null {
    return profile.Conditions?.find(condition => condition.Property === property)?.Value ?? null;
}

function getMeasuredHEVCProfiles(profile: DeviceProfile): CodecProfile[] {
    return (profile.CodecProfiles ?? []).filter(codecProfile => (
        codecProfile.Type === 'Video'
        && codecProfile.Codec === 'hevc'
        && getConditionValue(codecProfile, 'VideoProfile') !== null
    ));
}

function createPlaybackOptions(videoStream: Record<string, unknown>): Record<string, unknown> {
    return {
        mediaSource: {
            Container: 'mkv',
            MediaStreams: [ {
                Codec: 'hevc',
                Height: 1_080,
                Index: 0,
                IsInterlaced: false,
                Profile: 'Rext',
                Type: 'Video',
                Width: 1_920,
                ...videoStream
            } ],
            RunTimeTicks: 600_000_000,
            SupportsDirectPlay: true
        },
        playMethod: 'DirectPlay',
        playerStartPositionTicks: 0,
        url: 'http://localhost/Videos/range-extension/stream.mkv'
    };
}

describe('HEVC range-extension device profile', () => {
    it('advertises Rext only for complete SDR depth envelopes and rejects other ranges', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities(),
            {
                allowRawSDR: true,
                authorizedRawHDRRouteKeys: createSDRRouteKeys()
            }
        );
        const RextProfiles = getMeasuredHEVCProfiles(result.profile).filter(profile => (
            getConditionValue(profile, 'VideoProfile') === 'Rext'
        ));

        const SDRProfile = RextProfiles.find(profile => (
            getConditionValue(profile, 'VideoRangeType') === 'SDR'
        ));

        expect(RextProfiles).toHaveLength(JELLYFIN_HEVC_VIDEO_RANGE_TYPES.length);
        expect(RextProfiles.map(profile => getConditionValue(
            profile,
            'VideoRangeType'
        ))).toEqual(JELLYFIN_HEVC_VIDEO_RANGE_TYPES);
        expect(getConditionValue(SDRProfile as CodecProfile, 'VideoBitDepth')).toBe('8|10|12');
        expect(RextProfiles.filter(profile => (
            getConditionValue(profile, 'VideoRangeType') !== 'SDR'
        )).every(profile => getConditionValue(profile, 'VideoBitDepth') === '0')).toBe(true);
    });

    it('removes generic Rext when one same-depth capability is missing', () => {
        const supportedVariants = new Set<HEVCRangeExtensionVariant>(
            HEVC_RANGE_EXTENSION_VARIANTS
        );
        supportedVariants.delete('main444-10');

        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities(supportedVariants),
            {
                allowRawSDR: true,
                authorizedRawHDRRouteKeys: createSDRRouteKeys()
            }
        );
        const SDRProfile = getMeasuredHEVCProfiles(result.profile).find(profile => (
            getConditionValue(profile, 'VideoProfile') === 'Rext'
            && getConditionValue(profile, 'VideoRangeType') === 'SDR'
        ));

        expect(getConditionValue(SDRProfile as CodecProfile, 'VideoBitDepth')).toBe('8|12');
    });

    it('requires both indistinguishable SDR color ranges before advertising Rext', () => {
        const routeKeys = createSDRRouteKeys().filter(routeKey => (
            routeKey !== 'I422P10:bt709:bt709:full:sdr'
        ));

        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities(),
            {
                allowRawSDR: true,
                authorizedRawHDRRouteKeys: routeKeys
            }
        );
        const SDRProfile = getMeasuredHEVCProfiles(result.profile).find(profile => (
            getConditionValue(profile, 'VideoProfile') === 'Rext'
            && getConditionValue(profile, 'VideoRangeType') === 'SDR'
        ));

        expect(getConditionValue(SDRProfile as CodecProfile, 'VideoBitDepth')).toBe('8|12');
    });

    it('keeps a named compatibility alias exact while rejecting other ranges', () => {
        const supportedVariants = new Set<HEVCRangeExtensionVariant>([ 'main422-10' ]);
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities(supportedVariants),
            {
                allowRawSDR: true,
                authorizedRawHDRRouteKeys: [
                    'I422P10:bt709:bt709:limited:sdr',
                    'I422P10:bt709:bt709:full:sdr'
                ]
            }
        );
        const profiles = getMeasuredHEVCProfiles(result.profile);

        const namedProfiles = profiles.filter(profile => (
            getConditionValue(profile, 'VideoProfile') === 'Main 4:2:2 10'
        ));
        const SDRProfile = namedProfiles.find(profile => (
            getConditionValue(profile, 'VideoRangeType') === 'SDR'
        ));

        expect(namedProfiles).toHaveLength(JELLYFIN_HEVC_VIDEO_RANGE_TYPES.length);
        expect(namedProfiles.map(profile => getConditionValue(
            profile,
            'VideoRangeType'
        ))).toEqual(JELLYFIN_HEVC_VIDEO_RANGE_TYPES);
        expect(SDRProfile).toBeDefined();
        expect(getConditionValue(SDRProfile as CodecProfile, 'VideoBitDepth')).toBe('10');
        expect(namedProfiles.filter(profile => (
            getConditionValue(profile, 'VideoRangeType') !== 'SDR'
        )).every(profile => getConditionValue(profile, 'VideoBitDepth') === '0')).toBe(true);
    });

    it('widens an existing Main whitelist for SDR-only range-extension DirectPlay', () => {
        const baseProfile = createBaseProfile();
        baseProfile.CodecProfiles = [ {
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
                    Property: 'VideoBitDepth',
                    Value: '10'
                }
            ],
            Type: 'Video'
        } ];
        baseProfile.DirectPlayProfiles = [ {
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'hevc'
        } ];

        const result = augmentDeviceProfileForCustomDecode(
            baseProfile,
            createCapabilities(),
            {
                allowRawSDR: true,
                authorizedRawHDRRouteKeys: createSDRRouteKeys()
            }
        );
        const widenedGlobalProfile = (result.profile.CodecProfiles ?? []).find(profile => (
            profile.Codec === 'hevc'
            && profile.ApplyConditions === undefined
            && getConditionValue(profile, 'VideoProfile')?.includes('Rext') === true
        ));

        expect(widenedGlobalProfile).toBeDefined();
        expect(widenedGlobalProfile?.Conditions?.find(condition => (
            condition.Property === 'VideoRangeType'
        ))).toMatchObject({
            IsRequired: true,
            Value: 'SDR'
        });
        expect(isSameSessionNativePlaybackCompatible(
            createPlaybackOptions({
                BitDepth: 12,
                PixelFormat: 'yuv420p12le',
                Profile: 'Rext',
                VideoRangeType: 'SDR'
            }),
            result.profile
        )).toBe(true);
    });
});

describe('HEVC range-extension runtime eligibility', () => {
    it.each(HEVC_RANGE_EXTENSION_VARIANTS)(
        'selects exact SDR raw output for %s with omitted BitDepth',
        variant => {
            const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
            const routeKey = `${definition.format}:bt709:bt709:limited:sdr` as const;
            const options = createPlaybackOptions({
                BitDepth: null,
                PixelFormat: definition.pixelFormat,
                VideoRangeType: 'SDR'
            });

            const eligibility = getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                {
                    allowRawHDR: false,
                    allowRawSDR: true,
                    authorizedRawHDRRouteKeys: [ routeKey ],
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            );

            expect(eligibility).toMatchObject({
                eligible: true,
                hdr: false,
                rawVideoFrameFormat: definition.format,
                videoDecoderBackend: 'native',
                videoOutputMode: 'raw-planes'
            });
            expect(hasPotentialCustomPlaybackVideoRoute(
                (options as { mediaSource: object }).mediaSource
            )).toBe(true);
        }
    );

    it.each([ 'main422-10', 'main422-12' ] as const)(
        'infers omitted HDR bit depth and selects exact %s output',
        variant => {
            const definition = HEVC_RANGE_EXTENSION_PROBE_DEFINITIONS[variant];
            const routeKey = (
                `${definition.format}:bt2020-ncl:bt2020:limited:pq`
            ) as RawHDRAuthorizationRouteKey;
            const options = createPlaybackOptions({
                BitDepth: null,
                PixelFormat: definition.pixelFormat,
                VideoRangeType: 'HDR10'
            });

            const eligibility = getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                {
                    allowRawHDR: true,
                    authorizedRawHDRRouteKeys: [ routeKey ],
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            );

            expect(eligibility).toMatchObject({
                eligible: true,
                hdr: true,
                rawVideoFrameFormat: definition.format,
                videoOutputMode: 'raw-planes'
            });
        }
    );
});
