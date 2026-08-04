import { describe, expect, it } from 'vitest';

import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata
} from './ColorMetadata';

describe('ColorMetadata', () => {
    it('accepts the supported luminance bounds', () => {
        expect(createPQColorMetadata({ nominalPeakNits: 10_000 }).nominalPeakNits)
            .toBe(10_000);
        expect(createSDRColorMetadata({ sdrReferenceWhiteNits: 1 }).sdrReferenceWhiteNits)
            .toBe(1);
    });

    it.each([ 0, 0.5, 10_001, Number.POSITIVE_INFINITY, Number.NaN ])(
        'rejects unsafe nominal peak luminance %s',
        nominalPeakNits => {
            expect(() => createHLGColorMetadata({ nominalPeakNits })).toThrow(
                'Nominal peak luminance'
            );
        }
    );

    it.each([ 0, 0.5, 10_001, Number.POSITIVE_INFINITY, Number.NaN ])(
        'rejects unsafe SDR reference white %s',
        sdrReferenceWhiteNits => {
            expect(() => createPQColorMetadata({ sdrReferenceWhiteNits })).toThrow(
                'SDR reference white'
            );
        }
    );
});
