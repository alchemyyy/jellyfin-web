import type {
    DecoderOptions,
    HEVCFrame,
    HEVCStreamInfo
} from '@hevcjs/core';

import {
    createHEVCDecoderBackend,
    type HEVCDecoderBackend
} from './HEVCDecoderBackend';
import {
    HEVC_EXACT_CAPABILITY_MAXIMUM_DECODED_BYTE_LENGTH,
    HEVC_EXACT_CAPABILITY_MAXIMUM_TOTAL_DECODED_BYTE_LENGTH,
    HEVC_EXACT_CAPABILITY_MINIMUM_PLAYBACK_FRAMES_PER_SECOND,
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS,
    isHEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerResponse,
    type HEVCExactCapabilityWorkerTierRequest,
    type HEVCExactCapabilityWorkerTierResult
} from './HEVCExactCapabilityProtocol';

export type HEVCExactCapabilityWorkerRuntimeDependencies = Readonly<{
    createDecoder: (options: DecoderOptions) => Promise<HEVCDecoderBackend>
    fingerprintFrame: (frame: HEVCFrame) => number
    now: () => number
}>;

const DEFAULT_DEPENDENCIES: HEVCExactCapabilityWorkerRuntimeDependencies = Object.freeze({
    createDecoder: createHEVCDecoderBackend,
    fingerprintFrame: createFrameFingerprint,
    now: (): number => globalThis.performance.now()
});

const HEVC_ULTRA_HD_MAXIMUM_PROBE_ATTEMPT_COUNT = 3;

type AnnexBStartCode = Readonly<{
    byteLength: 3 | 4
    offset: number
}>;

type HEVCExactFixtureMetadata = Readonly<{
    levelIDC: number
    mainTier: boolean
    progressive: boolean
    profileIDC: 1 | 2
}>;

function findAnnexBStartCode(bytes: Uint8Array, startOffset: number): AnnexBStartCode | null {
    for (let byteOffset = startOffset; byteOffset + 3 <= bytes.byteLength; byteOffset += 1) {
        if (bytes[byteOffset] !== 0 || bytes[byteOffset + 1] !== 0) {
            continue;
        }
        if (bytes[byteOffset + 2] === 1) {
            return { byteLength: 3, offset: byteOffset };
        }
        if (byteOffset + 4 <= bytes.byteLength
            && bytes[byteOffset + 2] === 0
            && bytes[byteOffset + 3] === 1) {
            return { byteLength: 4, offset: byteOffset };
        }
    }
    return null;
}

function findFirstVCLNALUnitType(accessUnit: ArrayBuffer): number | null {
    const bytes = new Uint8Array(accessUnit);
    let startCode = findAnnexBStartCode(bytes, 0);
    while (startCode) {
        const nalUnitOffset = startCode.offset + startCode.byteLength;
        if (nalUnitOffset + 2 <= bytes.byteLength) {
            const nalUnitType = (bytes[nalUnitOffset] >> 1) & 0x3F;
            if (nalUnitType <= 31) {
                return nalUnitType;
            }
        }
        startCode = findAnnexBStartCode(bytes, nalUnitOffset + 2);
    }
    return null;
}

function createRBSP(nalUnit: Uint8Array): Uint8Array {
    const bytes: number[] = [];
    for (let byteIndex = 2; byteIndex < nalUnit.byteLength; byteIndex += 1) {
        if (
            nalUnit[byteIndex] === 3
            && byteIndex >= 4
            && nalUnit[byteIndex - 1] === 0
            && nalUnit[byteIndex - 2] === 0
        ) {
            continue;
        }
        bytes.push(nalUnit[byteIndex]);
    }
    return new Uint8Array(bytes);
}

