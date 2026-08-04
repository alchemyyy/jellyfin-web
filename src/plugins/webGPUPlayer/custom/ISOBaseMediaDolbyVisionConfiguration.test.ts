import { describe, expect, it, vi } from 'vitest';

import {
    readISOBaseMediaDolbyVisionTrackConfiguration,
    type ISOBaseMediaByteRangeReader
} from './ISOBaseMediaDolbyVisionConfiguration';

const BASE_TRACK_ID = 1;
const ENHANCEMENT_TRACK_ID = 2;
const VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH = 78;

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

function encodeUnsigned32(value: number): Uint8Array {
    return new Uint8Array([
        Math.floor(value / 0x1_000000) % 256,
        Math.floor(value / 0x1_0000) % 256,
        Math.floor(value / 0x100) % 256,
        value % 256
    ]);
}

function encodeFourCC(value: string): Uint8Array {
    if (value.length !== 4) {
        throw new TypeError('A synthetic FourCC must contain four characters');
    }
    return new Uint8Array(Array.from(
        value,
        (character: string): number => character.charCodeAt(0)
    ));
}

function createBox(
    type: string,
    payload: Uint8Array = new Uint8Array(0)
): Uint8Array {
    return concatenate([
        encodeUnsigned32(payload.byteLength + 8),
        encodeFourCC(type),
        payload
    ]);
}

function createExtendedBox(type: string, payload: Uint8Array): Uint8Array {
    const byteLength = payload.byteLength + 16;
    return concatenate([
        encodeUnsigned32(1),
        encodeFourCC(type),
        encodeUnsigned32(0),
        encodeUnsigned32(byteLength),
        payload
    ]);
}

function createFullBox(type: string, payload: Uint8Array, version = 0): Uint8Array {
    return createBox(type, concatenate([
        new Uint8Array([ version, 0, 0, 0 ]),
        payload
    ]));
}

function createHEVCConfiguration(seed = 0x20): Uint8Array {
    const data = new Uint8Array(23);
    data[0] = 1;
    for (let byteIndex = 1; byteIndex < data.byteLength; byteIndex += 1) {
        data[byteIndex] = (seed + byteIndex) & 0xFF;
    }
    return data;
}

type DolbyVisionConfigurationOptions = {
    baseLayerPresent?: boolean
    enhancementLayerPresent?: boolean
    profile?: number
    rpuPresent?: boolean
};

function createDolbyVisionConfiguration(
    options: DolbyVisionConfigurationOptions = {}
): Uint8Array {
    const data = new Uint8Array(24);
    data[0] = 1;
    const configurationBits = ((options.profile ?? 7) << 9)
        | (6 << 3)
        | ((options.rpuPresent ?? true) ? 4 : 0)
        | ((options.enhancementLayerPresent ?? true) ? 2 : 0)
        | ((options.baseLayerPresent ?? false) ? 1 : 0);
    data[2] = configurationBits >> 8;
    data[3] = configurationBits & 0xFF;
    return data;
}

type SyntheticTrackOptions = {
    dependencyTrackIDs?: readonly number[]
    dolbyVisionConfiguration?: Uint8Array | null
    handlerType?: string
    hevcConfiguration?: Uint8Array | null
    id: number
    sampleEntryType?: string
};

function createTrack(options: SyntheticTrackOptions): Uint8Array {
    const trackHeaderPayload = new Uint8Array(8);
    const trackHeaderBox = createFullBox('tkhd', concatenate([
        trackHeaderPayload,
        encodeUnsigned32(options.id)
    ]));
    const handlerBox = createFullBox('hdlr', concatenate([
        new Uint8Array(4),
        encodeFourCC(options.handlerType ?? 'vide')
    ]));
    const sampleEntryChildren: Uint8Array[] = [];
    if (options.hevcConfiguration !== null) {
        sampleEntryChildren.push(createBox(
            'hvcC',
            options.hevcConfiguration ?? createHEVCConfiguration()
        ));
    }
    if (options.dolbyVisionConfiguration !== null) {
        const dolbyVisionConfiguration = options.dolbyVisionConfiguration;
        if (dolbyVisionConfiguration) {
            sampleEntryChildren.push(createBox('dvcC', dolbyVisionConfiguration));
        }
    }
    const sampleEntry = createBox(
        options.sampleEntryType ?? 'hvc1',
        concatenate([
            new Uint8Array(VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH),
            ...sampleEntryChildren
        ])
    );
    const sampleDescriptionBox = createFullBox('stsd', concatenate([
        encodeUnsigned32(1),
        sampleEntry
    ]));
    const mediaBox = createBox('mdia', concatenate([
        handlerBox,
        createBox('minf', createBox('stbl', sampleDescriptionBox))
    ]));
    const trackReferenceBox = options.dependencyTrackIDs ?
        createBox('tref', createBox(
            'vdep',
            concatenate(options.dependencyTrackIDs.map(encodeUnsigned32))
        )) :
        null;
    return createBox('trak', concatenate([
        trackHeaderBox,
        ...(trackReferenceBox ? [ trackReferenceBox ] : []),
        mediaBox
    ]));
}

