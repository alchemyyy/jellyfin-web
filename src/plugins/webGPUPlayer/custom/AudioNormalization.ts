export type AudioNormalizationMode = 'AlbumGain' | 'Off' | 'TrackGain';

type AudioNormalizationItem = {
    NormalizationGain?: unknown
};

type AudioNormalizationMediaSource = {
    albumNormalizationGain?: unknown
};

type AudioNormalizationPlaybackOptions = {
    item?: AudioNormalizationItem
    mediaSource?: AudioNormalizationMediaSource
};

const DECIBELS_PER_POWER_OF_TEN = 20;
const UNITY_GAIN = 1;

function getPlaybackOptions(value: unknown): AudioNormalizationPlaybackOptions | null {
    return value !== null && typeof value === 'object' ?
        value as AudioNormalizationPlaybackOptions :
        null;
}

function getSelectedGainDecibels(
    options: AudioNormalizationPlaybackOptions,
    mode: AudioNormalizationMode
): unknown {
    const trackGain = options.item?.NormalizationGain;
    const albumGain = options.mediaSource?.albumNormalizationGain;
    switch (mode) {
        case 'TrackGain':
            return trackGain ?? albumGain;
        case 'AlbumGain':
            return albumGain ?? trackGain;
        case 'Off':
            return null;
    }
}

function isAudioNormalizationMode(value: unknown): value is AudioNormalizationMode {
    return value === 'AlbumGain' || value === 'Off' || value === 'TrackGain';
}

/** Resolves Jellyfin's selected decibel gain metadata into a linear multiplier. */
export function getAudioNormalizationLinearGain(
    playbackOptions: unknown,
    requestedMode: unknown
): number {
    const options = getPlaybackOptions(playbackOptions);
    if (!options || !isAudioNormalizationMode(requestedMode) || requestedMode === 'Off') {
        return UNITY_GAIN;
    }

    const gainDecibels = getSelectedGainDecibels(options, requestedMode);
    if (typeof gainDecibels !== 'number' || !Number.isFinite(gainDecibels)) {
        return UNITY_GAIN;
    }

    const linearGain = 10 ** (gainDecibels / DECIBELS_PER_POWER_OF_TEN);
    return Number.isFinite(linearGain) && linearGain >= 0 ? linearGain : UNITY_GAIN;
}
