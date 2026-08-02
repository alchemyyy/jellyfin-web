export const HEVC_EXACT_CAPABILITY_REQUEST_ID = 1;
export const HEVC_EXACT_CAPABILITY_MAXIMUM_ACCESS_UNIT_BYTE_LENGTH = 128 * 1024;
export const HEVC_EXACT_CAPABILITY_MAXIMUM_DECODED_BYTE_LENGTH = 32 * 1024 * 1024;
export const HEVC_EXACT_CAPABILITY_MAXIMUM_TOTAL_INPUT_BYTE_LENGTH = 1024 * 1024;
export const HEVC_EXACT_CAPABILITY_MAXIMUM_TOTAL_DECODED_BYTE_LENGTH = 285 * 1024 * 1024;
export const HEVC_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 7_000;
export const HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT = 8;
export const HEVC_EXACT_CAPABILITY_WARMUP_FRAME_COUNT = 1;
export const HEVC_EXACT_CAPABILITY_MINIMUM_PLAYBACK_FRAMES_PER_SECOND = 24;
export const HEVC_EXACT_CAPABILITY_THROUGHPUT_HEADROOM_FACTOR = 1.25;
export const HEVC_EXACT_CAPABILITY_MINIMUM_QUALIFIED_FRAMES_PER_SECOND =
    HEVC_EXACT_CAPABILITY_MINIMUM_PLAYBACK_FRAMES_PER_SECOND
    * HEVC_EXACT_CAPABILITY_THROUGHPUT_HEADROOM_FACTOR;

export const HEVC_EXACT_CAPABILITY_TIERS = Object.freeze([
    'main-1080p',
    'main10-1080p',
    'main10-4k'
] as const);

export type HEVCExactCapabilityTier = typeof HEVC_EXACT_CAPABILITY_TIERS[number];
export type HEVCExactCapabilityProfile = 'main' | 'main10';
export type HEVCExactCapabilityFormat = 'I420' | 'I420P10';

export type HEVCExactCapabilityTierDefinition = Readonly<{
    bitDepth: 8 | 10
    codecString: 'hvc1.1.6.L120.B0' | 'hvc1.2.4.L120.B0' | 'hvc1.2.4.L153.B0'
    codedHeight: 1_080 | 2_160
    codedWidth: 1_920 | 3_840
    decodedFrameFingerprints: readonly number[]
    format: HEVCExactCapabilityFormat
    maximumBitrate: 12_000_000 | 40_000_000
    maximumDecodeMilliseconds: number
    minimumFramesPerSecond: number
    profile: HEVCExactCapabilityProfile
    profileIDC: 1 | 2
    qualificationAccessUnitByteLengths: readonly number[]
    qualificationFrameCount: number
    qualificationVCLNALUnitTypes: readonly (1 | 20)[]
    levelIDC: 120 | 153
    tier: HEVCExactCapabilityTier
    warmupFrameCount: number
}>;

export const HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS: Readonly<Record<
    HEVCExactCapabilityTier,
    HEVCExactCapabilityTierDefinition
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
        maximumBitrate: 12_000_000,
        maximumDecodeMilliseconds: 1_750,
        minimumFramesPerSecond: HEVC_EXACT_CAPABILITY_MINIMUM_QUALIFIED_FRAMES_PER_SECOND,
        profile: 'main',
        profileIDC: 1,
        qualificationAccessUnitByteLengths: Object.freeze([
            1_422, 1_849, 2_004, 1_537, 1_830, 1_702, 1_845, 1_422
        ]),
        qualificationFrameCount: HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT,
        qualificationVCLNALUnitTypes: Object.freeze([
            20, 1, 20, 1, 20, 1, 20, 1
        ] as const),
        tier: 'main-1080p',
        warmupFrameCount: HEVC_EXACT_CAPABILITY_WARMUP_FRAME_COUNT
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
        maximumBitrate: 12_000_000,
        maximumDecodeMilliseconds: 1_750,
        minimumFramesPerSecond: HEVC_EXACT_CAPABILITY_MINIMUM_QUALIFIED_FRAMES_PER_SECOND,
        profile: 'main10',
        profileIDC: 2,
        qualificationAccessUnitByteLengths: Object.freeze([
            1_576, 1_884, 2_040, 1_992, 1_778, 1_631, 1_767, 1_549
        ]),
        qualificationFrameCount: HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT,
        qualificationVCLNALUnitTypes: Object.freeze([
            20, 1, 20, 1, 20, 1, 20, 1
        ] as const),
        tier: 'main10-1080p',
        warmupFrameCount: HEVC_EXACT_CAPABILITY_WARMUP_FRAME_COUNT
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
        maximumBitrate: 40_000_000,
        maximumDecodeMilliseconds: 2_750,
        minimumFramesPerSecond: HEVC_EXACT_CAPABILITY_MINIMUM_QUALIFIED_FRAMES_PER_SECOND,
        profile: 'main10',
        profileIDC: 2,
        qualificationAccessUnitByteLengths: Object.freeze([
            124_406, 90_639, 86_210, 85_647, 83_781, 76_782, 71_884, 57_625
        ]),
        qualificationFrameCount: HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT,
        qualificationVCLNALUnitTypes: Object.freeze([
            20, 1, 1, 1, 1, 1, 1, 1
        ] as const),
        tier: 'main10-4k',
        warmupFrameCount: HEVC_EXACT_CAPABILITY_WARMUP_FRAME_COUNT
    })
});

