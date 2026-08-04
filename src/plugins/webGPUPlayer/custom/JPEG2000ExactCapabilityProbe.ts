import JPEG2000ExactCapabilityProbeWorkerConstructor from './JPEG2000ExactCapabilityProbe.worker';
import {
    isJPEG2000ExactCapabilityWorkerResponse,
    JPEG2000_EXACT_CAPABILITY_REQUEST_ID,
    JPEG2000_QUALIFICATION_CODED_HEIGHT,
    JPEG2000_QUALIFICATION_CODED_WIDTH,
    JPEG2000_QUALIFICATION_MAXIMUM_FRAMES_PER_SECOND,
    JPEG2000_QUALIFICATION_MINIMUM_FRAMES_PER_SECOND,
    JPEG2000_QUALIFICATION_RGBA_BYTE_LENGTH,
    JPEG2000_QUALIFICATION_RGBA_FINGERPRINT,
    type JPEG2000ExactCapabilityWorkerRequest,
    type JPEG2000ExactCapabilityWorkerResponse
} from './JPEG2000ExactCapabilityProtocol';

export {
    isJPEG2000ExactCapabilityWorkerRequest,
    isJPEG2000ExactCapabilityWorkerResponse,
    JPEG2000_EXACT_CAPABILITY_REQUEST_ID,
    JPEG2000_QUALIFICATION_CODED_HEIGHT,
    JPEG2000_QUALIFICATION_CODED_WIDTH,
    JPEG2000_QUALIFICATION_FRAME_COUNT,
    JPEG2000_QUALIFICATION_MAXIMUM_FRAMES_PER_SECOND,
    JPEG2000_QUALIFICATION_MINIMUM_FRAMES_PER_SECOND,
    JPEG2000_QUALIFICATION_RGBA_BYTE_LENGTH,
    JPEG2000_QUALIFICATION_RGBA_FINGERPRINT,
    JPEG2000_QUALIFICATION_WARMUP_FRAME_COUNT,
    type JPEG2000ExactCapabilityWorkerRequest,
    type JPEG2000ExactCapabilityWorkerResponse
} from './JPEG2000ExactCapabilityProtocol';
export const JPEG2000_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 2_000;

const JPEG2000_DECODER_GLUE_ASSET = 'libraries/openjpeg/openjpeg-decode.js';
const JPEG2000_DECODER_WASM_ASSET = 'libraries/openjpeg/openjpeg-decode.wasm';
const JPEG2000_QUALIFICATION_ASSET =
    'libraries/openjpeg/jpeg2000-960x540-qualification.bin';

export type JPEG2000ExactCapabilityReason =
    | 'api-unavailable'
    | 'decode-error'
    | 'decode-output-verified'
    | 'output-mismatch'
    | 'probe-timeout'
    | 'throughput-insufficient'
    | 'worker-create-failed'
    | 'worker-error'
    | 'worker-message-invalid';

export type JPEG2000ExactCapability = Readonly<{
    bitDepth: 8
    codec: 'jpeg2000'
    codecString: 'mjp2'
    decodeMilliseconds: number | null
    decodedRGBAByteLength: number | null
    decodedRGBAFingerprint: number | null
    maximumCodedHeight: number
    maximumCodedWidth: number
    maximumFramesPerSecond: 24 | 0
    measuredFramesPerSecond: number | null
    reason: JPEG2000ExactCapabilityReason
    status: 'supported' | 'unsupported' | 'unknown'
}>;

type JPEG2000ExactCapabilityProbeWorkerEventListener = (event: Event) => void;

export type JPEG2000ExactCapabilityProbeWorker = {
    addEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: JPEG2000ExactCapabilityProbeWorkerEventListener
    ) => void
    postMessage: (message: unknown, transfer: Transferable[]) => void
    removeEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: JPEG2000ExactCapabilityProbeWorkerEventListener
    ) => void
    terminate: () => void
};