function createFile(
    tracks: readonly Uint8Array[],
    options: { extendedMovieBox?: boolean; leadingBoxes?: readonly Uint8Array[] } = {}
): Uint8Array {
    const moviePayload = concatenate(tracks);
    const movieBox = options.extendedMovieBox ?
        createExtendedBox('moov', moviePayload) :
        createBox('moov', moviePayload);
    return concatenate([
        createBox('ftyp', concatenate([
            encodeFourCC('isom'),
            encodeUnsigned32(0),
            encodeFourCC('isom')
        ])),
        ...(options.leadingBoxes ?? [ createBox('mdat', new Uint8Array([ 1, 2, 3 ])) ]),
        movieBox
    ]);
}

function createValidTracks(
    options: {
        dolbyVisionConfiguration?: Uint8Array
        enhancementType?: string
        enhancementTrackID?: number
        referenceTrackIDs?: readonly number[]
    } = {}
): readonly Uint8Array[] {
    return [
        createTrack({ id: BASE_TRACK_ID }),
        createTrack({
            dependencyTrackIDs: options.referenceTrackIDs ?? [ BASE_TRACK_ID ],
            dolbyVisionConfiguration: options.dolbyVisionConfiguration
                ?? createDolbyVisionConfiguration(),
            hevcConfiguration: createHEVCConfiguration(0x70),
            id: options.enhancementTrackID ?? ENHANCEMENT_TRACK_ID,
            sampleEntryType: options.enhancementType ?? 'dvh1'
        })
    ];
}

function createReader(data: Uint8Array): ISOBaseMediaByteRangeReader {
    return vi.fn(async (offset: number, byteLength: number): Promise<Uint8Array | null> => {
        if (offset < 0 || byteLength < 0 || offset >= data.byteLength) {
            return null;
        }
        return data.slice(offset, Math.min(data.byteLength, offset + byteLength));
    });
}

