export const MICROSECONDS_PER_MILLISECOND = 1_000;
export const MICROSECONDS_PER_SECOND = 1_000_000;

declare const MICROSECONDS_BRAND: unique symbol;
export type Microseconds = number & { readonly [MICROSECONDS_BRAND]: true };

function toIntegerMicroseconds(value: number): Microseconds {
    if (!Number.isFinite(value)) {
        throw new RangeError('Media time must be finite');
    }

    const microseconds = Math.round(value);
    if (!Number.isSafeInteger(microseconds)) {
        throw new RangeError('Media time exceeds the safe integer range');
    }

    return microseconds as Microseconds;
}

/** Converts HTML media seconds to signed integer microseconds. */
export function secondsToMicroseconds(seconds: number): Microseconds {
    return toIntegerMicroseconds(seconds * MICROSECONDS_PER_SECOND);
}

/** Converts Jellyfin-facing milliseconds to signed integer microseconds. */
export function millisecondsToMicroseconds(milliseconds: number): Microseconds {
    return toIntegerMicroseconds(milliseconds * MICROSECONDS_PER_MILLISECOND);
}

/** Converts signed integer microseconds to an HTML media seconds boundary. */
export function microsecondsToSeconds(microseconds: Microseconds): number {
    return microseconds / MICROSECONDS_PER_SECOND;
}

/** Converts signed integer microseconds to a Jellyfin milliseconds boundary. */
export function microsecondsToMilliseconds(microseconds: Microseconds): number {
    return microseconds / MICROSECONDS_PER_MILLISECOND;
}
