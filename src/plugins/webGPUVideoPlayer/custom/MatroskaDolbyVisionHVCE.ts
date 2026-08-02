const EBML_ID = 0x1A45_DFA3;
const MATROSKA_SEGMENT_ID = 0x1853_8067;
const MATROSKA_TRACKS_ID = 0x1654_AE6B;
const MATROSKA_TRACK_ENTRY_ID = 0xAE;
const MATROSKA_TRACK_NUMBER_ID = 0xD7;
const MATROSKA_TRACK_TYPE_ID = 0x83;
const MATROSKA_CODEC_ID = 0x86;
const MATROSKA_BLOCK_ADDITION_MAPPING_ID = 0x41E4;
const MATROSKA_BLOCK_ADD_ID_TYPE_ID = 0x41E7;
const MATROSKA_BLOCK_ADD_ID_EXTRA_DATA_ID = 0x41ED;
const MATROSKA_VIDEO_TRACK_TYPE = 1;
const MATROSKA_HEVC_CODEC_ID = 'V_MPEGH/ISO/HEVC';
const MATROSKA_HVCE_BLOCK_ADD_ID_TYPE = 0x6876_6345;
const MAXIMUM_EBML_HEADER_BYTE_LENGTH = 12;
const MAXIMUM_LEVEL_ZERO_ELEMENT_COUNT = 8;
const MAXIMUM_SEGMENT_METADATA_ELEMENT_COUNT = 128;
const MAXIMUM_TRACKS_BYTE_LENGTH = 4 * 1_024 * 1_024;
const MAXIMUM_TRACK_ENTRY_COUNT = 1_024;
const MAXIMUM_CODEC_ID_BYTE_LENGTH = 64;
const MINIMUM_HVCE_BYTE_LENGTH = 23;
const MAXIMUM_HVCE_BYTE_LENGTH = 1_024 * 1_024;

export type MatroskaByteRangeReader = (
    offset: number,
    byteLength: number
) => Promise<Uint8Array | null>;

type EBMLElementHeader = {
    dataOffset: number
    dataSize: number | null
    id: number
};

function getVariableIntegerByteLength(firstByte: number, maximumByteLength: number): number {
    let marker = 0x80;
    for (let byteLength = 1; byteLength <= maximumByteLength; byteLength += 1) {
        if ((firstByte & marker) !== 0) {
            return byteLength;
        }
        marker >>= 1;
    }
    throw new TypeError('The Matroska variable integer has no marker bit');
}

function parseElementID(
    data: Uint8Array,
    offset: number,
    endOffset: number
): { byteLength: number; value: number } {
    if (offset >= endOffset) {
        throw new TypeError('The Matroska element ID is missing');
    }
    const byteLength = getVariableIntegerByteLength(data[offset], 4);
    if (offset + byteLength > endOffset) {
        throw new TypeError('The Matroska element ID is truncated');
    }

    let value = 0;
    for (let byteIndex = 0; byteIndex < byteLength; byteIndex += 1) {
        value = (value * 256) + data[offset + byteIndex];
    }
    return { byteLength, value };
}

function parseElementSize(
    data: Uint8Array,
    offset: number,
    endOffset: number
): { byteLength: number; value: number | null } {
    if (offset >= endOffset) {
        throw new TypeError('The Matroska element size is missing');
    }
    const byteLength = getVariableIntegerByteLength(data[offset], 8);
    if (offset + byteLength > endOffset) {
        throw new TypeError('The Matroska element size is truncated');
    }

    const marker = 0x80 >> (byteLength - 1);
    const firstValue = data[offset] & (marker - 1);
    let unknownSize = firstValue === marker - 1;
    for (let byteIndex = 1; byteIndex < byteLength; byteIndex += 1) {
        unknownSize &&= data[offset + byteIndex] === 0xFF;
    }
    if (unknownSize) {
        return { byteLength, value: null };
    }

    let value = firstValue;
    for (let byteIndex = 1; byteIndex < byteLength; byteIndex += 1) {
        value = (value * 256) + data[offset + byteIndex];
        if (!Number.isSafeInteger(value)) {
            throw new TypeError('The Matroska element size exceeds the safe integer range');
        }
    }
    return { byteLength, value };
}

