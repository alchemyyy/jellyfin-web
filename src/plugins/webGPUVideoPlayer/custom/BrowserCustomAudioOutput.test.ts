import { beforeEach, describe, expect, it, vi } from 'vitest';

const audioWorkletMockState = vi.hoisted(() => ({
    create: vi.fn()
}));

vi.mock('./AudioWorkletController', () => ({
    default: class MockAudioWorkletController {
        static readonly create = audioWorkletMockState.create;
    }
}));

vi.mock('./CustomDecodeAudioBridge', () => ({
    default: class MockCustomDecodeAudioBridge {
        public constructor(public readonly controller: object) {}
    }
}));

import { createBrowserCustomAudioOutputFactory } from './BrowserCustomAudioOutput';
import { prewarmBrowserAudioContext } from './BrowserAudioContextPrewarm';

function createDeferred(): {
    promise: Promise<void>
    resolve: () => void
} {
    let promiseResolver: (() => void) | undefined;
    const promise = new Promise<void>(resolve => {
        promiseResolver = resolve;
    });
    return {
        promise,
        resolve: (): void => {
            if (!promiseResolver) {
                throw new Error('Deferred promise was not initialized');
            }
            promiseResolver();
        }
    };
}

class FakeAudioContext {
    public static readonly instances: FakeAudioContext[] = [];
    public readonly close = vi.fn((): Promise<void> => Promise.resolve());
    public readonly destination = {} as AudioDestinationNode;
    public readonly resume = vi.fn((): Promise<void> => {
        this.state = 'running';
        return Promise.resolve();
    });
    public readonly sampleRate: number;
    public state: AudioContextState = 'suspended';

    public constructor(public readonly options?: AudioContextOptions) {
        this.sampleRate = options?.sampleRate ?? 48_000;
        FakeAudioContext.instances.push(this);
    }
}

function createWorkletController(): {
    configuration: { maxChunks: number }
    destroy: ReturnType<typeof vi.fn>
    generation: number
    getTelemetry: ReturnType<typeof vi.fn>
    onTelemetry: ReturnType<typeof vi.fn>
    setMuted: ReturnType<typeof vi.fn>
    setPlaying: ReturnType<typeof vi.fn>
    setVolume: ReturnType<typeof vi.fn>
} {
    return {
        configuration: { maxChunks: 16 },
        destroy: vi.fn(),
        generation: 1,
        getTelemetry: vi.fn(() => null),
        onTelemetry: vi.fn(() => vi.fn()),
        setMuted: vi.fn(),
        setPlaying: vi.fn(),
        setVolume: vi.fn()
    };
}

