import { describe, expect, it } from 'vitest';

import { parseHEVCStaticHDRMetadata } from './HEVCStaticHDRMetadata';
import type { HEVCNALFormat } from './DolbyVisionHEVCSplitter';

const PREFIX_SEI_NAL_UNIT_TYPE = 39;
const MASTERING_DISPLAY_PAYLOAD_TYPE = 137;
const CONTENT_LIGHT_PAYLOAD_TYPE = 144;

function appendExtendedValue(output: number[], value: number): void {
    let remainingValue = value;
    while (remainingValue >= 0xFF) {
        output.push(0xFF);
        remainingValue -= 0xFF;
    }
    output.push(remainingValue);
}

function addEmulationPreventionBytes(data: readonly number[]): number[] {
    const output: number[] = [];
    let zeroCount = 0;
    for (const byteValue of data) {
        if (zeroCount >= 2 && byteValue <= 3) {
            output.push(3);
            zeroCount = 0;
        }
        output.push(byteValue);
        zeroCount = byteValue === 0 ? zeroCount + 1 : 0;
    }
    return output;
}

function createMasteringDisplayPayload(maximumLuminanceNits: number): Uint8Array {
    const payload = new Uint8Array(24);
    const view = new DataView(payload.buffer);
    view.setUint32(16, Math.round(maximumLuminanceNits * 10_000));
    view.setUint32(20, 50);
    return payload;
}

function createContentLightPayload(
    maximumContentLightLevelNits: number,
    maximumFrameAverageLightLevelNits: number
): Uint8Array {
    const payload = new Uint8Array(4);
    const view = new DataView(payload.buffer);
    view.setUint16(0, maximumContentLightLevelNits);
    view.setUint16(2, maximumFrameAverageLightLevelNits);
    return payload;
}

function createSEINALUnit(
    maximumLuminanceNits: number,
    includeContentLight = true
): Uint8Array {
    const RBSP: number[] = [];
    const masteringPayload = createMasteringDisplayPayload(maximumLuminanceNits);
    appendExtendedValue(RBSP, MASTERING_DISPLAY_PAYLOAD_TYPE);
    appendExtendedValue(RBSP, masteringPayload.byteLength);
    RBSP.push(...masteringPayload);
    if (includeContentLight) {
        const contentLightPayload = createContentLightPayload(500, 200);
        appendExtendedValue(RBSP, CONTENT_LIGHT_PAYLOAD_TYPE);
        appendExtendedValue(RBSP, contentLightPayload.byteLength);
        RBSP.push(...contentLightPayload);
    }
    RBSP.push(0x80);
    return Uint8Array.from([
        PREFIX_SEI_NAL_UNIT_TYPE << 1,
        1,
        ...addEmulationPreventionBytes(RBSP)
    ]);
}

function encodeAccessUnit(
    nalUnits: readonly Uint8Array[],
    format: HEVCNALFormat
): Uint8Array {
    const output: number[] = [];
    for (const nalUnit of nalUnits) {
        switch (format.kind) {
            case 'annex-b':
                output.push(0, 0, 0, 1);
                break;
            case 'length-prefixed':
                for (let byteIndex = format.lengthSize - 1; byteIndex >= 0; byteIndex -= 1) {
                    output.push(Math.floor(
                        nalUnit.byteLength / (256 ** byteIndex)
                    ) % 256);
                }
                break;
        }
        output.push(...nalUnit);
    }
    return Uint8Array.from(output);
}

describe('parseHEVCStaticHDRMetadata', () => {
    it.each([
        { kind: 'annex-b' } as const,
        { kind: 'length-prefixed', lengthSize: 4 } as const
    ])('extracts exact HDR10 luminance from $kind access units', format => {
        expect(parseHEVCStaticHDRMetadata(
            encodeAccessUnit([ createSEINALUnit(4_000) ], format),
            format
        )).toEqual({
            masteringDisplayMaximumLuminanceNits: 4_000,
            masteringDisplayMinimumLuminanceNits: 0.005,
            maximumContentLightLevelNits: 500,
            maximumFrameAverageLightLevelNits: 200
        });
    });

    it('returns null when an access unit has no static HDR SEI', () => {
        const format: HEVCNALFormat = { kind: 'annex-b' };
        const videoNALUnit = Uint8Array.from([ 19 << 1, 1, 0x80 ]);
        expect(parseHEVCStaticHDRMetadata(
            encodeAccessUnit([ videoNALUnit ], format),
            format
        )).toBeNull();
    });

    it('rejects truncated and conflicting static metadata', () => {
        const format: HEVCNALFormat = { kind: 'annex-b' };
        const truncatedSEI = Uint8Array.from([
            PREFIX_SEI_NAL_UNIT_TYPE << 1,
            1,
            MASTERING_DISPLAY_PAYLOAD_TYPE,
            24,
            1,
            0x80
        ]);
        expect(() => parseHEVCStaticHDRMetadata(
            encodeAccessUnit([ truncatedSEI ], format),
            format
        )).toThrow('payload exceeds');
        expect(() => parseHEVCStaticHDRMetadata(encodeAccessUnit([
            createSEINALUnit(1_000, false),
            createSEINALUnit(4_000, false)
        ], format), format)).toThrow('conflicting static HDR metadata');
    });
});
