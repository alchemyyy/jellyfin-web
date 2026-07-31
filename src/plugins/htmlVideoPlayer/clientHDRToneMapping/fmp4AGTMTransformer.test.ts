import { describe, expect, it } from 'vitest';

import { FMP4AGTMTransformer } from './fmp4AGTMTransformer';

const DEFAULT_BASE_IS_MOOF_FLAG = 0x020000;
const VIDEO_TRACK_ID = 1;
const METADATA_TRACK_ID = 2;
const VIDEO_TIMESCALE = 1000;

interface TestBox {
    end: number;
    payloadStart: number;
    size: number;
    start: number;
    type: string;
}

interface TestSample {
    compositionOffset: number;
    duration: number;
    size: number;
}

describe('FMP4AGTMTransformer', () => {
    it('adds a Chromium-compatible it35 metadata track', () => {
        const input = createInitializationSegment(10);
        const transformer = new FMP4AGTMTransformer(
            new Uint8Array([ 0x00, 0x80, 0x03, 0xF7 ])
        );

        const output = transformer.transformInitializationSegment(input);

        expect(output).not.toBe(input);
        const topLevelBoxes = parseTestBoxes(output, 0, output.byteLength);
        const movieBox = findSingleTestBox(topLevelBoxes, 'moov');
        const movieChildren = parseTestBoxes(
            output,
            movieBox.payloadStart,
            movieBox.end
        );
        const trackBoxes = findTestBoxes(movieChildren, 'trak');
        expect(trackBoxes).toHaveLength(2);

        const originalMovieBox = findSingleTestBox(
            parseTestBoxes(input, 0, input.byteLength),
            'moov'
        );
        const originalVideoTrack = findSingleTestBox(
            parseTestBoxes(
                input,
                originalMovieBox.payloadStart,
                originalMovieBox.end
            ),
            'trak'
        );
        expect(Array.from(output.subarray(
            trackBoxes[0].start,
            trackBoxes[0].end
        ))).toEqual(Array.from(input.subarray(
            originalVideoTrack.start,
            originalVideoTrack.end
        )));

        const metadataTrackChildren = parseTestBoxes(
            output,
            trackBoxes[1].payloadStart,
            trackBoxes[1].end
        );
        const metadataTrackHeader = findSingleTestBox(
            metadataTrackChildren,
            'tkhd'
        );
        expect(readTestUnsigned32(
            output,
            metadataTrackHeader.payloadStart + 12
        )).toBe(METADATA_TRACK_ID);

        const trackReference = findSingleTestBox(
            metadataTrackChildren,
            'tref'
        );
        const renderReference = findSingleTestBox(
            parseTestBoxes(
                output,
                trackReference.payloadStart,
                trackReference.end
            ),
            'rndr'
        );
        expect(readTestUnsigned32(output, renderReference.payloadStart))
            .toBe(VIDEO_TRACK_ID);

        const mediaBox = findSingleTestBox(metadataTrackChildren, 'mdia');
        const mediaChildren = parseTestBoxes(
            output,
            mediaBox.payloadStart,
            mediaBox.end
        );
        const mediaHeader = findSingleTestBox(mediaChildren, 'mdhd');
        expect(readTestUnsigned32(output, mediaHeader.payloadStart + 12))
            .toBe(VIDEO_TIMESCALE);
        const handler = findSingleTestBox(mediaChildren, 'hdlr');
        expect(readTestType(output, handler.payloadStart + 8)).toBe('meta');

        const mediaInformation = findSingleTestBox(mediaChildren, 'minf');
        const sampleTable = findSingleTestBox(
            parseTestBoxes(
                output,
                mediaInformation.payloadStart,
                mediaInformation.end
            ),
            'stbl'
        );
        const sampleDescription = findSingleTestBox(
            parseTestBoxes(
                output,
                sampleTable.payloadStart,
                sampleTable.end
            ),
            'stsd'
        );
        const sampleEntries = parseTestBoxes(
            output,
            sampleDescription.payloadStart + 8,
            sampleDescription.end
        );
        expect(sampleEntries).toHaveLength(1);
        expect(sampleEntries[0].type).toBe('it35');
        expect(Array.from(output.subarray(
            sampleEntries[0].payloadStart + 9,
            sampleEntries[0].end
        ))).toEqual([ 0xB5, 0x00, 0x90, 0x00, 0x01 ]);

        const movieExtends = findSingleTestBox(movieChildren, 'mvex');
        const metadataTrackExtends = findTestBoxes(
            parseTestBoxes(
                output,
                movieExtends.payloadStart,
                movieExtends.end
            ),
            'trex'
        )[1];
        expect(readTestUnsigned32(
            output,
            metadataTrackExtends.payloadStart + 4
        )).toBe(METADATA_TRACK_ID);
        expect(readTestUnsigned32(
            output,
            metadataTrackExtends.payloadStart + 8
        )).toBe(1);

        const movieHeader = findSingleTestBox(movieChildren, 'mvhd');
        expect(readTestUnsigned32(output, movieHeader.end - 4)).toBe(3);
    });

    it('appends one AGTM sample spanning the video presentation interval', () => {
        const payload = new Uint8Array([ 0x00, 0x80, 0x03, 0xF7 ]);
        const transformer = new FMP4AGTMTransformer(payload);
        transformer.transformInitializationSegment(
            createInitializationSegment(10)
        );
        const videoSamples: TestSample[] = [
            {
                compositionOffset: 20,
                duration: 100,
                size: 3
            },
            {
                compositionOffset: -10,
                duration: 100,
                size: 2
            }
        ];
        const input = createMediaSegment(videoSamples, 1000);
        const inputMovieFragment = findSingleTestBox(
            parseTestBoxes(input, 0, input.byteLength),
            'moof'
        );
        const inputVideoTrackFragment = findSingleTestBox(
            parseTestBoxes(
                input,
                inputMovieFragment.payloadStart,
                inputMovieFragment.end
            ),
            'traf'
        );
        const inputVideoTrackRun = findSingleTestBox(
            parseTestBoxes(
                input,
                inputVideoTrackFragment.payloadStart,
                inputVideoTrackFragment.end
            ),
            'trun'
        );
        const inputVideoDataOffset = readTestSigned32(
            input,
            inputVideoTrackRun.payloadStart + 8
        );

        const output = transformer.transformMediaSegment(input);

        expect(output).not.toBe(input);
        const topLevelBoxes = parseTestBoxes(output, 0, output.byteLength);
        const movieFragment = findSingleTestBox(topLevelBoxes, 'moof');
        const mediaData = findSingleTestBox(topLevelBoxes, 'mdat');
        const trackFragments = findTestBoxes(
            parseTestBoxes(
                output,
                movieFragment.payloadStart,
                movieFragment.end
            ),
            'traf'
        );
        expect(trackFragments).toHaveLength(2);

        const insertedLength = trackFragments[1].size;
        const videoTrackRun = findSingleTestBox(
            parseTestBoxes(
                output,
                trackFragments[0].payloadStart,
                trackFragments[0].end
            ),
            'trun'
        );
        expect(readTestSigned32(
            output,
            videoTrackRun.payloadStart + 8
        )).toBe(inputVideoDataOffset + insertedLength);

        const metadataChildren = parseTestBoxes(
            output,
            trackFragments[1].payloadStart,
            trackFragments[1].end
        );
        const metadataTrackHeader = findSingleTestBox(
            metadataChildren,
            'tfhd'
        );
        expect(readTestUnsigned32(
            output,
            metadataTrackHeader.payloadStart + 4
        )).toBe(METADATA_TRACK_ID);
        expect(readTestFlags(output, metadataTrackHeader.payloadStart))
            .toBe(DEFAULT_BASE_IS_MOOF_FLAG);

        const metadataDecodeTime = findSingleTestBox(
            metadataChildren,
            'tfdt'
        );
        expect(output[metadataDecodeTime.payloadStart]).toBe(0);
        expect(readTestUnsigned32(
            output,
            metadataDecodeTime.payloadStart + 4
        )).toBe(1010);

        const metadataTrackRun = findSingleTestBox(
            metadataChildren,
            'trun'
        );
        expect(output[metadataTrackRun.payloadStart]).toBe(0);
        expect(readTestFlags(output, metadataTrackRun.payloadStart))
            .toBe(0x000301);
        expect(readTestUnsigned32(
            output,
            metadataTrackRun.payloadStart + 4
        )).toBe(1);
        expect(readTestSigned32(
            output,
            metadataTrackRun.payloadStart + 8
        )).toBe(mediaData.end - movieFragment.start - payload.byteLength);
        expect(readTestUnsigned32(
            output,
            metadataTrackRun.payloadStart + 12
        )).toBe(170);
        expect(readTestUnsigned32(
            output,
            metadataTrackRun.payloadStart + 16
        )).toBe(payload.byteLength);

        expect(Array.from(output.subarray(
            mediaData.payloadStart,
            mediaData.end - payload.byteLength
        ))).toEqual([ 1, 2, 3, 4, 5 ]);
        expect(Array.from(output.subarray(
            mediaData.end - payload.byteLength,
            mediaData.end
        ))).toEqual(Array.from(payload));
    });

    it('uses signed composition time for a negative presentation interval', () => {
        const transformer = new FMP4AGTMTransformer(
            new Uint8Array([ 0x00, 0x80, 0x03, 0xF7 ])
        );
        transformer.transformInitializationSegment(
            createInitializationSegment(2000)
        );
        const input = createMediaSegment([
            {
                compositionOffset: 0,
                duration: 100,
                size: 4
            }
        ], 1000);

        const output = transformer.transformMediaSegment(input);

        const movieFragment = findSingleTestBox(
            parseTestBoxes(output, 0, output.byteLength),
            'moof'
        );
        const trackFragments = findTestBoxes(
            parseTestBoxes(
                output,
                movieFragment.payloadStart,
                movieFragment.end
            ),
            'traf'
        );
        const metadataChildren = parseTestBoxes(
            output,
            trackFragments[1].payloadStart,
            trackFragments[1].end
        );
        const metadataDecodeTime = findSingleTestBox(
            metadataChildren,
            'tfdt'
        );
        expect(readTestUnsigned32(
            output,
            metadataDecodeTime.payloadStart + 4
        )).toBe(0);

        const metadataTrackRun = findSingleTestBox(
            metadataChildren,
            'trun'
        );
        expect(output[metadataTrackRun.payloadStart]).toBe(1);
        expect(readTestFlags(output, metadataTrackRun.payloadStart))
            .toBe(0x000B01);
        expect(readTestUnsigned32(
            output,
            metadataTrackRun.payloadStart + 12
        )).toBe(100);
        expect(readTestSigned32(
            output,
            metadataTrackRun.payloadStart + 20
        )).toBe(-1000);
    });

    it('fails open for malformed and unsupported segments', () => {
        const transformer = new FMP4AGTMTransformer(
            new Uint8Array([ 0x00, 0x80, 0x03, 0xF7 ])
        );
        const mediaBeforeInitialization = createMediaSegment([
            {
                compositionOffset: 0,
                duration: 100,
                size: 4
            }
        ], 0);
        expect(transformer.transformMediaSegment(mediaBeforeInitialization))
            .toBe(mediaBeforeInitialization);

        const malformedInitialization = new Uint8Array([
            0x00, 0x00, 0x00, 0x20,
            0x6D, 0x6F, 0x6F, 0x76
        ]);
        expect(transformer.transformInitializationSegment(
            malformedInitialization
        )).toBe(malformedInitialization);

        transformer.transformInitializationSegment(
            createInitializationSegment(0)
        );
        const mediaWithoutDataOffset = createMediaSegment([
            {
                compositionOffset: 0,
                duration: 100,
                size: 4
            }
        ], 0, false);
        expect(transformer.transformMediaSegment(mediaWithoutDataOffset))
            .toBe(mediaWithoutDataOffset);
    });

    it('does not add a second it35 track', () => {
        const transformer = new FMP4AGTMTransformer(
            new Uint8Array([ 0x00, 0x80, 0x03, 0xF7 ])
        );
        const transformedInitialization =
            transformer.transformInitializationSegment(
                createInitializationSegment(0)
            );

        expect(transformer.transformInitializationSegment(
            transformedInitialization
        )).toBe(transformedInitialization);
    });

    it('leaves non-PQ video and its media segments unchanged', () => {
        const transformer = new FMP4AGTMTransformer(
            new Uint8Array([ 0x00, 0x80, 0x03, 0xF7 ])
        );
        const bt709Initialization = createInitializationSegment(0, 1);

        expect(transformer.transformInitializationSegment(
            bt709Initialization
        )).toBe(bt709Initialization);

        const mediaSegment = createMediaSegment([
            {
                compositionOffset: 0,
                duration: 100,
                size: 4
            }
        ], 0);
        expect(transformer.transformMediaSegment(mediaSegment))
            .toBe(mediaSegment);
    });
});

