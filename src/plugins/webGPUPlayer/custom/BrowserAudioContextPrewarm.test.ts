import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    prewarmBrowserAudioContext,
    takePrewarmedBrowserAudioContext
} from './BrowserAudioContextPrewarm';
import {
    acquireSharedBrowserAudioContext,
    closeIdleSharedBrowserAudioContexts
} from './BrowserAudioContextPool';

class FakeAudioContext {
    public static readonly instances: FakeAudioContext[] = [];
    public readonly close = vi.fn((): Promise<void> => Promise.resolve());
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

describe('BrowserAudioContextPrewarm', () => {
    beforeEach(() => {
        FakeAudioContext.instances.length = 0;
        vi.stubGlobal('AudioContext', FakeAudioContext);
    });

    afterEach(async () => {
        await closeIdleSharedBrowserAudioContexts();
    });

    it('synchronously creates and resumes an exact-rate playback context', async () => {
        const lease = prewarmBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];

        expect(audioContext.options).toEqual({
            latencyHint: 'playback',
            sampleRate: 48_000
        });
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(lease.audioContext).toBe(audioContext);
        await lease.close();
        expect(audioContext.suspend).toHaveBeenCalledOnce();
    });

    it('transfers a matching context and leaves its release lifecycle to the output', async () => {
        const lease = prewarmBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];
        const consumedPrewarm = takePrewarmedBrowserAudioContext(lease, 48_000);

        expect(consumedPrewarm).toEqual({
            audioContext,
            invalidate: expect.any(Function),
            isValid: expect.any(Function),
            release: expect.any(Function),
            resumePromise: lease.resumePromise
        });
        expect(takePrewarmedBrowserAudioContext(lease, 48_000)).toBeNull();
        await lease.close();

        expect(audioContext.close).not.toHaveBeenCalled();
        await consumedPrewarm?.release();
    });

    it('reuses a released context instead of accumulating closed wrappers', async () => {
        const lease = prewarmBrowserAudioContext(44_100);
        const audioContext = FakeAudioContext.instances[0];

        expect(takePrewarmedBrowserAudioContext(lease, 48_000)).toBeNull();
        await lease.close();
        await lease.close();
        const nextLease = prewarmBrowserAudioContext(44_100);
        await nextLease.close();

        expect(FakeAudioContext.instances).toHaveLength(1);
        expect(audioContext.close).not.toHaveBeenCalled();
        expect(audioContext.resume).toHaveBeenCalledTimes(2);
        expect(audioContext.suspend).toHaveBeenCalledTimes(2);
    });

    it('refuses a prewarm invalidated by an overlapping failed output', async () => {
        const lease = prewarmBrowserAudioContext(48_000);
        const overlappingReference = acquireSharedBrowserAudioContext(48_000);

        await overlappingReference.invalidate();
        expect(takePrewarmedBrowserAudioContext(lease, 48_000)).toBeNull();
        await lease.close();

        expect(FakeAudioContext.instances[0].close).toHaveBeenCalledOnce();
    });

    it('exposes resume rejection to its eventual consumer', async () => {
        class RejectedResumeAudioContext extends FakeAudioContext {
            public readonly resume = vi.fn(
                (): Promise<void> => Promise.reject(new Error('User activation required'))
            );
        }
        vi.stubGlobal('AudioContext', RejectedResumeAudioContext);

        const lease = prewarmBrowserAudioContext(48_000);

        await expect(lease.resumePromise).rejects.toThrow('User activation required');
        await lease.close();
    });

    it('keeps repeated session prewarms bounded to one live context', async () => {
        for (let sessionIndex = 0; sessionIndex < 10; sessionIndex += 1) {
            const lease = prewarmBrowserAudioContext(48_000);
            await lease.close();
        }

        expect(FakeAudioContext.instances).toHaveLength(1);
        expect(FakeAudioContext.instances[0].close).not.toHaveBeenCalled();
        expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledTimes(10);
        expect(FakeAudioContext.instances[0].suspend).toHaveBeenCalledTimes(10);
    });
});
