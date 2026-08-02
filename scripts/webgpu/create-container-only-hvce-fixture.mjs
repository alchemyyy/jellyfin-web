import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEVC_FILLER_DATA_NAL_UNIT_TYPE = 38;
const HEVC_PARAMETER_SET_NAL_UNIT_TYPES = new Set([ 32, 33, 34 ]);
const HVCE_BLOCK_ADD_ID_TYPE_BYTES = Buffer.from([ 0x68, 0x76, 0x63, 0x45 ]);
const MAXIMUM_FIXTURE_BYTE_LENGTH = 64 * 1_024 * 1_024;
const MINIMUM_WRAPPED_NAL_UNIT_BYTE_LENGTH = 4;

const USAGE = `Usage:
  node scripts/webgpu/create-container-only-hvce-fixture.mjs <input.mkv> <output.mkv>

Creates a validation-only Matroska copy whose wrapped enhancement-layer
VPS/SPS/PPS NAL units are replaced by same-size filler NAL units. The copy can
decode its enhancement layer only when the player reads the retained container
hvcE configuration.`;

class FixtureError extends Error {
    constructor(message) {
        super(message);
        this.name = 'FixtureError';
    }
}

function readUint32BE(data, offset) {
    return (
        (data[offset] * 0x1_00_00_00)
        + (data[offset + 1] * 0x1_00_00)
        + (data[offset + 2] * 0x1_00)
        + data[offset + 3]
    );
}

function getHEVCNALUnitType(firstHeaderByte) {
    return (firstHeaderByte >> 1) & 0x3F;
}

function findWrappedEnhancementParameterSets(data) {
    const candidates = [];
    for (
        let outerHeaderOffset = 4;
        outerHeaderOffset + MINIMUM_WRAPPED_NAL_UNIT_BYTE_LENGTH <= data.byteLength;
        outerHeaderOffset += 1
    ) {
        if (getHEVCNALUnitType(data[outerHeaderOffset]) !== 63) {
            continue;
        }
        const innerHeaderOffset = outerHeaderOffset + 2;
        const innerNALUnitType = getHEVCNALUnitType(data[innerHeaderOffset]);
        if (!HEVC_PARAMETER_SET_NAL_UNIT_TYPES.has(innerNALUnitType)) {
            continue;
        }
        const declaredByteLength = readUint32BE(data, outerHeaderOffset - 4);
        if (
            declaredByteLength < MINIMUM_WRAPPED_NAL_UNIT_BYTE_LENGTH
            || outerHeaderOffset + declaredByteLength > data.byteLength
        ) {
            continue;
        }
        candidates.push({
            byteLength: declaredByteLength - 2,
            innerHeaderOffset,
            nalUnitType: innerNALUnitType
        });
    }
    return candidates;
}

function requireOneParameterSetOfEachType(candidates) {
    for (const nalUnitType of HEVC_PARAMETER_SET_NAL_UNIT_TYPES) {
        const matchingCandidates = candidates.filter(candidate => (
            candidate.nalUnitType === nalUnitType
        ));
        if (matchingCandidates.length !== 1) {
            throw new FixtureError(
                `Expected one wrapped EL NAL type ${nalUnitType}, found ${matchingCandidates.length}`
            );
        }
    }
    if (candidates.length !== HEVC_PARAMETER_SET_NAL_UNIT_TYPES.size) {
        throw new FixtureError('The fixture has unexpected wrapped EL parameter-set copies');
    }
}

function replaceWithFillerData(data, candidate) {
    const startOffset = candidate.innerHeaderOffset;
    const endOffset = startOffset + candidate.byteLength;
    data[startOffset] = (
        (data[startOffset] & 0x81)
        | (HEVC_FILLER_DATA_NAL_UNIT_TYPE << 1)
    );
    data.fill(0xFF, startOffset + 2, endOffset);
    data[endOffset - 1] = 0x80;
}

function parseArguments(argumentsList) {
    if (argumentsList.includes('--help')) {
        return { help: true };
    }
    if (argumentsList.length !== 2) {
        throw new FixtureError('Expected an input and output path');
    }
    const inputPath = resolve(argumentsList[0]);
    const outputPath = resolve(argumentsList[1]);
    if (inputPath === outputPath) {
        throw new FixtureError('The output path must differ from the input path');
    }
    return { help: false, inputPath, outputPath };
}

/** Creates a same-size fixture that requires container hvcE for EL decode. */
export function createContainerOnlyHVCEFixture(sourceData) {
    const data = Buffer.from(sourceData);
    if (data.byteLength === 0 || data.byteLength > MAXIMUM_FIXTURE_BYTE_LENGTH) {
        throw new FixtureError('The source fixture size is unsupported');
    }
    if (data.indexOf(HVCE_BLOCK_ADD_ID_TYPE_BYTES) < 0) {
        throw new FixtureError('The source fixture has no Matroska hvcE mapping');
    }
    const candidates = findWrappedEnhancementParameterSets(data);
    requireOneParameterSetOfEachType(candidates);
    for (const candidate of candidates) {
        replaceWithFillerData(data, candidate);
    }
    if (findWrappedEnhancementParameterSets(data).length !== 0) {
        throw new FixtureError('The transformed fixture still has wrapped EL parameter sets');
    }
    return {
        data,
        replacedNALUnitTypes: candidates.map(candidate => candidate.nalUnitType)
    };
}

async function main() {
    const configuration = parseArguments(process.argv.slice(2));
    if (configuration.help) {
        console.log(USAGE);
        return;
    }
    const sourceData = await readFile(configuration.inputPath);
    const fixture = createContainerOnlyHVCEFixture(sourceData);
    await writeFile(configuration.outputPath, fixture.data);
    console.log(JSON.stringify({
        byteLength: fixture.data.byteLength,
        outputPath: configuration.outputPath,
        replacedNALUnitTypes: fixture.replacedNALUnitTypes,
        sha256: createHash('sha256').update(fixture.data).digest('hex')
    }, null, 2));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
    main().catch(error => {
        console.error(error instanceof Error ? error.message : String(error));
        console.error(USAGE);
        process.exitCode = 1;
    });
}
