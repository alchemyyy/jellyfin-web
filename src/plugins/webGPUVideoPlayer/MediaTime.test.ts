import { describe, expect, it } from 'vitest';

import {
    MICROSECONDS_PER_MILLISECOND,
    MICROSECONDS_PER_SECOND,
    microsecondsToMilliseconds,
    microsecondsToSeconds,
    millisecondsToMicroseconds,
    secondsToMicroseconds
} from './MediaTime';

describe('MediaTime', () => {
    it('declares the media boundary conversion constants', () => {
        expect(MICROSECONDS_PER_MILLISECOND).toBe(1_000);
        expect(MICROSECONDS_PER_SECOND).toBe(1_000_000);
    });

    it('rounds HTML seconds to signed integer microseconds', () => {
        expect(secondsToMicroseconds(1.2345674)).toBe(1_234_567);
        expect(secondsToMicroseconds(1.2345676)).toBe(1_234_568);
        expect(secondsToMicroseconds(-1.25)).toBe(-1_250_000);
        expect(Number.isInteger(secondsToMicroseconds(0.0000006))).toBe(true);
    });

    it('rounds Jellyfin milliseconds to signed integer microseconds', () => {
        expect(millisecondsToMicroseconds(12.345)).toBe(12_345);
        expect(millisecondsToMicroseconds(-12.345)).toBe(-12_345);
        expect(Number.isInteger(millisecondsToMicroseconds(0.0006))).toBe(true);
    });

    it('converts microseconds only at API boundaries', () => {
        const microseconds = millisecondsToMicroseconds(12.345);
        expect(microsecondsToMilliseconds(microseconds)).toBe(12.345);
        expect(microsecondsToSeconds(microseconds)).toBe(0.012345);
    });

    it('rejects invalid and unsafe timestamps', () => {
        expect(() => secondsToMicroseconds(Number.NaN)).toThrow(RangeError);
        expect(() => secondsToMicroseconds(Number.POSITIVE_INFINITY)).toThrow(RangeError);
        expect(() => millisecondsToMicroseconds(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
    });
});
