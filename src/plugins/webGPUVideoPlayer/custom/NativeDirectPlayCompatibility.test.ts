import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import type { DirectPlayProfile } from '@jellyfin/sdk/lib/generated-client/models/direct-play-profile';
import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client/models/media-source-info';
import type { MediaStream } from '@jellyfin/sdk/lib/generated-client/models/media-stream';
import { describe, expect, it } from 'vitest';

import { isSameSessionNativePlaybackCompatible } from './NativeDirectPlayCompatibility';

type PlaybackOptions = {
    mediaSource: MediaSourceInfo
    playMethod: string
    url: string
};

function createVideoStream(): MediaStream {
    return {
        AverageFrameRate: 24,
        BitDepth: 8,
        BitRate: 8_000_000,
        Codec: 'h264',
        CodecTag: 'avc1',
        Height: 1_080,
        Index: 4,
        IsAnamorphic: false,
        IsAVC: true,
        IsInterlaced: false,
        Level: 41,
        PacketLength: 188,
        Profile: 'High',
        RefFrames: 4,
        Rotation: 0,
        Type: 'Video',
        VideoRangeType: 'SDR',
        Width: 1_920
    };
}

function createAudioStream(index: number, codec: string, profile: string): MediaStream {
    return {
        BitDepth: 16,
        BitRate: 192_000,
        Channels: 2,
        Codec: codec,
        Index: index,
        IsExternal: false,
        Profile: profile,
        SampleRate: 48_000,
        Type: 'Audio'
    };
}

function createOptions(): PlaybackOptions {
    return {
        mediaSource: {
            Container: 'mov,mp4,m4a,3gp,3g2,mj2',
            DefaultAudioStreamIndex: 12,
            MediaStreams: [
                createVideoStream(),
                { Codec: 'subrip', Index: 8, Type: 'Subtitle' },
                createAudioStream(12, 'aac', 'LC'),
                createAudioStream(20, 'opus', 'Opus')
            ],
            SupportsDirectPlay: true,
            Timestamp: 'None'
        },
        playMethod: 'DirectPlay',
        url: '/Videos/item/stream.mp4?api_key=secret'
    };
}

function createProfile(): DeviceProfile {
    return {
        CodecProfiles: [
            {
                ApplyConditions: [ {
                    Condition: 'GreaterThanEqual',
                    Property: 'VideoBitDepth',
                    Value: '8'
                } ],
                Codec: 'h264',
                Conditions: [
                    {
                        Condition: 'EqualsAny',
                        IsRequired: false,
                        Property: 'VideoProfile',
                        Value: 'main|high'
                    },
                    {
                        Condition: 'EqualsAny',
                        IsRequired: false,
                        Property: 'VideoRangeType',
                        Value: 'SDR|HDR10'
                    },
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: false,
                        Property: 'VideoLevel',
                        Value: '52'
                    },
                    {
                        Condition: 'LessThanEqual',
                        IsRequired: false,
                        Property: 'Width',
                        Value: '3840'
                    },
                    {
                        Condition: 'NotEquals',
                        IsRequired: false,
                        Property: 'IsInterlaced',
                        Value: 'true'
                    }
                ],
                Container: 'mp4,m4v',
                Type: 'Video'
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
            },
            {
                Conditions: [ {
                    Condition: 'LessThanEqual',
                    Property: 'AudioChannels',
                    Value: '1'
                } ],
                Type: 'Audio'
            }
        ],
        ContainerProfiles: [ {
            Conditions: [ {
                Condition: 'LessThanEqual',
                IsRequired: false,
                Property: 'NumStreams',
                Value: '4'
            } ],
            Container: 'mp4,m4v',
            Type: 'Video'
        } ],
        DirectPlayProfiles: [ {
            AudioCodec: 'aac,opus',
            Container: 'mp4,m4v',
            Type: 'Video',
            VideoCodec: 'h264,hevc'
        } ]
    };
}