function parseElementHeader(
    data: Uint8Array,
    offset: number,
    endOffset: number
): EBMLElementHeader {
    const elementID = parseElementID(data, offset, endOffset);
    const sizeOffset = offset + elementID.byteLength;
    const elementSize = parseElementSize(data, sizeOffset, endOffset);
    const dataOffset = sizeOffset + elementSize.byteLength;
    return {
        dataOffset,
        dataSize: elementSize.value,
        id: elementID.value
    };
}

function requireContainedElementEnd(
    header: EBMLElementHeader,
    containerEndOffset: number
): number {
    if (header.dataSize === null) {
        throw new TypeError('A bounded Matroska metadata element uses an unknown size');
    }
    const endOffset = header.dataOffset + header.dataSize;
    if (!Number.isSafeInteger(endOffset) || endOffset > containerEndOffset) {
        throw new TypeError('A Matroska metadata element exceeds its container');
    }
    return endOffset;
}

function readUnsignedInteger(
    data: Uint8Array,
    startOffset: number,
    endOffset: number
): number {
    const byteLength = endOffset - startOffset;
    if (byteLength <= 0 || byteLength > 8) {
        throw new TypeError('The Matroska unsigned integer width is unsupported');
    }

    let value = 0;
    for (let offset = startOffset; offset < endOffset; offset += 1) {
        value = (value * 256) + data[offset];
        if (!Number.isSafeInteger(value)) {
            throw new TypeError('The Matroska unsigned integer exceeds the safe integer range');
        }
    }
    return value;
}

function readASCIIString(
    data: Uint8Array,
    startOffset: number,
    endOffset: number
): string {
    if (endOffset - startOffset > MAXIMUM_CODEC_ID_BYTE_LENGTH) {
        throw new TypeError('The Matroska codec ID is too large');
    }
    let value = '';
    for (let offset = startOffset; offset < endOffset && data[offset] !== 0; offset += 1) {
        if (data[offset] > 0x7F) {
            throw new TypeError('The Matroska codec ID is not ASCII');
        }
        value += String.fromCharCode(data[offset]);
    }
    return value;
}

function parseHVCEBlockAdditionMapping(
    data: Uint8Array,
    startOffset: number,
    endOffset: number
): Uint8Array | null {
    let blockAddIDType: number | null = null;
    let extraData: Uint8Array | null = null;
    let offset = startOffset;
    while (offset < endOffset) {
        const header = parseElementHeader(data, offset, endOffset);
        const elementEndOffset = requireContainedElementEnd(header, endOffset);
        switch (header.id) {
            case MATROSKA_BLOCK_ADD_ID_TYPE_ID:
                if (blockAddIDType !== null) {
                    throw new TypeError('The Matroska block-addition type is duplicated');
                }
                blockAddIDType = readUnsignedInteger(
                    data,
                    header.dataOffset,
                    elementEndOffset
                );
                break;
            case MATROSKA_BLOCK_ADD_ID_EXTRA_DATA_ID:
                if (extraData !== null) {
                    throw new TypeError('The Matroska block-addition extra data is duplicated');
                }
                extraData = data.slice(header.dataOffset, elementEndOffset);
                break;
        }
        offset = elementEndOffset;
    }

    if (blockAddIDType !== MATROSKA_HVCE_BLOCK_ADD_ID_TYPE) {
        return null;
    }
    if (
        !extraData
        || extraData.byteLength < MINIMUM_HVCE_BYTE_LENGTH
        || extraData.byteLength > MAXIMUM_HVCE_BYTE_LENGTH
    ) {
        throw new TypeError('The Matroska hvcE record size is unsupported');
    }
    return extraData;
}

type ParsedTrackEntry = {
    codecID: string | null
    enhancementConfiguration: Uint8Array | null
    trackNumber: number | null
    trackType: number | null
};

