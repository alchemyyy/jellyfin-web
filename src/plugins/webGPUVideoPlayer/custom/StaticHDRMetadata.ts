const MAXIMUM_HDR_LUMINANCE_NITS = 10_000;

export type StaticHDRMetadata = {
    masteringDisplayMaximumLuminanceNits: number | null
    masteringDisplayMinimumLuminanceNits: number | null
    maximumContentLightLevelNits: number | null
    maximumFrameAverageLightLevelNits: number | null
};

function isNullableLuminance(
    value: unknown,
    allowZero: boolean
): value is number | null {
    return value === null || (
        typeof value === 'number'
        && Number.isFinite(value)
        && value >= (allowZero ? 0 : 1)
        && value <= MAXIMUM_HDR_LUMINANCE_NITS
    );
}

/** Validates bounded static HDR luminance metadata received across a worker boundary. */
export function isStaticHDRMetadata(value: unknown): value is StaticHDRMetadata {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const metadata = value as Partial<StaticHDRMetadata>;
    if (!isNullableLuminance(metadata.masteringDisplayMaximumLuminanceNits, false)
        || !isNullableLuminance(metadata.masteringDisplayMinimumLuminanceNits, true)
        || !isNullableLuminance(metadata.maximumContentLightLevelNits, false)
        || !isNullableLuminance(metadata.maximumFrameAverageLightLevelNits, false)) {
        return false;
    }
    return metadata.masteringDisplayMaximumLuminanceNits === null
        || metadata.masteringDisplayMinimumLuminanceNits === null
        || metadata.masteringDisplayMinimumLuminanceNits
            < metadata.masteringDisplayMaximumLuminanceNits;
}

/** Chooses the static source peak used by the bounded SDR tone-mapping curve. */
export function getStaticHDRToneMappingPeakNits(
    metadata: StaticHDRMetadata
): number | null {
    if (!isStaticHDRMetadata(metadata)) {
        throw new TypeError('Static HDR metadata is invalid');
    }
    return metadata.masteringDisplayMaximumLuminanceNits
        ?? metadata.maximumContentLightLevelNits;
}
