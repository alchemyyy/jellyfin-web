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
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS,
    isHEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerQualificationRequest,
    type HEVCExactCapabilityWorkerQualificationResult,
    type HEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerResponse
} from './HEVCExactCapabilityProtocol';

export type HEVCExactCapabilityWorkerRuntimeDependencies = Readonly<{
    createDecoder: (options: DecoderOptions) => Promise<HEVCDecoderBackend>
    fingerprintFrame: (frame: HEVCFrame) => number
}>;

const DEFAULT_DEPENDENCIES: HEVCExactCapabilityWorkerRuntimeDependencies = Object.freeze({
    createDecoder: createHEVCDecoderBackend,
    fingerprintFrame: createFrameFingerprint
});

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
    qualificationRequest: HEVCExactCapabilityWorkerQualificationRequest,
    reason: Exclude<
        HEVCExactCapabilityWorkerQualificationResult['reason'],
        'decode-output-verified'
    >
): HEVCExactCapabilityWorkerQualificationResult {
    return {
        bitDepth: null,
        chromaHeight: null,
        chromaWidth: null,
        codedHeight: null,
        codedWidth: null,
        decodedFrameFingerprints: null,
        decodedFrameCount: null,
        decodedByteLength: null,
        levelIDC: null,
        profileIDC: null,
        reason,
        supported: false,
        fixture: qualificationRequest.fixture,
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
    qualificationRequest: HEVCExactCapabilityWorkerQualificationRequest,
    decodedByteLength: number,
    decodedFrameFingerprint: number,
    outputFrameIndex: number
): boolean {
    const expectedChromaWidth = Math.ceil(qualificationRequest.codedWidth / 2);
    const expectedChromaHeight = Math.ceil(qualificationRequest.codedHeight / 2);
    const expectedLumaSampleCount = qualificationRequest.codedWidth
        * qualificationRequest.codedHeight;
    const expectedChromaSampleCount = expectedChromaWidth * expectedChromaHeight;
    const expectedDecodedByteLength = (
        expectedLumaSampleCount + (2 * expectedChromaSampleCount)
    ) * Uint16Array.BYTES_PER_ELEMENT;
    const definition = HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS[
        qualificationRequest.fixture
    ];

    return frame.width === qualificationRequest.codedWidth
        && frame.height === qualificationRequest.codedHeight
        && frame.chromaWidth === expectedChromaWidth
        && frame.chromaHeight === expectedChromaHeight
        && frame.bitDepth === qualificationRequest.bitDepth
        && frame.y.length === expectedLumaSampleCount
        && frame.cb.length === expectedChromaSampleCount
        && frame.cr.length === expectedChromaSampleCount
        && decodedByteLength === expectedDecodedByteLength
        && decodedFrameFingerprint === definition.decodedFrameFingerprints[outputFrameIndex]
        && fixtureMetadata.levelIDC === qualificationRequest.levelIDC
        && fixtureMetadata.mainTier
        && fixtureMetadata.progressive
        && fixtureMetadata.profileIDC === qualificationRequest.profileIDC
        && (
            streamInfo === null
            || (
                streamInfo.width === qualificationRequest.codedWidth
                && streamInfo.height === qualificationRequest.codedHeight
                && streamInfo.bitDepth === qualificationRequest.bitDepth
                && streamInfo.chromaFormat === 1
                && (
                    streamInfo.profile === 0
                    || streamInfo.profile === qualificationRequest.profileIDC
                )
                && (
                    streamInfo.level === 0
                    || streamInfo.level === qualificationRequest.levelIDC
                )
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
    decodedFrameFingerprints: readonly number[]
    decodedFrameCount: number
    geometry: HEVCExactOutputGeometry
    totalDecodedByteLength: number
}>;

function createQualificationResult(
    qualificationRequest: HEVCExactCapabilityWorkerQualificationRequest,
    evidence: HEVCExactQualificationEvidence,
    reason: HEVCExactCapabilityWorkerQualificationResult['reason']
): HEVCExactCapabilityWorkerQualificationResult {
    const supported = reason === 'decode-output-verified';
    return {
        bitDepth: evidence.geometry.bitDepth,
        chromaHeight: evidence.geometry.chromaHeight,
        chromaWidth: evidence.geometry.chromaWidth,
        codedHeight: evidence.geometry.codedHeight,
        codedWidth: evidence.geometry.codedWidth,
        decodedFrameFingerprints: evidence.decodedFrameFingerprints,
        decodedFrameCount: evidence.decodedFrameCount,
        decodedByteLength: evidence.geometry.decodedByteLength,
        levelIDC: qualificationRequest.levelIDC,
        profileIDC: qualificationRequest.profileIDC,
        reason,
        supported,
        fixture: qualificationRequest.fixture,
        totalDecodedByteLength: evidence.totalDecodedByteLength
    };
}

function consumeFrame(
    frame: HEVCFrame,
    streamInfo: HEVCStreamInfo | null,
    fixtureMetadata: HEVCExactFixtureMetadata,
    qualificationRequest: HEVCExactCapabilityWorkerQualificationRequest,
    state: HEVCExactQualificationState,
    fingerprintFrame: (frame: HEVCFrame) => number
): void {
    const outputFrameIndex = state.decodedFrameCount;
    if (outputFrameIndex >= qualificationRequest.qualificationFrameCount) {
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
        qualificationRequest,
        decodedByteLength,
        decodedFrameFingerprint,
        outputFrameIndex
    );
}

async function probeQualification(
    qualificationRequest: HEVCExactCapabilityWorkerQualificationRequest,
    decoderWASMURL: string,
    dependencies: HEVCExactCapabilityWorkerRuntimeDependencies
): Promise<HEVCExactCapabilityWorkerQualificationResult> {
    let decoder: HEVCDecoderBackend | null = null;

    try {
        const fixtureMetadata = parseFixtureMetadata(
            qualificationRequest.qualificationAccessUnits[0]
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
        for (
            let accessUnitIndex = 0;
            accessUnitIndex < qualificationRequest.qualificationAccessUnits.length;
            accessUnitIndex += 1
        ) {
            const definition = HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS[
                qualificationRequest.fixture
            ];
            if (
                findFirstVCLNALUnitType(
                    qualificationRequest.qualificationAccessUnits[accessUnitIndex]
                ) !== definition.qualificationVCLNALUnitTypes[accessUnitIndex]
            ) {
                return createFailureResult(qualificationRequest, 'decode-error');
            }
            decoder.feed(new Uint8Array(
                qualificationRequest.qualificationAccessUnits[accessUnitIndex]
            ));
            const streamInfo = decoder.info;
            decoder.drain((frame: HEVCFrame): void => {
                consumeFrame(
                    frame,
                    streamInfo,
                    fixtureMetadata,
                    qualificationRequest,
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
                qualificationRequest,
                state,
                dependencies.fingerprintFrame
            );
        });
        if (!state.geometry) {
            return createFailureResult(qualificationRequest, 'decode-error');
        }
        const evidence: HEVCExactQualificationEvidence = {
            decodedFrameFingerprints: Object.freeze([
                ...state.decodedFrameFingerprints
            ]),
            decodedFrameCount: state.decodedFrameCount,
            geometry: state.geometry,
            totalDecodedByteLength: state.totalDecodedByteLength
        };
        const expectedDecodedByteLength = state.geometry.decodedByteLength
            * qualificationRequest.qualificationFrameCount;
        if (
            state.decodedFrameCount !== qualificationRequest.qualificationFrameCount
            || state.totalDecodedByteLength !== expectedDecodedByteLength
            || !state.outputMatches
        ) {
            return createQualificationResult(
                qualificationRequest,
                evidence,
                'output-mismatch'
            );
        }
        return createQualificationResult(
            qualificationRequest,
            evidence,
            'decode-output-verified'
        );
    } catch {
        return createFailureResult(qualificationRequest, 'decode-error');
    } finally {
        decoder?.destroy();
    }
}

/** Runs every exact HEVC qualification fixture through the bounded decoder. */
export async function runHEVCExactCapabilityWorkerRequest(
    request: HEVCExactCapabilityWorkerRequest,
    dependencies: HEVCExactCapabilityWorkerRuntimeDependencies = DEFAULT_DEPENDENCIES
): Promise<HEVCExactCapabilityWorkerResponse> {
    if (!isHEVCExactCapabilityWorkerRequest(request)) {
        throw new TypeError('The exact HEVC capability worker request is invalid');
    }

    const results: HEVCExactCapabilityWorkerQualificationResult[] = [];
    let totalDecodedByteLength = 0;
    for (const qualificationRequest of request.qualifications) {
        const result = await probeQualification(
            qualificationRequest,
            request.decoderWASMURL,
            dependencies
        );
        totalDecodedByteLength += result.totalDecodedByteLength ?? 0;
        if (
            !Number.isSafeInteger(totalDecodedByteLength)
            || totalDecodedByteLength
                > HEVC_EXACT_CAPABILITY_MAXIMUM_TOTAL_DECODED_BYTE_LENGTH
        ) {
            results.push(createFailureResult(qualificationRequest, 'decode-error'));
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