function parseTrackEntryElement(
    state: ParsedTrackEntry,
    data: Uint8Array,
    header: EBMLElementHeader,
    elementEndOffset: number
): void {
    switch (header.id) {
        case MATROSKA_TRACK_NUMBER_ID:
            if (state.trackNumber !== null) {
                throw new TypeError('The Matroska track number is duplicated');
            }
            state.trackNumber = readUnsignedInteger(data, header.dataOffset, elementEndOffset);
            break;
        case MATROSKA_TRACK_TYPE_ID:
            if (state.trackType !== null) {
                throw new TypeError('The Matroska track type is duplicated');
            }
            state.trackType = readUnsignedInteger(data, header.dataOffset, elementEndOffset);
            break;
        case MATROSKA_CODEC_ID:
            if (state.codecID !== null) {
                throw new TypeError('The Matroska codec ID is duplicated');
            }
            state.codecID = readASCIIString(data, header.dataOffset, elementEndOffset);
            break;
        case MATROSKA_BLOCK_ADDITION_MAPPING_ID: {
            const candidate = parseHVCEBlockAdditionMapping(
                data,
                header.dataOffset,
                elementEndOffset
            );
            if (!candidate) {
                break;
            }
            if (state.enhancementConfiguration) {
                throw new TypeError('The Matroska track has multiple hvcE records');
            }
            state.enhancementConfiguration = candidate;
            break;
        }
    }
}

function parseTrackEntry(
    data: Uint8Array,
    startOffset: number,
    endOffset: number
): ParsedTrackEntry {
    const state: ParsedTrackEntry = {
        codecID: null,
        enhancementConfiguration: null,
        trackNumber: null,
        trackType: null
    };
    let offset = startOffset;
    while (offset < endOffset) {
        const header = parseElementHeader(data, offset, endOffset);
        const elementEndOffset = requireContainedElementEnd(header, endOffset);
        parseTrackEntryElement(state, data, header, elementEndOffset);
        offset = elementEndOffset;
    }

    return state;
}

function parseTracks(
    data: Uint8Array,
    selectedTrackNumber: number
): Uint8Array | null {
    let trackEntryCount = 0;
    let selectedTrackSeen = false;
    let selectedEnhancementConfiguration: Uint8Array | null = null;
    let offset = 0;
    while (offset < data.byteLength) {
        const header = parseElementHeader(data, offset, data.byteLength);
        const elementEndOffset = requireContainedElementEnd(header, data.byteLength);
        offset = elementEndOffset;
        if (header.id !== MATROSKA_TRACK_ENTRY_ID) {
            continue;
        }

        trackEntryCount += 1;
        if (trackEntryCount > MAXIMUM_TRACK_ENTRY_COUNT) {
            throw new TypeError('The Matroska track count exceeds its bound');
        }
        const trackEntry = parseTrackEntry(
            data,
            header.dataOffset,
            elementEndOffset
        );
        if (trackEntry.trackNumber !== selectedTrackNumber) {
            continue;
        }
        if (selectedTrackSeen) {
            throw new TypeError('The selected Matroska track number is duplicated');
        }
        selectedTrackSeen = true;
        if (
            trackEntry.trackType === MATROSKA_VIDEO_TRACK_TYPE
            && trackEntry.codecID === MATROSKA_HEVC_CODEC_ID
        ) {
            selectedEnhancementConfiguration = trackEntry.enhancementConfiguration;
        }
    }
    return selectedEnhancementConfiguration;
}

async function readElementHeaderAt(
    reader: MatroskaByteRangeReader,
    offset: number
): Promise<EBMLElementHeader | null> {
    const data = await reader(offset, MAXIMUM_EBML_HEADER_BYTE_LENGTH);
    if (!data || data.byteLength === 0) {
        return null;
    }
    const localHeader = parseElementHeader(data, 0, data.byteLength);
    const dataOffset = offset + localHeader.dataOffset;
    if (!Number.isSafeInteger(dataOffset)) {
        throw new TypeError('The Matroska element offset exceeds the safe integer range');
    }
    return {
        ...localHeader,
        dataOffset
    };
}

