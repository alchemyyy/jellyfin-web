import {
    type DecoderOptions,
    type HEVCFrame,
    type HEVCStreamInfo
} from '@hevcjs/core';
import {
    CustomVideoDecoder,
    type EncodedPacket,
    registerDecoder,
    VideoSample,
    type VideoCodec
} from 'mediabunny';

import {
    createHEVCDecoderBackend,
    type HEVCDecoderBackend
} from './HEVCDecoderBackend';
import {
    parseHEVCSPS,
    type HEVCSPSColorSpace,
    type HEVCSPSConfiguration
} from './HEVCSPSParser';
import { microsecondsToSeconds, type Microseconds } from '../MediaTime';
import { requireMicroseconds } from './TimeMath';

const ANNEX_B_START_CODE = new Uint8Array([ 0, 0, 0, 1 ]);
const HEVC_DECODER_GLUE_ASSET = 'libraries/hevcjs/hevc-decode.js';
const HEVC_DECODER_WASM_ASSET = 'libraries/hevcjs/hevc-decode.wasm';
const HEVC_MAIN_PROFILE_IDC = 1;
const HEVC_MAIN_10_PROFILE_IDC = 2;
const HEVC_VPS_NAL_UNIT_TYPE = 32;
const HEVC_SPS_NAL_UNIT_TYPE = 33;
const HEVC_PPS_NAL_UNIT_TYPE = 34;
const MAXIMUM_COMPRESSED_PACKET_BYTE_LENGTH = 64 * 1024 * 1024;
const MAXIMUM_DECODER_DESCRIPTION_BYTE_LENGTH = 1024 * 1024;
const MAXIMUM_HEVC_CODED_HEIGHT = 2_160;
const MAXIMUM_HEVC_CODED_WIDTH = 3_840;
const MAXIMUM_DECODED_FRAME_BYTE_LENGTH = (
    MAXIMUM_HEVC_CODED_WIDTH * MAXIMUM_HEVC_CODED_HEIGHT
    + (2 * Math.ceil(MAXIMUM_HEVC_CODED_WIDTH / 2) * Math.ceil(MAXIMUM_HEVC_CODED_HEIGHT / 2))
) * Uint16Array.BYTES_PER_ELEMENT;
export const MAXIMUM_HEVC_PENDING_PICTURE_COUNT = 64;

type HEVCTiming = {
    durationMicroseconds: Microseconds
    sequenceNumber: number
    timestampMicroseconds: Microseconds
};

export type HEVCSoftwareVideoDecoderDependencies = {
    createDecoder: (options: DecoderOptions) => Promise<HEVCDecoderBackend>
    loadDecoderGlue: (url: string) => void
    resolveAssetURL: (path: string) => string
};

export type HEVCDecoderConfiguration = {
    bitDepth: 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15
    chromaFormat: number
    lengthSize: 1 | 2 | 3 | 4
    parameterSetsAnnexB: Uint8Array
    profileIDC: number
    sequenceParameterSets: readonly Uint8Array[]
};

export type AnnexBPacket = {
    data: Uint8Array
    hasVCLNALUnit: boolean
};

type ClassicWorkerGlobal = typeof globalThis & {
    HEVCDecoderModule?: unknown
    importScripts?: (...urls: string[]) => void
    location?: { href?: unknown }
};

type HEVCSoftwareVideoDecoderLifecycle = {
    claimed: boolean
    promise: Promise<void>
    resolve: () => void
};

type MutableHEVCSoftwareVideoDecoderContract = {
    codec: VideoCodec
    config: VideoDecoderConfig
    onError: (error: unknown) => undefined
    onSample: (sample: VideoSample) => unknown
};

export type OwnedHEVCSoftwareVideoDecoderCallbacks = {
    onError: (error: unknown) => void
    onSample: (sample: VideoSample) => unknown
};

let softwareDecoderRegistered = false;
const pendingSoftwareDecoderLifecycles: HEVCSoftwareVideoDecoderLifecycle[] = [];
const softwareDecoderShutdownPromises = new Set<Promise<void>>();

