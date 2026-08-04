import type { Microseconds } from '../MediaTime';

/** Validates a value at a custom playback microsecond boundary. */
export function requireMicroseconds(value: number, label = 'Media time'): Microseconds {
    if (!Number.isSafeInteger(value)) {
        throw new RangeError(`${label} must be a safe integer number of microseconds`);
    }

    return value as Microseconds;
}

/** Adds two microsecond values without leaving the safe integer range. */
export function addMicroseconds(left: Microseconds, right: Microseconds): Microseconds {
    return requireMicroseconds(left + right);
}

/** Converts an integral audio frame count to signed integer microseconds. */
export function audioFramesToMicroseconds(frameCount: number, sampleRate: number): Microseconds {
    if (!Number.isSafeInteger(frameCount)) {
        throw new RangeError('Audio frame count must be a safe integer');
    }

    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
        throw new RangeError('Audio sample rate must be a positive safe integer');
    }

    return requireMicroseconds(Math.round((frameCount * 1_000_000) / sampleRate));
}
