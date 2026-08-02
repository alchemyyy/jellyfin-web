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
    createExternalDolbyVisionColorPipelineWGSL,
    createRawDolbyVisionColorPipelineWGSL,
    createRawDolbyVisionProfile7ColorPipelineWGSL,
    createRawDolbyVisionProfile7FELColorPipelineWGSL,
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

describe('createExternalDolbyVisionColorPipelineWGSL', () => {
    it('inverts limited-range BT.709 before Profile 5 reconstruction', () => {
        const shader = createExternalDolbyVisionColorPipelineWGSL(
            createHDRToSDRRenderSettings()
        );
        const fragmentFunction = shader.slice(shader.indexOf('@fragment'));

        expect(shader).toContain('@binding(1) var videoTexture: texture_external');
        expect(shader).toContain('@binding(3) var<uniform> renderSettings');
        expect(shader).toContain('@binding(4) var<storage, read> dolbyVisionRPU');
        expect(shader).toContain('dot(encodedBT709RGB, vec3f(0.2126, 0.7152, 0.0722))');
        expect(shader).toContain('(normalizedLuma * 876.0) + 64.0');
        expect(shader).toContain('(normalizedChromaBlue * 896.0) + 512.0');
        expect(shader).toContain('(normalizedChromaRed * 896.0) + 512.0');
        expect(fragmentFunction).toContain(`reconstructDolbyVisionBT2020PQ(
        recoverDolbyVisionBaseSignal(encodedBT709RGB)
    )`);
        expect(fragmentFunction.indexOf('reconstructDolbyVisionBT2020PQ')).toBeLessThan(
            fragmentFunction.indexOf('processColor')
        );
    });

    it('keeps the external Dolby Vision shader stable across live settings', () => {
        const firstShader = createExternalDolbyVisionColorPipelineWGSL(
            createHDRToSDRRenderSettings()
        );
        const secondShader = createExternalDolbyVisionColorPipelineWGSL(
            createHDRToSDRRenderSettings({
                display: { brightness: 0.2, contrast: 1.1, saturation: 0.9 },
                toneMapping: { inputPeakNits: 4_000 }
            })
        );

        expect(secondShader).toBe(firstShader);
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

describe('createRawDolbyVisionColorPipelineWGSL', () => {
    it('reconstructs raw base-layer code values before the HDR pipeline', () => {
        const shader = createRawDolbyVisionColorPipelineWGSL(
            createHDRToSDRRenderSettings(),
            'I420P10'
        );
        const fragmentFunction = shader.slice(shader.indexOf('@fragment'));

        expect(shader).not.toContain('texture_external');
        expect(shader).toContain('@binding(1) var lumaTexture: texture_2d<u32>');
        expect(shader).toContain('@binding(2) var chromaUTexture: texture_2d<u32>');
        expect(shader).toContain('@binding(3) var chromaVTexture: texture_2d<u32>');
        expect(shader).toContain('@binding(4) var<uniform> renderSettings');
        expect(shader).toContain('@binding(5) var<storage, read> dolbyVisionRPU');
        expect(shader).not.toContain('fn normalizeRawYUV');
        expect(shader).not.toContain('fn convertRawYUVToEncodedRGB');
        expect(shader).toContain(
            'rawBaseSignal / (codeValueCount - 1.0)'
        );
        expect(fragmentFunction).toContain(`let encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(
        sampleRawYUV(textureCoordinate)
    );`);
        expect(fragmentFunction.indexOf('reconstructDolbyVisionBT2020PQ')).toBeLessThan(
            fragmentFunction.indexOf('processColor')
        );
    });

    it('keeps the Dolby Vision shader stable across live setting changes', () => {
        const firstShader = createRawDolbyVisionColorPipelineWGSL(
            createHDRToSDRRenderSettings(),
            'I420P12'
        );
        const secondShader = createRawDolbyVisionColorPipelineWGSL(
            createHDRToSDRRenderSettings({
                display: { brightness: 0.1, contrast: 1.2, saturation: 0.8 },
                toneMapping: { inputPeakNits: 4_000 }
            }),
            'I420P12'
        );

        expect(secondShader).toBe(firstShader);
    });
});

describe('createRawDolbyVisionProfile7ColorPipelineWGSL', () => {
    it('reconstructs MEL and explicitly uses the compatible HDR10 base for FEL', () => {
        const shader = createRawDolbyVisionProfile7ColorPipelineWGSL(
            createHDRToSDRRenderSettings(),
            'I420P10'
        );
        const fragmentFunction = shader.slice(shader.indexOf('@fragment'));

        expect(shader).toContain('fn isDolbyVisionFEL() -> bool');
        expect(shader).toContain('fn normalizeRawYUV');
        expect(shader).toContain('fn convertRawYUVToEncodedRGB');
        expect(fragmentFunction).toContain('if (isDolbyVisionFEL())');
        expect(fragmentFunction).toContain(
            'convertRawYUVToEncodedRGB(normalizeRawYUV(rawBaseSignal))'
        );
        expect(fragmentFunction).toContain(
            'encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(rawBaseSignal)'
        );
        expect(fragmentFunction.indexOf('isDolbyVisionFEL')).toBeLessThan(
            fragmentFunction.indexOf('processColor')
        );
    });

    it('keeps the Profile 7 shader stable across live setting changes', () => {
        const firstShader = createRawDolbyVisionProfile7ColorPipelineWGSL(
            createHDRToSDRRenderSettings(),
            'I420P10'
        );
        const secondShader = createRawDolbyVisionProfile7ColorPipelineWGSL(
            createHDRToSDRRenderSettings({
                display: { brightness: 0.1, contrast: 1.2, saturation: 0.8 },
                toneMapping: { inputPeakNits: 4_000 }
            }),
            'I420P10'
        );

        expect(secondShader).toBe(firstShader);
    });
});

describe('createRawDolbyVisionProfile7FELColorPipelineWGSL', () => {
    it('binds, sites, and composes the decoded EL before Dolby color matrices', () => {
        const shader = createRawDolbyVisionProfile7FELColorPipelineWGSL(
            createHDRToSDRRenderSettings(),
            'I420P10'
        );
        const fragmentFunction = shader.slice(shader.indexOf('@fragment'));

        expect(shader).toContain('@binding(6) var enhancementLumaTexture');
        expect(shader).toContain('@binding(7) var enhancementChromaUTexture');
        expect(shader).toContain('@binding(8) var enhancementChromaVTexture');
        expect(shader).toContain('@binding(9) var<uniform> enhancement');
        expect(shader).toContain('-0.5 / dimensions.x');
        expect(shader).toContain('-1.0 / lumaDimensions.x');
        expect(fragmentFunction).toContain('enhancement.enhancementPresent != 0u');
        expect(fragmentFunction).toContain(
            'reconstructDolbyVisionBT2020PQWithEnhancement'
        );
        expect(fragmentFunction).toContain(
            'convertRawYUVToEncodedRGB(normalizeRawYUV(rawBaseSignal))'
        );
    });
});
