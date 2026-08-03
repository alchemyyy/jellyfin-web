import { describe, expect, it } from 'vitest';

import {
    MAXIMUM_CUSTOM_AUDIO_SAMPLE_RATE,
    MINIMUM_CUSTOM_AUDIO_SAMPLE_RATE,
    isSupportedCustomAudioSampleRate,
    requireSupportedCustomAudioSampleRate
} from './CustomAudioSampleRate';

describe('CustomAudioSampleRate', () => {
    it.each([
        MINIMUM_CUSTOM_AUDIO_SAMPLE_RATE,
        7_350,
        12_345,
        44_100,
        96_000,
        MAXIMUM_CUSTOM_AUDIO_SAMPLE_RATE
    ])('accepts bounded integer source rate %d', sampleRate => {
        expect(isSupportedCustomAudioSampleRate(sampleRate)).toBe(true);
        expect(requireSupportedCustomAudioSampleRate(sampleRate, 'Source sample rate'))
            .toBe(sampleRate);
    });

    it.each([
        MINIMUM_CUSTOM_AUDIO_SAMPLE_RATE - 1,
        MAXIMUM_CUSTOM_AUDIO_SAMPLE_RATE + 1,
        48_000.5,
        Number.NaN,
        '48000',
        null
    ])('rejects sample rate %s outside the bounded integer contract', sampleRate => {
        expect(isSupportedCustomAudioSampleRate(sampleRate)).toBe(false);
        expect(() => requireSupportedCustomAudioSampleRate(sampleRate, 'Source sample rate'))
            .toThrow('Source sample rate must be between 3000 and 192000 Hz');
    });
});
