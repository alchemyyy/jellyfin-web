import { currentSettings } from 'scripts/settings/userSettings';

import {
    HDR_RENDER_SETTING_RANGES,
    createHDRToSDRRenderSettings,
    type HDRToSDRRenderSettings,
    type ToneMapOperator
} from './RenderSettings';
import {
    AUDIO_DOWNMIX_SETTING_RANGES,
    AUDIO_DOWNMIX_SETTINGS_VERSION,
    createDefaultAudioDownmixSettings,
    type AudioDownmixSettings
} from './custom/CustomAudioDownmix';

export const WEBGPU_USER_SETTINGS_VERSION = 1;
export const WEBGPU_USER_SETTINGS_STORAGE_KEY = 'webGPUPlaybackSettings';

export type WebGPUUserSettings = Readonly<{
    audio: Readonly<{
        downmix: AudioDownmixSettings
        forceStereoDownmix: boolean
    }>
    render: Readonly<{
        automaticInputPeakNits: boolean
        settings: HDRToSDRRenderSettings
    }>
    version: typeof WEBGPU_USER_SETTINGS_VERSION
}>;

export type WebGPUUserSettingsStorage = {
    get: (name: string, enableOnServer?: boolean) => string | null | undefined
    set: (name: string, value: string, enableOnServer?: boolean) => unknown
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function getRecord(value: unknown, key: string): Record<string, unknown> {
    if (!isRecord(value)) {
        return {};
    }
    const child = value[key];
    return isRecord(child) ? child : {};
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function normalizeNumber(
    value: unknown,
    fallback: number,
    minimum: number,
    maximum: number
): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(Math.max(value, minimum), maximum);
}

function normalizeToneMapOperator(value: unknown, fallback: ToneMapOperator): ToneMapOperator {
    switch (value) {
        case 'aces':
        case 'reinhard':
        case 'spline':
            return value;
        default:
            return fallback;
    }
}

/** Returns independent plugin defaults backed by renderer and downmix defaults. */
export function createDefaultWebGPUUserSettings(): WebGPUUserSettings {
    return {
        audio: {
            downmix: createDefaultAudioDownmixSettings(),
            forceStereoDownmix: false
        },
        render: {
            automaticInputPeakNits: true,
            settings: createHDRToSDRRenderSettings()
        },
        version: WEBGPU_USER_SETTINGS_VERSION
    };
}

/** Normalizes persisted input through the same ranges consumed by renderer validation. */
export function normalizeWebGPUUserSettings(value: unknown): WebGPUUserSettings {
    const defaults = createDefaultWebGPUUserSettings();
    if (!isRecord(value) || value.version !== WEBGPU_USER_SETTINGS_VERSION) {
        return defaults;
    }

    const render = getRecord(value, 'render');
    const persistedRenderSettings = getRecord(render, 'settings');
    const display = getRecord(persistedRenderSettings, 'display');
    const toneMapping = getRecord(persistedRenderSettings, 'toneMapping');
    const defaultRenderSettings = defaults.render.settings;
    const inputPeakNits = normalizeNumber(
        toneMapping.inputPeakNits,
        defaultRenderSettings.toneMapping.inputPeakNits,
        HDR_RENDER_SETTING_RANGES.inputPeakNits.minimum,
        HDR_RENDER_SETTING_RANGES.inputPeakNits.maximum
    );
    const paperWhiteNits = Math.min(inputPeakNits, normalizeNumber(
        toneMapping.paperWhiteNits,
        defaultRenderSettings.toneMapping.paperWhiteNits,
        HDR_RENDER_SETTING_RANGES.paperWhiteNits.minimum,
        HDR_RENDER_SETTING_RANGES.paperWhiteNits.maximum
    ));
    const settings = createHDRToSDRRenderSettings({
        display: {
            brightness: normalizeNumber(
                display.brightness,
                defaultRenderSettings.display.brightness,
                HDR_RENDER_SETTING_RANGES.brightness.minimum,
                HDR_RENDER_SETTING_RANGES.brightness.maximum
            ),
            contrast: normalizeNumber(
                display.contrast,
                defaultRenderSettings.display.contrast,
                HDR_RENDER_SETTING_RANGES.contrast.minimum,
                HDR_RENDER_SETTING_RANGES.contrast.maximum
            ),
            saturation: normalizeNumber(
                display.saturation,
                defaultRenderSettings.display.saturation,
                HDR_RENDER_SETTING_RANGES.saturation.minimum,
                HDR_RENDER_SETTING_RANGES.saturation.maximum
            )
        },
        toneMapping: {
            desaturationStrength: normalizeNumber(
                toneMapping.desaturationStrength,
                defaultRenderSettings.toneMapping.desaturationStrength,
                HDR_RENDER_SETTING_RANGES.desaturationStrength.minimum,
                HDR_RENDER_SETTING_RANGES.desaturationStrength.maximum
            ),
            exposure: normalizeNumber(
                toneMapping.exposure,
                defaultRenderSettings.toneMapping.exposure,
                HDR_RENDER_SETTING_RANGES.exposure.minimum,
                HDR_RENDER_SETTING_RANGES.exposure.maximum
            ),
            inputPeakNits,
            operator: normalizeToneMapOperator(
                toneMapping.operator,
                defaultRenderSettings.toneMapping.operator
            ),
            outputPeakNits: normalizeNumber(
                toneMapping.outputPeakNits,
                defaultRenderSettings.toneMapping.outputPeakNits,
                HDR_RENDER_SETTING_RANGES.outputPeakNits.minimum,
                HDR_RENDER_SETTING_RANGES.outputPeakNits.maximum
            ),
            paperWhiteNits
        }
    });

    const audio = getRecord(value, 'audio');
    const downmix = getRecord(audio, 'downmix');
    const defaultDownmix = defaults.audio.downmix;
    return {
        audio: {
            downmix: {
                centerLevel: normalizeNumber(
                    downmix.centerLevel,
                    defaultDownmix.centerLevel,
                    AUDIO_DOWNMIX_SETTING_RANGES.centerLevel.minimum,
                    AUDIO_DOWNMIX_SETTING_RANGES.centerLevel.maximum
                ),
                outputGain: normalizeNumber(
                    downmix.outputGain,
                    defaultDownmix.outputGain,
                    AUDIO_DOWNMIX_SETTING_RANGES.outputGain.minimum,
                    AUDIO_DOWNMIX_SETTING_RANGES.outputGain.maximum
                ),
                surroundLevel: normalizeNumber(
                    downmix.surroundLevel,
                    defaultDownmix.surroundLevel,
                    AUDIO_DOWNMIX_SETTING_RANGES.surroundLevel.minimum,
                    AUDIO_DOWNMIX_SETTING_RANGES.surroundLevel.maximum
                ),
                version: AUDIO_DOWNMIX_SETTINGS_VERSION
            },
            forceStereoDownmix: normalizeBoolean(
                audio.forceStereoDownmix,
                defaults.audio.forceStereoDownmix
            )
        },
        render: {
            automaticInputPeakNits: normalizeBoolean(
                render.automaticInputPeakNits,
                defaults.render.automaticInputPeakNits
            ),
            settings
        },
        version: WEBGPU_USER_SETTINGS_VERSION
    };
}

/** Loads local player settings without adding server-side profile state. */
export function loadWebGPUUserSettings(
    storage: WebGPUUserSettingsStorage = currentSettings
): WebGPUUserSettings {
    try {
        const serializedSettings = storage.get(WEBGPU_USER_SETTINGS_STORAGE_KEY, false);
        if (!serializedSettings) {
            return createDefaultWebGPUUserSettings();
        }
        return normalizeWebGPUUserSettings(JSON.parse(serializedSettings));
    } catch {
        return createDefaultWebGPUUserSettings();
    }
}

/** Persists a normalized local snapshot and returns that detached snapshot. */
export function saveWebGPUUserSettings(
    settings: WebGPUUserSettings,
    storage: WebGPUUserSettingsStorage = currentSettings
): WebGPUUserSettings {
    const normalizedSettings = normalizeWebGPUUserSettings(settings);
    storage.set(
        WEBGPU_USER_SETTINGS_STORAGE_KEY,
        JSON.stringify(normalizedSettings),
        false
    );
    return normalizedSettings;
}

/** Builds the actual HDR settings for a source while respecting metadata mode. */
export function createConfiguredHDRRenderSettings(
    settings: WebGPUUserSettings,
    detectedInputPeakNits: number
): HDRToSDRRenderSettings {
    const normalizedSettings = normalizeWebGPUUserSettings(settings);
    const configuredRenderSettings = normalizedSettings.render.settings;
    const inputPeakNits = normalizedSettings.render.automaticInputPeakNits ?
        normalizeNumber(
            detectedInputPeakNits,
            configuredRenderSettings.toneMapping.inputPeakNits,
            HDR_RENDER_SETTING_RANGES.inputPeakNits.minimum,
            HDR_RENDER_SETTING_RANGES.inputPeakNits.maximum
        ) :
        configuredRenderSettings.toneMapping.inputPeakNits;
    return createHDRToSDRRenderSettings({
        display: configuredRenderSettings.display,
        toneMapping: {
            ...configuredRenderSettings.toneMapping,
            inputPeakNits,
            paperWhiteNits: Math.min(
                configuredRenderSettings.toneMapping.paperWhiteNits,
                inputPeakNits
            )
        }
    });
}

/** Resets only tone-mapping and display settings. */
export function resetWebGPURenderSettings(
    settings: WebGPUUserSettings
): WebGPUUserSettings {
    const defaults = createDefaultWebGPUUserSettings();
    const normalizedSettings = normalizeWebGPUUserSettings(settings);
    return {
        ...normalizedSettings,
        render: defaults.render
    };
}

/** Resets only audio output and downmix settings. */
export function resetWebGPUAudioSettings(
    settings: WebGPUUserSettings
): WebGPUUserSettings {
    const defaults = createDefaultWebGPUUserSettings();
    const normalizedSettings = normalizeWebGPUUserSettings(settings);
    return {
        ...normalizedSettings,
        audio: defaults.audio
    };
}
