import {
    assertValidRenderSettings,
    RENDER_SETTINGS_VERSION,
    type DisplaySettings,
    type HDRToSDRRenderSettings,
    type RenderSettings,
    type ToneMappingSettings
} from '../RenderSettings';
import {
    assertValidInputColorMetadata,
    type ColorPrimaries,
    type InputColorMetadata,
    type YUVMatrix
} from './ColorMetadata';

export type ColorTriplet = readonly [number, number, number];
export type ReferenceSDROutputTransfer = 'bt709' | 'srgb';

const ACES_A = 2.51;
const ACES_B = 0.03;
const ACES_C = 2.43;
const ACES_D = 0.59;
const ACES_E = 0.14;
const HLG_A = 0.17883277;
const HLG_B = 1 - (4 * HLG_A);
const HLG_C = 0.5 - (HLG_A * Math.log(4 * HLG_A));
const PQ_C1 = 3424 / 4096;
const PQ_C2 = 2413 / 128;
const PQ_C3 = 2392 / 128;
const PQ_M1 = 2610 / 16384;
const PQ_M2 = 2523 / 32;
const PQ_PEAK_NITS = 10_000;

type LumaCoefficients = {
    blue: number
    green: number
    red: number
};

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function mapTriplet(
    value: ColorTriplet,
    transform: (component: number) => number
): ColorTriplet {
    return [ transform(value[0]), transform(value[1]), transform(value[2]) ];
}

function getLumaCoefficients(primaries: ColorPrimaries): LumaCoefficients {
    switch (primaries) {
        case 'bt2020':
            return { blue: 0.0593, green: 0.6780, red: 0.2627 };
        case 'bt709':
            return { blue: 0.0722, green: 0.7152, red: 0.2126 };
    }
}

function calculateLuminance(linearRGB: ColorTriplet, primaries: ColorPrimaries): number {
    const coefficients = getLumaCoefficients(primaries);
    return (linearRGB[0] * coefficients.red)
        + (linearRGB[1] * coefficients.green)
        + (linearRGB[2] * coefficients.blue);
}

function applyHLGInverseOETF(encodedValue: number): number {
    const clampedValue = clamp(encodedValue, 0, 1);
    if (clampedValue <= 0.5) {
        return (clampedValue * clampedValue) / 3;
    }

    return (Math.exp((clampedValue - HLG_C) / HLG_A) + HLG_B) / 12;
}

function evaluateToneMapCurve(normalizedLuminance: number, operator: ToneMappingSettings['operator']): number {
    const nonNegativeLuminance = Math.max(normalizedLuminance, 0);
    switch (operator) {
        case 'aces':
            return clamp(
                (nonNegativeLuminance * ((ACES_A * nonNegativeLuminance) + ACES_B))
                    / ((nonNegativeLuminance * ((ACES_C * nonNegativeLuminance) + ACES_D)) + ACES_E),
                0,
                1
            );
        case 'reinhard':
            return nonNegativeLuminance / (1 + nonNegativeLuminance);
    }
}

/** Expands normalized digital YUV codes into full-range luma and centered chroma. */
export function expandYUVRange(
    encodedYUV: ColorTriplet,
    metadata: InputColorMetadata
): ColorTriplet {
    assertValidInputColorMetadata(metadata);
    const maximumCode = (2 ** metadata.bitDepth) - 1;
    const chromaCenterCode = 2 ** (metadata.bitDepth - 1);
    if (metadata.range === 'full') {
        return [
            encodedYUV[0],
            encodedYUV[1] - (chromaCenterCode / maximumCode),
            encodedYUV[2] - (chromaCenterCode / maximumCode)
        ];
    }

    const codeScale = 2 ** (metadata.bitDepth - 8);
    const lumaBlackCode = 16 * codeScale;
    const lumaWhiteCode = 235 * codeScale;
    const chromaExcursion = 224 * codeScale;
    return [
        ((encodedYUV[0] * maximumCode) - lumaBlackCode) / (lumaWhiteCode - lumaBlackCode),
        ((encodedYUV[1] * maximumCode) - chromaCenterCode) / chromaExcursion,
        ((encodedYUV[2] * maximumCode) - chromaCenterCode) / chromaExcursion
    ];
}

/** Converts full-range YUV into nonlinear RGB without clipping legal overshoot. */
export function convertYUVToEncodedRGB(
    expandedYUV: ColorTriplet,
    matrix: YUVMatrix
): ColorTriplet {
    const lumaCoefficients = getLumaCoefficients(matrix === 'bt709' ? 'bt709' : 'bt2020');
    const luma = expandedYUV[0];
    const blueDifference = expandedYUV[1];
    const redDifference = expandedYUV[2];
    const red = luma + (2 * (1 - lumaCoefficients.red) * redDifference);
    const blue = luma + (2 * (1 - lumaCoefficients.blue) * blueDifference);
    const green = (
        luma - (lumaCoefficients.red * red) - (lumaCoefficients.blue * blue)
    ) / lumaCoefficients.green;
    return [ red, green, blue ];
}

