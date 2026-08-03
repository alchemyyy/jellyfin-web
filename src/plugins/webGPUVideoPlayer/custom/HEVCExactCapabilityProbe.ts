import HEVCExactCapabilityProbeWorkerConstructor from './HEVCExactCapabilityProbe.worker';
import { createHEVCExactCapabilityWorkerTierRequests } from './HEVCExactCapabilityFixtures';
import {
    HEVC_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS,
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    HEVC_EXACT_CAPABILITY_TIERS,
    HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS,
    isHEVCExactCapabilityWorkerResponse,
    type HEVCExactCapabilityTier,
    type HEVCExactCapabilityTierDefinition,
    type HEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerResponse,
    type HEVCExactCapabilityWorkerTierReason,
    type HEVCExactCapabilityWorkerTierResult
} from './HEVCExactCapabilityProtocol';

const HEVC_DECODER_GLUE_ASSET = 'libraries/hevcjs/hevc-decode.js';
const HEVC_DECODER_WASM_ASSET = 'libraries/hevcjs/hevc-decode.wasm';
const HEVC_MAIN10_4K_QUALIFICATION_ASSET =
    'libraries/hevcjs/main10-4k-qualification.bin';

export type BundledHEVCExactCapabilityStatus = 'supported' | 'unsupported';
export type BundledHEVCExactCapabilityReason =
    | HEVCExactCapabilityWorkerTierReason
    | 'api-unavailable'
    | 'probe-timeout'
    | 'worker-create-failed'
    | 'worker-error'
    | 'worker-message-invalid';

export type BundledHEVCExactTierCapability = Readonly<{
    bitDepth: 8 | 10
    codecString: HEVCExactCapabilityTierDefinition['codecString']
    decodeMilliseconds: number | null
    decodedFrameFingerprints?: readonly number[] | null
    decodedFrameCount?: number | null
    format: HEVCExactCapabilityTierDefinition['format']
    framesPerSecond?: number | null
    maximumCodedHeight: number
    maximumCodedWidth: number
    maximumLevel: number
    measuredFrameCount?: number | null
    minimumFramesPerSecond?: number
    profile: HEVCExactCapabilityTierDefinition['profile']
    qualificationFrameCount?: number
    reason: BundledHEVCExactCapabilityReason
    steadyStateDecodeMilliseconds?: number | null
    status: BundledHEVCExactCapabilityStatus
    tier: HEVCExactCapabilityTier
    totalDecodedByteLength?: number | null
    warmupFrameCount?: number
}>;

