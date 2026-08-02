const FILE_TYPE_BOX = 'ftyp';
const MOVIE_BOX = 'moov';
const TRACK_BOX = 'trak';
const TRACK_HEADER_BOX = 'tkhd';
const TRACK_REFERENCE_BOX = 'tref';
const VIDEO_DEPENDENCY_REFERENCE_BOX = 'vdep';
const MEDIA_BOX = 'mdia';
const HANDLER_BOX = 'hdlr';
const MEDIA_INFORMATION_BOX = 'minf';
const SAMPLE_TABLE_BOX = 'stbl';
const SAMPLE_DESCRIPTION_BOX = 'stsd';
const HEVC_CONFIGURATION_BOX = 'hvcC';
const DOLBY_VISION_CONFIGURATION_BOX = 'dvcC';
const VIDEO_HANDLER_TYPE = 'vide';
const BASE_HEVC_SAMPLE_ENTRY_TYPES = new Set([ 'hvc1', 'hev1' ]);
const DOLBY_VISION_HEVC_SAMPLE_ENTRY_TYPES = new Set([ 'dvh1', 'dvhe' ]);
const BASIC_BOX_HEADER_BYTE_LENGTH = 8;
const EXTENDED_BOX_HEADER_BYTE_LENGTH = 16;
const VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH = 78;
const FULL_BOX_HEADER_BYTE_LENGTH = 4;
const MAXIMUM_TOP_LEVEL_BOX_COUNT = 128;
const MAXIMUM_CHILD_BOX_COUNT = 4_096;
const MAXIMUM_TRACK_COUNT = 1_024;
const MAXIMUM_SAMPLE_ENTRY_COUNT = 16;
const MAXIMUM_MOVIE_BOX_BYTE_LENGTH = 16 * 1_024 * 1_024;
const MINIMUM_HEVC_CONFIGURATION_BYTE_LENGTH = 23;
const MAXIMUM_HEVC_CONFIGURATION_BYTE_LENGTH = 1_024 * 1_024;
const MINIMUM_DOLBY_VISION_CONFIGURATION_BYTE_LENGTH = 4;
const MAXIMUM_DOLBY_VISION_CONFIGURATION_BYTE_LENGTH = 1_024;

export type ISOBaseMediaByteRangeReader = (
    offset: number,
    byteLength: number
) => Promise<Uint8Array | null>;

export type ISOBaseMediaDolbyVisionTrackConfiguration = {
    enhancementConfiguration: Uint8Array
    separateEnhancementTrackNumber: number
};

type ISOBaseMediaBox = {
    dataOffset: number
    dataSize: number
    endOffset: number
    headerByteLength: number
    startOffset: number
    type: string
};

type ParsedDolbyVisionConfiguration = {
    baseLayerPresent: boolean
    enhancementLayerPresent: boolean
    profile: number
    rpuPresent: boolean
};

type ParsedVideoSampleEntry = {
    dolbyVisionConfiguration: ParsedDolbyVisionConfiguration | null
    hevcConfiguration: Uint8Array | null
    type: string
};

type ParsedTrack = {
    handlerType: string | null
    trackID: number | null
    videoDependencyTrackIDs: readonly number[]
    videoSampleEntry: ParsedVideoSampleEntry | null
};

function readUnsigned32(data: Uint8Array, offset: number, endOffset: number): number {
    if (offset < 0 || offset + 4 > endOffset) {
        throw new TypeError('The ISO base media unsigned integer is truncated');
    }
    return (
        (data[offset] * 0x1_000000)
        + (data[offset + 1] * 0x1_0000)
        + (data[offset + 2] * 0x100)
        + data[offset + 3]
    );
}

function readUnsigned64(data: Uint8Array, offset: number, endOffset: number): number {
    const highValue = readUnsigned32(data, offset, endOffset);
    const lowValue = readUnsigned32(data, offset + 4, endOffset);
    const value = (highValue * 0x1_0000_0000) + lowValue;
    if (!Number.isSafeInteger(value)) {
        throw new TypeError('The ISO base media box size exceeds the safe integer range');
    }
    return value;
}

