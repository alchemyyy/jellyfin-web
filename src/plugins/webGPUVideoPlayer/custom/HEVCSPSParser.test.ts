import { describe, expect, it } from 'vitest';

import { parseHEVCSPS } from './HEVCSPSParser';

function createBytesFromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
        bytes[byteIndex] = Number.parseInt(hex.slice(byteIndex * 2, (byteIndex * 2) + 2), 16);
    }
    return bytes;
}

const MAIN_SPS = createBytesFromHex(
    '42010101600000030090000003000003001ea020810596566924caf016a020202080000003008000000c04'
);
const MAIN10_PQ_SPS = createBytesFromHex(
    '4201010220000003009000000300000300ffa005020169365959a4932bc05a848804820000030002000003000210'
);
const MAIN10_HLG_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05a848904820000030002000003003010'
);
const UNSUPPORTED_COLOR_SPS = createBytesFromHex(
    '42010102200000030090000003000003003fa005020171f2b6595952930bc05a830303020000030002000003003010'
);
const LEVEL_5_1_4K_MAIN10_SPS = createBytesFromHex(
    '420101020000000080000000000099a001e020021c4d966ff089a848804800'
);
const LEVEL_5_1_OVERSIZED_DPB_SPS = createBytesFromHex(
    '420101020000000080000000000099a001e020021c4d967ff089a848804800'
);
const LEVEL_6_OVERSIZED_IMPLEMENTATION_DPB_SPS = createBytesFromHex(
    '4201010200000000800000000000b4a001e020021c4d967ff089a848804800'
);

describe('parseHEVCSPS', () => {
    it('parses a progressive Main Rec.709 SPS', () => {
        expect(parseHEVCSPS(MAIN_SPS)).toEqual({
            bitDepth: 8,
            chromaFormat: 1,
            codedHeight: 64,
            codedWidth: 64,
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            displayHeight: 64,
            displayWidth: 64,
            levelIDC: 30,
            maximumDPBPictureCount: 5,
            profileIDC: 1,
            progressive: true
        });
    });

    it('parses a progressive Main10 BT.2020 PQ SPS', () => {
        expect(parseHEVCSPS(MAIN10_PQ_SPS)).toEqual({
            bitDepth: 10,
            chromaFormat: 1,
            codedHeight: 360,
            codedWidth: 640,
            colorSpace: {
                fullRange: false,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: 'pq'
            },
            displayHeight: 360,
            displayWidth: 640,
            levelIDC: 255,
            maximumDPBPictureCount: 5,
            profileIDC: 2,
            progressive: true
        });
    });

    it('maps a progressive Main10 BT.2020 HLG SPS without aliases', () => {
        expect(parseHEVCSPS(MAIN10_HLG_SPS).colorSpace).toEqual({
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'hlg'
        });
    });

    it('accepts a six-picture 4K DPB within the Main10 Level 5.1 bound', () => {
        expect(parseHEVCSPS(LEVEL_5_1_4K_MAIN10_SPS)).toMatchObject({
            codedHeight: 2_160,
            codedWidth: 3_840,
            levelIDC: 153,
            maximumDPBPictureCount: 6
        });
    });

    it('rejects DPB declarations above the level and software memory budgets', () => {
        expect(() => parseHEVCSPS(LEVEL_5_1_OVERSIZED_DPB_SPS)).toThrow(
            'decoded picture buffer exceeds its level and picture-size bound'
        );
        expect(() => parseHEVCSPS(LEVEL_6_OVERSIZED_IMPLEMENTATION_DPB_SPS)).toThrow(
            'decoded picture buffer exceeds its level and picture-size bound'
        );
    });

    it('rejects interlaced constraints, truncated input, and oversized NAL units', () => {
        const interlacedSPS = MAIN10_PQ_SPS.slice();
        interlacedSPS[9] = 0x50;

        expect(() => parseHEVCSPS(interlacedSPS)).toThrow('not constrained to progressive');
        expect(() => parseHEVCSPS(MAIN10_PQ_SPS.subarray(0, 30))).toThrow('ends inside');
        expect(() => parseHEVCSPS(UNSUPPORTED_COLOR_SPS)).toThrow(
            'color description is unsupported'
        );
        expect(() => parseHEVCSPS(new Uint8Array((64 * 1024) + 1))).toThrow(
            'NAL unit header is invalid'
        );
    });
});
