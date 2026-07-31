const BOX_HEADER_SIZE = 8;
const DEFAULT_BASE_IS_MOOF_FLAG = 0x020000;
const BASE_DATA_OFFSET_PRESENT_FLAG = 0x000001;
const SAMPLE_DESCRIPTION_INDEX_PRESENT_FLAG = 0x000002;
const DEFAULT_SAMPLE_DURATION_PRESENT_FLAG = 0x000008;
const DEFAULT_SAMPLE_SIZE_PRESENT_FLAG = 0x000010;
const DEFAULT_SAMPLE_FLAGS_PRESENT_FLAG = 0x000020;
const TRUN_DATA_OFFSET_PRESENT_FLAG = 0x000001;
const TRUN_FIRST_SAMPLE_FLAGS_PRESENT_FLAG = 0x000004;
const TRUN_SAMPLE_DURATION_PRESENT_FLAG = 0x000100;
const TRUN_SAMPLE_SIZE_PRESENT_FLAG = 0x000200;
const TRUN_SAMPLE_FLAGS_PRESENT_FLAG = 0x000400;
const TRUN_SAMPLE_COMPOSITION_OFFSET_PRESENT_FLAG = 0x000800;
const UINT32_MAX = 0xFFFFFFFF;
const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7FFFFFFF;
const UINT32_RANGE = 0x100000000;
const UNDEFINED_LANGUAGE_CODE = 0x55C4;
const PQ_TRANSFER_CHARACTERISTICS = 16;
const VISUAL_SAMPLE_ENTRY_FIELDS_SIZE = 78;
const IT35_IDENTIFIER = [ 0xB5, 0x00, 0x90, 0x00, 0x01 ] as const;

interface MP4Box {
    end: number;
    headerSize: number;
    payloadStart: number;
    size: number;
    start: number;
    type: string;
}

interface ParsedTrack {
    editListOffset: number;
    handlerType: string;
    hasIT35SampleEntry: boolean;
    sampleTransferCharacteristics: Array<number | null>;
    timescale: number;
    trackID: number;
}

interface TrackState {
    editListOffset: number;
    metadataTrackID: number;
    timescale: number;
    videoDefaultSampleDescriptionIndex: number;
    videoDefaultSampleDuration: number;
    videoDefaultSampleSize: number;
    videoSampleTransferCharacteristics: Array<number | null>;
    videoTrackID: number;
}

interface ParsedTFHD {
    defaultSampleDuration: number;
    defaultSampleSize: number;
    flags: number;
    sampleDescriptionIndex: number;
    trackID: number;
}

interface ParsedTRUN {
    dataOffset: number;
    dataOffsetPosition: number;
    flags: number;
    sampleCount: number;
    sampleFieldsStart: number;
    version: number;
}

interface MediaTiming {
    intervalEnd: number;
    intervalStart: number;
}

interface ParsedVideoTrackFragment {
    tfhd: ParsedTFHD;
    trafChildren: MP4Box[];
}

interface ParsedTrackFragment {
    dataOffsetPositions: number[];
    videoTrackFragment: ParsedVideoTrackFragment | null;
}

interface ParsedTrackFragments {
    dataOffsetPositions: number[];
    videoTrackFragments: ParsedVideoTrackFragment[];
}

interface ParsedMediaFragment {
    dataOffsetPositions: number[];
    mediaDataBox: MP4Box;
    movieFragmentBox: MP4Box;
    videoTrackFragment: ParsedVideoTrackFragment;
}

interface ParsedVideoSample {
    compositionOffset: number;
    duration: number;
    nextFieldOffset: number;
    size: number;
}

interface TrackRunTiming {
    dataSize: number;
    decodeTime: number;
    intervalEnd: number;
    intervalStart: number;
    sampleCount: number;
}

interface VideoTrackDefaults {
    defaultSampleDescriptionIndex: number;
    defaultSampleDuration: number;
    defaultSampleSize: number;
}

/**
 * Injects Chromium's timed ST 2094-50 metadata track into simple fragmented
 * MP4 initialization and media segments.
 */
export class FMP4AGTMTransformer {
    private readonly payload: Uint8Array;
    private trackState: TrackState | null = null;

    public constructor(payload: Uint8Array) {
        this.payload = payload.slice();
    }

