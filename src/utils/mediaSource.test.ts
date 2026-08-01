import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client';
import { describe, expect, it } from 'vitest';

import { getTranscodingOffsetTicks } from './mediaSource';

const START_POSITION_TICKS = 22_800_000_000;
const TRANSCODING_URL = 'https://example.test/Videos/item/master.m3u8';

describe('getTranscodingOffsetTicks', () => {
    it.each(['hls', 'HLS'])(
        'does not offset an %s transcode that preserves source timestamps',
        (transcodingSubProtocol) => {
            const mediaSource = {
                TranscodingSubProtocol: transcodingSubProtocol
            } as MediaSourceInfo;

            expect(getTranscodingOffsetTicks(
                mediaSource,
                TRANSCODING_URL,
                START_POSITION_TICKS
            )).toBe(0);
        }
    );

    it('does not offset HLS with a selected external graphical subtitle', () => {
        const mediaSource = {
            TranscodingSubProtocol: 'hls',
            DefaultSubtitleStreamIndex: 3,
            MediaStreams: [
                {
                    Index: 3,
                    Type: 'Subtitle',
                    DeliveryMethod: 'External',
                    IsTextSubtitleStream: false,
                    Codec: 'pgssub'
                }
            ]
        } as MediaSourceInfo;

        expect(getTranscodingOffsetTicks(
            mediaSource,
            TRANSCODING_URL,
            START_POSITION_TICKS
        )).toBe(0);
    });

    it('does not offset a progressive transcode that copies timestamps', () => {
        const mediaSource = {
            TranscodingSubProtocol: 'http'
        } as MediaSourceInfo;
        const mediaURL = 'https://example.test/Videos/item/stream.mp4?CopyTimestamps=True&AudioCodec=aac';

        expect(getTranscodingOffsetTicks(
            mediaSource,
            mediaURL,
            START_POSITION_TICKS
        )).toBe(0);
    });

    it.each([
        'https://example.test/Videos/item/stream.mp4',
        'https://example.test/Videos/item/stream.mp4?CopyTimestamps=false',
        'https://example.test/Videos/item/stream.mp4?Value=CopyTimestamps=true'
    ])('offsets a rebased progressive transcode for %s', (mediaURL) => {
        const mediaSource = {
            TranscodingSubProtocol: 'http'
        } as MediaSourceInfo;

        expect(getTranscodingOffsetTicks(
            mediaSource,
            mediaURL,
            START_POSITION_TICKS
        )).toBe(START_POSITION_TICKS);
    });

    it('uses the transcoding protocol rather than the source container', () => {
        const mediaSource = {
            Container: 'hls',
            TranscodingSubProtocol: 'http'
        } as MediaSourceInfo;

        expect(getTranscodingOffsetTicks(
            mediaSource,
            'https://example.test/Videos/item/stream.mp4',
            START_POSITION_TICKS
        )).toBe(START_POSITION_TICKS);
    });

    it.each([0, null, undefined])(
        'returns zero for a missing start position (%s)',
        (startPositionTicks) => {
            const mediaSource = {
                TranscodingSubProtocol: 'http'
            } as MediaSourceInfo;

            expect(getTranscodingOffsetTicks(
                mediaSource,
                'https://example.test/Videos/item/stream.mp4',
                startPositionTicks
            )).toBe(0);
        }
    );
});
