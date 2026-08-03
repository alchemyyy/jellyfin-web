import {
    parseHEVCNALUnits,
    type HEVCNALFormat,
    type HEVCNALUnit
} from './DolbyVisionHEVCSplitter';

const HEVC_PREFIX_SEI_NAL_UNIT_TYPE = 39;
const HEVC_SUFFIX_SEI_NAL_UNIT_TYPE = 40;
const MAXIMUM_HEVC_SEI_MESSAGE_COUNT = 256;

export type HEVCSEIMessage = Readonly<{
    payload: Uint8Array
    payloadType: number
}>;

function removeEmulationPreventionBytes(data: Uint8Array): Uint8Array {
    const output = new Uint8Array(data.byteLength);
    let outputByteLength = 0;
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
        output[outputByteLength] = byteValue;
        outputByteLength += 1;
        zeroCount = byteValue === 0 ? zeroCount + 1 : 0;
    }
    return output.slice(0, outputByteLength);
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
    if (!Number.isSafeInteger(value)) {
        throw new TypeError('The HEVC SEI extended value exceeds its integer bound');
    }
    return { nextOffset: offset + 1, value };
}

function parseSEINALUnit(nalUnit: HEVCNALUnit): HEVCSEIMessage[] {
    if (nalUnit.data.byteLength < 3) {
        throw new TypeError('The HEVC SEI NAL unit is truncated');
    }
    const RBSP = removeEmulationPreventionBytes(nalUnit.data.subarray(2));
    const messages: HEVCSEIMessage[] = [];
    let offset = 0;
    while (offset < RBSP.byteLength) {
        if (isRBSPTrailingBits(RBSP, offset)) {
            return messages;
        }
        const payloadType = readExtendedSEIValue(RBSP, offset);
        const payloadSize = readExtendedSEIValue(RBSP, payloadType.nextOffset);
        offset = payloadSize.nextOffset;
        if (payloadSize.value > RBSP.byteLength - offset) {
            throw new TypeError('The HEVC SEI payload exceeds its NAL unit');
        }
        messages.push({
            payload: RBSP.subarray(offset, offset + payloadSize.value),
            payloadType: payloadType.value
        });
        if (messages.length > MAXIMUM_HEVC_SEI_MESSAGE_COUNT) {
            throw new TypeError('The HEVC SEI message count exceeds its bound');
        }
        offset += payloadSize.value;
    }
    throw new TypeError('The HEVC SEI NAL unit has no RBSP trailing bits');
}

/** Extracts bounded prefix and suffix SEI messages from one HEVC access unit. */
export function parseHEVCSEIMessages(
    accessUnit: Uint8Array,
    format: HEVCNALFormat
): HEVCSEIMessage[] {
    const messages: HEVCSEIMessage[] = [];
    const nalUnits = parseHEVCNALUnits(accessUnit, format);
    for (const nalUnit of nalUnits) {
        if (nalUnit.type === HEVC_PREFIX_SEI_NAL_UNIT_TYPE
            || nalUnit.type === HEVC_SUFFIX_SEI_NAL_UNIT_TYPE) {
            const nalUnitMessages = parseSEINALUnit(nalUnit);
            if (messages.length + nalUnitMessages.length
                > MAXIMUM_HEVC_SEI_MESSAGE_COUNT) {
                throw new TypeError('The HEVC SEI message count exceeds its bound');
            }
            messages.push(...nalUnitMessages);
        }
    }
    return messages;
}