    /**
     * Adds a metadata track associated with the single video track.
     *
     * Unsupported or malformed initialization segments are returned unchanged.
     */
    public transformInitializationSegment(input: Uint8Array): Uint8Array {
        this.trackState = null;

        if (this.payload.byteLength === 0) {
            return input;
        }

        try {
            const topLevelBoxes = parseBoxes(input, 0, input.byteLength);
            const movieBox = requireSingleBox(topLevelBoxes, 'moov');
            const movieChildren = parseBoxes(
                input,
                movieBox.payloadStart,
                movieBox.end
            );
            const movieHeaderBox = requireSingleBox(movieChildren, 'mvhd');
            const movieExtendsBox = requireSingleBox(movieChildren, 'mvex');
            const trackBoxes = findBoxes(movieChildren, 'trak');
            const parsedTracks: ParsedTrack[] = [];
            const trackIDs = new Set<number>();

            for (const trackBox of trackBoxes) {
                const parsedTrack = parseTrack(input, trackBox);
                if (
                    parsedTrack.trackID === 0
                    || trackIDs.has(parsedTrack.trackID)
                ) {
                    throw new Error('Invalid MP4 track ID');
                }

                trackIDs.add(parsedTrack.trackID);
                parsedTracks.push(parsedTrack);
            }

            const metadataTracks = parsedTracks.filter((parsedTrack) => (
                parsedTrack.handlerType === 'meta'
                && parsedTrack.hasIT35SampleEntry
            ));
            if (metadataTracks.length !== 0) {
                throw new Error('An it35 metadata track already exists');
            }

            const videoTracks = parsedTracks.filter((parsedTrack) => (
                parsedTrack.handlerType === 'vide'
            ));
            if (videoTracks.length !== 1) {
                throw new Error('Exactly one video track is required');
            }

            const videoTrack = videoTracks[0];
            if (videoTrack.timescale === 0) {
                throw new Error('The video timescale must be nonzero');
            }

            let maximumTrackID = 0;
            for (const trackID of trackIDs) {
                maximumTrackID = Math.max(maximumTrackID, trackID);
            }

            if (maximumTrackID >= UINT32_MAX) {
                throw new Error('No metadata track ID is available');
            }

            const metadataTrackID = maximumTrackID + 1;
            const videoDefaults = parseVideoTrackDefaults(
                input,
                movieExtendsBox,
                videoTrack.trackID
            );
            requirePQSampleDescription(
                videoTrack.sampleTransferCharacteristics,
                videoDefaults.defaultSampleDescriptionIndex
            );
            const metadataTrack = createMetadataTrack(
                metadataTrackID,
                videoTrack.trackID,
                videoTrack.timescale
            );
            const metadataTrackExtends = createMetadataTrackExtends(
                metadataTrackID
            );
            const rebuiltMovieExtendsBox = createBox('mvex', [
                input.subarray(movieExtendsBox.payloadStart, movieExtendsBox.end),
                metadataTrackExtends
            ]);
            const patchedMovieHeader = patchNextTrackID(
                input,
                movieHeaderBox,
                metadataTrackID
            );
            const rebuiltMovieParts: Uint8Array[] = [];

            for (const movieChild of movieChildren) {
                switch (movieChild.type) {
                    case 'mvhd':
                        rebuiltMovieParts.push(patchedMovieHeader);
                        break;
                    case 'mvex':
                        rebuiltMovieParts.push(metadataTrack);
                        rebuiltMovieParts.push(rebuiltMovieExtendsBox);
                        break;
                    default:
                        rebuiltMovieParts.push(input.subarray(
                            movieChild.start,
                            movieChild.end
                        ));
                        break;
                }
            }

            const rebuiltMovieBox = createBox('moov', rebuiltMovieParts);
            const output = concatenateBytes([
                input.subarray(0, movieBox.start),
                rebuiltMovieBox,
                input.subarray(movieBox.end)
            ]);

            this.trackState = {
                editListOffset: videoTrack.editListOffset,
                metadataTrackID,
                timescale: videoTrack.timescale,
                videoDefaultSampleDescriptionIndex:
                    videoDefaults.defaultSampleDescriptionIndex,
                videoDefaultSampleDuration:
                    videoDefaults.defaultSampleDuration,
                videoDefaultSampleSize: videoDefaults.defaultSampleSize,
                videoSampleTransferCharacteristics:
                    videoTrack.sampleTransferCharacteristics,
                videoTrackID: videoTrack.trackID
            };

            return output;
        } catch {
            return input;
        }
    }

    /**
     * Adds one AGTM sample spanning all video presentation timestamps in a
     * simple movie fragment.
     *
     * Unsupported or malformed media segments are returned unchanged.
     */
    public transformMediaSegment(input: Uint8Array): Uint8Array {
        const trackState = this.trackState;
        if (trackState === null || this.payload.byteLength === 0) {
            return input;
        }

        try {
            return transformMediaSegment(
                input,
                this.payload,
                trackState
            );
        } catch {
            return input;
        }
    }
}

function transformMediaSegment(
    input: Uint8Array,
    payload: Uint8Array,
    trackState: TrackState
): Uint8Array {
    const parsedFragment = parseMediaFragment(input, trackState);
    const mediaTiming = parseMediaTiming(
        input,
        parsedFragment.videoTrackFragment.trafChildren,
        parsedFragment.videoTrackFragment.tfhd,
        trackState,
        parsedFragment.movieFragmentBox,
        parsedFragment.mediaDataBox
    );
    const sampleDuration = mediaTiming.intervalEnd - mediaTiming.intervalStart;
    if (
        !Number.isSafeInteger(sampleDuration)
        || sampleDuration <= 0
        || sampleDuration > UINT32_MAX
    ) {
        throw new Error('The metadata duration is not representable');
    }

    const placeholderMetadataTrackFragment = createMetadataTrackFragment(
        trackState.metadataTrackID,
        mediaTiming.intervalStart,
        sampleDuration,
        payload.byteLength,
        0
    );
    const insertedLength = placeholderMetadataTrackFragment.byteLength;
    if (
        parsedFragment.movieFragmentBox.size + insertedLength > UINT32_MAX
        || parsedFragment.mediaDataBox.size + payload.byteLength > UINT32_MAX
    ) {
        throw new Error('The transformed boxes exceed 32-bit sizes');
    }

    const metadataDataOffset = parsedFragment.mediaDataBox.end
        + insertedLength
        - parsedFragment.movieFragmentBox.start;
    assertSigned32(metadataDataOffset);
    const metadataTrackFragment = createMetadataTrackFragment(
        trackState.metadataTrackID,
        mediaTiming.intervalStart,
        sampleDuration,
        payload.byteLength,
        metadataDataOffset
    );

    return rebuildMediaSegment(
        input,
        payload,
        parsedFragment,
        metadataTrackFragment
    );
}

function parseMediaFragment(
    input: Uint8Array,
    trackState: TrackState
): ParsedMediaFragment {
    const topLevelBoxes = parseBoxes(input, 0, input.byteLength);
    if (findBoxes(topLevelBoxes, 'sidx').length !== 0) {
        throw new Error('Segment indexes are not supported');
    }

    const movieFragmentBox = requireSingleBox(topLevelBoxes, 'moof');
    const mediaDataBox = requireSingleBox(topLevelBoxes, 'mdat');
    if (
        mediaDataBox.start < movieFragmentBox.end
        || mediaDataBox.headerSize !== BOX_HEADER_SIZE
    ) {
        throw new Error('The media data must follow the movie fragment');
    }

    const movieFragmentChildren = parseBoxes(
        input,
        movieFragmentBox.payloadStart,
        movieFragmentBox.end
    );
    const parsedTrackFragments = parseTrackFragments(
        input,
        findBoxes(movieFragmentChildren, 'traf'),
        trackState,
        movieFragmentBox,
        mediaDataBox
    );

    if (parsedTrackFragments.videoTrackFragments.length !== 1) {
        throw new Error('Exactly one video track fragment is required');
    }

    return {
        dataOffsetPositions: parsedTrackFragments.dataOffsetPositions,
        mediaDataBox,
        movieFragmentBox,
        videoTrackFragment: parsedTrackFragments.videoTrackFragments[0]
    };
}

