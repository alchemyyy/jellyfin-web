import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    microsecondsToMilliseconds,
    secondsToMicroseconds
} from '../MediaTime';
import type { AudioWorkletTelemetry } from './AudioWorkletProtocol';

const audioWorkletMockState = vi.hoisted(() => ({
    create: vi.fn()
}));

vi.mock('./AudioWorkletController', async importOriginal => {
    const originalModule = await importOriginal<typeof import('./AudioWorkletController')>();
    return {
        ...originalModule,
        default: class MockAudioWorkletController {
            static readonly create = audioWorkletMockState.create;
        }
    };
});

vi.mock('./CustomDecodeAudioBridge', () => ({
    default: class MockCustomDecodeAudioBridge {
        public constructor(public readonly controller: object) {}
    }
}));

import { createBrowserCustomAudioOutputFactory } from './BrowserCustomAudioOutput';
import { prewarmBrowserAudioContext } from './BrowserAudioContextPrewarm';
import {
    acquireSharedBrowserAudioContext,
    closeIdleSharedBrowserAudioContexts
} from './BrowserAudioContextPool';
import {
    AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS,
    DEFAULT_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS,
    SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS,
    waitForBrowserAudioOperation
} from './BrowserAudioOperation';

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
    public readonly suspend = vi.fn((): Promise<void> => {
        this.state = 'suspended';
        return Promise.resolve();
    });

    public constructor(public readonly options?: AudioContextOptions) {
        this.sampleRate = options?.sampleRate ?? 48_000;
        FakeAudioContext.instances.push(this);
    }
}

type WorkletControllerHarness = {
    configuration: {
        channelCount: number
        maxBufferedFrames: number
        maxChunks: number
        sampleRate: number
        telemetryIntervalFrames: number
    }
    deactivate: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    emitTelemetry: (telemetry: AudioWorkletTelemetry) => void
    enqueue: ReturnType<typeof vi.fn>
    flush: ReturnType<typeof vi.fn>
    generation: number
    getTelemetry: ReturnType<typeof vi.fn>
    onTelemetry: ReturnType<typeof vi.fn>
    seek: ReturnType<typeof vi.fn>
    setMuted: ReturnType<typeof vi.fn>
    setPlaying: ReturnType<typeof vi.fn>
    setVolume: ReturnType<typeof vi.fn>
};

type Deferred = {
    promise: Promise<void>
    resolve: () => void
};

type WorkletControllerDeferred = {
    promise: Promise<WorkletControllerHarness>
    resolve: (controller: WorkletControllerHarness) => void
};

function createDeferred(): Deferred {
    let resolver: (() => void) | null = null;
    const promise = new Promise<void>((resolve): void => {
        resolver = resolve;
    });
    return {
        promise,
        resolve: (): void => {
            if (!resolver) {
                throw new Error('Deferred resolver is unavailable');
            }
            resolver();
        }
    };
}

function createWorkletControllerDeferred(): WorkletControllerDeferred {
    let resolver: ((controller: WorkletControllerHarness) => void) | null = null;
    const promise = new Promise<WorkletControllerHarness>((resolve): void => {
        resolver = resolve;
    });
    return {
        promise,
        resolve: (controller: WorkletControllerHarness): void => {
            if (!resolver) {
                throw new Error('Worklet controller deferred resolver is unavailable');
            }
            resolver(controller);
        }
    };
}

