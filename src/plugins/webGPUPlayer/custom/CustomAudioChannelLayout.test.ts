import { describe, expect, it } from 'vitest';

import {
    FIVE_POINT_ONE_DIRECT_CHANNEL_GAIN,
    FIVE_POINT_ONE_MIXED_CHANNEL_GAIN,
    SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN,
    SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN
} from './CustomAudioDownmix';
import { CUSTOM_AUDIO_DOWNMIX_ALGORITHMS } from './CustomAudioDownmixAlgorithm';
import {
    CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_MONO_CHANNEL_LAYOUT,
    CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_STEREO_CHANNEL_LAYOUT,
    getCustomAudioChannelLayout,
    isSelectableCustomAudioDownmixRequired,
    mixCustomAudioToStereo,
    prepareCustomAudioOutputChannelData
} from './CustomAudioChannelLayout';

describe('CustomAudioChannelLayout', () => {
    it('maps only layouts with an implemented matrix', () => {
        expect(getCustomAudioChannelLayout(1)).toBe(CUSTOM_MONO_CHANNEL_LAYOUT);
        expect(getCustomAudioChannelLayout(2)).toBe(CUSTOM_STEREO_CHANNEL_LAYOUT);
        expect(getCustomAudioChannelLayout(6)).toBe(CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT);
        expect(getCustomAudioChannelLayout(7)).toBe(CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT);
        expect(getCustomAudioChannelLayout(8)).toBe(CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT);
        expect(getCustomAudioChannelLayout(0)).toBeNull();
    });

    it('uses the shared 6.1 matrix in explicit WAVE channel order', () => {
        const channels: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < 7; channelIndex += 1) {
            channels.push(new Float32Array([ channelIndex + 1 ]));
        }

        const output = mixCustomAudioToStereo(
            channels,
            CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT
        );
        const directGain = 1 / (1 + 3 / Math.SQRT2);
        const mixedGain = directGain / Math.SQRT2;
        expect(output[0][0]).toBeCloseTo(
            1 * directGain + (3 + 5 + 6) * mixedGain,
            6
        );
        expect(output[1][0]).toBeCloseTo(
            2 * directGain + (3 + 5 + 7) * mixedGain,
            6
        );
    });

    it('duplicates mono without changing its level', () => {
        const mono = new Float32Array([ -1, -0.25, 0.5, 1 ]);
        const output = mixCustomAudioToStereo([ mono ], CUSTOM_MONO_CHANNEL_LAYOUT);

        expect(output[0]).toEqual(mono);
        expect(output[1]).toEqual(mono);
        expect(output[0]).not.toBe(mono);
        expect(output[1]).not.toBe(mono);
    });

    it('keeps stereo buffers without another copy', () => {
        const left = new Float32Array([ 0.25, 0.5 ]);
        const right = new Float32Array([ -0.25, -0.5 ]);
        const output = mixCustomAudioToStereo(
            [ left, right ],
            CUSTOM_STEREO_CHANNEL_LAYOUT
        );

        expect(output).toEqual([ left, right ]);
        expect(output[0]).toBe(left);
        expect(output[1]).toBe(right);
    });

    it('uses the shared 5.1 matrix and validates the declared layout', () => {
        const channels: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < 6; channelIndex += 1) {
            channels.push(new Float32Array([ channelIndex + 1 ]));
        }

        const output = mixCustomAudioToStereo(
            channels,
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT
        );
        expect(output[0][0]).toBeCloseTo(
            FIVE_POINT_ONE_DIRECT_CHANNEL_GAIN
                + 3 * FIVE_POINT_ONE_MIXED_CHANNEL_GAIN
                + 5 * FIVE_POINT_ONE_MIXED_CHANNEL_GAIN,
            6
        );
        expect(output[1][0]).toBeCloseTo(
            2 * FIVE_POINT_ONE_DIRECT_CHANNEL_GAIN
                + 3 * FIVE_POINT_ONE_MIXED_CHANNEL_GAIN
                + 6 * FIVE_POINT_ONE_MIXED_CHANNEL_GAIN,
            6
        );
        expect(() => mixCustomAudioToStereo(
            channels.slice(0, 2),
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT
        )).toThrow('5.1-side audio requires exactly 6 input channels');
    });

    it('selects 5.1 and 7.1 matrices only for required stereo fallback', () => {
        expect(isSelectableCustomAudioDownmixRequired(
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
            2
        )).toBe(true);
        expect(isSelectableCustomAudioDownmixRequired(
            CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
            2
        )).toBe(true);
        expect(isSelectableCustomAudioDownmixRequired(
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
            6
        )).toBe(false);
        expect(isSelectableCustomAudioDownmixRequired(
            CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
            8
        )).toBe(false);
        expect(isSelectableCustomAudioDownmixRequired(
            CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT,
            2
        )).toBe(false);
        expect(isSelectableCustomAudioDownmixRequired(
            CUSTOM_STEREO_CHANNEL_LAYOUT,
            2
        )).toBe(false);
    });

    it('applies the selected matrix only when stereo conversion is required', () => {
        const channels = [ 1, 2, 3, 4, 5, 6 ].map(value => (
            new Float32Array([ value ])
        ));

        const stereoOutput = prepareCustomAudioOutputChannelData(
            channels,
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
            2,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue
        );
        const nativeOutput = prepareCustomAudioOutputChannelData(
            channels,
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
            6,
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue
        );

        expect(stereoOutput[0][0]).toBeCloseTo(1 * 0.3 + 3 + 5 * 0.3, 6);
        expect(stereoOutput[1][0]).toBeCloseTo(2 * 0.3 + 3 + 6 * 0.3, 6);
        expect(nativeOutput).toBe(channels);
    });

    it('uses the shared 7.1 matrix in explicit WAVE channel order', () => {
        const channels: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < 8; channelIndex += 1) {
            channels.push(new Float32Array([ channelIndex + 1 ]));
        }

        const output = mixCustomAudioToStereo(
            channels,
            CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT
        );
        const directGain = SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN;
        const mixedGain = SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN;
        expect(output[0][0]).toBeCloseTo(
            1 * directGain + (3 + 5 + 7) * mixedGain,
            6
        );
        expect(output[1][0]).toBeCloseTo(
            2 * directGain + (3 + 6 + 8) * mixedGain,
            6
        );
        expect(() => mixCustomAudioToStereo(
            channels.slice(0, 6),
            CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT
        )).toThrow('7.1 audio requires exactly 8 input channels');
    });

    it.each([
        { channelCount: 6 as const, layout: CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT },
        { channelCount: 8 as const, layout: CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT }
    ])('preserves exact $channelCount-channel speaker data without another copy', ({
        channelCount,
        layout
    }) => {
        const channels: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
            channels.push(new Float32Array([ channelIndex + 1 ]));
        }

        const output = prepareCustomAudioOutputChannelData(
            channels,
            layout,
            channelCount
        );

        expect(output).toBe(channels);
    });

    it('rejects an output count that does not represent the complete source layout', () => {
        const fivePointOneChannels = Array.from(
            { length: 6 },
            (): Float32Array => new Float32Array(1)
        );
        const sevenPointOneChannels = Array.from(
            { length: 8 },
            (): Float32Array => new Float32Array(1)
        );

        expect(() => prepareCustomAudioOutputChannelData(
            fivePointOneChannels,
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
            8
        )).toThrow('Native 7.1 output requires a 7.1 input layout');
        expect(() => prepareCustomAudioOutputChannelData(
            sevenPointOneChannels,
            CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
            6
        )).toThrow('Native 5.1 output requires a 5.1 input layout');
    });
});