function createInitializationSegment(
    editListOffset: number,
    transferCharacteristics = 16
): Uint8Array {
    const fileType = createTestBox('ftyp', [
        createTestTypeBytes('isom'),
        createTestUnsigned32Bytes(0),
        createTestTypeBytes('isom')
    ]);
    const movieHeaderBody = new Uint8Array(96);
    writeTestUnsigned32(movieHeaderBody, movieHeaderBody.byteLength - 4, 2);
    const movieHeader = createTestFullBox(
        'mvhd',
        0,
        0,
        [ movieHeaderBody ]
    );
    const videoTrack = createVideoTrack(
        editListOffset,
        transferCharacteristics
    );
    const videoTrackExtends = createTestFullBox('trex', 0, 0, [
        createTestUnsigned32Bytes(VIDEO_TRACK_ID),
        createTestUnsigned32Bytes(1),
        createTestUnsigned32Bytes(0),
        createTestUnsigned32Bytes(0),
        createTestUnsigned32Bytes(0)
    ]);
    const movieExtends = createTestBox('mvex', [ videoTrackExtends ]);
    const movie = createTestBox('moov', [
        movieHeader,
        videoTrack,
        movieExtends
    ]);

    return concatenateTestBytes([ fileType, movie ]);
}

function createVideoTrack(
    editListOffset: number,
    transferCharacteristics: number
): Uint8Array {
    const trackHeaderBody = new Uint8Array(80);
    writeTestUnsigned32(trackHeaderBody, 8, VIDEO_TRACK_ID);
    const trackHeader = createTestFullBox(
        'tkhd',
        0,
        3,
        [ trackHeaderBody ]
    );
    const editListEntry = new Uint8Array(16);
    writeTestUnsigned32(editListEntry, 0, 1);
    writeTestUnsigned32(editListEntry, 4, 10000);
    writeTestSigned32(editListEntry, 8, editListOffset);
    editListEntry[12] = 0;
    editListEntry[13] = 1;
    const editList = createTestFullBox(
        'elst',
        0,
        0,
        [ editListEntry ]
    );
    const edit = createTestBox('edts', [ editList ]);

    const mediaHeaderBody = new Uint8Array(20);
    writeTestUnsigned32(mediaHeaderBody, 8, VIDEO_TIMESCALE);
    const mediaHeader = createTestFullBox(
        'mdhd',
        0,
        0,
        [ mediaHeaderBody ]
    );
    const handlerBody = new Uint8Array(21);
    handlerBody.set(createTestTypeBytes('vide'), 4);
    const handler = createTestFullBox('hdlr', 0, 0, [ handlerBody ]);
    const visualSampleEntryFields = new Uint8Array(78);
    const colorInformation = createTestBox('colr', [
        createTestTypeBytes('nclx'),
        createTestUnsigned16Bytes(9),
        createTestUnsigned16Bytes(transferCharacteristics),
        createTestUnsigned16Bytes(9),
        new Uint8Array(1)
    ]);
    const videoSampleEntry = createTestBox('hvc1', [
        visualSampleEntryFields,
        colorInformation
    ]);
    const sampleDescription = createTestFullBox('stsd', 0, 0, [
        createTestUnsigned32Bytes(1),
        videoSampleEntry
    ]);
    const sampleTable = createTestBox('stbl', [ sampleDescription ]);
    const mediaInformation = createTestBox('minf', [ sampleTable ]);
    const media = createTestBox('mdia', [
        mediaHeader,
        handler,
        mediaInformation
    ]);

    return createTestBox('trak', [
        trackHeader,
        edit,
        media
    ]);
}

