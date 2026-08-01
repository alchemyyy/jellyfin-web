import type {
    DeviceProfile,
    MediaSourceInfo
} from '@jellyfin/sdk/lib/generated-client';
import { describe, expect, it } from 'vitest';

import {
    configureClientHDRToneMappingPlaybackOptions,
    configureClientHDRToneMappingSubtitleProfiles,
    type ClientHDRToneMappingPlaybackOptions,
    type ClientHDRToneMappingSubtitleProfileOptions
} from './playbackOptions';

const HDR_MEDIA_SOURCE = {
    MediaStreams: [
        {
            Type: 'Video',
            VideoRangeType: 'HDR10'
        }
    ]
} as MediaSourceInfo;

const CLIENT_HDR_BITMAP_SUBTITLE_OPTIONS: ClientHDRToneMappingSubtitleProfileOptions = {
    alwaysBurnInSubtitleWhenTranscoding: false,
    canvas2DSupported: true,
    isClientHDRToneMappingPlayback: true,
    subtitleBurnInSetting: ''
};

describe('client HDR tone-mapping playback options', () => {
    it('leaves disabled and unsupported playback unchanged', () => {
        const options: ClientHDRToneMappingPlaybackOptions = {
            allowAudioStreamCopy: null,
            allowVideoStreamCopy: null,
            enableDirectPlay: null,
            enableDirectStream: null
        };
        const originalOptions = { ...options };

        expect(configureClientHDRToneMappingPlaybackOptions(
            options,
            true,
            false,
            true,
            HDR_MEDIA_SOURCE
        )).toBe(false);
        expect(options).toEqual(originalOptions);
    });

    it('requests an fMP4 remux for compatible local HDR playback', () => {
        const options: ClientHDRToneMappingPlaybackOptions = {};

        expect(configureClientHDRToneMappingPlaybackOptions(
            options,
            true,
            true,
            true,
            HDR_MEDIA_SOURCE
        )).toBe(true);
        expect(options).toEqual({
            allowAudioStreamCopy: true,
            allowVideoStreamCopy: true,
            enableDirectPlay: false,
            enableDirectStream: false
        });
    });

    it('rejects client HDR playback when recovery disabled video stream copy', () => {
        const options: ClientHDRToneMappingPlaybackOptions = {
            allowAudioStreamCopy: false,
            allowVideoStreamCopy: false
        };

        expect(configureClientHDRToneMappingPlaybackOptions(
            options,
            true,
            true,
            true,
            HDR_MEDIA_SOURCE
        )).toBe(false);
        expect(options.allowAudioStreamCopy).toBe(false);
        expect(options.allowVideoStreamCopy).toBe(false);
    });

    it('leaves live HDR playback unchanged', () => {
        const options: ClientHDRToneMappingPlaybackOptions = {};

        expect(configureClientHDRToneMappingPlaybackOptions(
            options,
            true,
            true,
            true,
            {
                ...HDR_MEDIA_SOURCE,
                IsInfiniteStream: true
            }
        )).toBe(false);
        expect(options).toEqual({});
    });

    it('adds external bitmap subtitles to confirmed HDR playback', () => {
        const deviceProfile: DeviceProfile = {
            SubtitleProfiles: [
                {
                    Format: 'vtt',
                    Method: 'External'
                }
            ]
        };

        configureClientHDRToneMappingSubtitleProfiles(
            deviceProfile,
            CLIENT_HDR_BITMAP_SUBTITLE_OPTIONS
        );

        expect(deviceProfile.SubtitleProfiles).toEqual([
            {
                Format: 'vtt',
                Method: 'External'
            },
            {
                Format: 'pgssub',
                Method: 'External'
            },
            {
                Container: 'mks',
                Format: 'vobsub',
                Method: 'External'
            }
        ]);
    });

    it('adds missing bitmap profiles once', () => {
        const deviceProfile: DeviceProfile = {
            SubtitleProfiles: [
                {
                    Format: 'PGSSUB',
                    Method: 'External'
                }
            ]
        };

        configureClientHDRToneMappingSubtitleProfiles(
            deviceProfile,
            {
                ...CLIENT_HDR_BITMAP_SUBTITLE_OPTIONS,
                subtitleBurnInSetting: undefined
            }
        );
        configureClientHDRToneMappingSubtitleProfiles(
            deviceProfile,
            {
                ...CLIENT_HDR_BITMAP_SUBTITLE_OPTIONS,
                subtitleBurnInSetting: undefined
            }
        );

        expect(deviceProfile.SubtitleProfiles).toEqual([
            {
                Format: 'PGSSUB',
                Method: 'External'
            },
            {
                Container: 'mks',
                Format: 'vobsub',
                Method: 'External'
            }
        ]);
    });

    it('initializes a missing subtitle profile collection', () => {
        const deviceProfile: DeviceProfile = {};

        configureClientHDRToneMappingSubtitleProfiles(
            deviceProfile,
            {
                ...CLIENT_HDR_BITMAP_SUBTITLE_OPTIONS,
                subtitleBurnInSetting: null
            }
        );

        expect(deviceProfile.SubtitleProfiles).toHaveLength(2);
    });

    it.each([
        'onlyimageformats',
        'allcomplexformats',
        'all'
    ])('preserves the explicit %s subtitle burn-in mode', (subtitleBurnInSetting: string) => {
        const deviceProfile: DeviceProfile = {
            SubtitleProfiles: []
        };

        configureClientHDRToneMappingSubtitleProfiles(
            deviceProfile,
            {
                ...CLIENT_HDR_BITMAP_SUBTITLE_OPTIONS,
                subtitleBurnInSetting
            }
        );

        expect(deviceProfile.SubtitleProfiles).toEqual([]);
    });

    it('leaves unconfirmed playback unchanged', () => {
        const deviceProfile: DeviceProfile = {
            SubtitleProfiles: []
        };

        configureClientHDRToneMappingSubtitleProfiles(
            deviceProfile,
            {
                ...CLIENT_HDR_BITMAP_SUBTITLE_OPTIONS,
                isClientHDRToneMappingPlayback: false
            }
        );

        expect(deviceProfile.SubtitleProfiles).toEqual([]);
    });

    it('preserves always-burn-in transcoding preferences', () => {
        const deviceProfile: DeviceProfile = {
            SubtitleProfiles: []
        };

        configureClientHDRToneMappingSubtitleProfiles(
            deviceProfile,
            {
                ...CLIENT_HDR_BITMAP_SUBTITLE_OPTIONS,
                alwaysBurnInSubtitleWhenTranscoding: true
            }
        );

        expect(deviceProfile.SubtitleProfiles).toEqual([]);
    });

    it('leaves profiles unchanged without bitmap rendering support', () => {
        const deviceProfile: DeviceProfile = {
            SubtitleProfiles: []
        };

        configureClientHDRToneMappingSubtitleProfiles(
            deviceProfile,
            {
                ...CLIENT_HDR_BITMAP_SUBTITLE_OPTIONS,
                canvas2DSupported: false
            }
        );

        expect(deviceProfile.SubtitleProfiles).toEqual([]);
    });

    it('leaves profiles unchanged when PGS rendering is disabled', () => {
        const deviceProfile: DeviceProfile = {
            SubtitleProfiles: []
        };

        configureClientHDRToneMappingSubtitleProfiles(
            deviceProfile,
            {
                ...CLIENT_HDR_BITMAP_SUBTITLE_OPTIONS,
                enablePgsRender: false
            }
        );

        expect(deviceProfile.SubtitleProfiles).toEqual([]);
    });

    it('leaves profiles unchanged for playback recovery retries', () => {
        const deviceProfile: DeviceProfile = {
            SubtitleProfiles: []
        };

        configureClientHDRToneMappingSubtitleProfiles(
            deviceProfile,
            {
                ...CLIENT_HDR_BITMAP_SUBTITLE_OPTIONS,
                isRetry: true
            }
        );

        expect(deviceProfile.SubtitleProfiles).toEqual([]);
    });
});
