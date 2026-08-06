export const HEVC_EXACT_CAPABILITY_REQUEST_ID = 1;
export const HEVC_EXACT_CAPABILITY_MAXIMUM_ACCESS_UNIT_BYTE_LENGTH = 128 * 1024;
export const HEVC_EXACT_CAPABILITY_MAXIMUM_DECODED_BYTE_LENGTH = 32 * 1024 * 1024;
export const HEVC_EXACT_CAPABILITY_MAXIMUM_TOTAL_INPUT_BYTE_LENGTH = 1024 * 1024;
export const HEVC_EXACT_CAPABILITY_MAXIMUM_TOTAL_DECODED_BYTE_LENGTH = 285 * 1024 * 1024;
export const HEVC_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 7_000;
export const HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT = 8;

export const HEVC_EXACT_CAPABILITY_FIXTURES = Object.freeze([
    'main-1080p',
    'main10-1080p',
    'main10-4k'
] as const);

export type HEVCExactCapabilityFixture = typeof HEVC_EXACT_CAPABILITY_FIXTURES[number];
export type HEVCExactCapabilityProfile = 'main' | 'main10';
export type HEVCExactCapabilityFormat = 'I420' | 'I420P10';

export type HEVCExactCapabilityFixtureDefinition = Readonly<{
    bitDepth: 8 | 10
    codecString: 'hvc1.1.6.L120.B0' | 'hvc1.2.4.L120.B0' | 'hvc1.2.4.L153.B0'
    codedHeight: 1_080 | 2_160
    codedWidth: 1_920 | 3_840
    decodedFrameFingerprints: readonly number[]
    format: HEVCExactCapabilityFormat
    profile: HEVCExactCapabilityProfile
    profileIDC: 1 | 2
    qualificationAccessUnitByteLengths: readonly number[]
    qualificationFrameCount: number
    qualificationVCLNALUnitTypes: readonly (1 | 20)[]
    levelIDC: 120 | 153
    fixture: HEVCExactCapabilityFixture
}>;

export const HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS: Readonly<Record<
    HEVCExactCapabilityFixture,
    HEVCExactCapabilityFixtureDefinition
>> = Object.freeze({
    'main-1080p': Object.freeze({
        bitDepth: 8,
        codecString: 'hvc1.1.6.L120.B0',
        codedHeight: 1_080,
        codedWidth: 1_920,
        decodedFrameFingerprints: Object.freeze([
            1_409_144_559,
            2_325_269_144,
            1_479_088_652,
            3_424_562_773,
            1_522_044_181,
            3_126_439_635,
            2_013_041_680,
            1_744_647_904
        ]),
        format: 'I420',
        levelIDC: 120,
        profile: 'main',
        profileIDC: 1,
        qualificationAccessUnitByteLengths: Object.freeze([
            1_422, 1_849, 2_004, 1_537, 1_830, 1_702, 1_845, 1_422
        ]),
        qualificationFrameCount: HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT,
        qualificationVCLNALUnitTypes: Object.freeze([
            20, 1, 20, 1, 20, 1, 20, 1
        ] as const),
        fixture: 'main-1080p'
    }),
    'main10-1080p': Object.freeze({
        bitDepth: 10,
        codecString: 'hvc1.2.4.L120.B0',
        codedHeight: 1_080,
        codedWidth: 1_920,
        decodedFrameFingerprints: Object.freeze([
            918_370,
            3_550_082_707,
            3_383_640_766,
            728_543_190,
            3_369_665_670,
            2_797_437_209,
            3_596_637_169,
            36_311_845
        ]),
        format: 'I420P10',
        levelIDC: 120,
        profile: 'main10',
        profileIDC: 2,
        qualificationAccessUnitByteLengths: Object.freeze([
            1_576, 1_884, 2_040, 1_992, 1_778, 1_631, 1_767, 1_549
        ]),
        qualificationFrameCount: HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT,
        qualificationVCLNALUnitTypes: Object.freeze([
            20, 1, 20, 1, 20, 1, 20, 1
        ] as const),
        fixture: 'main10-1080p'
    }),
    'main10-4k': Object.freeze({
        bitDepth: 10,
        codecString: 'hvc1.2.4.L153.B0',
        codedHeight: 2_160,
        codedWidth: 3_840,
        decodedFrameFingerprints: Object.freeze([
            2_669_261_473,
            2_891_374_311,
            3_294_996_003,
            3_899_934_279,
            3_645_638_150,
            3_163_731_443,
            1_028_093_413,
            2_922_080_851
        ]),
        format: 'I420P10',
        levelIDC: 153,
        profile: 'main10',
        profileIDC: 2,
        qualificationAccessUnitByteLengths: Object.freeze([
            124_406, 90_639, 86_210, 85_647, 83_781, 76_782, 71_884, 57_625
        ]),
        qualificationFrameCount: HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT,
        qualificationVCLNALUnitTypes: Object.freeze([
            20, 1, 1, 1, 1, 1, 1, 1
        ] as const),
        fixture: 'main10-4k'
    })
});

