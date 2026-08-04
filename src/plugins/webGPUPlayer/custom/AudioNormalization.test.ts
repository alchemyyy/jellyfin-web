import { describe, expect, it } from 'vitest';

import { getAudioNormalizationLinearGain } from './AudioNormalization';

const DOUBLE_GAIN_DECIBELS = 20 * Math.log10(2);
const HALF_GAIN_DECIBELS = 20 * Math.log10(0.5);

describe('AudioNormalization', () => {
    it('uses track gain first and falls back to album gain', () => {
        expect(getAudioNormalizationLinearGain({
            item: { NormalizationGain: DOUBLE_GAIN_DECIBELS },
            mediaSource: { albumNormalizationGain: HALF_GAIN_DECIBELS }
        }, 'TrackGain')).toBeCloseTo(2);
        expect(getAudioNormalizationLinearGain({
            item: { NormalizationGain: null },
            mediaSource: { albumNormalizationGain: HALF_GAIN_DECIBELS }
        }, 'TrackGain')).toBeCloseTo(0.5);
    });

    it('uses album gain first and falls back to track gain', () => {
        expect(getAudioNormalizationLinearGain({
            item: { NormalizationGain: DOUBLE_GAIN_DECIBELS },
            mediaSource: { albumNormalizationGain: HALF_GAIN_DECIBELS }
        }, 'AlbumGain')).toBeCloseTo(0.5);
        expect(getAudioNormalizationLinearGain({
            item: { NormalizationGain: DOUBLE_GAIN_DECIBELS },
            mediaSource: { albumNormalizationGain: null }
        }, 'AlbumGain')).toBeCloseTo(2);
    });

    it('returns unity when normalization is disabled or metadata is unusable', () => {
        const options = {
            item: { NormalizationGain: DOUBLE_GAIN_DECIBELS }
        };

        expect(getAudioNormalizationLinearGain(options, 'Off')).toBe(1);
        expect(getAudioNormalizationLinearGain(options, 'Unexpected')).toBe(1);
        expect(getAudioNormalizationLinearGain({
            item: { NormalizationGain: Number.NaN }
        }, 'TrackGain')).toBe(1);
        expect(getAudioNormalizationLinearGain({
            item: { NormalizationGain: Number.MAX_VALUE }
        }, 'TrackGain')).toBe(1);
        expect(getAudioNormalizationLinearGain(null, 'TrackGain')).toBe(1);
    });
});
