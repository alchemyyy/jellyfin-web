import { describe, expect, it } from 'vitest';

import {
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK,
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_STEREO,
    getQualifiedCustomWaveChannelLayout
} from './CustomWaveChannelLayout';

describe('getQualifiedCustomWaveChannelLayout', () => {
    it.each([
        [ CUSTOM_WAVE_CHANNEL_MASK_STEREO, 2, 'stereo' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK, 6, '5.1-back' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE, 6, '5.1-side' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_SIX_POINT_ONE, 7, '6.1' ],
        [ CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE, 8, '7.1' ]
    ] as const)(
        'maps exact mask %# to %s',
        (channelMask, channelCount, layoutID) => {
            const result = getQualifiedCustomWaveChannelLayout(channelMask);

            expect(result?.channelCount).toBe(channelCount);
            expect(result?.layout.id).toBe(layoutID);
        }
    );

    it.each([ 0, -1, 0x0007, 0x003f | 0x0800, 1.5, Number.NaN ])(
        'rejects ambiguous or unsupported mask %s',
        channelMask => {
            expect(getQualifiedCustomWaveChannelLayout(channelMask)).toBeNull();
        }
    );
});