export type BundledHEVCExactCapabilities = Readonly<{
    reason: 'complete' | 'failed' | 'partial' | 'unavailable'
    tiers: Readonly<Record<HEVCExactCapabilityTier, BundledHEVCExactTierCapability>>
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

function getExpectedDecodedByteLength(definition: HEVCExactCapabilityTierDefinition): number {
    const chromaWidth = Math.ceil(definition.codedWidth / 2);
    const chromaHeight = Math.ceil(definition.codedHeight / 2);
    return (
        (definition.codedWidth * definition.codedHeight)
        + (2 * chromaWidth * chromaHeight)
    ) * Uint16Array.BYTES_PER_ELEMENT;
}

function createTierCapability(
    definition: HEVCExactCapabilityTierDefinition,
    reason: BundledHEVCExactCapabilityReason,
    result: HEVCExactCapabilityWorkerTierResult | null = null
): BundledHEVCExactTierCapability {
    return Object.freeze({
        bitDepth: definition.bitDepth,
        codecString: definition.codecString,
        decodeMilliseconds: result?.decodeMilliseconds ?? null,
        decodedFrameFingerprints: result?.decodedFrameFingerprints ?? null,
        decodedFrameCount: result?.decodedFrameCount ?? null,
        format: definition.format,
        framesPerSecond: result?.framesPerSecond ?? null,
        maximumCodedHeight: definition.codedHeight,
        maximumCodedWidth: definition.codedWidth,
        maximumLevel: definition.levelIDC,
        measuredFrameCount: result?.measuredFrameCount ?? null,
        minimumFramesPerSecond: definition.minimumFramesPerSecond,
        profile: definition.profile,
        qualificationFrameCount: definition.qualificationFrameCount,
        reason,
        steadyStateDecodeMilliseconds: result?.steadyStateDecodeMilliseconds ?? null,
        status: reason === 'decode-output-verified' ? 'supported' : 'unsupported',
        tier: definition.tier,
        totalDecodedByteLength: result?.totalDecodedByteLength ?? null,
        warmupFrameCount: definition.warmupFrameCount
    });
}

function createCapabilities(
    capabilities: readonly BundledHEVCExactTierCapability[],
    unavailable = false
): BundledHEVCExactCapabilities {
    const mainCapability = capabilities.find(
        capability => capability.tier === 'main-1080p'
    );
    const main10FullHDCapability = capabilities.find(
        capability => capability.tier === 'main10-1080p'
    );
    const main10Capability = capabilities.find(
        capability => capability.tier === 'main10-4k'
    );
    if (!mainCapability || !main10FullHDCapability || !main10Capability) {
        throw new TypeError('An exact HEVC capability tier result is missing');
    }
    const tiers = Object.freeze({
        'main-1080p': mainCapability,
        'main10-1080p': main10FullHDCapability,
        'main10-4k': main10Capability
    });
    const supportedCount = capabilities.filter(
        capability => capability.status === 'supported'
    ).length;
    let reason: BundledHEVCExactCapabilities['reason'];
    if (unavailable) {
        reason = 'unavailable';
    } else if (supportedCount === capabilities.length) {
        reason = 'complete';
    } else if (supportedCount > 0) {
        reason = 'partial';
    } else {
        reason = 'failed';
    }
    return Object.freeze({ reason, tiers });
}

function createUniformFailureCapabilities(
    reason: Exclude<BundledHEVCExactCapabilityReason, HEVCExactCapabilityWorkerTierReason>
): BundledHEVCExactCapabilities {
    const capabilities: BundledHEVCExactTierCapability[] = [];
    for (const tier of HEVC_EXACT_CAPABILITY_TIERS) {
        capabilities.push(createTierCapability(
            HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS[tier],
            reason
        ));
    }
    return createCapabilities(capabilities, reason === 'api-unavailable');
}

function workerResultMatchesDefinition(
    result: HEVCExactCapabilityWorkerTierResult,
    definition: HEVCExactCapabilityTierDefinition
): boolean {
    return result.supported
        && result.reason === 'decode-output-verified'
        && result.bitDepth === definition.bitDepth
        && result.chromaHeight === Math.ceil(definition.codedHeight / 2)
        && result.chromaWidth === Math.ceil(definition.codedWidth / 2)
        && result.codedHeight === definition.codedHeight
        && result.codedWidth === definition.codedWidth
        && result.decodeMilliseconds !== null
        && result.decodeMilliseconds <= definition.maximumDecodeMilliseconds
        && result.decodedFrameFingerprints !== null
        && result.decodedFrameFingerprints.length
            === definition.decodedFrameFingerprints.length
        && result.decodedFrameFingerprints.every((fingerprint, frameIndex) => (
            fingerprint === definition.decodedFrameFingerprints[frameIndex]
        ))
        && result.decodedFrameCount === definition.qualificationFrameCount
        && result.decodedByteLength === getExpectedDecodedByteLength(definition)
        && result.framesPerSecond !== null
        && result.framesPerSecond >= definition.minimumFramesPerSecond
        && result.levelIDC === definition.levelIDC
        && result.measuredFrameCount === definition.qualificationFrameCount
            - definition.warmupFrameCount
        && result.minimumFramesPerSecond === definition.minimumFramesPerSecond
        && result.profileIDC === definition.profileIDC
        && result.steadyStateDecodeMilliseconds !== null
        && result.steadyStateDecodeMilliseconds > 0
        && result.totalDecodedByteLength === getExpectedDecodedByteLength(definition)
            * definition.qualificationFrameCount;
}

function createCapabilitiesFromResponse(
    response: HEVCExactCapabilityWorkerResponse
): BundledHEVCExactCapabilities {
    const capabilities: BundledHEVCExactTierCapability[] = [];
    for (const tier of HEVC_EXACT_CAPABILITY_TIERS) {
        const definition = HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS[tier];
        const result = response.results.find(candidate => candidate.tier === tier);
        if (!result) {
            return createUniformFailureCapabilities('worker-message-invalid');
        }
        if (result.supported && !workerResultMatchesDefinition(result, definition)) {
            capabilities.push(createTierCapability(definition, 'output-mismatch', result));
            continue;
        }
        capabilities.push(createTierCapability(
            definition,
            result.reason,
            result
        ));
    }
    return createCapabilities(capabilities);
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
                    const tiers = createHEVCExactCapabilityWorkerTierRequests(
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
                        tiers,
                        type: 'probe'
                    };
                    const transfer: Transferable[] = [];
                    for (const tier of tiers) {
                        transfer.push(tier.accessUnit);
                        transfer.push(...tier.qualificationAccessUnits);
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

/** Qualifies and caches exact bundled HEVC tiers for production capability routing. */
export function probeBundledHEVCExactCapabilities(): Promise<BundledHEVCExactCapabilities> {
    defaultProbe ??= new BundledHEVCExactCapabilityProbe();
    return defaultProbe.probe();
}
