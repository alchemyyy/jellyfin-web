const MPEG_TS_PACKET_BYTE_LENGTH = 188;
const M2TS_PACKET_BYTE_LENGTH = 192;
const M2TS_TRANSPORT_PACKET_OFFSET = 4;
const MPEG_TS_SYNC_BYTE = 0x47;
const PROGRAM_ASSOCIATION_TABLE_ID = 0x00;
const PROGRAM_MAP_TABLE_ID = 0x02;
const REGISTRATION_DESCRIPTOR_TAG = 0x05;
const DOLBY_VISION_VIDEO_STREAM_DESCRIPTOR_TAG = 0xB0;
const PRIVATE_DATA_STREAM_TYPE = 0x06;
const HEVC_STREAM_TYPE = 0x24;
const BDMV_BASE_VIDEO_PID = 0x1011;
const BDMV_ENHANCEMENT_VIDEO_PID = 0x1015;
const MAXIMUM_PROBE_BYTE_LENGTH = 1 * 1_024 * 1_024;
const MAXIMUM_PSI_SECTION_BYTE_LENGTH = 4_096;
const MAXIMUM_PARSED_SECTION_COUNT = 256;
const MAXIMUM_PROGRAM_MAP_PID_COUNT = 64;
const MPEG_2_CRC_POLYNOMIAL = 0x04C1_1DB7;

export type MPEGTransportStreamByteRangeReader = (
    offset: number,
    byteLength: number
) => Promise<Uint8Array | null>;

export type MPEGTransportStreamDolbyVisionTrackConfiguration = {
    separateEnhancementTrackNumber: number
};

type TransportPacketLayout = {
    packetByteLength: number
    transportPacketOffset: number
};

type PSISectionAssembler = {
    buffer: Uint8Array
    byteLength: number
    continuityCounter: number | null
    expectedByteLength: number | null
};

type TransportStreamPacket = {
    continuityCounter: number
    discontinuity: boolean
    payload: Uint8Array | null
    payloadUnitStart: boolean
    pid: number
};

type ProgramMapStream = {
    dolbyVisionDependencyPIDs: readonly number[]
    pid: number
    streamType: number
};

type ProgramMap = {
    hasHDMVRegistration: boolean
    streams: readonly ProgramMapStream[]
};

type TransportConfigurationParseState = {
    ambiguousEnhancement: boolean
    enhancementPIDs: Set<number>
    parsedSectionCount: number
    programMapPIDs: Set<number>
    sectionAssemblers: Map<number, PSISectionAssembler>
};

function getMPEG2CRC32(data: Uint8Array): number {
    let crc = 0xFFFF_FFFF;
    for (const byteValue of data) {
        crc ^= byteValue << 24;
        for (let bitIndex = 0; bitIndex < 8; bitIndex += 1) {
            crc = (crc & 0x8000_0000) !== 0 ?
                ((crc << 1) ^ MPEG_2_CRC_POLYNOMIAL) >>> 0 :
                (crc << 1) >>> 0;
        }
    }
    return crc >>> 0;
}

function getSyncScore(
    data: Uint8Array,
    packetByteLength: number,
    transportPacketOffset: number
): number {
    const maximumPacketCount = Math.min(
        8,
        Math.floor((data.byteLength - 1 - transportPacketOffset) / packetByteLength) + 1
    );
    let score = 0;
    for (let packetIndex = 0; packetIndex < maximumPacketCount; packetIndex += 1) {
        const syncOffset = (packetIndex * packetByteLength) + transportPacketOffset;
        if (data[syncOffset] !== MPEG_TS_SYNC_BYTE) {
            break;
        }
        score += 1;
    }
    return score;
}

function getTransportPacketLayout(data: Uint8Array): TransportPacketLayout | null {
    const transportStreamScore = getSyncScore(
        data,
        MPEG_TS_PACKET_BYTE_LENGTH,
        0
    );
    const m2tsScore = getSyncScore(
        data,
        M2TS_PACKET_BYTE_LENGTH,
        M2TS_TRANSPORT_PACKET_OFFSET
    );
    if (transportStreamScore < 3 && m2tsScore < 3) {
        return null;
    }
    if (m2tsScore > transportStreamScore) {
        return {
            packetByteLength: M2TS_PACKET_BYTE_LENGTH,
            transportPacketOffset: M2TS_TRANSPORT_PACKET_OFFSET
        };
    }
    return {
        packetByteLength: MPEG_TS_PACKET_BYTE_LENGTH,
        transportPacketOffset: 0
    };
}

