import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const MPEG_TS_PACKET_BYTE_LENGTH = 188;
const MPEG_TS_SYNC_BYTE = 0x47;
const PROGRAM_ASSOCIATION_TABLE_ID = 0x00;
const PROGRAM_MAP_TABLE_ID = 0x02;
const HEVC_STREAM_TYPE = 0x24;
const DOLBY_VISION_VIDEO_STREAM_DESCRIPTOR_TAG = 0xB0;
const MPEG_2_CRC_POLYNOMIAL = 0x04C1_1DB7;
const BASE_VIDEO_PID = 0x100;
const ENHANCEMENT_VIDEO_PID = 0x101;
const MAXIMUM_SOURCE_FIXTURE_BYTE_LENGTH = 128 * 1_024 * 1_024;
const MAXIMUM_TRANSPORT_STREAM_BYTE_LENGTH = 256 * 1_024 * 1_024;
const MAXIMUM_TOOL_OUTPUT_BYTE_LENGTH = 16 * 1_024 * 1_024;

const USAGE = `Usage:
  node scripts/webgpu/create-dual-pid-dolby-vision-ts-fixture.mjs \\
      <two-track-profile7-input> <output.ts> [--ffmpeg <path>]

Creates a validation-only dual-PID MPEG-TS fixture. Both HEVC PIDs remain
stream_type 0x24 so Mediabunny exposes them; the EL PMT entry receives an exact
Profile 7 Dolby Vision dependency descriptor. The input must expose ordinary
HEVC BL and EL/RPU tracks, such as the output of the separate-track Matroska or
structural Profile 7 playback fixture generators.`;

export class TransportStreamFixtureError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TransportStreamFixtureError';
    }
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

function getPayloadOffset(packet) {
    if (packet.byteLength !== MPEG_TS_PACKET_BYTE_LENGTH || packet[0] !== MPEG_TS_SYNC_BYTE) {
        return null;
    }
    const adaptationFieldControl = (packet[3] >> 4) & 0x03;
    if (adaptationFieldControl === 0 || adaptationFieldControl === 2) {
        return null;
    }
    let payloadOffset = 4;
    if (adaptationFieldControl === 3) {
        payloadOffset += 1 + packet[payloadOffset];
    }
    return payloadOffset < packet.byteLength ? payloadOffset : null;
}

function getPacketPID(packet) {
    return ((packet[1] & 0x1F) << 8) | packet[2];
}

function getSinglePacketSection(packet, expectedTableID) {
    const payloadOffset = getPayloadOffset(packet);
    if (payloadOffset === null || (packet[1] & 0x40) === 0) {
        return null;
    }
    const sectionOffset = payloadOffset + 1 + packet[payloadOffset];
    if (sectionOffset + 3 > packet.byteLength || packet[sectionOffset] !== expectedTableID) {
        return null;
    }
    const sectionByteLength = 3
        + (((packet[sectionOffset + 1] & 0x0F) << 8) | packet[sectionOffset + 2]);
    const sectionEndOffset = sectionOffset + sectionByteLength;
    if (
        sectionByteLength < 12
        || sectionEndOffset > packet.byteLength
        || getMPEG2CRC32(packet.subarray(sectionOffset, sectionEndOffset)) !== 0
    ) {
        return null;
    }
    return { sectionEndOffset, sectionOffset };
}

function getProgramMapPIDs(data) {
    const programMapPIDs = new Set();
    for (
        let packetOffset = 0;
        packetOffset + MPEG_TS_PACKET_BYTE_LENGTH <= data.byteLength;
        packetOffset += MPEG_TS_PACKET_BYTE_LENGTH
    ) {
        const packet = data.subarray(packetOffset, packetOffset + MPEG_TS_PACKET_BYTE_LENGTH);
        if (getPacketPID(packet) !== 0) {
            continue;
        }
        const section = getSinglePacketSection(packet, PROGRAM_ASSOCIATION_TABLE_ID);
        if (!section) {
            continue;
        }
        const entriesEndOffset = section.sectionEndOffset - 4;
        for (let offset = section.sectionOffset + 8; offset < entriesEndOffset; offset += 4) {
            if (offset + 4 > entriesEndOffset) {
                throw new TransportStreamFixtureError('The generated PAT is malformed');
            }
            const programNumber = (packet[offset] << 8) | packet[offset + 1];
            if (programNumber !== 0) {
                programMapPIDs.add(((packet[offset + 2] & 0x1F) << 8) | packet[offset + 3]);
            }
        }
    }
    if (programMapPIDs.size === 0) {
        throw new TransportStreamFixtureError('The generated MPEG-TS has no bounded PAT');
    }
    return programMapPIDs;
}

