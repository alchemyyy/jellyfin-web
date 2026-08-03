import type { HEVCNALFormat } from './DolbyVisionHEVCSplitter';
import {
    parseHEVCSEIMessages,
    type HEVCSEIMessage
} from './HEVCSEI';

export const HDR10_PLUS_METADATA_SCHEMA_VERSION = 1;
export const MAXIMUM_HDR10_PLUS_PAYLOAD_BYTE_LENGTH = 907;
export const MAXIMUM_HDR10_PLUS_BEZIER_ANCHOR_COUNT = 15;

const USER_DATA_REGISTERED_ITU_T_T35_PAYLOAD_TYPE = 4;
const ITU_T_T35_COUNTRY_CODE_US = 0xB5;
const SAMSUNG_PROVIDER_CODE = 0x003C;
const HDR10_PLUS_PROVIDER_ORIENTED_CODE = 0x0001;
const HDR10_PLUS_APPLICATION_IDENTIFIER = 4;
const HDR10_PLUS_MAXIMUM_LUMINANCE_NITS = 10_000;
const HDR10_PLUS_LINEAR_RGB_SCALE = 10;
const HDR10_PLUS_KNEE_SCALE = 4_095;
const HDR10_PLUS_BEZIER_ANCHOR_SCALE = 1_023;
const BT2020_RED_LUMA = 0.2627;
const BT2020_GREEN_LUMA = 0.6780;
const BT2020_BLUE_LUMA = 0.0593;

export type HDR10PlusDistributionPercentile = Readonly<{
    percentage: number
    percentileNits: number
}>;

export type HDR10PlusToneMapping = Readonly<{
    bezierCurveAnchors: readonly number[]
    kneePointX: number
    kneePointY: number
}>;

export type HDR10PlusMetadata = Readonly<{
    applicationVersion: number
    averageMaxRGBNits: number
    distributionMaxRGB: readonly HDR10PlusDistributionPercentile[]
    maximumSCLNits: readonly [number, number, number]
    schemaVersion: typeof HDR10_PLUS_METADATA_SCHEMA_VERSION
    targetedSystemDisplayMaximumLuminanceNits: number
    toneMapping: HDR10PlusToneMapping | null
}>;

export type HDR10PlusFrameMetadataStatus =
    | 'absent'
    | 'conflicting'
    | 'malformed'
    | 'unsupported'
    | 'valid';

export type HDR10PlusFrameMetadata = Readonly<{
    metadata: HDR10PlusMetadata | null
    status: HDR10PlusFrameMetadataStatus
}>;

type HDR10PlusWindowMetadata = {
    averageMaxRGBNits: number
    distributionMaxRGB: HDR10PlusDistributionPercentile[]
    maximumSCLNits: [number, number, number]
    toneMapping: HDR10PlusToneMapping | null
};

type ParsedHDR10PlusPayload = {
    metadata: HDR10PlusMetadata
    supported: boolean
};

type HDR10PlusMessageParseResult =
    | { kind: 'ignored' }
    | { kind: 'malformed' }
    | { kind: 'parsed', payload: ParsedHDR10PlusPayload };

class BitReader {
    private bitOffset = 0;

    public constructor(private readonly data: Uint8Array) {}

    public readBits(bitCount: number): number {
        if (!Number.isSafeInteger(bitCount) || bitCount < 0 || bitCount > 31) {
            throw new RangeError('The HDR10+ bit count is unsupported');
        }
        if (bitCount > this.remainingBitCount) {
            throw new TypeError('The HDR10+ payload is truncated');
        }
        let value = 0;
        for (let bitIndex = 0; bitIndex < bitCount; bitIndex += 1) {
            const absoluteBitOffset = this.bitOffset + bitIndex;
            const byteValue = this.data[Math.floor(absoluteBitOffset / 8)];
            const bitValue = (byteValue >> (7 - (absoluteBitOffset % 8))) & 1;
            value = (value * 2) + bitValue;
        }
        this.bitOffset += bitCount;
        return value;
    }

