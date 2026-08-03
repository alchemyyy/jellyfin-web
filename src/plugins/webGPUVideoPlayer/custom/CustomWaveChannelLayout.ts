import {
    CUSTOM_FIVE_POINT_ONE_BACK_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_STEREO_CHANNEL_LAYOUT,
    type CustomAudioChannelLayout
} from './CustomAudioChannelLayout';

export const CUSTOM_WAVE_CHANNEL_MASK_STEREO = 0x0003;
export const CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK = 0x003f;
export const CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE = 0x060f;
export const CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE = 0x070f;
export const CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE = 0x063f;

export type QualifiedCustomWaveChannelLayout = Readonly<{
    channelCount: 2 | 6 | 7 | 8
    layout: CustomAudioChannelLayout
}>;

const CUSTOM_WAVE_CHANNEL_LAYOUTS = new Map<
    number,
    QualifiedCustomWaveChannelLayout
>([
    [
        CUSTOM_WAVE_CHANNEL_MASK_STEREO,
        { channelCount: 2, layout: CUSTOM_STEREO_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK,
        { channelCount: 6, layout: CUSTOM_FIVE_POINT_ONE_BACK_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
        { channelCount: 6, layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE,
        { channelCount: 7, layout: CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT }
    ],
    [
        CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
        { channelCount: 8, layout: CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT }
    ]
]);

/** Maps only exact native/WAVE masks covered by the shared PCM pipeline. */
export function getQualifiedCustomWaveChannelLayout(
    channelMask: number
): QualifiedCustomWaveChannelLayout | null {
    if (!Number.isSafeInteger(channelMask) || channelMask <= 0) {
        return null;
    }
    return CUSTOM_WAVE_CHANNEL_LAYOUTS.get(channelMask) ?? null;
}
