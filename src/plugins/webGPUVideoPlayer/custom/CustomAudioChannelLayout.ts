import { downmixFivePointOneToStereo } from './CustomAudioDownmix';

export const CUSTOM_MONO_INPUT_CHANNEL_COUNT = 1;
export const CUSTOM_STEREO_INPUT_CHANNEL_COUNT = 2;
export const CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT = 6;

export type CustomAudioChannel =
    | 'front-center'
    | 'front-left'
    | 'front-right'
    | 'low-frequency-effects'
    | 'side-left'
    | 'side-right';

export type CustomAudioChannelLayout = {
    channels: readonly CustomAudioChannel[]
    id: '5.1-side' | 'mono' | 'stereo'
};

export const CUSTOM_MONO_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([ 'front-center' ] as const),
    id: 'mono'
});

export const CUSTOM_STEREO_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([ 'front-left', 'front-right' ] as const),
    id: 'stereo'
});

export const CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'side-left',
        'side-right'
    ] as const),
    id: '5.1-side'
});

export type StereoChannelData = [ Float32Array, Float32Array ];

/** Maps only layouts with an explicit, implemented stereo presentation matrix. */
export function getCustomAudioChannelLayout(
    channelCount: number
): CustomAudioChannelLayout | null {
    switch (channelCount) {
        case CUSTOM_MONO_INPUT_CHANNEL_COUNT:
            return CUSTOM_MONO_CHANNEL_LAYOUT;
        case CUSTOM_STEREO_INPUT_CHANNEL_COUNT:
            return CUSTOM_STEREO_CHANNEL_LAYOUT;
        case CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT:
            return CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT;
        default:
            return null;
    }
}

function requireLayoutChannelData(
    channelData: readonly Float32Array[],
    layout: CustomAudioChannelLayout
): number {
    if (channelData.length !== layout.channels.length) {
        throw new RangeError(
            `${layout.id} audio requires exactly ${layout.channels.length} input channels`
        );
    }
    const frameCount = channelData[0]?.length ?? 0;
    if (frameCount <= 0) {
        throw new RangeError('Audio channel data must contain at least one frame');
    }
    for (const channel of channelData) {
        if (channel.length !== frameCount) {
            throw new RangeError('Audio channel data must have equal frame counts');
        }
    }
    return frameCount;
}

/** Applies the one shared channel-layout policy before decoded PCM output. */
export function mixCustomAudioToStereo(
    channelData: readonly Float32Array[],
    layout: CustomAudioChannelLayout
): StereoChannelData {
    const frameCount = requireLayoutChannelData(channelData, layout);
    switch (layout.id) {
        case 'mono': {
            const mono = channelData[0];
            const left = new Float32Array(frameCount);
            const right = new Float32Array(frameCount);
            left.set(mono);
            right.set(mono);
            return [ left, right ];
        }
        case 'stereo':
            return [ channelData[0], channelData[1] ];
        case '5.1-side':
            return downmixFivePointOneToStereo(channelData);
    }
}
