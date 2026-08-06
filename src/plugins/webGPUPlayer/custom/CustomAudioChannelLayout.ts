import {
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    type CustomAudioDownmixAlgorithm
} from './CustomAudioDownmixAlgorithm';
import {
    downmixFivePointOneToStereo,
    downmixSixPointOneToStereo,
    downmixSevenPointOneToStereo
} from './CustomAudioDownmix';

export const CUSTOM_MONO_INPUT_CHANNEL_COUNT = 1;
export const CUSTOM_STEREO_INPUT_CHANNEL_COUNT = 2;
export const CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT = 6;
export const CUSTOM_SIX_POINT_ONE_INPUT_CHANNEL_COUNT = 7;
export const CUSTOM_SEVEN_POINT_ONE_INPUT_CHANNEL_COUNT = 8;
export const CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT = 2;
export const CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT = 6;
export const CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT = 8;

export type CustomAudioOutputChannelCount =
    | typeof CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT
    | typeof CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT
    | typeof CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT;

export type CustomAudioChannel =
    | 'front-center'
    | 'front-left'
    | 'front-right'
    | 'back-left'
    | 'back-right'
    | 'back-center'
    | 'low-frequency-effects'
    | 'side-left'
    | 'side-right';

export type CustomAudioChannelLayout = {
    channels: readonly CustomAudioChannel[]
    id: '5.1-back' | '5.1-side' | '6.1' | '7.1' | 'mono' | 'stereo'
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

export const CUSTOM_FIVE_POINT_ONE_BACK_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'back-left',
        'back-right'
    ] as const),
    id: '5.1-back'
});

export const CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'back-left',
        'back-right',
        'side-left',
        'side-right'
    ] as const),
    id: '7.1'
});

export const CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT: CustomAudioChannelLayout = Object.freeze({
    channels: Object.freeze([
        'front-left',
        'front-right',
        'front-center',
        'low-frequency-effects',
        'back-center',
        'side-left',
        'side-right'
    ] as const),
    id: '6.1'
});

export type StereoChannelData = [ Float32Array, Float32Array ];
export type CustomAudioOutputChannelData = readonly Float32Array[];

/** Reports whether destination constraints require selectable 5.1/7.1 mixing. */
export function isSelectableCustomAudioDownmixRequired(
    layout: CustomAudioChannelLayout,
    outputChannelCount: CustomAudioOutputChannelCount
): boolean {
    if (outputChannelCount !== CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT) {
        return false;
    }
    switch (layout.id) {
        case '5.1-back':
        case '5.1-side':
        case '7.1':
            return true;
        case '6.1':
        case 'mono':
        case 'stereo':
            return false;
    }
}

/** Rejects incomplete multichannel speaker beds and unsupported layout conversion. */
export function assertCustomAudioOutputChannelLayout(
    layout: CustomAudioChannelLayout,
    outputChannelCount: CustomAudioOutputChannelCount
): void {
    switch (outputChannelCount) {
        case CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT:
            return;
        case CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT:
            if (layout.id === '5.1-back' || layout.id === '5.1-side') {
                return;
            }
            throw new RangeError('Native 5.1 output requires a 5.1 input layout');
        case CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT:
            if (layout.id === '7.1') {
                return;
            }
            throw new RangeError('Native 7.1 output requires a 7.1 input layout');
    }
}

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
        case CUSTOM_SIX_POINT_ONE_INPUT_CHANNEL_COUNT:
            return CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT;
        case CUSTOM_SEVEN_POINT_ONE_INPUT_CHANNEL_COUNT:
            return CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT;
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
    layout: CustomAudioChannelLayout,
    downmixAlgorithm: CustomAudioDownmixAlgorithm =
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
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
        case '5.1-back':
        case '5.1-side':
            return downmixFivePointOneToStereo(channelData, downmixAlgorithm);
        case '6.1':
            return downmixSixPointOneToStereo(channelData);
        case '7.1':
            return downmixSevenPointOneToStereo(channelData, downmixAlgorithm);
    }
}

/** Preserves a complete speaker bed or applies the qualified stereo fallback. */
export function prepareCustomAudioOutputChannelData(
    channelData: readonly Float32Array[],
    layout: CustomAudioChannelLayout,
    outputChannelCount: CustomAudioOutputChannelCount,
    downmixAlgorithm: CustomAudioDownmixAlgorithm =
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
): CustomAudioOutputChannelData {
    assertCustomAudioOutputChannelLayout(layout, outputChannelCount);
    switch (outputChannelCount) {
        case CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT:
            return mixCustomAudioToStereo(channelData, layout, downmixAlgorithm);
        case CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT:
        case CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT:
            requireLayoutChannelData(channelData, layout);
            return channelData;
    }
}
