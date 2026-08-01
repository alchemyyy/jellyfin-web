import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import { describe, expect, it } from 'vitest';

import {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_VIDEO_CODECS,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomDecodeCodecCapability,
    type CustomVideoCodec
} from './CustomDecodeCapabilities';
import { augmentDeviceProfileForCustomDecode } from './CustomDeviceProfile';

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

function createCapabilities(
    supportedVideoCodecs: readonly CustomVideoCodec[],
    supportedAudioCodecs: readonly CustomAudioCodec[]
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
    return {
        audio,
        telemetry: {
            audioProbeCount: CUSTOM_AUDIO_CODECS.length,
            reason: 'complete',
            supportedAudioCodecCount: supportedAudioCodecs.length,
            supportedVideoCodecCount: supportedVideoCodecs.length,
            unknownAudioCodecCount: 0,
            unknownVideoCodecCount: 0,
            videoProbeCount: CUSTOM_VIDEO_CODECS.length
        },
        video
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
            supportedVideoCodecs: [ 'h264', 'vp8' ]
        });
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

        expect(result.profile.CodecProfiles).toEqual(original.CodecProfiles);
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

        expect(result.profile.CodecProfiles).toEqual(alreadyAdvertisedProfile.CodecProfiles);
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
        const result = augmentDeviceProfileForCustomDecode(
            original,
            createCapabilities([ 'av1' ], [])
        );

        expect(result.profile.CodecProfiles).toEqual(original.CodecProfiles);
        expect(result.telemetry).toMatchObject({
            addedProfileCount: 0,
            reason: 'no-compatible-combinations'
        });
    });
});