function parseFixtureMetadata(accessUnit: ArrayBuffer): HEVCExactFixtureMetadata {
    const bytes = new Uint8Array(accessUnit);
    let startCode = findAnnexBStartCode(bytes, 0);
    while (startCode) {
        const nalUnitOffset = startCode.offset + startCode.byteLength;
        const nextStartCode = findAnnexBStartCode(bytes, nalUnitOffset);
        const nalUnitEnd = nextStartCode?.offset ?? bytes.byteLength;
        if (nalUnitOffset + 2 <= nalUnitEnd
            && ((bytes[nalUnitOffset] >> 1) & 0x3F) === 33) {
            const nalUnit = bytes.subarray(nalUnitOffset, nalUnitEnd);
            const rbsp = createRBSP(nalUnit);
            if (rbsp.byteLength < 13) {
                throw new TypeError('The exact HEVC probe SPS profile tier level is truncated');
            }
            const profileIDC = rbsp[1] & 0x1F;
            if (profileIDC !== 1 && profileIDC !== 2) {
                throw new TypeError('The exact HEVC probe SPS profile is unsupported');
            }
            return {
                levelIDC: rbsp[12],
                mainTier: (rbsp[1] & 0x20) === 0,
                progressive: (rbsp[6] & 0x80) !== 0 && (rbsp[6] & 0x40) === 0,
                profileIDC
            };
        }
        startCode = nextStartCode;
    }
    throw new TypeError('The exact HEVC probe access unit has no SPS');
}

function createFailureResult(
    tierRequest: HEVCExactCapabilityWorkerTierRequest,
    reason: Exclude<HEVCExactCapabilityWorkerTierResult['reason'], 'decode-output-verified'>,
    decodeMilliseconds: number | null = null
): HEVCExactCapabilityWorkerTierResult {
    return {
        bitDepth: null,
        chromaHeight: null,
        chromaWidth: null,
        codedHeight: null,
        codedWidth: null,
        decodeMilliseconds,
        decodedFrameFingerprints: null,
        decodedFrameCount: null,
        decodedByteLength: null,
        framesPerSecond: null,
        levelIDC: null,
        measuredFrameCount: null,
        minimumFramesPerSecond: null,
        profileIDC: null,
        reason,
        steadyStateDecodeMilliseconds: null,
        supported: false,
        tier: tierRequest.tier,
        totalDecodedByteLength: null
    };
}

function getDecodedByteLength(frame: HEVCFrame): number {
    const decodedByteLength = frame.y.byteLength + frame.cb.byteLength + frame.cr.byteLength;
    if (
        !Number.isSafeInteger(decodedByteLength)
        || decodedByteLength <= 0
        || decodedByteLength > HEVC_EXACT_CAPABILITY_MAXIMUM_DECODED_BYTE_LENGTH
    ) {
        throw new TypeError('The exact HEVC probe output exceeds its memory bound');
    }
    return decodedByteLength;
}

const FINGERPRINT_COLUMN_SAMPLE_COUNT = 64;
const FINGERPRINT_ROW_SAMPLE_COUNT = 36;
const FNV1A_OFFSET_BASIS = 2_166_136_261;
const FNV1A_PRIME = 16_777_619;

function mixFingerprintValue(fingerprint: number, value: number): number {
    let mixedFingerprint = Math.imul(
        (fingerprint ^ (value & 0xFF)) >>> 0,
        FNV1A_PRIME
    ) >>> 0;
    mixedFingerprint = Math.imul(
        (mixedFingerprint ^ ((value >>> 8) & 0xFF)) >>> 0,
        FNV1A_PRIME
    ) >>> 0;
    return mixedFingerprint;
}

function mixPlaneFingerprint(
    fingerprint: number,
    plane: Uint16Array,
    width: number,
    height: number
): number {
    let mixedFingerprint = mixFingerprintValue(fingerprint, width);
    mixedFingerprint = mixFingerprintValue(mixedFingerprint, height);
    for (
        let rowSampleIndex = 0;
        rowSampleIndex < FINGERPRINT_ROW_SAMPLE_COUNT;
        rowSampleIndex += 1
    ) {
        const rowIndex = Math.floor(
            rowSampleIndex * (height - 1) / (FINGERPRINT_ROW_SAMPLE_COUNT - 1)
        );
        for (
            let columnSampleIndex = 0;
            columnSampleIndex < FINGERPRINT_COLUMN_SAMPLE_COUNT;
            columnSampleIndex += 1
        ) {
            const columnIndex = Math.floor(
                columnSampleIndex * (width - 1)
                    / (FINGERPRINT_COLUMN_SAMPLE_COUNT - 1)
            );
            mixedFingerprint = mixFingerprintValue(
                mixedFingerprint,
                plane[(rowIndex * width) + columnIndex]
            );
        }
    }
    return mixedFingerprint;
}

