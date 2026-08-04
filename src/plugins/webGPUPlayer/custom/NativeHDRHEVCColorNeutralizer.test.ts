import { describe, expect, it } from 'vitest';

import {
    rewriteHEVCAccessUnitColorDescriptionToBT709,
    type HEVCNALFormat
} from './DolbyVisionHEVCSplitter';
import { parseHEVCDecoderConfiguration } from './HEVCSoftwareVideoDecoder';
import { parseHEVCSPS } from './HEVCSPSParser';
import {
    neutralizeNativeHDRHEVCDecoderConfig,
    rewriteHEVCDecoderDescriptionColorDescriptionToBT709
} from './NativeHDRHEVCColorNeutralizer';

function createBytesFromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
        bytes[byteIndex] = Number.parseInt(hex.slice(byteIndex * 2, (byteIndex * 2) + 2), 16);
    }
    return bytes;
}

const MAIN10_PQ_SPS = createBytesFromHex(
    '4201010220000003009000000300000300ffa005020169365959a4932bc05a848804820000030002000003000210'
);
const VPS = new Uint8Array([ 64, 1, 1 ]);
const PPS = new Uint8Array([ 68, 1, 2 ]);
const IDR = new Uint8Array([ 38, 1, 3 ]);

function appendNALUnitArray(
    descriptionBytes: number[],
    nalUnitType: number,
    nalUnits: readonly Uint8Array[]
): void {
    descriptionBytes.push(
        0x80 | nalUnitType,
        Math.floor(nalUnits.length / 256),
        nalUnits.length % 256
    );
    for (const nalUnit of nalUnits) {
        descriptionBytes.push(
            Math.floor(nalUnit.byteLength / 256),
            nalUnit.byteLength % 256
        );
        for (const byteValue of nalUnit) {
            descriptionBytes.push(byteValue);
        }
    }
}

function createHVCCDescription(includeSPS = true, spsCount = 1): Uint8Array {
    const descriptionBytes: number[] = new Array<number>(23).fill(0);
    descriptionBytes[0] = 1;
    descriptionBytes[1] = 2;
    descriptionBytes[16] = 1;
    descriptionBytes[17] = 2;
    descriptionBytes[18] = 2;
    descriptionBytes[21] = 3;
    descriptionBytes[22] = includeSPS ? 3 : 2;
    appendNALUnitArray(descriptionBytes, 32, [ VPS ]);
    if (includeSPS) {
        appendNALUnitArray(
            descriptionBytes,
            33,
            new Array<Uint8Array>(spsCount).fill(MAIN10_PQ_SPS)
        );
    }
    appendNALUnitArray(descriptionBytes, 34, [ PPS ]);
    return new Uint8Array(descriptionBytes);
}

function encodeAccessUnit(
    nalUnits: readonly Uint8Array[],
    format: HEVCNALFormat
): Uint8Array {
    const prefixByteLength = format.kind === 'annex-b' ? 4 : format.lengthSize;
    let byteLength = 0;
    for (const nalUnit of nalUnits) {
        byteLength += prefixByteLength + nalUnit.byteLength;
    }
    const output = new Uint8Array(byteLength);
    let outputOffset = 0;
    for (const nalUnit of nalUnits) {
        if (format.kind === 'annex-b') {
            output.set([ 0, 0, 0, 1 ], outputOffset);
        } else {
            let remainingLength = nalUnit.byteLength;
            for (let byteIndex = format.lengthSize - 1; byteIndex >= 0; byteIndex -= 1) {
                output[outputOffset + byteIndex] = remainingLength % 256;
                remainingLength = Math.floor(remainingLength / 256);
            }
        }
        outputOffset += prefixByteLength;
        output.set(nalUnit, outputOffset);
        outputOffset += nalUnit.byteLength;
    }
    return output;
}

function getFirstNALUnit(accessUnit: Uint8Array, format: HEVCNALFormat): Uint8Array {
    if (format.kind === 'length-prefixed') {
        let nalUnitByteLength = 0;
        for (let byteIndex = 0; byteIndex < format.lengthSize; byteIndex += 1) {
            nalUnitByteLength = (nalUnitByteLength * 256) + accessUnit[byteIndex];
        }
        return accessUnit.subarray(
            format.lengthSize,
            format.lengthSize + nalUnitByteLength
        );
    }
    for (let offset = 4; offset + 4 <= accessUnit.byteLength; offset += 1) {
        if (
            accessUnit[offset] === 0
            && accessUnit[offset + 1] === 0
            && accessUnit[offset + 2] === 0
            && accessUnit[offset + 3] === 1
        ) {
            return accessUnit.subarray(4, offset);
        }
    }
    throw new TypeError('The test access unit has no second Annex B start code');
}