export type JPEG2000ExactCapabilityProbeEnvironment = Readonly<{
    clearTimeout: (timeout: ReturnType<typeof globalThis.setTimeout>) => void
    createWorker: (() => JPEG2000ExactCapabilityProbeWorker) | null
    loadFixture: (url: string) => Promise<ArrayBuffer>
    resolveAssetURL: (path: string) => string
    runtimeAvailable: boolean
    setTimeout: (
        callback: () => void,
        milliseconds: number
    ) => ReturnType<typeof globalThis.setTimeout>
}>;

function resolveDefaultAssetURL(path: string): string {
    const locationHref = globalThis.location?.href;
    if (typeof locationHref !== 'string' || locationHref.length === 0) {
        return path;
    }
    return new URL(path, locationHref).href;
}

function createDefaultWorker(): JPEG2000ExactCapabilityProbeWorker {
    const worker = new JPEG2000ExactCapabilityProbeWorkerConstructor();
    return worker as unknown as JPEG2000ExactCapabilityProbeWorker;
}

async function loadDefaultFixture(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url, {
        cache: 'force-cache',
        credentials: 'same-origin',
        redirect: 'error'
    });
    if (!response.ok) {
        throw new Error('The exact JPEG 2000 qualification fixture request failed');
    }
    return response.arrayBuffer();
}

function createDefaultEnvironment(): JPEG2000ExactCapabilityProbeEnvironment {
    // eslint-disable-next-line compat/compat -- The exact capability probe gates this route
    const videoFrameAvailable = typeof globalThis.VideoFrame === 'function';
    const runtimeAvailable = typeof globalThis.Worker === 'function'
        && typeof globalThis.WebAssembly === 'object'
        && typeof globalThis.fetch === 'function'
        && videoFrameAvailable;
    return {
        clearTimeout: (timeout): void => globalThis.clearTimeout(timeout),
        createWorker: runtimeAvailable ? createDefaultWorker : null,
        loadFixture: loadDefaultFixture,
        resolveAssetURL: resolveDefaultAssetURL,
        runtimeAvailable,
        setTimeout: (callback, milliseconds): ReturnType<typeof globalThis.setTimeout> => (
            globalThis.setTimeout(callback, milliseconds)
        )
    };
}

function createCapability(
    reason: JPEG2000ExactCapabilityReason,
    response: JPEG2000ExactCapabilityWorkerResponse | null = null
): JPEG2000ExactCapability {
    const exactOutputMatches = response !== null
        && response.codedHeight === JPEG2000_QUALIFICATION_CODED_HEIGHT
        && response.codedWidth === JPEG2000_QUALIFICATION_CODED_WIDTH
        && response.decodedRGBAByteLength === JPEG2000_QUALIFICATION_RGBA_BYTE_LENGTH
        && response.decodedRGBAFingerprint === JPEG2000_QUALIFICATION_RGBA_FINGERPRINT;
    const exactThroughputMatches = response?.measuredFramesPerSecond !== null
        && response?.measuredFramesPerSecond !== undefined
        && response.measuredFramesPerSecond
            >= JPEG2000_QUALIFICATION_MINIMUM_FRAMES_PER_SECOND;
    const supported = reason === 'decode-output-verified'
        && response?.supported === true
        && exactOutputMatches
        && exactThroughputMatches;
    let status: JPEG2000ExactCapability['status'];
    if (supported) {
        status = 'supported';
    } else if (reason === 'api-unavailable' || reason === 'probe-timeout') {
        status = 'unknown';
    } else {
        status = 'unsupported';
    }
    let resolvedReason = reason;
    if (supported) {
        resolvedReason = 'decode-output-verified';
    } else if (reason === 'decode-output-verified') {
        resolvedReason = 'output-mismatch';
    }
    return Object.freeze({
        bitDepth: 8,
        codec: 'jpeg2000',
        codecString: 'mjp2',
        decodeMilliseconds: response?.decodeMilliseconds ?? null,
        decodedRGBAByteLength: response?.decodedRGBAByteLength ?? null,
        decodedRGBAFingerprint: response?.decodedRGBAFingerprint ?? null,
        maximumCodedHeight: JPEG2000_QUALIFICATION_CODED_HEIGHT,
        maximumCodedWidth: JPEG2000_QUALIFICATION_CODED_WIDTH,
        maximumFramesPerSecond: supported ?
            JPEG2000_QUALIFICATION_MAXIMUM_FRAMES_PER_SECOND :
            0,
        measuredFramesPerSecond: response?.measuredFramesPerSecond ?? null,
        reason: resolvedReason,
        status
    });
}

