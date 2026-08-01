import type {
    DeviceProfile,
    MediaSourceInfo,
    SubtitleProfile
} from '@jellyfin/sdk/lib/generated-client';

import { isClientHDRToneMappingMediaSource } from './compatibility';

export interface ClientHDRToneMappingPlaybackOptions {
    allowAudioStreamCopy?: boolean | null;
    allowVideoStreamCopy?: boolean | null;
    enableDirectPlay?: boolean | null;
    enableDirectStream?: boolean | null;
}

export interface ClientHDRToneMappingSubtitleProfileOptions {
    alwaysBurnInSubtitleWhenTranscoding: boolean;
    canvas2DSupported: boolean;
    enablePgsRender?: boolean;
    isClientHDRToneMappingPlayback: boolean;
    isRetry?: boolean;
    subtitleBurnInSetting: unknown;
}

const EXTERNAL_BITMAP_SUBTITLE_PROFILES: SubtitleProfile[] = [];
EXTERNAL_BITMAP_SUBTITLE_PROFILES.push(
    {
        Format: 'pgssub',
        Method: 'External'
    },
    {
        Container: 'mks',
        Format: 'vobsub',
        Method: 'External'
    }
);

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

    return options.allowVideoStreamCopy === true;
}

/**
 * Adds client-rendered bitmap subtitle profiles to a confirmed client HDR
 * playback request while preserving explicit subtitle burn-in preferences.
 * The general PGS preference is intentionally bypassed because burn-in would
 * replace the HDR stream-copy path with server video transcoding.
 */
export function configureClientHDRToneMappingSubtitleProfiles(
    deviceProfile: DeviceProfile | null | undefined,
    options: ClientHDRToneMappingSubtitleProfileOptions
): void {
    if (
        !deviceProfile
        || !options.isClientHDRToneMappingPlayback
        || !options.canvas2DSupported
        || options.enablePgsRender === false
        || options.isRetry === true
        || options.alwaysBurnInSubtitleWhenTranscoding
        || !allowsExternalBitmapSubtitles(options.subtitleBurnInSetting)
    ) {
        return;
    }

    const subtitleProfiles = deviceProfile.SubtitleProfiles ?? [];
    deviceProfile.SubtitleProfiles = subtitleProfiles;

    for (const externalProfile of EXTERNAL_BITMAP_SUBTITLE_PROFILES) {
        if (hasEquivalentSubtitleProfile(subtitleProfiles, externalProfile)) {
            continue;
        }

        subtitleProfiles.push({ ...externalProfile });
    }
}

function allowsExternalBitmapSubtitles(subtitleBurnInSetting: unknown): boolean {
    return subtitleBurnInSetting === null
        || subtitleBurnInSetting === undefined
        || subtitleBurnInSetting === '';
}

function hasEquivalentSubtitleProfile(
    subtitleProfiles: readonly SubtitleProfile[],
    candidate: SubtitleProfile
): boolean {
    return subtitleProfiles.some(subtitleProfile => {
        if (
            subtitleProfile.Format?.toLowerCase()
                !== candidate.Format?.toLowerCase()
            || subtitleProfile.Method !== candidate.Method
        ) {
            return false;
        }

        return candidate.Container === undefined
            || candidate.Container === null
            || subtitleProfile.Container?.toLowerCase()
                === candidate.Container.toLowerCase();
    });
}
