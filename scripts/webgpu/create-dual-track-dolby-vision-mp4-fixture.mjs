import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const BASIC_BOX_HEADER_BYTE_LENGTH = 8;
const EXTENDED_BOX_HEADER_BYTE_LENGTH = 16;
const VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH = 78;
const MAXIMUM_FIXTURE_BYTE_LENGTH = 128 * 1_024 * 1_024;
const MAXIMUM_TOOL_OUTPUT_BYTE_LENGTH = 16 * 1_024 * 1_024;
const BASE_HEVC_SAMPLE_ENTRY_TYPES = new Set([ 'hvc1', 'hev1' ]);
const DOLBY_VISION_SAMPLE_ENTRY_TYPE_BY_HEVC_TYPE = new Map([
    [ 'hvc1', 'dvh1' ],
    [ 'hev1', 'dvhe' ]
]);

const USAGE = `Usage:
  node scripts/webgpu/create-dual-track-dolby-vision-mp4-fixture.mjs \\
      <separate-profile7.mkv> <output.mp4> [--ffmpeg <path>]

Creates a validation-only MP4 with a base HEVC track and a dependent dvh1/dvhe
Profile 7 enhancement track. The input should be produced by
create-separate-track-dolby-vision-fixture.mjs.`;

export class FixtureError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FixtureError';
    }
}

function readUnsigned32(data, offset, endOffset = data.byteLength) {
    if (offset < 0 || offset + 4 > endOffset) {
        throw new FixtureError('An ISO base media unsigned integer is truncated');
    }
    return (
        (data[offset] * 0x1_000000)
        + (data[offset + 1] * 0x1_0000)
        + (data[offset + 2] * 0x100)
        + data[offset + 3]
    );
}

function readUnsigned64(data, offset, endOffset) {
    const highValue = readUnsigned32(data, offset, endOffset);
    const lowValue = readUnsigned32(data, offset + 4, endOffset);
    const value = (highValue * 0x1_0000_0000) + lowValue;
    if (!Number.isSafeInteger(value)) {
        throw new FixtureError('An ISO base media box exceeds the safe integer range');
    }
    return value;
}

function writeUnsigned32(data, offset, value) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 0xFFFF_FFFF) {
        throw new FixtureError('An ISO base media box size cannot be represented');
    }
    data[offset] = Math.floor(value / 0x1_000000) % 256;
    data[offset + 1] = Math.floor(value / 0x1_0000) % 256;
    data[offset + 2] = Math.floor(value / 0x100) % 256;
    data[offset + 3] = value % 256;
}

function readFourCC(data, offset, endOffset) {
    if (offset < 0 || offset + 4 > endOffset) {
        throw new FixtureError('An ISO base media box type is truncated');
    }
    let value = '';
    for (let byteIndex = 0; byteIndex < 4; byteIndex += 1) {
        const byteValue = data[offset + byteIndex];
        if (byteValue < 0x20 || byteValue > 0x7E) {
            throw new FixtureError('An ISO base media box type is not printable ASCII');
        }
        value += String.fromCharCode(byteValue);
    }
    return value;
}

