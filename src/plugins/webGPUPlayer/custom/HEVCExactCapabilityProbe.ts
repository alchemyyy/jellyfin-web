import HEVCExactCapabilityProbeWorkerConstructor from './HEVCExactCapabilityProbe.worker';
import {
    createHEVCExactCapabilityWorkerQualificationRequests
} from './HEVCExactCapabilityFixtures';
import {
    HEVC_EXACT_CAPABILITY_FIXTURES,
    HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS,
    HEVC_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS,
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    isHEVCExactCapabilityWorkerResponse,
    type HEVCExactCapabilityFixture,
    type HEVCExactCapabilityFixtureDefinition,
    type HEVCExactCapabilityWorkerQualificationReason,
    type HEVCExactCapabilityWorkerQualificationResult,
    type HEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerResponse
} from './HEVCExactCapabilityProtocol';

const HEVC_DECODER_GLUE_ASSET = 'libraries/hevcjs/hevc-decode.js';
const HEVC_DECODER_WASM_ASSET = 'libraries/hevcjs/hevc-decode.wasm';
const HEVC_MAIN10_4K_QUALIFICATION_ASSET =
    'libraries/hevcjs/main10-4k-qualification.bin';

export type BundledHEVCExactCapabilityStatus = 'supported' | 'unsupported';
export type BundledHEVCExactCapabilityReason =
    | HEVCExactCapabilityWorkerQualificationReason
    | 'api-unavailable'
    | 'probe-timeout'
    | 'worker-create-failed'
    | 'worker-error'
    | 'worker-message-invalid';

export type BundledHEVCExactQualification = Readonly<{
    bitDepth: 8 | 10
    codecString: HEVCExactCapabilityFixtureDefinition['codecString']
    decodedFrameFingerprints?: readonly number[] | null
    decodedFrameCount?: number | null
    fixture: HEVCExactCapabilityFixture
    format: HEVCExactCapabilityFixtureDefinition['format']
    profile: HEVCExactCapabilityFixtureDefinition['profile']
    qualificationFrameCount?: number
    reason: BundledHEVCExactCapabilityReason
    status: BundledHEVCExactCapabilityStatus
    totalDecodedByteLength?: number | null
}>;

export type BundledHEVCExactCapabilities = Readonly<{
    qualifications: Readonly<Record<
        HEVCExactCapabilityFixture,
        BundledHEVCExactQualification
    >>
    reason: 'complete' | 'failed' | 'partial' | 'unavailable'
}>;

type HEVCExactCapabilityProbeWorkerEventListener = (event: Event) => void;

export type HEVCExactCapabilityProbeWorker = {
    addEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: HEVCExactCapabilityProbeWorkerEventListener
    ) => void
    postMessage: (message: unknown, transfer: Transferable[]) => void
    removeEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: HEVCExactCapabilityProbeWorkerEventListener
    ) => void
    terminate: () => void
};

