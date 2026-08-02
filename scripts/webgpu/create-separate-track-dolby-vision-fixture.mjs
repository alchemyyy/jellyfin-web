import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const ANNEX_B_START_CODE = Buffer.from([ 0, 0, 0, 1 ]);
const DOLBY_VISION_CONFIGURATION_MARKER = Buffer.from([ 0x64, 0x76, 0x63, 0x43 ]);
const DOLBY_VISION_RPU_NAL_UNIT_TYPE = 62;
const DOLBY_VISION_ENHANCEMENT_WRAPPER_NAL_UNIT_TYPE = 63;
const HEVC_PARAMETER_SET_NAL_UNIT_TYPES = new Set([ 32, 33, 34 ]);
const MINIMUM_HEVC_NAL_UNIT_BYTE_LENGTH = 2;
const MINIMUM_REPEATED_ACCESS_UNIT_COUNT = 3;
const MAXIMUM_SOURCE_FIXTURE_BYTE_LENGTH = 64 * 1_024 * 1_024;
const MAXIMUM_TOOL_OUTPUT_BYTE_LENGTH = 16 * 1_024 * 1_024;
const DETERMINISTIC_MUX_SEED = 'webgpu-dolby-vision-separate-track-v1';

const USAGE = `Usage:
  node scripts/webgpu/create-separate-track-dolby-vision-fixture.mjs \\
      <interleaved-profile7.mkv> <output.mkv> \\
      [--mkvtoolnix-directory <directory>]

Creates a validation-only Matroska fixture with one BL track and one Profile 7
EL/RPU track. MKVToolNix is required. The source must contain exactly one HEVC
video track with interleaved NAL type 63 enhancement data.`;

class FixtureError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FixtureError';
    }
}

function getNALUnitType(nalUnit) {
    return (nalUnit[0] >> 1) & 0x3F;
}

function findAnnexBStartCodes(data) {
    const startCodes = [];
    for (let offset = 0; offset + 3 <= data.byteLength; offset += 1) {
        let byteLength = 0;
        if (data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 1) {
            byteLength = 3;
        } else if (
            offset + 4 <= data.byteLength
            && data[offset] === 0
            && data[offset + 1] === 0
            && data[offset + 2] === 0
            && data[offset + 3] === 1
        ) {
            byteLength = 4;
        }
        if (byteLength === 0) {
            continue;
        }
        startCodes.push({ byteLength, offset });
        offset += byteLength - 1;
    }
    return startCodes;
}

function requireElementaryStream(types, layer) {
    for (const parameterSetType of HEVC_PARAMETER_SET_NAL_UNIT_TYPES) {
        if (!types.has(parameterSetType)) {
            throw new FixtureError(`${layer} stream has no HEVC NAL type ${parameterSetType}`);
        }
    }
    if (![ ...types ].some(nalUnitType => nalUnitType <= 31)) {
        throw new FixtureError(`${layer} stream has no VCL NAL unit`);
    }
}