function readFourCC(data: Uint8Array, offset: number, endOffset: number): string {
    if (offset < 0 || offset + 4 > endOffset) {
        throw new TypeError('The ISO base media box type is truncated');
    }
    let value = '';
    for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
        const byteValue = data[offset + byteIndex];
        if (byteValue < 0x20 || byteValue > 0x7E) {
            throw new TypeError('The ISO base media box type is not printable ASCII');
        }
        value += String.fromCharCode(byteValue);
    }
    return value;
}

function parseBox(
    data: Uint8Array,
    startOffset: number,
    containerEndOffset: number
): ISOBaseMediaBox {
    if (startOffset < 0 || startOffset + BASIC_BOX_HEADER_BYTE_LENGTH > containerEndOffset) {
        throw new TypeError('The ISO base media box header is truncated');
    }
    const compactSize = readUnsigned32(data, startOffset, containerEndOffset);
    const type = readFourCC(data, startOffset + 4, containerEndOffset);
    const headerByteLength = compactSize === 1 ?
        EXTENDED_BOX_HEADER_BYTE_LENGTH :
        BASIC_BOX_HEADER_BYTE_LENGTH;
    let boxByteLength = compactSize;
    if (compactSize === 1) {
        boxByteLength = readUnsigned64(data, startOffset + 8, containerEndOffset);
    } else if (compactSize === 0) {
        boxByteLength = containerEndOffset - startOffset;
    }
    if (boxByteLength < headerByteLength) {
        throw new TypeError('The ISO base media box size is invalid');
    }
    const endOffset = startOffset + boxByteLength;
    if (!Number.isSafeInteger(endOffset) || endOffset > containerEndOffset) {
        throw new TypeError('The ISO base media box exceeds its container');
    }
    const dataOffset = startOffset + headerByteLength;
    return {
        dataOffset,
        dataSize: endOffset - dataOffset,
        endOffset,
        headerByteLength,
        startOffset,
        type
    };
}

function parseChildren(
    data: Uint8Array,
    startOffset: number,
    endOffset: number
): ISOBaseMediaBox[] {
    const boxes: ISOBaseMediaBox[] = [];
    let offset = startOffset;
    while (offset < endOffset) {
        if (boxes.length >= MAXIMUM_CHILD_BOX_COUNT) {
            throw new TypeError('The ISO base media child box count exceeds its bound');
        }
        const box = parseBox(data, offset, endOffset);
        boxes.push(box);
        offset = box.endOffset;
    }
    return boxes;
}

function findUniqueBox(
    boxes: readonly ISOBaseMediaBox[],
    type: string
): ISOBaseMediaBox | null {
    const matchingBoxes = boxes.filter((box: ISOBaseMediaBox): boolean => box.type === type);
    if (matchingBoxes.length > 1) {
        throw new TypeError(`The ISO base media ${type} box is duplicated`);
    }
    return matchingBoxes[0] ?? null;
}

function findUniqueNestedBox(
    data: Uint8Array,
    rootBox: ISOBaseMediaBox,
    path: readonly string[]
): ISOBaseMediaBox | null {
    let currentBox = rootBox;
    for (const type of path) {
        const childBoxes = parseChildren(data, currentBox.dataOffset, currentBox.endOffset);
        const childBox = findUniqueBox(childBoxes, type);
        if (!childBox) {
            return null;
        }
        currentBox = childBox;
    }
    return currentBox;
}

function parseTrackID(data: Uint8Array, trackBox: ISOBaseMediaBox): number | null {
    const trackHeaderBox = findUniqueNestedBox(data, trackBox, [ TRACK_HEADER_BOX ]);
    if (!trackHeaderBox || trackHeaderBox.dataSize < FULL_BOX_HEADER_BYTE_LENGTH) {
        return null;
    }
    const version = data[trackHeaderBox.dataOffset];
    let trackIDOffset: number;
    switch (version) {
        case 0:
            trackIDOffset = trackHeaderBox.dataOffset + 12;
            break;
        case 1:
            trackIDOffset = trackHeaderBox.dataOffset + 20;
            break;
        default:
            return null;
    }
    const trackID = readUnsigned32(data, trackIDOffset, trackHeaderBox.endOffset);
    return trackID > 0 ? trackID : null;
}

