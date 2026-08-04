import DTSExactCapabilityProbeWorkerConstructor from './DTSExactCapabilityProbe.worker';
import {
    DTS_EXACT_CAPABILITY_REQUEST_ID,
    DTS_QUALIFICATION_FIXTURE_COUNT,
    DTS_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR,
    DTS_QUALIFICATION_PROFILE_MASK,
    isDTSExactCapabilityWorkerResponse,
    type DTSExactCapabilityWorkerRequest,
    type DTSExactCapabilityWorkerResponse
} from './DTSExactCapabilityProtocol';

export const DTS_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 4_000;
const DTS_QUALIFIED_PROFILES = Object.freeze([
    'core',
    'core-96-24',
    'es',
    'hd-hra',
    'hd-ma'
] as const);
const DTS_QUALIFIED_SAMPLE_RATES = Object.freeze([ 48_000, 96_000, 192_000 ] as const);

export type DTSExactCapabilityReason =
    | 'api-unavailable'
    | DTSExactCapabilityWorkerResponse['reason']
    | 'probe-timeout'
    | 'worker-create-failed'
    | 'worker-error'
    | 'worker-message-invalid';

export type DTSExactCapability = Readonly<{
    channelBedOnly: true
    codec: 'dts'
    codecString: 'dts'
    decodeMilliseconds: number | null
    libraryVersion: number | null
    maximumChannelCount: 8
    measuredRealTimeFactor: number | null
    objectAudioRendered: false
    profiles: readonly [ 'core', 'core-96-24', 'es', 'hd-hra', 'hd-ma' ]
    reason: DTSExactCapabilityReason
    sampleRates: readonly [ 48_000, 96_000, 192_000 ]
    status: 'supported' | 'unsupported' | 'unknown'
    verifiedFixtureCount: number
    verifiedProfileMask: number
}>;

type DTSExactCapabilityProbeWorkerEventListener = (event: Event) => void;

export type DTSExactCapabilityProbeWorker = {
    addEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: DTSExactCapabilityProbeWorkerEventListener
    ) => void
    postMessage: (message: unknown) => void
    removeEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: DTSExactCapabilityProbeWorkerEventListener
    ) => void
    terminate: () => void
};

export type DTSExactCapabilityProbeEnvironment = Readonly<{
    clearTimeout: (timeout: ReturnType<typeof globalThis.setTimeout>) => void
    createWorker: (() => DTSExactCapabilityProbeWorker) | null
    runtimeAvailable: boolean
    setTimeout: (
        callback: () => void,
        milliseconds: number
    ) => ReturnType<typeof globalThis.setTimeout>
}>;

function createDefaultWorker(): DTSExactCapabilityProbeWorker {
    const worker = new DTSExactCapabilityProbeWorkerConstructor();
    return worker as unknown as DTSExactCapabilityProbeWorker;
}

function createDefaultEnvironment(): DTSExactCapabilityProbeEnvironment {
    const runtimeAvailable = typeof globalThis.Worker === 'function'
        && typeof globalThis.WebAssembly === 'object'
        && typeof globalThis.atob === 'function';
    return {
        clearTimeout: timeout => globalThis.clearTimeout(timeout),
        createWorker: runtimeAvailable ? createDefaultWorker : null,
        runtimeAvailable,
        setTimeout: (callback, milliseconds): ReturnType<typeof globalThis.setTimeout> => (
            globalThis.setTimeout(callback, milliseconds)
        )
    };
}

