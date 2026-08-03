export const JPEG2000_QUALIFICATION_CODED_HEIGHT = 540;
export const JPEG2000_QUALIFICATION_CODED_WIDTH = 960;
export const JPEG2000_QUALIFICATION_FRAME_COUNT = 9;
export const JPEG2000_QUALIFICATION_WARMUP_FRAME_COUNT = 1;
export const JPEG2000_QUALIFICATION_MINIMUM_FRAMES_PER_SECOND = 30;
export const JPEG2000_QUALIFICATION_MAXIMUM_FRAMES_PER_SECOND = 24;
export const JPEG2000_QUALIFICATION_RGBA_BYTE_LENGTH = 2_073_600;
export const JPEG2000_QUALIFICATION_RGBA_FINGERPRINT = 1_076_220_778;
export const JPEG2000_EXACT_CAPABILITY_REQUEST_ID = 'jpeg2000-srgb-960x540-v1';

export type JPEG2000ExactCapabilityWorkerRequest = {
    decoderGlueURL: string
    decoderWASMURL: string
    fixture: ArrayBuffer
    requestID: typeof JPEG2000_EXACT_CAPABILITY_REQUEST_ID
    type: 'probe'
};

export type JPEG2000ExactCapabilityWorkerResponse = {
    codedHeight: number | null
    codedWidth: number | null
    decodeMilliseconds: number | null
    decodedRGBAByteLength: number | null
    decodedRGBAFingerprint: number | null
    measuredFramesPerSecond: number | null
    reason: 'decode-error' | 'decode-output-verified' | 'output-mismatch' | 'throughput-insufficient'
    requestID: typeof JPEG2000_EXACT_CAPABILITY_REQUEST_ID
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
): value is JPEG2000ExactCapabilityWorkerResponse['reason'] {
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

/** Rejects malformed probe requests before loading executable codec assets. */
export function isJPEG2000ExactCapabilityWorkerRequest(
    value: unknown
): value is JPEG2000ExactCapabilityWorkerRequest {
    return isRecord(value)
        && value.type === 'probe'
        && value.requestID === JPEG2000_EXACT_CAPABILITY_REQUEST_ID
        && value.fixture instanceof ArrayBuffer
        && value.fixture.byteLength > 0
        && value.fixture.byteLength <= 64 * 1024 * 1024
        && isCodecAssetURL(value.decoderGlueURL)
        && isCodecAssetURL(value.decoderWASMURL);
}

/** Validates every exact-output and throughput field returned by the probe worker. */
export function isJPEG2000ExactCapabilityWorkerResponse(
    value: unknown
): value is JPEG2000ExactCapabilityWorkerResponse {
    return isRecord(value)
        && value.type === 'result'
        && value.requestID === JPEG2000_EXACT_CAPABILITY_REQUEST_ID
        && typeof value.supported === 'boolean'
        && isWorkerReason(value.reason)
        && isSafeNullableInteger(value.codedHeight)
        && isSafeNullableInteger(value.codedWidth)
        && isNullableFiniteNonNegativeNumber(value.decodeMilliseconds)
        && isSafeNullableInteger(value.decodedRGBAByteLength)
        && isSafeNullableInteger(value.decodedRGBAFingerprint)
        && isNullableFiniteNonNegativeNumber(value.measuredFramesPerSecond);
}