    public skipBits(bitCount: number): void {
        if (!Number.isSafeInteger(bitCount) || bitCount < 0) {
            throw new RangeError('The HDR10+ skipped bit count is unsupported');
        }
        let remainingBitCount = bitCount;
        while (remainingBitCount > 0) {
            const chunkBitCount = Math.min(remainingBitCount, 31);
            this.readBits(chunkBitCount);
            remainingBitCount -= chunkBitCount;
        }
    }

    public requireZeroPadding(): void {
        if (this.remainingBitCount > 7) {
            throw new TypeError('The HDR10+ payload has trailing data');
        }
        if (this.readBits(this.remainingBitCount) !== 0) {
            throw new TypeError('The HDR10+ payload has non-zero padding');
        }
    }

    private get remainingBitCount(): number {
        return (this.data.byteLength * 8) - this.bitOffset;
    }
}

function readUnsigned16(data: Uint8Array, offset: number): number {
    return (data[offset] * 256) + data[offset + 1];
}

function skipPeakLuminanceGrid(reader: BitReader): void {
    const rowCount = reader.readBits(5);
    const columnCount = reader.readBits(5);
    if (rowCount < 2 || rowCount > 25 || columnCount < 2 || columnCount > 25) {
        throw new TypeError('The HDR10+ peak-luminance grid dimensions are invalid');
    }
    reader.skipBits(rowCount * columnCount * 4);
}

function skipWindowGeometry(reader: BitReader): void {
    const upperLeftX = reader.readBits(16);
    const upperLeftY = reader.readBits(16);
    const lowerRightX = reader.readBits(16);
    const lowerRightY = reader.readBits(16);
    reader.skipBits(16 * 2);
    const rotationAngle = reader.readBits(8);
    const internalSemimajorAxis = reader.readBits(16);
    const externalSemimajorAxis = reader.readBits(16);
    const externalSemiminorAxis = reader.readBits(16);
    reader.skipBits(1);
    if (
        upperLeftX > lowerRightX
        || upperLeftY > lowerRightY
        || rotationAngle > 180
        || internalSemimajorAxis === 0
        || externalSemimajorAxis < internalSemimajorAxis
        || externalSemiminorAxis === 0
    ) {
        throw new TypeError('The HDR10+ processing-window geometry is invalid');
    }
}

function parseWindowStatistics(reader: BitReader): HDR10PlusWindowMetadata {
    const maximumSCLNits: [number, number, number] = [
        reader.readBits(17) / HDR10_PLUS_LINEAR_RGB_SCALE,
        reader.readBits(17) / HDR10_PLUS_LINEAR_RGB_SCALE,
        reader.readBits(17) / HDR10_PLUS_LINEAR_RGB_SCALE
    ];
    if (maximumSCLNits.some((value: number): boolean => (
        value > HDR10_PLUS_MAXIMUM_LUMINANCE_NITS
    ))) {
        throw new TypeError('The HDR10+ MaxSCL value exceeds its range');
    }

    const averageMaxRGBNits = reader.readBits(17) / HDR10_PLUS_LINEAR_RGB_SCALE;
    if (averageMaxRGBNits > HDR10_PLUS_MAXIMUM_LUMINANCE_NITS) {
        throw new TypeError('The HDR10+ average MaxRGB value exceeds its range');
    }
    const distributionCount = reader.readBits(4);
    const distributionMaxRGB: HDR10PlusDistributionPercentile[] = [];
    let previousPercentage = -1;
    for (let percentileIndex = 0; percentileIndex < distributionCount; percentileIndex += 1) {
        const percentage = reader.readBits(7);
        const percentileNits = reader.readBits(17) / HDR10_PLUS_LINEAR_RGB_SCALE;
        if (
            percentage > 100
            || percentage <= previousPercentage
            || percentileNits > HDR10_PLUS_MAXIMUM_LUMINANCE_NITS
        ) {
            throw new TypeError('The HDR10+ MaxRGB distribution is invalid');
        }
        distributionMaxRGB.push({ percentage, percentileNits });
        previousPercentage = percentage;
    }
    if (reader.readBits(10) > 1_000) {
        throw new TypeError('The HDR10+ bright-pixel fraction exceeds its range');
    }

    return {
        averageMaxRGBNits,
        distributionMaxRGB,
        maximumSCLNits,
        toneMapping: null
    };
}