describe('BrowserCustomAudioOutput', () => {
    beforeEach(() => {
        FakeAudioContext.instances.length = 0;
        audioWorkletMockState.create.mockReset();
        vi.stubGlobal('AudioContext', FakeAudioContext);
    });

    it('creates, resumes, and owns an exact-rate bounded worklet output', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const factory = createBrowserCustomAudioOutputFactory();

        const binding = await factory({
            channelCount: 6,
            codec: 'flac',
            sampleRate: 48_000
        });

        const audioContext = FakeAudioContext.instances[0];
        expect(audioContext.options).toEqual({
            latencyHint: 'playback',
            sampleRate: 48_000
        });
        expect(audioWorkletMockState.create).toHaveBeenCalledWith(audioContext, {
            channelCount: 6,
            maxBufferedFrames: 96_000
        });
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(binding.configuration).toEqual({
            channelCount: 6,
            codec: 'flac',
            sampleRate: 48_000
        });

        binding.output.setVolume(0.5);
        binding.output.setMuted(true);
        await binding.output.setPlaying(true);
        await binding.output.destroy();
        await binding.output.destroy();

        expect(workletController.setVolume).toHaveBeenCalledWith(0.5);
        expect(workletController.setMuted).toHaveBeenCalledWith(true);
        expect(workletController.setPlaying).toHaveBeenCalledWith(true);
        expect(workletController.destroy).toHaveBeenCalledOnce();
        expect(audioContext.close).toHaveBeenCalledOnce();
    });

    it('consumes a matching prewarmed context without a second resume', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const prewarm = prewarmBrowserAudioContext(48_000);
        const binding = await createBrowserCustomAudioOutputFactory(prewarm)({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];

        expect(FakeAudioContext.instances).toHaveLength(1);
        expect(audioContext.resume).toHaveBeenCalledOnce();
        await prewarm.close();
        expect(audioContext.close).not.toHaveBeenCalled();

        await binding.output.destroy();
        expect(audioContext.close).toHaveBeenCalledOnce();
    });

    it('closes a mismatched prewarm before creating the decoded exact rate', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const prewarm = prewarmBrowserAudioContext(44_100);
        const binding = await createBrowserCustomAudioOutputFactory(prewarm)({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });

        expect(FakeAudioContext.instances).toHaveLength(2);
        expect(FakeAudioContext.instances[0].close).toHaveBeenCalledOnce();
        expect(FakeAudioContext.instances[1].sampleRate).toBe(48_000);

        await binding.output.destroy();
        expect(FakeAudioContext.instances[1].close).toHaveBeenCalledOnce();
    });

    it('reports a suspended context resume failure to the playback owner', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        audioContext.state = 'suspended';
        audioContext.resume.mockRejectedValueOnce(new Error('User activation required'));

        await expect(binding.output.setPlaying(true)).rejects.toThrow('User activation required');

        expect(workletController.setPlaying).toHaveBeenLastCalledWith(true);
        expect(audioContext.resume).toHaveBeenCalledTimes(2);
        await binding.output.destroy();
    });

    it('does not finish destruction until AudioContext close completes', async () => {
        const workletController = createWorkletController();
        const deferredClose = createDeferred();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        audioContext.close.mockReturnValueOnce(deferredClose.promise);
        const asynchronousOutput = binding.output as unknown as {
            destroy: () => Promise<void>
        };

        const firstDestroyPromise = asynchronousOutput.destroy();
        const secondDestroyPromise = asynchronousOutput.destroy();
        let destroySettled = false;
        const observedDestroyPromise = firstDestroyPromise.then((): void => {
            destroySettled = true;
        });
        await Promise.resolve();

        expect(secondDestroyPromise).toBe(firstDestroyPromise);
        expect(destroySettled).toBe(false);
        expect(workletController.destroy).toHaveBeenCalledOnce();
        expect(audioContext.close).toHaveBeenCalledOnce();

        deferredClose.resolve();
        await firstDestroyPromise;
        await observedDestroyPromise;
        expect(destroySettled).toBe(true);
    });

    it('reports an AudioContext close failure to the playback owner', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        audioContext.close.mockRejectedValueOnce(new Error('Context close failed'));
        const asynchronousOutput = binding.output as unknown as {
            destroy: () => Promise<void>
        };

        await expect(asynchronousOutput.destroy()).rejects.toThrow('Context close failed');

        expect(workletController.destroy).toHaveBeenCalledOnce();
        expect(audioContext.close).toHaveBeenCalledOnce();
    });

    it('rejects a browser context that cannot honor the decoded sample rate', async () => {
        class WrongRateAudioContext extends FakeAudioContext {
            public constructor(options?: AudioContextOptions) {
                super({ ...options, sampleRate: 44_100 });
            }
        }
        vi.stubGlobal('AudioContext', WrongRateAudioContext);
        const factory = createBrowserCustomAudioOutputFactory();

        await expect(factory({
            channelCount: 2,
            codec: 'aac',
            sampleRate: 48_000
        })).rejects.toThrow('requested audio sample rate');

        expect(FakeAudioContext.instances[0].close).toHaveBeenCalledOnce();
        expect(audioWorkletMockState.create).not.toHaveBeenCalled();
    });
});
