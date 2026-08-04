/** Selects an established clock or the initial resume point for playback retry. */
export function getPlaybackRecoveryStartTimeTicks(
    currentPositionTicks: unknown,
    initialPositionTicks: number | null | undefined,
    playbackStarted: boolean
): number | null | undefined {
    if (
        typeof currentPositionTicks === 'number'
        && Number.isFinite(currentPositionTicks)
        && currentPositionTicks >= 0
        && (currentPositionTicks > 0 || playbackStarted)
    ) {
        return currentPositionTicks;
    }

    return initialPositionTicks;
}
