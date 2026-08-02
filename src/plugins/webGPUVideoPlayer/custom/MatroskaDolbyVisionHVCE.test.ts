import { describe, expect, it, vi } from 'vitest';

import {
    readMatroskaDolbyVisionHVCE,
    type MatroskaByteRangeReader
} from './MatroskaDolbyVisionHVCE';

const EBML_ID = 0x1A45_DFA3;
const SEGMENT_ID = 0x1853_8067;
const TRACKS_ID = 0x1654_AE6B;
const TRACK_ENTRY_ID = 0xAE;
const TRACK_NUMBER_ID = 0xD7;
const TRACK_TYPE_ID = 0x83;
const CODEC_ID = 0x86;
const BLOCK_ADDITION_MAPPING_ID = 0x41E4;
const BLOCK_ADD_ID_TYPE_ID = 0x41E7;
const BLOCK_ADD_ID_EXTRA_DATA_ID = 0x41ED;
const VOID_ID = 0xEC;
const VIDEO_TRACK_TYPE = 1;
const AUDIO_TRACK_TYPE = 2;
const DVCC_BLOCK_ADD_ID_TYPE = 0x6476_6343;
const HVCE_BLOCK_ADD_ID_TYPE = 0x6876_6345;

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
    const byteLength = parts.reduce(
        (totalByteLength: number, part: Uint8Array): number => totalByteLength + part.byteLength,
        0
    );
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

function encodeElementID(id: number): Uint8Array {
    let byteLength = 1;
    while (id >= 256 ** byteLength) {
        byteLength += 1;
    }
    const output = new Uint8Array(byteLength);
    let remainingValue = id;
    for (let byteIndex = byteLength - 1; byteIndex >= 0; byteIndex -= 1) {
        output[byteIndex] = remainingValue % 256;
        remainingValue = Math.floor(remainingValue / 256);
    }
    return output;
}

function encodeElementSize(byteLength: number): Uint8Array {
    for (let encodedByteLength = 1; encodedByteLength <= 8; encodedByteLength += 1) {
        const maximumValue = (2 ** (7 * encodedByteLength)) - 2;
        if (byteLength > maximumValue) {
            continue;
        }
        let encodedValue = byteLength + (2 ** (7 * encodedByteLength));
        const output = new Uint8Array(encodedByteLength);
        for (let byteIndex = encodedByteLength - 1; byteIndex >= 0; byteIndex -= 1) {
            output[byteIndex] = encodedValue % 256;
            encodedValue = Math.floor(encodedValue / 256);
        }
        return output;
    }
    throw new RangeError('The synthetic EBML element is too large');
}

function createElement(id: number, payload: Uint8Array): Uint8Array {
    return concatenate([
        encodeElementID(id),
        encodeElementSize(payload.byteLength),
        payload
    ]);
}

function createUnsignedIntegerElement(id: number, value: number): Uint8Array {
    const bytes: number[] = [];
    let remainingValue = value;
    do {
        bytes.unshift(remainingValue % 256);
        remainingValue = Math.floor(remainingValue / 256);
    } while (remainingValue > 0);
    return createElement(id, new Uint8Array(bytes));
}

function createASCIIElement(id: number, value: string): Uint8Array {
    return createElement(
        id,
        new Uint8Array(Array.from(value, (character: string): number => character.charCodeAt(0)))
    );
}

function createBlockAdditionMapping(type: number, extraData: Uint8Array): Uint8Array {
    return createElement(BLOCK_ADDITION_MAPPING_ID, concatenate([
        createUnsignedIntegerElement(BLOCK_ADD_ID_TYPE_ID, type),
        createElement(BLOCK_ADD_ID_EXTRA_DATA_ID, extraData)
    ]));
}

type SyntheticTrackOptions = {
    codecID?: string
    mappings?: readonly Uint8Array[]
    number: number
    type?: number
};

function createTrack(options: SyntheticTrackOptions): Uint8Array {
    return createElement(TRACK_ENTRY_ID, concatenate([
        createUnsignedIntegerElement(TRACK_NUMBER_ID, options.number),
        createUnsignedIntegerElement(TRACK_TYPE_ID, options.type ?? VIDEO_TRACK_TYPE),
        createASCIIElement(CODEC_ID, options.codecID ?? 'V_MPEGH/ISO/HEVC'),
        ...(options.mappings ?? [])
    ]));
}

function createMatroska(
    tracks: readonly Uint8Array[],
    options: { segmentPrefix?: Uint8Array; unknownSegmentSize?: boolean } = {}
): Uint8Array {
    const segmentPayload = concatenate([
        options.segmentPrefix ?? new Uint8Array(0),
        createElement(TRACKS_ID, concatenate(tracks))
    ]);
    const segment = options.unknownSegmentSize ?
        concatenate([
            encodeElementID(SEGMENT_ID),
            new Uint8Array([ 0x01, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF ]),
            segmentPayload
        ]) :
        createElement(SEGMENT_ID, segmentPayload);
    return concatenate([
        createElement(EBML_ID, new Uint8Array(0)),
        segment
    ]);
}

function createReader(data: Uint8Array): MatroskaByteRangeReader {
    return vi.fn(async (offset: number, byteLength: number): Promise<Uint8Array | null> => {
        if (offset >= data.byteLength) {
            return null;
        }
        return data.slice(offset, Math.min(data.byteLength, offset + byteLength));
    });
}