export type HEVCExactCapabilityWorkerQualificationRequest = Readonly<{
    accessUnit: ArrayBuffer
    bitDepth: 8 | 10
    codedHeight: number
    codedWidth: number
    levelIDC: number
    profileIDC: number
    qualificationAccessUnits: readonly ArrayBuffer[]
    qualificationFrameCount: number
    fixture: HEVCExactCapabilityFixture
}>;

export type HEVCExactCapabilityWorkerRequest = Readonly<{
    decoderGlueURL: string
    decoderWASMURL: string
    requestID: typeof HEVC_EXACT_CAPABILITY_REQUEST_ID
    qualifications: readonly HEVCExactCapabilityWorkerQualificationRequest[]
    type: 'probe'
}>;

export type HEVCExactCapabilityWorkerQualificationReason =
    | 'decode-error'
    | 'decode-output-verified'
    | 'output-mismatch';

export type HEVCExactCapabilityWorkerQualificationResult = Readonly<{
    bitDepth: number | null
    chromaHeight: number | null
    chromaWidth: number | null
    codedHeight: number | null
    codedWidth: number | null
    decodedFrameFingerprints: readonly number[] | null
    decodedFrameCount: number | null
    decodedByteLength: number | null
    levelIDC: number | null
    profileIDC: number | null
    reason: HEVCExactCapabilityWorkerQualificationReason
    supported: boolean
    fixture: HEVCExactCapabilityFixture
    totalDecodedByteLength: number | null
}>;

export type HEVCExactCapabilityWorkerResponse = Readonly<{
    requestID: typeof HEVC_EXACT_CAPABILITY_REQUEST_ID
    results: readonly HEVCExactCapabilityWorkerQualificationResult[]
    type: 'result'
}>;

function isNullableNonNegativeSafeInteger(value: unknown): value is number | null {
    return value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
}

function isNullableFingerprintArray(value: unknown): value is readonly number[] | null {
    return value === null || (
        Array.isArray(value)
        && value.length <= HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT
        && value.every(fingerprint => (
            Number.isSafeInteger(fingerprint)
            && fingerprint >= 0
            && fingerprint <= 0xFFFF_FFFF
        ))
    );
}

function isFixture(value: unknown): value is HEVCExactCapabilityFixture {
    return value === 'main-1080p'
        || value === 'main10-1080p'
        || value === 'main10-4k';
}

function isWorkerQualificationReason(
    value: unknown
): value is HEVCExactCapabilityWorkerQualificationReason {
    switch (value) {
        case 'decode-error':
        case 'decode-output-verified':
        case 'output-mismatch':
            return true;
        default:
            return false;
    }
}

function getQualificationInputByteLength(
    qualificationRequest: HEVCExactCapabilityWorkerQualificationRequest,
    definition: HEVCExactCapabilityFixtureDefinition
): number | null {
    if (
        !Array.isArray(qualificationRequest.qualificationAccessUnits)
        || qualificationRequest.qualificationAccessUnits.length
            !== definition.qualificationAccessUnitByteLengths.length
    ) {
        return null;
    }

    let inputByteLength = 0;
    for (
        let accessUnitIndex = 0;
        accessUnitIndex < qualificationRequest.qualificationAccessUnits.length;
        accessUnitIndex += 1
    ) {
        const qualificationAccessUnit = qualificationRequest.qualificationAccessUnits[
            accessUnitIndex
        ];
        if (
            !(qualificationAccessUnit instanceof ArrayBuffer)
            || qualificationAccessUnit.byteLength
                !== definition.qualificationAccessUnitByteLengths[accessUnitIndex]
            || qualificationAccessUnit.byteLength
                > HEVC_EXACT_CAPABILITY_MAXIMUM_ACCESS_UNIT_BYTE_LENGTH
        ) {
            return null;
        }
        inputByteLength += qualificationAccessUnit.byteLength;
    }
    return inputByteLength;
}

