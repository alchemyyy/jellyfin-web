/** Marks a player request that was invalidated before playback could start. */
export const PLAYBACK_SUPERSEDED = Symbol('PLAYBACK_SUPERSEDED');

/** Returns whether a player result represents an invalidated playback request. */
export function isPlaybackSuperseded(result: unknown): boolean {
    return result === PLAYBACK_SUPERSEDED;
}