function createSoftwareDecoderLifecycle(): HEVCSoftwareVideoDecoderLifecycle {
    let resolveLifecycle!: () => void;
    const promise = new Promise<void>((resolve): void => {
        resolveLifecycle = resolve;
    });
    return {
        claimed: false,
        promise,
        resolve: resolveLifecycle
    };
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function toUint8Array(data: AllowSharedBufferSource): Uint8Array {
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    throw new TypeError('The HEVC decoder description is not a buffer source');
}

function getNALUnitType(data: Uint8Array, offset: number): number {
    if (offset < 0 || offset + 1 >= data.byteLength) {
        throw new TypeError('An HEVC NAL unit is missing its two-byte header');
    }

    return (data[offset] >> 1) & 0x3F;
}

function appendAnnexBNALUnit(output: Uint8Array, offset: number, nalUnit: Uint8Array): number {
    output.set(ANNEX_B_START_CODE, offset);
    output.set(nalUnit, offset + ANNEX_B_START_CODE.byteLength);
    return offset + ANNEX_B_START_CODE.byteLength + nalUnit.byteLength;
}

function parseHVCCNALArrays(
    description: Uint8Array,
    arrayCount: number
): Uint8Array[] {
    const parameterSets: Uint8Array[] = [];
    let offset = 23;
    for (let arrayIndex = 0; arrayIndex < arrayCount; arrayIndex += 1) {
        if (offset + 3 > description.byteLength) {
            throw new TypeError('The HEVC decoder description ends inside a NAL array header');
        }
        const declaredNALUnitType = description[offset] & 0x3F;
        const nalUnitCount = (description[offset + 1] * 256) + description[offset + 2];
        offset += 3;

        for (let nalUnitIndex = 0; nalUnitIndex < nalUnitCount; nalUnitIndex += 1) {
            if (offset + 2 > description.byteLength) {
                throw new TypeError('The HEVC decoder description ends before a NAL unit length');
            }
            const nalUnitByteLength = (description[offset] * 256) + description[offset + 1];
            offset += 2;
            if (nalUnitByteLength < 2 || offset + nalUnitByteLength > description.byteLength) {
                throw new TypeError('The HEVC decoder description contains an invalid NAL unit');
            }

            const nalUnit = description.subarray(offset, offset + nalUnitByteLength);
            if (getNALUnitType(nalUnit, 0) !== declaredNALUnitType) {
                throw new TypeError('The HEVC decoder description NAL unit type does not match its array');
            }
            parameterSets.push(nalUnit);
            offset += nalUnitByteLength;
        }
    }

    if (offset !== description.byteLength) {
        throw new TypeError('The HEVC decoder description contains trailing bytes');
    }
    return parameterSets;
}

/** Parses one ISO/IEC 14496-15 HEVCDecoderConfigurationRecord. */
export function parseHEVCDecoderConfiguration(
    descriptionSource: AllowSharedBufferSource
): HEVCDecoderConfiguration {
    const description = toUint8Array(descriptionSource);
    if (
        description.byteLength < 23
        || description.byteLength > MAXIMUM_DECODER_DESCRIPTION_BYTE_LENGTH
        || description[0] !== 1
    ) {
        throw new TypeError('The HEVC decoder description is not a supported HVCC record');
    }

    const profileIDC = description[1] & 0x1F;
    const chromaFormat = description[16] & 0x03;
    const bitDepthValue = 8 + (description[17] & 0x07);
    const chromaBitDepthValue = 8 + (description[18] & 0x07);
    if (bitDepthValue < 8 || bitDepthValue > 15) {
        throw new TypeError('The HEVC decoder description has an invalid bit depth');
    }
    if (chromaBitDepthValue !== bitDepthValue) {
        throw new TypeError('The HEVC decoder description uses mismatched plane bit depths');
    }
    const bitDepth = bitDepthValue as HEVCDecoderConfiguration['bitDepth'];
    const lengthSize = ((description[21] & 0x03) + 1) as 1 | 2 | 3 | 4;
    const arrayCount = description[22];
    const parameterSets = parseHVCCNALArrays(description, arrayCount);
    let parameterSetByteLength = 0;
    for (const parameterSet of parameterSets) {
        parameterSetByteLength += ANNEX_B_START_CODE.byteLength + parameterSet.byteLength;
    }

    const parameterSetsAnnexB = new Uint8Array(parameterSetByteLength);
    let parameterSetOffset = 0;
    for (const parameterSet of parameterSets) {
        parameterSetOffset = appendAnnexBNALUnit(
            parameterSetsAnnexB,
            parameterSetOffset,
            parameterSet
        );
    }

    return {
        bitDepth,
        chromaFormat,
        lengthSize,
        parameterSetsAnnexB,
        profileIDC,
        sequenceParameterSets: parameterSets
            .filter((parameterSet: Uint8Array): boolean => (
                getNALUnitType(parameterSet, 0) === HEVC_SPS_NAL_UNIT_TYPE
            ))
            .map((parameterSet: Uint8Array): Uint8Array => parameterSet.slice())
    };
}

function readLengthPrefix(data: Uint8Array, offset: number, lengthSize: number): number {
    let nalUnitByteLength = 0;
    for (let byteIndex = 0; byteIndex < lengthSize; byteIndex += 1) {
        nalUnitByteLength = (nalUnitByteLength * 256) + data[offset + byteIndex];
    }
    return nalUnitByteLength;
}

/** Converts one HVCC length-prefixed access unit to a bounded Annex B packet. */
export function convertHVCCPacketToAnnexB(
    packetData: Uint8Array,
    lengthSize: 1 | 2 | 3 | 4
): AnnexBPacket {
    if (
        packetData.byteLength === 0
        || packetData.byteLength > MAXIMUM_COMPRESSED_PACKET_BYTE_LENGTH
    ) {
        throw new TypeError('The HEVC packet size is unsupported');
    }

    const nalUnits: Uint8Array[] = [];
    let outputByteLength = 0;
    let hasVCLNALUnit = false;
    let offset = 0;
    while (offset < packetData.byteLength) {
        if (offset + lengthSize > packetData.byteLength) {
            throw new TypeError('The HEVC packet ends inside a NAL unit length');
        }
        const nalUnitByteLength = readLengthPrefix(packetData, offset, lengthSize);
        offset += lengthSize;
        if (nalUnitByteLength < 2 || offset + nalUnitByteLength > packetData.byteLength) {
            throw new TypeError('The HEVC packet contains an invalid NAL unit length');
        }

        const nalUnit = packetData.subarray(offset, offset + nalUnitByteLength);
        hasVCLNALUnit ||= getNALUnitType(nalUnit, 0) <= 31;
        nalUnits.push(nalUnit);
        outputByteLength += ANNEX_B_START_CODE.byteLength + nalUnit.byteLength;
        if (
            !Number.isSafeInteger(outputByteLength)
            || outputByteLength > MAXIMUM_COMPRESSED_PACKET_BYTE_LENGTH
        ) {
            throw new TypeError('The converted HEVC packet exceeds its size bound');
        }
        offset += nalUnitByteLength;
    }

    const output = new Uint8Array(outputByteLength);
    let outputOffset = 0;
    for (const nalUnit of nalUnits) {
        outputOffset = appendAnnexBNALUnit(output, outputOffset, nalUnit);
    }
    return { data: output, hasVCLNALUnit };
}

function findAnnexBStartCode(
    data: Uint8Array,
    startOffset: number
): { byteLength: 3 | 4; offset: number } | null {
    for (let offset = startOffset; offset + 3 <= data.byteLength; offset += 1) {
        if (data[offset] !== 0 || data[offset + 1] !== 0) {
            continue;
        }
        if (data[offset + 2] === 1) {
            return { byteLength: 3, offset };
        }
        if (offset + 4 <= data.byteLength && data[offset + 2] === 0 && data[offset + 3] === 1) {
            return { byteLength: 4, offset };
        }
    }
    return null;
}

/** Validates an Annex B access unit and reports whether it contains coded picture data. */
export function inspectAnnexBPacket(packetData: Uint8Array): AnnexBPacket {
    if (
        packetData.byteLength === 0
        || packetData.byteLength > MAXIMUM_COMPRESSED_PACKET_BYTE_LENGTH
    ) {
        throw new TypeError('The HEVC packet size is unsupported');
    }

    let startCode = findAnnexBStartCode(packetData, 0);
    if (!startCode) {
        throw new TypeError('The HEVC packet is neither Annex B nor HVCC length-prefixed data');
    }
    for (let prefixIndex = 0; prefixIndex < startCode.offset; prefixIndex += 1) {
        if (packetData[prefixIndex] !== 0) {
            throw new TypeError('The HEVC Annex B packet has data before its first start code');
        }
    }

    let hasVCLNALUnit = false;
    while (startCode) {
        const nalUnitOffset = startCode.offset + startCode.byteLength;
        const nextStartCode = findAnnexBStartCode(packetData, nalUnitOffset);
        const nalUnitEnd = nextStartCode?.offset ?? packetData.byteLength;
        if (nalUnitEnd - nalUnitOffset < 2) {
            throw new TypeError('The HEVC Annex B packet contains an empty NAL unit');
        }
        hasVCLNALUnit ||= getNALUnitType(packetData, nalUnitOffset) <= 31;
        startCode = nextStartCode;
    }

    return { data: packetData, hasVCLNALUnit };
}

function getProfileIDCFromCodecString(codecString: string): number | null {
    const match = /^(?:hev1|hvc1)\.(?:[ABC])?(\d+)(?:\.|$)/i.exec(codecString);
    if (!match) {
        return null;
    }
    const profileIDC = Number(match[1]);
    return Number.isSafeInteger(profileIDC) ? profileIDC : null;
}

function getHEVCSampleEntry(codecString: string): 'hev1' | 'hvc1' | null {
    const match = /^(hev1|hvc1)(?:\.|$)/i.exec(codecString);
    if (!match) {
        return null;
    }
    return match[1].toLowerCase() as 'hev1' | 'hvc1';
}

function getConfigurationProfileIDC(config: VideoDecoderConfig): number | null {
    if (config.description !== undefined) {
        try {
            return parseHEVCDecoderConfiguration(config.description).profileIDC;
        } catch {
            return null;
        }
    }
    return getProfileIDCFromCodecString(config.codec);
}

function normalizeTransfer(value: unknown): HEVCSPSColorSpace['transfer'] | null {
    switch (String(value)) {
        case 'bt709':
            return 'bt709';
        case 'arib-std-b67':
        case 'hlg':
            return 'hlg';
        case 'pq':
        case 'smpte2084':
            return 'pq';
        default:
            return null;
    }
}

function configuredColorSpaceContradictsSPS(
    configuredColorSpace: VideoColorSpaceInit | undefined,
    spsColorSpace: HEVCSPSColorSpace
): boolean {
    if (!configuredColorSpace) {
        return false;
    }
    return (configuredColorSpace.fullRange != null
            && configuredColorSpace.fullRange !== spsColorSpace.fullRange)
        || (configuredColorSpace.matrix != null
            && String(configuredColorSpace.matrix) !== spsColorSpace.matrix)
        || (configuredColorSpace.primaries != null
            && String(configuredColorSpace.primaries) !== spsColorSpace.primaries)
        || (configuredColorSpace.transfer != null
            && normalizeTransfer(configuredColorSpace.transfer) !== spsColorSpace.transfer);
}

function spsConfigurationsMatch(
    first: HEVCSPSConfiguration,
    second: HEVCSPSConfiguration
): boolean {
    return first.bitDepth === second.bitDepth
        && first.chromaFormat === second.chromaFormat
        && first.codedHeight === second.codedHeight
        && first.codedWidth === second.codedWidth
        && first.displayHeight === second.displayHeight
        && first.displayWidth === second.displayWidth
        && first.levelIDC === second.levelIDC
        && first.maximumDPBPictureCount === second.maximumDPBPictureCount
        && first.profileIDC === second.profileIDC
        && first.colorSpace.fullRange === second.colorSpace.fullRange
        && first.colorSpace.matrix === second.colorSpace.matrix
        && first.colorSpace.primaries === second.colorSpace.primaries
        && first.colorSpace.transfer === second.colorSpace.transfer;
}

function parseConsistentSPSConfiguration(
    sequenceParameterSets: readonly Uint8Array[]
): HEVCSPSConfiguration {
    if (sequenceParameterSets.length === 0) {
        throw new TypeError('The HEVC decoder configuration has no sequence parameter set');
    }
    const configuration = parseHEVCSPS(sequenceParameterSets[0]);
    for (let spsIndex = 1; spsIndex < sequenceParameterSets.length; spsIndex += 1) {
        const nextConfiguration = parseHEVCSPS(sequenceParameterSets[spsIndex]);
        if (!spsConfigurationsMatch(configuration, nextConfiguration)) {
            throw new TypeError('The HEVC sequence parameter sets are contradictory');
        }
    }
    return configuration;
}

function validateSPSAgainstDecoderConfiguration(
    spsConfiguration: HEVCSPSConfiguration,
    decoderConfiguration: HEVCDecoderConfiguration,
    config: VideoDecoderConfig
): void {
    validateSPSDimensionsAgainstConfig(spsConfiguration, config);
    if (
        spsConfiguration.profileIDC !== decoderConfiguration.profileIDC
        || spsConfiguration.bitDepth !== decoderConfiguration.bitDepth
        || spsConfiguration.chromaFormat !== decoderConfiguration.chromaFormat
        || configuredColorSpaceContradictsSPS(config.colorSpace, spsConfiguration.colorSpace)
    ) {
        throw new TypeError('The HEVC SPS contradicts the decoder configuration');
    }
}

function hasSupportedConfiguredDimensions(config: VideoDecoderConfig): boolean {
    return config.codedWidth !== undefined
        && config.codedHeight !== undefined
        && isPositiveSafeInteger(config.codedWidth)
        && isPositiveSafeInteger(config.codedHeight)
        && config.codedWidth <= MAXIMUM_HEVC_CODED_WIDTH
        && config.codedHeight <= MAXIMUM_HEVC_CODED_HEIGHT;
}

function validateSPSDimensionsAgainstConfig(
    spsConfiguration: HEVCSPSConfiguration,
    config: VideoDecoderConfig
): void {
    if (
        !hasSupportedConfiguredDimensions(config)
        || spsConfiguration.codedWidth > MAXIMUM_HEVC_CODED_WIDTH
        || spsConfiguration.codedHeight > MAXIMUM_HEVC_CODED_HEIGHT
        || spsConfiguration.codedWidth !== config.codedWidth
        || spsConfiguration.codedHeight !== config.codedHeight
        || spsConfiguration.displayWidth > config.codedWidth
        || spsConfiguration.displayHeight > config.codedHeight
    ) {
        throw new TypeError('The HEVC SPS dimensions contradict the bounded decoder configuration');
    }
}

function supportsHEVCConfiguration(codec: VideoCodec, config: VideoDecoderConfig): boolean {
    if (
        codec !== 'hevc'
        || config.hardwareAcceleration === 'prefer-hardware'
        || !hasSupportedConfiguredDimensions(config)
    ) {
        return false;
    }
    const sampleEntry = getHEVCSampleEntry(config.codec);
    if (!sampleEntry) {
        return false;
    }
    const profileIDC = getConfigurationProfileIDC(config);
    if (profileIDC !== HEVC_MAIN_PROFILE_IDC && profileIDC !== HEVC_MAIN_10_PROFILE_IDC) {
        return false;
    }

    if (config.description === undefined) {
        return sampleEntry === 'hev1';
    }
    try {
        const decoderConfiguration = parseHEVCDecoderConfiguration(config.description);
        const codecProfileIDC = getProfileIDCFromCodecString(config.codec);
        if (decoderConfiguration.sequenceParameterSets.length > 0) {
            const spsConfiguration = parseConsistentSPSConfiguration(
                decoderConfiguration.sequenceParameterSets
            );
            validateSPSAgainstDecoderConfiguration(spsConfiguration, decoderConfiguration, config);
        } else if (sampleEntry === 'hvc1') {
            return false;
        }
        return decoderConfiguration.chromaFormat === 1
            && decoderConfiguration.bitDepth <= 10
            && (sampleEntry !== 'hvc1' || hasRequiredHEVCParameterSets(config.description))
            && (codecProfileIDC === null || codecProfileIDC === decoderConfiguration.profileIDC);
    } catch {
        return false;
    }
}

function resolveDefaultAssetURL(path: string): string {
    const workerGlobal = globalThis as ClassicWorkerGlobal;
    const locationHref = workerGlobal.location?.href;
    if (typeof locationHref !== 'string' || !locationHref) {
        return path;
    }
    return new URL(path, locationHref).href;
}

function loadDefaultDecoderGlue(url: string): void {
    const workerGlobal = globalThis as ClassicWorkerGlobal;
    if (typeof workerGlobal.HEVCDecoderModule === 'function') {
        return;
    }
    if (typeof workerGlobal.importScripts !== 'function') {
        throw new Error('The HEVC software decoder requires a classic Web Worker');
    }

    workerGlobal.importScripts(url);
    if (typeof workerGlobal.HEVCDecoderModule !== 'function') {
        throw new Error('The HEVC software decoder glue did not expose its module factory');
    }
}

const DEFAULT_DEPENDENCIES: HEVCSoftwareVideoDecoderDependencies = {
    createDecoder: createHEVCDecoderBackend,
    loadDecoderGlue: loadDefaultDecoderGlue,
    resolveAssetURL: resolveDefaultAssetURL
};

function insertTiming(timings: HEVCTiming[], timing: HEVCTiming): void {
    let insertionIndex = timings.length;
    for (let timingIndex = 0; timingIndex < timings.length; timingIndex += 1) {
        const queuedTiming = timings[timingIndex];
        if (
            queuedTiming.timestampMicroseconds > timing.timestampMicroseconds
            || (
                queuedTiming.timestampMicroseconds === timing.timestampMicroseconds
                && queuedTiming.sequenceNumber >= 0
                && timing.sequenceNumber >= 0
                && queuedTiming.sequenceNumber > timing.sequenceNumber
            )
        ) {
            insertionIndex = timingIndex;
            break;
        }
    }
    timings.splice(insertionIndex, 0, timing);
}

function checkedPlaneSampleCount(width: number, height: number, label: string): number {
    if (!isPositiveSafeInteger(width) || !isPositiveSafeInteger(height)) {
        throw new TypeError(`The decoded HEVC ${label} plane dimensions are invalid`);
    }
    const sampleCount = width * height;
    if (!Number.isSafeInteger(sampleCount) || sampleCount <= 0) {
        throw new TypeError(`The decoded HEVC ${label} plane is too large`);
    }
    return sampleCount;
}

function getDisplayDimensions(
    config: VideoDecoderConfig,
    codedWidth: number,
    codedHeight: number
): { displayHeight: number; displayWidth: number } {
    const displayWidth = config.displayAspectWidth;
    const displayHeight = config.displayAspectHeight;
    if (
        displayWidth !== undefined
        && displayHeight !== undefined
        && isPositiveSafeInteger(displayWidth)
        && isPositiveSafeInteger(displayHeight)
    ) {
        return { displayHeight, displayWidth };
    }
    return { displayHeight: codedHeight, displayWidth: codedWidth };
}

function getAnnexBSequenceParameterSets(packetData: Uint8Array): Uint8Array[] {
    const sequenceParameterSets: Uint8Array[] = [];
    let startCode = findAnnexBStartCode(packetData, 0);
    while (startCode) {
        const nalUnitOffset = startCode.offset + startCode.byteLength;
        const nextStartCode = findAnnexBStartCode(packetData, nalUnitOffset);
        const nalUnitEnd = nextStartCode?.offset ?? packetData.byteLength;
        if (getNALUnitType(packetData, nalUnitOffset) === HEVC_SPS_NAL_UNIT_TYPE) {
            sequenceParameterSets.push(packetData.subarray(nalUnitOffset, nalUnitEnd));
        }
        startCode = nextStartCode;
    }
    return sequenceParameterSets;
}

function validateDecodedFrameAgainstSPS(
    frame: HEVCFrame,
    spsConfiguration: HEVCSPSConfiguration
): void {
    if (
        frame.width !== spsConfiguration.codedWidth
        || frame.height !== spsConfiguration.codedHeight
        || frame.bitDepth !== spsConfiguration.bitDepth
    ) {
        throw new TypeError('The HEVC software decoder output contradicts the active SPS');
    }
}

function validateStreamInfoAgainstSPS(
    streamInfo: HEVCStreamInfo | null,
    spsConfiguration: HEVCSPSConfiguration,
    configuredProfileIDC: number | null
): void {
    if (!streamInfo) {
        return;
    }
    if (streamInfo.chromaFormat !== 1) {
        throw new TypeError('The HEVC software decoder output is not 4:2:0');
    }
    if (
        streamInfo.width !== spsConfiguration.codedWidth
        || streamInfo.height !== spsConfiguration.codedHeight
        || streamInfo.bitDepth !== spsConfiguration.bitDepth
    ) {
        throw new TypeError('The HEVC software decoder output contradicts the active SPS');
    }
    if (
        streamInfo.profile !== 0
        && streamInfo.profile !== configuredProfileIDC
    ) {
        throw new TypeError('The HEVC software decoder output profile is inconsistent');
    }
}

function getValidatedFrameSampleCounts(frame: HEVCFrame): {
    chromaSampleCount: number
    lumaSampleCount: number
} {
    const lumaSampleCount = checkedPlaneSampleCount(frame.width, frame.height, 'luma');
    const expectedChromaWidth = Math.ceil(frame.width / 2);
    const expectedChromaHeight = Math.ceil(frame.height / 2);
    if (
        frame.chromaWidth !== expectedChromaWidth
        || frame.chromaHeight !== expectedChromaHeight
    ) {
        throw new TypeError('The decoded HEVC chroma dimensions are not 4:2:0');
    }
    const chromaSampleCount = checkedPlaneSampleCount(
        frame.chromaWidth,
        frame.chromaHeight,
        'chroma'
    );
    if (
        frame.y.length !== lumaSampleCount
        || frame.cb.length !== chromaSampleCount
        || frame.cr.length !== chromaSampleCount
    ) {
        throw new TypeError('The decoded HEVC plane lengths do not match their dimensions');
    }
    return { chromaSampleCount, lumaSampleCount };
}

/** Mediabunny decoder adapter for @hevcjs/core Main and Main10 planar output. */
export default class HEVCSoftwareVideoDecoder {
    public readonly codec!: VideoCodec;
    public readonly config!: VideoDecoderConfig;
    public readonly onError!: (error: unknown) => undefined;
    public readonly onSample!: (sample: VideoSample) => unknown;

    private closed = false;
    private decoder: HEVCDecoderBackend | null = null;
    private decoderConfiguration: HEVCDecoderConfiguration | null = null;
    private parameterSetsPending = true;
    private readonly pendingTimings: HEVCTiming[] = [];
    private readonly shutdownPromise: Promise<void>;
    private shutdownResolver: (() => void) | null = null;
    private spsConfiguration: HEVCSPSConfiguration | null = null;
    private streamInfo: HEVCStreamInfo | null = null;

    public constructor(
        private readonly dependencies: HEVCSoftwareVideoDecoderDependencies = DEFAULT_DEPENDENCIES
    ) {
        const lifecycle = pendingSoftwareDecoderLifecycles.shift()
            ?? createSoftwareDecoderLifecycle();
        lifecycle.claimed = true;
        this.shutdownPromise = lifecycle.promise;
        this.shutdownResolver = lifecycle.resolve;
        softwareDecoderShutdownPromises.add(this.shutdownPromise);
    }

    /** Accepts only HEVC Main/Main10 4:2:0 configurations outside hardware-forced sinks. */
    public static supports(codec: VideoCodec, config: VideoDecoderConfig): boolean {
        return supportsHEVCConfiguration(codec, config);
    }

    /** Loads the single-threaded decoder module and creates one bounded decoder instance. */
    public async init(): Promise<void> {
        if (this.closed) {
            throw new Error('The HEVC software decoder is closed');
        }
        if (this.decoder) {
            throw new Error('The HEVC software decoder is already initialized');
        }
        if (!HEVCSoftwareVideoDecoder.supports(this.codec, this.config)) {
            throw new TypeError('The HEVC software decoder configuration is unsupported');
        }

        this.decoderConfiguration = this.config.description === undefined ?
            null :
            parseHEVCDecoderConfiguration(this.config.description);
        if (
            this.decoderConfiguration
            && this.decoderConfiguration.sequenceParameterSets.length > 0
        ) {
            const spsConfiguration = parseConsistentSPSConfiguration(
                this.decoderConfiguration.sequenceParameterSets
            );
            validateSPSAgainstDecoderConfiguration(
                spsConfiguration,
                this.decoderConfiguration,
                this.config
            );
            this.spsConfiguration = spsConfiguration;
        }
        const decoderGlueURL = this.dependencies.resolveAssetURL(HEVC_DECODER_GLUE_ASSET);
        const decoderWASMURL = this.dependencies.resolveAssetURL(HEVC_DECODER_WASM_ASSET);
        this.dependencies.loadDecoderGlue(decoderGlueURL);
        const decoder = await this.dependencies.createDecoder({
            wasmBinaryUrl: decoderWASMURL
        });
        if (this.closed) {
            decoder.destroy();
            return;
        }
        this.decoder = decoder;
    }

    /** Feeds one access unit and emits all newly displayable frames in presentation order. */
    public decode(packet: EncodedPacket): void {
        const decoder = this.requireDecoder();
        if (packet.isMetadataOnly) {
            throw new TypeError('The HEVC software decoder cannot decode metadata-only packets');
        }

        const annexBPacket = this.decoderConfiguration ?
            convertHVCCPacketToAnnexB(packet.data, this.decoderConfiguration.lengthSize) :
            inspectAnnexBPacket(packet.data);
        this.updateSPSConfiguration(getAnnexBSequenceParameterSets(annexBPacket.data));
        if (annexBPacket.hasVCLNALUnit && !this.spsConfiguration) {
            throw new TypeError('The HEVC access unit has coded data before a supported SPS VUI');
        }
        if (
            annexBPacket.hasVCLNALUnit
            && this.pendingTimings.length >= MAXIMUM_HEVC_PENDING_PICTURE_COUNT
        ) {
            throw new Error('The HEVC software decoder reorder window exceeded its bound');
        }
        let timing: HEVCTiming | null = null;
        if (annexBPacket.hasVCLNALUnit) {
            const durationMicroseconds = requireMicroseconds(
                packet.microsecondDuration,
                'HEVC packet duration'
            );
            if (durationMicroseconds < 0) {
                throw new RangeError('The HEVC packet duration must not be negative');
            }
            timing = {
                durationMicroseconds,
                sequenceNumber: packet.sequenceNumber,
                timestampMicroseconds: requireMicroseconds(
                    packet.microsecondTimestamp,
                    'HEVC packet timestamp'
                )
            };
        }

        if (
            this.parameterSetsPending
            && this.decoderConfiguration
            && this.decoderConfiguration.parameterSetsAnnexB.byteLength > 0
        ) {
            decoder.feed(this.decoderConfiguration.parameterSetsAnnexB);
        }
        this.parameterSetsPending = false;
        decoder.feed(annexBPacket.data);
        this.updateStreamInfo(decoder.info);
        if (timing) {
            insertTiming(this.pendingTimings, timing);
        }
        decoder.drain((frame: HEVCFrame): void => this.emitFrame(frame));
    }

    /** Flushes the DPB and rejects silent packet loss instead of shifting later timestamps. */
    public flush(): void {
        const decoder = this.requireDecoder();
        this.updateStreamInfo(decoder.info);
        decoder.flush((frame: HEVCFrame): void => this.emitFrame(frame));
        if (this.pendingTimings.length > 0) {
            throw new Error('The HEVC software decoder ended before every picture was output');
        }
        this.parameterSetsPending = true;
    }

    /** Releases the WASM decoder exactly once and discards queued packet metadata. */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        try {
            this.pendingTimings.length = 0;
            this.decoderConfiguration = null;
            this.spsConfiguration = null;
            this.streamInfo = null;
            const decoder = this.decoder;
            this.decoder = null;
            if (!decoder) {
                return;
            }

            try {
                decoder.destroy();
            } catch (error) {
                this.onError(error);
            }
        } finally {
            this.completeShutdown();
        }
    }

    private completeShutdown(): void {
        const shutdownResolver = this.shutdownResolver;
        if (!shutdownResolver) {
            return;
        }

        this.shutdownResolver = null;
        softwareDecoderShutdownPromises.delete(this.shutdownPromise);
        shutdownResolver();
    }

    private requireDecoder(): HEVCDecoderBackend {
        if (this.closed) {
            throw new Error('The HEVC software decoder is closed');
        }
        if (!this.decoder) {
            throw new Error('The HEVC software decoder is not initialized');
        }
        return this.decoder;
    }

    private emitFrame(frame: HEVCFrame): void {
        const timing = this.pendingTimings.shift();
        if (!timing) {
            throw new Error('The HEVC software decoder output a frame without packet timing');
        }

        const sample = this.createVideoSample(frame, timing);
        try {
            this.onSample(sample);
        } catch (error) {
            sample.close();
            throw error;
        }
    }

    private createVideoSample(frame: HEVCFrame, timing: HEVCTiming): VideoSample {
        this.requireDecoder();
        const streamInfo = this.streamInfo;
        const spsConfiguration = this.spsConfiguration;
        if (!spsConfiguration) {
            throw new TypeError('The decoded HEVC frame has no supported SPS VUI');
        }
        const configuredProfileIDC = this.decoderConfiguration?.profileIDC
            ?? getProfileIDCFromCodecString(this.config.codec);
        validateDecodedFrameAgainstSPS(frame, spsConfiguration);
        validateStreamInfoAgainstSPS(streamInfo, spsConfiguration, configuredProfileIDC);
        if (frame.bitDepth !== 8 && frame.bitDepth !== 10) {
            throw new TypeError('The HEVC software decoder output has an unsupported bit depth');
        }
        const { chromaSampleCount, lumaSampleCount } = getValidatedFrameSampleCounts(frame);

        const bytesPerSample = frame.bitDepth === 8 ? 1 : 2;
        const totalSampleCount = lumaSampleCount + (2 * chromaSampleCount);
        const frameByteLength = totalSampleCount * bytesPerSample;
        if (
            !Number.isSafeInteger(frameByteLength)
            || frameByteLength <= 0
            || frameByteLength > MAXIMUM_DECODED_FRAME_BYTE_LENGTH
        ) {
            throw new TypeError('The decoded HEVC frame exceeds its memory bound');
        }

        const sampleData = this.packFramePlanes(frame, totalSampleCount);
        const lumaByteLength = lumaSampleCount * bytesPerSample;
        const chromaByteLength = chromaSampleCount * bytesPerSample;
        const displayDimensions = getDisplayDimensions(this.config, frame.width, frame.height);
        return new VideoSample(sampleData, {
            codedHeight: frame.height,
            codedWidth: frame.width,
            colorSpace: spsConfiguration.colorSpace as unknown as VideoColorSpaceInit,
            displayHeight: displayDimensions.displayHeight,
            displayWidth: displayDimensions.displayWidth,
            duration: microsecondsToSeconds(timing.durationMicroseconds),
            format: frame.bitDepth === 8 ? 'I420' : 'I420P10',
            layout: [
                { offset: 0, stride: frame.width * bytesPerSample },
                { offset: lumaByteLength, stride: frame.chromaWidth * bytesPerSample },
                {
                    offset: lumaByteLength + chromaByteLength,
                    stride: frame.chromaWidth * bytesPerSample
                }
            ],
            timestamp: microsecondsToSeconds(timing.timestampMicroseconds)
        });
    }

    private packFramePlanes(frame: HEVCFrame, totalSampleCount: number): Uint8Array {
        if (frame.bitDepth === 8) {
            const packedData = new Uint8Array(totalSampleCount);
            packedData.set(frame.y, 0);
            packedData.set(frame.cb, frame.y.length);
            packedData.set(frame.cr, frame.y.length + frame.cb.length);
            return packedData;
        }

        const packedSamples = new Uint16Array(totalSampleCount);
        packedSamples.set(frame.y, 0);
        packedSamples.set(frame.cb, frame.y.length);
        packedSamples.set(frame.cr, frame.y.length + frame.cb.length);
        return new Uint8Array(packedSamples.buffer);
    }

    private updateStreamInfo(streamInfo: HEVCStreamInfo | null): void {
        if (streamInfo) {
            this.streamInfo = streamInfo;
        }
    }

    private updateSPSConfiguration(sequenceParameterSets: readonly Uint8Array[]): void {
        for (const sequenceParameterSet of sequenceParameterSets) {
            const nextConfiguration = parseHEVCSPS(sequenceParameterSet);
            if (this.decoderConfiguration) {
                validateSPSAgainstDecoderConfiguration(
                    nextConfiguration,
                    this.decoderConfiguration,
                    this.config
                );
            } else {
                validateSPSDimensionsAgainstConfig(nextConfiguration, this.config);
                const codecProfileIDC = getProfileIDCFromCodecString(this.config.codec);
                if (
                    codecProfileIDC !== nextConfiguration.profileIDC
                    || configuredColorSpaceContradictsSPS(
                        this.config.colorSpace,
                        nextConfiguration.colorSpace
                    )
                ) {
                    throw new TypeError('The in-band HEVC SPS contradicts the decoder configuration');
                }
            }
            if (
                this.spsConfiguration
                && !spsConfigurationsMatch(this.spsConfiguration, nextConfiguration)
            ) {
                throw new TypeError('The active HEVC sequence parameter sets are contradictory');
            }
            this.spsConfiguration = nextConfiguration;
        }
    }
}