export type HEVCExactCapabilityWorkerTierRequest = Readonly<{
    accessUnit: ArrayBuffer
    bitDepth: 8 | 10
    codedHeight: number
    codedWidth: number
    levelIDC: number
    maximumDecodeMilliseconds: number
    minimumFramesPerSecond: number
    profileIDC: number
    qualificationAccessUnits: readonly ArrayBuffer[]
    qualificationFrameCount: number
    tier: HEVCExactCapabilityTier
    warmupFrameCount: number
}>;

export type HEVCExactCapabilityWorkerRequest = Readonly<{
    decoderGlueURL: string
    decoderWASMURL: string
    requestID: typeof HEVC_EXACT_CAPABILITY_REQUEST_ID
    tiers: readonly HEVCExactCapabilityWorkerTierRequest[]
    type: 'probe'
}>;

export type HEVCExactCapabilityWorkerTierReason =
    | 'decode-error'
    | 'decode-output-verified'
    | 'output-mismatch'
    | 'throughput-insufficient'
    | 'time-budget-exceeded';

export type HEVCExactCapabilityWorkerTierResult = Readonly<{
    bitDepth: number | null
    chromaHeight: number | null
    chromaWidth: number | null
    codedHeight: number | null
    codedWidth: number | null
    decodeMilliseconds: number | null
    decodedFrameFingerprints: readonly number[] | null
    decodedFrameCount: number | null
    decodedByteLength: number | null
    framesPerSecond: number | null
    levelIDC: number | null
    measuredFrameCount: number | null
    minimumFramesPerSecond: number | null
    profileIDC: number | null
    reason: HEVCExactCapabilityWorkerTierReason
    supported: boolean
    tier: HEVCExactCapabilityTier
    steadyStateDecodeMilliseconds: number | null
    totalDecodedByteLength: number | null
}>;

export type HEVCExactCapabilityWorkerResponse = Readonly<{
    requestID: typeof HEVC_EXACT_CAPABILITY_REQUEST_ID
    results: readonly HEVCExactCapabilityWorkerTierResult[]
    type: 'result'
}>;

function isFiniteNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

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

function isTier(value: unknown): value is HEVCExactCapabilityTier {
    return value === 'main-1080p'
        || value === 'main10-1080p'
        || value === 'main10-4k';
}

function isWorkerTierReason(value: unknown): value is HEVCExactCapabilityWorkerTierReason {
    switch (value) {
        case 'decode-error':
        case 'decode-output-verified':
        case 'output-mismatch':
        case 'throughput-insufficient':
        case 'time-budget-exceeded':
            return true;
        default:
            return false;
    }
}