function createFrameFingerprint(frame: HEVCFrame): number {
    let fingerprint = mixPlaneFingerprint(
        FNV1A_OFFSET_BASIS,
        frame.y,
        frame.width,
        frame.height
    );
    fingerprint = mixPlaneFingerprint(
        fingerprint,
        frame.cb,
        frame.chromaWidth,
        frame.chromaHeight
    );
    return mixPlaneFingerprint(
        fingerprint,
        frame.cr,
        frame.chromaWidth,
        frame.chromaHeight
    );
}

function frameMatchesRequest(
    frame: HEVCFrame,
    streamInfo: HEVCStreamInfo | null,
    fixtureMetadata: HEVCExactFixtureMetadata,
    tierRequest: HEVCExactCapabilityWorkerTierRequest,
    decodedByteLength: number,
    decodedFrameFingerprint: number,
    outputFrameIndex: number
): boolean {
    const expectedChromaWidth = Math.ceil(tierRequest.codedWidth / 2);
    const expectedChromaHeight = Math.ceil(tierRequest.codedHeight / 2);
    const expectedLumaSampleCount = tierRequest.codedWidth * tierRequest.codedHeight;
    const expectedChromaSampleCount = expectedChromaWidth * expectedChromaHeight;
    const expectedDecodedByteLength = (
        expectedLumaSampleCount + (2 * expectedChromaSampleCount)
    ) * Uint16Array.BYTES_PER_ELEMENT;
    const definition = HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS[tierRequest.tier];

    return frame.width === tierRequest.codedWidth
        && frame.height === tierRequest.codedHeight
        && frame.chromaWidth === expectedChromaWidth
        && frame.chromaHeight === expectedChromaHeight
        && frame.bitDepth === tierRequest.bitDepth
        && frame.y.length === expectedLumaSampleCount
        && frame.cb.length === expectedChromaSampleCount
        && frame.cr.length === expectedChromaSampleCount
        && decodedByteLength === expectedDecodedByteLength
        && decodedFrameFingerprint === definition.decodedFrameFingerprints[outputFrameIndex]
        && fixtureMetadata.levelIDC === tierRequest.levelIDC
        && fixtureMetadata.mainTier
        && fixtureMetadata.progressive
        && fixtureMetadata.profileIDC === tierRequest.profileIDC
        && (
            streamInfo === null
            || (
                streamInfo.width === tierRequest.codedWidth
                && streamInfo.height === tierRequest.codedHeight
                && streamInfo.bitDepth === tierRequest.bitDepth
                && streamInfo.chromaFormat === 1
                && (streamInfo.profile === 0 || streamInfo.profile === tierRequest.profileIDC)
                && (streamInfo.level === 0 || streamInfo.level === tierRequest.levelIDC)
            )
        );
}

type HEVCExactOutputGeometry = Readonly<{
    bitDepth: number
    chromaHeight: number
    chromaWidth: number
    codedHeight: number
    codedWidth: number
    decodedByteLength: number
}>;

type HEVCExactQualificationState = {
    decodedFrameFingerprints: number[]
    decodedFrameCount: number
    geometry: HEVCExactOutputGeometry | null
    outputMatches: boolean
    totalDecodedByteLength: number
};

