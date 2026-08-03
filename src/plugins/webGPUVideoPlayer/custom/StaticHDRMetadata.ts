const MAXIMUM_HDR_LUMINANCE_NITS = 10_000;
export const MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT = 16;

export type StaticHDRMetadataScanStatus =
    | 'absent'
    | 'conflicting'
    | 'malformed'
    | 'valid';

export type StaticHDRMetadata = {
    masteringDisplayMaximumLuminanceNits: number | null
    masteringDisplayMinimumLuminanceNits: number | null
    maximumContentLightLevelNits: number | null
    maximumFrameAverageLightLevelNits: number | null
};

export type StaticHDRMetadataScanResult = {
    accessUnitCount: number
    firstMetadataAccessUnitIndex: number | null
    metadata: StaticHDRMetadata | null
    status: StaticHDRMetadataScanStatus
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

/** Validates the bounded startup scan result received across a worker boundary. */
export function isStaticHDRMetadataScanResult(
    value: unknown
): value is StaticHDRMetadataScanResult {
    if (!value || typeof value !== 'object') {
        return false;
    }

    const result = value as Partial<StaticHDRMetadataScanResult>;
    if (!Number.isSafeInteger(result.accessUnitCount)
        || Number(result.accessUnitCount) < 0
        || Number(result.accessUnitCount) > MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT) {
        return false;
    }
    switch (result.status) {
        case 'valid':
            return isStaticHDRMetadata(result.metadata)
                && Object.values(result.metadata).some((luminanceNits: number | null): boolean => (
                    luminanceNits !== null
                ))
                && Number.isSafeInteger(result.firstMetadataAccessUnitIndex)
                && Number(result.firstMetadataAccessUnitIndex) >= 0
                && Number(result.firstMetadataAccessUnitIndex) < Number(result.accessUnitCount);
        case 'absent':
        case 'conflicting':
        case 'malformed':
            return result.metadata === null
                && result.firstMetadataAccessUnitIndex === null;
        default:
            return false;
    }
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
