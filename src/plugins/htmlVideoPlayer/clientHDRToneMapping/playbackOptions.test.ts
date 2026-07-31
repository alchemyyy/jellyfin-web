import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client';
import { describe, expect, it } from 'vitest';

import {
    configureClientHDRToneMappingPlaybackOptions,
    type ClientHDRToneMappingPlaybackOptions
} from './playbackOptions';

const HDR_MEDIA_SOURCE = {
    MediaStreams: [
        {
            Type: 'Video',
            VideoRangeType: 'HDR10'
        }
    ]
} as MediaSourceInfo;

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

    it('preserves explicit stream-copy rejection during error recovery', () => {
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
        )).toBe(true);
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
});
