import { beforeEach, describe, expect, it, vi } from 'vitest';

import { microsecondsToMilliseconds, secondsToMicroseconds } from '../MediaTime';
import type { AudioWorkletTelemetry } from './AudioWorkletProtocol';

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
import { DEFAULT_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS } from './BrowserAudioOperation';

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
    public baseLatency = 0.01;
    public readonly close = vi.fn((): Promise<void> => Promise.resolve());
    public readonly destination = {} as AudioDestinationNode;
    public readonly getOutputTimestamp = vi.fn((): AudioTimestamp => ({
        contextTime: 9.95,
        performanceTime: 1_000
    }));
    public readonly resume = vi.fn((): Promise<void> => {
        this.state = 'running';
        return Promise.resolve();
    });
    public readonly sampleRate: number;
    public currentTime = 10;
    public outputLatency = 0.04;
    public state: AudioContextState = 'suspended';

    public constructor(public readonly options?: AudioContextOptions) {
        this.sampleRate = options?.sampleRate ?? 48_000;
        FakeAudioContext.instances.push(this);
    }
}

type WorkletControllerHarness = {
    configuration: { maxChunks: number }
    destroy: ReturnType<typeof vi.fn>
    emitTelemetry: (telemetry: AudioWorkletTelemetry) => void
    generation: number
    getTelemetry: ReturnType<typeof vi.fn>
    onTelemetry: ReturnType<typeof vi.fn>
    setMuted: ReturnType<typeof vi.fn>
    setPlaying: ReturnType<typeof vi.fn>
    setVolume: ReturnType<typeof vi.fn>
};

function createWorkletController(): WorkletControllerHarness {
    const telemetryListeners = new Set<(telemetry: AudioWorkletTelemetry) => void>();
    return {
        configuration: { maxChunks: 16 },
        destroy: vi.fn(),
        emitTelemetry: (telemetry: AudioWorkletTelemetry): void => {
            for (const listener of telemetryListeners) {
                listener(telemetry);
            }
        },
        generation: 1,
        getTelemetry: vi.fn((): AudioWorkletTelemetry | null => null),
        onTelemetry: vi.fn((listener: (telemetry: AudioWorkletTelemetry) => void): (() => void) => {
            telemetryListeners.add(listener);
            return (): void => {
                telemetryListeners.delete(listener);
            };
        }),
        setMuted: vi.fn(),
        setPlaying: vi.fn(),
        setVolume: vi.fn()
    };
}

