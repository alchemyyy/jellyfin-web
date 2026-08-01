import type { Microseconds } from '../MediaTime';
import { addMicroseconds, audioFramesToMicroseconds, requireMicroseconds } from './TimeMath';

const MICROSECONDS_PER_SECOND = 1_000_000;

export type AudioSampleWindow = {
    durationMicroseconds: Microseconds
    frameCount: number
    frameOffset: number
    mediaTimeMicroseconds: Microseconds
};

/**
 * Selects whole PCM frames at or after a seek boundary so decoded audio never
 * moves the flushed AudioWorklet clock backwards.
 */
export function getAudioSampleWindow(
    sampleTimeMicroseconds: Microseconds,
    sampleFrameCount: number,
    sampleRate: number,
    startTimeMicroseconds: Microseconds
): AudioSampleWindow | null {
    requireMicroseconds(sampleTimeMicroseconds, 'Decoded audio sample time');
    requireMicroseconds(startTimeMicroseconds, 'Decoded audio start time');
    if (!Number.isSafeInteger(sampleFrameCount) || sampleFrameCount <= 0) {
        throw new RangeError('Decoded audio frame count must be a positive safe integer');
    }
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
        throw new RangeError('Decoded audio sample rate must be a positive safe integer');
    }

    let frameOffset = 0;
    if (sampleTimeMicroseconds < startTimeMicroseconds) {
        const leadingDurationMicroseconds = requireMicroseconds(
            startTimeMicroseconds - sampleTimeMicroseconds,
            'Decoded audio leading duration'
        );
        const maximumSampleDurationMicroseconds = Math.ceil(
            (sampleFrameCount * MICROSECONDS_PER_SECOND) / sampleRate
        );
        if (leadingDurationMicroseconds >= maximumSampleDurationMicroseconds) {
            return null;
        }

        frameOffset = Math.ceil(
            (leadingDurationMicroseconds * sampleRate) / MICROSECONDS_PER_SECOND
        );
        if (frameOffset >= sampleFrameCount) {
            return null;
        }
    }

    const frameCount = sampleFrameCount - frameOffset;
    const calculatedMediaTimeMicroseconds = addMicroseconds(
        sampleTimeMicroseconds,
        audioFramesToMicroseconds(frameOffset, sampleRate)
    );
    return {
        durationMicroseconds: audioFramesToMicroseconds(frameCount, sampleRate),
        frameCount,
        frameOffset,
        mediaTimeMicroseconds: requireMicroseconds(Math.max(
            calculatedMediaTimeMicroseconds,
            startTimeMicroseconds
        ))
    };
}
