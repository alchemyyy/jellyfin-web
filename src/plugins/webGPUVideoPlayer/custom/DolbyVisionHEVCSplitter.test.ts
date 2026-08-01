import { describe, expect, it } from 'vitest';

import {
    type HEVCNALFormat,
    splitDolbyVisionHEVCAccessUnit
} from './DolbyVisionHEVCSplitter';

function createNALUnit(type: number, payload: readonly number[]): Uint8Array {
    return new Uint8Array([ (type & 0x3F) << 1, 1, ...payload ]);
}

function encodeLengthPrefixedNALUnits(
    nalUnits: readonly Uint8Array[],
    lengthSize: 1 | 2 | 3 | 4
): Uint8Array {
    const byteLength = nalUnits.reduce(
        (totalByteLength: number, nalUnit: Uint8Array): number => (
            totalByteLength + lengthSize + nalUnit.byteLength
        ),
        0
    );
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const nalUnit of nalUnits) {
        let remainingLength = nalUnit.byteLength;
        for (let byteIndex = lengthSize - 1; byteIndex >= 0; byteIndex -= 1) {
            output[offset + byteIndex] = remainingLength % 256;
            remainingLength = Math.floor(remainingLength / 256);
        }
        offset += lengthSize;
        output.set(nalUnit, offset);
        offset += nalUnit.byteLength;
    }
    return output;
}

function encodeAnnexBNALUnits(nalUnits: readonly Uint8Array[]): Uint8Array {
    const startCode = new Uint8Array([ 0, 0, 0, 1 ]);
    const byteLength = nalUnits.reduce(
        (totalByteLength: number, nalUnit: Uint8Array): number => (
            totalByteLength + startCode.byteLength + nalUnit.byteLength
        ),
        0
    );
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const nalUnit of nalUnits) {
        output.set(startCode, offset);
        offset += startCode.byteLength;
        output.set(nalUnit, offset);
        offset += nalUnit.byteLength;
    }
    return output;
}

function decodeNALUnitTypes(data: Uint8Array | null, format: HEVCNALFormat): number[] {
    if (!data) {
        return [];
    }
    const types: number[] = [];
    let offset = 0;
    while (offset < data.byteLength) {
        let nalUnitOffset: number;
        let nalUnitByteLength: number;
        if (format.kind === 'annex-b') {
            expect(Array.from(data.subarray(offset, offset + 4))).toEqual([ 0, 0, 0, 1 ]);
            nalUnitOffset = offset + 4;
            const nextStartCodeOffset = data.findIndex((value: number, index: number): boolean => (
                index >= nalUnitOffset
                && value === 0
                && data[index + 1] === 0
                && data[index + 2] === 0
                && data[index + 3] === 1
            ));
            const nalUnitEnd = nextStartCodeOffset < 0 ? data.byteLength : nextStartCodeOffset;
            nalUnitByteLength = nalUnitEnd - nalUnitOffset;
        } else {
            nalUnitByteLength = 0;
            for (let byteIndex = 0; byteIndex < format.lengthSize; byteIndex += 1) {
                nalUnitByteLength = (nalUnitByteLength * 256) + data[offset + byteIndex];
            }
            nalUnitOffset = offset + format.lengthSize;
        }
        types.push((data[nalUnitOffset] >> 1) & 0x3F);
        offset = nalUnitOffset + nalUnitByteLength;
    }
    return types;
}

describe.each<1 | 2 | 3 | 4>([ 1, 2, 3, 4 ])(
    'DolbyVisionHEVCSplitter length size %i',
    lengthSize => {
        it('separates base-layer, RPU, and enhancement-layer NAL units', () => {
            const baseParameterSet = createNALUnit(32, [ 10 ]);
            const basePicture = createNALUnit(19, [ 11, 12 ]);
            const rpu = createNALUnit(62, [ 25, 8, 9, 13 ]);
            const enhancementPicture = createNALUnit(1, [ 14, 15 ]);
            const enhancementWrapper = createNALUnit(63, Array.from(enhancementPicture));
            const inputFormat = { kind: 'length-prefixed', lengthSize } as const;
            const result = splitDolbyVisionHEVCAccessUnit(
                encodeLengthPrefixedNALUnits([
                    baseParameterSet,
                    rpu,
                    basePicture,
                    enhancementWrapper
                ], lengthSize),
                inputFormat
            );

            expect(decodeNALUnitTypes(result.baseLayerData, inputFormat)).toEqual([ 32, 19 ]);
            expect(decodeNALUnitTypes(result.enhancementLayerData, inputFormat)).toEqual([ 1 ]);
            expect(result.hasBaseLayerVCL).toBe(true);
            expect(result.hasEnhancementLayerVCL).toBe(true);
            expect(result.rpuNALUnits).toHaveLength(1);
            expect(result.rpuNALUnits[0]).toEqual(rpu);
        });
    }
);

