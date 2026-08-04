import {
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_STEREO,
    getQualifiedCustomWaveChannelLayout,
    type QualifiedCustomWaveChannelLayout
} from './CustomWaveChannelLayout';

export const DTS_WAVE_CHANNEL_MASK_STEREO = CUSTOM_WAVE_CHANNEL_MASK_STEREO;
export const DTS_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK =
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK;
export const DTS_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE =
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE;
export const DTS_WAVE_CHANNEL_MASK_SIX_POINT_ONE =
    CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE;
export const DTS_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE =
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE;

/** Maps only exact WAVEFORMATEXTENSIBLE layouts covered by the PCM pipeline. */
export function getQualifiedDTSChannelLayout(
    channelMask: number
): QualifiedCustomWaveChannelLayout | null {
    return getQualifiedCustomWaveChannelLayout(channelMask);
}
