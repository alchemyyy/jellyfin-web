import {
    acquireSharedBrowserAudioContext,
    type SharedBrowserAudioContextReference
} from './BrowserAudioContextPool';

export type BrowserAudioContextPrewarmLease = {
    readonly audioContext: AudioContext
    readonly resumePromise: Promise<void>
    close: () => Promise<void>
};

export type ConsumedBrowserAudioContextPrewarm = {
    audioContext: AudioContext
    invalidate: () => Promise<void>
    isValid: () => boolean
    release: () => Promise<void>
    resumePromise: Promise<void>
};

type BrowserAudioContextPrewarmState = {
    reference: SharedBrowserAudioContextReference
    released: boolean
    transferred: boolean
};

const prewarmStates = new WeakMap<
    BrowserAudioContextPrewarmLease,
    BrowserAudioContextPrewarmState
>();

function validateSampleRate(sampleRate: number): void {
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
        throw new RangeError('AudioContext sample rate must be a positive safe integer');
    }
}

function closeLease(state: BrowserAudioContextPrewarmState): Promise<void> {
    if (state.transferred) {
        return Promise.resolve();
    }
    state.released = true;
    return state.reference.release();
}

/** Creates an exact-rate AudioContext and requests resume in the current user-activation task. */
export function prewarmBrowserAudioContext(
    sampleRate: number
): BrowserAudioContextPrewarmLease {
    validateSampleRate(sampleRate);
    const reference = acquireSharedBrowserAudioContext(sampleRate);

    const state: BrowserAudioContextPrewarmState = {
        reference,
        released: false,
        transferred: false
    };
    const lease: BrowserAudioContextPrewarmLease = {
        audioContext: reference.audioContext,
        close: (): Promise<void> => closeLease(state),
        resumePromise: reference.resumePromise
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
        || state.released
        || !state.reference.isValid()
        || state.reference.audioContext.sampleRate !== sampleRate) {
        return null;
    }

    state.transferred = true;
    return {
        audioContext: state.reference.audioContext,
        invalidate: state.reference.invalidate,
        isValid: state.reference.isValid,
        release: state.reference.release,
        resumePromise: state.reference.resumePromise
    };
}