describe('readISOBaseMediaDolbyVisionTrackConfiguration', () => {
    it.each([ 'dvh1', 'dvhe' ])(
        'extracts the separate %s Profile 7 enhancement configuration',
        async (enhancementType: string) => {
            const enhancementConfiguration = createHEVCConfiguration(0x70);
            const reader = createReader(createFile([
                createTrack({ id: BASE_TRACK_ID }),
                createTrack({
                    dependencyTrackIDs: [ BASE_TRACK_ID ],
                    dolbyVisionConfiguration: createDolbyVisionConfiguration(),
                    hevcConfiguration: enhancementConfiguration,
                    id: ENHANCEMENT_TRACK_ID,
                    sampleEntryType: enhancementType
                })
            ]));

            const result = await readISOBaseMediaDolbyVisionTrackConfiguration(
                reader,
                BASE_TRACK_ID
            );

            expect(result).toEqual({
                enhancementConfiguration,
                separateEnhancementTrackNumber: ENHANCEMENT_TRACK_ID
            });
            expect(result?.enhancementConfiguration).not.toBe(enhancementConfiguration);
            expect(reader).toHaveBeenCalledWith(0, 16);
        }
    );

    it('supports an extended-size movie box after bounded top-level boxes', async () => {
        const reader = createReader(createFile(createValidTracks(), {
            extendedMovieBox: true,
            leadingBoxes: [
                createBox('free', new Uint8Array(257)),
                createBox('mdat', new Uint8Array(509))
            ]
        }));

        await expect(readISOBaseMediaDolbyVisionTrackConfiguration(
            reader,
            BASE_TRACK_ID
        )).resolves.toMatchObject({
            separateEnhancementTrackNumber: ENHANCEMENT_TRACK_ID
        });
        expect(reader).toHaveBeenCalledWith(0, 16);
        expect(Math.max(...vi.mocked(reader).mock.calls.map(
            (call: [number, number]): number => call[1]
        ))).toBeLessThan(16 * 1_024 * 1_024);
    });

    it.each([
        {
            configuration: createDolbyVisionConfiguration({ profile: 8 }),
            label: 'non-Profile 7 configuration'
        },
        {
            configuration: createDolbyVisionConfiguration({ rpuPresent: false }),
            label: 'missing RPU flag'
        },
        {
            configuration: createDolbyVisionConfiguration({ enhancementLayerPresent: false }),
            label: 'missing enhancement-layer flag'
        },
        {
            configuration: createDolbyVisionConfiguration({ baseLayerPresent: true }),
            label: 'embedded base-layer flag'
        }
    ])('rejects an enhancement track with $label', async ({ configuration }) => {
        const data = createFile(createValidTracks({
            dolbyVisionConfiguration: configuration
        }));

        await expect(readISOBaseMediaDolbyVisionTrackConfiguration(
            createReader(data),
            BASE_TRACK_ID
        )).resolves.toBeNull();
    });

    it.each([
        {
            label: 'missing dependency',
            referenceTrackIDs: undefined
        },
        {
            label: 'wrong dependency',
            referenceTrackIDs: [ 8 ]
        },
        {
            label: 'multiple dependencies',
            referenceTrackIDs: [ BASE_TRACK_ID, 8 ]
        }
    ])('rejects an enhancement track with $label', async ({ referenceTrackIDs }) => {
        const tracks = referenceTrackIDs ?
            createValidTracks({ referenceTrackIDs }) :
            [
                createTrack({ id: BASE_TRACK_ID }),
                createTrack({
                    dolbyVisionConfiguration: createDolbyVisionConfiguration(),
                    id: ENHANCEMENT_TRACK_ID,
                    sampleEntryType: 'dvh1'
                })
            ];

        await expect(readISOBaseMediaDolbyVisionTrackConfiguration(
            createReader(createFile(tracks)),
            BASE_TRACK_ID
        )).resolves.toBeNull();
    });

    it('rejects ambiguous enhancement tracks', async () => {
        const tracks = [
            ...createValidTracks(),
            createTrack({
                dependencyTrackIDs: [ BASE_TRACK_ID ],
                dolbyVisionConfiguration: createDolbyVisionConfiguration(),
                id: 3,
                sampleEntryType: 'dvhe'
            })
        ];

        await expect(readISOBaseMediaDolbyVisionTrackConfiguration(
            createReader(createFile(tracks)),
            BASE_TRACK_ID
        )).resolves.toBeNull();
    });

    it.each([
        {
            label: 'the enhancement track as the selected track',
            selectedTrackID: ENHANCEMENT_TRACK_ID,
            tracks: createValidTracks()
        },
        {
            label: 'an absent selected track',
            selectedTrackID: 99,
            tracks: createValidTracks()
        },
        {
            label: 'a non-HEVC selected track',
            selectedTrackID: BASE_TRACK_ID,
            tracks: [
                createTrack({ id: BASE_TRACK_ID, sampleEntryType: 'avc1' }),
                createValidTracks()[1]
            ]
        },
        {
            label: 'a duplicated track ID',
            selectedTrackID: BASE_TRACK_ID,
            tracks: [
                ...createValidTracks(),
                createTrack({ id: BASE_TRACK_ID })
            ]
        }
    ])('rejects $label', async ({ selectedTrackID, tracks }) => {
        await expect(readISOBaseMediaDolbyVisionTrackConfiguration(
            createReader(createFile(tracks)),
            selectedTrackID
        )).resolves.toBeNull();
    });

    it('rejects files without an initial file-type box', async () => {
        const data = concatenate([
            createBox('free'),
            createBox('moov', concatenate(createValidTracks()))
        ]);

        await expect(readISOBaseMediaDolbyVisionTrackConfiguration(
            createReader(data),
            BASE_TRACK_ID
        )).resolves.toBeNull();
    });

    it('rejects an oversized movie box without reading its payload', async () => {
        const oversizedMovieHeader = concatenate([
            encodeUnsigned32((16 * 1_024 * 1_024) + 9),
            encodeFourCC('moov'),
            new Uint8Array(8)
        ]);
        const reader = createReader(concatenate([
            createBox('ftyp'),
            oversizedMovieHeader
        ]));

        await expect(readISOBaseMediaDolbyVisionTrackConfiguration(
            reader,
            BASE_TRACK_ID
        )).resolves.toBeNull();
        expect(reader).toHaveBeenCalledTimes(2);
    });

    it.each([ 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1 ])(
        'rejects invalid selected track number %s without reading',
        async (selectedTrackID: number) => {
            const reader = createReader(createFile(createValidTracks()));

            await expect(readISOBaseMediaDolbyVisionTrackConfiguration(
                reader,
                selectedTrackID
            )).resolves.toBeNull();
            expect(reader).not.toHaveBeenCalled();
        }
    );

    it('fails closed on truncated box metadata', async () => {
        const data = concatenate([
            createBox('ftyp'),
            new Uint8Array([ 0, 0, 0, 20, 0x6D, 0x6F, 0x6F, 0x76 ])
        ]);

        await expect(readISOBaseMediaDolbyVisionTrackConfiguration(
            createReader(data),
            BASE_TRACK_ID
        )).resolves.toBeNull();
    });
});
