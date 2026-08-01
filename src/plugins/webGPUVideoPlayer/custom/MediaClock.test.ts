import { describe, expect, it } from 'vitest';

import { secondsToMicroseconds, type Microseconds } from '../MediaTime';
import MediaClock from './MediaClock';

describe('MediaClock', () => {
    it('advances signed integer media time only while running', () => {
        let monotonicTime = secondsToMicroseconds(10);
        const clock = new MediaClock(() => monotonicTime);

        clock.seek(secondsToMicroseconds(-2));
        expect(clock.mediaTimeMicroseconds).toBe(-2_000_000);

        clock.resume();
        monotonicTime = secondsToMicroseconds(10.25);
        expect(clock.mediaTimeMicroseconds).toBe(-1_750_000);

        clock.pause();
        monotonicTime = secondsToMicroseconds(15);
        expect(clock.mediaTimeMicroseconds).toBe(-1_750_000);
    });

    it('changes rate without introducing a media-time discontinuity', () => {
        let monotonicTime = secondsToMicroseconds(0);
        const clock = new MediaClock(() => monotonicTime);
        clock.resume();
        monotonicTime = secondsToMicroseconds(1);

        const generation = clock.setPlaybackRate(2);
        expect(clock.mediaTimeMicroseconds).toBe(1_000_000);
        expect(clock.rate).toBe(2);
        expect(clock.isGenerationCurrent(generation)).toBe(true);

        monotonicTime = secondsToMicroseconds(1.25);
        expect(clock.snapshot()).toEqual({
            generation,
            mediaTimeMicroseconds: 1_500_000,
            paused: false,
            playbackRate: 2
        });
    });

    it('synchronizes to an external audio master without changing generation', () => {
        let monotonicTime = secondsToMicroseconds(10);
        const clock = new MediaClock(() => monotonicTime);
        clock.resume();
        const generation = clock.generation;

        monotonicTime = secondsToMicroseconds(10.5);
        clock.synchronize(secondsToMicroseconds(5));
        expect(clock.generation).toBe(generation);
        expect(clock.mediaTimeMicroseconds).toBe(5_000_000);

        monotonicTime = secondsToMicroseconds(10.75);
        expect(clock.mediaTimeMicroseconds).toBe(5_250_000);
    });

    it('invalidates captured generations on every state operation', () => {
        const clock = new MediaClock(() => secondsToMicroseconds(0));
        const initialGeneration = clock.generation;
        const seekGeneration = clock.seek(secondsToMicroseconds(5));
        const pauseGeneration = clock.pause();
        const resumeGeneration = clock.resume();
        const rateGeneration = clock.setPlaybackRate(1);
        const invalidatedGeneration = clock.invalidate();
        const resetGeneration = clock.reset(secondsToMicroseconds(-1));

        expect([
            initialGeneration,
            seekGeneration,
            pauseGeneration,
            resumeGeneration,
            rateGeneration,
            invalidatedGeneration,
            resetGeneration
        ]).toEqual([ 1, 2, 3, 4, 5, 6, 7 ]);
        expect(clock.isGenerationCurrent(initialGeneration)).toBe(false);
        expect(clock.isPaused).toBe(true);
        expect(clock.rate).toBe(1);
        expect(clock.mediaTimeMicroseconds).toBe(-1_000_000);
    });

    it('rejects invalid rates, timestamps, and non-monotonic time', () => {
        let monotonicTime: Microseconds = secondsToMicroseconds(1);
        const clock = new MediaClock(() => monotonicTime);

        expect(() => clock.setPlaybackRate(0)).toThrow(RangeError);
        expect(() => clock.setPlaybackRate(Number.NaN)).toThrow(RangeError);
        expect(() => clock.seek(1.5 as Microseconds)).toThrow(RangeError);

        clock.resume();
        monotonicTime = secondsToMicroseconds(0.5);
        expect(() => clock.mediaTimeMicroseconds).toThrow('Monotonic time moved backwards');
    });
});
