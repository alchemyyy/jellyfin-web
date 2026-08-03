// Match Chromium's decoder floor and the player's qualified resampler ceiling
export const MINIMUM_CUSTOM_AUDIO_SAMPLE_RATE = 3_000;
export const MAXIMUM_CUSTOM_AUDIO_SAMPLE_RATE = 192_000;

/** Accepts every integer source rate inside the bounded PCM/resampler envelope. */
export function isSupportedCustomAudioSampleRate(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= MINIMUM_CUSTOM_AUDIO_SAMPLE_RATE
        && value <= MAXIMUM_CUSTOM_AUDIO_SAMPLE_RATE;
}

/** Returns a bounded source rate or rejects malformed decoder/container metadata. */
export function requireSupportedCustomAudioSampleRate(
    value: unknown,
    label: string
): number {
    if (!isSupportedCustomAudioSampleRate(value)) {
        throw new RangeError(
            `${label} must be between ${MINIMUM_CUSTOM_AUDIO_SAMPLE_RATE} and `
            + `${MAXIMUM_CUSTOM_AUDIO_SAMPLE_RATE} Hz`
        );
    }
    return value;
}
