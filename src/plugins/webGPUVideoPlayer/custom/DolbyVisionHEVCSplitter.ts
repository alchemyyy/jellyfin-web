const ANNEX_B_START_CODE = new Uint8Array([ 0, 0, 0, 1 ]);
const DOLBY_VISION_RPU_NAL_UNIT_TYPE = 62;
const DOLBY_VISION_ENHANCEMENT_WRAPPER_NAL_UNIT_TYPE = 63;
const MAXIMUM_ACCESS_UNIT_BYTE_LENGTH = 64 * 1_024 * 1_024;
const MAXIMUM_NAL_UNIT_COUNT = 4_096;
const MINIMUM_NAL_UNIT_BYTE_LENGTH = 2;

export type HEVCLengthSize = 1 | 2 | 3 | 4;
export type HEVCNALFormat =
    | { kind: 'annex-b' }
    | { kind: 'length-prefixed', lengthSize: HEVCLengthSize };

export type DolbyVisionHEVCSplitResult = {
    baseLayerData: Uint8Array | null
    enhancementLayerData: Uint8Array | null
    hasBaseLayerVCL: boolean
    hasEnhancementLayerVCL: boolean
    rpuNALUnits: readonly Uint8Array[]
};

type HEVCNALUnit = {
    data: Uint8Array
    type: number
};

function requireAccessUnit(data: Uint8Array): void {
    if (!(data instanceof Uint8Array)
        || data.byteLength === 0
        || data.byteLength > MAXIMUM_ACCESS_UNIT_BYTE_LENGTH) {
        throw new TypeError('The HEVC access unit size is unsupported');
    }
}

function getNALUnitType(data: Uint8Array): number {
    if (data.byteLength < MINIMUM_NAL_UNIT_BYTE_LENGTH) {
        throw new TypeError('An HEVC NAL unit is missing its two-byte header');
    }
    return (data[0] >> 1) & 0x3F;
}

function readNALUnitLength(
    data: Uint8Array,
    offset: number,
    lengthSize: HEVCLengthSize
): number {
    let byteLength = 0;
    for (let byteIndex = 0; byteIndex < lengthSize; byteIndex += 1) {
        byteLength = (byteLength * 256) + data[offset + byteIndex];
    }
    return byteLength;
}

function parseLengthPrefixedNALUnits(
    data: Uint8Array,
    lengthSize: HEVCLengthSize
): HEVCNALUnit[] {
    const nalUnits: HEVCNALUnit[] = [];
    let offset = 0;
    while (offset < data.byteLength) {
        if (nalUnits.length >= MAXIMUM_NAL_UNIT_COUNT) {
            throw new TypeError('The HEVC access unit contains too many NAL units');
        }
        if (offset + lengthSize > data.byteLength) {
            throw new TypeError('The HEVC access unit ends inside a NAL unit length');
        }
        const nalUnitByteLength = readNALUnitLength(data, offset, lengthSize);
        offset += lengthSize;
        if (nalUnitByteLength < MINIMUM_NAL_UNIT_BYTE_LENGTH
            || offset + nalUnitByteLength > data.byteLength) {
            throw new TypeError('The HEVC access unit contains an invalid NAL unit length');
        }
        const nalUnit = data.subarray(offset, offset + nalUnitByteLength);
        nalUnits.push({ data: nalUnit, type: getNALUnitType(nalUnit) });
        offset += nalUnitByteLength;
    }
    return nalUnits;
}

function findAnnexBStartCode(
    data: Uint8Array,
    startOffset: number
): { byteLength: 3 | 4, offset: number } | null {
    for (let offset = startOffset; offset + 3 <= data.byteLength; offset += 1) {
        if (data[offset] !== 0 || data[offset + 1] !== 0) {
            continue;
        }
        if (data[offset + 2] === 1) {
            return { byteLength: 3, offset };
        }
        if (offset + 4 <= data.byteLength
            && data[offset + 2] === 0
            && data[offset + 3] === 1) {
            return { byteLength: 4, offset };
        }
    }
    return null;
}

function parseAnnexBNALUnits(data: Uint8Array): HEVCNALUnit[] {
    const nalUnits: HEVCNALUnit[] = [];
    let startCode = findAnnexBStartCode(data, 0);
    if (!startCode) {
        throw new TypeError('The HEVC access unit has no Annex B start code');
    }
    for (let prefixIndex = 0; prefixIndex < startCode.offset; prefixIndex += 1) {
        if (data[prefixIndex] !== 0) {
            throw new TypeError('The HEVC access unit has data before its first start code');
        }
    }

    while (startCode) {
        if (nalUnits.length >= MAXIMUM_NAL_UNIT_COUNT) {
            throw new TypeError('The HEVC access unit contains too many NAL units');
        }
        const nalUnitOffset = startCode.offset + startCode.byteLength;
        const nextStartCode = findAnnexBStartCode(data, nalUnitOffset);
        const nalUnitEnd = nextStartCode?.offset ?? data.byteLength;
        const nalUnit = data.subarray(nalUnitOffset, nalUnitEnd);
        nalUnits.push({ data: nalUnit, type: getNALUnitType(nalUnit) });
        startCode = nextStartCode;
    }
    return nalUnits;
}