function createTelemetry(
    overrides: Partial<AudioWorkletTelemetry> = {}
): AudioWorkletTelemetry {
    return {
        consumedFrames: 4_096,
        droppedFrames: 0,
        generation: 1,
        hasPhysicalOutputTimeCorrelation: false,
        mediaTimeContextTimeMicroseconds: secondsToMicroseconds(10),
        mediaTimeMicroseconds: secondsToMicroseconds(5),
        muted: false,
        outputFrames: 4_096,
        overflowEvents: 0,
        overflowFrames: 0,
        playing: true,
        queuedFrames: 2_048,
        reason: 'periodic',
        sequence: null,
        staleChunks: 0,
        type: 'telemetry',
        underflowEvents: 0,
        underflowFrames: 0,
        volume: 1,
        ...overrides
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
            channelCount: 2,
            codec: 'flac',
            sampleRate: 48_000
        });

        const audioContext = FakeAudioContext.instances[0];
        expect(audioContext.options).toEqual({
            latencyHint: 'playback',
            sampleRate: 48_000
        });
        expect(audioWorkletMockState.create).toHaveBeenCalledWith(audioContext, {
            channelCount: 2,
            maxBufferedFrames: 96_000
        });
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(binding.configuration).toEqual({
            channelCount: 2,
            codec: 'flac',
            sampleRate: 48_000
        });
        expect(binding.output.getEstimatedOutputLatencyMicroseconds?.()).toBe(50_000);

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

    it.each([
        { channelCount: 6, sampleRate: 48_000 },
        { channelCount: 2, sampleRate: 44_100 }
    ])('rejects an unmeasured output layout %#', async configuration => {
        const factory = createBrowserCustomAudioOutputFactory();

        await expect(factory({
            ...configuration,
            codec: 'flac'
        })).rejects.toThrow('Custom audio output requires 2 channels at 48000 Hz');
        expect(FakeAudioContext.instances).toHaveLength(0);
        expect(audioWorkletMockState.create).not.toHaveBeenCalled();
    });

    it('closes an unused prewarm when rejecting an unmeasured layout', async () => {
        const prewarm = prewarmBrowserAudioContext(48_000);
        const factory = createBrowserCustomAudioOutputFactory(prewarm);

        await expect(factory({
            channelCount: 6,
            codec: 'ac3',
            sampleRate: 48_000
        })).rejects.toThrow('Custom audio output requires 2 channels at 48000 Hz');

        expect(FakeAudioContext.instances[0].close).toHaveBeenCalledOnce();
        expect(audioWorkletMockState.create).not.toHaveBeenCalled();
    });

    it('maps raw worklet time to the sample currently reaching physical output', async () => {
        const workletController = createWorkletController();
        const rawTelemetry = createTelemetry();
        workletController.getTelemetry.mockReturnValue(rawTelemetry);
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const mappedListener = vi.fn();
        const rawListener = vi.fn();
        binding.output.onTelemetry(mappedListener);
        workletController.onTelemetry(rawListener);

        expect(binding.output.getTelemetry()).toEqual({
            ...rawTelemetry,
            hasPhysicalOutputTimeCorrelation: true,
            mediaTimeMicroseconds: secondsToMicroseconds(4.95)
        });

        workletController.emitTelemetry(rawTelemetry);
        expect(mappedListener).toHaveBeenCalledWith({
            ...rawTelemetry,
            hasPhysicalOutputTimeCorrelation: true,
            mediaTimeMicroseconds: secondsToMicroseconds(4.95)
        });
        expect(rawListener).toHaveBeenCalledWith(rawTelemetry);

        await binding.output.destroy();
    });

    it('holds a signed flush anchor until physical output correlation is available', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        const mappedListener = vi.fn();
        binding.output.onTelemetry(mappedListener);
        const mediaFloorMicroseconds = secondsToMicroseconds(-0.5);
        const flushTelemetry = createTelemetry({
            mediaTimeContextTimeMicroseconds: null,
            mediaTimeMicroseconds: mediaFloorMicroseconds,
            reason: 'flush'
        });
        const uncorrelatedTelemetry = createTelemetry({
            mediaTimeMicroseconds: secondsToMicroseconds(-0.4)
        });

        workletController.emitTelemetry(flushTelemetry);
        audioContext.getOutputTimestamp.mockReturnValue({ contextTime: 0, performanceTime: 0 });
        workletController.getTelemetry.mockReturnValue(uncorrelatedTelemetry);
        workletController.emitTelemetry(uncorrelatedTelemetry);

        expect(binding.output.getTelemetry()).toEqual({
            ...uncorrelatedTelemetry,
            mediaTimeMicroseconds: mediaFloorMicroseconds
        });
        expect(mappedListener).toHaveBeenLastCalledWith({
            ...uncorrelatedTelemetry,
            mediaTimeMicroseconds: mediaFloorMicroseconds
        });

        await binding.output.destroy();
    });

    it('clamps a valid physical-output mapping to the flush media floor', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        const mediaFloorMicroseconds = secondsToMicroseconds(5);
        workletController.emitTelemetry(createTelemetry({
            mediaTimeContextTimeMicroseconds: null,
            mediaTimeMicroseconds: mediaFloorMicroseconds,
            reason: 'flush'
        }));
        const startupTelemetry = createTelemetry({
            mediaTimeContextTimeMicroseconds: secondsToMicroseconds(10.02),
            mediaTimeMicroseconds: secondsToMicroseconds(5.02)
        });
        workletController.getTelemetry.mockReturnValue(startupTelemetry);

        expect(binding.output.getTelemetry()).toEqual({
            ...startupTelemetry,
            hasPhysicalOutputTimeCorrelation: true,
            mediaTimeMicroseconds: mediaFloorMicroseconds
        });

        audioContext.currentTime = 10.25;
        audioContext.getOutputTimestamp.mockReturnValue({
            contextTime: 10.05,
            performanceTime: 1_000
        });
        const progressingTelemetry = createTelemetry({
            mediaTimeContextTimeMicroseconds: secondsToMicroseconds(10.2),
            mediaTimeMicroseconds: secondsToMicroseconds(5.2)
        });
        workletController.getTelemetry.mockReturnValue(progressingTelemetry);
        expect(binding.output.getTelemetry()).toEqual({
            ...progressingTelemetry,
            hasPhysicalOutputTimeCorrelation: true,
            mediaTimeMicroseconds: secondsToMicroseconds(5.05)
        });

        await binding.output.destroy();
    });

    it('resets the startup anchor on every flush and worklet generation', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        audioContext.getOutputTimestamp.mockReturnValue({ contextTime: 0, performanceTime: 0 });

        workletController.emitTelemetry(createTelemetry({
            mediaTimeContextTimeMicroseconds: null,
            mediaTimeMicroseconds: secondsToMicroseconds(5),
            reason: 'flush'
        }));
        workletController.emitTelemetry(createTelemetry({
            mediaTimeContextTimeMicroseconds: null,
            mediaTimeMicroseconds: secondsToMicroseconds(6),
            reason: 'flush'
        }));
        const sameGenerationTelemetry = createTelemetry({
            mediaTimeMicroseconds: secondsToMicroseconds(6.1)
        });
        workletController.getTelemetry.mockReturnValue(sameGenerationTelemetry);
        expect(binding.output.getTelemetry()?.mediaTimeMicroseconds).toBe(6_000_000);

        const unanchoredNextGenerationTelemetry = createTelemetry({
            generation: 2,
            mediaTimeMicroseconds: secondsToMicroseconds(42)
        });
        workletController.emitTelemetry(unanchoredNextGenerationTelemetry);
        workletController.getTelemetry.mockReturnValue(unanchoredNextGenerationTelemetry);
        expect(binding.output.getTelemetry()?.mediaTimeMicroseconds).toBe(42_000_000);

        workletController.emitTelemetry(createTelemetry({
            generation: 2,
            mediaTimeContextTimeMicroseconds: null,
            mediaTimeMicroseconds: secondsToMicroseconds(41),
            reason: 'flush'
        }));
        workletController.getTelemetry.mockReturnValue(unanchoredNextGenerationTelemetry);
        expect(binding.output.getTelemetry()?.mediaTimeMicroseconds).toBe(41_000_000);

        await binding.output.destroy();
    });

    it('never extrapolates beyond the latest rendered media sample', async () => {
        const workletController = createWorkletController();
        const rawTelemetry = createTelemetry({ reason: 'underflow' });
        workletController.getTelemetry.mockReturnValue(rawTelemetry);
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        audioContext.currentTime = 10.1;
        audioContext.getOutputTimestamp.mockReturnValue({
            contextTime: 10.05,
            performanceTime: 1_000
        });

        expect(binding.output.getTelemetry()).toEqual({
            ...rawTelemetry,
            hasPhysicalOutputTimeCorrelation: true
        });

        await binding.output.destroy();
    });

    it('falls back to raw time for unavailable, zero, invalid, or unbounded timestamps', async () => {
        const workletController = createWorkletController();
        const rawTelemetry = createTelemetry();
        workletController.getTelemetry.mockReturnValue(rawTelemetry);
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];

        audioContext.getOutputTimestamp.mockReturnValue({ contextTime: 0, performanceTime: 0 });
        expect(binding.output.getTelemetry()).toEqual(rawTelemetry);

        audioContext.getOutputTimestamp.mockReturnValue({
            contextTime: 7,
            performanceTime: 1_000
        });
        expect(binding.output.getTelemetry()).toEqual(rawTelemetry);

        audioContext.currentTime = 9;
        audioContext.getOutputTimestamp.mockReturnValue({
            contextTime: 9.5,
            performanceTime: 1_000
        });
        expect(binding.output.getTelemetry()).toEqual(rawTelemetry);

        audioContext.currentTime = 10;
        audioContext.getOutputTimestamp.mockImplementation((): AudioTimestamp => {
            throw new Error('Timestamp unavailable');
        });
        expect(binding.output.getTelemetry()).toEqual(rawTelemetry);

        await binding.output.destroy();
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

    it('bounds a stalled worklet creation and closes its context', async () => {
        vi.useFakeTimers();
        try {
            audioWorkletMockState.create.mockReturnValue(new Promise(() => undefined));
            const factoryResult = Promise.resolve(createBrowserCustomAudioOutputFactory()({
                channelCount: 2,
                codec: 'aac',
                sampleRate: 48_000
            }));
            const observedResult = factoryResult.catch((error: unknown): unknown => error);

            await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(
                DEFAULT_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS
            ));

            expect(await observedResult).toEqual(
                new Error('AudioWorklet output creation exceeded its bounded timeout')
            );
            expect(FakeAudioContext.instances[0].close).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds a stalled context resume during playback', async () => {
        vi.useFakeTimers();
        try {
            const workletController = createWorkletController();
            audioWorkletMockState.create.mockResolvedValue(workletController);
            const binding = await createBrowserCustomAudioOutputFactory()({
                channelCount: 2,
                codec: 'opus',
                sampleRate: 48_000
            });
            const audioContext = FakeAudioContext.instances[0];
            audioContext.state = 'suspended';
            audioContext.resume.mockReturnValueOnce(new Promise(() => undefined));
            const resumeResult = Promise.resolve(binding.output.setPlaying(true));
            const observedResult = resumeResult.catch((error: unknown): unknown => error);

            await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(
                DEFAULT_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS
            ));

            expect(await observedResult).toEqual(
                new Error('AudioContext resume exceeded its bounded timeout')
            );
            await binding.output.destroy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds a stalled context close during destruction', async () => {
        vi.useFakeTimers();
        try {
            const workletController = createWorkletController();
            audioWorkletMockState.create.mockResolvedValue(workletController);
            const binding = await createBrowserCustomAudioOutputFactory()({
                channelCount: 2,
                codec: 'flac',
                sampleRate: 48_000
            });
            FakeAudioContext.instances[0].close.mockReturnValueOnce(
                new Promise(() => undefined)
            );
            const destroyResult = Promise.resolve(binding.output.destroy());
            const observedResult = destroyResult.catch((error: unknown): unknown => error);

            await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(
                DEFAULT_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS
            ));

            expect(await observedResult).toEqual(
                new Error('AudioContext close exceeded its bounded timeout')
            );
            expect(workletController.destroy).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });
});
