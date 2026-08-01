import { describe, expect, it, vi } from 'vitest';

import { secondsToMicroseconds, type Microseconds } from '../MediaTime';
import AudioWorkletController, {
    type AudioWorkletControllerConfiguration
} from './AudioWorkletController';
import type { AudioWorkletTelemetry, CustomAudioWorkletMessage } from './AudioWorkletProtocol';
import CustomDecodeAudioBridge from './CustomDecodeAudioBridge';
import type { DecodeWorkerAudioResponse } from './DecodeWorkerProtocol';
import { requireMicroseconds } from './TimeMath';

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

type BridgeHarness = {
    bridge: CustomDecodeAudioBridge
    controller: AudioWorkletController
    port: MockMessagePort
};

const configuration: AudioWorkletControllerConfiguration = {
    channelCount: 2,
    maxBufferedFrames: 16,
    maxChunks: 4,
    sampleRate: 48_000,
    telemetryIntervalFrames: 128
};

function createHarness(
    overrides: Partial<AudioWorkletControllerConfiguration> = {}
): BridgeHarness {
    const port = new MockMessagePort();
    const node = {
        disconnect: vi.fn(),
        port
    } as unknown as AudioWorkletNode;
    const controller = new AudioWorkletController(node, { ...configuration, ...overrides });
    return {
        bridge: new CustomDecodeAudioBridge(controller),
        controller,
        port
    };
}

