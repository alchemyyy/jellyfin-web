import { describe, expect, it, vi } from 'vitest';

vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: vi.fn(() => null),
        set: vi.fn()
    }
}));

import {
    WEBGPU_USER_SETTINGS_STORAGE_KEY,
    createConfiguredHDRRenderSettings,
    createDefaultWebGPUUserSettings,
    loadWebGPUUserSettings,
    normalizeWebGPUUserSettings,
    resetWebGPUAudioSettings,
    resetWebGPURenderSettings,
    saveWebGPUUserSettings,
    type WebGPUUserSettingsStorage
} from './WebGPUUserSettings';

function createStorage(initialValue: string | null = null): WebGPUUserSettingsStorage {
    let value = initialValue;
    return {
        get: vi.fn(() => value),
        set: vi.fn((_name: string, nextValue: string): void => {
            value = nextValue;
        })
    };
}

describe('WebGPUUserSettings', () => {
    it('uses independent qualified defaults for missing and malformed storage', () => {
        const first = loadWebGPUUserSettings(createStorage());
        const second = loadWebGPUUserSettings(createStorage('{bad json'));

        expect(first).toEqual(createDefaultWebGPUUserSettings());
        expect(second).toEqual(createDefaultWebGPUUserSettings());
        expect(first).not.toBe(second);
        expect(first.audio.downmix).not.toBe(second.audio.downmix);
    });

    it('falls back to defaults when local storage cannot be read', () => {
        const storage: WebGPUUserSettingsStorage = {
            get: vi.fn((): string => {
                throw new DOMException('Storage is unavailable', 'SecurityError');
            }),
            set: vi.fn()
        };

        expect(loadWebGPUUserSettings(storage)).toEqual(createDefaultWebGPUUserSettings());
    });

    it('normalizes persisted fields through renderer and downmix ranges', () => {
        const normalized = normalizeWebGPUUserSettings({
            audio: {
                downmix: {
                    centerLevel: 4,
                    outputGain: 30,
                    surroundLevel: -2
                },
                forceStereoDownmix: true
            },
            render: {
                automaticInputPeakNits: false,
                settings: {
                    display: {
                        brightness: 2,
                        contrast: 1.5,
                        saturation: Number.NaN
                    },
                    toneMapping: {
                        desaturationStrength: 0.6,
                        exposure: -20,
                        inputPeakNits: 120,
                        operator: 'aces',
                        outputPeakNits: 80,
                        paperWhiteNits: 203
                    }
                }
            },
            version: 1
        });

        expect(normalized.audio).toEqual({
            downmix: {
                centerLevel: 2,
                outputGain: 10,
                surroundLevel: 0,
                version: 1
            },
            forceStereoDownmix: true
        });
        expect(normalized.render.settings.display).toEqual({
            brightness: 1,
            contrast: 1.5,
            saturation: 1
        });
        expect(normalized.render.settings.toneMapping).toEqual({
            desaturationStrength: 0.6,
            exposure: -16,
            inputPeakNits: 120,
            operator: 'aces',
            outputPeakNits: 80,
            paperWhiteNits: 120
        });
    });

    it('round-trips a normalized versioned snapshot in local storage', () => {
        const storage = createStorage();
        const settings = createDefaultWebGPUUserSettings();
        const changedSettings = {
            ...settings,
            audio: {
                ...settings.audio,
                forceStereoDownmix: true
            }
        };

        const saved = saveWebGPUUserSettings(changedSettings, storage);

        expect(storage.set).toHaveBeenCalledWith(
            WEBGPU_USER_SETTINGS_STORAGE_KEY,
            JSON.stringify(saved),
            false
        );
        expect(loadWebGPUUserSettings(storage)).toEqual(saved);
    });

    it('applies detected input peaks only in automatic mode', () => {
        const defaults = createDefaultWebGPUUserSettings();
        const automaticSettings = createConfiguredHDRRenderSettings(defaults, 4_000);
        const manualSettings = createConfiguredHDRRenderSettings({
            ...defaults,
            render: {
                automaticInputPeakNits: false,
                settings: defaults.render.settings
            }
        }, 4_000);

        expect(automaticSettings.toneMapping.inputPeakNits).toBe(4_000);
        expect(manualSettings.toneMapping.inputPeakNits).toBe(1_000);
    });

    it('clamps configured paper white to a lower detected input peak', () => {
        const defaults = createDefaultWebGPUUserSettings();
        const configuredSettings = createConfiguredHDRRenderSettings(defaults, 100);

        expect(configuredSettings.toneMapping).toMatchObject({
            inputPeakNits: 100,
            paperWhiteNits: 100
        });
    });

    it('resets render and audio sections independently', () => {
        const defaults = createDefaultWebGPUUserSettings();
        const changed = normalizeWebGPUUserSettings({
            ...defaults,
            audio: {
                downmix: {
                    centerLevel: 0.5,
                    outputGain: 0.7,
                    surroundLevel: 0.2,
                    version: 1
                },
                forceStereoDownmix: true
            },
            render: {
                automaticInputPeakNits: false,
                settings: {
                    ...defaults.render.settings,
                    display: {
                        ...defaults.render.settings.display,
                        brightness: 0.25
                    }
                }
            }
        });

        expect(resetWebGPURenderSettings(changed).render).toEqual(defaults.render);
        expect(resetWebGPURenderSettings(changed).audio).toEqual(changed.audio);
        expect(resetWebGPUAudioSettings(changed).audio).toEqual(defaults.audio);
        expect(resetWebGPUAudioSettings(changed).render).toEqual(changed.render);
    });
});
