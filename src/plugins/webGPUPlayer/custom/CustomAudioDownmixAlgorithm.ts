export const CUSTOM_AUDIO_DOWNMIX_ALGORITHMS = Object.freeze({
    AC4: 'ac-4',
    Dave750: 'dave750',
    NightModeDialogue: 'night-mode-dialogue',
    PeakNormalizedLORO: 'peak-normalized-lo-ro',
    RFC7845: 'rfc-7845',
    StandardLORO: 'standard-lo-ro'
} as const);

export type CustomAudioDownmixAlgorithm =
    typeof CUSTOM_AUDIO_DOWNMIX_ALGORITHMS[
        keyof typeof CUSTOM_AUDIO_DOWNMIX_ALGORITHMS
    ];

export const DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM =
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO;

/** Rejects unknown persisted or cross-thread downmix algorithm values. */
export function isCustomAudioDownmixAlgorithm(
    value: unknown
): value is CustomAudioDownmixAlgorithm {
    switch (value) {
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4:
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750:
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue:
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO:
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845:
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO:
            return true;
        default:
            return false;
    }
}

/** Falls back to the standard full-gain matrix for invalid stored settings. */
export function normalizeCustomAudioDownmixAlgorithm(
    value: unknown
): CustomAudioDownmixAlgorithm {
    return isCustomAudioDownmixAlgorithm(value) ?
        value :
        DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM;
}

/** Reports whether a matrix needs dynamic overload protection. */
export function customAudioDownmixAlgorithmUsesLimiter(
    algorithm: CustomAudioDownmixAlgorithm
): boolean {
    return algorithm !== CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO;
}