describe('NativeDirectPlayCompatibility', () => {
    it('proves an exact selected source against direct, container, and codec profiles', () => {
        expect(isSameSessionNativePlaybackCompatible(
            createOptions(),
            createProfile()
        )).toBe(true);
    });

    it('ignores native profile bitrate conditions during fallback selection', () => {
        const profile = createProfile();
        profile.CodecProfiles?.[0].Conditions?.push({
            Condition: 'LessThanEqual',
            Property: 'VideoBitrate',
            Value: '1'
        });
        profile.CodecProfiles?.[1].Conditions?.push({
            Condition: 'LessThanEqual',
            Property: 'AudioBitrate',
            Value: '1'
        });

        expect(isSameSessionNativePlaybackCompatible(
            createOptions(),
            profile
        )).toBe(true);
    });

    it.each([
        [ 3_000, true ],
        [ 12_345, true ],
        [ 96_000, true ],
        [ 192_000, true ],
        [ 2_999, false ],
        [ 192_001, false ]
    ])('evaluates bounded audio source rate %i as compatible=%s', (sampleRate, compatible) => {
        const options = createOptions();
        const audioStream = options.mediaSource.MediaStreams?.find(stream => (
            stream.Index === options.mediaSource.DefaultAudioStreamIndex
        ));
        if (!audioStream) {
            throw new Error('The selected audio stream fixture is unavailable');
        }
        audioStream.SampleRate = sampleRate;
        const profile = createProfile();
        profile.CodecProfiles?.[1].Conditions?.push(
            {
                Condition: 'GreaterThanEqual',
                IsRequired: true,
                Property: 'AudioSampleRate',
                Value: '3000'
            },
            {
                Condition: 'LessThanEqual',
                IsRequired: true,
                Property: 'AudioSampleRate',
                Value: '192000'
            }
        );

        expect(isSameSessionNativePlaybackCompatible(options, profile)).toBe(compatible);
    });

    it.each([
        [ { AudioCodec: 'flac', Container: 'mp4', Type: 'Video', VideoCodec: 'h264' } ],
        [ { AudioCodec: 'aac', Container: 'webm', Type: 'Video', VideoCodec: 'h264' } ],
        [ { AudioCodec: 'aac', Container: 'mp4', Type: 'Video', VideoCodec: 'vp9' } ]
    ])('rejects a DirectPlayProfile mismatch %#', directPlayProfile => {
        const profile = createProfile();
        profile.DirectPlayProfiles = [ directPlayProfile as DirectPlayProfile ];

        expect(isSameSessionNativePlaybackCompatible(createOptions(), profile)).toBe(false);
    });

    it('evaluates the exact selected audio stream and secondary-audio state', () => {
        const options = createOptions();
        options.mediaSource.DefaultAudioStreamIndex = 20;

        expect(isSameSessionNativePlaybackCompatible(options, createProfile())).toBe(false);
    });

    it('ignores a condition profile only when every apply condition is known to fail', () => {
        const profile = createProfile();
        profile.CodecProfiles = [ {
            ApplyConditions: [ {
                Condition: 'Equals',
                Property: 'VideoProfile',
                Value: 'Baseline'
            } ],
            Codec: 'h264',
            Conditions: [ {
                Condition: 'LessThanEqual',
                Property: 'Width',
                Value: '1'
            } ],
            Type: 'Video'
        } ];

        expect(isSameSessionNativePlaybackCompatible(createOptions(), profile)).toBe(true);
    });

    it('rejects unknown apply conditions instead of assuming a profile does not apply', () => {
        const profile = createProfile();
        profile.CodecProfiles = [ {
            ApplyConditions: [ {
                Condition: 'Equals',
                Property: 'Has64BitOffsets',
                Value: 'false'
            } ],
            Codec: 'h264',
            Type: 'Video'
        } ];

        expect(isSameSessionNativePlaybackCompatible(createOptions(), profile)).toBe(false);
    });

    it('rejects missing metadata even when the server condition is not required', () => {
        const options = createOptions();
        const videoStream = options.mediaSource.MediaStreams?.[0];
        if (!videoStream) {
            throw new Error('Expected a video stream');
        }
        delete videoStream.Width;

        expect(isSameSessionNativePlaybackCompatible(options, createProfile())).toBe(false);
    });

    it('rejects unsupported condition operators and properties', () => {
        const profile = createProfile();
        profile.ContainerProfiles = [ {
            Conditions: [ {
                Condition: 'EqualsAny',
                Property: 'Has64BitOffsets',
                Value: 'false|true'
            } ],
            Type: 'Video'
        } ];

        expect(isSameSessionNativePlaybackCompatible(createOptions(), profile)).toBe(false);

        const operatorProfile = createProfile();
        const condition = operatorProfile.ContainerProfiles?.[0].Conditions?.[0];
        if (!condition) {
            throw new Error('Expected a container profile condition');
        }
        condition.Condition = 'GreaterThan' as unknown as typeof condition.Condition;
        expect(isSameSessionNativePlaybackCompatible(
            createOptions(),
            operatorProfile
        )).toBe(false);
    });

    it('uses profile container blacklists only to scope matching restrictions', () => {
        const profile = createProfile();
        profile.CodecProfiles = [ {
            Codec: 'h264',
            Conditions: [ {
                Condition: 'LessThanEqual',
                Property: 'Width',
                Value: '1'
            } ],
            Container: '-mp4,m4v',
            Type: 'Video'
        } ];

        expect(isSameSessionNativePlaybackCompatible(createOptions(), profile)).toBe(true);

        const options = createOptions();
        options.mediaSource.Container = 'mkv';
        profile.DirectPlayProfiles = [ {
            AudioCodec: 'aac',
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: 'h264'
        } ];
        expect(isSameSessionNativePlaybackCompatible(options, profile)).toBe(false);
    });

    it('does not treat HDR10Plus as static HDR10 without explicit profile support', () => {
        const options = createOptions();
        const videoStream = options.mediaSource.MediaStreams?.[0];
        if (!videoStream) {
            throw new Error('Expected a video stream');
        }
        videoStream.VideoRangeType = 'HDR10Plus';

        expect(isSameSessionNativePlaybackCompatible(options, createProfile())).toBe(false);

        const profile = createProfile();
        const videoRangeCondition = profile.CodecProfiles?.[0].Conditions?.find(condition => (
            condition.Property === 'VideoRangeType'
        ));
        if (!videoRangeCondition) {
            throw new Error('Expected a video range condition');
        }
        videoRangeCondition.Value = 'SDR|HDR10|HDR10Plus';
        expect(isSameSessionNativePlaybackCompatible(options, profile)).toBe(true);
    });

    it('accepts a proven audio-less video source without applying VideoAudio profiles', () => {
        const options = createOptions();
        options.mediaSource.DefaultAudioStreamIndex = null;
        options.mediaSource.MediaStreams = options.mediaSource.MediaStreams?.filter(stream => (
            stream.Type !== 'Audio'
        ));

        expect(isSameSessionNativePlaybackCompatible(options, createProfile())).toBe(true);
    });

    it('rejects malformed or non-direct selected sources', () => {
        const options = createOptions();
        options.playMethod = 'Transcode';
        expect(isSameSessionNativePlaybackCompatible(options, createProfile())).toBe(false);

        options.playMethod = 'DirectPlay';
        options.mediaSource.SupportsDirectPlay = false;
        expect(isSameSessionNativePlaybackCompatible(options, createProfile())).toBe(false);

        options.mediaSource.SupportsDirectPlay = true;
        options.mediaSource.DefaultAudioStreamIndex = 999;
        expect(isSameSessionNativePlaybackCompatible(options, createProfile())).toBe(false);

        expect(isSameSessionNativePlaybackCompatible(options, {})).toBe(false);
    });
});
