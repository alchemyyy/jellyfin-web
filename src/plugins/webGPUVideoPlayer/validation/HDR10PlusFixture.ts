const HEVC_PREFIX_SEI_NAL_UNIT_TYPE = 39;
const HEVC_TRAIL_R_NAL_UNIT_TYPE = 1;
const USER_DATA_REGISTERED_ITU_T_T35_PAYLOAD_TYPE = 4;
const ANNEX_B_START_CODE = new Uint8Array([ 0, 0, 0, 1 ]);

export type HDR10PlusFixtureKind =
    | 'absent'
    | 'conflicting'
    | 'malformed'
    | 'unsupported'
    | 'valid';

class BitWriter {
    private readonly bits: number[] = [];

    public writeBits(value: number, bitCount: number): void {
        if (
            !Number.isSafeInteger(value)
            || value < 0
            || !Number.isSafeInteger(bitCount)
            || bitCount < 0
            || value >= 2 ** bitCount
        ) {
            throw new RangeError('The HDR10+ fixture bit field is invalid');
        }
        for (let bitIndex = bitCount - 1; bitIndex >= 0; bitIndex -= 1) {
            this.bits.push((value >> bitIndex) & 1);
        }
    }

    public finish(): Uint8Array {
        const output = new Uint8Array(Math.ceil(this.bits.length / 8));
        for (let bitIndex = 0; bitIndex < this.bits.length; bitIndex += 1) {
            output[Math.floor(bitIndex / 8)] |= this.bits[bitIndex]
                << (7 - (bitIndex % 8));
        }
        return output;
    }
}

function createApplicationPayload(maximumRedSCLNits: number, windowCount = 1): Uint8Array {
    const writer = new BitWriter();
    writer.writeBits(1, 8);
    writer.writeBits(windowCount, 2);
    for (let windowIndex = 1; windowIndex < windowCount; windowIndex += 1) {
        writer.writeBits(0, 16);
        writer.writeBits(0, 16);
        writer.writeBits(1_919, 16);
        writer.writeBits(1_079, 16);
        writer.writeBits(960, 16);
        writer.writeBits(540, 16);
        writer.writeBits(0, 8);
        writer.writeBits(100, 16);
        writer.writeBits(200, 16);
        writer.writeBits(100, 16);
        writer.writeBits(0, 1);
    }
    writer.writeBits(1_000, 27);
    writer.writeBits(0, 1);
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
        writer.writeBits(Math.round(maximumRedSCLNits * 10), 17);
        writer.writeBits(8_000, 17);
        writer.writeBits(5_000, 17);
        writer.writeBits(2_000, 17);
        writer.writeBits(2, 4);
        writer.writeBits(50, 7);
        writer.writeBits(1_000, 17);
        writer.writeBits(99, 7);
        writer.writeBits(9_000, 17);
        writer.writeBits(0, 10);
    }
    writer.writeBits(0, 1);
    for (let windowIndex = 0; windowIndex < windowCount; windowIndex += 1) {
        writer.writeBits(1, 1);
        writer.writeBits(2_048, 12);
        writer.writeBits(1_024, 12);
        writer.writeBits(2, 4);
        writer.writeBits(256, 10);
        writer.writeBits(768, 10);
        writer.writeBits(0, 1);
    }
    return writer.finish();
}

function createRegisteredPayload(
    maximumRedSCLNits: number,
    windowCount = 1
): Uint8Array {
    const applicationPayload = createApplicationPayload(maximumRedSCLNits, windowCount);
    const payload = new Uint8Array(6 + applicationPayload.byteLength);
    payload.set([ 0xB5, 0x00, 0x3C, 0x00, 0x01, 0x04 ]);
    payload.set(applicationPayload, 6);
    return payload;
}

function encodeExtendedSEIValue(value: number): number[] {
    const bytes: number[] = [];
    let remainingValue = value;
    while (remainingValue >= 0xFF) {
        bytes.push(0xFF);
        remainingValue -= 0xFF;
    }
    bytes.push(remainingValue);
    return bytes;
}

function addEmulationPreventionBytes(RBSP: Uint8Array): Uint8Array {
    const bytes: number[] = [];
    let zeroCount = 0;
    for (const byteValue of RBSP) {
        if (zeroCount >= 2 && byteValue <= 3) {
            bytes.push(3);
            zeroCount = 0;
        }
        bytes.push(byteValue);
        zeroCount = byteValue === 0 ? zeroCount + 1 : 0;
    }
    return new Uint8Array(bytes);
}

function createSEINALUnit(payloads: readonly Uint8Array[]): Uint8Array {
    const RBSPBytes: number[] = [];
    for (const payload of payloads) {
        RBSPBytes.push(...encodeExtendedSEIValue(
            USER_DATA_REGISTERED_ITU_T_T35_PAYLOAD_TYPE
        ));
        RBSPBytes.push(...encodeExtendedSEIValue(payload.byteLength));
        RBSPBytes.push(...payload);
    }
    RBSPBytes.push(0x80);
    const EBSP = addEmulationPreventionBytes(new Uint8Array(RBSPBytes));
    return new Uint8Array([
        HEVC_PREFIX_SEI_NAL_UNIT_TYPE << 1,
        1,
        ...EBSP
    ]);
}

function encodeAnnexBNALUnits(nalUnits: readonly Uint8Array[]): Uint8Array {
    const outputByteLength = nalUnits.reduce(
        (byteLength: number, nalUnit: Uint8Array): number => (
            byteLength + ANNEX_B_START_CODE.byteLength + nalUnit.byteLength
        ),
        0
    );
    const output = new Uint8Array(outputByteLength);
    let outputOffset = 0;
    for (const nalUnit of nalUnits) {
        output.set(ANNEX_B_START_CODE, outputOffset);
        outputOffset += ANNEX_B_START_CODE.byteLength;
        output.set(nalUnit, outputOffset);
        outputOffset += nalUnit.byteLength;
    }
    return output;
}

/** Creates one deterministic HEVC access unit for a dynamic-HDR validation state. */
export function createHDR10PlusHEVCFixture(kind: HDR10PlusFixtureKind): Uint8Array {
    const payloads: Uint8Array[] = [];
    switch (kind) {
        case 'absent':
            break;
        case 'conflicting':
            payloads.push(createRegisteredPayload(1_000));
            payloads.push(createRegisteredPayload(2_000));
            break;
        case 'malformed':
            payloads.push(new Uint8Array([ 0xB5, 0x00, 0x3C, 0x00, 0x01, 0x04 ]));
            break;
        case 'unsupported':
            payloads.push(createRegisteredPayload(1_000, 2));
            break;
        case 'valid':
            payloads.push(createRegisteredPayload(1_000));
            break;
    }
    const nalUnits: Uint8Array[] = [];
    if (payloads.length > 0) {
        nalUnits.push(createSEINALUnit(payloads));
    }
    nalUnits.push(new Uint8Array([
        HEVC_TRAIL_R_NAL_UNIT_TYPE << 1,
        1,
        0x80
    ]));
    return encodeAnnexBNALUnits(nalUnits);
}