function resetSectionAssembler(assembler: PSISectionAssembler): void {
    assembler.byteLength = 0;
    assembler.expectedByteLength = null;
}

function createSectionAssembler(): PSISectionAssembler {
    return {
        buffer: new Uint8Array(MAXIMUM_PSI_SECTION_BYTE_LENGTH),
        byteLength: 0,
        continuityCounter: null,
        expectedByteLength: null
    };
}

function parseTransportPacket(
    data: Uint8Array,
    transportPacketOffset: number
): TransportStreamPacket | null {
    const transportPacketEndOffset = transportPacketOffset + MPEG_TS_PACKET_BYTE_LENGTH;
    if (
        transportPacketOffset < 0
        || transportPacketEndOffset > data.byteLength
        || data[transportPacketOffset] !== MPEG_TS_SYNC_BYTE
    ) {
        return null;
    }
    const headerByteOne = data[transportPacketOffset + 1];
    const headerByteThree = data[transportPacketOffset + 3];
    const transportError = (headerByteOne & 0x80) !== 0;
    const transportScramblingControl = headerByteThree >> 6;
    const adaptationFieldControl = (headerByteThree >> 4) & 0x03;
    if (transportError || transportScramblingControl !== 0 || adaptationFieldControl === 0) {
        return null;
    }

    let payloadOffset = transportPacketOffset + 4;
    let discontinuity = false;
    if ((adaptationFieldControl & 0x02) !== 0) {
        if (payloadOffset >= transportPacketEndOffset) {
            return null;
        }
        const adaptationFieldByteLength = data[payloadOffset];
        const adaptationFieldEndOffset = payloadOffset + 1 + adaptationFieldByteLength;
        if (adaptationFieldEndOffset > transportPacketEndOffset) {
            return null;
        }
        if (adaptationFieldByteLength > 0) {
            discontinuity = (data[payloadOffset + 1] & 0x80) !== 0;
        }
        payloadOffset = adaptationFieldEndOffset;
    }
    const hasPayload = (adaptationFieldControl & 0x01) !== 0;
    return {
        continuityCounter: headerByteThree & 0x0F,
        discontinuity,
        payload: hasPayload && payloadOffset < transportPacketEndOffset ?
            data.subarray(payloadOffset, transportPacketEndOffset) :
            null,
        payloadUnitStart: (headerByteOne & 0x40) !== 0,
        pid: ((headerByteOne & 0x1F) << 8) | data[transportPacketOffset + 2]
    };
}

function appendSectionBytes(
    assembler: PSISectionAssembler,
    data: Uint8Array,
    startOffset: number,
    endOffset: number,
    sections: Uint8Array[]
): void {
    let offset = startOffset;
    while (offset < endOffset) {
        if (assembler.byteLength === 0 && data[offset] === 0xFF) {
            return;
        }
        const requiredHeaderByteLength = Math.max(0, 3 - assembler.byteLength);
        const headerCopyByteLength = Math.min(requiredHeaderByteLength, endOffset - offset);
        if (headerCopyByteLength > 0) {
            assembler.buffer.set(
                data.subarray(offset, offset + headerCopyByteLength),
                assembler.byteLength
            );
            assembler.byteLength += headerCopyByteLength;
            offset += headerCopyByteLength;
        }
        if (assembler.byteLength < 3) {
            return;
        }
        if (assembler.expectedByteLength === null) {
            const sectionByteLength = 3
                + (((assembler.buffer[1] & 0x0F) << 8) | assembler.buffer[2]);
            if (sectionByteLength < 4 || sectionByteLength > MAXIMUM_PSI_SECTION_BYTE_LENGTH) {
                resetSectionAssembler(assembler);
                return;
            }
            assembler.expectedByteLength = sectionByteLength;
        }
        const remainingByteLength = assembler.expectedByteLength - assembler.byteLength;
        const copyByteLength = Math.min(remainingByteLength, endOffset - offset);
        assembler.buffer.set(
            data.subarray(offset, offset + copyByteLength),
            assembler.byteLength
        );
        assembler.byteLength += copyByteLength;
        offset += copyByteLength;
        if (assembler.byteLength !== assembler.expectedByteLength) {
            return;
        }
        sections.push(assembler.buffer.slice(0, assembler.byteLength));
        resetSectionAssembler(assembler);
    }
}

