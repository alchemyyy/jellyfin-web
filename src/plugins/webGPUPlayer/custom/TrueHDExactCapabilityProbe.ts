import TrueHDExactCapabilityProbeWorkerConstructor from './TrueHDExactCapabilityProbe.worker';
import {
    TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
    TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK,
    TRUEHD_QUALIFICATION_CODEC_MASK,
    TRUEHD_QUALIFICATION_FIXTURE_COUNT,
    TRUEHD_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR,
    TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK,
    isTrueHDExactCapabilityWorkerResponse,
    type TrueHDExactCapabilityWorkerRequest,
    type TrueHDExactCapabilityWorkerResponse
} from './TrueHDExactCapabilityProtocol';

export const TRUEHD_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 4_000;
const TRUEHD_QUALIFIED_CHANNEL_COUNTS = Object.freeze([ 2, 6 ] as const);
const TRUEHD_QUALIFIED_CODECS = Object.freeze([ 'truehd', 'mlp' ] as const);
const TRUEHD_QUALIFIED_SAMPLE_RATES = Object.freeze([ 48_000, 96_000, 192_000 ] as const);

export type TrueHDExactCapabilityReason =
    | 'api-unavailable'
    | TrueHDExactCapabilityWorkerResponse['reason']
    | 'probe-timeout'
    | 'worker-create-failed'
    | 'worker-error'
    | 'worker-message-invalid';

export type TrueHDExactCapability = Readonly<{
    channelBedOnly: true
    channelCounts: readonly [ 2, 6 ]
    codecs: readonly [ 'truehd', 'mlp' ]
    decodeMilliseconds: number | null
    library: 'ffmpeg-libavcodec'
    libraryVersion: number | null
    majorSyncRecoveryVerified: boolean
    measuredRealTimeFactor: number | null
    objectAudioRendered: false
    passthrough: false
    reason: TrueHDExactCapabilityReason
    sampleRates: readonly [ 48_000, 96_000, 192_000 ]
    status: 'supported' | 'unsupported' | 'unknown'
    verifiedChannelCountMask: number
    verifiedCodecMask: number
    verifiedFixtureCount: number
    verifiedSampleRateMask: number
}>;

type TrueHDExactCapabilityProbeWorkerEventListener = (event: Event) => void;

export type TrueHDExactCapabilityProbeWorker = {
    addEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: TrueHDExactCapabilityProbeWorkerEventListener
    ) => void
    postMessage: (message: unknown) => void
    removeEventListener: (
        type: 'error' | 'message' | 'messageerror',
        listener: TrueHDExactCapabilityProbeWorkerEventListener
    ) => void
    terminate: () => void
};

export type TrueHDExactCapabilityProbeEnvironment = Readonly<{
    clearTimeout: (timeout: ReturnType<typeof globalThis.setTimeout>) => void
    createWorker: (() => TrueHDExactCapabilityProbeWorker) | null
    runtimeAvailable: boolean
    setTimeout: (
        callback: () => void,
        milliseconds: number
    ) => ReturnType<typeof globalThis.setTimeout>
}>;

function createDefaultWorker(): TrueHDExactCapabilityProbeWorker {
    const worker = new TrueHDExactCapabilityProbeWorkerConstructor();
    return worker as unknown as TrueHDExactCapabilityProbeWorker;
}

