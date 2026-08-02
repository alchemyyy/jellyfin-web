import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import { describe, expect, it } from 'vitest';

import {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_BUNDLED_AUDIO_CODECS,
    CUSTOM_RAW_HDR_VIDEO_CODECS,
    CUSTOM_VIDEO_CODECS,
    CUSTOM_WEB_CODECS_AUDIO_CODECS,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomDecodeCodecCapability,
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
                maximumBitrate: 12_000_000,
                maximumCodedHeight: 1_080,
                maximumCodedWidth: 1_920,
                maximumLevel: 120,
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
                maximumBitrate: 12_000_000,
                maximumCodedHeight: 1_080,
                maximumCodedWidth: 1_920,
                maximumLevel: 120,
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
                maximumBitrate: 40_000_000,
                maximumCodedHeight: 2_160,
                maximumCodedWidth: 3_840,
                maximumLevel: 153,
                profile: 'main10',
                reason: 'decode-output-verified',
                status: 'supported',
                tier: 'main10-4k'
            }
        }
    };
}

function createCapabilities(
    supportedVideoCodecs: readonly CustomVideoCodec[],
    supportedAudioCodecs: readonly CustomAudioCodec[],
    supportedRawHDRVideoCodecs: readonly CustomRawHDRVideoCodec[] = []
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
            reason: capabilityReason,
            status: supported ? 'supported' : 'unsupported'
        };
    }
    return {
        audio,
        ...(supportedVideoSet.has('hevc') || supportedRawHDRVideoSet.has('hevc') ? {
            bundledHEVC: createBundledHEVCCapabilities()
        } : {}),
        h264Profiles: createH264ProfileCapabilities(supportedVideoSet.has('h264')),
        rawHDRVideo,
        telemetry: {
            audioProbeCount: CUSTOM_WEB_CODECS_AUDIO_CODECS.length,
            bundledAudioCodecCount: CUSTOM_BUNDLED_AUDIO_CODECS.length,
            rawHDRVideoProbeCount: CUSTOM_RAW_HDR_VIDEO_CODECS.length - 1,
            reason: 'complete',
            supportedAudioCodecCount: supportedAudioCodecs.length,
            supportedRawHDRVideoCodecCount: supportedRawHDRVideoCodecs.length,
            supportedVideoCodecCount: supportedVideoCodecs.length,
            unknownAudioCodecCount: 0,
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
                        Value: '24'
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
                        Value: '24'
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

    it('preserves every native codec constraint while adding custom direct-play combinations', () => {
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

        expect(result.profile.CodecProfiles?.slice(0, original.CodecProfiles?.length ?? 0))
            .toEqual(original.CodecProfiles);
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
                expect.objectContaining({ Property: 'VideoFramerate', Value: '24' }),
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
                expect.objectContaining({ Property: 'VideoFramerate', Value: '24' }),
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
