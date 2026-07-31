import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client';

import { isClientHDRToneMappingMediaSource } from './compatibility';

export interface ClientHDRToneMappingPlaybackOptions {
    allowAudioStreamCopy?: boolean | null;
    allowVideoStreamCopy?: boolean | null;
    enableDirectPlay?: boolean | null;
    enableDirectStream?: boolean | null;
}

/**
 * Forces compatible local playback through complete fMP4 HLS fragments.
 * Explicit stream-copy rejection from playback recovery is preserved.
 */
export function configureClientHDRToneMappingPlaybackOptions(
    options: ClientHDRToneMappingPlaybackOptions,
    isLocalPlayer: boolean,
    enabled: boolean,
    runtimeAvailable: boolean,
    mediaSource: MediaSourceInfo | null | undefined
): boolean {
    if (
        !isLocalPlayer
        || !enabled
        || !runtimeAvailable
        || !isClientHDRToneMappingMediaSource(mediaSource)
    ) {
        return false;
    }

    options.enableDirectPlay = false;
    options.enableDirectStream = false;
    options.allowVideoStreamCopy = options.allowVideoStreamCopy !== false;
    options.allowAudioStreamCopy = options.allowAudioStreamCopy !== false;

    return true;
}