describe('DolbyVisionHEVCSplitter Annex B', () => {
    it('normalizes mixed start codes and can change the EL output format', () => {
        const basePicture = createNALUnit(1, [ 1 ]);
        const rpu = createNALUnit(62, [ 25, 8, 9 ]);
        const enhancementPicture = createNALUnit(20, [ 2 ]);
        const enhancementWrapper = createNALUnit(63, Array.from(enhancementPicture));
        const fourByteStartCode = new Uint8Array([ 0, 0, 0, 1 ]);
        const threeByteStartCode = new Uint8Array([ 0, 0, 1 ]);
        const packet = new Uint8Array(
            fourByteStartCode.byteLength + basePicture.byteLength
            + threeByteStartCode.byteLength + rpu.byteLength
            + fourByteStartCode.byteLength + enhancementWrapper.byteLength
        );
        let offset = 0;
        for (const [ startCode, nalUnit ] of [
            [ fourByteStartCode, basePicture ],
            [ threeByteStartCode, rpu ],
            [ fourByteStartCode, enhancementWrapper ]
        ] as const) {
            packet.set(startCode, offset);
            offset += startCode.byteLength;
            packet.set(nalUnit, offset);
            offset += nalUnit.byteLength;
        }

        const result = splitDolbyVisionHEVCAccessUnit(
            packet,
            { kind: 'annex-b' },
            { kind: 'length-prefixed', lengthSize: 2 }
        );

        expect(result.baseLayerData).toEqual(encodeAnnexBNALUnits([ basePicture ]));
        expect(decodeNALUnitTypes(
            result.enhancementLayerData,
            { kind: 'length-prefixed', lengthSize: 2 }
        )).toEqual([ 20 ]);
        expect(result.rpuNALUnits).toEqual([ rpu ]);
    });

    it('returns null for absent BL and EL data while preserving an owned RPU', () => {
        const rpu = createNALUnit(62, [ 25, 8, 9 ]);
        const packet = encodeAnnexBNALUnits([ rpu ]);
        const result = splitDolbyVisionHEVCAccessUnit(packet, { kind: 'annex-b' });
        packet.fill(0);

        expect(result.baseLayerData).toBeNull();
        expect(result.enhancementLayerData).toBeNull();
        expect(result.hasBaseLayerVCL).toBe(false);
        expect(result.hasEnhancementLayerVCL).toBe(false);
        expect(result.rpuNALUnits[0]).toEqual(rpu);
    });
});

describe('DolbyVisionHEVCSplitter validation', () => {
    it('rejects empty, truncated, and malformed access units', () => {
        expect(() => splitDolbyVisionHEVCAccessUnit(
            new Uint8Array(),
            { kind: 'annex-b' }
        )).toThrow('size is unsupported');
        expect(() => splitDolbyVisionHEVCAccessUnit(
            new Uint8Array([ 0, 0, 0, 5, 1, 2 ]),
            { kind: 'length-prefixed', lengthSize: 4 }
        )).toThrow('invalid NAL unit length');
        expect(() => splitDolbyVisionHEVCAccessUnit(
            encodeAnnexBNALUnits([ createNALUnit(63, [ 1 ]) ]),
            { kind: 'annex-b' }
        )).toThrow('two-byte header');
    });

    it('rejects NAL units that do not fit the requested output prefix', () => {
        const oversizedInnerNALUnit = createNALUnit(1, new Array<number>(254).fill(7));
        const wrapper = createNALUnit(63, Array.from(oversizedInnerNALUnit));

        expect(() => splitDolbyVisionHEVCAccessUnit(
            encodeLengthPrefixedNALUnits([ wrapper ], 2),
            { kind: 'length-prefixed', lengthSize: 2 },
            { kind: 'length-prefixed', lengthSize: 1 }
        )).toThrow('does not fit the output length field');
    });
});
