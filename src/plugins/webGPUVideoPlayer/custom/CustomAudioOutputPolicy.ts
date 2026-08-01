export const CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT = 2;
export const CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE = 48_000;
export const CUSTOM_AUDIO_OUTPUT_CHANNEL_INTERPRETATION = 'speakers' as const;

/**
 * Accepts only the stereo, 48 kHz layout covered by the decoder capability
 * probe. Wider layouts need codec-specific channel mapping before playback.
 */
export function isSupportedCustomAudioOutputLayout(
    channelCount: unknown,
    sampleRate: unknown
): boolean {
    return channelCount === CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT
        && sampleRate === CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE;
}

/** Rejects decoded output that exceeds the measured audio presentation route. */
export function assertSupportedCustomAudioOutputLayout(
    channelCount: unknown,
    sampleRate: unknown
): void {
    if (!isSupportedCustomAudioOutputLayout(channelCount, sampleRate)) {
        throw new RangeError(
            `Custom audio output requires ${CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT} channels at `
            + `${CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE} Hz`
        );
    }
}