function parseWindowToneMapping(
    reader: BitReader,
    window: HDR10PlusWindowMetadata
): boolean {
    if (reader.readBits(1) === 1) {
        const kneePointXValue = reader.readBits(12);
        const kneePointYValue = reader.readBits(12);
        const anchorCount = reader.readBits(4);
        const bezierCurveAnchors: number[] = [];
        for (let anchorIndex = 0; anchorIndex < anchorCount; anchorIndex += 1) {
            bezierCurveAnchors.push(
                reader.readBits(10) / HDR10_PLUS_BEZIER_ANCHOR_SCALE
            );
        }
        window.toneMapping = anchorCount > 0 ? {
            bezierCurveAnchors,
            kneePointX: kneePointXValue / HDR10_PLUS_KNEE_SCALE,
            kneePointY: kneePointYValue / HDR10_PLUS_KNEE_SCALE
        } : null;
    }

    const hasReservedSaturationMapping = reader.readBits(1) === 1;
    if (hasReservedSaturationMapping) {
        reader.skipBits(6);
    }
    return !hasReservedSaturationMapping;
}

function parseHDR10PlusPayload(payload: Uint8Array): ParsedHDR10PlusPayload {
    if (
        payload.byteLength === 0
        || payload.byteLength > MAXIMUM_HDR10_PLUS_PAYLOAD_BYTE_LENGTH
    ) {
        throw new TypeError('The HDR10+ payload size is unsupported');
    }
    const reader = new BitReader(payload);
    const applicationVersion = reader.readBits(8);
    const windowCount = reader.readBits(2);
    if (windowCount < 1 || windowCount > 3) {
        throw new TypeError('The HDR10+ processing-window count is invalid');
    }
    for (let windowIndex = 1; windowIndex < windowCount; windowIndex += 1) {
        skipWindowGeometry(reader);
    }

    const targetedSystemDisplayMaximumLuminanceNits = reader.readBits(27);
    if (
        targetedSystemDisplayMaximumLuminanceNits < 1
        || targetedSystemDisplayMaximumLuminanceNits
            > HDR10_PLUS_MAXIMUM_LUMINANCE_NITS
    ) {
        throw new TypeError('The HDR10+ targeted display luminance is invalid');
    }
    const hasTargetedPeakLuminanceGrid = reader.readBits(1) === 1;
    if (hasTargetedPeakLuminanceGrid) {
        skipPeakLuminanceGrid(reader);
    }

    const windows: HDR10PlusWindowMetadata[] = [];
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
        windows.push(parseWindowStatistics(reader));
    }
    const hasMasteringPeakLuminanceGrid = reader.readBits(1) === 1;
    if (hasMasteringPeakLuminanceGrid) {
        skipPeakLuminanceGrid(reader);
    }

    let usesSupportedToneMapping = true;
    for (const window of windows) {
        usesSupportedToneMapping &&= parseWindowToneMapping(reader, window);
    }
    reader.requireZeroPadding();

    const primaryWindow = windows[0];
    return {
        metadata: {
            applicationVersion,
            averageMaxRGBNits: primaryWindow.averageMaxRGBNits,
            distributionMaxRGB: primaryWindow.distributionMaxRGB,
            maximumSCLNits: primaryWindow.maximumSCLNits,
            schemaVersion: HDR10_PLUS_METADATA_SCHEMA_VERSION,
            targetedSystemDisplayMaximumLuminanceNits,
            toneMapping: primaryWindow.toneMapping
        },
        supported: applicationVersion <= 1
            && windowCount === 1
            && !hasTargetedPeakLuminanceGrid
            && !hasMasteringPeakLuminanceGrid
            && usesSupportedToneMapping
    };
}

