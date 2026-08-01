export const RENDER_SETTINGS_VERSION = 4;
export const RENDER_SETTINGS_UNIFORM_BYTE_LENGTH = 48;

const MAXIMUM_LUMINANCE_NITS = 10_000;
const MINIMUM_LUMINANCE_NITS = 1;
const MAXIMUM_EXPOSURE_STOPS = 16;
const MINIMUM_EXPOSURE_STOPS = -16;

export type RenderMode = 'hdr-to-sdr' | 'identity-sdr';
// The configured WebGPU canvas uses the sRGB output color space
export type OutputTransfer = 'srgb';
export type ToneMapOperator = 'aces' | 'reinhard';

export type ToneMappingSettings = {
    desaturationStrength: number
    exposure: number
    inputPeakNits: number
    operator: ToneMapOperator
    outputPeakNits: number
    paperWhiteNits: number
};

export type DisplaySettings = {
    brightness: number
    contrast: number
    saturation: number
};

export type IdentitySDRRenderSettings = {
    mode: 'identity-sdr'
    version: typeof RENDER_SETTINGS_VERSION
};

export type HDRToSDRRenderSettings = {
    display: DisplaySettings
    mode: 'hdr-to-sdr'
    outputTransfer: OutputTransfer
    toneMapping: ToneMappingSettings
    version: typeof RENDER_SETTINGS_VERSION
};

export type RenderSettings = HDRToSDRRenderSettings | IdentitySDRRenderSettings;

export type HDRToSDRRenderSettingsOverrides = {
    display?: Partial<DisplaySettings>
    outputTransfer?: OutputTransfer
    toneMapping?: Partial<ToneMappingSettings>
};

const DEFAULT_TONE_MAPPING_SETTINGS: ToneMappingSettings = {
    desaturationStrength: 0.25,
    exposure: 0,
    inputPeakNits: 1_000,
    operator: 'aces',
    outputPeakNits: 100,
    paperWhiteNits: 203
};

const DEFAULT_DISPLAY_SETTINGS: DisplaySettings = {
    brightness: 0,
    contrast: 1,
    saturation: 1
};

const ACES_OPERATOR_CODE = 0;
const REINHARD_OPERATOR_CODE = 1;
const SRGB_OUTPUT_TRANSFER_CODE = 1;

const UNIFORM_VERSION_INDEX = 0;
const UNIFORM_OPERATOR_INDEX = 1;
const UNIFORM_OUTPUT_TRANSFER_INDEX = 2;
const UNIFORM_DESATURATION_INDEX = 4;
const UNIFORM_EXPOSURE_INDEX = 5;
const UNIFORM_INPUT_PEAK_INDEX = 6;
const UNIFORM_OUTPUT_PEAK_INDEX = 7;
const UNIFORM_PAPER_WHITE_INDEX = 8;
const UNIFORM_BRIGHTNESS_INDEX = 9;
const UNIFORM_CONTRAST_INDEX = 10;
const UNIFORM_SATURATION_INDEX = 11;

/** Throws when renderer settings cannot produce a deterministic color transform. */
export function assertValidRenderSettings(settings: RenderSettings): void {
    if (settings.version !== RENDER_SETTINGS_VERSION) {
        throw new RangeError('Unsupported render settings version');
    }

    switch (settings.mode) {
        case 'identity-sdr':
            return;
        case 'hdr-to-sdr':
            break;
        default:
            throw new RangeError('Unsupported render mode');
    }

    if (settings.outputTransfer !== 'srgb') {
        throw new RangeError('Unsupported output transfer');
    }
    switch (settings.toneMapping.operator) {
        case 'aces':
        case 'reinhard':
            break;
        default:
            throw new RangeError('Unsupported tone map operator');
    }

    const toneMapping = settings.toneMapping;
    const numericSettings: number[] = [];
    numericSettings.push(
        toneMapping.desaturationStrength,
        toneMapping.exposure,
        toneMapping.inputPeakNits,
        toneMapping.outputPeakNits,
        toneMapping.paperWhiteNits
    );
    numericSettings.push(
        settings.display.brightness,
        settings.display.contrast,
        settings.display.saturation
    );
    if (!numericSettings.every(Number.isFinite)) {
        throw new RangeError('Tone mapping settings must be finite');
    }
    if (
        toneMapping.inputPeakNits < MINIMUM_LUMINANCE_NITS
        || toneMapping.inputPeakNits > MAXIMUM_LUMINANCE_NITS
        || toneMapping.outputPeakNits < MINIMUM_LUMINANCE_NITS
        || toneMapping.outputPeakNits > MAXIMUM_LUMINANCE_NITS
    ) {
        throw new RangeError('Tone mapping peak luminance must be from 1 through 10000 nits');
    }
    if (toneMapping.paperWhiteNits < MINIMUM_LUMINANCE_NITS
        || toneMapping.paperWhiteNits > MAXIMUM_LUMINANCE_NITS
        || toneMapping.paperWhiteNits > toneMapping.inputPeakNits) {
        throw new RangeError('Paper white must be within the input luminance range');
    }
    if (
        toneMapping.exposure < MINIMUM_EXPOSURE_STOPS
        || toneMapping.exposure > MAXIMUM_EXPOSURE_STOPS
    ) {
        throw new RangeError('Exposure must be from negative 16 through 16 stops');
    }
    if (toneMapping.desaturationStrength < 0 || toneMapping.desaturationStrength > 1) {
        throw new RangeError('Desaturation strength must be between zero and one');
    }
    if (settings.display.brightness < -1 || settings.display.brightness > 1) {
        throw new RangeError('Display brightness must be between negative one and one');
    }
    if (settings.display.contrast < 0 || settings.display.contrast > 4) {
        throw new RangeError('Display contrast must be between zero and four');
    }
    if (settings.display.saturation < 0 || settings.display.saturation > 4) {
        throw new RangeError('Display saturation must be between zero and four');
    }
}