function parseHandlerType(data: Uint8Array, trackBox: ISOBaseMediaBox): string | null {
    const handlerBox = findUniqueNestedBox(
        data,
        trackBox,
        [ MEDIA_BOX, HANDLER_BOX ]
    );
    if (!handlerBox || handlerBox.dataSize < 12) {
        return null;
    }
    return readFourCC(data, handlerBox.dataOffset + 8, handlerBox.endOffset);
}

function parseDolbyVisionConfiguration(
    data: Uint8Array,
    box: ISOBaseMediaBox
): ParsedDolbyVisionConfiguration {
    if (
        box.dataSize < MINIMUM_DOLBY_VISION_CONFIGURATION_BYTE_LENGTH
        || box.dataSize > MAXIMUM_DOLBY_VISION_CONFIGURATION_BYTE_LENGTH
    ) {
        throw new TypeError('The ISO base media Dolby Vision configuration size is unsupported');
    }
    const configurationBits = (data[box.dataOffset + 2] * 256) + data[box.dataOffset + 3];
    return {
        baseLayerPresent: (configurationBits & 1) === 1,
        enhancementLayerPresent: ((configurationBits >> 1) & 1) === 1,
        profile: (configurationBits >> 9) & 0x7F,
        rpuPresent: ((configurationBits >> 2) & 1) === 1
    };
}

function copyHEVCConfiguration(data: Uint8Array, box: ISOBaseMediaBox): Uint8Array {
    if (
        box.dataSize < MINIMUM_HEVC_CONFIGURATION_BYTE_LENGTH
        || box.dataSize > MAXIMUM_HEVC_CONFIGURATION_BYTE_LENGTH
    ) {
        throw new TypeError('The ISO base media HEVC configuration size is unsupported');
    }
    return data.slice(box.dataOffset, box.endOffset);
}

function parseVideoSampleEntry(
    data: Uint8Array,
    sampleEntryBox: ISOBaseMediaBox
): ParsedVideoSampleEntry {
    const childStartOffset = sampleEntryBox.dataOffset + VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH;
    if (childStartOffset > sampleEntryBox.endOffset) {
        throw new TypeError('The ISO base media visual sample entry is truncated');
    }
    const childBoxes = parseChildren(data, childStartOffset, sampleEntryBox.endOffset);
    const hevcConfigurationBox = findUniqueBox(childBoxes, HEVC_CONFIGURATION_BOX);
    const dolbyVisionConfigurationBox = findUniqueBox(
        childBoxes,
        DOLBY_VISION_CONFIGURATION_BOX
    );
    return {
        dolbyVisionConfiguration: dolbyVisionConfigurationBox ?
            parseDolbyVisionConfiguration(data, dolbyVisionConfigurationBox) :
            null,
        hevcConfiguration: hevcConfigurationBox ?
            copyHEVCConfiguration(data, hevcConfigurationBox) :
            null,
        type: sampleEntryBox.type
    };
}

function parseVideoSampleDescription(
    data: Uint8Array,
    trackBox: ISOBaseMediaBox
): ParsedVideoSampleEntry | null {
    const sampleDescriptionBox = findUniqueNestedBox(
        data,
        trackBox,
        [ MEDIA_BOX, MEDIA_INFORMATION_BOX, SAMPLE_TABLE_BOX, SAMPLE_DESCRIPTION_BOX ]
    );
    if (!sampleDescriptionBox || sampleDescriptionBox.dataSize < 8) {
        return null;
    }
    const entryCount = readUnsigned32(
        data,
        sampleDescriptionBox.dataOffset + FULL_BOX_HEADER_BYTE_LENGTH,
        sampleDescriptionBox.endOffset
    );
    if (entryCount !== 1 || entryCount > MAXIMUM_SAMPLE_ENTRY_COUNT) {
        return null;
    }
    const sampleEntryOffset = sampleDescriptionBox.dataOffset + 8;
    const sampleEntryBox = parseBox(data, sampleEntryOffset, sampleDescriptionBox.endOffset);
    if (sampleEntryBox.endOffset !== sampleDescriptionBox.endOffset) {
        return null;
    }
    return parseVideoSampleEntry(data, sampleEntryBox);
}

