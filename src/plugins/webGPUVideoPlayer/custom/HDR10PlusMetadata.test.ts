import { describe, expect, it } from 'vitest';

import { createHDR10PlusHEVCFixture } from '../validation/HDR10PlusFixture';
import {
    getHDR10PlusSceneLuminance,
    isHDR10PlusFrameMetadata,
    parseHEVCHDR10PlusMetadata
} from './HDR10PlusMetadata';

const ANNEX_B_FORMAT = { kind: 'annex-b' } as const;

describe('HDR10PlusMetadata', () => {
    it('parses bounded ST 2094-40 statistics and tone-mapping anchors', () => {
        const result = parseHEVCHDR10PlusMetadata(
            createHDR10PlusHEVCFixture('valid'),
            ANNEX_B_FORMAT
        );

        expect(result.status).toBe('valid');
        expect(result.metadata).toMatchObject({
            applicationVersion: 1,
            averageMaxRGBNits: 200,
            distributionMaxRGB: [
                { percentage: 50, percentileNits: 100 },
                { percentage: 99, percentileNits: 900 }
            ],
            maximumSCLNits: [ 1_000, 800, 500 ],
            targetedSystemDisplayMaximumLuminanceNits: 1_000,
            toneMapping: {
                bezierCurveAnchors: [ 256 / 1_023, 768 / 1_023 ],
                kneePointX: 2_048 / 4_095,
                kneePointY: 1_024 / 4_095
            }
        });
        expect(isHDR10PlusFrameMetadata(result)).toBe(true);
        const sceneLuminance = getHDR10PlusSceneLuminance(result.metadata!);
        expect(sceneLuminance.averageNits).toBeCloseTo(166.95);
        expect(sceneLuminance.peakNits).toBeCloseTo(834.75);
    });

    it.each([
        [ 'absent', 'absent' ],
        [ 'malformed', 'malformed' ],
        [ 'conflicting', 'conflicting' ],
        [ 'unsupported', 'unsupported' ]
    ] as const)('classifies %s metadata without leaking a previous frame', (kind, status) => {
        expect(parseHEVCHDR10PlusMetadata(
            createHDR10PlusHEVCFixture(kind),
            ANNEX_B_FORMAT
        )).toEqual({ metadata: null, status });
    });

    it('rejects malformed cross-worker metadata and accepts explicit fallback states', () => {
        expect(isHDR10PlusFrameMetadata({
            metadata: null,
            status: 'malformed'
        })).toBe(true);
        expect(isHDR10PlusFrameMetadata({
            metadata: {
                ...(parseHEVCHDR10PlusMetadata(
                    createHDR10PlusHEVCFixture('valid'),
                    ANNEX_B_FORMAT
                ).metadata ?? {}),
                maximumSCLNits: [ Number.NaN, 800, 500 ]
            },
            status: 'valid'
        })).toBe(false);
    });
});
