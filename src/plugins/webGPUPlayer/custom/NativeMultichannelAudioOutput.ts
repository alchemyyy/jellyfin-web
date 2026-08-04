import {
    CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT,
    CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT,
    CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT,
    type CustomAudioOutputChannelCount
} from './CustomAudioChannelLayout';

function getMaximumDestinationChannelCount(audioContext: AudioContext): number {
    try {
        const maximumChannelCount = audioContext.destination.maxChannelCount;
        return Number.isSafeInteger(maximumChannelCount) && maximumChannelCount > 0 ?
            maximumChannelCount :
            CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
    } catch {
        return CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
    }
}

/**
 * Selects native speaker output only when the current AudioContext destination
 * reports enough physical channels for the complete source layout.
 */
export function selectCustomAudioOutputChannelCount(
    audioContext: AudioContext | null,
    sourceChannelCount: number | null
): CustomAudioOutputChannelCount {
    if (!audioContext) {
        return CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
    }

    const maximumChannelCount = getMaximumDestinationChannelCount(audioContext);
    switch (sourceChannelCount) {
        case CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT:
            return maximumChannelCount >= CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT ?
                CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT :
                CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
        case CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT:
            return maximumChannelCount >= CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT ?
                CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT :
                CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
        default:
            return CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
    }
}

/** Configures and verifies the exact hardware-facing AudioContext channel count. */
export function configureCustomAudioDestination(
    audioContext: AudioContext,
    outputChannelCount: CustomAudioOutputChannelCount
): void {
    const maximumChannelCount = getMaximumDestinationChannelCount(audioContext);
    if (outputChannelCount > maximumChannelCount) {
        throw new RangeError(
            `Audio destination exposes ${maximumChannelCount} channels, not ${outputChannelCount}`
        );
    }

    audioContext.destination.channelCount = outputChannelCount;
    if (audioContext.destination.channelCount !== outputChannelCount) {
        throw new Error('The browser did not apply the requested audio destination channel count');
    }
}
