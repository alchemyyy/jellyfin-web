import {
    parseHEVCNALUnits,
    type HEVCNALFormat,
    type HEVCNALUnit
} from './DolbyVisionHEVCSplitter';
import {
    MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT,
    isStaticHDRMetadata,
    type StaticHDRMetadata,
    type StaticHDRMetadataScanResult
} from './StaticHDRMetadata';

const HEVC_PREFIX_SEI_NAL_UNIT_TYPE = 39;
const HEVC_SUFFIX_SEI_NAL_UNIT_TYPE = 40;
const MASTERING_DISPLAY_COLOUR_VOLUME_PAYLOAD_TYPE = 137;
const CONTENT_LIGHT_LEVEL_INFORMATION_PAYLOAD_TYPE = 144;
const MASTERING_DISPLAY_PAYLOAD_BYTE_LENGTH = 24;
const CONTENT_LIGHT_PAYLOAD_BYTE_LENGTH = 4;
const MASTERING_LUMINANCE_SCALE = 10_000;

type MutableStaticHDRMetadata = {
    -readonly [Property in keyof StaticHDRMetadata]: StaticHDRMetadata[Property]
};

const STATIC_HDR_METADATA_PROPERTIES: readonly (keyof StaticHDRMetadata)[] = [
    'masteringDisplayMaximumLuminanceNits',
    'masteringDisplayMinimumLuminanceNits',
    'maximumContentLightLevelNits',
    'maximumFrameAverageLightLevelNits'
];

class HEVCStaticHDRMetadataConflictError extends TypeError {
    public constructor() {
        super('The HEVC access units contain conflicting static HDR metadata');
        // TypeScript's ES5 transform does not preserve built-in Error prototypes
        Object.setPrototypeOf(this, HEVCStaticHDRMetadataConflictError.prototype);
        this.name = 'HEVCStaticHDRMetadataConflictError';
    }
}

function createEmptyStaticHDRMetadata(): MutableStaticHDRMetadata {
    return {
        masteringDisplayMaximumLuminanceNits: null,
        masteringDisplayMinimumLuminanceNits: null,
        maximumContentLightLevelNits: null,
        maximumFrameAverageLightLevelNits: null
    };
}

function readUnsigned16(data: Uint8Array, offset: number): number {
    return (data[offset] * 256) + data[offset + 1];
}

function readUnsigned32(data: Uint8Array, offset: number): number {
    return (
        (data[offset] * 0x1000000)
        + (data[offset + 1] * 0x10000)
        + (data[offset + 2] * 0x100)
        + data[offset + 3]
    );
}

function removeEmulationPreventionBytes(data: Uint8Array): Uint8Array {
    const output: number[] = [];
    let zeroCount = 0;
    for (let byteIndex = 0; byteIndex < data.byteLength; byteIndex += 1) {
        const byteValue = data[byteIndex];
        if (zeroCount >= 2 && byteValue === 3) {
            if (byteIndex + 1 >= data.byteLength || data[byteIndex + 1] > 3) {
                throw new TypeError('The HEVC SEI has an invalid emulation-prevention byte');
            }
            zeroCount = 0;
            continue;
        }
        output.push(byteValue);
        zeroCount = byteValue === 0 ? zeroCount + 1 : 0;
    }
    return new Uint8Array(output);
}

function isRBSPTrailingBits(data: Uint8Array, offset: number): boolean {
    if (data[offset] !== 0x80) {
        return false;
    }
    for (let byteIndex = offset + 1; byteIndex < data.byteLength; byteIndex += 1) {
        if (data[byteIndex] !== 0) {
            return false;
        }
    }
    return true;
}

function readExtendedSEIValue(
    data: Uint8Array,
    startOffset: number
): { nextOffset: number, value: number } {
    let offset = startOffset;
    let value = 0;
    while (offset < data.byteLength && data[offset] === 0xFF) {
        value += 0xFF;
        offset += 1;
    }
    if (offset >= data.byteLength) {
        throw new TypeError('The HEVC SEI ends inside an extended value');
    }
    value += data[offset];
    return { nextOffset: offset + 1, value };
}

function mergeMetadataValue(
    metadata: MutableStaticHDRMetadata,
    property: keyof StaticHDRMetadata,
    value: number | null
): void {
    if (value === null) {
        return;
    }
    const previousValue = metadata[property];
    if (previousValue !== null && previousValue !== value) {
        throw new HEVCStaticHDRMetadataConflictError();
    }
    metadata[property] = value;
}

function mergeStaticHDRMetadata(
    destination: MutableStaticHDRMetadata,
    source: StaticHDRMetadata
): void {
    for (const property of STATIC_HDR_METADATA_PROPERTIES) {
        mergeMetadataValue(destination, property, source[property]);
    }
}

function parseMasteringDisplayPayload(
    payload: Uint8Array,
    metadata: MutableStaticHDRMetadata
): void {
    if (payload.byteLength !== MASTERING_DISPLAY_PAYLOAD_BYTE_LENGTH) {
        throw new TypeError('The HEVC mastering-display SEI payload size is invalid');
    }
    const maximumLuminanceNits = readUnsigned32(payload, 16) / MASTERING_LUMINANCE_SCALE;
    const minimumLuminanceNits = readUnsigned32(payload, 20) / MASTERING_LUMINANCE_SCALE;
    mergeMetadataValue(
        metadata,
        'masteringDisplayMaximumLuminanceNits',
        maximumLuminanceNits
    );
    mergeMetadataValue(
        metadata,
        'masteringDisplayMinimumLuminanceNits',
        minimumLuminanceNits
    );
}