function parseNALUnits(data: Uint8Array, format: HEVCNALFormat): HEVCNALUnit[] {
    switch (format.kind) {
        case 'annex-b':
            return parseAnnexBNALUnits(data);
        case 'length-prefixed':
            return parseLengthPrefixedNALUnits(data, format.lengthSize);
    }
}

function getPrefixByteLength(format: HEVCNALFormat): number {
    return format.kind === 'annex-b' ?
        ANNEX_B_START_CODE.byteLength :
        format.lengthSize;
}

function getMaximumNALUnitByteLength(lengthSize: HEVCLengthSize): number {
    return (256 ** lengthSize) - 1;
}

function writeNALUnitLength(
    output: Uint8Array,
    offset: number,
    lengthSize: HEVCLengthSize,
    nalUnitByteLength: number
): void {
    let remainingLength = nalUnitByteLength;
    for (let byteIndex = lengthSize - 1; byteIndex >= 0; byteIndex -= 1) {
        output[offset + byteIndex] = remainingLength % 256;
        remainingLength = Math.floor(remainingLength / 256);
    }
}

function encodeNALUnits(
    nalUnits: readonly Uint8Array[],
    format: HEVCNALFormat
): Uint8Array | null {
    if (nalUnits.length === 0) {
        return null;
    }
    const prefixByteLength = getPrefixByteLength(format);
    let outputByteLength = 0;
    for (const nalUnit of nalUnits) {
        if (nalUnit.byteLength < MINIMUM_NAL_UNIT_BYTE_LENGTH) {
            throw new TypeError('An output HEVC NAL unit is missing its two-byte header');
        }
        if (format.kind === 'length-prefixed'
            && nalUnit.byteLength > getMaximumNALUnitByteLength(format.lengthSize)) {
            throw new TypeError('An HEVC NAL unit does not fit the output length field');
        }
        outputByteLength += prefixByteLength + nalUnit.byteLength;
        if (!Number.isSafeInteger(outputByteLength)
            || outputByteLength > MAXIMUM_ACCESS_UNIT_BYTE_LENGTH) {
            throw new TypeError('The split HEVC access unit exceeds its size bound');
        }
    }

    const output = new Uint8Array(outputByteLength);
    let outputOffset = 0;
    for (const nalUnit of nalUnits) {
        if (format.kind === 'annex-b') {
            output.set(ANNEX_B_START_CODE, outputOffset);
        } else {
            writeNALUnitLength(
                output,
                outputOffset,
                format.lengthSize,
                nalUnit.byteLength
            );
        }
        outputOffset += prefixByteLength;
        output.set(nalUnit, outputOffset);
        outputOffset += nalUnit.byteLength;
    }
    return output;
}

/** Separates BL, RPU, and wrapped EL NAL units without retaining packet views. */
export function splitDolbyVisionHEVCAccessUnit(
    data: Uint8Array,
    inputFormat: HEVCNALFormat,
    enhancementOutputFormat: HEVCNALFormat = inputFormat
): DolbyVisionHEVCSplitResult {
    requireAccessUnit(data);
    const nalUnits = parseNALUnits(data, inputFormat);
    const baseLayerNALUnits: Uint8Array[] = [];
    const enhancementLayerNALUnits: Uint8Array[] = [];
    const rpuNALUnits: Uint8Array[] = [];
    let hasBaseLayerVCL = false;
    let hasEnhancementLayerVCL = false;

    for (const nalUnit of nalUnits) {
        switch (nalUnit.type) {
            case DOLBY_VISION_RPU_NAL_UNIT_TYPE:
                rpuNALUnits.push(nalUnit.data.slice());
                break;
            case DOLBY_VISION_ENHANCEMENT_WRAPPER_NAL_UNIT_TYPE: {
                const enhancementLayerNALUnit = nalUnit.data.subarray(2);
                const enhancementLayerType = getNALUnitType(enhancementLayerNALUnit);
                hasEnhancementLayerVCL ||= enhancementLayerType <= 31;
                enhancementLayerNALUnits.push(enhancementLayerNALUnit);
                break;
            }
            default:
                hasBaseLayerVCL ||= nalUnit.type <= 31;
                baseLayerNALUnits.push(nalUnit.data);
                break;
        }
    }

    return {
        baseLayerData: encodeNALUnits(baseLayerNALUnits, inputFormat),
        enhancementLayerData: encodeNALUnits(
            enhancementLayerNALUnits,
            enhancementOutputFormat
        ),
        hasBaseLayerVCL,
        hasEnhancementLayerVCL,
        rpuNALUnits
    };
}
