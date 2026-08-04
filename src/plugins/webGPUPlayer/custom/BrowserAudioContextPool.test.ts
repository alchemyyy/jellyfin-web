import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { microsecondsToMilliseconds } from '../MediaTime';
import {
    acquireSharedBrowserAudioContext,
    closeIdleSharedBrowserAudioContexts
} from './BrowserAudioContextPool';
import { SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS } from './BrowserAudioOperation';

type Deferred = {
    promise: Promise<void>
    resolve: () => void
};

function createDeferred(): Deferred {
    let resolvePromise: (() => void) | null = null;
    const promise = new Promise<void>((resolve): void => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: (): void => {
            if (!resolvePromise) {
                throw new Error('Deferred resolver is unavailable');
            }
            resolvePromise();
        }
    };
}

class FakeAudioContext {
    public static readonly instances: FakeAudioContext[] = [];
    public readonly close = vi.fn((): Promise<void> => {
        this.state = 'closed';
        return Promise.resolve();
    });
    public readonly resume = vi.fn((): Promise<void> => {
        this.state = 'running';
        return Promise.resolve();
    });
    public readonly sampleRate: number;
    public state: AudioContextState = 'suspended';
    public readonly suspend = vi.fn((): Promise<void> => {
        this.state = 'suspended';
        return Promise.resolve();
    });

    public constructor(public readonly options?: AudioContextOptions) {
        this.sampleRate = options?.sampleRate ?? 48_000;
        FakeAudioContext.instances.push(this);
    }
}

describe('BrowserAudioContextPool', () => {
    beforeEach(() => {
        FakeAudioContext.instances.length = 0;
        vi.stubGlobal('AudioContext', FakeAudioContext);
    });

    afterEach(async () => {
        vi.useRealTimers();
        await closeIdleSharedBrowserAudioContexts().catch((): void => undefined);
    });

    it('shares one context across simultaneous guarded references', async () => {
        const firstReference = acquireSharedBrowserAudioContext(48_000);
        const secondReference = acquireSharedBrowserAudioContext(48_000);

        expect(secondReference.audioContext).toBe(firstReference.audioContext);
        expect(firstReference.isValid()).toBe(true);
        expect(FakeAudioContext.instances).toHaveLength(1);

        await firstReference.release();
        await firstReference.release();
        await secondReference.release();

        expect(FakeAudioContext.instances[0].close).not.toHaveBeenCalled();
        expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledTimes(2);
        expect(FakeAudioContext.instances[0].suspend).toHaveBeenCalledOnce();
    });

    it('resumes synchronously when reacquired during an asynchronous idle suspend', async () => {
        const deferredSuspend = createDeferred();
        const firstReference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];
        await firstReference.resumePromise;
        audioContext.suspend.mockImplementationOnce((): Promise<void> => deferredSuspend.promise);

        const firstRelease = firstReference.release();
        const secondReference = acquireSharedBrowserAudioContext(48_000);

        expect(audioContext.suspend).toHaveBeenCalledOnce();
        expect(audioContext.resume).toHaveBeenCalledTimes(2);
        deferredSuspend.resolve();
        await firstRelease;
        await secondReference.resumePromise;
        await secondReference.release();

        expect(audioContext.suspend).toHaveBeenCalledTimes(2);
        expect(audioContext.state).toBe('suspended');
    });

    it('does not close an active reacquisition when the stale suspend rejects', async () => {
        const firstReference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];
        await firstReference.resumePromise;
        audioContext.suspend.mockRejectedValueOnce(new Error('stale suspend failed'));

        const staleRelease = firstReference.release();
        const activeReference = acquireSharedBrowserAudioContext(48_000);

        await expect(staleRelease).rejects.toThrow('stale suspend failed');
        expect(audioContext.close).not.toHaveBeenCalled();
        expect(activeReference.audioContext).toBe(audioContext);
        await activeReference.resumePromise;
        await activeReference.release();

        expect(audioContext.suspend).toHaveBeenCalledTimes(2);
        expect(audioContext.state).toBe('suspended');
    });

    it('suspends after a pending resume even while the public state is suspended', async () => {
        const deferredResume = createDeferred();
        const reference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];
        audioContext.state = 'suspended';
        audioContext.resume.mockReset();
        audioContext.resume.mockImplementationOnce(async (): Promise<void> => {
            await deferredResume.promise;
            audioContext.state = 'running';
        });

        // Reacquire with the delayed implementation installed to model an
        // asynchronous browser state transition
        await reference.release();
        const pendingReference = acquireSharedBrowserAudioContext(48_000);
        audioContext.suspend.mockImplementationOnce(async (): Promise<void> => {
            await deferredResume.promise;
            audioContext.state = 'suspended';
        });

        const releasePromise = pendingReference.release();
        expect(audioContext.state).toBe('suspended');
        expect(audioContext.suspend).toHaveBeenCalledTimes(2);
        deferredResume.resolve();
        await pendingReference.resumePromise;
        await releasePromise;

        expect(audioContext.state).toBe('suspended');
    });

    it('bounds a stalled final-reference idle suspend', async () => {
        vi.useFakeTimers();
        const reference = acquireSharedBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];
        await reference.resumePromise;
        audioContext.suspend.mockReturnValueOnce(new Promise(() => undefined));

        const releaseResult = reference.release();
        const observedResult = releaseResult.catch((error: unknown): unknown => error);
        await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(
            SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS
        ));

        expect(await observedResult).toEqual(
            new Error('Idle shared AudioContext suspend exceeded its bounded timeout')
        );
        expect(audioContext.suspend).toHaveBeenCalledOnce();
        expect(audioContext.close).toHaveBeenCalledOnce();

        const replacementReference = acquireSharedBrowserAudioContext(48_000);
        expect(replacementReference.audioContext).not.toBe(audioContext);
        await replacementReference.release();
    });

    it('invalidates a context when resume throws synchronously', async () => {
        const poisonedReference = acquireSharedBrowserAudioContext(48_000);
        const poisonedContext = FakeAudioContext.instances[0];
        await poisonedReference.release();
        poisonedContext.resume.mockImplementationOnce((): Promise<void> => {
            throw new Error('resume failed');
        });

        expect(() => acquireSharedBrowserAudioContext(48_000)).toThrow('resume failed');
        await Promise.resolve();
        expect(poisonedContext.close).toHaveBeenCalledOnce();

        const replacementReference = acquireSharedBrowserAudioContext(48_000);
        expect(replacementReference.audioContext).not.toBe(poisonedContext);
        await replacementReference.release();
    });

    it('does not let stale invalidation evict its replacement context', async () => {
        const deferredClose = createDeferred();
        const staleReference = acquireSharedBrowserAudioContext(48_000);
        const staleContext = FakeAudioContext.instances[0];
        staleContext.close.mockImplementationOnce((): Promise<void> => deferredClose.promise);

        const staleInvalidation = staleReference.invalidate();
        expect(staleReference.isValid()).toBe(false);
        const replacementReference = acquireSharedBrowserAudioContext(48_000);
        const replacementContext = FakeAudioContext.instances[1];

        deferredClose.resolve();
        await staleInvalidation;
        await replacementReference.release();

        const nextReference = acquireSharedBrowserAudioContext(48_000);
        expect(nextReference.audioContext).toBe(replacementContext);
        expect(FakeAudioContext.instances).toHaveLength(2);
        await nextReference.release();
    });
});