function tryParseRegisteredHDR10PlusPayload(
    payload: Uint8Array
): ParsedHDR10PlusPayload | null {
    if (payload.byteLength < 3 || payload[0] !== ITU_T_T35_COUNTRY_CODE_US) {
        return null;
    }
    if (readUnsigned16(payload, 1) !== SAMSUNG_PROVIDER_CODE) {
        return null;
    }
    if (payload.byteLength < 6) {
        throw new TypeError('The HDR10+ ITU-T T.35 header is truncated');
    }
    if (
        readUnsigned16(payload, 3) !== HDR10_PLUS_PROVIDER_ORIENTED_CODE
        || payload[5] !== HDR10_PLUS_APPLICATION_IDENTIFIER
    ) {
        return null;
    }
    return parseHDR10PlusPayload(payload.subarray(6));
}

function metadataEqual(first: HDR10PlusMetadata, second: HDR10PlusMetadata): boolean {
    return JSON.stringify(first) === JSON.stringify(second);
}

function isMetadataSyntaxError(error: unknown): error is RangeError | TypeError {
    return error instanceof TypeError || error instanceof RangeError;
}

function parseHDR10PlusSEIMessage(message: HEVCSEIMessage): HDR10PlusMessageParseResult {
    if (message.payloadType !== USER_DATA_REGISTERED_ITU_T_T35_PAYLOAD_TYPE) {
        return { kind: 'ignored' };
    }
    try {
        const payload = tryParseRegisteredHDR10PlusPayload(message.payload);
        return payload ? { kind: 'parsed', payload } : { kind: 'ignored' };
    } catch (error) {
        if (isMetadataSyntaxError(error)) {
            return { kind: 'malformed' };
        }
        throw error;
    }
}

/** Parses one frame's ST 2094-40 metadata without retaining access-unit views. */
export function parseHEVCHDR10PlusMetadata(
    accessUnit: Uint8Array,
    format: HEVCNALFormat
): HDR10PlusFrameMetadata {
    const parsedPayloads: ParsedHDR10PlusPayload[] = [];
    let malformed = false;
    try {
        for (const message of parseHEVCSEIMessages(accessUnit, format)) {
            const result = parseHDR10PlusSEIMessage(message);
            switch (result.kind) {
                case 'ignored':
                    break;
                case 'malformed':
                    malformed = true;
                    break;
                case 'parsed':
                    parsedPayloads.push(result.payload);
                    break;
            }
        }
    } catch (error) {
        if (isMetadataSyntaxError(error)) {
            return { metadata: null, status: 'malformed' };
        }
        throw error;
    }

    if (malformed) {
        return { metadata: null, status: 'malformed' };
    }
    if (parsedPayloads.length === 0) {
        return { metadata: null, status: 'absent' };
    }
    const firstPayload = parsedPayloads[0];
    if (parsedPayloads.some((payload: ParsedHDR10PlusPayload): boolean => (
        !metadataEqual(firstPayload.metadata, payload.metadata)
    ))) {
        return { metadata: null, status: 'conflicting' };
    }
    if (parsedPayloads.some((payload: ParsedHDR10PlusPayload): boolean => (
        !payload.supported
    ))) {
        return { metadata: null, status: 'unsupported' };
    }
    return { metadata: firstPayload.metadata, status: 'valid' };
}

function isFiniteRange(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value >= minimum
        && value <= maximum;
}

function isHDR10PlusDistribution(
    value: unknown
): value is readonly HDR10PlusDistributionPercentile[] {
    if (!Array.isArray(value) || value.length > 15) {
        return false;
    }
    let previousPercentage = -1;
    for (const entryValue of value) {
        if (!entryValue || typeof entryValue !== 'object') {
            return false;
        }
        const entry = entryValue as Partial<HDR10PlusDistributionPercentile>;
        if (
            !Number.isSafeInteger(entry.percentage)
            || !isFiniteRange(entry.percentage, 0, 100)
            || entry.percentage <= previousPercentage
            || !isFiniteRange(entry.percentileNits, 0, HDR10_PLUS_MAXIMUM_LUMINANCE_NITS)
        ) {
            return false;
        }
        previousPercentage = entry.percentage;
    }
    return true;
}