function getQualificationInputByteLength(
    tierRequest: HEVCExactCapabilityWorkerTierRequest,
    definition: HEVCExactCapabilityTierDefinition
): number | null {
    if (
        !Array.isArray(tierRequest.qualificationAccessUnits)
        || tierRequest.qualificationAccessUnits.length
            !== definition.qualificationAccessUnitByteLengths.length
    ) {
        return null;
    }

    let inputByteLength = 0;
    for (
        let accessUnitIndex = 0;
        accessUnitIndex < tierRequest.qualificationAccessUnits.length;
        accessUnitIndex += 1
    ) {
        const qualificationAccessUnit = tierRequest.qualificationAccessUnits[accessUnitIndex];
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
        || !Array.isArray(request.tiers)
        || request.tiers.length !== HEVC_EXACT_CAPABILITY_TIERS.length
    ) {
        return false;
    }

    const seenTiers = new Set<HEVCExactCapabilityTier>();
    let totalDecodedByteLength = 0;
    let totalInputByteLength = 0;
    for (const tierRequest of request.tiers) {
        if (!tierRequest || typeof tierRequest !== 'object') {
            return false;
        }
        const tier = (tierRequest as { tier?: unknown }).tier;
        if (!isTier(tier)) {
            return false;
        }
        const definition = HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS[tier];
        if (
            seenTiers.has(tier)
            || !(tierRequest.accessUnit instanceof ArrayBuffer)
            || tierRequest.accessUnit.byteLength === 0
            || tierRequest.accessUnit.byteLength
                > HEVC_EXACT_CAPABILITY_MAXIMUM_ACCESS_UNIT_BYTE_LENGTH
            || tierRequest.bitDepth !== definition.bitDepth
            || tierRequest.codedHeight !== definition.codedHeight
            || tierRequest.codedWidth !== definition.codedWidth
            || tierRequest.levelIDC !== definition.levelIDC
            || tierRequest.maximumDecodeMilliseconds !== definition.maximumDecodeMilliseconds
            || tierRequest.minimumFramesPerSecond !== definition.minimumFramesPerSecond
            || tierRequest.profileIDC !== definition.profileIDC
            || definition.decodedFrameFingerprints.length
                !== definition.qualificationFrameCount
            || definition.qualificationAccessUnitByteLengths.length
                !== definition.qualificationFrameCount
            || definition.qualificationVCLNALUnitTypes.length
                !== definition.qualificationFrameCount
            || tierRequest.qualificationFrameCount !== definition.qualificationFrameCount
            || tierRequest.warmupFrameCount !== definition.warmupFrameCount
        ) {
            return false;
        }
        const qualificationInputByteLength = getQualificationInputByteLength(
            tierRequest,
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
        totalInputByteLength += tierRequest.accessUnit.byteLength;
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
        seenTiers.add(tier);
    }
    return seenTiers.size === HEVC_EXACT_CAPABILITY_TIERS.length;
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
        || response.results.length !== HEVC_EXACT_CAPABILITY_TIERS.length
    ) {
        return false;
    }

    const seenTiers = new Set<HEVCExactCapabilityTier>();
    for (const result of response.results) {
        if (
            !result
            || typeof result !== 'object'
            || !isTier(result.tier)
            || seenTiers.has(result.tier)
            || typeof result.supported !== 'boolean'
            || !isWorkerTierReason(result.reason)
            || !isNullableNonNegativeSafeInteger(result.bitDepth)
            || !isNullableNonNegativeSafeInteger(result.chromaHeight)
            || !isNullableNonNegativeSafeInteger(result.chromaWidth)
            || !isNullableNonNegativeSafeInteger(result.codedHeight)
            || !isNullableNonNegativeSafeInteger(result.codedWidth)
            || !isNullableFingerprintArray(result.decodedFrameFingerprints)
            || !isNullableNonNegativeSafeInteger(result.decodedFrameCount)
            || !isNullableNonNegativeSafeInteger(result.decodedByteLength)
            || !isNullableNonNegativeSafeInteger(result.levelIDC)
            || !isNullableNonNegativeSafeInteger(result.measuredFrameCount)
            || !isNullableNonNegativeSafeInteger(result.profileIDC)
            || !isNullableNonNegativeSafeInteger(result.totalDecodedByteLength)
            || (
                result.decodeMilliseconds !== null
                && !isFiniteNonNegativeNumber(result.decodeMilliseconds)
            )
            || (
                result.framesPerSecond !== null
                && !isFiniteNonNegativeNumber(result.framesPerSecond)
            )
            || (
                result.minimumFramesPerSecond !== null
                && !isFiniteNonNegativeNumber(result.minimumFramesPerSecond)
            )
            || (
                result.steadyStateDecodeMilliseconds !== null
                && !isFiniteNonNegativeNumber(result.steadyStateDecodeMilliseconds)
            )
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
                    || result.decodeMilliseconds === null
                    || result.decodedFrameFingerprints === null
                    || result.decodedFrameFingerprints.length
                        !== HEVC_EXACT_CAPABILITY_QUALIFICATION_FRAME_COUNT
                    || result.decodedFrameCount === null
                    || result.decodedByteLength === null
                    || result.framesPerSecond === null
                    || result.levelIDC === null
                    || result.measuredFrameCount === null
                    || result.minimumFramesPerSecond === null
                    || result.profileIDC === null
                    || result.steadyStateDecodeMilliseconds === null
                    || result.totalDecodedByteLength === null
                )
            )
        ) {
            return false;
        }
        seenTiers.add(result.tier);
    }
    return seenTiers.size === HEVC_EXACT_CAPABILITY_TIERS.length;
}
