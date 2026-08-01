import { waitForBrowserAudioOperation } from './BrowserAudioOperation';

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

type AudioContextRuntime = typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor
};

export type BrowserAudioContextPrewarmLease = {
    readonly audioContext: AudioContext
    readonly resumePromise: Promise<void>
    close: () => Promise<void>
};

export type ConsumedBrowserAudioContextPrewarm = {
    audioContext: AudioContext
    resumePromise: Promise<void>
};

type BrowserAudioContextPrewarmState = {
    audioContext: AudioContext
    closePromise: Promise<void> | null
    resumePromise: Promise<void>
    transferred: boolean
};

const prewarmStates = new WeakMap<
    BrowserAudioContextPrewarmLease,
    BrowserAudioContextPrewarmState
>();

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

function closeLease(state: BrowserAudioContextPrewarmState): Promise<void> {
    if (state.transferred) {
        return Promise.resolve();
    }
    if (state.closePromise) {
        return state.closePromise;
    }

    state.closePromise = state.audioContext.state === 'closed' ?
        Promise.resolve() :
        waitForBrowserAudioOperation(
            state.audioContext.close(),
            'AudioContext prewarm close'
        );
    return state.closePromise;
}

/** Creates an exact-rate AudioContext and requests resume in the current user-activation task. */
export function prewarmBrowserAudioContext(
    sampleRate: number
): BrowserAudioContextPrewarmLease {
    validateSampleRate(sampleRate);
    const AudioContextClass = getAudioContextConstructor();
    const audioContext = new AudioContextClass({
        latencyHint: 'playback',
        sampleRate
    });

    let resumePromise: Promise<void>;
    // eslint-disable-next-line sonarjs/no-try-promise -- Resume must run in this activation task
    try {
        resumePromise = audioContext.resume();
    } catch (error) {
        void waitForBrowserAudioOperation(
            audioContext.close(),
            'AudioContext prewarm close'
        ).catch((): void => undefined);
        throw error;
    }
    // Keep the original rejection observable without reporting it as unhandled before consumption
    resumePromise.catch((): void => undefined);

    const state: BrowserAudioContextPrewarmState = {
        audioContext,
        closePromise: null,
        resumePromise,
        transferred: false
    };
    const lease: BrowserAudioContextPrewarmLease = {
        audioContext,
        close: (): Promise<void> => closeLease(state),
        resumePromise
    };
    prewarmStates.set(lease, state);
    return lease;
}

/** Transfers a matching live prewarm lease to one managed audio output. */
export function takePrewarmedBrowserAudioContext(
    lease: BrowserAudioContextPrewarmLease,
    sampleRate: number
): ConsumedBrowserAudioContextPrewarm | null {
    validateSampleRate(sampleRate);
    const state = prewarmStates.get(lease);
    if (!state) {
        throw new TypeError('Browser AudioContext prewarm lease was not created by this runtime');
    }
    if (state.transferred
        || state.closePromise
        || state.audioContext.sampleRate !== sampleRate) {
        return null;
    }

    state.transferred = true;
    return {
        audioContext: state.audioContext,
        resumePromise: state.resumePromise
    };
}