function parseTrackFragments(
    input: Uint8Array,
    trackFragmentBoxes: readonly MP4Box[],
    trackState: TrackState,
    movieFragmentBox: MP4Box,
    mediaDataBox: MP4Box
): ParsedTrackFragments {
    const dataOffsetPositions: number[] = [];
    const videoTrackFragments: ParsedVideoTrackFragment[] = [];

    for (const trackFragmentBox of trackFragmentBoxes) {
        const parsedTrackFragment = parseTrackFragment(
            input,
            trackFragmentBox,
            trackState,
            movieFragmentBox,
            mediaDataBox
        );
        dataOffsetPositions.push(
            ...parsedTrackFragment.dataOffsetPositions
        );
        if (parsedTrackFragment.videoTrackFragment !== null) {
            videoTrackFragments.push(
                parsedTrackFragment.videoTrackFragment
            );
        }
    }

    return {
        dataOffsetPositions,
        videoTrackFragments
    };
}

function parseTrackFragment(
    input: Uint8Array,
    trackFragmentBox: MP4Box,
    trackState: TrackState,
    movieFragmentBox: MP4Box,
    mediaDataBox: MP4Box
): ParsedTrackFragment {
    const trackFragmentChildren = parseBoxes(
        input,
        trackFragmentBox.payloadStart,
        trackFragmentBox.end
    );
    rejectEncryptedTrackFragment(trackFragmentChildren);
    const trackFragmentHeader = parseTFHD(
        input,
        requireSingleBox(trackFragmentChildren, 'tfhd')
    );
    if (
        (trackFragmentHeader.flags & BASE_DATA_OFFSET_PRESENT_FLAG) !== 0
        || (trackFragmentHeader.flags & DEFAULT_BASE_IS_MOOF_FLAG) === 0
    ) {
        throw new Error('Only moof-relative fragments are supported');
    }

    if (trackFragmentHeader.trackID === trackState.metadataTrackID) {
        throw new Error('The metadata fragment already exists');
    }

    const trackRuns = findBoxes(trackFragmentChildren, 'trun');
    if (trackRuns.length === 0) {
        throw new Error('A track fragment has no track run');
    }

    const dataOffsetPositions: number[] = [];
    for (const trackRun of trackRuns) {
        const parsedTrackRun = parseTRUN(input, trackRun);
        const absoluteDataStart = movieFragmentBox.start
            + parsedTrackRun.dataOffset;
        if (
            absoluteDataStart < mediaDataBox.payloadStart
            || absoluteDataStart > mediaDataBox.end
        ) {
            throw new Error('A track run points outside the mdat');
        }
        dataOffsetPositions.push(parsedTrackRun.dataOffsetPosition);
    }

    const isVideoTrack = trackFragmentHeader.trackID
        === trackState.videoTrackID;
    if (isVideoTrack) {
        const sampleDescriptionIndex =
            trackFragmentHeader.sampleDescriptionIndex
            || trackState.videoDefaultSampleDescriptionIndex;
        requirePQSampleDescription(
            trackState.videoSampleTransferCharacteristics,
            sampleDescriptionIndex
        );
    }

    const videoTrackFragment = isVideoTrack ?
        {
            tfhd: trackFragmentHeader,
            trafChildren: trackFragmentChildren
        } :
        null;

    return {
        dataOffsetPositions,
        videoTrackFragment
    };
}

function rebuildMediaSegment(
    input: Uint8Array,
    payload: Uint8Array,
    parsedFragment: ParsedMediaFragment,
    metadataTrackFragment: Uint8Array
): Uint8Array {
    const movieFragmentBox = parsedFragment.movieFragmentBox;
    const mediaDataBox = parsedFragment.mediaDataBox;
    const insertedLength = metadataTrackFragment.byteLength;
    const rebuiltMovieFragment = new Uint8Array(
        movieFragmentBox.size + insertedLength
    );
    rebuiltMovieFragment.set(
        input.subarray(movieFragmentBox.start, movieFragmentBox.end)
    );
    writeUnsigned32(
        rebuiltMovieFragment,
        0,
        rebuiltMovieFragment.byteLength
    );

    for (const dataOffsetPosition of parsedFragment.dataOffsetPositions) {
        const relativePosition = dataOffsetPosition - movieFragmentBox.start;
        const originalDataOffset = readSigned32(
            rebuiltMovieFragment,
            relativePosition
        );
        const shiftedDataOffset = originalDataOffset + insertedLength;
        assertSigned32(shiftedDataOffset);
        writeSigned32(
            rebuiltMovieFragment,
            relativePosition,
            shiftedDataOffset
        );
    }

    rebuiltMovieFragment.set(metadataTrackFragment, movieFragmentBox.size);
    const rebuiltMediaData = new Uint8Array(
        mediaDataBox.size + payload.byteLength
    );
    rebuiltMediaData.set(input.subarray(mediaDataBox.start, mediaDataBox.end));
    writeUnsigned32(rebuiltMediaData, 0, rebuiltMediaData.byteLength);
    rebuiltMediaData.set(payload, mediaDataBox.size);

    return concatenateBytes([
        input.subarray(0, movieFragmentBox.start),
        rebuiltMovieFragment,
        input.subarray(movieFragmentBox.end, mediaDataBox.start),
        rebuiltMediaData,
        input.subarray(mediaDataBox.end)
    ]);
}

function parseTrack(input: Uint8Array, trackBox: MP4Box): ParsedTrack {
    const trackChildren = parseBoxes(
        input,
        trackBox.payloadStart,
        trackBox.end
    );
    const trackHeaderBox = requireSingleBox(trackChildren, 'tkhd');
    const mediaBox = requireSingleBox(trackChildren, 'mdia');
    const mediaChildren = parseBoxes(input, mediaBox.payloadStart, mediaBox.end);
    const mediaHeaderBox = requireSingleBox(mediaChildren, 'mdhd');
    const handlerBox = requireSingleBox(mediaChildren, 'hdlr');
    const handlerType = readFourCharacterCode(
        input,
        handlerBox.payloadStart + 8
    );
    const trackID = parseTrackID(input, trackHeaderBox);
    const timescale = parseTimescale(input, mediaHeaderBox);
    const mediaInformationBox = requireSingleBox(mediaChildren, 'minf');
    const mediaInformationChildren = parseBoxes(
        input,
        mediaInformationBox.payloadStart,
        mediaInformationBox.end
    );
    const sampleTableBox = requireSingleBox(
        mediaInformationChildren,
        'stbl'
    );
    const sampleTableChildren = parseBoxes(
        input,
        sampleTableBox.payloadStart,
        sampleTableBox.end
    );
    const sampleDescriptionBox = requireSingleBox(
        sampleTableChildren,
        'stsd'
    );
    const sampleEntries = parseSampleEntries(input, sampleDescriptionBox);

    return {
        editListOffset: parseEditListOffset(input, trackChildren),
        handlerType,
        hasIT35SampleEntry: sampleEntries.some((sampleEntry) => (
            sampleEntry.type === 'it35'
        )),
        sampleTransferCharacteristics: handlerType === 'vide' ?
            parseSampleTransferCharacteristics(input, sampleEntries) :
            [],
        timescale,
        trackID
    };
}

