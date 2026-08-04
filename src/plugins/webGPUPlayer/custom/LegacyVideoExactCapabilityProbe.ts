import LegacyVideoExactCapabilityProbeWorkerConstructor from
    './LegacyVideoExactCapabilityProbe.worker';
import {
    isLegacyVideoExactCapabilityWorkerResponse,
    LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID,
    LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT,
    LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH,
    LEGACY_VIDEO_QUALIFICATION_FINGERPRINT,
    LEGACY_VIDEO_QUALIFICATION_FRAME_BYTE_LENGTH,
    LEGACY_VIDEO_QUALIFICATION_FRAME_COUNT,
    LEGACY_VIDEO_QUALIFICATION_MAXIMUM_FRAMES_PER_SECOND,
    LEGACY_VIDEO_QUALIFICATION_MINIMUM_FRAMES_PER_SECOND,
    LEGACY_VIDEO_QUALIFICATION_TOTAL_BYTE_LENGTH,
    type LegacyVideoExactCapabilityWorkerRequest,
    type LegacyVideoExactCapabilityWorkerResponse
} from './LegacyVideoExactCapabilityProtocol';

export {
    isLegacyVideoExactCapabilityWorkerRequest,
    isLegacyVideoExactCapabilityWorkerResponse,
    LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID,
    LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT,
    LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH,
    LEGACY_VIDEO_QUALIFICATION_FINGERPRINT,
    LEGACY_VIDEO_QUALIFICATION_FRAME_BYTE_LENGTH,
    LEGACY_VIDEO_QUALIFICATION_FRAME_COUNT,
    LEGACY_VIDEO_QUALIFICATION_MAXIMUM_FRAMES_PER_SECOND,
    LEGACY_VIDEO_QUALIFICATION_MINIMUM_FRAMES_PER_SECOND,
    LEGACY_VIDEO_QUALIFICATION_TOTAL_BYTE_LENGTH,
    LEGACY_VIDEO_QUALIFICATION_WARMUP_FRAME_COUNT,
    type LegacyVideoExactCapabilityWorkerRequest,
    type LegacyVideoExactCapabilityWorkerResponse
} from './LegacyVideoExactCapabilityProtocol';

export const LEGACY_VIDEO_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 5_000;

const LEGACY_VIDEO_DECODER_GLUE_ASSET =
    'libraries/legacy-video/legacy-video-decode.js';
const LEGACY_VIDEO_DECODER_WASM_ASSET =
    'libraries/legacy-video/legacy-video-decode.wasm';
const LEGACY_VIDEO_QUALIFICATION_ASSET =
    'libraries/legacy-video/mpeg2-progressive-1920x1080-qualification.bin';

export type LegacyVideoExactCapabilityReason =
    | 'api-unavailable'
    | 'decode-error'
    | 'decode-output-verified'
    | 'output-mismatch'
    | 'probe-timeout'
    | 'throughput-insufficient'
    | 'worker-create-failed'
    | 'worker-error'
    | 'worker-message-invalid';

export type LegacyVideoExactCapability = Readonly<{
    codec: 'mpeg2video'
    decodeMilliseconds: number | null
    decodedFrameByteLength: number | null
    decodedFrameCount: number | null
    decodedI420Fingerprint: number | null
    decodedTotalByteLength: number | null
    maximumCodedHeight: number
    maximumCodedWidth: number
    maximumFramesPerSecond: 24 | 0
    measuredFramesPerSecond: number | null
    reason: LegacyVideoExactCapabilityReason
    status: 'supported' | 'unsupported' | 'unknown'
}>;

type LegacyVideoExactCapabilityProbeWorkerEventListener = (event: Event) => void;

export type LegacyVideoExactCapabilityProbeWorker = {
    addEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: LegacyVideoExactCapabilityProbeWorkerEventListener
    ) => void
    postMessage: (message: unknown, transfer: Transferable[]) => void
    removeEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: LegacyVideoExactCapabilityProbeWorkerEventListener
    ) => void
    terminate: () => void
};

export type LegacyVideoExactCapabilityProbeEnvironment = Readonly<{
    clearTimeout: (timeout: ReturnType<typeof globalThis.setTimeout>) => void
    createWorker: (() => LegacyVideoExactCapabilityProbeWorker) | null
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

function createDefaultWorker(): LegacyVideoExactCapabilityProbeWorker {
    const worker = new LegacyVideoExactCapabilityProbeWorkerConstructor();
    return worker as unknown as LegacyVideoExactCapabilityProbeWorker;
}

async function loadDefaultFixture(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url, {
        cache: 'force-cache',
        credentials: 'same-origin',
        redirect: 'error'
    });
    if (!response.ok) {
        throw new Error('The exact legacy video qualification fixture request failed');
    }
    return response.arrayBuffer();
}

