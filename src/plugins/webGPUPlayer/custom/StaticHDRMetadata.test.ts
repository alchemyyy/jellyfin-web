import { describe, expect, it } from 'vitest';

import {
    getStaticHDRToneMappingPeakNits,
    isStaticHDRMetadata,
    isStaticHDRMetadataScanResult,
    type StaticHDRMetadata
} from './StaticHDRMetadata';

function createMetadata(
    overrides: Partial<StaticHDRMetadata> = {}
): StaticHDRMetadata {
    return {
        masteringDisplayMaximumLuminanceNits: 4_000,
        masteringDisplayMinimumLuminanceNits: 0.005,
        maximumContentLightLevelNits: 500,
        maximumFrameAverageLightLevelNits: 200,
        ...overrides
    };
}

describe('StaticHDRMetadata', () => {
    it('uses mastering luminance before content light level', () => {
        expect(getStaticHDRToneMappingPeakNits(createMetadata())).toBe(4_000);
        expect(getStaticHDRToneMappingPeakNits(createMetadata({
            masteringDisplayMaximumLuminanceNits: null,
            masteringDisplayMinimumLuminanceNits: null
        }))).toBe(500);
    });

    it('accepts absent optional values and rejects unsafe luminance', () => {
        const emptyMetadata = createMetadata({
            masteringDisplayMaximumLuminanceNits: null,
            masteringDisplayMinimumLuminanceNits: null,
            maximumContentLightLevelNits: null,
            maximumFrameAverageLightLevelNits: null
        });
        expect(isStaticHDRMetadata(emptyMetadata)).toBe(true);
        expect(getStaticHDRToneMappingPeakNits(emptyMetadata)).toBeNull();
        expect(isStaticHDRMetadata(createMetadata({
            masteringDisplayMaximumLuminanceNits: 10_001
        }))).toBe(false);
        expect(isStaticHDRMetadata(createMetadata({
            masteringDisplayMinimumLuminanceNits: 4_000
        }))).toBe(false);
        expect(() => getStaticHDRToneMappingPeakNits({
            ...createMetadata(),
            maximumContentLightLevelNits: Number.NaN
        })).toThrow('Static HDR metadata is invalid');
    });

    it('validates exact bounded startup scan states', () => {
        expect(isStaticHDRMetadataScanResult({
            accessUnitCount: 3,
            firstMetadataAccessUnitIndex: 1,
            metadata: createMetadata(),
            status: 'valid'
        })).toBe(true);
        expect(isStaticHDRMetadataScanResult({
            accessUnitCount: 16,
            firstMetadataAccessUnitIndex: null,
            metadata: null,
            status: 'conflicting'
        })).toBe(true);
        expect(isStaticHDRMetadataScanResult({
            accessUnitCount: 1,
            firstMetadataAccessUnitIndex: 1,
            metadata: createMetadata(),
            status: 'valid'
        })).toBe(false);
        expect(isStaticHDRMetadataScanResult({
            accessUnitCount: 1,
            firstMetadataAccessUnitIndex: null,
            metadata: createMetadata(),
            status: 'malformed'
        })).toBe(false);
        expect(isStaticHDRMetadataScanResult({
            accessUnitCount: 17,
            firstMetadataAccessUnitIndex: null,
            metadata: null,
            status: 'absent'
        })).toBe(false);
        expect(isStaticHDRMetadataScanResult({
            accessUnitCount: 1,
            firstMetadataAccessUnitIndex: 0,
            metadata: {
                masteringDisplayMaximumLuminanceNits: null,
                masteringDisplayMinimumLuminanceNits: null,
                maximumContentLightLevelNits: null,
                maximumFrameAverageLightLevelNits: null
            },
            status: 'valid'
        })).toBe(false);
    });
});
