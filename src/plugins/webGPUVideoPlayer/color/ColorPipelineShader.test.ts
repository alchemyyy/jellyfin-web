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
    createColorPipelineWGSL,
    createRawYUVColorPipelineWGSL
} from './ColorPipelineShader';

describe('createColorPipelineWGSL', () => {
    it('generates the ordered external-RGB PQ-to-SDR processing stages', () => {
        const shader = createColorPipelineWGSL(
            createPQColorMetadata(),
            createHDRToSDRRenderSettings({
                toneMapping: { operator: 'reinhard' }
            })
        );
        const processFunction = shader.slice(shader.indexOf('fn processColor'));

        // texture_external sampling already converts underlying YUV planes to RGB
        expect(shader).not.toContain('fn expandYUVRange');
        expect(shader).not.toContain('fn convertYUVToEncodedRGB');
        expect(shader).toContain('fn applyPQEOTF');
        expect(shader).toContain('fn convertToBT709');
        expect(shader).toContain('fn toneMapToSDR');
        expect(shader).toContain('fn applyOutputDither');
        expect(shader).toContain('noise / 255.0');
        expect(shader).toContain('@binding(3) var<uniform> renderSettings');
        expect(shader).toContain('renderSettings.toneMapOperator == 0u');
        expect(shader).not.toContain('fn encodeBT709');
        expect(processFunction.indexOf('decodeInputTransfer')).toBeLessThan(
            processFunction.indexOf('convertToBT709')
        );
        expect(processFunction.indexOf('convertToBT709')).toBeLessThan(
            processFunction.indexOf('toneMapToSDR')
        );
        expect(shader).toContain('return encodeSRGB(linearValue);');
    });

    it('keeps the specialized shader stable across live settings changes', () => {
        const metadata = createPQColorMetadata();
        const firstShader = createColorPipelineWGSL(
            metadata,
            createHDRToSDRRenderSettings()
        );
        const secondShader = createColorPipelineWGSL(
            metadata,
            createHDRToSDRRenderSettings({
                display: {
                    brightness: 0.2,
                    contrast: 1.4,
                    saturation: 0.7
                },
                toneMapping: {
                    desaturationStrength: 0.8,
                    exposure: 1,
                    inputPeakNits: 4_000,
                    operator: 'reinhard',
                    outputPeakNits: 120,
                    paperWhiteNits: 250
                }
            })
        );

        expect(secondShader).toBe(firstShader);
        expect(firstShader).toContain('renderSettings.brightness');
        expect(firstShader).toContain('renderSettings.contrast');
        expect(firstShader).toContain('renderSettings.saturation');
        expect(firstShader).not.toContain('4000.000000000');
    });

    it('injects HLG display metadata into the generated shader', () => {
        const shader = createColorPipelineWGSL(
            createHLGColorMetadata({ nominalPeakNits: 2_000 }),
            createHDRToSDRRenderSettings()
        );

        expect(shader).toContain('fn applyHLGInverseOETF');
        expect(shader).toContain('2000.000000000');
        expect(shader).toContain('sceneLuminance');
    });

    it('retains a literal identity stage for the default mode', () => {
        const shader = createColorPipelineWGSL(
            createSDRColorMetadata(),
            createDefaultRenderSettings()
        );

        expect(shader).toContain(`fn processColor(encodedRGB: vec3f, pixelCoordinate: vec2f) -> vec3f {
    return encodedRGB;
}`);
        expect(shader).not.toContain('fn applyOutputDither');
    });
});

describe('createRawYUVColorPipelineWGSL', () => {
    it('generates planar 10-bit BT.2020 limited-range conversion before PQ decoding', () => {
        const shader = createRawYUVColorPipelineWGSL(
            createPQColorMetadata(),
            createHDRToSDRRenderSettings(),
            'I420P10'
        );
        const fragmentFunction = shader.slice(shader.indexOf('@fragment'));

        expect(shader).not.toContain('texture_external');
        expect(shader).toContain('@binding(1) var lumaTexture: texture_2d<u32>');
        expect(shader).toContain('@binding(2) var chromaUTexture: texture_2d<u32>');
        expect(shader).toContain('@binding(3) var chromaVTexture: texture_2d<u32>');
        expect(shader).toContain('@binding(4) var<uniform> renderSettings');
        expect(shader).toContain('(rawYUV.x - 64.000000000) / 876.000000000');
        expect(shader).toContain('(rawYUV.y - 512.000000000) / 896.000000000');
        expect(shader).toContain('normalizedYUV.x + 1.4746 * normalizedYUV.z');
        expect(fragmentFunction.indexOf('normalizeRawYUV')).toBeLessThan(
            fragmentFunction.indexOf('convertRawYUVToEncodedRGB')
        );
        expect(shader.indexOf('fn convertRawYUVToEncodedRGB')).toBeLessThan(
            shader.indexOf('fn applyPQEOTF')
        );
    });

    it('generates interleaved 8-bit NV12 BT.709 full-range bindings', () => {
        const shader = createRawYUVColorPipelineWGSL(
            createSDRColorMetadata({ range: 'full' }),
            createHDRToSDRRenderSettings(),
            'NV12'
        );

        expect(shader).toContain('@binding(2) var chromaTexture: texture_2d<u32>');
        expect(shader).not.toContain('chromaVTexture');
        expect(shader).toContain('@binding(3) var<uniform> renderSettings');
        expect(shader).toContain('rawYUV.x / 255.000000000');
        expect(shader).toContain('(rawYUV.y - 128.000000000) / 255.000000000');
        expect(shader).toContain('normalizedYUV.x + 1.5748 * normalizedYUV.z');
    });

    it('rejects metadata whose bit depth differs from the copied frame format', () => {
        expect(() => createRawYUVColorPipelineWGSL(
            createPQColorMetadata({ bitDepth: 10 }),
            createHDRToSDRRenderSettings(),
            'I420P12'
        )).toThrow('Raw frame format bit depth does not match color metadata');
    });

    it('keeps the raw shader stable across live setting changes', () => {
        const metadata = createHLGColorMetadata();
        const firstShader = createRawYUVColorPipelineWGSL(
            metadata,
            createHDRToSDRRenderSettings(),
            'I420P10'
        );
        const secondShader = createRawYUVColorPipelineWGSL(
            metadata,
            createHDRToSDRRenderSettings({
                display: { brightness: 0.1, contrast: 1.2, saturation: 0.8 },
                toneMapping: { inputPeakNits: 2_000 }
            }),
            'I420P10'
        );

        expect(secondShader).toBe(firstShader);
    });
});
