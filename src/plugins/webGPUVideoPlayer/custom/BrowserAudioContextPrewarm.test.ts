import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    prewarmBrowserAudioContext,
    takePrewarmedBrowserAudioContext
} from './BrowserAudioContextPrewarm';

class FakeAudioContext {
    public static readonly instances: FakeAudioContext[] = [];
    public readonly close = vi.fn((): Promise<void> => Promise.resolve());
    public readonly resume = vi.fn((): Promise<void> => Promise.resolve());
    public readonly sampleRate: number;
    public state: AudioContextState = 'suspended';

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

    it('synchronously creates and resumes an exact-rate playback context', () => {
        const lease = prewarmBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];

        expect(audioContext.options).toEqual({
            latencyHint: 'playback',
            sampleRate: 48_000
        });
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(lease.audioContext).toBe(audioContext);
    });

    it('transfers a matching context and leaves its close lifecycle to the output', async () => {
        const lease = prewarmBrowserAudioContext(48_000);
        const audioContext = FakeAudioContext.instances[0];

        expect(takePrewarmedBrowserAudioContext(lease, 48_000)).toEqual({
            audioContext,
            resumePromise: lease.resumePromise
        });
        expect(takePrewarmedBrowserAudioContext(lease, 48_000)).toBeNull();
        await lease.close();

        expect(audioContext.close).not.toHaveBeenCalled();
    });

    it('keeps a mismatched context owned by the lease for explicit cleanup', async () => {
        const lease = prewarmBrowserAudioContext(44_100);
        const audioContext = FakeAudioContext.instances[0];

        expect(takePrewarmedBrowserAudioContext(lease, 48_000)).toBeNull();
        await lease.close();
        await lease.close();

        expect(audioContext.close).toHaveBeenCalledOnce();
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
});