function createDolbyVisionDescriptor(basePID) {
    const profile = 7;
    const level = 3;
    const configurationBits = (profile << 9) | (level << 3) | 0x06;
    const dependencyBits = basePID << 3;
    return new Uint8Array([
        DOLBY_VISION_VIDEO_STREAM_DESCRIPTOR_TAG,
        7,
        1,
        0,
        configurationBits >> 8,
        configurationBits & 0xFF,
        dependencyBits >> 8,
        dependencyBits & 0xFF,
        6 << 4
    ]);
}

function findProgramMapEnhancementEntry(
    packet,
    section,
    basePID,
    enhancementPID
) {
    const entriesEndOffset = section.sectionEndOffset - 4;
    const programInfoByteLength = ((packet[section.sectionOffset + 10] & 0x0F) << 8)
        | packet[section.sectionOffset + 11];
    let offset = section.sectionOffset + 12 + programInfoByteLength;
    let baseLayerFound = false;
    let enhancementEntry = null;
    while (offset < entriesEndOffset) {
        if (offset + 5 > entriesEndOffset) {
            throw new TransportStreamFixtureError('The generated PMT stream entry is truncated');
        }
        const streamType = packet[offset];
        const pid = ((packet[offset + 1] & 0x1F) << 8) | packet[offset + 2];
        const descriptorByteLength = ((packet[offset + 3] & 0x0F) << 8)
            | packet[offset + 4];
        const descriptorEndOffset = offset + 5 + descriptorByteLength;
        if (descriptorEndOffset > entriesEndOffset) {
            throw new TransportStreamFixtureError('The generated PMT descriptor loop is malformed');
        }
        if (pid === basePID && streamType === HEVC_STREAM_TYPE) {
            baseLayerFound = true;
        }
        if (pid === enhancementPID && streamType === HEVC_STREAM_TYPE) {
            if (enhancementEntry) {
                throw new TransportStreamFixtureError('The generated PMT repeats the EL PID');
            }
            enhancementEntry = {
                descriptorEndOffset,
                entryOffset: offset,
                existingDescriptorByteLength: descriptorByteLength
            };
        }
        offset = descriptorEndOffset;
    }
    if (!baseLayerFound || !enhancementEntry) {
        return null;
    }
    return enhancementEntry;
}

function patchProgramMapPacket(packet, basePID, enhancementPID) {
    const section = getSinglePacketSection(packet, PROGRAM_MAP_TABLE_ID);
    if (!section) {
        return false;
    }
    const enhancementEntry = findProgramMapEnhancementEntry(
        packet,
        section,
        basePID,
        enhancementPID
    );
    if (!enhancementEntry) {
        return false;
    }
    const descriptor = createDolbyVisionDescriptor(basePID);
    const nextSectionEndOffset = section.sectionEndOffset + descriptor.byteLength;
    if (nextSectionEndOffset > packet.byteLength) {
        throw new TransportStreamFixtureError('The generated PMT has no descriptor stuffing');
    }
    packet.copyWithin(
        enhancementEntry.descriptorEndOffset + descriptor.byteLength,
        enhancementEntry.descriptorEndOffset,
        section.sectionEndOffset
    );
    packet.set(descriptor, enhancementEntry.descriptorEndOffset);

    const nextDescriptorByteLength = enhancementEntry.existingDescriptorByteLength
        + descriptor.byteLength;
    packet[enhancementEntry.entryOffset + 3] = 0xF0 | (nextDescriptorByteLength >> 8);
    packet[enhancementEntry.entryOffset + 4] = nextDescriptorByteLength & 0xFF;
    const previousSectionLength = ((packet[section.sectionOffset + 1] & 0x0F) << 8)
        | packet[section.sectionOffset + 2];
    const nextSectionLength = previousSectionLength + descriptor.byteLength;
    packet[section.sectionOffset + 1] = 0xB0 | (nextSectionLength >> 8);
    packet[section.sectionOffset + 2] = nextSectionLength & 0xFF;

    const crcOffset = nextSectionEndOffset - 4;
    const crc = getMPEG2CRC32(packet.subarray(section.sectionOffset, crcOffset));
    packet[crcOffset] = crc >>> 24;
    packet[crcOffset + 1] = (crc >>> 16) & 0xFF;
    packet[crcOffset + 2] = (crc >>> 8) & 0xFF;
    packet[crcOffset + 3] = crc & 0xFF;
    packet.fill(0xFF, nextSectionEndOffset);
    return true;
}