/** Applies the SMPTE ST 2084 EOTF and returns absolute luminance in nits. */
export function applyPQEOTF(encodedValue: number): number {
    const clampedValue = clamp(encodedValue, 0, 1);
    const inversePower = clampedValue ** (1 / PQ_M2);
    const numerator = Math.max(inversePower - PQ_C1, 0);
    const denominator = Math.max(PQ_C2 - (PQ_C3 * inversePower), Number.EPSILON);
    return PQ_PEAK_NITS * ((numerator / denominator) ** (1 / PQ_M1));
}

/** Applies the BT.2100 HLG display transform for an achromatic signal. */
export function applyHLGEOTF(encodedValue: number, nominalPeakNits: number): number {
    if (!Number.isFinite(nominalPeakNits) || nominalPeakNits <= 0) {
        throw new RangeError('HLG nominal peak luminance must be positive and finite');
    }

    const sceneLinear = applyHLGInverseOETF(encodedValue);
    const systemGamma = 1.2 + (0.42 * Math.log10(nominalPeakNits / 1_000));
    return nominalPeakNits * (sceneLinear ** systemGamma);
}

/** Applies the BT.709 inverse transfer function and scales it to reference white. */
export function applySDREOTF(encodedValue: number, referenceWhiteNits: number): number {
    if (!Number.isFinite(referenceWhiteNits) || referenceWhiteNits <= 0) {
        throw new RangeError('SDR reference white must be positive and finite');
    }

    const linearValue = encodedValue < 0.081 ?
        encodedValue / 4.5 :
        ((encodedValue + 0.099) / 1.099) ** (1 / 0.45);
    return linearValue * referenceWhiteNits;
}

/** Decodes nonlinear RGB into absolute linear-light RGB in nits. */
export function decodeEncodedRGBToNits(
    encodedRGB: ColorTriplet,
    metadata: InputColorMetadata
): ColorTriplet {
    assertValidInputColorMetadata(metadata);
    switch (metadata.transfer) {
        case 'pq':
            return mapTriplet(encodedRGB, applyPQEOTF);
        case 'sdr':
            return mapTriplet(
                encodedRGB,
                (component: number): number => applySDREOTF(
                    component,
                    metadata.sdrReferenceWhiteNits
                )
            );
        case 'hlg': {
            const sceneLinearRGB = mapTriplet(encodedRGB, applyHLGInverseOETF);
            const sceneLuminance = Math.max(
                calculateLuminance(sceneLinearRGB, metadata.primaries),
                0
            );
            if (sceneLuminance === 0) {
                return [ 0, 0, 0 ];
            }

            const systemGamma = 1.2
                + (0.42 * Math.log10(metadata.nominalPeakNits / 1_000));
            const luminanceScale = metadata.nominalPeakNits
                * (sceneLuminance ** (systemGamma - 1));
            return mapTriplet(
                sceneLinearRGB,
                (component: number): number => component * luminanceScale
            );
        }
    }
}

/** Converts linear-light RGB between the supported display primaries. */
export function convertLinearRGBGamut(
    linearRGB: ColorTriplet,
    sourcePrimaries: ColorPrimaries,
    destinationPrimaries: ColorPrimaries
): ColorTriplet {
    if (sourcePrimaries === destinationPrimaries) {
        return [ linearRGB[0], linearRGB[1], linearRGB[2] ];
    }

    if (sourcePrimaries === 'bt2020') {
        return [
            (1.660491 * linearRGB[0]) - (0.587641 * linearRGB[1]) - (0.072850 * linearRGB[2]),
            (-0.124550 * linearRGB[0]) + (1.132900 * linearRGB[1]) - (0.008349 * linearRGB[2]),
            (-0.018151 * linearRGB[0]) - (0.100579 * linearRGB[1]) + (1.118730 * linearRGB[2])
        ];
    }

    return [
        (0.627404 * linearRGB[0]) + (0.329283 * linearRGB[1]) + (0.043313 * linearRGB[2]),
        (0.069097 * linearRGB[0]) + (0.919540 * linearRGB[1]) + (0.011362 * linearRGB[2]),
        (0.016391 * linearRGB[0]) + (0.088013 * linearRGB[1]) + (0.895595 * linearRGB[2])
    ];
}