function parseBox(data, startOffset, containerEndOffset) {
    if (startOffset < 0 || startOffset + BASIC_BOX_HEADER_BYTE_LENGTH > containerEndOffset) {
        throw new FixtureError('An ISO base media box header is truncated');
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
    const endOffset = startOffset + boxByteLength;
    if (
        boxByteLength < headerByteLength
        || !Number.isSafeInteger(endOffset)
        || endOffset > containerEndOffset
    ) {
        throw new FixtureError(`The ISO base media ${type} box size is invalid`);
    }
    return {
        compactSize,
        dataOffset: startOffset + headerByteLength,
        dataSize: boxByteLength - headerByteLength,
        endOffset,
        headerByteLength,
        startOffset,
        type
    };
}

function parseChildren(data, startOffset, endOffset) {
    const boxes = [];
    let offset = startOffset;
    while (offset < endOffset) {
        if (boxes.length >= 4_096) {
            throw new FixtureError('The ISO base media child box count exceeds its bound');
        }
        const box = parseBox(data, offset, endOffset);
        boxes.push(box);
        offset = box.endOffset;
    }
    return boxes;
}

function findUniqueBox(boxes, type, required = false) {
    const matches = boxes.filter(box => box.type === type);
    if (matches.length > 1 || (required && matches.length !== 1)) {
        throw new FixtureError(`Expected one ISO base media ${type} box`);
    }
    return matches[0] ?? null;
}

function findUniqueNestedBox(data, rootBox, path) {
    let currentBox = rootBox;
    for (const type of path) {
        const childBox = findUniqueBox(
            parseChildren(data, currentBox.dataOffset, currentBox.endOffset),
            type,
            true
        );
        currentBox = childBox;
    }
    return currentBox;
}

function parseTrackID(data, trackHeaderBox) {
    if (trackHeaderBox.dataSize < 4) {
        throw new FixtureError('The ISO base media track header is truncated');
    }
    const version = data[trackHeaderBox.dataOffset];
    let trackIDOffset;
    switch (version) {
        case 0:
            trackIDOffset = trackHeaderBox.dataOffset + 12;
            break;
        case 1:
            trackIDOffset = trackHeaderBox.dataOffset + 20;
            break;
        default:
            throw new FixtureError('The ISO base media track header version is unsupported');
    }
    const trackID = readUnsigned32(data, trackIDOffset, trackHeaderBox.endOffset);
    if (trackID <= 0) {
        throw new FixtureError('The ISO base media track ID is invalid');
    }
    return trackID;
}

function parseVideoTrack(data, trackBox) {
    if (trackBox.compactSize === 1 || trackBox.compactSize === 0) {
        throw new FixtureError('The fixture requires compact track box sizes');
    }
    const trackChildren = parseChildren(data, trackBox.dataOffset, trackBox.endOffset);
    const trackHeaderBox = findUniqueBox(trackChildren, 'tkhd', true);
    if (findUniqueBox(trackChildren, 'tref')) {
        throw new FixtureError('The enhancement source already contains a track reference');
    }
    const handlerBox = findUniqueNestedBox(data, trackBox, [ 'mdia', 'hdlr' ]);
    if (
        handlerBox.dataSize < 12
        || readFourCC(data, handlerBox.dataOffset + 8, handlerBox.endOffset) !== 'vide'
    ) {
        throw new FixtureError('The fixture contains a non-video track');
    }
    const sampleDescriptionBox = findUniqueNestedBox(
        data,
        trackBox,
        [ 'mdia', 'minf', 'stbl', 'stsd' ]
    );
    if (
        sampleDescriptionBox.dataSize < 8
        || readUnsigned32(
            data,
            sampleDescriptionBox.dataOffset + 4,
            sampleDescriptionBox.endOffset
        ) !== 1
    ) {
        throw new FixtureError('The fixture requires one video sample entry per track');
    }
    const sampleEntry = parseBox(
        data,
        sampleDescriptionBox.dataOffset + 8,
        sampleDescriptionBox.endOffset
    );
    if (
        sampleEntry.endOffset !== sampleDescriptionBox.endOffset
        || !BASE_HEVC_SAMPLE_ENTRY_TYPES.has(sampleEntry.type)
    ) {
        throw new FixtureError('The fixture requires hvc1 or hev1 sample entries');
    }
    const sampleEntryChildOffset = sampleEntry.dataOffset
        + VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH;
    if (sampleEntryChildOffset > sampleEntry.endOffset) {
        throw new FixtureError('An HEVC visual sample entry is truncated');
    }
    const sampleEntryChildren = parseChildren(
        data,
        sampleEntryChildOffset,
        sampleEntry.endOffset
    );
    findUniqueBox(sampleEntryChildren, 'hvcC', true);
    return {
        dolbyVisionConfigurationBox: findUniqueBox(sampleEntryChildren, 'dvcC'),
        sampleEntry,
        trackBox,
        trackHeaderBox,
        trackID: parseTrackID(data, trackHeaderBox)
    };
}

function requireProfile7EnhancementConfiguration(data, configurationBox) {
    if (!configurationBox || configurationBox.dataSize < 4) {
        throw new FixtureError('The enhancement track has no valid dvcC configuration');
    }
    const bitsOffset = configurationBox.dataOffset + 2;
    const configurationBits = (data[bitsOffset] * 256) + data[bitsOffset + 1];
    const profile = (configurationBits >> 9) & 0x7F;
    const rpuPresent = (configurationBits & 4) !== 0;
    const enhancementLayerPresent = (configurationBits & 2) !== 0;
    if (profile !== 7 || !rpuPresent || !enhancementLayerPresent) {
        throw new FixtureError('The enhancement track is not an RPU-bearing Profile 7 EL');
    }
    return bitsOffset;
}

function createBox(type, payload) {
    const output = Buffer.alloc(payload.byteLength + BASIC_BOX_HEADER_BYTE_LENGTH);
    writeUnsigned32(output, 0, output.byteLength);
    output.write(type, 4, 4, 'ascii');
    Buffer.from(payload).copy(output, BASIC_BOX_HEADER_BYTE_LENGTH);
    return output;
}

function createVideoDependencyReference(baseTrackID) {
    const trackID = Buffer.alloc(4);
    writeUnsigned32(trackID, 0, baseTrackID);
    return createBox('tref', createBox('vdep', trackID));
}

/** Patches a two-track HEVC MP4 into a legacy dual-track Profile 7 fixture. */
export function patchDualTrackDolbyVisionMP4(sourceData) {
    const source = Buffer.from(sourceData);
    if (source.byteLength === 0 || source.byteLength > MAXIMUM_FIXTURE_BYTE_LENGTH) {
        throw new FixtureError('The MP4 fixture size is unsupported');
    }
    const topLevelBoxes = parseChildren(source, 0, source.byteLength);
    if (topLevelBoxes[0]?.type !== 'ftyp') {
        throw new FixtureError('The fixture is not an ISO base media file');
    }
    const movieBox = findUniqueBox(topLevelBoxes, 'moov', true);
    if (movieBox.compactSize === 1 || movieBox.compactSize === 0) {
        throw new FixtureError('The fixture requires a compact movie box size');
    }
    const mediaDataBoxes = topLevelBoxes.filter(box => box.type === 'mdat');
    if (
        mediaDataBoxes.length === 0
        || mediaDataBoxes.some(box => box.endOffset > movieBox.startOffset)
    ) {
        throw new FixtureError('All fixture media data must precede the movie box');
    }
    const trackBoxes = parseChildren(source, movieBox.dataOffset, movieBox.endOffset)
        .filter(box => box.type === 'trak');
    if (trackBoxes.length !== 2) {
        throw new FixtureError('The fixture requires exactly two video tracks');
    }
    const tracks = trackBoxes.map(trackBox => parseVideoTrack(source, trackBox));
    if (tracks[0].trackID === tracks[1].trackID) {
        throw new FixtureError('The fixture track IDs are duplicated');
    }
    const enhancementTracks = tracks.filter(track => track.dolbyVisionConfigurationBox);
    if (enhancementTracks.length !== 1) {
        throw new FixtureError('The fixture requires exactly one Dolby Vision enhancement track');
    }
    const enhancementTrack = enhancementTracks[0];
    const baseTrack = tracks.find(track => track !== enhancementTrack);
    if (!baseTrack || baseTrack.dolbyVisionConfigurationBox) {
        throw new FixtureError('The fixture base track is ambiguous');
    }
    const configurationBitsOffset = requireProfile7EnhancementConfiguration(
        source,
        enhancementTrack.dolbyVisionConfigurationBox
    );
    const dolbyVisionSampleEntryType = DOLBY_VISION_SAMPLE_ENTRY_TYPE_BY_HEVC_TYPE.get(
        enhancementTrack.sampleEntry.type
    );
    if (!dolbyVisionSampleEntryType) {
        throw new FixtureError('The enhancement sample entry type is unsupported');
    }

    const patchedSource = Buffer.from(source);
    patchedSource[configurationBitsOffset + 1] &= 0xFE;
    patchedSource.write(
        dolbyVisionSampleEntryType,
        enhancementTrack.sampleEntry.startOffset + 4,
        4,
        'ascii'
    );
    const trackReferenceBox = createVideoDependencyReference(baseTrack.trackID);
    writeUnsigned32(
        patchedSource,
        enhancementTrack.trackBox.startOffset,
        enhancementTrack.trackBox.endOffset
            - enhancementTrack.trackBox.startOffset
            + trackReferenceBox.byteLength
    );
    writeUnsigned32(
        patchedSource,
        movieBox.startOffset,
        movieBox.endOffset - movieBox.startOffset + trackReferenceBox.byteLength
    );
    const insertionOffset = enhancementTrack.trackHeaderBox.endOffset;
    const data = Buffer.concat([
        patchedSource.subarray(0, insertionOffset),
        trackReferenceBox,
        patchedSource.subarray(insertionOffset)
    ]);
    return {
        baseTrackID: baseTrack.trackID,
        data,
        enhancementSampleEntryType: dolbyVisionSampleEntryType,
        enhancementTrackID: enhancementTrack.trackID
    };
}

function parseArguments(argumentsList) {
    if (argumentsList.includes('--help')) {
        return { help: true };
    }
    const ffmpegOptionIndex = argumentsList.indexOf('--ffmpeg');
    let configuredFFmpegPath = null;
    const positionalArguments = [ ...argumentsList ];
    if (ffmpegOptionIndex >= 0) {
        configuredFFmpegPath = argumentsList[ffmpegOptionIndex + 1];
        if (!configuredFFmpegPath) {
            throw new FixtureError('--ffmpeg requires a path');
        }
        positionalArguments.splice(ffmpegOptionIndex, 2);
    }
    if (positionalArguments.length !== 2) {
        throw new FixtureError('Expected an input and output path');
    }
    const inputPath = resolve(positionalArguments[0]);
    const outputPath = resolve(positionalArguments[1]);
    if (inputPath === outputPath) {
        throw new FixtureError('The output path must differ from the input path');
    }
    return {
        configuredFFmpegPath: configuredFFmpegPath ? resolve(configuredFFmpegPath) : null,
        help: false,
        inputPath,
        outputPath
    };
}

async function resolveFFmpeg(configuredPath) {
    if (!configuredPath) {
        return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    }
    await access(configuredPath);
    return configuredPath;
}

async function executeFFmpeg(executable, argumentsList) {
    return execFile(executable, argumentsList, {
        encoding: 'utf8',
        maxBuffer: MAXIMUM_TOOL_OUTPUT_BYTE_LENGTH,
        windowsHide: true
    });
}

export async function createDualTrackDolbyVisionMP4Fixture(configuration) {
    const sourceFile = await stat(configuration.inputPath);
    if (!sourceFile.isFile() || sourceFile.size > MAXIMUM_FIXTURE_BYTE_LENGTH) {
        throw new FixtureError('The source fixture size is unsupported');
    }
    const ffmpegPath = await resolveFFmpeg(configuration.configuredFFmpegPath);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'webgpu-dovi-mp4-'));
    const resolvedTemporaryDirectory = resolve(temporaryDirectory);
    if (dirname(resolvedTemporaryDirectory) !== resolve(tmpdir())) {
        throw new FixtureError('Refusing to use an unexpected temporary directory');
    }
    try {
        const unpatchedPath = join(temporaryDirectory, 'unpatched.mp4');
        await executeFFmpeg(ffmpegPath, [
            '-hide_banner',
            '-loglevel', 'error',
            '-nostdin',
            '-y',
            '-i', configuration.inputPath,
            '-map', '0:v:0',
            '-map', '0:v:1',
            '-c:v', 'copy',
            '-tag:v:0', 'hvc1',
            '-tag:v:1', 'hvc1',
            '-disposition:v:0', 'default',
            '-disposition:v:1', '0',
            '-map_metadata', '-1',
            '-strict', 'unofficial',
            unpatchedPath
        ]);
        const unpatchedData = await readFile(unpatchedPath);
        const patched = patchDualTrackDolbyVisionMP4(unpatchedData);
        await writeFile(configuration.outputPath, patched.data);
        return {
            baseTrackID: patched.baseTrackID,
            byteLength: patched.data.byteLength,
            enhancementSampleEntryType: patched.enhancementSampleEntryType,
            enhancementTrackID: patched.enhancementTrackID,
            outputPath: configuration.outputPath,
            sha256: createHash('sha256').update(patched.data).digest('hex')
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
    console.log(JSON.stringify(
        await createDualTrackDolbyVisionMP4Fixture(configuration),
        null,
        2
    ));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        console.error(USAGE);
        process.exitCode = 1;
    });
}