/** Splits one Annex B interleaved Profile 7 access unit into BL and EL/RPU streams. */
export function splitInterleavedDolbyVisionAnnexB(sourceData) {
    const data = Buffer.from(sourceData);
    if (data.byteLength === 0 || data.byteLength > MAXIMUM_SOURCE_FIXTURE_BYTE_LENGTH) {
        throw new FixtureError('The extracted HEVC fixture size is unsupported');
    }
    const startCodes = findAnnexBStartCodes(data);
    if (startCodes.length === 0 || startCodes[0].offset !== 0) {
        throw new FixtureError('The extracted HEVC fixture is not Annex B');
    }

    const baseParts = [];
    const enhancementParts = [];
    const baseTypes = new Set();
    const enhancementTypes = new Set();
    let enhancementWrapperCount = 0;
    let rpuCount = 0;
    for (let nalUnitIndex = 0; nalUnitIndex < startCodes.length; nalUnitIndex += 1) {
        const startCode = startCodes[nalUnitIndex];
        const nalUnitOffset = startCode.offset + startCode.byteLength;
        const nalUnitEndOffset = startCodes[nalUnitIndex + 1]?.offset ?? data.byteLength;
        const nalUnit = data.subarray(nalUnitOffset, nalUnitEndOffset);
        if (nalUnit.byteLength < MINIMUM_HEVC_NAL_UNIT_BYTE_LENGTH) {
            throw new FixtureError('The extracted HEVC fixture contains a truncated NAL unit');
        }
        const nalUnitType = getNALUnitType(nalUnit);
        switch (nalUnitType) {
            case DOLBY_VISION_ENHANCEMENT_WRAPPER_NAL_UNIT_TYPE: {
                const enhancementNALUnit = nalUnit.subarray(2);
                if (enhancementNALUnit.byteLength < MINIMUM_HEVC_NAL_UNIT_BYTE_LENGTH) {
                    throw new FixtureError('A wrapped Dolby Vision EL NAL unit is truncated');
                }
                enhancementParts.push(ANNEX_B_START_CODE, enhancementNALUnit);
                enhancementTypes.add(getNALUnitType(enhancementNALUnit));
                enhancementWrapperCount += 1;
                break;
            }
            case DOLBY_VISION_RPU_NAL_UNIT_TYPE:
                enhancementParts.push(ANNEX_B_START_CODE, nalUnit);
                enhancementTypes.add(nalUnitType);
                rpuCount += 1;
                break;
            default:
                baseParts.push(ANNEX_B_START_CODE, nalUnit);
                baseTypes.add(nalUnitType);
                break;
        }
    }

    requireElementaryStream(baseTypes, 'Base-layer');
    requireElementaryStream(enhancementTypes, 'Enhancement-layer');
    if (enhancementWrapperCount === 0 || rpuCount !== 1) {
        throw new FixtureError(
            `Expected wrapped EL data and one RPU, found ${enhancementWrapperCount} wrappers and ${rpuCount} RPUs`
        );
    }
    return {
        baseLayerData: Buffer.concat(baseParts),
        enhancementLayerData: Buffer.concat(enhancementParts),
        enhancementWrapperCount,
        rpuCount
    };
}

function parseArguments(argumentsList) {
    if (argumentsList.includes('--help')) {
        return { help: true };
    }
    const toolDirectoryOptionIndex = argumentsList.indexOf('--mkvtoolnix-directory');
    let mkvToolNixDirectory = null;
    const positionalArguments = [ ...argumentsList ];
    if (toolDirectoryOptionIndex >= 0) {
        const directoryValue = argumentsList[toolDirectoryOptionIndex + 1];
        if (!directoryValue) {
            throw new FixtureError('--mkvtoolnix-directory requires a directory');
        }
        mkvToolNixDirectory = resolve(directoryValue);
        positionalArguments.splice(toolDirectoryOptionIndex, 2);
    }
    if (positionalArguments.length !== 2) {
        throw new FixtureError('Expected an input and output path');
    }
    const inputPath = resolve(positionalArguments[0]);
    const outputPath = resolve(positionalArguments[1]);
    if (inputPath === outputPath) {
        throw new FixtureError('The output path must differ from the input path');
    }
    return { help: false, inputPath, mkvToolNixDirectory, outputPath };
}

async function resolveTool(toolName, configuredDirectory) {
    const executableName = process.platform === 'win32' ? `${toolName}.exe` : toolName;
    const candidateDirectories = [];
    if (configuredDirectory) {
        candidateDirectories.push(configuredDirectory);
    }
    if (process.platform === 'win32' && process.env.ProgramFiles) {
        candidateDirectories.push(join(process.env.ProgramFiles, 'MKVToolNix'));
    }
    for (const candidateDirectory of candidateDirectories) {
        const candidatePath = join(candidateDirectory, executableName);
        try {
            await access(candidatePath);
            return candidatePath;
        } catch {
            continue;
        }
    }
    return executableName;
}

async function executeTool(executable, argumentsList) {
    return execFile(executable, argumentsList, {
        encoding: 'utf8',
        maxBuffer: MAXIMUM_TOOL_OUTPUT_BYTE_LENGTH,
        windowsHide: true
    });
}

