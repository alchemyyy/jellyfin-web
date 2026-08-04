import { describe, expect, it } from 'vitest';

import { parseHEVCSEIMessages } from './HEVCSEI';

const ANNEX_B_START_CODE = [ 0, 0, 0, 1 ];

function appendExtendedValue(bytes: number[], value: number): void {
    let remainingValue = value;
    while (remainingValue >= 0xFF) {
        bytes.push(0xFF);
        remainingValue -= 0xFF;
    }
    bytes.push(remainingValue);
}

function addEmulationPreventionBytes(bytes: readonly number[]): number[] {
    const output: number[] = [];
    let zeroCount = 0;
    for (const byteValue of bytes) {
        if (zeroCount >= 2 && byteValue <= 3) {
            output.push(3);
            zeroCount = 0;
        }
        output.push(byteValue);
        zeroCount = byteValue === 0 ? zeroCount + 1 : 0;
    }
    return output;
}

function createSEIAccessUnit(
    nalUnitType: 39 | 40,
    payloadType: number,
    payload: readonly number[]
): Uint8Array {
    const RBSP: number[] = [];
    appendExtendedValue(RBSP, payloadType);
    appendExtendedValue(RBSP, payload.length);
    RBSP.push(...payload, 0x80);
    return Uint8Array.from([
        ...ANNEX_B_START_CODE,
        nalUnitType << 1,
        1,
        ...addEmulationPreventionBytes(RBSP)
    ]);
}

describe('parseHEVCSEIMessages', () => {
    it.each([ 39, 40 ] as const)(
        'extracts extended payload type and owned RBSP bytes from NAL type %i',
        nalUnitType => {
            const messages = parseHEVCSEIMessages(
                createSEIAccessUnit(nalUnitType, 300, [ 0, 0, 1, 3 ]),
                { kind: 'annex-b' }
            );

            expect(messages).toHaveLength(1);
            expect(messages[0].payloadType).toBe(300);
            expect(Array.from(messages[0].payload)).toEqual([ 0, 0, 1, 3 ]);
        }
    );

    it('rejects access units with an unbounded number of messages', () => {
        const RBSP: number[] = [];
        for (let messageIndex = 0; messageIndex < 257; messageIndex += 1) {
            RBSP.push(5, 0);
        }
        RBSP.push(0x80);
        const accessUnit = Uint8Array.from([
            ...ANNEX_B_START_CODE,
            39 << 1,
            1,
            ...addEmulationPreventionBytes(RBSP)
        ]);

        expect(() => parseHEVCSEIMessages(
            accessUnit,
            { kind: 'annex-b' }
        )).toThrow('message count exceeds');
    });

    it('rejects an invalid emulation-prevention sequence', () => {
        const accessUnit = Uint8Array.from([
            ...ANNEX_B_START_CODE,
            39 << 1,
            1,
            5,
            4,
            0,
            0,
            3,
            4,
            0x80
        ]);

        expect(() => parseHEVCSEIMessages(
            accessUnit,
            { kind: 'annex-b' }
        )).toThrow('invalid emulation-prevention');
    });

    it('rejects an SEI NAL unit without RBSP trailing bits', () => {
        const accessUnit = Uint8Array.from([
            ...ANNEX_B_START_CODE,
            39 << 1,
            1,
            5,
            1,
            0x7F
        ]);

        expect(() => parseHEVCSEIMessages(
            accessUnit,
            { kind: 'annex-b' }
        )).toThrow('no RBSP trailing bits');
    });
});