/** Creates a directly owned decoder without Mediabunny's sample-sink wrapper. */
export function createOwnedHEVCSoftwareVideoDecoder(
    config: VideoDecoderConfig,
    callbacks: OwnedHEVCSoftwareVideoDecoderCallbacks,
    dependencies: HEVCSoftwareVideoDecoderDependencies = DEFAULT_DEPENDENCIES
): HEVCSoftwareVideoDecoder {
    const decoder = new HEVCSoftwareVideoDecoder(dependencies);
    const decoderContract = decoder as unknown as MutableHEVCSoftwareVideoDecoderContract;
    decoderContract.codec = 'hevc';
    decoderContract.config = config;
    decoderContract.onError = (error: unknown): undefined => {
        callbacks.onError(error);
        return undefined;
    };
    decoderContract.onSample = callbacks.onSample;
    return decoder;
}

/** Prevents a failed custom operation from poisoning Mediabunny's serialized close call. */
export class MediabunnyHEVCSoftwareVideoDecoder {
    public readonly codec!: VideoCodec;
    public readonly config!: VideoDecoderConfig;
    public readonly onError!: (error: unknown) => undefined;
    public readonly onSample!: (sample: VideoSample) => unknown;

    private closed = false;
    private readonly decoder: HEVCSoftwareVideoDecoder;
    private failed = false;
    private fatalErrorReported = false;

