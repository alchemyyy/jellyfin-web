import {
    SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS,
    waitForBrowserAudioOperation
} from './BrowserAudioOperation';

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

type AudioContextRuntime = typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor
};

type SharedBrowserAudioContextState = {
    audioContext: AudioContext
    closePromise: Promise<void> | null
    invalidated: boolean
    referenceCount: number
    requestedSampleRate: number
};

export type SharedBrowserAudioContextReference = {
    readonly audioContext: AudioContext
    readonly resumePromise: Promise<void>
    invalidate: () => Promise<void>
    isValid: () => boolean
    release: () => Promise<void>
};

const sharedStatesBySampleRate = new Map<number, SharedBrowserAudioContextState>();

function getAudioContextConstructor(): AudioContextConstructor {
    const runtime = globalThis as AudioContextRuntime;
    const constructor = runtime.AudioContext ?? runtime.webkitAudioContext;
    if (!constructor) {
        throw new Error('AudioContext is unavailable');
    }
    return constructor;
}

function validateSampleRate(sampleRate: number): void {
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
        throw new RangeError('AudioContext sample rate must be a positive safe integer');
    }
}

function removeSharedState(state: SharedBrowserAudioContextState): void {
    if (sharedStatesBySampleRate.get(state.requestedSampleRate) === state) {
        sharedStatesBySampleRate.delete(state.requestedSampleRate);
    }
}

function closeSharedState(state: SharedBrowserAudioContextState): Promise<void> {
    if (state.closePromise) {
        return state.closePromise;
    }

    removeSharedState(state);
    state.invalidated = true;
    if (state.audioContext.state === 'closed') {
        state.closePromise = Promise.resolve();
        return state.closePromise;
    }

    // eslint-disable-next-line sonarjs/no-try-promise -- AudioContext close may throw synchronously
    try {
        state.closePromise = waitForBrowserAudioOperation(
            state.audioContext.close(),
            'Shared AudioContext close',
            SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS
        );
    } catch (error) {
        state.closePromise = Promise.reject(error);
    }
    return state.closePromise;
}

function closeInvalidatedStateWhenIdle(
    state: SharedBrowserAudioContextState
): Promise<void> {
    if (!state.invalidated || state.referenceCount > 0) {
        return Promise.resolve();
    }
    return closeSharedState(state);
}

function suspendSharedStateWhenIdle(
    state: SharedBrowserAudioContextState
): Promise<void> {
    if (state.invalidated) {
        return closeInvalidatedStateWhenIdle(state);
    }
    if (state.referenceCount > 0
        || state.audioContext.state === 'closed') {
        return Promise.resolve();
    }

    let suspendPromise: Promise<void>;
    // eslint-disable-next-line sonarjs/no-try-promise -- AudioContext suspend may throw synchronously
    try {
        // Suspend even while the public state is still "suspended": a resume
        // control message may already be pending behind that stale state
        suspendPromise = waitForBrowserAudioOperation(
            state.audioContext.suspend(),
            'Idle shared AudioContext suspend',
            SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS
        );
    } catch (error) {
        suspendPromise = Promise.reject(error);
    }
    return suspendPromise.catch((error: unknown): never => {
        if (state.referenceCount === 0) {
            state.invalidated = true;
            removeSharedState(state);
            void closeSharedState(state).catch((): void => undefined);
        }
        throw error;
    });
}

function invalidateIdleStatesExcept(sampleRate: number): void {
    for (const state of sharedStatesBySampleRate.values()) {
        if (state.requestedSampleRate === sampleRate) {
            continue;
        }
        state.invalidated = true;
        removeSharedState(state);
        void closeInvalidatedStateWhenIdle(state).catch((): void => undefined);
    }
}

function createSharedState(sampleRate: number): SharedBrowserAudioContextState {
    const AudioContextClass = getAudioContextConstructor();
    const audioContext = new AudioContextClass({
        latencyHint: 'playback',
        sampleRate
    });
    if (audioContext.sampleRate !== sampleRate) {
        // eslint-disable-next-line sonarjs/no-try-promise -- AudioContext close may throw synchronously
        try {
            void waitForBrowserAudioOperation(
                audioContext.close(),
                'Mismatched AudioContext close',
                SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS
            ).catch((): void => undefined);
        } catch {
            // Preserve the requested-rate error below
        }
        throw new RangeError('The browser did not create the requested audio sample rate');
    }

    const state: SharedBrowserAudioContextState = {
        audioContext,
        closePromise: null,
        invalidated: false,
        referenceCount: 0,
        requestedSampleRate: sampleRate
    };
    sharedStatesBySampleRate.set(sampleRate, state);
    invalidateIdleStatesExcept(sampleRate);
    return state;
}

function getSharedState(sampleRate: number): SharedBrowserAudioContextState {
    const existingState = sharedStatesBySampleRate.get(sampleRate);
    if (existingState
        && !existingState.invalidated
        && existingState.audioContext.state !== 'closed') {
        return existingState;
    }
    if (existingState) {
        existingState.invalidated = true;
        removeSharedState(existingState);
        void closeInvalidatedStateWhenIdle(existingState).catch((): void => undefined);
    }
    return createSharedState(sampleRate);
}

/**
 * Acquires the shared exact-rate context used by custom audio outputs. Session
 * teardown suspends its destination but keeps the context and worklet module
 * warm, avoiding Chromium retention of one closed wrapper per item.
 */
export function acquireSharedBrowserAudioContext(
    sampleRate: number
): SharedBrowserAudioContextReference {
    validateSampleRate(sampleRate);
    const state = getSharedState(sampleRate);
    state.referenceCount += 1;

    let resumePromise: Promise<void>;
    // eslint-disable-next-line sonarjs/no-try-promise -- Resume must run in this activation task
    try {
        // Calling resume while Chromium has an asynchronous suspend pending
        // cancels that transition before the destination stops rendering
        resumePromise = state.audioContext.resume();
    } catch (error) {
        state.referenceCount -= 1;
        state.invalidated = true;
        removeSharedState(state);
        void closeInvalidatedStateWhenIdle(state).catch((): void => undefined);
        throw error;
    }
    // Preserve the rejection for the consumer without reporting it before consumption
    resumePromise.catch((): void => undefined);

    let releasePromise: Promise<void> | null = null;
    const release = (invalidate: boolean): Promise<void> => {
        if (releasePromise) {
            return releasePromise;
        }
        if (invalidate) {
            state.invalidated = true;
            removeSharedState(state);
        }
        state.referenceCount -= 1;
        releasePromise = suspendSharedStateWhenIdle(state);
        return releasePromise;
    };

    return {
        audioContext: state.audioContext,
        invalidate: (): Promise<void> => release(true),
        isValid: (): boolean => !state.invalidated
            && state.audioContext.state !== 'closed'
            && sharedStatesBySampleRate.get(state.requestedSampleRate) === state,
        release: (): Promise<void> => release(false),
        resumePromise
    };
}

/** Closes every idle shared context, primarily for deterministic runtime teardown. */
export function closeIdleSharedBrowserAudioContexts(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    for (const state of sharedStatesBySampleRate.values()) {
        state.invalidated = true;
        removeSharedState(state);
        if (state.referenceCount === 0) {
            closePromises.push(closeSharedState(state));
        }
    }
    return Promise.all(closePromises).then((): void => undefined);
}
