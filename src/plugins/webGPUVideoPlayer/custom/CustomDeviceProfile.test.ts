import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import { describe, expect, it } from 'vitest';

import {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_BUNDLED_AUDIO_CODECS,
    CUSTOM_NATIVE_SURROUND_AUDIO_CODECS,
    CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS,
    CUSTOM_RAW_HDR_VIDEO_CODECS,
    CUSTOM_VIDEO_CODECS,
    CUSTOM_WEB_CODECS_AUDIO_CODECS,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomDecodeCodecCapability,
    type CustomNativeSurroundAudioCodec,
    type CustomNativeSurroundAudioCodecCapability,
    type CustomNativeUltraHDVideoCodec,
    type CustomNativeUltraHDVideoCodecCapability,
    type CustomRawHDRVideoCodec,
    type CustomRawHDRVideoCodecCapability,
    type CustomVideoCodec
} from './CustomDecodeCapabilities';
import { augmentDeviceProfileForCustomDecode } from './CustomDeviceProfile';
import {
    H264_JELLYFIN_PROFILE_NAMES,
    H264_PROFILE_PROBE_CODED_HEIGHT,
    H264_PROFILE_PROBE_CODED_WIDTH,
    H264_PROFILES,
    type H264ProfileCapabilities
} from './H264ProfileCapabilities';
import type {
    NativeMediaAudioCapabilities,
    NativeMediaAudioChannelCount,
    NativeMediaAudioCodec,
    NativeMediaAudioCodecCapability,
    NativeMediaAudioLayoutCapability
} from './NativeMediaAudioCapabilities';

const RAW_HDR_PROFILE_OPTIONS = {
    allowRawHDR: true,
    authorizedRawHDRRouteKeys: [
        'I420P10:bt2020-ncl:bt2020:limited:pq',
        'I420P10:bt2020-ncl:bt2020:limited:hlg'
    ] as const
};

function createCapability<Codec extends CustomAudioCodec | CustomVideoCodec>(
    codec: Codec,
    supported: boolean
): CustomDecodeCodecCapability<Codec> {
    return {
        codec,
        codecString: codec,
        reason: supported ? 'config-supported' : 'config-unsupported',
        status: supported ? 'supported' : 'unsupported'
    };
}

function createH264ProfileCapabilities(supported: boolean): H264ProfileCapabilities {
    const capabilities = {} as Record<
        typeof H264_PROFILES[number],
        H264ProfileCapabilities[typeof H264_PROFILES[number]]
    >;
    for (const profile of H264_PROFILES) {
        capabilities[profile] = Object.freeze({
            codecString: profile,
            codedHeight: H264_PROFILE_PROBE_CODED_HEIGHT,
            codedWidth: H264_PROFILE_PROBE_CODED_WIDTH,
            evidence: supported ? 'decoded-output' : 'none',
            jellyfinProfileName: H264_JELLYFIN_PROFILE_NAMES[profile],
            profile,
            reason: supported ? 'decode-output-verified' : 'config-unsupported',
            status: supported ? 'supported' : 'unsupported'
        });
    }
    return Object.freeze(capabilities);
}

function createBundledHEVCCapabilities(): NonNullable<CustomDecodeCapabilities['bundledHEVC']> {
    return {
        reason: 'complete',
        tiers: {
            'main-1080p': {
                bitDepth: 8,
                codecString: 'hvc1.1.6.L120.B0',
                decodeMilliseconds: 20,
                format: 'I420',
                framesPerSecond: 40,
                maximumBitrate: 12_000_000,
                maximumCodedHeight: 1_080,
                maximumCodedWidth: 1_920,
                maximumLevel: 120,
                minimumFramesPerSecond: 30,
                profile: 'main',
                reason: 'decode-output-verified',
                status: 'supported',
                tier: 'main-1080p'
            },
            'main10-1080p': {
                bitDepth: 10,
                codecString: 'hvc1.2.4.L120.B0',
                decodeMilliseconds: 25,
                format: 'I420P10',
                framesPerSecond: 40,
                maximumBitrate: 12_000_000,
                maximumCodedHeight: 1_080,
                maximumCodedWidth: 1_920,
                maximumLevel: 120,
                minimumFramesPerSecond: 30,
                profile: 'main10',
                reason: 'decode-output-verified',
                status: 'supported',
                tier: 'main10-1080p'
            },
            'main10-4k': {
                bitDepth: 10,
                codecString: 'hvc1.2.4.L153.B0',
                decodeMilliseconds: 30,
                format: 'I420P10',
                framesPerSecond: 40,
                maximumBitrate: 40_000_000,
                maximumCodedHeight: 2_160,
                maximumCodedWidth: 3_840,
                maximumLevel: 153,
                minimumFramesPerSecond: 30,
                profile: 'main10',
                reason: 'decode-output-verified',
                status: 'supported',
                tier: 'main10-4k'
            }
        }
    };
}

type NativeUltraHDVideoCapabilityHarness = Readonly<{
    capabilityProperties: Readonly<{
        nativeUltraHDVideo?: NonNullable<CustomDecodeCapabilities['nativeUltraHDVideo']>
    }>
    probeCount: number
}>;

type NativeSurroundAudioCapabilityHarness = Readonly<{
    capabilityProperties: Readonly<{
        nativeSurroundAudio?: NonNullable<CustomDecodeCapabilities['nativeSurroundAudio']>
    }>
    probeCount: number
}>;

function createNativeSurroundAudioCapabilityHarness(
    supportedCodecs: readonly CustomNativeSurroundAudioCodec[]
): NativeSurroundAudioCapabilityHarness {
    if (supportedCodecs.length === 0) {
        return { capabilityProperties: {}, probeCount: 0 };
    }

    const capabilities = {} as Record<
        CustomNativeSurroundAudioCodec,
        CustomNativeSurroundAudioCodecCapability
    >;
    const supportedCodecSet = new Set(supportedCodecs);
    const codecStrings: Readonly<Record<CustomNativeSurroundAudioCodec, string>> = {
        aac: 'mp4a.40.2',
        flac: 'flac',
        opus: 'opus',
        vorbis: 'vorbis'
    };
    for (const codec of CUSTOM_NATIVE_SURROUND_AUDIO_CODECS) {
        const supported = supportedCodecSet.has(codec);
        capabilities[codec] = {
            codec,
            codecString: codecStrings[codec],
            inputChannelCount: 6,
            reason: supported ? 'decode-output-verified' : 'decode-output-missing',
            sampleRate: 48_000,
            status: supported ? 'supported' : 'unsupported'
        };
    }
    return {
        capabilityProperties: { nativeSurroundAudio: capabilities },
        probeCount: CUSTOM_NATIVE_SURROUND_AUDIO_CODECS.length
    };
}

