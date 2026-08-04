/** Returns a track by its zero-based ordinal within one media type. */
export function getTrackByOrdinal<Track>(
    tracks: readonly Track[],
    trackOrdinal: number
): Track | null {
    if (!Number.isSafeInteger(trackOrdinal) || trackOrdinal < 0) {
        return null;
    }

    return tracks[trackOrdinal] ?? null;
}