    public constructor(
        dependencies: HEVCSoftwareVideoDecoderDependencies = DEFAULT_DEPENDENCIES
    ) {
        this.decoder = new HEVCSoftwareVideoDecoder(dependencies);
    }

    /** Delegates exact capability checks to the strict decoder implementation. */
    public static supports(codec: VideoCodec, config: VideoDecoderConfig): boolean {
        return HEVCSoftwareVideoDecoder.supports(codec, config);
    }

    /** Initializes the delegate without rejecting Mediabunny's call serializer. */
    public async init(): Promise<void> {
        if (this.closed || this.failed) {
            return;
        }

        try {
            this.synchronizeDecoderContract();
            await this.decoder.init();
        } catch (error) {
            this.handleFatalError(error);
        }
    }

    /** Decodes one packet or latches the first fatal failure. */
    public decode(packet: EncodedPacket): void {
        if (this.closed || this.failed) {
            return;
        }

        try {
            this.decoder.decode(packet);
        } catch (error) {
            this.handleFatalError(error);
        }
    }

    /** Flushes remaining pictures without rejecting Mediabunny's call serializer. */
    public flush(): void {
        if (this.closed || this.failed) {
            return;
        }

        try {
            this.decoder.flush();
        } catch (error) {
            this.handleFatalError(error);
        }
    }