function parseTrackID(input: Uint8Array, trackHeaderBox: MP4Box): number {
    ensureRange(input, trackHeaderBox.payloadStart, 4);
    const version = input[trackHeaderBox.payloadStart];
    switch (version) {
        case 0:
            return readUnsigned32(input, trackHeaderBox.payloadStart + 12);
        case 1:
            return readUnsigned32(input, trackHeaderBox.payloadStart + 20);
        default:
            throw new Error('Unsupported tkhd version');
    }
}

function parseTimescale(input: Uint8Array, mediaHeaderBox: MP4Box): number {
    ensureRange(input, mediaHeaderBox.payloadStart, 4);
    const version = input[mediaHeaderBox.payloadStart];
    switch (version) {
        case 0:
            return readUnsigned32(input, mediaHeaderBox.payloadStart + 12);
        case 1:
            return readUnsigned32(input, mediaHeaderBox.payloadStart + 20);
        default:
            throw new Error('Unsupported mdhd version');
    }
}

function parseEditListOffset(
    input: Uint8Array,
    trackChildren: readonly MP4Box[]
): number {
    const editBoxes = findBoxes(trackChildren, 'edts');
    if (editBoxes.length === 0) {
        return 0;
    }

    if (editBoxes.length !== 1) {
        throw new Error('Multiple edit boxes are not supported');
    }

    const editChildren = parseBoxes(
        input,
        editBoxes[0].payloadStart,
        editBoxes[0].end
    );
    const editListBoxes = findBoxes(editChildren, 'elst');
    if (editListBoxes.length === 0) {
        return 0;
    }

    if (editListBoxes.length !== 1) {
        throw new Error('Multiple edit lists are not supported');
    }

    const editListBox = editListBoxes[0];
    ensureRange(input, editListBox.payloadStart, 8);
    const version = input[editListBox.payloadStart];
    const entryCount = readUnsigned32(input, editListBox.payloadStart + 4);
    if (entryCount === 0) {
        return 0;
    }

    let mediaTime: number;
    switch (version) {
        case 0:
            mediaTime = readSigned32(input, editListBox.payloadStart + 12);
            break;
        case 1:
            mediaTime = readSigned64Safe(
                input,
                editListBox.payloadStart + 16
            );
            break;
        default:
            throw new Error('Unsupported elst version');
    }

    return mediaTime < 0 ? 0 : mediaTime;
}

function parseSampleEntries(
    input: Uint8Array,
    sampleDescriptionBox: MP4Box
): MP4Box[] {
    ensureRange(input, sampleDescriptionBox.payloadStart, 8);
    const entryCount = readUnsigned32(
        input,
        sampleDescriptionBox.payloadStart + 4
    );
    const sampleEntries = parseBoxes(
        input,
        sampleDescriptionBox.payloadStart + 8,
        sampleDescriptionBox.end
    );
    if (sampleEntries.length !== entryCount) {
        throw new Error('The stsd entry count is inconsistent');
    }

    return sampleEntries;
}

function parseSampleTransferCharacteristics(
    input: Uint8Array,
    sampleEntries: readonly MP4Box[]
): Array<number | null> {
    const transferCharacteristics: Array<number | null> = [];
    for (const sampleEntry of sampleEntries) {
        transferCharacteristics.push(
            parseSampleEntryTransferCharacteristics(input, sampleEntry)
        );
    }

    return transferCharacteristics;
}

function parseSampleEntryTransferCharacteristics(
    input: Uint8Array,
    sampleEntry: MP4Box
): number | null {
    const visualSampleEntryTypes = new Set([
        'avc1',
        'avc3',
        'hev1',
        'hvc1',
        'vp08',
        'vp09',
        'av01'
    ]);
    if (!visualSampleEntryTypes.has(sampleEntry.type)) {
        return null;
    }

    const childBoxesStart = sampleEntry.payloadStart
        + VISUAL_SAMPLE_ENTRY_FIELDS_SIZE;
    if (childBoxesStart > sampleEntry.end) {
        return null;
    }

    const sampleEntryChildren = parseBoxes(
        input,
        childBoxesStart,
        sampleEntry.end
    );
    const colorInformationBoxes = findBoxes(sampleEntryChildren, 'colr');
    if (colorInformationBoxes.length !== 1) {
        return null;
    }

    const colorInformationBox = colorInformationBoxes[0];
    ensureRange(input, colorInformationBox.payloadStart, 11);
    if (
        readFourCharacterCode(input, colorInformationBox.payloadStart)
        !== 'nclx'
    ) {
        return null;
    }

    return readUnsigned16(input, colorInformationBox.payloadStart + 6);
}

function requirePQSampleDescription(
    transferCharacteristics: readonly (number | null)[],
    sampleDescriptionIndex: number
): void {
    if (
        !Number.isInteger(sampleDescriptionIndex)
        || sampleDescriptionIndex < 1
        || sampleDescriptionIndex > transferCharacteristics.length
        || transferCharacteristics[sampleDescriptionIndex - 1]
            !== PQ_TRANSFER_CHARACTERISTICS
    ) {
        throw new Error('The selected video sample description is not PQ');
    }
}

function parseVideoTrackDefaults(
    input: Uint8Array,
    movieExtendsBox: MP4Box,
    videoTrackID: number
): VideoTrackDefaults {
    const movieExtendsChildren = parseBoxes(
        input,
        movieExtendsBox.payloadStart,
        movieExtendsBox.end
    );
    const trackExtendsBoxes = findBoxes(movieExtendsChildren, 'trex');
    const matchingTrackExtendsBoxes: MP4Box[] = [];

    for (const trackExtendsBox of trackExtendsBoxes) {
        ensureRange(input, trackExtendsBox.payloadStart, 24);
        if (
            readUnsigned32(input, trackExtendsBox.payloadStart + 4)
            === videoTrackID
        ) {
            matchingTrackExtendsBoxes.push(trackExtendsBox);
        }
    }

    if (matchingTrackExtendsBoxes.length !== 1) {
        throw new Error('Exactly one video trex is required');
    }

    const videoTrackExtendsBox = matchingTrackExtendsBoxes[0];
    return {
        defaultSampleDescriptionIndex: readUnsigned32(
            input,
            videoTrackExtendsBox.payloadStart + 8
        ),
        defaultSampleDuration: readUnsigned32(
            input,
            videoTrackExtendsBox.payloadStart + 12
        ),
        defaultSampleSize: readUnsigned32(
            input,
            videoTrackExtendsBox.payloadStart + 16
        )
    };
}

