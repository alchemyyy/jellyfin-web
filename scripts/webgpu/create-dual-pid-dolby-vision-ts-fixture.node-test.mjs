import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createTransportStreamFFmpegArguments,
    patchDolbyVisionProgramMaps,
    TransportStreamFixtureError
} from './create-dual-pid-dolby-vision-ts-fixture.mjs';

const MPEG_TS_PACKET_BYTE_LENGTH = 188;
const MPEG_2_CRC_POLYNOMIAL = 0x04C1_1DB7;
const BASE_PID = 0x100;
const ENHANCEMENT_PID = 0x101;
const PROGRAM_MAP_PID = 0x1000;

function concatenate(parts) {
    const output = new Uint8Array(parts.reduce(
        (byteLength, part) => byteLength + part.byteLength,
        0
    ));
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

function getMPEG2CRC32(data) {
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

function createSection(tableID, body) {
    const sectionLength = body.byteLength + 4;
    const sectionWithoutCRC = concatenate([
        new Uint8Array([ tableID, 0xB0 | (sectionLength >> 8), sectionLength & 0xFF ]),
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

function createElementaryStream(pid) {
    return new Uint8Array([
        0x24,
        0xE0 | (pid >> 8), pid & 0xFF,
        0xF0, 0x00
    ]);
}

function packetize(pid, section, continuityCounter = 0) {
    const packet = new Uint8Array(MPEG_TS_PACKET_BYTE_LENGTH).fill(0xFF);
    assert.ok(section.byteLength <= 183);
    packet.set([
        0x47,
        0x40 | (pid >> 8),
        pid & 0xFF,
        0x10 | continuityCounter,
        0
    ]);
    packet.set(section, 5);
    return packet;
}

function createProgramAssociationTable() {
    return createSection(0x00, new Uint8Array([
        0x00, 0x01,
        0xC1,
        0x00,
        0x00,
        0x00, 0x01,
        0xF0, 0x00
    ]));
}

function createProgramMap(includeEnhancement = true) {
    const streams = [ createElementaryStream(BASE_PID) ];
    if (includeEnhancement) {
        streams.push(createElementaryStream(ENHANCEMENT_PID));
    }
    return createSection(0x02, concatenate([
        new Uint8Array([
            0x00, 0x01,
            0xC1,
            0x00,
            0x00,
            0xE1, 0x00,
            0xF0, 0x00
        ]),
        ...streams
    ]));
}

function createTransportStream(includeEnhancement = true, repeatedProgramMap = false) {
    const packets = [
        packetize(0, createProgramAssociationTable()),
        packetize(PROGRAM_MAP_PID, createProgramMap(includeEnhancement))
    ];
    if (repeatedProgramMap) {
        packets.push(packetize(PROGRAM_MAP_PID, createProgramMap(includeEnhancement), 1));
    }
    return concatenate(packets);
}

function findSequence(data, sequence) {
    for (let offset = 0; offset + sequence.byteLength <= data.byteLength; offset += 1) {
        let matches = true;
        for (let byteIndex = 0; byteIndex < sequence.byteLength; byteIndex += 1) {
            matches &&= data[offset + byteIndex] === sequence[byteIndex];
        }
        if (matches) {
            return offset;
        }
    }
    return -1;
}

test('creates bounded copy-only FFmpeg arguments with stable PIDs', () => {
    assert.deepEqual(createTransportStreamFFmpegArguments('input.mkv', 'output.ts'), [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-y',
        '-i', 'input.mkv',
        '-map', '0:v:0',
        '-map', '0:v:1',
        '-c:v', 'copy',
        '-streamid', '0:256',
        '-streamid', '1:257',
        '-map_metadata', '-1',
        '-f', 'mpegts',
        'output.ts'
    ]);
});

test('patches every compatible PMT with an exact dependency descriptor', () => {
    const sourceData = createTransportStream(true, true);
    const result = patchDolbyVisionProgramMaps(sourceData);

    assert.equal(result.patchedProgramMapCount, 2);
    assert.notStrictEqual(result.outputData, sourceData);
    assert.deepEqual(sourceData, createTransportStream(true, true));
    const expectedDescriptor = new Uint8Array([
        0xB0, 0x07,
        0x01, 0x00,
        0x0E, 0x1E,
        0x08, 0x00,
        0x60
    ]);
    assert.notEqual(findSequence(result.outputData, expectedDescriptor), -1);

    for (let packetIndex = 1; packetIndex <= 2; packetIndex += 1) {
        const packetOffset = packetIndex * MPEG_TS_PACKET_BYTE_LENGTH;
        const sectionOffset = packetOffset + 5;
        const sectionByteLength = 3
            + (((result.outputData[sectionOffset + 1] & 0x0F) << 8)
                | result.outputData[sectionOffset + 2]);
        assert.equal(getMPEG2CRC32(result.outputData.subarray(
            sectionOffset,
            sectionOffset + sectionByteLength
        )), 0);
    }
});

test('rejects a transport stream without the enhancement PID', () => {
    assert.throws(
        () => patchDolbyVisionProgramMaps(createTransportStream(false)),
        TransportStreamFixtureError
    );
});

test('rejects packet misalignment', () => {
    assert.throws(
        () => patchDolbyVisionProgramMaps(new Uint8Array(189)),
        TransportStreamFixtureError
    );
});
