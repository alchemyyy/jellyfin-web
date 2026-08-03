export const DTS_EXACT_CAPABILITY_REQUEST_ID = 'libdcadec-dts-family-v1';
export const DTS_QUALIFICATION_FIXTURE_COUNT = 7;
export const DTS_QUALIFICATION_PROFILE_MASK = 0x1f;
export const DTS_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR = 2;
export const DTS_QUALIFICATION_WARMUP_CYCLE_COUNT = 1;
export const DTS_QUALIFICATION_MEASURED_CYCLE_COUNT = 8;

export type DTSExactCapabilityWorkerRequest = Readonly<{
    requestID: typeof DTS_EXACT_CAPABILITY_REQUEST_ID
    type: 'probe'
}>;

export type DTSExactCapabilityWorkerReason =
    | 'decode-error'
    | 'decode-output-verified'
    | 'output-mismatch'
    | 'throughput-insufficient';

export type DTSExactCapabilityWorkerResponse = Readonly<{
    decodeMilliseconds: number | null
    libraryVersion: number | null
    measuredRealTimeFactor: number | null
    reason: DTSExactCapabilityWorkerReason
    requestID: typeof DTS_EXACT_CAPABILITY_REQUEST_ID
    supported: boolean
    type: 'result'
    verifiedFixtureCount: number
    verifiedProfileMask: number
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

function isWorkerReason(value: unknown): value is DTSExactCapabilityWorkerReason {
    switch (value) {
        case 'decode-error':
        case 'decode-output-verified':
        case 'output-mismatch':
        case 'throughput-insufficient':
            return true;
        default:
            return false;
    }
}

/** Rejects malformed requests before initializing executable decoder code. */
export function isDTSExactCapabilityWorkerRequest(
    value: unknown
): value is DTSExactCapabilityWorkerRequest {
    return isRecord(value)
        && value.type === 'probe'
        && value.requestID === DTS_EXACT_CAPABILITY_REQUEST_ID;
}

/** Validates every output and throughput field returned by the DTS probe worker. */
export function isDTSExactCapabilityWorkerResponse(
    value: unknown
): value is DTSExactCapabilityWorkerResponse {
    return isRecord(value)
        && value.type === 'result'
        && value.requestID === DTS_EXACT_CAPABILITY_REQUEST_ID
        && typeof value.supported === 'boolean'
        && isWorkerReason(value.reason)
        && isNullableFiniteNonNegativeNumber(value.decodeMilliseconds)
        && isNullablePositiveSafeInteger(value.libraryVersion)
        && isNullableFiniteNonNegativeNumber(value.measuredRealTimeFactor)
        && Number.isSafeInteger(value.verifiedFixtureCount)
        && Number(value.verifiedFixtureCount) >= 0
        && Number(value.verifiedFixtureCount) <= DTS_QUALIFICATION_FIXTURE_COUNT
        && Number.isSafeInteger(value.verifiedProfileMask)
        && Number(value.verifiedProfileMask) >= 0
        && (Number(value.verifiedProfileMask) & ~DTS_QUALIFICATION_PROFILE_MASK) === 0;
}
