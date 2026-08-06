import LegacyVideoExactCapabilityProbeWorkerConstructor from
    './LegacyVideoExactCapabilityProbe.worker';
import {
    getLegacyVideoQualification,
    isLegacyVideoExactCapabilityWorkerResponse,
    LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID,
    VC1_EXACT_CAPABILITY_REQUEST_ID,
    type LegacyVideoCodec,
    type LegacyVideoExactCapabilityWorkerRequest,
    type LegacyVideoExactCapabilityWorkerResponse,
    type LegacyVideoQualification
} from './LegacyVideoExactCapabilityProtocol';

export {
    isLegacyVideoExactCapabilityWorkerRequest,
    isLegacyVideoExactCapabilityWorkerResponse,
    getLegacyVideoQualification,
    LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID,
    LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT,
    LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH,
    LEGACY_VIDEO_QUALIFICATION_FINGERPRINT,
    LEGACY_VIDEO_QUALIFICATION_FRAME_BYTE_LENGTH,
    LEGACY_VIDEO_QUALIFICATION_FRAME_COUNT,
    LEGACY_VIDEO_QUALIFICATION_TOTAL_BYTE_LENGTH,
    VC1_EXACT_CAPABILITY_REQUEST_ID,
    VC1_VIDEO_QUALIFICATION_FINGERPRINT,
    type LegacyVideoCodec,
    type LegacyVideoQualification,
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
const VC1_VIDEO_QUALIFICATION_ASSET =
    'libraries/legacy-video/vc1-advanced-progressive-1920x1080-qualification.bin';

export type LegacyVideoExactCapabilityReason =
    | 'api-unavailable'
    | 'decode-error'
    | 'decode-output-verified'
    | 'output-mismatch'
    | 'probe-timeout'
    | 'worker-create-failed'
    | 'worker-error'
    | 'worker-message-invalid';

export type LegacyVideoExactCapability = Readonly<{
    codec: LegacyVideoCodec
    decodedFrameByteLength: number | null
    decodedFrameCount: number | null
    decodedI420Fingerprint: number | null
    decodedTotalByteLength: number | null
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
    response: LegacyVideoExactCapabilityWorkerResponse,
    qualification: LegacyVideoQualification
): boolean {
    return response.supported
        && response.reason === 'decode-output-verified'
        && response.requestID === qualification.requestID
        && response.codedHeight === qualification.codedHeight
        && response.codedWidth === qualification.codedWidth
        && response.decodedFrameByteLength === qualification.frameByteLength
        && response.decodedFrameCount === qualification.frameCount
        && response.decodedI420Fingerprint === qualification.fingerprint
        && response.decodedTotalByteLength === qualification.totalByteLength;
}

function createCapability(
    reason: LegacyVideoExactCapabilityReason,
    qualification: LegacyVideoQualification,
    response: LegacyVideoExactCapabilityWorkerResponse | null = null
): LegacyVideoExactCapability {
    const supported = response !== null
        && responseMatchesQualification(response, qualification);
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
        codec: qualification.codec,
        decodedFrameByteLength: response?.decodedFrameByteLength ?? null,
        decodedFrameCount: response?.decodedFrameCount ?? null,
        decodedI420Fingerprint: response?.decodedI420Fingerprint ?? null,
        decodedTotalByteLength: response?.decodedTotalByteLength ?? null,
        reason: resolvedReason,
        status
    });
}

/** Owns one cached, fail-closed MPEG-2 exact-output probe. */
export default class LegacyVideoExactCapabilityProbe {
    private cachedProbe: Promise<LegacyVideoExactCapability> | null = null;
    private readonly qualification: LegacyVideoQualification;

    public constructor(
        private readonly environment: LegacyVideoExactCapabilityProbeEnvironment =
        createDefaultEnvironment(),
        private readonly timeoutMilliseconds =
        LEGACY_VIDEO_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS,
        codec: LegacyVideoCodec = 'mpeg2video'
    ) {
        if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
            throw new TypeError('The exact legacy video capability timeout is invalid');
        }
        this.qualification = getLegacyVideoQualification(
            codec === 'vc1' ?
                VC1_EXACT_CAPABILITY_REQUEST_ID :
                LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID
        );
    }

    /** Returns the same immutable capability result for every call. */
    public probe(): Promise<LegacyVideoExactCapability> {
        this.cachedProbe ??= this.runProbe();
        return this.cachedProbe;
    }

    private runProbe(): Promise<LegacyVideoExactCapability> {
        if (!this.environment.runtimeAvailable || !this.environment.createWorker) {
            return Promise.resolve(createCapability('api-unavailable', this.qualification));
        }
        let worker: LegacyVideoExactCapabilityProbeWorker;
        try {
            worker = this.environment.createWorker();
        } catch {
            return Promise.resolve(createCapability(
                'worker-create-failed',
                this.qualification
            ));
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
                if (
                    !isLegacyVideoExactCapabilityWorkerResponse(value)
                    || value.requestID !== this.qualification.requestID
                ) {
                    settle(createCapability(
                        'worker-message-invalid',
                        this.qualification
                    ));
                    return;
                }
                settle(createCapability(value.reason, this.qualification, value));
            };
            const errorHandler: LegacyVideoExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createCapability('worker-error', this.qualification));
            };
            const messageErrorHandler: LegacyVideoExactCapabilityProbeWorkerEventListener =
                (): void => {
                    settle(createCapability(
                        'worker-message-invalid',
                        this.qualification
                    ));
                };
            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);
            worker.addEventListener('messageerror', messageErrorHandler);
            timeout = this.environment.setTimeout((): void => {
                settle(createCapability('probe-timeout', this.qualification));
            }, this.timeoutMilliseconds);

            const loadAndPostRequest = async (): Promise<void> => {
                try {
                    const fixture = await this.environment.loadFixture(
                        this.environment.resolveAssetURL(
                            this.qualification.codec === 'vc1' ?
                                VC1_VIDEO_QUALIFICATION_ASSET :
                                LEGACY_VIDEO_QUALIFICATION_ASSET
                        )
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
                        requestID: this.qualification.requestID,
                        type: 'probe'
                    };
                    worker.postMessage(request, [ fixture ]);
                } catch {
                    settle(createCapability('worker-error', this.qualification));
                }
            };
            void loadAndPostRequest();
        });
    }
}

let defaultProbe: LegacyVideoExactCapabilityProbe | null = null;
let defaultVC1Probe: LegacyVideoExactCapabilityProbe | null = null;

/** Qualifies and caches the bundled progressive MPEG-2 software route. */
export function probeLegacyVideoExactCapability(): Promise<LegacyVideoExactCapability> {
    defaultProbe ??= new LegacyVideoExactCapabilityProbe();
    return defaultProbe.probe();
}

/** Qualifies and caches the bundled progressive Advanced VC-1 software route. */
export function probeVC1ExactCapability(): Promise<LegacyVideoExactCapability> {
    defaultVC1Probe ??= new LegacyVideoExactCapabilityProbe(
        createDefaultEnvironment(),
        LEGACY_VIDEO_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS,
        'vc1'
    );
    return defaultVC1Probe.probe();
}
