import { describe, expect, it, vi } from 'vitest';

import {
    readMPEGTransportStreamDolbyVisionTrackConfiguration,
    type MPEGTransportStreamByteRangeReader
} from './MPEGTransportStreamDolbyVisionConfiguration';

const MPEG_TS_PACKET_BYTE_LENGTH = 188;
const M2TS_PACKET_BYTE_LENGTH = 192;
const MAXIMUM_PROBE_BYTE_LENGTH = 1 * 1_024 * 1_024;
const MPEG_2_CRC_POLYNOMIAL = 0x04C1_1DB7;
const BASE_PID = 0x100;
const ENHANCEMENT_PID = 0x101;
const PROGRAM_MAP_PID = 0x1000;
const DOLBY_VISION_LEVEL = 3;

type DolbyVisionDescriptorOptions = {
    baseLayerPresent?: boolean
    compatibilityID?: number
    dependencyPID?: number
    enhancementLayerPresent?: boolean
    metadataCompression?: number
    profile?: number
    rpuPresent?: boolean
    versionMajor?: number
};

type ProgramMapOptions = {
    basePID?: number
    enhancementPID?: number
    enhancementStreamType?: number
    extraEnhancementPIDs?: readonly number[]
    programDescriptors?: Uint8Array
    descriptorOptions?: DolbyVisionDescriptorOptions
};