function createDefaultEnvironment(): LegacyVideoExactCapabilityProbeEnvironment {
    const runtimeAvailable = typeof globalThis.Worker === 'function'
        && typeof globalThis.WebAssembly === 'object'
        && typeof globalThis.fetch === 'function';
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

function responseMatchesQualification(
    response: LegacyVideoExactCapabilityWorkerResponse
): boolean {
    return response.supported
        && response.reason === 'decode-output-verified'
        && response.codedHeight === LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT
        && response.codedWidth === LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH
        && response.decodedFrameByteLength
            === LEGACY_VIDEO_QUALIFICATION_FRAME_BYTE_LENGTH
        && response.decodedFrameCount === LEGACY_VIDEO_QUALIFICATION_FRAME_COUNT
        && response.decodedI420Fingerprint === LEGACY_VIDEO_QUALIFICATION_FINGERPRINT
        && response.decodedTotalByteLength
            === LEGACY_VIDEO_QUALIFICATION_TOTAL_BYTE_LENGTH
        && response.measuredFramesPerSecond !== null
        && response.measuredFramesPerSecond
            >= LEGACY_VIDEO_QUALIFICATION_MINIMUM_FRAMES_PER_SECOND;
}

function createCapability(
    reason: LegacyVideoExactCapabilityReason,
    response: LegacyVideoExactCapabilityWorkerResponse | null = null
): LegacyVideoExactCapability {
    const supported = response !== null && responseMatchesQualification(response);
    let status: LegacyVideoExactCapability['status'];
    if (supported) {
        status = 'supported';
    } else if (reason === 'api-unavailable' || reason === 'probe-timeout') {
        status = 'unknown';
    } else {
        status = 'unsupported';
    }
    const resolvedReason = reason === 'decode-output-verified' && !supported ?
        'output-mismatch' :
        reason;
    return Object.freeze({
        codec: 'mpeg2video',
        decodeMilliseconds: response?.decodeMilliseconds ?? null,
        decodedFrameByteLength: response?.decodedFrameByteLength ?? null,
        decodedFrameCount: response?.decodedFrameCount ?? null,
        decodedI420Fingerprint: response?.decodedI420Fingerprint ?? null,
        decodedTotalByteLength: response?.decodedTotalByteLength ?? null,
        maximumCodedHeight: LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT,
        maximumCodedWidth: LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH,
        maximumFramesPerSecond: supported ?
            LEGACY_VIDEO_QUALIFICATION_MAXIMUM_FRAMES_PER_SECOND :
            0,
        measuredFramesPerSecond: response?.measuredFramesPerSecond ?? null,
        reason: resolvedReason,
        status
    });
}

/** Owns one cached, fail-closed MPEG-2 exact-output and throughput probe. */
export default class LegacyVideoExactCapabilityProbe {
    private cachedProbe: Promise<LegacyVideoExactCapability> | null = null;

    public constructor(
        private readonly environment: LegacyVideoExactCapabilityProbeEnvironment =
        createDefaultEnvironment(),
        private readonly timeoutMilliseconds =
        LEGACY_VIDEO_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS
    ) {
        if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
            throw new TypeError('The exact legacy video capability timeout is invalid');
        }
    }

    /** Returns the same immutable capability result for every call. */
    public probe(): Promise<LegacyVideoExactCapability> {
        this.cachedProbe ??= this.runProbe();
        return this.cachedProbe;
    }

    private runProbe(): Promise<LegacyVideoExactCapability> {
        if (!this.environment.runtimeAvailable || !this.environment.createWorker) {
            return Promise.resolve(createCapability('api-unavailable'));
        }
        let worker: LegacyVideoExactCapabilityProbeWorker;
        try {
            worker = this.environment.createWorker();
        } catch {
            return Promise.resolve(createCapability('worker-create-failed'));
        }

        return new Promise<LegacyVideoExactCapability>((resolve): void => {
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
                    // Ownership ends even if the platform throws during termination
                }
            };
            const settle = (capability: LegacyVideoExactCapability): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(capability);
            };
            const messageHandler: LegacyVideoExactCapabilityProbeWorkerEventListener = (
                event: Event
            ): void => {
                const value = (event as MessageEvent<unknown>).data;
                if (!isLegacyVideoExactCapabilityWorkerResponse(value)) {
                    settle(createCapability('worker-message-invalid'));
                    return;
                }
                settle(createCapability(value.reason, value));
            };
            const errorHandler: LegacyVideoExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createCapability('worker-error'));
            };
            const messageErrorHandler: LegacyVideoExactCapabilityProbeWorkerEventListener =
                (): void => {
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
                        this.environment.resolveAssetURL(LEGACY_VIDEO_QUALIFICATION_ASSET)
                    );
                    if (settled) {
                        return;
                    }
                    const request: LegacyVideoExactCapabilityWorkerRequest = {
                        decoderGlueURL: this.environment.resolveAssetURL(
                            LEGACY_VIDEO_DECODER_GLUE_ASSET
                        ),
                        decoderWASMURL: this.environment.resolveAssetURL(
                            LEGACY_VIDEO_DECODER_WASM_ASSET
                        ),
                        fixture,
                        requestID: LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID,
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

let defaultProbe: LegacyVideoExactCapabilityProbe | null = null;

/** Qualifies and caches the bundled progressive MPEG-2 software route. */
export function probeLegacyVideoExactCapability(): Promise<LegacyVideoExactCapability> {
    defaultProbe ??= new LegacyVideoExactCapabilityProbe();
    return defaultProbe.probe();
}