type HEVCExactQualificationEvidence = Readonly<{
    decodeMilliseconds: number
    decodedFrameFingerprints: readonly number[]
    decodedFrameCount: number
    framesPerSecond: number
    geometry: HEVCExactOutputGeometry
    measuredFrameCount: number
    steadyStateDecodeMilliseconds: number
    totalDecodedByteLength: number
}>;

function createQualificationResult(
    tierRequest: HEVCExactCapabilityWorkerTierRequest,
    evidence: HEVCExactQualificationEvidence,
    reason: HEVCExactCapabilityWorkerTierResult['reason']
): HEVCExactCapabilityWorkerTierResult {
    const supported = reason === 'decode-output-verified';
    return {
        bitDepth: evidence.geometry.bitDepth,
        chromaHeight: evidence.geometry.chromaHeight,
        chromaWidth: evidence.geometry.chromaWidth,
        codedHeight: evidence.geometry.codedHeight,
        codedWidth: evidence.geometry.codedWidth,
        decodeMilliseconds: evidence.decodeMilliseconds,
        decodedFrameFingerprints: evidence.decodedFrameFingerprints,
        decodedFrameCount: evidence.decodedFrameCount,
        decodedByteLength: evidence.geometry.decodedByteLength,
        framesPerSecond: evidence.framesPerSecond,
        levelIDC: tierRequest.levelIDC,
        measuredFrameCount: evidence.measuredFrameCount,
        minimumFramesPerSecond: tierRequest.minimumFramesPerSecond,
        profileIDC: tierRequest.profileIDC,
        reason,
        steadyStateDecodeMilliseconds: evidence.steadyStateDecodeMilliseconds,
        supported,
        tier: tierRequest.tier,
        totalDecodedByteLength: evidence.totalDecodedByteLength
    };
}

function consumeFrame(
    frame: HEVCFrame,
    streamInfo: HEVCStreamInfo | null,
    fixtureMetadata: HEVCExactFixtureMetadata,
    tierRequest: HEVCExactCapabilityWorkerTierRequest,
    state: HEVCExactQualificationState,
    fingerprintFrame: (frame: HEVCFrame) => number
): void {
    const outputFrameIndex = state.decodedFrameCount;
    if (outputFrameIndex >= tierRequest.qualificationFrameCount) {
        throw new TypeError('The exact HEVC probe returned too many frames');
    }
    const decodedByteLength = getDecodedByteLength(frame);
    const decodedFrameFingerprint = fingerprintFrame(frame);
    state.decodedFrameCount += 1;
    state.decodedFrameFingerprints.push(decodedFrameFingerprint);
    state.totalDecodedByteLength += decodedByteLength;
    if (
        !Number.isSafeInteger(state.totalDecodedByteLength)
        || state.totalDecodedByteLength
            > HEVC_EXACT_CAPABILITY_MAXIMUM_TOTAL_DECODED_BYTE_LENGTH
    ) {
        throw new TypeError('The exact HEVC probe aggregate output exceeds its bound');
    }
    state.geometry ??= {
        bitDepth: frame.bitDepth,
        chromaHeight: frame.chromaHeight,
        chromaWidth: frame.chromaWidth,
        codedHeight: frame.height,
        codedWidth: frame.width,
        decodedByteLength
    };
    state.outputMatches &&= frameMatchesRequest(
        frame,
        streamInfo,
        fixtureMetadata,
        tierRequest,
        decodedByteLength,
        decodedFrameFingerprint,
        outputFrameIndex
    );
}

