export enum VideoPlayerPreference {
    Auto = 'auto',
    HTML = 'html',
    WEBGPU = 'webgpu'
}

type PlayerIdentity = {
    id?: unknown
};

const HTML_VIDEO_PLAYER_ID = 'htmlvideoplayer';
const WEBGPU_VIDEO_PLAYER_ID = 'webgpuvideoplayer';

/** Converts persisted or external values to a supported player preference. */
export function normalizeVideoPlayerPreference(value: unknown): VideoPlayerPreference {
    switch (value) {
        case VideoPlayerPreference.HTML:
            return VideoPlayerPreference.HTML;
        case VideoPlayerPreference.WEBGPU:
            return VideoPlayerPreference.WEBGPU;
        case VideoPlayerPreference.Auto:
        default:
            return VideoPlayerPreference.Auto;
    }
}

/** Moves the selected local video player first without removing fallbacks. */
export function orderVideoPlayersByPreference<Player extends PlayerIdentity>(
    players: readonly Player[],
    mediaType: unknown,
    preferenceValue: unknown
): Player[] {
    const preference = normalizeVideoPlayerPreference(preferenceValue);
    if (mediaType !== 'Video' || preference === VideoPlayerPreference.Auto) {
        return [ ...players ];
    }

    const preferredPlayerID = preference === VideoPlayerPreference.HTML ?
        HTML_VIDEO_PLAYER_ID :
        WEBGPU_VIDEO_PLAYER_ID;
    const preferredPlayers: Player[] = [];
    const remainingPlayers: Player[] = [];
    for (const player of players) {
        if (player.id === preferredPlayerID) {
            preferredPlayers.push(player);
        } else {
            remainingPlayers.push(player);
        }
    }
    preferredPlayers.push(...remainingPlayers);
    return preferredPlayers;
}
