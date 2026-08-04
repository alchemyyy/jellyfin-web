import { describe, expect, it } from 'vitest';

import { shouldPreferHDRHLSRendition } from './HLSRenditionPreference';

describe('shouldPreferHDRHLSRendition', () => {
    it('selects the SDR rendition when a video reason requires encoding', () => {
        expect(shouldPreferHDRHLSRendition({
            mediaSource: {
                TranscodingUrl: '/Videos/item/master.m3u8?TranscodeReasons=AudioCodecNotSupported%2CVideoRangeTypeNotSupported'
            },
            playMethod: 'Transcode',
            url: '/Videos/item/master.m3u8'
        })).toBe(false);
    });

    it('retains the copied HDR rendition for audio-only transcoding', () => {
        expect(shouldPreferHDRHLSRendition({
            playMethod: 'Transcode',
            url: '/Videos/item/master.m3u8?TranscodeReasons=AudioCodecNotSupported%2CAudioChannelsNotSupported'
        })).toBe(true);
    });

    it('selects the SDR rendition when video stream copy is explicitly disabled', () => {
        expect(shouldPreferHDRHLSRendition({
            playMethod: 'DirectStream',
            url: '/Videos/item/master.m3u8?AllowVideoStreamCopy=false'
        })).toBe(false);
    });

    it('selects the SDR rendition for subtitle encoding', () => {
        expect(shouldPreferHDRHLSRendition({
            playMethod: 'Transcode',
            url: '/Videos/item/master.m3u8?TranscodeReasons=SubtitleCodecNotSupported'
        })).toBe(false);
    });

    it('defaults to HDR preference without structured video-encoding evidence', () => {
        expect(shouldPreferHDRHLSRendition({
            playMethod: 'Transcode',
            url: '/Videos/item/master.m3u8'
        })).toBe(true);
    });
});