function takePacketSections(
    assembler: PSISectionAssembler,
    packet: TransportStreamPacket
): Uint8Array[] {
    const sections: Uint8Array[] = [];
    if (packet.discontinuity) {
        resetSectionAssembler(assembler);
        assembler.continuityCounter = null;
    }
    if (!packet.payload) {
        return sections;
    }
    if (assembler.continuityCounter === packet.continuityCounter) {
        return sections;
    }
    if (
        assembler.continuityCounter !== null
        && packet.continuityCounter !== ((assembler.continuityCounter + 1) & 0x0F)
    ) {
        resetSectionAssembler(assembler);
    }
    assembler.continuityCounter = packet.continuityCounter;

    if (!packet.payloadUnitStart) {
        if (assembler.byteLength > 0) {
            appendSectionBytes(assembler, packet.payload, 0, packet.payload.byteLength, sections);
        }
        return sections;
    }
    const pointerField = packet.payload[0];
    const firstSectionOffset = 1 + pointerField;
    if (firstSectionOffset > packet.payload.byteLength) {
        resetSectionAssembler(assembler);
        return sections;
    }
    if (assembler.byteLength > 0 && pointerField > 0) {
        appendSectionBytes(assembler, packet.payload, 1, firstSectionOffset, sections);
    }
    resetSectionAssembler(assembler);
    appendSectionBytes(
        assembler,
        packet.payload,
        firstSectionOffset,
        packet.payload.byteLength,
        sections
    );
    return sections;
}

function isValidCurrentPSISection(section: Uint8Array, tableID: number): boolean {
    if (
        section.byteLength < 12
        || section[0] !== tableID
        || (section[1] & 0xC0) !== 0x80
        || (section[5] & 0x01) === 0
        || section[6] > section[7]
    ) {
        return false;
    }
    const declaredByteLength = 3 + (((section[1] & 0x0F) << 8) | section[2]);
    return declaredByteLength === section.byteLength && getMPEG2CRC32(section) === 0;
}

function readProgramMapPIDs(section: Uint8Array): readonly number[] {
    if (!isValidCurrentPSISection(section, PROGRAM_ASSOCIATION_TABLE_ID)) {
        return [];
    }
    const programMapPIDs: number[] = [];
    const entriesEndOffset = section.byteLength - 4;
    if ((entriesEndOffset - 8) % 4 !== 0) {
        return [];
    }
    for (let offset = 8; offset < entriesEndOffset; offset += 4) {
        const programNumber = (section[offset] << 8) | section[offset + 1];
        if (programNumber === 0) {
            continue;
        }
        const pid = ((section[offset + 2] & 0x1F) << 8) | section[offset + 3];
        if (!programMapPIDs.includes(pid)) {
            programMapPIDs.push(pid);
        }
    }
    return programMapPIDs;
}

function isRegistrationDescriptor(
    data: Uint8Array,
    startOffset: number,
    registration: string
): boolean {
    if (registration.length !== 4 || startOffset + 4 > data.byteLength) {
        return false;
    }
    for (let characterIndex = 0; characterIndex < 4; characterIndex += 1) {
        if (data[startOffset + characterIndex] !== registration.charCodeAt(characterIndex)) {
            return false;
        }
    }
    return true;
}

function readDolbyVisionDependencyPID(
    data: Uint8Array,
    startOffset: number,
    endOffset: number
): number | null {
    const descriptorByteLength = endOffset - startOffset;
    if (descriptorByteLength < 7 || data[startOffset] !== 1) {
        return null;
    }
    const configurationBits = (data[startOffset + 2] << 8) | data[startOffset + 3];
    const profile = (configurationBits >> 9) & 0x7F;
    const rpuPresent = (configurationBits & 0x04) !== 0;
    const enhancementLayerPresent = (configurationBits & 0x02) !== 0;
    const baseLayerPresent = (configurationBits & 0x01) !== 0;
    const compatibilityID = data[startOffset + 6] >> 4;
    const metadataCompression = (data[startOffset + 6] >> 2) & 0x03;
    if (
        profile !== 7
        || !rpuPresent
        || !enhancementLayerPresent
        || baseLayerPresent
        || compatibilityID !== 6
        || metadataCompression !== 0
    ) {
        return null;
    }
    return ((data[startOffset + 4] << 8) | data[startOffset + 5]) >> 3;
}