function createMediaSegment(
    samples: readonly TestSample[],
    baseDecodeTime: number,
    includeDataOffset = true
): Uint8Array {
    const segmentType = createTestBox('styp', [
        createTestTypeBytes('msdh'),
        createTestUnsigned32Bytes(0),
        createTestTypeBytes('msdh')
    ]);
    const mediaDataBytes = new Uint8Array(
        samples.reduce(
            (totalSize, sample) => totalSize + sample.size,
            0
        )
    );
    for (
        let byteIndex = 0;
        byteIndex < mediaDataBytes.byteLength;
        byteIndex++
    ) {
        mediaDataBytes[byteIndex] = byteIndex + 1;
    }

    const mediaData = createTestBox('mdat', [ mediaDataBytes ]);
    const movieFragmentHeader = createTestFullBox('mfhd', 0, 0, [
        createTestUnsigned32Bytes(1)
    ]);
    const placeholderTrackFragment = createVideoTrackFragment(
        samples,
        baseDecodeTime,
        0,
        includeDataOffset
    );
    const placeholderMovieFragment = createTestBox('moof', [
        movieFragmentHeader,
        placeholderTrackFragment
    ]);
    const dataOffset = placeholderMovieFragment.byteLength + 8;
    const videoTrackFragment = createVideoTrackFragment(
        samples,
        baseDecodeTime,
        dataOffset,
        includeDataOffset
    );
    const movieFragment = createTestBox('moof', [
        movieFragmentHeader,
        videoTrackFragment
    ]);

    return concatenateTestBytes([
        segmentType,
        movieFragment,
        mediaData
    ]);
}

