import type { HEVCNALFormat } from './DolbyVisionHEVCSplitter';
import { parseHEVCSEIMessages } from './HEVCSEI';
import {
    MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT,
    isStaticHDRMetadata,
    type StaticHDRMetadata,
    type StaticHDRMetadataScanResult
} from './StaticHDRMetadata';

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

/** Extracts bounded HDR10 static luminance metadata from one HEVC access unit. */
export function parseHEVCStaticHDRMetadata(
    accessUnit: Uint8Array,
    format: HEVCNALFormat
): StaticHDRMetadata | null {
    const metadata = createEmptyStaticHDRMetadata();
    const messages = parseHEVCSEIMessages(accessUnit, format);
    for (const message of messages) {
        switch (message.payloadType) {
            case MASTERING_DISPLAY_COLOUR_VOLUME_PAYLOAD_TYPE:
                parseMasteringDisplayPayload(message.payload, metadata);
                break;
            case CONTENT_LIGHT_LEVEL_INFORMATION_PAYLOAD_TYPE:
                parseContentLightPayload(message.payload, metadata);
                break;
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