function parseDescriptorLoop(
    data: Uint8Array,
    startOffset: number,
    endOffset: number
): { dolbyVisionDependencyPIDs: readonly number[]; hasHDMVRegistration: boolean } {
    const dolbyVisionDependencyPIDs: number[] = [];
    let hasHDMVRegistration = false;
    let offset = startOffset;
    while (offset < endOffset) {
        if (offset + 2 > endOffset) {
            throw new TypeError('An MPEG-TS descriptor header is truncated');
        }
        const descriptorTag = data[offset];
        const descriptorByteLength = data[offset + 1];
        const descriptorStartOffset = offset + 2;
        const descriptorEndOffset = descriptorStartOffset + descriptorByteLength;
        if (descriptorEndOffset > endOffset) {
            throw new TypeError('An MPEG-TS descriptor exceeds its descriptor loop');
        }
        switch (descriptorTag) {
            case REGISTRATION_DESCRIPTOR_TAG:
                hasHDMVRegistration ||= descriptorByteLength === 4
                    && isRegistrationDescriptor(data, descriptorStartOffset, 'HDMV');
                break;
            case DOLBY_VISION_VIDEO_STREAM_DESCRIPTOR_TAG: {
                const dependencyPID = readDolbyVisionDependencyPID(
                    data,
                    descriptorStartOffset,
                    descriptorEndOffset
                );
                if (dependencyPID !== null) {
                    dolbyVisionDependencyPIDs.push(dependencyPID);
                }
                break;
            }
            default:
                break;
        }
        offset = descriptorEndOffset;
    }
    return { dolbyVisionDependencyPIDs, hasHDMVRegistration };
}

function parseProgramMap(section: Uint8Array): ProgramMap | null {
    if (!isValidCurrentPSISection(section, PROGRAM_MAP_TABLE_ID)) {
        return null;
    }
    const entriesEndOffset = section.byteLength - 4;
    const programInfoByteLength = ((section[10] & 0x0F) << 8) | section[11];
    const programInfoEndOffset = 12 + programInfoByteLength;
    if (programInfoEndOffset > entriesEndOffset) {
        return null;
    }
    const programDescriptors = parseDescriptorLoop(
        section,
        12,
        programInfoEndOffset
    );
    const streams: ProgramMapStream[] = [];
    let offset = programInfoEndOffset;
    while (offset < entriesEndOffset) {
        if (offset + 5 > entriesEndOffset) {
            return null;
        }
        const streamType = section[offset];
        const pid = ((section[offset + 1] & 0x1F) << 8) | section[offset + 2];
        const descriptorByteLength = ((section[offset + 3] & 0x0F) << 8)
            | section[offset + 4];
        const descriptorStartOffset = offset + 5;
        const descriptorEndOffset = descriptorStartOffset + descriptorByteLength;
        if (descriptorEndOffset > entriesEndOffset) {
            return null;
        }
        const descriptors = parseDescriptorLoop(
            section,
            descriptorStartOffset,
            descriptorEndOffset
        );
        streams.push({
            dolbyVisionDependencyPIDs: descriptors.dolbyVisionDependencyPIDs,
            pid,
            streamType
        });
        offset = descriptorEndOffset;
    }
    return {
        hasHDMVRegistration: programDescriptors.hasHDMVRegistration,
        streams
    };
}

function getEnhancementPIDs(
    programMap: ProgramMap,
    selectedBasePID: number
): readonly number[] {
    const selectedBaseStream = programMap.streams.find(
        (stream: ProgramMapStream): boolean => (
            stream.pid === selectedBasePID && stream.streamType === HEVC_STREAM_TYPE
        )
    );
    if (!selectedBaseStream) {
        return [];
    }
    const descriptorCandidates = programMap.streams.filter(
        (stream: ProgramMapStream): boolean => (
            stream.pid !== selectedBasePID
            && (
                stream.streamType === PRIVATE_DATA_STREAM_TYPE
                || stream.streamType === HEVC_STREAM_TYPE
            )
            && stream.dolbyVisionDependencyPIDs.length === 1
            && stream.dolbyVisionDependencyPIDs[0] === selectedBasePID
        )
    );
    const candidatePIDs: number[] = [];
    for (const candidate of descriptorCandidates) {
        if (!candidatePIDs.includes(candidate.pid)) {
            candidatePIDs.push(candidate.pid);
        }
    }
    if (
        programMap.hasHDMVRegistration
        && selectedBasePID === BDMV_BASE_VIDEO_PID
        && programMap.streams.some((stream: ProgramMapStream): boolean => (
            stream.pid === BDMV_ENHANCEMENT_VIDEO_PID
            && stream.streamType === HEVC_STREAM_TYPE
        ))
        && !candidatePIDs.includes(BDMV_ENHANCEMENT_VIDEO_PID)
    ) {
        candidatePIDs.push(BDMV_ENHANCEMENT_VIDEO_PID);
    }
    return candidatePIDs;
}