    /** Always completes the delegate lifecycle, including after an earlier fatal failure. */
    public close(): void {
        if (this.closed) {
            return;
        }

        this.closed = true;
        try {
            this.decoder.close();
        } catch (error) {
            this.handleFatalError(error);
        }
    }

    private synchronizeDecoderContract(): void {
        const decoderContract = this.decoder as unknown as MutableHEVCSoftwareVideoDecoderContract;
        decoderContract.codec = this.codec;
        decoderContract.config = this.config;
        decoderContract.onError = (error: unknown): undefined => {
            this.handleFatalError(error);
            return undefined;
        };
        decoderContract.onSample = (sample: VideoSample): unknown => this.onSample(sample);
    }

    private handleFatalError(error: unknown): void {
        this.failed = true;
        if (this.fatalErrorReported) {
            return;
        }

        this.fatalErrorReported = true;
        try {
            this.onError(error);
        } catch {
            // The adapter must keep Mediabunny's serializer fulfilled so close can run
        }
    }
}

// Preserve Mediabunny's runtime decoder contract without downleveling a native
// ES class constructor through this repository's ES5 TypeScript target
Object.setPrototypeOf(HEVCSoftwareVideoDecoder.prototype, CustomVideoDecoder.prototype);
Object.setPrototypeOf(MediabunnyHEVCSoftwareVideoDecoder.prototype, CustomVideoDecoder.prototype);