function parseVideoDependencyTrackIDs(
    data: Uint8Array,
    trackBox: ISOBaseMediaBox
): readonly number[] {
    const trackReferenceBox = findUniqueNestedBox(data, trackBox, [ TRACK_REFERENCE_BOX ]);
    if (!trackReferenceBox) {
        return [];
    }
    const referenceBoxes = parseChildren(
        data,
        trackReferenceBox.dataOffset,
        trackReferenceBox.endOffset
    );
    const videoDependencyBox = findUniqueBox(
        referenceBoxes,
        VIDEO_DEPENDENCY_REFERENCE_BOX
    );
    if (!videoDependencyBox) {
        return [];
    }
    if (videoDependencyBox.dataSize === 0 || videoDependencyBox.dataSize % 4 !== 0) {
        throw new TypeError('The ISO base media vdep reference size is invalid');
    }
    const trackIDs: number[] = [];
    for (
        let offset = videoDependencyBox.dataOffset;
        offset < videoDependencyBox.endOffset;
        offset += 4
    ) {
        const trackID = readUnsigned32(data, offset, videoDependencyBox.endOffset);
        if (trackID <= 0) {
            throw new TypeError('The ISO base media vdep track ID is invalid');
        }
        trackIDs.push(trackID);
    }
    return trackIDs;
}

function parseTrack(data: Uint8Array, trackBox: ISOBaseMediaBox): ParsedTrack {
    const handlerType = parseHandlerType(data, trackBox);
    return {
        handlerType,
        trackID: parseTrackID(data, trackBox),
        videoDependencyTrackIDs: parseVideoDependencyTrackIDs(data, trackBox),
        videoSampleEntry: handlerType === VIDEO_HANDLER_TYPE ?
            parseVideoSampleDescription(data, trackBox) :
            null
    };
}

function isBaseHEVCTrack(track: ParsedTrack): boolean {
    return track.handlerType === VIDEO_HANDLER_TYPE
        && track.trackID !== null
        && track.videoSampleEntry !== null
        && BASE_HEVC_SAMPLE_ENTRY_TYPES.has(track.videoSampleEntry.type)
        && track.videoSampleEntry.hevcConfiguration !== null;
}

function isDolbyVisionEnhancementTrack(track: ParsedTrack): boolean {
    const sampleEntry = track.videoSampleEntry;
    const configuration = sampleEntry?.dolbyVisionConfiguration;
    return track.handlerType === VIDEO_HANDLER_TYPE
        && track.trackID !== null
        && sampleEntry !== null
        && DOLBY_VISION_HEVC_SAMPLE_ENTRY_TYPES.has(sampleEntry.type)
        && sampleEntry.hevcConfiguration !== null
        && configuration?.profile === 7
        && configuration.rpuPresent
        && configuration.enhancementLayerPresent
        && !configuration.baseLayerPresent;
}

function parseMovieConfiguration(
    data: Uint8Array,
    selectedTrackNumber: number
): ISOBaseMediaDolbyVisionTrackConfiguration | null {
    const movieChildren = parseChildren(data, 0, data.byteLength);
    const trackBoxes = movieChildren.filter((box: ISOBaseMediaBox): boolean => (
        box.type === TRACK_BOX
    ));
    if (trackBoxes.length === 0 || trackBoxes.length > MAXIMUM_TRACK_COUNT) {
        return null;
    }
    const tracks: ParsedTrack[] = [];
    const trackIDs = new Set<number>();
    for (const trackBox of trackBoxes) {
        const track = parseTrack(data, trackBox);
        if (track.trackID !== null) {
            if (trackIDs.has(track.trackID)) {
                throw new TypeError('An ISO base media track ID is duplicated');
            }
            trackIDs.add(track.trackID);
        }
        tracks.push(track);
    }
    const selectedTrack = tracks.find((track: ParsedTrack): boolean => (
        track.trackID === selectedTrackNumber
    ));
    if (!selectedTrack || !isBaseHEVCTrack(selectedTrack)) {
        return null;
    }
    const enhancementTracks = tracks.filter((track: ParsedTrack): boolean => (
        isDolbyVisionEnhancementTrack(track)
        && track.videoDependencyTrackIDs.length === 1
        && track.videoDependencyTrackIDs[0] === selectedTrackNumber
    ));
    if (enhancementTracks.length !== 1) {
        return null;
    }
    const enhancementTrack = enhancementTracks[0];
    const enhancementConfiguration = enhancementTrack.videoSampleEntry?.hevcConfiguration;
    if (!enhancementConfiguration || enhancementTrack.trackID === null) {
        return null;
    }
    return {
        enhancementConfiguration,
        separateEnhancementTrackNumber: enhancementTrack.trackID
    };
}