async function probeTier(
    tierRequest: HEVCExactCapabilityWorkerTierRequest,
    decoderWASMURL: string,
    dependencies: HEVCExactCapabilityWorkerRuntimeDependencies
): Promise<HEVCExactCapabilityWorkerTierResult> {
    let decoder: HEVCDecoderBackend | null = null;
    const startMilliseconds = dependencies.now();
    if (!Number.isFinite(startMilliseconds)) {
        return createFailureResult(tierRequest, 'decode-error');
    }

    try {
        const fixtureMetadata = parseFixtureMetadata(
            tierRequest.qualificationAccessUnits[0]
        );
        decoder = await dependencies.createDecoder({
            wasmBinaryUrl: decoderWASMURL
        });
        const state: HEVCExactQualificationState = {
            decodedFrameFingerprints: [],
            decodedFrameCount: 0,
            geometry: null,
            outputMatches: true,
            totalDecodedByteLength: 0
        };
        let decodedWarmupFrameCount = 0;
        let steadyStateStartMilliseconds: number | null = null;
        for (
            let accessUnitIndex = 0;
            accessUnitIndex < tierRequest.qualificationAccessUnits.length;
            accessUnitIndex += 1
        ) {
            const definition = HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS[tierRequest.tier];
            if (
                findFirstVCLNALUnitType(
                    tierRequest.qualificationAccessUnits[accessUnitIndex]
                ) !== definition.qualificationVCLNALUnitTypes[accessUnitIndex]
            ) {
                return createFailureResult(tierRequest, 'decode-error');
            }
            if (accessUnitIndex === tierRequest.warmupFrameCount) {
                decodedWarmupFrameCount = state.decodedFrameCount;
                steadyStateStartMilliseconds = dependencies.now();
            }
            decoder.feed(new Uint8Array(
                tierRequest.qualificationAccessUnits[accessUnitIndex]
            ));
            const streamInfo = decoder.info;
            decoder.drain((frame: HEVCFrame): void => {
                consumeFrame(
                    frame,
                    streamInfo,
                    fixtureMetadata,
                    tierRequest,
                    state,
                    dependencies.fingerprintFrame
                );
            });
        }
        const finalStreamInfo = decoder.info;
        decoder.flush((frame: HEVCFrame): void => {
            consumeFrame(
                frame,
                finalStreamInfo,
                fixtureMetadata,
                tierRequest,
                state,
                dependencies.fingerprintFrame
            );
        });
        const finishMilliseconds = dependencies.now();
        if (steadyStateStartMilliseconds === null) {
            return createFailureResult(tierRequest, 'decode-error');
        }
        const decodeMilliseconds = finishMilliseconds - startMilliseconds;
        const steadyStateDecodeMilliseconds = finishMilliseconds
            - steadyStateStartMilliseconds;
        const measuredFrameCount = state.decodedFrameCount - decodedWarmupFrameCount;
        if (
            !Number.isFinite(decodeMilliseconds)
            || decodeMilliseconds < 0
            || !Number.isFinite(steadyStateDecodeMilliseconds)
            || steadyStateDecodeMilliseconds <= 0
            || !Number.isSafeInteger(measuredFrameCount)
            || measuredFrameCount < 0
            || !state.geometry
        ) {
            return createFailureResult(tierRequest, 'decode-error');
        }
        const framesPerSecond = measuredFrameCount * 1_000
            / steadyStateDecodeMilliseconds;
        if (!Number.isFinite(framesPerSecond) || framesPerSecond < 0) {
            return createFailureResult(tierRequest, 'decode-error');
        }
        const evidence: HEVCExactQualificationEvidence = {
            decodeMilliseconds,
            decodedFrameFingerprints: Object.freeze([
                ...state.decodedFrameFingerprints
            ]),
            decodedFrameCount: state.decodedFrameCount,
            framesPerSecond,
            geometry: state.geometry,
            measuredFrameCount,
            steadyStateDecodeMilliseconds,
            totalDecodedByteLength: state.totalDecodedByteLength
        };
        if (decodeMilliseconds > tierRequest.maximumDecodeMilliseconds) {
            return createQualificationResult(
                tierRequest,
                evidence,
                'time-budget-exceeded'
            );
        }
        const expectedDecodedByteLength = state.geometry.decodedByteLength
            * tierRequest.qualificationFrameCount;
        if (
            decodedWarmupFrameCount !== tierRequest.warmupFrameCount
            || state.decodedFrameCount !== tierRequest.qualificationFrameCount
            || measuredFrameCount !== tierRequest.qualificationFrameCount
                - tierRequest.warmupFrameCount
            || state.totalDecodedByteLength !== expectedDecodedByteLength
            || !state.outputMatches
        ) {
            return createQualificationResult(tierRequest, evidence, 'output-mismatch');
        }
        if (framesPerSecond < tierRequest.minimumFramesPerSecond) {
            return createQualificationResult(
                tierRequest,
                evidence,
                'throughput-insufficient'
            );
        }
        return createQualificationResult(tierRequest, evidence, 'decode-output-verified');
    } catch {
        return createFailureResult(tierRequest, 'decode-error');
    } finally {
        decoder?.destroy();
    }
}