/** Adds deterministic Profile 7 dependency descriptors to compatible single-packet PMTs. */
export function patchDolbyVisionProgramMaps(
    sourceData,
    basePID = BASE_VIDEO_PID,
    enhancementPID = ENHANCEMENT_VIDEO_PID
) {
    if (!(sourceData instanceof Uint8Array) || sourceData.byteLength === 0) {
        throw new TransportStreamFixtureError('The generated MPEG-TS is empty');
    }
    if (sourceData.byteLength % MPEG_TS_PACKET_BYTE_LENGTH !== 0) {
        throw new TransportStreamFixtureError('The generated MPEG-TS packet alignment is invalid');
    }
    const outputData = sourceData.slice();
    const programMapPIDs = getProgramMapPIDs(outputData);
    let patchedProgramMapCount = 0;
    for (
        let packetOffset = 0;
        packetOffset < outputData.byteLength;
        packetOffset += MPEG_TS_PACKET_BYTE_LENGTH
    ) {
        const packet = outputData.subarray(
            packetOffset,
            packetOffset + MPEG_TS_PACKET_BYTE_LENGTH
        );
        if (!programMapPIDs.has(getPacketPID(packet))) {
            continue;
        }
        if (patchProgramMapPacket(packet, basePID, enhancementPID)) {
            patchedProgramMapCount += 1;
        }
    }
    if (patchedProgramMapCount === 0) {
        throw new TransportStreamFixtureError(
            'No generated PMT contains the expected HEVC BL and EL PIDs'
        );
    }
    return { outputData, patchedProgramMapCount };
}

export function createTransportStreamFFmpegArguments(inputPath, outputPath) {
    return [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-y',
        '-i', inputPath,
        '-map', '0:v:0',
        '-map', '0:v:1',
        '-c:v', 'copy',
        '-streamid', `0:${BASE_VIDEO_PID}`,
        '-streamid', `1:${ENHANCEMENT_VIDEO_PID}`,
        '-map_metadata', '-1',
        '-f', 'mpegts',
        outputPath
    ];
}

function parseArguments(argumentsList) {
    if (argumentsList.includes('--help')) {
        return { help: true };
    }
    let configuredFFmpegPath = null;
    const positionalArguments = [];
    for (let argumentIndex = 0; argumentIndex < argumentsList.length; argumentIndex += 1) {
        const argument = argumentsList[argumentIndex];
        if (argument === '--ffmpeg') {
            const value = argumentsList[argumentIndex + 1];
            if (!value) {
                throw new TransportStreamFixtureError('--ffmpeg requires a path');
            }
            configuredFFmpegPath = resolve(value);
            argumentIndex += 1;
        } else {
            positionalArguments.push(argument);
        }
    }
    if (positionalArguments.length !== 2) {
        throw new TransportStreamFixtureError('Expected an input and output path');
    }
    const inputPath = resolve(positionalArguments[0]);
    const outputPath = resolve(positionalArguments[1]);
    if (inputPath === outputPath) {
        throw new TransportStreamFixtureError('The output path must differ from the input path');
    }
    return { configuredFFmpegPath, help: false, inputPath, outputPath };
}

async function resolveFFmpeg(configuredPath) {
    if (!configuredPath) {
        return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    }
    await access(configuredPath);
    return configuredPath;
}

async function createFixture(configuration) {
    const sourceFile = await stat(configuration.inputPath);
    if (!sourceFile.isFile() || sourceFile.size > MAXIMUM_SOURCE_FIXTURE_BYTE_LENGTH) {
        throw new TransportStreamFixtureError('The source fixture size is unsupported');
    }
    const ffmpegPath = await resolveFFmpeg(configuration.configuredFFmpegPath);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'webgpu-dovi-ts-'));
    const resolvedTemporaryDirectory = resolve(temporaryDirectory);
    if (dirname(resolvedTemporaryDirectory) !== resolve(tmpdir())) {
        throw new TransportStreamFixtureError('Refusing to use an unexpected temporary directory');
    }
    try {
        const generatedPath = join(temporaryDirectory, 'generated.ts');
        await execFile(
            ffmpegPath,
            createTransportStreamFFmpegArguments(configuration.inputPath, generatedPath),
            {
                encoding: 'utf8',
                maxBuffer: MAXIMUM_TOOL_OUTPUT_BYTE_LENGTH,
                windowsHide: true
            }
        );
        const generatedFile = await stat(generatedPath);
        if (!generatedFile.isFile() || generatedFile.size > MAXIMUM_TRANSPORT_STREAM_BYTE_LENGTH) {
            throw new TransportStreamFixtureError('The generated MPEG-TS size is unsupported');
        }
        const generatedData = new Uint8Array(await readFile(generatedPath));
        const result = patchDolbyVisionProgramMaps(generatedData);
        await writeFile(configuration.outputPath, result.outputData);
        return {
            basePID: BASE_VIDEO_PID,
            colorFidelityReference: false,
            enhancementPID: ENHANCEMENT_VIDEO_PID,
            outputByteLength: result.outputData.byteLength,
            outputPath: configuration.outputPath,
            patchedProgramMapCount: result.patchedProgramMapCount
        };
    } finally {
        await rm(resolvedTemporaryDirectory, { force: true, recursive: true });
    }
}

async function main() {
    const configuration = parseArguments(process.argv.slice(2));
    if (configuration.help) {
        console.log(USAGE);
        return;
    }
    console.log(JSON.stringify(await createFixture(configuration), null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        console.error(USAGE);
        process.exitCode = 1;
    });
}