function createTelemetry(
    generation: number,
    overrides: Partial<AudioWorkletTelemetry> = {}
): AudioWorkletTelemetry {
    return {
        consumedFrames: 0,
        droppedFrames: 0,
        generation,
        mediaTimeMicroseconds: secondsToMicroseconds(1),
        muted: false,
        outputFrames: 0,
        overflowEvents: 0,
        overflowFrames: 0,
        playing: true,
        queuedFrames: 0,
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

function createAudioResponse(
    generation: number,
    mediaTimeMicroseconds: Microseconds,
    frameCount = 4
): DecodeWorkerAudioResponse {
    return {
        channelCount: 2,
        channelData: [ new Float32Array(frameCount), new Float32Array(frameCount) ],
        durationMicroseconds: requireMicroseconds(Math.round(frameCount * 1_000_000 / 48_000)),
        frameCount,
        generation,
        mediaTimeMicroseconds,
        sampleRate: 48_000,
        type: 'audio'
    };
}

function startBridge(
    harness: BridgeHarness,
    decodeGeneration: number,
    onCreditsReleased = vi.fn(),
    onFailure = vi.fn()
): { onCreditsReleased: ReturnType<typeof vi.fn>, onFailure: ReturnType<typeof vi.fn> } {
    harness.bridge.start({
        audioConfiguration: {
            channelCount: 2,
            codec: 'mp4a.40.2',
            sampleRate: 48_000
        },
        callbacks: { onCreditsReleased, onFailure },
        decodeGeneration,
        startTimeMicroseconds: secondsToMicroseconds(1)
    });
    return { onCreditsReleased, onFailure };
}

describe('CustomDecodeAudioBridge', () => {
    it('transfers planar PCM and releases one worker credit after complete consumption', () => {
        const harness = createHarness();
        const callbacks = startBridge(harness, 7);
        const workletGeneration = harness.controller.generation;
        harness.port.dispatchTelemetry(createTelemetry(workletGeneration, { reason: 'flush' }));

        const audioResponse = createAudioResponse(7, secondsToMicroseconds(1));
        expect(harness.bridge.enqueue(audioResponse, 7)).toEqual({
            frameCount: 4,
            status: 'submitted'
        });
        expect(harness.port.messages.at(-1)?.message).toMatchObject({
            generation: workletGeneration,
            sequence: 1,
            timestampMicroseconds: 1_000_000,
            type: 'enqueue'
        });
        expect(harness.port.messages.at(-1)?.transferables).toEqual(
            audioResponse.channelData.map(channel => channel.buffer)
        );

        harness.port.dispatchTelemetry(createTelemetry(workletGeneration, {
            consumedFrames: 2,
            queuedFrames: 2
        }));
        expect(callbacks.onCreditsReleased).not.toHaveBeenCalled();
        harness.port.dispatchTelemetry(createTelemetry(workletGeneration, {
            consumedFrames: 4,
            queuedFrames: 0
        }));
        expect(callbacks.onCreditsReleased).toHaveBeenCalledWith(1);
        expect(harness.bridge.getTelemetry()).toMatchObject({
            pendingFrameCount: 0,
            pendingSampleCount: 0,
            releasedSampleCredits: 1,
            submittedFrameCount: 4,
            submittedSampleCount: 1
        });
    });

    it('enforces the controller frame bound before the worklet can overflow', () => {
        const harness = createHarness({ maxBufferedFrames: 6 });
        const callbacks = startBridge(harness, 8);

        expect(harness.bridge.enqueue(
            createAudioResponse(8, secondsToMicroseconds(0), 4),
            8
        ).status).toBe('submitted');
        expect(harness.bridge.enqueue(
            createAudioResponse(8, secondsToMicroseconds(0.1), 4),
            8
        ).status).toBe('output-capacity');
        expect(callbacks.onFailure).toHaveBeenCalledOnce();
        expect(callbacks.onFailure).toHaveBeenCalledWith('Decoded audio exceeded the bounded worklet queue');
    });

    it('rejects stale decoder generations without transferring their buffers', () => {
        const harness = createHarness();
        const callbacks = startBridge(harness, 9);
        const previousMessageCount = harness.port.messages.length;

        expect(harness.bridge.enqueue(
            createAudioResponse(8, secondsToMicroseconds(0)),
            8
        ).status).toBe('stale-generation');
        expect(harness.port.messages).toHaveLength(previousMessageCount);
        expect(callbacks.onFailure).not.toHaveBeenCalled();
        expect(harness.bridge.getTelemetry().staleSampleCount).toBe(1);
    });

    it('reports asynchronous worklet rejection and stops without destroying the controller', () => {
        const harness = createHarness();
        const callbacks = startBridge(harness, 10);
        const workletGeneration = harness.controller.generation;
        harness.port.dispatchTelemetry(createTelemetry(workletGeneration, { reason: 'flush' }));
        harness.bridge.enqueue(createAudioResponse(10, secondsToMicroseconds(0)), 10);

        harness.port.dispatchTelemetry(createTelemetry(workletGeneration, {
            reason: 'overflow',
            sequence: 1
        }));
        expect(callbacks.onFailure).toHaveBeenCalledWith('The audio worklet dropped a decoded sample');

        harness.bridge.stop(10);
        expect(harness.port.messages.slice(-2).map(entry => entry.message)).toEqual([
            { playing: false, type: 'playback' },
            { generation: workletGeneration + 1, mediaTimeMicroseconds: 1_000_000, type: 'flush' }
        ]);
    });

    it('requires an exact decoded channel layout and sample rate', () => {
        const harness = createHarness();

        expect(() => harness.bridge.start({
            audioConfiguration: { channelCount: 1, codec: 'opus', sampleRate: 48_000 },
            callbacks: { onCreditsReleased: vi.fn(), onFailure: vi.fn() },
            decodeGeneration: 11,
            startTimeMicroseconds: secondsToMicroseconds(0)
        })).toThrow('channel count');
        expect(() => harness.bridge.start({
            audioConfiguration: { channelCount: 2, codec: 'opus', sampleRate: 44_100 },
            callbacks: { onCreditsReleased: vi.fn(), onFailure: vi.fn() },
            decodeGeneration: 11,
            startTimeMicroseconds: secondsToMicroseconds(0)
        })).toThrow('sample rate');
    });
});
