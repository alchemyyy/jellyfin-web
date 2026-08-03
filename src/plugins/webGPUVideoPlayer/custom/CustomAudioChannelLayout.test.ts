import { describe, expect, it } from 'vitest';

import {
    SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN,
    SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN
} from './CustomAudioDownmix';
import {
    CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_MONO_CHANNEL_LAYOUT,
    CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_STEREO_CHANNEL_LAYOUT,
    getCustomAudioChannelLayout,
    mixCustomAudioToStereo
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
            (Math.SQRT2 - 1) + 3 * (1 - Math.SQRT2 / 2)
                + 5 * (1 - Math.SQRT2 / 2),
            6
        );
        expect(output[1][0]).toBeCloseTo(
            2 * (Math.SQRT2 - 1) + 3 * (1 - Math.SQRT2 / 2)
                + 6 * (1 - Math.SQRT2 / 2),
            6
        );
        expect(() => mixCustomAudioToStereo(
            channels.slice(0, 2),
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT
        )).toThrow('5.1-side audio requires exactly 6 input channels');
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
});
