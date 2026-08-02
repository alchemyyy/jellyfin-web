import type { CustomAudioCodec } from './CustomDecodeCapabilities';

export const CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT = 2;
export const CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE = 48_000;
export const CUSTOM_AUDIO_OUTPUT_CHANNEL_INTERPRETATION = 'speakers' as const;
export const CUSTOM_AC3_SURROUND_INPUT_CHANNEL_COUNT = 6;
export const CUSTOM_STEREO_INPUT_CHANNEL_COUNT = 2;

const CUSTOM_STEREO_INPUT_CHANNEL_COUNTS: readonly number[] = [
    CUSTOM_STEREO_INPUT_CHANNEL_COUNT
];
const CUSTOM_AC3_INPUT_CHANNEL_COUNTS: readonly number[] = [
    CUSTOM_STEREO_INPUT_CHANNEL_COUNT,
    CUSTOM_AC3_SURROUND_INPUT_CHANNEL_COUNT
];

/** Returns the source layouts covered by the codec's decoded PCM route. */
export function getSupportedCustomAudioInputChannelCounts(
    codec: CustomAudioCodec
): readonly number[] {
    switch (codec) {
        case 'ac3':
        case 'eac3':
            return CUSTOM_AC3_INPUT_CHANNEL_COUNTS;
        case 'aac':
        case 'flac':
        case 'mp3':
        case 'opus':
        case 'vorbis':
            return CUSTOM_STEREO_INPUT_CHANNEL_COUNTS;
    }
}

/** Accepts source layouts with a complete decoded PCM presentation path. */
export function isSupportedCustomAudioInputLayout(
    codec: string,
    channelCount: unknown,
    sampleRate: unknown
): boolean {
    if (sampleRate !== CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE
        || typeof channelCount !== 'number') {
        return false;
    }

    switch (codec) {
        case 'ac3':
        case 'eac3':
            return CUSTOM_AC3_INPUT_CHANNEL_COUNTS.includes(channelCount);
        case 'aac':
        case 'flac':
        case 'mp3':
        case 'opus':
        case 'vorbis':
            return CUSTOM_STEREO_INPUT_CHANNEL_COUNTS.includes(channelCount);
        default:
            return false;
    }
}

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
