export const LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID =
    'mpeg2-progressive-main-1920x1080-v1';
export const LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT = 1_080;
export const LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH = 1_920;
export const LEGACY_VIDEO_QUALIFICATION_FRAME_COUNT = 12;
export const LEGACY_VIDEO_QUALIFICATION_WARMUP_FRAME_COUNT = 2;
export const LEGACY_VIDEO_QUALIFICATION_MINIMUM_FRAMES_PER_SECOND = 30;
export const LEGACY_VIDEO_QUALIFICATION_MAXIMUM_FRAMES_PER_SECOND = 24;
export const LEGACY_VIDEO_QUALIFICATION_FRAME_BYTE_LENGTH = 3_110_400;
export const LEGACY_VIDEO_QUALIFICATION_TOTAL_BYTE_LENGTH = 37_324_800;
export const LEGACY_VIDEO_QUALIFICATION_FINGERPRINT = 544_635_241;

export type LegacyVideoExactCapabilityWorkerRequest = {
    decoderGlueURL: string
    decoderWASMURL: string
    fixture: ArrayBuffer
    requestID: typeof LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID
    type: 'probe'
};

export type LegacyVideoExactCapabilityWorkerResponse = {
    codedHeight: number | null
    codedWidth: number | null
    decodeMilliseconds: number | null
    decodedFrameByteLength: number | null
    decodedFrameCount: number | null
    decodedI420Fingerprint: number | null
    decodedTotalByteLength: number | null
    measuredFramesPerSecond: number | null
    reason: 'decode-error' | 'decode-output-verified' | 'output-mismatch' | 'throughput-insufficient'
    requestID: typeof LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID
    supported: boolean
    type: 'result'
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableFiniteNonNegativeNumber(value: unknown): value is number | null {
    return value === null || isFiniteNonNegativeNumber(value);
}

function isSafeNullableInteger(value: unknown): value is number | null {
    return value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
}

function isWorkerReason(
    value: unknown
): value is LegacyVideoExactCapabilityWorkerResponse['reason'] {
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

function isCodecAssetURL(value: unknown): value is string {
    if (typeof value !== 'string' || value.length === 0 || value.length > 2_048) {
        return false;
    }
    try {
        const parsedURL = new URL(value);
        return (parsedURL.protocol === 'http:' || parsedURL.protocol === 'https:')
            && parsedURL.username.length === 0
            && parsedURL.password.length === 0;
    } catch {
        return false;
    }
}

/** Rejects malformed requests before loading the focused executable decoder. */
export function isLegacyVideoExactCapabilityWorkerRequest(
    value: unknown
): value is LegacyVideoExactCapabilityWorkerRequest {
    return isRecord(value)
        && value.type === 'probe'
        && value.requestID === LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID
        && value.fixture instanceof ArrayBuffer
        && value.fixture.byteLength > 0
        && value.fixture.byteLength <= 16 * 1024 * 1024
        && isCodecAssetURL(value.decoderGlueURL)
        && isCodecAssetURL(value.decoderWASMURL);
}

/** Validates all exact-output and throughput evidence returned by the worker. */
export function isLegacyVideoExactCapabilityWorkerResponse(
    value: unknown
): value is LegacyVideoExactCapabilityWorkerResponse {
    return isRecord(value)
        && value.type === 'result'
        && value.requestID === LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID
        && typeof value.supported === 'boolean'
        && isWorkerReason(value.reason)
        && isSafeNullableInteger(value.codedHeight)
        && isSafeNullableInteger(value.codedWidth)
        && isNullableFiniteNonNegativeNumber(value.decodeMilliseconds)
        && isSafeNullableInteger(value.decodedFrameByteLength)
        && isSafeNullableInteger(value.decodedFrameCount)
        && isSafeNullableInteger(value.decodedI420Fingerprint)
        && isSafeNullableInteger(value.decodedTotalByteLength)
        && isNullableFiniteNonNegativeNumber(value.measuredFramesPerSecond);
}
