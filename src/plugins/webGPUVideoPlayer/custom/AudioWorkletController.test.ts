import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    microsecondsToMilliseconds,
    secondsToMicroseconds
} from '../MediaTime';
import type { AudioWorkletTelemetry, CustomAudioWorkletMessage } from './AudioWorkletProtocol';
import AudioWorkletController, {
    type AudioWorkletControllerConfiguration
} from './AudioWorkletController';
import { AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS } from './BrowserAudioOperation';
import {
    CUSTOM_AUDIO_WORKLET_PROCESSOR_NAME,
    getCustomAudioWorkletSource
} from './AudioWorkletProcessorSource';

type PostedMessage = {
    message: CustomAudioWorkletMessage
    transferables: readonly Transferable[]
};

class MockMessagePort extends EventTarget {
    public readonly close = vi.fn();
    public readonly messages: PostedMessage[] = [];
    public readonly start = vi.fn();

    public postMessage(message: CustomAudioWorkletMessage, transferables: Transferable[] = []): void {
        this.messages.push({ message, transferables });
    }

    public dispatchTelemetry(telemetry: AudioWorkletTelemetry): void {
        this.dispatchEvent(new MessageEvent('message', { data: telemetry }));
    }

    public dispatchRetired(): void {
        this.dispatchEvent(new MessageEvent('message', { data: { type: 'retired' } }));
    }

    public dispatchDeactivated(leaseId: number): void {
        this.dispatchEvent(new MessageEvent('message', {
            data: { leaseId, type: 'deactivated' }
        }));
    }
}

type AudioNodeHarness = {
    disconnect: ReturnType<typeof vi.fn>
    node: AudioWorkletNode
    port: MockMessagePort
};

const configuration: AudioWorkletControllerConfiguration = {
    channelCount: 2,
    maxBufferedFrames: 8,
    maxChunks: 4,
    sampleRate: 48_000,
    telemetryIntervalFrames: 1_024
};

function createAudioNodeHarness(): AudioNodeHarness {
    const port = new MockMessagePort();
    const disconnect = vi.fn();
    const node = { disconnect, port } as unknown as AudioWorkletNode;
    return { disconnect, node, port };
}

function createTelemetry(overrides: Partial<AudioWorkletTelemetry> = {}): AudioWorkletTelemetry {
    return {
        consumedFrames: 4,
        droppedFrames: 0,
        generation: 1,
        hasPhysicalOutputTimeCorrelation: false,
        mediaTimeContextTimeMicroseconds: secondsToMicroseconds(1.01),
        mediaTimeMicroseconds: secondsToMicroseconds(1),
        muted: false,
        outputFrames: 4,
        overflowEvents: 0,
        overflowFrames: 0,
        playing: true,
        queuedFrames: 2,
        reason: 'periodic',
        sequence: null,
        signal: {
            analyzedFrameCount: 4,
            analyzedSampleCount: 8,
            clippedSampleCount: 0,
            nonFiniteSampleCount: 0,
            samplePeak: 0.5,
            sampleSquareSum: 1
        },
        staleChunks: 0,
        type: 'telemetry',
        underflowEvents: 0,
        underflowFrames: 0,
        volume: 1,
        ...overrides
    };
}

