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
    applyPQOETF,
    applySDREOTF,
    convertIPTPQToLinearRGBNits,
    convertLinearRGBGamut,
    convertLinearRGBNitsToIPTPQ,
    convertYUVToEncodedRGB,
    encodeSDROutput,
    evaluateSplineToneMapPQ,
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

    it('round trips absolute luminance and neutral BT.2020 through IPTPQc4', () => {
        expect(applyPQOETF(100)).toBeCloseTo(0.5080784215, 9);
        expect(applyPQEOTF(applyPQOETF(1_000))).toBeCloseTo(1_000, 7);

        const perceptualColor = convertLinearRGBNitsToIPTPQ(
            [ 100, 100, 100 ],
            'bt2020'
        );
        const roundTripRGB = convertIPTPQToLinearRGBNits(perceptualColor, 'bt2020');
        expect(perceptualColor[0]).toBeCloseTo(applyPQOETF(100), 6);
        expect(perceptualColor[1]).toBeCloseTo(0, 5);
        expect(perceptualColor[2]).toBeCloseTo(0, 5);
        for (const component of roundTripRGB) {
            expect(component).toBeCloseTo(100, 7);
        }
    });

    it('matches static libplacebo spline anchors and stays monotonic', () => {
        const inputLuminances = [ 0, 10, 100, 203, 400, 1_000 ];
        const mappedIntensities = inputLuminances.map((luminanceNits: number) => (
            evaluateSplineToneMapPQ(applyPQOETF(luminanceNits), 1_000, 100)
        ));

        expect(mappedIntensities[0]).toBeLessThan(0.000001);
        expect(mappedIntensities[2]).toBeCloseTo(0.4099250914, 9);
        expect(mappedIntensities[3]).toBeCloseTo(0.4442964008, 9);
        expect(mappedIntensities.at(-1)).toBeCloseTo(applyPQOETF(100), 12);
        for (let intensityIndex = 1; intensityIndex < mappedIntensities.length; intensityIndex++) {
            expect(mappedIntensities[intensityIndex]).toBeGreaterThan(
                mappedIntensities[intensityIndex - 1]
            );
        }
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

    it('perceptually compresses BT.2020 primaries without hard channel clipping', () => {
        const encoded100Nits = applyPQOETF(100);
        const settings = createHDRToSDRRenderSettings();
        const metadata = createPQColorMetadata();
        const mappedRed = processEncodedRGB(
            [ encoded100Nits, 0, 0 ],
            metadata,
            settings
        );
        const mappedGreen = processEncodedRGB(
            [ 0, encoded100Nits, 0 ],
            metadata,
            settings
        );
        const mappedBlue = processEncodedRGB(
            [ 0, 0, encoded100Nits ],
            metadata,
            settings
        );

        expect(mappedRed).toEqual(expect.arrayContaining([
            expect.any(Number),
            expect.any(Number),
            expect.any(Number)
        ]));
        expect(mappedRed[0]).toBeCloseTo(0.79467454, 7);
        expect(mappedRed[0]).toBeGreaterThan(mappedRed[1]);
        expect(mappedRed[0]).toBeGreaterThan(mappedRed[2]);
        expect(mappedGreen[1]).toBeGreaterThan(mappedGreen[0]);
        expect(mappedGreen[1]).toBeGreaterThan(mappedGreen[2]);
        expect(mappedBlue[2]).toBeGreaterThan(mappedBlue[0]);
        expect(mappedBlue[2]).toBeGreaterThan(mappedBlue[1]);
        for (const component of [ ...mappedRed, ...mappedGreen, ...mappedBlue ]) {
            expect(component).toBeGreaterThan(0);
            expect(component).toBeLessThan(1);
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