function createVideoTrackFragment(
    samples: readonly TestSample[],
    baseDecodeTime: number,
    dataOffset: number,
    includeDataOffset: boolean
): Uint8Array {
    const trackFragmentHeader = createTestFullBox(
        'tfhd',
        0,
        DEFAULT_BASE_IS_MOOF_FLAG,
        [ createTestUnsigned32Bytes(VIDEO_TRACK_ID) ]
    );
    const trackFragmentDecodeTime = createTestFullBox('tfdt', 0, 0, [
        createTestUnsigned32Bytes(baseDecodeTime)
    ]);
    const trackRunParts: Uint8Array[] = [
        createTestUnsigned32Bytes(samples.length)
    ];
    if (includeDataOffset) {
        trackRunParts.push(createTestSigned32Bytes(dataOffset));
    }
    for (const sample of samples) {
        trackRunParts.push(createTestUnsigned32Bytes(sample.duration));
        trackRunParts.push(createTestUnsigned32Bytes(sample.size));
        trackRunParts.push(createTestSigned32Bytes(sample.compositionOffset));
    }

    const trackRunFlags = (
        includeDataOffset ? 0x000001 : 0
    ) | 0x000B00;
    const trackRun = createTestFullBox(
        'trun',
        1,
        trackRunFlags,
        trackRunParts
    );

    return createTestBox('traf', [
        trackFragmentHeader,
        trackFragmentDecodeTime,
        trackRun
    ]);
}

