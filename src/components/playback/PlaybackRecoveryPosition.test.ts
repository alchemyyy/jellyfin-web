import { describe, expect, it } from 'vitest';

import { getPlaybackRecoveryStartTimeTicks } from './PlaybackRecoveryPosition';

describe('getPlaybackRecoveryStartTimeTicks', () => {
    it('preserves an intentional exact-zero position', () => {
        expect(getPlaybackRecoveryStartTimeTicks(0, 36_000_000_000, true)).toBe(0);
    });

    it('preserves the initial resume before playback starts', () => {
        expect(getPlaybackRecoveryStartTimeTicks(0, 36_000_000_000, false))
            .toBe(36_000_000_000);
    });

    it('uses the current nonzero position', () => {
        expect(getPlaybackRecoveryStartTimeTicks(42_000_000, 36_000_000_000, false))
            .toBe(42_000_000);
    });

    it('falls back only when the current position is invalid', () => {
        expect(getPlaybackRecoveryStartTimeTicks(Number.NaN, 36_000_000_000, true))
            .toBe(36_000_000_000);
        expect(getPlaybackRecoveryStartTimeTicks(undefined, 36_000_000_000, true))
            .toBe(36_000_000_000);
        expect(getPlaybackRecoveryStartTimeTicks(-1, 36_000_000_000, true))
            .toBe(36_000_000_000);
    });
});