describe('NativeHDRHEVCColorNeutralizer', () => {
    it('rebuilds HVCC while preserving non-SPS arrays and configuration fields', () => {
        const description = createHVCCDescription(true, 2);
        const rewritten = rewriteHEVCDecoderDescriptionColorDescriptionToBT709(description);
        const originalConfiguration = parseHEVCDecoderConfiguration(description);
        const rewrittenConfiguration = parseHEVCDecoderConfiguration(rewritten);

        expect(description).not.toEqual(rewritten);
        expect(rewrittenConfiguration).toMatchObject({
            bitDepth: originalConfiguration.bitDepth,
            chromaFormat: originalConfiguration.chromaFormat,
            lengthSize: originalConfiguration.lengthSize,
            profileIDC: originalConfiguration.profileIDC
        });
        expect(rewrittenConfiguration.sequenceParameterSets).toHaveLength(2);
        for (const sequenceParameterSet of rewrittenConfiguration.sequenceParameterSets) {
            expect(parseHEVCSPS(sequenceParameterSet).colorSpace).toEqual({
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            });
        }
        expect(rewriteHEVCDecoderDescriptionColorDescriptionToBT709(rewritten))
            .toEqual(rewritten);
        expect(() => rewriteHEVCDecoderDescriptionColorDescriptionToBT709(
            description,
            'hlg'
        )).toThrow('expected limited-range BT.2020 HDR route');
    });

    it('neutralizes config color metadata and an owned decoder description', () => {
        const description = createHVCCDescription();
        const configuration = neutralizeNativeHDRHEVCDecoderConfig({
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            description,
            hardwareAcceleration: 'prefer-hardware'
        }, 'pq');

        expect(configuration).toMatchObject({
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            hardwareAcceleration: 'prefer-hardware'
        });
        expect(configuration.description).not.toBe(description);
    });

    it('rewrites Annex B and length-prefixed in-band SPS units', () => {
        const formats: readonly HEVCNALFormat[] = [
            { kind: 'annex-b' },
            { kind: 'length-prefixed', lengthSize: 4 }
        ];
        for (const format of formats) {
            const accessUnit = encodeAccessUnit([ MAIN10_PQ_SPS, IDR ], format);
            const rewritten = rewriteHEVCAccessUnitColorDescriptionToBT709(
                accessUnit,
                format
            );

            expect(rewritten).not.toBeNull();
            expect(parseHEVCSPS(getFirstNALUnit(rewritten as Uint8Array, format)).colorSpace)
                .toEqual({
                    fullRange: false,
                    matrix: 'bt709',
                    primaries: 'bt709',
                    transfer: 'bt709'
                });
        }
    });

    it('reports absent SPS records and access units without rewriting unrelated data', () => {
        expect(() => rewriteHEVCDecoderDescriptionColorDescriptionToBT709(
            createHVCCDescription(false)
        )).toThrow('no SPS');
        expect(rewriteHEVCAccessUnitColorDescriptionToBT709(
            encodeAccessUnit([ IDR ], { kind: 'annex-b' }),
            { kind: 'annex-b' }
        )).toBeNull();
    });

    it('rejects malformed HVCC and length-prefixed NAL boundaries', () => {
        const trailingHVCC = new Uint8Array(createHVCCDescription().byteLength + 1);
        trailingHVCC.set(createHVCCDescription());
        expect(() => rewriteHEVCDecoderDescriptionColorDescriptionToBT709(trailingHVCC))
            .toThrow('trailing data');

        const truncatedHVCC = createHVCCDescription();
        const firstSPSLengthOffset = 34;
        truncatedHVCC[firstSPSLengthOffset] = 0xFF;
        truncatedHVCC[firstSPSLengthOffset + 1] = 0xFF;
        expect(() => rewriteHEVCDecoderDescriptionColorDescriptionToBT709(truncatedHVCC))
            .toThrow('invalid NAL unit');

        expect(() => rewriteHEVCAccessUnitColorDescriptionToBT709(
            new Uint8Array([ 0, 0, 0, 8, 66, 1 ]),
            { kind: 'length-prefixed', lengthSize: 4 }
        )).toThrow('invalid NAL unit length');
        expect(() => rewriteHEVCAccessUnitColorDescriptionToBT709(
            new Uint8Array([ 0, 0, 0, 1 ]),
            { kind: 'annex-b' }
        )).toThrow('missing its two-byte header');
    });
});