function parseTestBoxes(
    input: Uint8Array,
    start: number,
    end: number
): TestBox[] {
    const boxes: TestBox[] = [];
    let readOffset = start;
    while (readOffset < end) {
        const size = readTestUnsigned32(input, readOffset);
        boxes.push({
            end: readOffset + size,
            payloadStart: readOffset + 8,
            size,
            start: readOffset,
            type: readTestType(input, readOffset + 4)
        });
        readOffset += size;
    }

    expect(readOffset).toBe(end);
    return boxes;
}

function findTestBoxes(
    boxes: readonly TestBox[],
    type: string
): TestBox[] {
    const matchingBoxes: TestBox[] = [];
    for (const box of boxes) {
        if (box.type === type) {
            matchingBoxes.push(box);
        }
    }
    return matchingBoxes;
}

function findSingleTestBox(
    boxes: readonly TestBox[],
    type: string
): TestBox {
    const matchingBoxes = findTestBoxes(boxes, type);
    expect(matchingBoxes).toHaveLength(1);
    return matchingBoxes[0];
}

function createTestBox(
    type: string,
    payloadParts: readonly Uint8Array[]
): Uint8Array {
    const payload = concatenateTestBytes(payloadParts);
    const output = new Uint8Array(payload.byteLength + 8);
    writeTestUnsigned32(output, 0, output.byteLength);
    output.set(createTestTypeBytes(type), 4);
    output.set(payload, 8);
    return output;
}