/** Arms one shutdown lease before Mediabunny starts asynchronous decoder creation. */
export function armHEVCSoftwareVideoDecoderLifecycle(): () => void {
    const lifecycle = createSoftwareDecoderLifecycle();
    pendingSoftwareDecoderLifecycles.push(lifecycle);
    softwareDecoderShutdownPromises.add(lifecycle.promise);

    return (): void => {
        if (lifecycle.claimed) {
            return;
        }

        lifecycle.claimed = true;
        const lifecycleIndex = pendingSoftwareDecoderLifecycles.indexOf(lifecycle);
        if (lifecycleIndex >= 0) {
            pendingSoftwareDecoderLifecycles.splice(lifecycleIndex, 1);
        }
        softwareDecoderShutdownPromises.delete(lifecycle.promise);
        lifecycle.resolve();
    };
}

/** Waits until every expected or constructed HEVC adapter completes its queued close call. */
export async function waitForHEVCSoftwareVideoDecoderShutdown(): Promise<void> {
    while (softwareDecoderShutdownPromises.size > 0) {
        const shutdownPromises: Array<Promise<void>> = [];
        shutdownPromises.push(...softwareDecoderShutdownPromises);
        await Promise.all(shutdownPromises);
    }
}

/** Registers the adapter once before Mediabunny probes a negotiated HEVC track. */
export function registerHEVCSoftwareVideoDecoder(): void {
    if (softwareDecoderRegistered) {
        return;
    }
    registerDecoder(MediabunnyHEVCSoftwareVideoDecoder);
    softwareDecoderRegistered = true;
}

/** Returns whether an HVCC record carries all random-access parameter-set classes. */
export function hasRequiredHEVCParameterSets(descriptionSource: AllowSharedBufferSource): boolean {
    const parameterSets = parseHEVCDecoderConfiguration(descriptionSource).parameterSetsAnnexB;
    const presentTypes = new Set<number>();
    let startCode = findAnnexBStartCode(parameterSets, 0);
    while (startCode) {
        const nalUnitOffset = startCode.offset + startCode.byteLength;
        presentTypes.add(getNALUnitType(parameterSets, nalUnitOffset));
        startCode = findAnnexBStartCode(parameterSets, nalUnitOffset + 2);
    }
    return presentTypes.has(HEVC_VPS_NAL_UNIT_TYPE)
        && presentTypes.has(HEVC_SPS_NAL_UNIT_TYPE)
        && presentTypes.has(HEVC_PPS_NAL_UNIT_TYPE);
}
