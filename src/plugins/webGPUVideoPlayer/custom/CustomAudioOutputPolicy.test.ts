import { describe, expect, it } from 'vitest';

import {
    assertSupportedCustomAudioOutputLayout,
    CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT,
    CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
    isSupportedCustomAudioOutputLayout
} from './CustomAudioOutputPolicy';

describe('CustomAudioOutputPolicy', () => {
    it('accepts only the probed stereo 48 kHz layout', () => {
        expect(isSupportedCustomAudioOutputLayout(
            CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT,
            CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE
        )).toBe(true);

        expect(isSupportedCustomAudioOutputLayout(1, 48_000)).toBe(false);
        expect(isSupportedCustomAudioOutputLayout(6, 48_000)).toBe(false);
        expect(isSupportedCustomAudioOutputLayout(2, 44_100)).toBe(false);
        expect(isSupportedCustomAudioOutputLayout('2', 48_000)).toBe(false);
        expect(isSupportedCustomAudioOutputLayout(2, '48000')).toBe(false);
    });

    it('rejects unsupported layouts with a stable diagnostic', () => {
        expect(() => assertSupportedCustomAudioOutputLayout(6, 48_000)).toThrow(
            'Custom audio output requires 2 channels at 48000 Hz'
        );
    });
});