function createTestFullBox(
    type: string,
    version: number,
    flags: number,
    payloadParts: readonly Uint8Array[]
): Uint8Array {
    return createTestBox(type, [
        new Uint8Array([
            version,
            (flags >>> 16) & 0xFF,
            (flags >>> 8) & 0xFF,
            flags & 0xFF
        ]),
        ...payloadParts
    ]);
}

function concatenateTestBytes(
    parts: readonly Uint8Array[]
): Uint8Array {
    let totalLength = 0;
    for (const part of parts) {
        totalLength += part.byteLength;
    }

    const output = new Uint8Array(totalLength);
    let writeOffset = 0;
    for (const part of parts) {
        output.set(part, writeOffset);
        writeOffset += part.byteLength;
    }
    return output;
}

function createTestTypeBytes(type: string): Uint8Array {
    const output = new Uint8Array(4);
    for (let characterIndex = 0; characterIndex < 4; characterIndex++) {
        output[characterIndex] = type.charCodeAt(characterIndex);
    }
    return output;
}

function createTestUnsigned16Bytes(value: number): Uint8Array {
    const output = new Uint8Array(2);
    new DataView(output.buffer).setUint16(0, value);
    return output;
}

function createTestUnsigned32Bytes(value: number): Uint8Array {
    const output = new Uint8Array(4);
    writeTestUnsigned32(output, 0, value);
    return output;
}

function createTestSigned32Bytes(value: number): Uint8Array {
    const output = new Uint8Array(4);
    writeTestSigned32(output, 0, value);
    return output;
}

function readTestType(input: Uint8Array, offset: number): string {
    return String.fromCharCode(
        input[offset],
        input[offset + 1],
        input[offset + 2],
        input[offset + 3]
    );
}

function readTestFlags(input: Uint8Array, offset: number): number {
    return input[offset + 1] * 0x10000
        + input[offset + 2] * 0x100
        + input[offset + 3];
}

function readTestUnsigned32(input: Uint8Array, offset: number): number {
    return new DataView(
        input.buffer,
        input.byteOffset + offset,
        4
    ).getUint32(0);
}

function readTestSigned32(input: Uint8Array, offset: number): number {
    return new DataView(
        input.buffer,
        input.byteOffset + offset,
        4
    ).getInt32(0);
}

function writeTestUnsigned32(
    output: Uint8Array,
    offset: number,
    value: number
): void {
    new DataView(
        output.buffer,
        output.byteOffset + offset,
        4
    ).setUint32(0, value);
}

function writeTestSigned32(
    output: Uint8Array,
    offset: number,
    value: number
): void {
    new DataView(
        output.buffer,
        output.byteOffset + offset,
        4
    ).setInt32(0, value);
}