function patchNextTrackID(
    input: Uint8Array,
    movieHeaderBox: MP4Box,
    metadataTrackID: number
): Uint8Array {
    ensureRange(input, movieHeaderBox.payloadStart, 4);
    const version = input[movieHeaderBox.payloadStart];
    const minimumBoxSize = version === 0 ? 108 : 120;
    if (
        (version !== 0 && version !== 1)
        || movieHeaderBox.size < minimumBoxSize
    ) {
        throw new Error('Unsupported mvhd box');
    }

    const patchedMovieHeader = input.slice(
        movieHeaderBox.start,
        movieHeaderBox.end
    );
    const nextTrackIDOffset = patchedMovieHeader.byteLength - 4;
    const currentNextTrackID = readUnsigned32(
        patchedMovieHeader,
        nextTrackIDOffset
    );
    const nextTrackID = currentNextTrackID <= metadataTrackID ?
        metadataTrackID + 1 :
        currentNextTrackID;
    writeUnsigned32(patchedMovieHeader, nextTrackIDOffset, nextTrackID);

    return patchedMovieHeader;
}

function parseTFHD(input: Uint8Array, trackFragmentHeader: MP4Box): ParsedTFHD {
    ensureRange(input, trackFragmentHeader.payloadStart, 8);
    const flags = readFullBoxFlags(input, trackFragmentHeader.payloadStart);
    const trackID = readUnsigned32(
        input,
        trackFragmentHeader.payloadStart + 4
    );
    let readOffset = trackFragmentHeader.payloadStart + 8;

    if ((flags & BASE_DATA_OFFSET_PRESENT_FLAG) !== 0) {
        ensureRange(input, readOffset, 8);
        readOffset += 8;
    }

    let sampleDescriptionIndex = 0;
    if ((flags & SAMPLE_DESCRIPTION_INDEX_PRESENT_FLAG) !== 0) {
        sampleDescriptionIndex = readUnsigned32(input, readOffset);
        readOffset += 4;
    }

    let defaultSampleDuration = 0;
    if ((flags & DEFAULT_SAMPLE_DURATION_PRESENT_FLAG) !== 0) {
        defaultSampleDuration = readUnsigned32(input, readOffset);
        readOffset += 4;
    }

    let defaultSampleSize = 0;
    if ((flags & DEFAULT_SAMPLE_SIZE_PRESENT_FLAG) !== 0) {
        defaultSampleSize = readUnsigned32(input, readOffset);
        readOffset += 4;
    }

    if ((flags & DEFAULT_SAMPLE_FLAGS_PRESENT_FLAG) !== 0) {
        ensureRange(input, readOffset, 4);
        readOffset += 4;
    }

    if (readOffset !== trackFragmentHeader.end) {
        throw new Error('Malformed tfhd box');
    }

    return {
        defaultSampleDuration,
        defaultSampleSize,
        flags,
        sampleDescriptionIndex,
        trackID
    };
}

function parseTRUN(input: Uint8Array, trackRun: MP4Box): ParsedTRUN {
    ensureRange(input, trackRun.payloadStart, 8);
    const version = input[trackRun.payloadStart];
    if (version !== 0 && version !== 1) {
        throw new Error('Unsupported trun version');
    }

    const flags = readFullBoxFlags(input, trackRun.payloadStart);
    if ((flags & TRUN_DATA_OFFSET_PRESENT_FLAG) === 0) {
        throw new Error('Every trun must have an explicit data offset');
    }

    const sampleCount = readUnsigned32(input, trackRun.payloadStart + 4);
    const dataOffsetPosition = trackRun.payloadStart + 8;
    const dataOffset = readSigned32(input, dataOffsetPosition);
    let sampleFieldsStart = dataOffsetPosition + 4;

    if ((flags & TRUN_FIRST_SAMPLE_FLAGS_PRESENT_FLAG) !== 0) {
        ensureRange(input, sampleFieldsStart, 4);
        sampleFieldsStart += 4;
    }

    let bytesPerSample = 0;
    if ((flags & TRUN_SAMPLE_DURATION_PRESENT_FLAG) !== 0) {
        bytesPerSample += 4;
    }
    if ((flags & TRUN_SAMPLE_SIZE_PRESENT_FLAG) !== 0) {
        bytesPerSample += 4;
    }
    if ((flags & TRUN_SAMPLE_FLAGS_PRESENT_FLAG) !== 0) {
        bytesPerSample += 4;
    }
    if ((flags & TRUN_SAMPLE_COMPOSITION_OFFSET_PRESENT_FLAG) !== 0) {
        bytesPerSample += 4;
    }

    const sampleFieldsLength = sampleCount * bytesPerSample;
    if (
        !Number.isSafeInteger(sampleFieldsLength)
        || sampleFieldsStart + sampleFieldsLength !== trackRun.end
    ) {
        throw new Error('Malformed trun box');
    }

    return {
        dataOffset,
        dataOffsetPosition,
        flags,
        sampleCount,
        sampleFieldsStart,
        version
    };
}

function parseMediaTiming(
    input: Uint8Array,
    trackFragmentChildren: readonly MP4Box[],
    trackFragmentHeader: ParsedTFHD,
    trackState: TrackState,
    movieFragmentBox: MP4Box,
    mediaDataBox: MP4Box
): MediaTiming {
    const trackFragmentDecodeTimeBox = requireSingleBox(
        trackFragmentChildren,
        'tfdt'
    );
    let decodeTime = parseBaseMediaDecodeTime(
        input,
        trackFragmentDecodeTimeBox
    );
    let intervalStart = Number.POSITIVE_INFINITY;
    let intervalEnd = Number.NEGATIVE_INFINITY;
    let sampleTotal = 0;
    const trackRunBoxes = findBoxes(trackFragmentChildren, 'trun');

    for (const trackRunBox of trackRunBoxes) {
        const trackRun = parseTRUN(input, trackRunBox);
        const trackRunTiming = parseTrackRunTiming(
            input,
            trackRun,
            trackFragmentHeader,
            trackState,
            decodeTime
        );
        decodeTime = trackRunTiming.decodeTime;
        intervalStart = Math.min(
            intervalStart,
            trackRunTiming.intervalStart
        );
        intervalEnd = Math.max(intervalEnd, trackRunTiming.intervalEnd);
        sampleTotal += trackRunTiming.sampleCount;
        const absoluteTrackRunDataEnd = movieFragmentBox.start
            + trackRun.dataOffset
            + trackRunTiming.dataSize;
        if (absoluteTrackRunDataEnd > mediaDataBox.end) {
            throw new Error('Video samples exceed the mdat');
        }
    }

    if (sampleTotal === 0) {
        throw new Error('The video fragment has no samples');
    }

    return {
        intervalEnd,
        intervalStart
    };
}