describe('AudioWorkletController', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('creates an explicit speaker-layout output without browser-selected channel expansion', async () => {
        let capturedOptions: AudioWorkletNodeOptions | undefined;
        const connect = vi.fn();
        class MockAudioWorkletNode {
            public readonly connect = connect;
            public readonly port = new MockMessagePort();

            public constructor(
                _audioContext: BaseAudioContext,
                _processorName: string,
                options?: AudioWorkletNodeOptions
            ) {
                capturedOptions = options;
            }
        }
        const addModule = vi.fn((): Promise<void> => Promise.resolve());
        const audioContext = {
            audioWorklet: { addModule },
            destination: {},
            sampleRate: 48_000
        } as unknown as AudioContext;
        vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);
        vi.stubGlobal('URL', {
            createObjectURL: vi.fn((): string => 'blob:audio-worklet'),
            revokeObjectURL: vi.fn()
        });

        await AudioWorkletController.create(audioContext, {
            channelCount: 2,
            maxBufferedFrames: 96_000
        });

        expect(capturedOptions).toMatchObject({
            channelCount: 2,
            channelCountMode: 'explicit',
            channelInterpretation: 'speakers',
            outputChannelCount: [ 2 ]
        });
        expect(connect).toHaveBeenCalledWith(audioContext.destination);
    });

    it('submits planar PCM with transferable buffers and generation metadata', () => {
        const harness = createAudioNodeHarness();
        const controller = new AudioWorkletController(harness.node, configuration);
        const left = new Float32Array([ 1, 2, 3 ]);
        const right = new Float32Array([ 4, 5, 6 ]);

        const submission = controller.enqueue({
            channelData: [ left, right ],
            timestampMicroseconds: secondsToMicroseconds(-1)
        }, controller.generation);

        expect(submission).toEqual({ frameCount: 3, sequence: 1, status: 'submitted' });
        expect(harness.port.messages).toHaveLength(1);
        expect(harness.port.messages[0].message).toMatchObject({
            generation: 1,
            sequence: 1,
            timestampMicroseconds: -1_000_000,
            type: 'enqueue'
        });
        expect(harness.port.messages[0].transferables).toEqual([ left.buffer, right.buffer ]);
        expect(harness.port.start).toHaveBeenCalledOnce();
    });

    it('does not transfer stale or individually oversized chunks', () => {
        const harness = createAudioNodeHarness();
        const controller = new AudioWorkletController(harness.node, configuration);
        const staleGeneration = controller.generation;
        const currentGeneration = controller.seek(secondsToMicroseconds(5));

        expect(controller.enqueue({
            channelData: [ new Float32Array(1), new Float32Array(1) ],
            timestampMicroseconds: secondsToMicroseconds(5)
        }, staleGeneration)).toEqual({ frameCount: 1, sequence: null, status: 'stale-generation' });
        expect(controller.enqueue({
            channelData: [ new Float32Array(9), new Float32Array(9) ],
            timestampMicroseconds: secondsToMicroseconds(5)
        }, currentGeneration)).toEqual({ frameCount: 9, sequence: null, status: 'chunk-too-large' });
        expect(harness.port.messages).toHaveLength(1);
        expect(harness.port.messages[0].message).toEqual({
            generation: 2,
            mediaTimeMicroseconds: 5_000_000,
            type: 'flush'
        });
    });

    it('updates playback, volume, and mute without rebuilding the node', () => {
        const harness = createAudioNodeHarness();
        const controller = new AudioWorkletController(harness.node, configuration);

        controller.setPlaying(true);
        controller.setVolume(0.25);
        controller.setMuted(true);

        expect(controller.isPlaying).toBe(true);
        expect(harness.port.messages.map(entry => entry.message)).toEqual([
            { playing: true, type: 'playback' },
            { muted: false, type: 'gain', volume: 0.25 },
            { muted: true, type: 'gain', volume: 0.25 }
        ]);
        expect(() => controller.setVolume(1.1)).toThrow(RangeError);
    });

    it('forwards trusted telemetry and supports deterministic unsubscribe', () => {
        const harness = createAudioNodeHarness();
        const controller = new AudioWorkletController(harness.node, configuration);
        const listener = vi.fn();
        const unsubscribe = controller.onTelemetry(listener);
        const telemetry = createTelemetry();

        harness.port.dispatchTelemetry(telemetry);
        harness.port.dispatchEvent(new MessageEvent('message', { data: { type: 'unrelated' } }));
        harness.port.dispatchEvent(new MessageEvent('message', {
            data: { ...createTelemetry(), mediaTimeContextTimeMicroseconds: -1 }
        }));
        harness.port.dispatchEvent(new MessageEvent('message', {
            data: { ...createTelemetry(), hasPhysicalOutputTimeCorrelation: true }
        }));
        harness.port.dispatchEvent(new MessageEvent('message', {
            data: { ...createTelemetry(), consumedFrames: 0.5 }
        }));
        harness.port.dispatchEvent(new MessageEvent('message', {
            data: {
                ...createTelemetry(),
                signal: { ...createTelemetry().signal, sampleSquareSum: Number.NaN }
            }
        }));
        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith(telemetry);
        expect(controller.getTelemetry()).toEqual(telemetry);
        expect(controller.getTelemetry()).not.toBe(telemetry);

        unsubscribe();
        harness.port.dispatchTelemetry(createTelemetry({ queuedFrames: 0 }));
        expect(listener).toHaveBeenCalledOnce();
    });

    it('waits for the matching lease deactivation and resets session state', async () => {
        const harness = createAudioNodeHarness();
        const controller = new AudioWorkletController(harness.node, configuration);
        harness.port.dispatchTelemetry(createTelemetry());
        controller.setPlaying(true);
        controller.setVolume(0.25);
        controller.setMuted(true);
        expect(controller.enqueue({
            channelData: [ new Float32Array(1), new Float32Array(1) ],
            timestampMicroseconds: secondsToMicroseconds(0)
        }, controller.generation).sequence).toBe(1);

        const firstDeactivation = controller.deactivate(41);
        expect(controller.deactivate(41)).toBe(firstDeactivation);
        await expect(controller.deactivate(42)).rejects.toThrow('already pending');
        expect(harness.port.messages[harness.port.messages.length - 1].message).toEqual({
            generation: 2,
            leaseId: 41,
            type: 'deactivate'
        });
        expect(controller.isPlaying).toBe(false);
        expect(() => controller.setPlaying(true)).toThrow('deactivating');

        let deactivated = false;
        void firstDeactivation.then((): void => {
            deactivated = true;
        });
        harness.port.dispatchDeactivated(40);
        await Promise.resolve();
        expect(deactivated).toBe(false);
        harness.port.dispatchDeactivated(41);
        await firstDeactivation;

        expect(controller.getTelemetry()).toBeNull();
        expect(controller.generation).toBe(2);
        expect(controller.enqueue({
            channelData: [ new Float32Array(1), new Float32Array(1) ],
            timestampMicroseconds: secondsToMicroseconds(0)
        }, controller.generation).sequence).toBe(1);
        controller.setPlaying(true);
        controller.setVolume(0.5);
        expect(harness.port.messages[harness.port.messages.length - 1].message).toEqual({
            muted: false,
            type: 'gain',
            volume: 0.5
        });

        const secondDeactivation = controller.deactivate(42);
        harness.port.dispatchDeactivated(41);
        await Promise.resolve();
        expect(controller.deactivate(42)).toBe(secondDeactivation);
        harness.port.dispatchDeactivated(42);
        await secondDeactivation;
    });

    it('bounds a missing lease deactivation acknowledgement', async () => {
        vi.useFakeTimers();
        const harness = createAudioNodeHarness();
        const controller = new AudioWorkletController(harness.node, configuration);

        const deactivationResult = controller.deactivate(51);
        const observedResult = deactivationResult.catch((error: unknown): unknown => error);
        await vi.advanceTimersByTimeAsync(microsecondsToMilliseconds(
            AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS
        ));

        expect(await observedResult).toEqual(
            new Error('AudioWorklet lease deactivation exceeded its bounded timeout')
        );
        expect(() => controller.setPlaying(true)).toThrow('deactivation failed');
    });

    it('poisons deactivation after message delivery fails', async () => {
        const harness = createAudioNodeHarness();
        const controller = new AudioWorkletController(harness.node, configuration);
        vi.spyOn(harness.port, 'postMessage').mockImplementationOnce((): never => {
            throw new Error('Deactivate delivery failed');
        });

        await expect(controller.deactivate(61)).rejects.toThrow('Deactivate delivery failed');
        expect(() => controller.flush(secondsToMicroseconds(0))).toThrow('deactivation failed');

        const destroyResult = controller.destroy();
        harness.port.dispatchRetired();
        await destroyResult;
    });

    it('rejects pending deactivation when destruction wins the race', async () => {
        const harness = createAudioNodeHarness();
        const controller = new AudioWorkletController(harness.node, configuration);
        const deactivationResult = controller.deactivate(71);
        const observedDeactivation = deactivationResult.catch((error: unknown): unknown => error);

        const destroyResult = controller.destroy();
        harness.port.dispatchDeactivated(71);
        harness.port.dispatchRetired();

        expect(await observedDeactivation).toEqual(
            new Error('Audio worklet controller was destroyed during deactivation')
        );
        await destroyResult;
        harness.port.dispatchDeactivated(71);
        expect(harness.port.close).toHaveBeenCalledOnce();
        expect(harness.disconnect).toHaveBeenCalledOnce();
    });

    it('waits for render-thread retirement before destroying once', async () => {
        const harness = createAudioNodeHarness();
        const controller = new AudioWorkletController(harness.node, configuration);

        const firstDestroyPromise = controller.destroy();
        const secondDestroyPromise = controller.destroy();

        expect(secondDestroyPromise).toBe(firstDestroyPromise);
        expect(harness.port.messages).toEqual([ { message: { type: 'destroy' }, transferables: [] } ]);
        expect(harness.port.close).not.toHaveBeenCalled();
        expect(harness.disconnect).not.toHaveBeenCalled();
        harness.port.dispatchRetired();
        await firstDestroyPromise;

        expect(harness.port.close).toHaveBeenCalledOnce();
        expect(harness.disconnect).toHaveBeenCalledOnce();
        expect(controller.generation).toBe(2);
        expect(() => controller.setPlaying(true)).toThrow('destroyed');
    });

    it('bounds missing render-thread retirement and releases the node', async () => {
        vi.useFakeTimers();
        const harness = createAudioNodeHarness();
        const controller = new AudioWorkletController(harness.node, configuration);

        const destroyResult = controller.destroy();
        const observedResult = destroyResult.catch((error: unknown): unknown => error);
        const timeoutMilliseconds = microsecondsToMilliseconds(
            AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS
        );
        await vi.advanceTimersByTimeAsync(timeoutMilliseconds - 1);
        expect(harness.port.close).not.toHaveBeenCalled();
        expect(harness.disconnect).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);

        expect(await observedResult).toEqual(
            new Error('AudioWorklet processor retirement exceeded its bounded timeout')
        );
        expect(harness.port.close).toHaveBeenCalledOnce();
        expect(harness.disconnect).toHaveBeenCalledOnce();
    });

    it('attempts every local cleanup operation when one throws', async () => {
        const harness = createAudioNodeHarness();
        const controller = new AudioWorkletController(harness.node, configuration);
        harness.port.close.mockImplementationOnce((): never => {
            throw new Error('Port close failed');
        });

        const destroyResult = controller.destroy();
        harness.port.dispatchRetired();

        await expect(destroyResult).rejects.toThrow('Port close failed');
        expect(harness.port.close).toHaveBeenCalledOnce();
        expect(harness.disconnect).toHaveBeenCalledOnce();
    });

    it('preserves message-delivery failure while releasing local resources', async () => {
        const harness = createAudioNodeHarness();
        const controller = new AudioWorkletController(harness.node, configuration);
        vi.spyOn(harness.port, 'postMessage').mockImplementationOnce((): never => {
            throw new Error('Destroy delivery failed');
        });

        await expect(controller.destroy()).rejects.toThrow('Destroy delivery failed');
        expect(harness.port.close).toHaveBeenCalledOnce();
        expect(harness.disconnect).toHaveBeenCalledOnce();
    });

    it('packages a self-contained transferable worklet source', () => {
        const source = getCustomAudioWorkletSource();

        expect(source).toContain(`registerProcessor('${CUSTOM_AUDIO_WORKLET_PROCESSOR_NAME}'`);
        expect(source).toContain("case 'enqueue':");
        expect(source).toContain("case 'deactivate':");
        expect(source).toContain("case 'flush':");
        expect(source).toContain("this.port.postMessage({leaseId, type: 'deactivated'});");
        expect(source).toContain("this.port.postMessage({type: 'retired'});");
        expect(source).not.toContain('SharedArrayBuffer');
    });
});
