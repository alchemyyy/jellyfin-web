import { describe, expect, it } from 'vitest';

import { getTrackByOrdinal } from './CustomDecodeTrackSelection';

describe('CustomDecodeTrackSelection', () => {
    it('selects from a type-specific track array by ordinal', () => {
        const videoTracks = [
            { identity: 'video-primary' },
            { identity: 'video-commentary' }
        ];

        expect(getTrackByOrdinal(videoTracks, 1)).toBe(videoTracks[1]);
    });

    it.each([ -1, 2, 0.5, Number.NaN ])(
        'rejects an unavailable or invalid ordinal %s',
        trackOrdinal => {
            expect(getTrackByOrdinal([ { identity: 'audio-primary' } ], trackOrdinal)).toBeNull();
        }
    );
});