function isBorderlineUltraHDThroughputFailure(
    result: HEVCExactCapabilityWorkerTierResult
): boolean {
    return result.tier === 'main10-4k'
        && result.reason === 'throughput-insufficient'
        && result.framesPerSecond !== null
        && result.framesPerSecond
            >= HEVC_EXACT_CAPABILITY_MINIMUM_PLAYBACK_FRAMES_PER_SECOND;
}

function selectFasterThroughputFailure(
    first: HEVCExactCapabilityWorkerTierResult,
    second: HEVCExactCapabilityWorkerTierResult
): HEVCExactCapabilityWorkerTierResult {
    return (second.framesPerSecond ?? 0) > (first.framesPerSecond ?? 0) ?
        second :
        first;
}

async function probeTierWithWarmRetry(
    tierRequest: HEVCExactCapabilityWorkerTierRequest,
    decoderWASMURL: string,
    dependencies: HEVCExactCapabilityWorkerRuntimeDependencies
): Promise<HEVCExactCapabilityWorkerTierResult> {
    let bestResult = await probeTier(tierRequest, decoderWASMURL, dependencies);
    if (!isBorderlineUltraHDThroughputFailure(bestResult)) {
        return bestResult;
    }

    // UHD allocation and WASM tiering can distort the first otherwise valid sample
    for (
        let attemptNumber = 2;
        attemptNumber <= HEVC_ULTRA_HD_MAXIMUM_PROBE_ATTEMPT_COUNT;
        attemptNumber += 1
    ) {
        const retryResult = await probeTier(
            tierRequest,
            decoderWASMURL,
            dependencies
        );
        switch (retryResult.reason) {
            case 'decode-output-verified':
                return retryResult;
            case 'throughput-insufficient':
                bestResult = selectFasterThroughputFailure(bestResult, retryResult);
                if (!isBorderlineUltraHDThroughputFailure(retryResult)) {
                    return bestResult;
                }
                break;
            default:
                // Inconsistent decode or output evidence must still fail closed
                return retryResult;
        }
    }
    return bestResult;
}

/** Runs every exact HEVC decode tier through the bounded @hevcjs/core backend. */
export async function runHEVCExactCapabilityWorkerRequest(
    request: HEVCExactCapabilityWorkerRequest,
    dependencies: HEVCExactCapabilityWorkerRuntimeDependencies = DEFAULT_DEPENDENCIES
): Promise<HEVCExactCapabilityWorkerResponse> {
    if (!isHEVCExactCapabilityWorkerRequest(request)) {
        throw new TypeError('The exact HEVC capability worker request is invalid');
    }

    const results: HEVCExactCapabilityWorkerTierResult[] = [];
    let totalDecodedByteLength = 0;
    for (const tierRequest of request.tiers) {
        const result = await probeTierWithWarmRetry(
            tierRequest,
            request.decoderWASMURL,
            dependencies
        );
        totalDecodedByteLength += result.totalDecodedByteLength ?? 0;
        if (
            !Number.isSafeInteger(totalDecodedByteLength)
            || totalDecodedByteLength
                > HEVC_EXACT_CAPABILITY_MAXIMUM_TOTAL_DECODED_BYTE_LENGTH
        ) {
            results.push(createFailureResult(tierRequest, 'decode-error'));
            continue;
        }
        results.push(result);
    }
    return {
        requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
        results,
        type: 'result'
    };
}