function concatenate(parts: readonly Uint8Array[]): Uint8Array {
    const byteLength = parts.reduce(
        (totalByteLength: number, part: Uint8Array): number => (
            totalByteLength + part.byteLength
        ),
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

function createPSISection(tableID: number, body: Uint8Array): Uint8Array {
    const sectionLength = body.byteLength + 4;
    const sectionWithoutCRC = concatenate([
        new Uint8Array([
            tableID,
            0xB0 | (sectionLength >> 8),
            sectionLength & 0xFF
        ]),
        body
    ]);
    const crc = getMPEG2CRC32(sectionWithoutCRC);
    return concatenate([
        sectionWithoutCRC,
        new Uint8Array([
            crc >>> 24,
            (crc >>> 16) & 0xFF,
            (crc >>> 8) & 0xFF,
            crc & 0xFF
        ])
    ]);
}

function createProgramAssociationTable(programMapPID = PROGRAM_MAP_PID): Uint8Array {
    return createPSISection(PROGRAM_ASSOCIATION_TABLE_ID, new Uint8Array([
        0x00, 0x01,
        0xC1,
        0x00,
        0x00,
        0x00, 0x01,
        0xE0 | (programMapPID >> 8), programMapPID & 0xFF
    ]));
}

const PROGRAM_ASSOCIATION_TABLE_ID = 0x00;
const PROGRAM_MAP_TABLE_ID = 0x02;

function createDescriptor(tag: number, payload: Uint8Array): Uint8Array {
    return concatenate([ new Uint8Array([ tag, payload.byteLength ]), payload ]);
}

function createDolbyVisionDescriptor(
    options: DolbyVisionDescriptorOptions = {}
): Uint8Array {
    const configurationBits = ((options.profile ?? 7) << 9)
        | (DOLBY_VISION_LEVEL << 3)
        | ((options.rpuPresent ?? true) ? 0x04 : 0)
        | ((options.enhancementLayerPresent ?? true) ? 0x02 : 0)
        | ((options.baseLayerPresent ?? false) ? 0x01 : 0);
    const dependencyBits = (options.dependencyPID ?? BASE_PID) << 3;
    const compatibilityBits = ((options.compatibilityID ?? 6) << 4)
        | ((options.metadataCompression ?? 0) << 2);
    return createDescriptor(0xB0, new Uint8Array([
        options.versionMajor ?? 1,
        0,
        configurationBits >> 8,
        configurationBits & 0xFF,
        dependencyBits >> 8,
        dependencyBits & 0xFF,
        compatibilityBits
    ]));
}

function createElementaryStream(
    streamType: number,
    pid: number,
    descriptors: Uint8Array = new Uint8Array(0)
): Uint8Array {
    return concatenate([
        new Uint8Array([
            streamType,
            0xE0 | (pid >> 8), pid & 0xFF,
            0xF0 | (descriptors.byteLength >> 8), descriptors.byteLength & 0xFF
        ]),
        descriptors
    ]);
}

function createProgramMap(options: ProgramMapOptions = {}): Uint8Array {
    const basePID = options.basePID ?? BASE_PID;
    const enhancementPID = options.enhancementPID ?? ENHANCEMENT_PID;
    const programDescriptors = options.programDescriptors ?? new Uint8Array(0);
    const streams: Uint8Array[] = [];
    streams.push(createElementaryStream(0x24, basePID));
    streams.push(createElementaryStream(
        options.enhancementStreamType ?? 0x24,
        enhancementPID,
        createDolbyVisionDescriptor({
            dependencyPID: basePID,
            ...options.descriptorOptions
        })
    ));
    for (const extraEnhancementPID of options.extraEnhancementPIDs ?? []) {
        streams.push(createElementaryStream(
            0x24,
            extraEnhancementPID,
            createDolbyVisionDescriptor({ dependencyPID: basePID })
        ));
    }
    return createPSISection(PROGRAM_MAP_TABLE_ID, concatenate([
        new Uint8Array([
            0x00, 0x01,
            0xC1,
            0x00,
            0x00,
            0xE0 | (basePID >> 8), basePID & 0xFF,
            0xF0 | (programDescriptors.byteLength >> 8),
            programDescriptors.byteLength & 0xFF
        ]),
        programDescriptors,
        ...streams
    ]));
}

function createBDMVProgramMap(): Uint8Array {
    const registration = createDescriptor(
        0x05,
        new Uint8Array([ 0x48, 0x44, 0x4D, 0x56 ])
    );
    return createPSISection(PROGRAM_MAP_TABLE_ID, concatenate([
        new Uint8Array([
            0x00, 0x01,
            0xC1,
            0x00,
            0x00,
            0xF0, 0x11,
            0xF0, registration.byteLength
        ]),
        registration,
        createElementaryStream(0x24, 0x1011),
        createElementaryStream(0x24, 0x1015)
    ]));
}

function packetizeSection(
    pid: number,
    section: Uint8Array,
    startingContinuityCounter = 0
): Uint8Array[] {
    const packets: Uint8Array[] = [];
    let sectionOffset = 0;
    let continuityCounter = startingContinuityCounter;
    while (sectionOffset < section.byteLength) {
        const packet = new Uint8Array(MPEG_TS_PACKET_BYTE_LENGTH).fill(0xFF);
        const payloadUnitStart = sectionOffset === 0;
        packet[0] = 0x47;
        packet[1] = (payloadUnitStart ? 0x40 : 0) | (pid >> 8);
        packet[2] = pid & 0xFF;
        packet[3] = 0x10 | continuityCounter;
        let payloadOffset = 4;
        if (payloadUnitStart) {
            packet[payloadOffset] = 0;
            payloadOffset += 1;
        }
        const copyByteLength = Math.min(
            packet.byteLength - payloadOffset,
            section.byteLength - sectionOffset
        );
        packet.set(
            section.subarray(sectionOffset, sectionOffset + copyByteLength),
            payloadOffset
        );
        sectionOffset += copyByteLength;
        continuityCounter = (continuityCounter + 1) & 0x0F;
        packets.push(packet);
    }
    return packets;
}

function createNullPacket(): Uint8Array {
    const packet = new Uint8Array(MPEG_TS_PACKET_BYTE_LENGTH).fill(0xFF);
    packet.set([ 0x47, 0x1F, 0xFF, 0x10 ]);
    return packet;
}

function createTransportStream(
    programMap: Uint8Array,
    packetLayout: 'm2ts' | 'ts' = 'ts'
): Uint8Array {
    const packets = [
        ...packetizeSection(0, createProgramAssociationTable()),
        ...packetizeSection(PROGRAM_MAP_PID, programMap),
        createNullPacket()
    ];
    if (packetLayout === 'ts') {
        return concatenate(packets);
    }
    const m2tsPackets = packets.map((packet: Uint8Array, packetIndex: number): Uint8Array => {
        const m2tsPacket = new Uint8Array(M2TS_PACKET_BYTE_LENGTH);
        m2tsPacket[3] = packetIndex;
        m2tsPacket.set(packet, 4);
        return m2tsPacket;
    });
    return concatenate(m2tsPackets);
}

function createReader(data: Uint8Array): MPEGTransportStreamByteRangeReader {
    return vi.fn(async (offset: number, byteLength: number): Promise<Uint8Array | null> => {
        if (offset >= data.byteLength) {
            return null;
        }
        return data.slice(offset, Math.min(data.byteLength, offset + byteLength));
    });
}

describe('MPEGTransportStreamDolbyVisionConfiguration', () => {
    it('discovers an HEVC-declared Profile 7 enhancement PID', async () => {
        const reader = createReader(createTransportStream(createProgramMap()));

        await expect(readMPEGTransportStreamDolbyVisionTrackConfiguration(
            reader,
            BASE_PID
        )).resolves.toEqual({
            separateEnhancementTrackNumber: ENHANCEMENT_PID
        });
        expect(reader).toHaveBeenCalledWith(0, MAXIMUM_PROBE_BYTE_LENGTH);
    });

    it('discovers the standards-defined private-data enhancement PID', async () => {
        const reader = createReader(createTransportStream(createProgramMap({
            enhancementStreamType: 0x06
        })));

        await expect(readMPEGTransportStreamDolbyVisionTrackConfiguration(
            reader,
            BASE_PID
        )).resolves.toEqual({
            separateEnhancementTrackNumber: ENHANCEMENT_PID
        });
    });

    it('discovers UHD Blu-ray fixed PIDs in M2TS', async () => {
        const reader = createReader(createTransportStream(createBDMVProgramMap(), 'm2ts'));

        await expect(readMPEGTransportStreamDolbyVisionTrackConfiguration(
            reader,
            0x1011
        )).resolves.toEqual({
            separateEnhancementTrackNumber: 0x1015
        });
    });

    it('reassembles a split program map section', async () => {
        const fillerDescriptor = createDescriptor(0x40, new Uint8Array(170));
        const reader = createReader(createTransportStream(createProgramMap({
            programDescriptors: fillerDescriptor
        })));

        await expect(readMPEGTransportStreamDolbyVisionTrackConfiguration(
            reader,
            BASE_PID
        )).resolves.toEqual({
            separateEnhancementTrackNumber: ENHANCEMENT_PID
        });
    });

    it('rejects a split section after a continuity gap', async () => {
        const fillerDescriptor = createDescriptor(0x40, new Uint8Array(170));
        const programMapPackets = packetizeSection(PROGRAM_MAP_PID, createProgramMap({
            programDescriptors: fillerDescriptor
        }));
        programMapPackets[1][3] = (programMapPackets[1][3] & 0xF0) | 0x02;
        const reader = createReader(concatenate([
            ...packetizeSection(0, createProgramAssociationTable()),
            ...programMapPackets,
            createNullPacket()
        ]));

        await expect(readMPEGTransportStreamDolbyVisionTrackConfiguration(
            reader,
            BASE_PID
        )).resolves.toBeNull();
    });

    it('fails closed when the parsed PSI section bound is exceeded', async () => {
        const programMap = createProgramMap();
        const programMapPackets: Uint8Array[] = [];
        for (let sectionIndex = 0; sectionIndex < 256; sectionIndex += 1) {
            programMapPackets.push(...packetizeSection(
                PROGRAM_MAP_PID,
                programMap,
                sectionIndex & 0x0F
            ));
        }
        const reader = createReader(concatenate([
            ...packetizeSection(0, createProgramAssociationTable()),
            ...programMapPackets
        ]));

        await expect(readMPEGTransportStreamDolbyVisionTrackConfiguration(
            reader,
            BASE_PID
        )).resolves.toBeNull();
    });

    it('rejects a bad PSI CRC', async () => {
        const programMap = createProgramMap();
        programMap[programMap.byteLength - 1] ^= 0x01;
        const reader = createReader(createTransportStream(programMap));

        await expect(readMPEGTransportStreamDolbyVisionTrackConfiguration(
            reader,
            BASE_PID
        )).resolves.toBeNull();
    });

    it('rejects incompatible Dolby Vision signaling', async () => {
        const incompatibleConfigurations: DolbyVisionDescriptorOptions[] = [
            { dependencyPID: 0x102 },
            { profile: 8 },
            { rpuPresent: false },
            { enhancementLayerPresent: false },
            { baseLayerPresent: true },
            { compatibilityID: 1 },
            { metadataCompression: 1 },
            { versionMajor: 2 }
        ];
        for (const descriptorOptions of incompatibleConfigurations) {
            const reader = createReader(createTransportStream(createProgramMap({
                descriptorOptions
            })));
            await expect(readMPEGTransportStreamDolbyVisionTrackConfiguration(
                reader,
                BASE_PID
            )).resolves.toBeNull();
        }
    });

    it('rejects ambiguous enhancement PIDs', async () => {
        const reader = createReader(createTransportStream(createProgramMap({
            extraEnhancementPIDs: [ 0x102 ]
        })));

        await expect(readMPEGTransportStreamDolbyVisionTrackConfiguration(
            reader,
            BASE_PID
        )).resolves.toBeNull();
    });

    it('fails closed for invalid inputs and non-transport data', async () => {
        const reader = createReader(new Uint8Array(1_024));

        await expect(readMPEGTransportStreamDolbyVisionTrackConfiguration(
            reader,
            0
        )).resolves.toBeNull();
        await expect(readMPEGTransportStreamDolbyVisionTrackConfiguration(
            reader,
            BASE_PID
        )).resolves.toBeNull();
    });
});
