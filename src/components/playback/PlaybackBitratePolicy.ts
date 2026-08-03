export const PLAYBACK_SELECTION_BITRATE_PURPOSE = 'playback-selection';
export const TRANSCODE_OUTPUT_BITRATE_PURPOSE = 'transcode-output';

export type PlaybackBitratePurpose =
    | typeof PLAYBACK_SELECTION_BITRATE_PURPOSE
    | typeof TRANSCODE_OUTPUT_BITRATE_PURPOSE;

export type PlaybackBitrateRequest = {
    fallbackBitrate: number | null | undefined
    purpose: PlaybackBitratePurpose
};

type PlaybackBitratePlayer = {
    getMaxStreamingBitrate?: (
        request?: PlaybackBitrateRequest
    ) => number | null | undefined
};

type PlaybackMediaSourceCandidate = {
    SupportsDirectStream?: boolean
    SupportsTranscoding?: boolean
    enableDirectPlay?: boolean
};

/** Resolves the bitrate value for one explicitly identified use. */
export function getPlayerMaxStreamingBitrate(
    player: PlaybackBitratePlayer | null | undefined,
    fallbackBitrate: number | null | undefined,
    purpose: PlaybackBitratePurpose = PLAYBACK_SELECTION_BITRATE_PURPOSE
): number | null | undefined {
    if (!player?.getMaxStreamingBitrate) {
        return fallbackBitrate;
    }
    return player.getMaxStreamingBitrate({
        fallbackBitrate,
        purpose
    });
}

/** Returns true only after bitrate-free selection has fixed a transcode. */
export function shouldUsePostSelectionTranscodeBitrate(
    selectionBitrate: number | null | undefined,
    transcodingBitrate: number | null | undefined,
    mediaSource: PlaybackMediaSourceCandidate
): boolean {
    if (selectionBitrate != null) {
        return false;
    }
    if (
        typeof transcodingBitrate !== 'number'
        || !Number.isFinite(transcodingBitrate)
        || transcodingBitrate <= 0
    ) {
        return false;
    }
    return !mediaSource.enableDirectPlay
        && !mediaSource.SupportsDirectStream
        && Boolean(mediaSource.SupportsTranscoding);
}