async function identifyMatroska(mkvmergePath, inputPath) {
    const { stdout } = await executeTool(mkvmergePath, [ '-J', inputPath ]);
    try {
        return JSON.parse(stdout);
    } catch {
        throw new FixtureError(`MKVToolNix returned invalid identification JSON for ${basename(inputPath)}`);
    }
}

function requireSingleHEVCVideoTrack(identification) {
    const videoTracks = Array.isArray(identification.tracks) ?
        identification.tracks.filter(track => (
            track?.type === 'video'
            && track.properties?.codec_id === 'V_MPEGH/ISO/HEVC'
        )) :
        [];
    if (videoTracks.length !== 1 || !Number.isSafeInteger(videoTracks[0].id)) {
        throw new FixtureError('The source must contain exactly one Matroska HEVC video track');
    }
    return videoTracks[0].id;
}

function repeatAccessUnit(data) {
    const copies = [];
    for (let copyIndex = 0; copyIndex < MINIMUM_REPEATED_ACCESS_UNIT_COUNT; copyIndex += 1) {
        copies.push(data);
    }
    return Buffer.concat(copies);
}

async function createFixture(configuration) {
    const sourceFile = await stat(configuration.inputPath);
    if (!sourceFile.isFile() || sourceFile.size > MAXIMUM_SOURCE_FIXTURE_BYTE_LENGTH) {
        throw new FixtureError('The source fixture size is unsupported');
    }
    const mkvextractPath = await resolveTool('mkvextract', configuration.mkvToolNixDirectory);
    const mkvmergePath = await resolveTool('mkvmerge', configuration.mkvToolNixDirectory);
    const sourceIdentification = await identifyMatroska(mkvmergePath, configuration.inputPath);
    const sourceTrackID = requireSingleHEVCVideoTrack(sourceIdentification);
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'webgpu-dovi-separate-'));
    const resolvedTemporaryDirectory = resolve(temporaryDirectory);
    if (dirname(resolvedTemporaryDirectory) !== resolve(tmpdir())) {
        throw new FixtureError('Refusing to use an unexpected temporary directory');
    }
    try {
        const interleavedPath = join(temporaryDirectory, 'interleaved.hevc');
        const baseLayerPath = join(temporaryDirectory, 'base-layer.hevc');
        const enhancementLayerPath = join(temporaryDirectory, 'enhancement-layer.hevc');
        await executeTool(mkvextractPath, [
            'tracks',
            configuration.inputPath,
            `${sourceTrackID}:${interleavedPath}`
        ]);
        const split = splitInterleavedDolbyVisionAnnexB(await readFile(interleavedPath));
        await writeFile(baseLayerPath, repeatAccessUnit(split.baseLayerData));
        await writeFile(
            enhancementLayerPath,
            repeatAccessUnit(split.enhancementLayerData)
        );
        await executeTool(mkvmergePath, [
            '--output', configuration.outputPath,
            '--deterministic', DETERMINISTIC_MUX_SEED,
            '--no-date',
            '--disable-track-statistics-tags',
            '--default-duration', '0:24000/1001p',
            baseLayerPath,
            '--default-duration', '0:24000/1001p',
            enhancementLayerPath
        ]);
        const outputData = await readFile(configuration.outputPath);
        if (outputData.indexOf(DOLBY_VISION_CONFIGURATION_MARKER) < 0) {
            throw new FixtureError('The separate enhancement track has no dvcC mapping');
        }
        return {
            baseLayerAccessUnitByteLength: split.baseLayerData.byteLength,
            byteLength: outputData.byteLength,
            enhancementLayerAccessUnitByteLength: split.enhancementLayerData.byteLength,
            enhancementWrapperCount: split.enhancementWrapperCount,
            outputPath: configuration.outputPath,
            repeatedAccessUnitCount: MINIMUM_REPEATED_ACCESS_UNIT_COUNT,
            rpuCount: split.rpuCount,
            sha256: createHash('sha256').update(outputData).digest('hex')
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