function createHVCE(seed = 0x30): Uint8Array {
    const data = new Uint8Array(187);
    data[0] = 1;
    for (let byteIndex = 1; byteIndex < data.byteLength; byteIndex += 1) {
        data[byteIndex] = (seed + byteIndex) & 0xFF;
    }
    return data;
}

describe('readMatroskaDolbyVisionHVCE', () => {
    it('extracts hvcE from the selected Matroska HEVC video track', async () => {
        const selectedHVCE = createHVCE();
        const otherHVCE = createHVCE(0x70);
        const data = createMatroska([
            createTrack({
                mappings: [ createBlockAdditionMapping(HVCE_BLOCK_ADD_ID_TYPE, otherHVCE) ],
                number: 1
            }),
            createTrack({
                mappings: [
                    createBlockAdditionMapping(DVCC_BLOCK_ADD_ID_TYPE, new Uint8Array(24)),
                    createBlockAdditionMapping(HVCE_BLOCK_ADD_ID_TYPE, selectedHVCE)
                ],
                number: 2
            })
        ]);

        const result = await readMatroskaDolbyVisionHVCE(createReader(data), 2);

        expect(result).toEqual(selectedHVCE);
        expect(result).not.toBe(selectedHVCE);
    });

    it('supports an unknown-size segment and skips bounded metadata before Tracks', async () => {
        const selectedHVCE = createHVCE();
        const reader = createReader(createMatroska([
            createTrack({
                mappings: [ createBlockAdditionMapping(HVCE_BLOCK_ADD_ID_TYPE, selectedHVCE) ],
                number: 7
            })
        ], {
            segmentPrefix: createElement(VOID_ID, new Uint8Array(4_097)),
            unknownSegmentSize: true
        }));

        await expect(readMatroskaDolbyVisionHVCE(reader, 7)).resolves.toEqual(selectedHVCE);
        expect(reader).toHaveBeenCalledWith(expect.any(Number), 12);
    });

    it.each([
        {
            label: 'different selected track',
            selectedTrackNumber: 2,
            tracks: [ createTrack({ number: 1 }) ]
        },
        {
            label: 'audio track',
            selectedTrackNumber: 1,
            tracks: [ createTrack({
                mappings: [ createBlockAdditionMapping(HVCE_BLOCK_ADD_ID_TYPE, createHVCE()) ],
                number: 1,
                type: AUDIO_TRACK_TYPE
            }) ]
        },
        {
            label: 'non-HEVC video track',
            selectedTrackNumber: 1,
            tracks: [ createTrack({
                codecID: 'V_AV1',
                mappings: [ createBlockAdditionMapping(HVCE_BLOCK_ADD_ID_TYPE, createHVCE()) ],
                number: 1
            }) ]
        },
        {
            label: 'no hvcE mapping',
            selectedTrackNumber: 1,
            tracks: [ createTrack({
                mappings: [ createBlockAdditionMapping(DVCC_BLOCK_ADD_ID_TYPE, new Uint8Array(24)) ],
                number: 1
            }) ]
        }
    ])('returns null for $label', async ({ selectedTrackNumber, tracks }) => {
        const result = await readMatroskaDolbyVisionHVCE(
            createReader(createMatroska(tracks)),
            selectedTrackNumber
        );

        expect(result).toBeNull();
    });

    it('rejects duplicate hvcE mappings without exposing either record', async () => {
        const data = createMatroska([
            createTrack({
                mappings: [
                    createBlockAdditionMapping(HVCE_BLOCK_ADD_ID_TYPE, createHVCE()),
                    createBlockAdditionMapping(HVCE_BLOCK_ADD_ID_TYPE, createHVCE(0x70))
                ],
                number: 1
            })
        ]);

        await expect(readMatroskaDolbyVisionHVCE(createReader(data), 1)).resolves.toBeNull();
    });

    it('rejects a duplicated selected track number even when only one entry has hvcE', async () => {
        const data = createMatroska([
            createTrack({ number: 1 }),
            createTrack({
                mappings: [ createBlockAdditionMapping(HVCE_BLOCK_ADD_ID_TYPE, createHVCE()) ],
                number: 1
            })
        ]);

        await expect(readMatroskaDolbyVisionHVCE(createReader(data), 1)).resolves.toBeNull();
    });

    it.each([ 0, -1, 1.5, Number.NaN ])(
        'rejects invalid selected track number %s before reading',
        async selectedTrackNumber => {
            const reader = createReader(new Uint8Array(0));

            await expect(readMatroskaDolbyVisionHVCE(reader, selectedTrackNumber))
                .resolves.toBeNull();
            expect(reader).not.toHaveBeenCalled();
        }
    );

    it('treats truncated metadata as unavailable instead of throwing', async () => {
        const data = createMatroska([
            createTrack({
                mappings: [ createBlockAdditionMapping(HVCE_BLOCK_ADD_ID_TYPE, createHVCE()) ],
                number: 1
            })
        ]);

        await expect(readMatroskaDolbyVisionHVCE(
            createReader(data.subarray(0, data.byteLength - 1)),
            1
        )).resolves.toBeNull();
    });

    it('rejects a non-Matroska source after the first bounded read', async () => {
        const reader = createReader(new Uint8Array([ 0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70 ]));

        await expect(readMatroskaDolbyVisionHVCE(reader, 1)).resolves.toBeNull();
        expect(reader).toHaveBeenCalledTimes(1);
        expect(reader).toHaveBeenCalledWith(0, 12);
    });
});