function createCapability(
    reason: DTSExactCapabilityReason,
    response: DTSExactCapabilityWorkerResponse | null = null
): DTSExactCapability {
    const exactOutputMatches = response !== null
        && response.verifiedFixtureCount === DTS_QUALIFICATION_FIXTURE_COUNT
        && response.verifiedProfileMask === DTS_QUALIFICATION_PROFILE_MASK;
    const exactThroughputMatches = response?.measuredRealTimeFactor !== null
        && response?.measuredRealTimeFactor !== undefined
        && response.measuredRealTimeFactor >= DTS_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR;
    const supported = reason === 'decode-output-verified'
        && response?.supported === true
        && exactOutputMatches
        && exactThroughputMatches;
    let status: DTSExactCapability['status'];
    if (supported) {
        status = 'supported';
    } else if (reason === 'api-unavailable' || reason === 'probe-timeout') {
        status = 'unknown';
    } else {
        status = 'unsupported';
    }
    let resolvedReason: DTSExactCapabilityReason = reason;
    if (supported) {
        resolvedReason = 'decode-output-verified';
    } else if (reason === 'decode-output-verified') {
        resolvedReason = 'output-mismatch';
    }
    return Object.freeze({
        channelBedOnly: true,
        codec: 'dts',
        codecString: 'dts',
        decodeMilliseconds: response?.decodeMilliseconds ?? null,
        libraryVersion: response?.libraryVersion ?? null,
        maximumChannelCount: 8,
        measuredRealTimeFactor: response?.measuredRealTimeFactor ?? null,
        objectAudioRendered: false,
        profiles: DTS_QUALIFIED_PROFILES,
        reason: resolvedReason,
        sampleRates: DTS_QUALIFIED_SAMPLE_RATES,
        status,
        verifiedFixtureCount: response?.verifiedFixtureCount ?? 0,
        verifiedProfileMask: response?.verifiedProfileMask ?? 0
    });
}

/** Owns one cached, fail-closed libdcadec output and throughput probe. */
export default class DTSExactCapabilityProbe {
    private cachedProbe: Promise<DTSExactCapability> | null = null;

    public constructor(
        private readonly environment: DTSExactCapabilityProbeEnvironment =
        createDefaultEnvironment(),
        private readonly timeoutMilliseconds =
        DTS_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS
    ) {
        if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
            throw new TypeError('The exact DTS capability timeout is invalid');
        }
    }

    /** Returns the same immutable capability result for every call. */
    public probe(): Promise<DTSExactCapability> {
        this.cachedProbe ??= this.runProbe();
        return this.cachedProbe;
    }

    private runProbe(): Promise<DTSExactCapability> {
        if (!this.environment.runtimeAvailable || !this.environment.createWorker) {
            return Promise.resolve(createCapability('api-unavailable'));
        }
        let worker: DTSExactCapabilityProbeWorker;
        try {
            worker = this.environment.createWorker();
        } catch {
            return Promise.resolve(createCapability('worker-create-failed'));
        }

        return new Promise<DTSExactCapability>((resolve): void => {
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
                    // Ownership ends even when termination fails
                }
            };
            const settle = (capability: DTSExactCapability): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(capability);
            };
            const messageHandler: DTSExactCapabilityProbeWorkerEventListener = (
                event: Event
            ): void => {
                const value = (event as MessageEvent<unknown>).data;
                if (!isDTSExactCapabilityWorkerResponse(value)) {
                    settle(createCapability('worker-message-invalid'));
                    return;
                }
                settle(createCapability(value.reason, value));
            };
            const errorHandler: DTSExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createCapability('worker-error'));
            };
            const messageErrorHandler: DTSExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createCapability('worker-message-invalid'));
            };
            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);
            worker.addEventListener('messageerror', messageErrorHandler);
            timeout = this.environment.setTimeout((): void => {
                settle(createCapability('probe-timeout'));
            }, this.timeoutMilliseconds);

            const request: DTSExactCapabilityWorkerRequest = {
                requestID: DTS_EXACT_CAPABILITY_REQUEST_ID,
                type: 'probe'
            };
            try {
                worker.postMessage(request);
            } catch {
                settle(createCapability('worker-error'));
            }
        });
    }
}

let defaultProbe: DTSExactCapabilityProbe | null = null;

/** Qualifies and caches the pinned libdcadec DTS-family route. */
export function probeDTSExactCapability(): Promise<DTSExactCapability> {
    defaultProbe ??= new DTSExactCapabilityProbe();
    return defaultProbe.probe();
}
