import { describe, expect, it } from 'vitest';

import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings,
    createRenderSettingsUniformData,
    RENDER_SETTINGS_UNIFORM_BYTE_LENGTH,
    RENDER_SETTINGS_VERSION
} from './RenderSettings';

describe('RenderSettings', () => {
    it('keeps identity SDR as the safe default', () => {
        expect(createDefaultRenderSettings()).toEqual({
            mode: 'identity-sdr',
            version: RENDER_SETTINGS_VERSION
        });
    });

    it('creates independent versioned HDR settings with explicit overrides', () => {
        const firstSettings = createHDRToSDRRenderSettings({
            display: {
                brightness: 0.1,
                contrast: 1.2,
                saturation: 0.8
            },
            toneMapping: {
                desaturationStrength: 0.5,
                operator: 'reinhard'
            }
        });
        const secondSettings = createHDRToSDRRenderSettings();

        expect(firstSettings).toMatchObject({
            mode: 'hdr-to-sdr',
            display: {
                brightness: 0.1,
                contrast: 1.2,
                saturation: 0.8
            },
            outputTransfer: 'srgb',
            toneMapping: {
                desaturationStrength: 0.5,
                operator: 'reinhard'
            },
            version: RENDER_SETTINGS_VERSION
        });
        expect(secondSettings.outputTransfer).toBe('srgb');
        expect(secondSettings.toneMapping.desaturationStrength).toBe(0.25);
        expect(secondSettings.display).toEqual({
            brightness: 0,
            contrast: 1,
            saturation: 1
        });
    });

    it('rejects invalid HDR luminance and desaturation settings', () => {
        expect(() => createHDRToSDRRenderSettings({
            toneMapping: { outputPeakNits: 0 }
        })).toThrow('peak luminance');
        expect(() => createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 10_001 }
        })).toThrow('peak luminance');
        expect(() => createHDRToSDRRenderSettings({
            toneMapping: { outputPeakNits: 10_001 }
        })).toThrow('peak luminance');
        expect(() => createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 100, paperWhiteNits: 203 }
        })).toThrow('Paper white');
        expect(() => createHDRToSDRRenderSettings({
            toneMapping: { exposure: 16.1 }
        })).toThrow('Exposure');
        expect(() => createHDRToSDRRenderSettings({
            toneMapping: { exposure: -16.1 }
        })).toThrow('Exposure');
        expect(() => createHDRToSDRRenderSettings({
            toneMapping: { desaturationStrength: 1.1 }
        })).toThrow('Desaturation');
        expect(() => createHDRToSDRRenderSettings({
            display: { brightness: 1.1 }
        })).toThrow('brightness');
        expect(() => createHDRToSDRRenderSettings({
            display: { contrast: -1 }
        })).toThrow('contrast');
        expect(() => createHDRToSDRRenderSettings({
            display: { saturation: 4.1 }
        })).toThrow('saturation');
        expect(() => createHDRToSDRRenderSettings({
            outputTransfer: 'bt709' as 'srgb'
        })).toThrow('output transfer');
    });

    it('serializes all live controls into the aligned versioned uniform layout', () => {
        const settings = createHDRToSDRRenderSettings({
            display: {
                brightness: 0.125,
                contrast: 1.5,
                saturation: 0.75
            },
            toneMapping: {
                desaturationStrength: 0.375,
                exposure: -0.5,
                inputPeakNits: 4_000,
                operator: 'reinhard',
                outputPeakNits: 120,
                paperWhiteNits: 250
            }
        });

        const data = createRenderSettingsUniformData(settings);
        const integerValues = new Uint32Array(data.buffer);
        const floatValues = new Float32Array(data.buffer);

        expect(data.byteLength).toBe(RENDER_SETTINGS_UNIFORM_BYTE_LENGTH);
        expect(integerValues.slice(0, 4)).toEqual(new Uint32Array([
            RENDER_SETTINGS_VERSION,
            1,
            1,
            0
        ]));
        expect(floatValues[4]).toBeCloseTo(0.375);
        expect(floatValues[5]).toBeCloseTo(-0.5);
        expect(floatValues[6]).toBeCloseTo(4_000);
        expect(floatValues[7]).toBeCloseTo(120);
        expect(floatValues[8]).toBeCloseTo(250);
        expect(floatValues[9]).toBeCloseTo(0.125);
        expect(floatValues[10]).toBeCloseTo(1.5);
        expect(floatValues[11]).toBeCloseTo(0.75);
    });
});
