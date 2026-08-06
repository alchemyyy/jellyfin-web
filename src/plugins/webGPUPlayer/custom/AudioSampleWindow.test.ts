import { describe, expect, it } from 'vitest';

import { secondsToMicroseconds } from '../MediaTime';
import { getAudioSampleWindow } from './AudioSampleWindow';

describe('getAudioSampleWindow', () => {
    it('preserves samples that begin at or after the requested time', () => {
        expect(getAudioSampleWindow(
            secondsToMicroseconds(2),
            1_024,
            48_000,
            secondsToMicroseconds(1)
        )).toEqual({
            durationMicroseconds: 21_333,
            frameCount: 1_024,
            frameOffset: 0,
            mediaTimeMicroseconds: 2_000_000
        });
    });

    it('trims whole leading frames and never reports time before a seek', () => {
        expect(getAudioSampleWindow(
            secondsToMicroseconds(1),
            1_024,
            48_000,
            secondsToMicroseconds(1.01)
        )).toEqual({
            durationMicroseconds: 11_333,
            frameCount: 544,
            frameOffset: 480,
            mediaTimeMicroseconds: 1_010_000
        });
    });

    it('skips a sample with no complete frame at the requested time', () => {
        expect(getAudioSampleWindow(
            secondsToMicroseconds(1),
            1_024,
            48_000,
            secondsToMicroseconds(1.021333)
        )).toBeNull();
    });

    it('rounds a fractional leading frame toward the future', () => {
        const sampleWindow = getAudioSampleWindow(
            secondsToMicroseconds(0),
            1_024,
            44_100,
            secondsToMicroseconds(0.010001)
        );

        expect(sampleWindow).toMatchObject({
            frameCount: 582,
            frameOffset: 442,
            mediaTimeMicroseconds: 10_023
        });
        expect(sampleWindow?.mediaTimeMicroseconds).toBeGreaterThanOrEqual(10_001);
    });

    it('sample-exactly trims a DTS seek boundary packet', () => {
        expect(getAudioSampleWindow(
            secondsToMicroseconds(1_052.31975),
            512,
            48_000,
            secondsToMicroseconds(1_052.326)
        )).toEqual({
            durationMicroseconds: 4_417,
            frameCount: 212,
            frameOffset: 300,
            mediaTimeMicroseconds: 1_052_326_000
        });
    });
});