function registerProgramMapPIDs(
    state: TransportConfigurationParseState,
    section: Uint8Array
): boolean {
    for (const programMapPID of readProgramMapPIDs(section)) {
        if (state.programMapPIDs.has(programMapPID)) {
            continue;
        }
        if (state.programMapPIDs.size >= MAXIMUM_PROGRAM_MAP_PID_COUNT) {
            return false;
        }
        state.programMapPIDs.add(programMapPID);
        state.sectionAssemblers.set(programMapPID, createSectionAssembler());
    }
    return true;
}

function collectEnhancementPIDs(
    state: TransportConfigurationParseState,
    section: Uint8Array,
    selectedBasePID: number
): void {
    const programMap = parseProgramMap(section);
    if (!programMap) {
        return;
    }
    const enhancementPIDs = getEnhancementPIDs(programMap, selectedBasePID);
    if (enhancementPIDs.length > 1) {
        state.ambiguousEnhancement = true;
        return;
    }
    if (enhancementPIDs.length === 1) {
        state.enhancementPIDs.add(enhancementPIDs[0]);
    }
}

function processTransportPacket(
    state: TransportConfigurationParseState,
    packet: TransportStreamPacket,
    selectedBasePID: number
): boolean {
    const assembler = state.sectionAssemblers.get(packet.pid);
    if (!assembler) {
        return true;
    }
    for (const section of takePacketSections(assembler, packet)) {
        state.parsedSectionCount += 1;
        if (state.parsedSectionCount > MAXIMUM_PARSED_SECTION_COUNT) {
            return false;
        }
        if (packet.pid === 0) {
            if (!registerProgramMapPIDs(state, section)) {
                return false;
            }
        } else {
            collectEnhancementPIDs(state, section, selectedBasePID);
        }
    }
    return true;
}

function parseTransportStreamConfiguration(
    data: Uint8Array,
    selectedBasePID: number
): MPEGTransportStreamDolbyVisionTrackConfiguration | null {
    const layout = getTransportPacketLayout(data);
    if (!layout) {
        return null;
    }
    const state: TransportConfigurationParseState = {
        ambiguousEnhancement: false,
        enhancementPIDs: new Set<number>(),
        parsedSectionCount: 0,
        programMapPIDs: new Set<number>(),
        sectionAssemblers: new Map<number, PSISectionAssembler>([
            [ 0, createSectionAssembler() ]
        ])
    };

    for (
        let packetOffset = 0;
        packetOffset + layout.transportPacketOffset + MPEG_TS_PACKET_BYTE_LENGTH
            <= data.byteLength;
        packetOffset += layout.packetByteLength
    ) {
        const packet = parseTransportPacket(
            data,
            packetOffset + layout.transportPacketOffset
        );
        if (packet && !processTransportPacket(state, packet, selectedBasePID)) {
            return null;
        }
    }
    if (state.ambiguousEnhancement || state.enhancementPIDs.size !== 1) {
        return null;
    }
    const [ separateEnhancementTrackNumber ] = state.enhancementPIDs;
    return { separateEnhancementTrackNumber };
}

/** Reads bounded Profile 7 dependency signaling from an MPEG-TS or M2TS file. */
export async function readMPEGTransportStreamDolbyVisionTrackConfiguration(
    reader: MPEGTransportStreamByteRangeReader,
    selectedBasePID: number
): Promise<MPEGTransportStreamDolbyVisionTrackConfiguration | null> {
    if (
        !Number.isSafeInteger(selectedBasePID)
        || selectedBasePID <= 0
        || selectedBasePID > 0x1FFE
    ) {
        return null;
    }
    try {
        const data = await reader(0, MAXIMUM_PROBE_BYTE_LENGTH);
        if (!data || data.byteLength < 3 * MPEG_TS_PACKET_BYTE_LENGTH) {
            return null;
        }
        return parseTransportStreamConfiguration(
            data.subarray(0, MAXIMUM_PROBE_BYTE_LENGTH),
            selectedBasePID
        );
    } catch {
        return null;
    }
}
