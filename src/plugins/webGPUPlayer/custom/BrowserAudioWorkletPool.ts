import type { Microseconds } from '../MediaTime';
import AudioWorkletController, {
    type AudioEnqueueSubmission,
    type AudioTelemetryListener,
    type AudioWorkletControllerConfiguration,
    type AudioWorkletControllerOptions,
    type AudioWorkletOutputController,
    DEFAULT_AUDIO_TELEMETRY_INTERVAL_FRAMES,
    DEFAULT_MAX_WORKLET_CHUNKS,
    MAX_AUDIO_CHANNEL_COUNT,
    MAX_AUDIO_WORKLET_CHUNKS
} from './AudioWorkletController';
import type {
    AudioWorkletTelemetry,
    TransferablePlanarPCM
} from './AudioWorkletProtocol';

type PooledBrowserAudioWorkletState = {
    configuration: AudioWorkletControllerConfiguration
    controller: AudioWorkletController | null
    invalidationPromise: Promise<void> | null
    invalidated: boolean
    leased: boolean
    releasePromise: Promise<void> | null
};

export type SharedBrowserAudioWorkletLease = {
    readonly leaseId: number
    readonly output: AudioWorkletOutputController
    invalidate: () => Promise<void>
    release: () => Promise<void>
};

const pooledStates = new WeakMap<AudioContext, PooledBrowserAudioWorkletState>();
const retirementPromises = new WeakMap<AudioContext, Promise<void>>();
let nextLeaseId = 1;

function requirePositiveSafeInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive safe integer`);
    }
    return value;
}

function takeLeaseId(): number {
    if (nextLeaseId === Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Audio worklet lease ID exhausted');
    }
    const leaseId = nextLeaseId;
    nextLeaseId += 1;
    return leaseId;
}

function createRequestedConfiguration(
    audioContext: AudioContext,
    options: AudioWorkletControllerOptions
): AudioWorkletControllerConfiguration {
    const channelCount = requirePositiveSafeInteger(options.channelCount, 'Channel count');
    if (channelCount > MAX_AUDIO_CHANNEL_COUNT) {
        throw new RangeError(`Channel count cannot exceed ${MAX_AUDIO_CHANNEL_COUNT}`);
    }

    const maxChunks = requirePositiveSafeInteger(
        options.maxChunks ?? DEFAULT_MAX_WORKLET_CHUNKS,
        'Maximum audio chunks'
    );
    if (maxChunks > MAX_AUDIO_WORKLET_CHUNKS) {
        throw new RangeError(`Maximum audio chunks cannot exceed ${MAX_AUDIO_WORKLET_CHUNKS}`);
    }

    return {
        channelCount,
        maxBufferedFrames: requirePositiveSafeInteger(
            options.maxBufferedFrames,
            'Maximum buffered frames'
        ),
        maxChunks,
        sampleRate: requirePositiveSafeInteger(audioContext.sampleRate, 'Audio context sample rate'),
        telemetryIntervalFrames: requirePositiveSafeInteger(
            options.telemetryIntervalFrames ?? DEFAULT_AUDIO_TELEMETRY_INTERVAL_FRAMES,
            'Telemetry interval frames'
        )
    };
}

function configurationsMatch(
    first: AudioWorkletControllerConfiguration,
    second: AudioWorkletControllerConfiguration
): boolean {
    return first.channelCount === second.channelCount
        && first.maxBufferedFrames === second.maxBufferedFrames
        && first.maxChunks === second.maxChunks
        && first.sampleRate === second.sampleRate
        && first.telemetryIntervalFrames === second.telemetryIntervalFrames;
}

function removePooledState(
    audioContext: AudioContext,
    state: PooledBrowserAudioWorkletState
): void {
    if (pooledStates.get(audioContext) === state) {
        pooledStates.delete(audioContext);
    }
}

function invalidatePooledState(
    audioContext: AudioContext,
    state: PooledBrowserAudioWorkletState
): Promise<void> {
    if (state.invalidationPromise) {
        return state.invalidationPromise;
    }

    removePooledState(audioContext, state);
    state.invalidated = true;
    state.leased = false;
    const controller = state.controller;
    if (!controller) {
        const unavailableControllerError = new Error('Pooled audio worklet controller is unavailable');
        state.invalidationPromise = Promise.reject(unavailableControllerError);
        return state.invalidationPromise;
    }

    let controllerDestroyPromise: Promise<void>;
    // eslint-disable-next-line sonarjs/no-try-promise -- Controller destruction may throw synchronously
    try {
        controllerDestroyPromise = controller.destroy();
    } catch (error) {
        controllerDestroyPromise = Promise.reject(error);
    }

    const retirementPromise = controllerDestroyPromise.finally((): void => {
        if (retirementPromises.get(audioContext) === retirementPromise) {
            retirementPromises.delete(audioContext);
        }
    });
    state.invalidationPromise = retirementPromise;
    retirementPromises.set(audioContext, retirementPromise);
    return retirementPromise;
}

function rejectAfterInvalidationStarts(
    audioContext: AudioContext,
    state: PooledBrowserAudioWorkletState,
    releaseError: unknown
): Promise<void> {
    // Context invalidation can overlap bounded processor retirement. The pool
    // still blocks reuse through retirementPromises until destruction settles.
    void invalidatePooledState(audioContext, state).catch((): void => undefined);
    return Promise.reject(releaseError);
}

function releasePooledState(
    audioContext: AudioContext,
    state: PooledBrowserAudioWorkletState,
    leaseId: number
): Promise<void> {
    const controller = state.controller;
    if (!controller || state.invalidated) {
        return Promise.reject(new Error('Pooled audio worklet controller is unavailable'));
    }

    let deactivationPromise: Promise<void>;
    // eslint-disable-next-line sonarjs/no-try-promise -- Controller deactivation may throw synchronously
    try {
        deactivationPromise = controller.deactivate(leaseId);
    } catch (error) {
        const failedReleasePromise = rejectAfterInvalidationStarts(audioContext, state, error);
        state.releasePromise = failedReleasePromise;
        return failedReleasePromise;
    }

    const releasePromise = deactivationPromise.then(
        (): void => {
            if (pooledStates.get(audioContext) !== state || state.invalidated) {
                return;
            }
            state.leased = false;
            state.releasePromise = null;
        },
        (error: unknown): Promise<void> => rejectAfterInvalidationStarts(audioContext, state, error)
    );
    state.releasePromise = releasePromise;
    return releasePromise;
}

class GuardedAudioWorkletOutput implements AudioWorkletOutputController {
    public readonly configuration: AudioWorkletControllerConfiguration;

    private active = true;
    private readonly telemetryUnsubscribers = new Set<() => void>();

    public constructor(private readonly controller: AudioWorkletController) {
        this.configuration = Object.freeze({ ...controller.configuration });
    }

    public get generation(): number {
        this.requireActive();
        return this.controller.generation;
    }

    public get isPlaying(): boolean {
        return this.active && this.controller.isPlaying;
    }

    public enqueue(
        chunk: TransferablePlanarPCM,
        generation: number
    ): AudioEnqueueSubmission {
        this.requireActive();
        return this.controller.enqueue(chunk, generation);
    }

    public flush(mediaTimeMicroseconds: Microseconds): number {
        this.requireActive();
        return this.controller.flush(mediaTimeMicroseconds);
    }

    public getTelemetry(): AudioWorkletTelemetry | null {
        this.requireActive();
        return this.controller.getTelemetry();
    }

    public onTelemetry(listener: AudioTelemetryListener): () => void {
        this.requireActive();
        let subscribed = true;
        const guardedListener = (telemetry: AudioWorkletTelemetry): void => {
            if (this.active && subscribed) {
                listener(telemetry);
            }
        };
        const unsubscribeController = this.controller.onTelemetry(guardedListener);
        const unsubscribe = (): void => {
            if (!subscribed) {
                return;
            }
            subscribed = false;
            this.telemetryUnsubscribers.delete(unsubscribe);
            unsubscribeController();
        };
        this.telemetryUnsubscribers.add(unsubscribe);
        return unsubscribe;
    }

    public seek(mediaTimeMicroseconds: Microseconds): number {
        this.requireActive();
        return this.controller.seek(mediaTimeMicroseconds);
    }

    public setMuted(muted: boolean): void {
        this.requireActive();
        this.controller.setMuted(muted);
    }

    public setPlaying(playing: boolean): void {
        this.requireActive();
        this.controller.setPlaying(playing);
    }

    public setVolume(volume: number): void {
        this.requireActive();
        this.controller.setVolume(volume);
    }

    public revoke(): void {
        if (!this.active) {
            return;
        }
        this.active = false;
        for (const unsubscribe of [ ...this.telemetryUnsubscribers ]) {
            unsubscribe();
        }
        this.telemetryUnsubscribers.clear();
    }

    private requireActive(): void {
        if (!this.active) {
            throw new Error('Audio worklet lease is no longer active');
        }
    }
}

function createLease(
    audioContext: AudioContext,
    state: PooledBrowserAudioWorkletState,
    controller: AudioWorkletController,
    leaseId: number
): SharedBrowserAudioWorkletLease {
    const guardedOutput = new GuardedAudioWorkletOutput(controller);
    let settlementPromise: Promise<void> | null = null;

    return {
        leaseId,
        output: guardedOutput,
        invalidate: (): Promise<void> => {
            if (!settlementPromise) {
                guardedOutput.revoke();
                settlementPromise = invalidatePooledState(audioContext, state);
            }
            return settlementPromise;
        },
        release: (): Promise<void> => {
            if (!settlementPromise) {
                guardedOutput.revoke();
                settlementPromise = releasePooledState(audioContext, state, leaseId);
            }
            return settlementPromise;
        }
    };
}

function createControllerOptions(
    configuration: AudioWorkletControllerConfiguration
): AudioWorkletControllerOptions {
    return {
        channelCount: configuration.channelCount,
        maxBufferedFrames: configuration.maxBufferedFrames,
        maxChunks: configuration.maxChunks,
        telemetryIntervalFrames: configuration.telemetryIntervalFrames
    };
}

async function createPooledState(
    audioContext: AudioContext,
    configuration: AudioWorkletControllerConfiguration,
    leaseId: number
): Promise<SharedBrowserAudioWorkletLease> {
    const controllerPromise = AudioWorkletController.create(
        audioContext,
        createControllerOptions(configuration)
    );
    const newState: PooledBrowserAudioWorkletState = {
        configuration,
        controller: null,
        invalidationPromise: null,
        invalidated: false,
        leased: true,
        releasePromise: null
    };
    pooledStates.set(audioContext, newState);

    try {
        const controller = await controllerPromise;
        newState.controller = controller;
        if (!configurationsMatch(controller.configuration, configuration)) {
            const configurationError = new RangeError(
                'Created audio worklet configuration does not match the requested configuration'
            );
            try {
                await invalidatePooledState(audioContext, newState);
            } catch {
                // Preserve the configuration error
            }
            throw configurationError;
        }
        return createLease(audioContext, newState, controller, leaseId);
    } catch (error) {
        newState.leased = false;
        removePooledState(audioContext, newState);
        throw error;
    }
}

async function leaseIdlePooledState(
    audioContext: AudioContext,
    state: PooledBrowserAudioWorkletState
): Promise<SharedBrowserAudioWorkletLease> {
    const controller = state.controller;
    if (!controller || state.invalidated) {
        throw new Error('Pooled audio worklet controller is unavailable');
    }

    let leaseId: number;
    try {
        leaseId = takeLeaseId();
    } catch (error) {
        try {
            await invalidatePooledState(audioContext, state);
        } catch {
            // Preserve the lease ID exhaustion error
        }
        throw error;
    }
    state.leased = true;
    return createLease(audioContext, state, controller, leaseId);
}

/**
 * Exclusively leases the page-lifetime output for an AudioContext. Release is
 * acknowledged on the worklet thread before another guarded facade is issued.
 */
export async function acquireSharedBrowserAudioWorklet(
    audioContext: AudioContext,
    options: AudioWorkletControllerOptions
): Promise<SharedBrowserAudioWorkletLease> {
    const requestedConfiguration = createRequestedConfiguration(audioContext, options);

    // State changes across every awaited retirement or release
    while (true) {
        const pendingRetirement = retirementPromises.get(audioContext);
        if (pendingRetirement) {
            await pendingRetirement;
            continue;
        }

        const existingState = pooledStates.get(audioContext);
        if (!existingState) {
            return createPooledState(
                audioContext,
                requestedConfiguration,
                takeLeaseId()
            );
        }
        if (existingState.releasePromise) {
            await existingState.releasePromise;
            continue;
        }
        if (existingState.leased) {
            throw new Error('The shared audio worklet output is already leased');
        }
        if (!configurationsMatch(existingState.configuration, requestedConfiguration)) {
            await invalidatePooledState(audioContext, existingState);
            continue;
        }
        return leaseIdlePooledState(audioContext, existingState);
    }
}
