export const TRUEHD_EXACT_CAPABILITY_REQUEST_ID = 'ffmpeg-truehd-mlp-v1';
export const TRUEHD_QUALIFICATION_FIXTURE_COUNT = 4;
export const TRUEHD_QUALIFICATION_CODEC_MASK = 0x03;
export const TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK = (1 << 2) | (1 << 6);
export const TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK = 0x07;
export const TRUEHD_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR = 2;
export const TRUEHD_QUALIFICATION_WARMUP_CYCLE_COUNT = 1;
export const TRUEHD_QUALIFICATION_MEASURED_CYCLE_COUNT = 8;

export type TrueHDExactCapabilityWorkerRequest = Readonly<{
    requestID: typeof TRUEHD_EXACT_CAPABILITY_REQUEST_ID
    type: 'probe'
}>;

export type TrueHDExactCapabilityWorkerReason =
    | 'decode-error'
    | 'decode-output-verified'
    | 'major-sync-recovery-failed'
    | 'output-mismatch'
    | 'throughput-insufficient';

export type TrueHDExactCapabilityWorkerResponse = Readonly<{
    decodeMilliseconds: number | null
    libraryVersion: number | null
    majorSyncRecoveryVerified: boolean
    measuredRealTimeFactor: number | null
    reason: TrueHDExactCapabilityWorkerReason
    requestID: typeof TRUEHD_EXACT_CAPABILITY_REQUEST_ID
    supported: boolean
    type: 'result'
    verifiedChannelCountMask: number
    verifiedCodecMask: number
    verifiedFixtureCount: number
    verifiedSampleRateMask: number
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableFiniteNonNegativeNumber(value: unknown): value is number | null {
    return value === null || isFiniteNonNegativeNumber(value);
}

function isNullablePositiveSafeInteger(value: unknown): value is number | null {
    return value === null || (Number.isSafeInteger(value) && Number(value) > 0);
}

function isWorkerReason(value: unknown): value is TrueHDExactCapabilityWorkerReason {
    switch (value) {
        case 'decode-error':
        case 'decode-output-verified':
        case 'major-sync-recovery-failed':
        case 'output-mismatch':
        case 'throughput-insufficient':
            return true;
        default:
            return false;
    }
}

function isBoundedMask(value: unknown, qualifiedMask: number): value is number {
    return Number.isSafeInteger(value)
        && Number(value) >= 0
        && (Number(value) & ~qualifiedMask) === 0;
}

/** Rejects malformed requests before loading the executable decoder module. */
export function isTrueHDExactCapabilityWorkerRequest(
    value: unknown
): value is TrueHDExactCapabilityWorkerRequest {
    return isRecord(value)
        && value.type === 'probe'
        && value.requestID === TRUEHD_EXACT_CAPABILITY_REQUEST_ID;
}

/** Validates all exact-output, recovery, and throughput evidence. */
export function isTrueHDExactCapabilityWorkerResponse(
    value: unknown
): value is TrueHDExactCapabilityWorkerResponse {
    return isRecord(value)
        && value.type === 'result'
        && value.requestID === TRUEHD_EXACT_CAPABILITY_REQUEST_ID
        && typeof value.supported === 'boolean'
        && typeof value.majorSyncRecoveryVerified === 'boolean'
        && isWorkerReason(value.reason)
        && isNullableFiniteNonNegativeNumber(value.decodeMilliseconds)
        && isNullablePositiveSafeInteger(value.libraryVersion)
        && isNullableFiniteNonNegativeNumber(value.measuredRealTimeFactor)
        && Number.isSafeInteger(value.verifiedFixtureCount)
        && Number(value.verifiedFixtureCount) >= 0
        && Number(value.verifiedFixtureCount) <= TRUEHD_QUALIFICATION_FIXTURE_COUNT
        && isBoundedMask(
            value.verifiedChannelCountMask,
            TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK
        )
        && isBoundedMask(value.verifiedCodecMask, TRUEHD_QUALIFICATION_CODEC_MASK)
        && isBoundedMask(
            value.verifiedSampleRateMask,
            TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK
        );
}