async function readBoxAt(
    reader: ISOBaseMediaByteRangeReader,
    offset: number
): Promise<ISOBaseMediaBox | null> {
    const data = await reader(offset, EXTENDED_BOX_HEADER_BYTE_LENGTH);
    if (!data || data.byteLength < BASIC_BOX_HEADER_BYTE_LENGTH) {
        return null;
    }
    return parseRangeBoxHeader(data, offset);
}

function parseRangeBoxHeader(data: Uint8Array, absoluteOffset: number): ISOBaseMediaBox {
    const compactSize = readUnsigned32(data, 0, data.byteLength);
    const type = readFourCC(data, 4, data.byteLength);
    if (compactSize === 0) {
        throw new TypeError('A top-level ISO base media box has an unknown size');
    }
    const headerByteLength = compactSize === 1 ?
        EXTENDED_BOX_HEADER_BYTE_LENGTH :
        BASIC_BOX_HEADER_BYTE_LENGTH;
    const boxByteLength = compactSize === 1 ?
        readUnsigned64(data, 8, data.byteLength) :
        compactSize;
    if (boxByteLength < headerByteLength) {
        throw new TypeError('The ISO base media box size is invalid');
    }
    const endOffset = absoluteOffset + boxByteLength;
    if (!Number.isSafeInteger(endOffset)) {
        throw new TypeError('The ISO base media box offset exceeds the safe integer range');
    }
    return {
        dataOffset: absoluteOffset + headerByteLength,
        dataSize: boxByteLength - headerByteLength,
        endOffset,
        headerByteLength,
        startOffset: absoluteOffset,
        type
    };
}

async function findMovieBox(
    reader: ISOBaseMediaByteRangeReader
): Promise<ISOBaseMediaBox | null> {
    let offset = 0;
    for (let boxIndex = 0; boxIndex < MAXIMUM_TOP_LEVEL_BOX_COUNT; boxIndex += 1) {
        const box = await readBoxAt(reader, offset);
        if (!box) {
            return null;
        }
        if (boxIndex === 0 && box.type !== FILE_TYPE_BOX) {
            return null;
        }
        if (box.type === MOVIE_BOX) {
            return box;
        }
        if (box.endOffset <= offset) {
            return null;
        }
        offset = box.endOffset;
    }
    return null;
}

async function readISOBaseMediaDolbyVisionTrackConfigurationStrict(
    reader: ISOBaseMediaByteRangeReader,
    selectedTrackNumber: number
): Promise<ISOBaseMediaDolbyVisionTrackConfiguration | null> {
    const movieBox = await findMovieBox(reader);
    if (
        !movieBox
        || movieBox.dataSize <= 0
        || movieBox.dataSize > MAXIMUM_MOVIE_BOX_BYTE_LENGTH
    ) {
        return null;
    }
    const movieData = await reader(movieBox.dataOffset, movieBox.dataSize);
    if (!movieData || movieData.byteLength !== movieBox.dataSize) {
        return null;
    }
    return parseMovieConfiguration(movieData, selectedTrackNumber);
}

/** Reads bounded dual-track Profile 7 configuration from an ISO base media file. */
export async function readISOBaseMediaDolbyVisionTrackConfiguration(
    reader: ISOBaseMediaByteRangeReader,
    selectedTrackNumber: number
): Promise<ISOBaseMediaDolbyVisionTrackConfiguration | null> {
    if (!Number.isSafeInteger(selectedTrackNumber) || selectedTrackNumber <= 0) {
        return null;
    }
    try {
        return await readISOBaseMediaDolbyVisionTrackConfigurationStrict(
            reader,
            selectedTrackNumber
        );
    } catch {
        return null;
    }
}