function createWorkletController(): WorkletControllerHarness {
    const telemetryListeners = new Set<(telemetry: AudioWorkletTelemetry) => void>();
    return {
        configuration: {
            channelCount: 2,
            maxBufferedFrames: 96_000,
            maxChunks: 1_024,
            sampleRate: 48_000,
            telemetryIntervalFrames: 4_096
        },
        deactivate: vi.fn((): Promise<void> => Promise.resolve()),
        destroy: vi.fn((): Promise<void> => Promise.resolve()),
        emitTelemetry: (telemetry: AudioWorkletTelemetry): void => {
            for (const listener of telemetryListeners) {
                listener(telemetry);
            }
        },
        generation: 1,
        getTelemetry: vi.fn((): AudioWorkletTelemetry | null => null),
        enqueue: vi.fn(),
        flush: vi.fn((): number => 2),
        onTelemetry: vi.fn((listener: (telemetry: AudioWorkletTelemetry) => void): (() => void) => {
            telemetryListeners.add(listener);
            return (): void => {
                telemetryListeners.delete(listener);
            };
        }),
        seek: vi.fn((): number => 2),
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

    afterEach(async () => {
        await closeIdleSharedBrowserAudioContexts().catch((): void => undefined);
    });

    it('creates an exact-rate bounded worklet output on the shared context', async () => {
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
            maxBufferedFrames: 96_000,
            maxChunks: 1_024,
            telemetryIntervalFrames: 4_096
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
        expect(workletController.deactivate).toHaveBeenCalledOnce();
        expect(workletController.destroy).not.toHaveBeenCalled();
        expect(audioContext.close).not.toHaveBeenCalled();
        expect(audioContext.suspend).toHaveBeenCalledOnce();
    });

    it('keeps repeated output creation and destruction bounded to one context', async () => {
        const workletControllers: WorkletControllerHarness[] = [];
        audioWorkletMockState.create.mockImplementation((): WorkletControllerHarness => {
            const workletController = createWorkletController();
            workletControllers.push(workletController);
            return workletController;
        });

        for (let sessionIndex = 0; sessionIndex < 10; sessionIndex += 1) {
            const prewarm = prewarmBrowserAudioContext(48_000);
            const binding = await createBrowserCustomAudioOutputFactory(prewarm)({
                channelCount: 2,
                codec: 'aac',
                sampleRate: 48_000
            });
            await binding.output.destroy();
        }

        expect(FakeAudioContext.instances).toHaveLength(1);
        expect(FakeAudioContext.instances[0].resume).toHaveBeenCalledTimes(10);
        expect(FakeAudioContext.instances[0].suspend).toHaveBeenCalledTimes(10);
        expect(FakeAudioContext.instances[0].close).not.toHaveBeenCalled();
        expect(workletControllers).toHaveLength(1);
        expect(workletControllers[0].deactivate).toHaveBeenCalledTimes(10);
        expect(workletControllers[0].destroy).not.toHaveBeenCalled();
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

        expect(FakeAudioContext.instances[0].close).not.toHaveBeenCalled();
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
        expect(audioContext.close).not.toHaveBeenCalled();
    });

    it('rejects a prewarmed context invalidated while its resume is pending', async () => {
        const resume = createDeferred();
        class PendingResumeAudioContext extends FakeAudioContext {
            public override readonly resume = vi.fn((): Promise<void> => resume.promise);
        }
        vi.stubGlobal('AudioContext', PendingResumeAudioContext);
        const prewarm = prewarmBrowserAudioContext(48_000);
        const factoryResult = createBrowserCustomAudioOutputFactory(prewarm)({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const invalidatingReference = acquireSharedBrowserAudioContext(48_000);

        await invalidatingReference.invalidate();
        resume.resolve();

        await expect(factoryResult).rejects.toThrow(
            'AudioContext was invalidated while preparing custom audio output'
        );
        expect(audioWorkletMockState.create).not.toHaveBeenCalled();
        expect(FakeAudioContext.instances[0].close).toHaveBeenCalledOnce();
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
        expect(FakeAudioContext.instances[1].close).not.toHaveBeenCalled();
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

    it('makes output destruction idempotent while leaving the shared context warm', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        const asynchronousOutput = binding.output as unknown as {
            destroy: () => Promise<void>
        };

        const firstDestroyPromise = asynchronousOutput.destroy();
        const secondDestroyPromise = asynchronousOutput.destroy();

        expect(secondDestroyPromise).toBe(firstDestroyPromise);
        await firstDestroyPromise;
        expect(workletController.deactivate).toHaveBeenCalledOnce();
        expect(workletController.destroy).not.toHaveBeenCalled();
        expect(audioContext.close).not.toHaveBeenCalled();
    });

    it('reports an explicit shared context teardown failure', async () => {
        const workletController = createWorkletController();
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];
        audioContext.close.mockRejectedValueOnce(new Error('Context close failed'));

        await binding.output.destroy();
        await expect(closeIdleSharedBrowserAudioContexts()).rejects.toThrow(
            'Context close failed'
        );

        expect(workletController.deactivate).toHaveBeenCalledOnce();
        expect(workletController.destroy).not.toHaveBeenCalled();
        expect(audioContext.close).toHaveBeenCalledOnce();
    });

    it('invalidates the shared context when processor deactivation fails', async () => {
        const workletController = createWorkletController();
        workletController.deactivate.mockRejectedValueOnce(
            new Error('Processor deactivation failed')
        );
        audioWorkletMockState.create.mockResolvedValue(workletController);
        const binding = await createBrowserCustomAudioOutputFactory()({
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        });
        const audioContext = FakeAudioContext.instances[0];

        await expect(binding.output.destroy()).rejects.toThrow(
            'Processor deactivation failed'
        );

        expect(workletController.destroy).toHaveBeenCalledOnce();
        expect(audioContext.close).toHaveBeenCalledOnce();
    });

    it('overlaps failed processor retirement with bounded context close', async () => {
        vi.useFakeTimers();
        try {
            const workletController = createWorkletController();
            workletController.deactivate.mockImplementationOnce((): Promise<void> => (
                waitForBrowserAudioOperation(
                    new Promise<void>(() => undefined),
                    'AudioWorklet lease deactivation',
                    AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS
                )
            ));
            workletController.destroy.mockImplementationOnce((): Promise<void> => (
                waitForBrowserAudioOperation(
                    new Promise<void>(() => undefined),
                    'AudioWorklet processor retirement',
                    AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS
                )
            ));
            audioWorkletMockState.create.mockResolvedValue(workletController);
            const binding = await createBrowserCustomAudioOutputFactory()({
                channelCount: 2,
                codec: 'opus',
                sampleRate: 48_000
            });
            const audioContext = FakeAudioContext.instances[0];
            audioContext.close.mockReturnValueOnce(new Promise(() => undefined));

            const destroyResult = Promise.resolve(binding.output.destroy());
            const observedResult = destroyResult.catch((error: unknown): unknown => error);
            let destroySettled = false;
            const settleObservationPromise = observedResult.then((): void => {
                destroySettled = true;
            });
            const sequentialTimeoutMilliseconds = microsecondsToMilliseconds(
                AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS
            ) + microsecondsToMilliseconds(
                SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS
            );
            expect(sequentialTimeoutMilliseconds).toBeLessThan(900);

            await vi.advanceTimersByTimeAsync(
                sequentialTimeoutMilliseconds - 1
            );
            expect(destroySettled).toBe(false);
            expect(audioContext.close).toHaveBeenCalledOnce();
            expect(workletController.destroy).toHaveBeenCalledOnce();
            await vi.advanceTimersByTimeAsync(1);

            expect(await observedResult).toEqual(
                new Error('AudioWorklet lease deactivation exceeded its bounded timeout')
            );
            await settleObservationPromise;
            expect(destroySettled).toBe(true);
            await vi.advanceTimersByTimeAsync(
                microsecondsToMilliseconds(AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS)
                    - microsecondsToMilliseconds(SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS)
            );
        } finally {
            vi.useRealTimers();
        }
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

    it('invalidates a worklet lease that resolves after creation times out', async () => {
        vi.useFakeTimers();
        try {
            const deferredCreation = createWorkletControllerDeferred();
            audioWorkletMockState.create.mockReturnValueOnce(deferredCreation.promise);
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
            const timedOutContext = FakeAudioContext.instances[0];
            expect(timedOutContext.close).toHaveBeenCalledOnce();

            const lateWorkletController = createWorkletController();
            deferredCreation.resolve(lateWorkletController);
            await vi.advanceTimersByTimeAsync(0);

            expect(lateWorkletController.destroy).toHaveBeenCalledOnce();
            expect(lateWorkletController.deactivate).not.toHaveBeenCalled();

            const replacementWorkletController = createWorkletController();
            audioWorkletMockState.create.mockResolvedValueOnce(replacementWorkletController);
            const replacementBinding = await createBrowserCustomAudioOutputFactory()({
                channelCount: 2,
                codec: 'aac',
                sampleRate: 48_000
            });
            expect(FakeAudioContext.instances[1]).not.toBe(timedOutContext);
            await replacementBinding.output.destroy();
            expect(replacementWorkletController.deactivate).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('invalidates a context whose initial resume times out', async () => {
        vi.useFakeTimers();
        try {
            class StalledResumeAudioContext extends FakeAudioContext {
                public override readonly resume = vi.fn(
                    (): Promise<void> => new Promise(() => undefined)
                );
            }
            vi.stubGlobal('AudioContext', StalledResumeAudioContext);
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
                new Error('AudioContext resume exceeded its bounded timeout')
            );
            const poisonedContext = FakeAudioContext.instances[0];
            expect(poisonedContext.close).toHaveBeenCalledOnce();
            expect(audioWorkletMockState.create).not.toHaveBeenCalled();

            vi.stubGlobal('AudioContext', FakeAudioContext);
            const workletController = createWorkletController();
            audioWorkletMockState.create.mockResolvedValue(workletController);
            const replacementBinding = await createBrowserCustomAudioOutputFactory()({
                channelCount: 2,
                codec: 'aac',
                sampleRate: 48_000
            });
            expect(FakeAudioContext.instances[1]).not.toBe(poisonedContext);
            await replacementBinding.output.destroy();
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

    it('bounds a stalled explicit shared context close', async () => {
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
            await binding.output.destroy();
            const closeResult = closeIdleSharedBrowserAudioContexts();
            const observedResult = closeResult.catch((error: unknown): unknown => error);

            await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(
                SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS
            ));

            expect(await observedResult).toEqual(
                new Error('Shared AudioContext close exceeded its bounded timeout')
            );
            expect(workletController.deactivate).toHaveBeenCalledOnce();
            expect(workletController.destroy).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
});