/** Owns one cached, fail-closed OpenJPEG exact-output and throughput probe. */
export default class JPEG2000ExactCapabilityProbe {
    private cachedProbe: Promise<JPEG2000ExactCapability> | null = null;

    public constructor(
        private readonly environment: JPEG2000ExactCapabilityProbeEnvironment =
        createDefaultEnvironment(),
        private readonly timeoutMilliseconds =
        JPEG2000_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS
    ) {
        if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
            throw new TypeError('The exact JPEG 2000 capability timeout is invalid');
        }
    }

    /** Returns the same immutable capability result for every call. */
    public probe(): Promise<JPEG2000ExactCapability> {
        this.cachedProbe ??= this.runProbe();
        return this.cachedProbe;
    }

    private runProbe(): Promise<JPEG2000ExactCapability> {
        if (!this.environment.runtimeAvailable || !this.environment.createWorker) {
            return Promise.resolve(createCapability('api-unavailable'));
        }
        let worker: JPEG2000ExactCapabilityProbeWorker;
        try {
            worker = this.environment.createWorker();
        } catch {
            return Promise.resolve(createCapability('worker-create-failed'));
        }

        return new Promise<JPEG2000ExactCapability>((resolve): void => {
            let settled = false;
            let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
            const cleanup = (): void => {
                if (timeout !== null) {
                    this.environment.clearTimeout(timeout);
                    timeout = null;
                }
                worker.removeEventListener('message', messageHandler);
                worker.removeEventListener('error', errorHandler);
                worker.removeEventListener('messageerror', messageErrorHandler);
                try {
                    worker.terminate();
                } catch {
                    // Ownership ends even when a platform worker throws during termination
                }
            };
            const settle = (capability: JPEG2000ExactCapability): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(capability);
            };
            const messageHandler: JPEG2000ExactCapabilityProbeWorkerEventListener = (
                event: Event
            ): void => {
                const value = (event as MessageEvent<unknown>).data;
                if (!isJPEG2000ExactCapabilityWorkerResponse(value)) {
                    settle(createCapability('worker-message-invalid'));
                    return;
                }
                settle(createCapability(value.reason, value));
            };
            const errorHandler: JPEG2000ExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createCapability('worker-error'));
            };
            const messageErrorHandler: JPEG2000ExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createCapability('worker-message-invalid'));
            };
            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);
            worker.addEventListener('messageerror', messageErrorHandler);
            timeout = this.environment.setTimeout((): void => {
                settle(createCapability('probe-timeout'));
            }, this.timeoutMilliseconds);

            const loadAndPostRequest = async (): Promise<void> => {
                try {
                    const fixture = await this.environment.loadFixture(
                        this.environment.resolveAssetURL(JPEG2000_QUALIFICATION_ASSET)
                    );
                    if (settled) {
                        return;
                    }
                    const request: JPEG2000ExactCapabilityWorkerRequest = {
                        decoderGlueURL: this.environment.resolveAssetURL(
                            JPEG2000_DECODER_GLUE_ASSET
                        ),
                        decoderWASMURL: this.environment.resolveAssetURL(
                            JPEG2000_DECODER_WASM_ASSET
                        ),
                        fixture,
                        requestID: JPEG2000_EXACT_CAPABILITY_REQUEST_ID,
                        type: 'probe'
                    };
                    worker.postMessage(request, [ fixture ]);
                } catch {
                    settle(createCapability('worker-error'));
                }
            };
            void loadAndPostRequest();
        });
    }
}

let defaultProbe: JPEG2000ExactCapabilityProbe | null = null;

/** Qualifies and caches the pinned OpenJPEG software route. */
export function probeJPEG2000ExactCapability(): Promise<JPEG2000ExactCapability> {
    defaultProbe ??= new JPEG2000ExactCapabilityProbe();
    return defaultProbe.probe();
}