function createNativeUltraHDVideoCapabilityHarness(
    supportedCodecs: readonly CustomNativeUltraHDVideoCodec[]
): NativeUltraHDVideoCapabilityHarness {
    if (supportedCodecs.length === 0) {
        return { capabilityProperties: {}, probeCount: 0 };
    }

    const capabilities = {} as Record<
        CustomNativeUltraHDVideoCodec,
        CustomNativeUltraHDVideoCodecCapability
    >;
    const supportedCodecSet = new Set(supportedCodecs);
    const codecStrings: Readonly<Record<CustomNativeUltraHDVideoCodec, string>> = {
        av1: 'av01.0.12M.08',
        hevc: 'hvc1.1.6.L153.B0',
        vp9: 'vp09.00.51.08'
    };
    for (const codec of CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS) {
        const supported = supportedCodecSet.has(codec);
        capabilities[codec] = {
            bitDepth: 8,
            codec,
            codecString: codecStrings[codec],
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            reason: supported ? 'decode-output-verified' : 'decode-output-missing',
            status: supported ? 'supported' : 'unsupported'
        };
    }
    return {
        capabilityProperties: { nativeUltraHDVideo: capabilities },
        probeCount: CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS.length
    };
}

function createCapabilities(
    supportedVideoCodecs: readonly CustomVideoCodec[],
    supportedAudioCodecs: readonly CustomAudioCodec[],
    supportedRawHDRVideoCodecs: readonly CustomRawHDRVideoCodec[] = [],
    nativeDolbyVisionSupported = false,
    supportedNativeUltraHDVideoCodecs: readonly CustomNativeUltraHDVideoCodec[] = [],
    supportedNativeSurroundAudioCodecs: readonly CustomNativeSurroundAudioCodec[] = []
): CustomDecodeCapabilities {
    const supportedVideoSet = new Set(supportedVideoCodecs);
    const supportedAudioSet = new Set(supportedAudioCodecs);
    const video = {} as Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>;
    for (const codec of CUSTOM_VIDEO_CODECS) {
        video[codec] = createCapability(codec, supportedVideoSet.has(codec));
    }
    const audio = {} as Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>;
    for (const codec of CUSTOM_AUDIO_CODECS) {
        audio[codec] = createCapability(codec, supportedAudioSet.has(codec));
    }
    const supportedRawHDRVideoSet = new Set(supportedRawHDRVideoCodecs);
    const rawHDRVideo = {} as Record<
        CustomRawHDRVideoCodec,
        CustomRawHDRVideoCodecCapability
    >;
    for (const codec of CUSTOM_RAW_HDR_VIDEO_CODECS) {
        const supported = supportedRawHDRVideoSet.has(codec);
        const bundledHEVC = codec === 'hevc'
            && supported
            && !supportedVideoSet.has('hevc');
        let capabilityReason: CustomRawHDRVideoCodecCapability['reason'] = supported ?
            'output-copy-supported' :
            'output-copy-unsupported';
        if (bundledHEVC) {
            capabilityReason = 'bundled-software-decoder';
        }
        rawHDRVideo[codec] = {
            bitDepth: 10,
            codec,
            codecString: bundledHEVC ? 'hvc1.2.4.L153.B0' : codec,
            format: 'I420P10',
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            maximumFramesPerSecond: 30,
            measuredFramesPerSecond: 40,
            reason: capabilityReason,
            status: supported ? 'supported' : 'unsupported'
        };
    }
    const nativeUltraHDVideoCapabilityHarness =
        createNativeUltraHDVideoCapabilityHarness(supportedNativeUltraHDVideoCodecs);
    const nativeSurroundAudioCapabilityHarness =
        createNativeSurroundAudioCapabilityHarness(supportedNativeSurroundAudioCodecs);
    return {
        audio,
        ...(supportedVideoSet.has('hevc') || supportedRawHDRVideoSet.has('hevc') ? {
            bundledHEVC: createBundledHEVCCapabilities()
        } : {}),
        h264Profiles: createH264ProfileCapabilities(supportedVideoSet.has('h264')),
        nativeDolbyVisionHEVC: {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hev1.2.4.H150.B0',
            maximumBitrate: 40_000_000,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            maximumFramesPerSecond: 24,
            maximumLevel: 153,
            measuredFramesPerSecond: 30,
            profile: 5,
            reason: nativeDolbyVisionSupported ?
                'decode-output-verified' :
                'decode-output-missing',
            status: nativeDolbyVisionSupported ? 'supported' : 'unsupported'
        },
        ...nativeSurroundAudioCapabilityHarness.capabilityProperties,
        ...nativeUltraHDVideoCapabilityHarness.capabilityProperties,
        rawHDRVideo,
        telemetry: {
            audioProbeCount: CUSTOM_WEB_CODECS_AUDIO_CODECS.length,
            bundledAudioCodecCount: CUSTOM_BUNDLED_AUDIO_CODECS.length,
            nativeSurroundAudioProbeCount: nativeSurroundAudioCapabilityHarness.probeCount,
            nativeHDRVideoProbeCount: 0,
            nativeUltraHDVideoProbeCount: nativeUltraHDVideoCapabilityHarness.probeCount,
            rawHDRVideoProbeCount: CUSTOM_RAW_HDR_VIDEO_CODECS.length - 1,
            reason: 'complete',
            supportedAudioCodecCount: supportedAudioCodecs.length,
            supportedNativeSurroundAudioCodecCount:
                supportedNativeSurroundAudioCodecs.length,
            supportedNativeHDRVideoCodecCount: 0,
            supportedNativeUltraHDVideoCodecCount:
                supportedNativeUltraHDVideoCodecs.length,
            supportedRawHDRVideoCodecCount: supportedRawHDRVideoCodecs.length,
            supportedVideoCodecCount: supportedVideoCodecs.length,
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

function createNativeMediaAudioCapabilities(
    supportedRoutes: ReadonlySet<string>
): NativeMediaAudioCapabilities {
    const audio = {} as Record<NativeMediaAudioCodec, NativeMediaAudioCodecCapability>;
    for (const codec of [ 'ac3', 'eac3' ] as const) {
        const codecString = codec === 'ac3' ? 'ac-3' : 'ec-3';
        const mimeType = `audio/mp4; codecs="${codecString}"`;
        const layouts = {} as Record<
            NativeMediaAudioChannelCount,
            NativeMediaAudioLayoutCapability
        >;
        let codecSupported = false;
        for (const channelCount of [ 2, 6 ] as const) {
            const supported = supportedRoutes.has(`${codec}:${channelCount}:48000`);
            codecSupported ||= supported;
            layouts[channelCount] = {
                channelCount,
                codec,
                codecString,
                mimeType,
                reason: supported ? 'decoded-playback-advanced' : 'playback-not-advanced',
                sampleRate: 48_000,
                status: supported ? 'supported' : 'unsupported'
            };
        }
        audio[codec] = {
            codec,
            codecString,
            layouts,
            mimeType,
            status: codecSupported ? 'supported' : 'unsupported'
        };
    }
    return {
        audio,
        telemetry: {
            probeCount: 4,
            supportedLayoutCount: supportedRoutes.size,
            unknownLayoutCount: 0
        }
    };
}

function createBaseProfile(): DeviceProfile {
    return {
        CodecProfiles: [ {
            Codec: 'h264',
            Conditions: [ {
                Condition: 'LessThanEqual',
                IsRequired: false,
                Property: 'VideoBitDepth',
                Value: '8'
            } ],
            Type: 'Video'
        } ],
        ContainerProfiles: [ {
            Conditions: [ {
                Condition: 'LessThanEqual',
                IsRequired: false,
                Property: 'NumStreams',
                Value: '32'
            } ],
            Container: 'mp4',
            Type: 'Video'
        } ],
        DirectPlayProfiles: [ {
            AudioCodec: 'aac',
            Container: 'mp4',
            Type: 'Video',
            VideoCodec: 'h264'
        } ],
        Name: 'HTML profile',
        SubtitleProfiles: [ { Format: 'vtt', Method: 'External' } ],
        TranscodingProfiles: [ {
            AudioCodec: 'aac',
            Conditions: [ {
                Condition: 'LessThanEqual',
                IsRequired: false,
                Property: 'AudioChannels',
                Value: '2'
            } ],
            Container: 'mp4',
            Protocol: 'hls',
            Type: 'Video',
            VideoCodec: 'h264'
        } ]
    };
}

describe('augmentDeviceProfileForCustomDecode', () => {
    it('advertises exact bundled HEVC Main when native HEVC is unavailable', () => {
        const capabilities = createCapabilities([], [ 'aac' ]);
        capabilities.bundledHEVC = createBundledHEVCCapabilities();

        const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities);

        expect(result.telemetry.supportedVideoCodecs).toContain('hevc');
        expect(result.profile.CodecProfiles).toContainEqual(expect.objectContaining({
            Codec: 'hevc',
            Conditions: expect.arrayContaining([
                expect.objectContaining({ Property: 'VideoProfile', Value: 'main' }),
                expect.objectContaining({ Property: 'VideoFramerate', Value: '24' }),
                expect.objectContaining({ Property: 'VideoLevel', Value: '120' }),
                expect.objectContaining({ Property: 'VideoBitrate', Value: '12000000' })
            ])
        }));
    });

    it('advertises only H264 profiles with verified decoder output', () => {
        const capabilities = createCapabilities([ 'h264' ], [ 'aac' ]);
        const h264Profiles = capabilities.h264Profiles as H264ProfileCapabilities;
        capabilities.h264Profiles = {
            ...h264Profiles,
            'constrained-baseline': {
                ...h264Profiles['constrained-baseline'],
                evidence: 'none',
                reason: 'config-unsupported',
                status: 'unsupported'
            },
            high: {
                ...h264Profiles.high,
                evidence: 'configuration',
                reason: 'config-supported-only',
                status: 'unknown'
            },
            main: {
                ...h264Profiles.main,
                evidence: 'none',
                reason: 'config-unsupported',
                status: 'unsupported'
            }
        };

        const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities);
        const measuredH264Profile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'h264'
            && profile.Container === 'mp4,m4v,mov,mkv,ts,m2ts,mts'
            && profile.Conditions?.some(condition => condition.Property === 'VideoRangeType')
        ));
        expect(measuredH264Profile?.Conditions).toContainEqual(expect.objectContaining({
            Property: 'VideoProfile',
            Value: 'baseline'
        }));
    });

    it('does not advertise H264 from a generic config result without exact output evidence', () => {
        const capabilities = createCapabilities([ 'h264' ], [ 'aac' ]);
        delete capabilities.h264Profiles;

        const result = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities);

        expect(result.telemetry.supportedVideoCodecs).toEqual([]);
        expect(result.profile.DirectPlayProfiles).toEqual(createBaseProfile().DirectPlayProfiles);
    });

    it.each([
        { codec: 'hevc', profile: 'main' },
        { codec: 'vp9', profile: 'profile 0' },
        { codec: 'av1', profile: 'main' }
    ] as const)(
        'advertises exact native Ultra HD $codec limits',
        ({ codec, profile }) => {
            const capabilities = createCapabilities(
                [ codec ],
                [ 'aac' ],
                [],
                false,
                [ codec ]
            );

            const result = augmentDeviceProfileForCustomDecode(
                createBaseProfile(),
                capabilities
            );
            const measuredProfile = result.profile.CodecProfiles?.find(codecProfile => (
                codecProfile.Codec === codec
                && codecProfile.Conditions?.some(condition => (
                    condition.Property === 'VideoRangeType'
                    && condition.Value === 'SDR'
                ))
                && codecProfile.Conditions.some(condition => (
                    condition.Property === 'Width'
                    && condition.Value === '3840'
                ))
            ));

            expect(measuredProfile?.Conditions).toEqual(expect.arrayContaining([
                expect.objectContaining({ Property: 'VideoBitDepth', Value: '8' }),
                expect.objectContaining({ Property: 'VideoRangeType', Value: 'SDR' }),
                expect.objectContaining({ Property: 'Width', Value: '3840' }),
                expect.objectContaining({ Property: 'Height', Value: '2160' }),
                expect.objectContaining({ Property: 'VideoProfile', Value: profile })
            ]));
        }
    );

    it('adds only compatible Mediabunny container and codec combinations', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities([ 'h264', 'vp8' ], [ 'aac', 'vorbis' ])
        );
        const addedProfiles = result.profile.DirectPlayProfiles?.slice(1) ?? [];

        expect(addedProfiles).toContainEqual({
            AudioCodec: 'aac,vorbis',
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: 'h264,vp8'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'vorbis',
            Container: 'webm',
            Type: 'Video',
            VideoCodec: 'vp8'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'aac',
            Container: 'ts,m2ts,mts',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).not.toContainEqual(expect.objectContaining({
            AudioCodec: expect.stringContaining('aac'),
            Container: 'webm'
        }));
        expect(addedProfiles).not.toContainEqual(expect.objectContaining({
            Container: 'ts,m2ts,mts',
            VideoCodec: expect.stringContaining('vp8')
        }));
        expect(result.telemetry).toMatchObject({
            addedAudioProfileCount: 0,
            addedProfileCount: 4,
            addedVideoProfileCount: 4,
            reason: 'augmented',
            supportedAudioCodecs: [ 'aac', 'vorbis' ],
            supportedVideoCodecs: [ 'h264', 'vp8' ],
            widenedHDRCodecProfileCount: 0
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'aac,vorbis',
            Conditions: [
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '2'
                },
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioSampleRate',
                    Value: '48000'
                }
            ],
            Container: 'mp4,m4v,mov,mkv,webm,ts,m2ts,mts',
            Type: 'VideoAudio'
        });
    });

    it.each([ 'aac', 'opus', 'flac', 'vorbis' ] as const)(
        'advertises exact qualified native 5.1 %s limits',
        codec => {
            const result = augmentDeviceProfileForCustomDecode(
                createBaseProfile(),
                createCapabilities(
                    [ 'h264' ],
                    [ codec ],
                    [],
                    false,
                    [],
                    [ codec ]
                )
            );
            const measuredProfile = result.profile.CodecProfiles?.find(profile => (
                profile.Codec === codec
                && profile.Container === 'mp4,m4v,mov,mkv,webm,ts,m2ts,mts'
            ));

            expect(measuredProfile?.Conditions).toContainEqual({
                Condition: 'EqualsAny',
                IsRequired: true,
                Property: 'AudioChannels',
                Value: '2|6'
            });
            expect(measuredProfile?.Conditions).toContainEqual({
                Condition: 'Equals',
                IsRequired: true,
                Property: 'AudioSampleRate',
                Value: '48000'
            });
        }
    );

    it('advertises bundled AC-3 codecs only in compatible video containers', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities([ 'h264' ], [ 'ac3', 'eac3' ])
        );
        const addedProfiles = result.profile.DirectPlayProfiles?.slice(1) ?? [];

        expect(addedProfiles).toContainEqual({
            AudioCodec: 'ac3,eac3',
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'ac3,eac3',
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'ac3,eac3',
            Container: 'ts,m2ts,mts',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles.some(profile => profile.Container === 'webm')).toBe(false);
        expect(result.telemetry.supportedAudioCodecs).toEqual([ 'ac3', 'eac3' ]);
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'ac3,eac3',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '2|6'
                },
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioSampleRate',
                    Value: '48000'
                }
            ],
            Container: 'mp4,m4v,mov,mkv,webm,ts,m2ts,mts',
            Type: 'VideoAudio'
        });
    });

    it('advertises exact Mediabunny PCM container, rate, and layout routes', () => {
        const supportedPCMCodecs = [
            'pcm_s24le',
            'pcm_s8',
            'pcm_alaw'
        ] as const;
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities([ 'h264' ], supportedPCMCodecs)
        );
        const addedProfiles = result.profile.DirectPlayProfiles?.slice(1) ?? [];

        expect(addedProfiles).toContainEqual({
            AudioCodec: 'pcm_s24le',
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'pcm_s24le,pcm_s8,pcm_alaw',
            Container: 'mov',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).toContainEqual({
            AudioCodec: 'pcm_s24le',
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(addedProfiles).not.toContainEqual({
            AudioCodec: expect.stringContaining('pcm_s8'),
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'h264'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: supportedPCMCodecs.join(','),
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '1|2|6'
                },
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioSampleRate',
                    Value: '8000|11025|12000|16000|22050|24000|32000|44100|48000|88200|96000|176400|192000'
                }
            ],
            Container: 'mp4,m4v,mov,mkv,webm,ts,m2ts,mts',
            Type: 'VideoAudio'
        });
    });

    it('replaces browser secondary-audio limits only on measured custom routes', () => {
        const original = createBaseProfile();
        original.DirectPlayProfiles = [ {
            AudioCodec: 'aac,eac3,dts',
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'h264'
        } ];
        original.CodecProfiles = [
            {
                Codec: 'aac',
                Conditions: [
                    {
                        Condition: 'NotEquals',
                        Property: 'AudioProfile',
                        Value: 'HE-AAC'
                    },
                    {
                        Condition: 'Equals',
                        IsRequired: false,
                        Property: 'IsSecondaryAudio',
                        Value: 'false'
                    }
                ],
                Type: 'VideoAudio'
            },
            {
                Conditions: [
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: false,
                        Property: 'AudioChannels',
                        Value: '2'
                    },
                    {
                        Condition: 'Equals',
                        IsRequired: false,
                        Property: 'IsSecondaryAudio',
                        Value: 'false'
                    }
                ],
                Type: 'VideoAudio'
            }
        ];

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities([ 'h264' ], [ 'aac', 'eac3' ])
        );

        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'aac',
            Conditions: [ {
                Condition: 'NotEquals',
                Property: 'AudioProfile',
                Value: 'HE-AAC'
            } ],
            Container: 'mp4,m4v,mov,mkv,webm,ts,m2ts,mts',
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'dts',
            Conditions: original.CodecProfiles[1].Conditions,
            Container: 'mp4,m4v,mov,mkv,webm,ts,m2ts,mts',
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            ...original.CodecProfiles[1],
            Container: '-mp4,m4v,mov,mkv,webm,ts,m2ts,mts'
        });

        const measuredEAC3Profile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'eac3'
            && profile.Container === 'mp4,m4v,mov,mkv,webm,ts,m2ts,mts'
        ));
        expect(measuredEAC3Profile?.Conditions).toContainEqual(expect.objectContaining({
            Property: 'AudioChannels',
            Value: '2|6'
        }));
    });

    it('advertises native AC-3 routes only at their exact measured layouts', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities([ 'h264' ], []),
            {
                nativeMediaAudioCapabilities: createNativeMediaAudioCapabilities(
                    new Set([ 'ac3:2:48000', 'eac3:2:48000', 'eac3:6:48000' ])
                )
            }
        );

        expect(result.telemetry.supportedAudioCodecs).toEqual([ 'ac3', 'eac3' ]);
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'ac3',
            Conditions: [
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '2'
                },
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioSampleRate',
                    Value: '48000'
                }
            ],
            Container: 'mp4,m4v,mov,mkv,webm,ts,m2ts,mts',
            Type: 'VideoAudio'
        });
        expect(result.profile.CodecProfiles).toContainEqual({
            Codec: 'eac3',
            Conditions: [
                {
                    Condition: 'EqualsAny',
                    IsRequired: true,
                    Property: 'AudioChannels',
                    Value: '2|6'
                },
                {
                    Condition: 'Equals',
                    IsRequired: true,
                    Property: 'AudioSampleRate',
                    Value: '48000'
                }
            ],
            Container: 'mp4,m4v,mov,mkv,webm,ts,m2ts,mts',
            Type: 'VideoAudio'
        });
        expect(result.profile.DirectPlayProfiles).toContainEqual(expect.objectContaining({
            AudioCodec: 'ac3,eac3',
            Container: 'mkv',
            VideoCodec: 'h264'
        }));
    });

    it('widens raw HDR ranges only for supported high-bit-depth codec families', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'h264,hevc,vp9,av1',
            Conditions: [
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
                    Value: '120'
                }
            ],
            Type: 'Video'
        } ];

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities([ 'h264', 'hevc', 'vp9' ], [ 'aac' ], [ 'hevc', 'vp9' ]),
            RAW_HDR_PROFILE_OPTIONS
        );

        expect(result.profile.CodecProfiles?.slice(0, 3)).toEqual([
            {
                Codec: 'h264,av1',
                Conditions: original.CodecProfiles[0].Conditions,
                Type: 'Video'
            },
            {
                Codec: 'hevc,vp9',
                Conditions: original.CodecProfiles[0].Conditions,
                Container: '-mp4,m4v,mov,mkv,webm,ts,m2ts,mts',
                Type: 'Video'
            },
            {
                Codec: 'hevc,vp9',
                Conditions: [
                    {
                        Condition: 'EqualsAny',
                        IsRequired: false,
                        Property: 'VideoRangeType',
                        Value: 'SDR|HDR10|HLG'
                    },
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: false,
                        Property: 'VideoLevel',
                        Value: '120'
                    },
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: true,
                        Property: 'VideoBitDepth',
                        Value: '10'
                    },
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: true,
                        Property: 'VideoFramerate',
                        Value: '30'
                    },
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: true,
                        Property: 'Width',
                        Value: '3840'
                    },
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: true,
                        Property: 'Height',
                        Value: '2160'
                    }
                ],
                Container: 'mp4,m4v,mov,mkv,webm,ts,m2ts,mts',
                Type: 'Video'
            }
        ]);
        expect(result.profile.CodecProfiles?.[2].Conditions?.[0].Value).not.toContain('DOVI');
        expect(result.profile.CodecProfiles?.[2].Conditions?.[0].Value).not.toContain('HDR10Plus');
        expect(result.telemetry.widenedHDRCodecProfileCount).toBe(1);
    });

    it.each([ 24 as const, 30 as const, 60 as const ])(
        'advertises the measured %i fps raw HDR tier',
        maximumFramesPerSecond => {
            const original = createBaseProfile();
            original.CodecProfiles = [ {
                Codec: 'vp9',
                Conditions: [ {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoRangeType',
                    Value: 'SDR'
                } ],
                Type: 'Video'
            } ];
            const capabilities = createCapabilities(
                [ 'vp9' ],
                [ 'opus' ],
                [ 'vp9' ]
            );
            capabilities.rawHDRVideo = {
                ...capabilities.rawHDRVideo,
                vp9: {
                    ...capabilities.rawHDRVideo.vp9,
                    maximumFramesPerSecond,
                    measuredFramesPerSecond: maximumFramesPerSecond * 1.25
                }
            };

            const result = augmentDeviceProfileForCustomDecode(
                original,
                capabilities,
                RAW_HDR_PROFILE_OPTIONS
            );

            expect(result.profile.CodecProfiles).toContainEqual(expect.objectContaining({
                Codec: 'vp9',
                Conditions: expect.arrayContaining([
                    expect.objectContaining({
                        Property: 'VideoRangeType',
                        Value: 'HDR10|HLG'
                    }),
                    expect.objectContaining({
                        Property: 'VideoFramerate',
                        Value: String(maximumFramesPerSecond)
                    })
                ])
            }));
        }
    );

    it('does not advertise a supported raw HDR capability with an invalid frame-rate tier', () => {
        const capabilities = createCapabilities([ 'vp9' ], [ 'opus' ], [ 'vp9' ]);
        capabilities.rawHDRVideo = {
            ...capabilities.rawHDRVideo,
            vp9: {
                ...capabilities.rawHDRVideo.vp9,
                maximumFramesPerSecond: 0,
                measuredFramesPerSecond: null
            }
        };

        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            capabilities,
            RAW_HDR_PROFILE_OPTIONS
        );

        expect(result.profile.CodecProfiles?.some(profile => (
            profile.Codec === 'vp9'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value?.includes('HDR10')
            ))
        ))).toBe(false);
    });

    it('advertises only settled authorized HDR range types and exact progressive metadata', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities([ 'hevc' ], [ 'aac' ], [ 'hevc' ]);

        const missingAuthorization = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            { allowRawHDR: true }
        );
        expect(missingAuthorization.telemetry.widenedHDRCodecProfileCount).toBe(0);
        expect(missingAuthorization.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => condition.Value?.includes('HDR10'))
        ))).toBe(false);

        const pqAuthorization = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            {
                allowRawHDR: true,
                authorizedRawHDRRouteKeys: [
                    'I420P10:bt2020-ncl:bt2020:limited:pq'
                ]
            }
        );
        expect(pqAuthorization.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'SDR|HDR10'
            ))
        ))).toBe(true);
        expect(pqAuthorization.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => condition.Value?.includes('HLG'))
        ))).toBe(false);
        expect(pqAuthorization.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => (
                condition.Property === 'IsInterlaced'
                && condition.Condition === 'Equals'
                && condition.Value === 'false'
            ))
        ))).toBe(true);
    });

    it('advertises exact native Main10 limits only for an authorized external HDR route', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities([], [ 'flac' ]);
        capabilities.nativeHDRHEVC = {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            maximumBitrate: 40_000_000,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            maximumFramesPerSecond: 30,
            maximumLevel: 153,
            measuredFramesPerSecond: 75,
            reason: 'decode-output-verified',
            status: 'supported'
        };

        const missingAuthorization = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            { allowNativeHDR: true, allowRawHDR: false }
        );
        expect(missingAuthorization.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => condition.Value?.includes('HDR10'))
        ))).toBe(false);

        const result = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            {
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ]
            }
        );
        const nativeHDRProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'hevc'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'HDR10'
            ))
            && profile.Conditions.some(condition => (
                condition.Property === 'IsInterlaced'
                && condition.Value === 'false'
            ))
        ));

        expect(nativeHDRProfile?.Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({ Property: 'VideoBitDepth', Value: '10' }),
            expect.objectContaining({ Property: 'VideoFramerate', Value: '30' }),
            expect.objectContaining({ Property: 'VideoBitrate', Value: '40000000' }),
            expect.objectContaining({ Property: 'VideoLevel', Value: '153' }),
            expect.objectContaining({ Property: 'VideoProfile', Value: 'main 10' }),
            expect.objectContaining({ Property: 'Width', Value: '3840' }),
            expect.objectContaining({ Property: 'Height', Value: '2160' })
        ]));
        expect(result.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => condition.Value?.includes('HLG'))
        ))).toBe(false);
        expect(result.profile.DirectPlayProfiles).toContainEqual(expect.objectContaining({
            AudioCodec: expect.stringContaining('flac'),
            Container: 'mkv',
            VideoCodec: 'hevc'
        }));
    });

    it('does not synthesize a larger envelope across independent HDR routes', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities([ 'hevc' ], [ 'flac' ], [ 'hevc' ]);
        capabilities.rawHDRVideo = {
            ...capabilities.rawHDRVideo,
            hevc: {
                ...capabilities.rawHDRVideo.hevc,
                codecString: 'hvc1.2.4.L153.B0',
                maximumCodedHeight: 1_080,
                maximumCodedWidth: 1_920,
                maximumFramesPerSecond: 24,
                reason: 'bundled-software-decoder'
            }
        };
        const bundledHEVC = capabilities.bundledHEVC as NonNullable<
            CustomDecodeCapabilities['bundledHEVC']
        >;
        capabilities.bundledHEVC = {
            ...bundledHEVC,
            tiers: {
                ...bundledHEVC.tiers,
                'main10-4k': {
                    ...bundledHEVC.tiers['main10-4k'],
                    maximumBitrate: 12_000_000,
                    maximumCodedHeight: 1_080,
                    maximumCodedWidth: 1_920,
                    maximumLevel: 120
                }
            }
        };
        capabilities.nativeHDRHEVC = {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            maximumBitrate: 40_000_000,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            maximumFramesPerSecond: 60,
            maximumLevel: 153,
            measuredFramesPerSecond: 80,
            reason: 'decode-output-verified',
            status: 'supported'
        };

        const result = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            {
                allowNativeHDR: true,
                allowRawHDR: true,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:hlg-v1'
                ],
                authorizedRawHDRRouteKeys: [
                    'I420P10:bt2020-ncl:bt2020:limited:pq'
                ]
            }
        );
        const sharedProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'hevc'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'SDR|HDR10|HLG'
            ))
        ));
        const nativeHLGProfile = result.profile.CodecProfiles?.find(profile => (
            profile.Codec === 'hevc'
            && profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'HLG'
            ))
        ));

        expect(sharedProfile?.Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({ Property: 'VideoFramerate', Value: '24' }),
            expect.objectContaining({ Property: 'VideoBitrate', Value: '12000000' }),
            expect.objectContaining({ Property: 'VideoLevel', Value: '120' }),
            expect.objectContaining({ Property: 'Width', Value: '1920' }),
            expect.objectContaining({ Property: 'Height', Value: '1080' })
        ]));
        expect(nativeHLGProfile?.Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({ Property: 'VideoFramerate', Value: '60' }),
            expect.objectContaining({ Property: 'VideoBitrate', Value: '40000000' }),
            expect.objectContaining({ Property: 'VideoLevel', Value: '153' }),
            expect.objectContaining({ Property: 'Width', Value: '3840' }),
            expect.objectContaining({ Property: 'Height', Value: '2160' })
        ]));
    });

    it('advertises authorized Dolby Vision ranges only for raw HEVC', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc,vp9',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities([ 'hevc', 'vp9' ], [ 'aac' ], [ 'hevc', 'vp9' ]),
            { allowDolbyVision: true, allowRawHDR: false }
        );
        const HEVCProfiles = result.profile.CodecProfiles?.filter(profile => (
            profile.Codec?.split(',').includes('hevc')
        )) ?? [];
        const VP9Profiles = result.profile.CodecProfiles?.filter(profile => (
            profile.Codec?.split(',').includes('vp9')
        )) ?? [];

        expect(HEVCProfiles.some(profile => profile.Conditions?.some(condition => (
            condition.Property === 'VideoRangeType'
            && condition.Value === 'SDR|DOVI|DOVIWithHDR10|DOVIWithHLG'
        )))).toBe(true);
        expect(VP9Profiles.some(profile => profile.Conditions?.some(condition => (
            condition.Value?.includes('DOVI')
        )))).toBe(false);
    });

    it('advertises Profile 7 only through its separately authorized EL range', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities([ 'hevc' ], [ 'aac' ], [ 'hevc' ]),
            { allowDolbyVisionProfile7: true, allowRawHDR: false }
        );
        const rangeValues = result.profile.CodecProfiles
            ?.flatMap(profile => profile.Conditions ?? [])
            .filter(condition => condition.Property === 'VideoRangeType')
            .map(condition => condition.Value) ?? [];

        expect(rangeValues.some(value => value?.includes('DOVIWithEL'))).toBe(true);
        expect(rangeValues.some(value => value?.includes('DOVIWithHDR10'))).toBe(false);
        expect(rangeValues.some(value => value?.includes('DOVIWithHLG'))).toBe(false);
    });

    it('adds HDR10 only for an exact item-scoped separate Profile 7 base route', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities([ 'hevc' ], [ 'aac' ], [ 'hevc' ]),
            {
                allowDolbyVisionProfile7: true,
                allowDolbyVisionProfile7HDR10Base: true,
                allowRawHDR: false
            }
        );
        const rangeValues = result.profile.CodecProfiles
            ?.flatMap(profile => profile.Conditions ?? [])
            .filter(condition => condition.Property === 'VideoRangeType')
            .map(condition => condition.Value) ?? [];

        expect(rangeValues).toContain('SDR|DOVIWithEL|HDR10');
        expect(rangeValues).toContain('DOVIWithEL|HDR10');
        expect(rangeValues.some(value => value?.includes('HLG'))).toBe(false);
    });

    it.each([ 24 as const, 30 as const, 60 as const ])(
        'advertises only the exact native Profile 5 route at %i fps',
        maximumFramesPerSecond => {
            const original = createBaseProfile();
            original.CodecProfiles = [ {
                Codec: 'hevc',
                Conditions: [ {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoRangeType',
                    Value: 'SDR'
                } ],
                Type: 'Video'
            } ];
            const capabilities = createCapabilities([], [ 'aac' ], [], true);
            const nativeDolbyVisionHEVC = capabilities.nativeDolbyVisionHEVC;
            if (!nativeDolbyVisionHEVC) {
                throw new Error('The native Dolby Vision capability fixture is missing');
            }
            capabilities.nativeDolbyVisionHEVC = {
                ...nativeDolbyVisionHEVC,
                maximumFramesPerSecond,
                measuredFramesPerSecond: maximumFramesPerSecond * 1.25
            };
            const result = augmentDeviceProfileForCustomDecode(
                original,
                capabilities,
                { allowNativeDolbyVision: true, allowRawHDR: false }
            );
            const nativeProfile = result.profile.CodecProfiles?.find(profile => (
                profile.Codec === 'hevc'
                && profile.Conditions?.some(condition => (
                    condition.Property === 'VideoRangeType'
                    && condition.Value === 'DOVI'
                ))
                && profile.Conditions.some(condition => (
                    condition.Property === 'IsInterlaced'
                    && condition.Value === 'false'
                ))
            ));

            expect(nativeProfile).toBeDefined();
            expect(nativeProfile?.Conditions).toEqual(expect.arrayContaining([
                expect.objectContaining({
                    Condition: 'EqualsAny',
                    Property: 'VideoRangeType',
                    Value: 'DOVI'
                }),
                expect.objectContaining({
                    Condition: 'LessThanEqual',
                    Property: 'VideoFramerate',
                    Value: String(maximumFramesPerSecond)
                }),
                expect.objectContaining({
                    Condition: 'LessThanEqual',
                    Property: 'VideoBitrate',
                    Value: '40000000'
                }),
                expect.objectContaining({
                    Condition: 'LessThanEqual',
                    Property: 'VideoLevel',
                    Value: '153'
                }),
                expect.objectContaining({ Property: 'Width', Value: '3840' }),
                expect.objectContaining({ Property: 'Height', Value: '2160' })
            ]));
            expect(result.profile.CodecProfiles?.some(profile => (
                profile.Conditions?.some(condition => (
                    condition.Value?.includes('DOVIWithHDR10')
                    || condition.Value?.includes('DOVIWithHLG')
                ))
            ))).toBe(false);
        }
    );

    it('does not advertise native Profile 5 with an invalid frame-rate tier', () => {
        const capabilities = createCapabilities([], [ 'aac' ], [], true);
        const nativeDolbyVisionHEVC = capabilities.nativeDolbyVisionHEVC;
        if (!nativeDolbyVisionHEVC) {
            throw new Error('The native Dolby Vision capability fixture is missing');
        }
        capabilities.nativeDolbyVisionHEVC = {
            ...nativeDolbyVisionHEVC,
            maximumFramesPerSecond: 0,
            measuredFramesPerSecond: null
        };

        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            capabilities,
            { allowNativeDolbyVision: true, allowRawHDR: false }
        );

        expect(result.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value?.includes('DOVI')
            ))
        ))).toBe(false);
    });

    it('does not leak native Profile 5 support through raw authorization', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities([], [ 'aac' ], [], true),
            { allowDolbyVision: true, allowRawHDR: false }
        );

        expect(result.profile.CodecProfiles?.some(profile => (
            profile.Conditions?.some(condition => condition.Value?.includes('DOVI'))
        ))).toBe(false);
    });

    it('keeps stronger native Profile 5 limits separate from raw Dolby Vision limits', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities([], [ 'aac' ], [ 'hevc' ], true);
        capabilities.rawHDRVideo.hevc.codecString = 'hvc1.2.4.L120.B0';
        capabilities.rawHDRVideo.hevc.maximumCodedHeight = 1_080;
        capabilities.rawHDRVideo.hevc.maximumCodedWidth = 1_920;
        const result = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            {
                allowDolbyVision: true,
                allowNativeDolbyVision: true,
                allowRawHDR: false
            }
        );
        const nativeProfile = result.profile.CodecProfiles?.find(profile => (
            profile.ApplyConditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'DOVI'
            ))
        ));
        const rawProfile = result.profile.CodecProfiles?.find(profile => (
            profile.ApplyConditions?.some(condition => (
                condition.Property === 'VideoRangeType'
                && condition.Value === 'DOVIWithHDR10|DOVIWithHLG'
            ))
        ));

        expect(nativeProfile?.Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({ Property: 'Width', Value: '3840' }),
            expect.objectContaining({ Property: 'Height', Value: '2160' }),
            expect.objectContaining({ Property: 'VideoFramerate', Value: '24' }),
            expect.objectContaining({ Property: 'VideoBitrate', Value: '40000000' }),
            expect.objectContaining({ Property: 'VideoLevel', Value: '153' })
        ]));
        expect(rawProfile?.Conditions).toEqual(expect.arrayContaining([
            expect.objectContaining({ Property: 'Width', Value: '1920' }),
            expect.objectContaining({ Property: 'Height', Value: '1080' }),
            expect.objectContaining({ Property: 'VideoFramerate', Value: '30' }),
            expect.objectContaining({ Property: 'VideoBitrate', Value: '12000000' }),
            expect.objectContaining({ Property: 'VideoLevel', Value: '120' })
        ]));
    });

    it('keeps non-custom containers on the original native video range constraints', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Container: 'mp4,hls',
            Type: 'Video'
        } ];

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities([ 'hevc' ], [ 'aac' ], [ 'hevc' ]),
            RAW_HDR_PROFILE_OPTIONS
        );

        expect(result.profile.CodecProfiles?.slice(0, 2)).toEqual([
            {
                Codec: 'hevc',
                Conditions: original.CodecProfiles[0].Conditions,
                Container: 'hls',
                Type: 'Video'
            },
            {
                Codec: 'hevc',
                Conditions: [
                    {
                        Condition: 'EqualsAny',
                        IsRequired: false,
                        Property: 'VideoRangeType',
                        Value: 'SDR|HDR10|HLG'
                    },
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: true,
                        Property: 'VideoBitDepth',
                        Value: '10'
                    },
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: true,
                        Property: 'VideoFramerate',
                        Value: '30'
                    },
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: true,
                        Property: 'Width',
                        Value: '3840'
                    },
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: true,
                        Property: 'Height',
                        Value: '2160'
                    }
                ],
                Container: 'mp4',
                Type: 'Video'
            }
        ]);
    });

    it('does not widen raw HDR ranges when HDR presentation is disabled or on retry', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities([ 'hevc' ], [ 'aac' ], [ 'hevc' ]);

        const disabledResult = augmentDeviceProfileForCustomDecode(original, capabilities);
        const retryResult = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            { ...RAW_HDR_PROFILE_OPTIONS, isRetry: true }
        );

        expect(disabledResult.profile.CodecProfiles?.slice(0, original.CodecProfiles?.length ?? 0))
            .toEqual(original.CodecProfiles);
        expect(disabledResult.profile.CodecProfiles).toContainEqual(expect.objectContaining({
            Codec: 'hevc',
            Conditions: expect.arrayContaining([
                expect.objectContaining({ Property: 'Width', Value: '1920' }),
                expect.objectContaining({ Property: 'Height', Value: '1080' }),
                expect.objectContaining({ Property: 'VideoBitDepth', Value: '8' })
            ])
        }));
        expect(disabledResult.telemetry.widenedHDRCodecProfileCount).toBe(0);
        expect(retryResult.profile.CodecProfiles).toEqual(original.CodecProfiles);
        expect(retryResult.telemetry.widenedHDRCodecProfileCount).toBe(0);
    });

    it('keeps raw HDR range widening idempotent', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'hevc',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const capabilities = createCapabilities([ 'hevc' ], [ 'aac' ], [ 'hevc' ]);

        const firstResult = augmentDeviceProfileForCustomDecode(
            original,
            capabilities,
            RAW_HDR_PROFILE_OPTIONS
        );
        const secondResult = augmentDeviceProfileForCustomDecode(
            firstResult.profile,
            capabilities,
            RAW_HDR_PROFILE_OPTIONS
        );

        expect(secondResult.profile.CodecProfiles).toEqual(firstResult.profile.CodecProfiles);
        expect(secondResult.telemetry.widenedHDRCodecProfileCount).toBe(0);
    });

    it('never widens a retry profile', () => {
        const original = createBaseProfile();
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities(CUSTOM_VIDEO_CODECS, CUSTOM_AUDIO_CODECS),
            { isRetry: true }
        );

        expect(result.profile).toEqual(original);
        expect(result.profile).not.toBe(original);
        expect(result.profile.DirectPlayProfiles).not.toBe(original.DirectPlayProfiles);
        expect(result.telemetry).toMatchObject({
            addedProfileCount: 0,
            reason: 'retry-not-widened'
        });
    });

    it('deep-clones the input and preserves transcoding and constraint profiles', () => {
        const original = createBaseProfile();
        const originalSnapshot = JSON.stringify(original);
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities([ 'vp9' ], [ 'opus' ])
        );

        expect(JSON.stringify(original)).toBe(originalSnapshot);
        expect(result.profile.TranscodingProfiles).toEqual(original.TranscodingProfiles);
        expect(result.profile.TranscodingProfiles).not.toBe(original.TranscodingProfiles);
        expect(result.profile.TranscodingProfiles?.[0]).not.toBe(original.TranscodingProfiles?.[0]);
        expect(result.profile.TranscodingProfiles?.[0].Conditions)
            .not.toBe(original.TranscodingProfiles?.[0].Conditions);
        expect(result.profile.CodecProfiles?.[0].Conditions).not.toBe(original.CodecProfiles?.[0].Conditions);
        expect(result.profile.ContainerProfiles?.[0].Conditions)
            .not.toBe(original.ContainerProfiles?.[0].Conditions);
        expect(result.profile.SubtitleProfiles).not.toBe(original.SubtitleProfiles);
    });

    it('preserves native constraints outside the measured custom audio route', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [
            {
                Codec: 'h264,hevc',
                Conditions: [ {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoRangeType',
                    Value: 'SDR'
                } ],
                Type: 'Video'
            },
            {
                Codec: 'h264',
                Conditions: [ {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'VideoLevel',
                    Value: '42'
                } ],
                Container: 'webm',
                Type: 'Video'
            },
            {
                Codec: 'h264',
                Conditions: [ {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoProfile',
                    Value: 'main|high'
                } ],
                Container: '-mp4,m4v,mov,mkv,ts,m2ts,mts',
                Type: 'Video'
            },
            {
                Conditions: [ {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'Width',
                    Value: '3840'
                } ],
                Type: 'Video'
            },
            {
                Codec: 'aac',
                Conditions: [ {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'AudioChannels',
                    Value: '2'
                } ],
                Type: 'VideoAudio'
            },
            {
                Codec: 'aac',
                Conditions: [ {
                    Condition: 'LessThanEqual',
                    IsRequired: false,
                    Property: 'AudioChannels',
                    Value: '2'
                } ],
                Type: 'Audio'
            }
        ];

        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities([ 'h264' ], [ 'aac' ])
        );

        expect(result.profile.CodecProfiles?.slice(0, 4))
            .toEqual(original.CodecProfiles.slice(0, 4));
        expect(result.profile.CodecProfiles).toContainEqual({
            ...original.CodecProfiles[4],
            Container: '-mp4,m4v,mov,mkv,webm,ts,m2ts,mts'
        });
        expect(result.profile.CodecProfiles).toContainEqual(original.CodecProfiles[5]);
        expect(result.profile.CodecProfiles).not.toContainEqual(original.CodecProfiles[4]);
        expect(result.profile.CodecProfiles).not.toBe(original.CodecProfiles);
        expect(result.profile.CodecProfiles?.[0].Conditions).toEqual(
            original.CodecProfiles[0].Conditions
        );
        expect(result.profile.CodecProfiles?.[0].Conditions).not.toBe(
            original.CodecProfiles[0].Conditions
        );
        expect(result.profile.CodecProfiles?.[3]).not.toHaveProperty('Codec');
    });

    it('preserves native video constraints when direct play was already advertised', () => {
        const capabilities = createCapabilities([ 'h264' ], [ 'aac' ]);
        const firstResult = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities);
        const alreadyAdvertisedProfile: DeviceProfile = {
            ...firstResult.profile,
            CodecProfiles: [ {
                Codec: 'h264',
                Conditions: [ {
                    Condition: 'EqualsAny',
                    IsRequired: false,
                    Property: 'VideoRangeType',
                    Value: 'SDR'
                } ],
                Type: 'Video'
            } ]
        };

        const result = augmentDeviceProfileForCustomDecode(alreadyAdvertisedProfile, capabilities);

        expect(result.profile.CodecProfiles?.slice(
            0,
            alreadyAdvertisedProfile.CodecProfiles?.length ?? 0
        )).toEqual(alreadyAdvertisedProfile.CodecProfiles);
        expect(result.telemetry).toMatchObject({
            addedProfileCount: 0,
            reason: 'already-advertised'
        });
    });

    it('does not add profiles for unsupported or unknown codecs', () => {
        const original = createBaseProfile();
        const baseCapabilities = createCapabilities([], []);
        const capabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            video: {
                ...baseCapabilities.video,
                hevc: {
                    codec: 'hevc',
                    codecString: 'hvc1.1.6.L120.B0',
                    reason: 'probe-exception',
                    status: 'unknown'
                }
            }
        };
        const result = augmentDeviceProfileForCustomDecode(original, capabilities);

        expect(result.profile).toEqual(original);
        expect(result.telemetry).toMatchObject({
            addedProfileCount: 0,
            reason: 'no-supported-codecs'
        });
    });

    it('advertises proven bundled HEVC raw decode without native HEVC WebCodecs', () => {
        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            createCapabilities([], [ 'aac' ], [ 'hevc' ]),
            RAW_HDR_PROFILE_OPTIONS
        );

        expect(result.profile.DirectPlayProfiles).toContainEqual({
            AudioCodec: 'aac',
            Container: 'mp4,m4v,mov',
            Type: 'Video',
            VideoCodec: 'hevc'
        });
        expect(result.profile.DirectPlayProfiles).toContainEqual({
            AudioCodec: 'aac',
            Container: 'ts,m2ts,mts',
            Type: 'Video',
            VideoCodec: 'hevc'
        });
        expect(result.profile.DirectPlayProfiles?.some(directPlayProfile => (
            directPlayProfile.Container === 'webm'
        ))).toBe(false);
        expect(result.profile.CodecProfiles).toContainEqual(expect.objectContaining({
            Codec: 'hevc',
            Conditions: expect.arrayContaining([
                expect.objectContaining({ Property: 'VideoRangeType', Value: 'HDR10|HLG' }),
                expect.objectContaining({ Property: 'VideoBitDepth', Value: '10' }),
                expect.objectContaining({ Property: 'VideoFramerate', Value: '30' }),
                expect.objectContaining({ Property: 'VideoLevel', Value: '153' }),
                expect.objectContaining({ Property: 'VideoBitrate', Value: '40000000' }),
                expect.objectContaining({ Property: 'Width', Value: '3840' }),
                expect.objectContaining({ Property: 'Height', Value: '2160' }),
                expect.objectContaining({ Property: 'VideoProfile', Value: 'main 10' })
            ])
        }));
        expect(result.telemetry.supportedVideoCodecs).toEqual([ 'hevc' ]);
    });

    it('advertises only the qualified bundled HEVC Main10 1080p tier', () => {
        const capabilities = createCapabilities([], [ 'aac' ], [ 'hevc' ]);
        const bundledHEVC = createBundledHEVCCapabilities();
        capabilities.bundledHEVC = {
            ...bundledHEVC,
            reason: 'partial',
            tiers: {
                ...bundledHEVC.tiers,
                'main10-4k': {
                    ...bundledHEVC.tiers['main10-4k'],
                    reason: 'throughput-insufficient',
                    status: 'unsupported'
                }
            }
        };
        capabilities.rawHDRVideo = {
            ...capabilities.rawHDRVideo,
            hevc: {
                ...capabilities.rawHDRVideo.hevc,
                codecString: 'hvc1.2.4.L120.B0',
                maximumCodedHeight: 1_080,
                maximumCodedWidth: 1_920
            }
        };

        const result = augmentDeviceProfileForCustomDecode(
            createBaseProfile(),
            capabilities,
            RAW_HDR_PROFILE_OPTIONS
        );

        expect(result.profile.CodecProfiles).toContainEqual(expect.objectContaining({
            Codec: 'hevc',
            Conditions: expect.arrayContaining([
                expect.objectContaining({ Property: 'VideoRangeType', Value: 'HDR10|HLG' }),
                expect.objectContaining({ Property: 'VideoFramerate', Value: '30' }),
                expect.objectContaining({ Property: 'VideoLevel', Value: '120' }),
                expect.objectContaining({ Property: 'VideoBitrate', Value: '12000000' }),
                expect.objectContaining({ Property: 'Width', Value: '1920' }),
                expect.objectContaining({ Property: 'Height', Value: '1080' })
            ])
        }));
        expect(result.profile.CodecProfiles?.some(codecProfile => (
            codecProfile.Codec === 'hevc'
            && codecProfile.Conditions?.some(condition => (
                condition.Property === 'Width' && condition.Value === '3840'
            ))
        ))).toBe(false);
    });

    it('does not duplicate profiles already advertised by a previous augmentation', () => {
        const capabilities = createCapabilities([ 'vp9' ], [ 'opus' ]);
        const firstResult = augmentDeviceProfileForCustomDecode(createBaseProfile(), capabilities);
        const secondResult = augmentDeviceProfileForCustomDecode(firstResult.profile, capabilities);

        expect(secondResult.profile.DirectPlayProfiles).toEqual(firstResult.profile.DirectPlayProfiles);
        expect(secondResult.telemetry).toMatchObject({
            addedProfileCount: 0,
            reason: 'already-advertised'
        });
    });

    it('reports video-only support as having no safe combined profile', () => {
        const original = createBaseProfile();
        original.CodecProfiles = [ {
            Codec: 'av1',
            Conditions: [ {
                Condition: 'EqualsAny',
                IsRequired: false,
                Property: 'VideoRangeType',
                Value: 'SDR'
            } ],
            Type: 'Video'
        } ];
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities([ 'av1' ], [], [ 'av1' ]),
            RAW_HDR_PROFILE_OPTIONS
        );

        expect(result.profile.CodecProfiles).toEqual(original.CodecProfiles);
        expect(result.telemetry).toMatchObject({
            addedProfileCount: 0,
            reason: 'no-compatible-combinations',
            widenedHDRCodecProfileCount: 0
        });
    });
});
