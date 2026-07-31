import { describe, expect, it } from 'vitest';

import { calculateClientHDRToneMappingSaturation } from './postProcessing';

const DEFAULT_PARAMETERS = {
    kneeOffset: 1,
    sourcePeakNits: 1000,
    targetPeakNits: 203
};

describe('client HDR tone-mapping CSS post-processing', () => {
    it('leaves the control preset unmodified', () => {
        expect(calculateClientHDRToneMappingSaturation(
            'control',
            DEFAULT_PARAMETERS,
            100
        )).toBe(1);
    });

    it('derives automatic desaturation from peak curve compression', () => {
        expect(calculateClientHDRToneMappingSaturation(
            'bt2390',
            DEFAULT_PARAMETERS,
            100
        )).toBeCloseTo((203 / 1000) ** (1 / 8), 8);
    });

    it('scales the user strength without changing the curve value', () => {
        const automaticSaturation = calculateClientHDRToneMappingSaturation(
            'bt2390',
            DEFAULT_PARAMETERS,
            100
        );

        expect(calculateClientHDRToneMappingSaturation(
            'bt2390',
            DEFAULT_PARAMETERS,
            0
        )).toBe(1);
        expect(calculateClientHDRToneMappingSaturation(
            'bt2390',
            DEFAULT_PARAMETERS,
            50
        )).toBeCloseTo(automaticSaturation ** 0.5, 8);
    });

    it('responds to the active source and target peak settings', () => {
        const defaultSaturation = calculateClientHDRToneMappingSaturation(
            'bt2390',
            DEFAULT_PARAMETERS,
            100
        );
        const strongerCompressionSaturation =
            calculateClientHDRToneMappingSaturation(
                'bt2390',
                {
                    ...DEFAULT_PARAMETERS,
                    sourcePeakNits: 4000,
                    targetPeakNits: 100
                },
                100
            );

        expect(strongerCompressionSaturation).toBeLessThan(defaultSaturation);
    });

    it('supports unclamped finite strengths and defaults invalid values', () => {
        expect(calculateClientHDRToneMappingSaturation(
            'bt2390',
            {
                ...DEFAULT_PARAMETERS,
                sourcePeakNits: 6400,
                targetPeakNits: 100
            },
            500
        )).toBeCloseTo(0.6 ** 5, 8);
        expect(calculateClientHDRToneMappingSaturation(
            'bt2390',
            DEFAULT_PARAMETERS,
            Number.NaN
        )).toBeCloseTo((203 / 1000) ** (1 / 8), 8);
    });
});
