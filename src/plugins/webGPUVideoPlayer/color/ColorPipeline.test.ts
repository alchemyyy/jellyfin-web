import { describe, expect, it } from 'vitest';

import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings
} from '../RenderSettings';
import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata
} from './ColorMetadata';
import {
    applyHLGEOTF,
    applyPQEOTF,
    applySDREOTF,
    convertLinearRGBGamut,
    convertYUVToEncodedRGB,
    encodeSDROutput,
    expandYUVRange,
    processEncodedRGB,
    toneMapToSDR,
    type ColorTriplet
} from './ColorPipeline';

describe('ColorPipeline', () => {
    it('expands exact 10-bit limited-range code points without clipping overshoot', () => {
        const metadata = createPQColorMetadata();
        const maximumCode = 1_023;

        expect(expandYUVRange([ 64 / maximumCode, 512 / maximumCode, 512 / maximumCode ], metadata))
            .toEqual([ 0, 0, 0 ]);
        expect(expandYUVRange([ 940 / maximumCode, 64 / maximumCode, 960 / maximumCode ], metadata))
            .toEqual([ 1, -0.5, 0.5 ]);
        expect(expandYUVRange([ 0, 512 / maximumCode, 512 / maximumCode ], metadata)[0])
            .toBeLessThan(0);
    });

    it('uses the exact digital center for full-range chroma', () => {
        const metadata = createPQColorMetadata({ range: 'full' });
        const chromaCenter = 512 / 1_023;

        expect(expandYUVRange([ 0.5, chromaCenter, chromaCenter ], metadata))
            .toEqual([ 0.5, 0, 0 ]);
    });

    it('converts neutral YUV to neutral nonlinear RGB for both matrices', () => {
        const bt709RGB = convertYUVToEncodedRGB([ 0.4, 0, 0 ], 'bt709');
        const bt2020RGB = convertYUVToEncodedRGB([ 0.4, 0, 0 ], 'bt2020-ncl');
        for (const component of [ ...bt709RGB, ...bt2020RGB ]) {
            expect(component).toBeCloseTo(0.4, 12);
        }
    });

    it('matches PQ, HLG, and SDR transfer-function anchors', () => {
        expect(applyPQEOTF(0)).toBe(0);
        expect(applyPQEOTF(1)).toBeCloseTo(10_000, 6);
        expect(applyPQEOTF(0.5080784215)).toBeCloseTo(100, 3);
        expect(applyHLGEOTF(0.75, 1_000)).toBeCloseTo(203.15, 1);
        expect(applySDREOTF(0.04, 100)).toBeCloseTo(0.888888889, 8);
    });

    it('converts BT.2020 linear primaries into BT.709', () => {
        expect(convertLinearRGBGamut([ 1, 0, 0 ], 'bt2020', 'bt709'))
            .toEqual([ 1.660491, -0.12455, -0.018151 ]);
        expect(convertLinearRGBGamut([ 0.2, 0.3, 0.4 ], 'bt709', 'bt709'))
            .toEqual([ 0.2, 0.3, 0.4 ]);
    });

    it('tone maps into the configured peak and preserves achromatic samples', () => {
        const settings = createHDRToSDRRenderSettings({
            toneMapping: {
                desaturationStrength: 0,
                operator: 'reinhard'
            }
        }).toneMapping;
        const mappedRGB = toneMapToSDR([ 1_000, 1_000, 1_000 ], settings);

        expect(mappedRGB[0]).toBeCloseTo(100, 8);
        expect(mappedRGB[1]).toBeCloseTo(mappedRGB[0], 10);
        expect(mappedRGB[2]).toBeCloseTo(mappedRGB[0], 10);
    });

    it('supports both SDR output encodings', () => {
        const sRGBOutput = encodeSDROutput([ 0, 50, 100 ], 100, 'srgb');
        const bt709Output = encodeSDROutput([ 0, 50, 100 ], 100, 'bt709');

        expect(sRGBOutput[0]).toBe(0);
        expect(sRGBOutput[1]).toBeCloseTo(0.735356983, 8);
        expect(sRGBOutput[2]).toBeCloseTo(1, 12);
        expect(bt709Output[0]).toBe(0);
        expect(bt709Output[1]).toBeCloseTo(0.70551509, 8);
        expect(bt709Output[2]).toBeCloseTo(1, 12);
    });

    it('leaves identity RGB untouched and bounds HDR-to-SDR output', () => {
        const encodedRGB: ColorTriplet = [ 0.25, 0.5, 0.75 ];
        expect(processEncodedRGB(
            encodedRGB,
            createSDRColorMetadata(),
            createDefaultRenderSettings()
        )).toEqual(encodedRGB);

        const transformedRGB = processEncodedRGB(
            encodedRGB,
            createHLGColorMetadata(),
            createHDRToSDRRenderSettings()
        );
        for (const component of transformedRGB) {
            expect(component).toBeGreaterThanOrEqual(0);
            expect(component).toBeLessThanOrEqual(1);
        }
    });

    it('applies display controls after HDR output encoding', () => {
        const encodedRGB: ColorTriplet = [ 0.25, 0.5, 0.75 ];
        const metadata = createHLGColorMetadata();
        const neutralOutput = processEncodedRGB(
            encodedRGB,
            metadata,
            createHDRToSDRRenderSettings()
        );
        const adjustedOutput = processEncodedRGB(
            encodedRGB,
            metadata,
            createHDRToSDRRenderSettings({
                display: {
                    brightness: 0.1,
                    contrast: 1,
                    saturation: 0
                }
            })
        );

        expect(adjustedOutput[0]).toBeCloseTo(adjustedOutput[1], 10);
        expect(adjustedOutput[1]).toBeCloseTo(adjustedOutput[2], 10);
        expect(adjustedOutput[0]).toBeGreaterThan(neutralOutput[0]);
    });
});