function parseContentLightPayload(
    payload: Uint8Array,
    metadata: MutableStaticHDRMetadata
): void {
    if (payload.byteLength !== CONTENT_LIGHT_PAYLOAD_BYTE_LENGTH) {
        throw new TypeError('The HEVC content-light SEI payload size is invalid');
    }
    const maximumContentLightLevelNits = readUnsigned16(payload, 0);
    const maximumFrameAverageLightLevelNits = readUnsigned16(payload, 2);
    mergeMetadataValue(
        metadata,
        'maximumContentLightLevelNits',
        maximumContentLightLevelNits > 0 ? maximumContentLightLevelNits : null
    );
    mergeMetadataValue(
        metadata,
        'maximumFrameAverageLightLevelNits',
        maximumFrameAverageLightLevelNits > 0 ? maximumFrameAverageLightLevelNits : null
    );
}

function parseSEINALUnit(
    nalUnit: HEVCNALUnit,
    metadata: MutableStaticHDRMetadata
): void {
    if (nalUnit.data.byteLength < 3) {
        throw new TypeError('The HEVC SEI NAL unit is truncated');
    }
    const RBSP = removeEmulationPreventionBytes(nalUnit.data.subarray(2));
    let offset = 0;
    while (offset < RBSP.byteLength) {
        if (isRBSPTrailingBits(RBSP, offset)) {
            return;
        }
        const payloadType = readExtendedSEIValue(RBSP, offset);
        const payloadSize = readExtendedSEIValue(RBSP, payloadType.nextOffset);
        offset = payloadSize.nextOffset;
        if (payloadSize.value > RBSP.byteLength - offset) {
            throw new TypeError('The HEVC SEI payload exceeds its NAL unit');
        }
        const payload = RBSP.subarray(offset, offset + payloadSize.value);
        switch (payloadType.value) {
            case MASTERING_DISPLAY_COLOUR_VOLUME_PAYLOAD_TYPE:
                parseMasteringDisplayPayload(payload, metadata);
                break;
            case CONTENT_LIGHT_LEVEL_INFORMATION_PAYLOAD_TYPE:
                parseContentLightPayload(payload, metadata);
                break;
        }
        offset += payloadSize.value;
    }
}

/** Extracts bounded HDR10 static luminance metadata from one HEVC access unit. */
export function parseHEVCStaticHDRMetadata(
    accessUnit: Uint8Array,
    format: HEVCNALFormat
): StaticHDRMetadata | null {
    const metadata = createEmptyStaticHDRMetadata();
    const nalUnits = parseHEVCNALUnits(accessUnit, format);
    for (const nalUnit of nalUnits) {
        if (nalUnit.type === HEVC_PREFIX_SEI_NAL_UNIT_TYPE
            || nalUnit.type === HEVC_SUFFIX_SEI_NAL_UNIT_TYPE) {
            parseSEINALUnit(nalUnit, metadata);
        }
    }
    const hasMetadata = Object.values(metadata).some((value: number | null): boolean => (
        value !== null
    ));
    if (!hasMetadata) {
        return null;
    }
    if (!isStaticHDRMetadata(metadata)) {
        throw new TypeError('The HEVC access unit contains invalid static HDR metadata');
    }
    return metadata;
}

/** Scans a bounded startup prefix and rejects malformed or conflicting metadata. */
export function scanHEVCStaticHDRMetadata(
    accessUnits: readonly Uint8Array[],
    format: HEVCNALFormat
): StaticHDRMetadataScanResult {
    if (accessUnits.length > MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT) {
        throw new RangeError('The HEVC static HDR metadata scan exceeds its access-unit bound');
    }

    const metadata = createEmptyStaticHDRMetadata();
    let firstMetadataAccessUnitIndex: number | null = null;
    for (let accessUnitIndex = 0; accessUnitIndex < accessUnits.length; accessUnitIndex += 1) {
        let parsedMetadata: StaticHDRMetadata | null;
        try {
            parsedMetadata = parseHEVCStaticHDRMetadata(accessUnits[accessUnitIndex], format);
            if (!parsedMetadata) {
                continue;
            }
            mergeStaticHDRMetadata(metadata, parsedMetadata);
        } catch (error) {
            if (error instanceof HEVCStaticHDRMetadataConflictError) {
                return {
                    accessUnitCount: accessUnits.length,
                    firstMetadataAccessUnitIndex: null,
                    metadata: null,
                    status: 'conflicting'
                };
            }
            if (error instanceof TypeError) {
                return {
                    accessUnitCount: accessUnits.length,
                    firstMetadataAccessUnitIndex: null,
                    metadata: null,
                    status: 'malformed'
                };
            }
            throw error;
        }
        firstMetadataAccessUnitIndex ??= accessUnitIndex;
    }

    if (firstMetadataAccessUnitIndex === null) {
        return {
            accessUnitCount: accessUnits.length,
            firstMetadataAccessUnitIndex: null,
            metadata: null,
            status: 'absent'
        };
    }
    if (!isStaticHDRMetadata(metadata)) {
        return {
            accessUnitCount: accessUnits.length,
            firstMetadataAccessUnitIndex: null,
            metadata: null,
            status: 'malformed'
        };
    }
    return {
        accessUnitCount: accessUnits.length,
        firstMetadataAccessUnitIndex,
        metadata,
        status: 'valid'
    };
}
