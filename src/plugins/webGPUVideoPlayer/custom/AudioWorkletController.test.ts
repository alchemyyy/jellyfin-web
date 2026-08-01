import { afterEach, describe, expect, it, vi } from 'vitest';

import { secondsToMicroseconds } from '../MediaTime';
import type { AudioWorkletTelemetry, CustomAudioWorkletMessage } from './AudioWorkletProtocol';
import AudioWorkletController, {
    type AudioWorkletControllerConfiguration
} from './AudioWorkletController';
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
        expect(listener).toHaveBeenCalledOnce();
        expect(listener).toHaveBeenCalledWith(telemetry);
        expect(controller.getTelemetry()).toEqual(telemetry);
        expect(controller.getTelemetry()).not.toBe(telemetry);

        unsubscribe();
        harness.port.dispatchTelemetry(createTelemetry({ queuedFrames: 0 }));
        expect(listener).toHaveBeenCalledOnce();
    });

    it('destroys once and rejects subsequent operations', () => {
        const harness = createAudioNodeHarness();
        const controller = new AudioWorkletController(harness.node, configuration);

        controller.destroy();
        controller.destroy();

        expect(harness.port.messages).toEqual([ { message: { type: 'destroy' }, transferables: [] } ]);
        expect(harness.port.close).toHaveBeenCalledOnce();
        expect(harness.disconnect).toHaveBeenCalledOnce();
        expect(controller.generation).toBe(2);
        expect(() => controller.setPlaying(true)).toThrow('destroyed');
    });

    it('packages a self-contained transferable worklet source', () => {
        const source = getCustomAudioWorkletSource();

        expect(source).toContain(`registerProcessor('${CUSTOM_AUDIO_WORKLET_PROCESSOR_NAME}'`);
        expect(source).toContain("case 'enqueue':");
        expect(source).toContain("case 'flush':");
        expect(source).not.toContain('SharedArrayBuffer');
    });
});
