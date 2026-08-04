import { describe, expect, it } from 'vitest';

import {
    CUSTOM_FIVE_POINT_ONE_BACK_CHANNEL_LAYOUT,
    CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_STEREO_CHANNEL_LAYOUT
} from './CustomAudioChannelLayout';
import {
    DTS_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK,
    DTS_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
    DTS_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    DTS_WAVE_CHANNEL_MASK_SIX_POINT_ONE,
    DTS_WAVE_CHANNEL_MASK_STEREO,
    getQualifiedDTSChannelLayout
} from './DTSChannelLayout';

describe('getQualifiedDTSChannelLayout', () => {
    it.each([
        [ DTS_WAVE_CHANNEL_MASK_STEREO, 2, CUSTOM_STEREO_CHANNEL_LAYOUT ],
        [ DTS_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_BACK, 6, CUSTOM_FIVE_POINT_ONE_BACK_CHANNEL_LAYOUT ],
        [ DTS_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE, 6, CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT ],
        [ DTS_WAVE_CHANNEL_MASK_SIX_POINT_ONE, 7, CUSTOM_SIX_POINT_ONE_CHANNEL_LAYOUT ],
        [ DTS_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE, 8, CUSTOM_SEVEN_POINT_ONE_CHANNEL_LAYOUT ]
    ])('maps exact WAVE mask %#s', (channelMask, channelCount, layout) => {
        expect(getQualifiedDTSChannelLayout(channelMask)).toEqual({
            channelCount,
            layout
        });
    });

    it.each([ 0, -1, 0x0607, 0x0707, 0x8000_063f, 1.5 ])(
        'rejects unsupported or ambiguous mask %#s',
        channelMask => {
            expect(getQualifiedDTSChannelLayout(channelMask)).toBeNull();
        }
    );
});
