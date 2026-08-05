import { describe, expect, it, vi } from 'vitest';

import { shouldAllowVideoStreamCopy } from './PlaybackStreamCopyPolicy';

describe('PlaybackStreamCopyPolicy', () => {
    it('preserves existing players without a stream-copy policy hook', () => {
        expect(shouldAllowVideoStreamCopy({}, { Id: 'item' }, 'source')).toBe(true);
    });

    it('passes the item, selected source, and fetched streams to the player policy', () => {
        const item = { Id: 'item' };
        const mediaStreams = [{ Codec: 'hevc', Type: 'Video' }];
        const supportsVideoStreamCopy = vi.fn(() => false);

        expect(shouldAllowVideoStreamCopy(
            { supportsVideoStreamCopy },
            item,
            'dolby-vision-source',
            mediaStreams
        )).toBe(false);
        expect(supportsVideoStreamCopy).toHaveBeenCalledWith(
            item,
            'dolby-vision-source',
            mediaStreams
        );
    });
});