function isHDR10PlusToneMapping(value: unknown): value is HDR10PlusToneMapping | null {
    if (value === null) {
        return true;
    }
    if (!value || typeof value !== 'object') {
        return false;
    }
    const toneMapping = value as Partial<HDR10PlusToneMapping>;
    return isFiniteRange(toneMapping.kneePointX, 0, 1)
        && isFiniteRange(toneMapping.kneePointY, 0, 1)
        && Array.isArray(toneMapping.bezierCurveAnchors)
        && toneMapping.bezierCurveAnchors.length > 0
        && toneMapping.bezierCurveAnchors.length
            <= MAXIMUM_HDR10_PLUS_BEZIER_ANCHOR_COUNT
        && toneMapping.bezierCurveAnchors.every((anchor: unknown): boolean => (
            isFiniteRange(anchor, 0, 1)
        ));
}

/** Validates dynamic HDR10+ metadata received across a worker boundary. */
export function isHDR10PlusMetadata(value: unknown): value is HDR10PlusMetadata {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const metadata = value as Partial<HDR10PlusMetadata>;
    if (
        metadata.schemaVersion !== HDR10_PLUS_METADATA_SCHEMA_VERSION
        || !Number.isSafeInteger(metadata.applicationVersion)
        || !isFiniteRange(metadata.applicationVersion, 0, 1)
        || !isFiniteRange(metadata.averageMaxRGBNits, 0, HDR10_PLUS_MAXIMUM_LUMINANCE_NITS)
        || !isFiniteRange(
            metadata.targetedSystemDisplayMaximumLuminanceNits,
            1,
            HDR10_PLUS_MAXIMUM_LUMINANCE_NITS
        )
        || !Array.isArray(metadata.maximumSCLNits)
        || metadata.maximumSCLNits.length !== 3
        || !metadata.maximumSCLNits.every((entry: unknown): boolean => (
            isFiniteRange(entry, 0, HDR10_PLUS_MAXIMUM_LUMINANCE_NITS)
        ))
        || !isHDR10PlusDistribution(metadata.distributionMaxRGB)
        || !isHDR10PlusToneMapping(metadata.toneMapping)
    ) {
        return false;
    }
    return true;
}

/** Validates a per-frame HDR10+ parser result received across a worker boundary. */
export function isHDR10PlusFrameMetadata(value: unknown): value is HDR10PlusFrameMetadata {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const frameMetadata = value as Partial<HDR10PlusFrameMetadata>;
    switch (frameMetadata.status) {
        case 'valid':
            return isHDR10PlusMetadata(frameMetadata.metadata);
        case 'absent':
        case 'conflicting':
        case 'malformed':
        case 'unsupported':
            return frameMetadata.metadata === null;
        default:
            return false;
    }
}

/** Resolves FFmpeg-compatible whole-frame HDR10+ peak and average luminance. */
export function getHDR10PlusSceneLuminance(metadata: HDR10PlusMetadata): Readonly<{
    averageNits: number | null
    peakNits: number | null
}> {
    if (!isHDR10PlusMetadata(metadata)) {
        return { averageNits: null, peakNits: null };
    }
    const maximumRGBNits = Math.max(...metadata.maximumSCLNits);
    if (maximumRGBNits > 0) {
        const peakNits = (metadata.maximumSCLNits[0] * BT2020_RED_LUMA)
            + (metadata.maximumSCLNits[1] * BT2020_GREEN_LUMA)
            + (metadata.maximumSCLNits[2] * BT2020_BLUE_LUMA);
        const averageNits = metadata.averageMaxRGBNits * peakNits / maximumRGBNits;
        return {
            averageNits: averageNits > 0 ? averageNits : null,
            peakNits: peakNits > 0 ? peakNits : null
        };
    }

    let peakNits = 0;
    for (const distribution of metadata.distributionMaxRGB) {
        peakNits = Math.max(peakNits, distribution.percentileNits);
    }
    return {
        averageNits: metadata.averageMaxRGBNits > 0 ? metadata.averageMaxRGBNits : null,
        peakNits: peakNits > 0 ? peakNits : null
    };
}