function parseTrackRunTiming(
    input: Uint8Array,
    trackRun: ParsedTRUN,
    trackFragmentHeader: ParsedTFHD,
    trackState: TrackState,
    initialDecodeTime: number
): TrackRunTiming {
    let decodeTime = initialDecodeTime;
    let intervalStart = Number.POSITIVE_INFINITY;
    let intervalEnd = Number.NEGATIVE_INFINITY;
    let sampleFieldOffset = trackRun.sampleFieldsStart;
    let dataSize = 0;

    for (
        let sampleIndex = 0;
        sampleIndex < trackRun.sampleCount;
        sampleIndex++
    ) {
        const sample = parseVideoSample(
            input,
            trackRun,
            trackFragmentHeader,
            trackState,
            sampleFieldOffset
        );
        const presentationTime = decodeTime
            + sample.compositionOffset
            - trackState.editListOffset;
        const presentationEnd = presentationTime + sample.duration;
        decodeTime += sample.duration;
        dataSize += sample.size;
        assertSafeSampleValues(
            presentationTime,
            presentationEnd,
            decodeTime,
            dataSize
        );

        intervalStart = Math.min(intervalStart, presentationTime);
        intervalEnd = Math.max(intervalEnd, presentationEnd);
        sampleFieldOffset = sample.nextFieldOffset;
    }

    return {
        dataSize,
        decodeTime,
        intervalEnd,
        intervalStart,
        sampleCount: trackRun.sampleCount
    };
}

function parseVideoSample(
    input: Uint8Array,
    trackRun: ParsedTRUN,
    trackFragmentHeader: ParsedTFHD,
    trackState: TrackState,
    initialFieldOffset: number
): ParsedVideoSample {
    let fieldOffset = initialFieldOffset;
    let duration = trackFragmentHeader.defaultSampleDuration
        || trackState.videoDefaultSampleDuration;
    if ((trackRun.flags & TRUN_SAMPLE_DURATION_PRESENT_FLAG) !== 0) {
        duration = readUnsigned32(input, fieldOffset);
        fieldOffset += 4;
    }

    let size = trackFragmentHeader.defaultSampleSize
        || trackState.videoDefaultSampleSize;
    if ((trackRun.flags & TRUN_SAMPLE_SIZE_PRESENT_FLAG) !== 0) {
        size = readUnsigned32(input, fieldOffset);
        fieldOffset += 4;
    }

    if ((trackRun.flags & TRUN_SAMPLE_FLAGS_PRESENT_FLAG) !== 0) {
        ensureRange(input, fieldOffset, 4);
        fieldOffset += 4;
    }

    let compositionOffset = 0;
    if (
        (trackRun.flags
            & TRUN_SAMPLE_COMPOSITION_OFFSET_PRESENT_FLAG) !== 0
    ) {
        compositionOffset = trackRun.version === 0 ?
            readUnsigned32(input, fieldOffset) :
            readSigned32(input, fieldOffset);
        fieldOffset += 4;
    }

    if (duration === 0 || size === 0) {
        throw new Error('Video samples require duration and size');
    }

    return {
        compositionOffset,
        duration,
        nextFieldOffset: fieldOffset,
        size
    };
}

function assertSafeSampleValues(
    presentationTime: number,
    presentationEnd: number,
    decodeTime: number,
    dataSize: number
): void {
    if (
        !Number.isSafeInteger(presentationTime)
        || !Number.isSafeInteger(presentationEnd)
        || !Number.isSafeInteger(decodeTime)
        || !Number.isSafeInteger(dataSize)
    ) {
        throw new Error('Video sample timing exceeds safe integers');
    }
}

function parseBaseMediaDecodeTime(
    input: Uint8Array,
    trackFragmentDecodeTimeBox: MP4Box
): number {
    ensureRange(input, trackFragmentDecodeTimeBox.payloadStart, 4);
    const version = input[trackFragmentDecodeTimeBox.payloadStart];
    switch (version) {
        case 0:
            return readUnsigned32(
                input,
                trackFragmentDecodeTimeBox.payloadStart + 4
            );
        case 1:
            return readUnsigned64Safe(
                input,
                trackFragmentDecodeTimeBox.payloadStart + 4
            );
        default:
            throw new Error('Unsupported tfdt version');
    }
}

function rejectEncryptedTrackFragment(
    trackFragmentChildren: readonly MP4Box[]
): void {
    const encryptedBoxTypes = new Set([ 'senc', 'saio', 'saiz' ]);
    for (const trackFragmentChild of trackFragmentChildren) {
        if (encryptedBoxTypes.has(trackFragmentChild.type)) {
            throw new Error('Encrypted fragments are not supported');
        }
    }
}

function createMetadataTrack(
    metadataTrackID: number,
    videoTrackID: number,
    timescale: number
): Uint8Array {
    const trackHeader = createTrackHeader(metadataTrackID);
    const trackReference = createBox('tref', [
        createBox('rndr', [ createUnsigned32Bytes(videoTrackID) ])
    ]);
    const mediaHeader = createFullBox('mdhd', 0, 0, [
        createUnsigned32Bytes(0),
        createUnsigned32Bytes(0),
        createUnsigned32Bytes(timescale),
        createUnsigned32Bytes(0),
        createUnsigned16Bytes(UNDEFINED_LANGUAGE_CODE),
        createUnsigned16Bytes(0)
    ]);
    const handler = createFullBox('hdlr', 0, 0, [
        createUnsigned32Bytes(0),
        createFourCharacterCodeBytes('meta'),
        new Uint8Array(12),
        new Uint8Array(1)
    ]);
    const nullMediaHeader = createFullBox('nmhd', 0, 0, []);
    const dataReference = createFullBox('dref', 0, 0, [
        createUnsigned32Bytes(1),
        createFullBox('url ', 0, 1, [])
    ]);
    const dataInformation = createBox('dinf', [ dataReference ]);
    const sampleDescription = createFullBox('stsd', 0, 0, [
        createUnsigned32Bytes(1),
        createIT35SampleEntry()
    ]);
    const sampleTable = createBox('stbl', [
        sampleDescription,
        createEmptyTableBox('stts'),
        createEmptyTableBox('stsc'),
        createFullBox('stsz', 0, 0, [
            createUnsigned32Bytes(0),
            createUnsigned32Bytes(0)
        ]),
        createEmptyTableBox('stco')
    ]);
    const mediaInformation = createBox('minf', [
        nullMediaHeader,
        dataInformation,
        sampleTable
    ]);
    const media = createBox('mdia', [
        mediaHeader,
        handler,
        mediaInformation
    ]);

    return createBox('trak', [
        trackHeader,
        trackReference,
        media
    ]);
}