function createDefaultEnvironment(): TrueHDExactCapabilityProbeEnvironment {
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
    reason: TrueHDExactCapabilityReason,
    response: TrueHDExactCapabilityWorkerResponse | null = null
): TrueHDExactCapability {
    const exactOutputMatches = response !== null
        && response.verifiedFixtureCount === TRUEHD_QUALIFICATION_FIXTURE_COUNT
        && response.verifiedCodecMask === TRUEHD_QUALIFICATION_CODEC_MASK
        && response.verifiedChannelCountMask === TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK
        && response.verifiedSampleRateMask === TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK
        && response.majorSyncRecoveryVerified;
    const exactThroughputMatches = response?.measuredRealTimeFactor !== null
        && response?.measuredRealTimeFactor !== undefined
        && response.measuredRealTimeFactor >= TRUEHD_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR;
    const supported = reason === 'decode-output-verified'
        && response?.supported === true
        && exactOutputMatches
        && exactThroughputMatches;
    let status: TrueHDExactCapability['status'];
    if (supported) {
        status = 'supported';
    } else if (reason === 'api-unavailable' || reason === 'probe-timeout') {
        status = 'unknown';
    } else {
        status = 'unsupported';
    }
    let resolvedReason: TrueHDExactCapabilityReason = reason;
    if (supported) {
        resolvedReason = 'decode-output-verified';
    } else if (reason === 'decode-output-verified') {
        resolvedReason = 'output-mismatch';
    }
    return Object.freeze({
        channelBedOnly: true,
        channelCounts: TRUEHD_QUALIFIED_CHANNEL_COUNTS,
        codecs: TRUEHD_QUALIFIED_CODECS,
        decodeMilliseconds: response?.decodeMilliseconds ?? null,
        library: 'ffmpeg-libavcodec',
        libraryVersion: response?.libraryVersion ?? null,
        majorSyncRecoveryVerified: response?.majorSyncRecoveryVerified ?? false,
        measuredRealTimeFactor: response?.measuredRealTimeFactor ?? null,
        objectAudioRendered: false,
        passthrough: false,
        reason: resolvedReason,
        sampleRates: TRUEHD_QUALIFIED_SAMPLE_RATES,
        status,
        verifiedChannelCountMask: response?.verifiedChannelCountMask ?? 0,
        verifiedCodecMask: response?.verifiedCodecMask ?? 0,
        verifiedFixtureCount: response?.verifiedFixtureCount ?? 0,
        verifiedSampleRateMask: response?.verifiedSampleRateMask ?? 0
    });
}

/** Owns one cached, fail-closed TrueHD/MLP output and throughput probe. */
export default class TrueHDExactCapabilityProbe {
    private cachedProbe: Promise<TrueHDExactCapability> | null = null;

    public constructor(
        private readonly environment: TrueHDExactCapabilityProbeEnvironment =
        createDefaultEnvironment(),
        private readonly timeoutMilliseconds =
        TRUEHD_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS
    ) {
        if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
            throw new TypeError('The exact TrueHD capability timeout is invalid');
        }
    }

    /** Returns the same immutable capability result for every call. */
    public probe(): Promise<TrueHDExactCapability> {
        this.cachedProbe ??= this.runProbe();
        return this.cachedProbe;
    }

    private runProbe(): Promise<TrueHDExactCapability> {
        if (!this.environment.runtimeAvailable || !this.environment.createWorker) {
            return Promise.resolve(createCapability('api-unavailable'));
        }
        let worker: TrueHDExactCapabilityProbeWorker;
        try {
            worker = this.environment.createWorker();
        } catch {
            return Promise.resolve(createCapability('worker-create-failed'));
        }

        return new Promise<TrueHDExactCapability>((resolve): void => {
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
            const settle = (capability: TrueHDExactCapability): void => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(capability);
            };
            const messageHandler: TrueHDExactCapabilityProbeWorkerEventListener = (
                event: Event
            ): void => {
                const value = (event as MessageEvent<unknown>).data;
                if (!isTrueHDExactCapabilityWorkerResponse(value)) {
                    settle(createCapability('worker-message-invalid'));
                    return;
                }
                settle(createCapability(value.reason, value));
            };
            const errorHandler: TrueHDExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createCapability('worker-error'));
            };
            const messageErrorHandler: TrueHDExactCapabilityProbeWorkerEventListener = (): void => {
                settle(createCapability('worker-message-invalid'));
            };
            worker.addEventListener('message', messageHandler);
            worker.addEventListener('error', errorHandler);
            worker.addEventListener('messageerror', messageErrorHandler);
            timeout = this.environment.setTimeout((): void => {
                settle(createCapability('probe-timeout'));
            }, this.timeoutMilliseconds);

            const request: TrueHDExactCapabilityWorkerRequest = {
                requestID: TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
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

let defaultProbe: TrueHDExactCapabilityProbe | null = null;

/** Qualifies and caches the pinned FFmpeg TrueHD/MLP channel-bed route. */
export function probeTrueHDExactCapability(): Promise<TrueHDExactCapability> {
    defaultProbe ??= new TrueHDExactCapabilityProbe();
    return defaultProbe.probe();
}