async function findSegment(
    reader: MatroskaByteRangeReader
): Promise<EBMLElementHeader | null> {
    let offset = 0;
    let ebmlHeaderSeen = false;
    for (
        let elementIndex = 0;
        elementIndex < MAXIMUM_LEVEL_ZERO_ELEMENT_COUNT;
        elementIndex += 1
    ) {
        const header = await readElementHeaderAt(reader, offset);
        if (!header) {
            return null;
        }
        if (!ebmlHeaderSeen) {
            if (header.id !== EBML_ID) {
                return null;
            }
            ebmlHeaderSeen = true;
        } else if (header.id === MATROSKA_SEGMENT_ID) {
            return header;
        }
        if (header.dataSize === null) {
            return null;
        }
        offset = header.dataOffset + header.dataSize;
        if (!Number.isSafeInteger(offset)) {
            return null;
        }
    }
    return null;
}

function isOffsetBeforeEnd(offset: number, endOffset: number | null): boolean {
    return endOffset === null || offset < endOffset;
}

function getNextElementOffset(
    header: EBMLElementHeader,
    containerEndOffset: number | null
): number | null {
    if (header.dataSize === null) {
        return null;
    }
    const nextOffset = header.dataOffset + header.dataSize;
    if (!Number.isSafeInteger(nextOffset)) {
        return null;
    }
    if (containerEndOffset !== null && nextOffset > containerEndOffset) {
        return null;
    }
    return nextOffset;
}

async function findTracks(
    reader: MatroskaByteRangeReader,
    segment: EBMLElementHeader
): Promise<EBMLElementHeader | null> {
    const segmentEndOffset = segment.dataSize === null ?
        null :
        segment.dataOffset + segment.dataSize;
    if (segmentEndOffset !== null && !Number.isSafeInteger(segmentEndOffset)) {
        return null;
    }

    let offset = segment.dataOffset;
    for (
        let elementIndex = 0;
        elementIndex < MAXIMUM_SEGMENT_METADATA_ELEMENT_COUNT;
        elementIndex += 1
    ) {
        if (!isOffsetBeforeEnd(offset, segmentEndOffset)) {
            return null;
        }
        const header = await readElementHeaderAt(reader, offset);
        if (!header) {
            return null;
        }
        if (header.id === MATROSKA_TRACKS_ID) {
            return header;
        }
        const nextOffset = getNextElementOffset(header, segmentEndOffset);
        if (nextOffset === null) {
            return null;
        }
        offset = nextOffset;
    }
    return null;
}

async function readMatroskaDolbyVisionHVCEStrict(
    reader: MatroskaByteRangeReader,
    selectedTrackNumber: number
): Promise<Uint8Array | null> {
    const segment = await findSegment(reader);
    if (!segment) {
        return null;
    }
    const tracks = await findTracks(reader, segment);
    if (
        !tracks
        || tracks.dataSize === null
        || tracks.dataSize <= 0
        || tracks.dataSize > MAXIMUM_TRACKS_BYTE_LENGTH
    ) {
        return null;
    }
    const tracksData = await reader(tracks.dataOffset, tracks.dataSize);
    if (!tracksData || tracksData.byteLength !== tracks.dataSize) {
        return null;
    }
    return parseTracks(tracksData, selectedTrackNumber);
}

/** Reads the selected Matroska HEVC track's bounded container hvcE record. */
export async function readMatroskaDolbyVisionHVCE(
    reader: MatroskaByteRangeReader,
    selectedTrackNumber: number
): Promise<Uint8Array | null> {
    if (!Number.isSafeInteger(selectedTrackNumber) || selectedTrackNumber <= 0) {
        return null;
    }
    try {
        return await readMatroskaDolbyVisionHVCEStrict(reader, selectedTrackNumber);
    } catch {
        return null;
    }
}