function createTrackHeader(trackID: number): Uint8Array {
    const matrixValues = [
        0x00010000, 0, 0,
        0, 0x00010000, 0,
        0, 0, 0x40000000
    ];
    const matrixParts: Uint8Array[] = [];
    for (const matrixValue of matrixValues) {
        matrixParts.push(createUnsigned32Bytes(matrixValue));
    }

    return createFullBox('tkhd', 0, 3, [
        createUnsigned32Bytes(0),
        createUnsigned32Bytes(0),
        createUnsigned32Bytes(trackID),
        createUnsigned32Bytes(0),
        createUnsigned32Bytes(0),
        new Uint8Array(8),
        createUnsigned16Bytes(0),
        createUnsigned16Bytes(0),
        createUnsigned16Bytes(0),
        createUnsigned16Bytes(0),
        concatenateBytes(matrixParts),
        createUnsigned32Bytes(0),
        createUnsigned32Bytes(0)
    ]);
}

function createIT35SampleEntry(): Uint8Array {
    return createBox('it35', [
        new Uint8Array(6),
        createUnsigned16Bytes(1),
        new Uint8Array([ IT35_IDENTIFIER.length ]),
        new Uint8Array(IT35_IDENTIFIER)
    ]);
}

function createEmptyTableBox(type: string): Uint8Array {
    return createFullBox(type, 0, 0, [ createUnsigned32Bytes(0) ]);
}

function createMetadataTrackExtends(metadataTrackID: number): Uint8Array {
    return createFullBox('trex', 0, 0, [
        createUnsigned32Bytes(metadataTrackID),
        createUnsigned32Bytes(1),
        createUnsigned32Bytes(0),
        createUnsigned32Bytes(0),
        createUnsigned32Bytes(0)
    ]);
}

function createMetadataTrackFragment(
    metadataTrackID: number,
    intervalStart: number,
    sampleDuration: number,
    sampleSize: number,
    dataOffset: number
): Uint8Array {
    const hasNegativePresentationTime = intervalStart < 0;
    const baseDecodeTime = hasNegativePresentationTime ? 0 : intervalStart;
    if (
        !Number.isSafeInteger(baseDecodeTime)
        || baseDecodeTime < 0
    ) {
        throw new Error('The metadata decode time is not representable');
    }

    const trackFragmentHeader = createFullBox(
        'tfhd',
        0,
        DEFAULT_BASE_IS_MOOF_FLAG,
        [ createUnsigned32Bytes(metadataTrackID) ]
    );
    const trackFragmentDecodeTime = baseDecodeTime <= UINT32_MAX ?
        createFullBox('tfdt', 0, 0, [
            createUnsigned32Bytes(baseDecodeTime)
        ]) :
        createFullBox('tfdt', 1, 0, [
            createUnsigned64Bytes(baseDecodeTime)
        ]);
    const trackRunParts: Uint8Array[] = [
        createUnsigned32Bytes(1),
        createSigned32Bytes(dataOffset),
        createUnsigned32Bytes(sampleDuration),
        createUnsigned32Bytes(sampleSize)
    ];
    let trackRunFlags = TRUN_DATA_OFFSET_PRESENT_FLAG
        | TRUN_SAMPLE_DURATION_PRESENT_FLAG
        | TRUN_SAMPLE_SIZE_PRESENT_FLAG;
    let trackRunVersion = 0;

    if (hasNegativePresentationTime) {
        assertSigned32(intervalStart);
        trackRunVersion = 1;
        trackRunFlags |= TRUN_SAMPLE_COMPOSITION_OFFSET_PRESENT_FLAG;
        trackRunParts.push(createSigned32Bytes(intervalStart));
    }

    const trackRun = createFullBox(
        'trun',
        trackRunVersion,
        trackRunFlags,
        trackRunParts
    );

    return createBox('traf', [
        trackFragmentHeader,
        trackFragmentDecodeTime,
        trackRun
    ]);
}

function parseBoxes(
    input: Uint8Array,
    start: number,
    end: number
): MP4Box[] {
    if (
        !Number.isSafeInteger(start)
        || !Number.isSafeInteger(end)
        || start < 0
        || end < start
        || end > input.byteLength
    ) {
        throw new Error('Invalid MP4 box range');
    }

    const boxes: MP4Box[] = [];
    let readOffset = start;
    while (readOffset < end) {
        ensureRange(input, readOffset, BOX_HEADER_SIZE);
        const size = readUnsigned32(input, readOffset);
        if (size === 0 || size === 1 || size < BOX_HEADER_SIZE) {
            throw new Error('Unsupported MP4 box size');
        }

        const boxEnd = readOffset + size;
        if (!Number.isSafeInteger(boxEnd) || boxEnd > end) {
            throw new Error('MP4 box exceeds its container');
        }

        boxes.push({
            end: boxEnd,
            headerSize: BOX_HEADER_SIZE,
            payloadStart: readOffset + BOX_HEADER_SIZE,
            size,
            start: readOffset,
            type: readFourCharacterCode(input, readOffset + 4)
        });
        readOffset = boxEnd;
    }

    if (readOffset !== end) {
        throw new Error('MP4 boxes do not fill their container');
    }

    return boxes;
}

function findBoxes(
    boxes: readonly MP4Box[],
    type: string
): MP4Box[] {
    const matchingBoxes: MP4Box[] = [];
    for (const box of boxes) {
        if (box.type === type) {
            matchingBoxes.push(box);
        }
    }

    return matchingBoxes;
}