/** Checks an internal worker request before allocating decoder memory. */
export function isHEVCExactCapabilityWorkerRequest(
    value: unknown
): value is HEVCExactCapabilityWorkerRequest {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const request = value as Partial<HEVCExactCapabilityWorkerRequest>;
    if (
        request.type !== 'probe'
        || request.requestID !== HEVC_EXACT_CAPABILITY_REQUEST_ID
        || typeof request.decoderGlueURL !== 'string'
        || request.decoderGlueURL.length === 0
        || typeof request.decoderWASMURL !== 'string'
        || request.decoderWASMURL.length === 0
        || !Array.isArray(request.qualifications)
        || request.qualifications.length !== HEVC_EXACT_CAPABILITY_FIXTURES.length
    ) {
        return false;
    }

    const seenFixtures = new Set<HEVCExactCapabilityFixture>();
    let totalDecodedByteLength = 0;
    let totalInputByteLength = 0;
    for (const qualificationRequest of request.qualifications) {
        if (!qualificationRequest || typeof qualificationRequest !== 'object') {
            return false;
        }
        const fixture = (qualificationRequest as { fixture?: unknown }).fixture;
        if (!isFixture(fixture)) {
            return false;
        }
        const definition = HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS[fixture];
        if (
            seenFixtures.has(fixture)
            || !(qualificationRequest.accessUnit instanceof ArrayBuffer)
            || qualificationRequest.accessUnit.byteLength === 0
            || qualificationRequest.accessUnit.byteLength
                > HEVC_EXACT_CAPABILITY_MAXIMUM_ACCESS_UNIT_BYTE_LENGTH
            || qualificationRequest.bitDepth !== definition.bitDepth
            || qualificationRequest.codedHeight !== definition.codedHeight
            || qualificationRequest.codedWidth !== definition.codedWidth
            || qualificationRequest.levelIDC !== definition.levelIDC
            || qualificationRequest.profileIDC !== definition.profileIDC
            || definition.decodedFrameFingerprints.length
                !== definition.qualificationFrameCount
            || definition.qualificationAccessUnitByteLengths.length
                !== definition.qualificationFrameCount
            || definition.qualificationVCLNALUnitTypes.length
                !== definition.qualificationFrameCount
            || qualificationRequest.qualificationFrameCount
                !== definition.qualificationFrameCount
        ) {
            return false;
        }
        const qualificationInputByteLength = getQualificationInputByteLength(
            qualificationRequest,
            definition
        );
        if (qualificationInputByteLength === null) {
            return false;
        }
        totalInputByteLength += qualificationInputByteLength;
        const chromaWidth = Math.ceil(definition.codedWidth / 2);
        const chromaHeight = Math.ceil(definition.codedHeight / 2);
        const decodedFrameByteLength = (
            (definition.codedWidth * definition.codedHeight)
            + (2 * chromaWidth * chromaHeight)
        ) * Uint16Array.BYTES_PER_ELEMENT;
        totalInputByteLength += qualificationRequest.accessUnit.byteLength;
        totalDecodedByteLength += decodedFrameByteLength
            * definition.qualificationFrameCount;
        if (
            !Number.isSafeInteger(totalInputByteLength)
            || totalInputByteLength > HEVC_EXACT_CAPABILITY_MAXIMUM_TOTAL_INPUT_BYTE_LENGTH
            || !Number.isSafeInteger(totalDecodedByteLength)
            || totalDecodedByteLength > HEVC_EXACT_CAPABILITY_MAXIMUM_TOTAL_DECODED_BYTE_LENGTH
        ) {
            return false;
        }
        seenFixtures.add(fixture);
    }
    return seenFixtures.size === HEVC_EXACT_CAPABILITY_FIXTURES.length;
}

/** Checks the bounded summary returned by the capability worker. */
export function isHEVCExactCapabilityWorkerResponse(
    value: unknown
): value is HEVCExactCapabilityWorkerResponse {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const response = value as Partial<HEVCExactCapabilityWorkerResponse>;
    if (
        response.type !== 'result'
        || response.requestID !== HEVC_EXACT_CAPABILITY_REQUEST_ID
        || !Array.isArray(response.results)
        || response.results.length !== HEVC_EXACT_CAPABILITY_FIXTURES.length
    ) {
        return false;
    }

    const seenFixtures = new Set<HEVCExactCapabilityFixture>();
    for (const result of response.results) {
        if (
            !result
            || typeof result !== 'object'
            || !isFixture(result.fixture)
            || seenFixtures.has(result.fixture)
            || typeof result.supported !== 'boolean'
            || !isWorkerQualificationReason(result.reason)
            || !isNullableNonNegativeSafeInteger(result.bitDepth)
            || !isNullableNonNegativeSafeInteger(result.chromaHeight)
            || !isNullableNonNegativeSafeInteger(result.chromaWidth)
            || !isNullableNonNegativeSafeInteger(result.codedHeight)
            || !isNullableNonNegativeSafeInteger(result.codedWidth)
            || !isNullableFingerprintArray(result.decodedFrameFingerprints)
            || !isNullableNonNegativeSafeInteger(result.decodedFrameCount)
            || !isNullableNonNegativeSafeInteger(result.decodedByteLength)
            || !isNullableNonNegativeSafeInteger(result.levelIDC)
            || !isNullableNonNegativeSafeInteger(result.profileIDC)
            || !isNullableNonNegativeSafeInteger(result.totalDecodedByteLength)
        ) {
            return false;
        }
        if (
            result.supported !== (result.reason === 'decode-output-verified')
            || (
                result.supported
                && (
                    result.bitDepth === null
                    || result.chromaHeight === null
                    || result.chromaWidth === null
                    || result.codedHeight === null
                    || result.codedWidth === null
                    || result.decodedFrameFingerprints === null
                    || result.decodedFrameFingerprints.length
                        !== HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT
                    || result.decodedFrameCount === null
                    || result.decodedByteLength === null
                    || result.levelIDC === null
                    || result.profileIDC === null
                    || result.totalDecodedByteLength === null
                )
            )
        ) {
            return false;
        }
        seenFixtures.add(result.fixture);
    }
    return seenFixtures.size === HEVC_EXACT_CAPABILITY_FIXTURES.length;
}