export type HEVCExactCapabilityProbeEnvironment = Readonly<{
    clearTimeout: (timeout: ReturnType<typeof globalThis.setTimeout>) => void
    createWorker: (() => HEVCExactCapabilityProbeWorker) | null
    loadQualificationBitstream: (url: string) => Promise<ArrayBuffer>
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

function createDefaultWorker(): HEVCExactCapabilityProbeWorker {
    const worker = new HEVCExactCapabilityProbeWorkerConstructor();
    return worker as unknown as HEVCExactCapabilityProbeWorker;
}

async function loadDefaultQualificationBitstream(url: string): Promise<ArrayBuffer> {
    const response = await fetch(url, {
        cache: 'force-cache',
        credentials: 'same-origin',
        redirect: 'error'
    });
    if (!response.ok) {
        throw new Error('The exact HEVC qualification fixture request failed');
    }
    return response.arrayBuffer();
}

function createDefaultEnvironment(): HEVCExactCapabilityProbeEnvironment {
    const runtimeAvailable = typeof globalThis.Worker === 'function'
        && typeof globalThis.WebAssembly === 'object'
        && typeof globalThis.atob === 'function'
        && typeof globalThis.fetch === 'function';
    return {
        clearTimeout: (timeout): void => globalThis.clearTimeout(timeout),
        createWorker: runtimeAvailable ? createDefaultWorker : null,
        loadQualificationBitstream: loadDefaultQualificationBitstream,
        resolveAssetURL: resolveDefaultAssetURL,
        runtimeAvailable,
        setTimeout: (callback, milliseconds): ReturnType<typeof globalThis.setTimeout> => (
            globalThis.setTimeout(callback, milliseconds)
        )
    };
}

function getExpectedDecodedByteLength(
    definition: HEVCExactCapabilityFixtureDefinition
): number {
    const chromaWidth = Math.ceil(definition.codedWidth / 2);
    const chromaHeight = Math.ceil(definition.codedHeight / 2);
    return (
        (definition.codedWidth * definition.codedHeight)
        + (2 * chromaWidth * chromaHeight)
    ) * Uint16Array.BYTES_PER_ELEMENT;
}

function createQualification(
    definition: HEVCExactCapabilityFixtureDefinition,
    reason: BundledHEVCExactCapabilityReason,
    result: HEVCExactCapabilityWorkerQualificationResult | null = null
): BundledHEVCExactQualification {
    return Object.freeze({
        bitDepth: definition.bitDepth,
        codecString: definition.codecString,
        decodedFrameFingerprints: result?.decodedFrameFingerprints ?? null,
        decodedFrameCount: result?.decodedFrameCount ?? null,
        fixture: definition.fixture,
        format: definition.format,
        profile: definition.profile,
        qualificationFrameCount: definition.qualificationFrameCount,
        reason,
        status: reason === 'decode-output-verified' ? 'supported' : 'unsupported',
        totalDecodedByteLength: result?.totalDecodedByteLength ?? null
    });
}

function createCapabilities(
    qualificationResults: readonly BundledHEVCExactQualification[],
    unavailable = false
): BundledHEVCExactCapabilities {
    const mainQualification = qualificationResults.find(
        qualification => qualification.fixture === 'main-1080p'
    );
    const main10FullHDQualification = qualificationResults.find(
        qualification => qualification.fixture === 'main10-1080p'
    );
    const main10UltraHDQualification = qualificationResults.find(
        qualification => qualification.fixture === 'main10-4k'
    );
    if (
        !mainQualification
        || !main10FullHDQualification
        || !main10UltraHDQualification
    ) {
        throw new TypeError('An exact HEVC qualification result is missing');
    }
    const qualifications = Object.freeze({
        'main-1080p': mainQualification,
        'main10-1080p': main10FullHDQualification,
        'main10-4k': main10UltraHDQualification
    });
    const supportedCount = qualificationResults.filter(
        qualification => qualification.status === 'supported'
    ).length;
    let reason: BundledHEVCExactCapabilities['reason'];
    if (unavailable) {
        reason = 'unavailable';
    } else if (supportedCount === qualificationResults.length) {
        reason = 'complete';
    } else if (supportedCount > 0) {
        reason = 'partial';
    } else {
        reason = 'failed';
    }
    return Object.freeze({ qualifications, reason });
}

function createUniformFailureCapabilities(
    reason: Exclude<
        BundledHEVCExactCapabilityReason,
        HEVCExactCapabilityWorkerQualificationReason
    >
): BundledHEVCExactCapabilities {
    const qualifications: BundledHEVCExactQualification[] = [];
    for (const fixture of HEVC_EXACT_CAPABILITY_FIXTURES) {
        qualifications.push(createQualification(
            HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS[fixture],
            reason
        ));
    }
    return createCapabilities(qualifications, reason === 'api-unavailable');
}

function workerResultMatchesDefinition(
    result: HEVCExactCapabilityWorkerQualificationResult,
    definition: HEVCExactCapabilityFixtureDefinition
): boolean {
    return result.supported
        && result.reason === 'decode-output-verified'
        && result.bitDepth === definition.bitDepth
        && result.chromaHeight === Math.ceil(definition.codedHeight / 2)
        && result.chromaWidth === Math.ceil(definition.codedWidth / 2)
        && result.codedHeight === definition.codedHeight
        && result.codedWidth === definition.codedWidth
        && result.decodedFrameFingerprints !== null
        && result.decodedFrameFingerprints.length
            === definition.decodedFrameFingerprints.length
        && result.decodedFrameFingerprints.every((fingerprint, frameIndex) => (
            fingerprint === definition.decodedFrameFingerprints[frameIndex]
        ))
        && result.decodedFrameCount === definition.qualificationFrameCount
        && result.decodedByteLength === getExpectedDecodedByteLength(definition)
        && result.levelIDC === definition.levelIDC
        && result.profileIDC === definition.profileIDC
        && result.totalDecodedByteLength === getExpectedDecodedByteLength(definition)
            * definition.qualificationFrameCount;
}

function createCapabilitiesFromResponse(
    response: HEVCExactCapabilityWorkerResponse
): BundledHEVCExactCapabilities {
    const qualifications: BundledHEVCExactQualification[] = [];
    for (const fixture of HEVC_EXACT_CAPABILITY_FIXTURES) {
        const definition = HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS[fixture];
        const result = response.results.find(candidate => candidate.fixture === fixture);
        if (!result) {
            return createUniformFailureCapabilities('worker-message-invalid');
        }
        if (result.supported && !workerResultMatchesDefinition(result, definition)) {
            qualifications.push(createQualification(
                definition,
                'output-mismatch',
                result
            ));
            continue;
        }
        qualifications.push(createQualification(
            definition,
            result.reason,
            result
        ));
    }
    return createCapabilities(qualifications);
}

/** Owns one cached, fail-closed exact bundled HEVC capability qualification. */
export class BundledHEVCExactCapabilityProbe {
    private cachedProbe: Promise<BundledHEVCExactCapabilities> | null = null;

    public constructor(
        private readonly environment: HEVCExactCapabilityProbeEnvironment =
        createDefaultEnvironment(),
        private readonly timeoutMilliseconds =
        HEVC_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS
    ) {
        if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
            throw new TypeError('The exact HEVC capability timeout is invalid');
        }
    }

    /** Returns the same immutable result promise for all calls in this runtime. */
    public probe(): Promise<BundledHEVCExactCapabilities> {
        this.cachedProbe ??= this.runProbe();
        return this.cachedProbe;
    }

    private runProbe(): Promise<BundledHEVCExactCapabilities> {
        if (!this.environment.runtimeAvailable || !this.environment.createWorker) {
            return Promise.resolve(createUniformFailureCapabilities('api-unavailable'));
        }

        let worker: HEVCExactCapabilityProbeWorker;
        try {
            worker = this.environment.createWorker();
        } catch {
            return Promise.resolve(createUniformFailureCapabilities('worker-create-failed'));
        }

        return new Promise<BundledHEVCExactCapabilities>((resolve): void => {
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
            const settle = (capabilities: BundledHEVCExactCapabilities): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(capabilities);
            };
            const messageHandler: HEVCExactCapabilityProbeWorkerEventListener = (
                event: Event
            ): void => {
                const value = (event as MessageEvent<unknown>).data;
                if (!isHEVCExactCapabilityWorkerResponse(value)) {
                    settle(createUniformFailureCapabilities('worker-message-invalid'));
                    return;
                }
                settle(createCapabilitiesFromResponse(value));
            };
            const errorHandler: HEVCExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createUniformFailureCapabilities('worker-error'));
            };
            const messageErrorHandler: HEVCExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createUniformFailureCapabilities('worker-message-invalid'));
            };

            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);
            worker.addEventListener('messageerror', messageErrorHandler);
            timeout = this.environment.setTimeout((): void => {
                settle(createUniformFailureCapabilities('probe-timeout'));
            }, this.timeoutMilliseconds);

            const loadAndPostRequest = async (): Promise<void> => {
                try {
                    const qualificationBitstream =
                        await this.environment.loadQualificationBitstream(
                            this.environment.resolveAssetURL(
                                HEVC_MAIN10_4K_QUALIFICATION_ASSET
                            )
                        );
                    if (settled) {
                        return;
                    }
                    const qualifications =
                        createHEVCExactCapabilityWorkerQualificationRequests(
                            qualificationBitstream
                        );
                    const request: HEVCExactCapabilityWorkerRequest = {
                        decoderGlueURL: this.environment.resolveAssetURL(
                            HEVC_DECODER_GLUE_ASSET
                        ),
                        decoderWASMURL: this.environment.resolveAssetURL(
                            HEVC_DECODER_WASM_ASSET
                        ),
                        requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
                        qualifications,
                        type: 'probe'
                    };
                    const transfer: Transferable[] = [];
                    for (const qualification of qualifications) {
                        transfer.push(qualification.accessUnit);
                        transfer.push(...qualification.qualificationAccessUnits);
                    }
                    worker.postMessage(request, transfer);
                } catch {
                    settle(createUniformFailureCapabilities('worker-error'));
                }
            };
            void loadAndPostRequest();
        });
    }
}

let defaultProbe: BundledHEVCExactCapabilityProbe | null = null;

/** Qualifies and caches exact bundled HEVC output fixtures. */
export function probeBundledHEVCExactCapabilities(): Promise<BundledHEVCExactCapabilities> {
    defaultProbe ??= new BundledHEVCExactCapabilityProbe();
    return defaultProbe.probe();
}