/** Compresses absolute BT.709 linear light into the configured SDR luminance range. */
export function toneMapToSDR(
    linearBT709Nits: ColorTriplet,
    settings: ToneMappingSettings
): ColorTriplet {
    const temporarySettings: HDRToSDRRenderSettings = {
        display: {
            brightness: 0,
            contrast: 1,
            saturation: 1
        },
        mode: 'hdr-to-sdr',
        outputTransfer: 'srgb',
        toneMapping: settings,
        version: RENDER_SETTINGS_VERSION
    };
    assertValidRenderSettings(temporarySettings);

    const exposureScale = 2 ** settings.exposure;
    const exposedRGB = mapTriplet(
        linearBT709Nits,
        (component: number): number => Math.max(component * exposureScale, 0)
    );
    const inputLuminance = calculateLuminance(exposedRGB, 'bt709');
    if (inputLuminance <= 0) {
        return [ 0, 0, 0 ];
    }

    const peakCurveValue = evaluateToneMapCurve(
        settings.inputPeakNits / settings.paperWhiteNits,
        settings.operator
    );
    const inputCurveValue = evaluateToneMapCurve(
        inputLuminance / settings.paperWhiteNits,
        settings.operator
    );
    const mappedLuminance = settings.outputPeakNits
        * clamp(inputCurveValue / peakCurveValue, 0, 1);
    const luminanceScale = mappedLuminance / inputLuminance;
    const mappedRGB = mapTriplet(
        exposedRGB,
        (component: number): number => component * luminanceScale
    );
    const highlightRange = Math.max(
        settings.inputPeakNits - settings.paperWhiteNits,
        Number.EPSILON
    );
    const highlightAmount = settings.desaturationStrength * clamp(
        (inputLuminance - settings.paperWhiteNits) / highlightRange,
        0,
        1
    );
    return mapTriplet(mappedRGB, (component: number): number => clamp(
        component + ((mappedLuminance - component) * highlightAmount),
        0,
        settings.outputPeakNits
    ));
}

function applyDisplayControls(
    encodedRGB: ColorTriplet,
    settings: DisplaySettings
): ColorTriplet {
    const luminance = calculateLuminance(encodedRGB, 'bt709');
    const saturatedRGB = mapTriplet(
        encodedRGB,
        (component: number): number => luminance
            + ((component - luminance) * settings.saturation)
    );
    return mapTriplet(saturatedRGB, (component: number): number => clamp(
        ((component - 0.5) * settings.contrast) + 0.5 + settings.brightness,
        0,
        1
    ));
}

/** Encodes absolute linear-light RGB for an SDR swap-chain target. */
export function encodeSDROutput(
    linearRGBNits: ColorTriplet,
    outputPeakNits: number,
    transfer: ReferenceSDROutputTransfer
): ColorTriplet {
    if (!Number.isFinite(outputPeakNits) || outputPeakNits <= 0) {
        throw new RangeError('Output peak luminance must be positive and finite');
    }

    return mapTriplet(linearRGBNits, (component: number): number => {
        const linearValue = clamp(component / outputPeakNits, 0, 1);
        switch (transfer) {
            case 'bt709':
                return linearValue < 0.018 ?
                    4.5 * linearValue :
                    (1.099 * (linearValue ** 0.45)) - 0.099;
            case 'srgb':
                return linearValue <= 0.0031308 ?
                    12.92 * linearValue :
                    (1.055 * (linearValue ** (1 / 2.4))) - 0.055;
        }
    });
}

/** Applies the reference color pipeline to an already converted nonlinear RGB sample. */
export function processEncodedRGB(
    encodedRGB: ColorTriplet,
    metadata: InputColorMetadata,
    settings: RenderSettings
): ColorTriplet {
    assertValidInputColorMetadata(metadata);
    assertValidRenderSettings(settings);
    if (settings.mode === 'identity-sdr') {
        return [ encodedRGB[0], encodedRGB[1], encodedRGB[2] ];
    }

    const decodedRGB = decodeEncodedRGBToNits(encodedRGB, metadata);
    const linearBT709RGB = convertLinearRGBGamut(decodedRGB, metadata.primaries, 'bt709');
    const toneMappedRGB = toneMapToSDR(linearBT709RGB, settings.toneMapping);
    const encodedOutputRGB = encodeSDROutput(
        toneMappedRGB,
        settings.toneMapping.outputPeakNits,
        settings.outputTransfer
    );
    return applyDisplayControls(encodedOutputRGB, settings.display);
}

/** Applies range, matrix, transfer, gamut, tone-map, and output stages to YUV. */
export function processEncodedYUV(
    encodedYUV: ColorTriplet,
    metadata: InputColorMetadata,
    settings: RenderSettings
): ColorTriplet {
    const expandedYUV = expandYUVRange(encodedYUV, metadata);
    const encodedRGB = convertYUVToEncodedRGB(expandedYUV, metadata.matrix);
    return processEncodedRGB(encodedRGB, metadata, settings);
}