function requireSingleBox(
    boxes: readonly MP4Box[],
    type: string
): MP4Box {
    const matchingBoxes = findBoxes(boxes, type);
    if (matchingBoxes.length !== 1) {
        throw new Error(`Exactly one ${type} box is required`);
    }

    return matchingBoxes[0];
}

function createBox(
    type: string,
    payloadParts: readonly Uint8Array[]
): Uint8Array {
    const payload = concatenateBytes(payloadParts);
    const size = BOX_HEADER_SIZE + payload.byteLength;
    if (size > UINT32_MAX) {
        throw new Error('MP4 box exceeds a 32-bit size');
    }

    const box = new Uint8Array(size);
    writeUnsigned32(box, 0, size);
    box.set(createFourCharacterCodeBytes(type), 4);
    box.set(payload, BOX_HEADER_SIZE);

    return box;
}

function createFullBox(
    type: string,
    version: number,
    flags: number,
    payloadParts: readonly Uint8Array[]
): Uint8Array {
    if (
        !Number.isInteger(version)
        || version < 0
        || version > 0xFF
        || !Number.isInteger(flags)
        || flags < 0
        || flags > 0xFFFFFF
    ) {
        throw new Error('Invalid full box header');
    }

    const fullBoxHeader = new Uint8Array([
        version,
        (flags >>> 16) & 0xFF,
        (flags >>> 8) & 0xFF,
        flags & 0xFF
    ]);

    return createBox(type, [ fullBoxHeader, ...payloadParts ]);
}

function concatenateBytes(parts: readonly Uint8Array[]): Uint8Array {
    let totalLength = 0;
    for (const part of parts) {
        totalLength += part.byteLength;
        if (!Number.isSafeInteger(totalLength)) {
            throw new Error('Byte array length exceeds safe integers');
        }
    }

    const output = new Uint8Array(totalLength);
    let writeOffset = 0;
    for (const part of parts) {
        output.set(part, writeOffset);
        writeOffset += part.byteLength;
    }

    return output;
}

function createFourCharacterCodeBytes(type: string): Uint8Array {
    if (type.length !== 4) {
        throw new Error('MP4 box types must contain four characters');
    }

    const bytes = new Uint8Array(4);
    for (let characterIndex = 0; characterIndex < 4; characterIndex++) {
        const characterCode = type.charCodeAt(characterIndex);
        if (characterCode > 0x7F) {
            throw new Error('MP4 box types must be ASCII');
        }
        bytes[characterIndex] = characterCode;
    }

    return bytes;
}

function readFourCharacterCode(
    input: Uint8Array,
    offset: number
): string {
    ensureRange(input, offset, 4);
    return String.fromCharCode(
        input[offset],
        input[offset + 1],
        input[offset + 2],
        input[offset + 3]
    );
}

function readFullBoxFlags(input: Uint8Array, offset: number): number {
    ensureRange(input, offset, 4);
    return (
        input[offset + 1] * 0x10000
        + input[offset + 2] * 0x100
        + input[offset + 3]
    );
}

function readUnsigned16(input: Uint8Array, offset: number): number {
    ensureRange(input, offset, 2);
    const view = new DataView(
        input.buffer,
        input.byteOffset + offset,
        2
    );
    return view.getUint16(0);
}

function readUnsigned32(input: Uint8Array, offset: number): number {
    ensureRange(input, offset, 4);
    const view = new DataView(
        input.buffer,
        input.byteOffset + offset,
        4
    );
    return view.getUint32(0);
}

function readSigned32(input: Uint8Array, offset: number): number {
    ensureRange(input, offset, 4);
    const view = new DataView(
        input.buffer,
        input.byteOffset + offset,
        4
    );
    return view.getInt32(0);
}

function readUnsigned64Safe(input: Uint8Array, offset: number): number {
    const high = readUnsigned32(input, offset);
    const low = readUnsigned32(input, offset + 4);
    const value = high * UINT32_RANGE + low;
    if (!Number.isSafeInteger(value)) {
        throw new Error('64-bit value exceeds safe integers');
    }

    return value;
}

function readSigned64Safe(input: Uint8Array, offset: number): number {
    const high = readSigned32(input, offset);
    const low = readUnsigned32(input, offset + 4);
    const value = high * UINT32_RANGE + low;
    if (!Number.isSafeInteger(value)) {
        throw new Error('64-bit value exceeds safe integers');
    }

    return value;
}

function createUnsigned16Bytes(value: number): Uint8Array {
    if (!Number.isInteger(value) || value < 0 || value > 0xFFFF) {
        throw new Error('Value is not an unsigned 16-bit integer');
    }

    const bytes = new Uint8Array(2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, value);
    return bytes;
}

function createUnsigned32Bytes(value: number): Uint8Array {
    const bytes = new Uint8Array(4);
    writeUnsigned32(bytes, 0, value);
    return bytes;
}

function createSigned32Bytes(value: number): Uint8Array {
    const bytes = new Uint8Array(4);
    writeSigned32(bytes, 0, value);
    return bytes;
}

function createUnsigned64Bytes(value: number): Uint8Array {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('Value is not a safe unsigned 64-bit integer');
    }

    return concatenateBytes([
        createUnsigned32Bytes(Math.floor(value / UINT32_RANGE)),
        createUnsigned32Bytes(value % UINT32_RANGE)
    ]);
}

function writeUnsigned32(
    output: Uint8Array,
    offset: number,
    value: number
): void {
    if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
        throw new Error('Value is not an unsigned 32-bit integer');
    }

    ensureRange(output, offset, 4);
    const view = new DataView(
        output.buffer,
        output.byteOffset + offset,
        4
    );
    view.setUint32(0, value);
}

function writeSigned32(
    output: Uint8Array,
    offset: number,
    value: number
): void {
    assertSigned32(value);
    ensureRange(output, offset, 4);
    const view = new DataView(
        output.buffer,
        output.byteOffset + offset,
        4
    );
    view.setInt32(0, value);
}

function assertSigned32(value: number): void {
    if (
        !Number.isInteger(value)
        || value < INT32_MIN
        || value > INT32_MAX
    ) {
        throw new Error('Value is not a signed 32-bit integer');
    }
}

function ensureRange(
    input: Uint8Array,
    offset: number,
    length: number
): void {
    if (
        !Number.isSafeInteger(offset)
        || !Number.isSafeInteger(length)
        || offset < 0
        || length < 0
        || offset + length > input.byteLength
    ) {
        throw new Error('Byte range is outside the input');
    }
}
