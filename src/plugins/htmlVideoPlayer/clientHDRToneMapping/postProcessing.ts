import {
    DEFAULT_BT2390_TONE_MAPPING_PARAMETERS,
    mapBT2390Luminance,
    normalizeBT2390ToneMappingParameters,
    type ClientHDRToneMappingPreset
} from './agtm';

const FULL_DESATURATION_STRENGTH = 100;
const CHROMA_RETENTION_EXPONENT = 1 / 8;
const MINIMUM_AUTOMATIC_SATURATION = 0.6;

/**
 * Derives a global CSS saturation value from the active tone-mapping curve.
 * The strength interpolates between unmodified chroma and the automatic value.
 */
export function calculateClientHDRToneMappingSaturation(
    preset: ClientHDRToneMappingPreset,
    bt2390Parameters: unknown,
    desaturationStrength: unknown
): number {
    if (preset === 'control') {
        return 1;
    }

    const toneMappingParameters = preset === 'bt2390' ?
        normalizeBT2390ToneMappingParameters(bt2390Parameters) :
        DEFAULT_BT2390_TONE_MAPPING_PARAMETERS;
    const mappedPeakNits = mapBT2390Luminance(
        toneMappingParameters.sourcePeakNits,
        toneMappingParameters
    );
    const peakGain = mappedPeakNits / toneMappingParameters.sourcePeakNits;
    const automaticSaturation = Math.max(
        peakGain ** CHROMA_RETENTION_EXPONENT,
        MINIMUM_AUTOMATIC_SATURATION
    );
    const normalizedStrength = normalizeDesaturationStrength(
        desaturationStrength
    ) / FULL_DESATURATION_STRENGTH;

    return 1 - normalizedStrength * (1 - automaticSaturation);
}

function normalizeDesaturationStrength(value: unknown): number {
    if (
        value === null
        || value === undefined
        || (typeof value === 'string' && value.trim() === '')
    ) {
        return FULL_DESATURATION_STRENGTH;
    }

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return FULL_DESATURATION_STRENGTH;
    }

    return Math.min(
        Math.max(numericValue, 0),
        FULL_DESATURATION_STRENGTH
    );
}