/** Returns independent identity settings for a new presentation session. */
export function createDefaultRenderSettings(): IdentitySDRRenderSettings {
    return {
        mode: 'identity-sdr',
        version: RENDER_SETTINGS_VERSION
    };
}

/** Returns independent HDR-to-SDR settings with validated overrides. */
export function createHDRToSDRRenderSettings(
    overrides: HDRToSDRRenderSettingsOverrides = {}
): HDRToSDRRenderSettings {
    const display: DisplaySettings = {
        ...DEFAULT_DISPLAY_SETTINGS,
        ...overrides.display
    };
    const toneMapping: ToneMappingSettings = {
        ...DEFAULT_TONE_MAPPING_SETTINGS,
        ...overrides.toneMapping
    };
    const settings: HDRToSDRRenderSettings = {
        display,
        mode: 'hdr-to-sdr',
        outputTransfer: overrides.outputTransfer ?? 'srgb',
        toneMapping,
        version: RENDER_SETTINGS_VERSION
    };
    assertValidRenderSettings(settings);
    return settings;
}

function getToneMapOperatorCode(operator: ToneMapOperator): number {
    switch (operator) {
        case 'aces':
            return ACES_OPERATOR_CODE;
        case 'reinhard':
            return REINHARD_OPERATOR_CODE;
    }
}

function getOutputTransferCode(outputTransfer: OutputTransfer): number {
    if (outputTransfer !== 'srgb') {
        throw new RangeError('Unsupported output transfer');
    }
    return SRGB_OUTPUT_TRANSFER_CODE;
}

/** Serializes adjustable renderer controls into the versioned WGSL layout. */
export function createRenderSettingsUniformData(
    settings: HDRToSDRRenderSettings
): Uint8Array<ArrayBuffer> {
    assertValidRenderSettings(settings);

    const buffer = new ArrayBuffer(RENDER_SETTINGS_UNIFORM_BYTE_LENGTH);
    const integerValues = new Uint32Array(buffer);
    const floatValues = new Float32Array(buffer);
    integerValues[UNIFORM_VERSION_INDEX] = settings.version;
    integerValues[UNIFORM_OPERATOR_INDEX] = getToneMapOperatorCode(
        settings.toneMapping.operator
    );
    integerValues[UNIFORM_OUTPUT_TRANSFER_INDEX] = getOutputTransferCode(
        settings.outputTransfer
    );
    floatValues[UNIFORM_DESATURATION_INDEX] = settings.toneMapping.desaturationStrength;
    floatValues[UNIFORM_EXPOSURE_INDEX] = settings.toneMapping.exposure;
    floatValues[UNIFORM_INPUT_PEAK_INDEX] = settings.toneMapping.inputPeakNits;
    floatValues[UNIFORM_OUTPUT_PEAK_INDEX] = settings.toneMapping.outputPeakNits;
    floatValues[UNIFORM_PAPER_WHITE_INDEX] = settings.toneMapping.paperWhiteNits;
    floatValues[UNIFORM_BRIGHTNESS_INDEX] = settings.display.brightness;
    floatValues[UNIFORM_CONTRAST_INDEX] = settings.display.contrast;
    floatValues[UNIFORM_SATURATION_INDEX] = settings.display.saturation;
    return new Uint8Array(buffer);
}
