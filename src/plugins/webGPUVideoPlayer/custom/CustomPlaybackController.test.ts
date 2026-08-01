import { describe, expect, it, vi } from 'vitest';

import {
    millisecondsToMicroseconds,
    secondsToMicroseconds,
    type Microseconds
} from '../MediaTime';
import type { DecodedPresentationFrame } from '../WebGPUPresenter';
import type { AudioWorkletTelemetry } from './AudioWorkletProtocol';
import type CustomDecodeAudioBridge from './CustomDecodeAudioBridge';
import type { CustomDecodeAudioBridgeTelemetry } from './CustomDecodeAudioBridge';
import type {
    CustomDecodeAudioBridgeFactory,
    CustomDecodeSessionEvent,
    CustomDecodeSessionStartOptions,
    CustomDecodeSessionTelemetry
} from './CustomDecodeSession';
import type { DecodeWorkerAudioConfiguration } from './DecodeWorkerProtocol';
import CustomPlaybackController from './CustomPlaybackController';
import type {
    CustomAudioOutput,
    CustomAudioOutputBinding,
    CustomPlaybackControllerEvent,
    CustomPlaybackFallbackRequest,
    CustomPlaybackPlayOptions,
    CustomVideoDecodeSession
} from './CustomPlaybackControllerTypes';

vi.mock('./CustomDecode.worker', () => ({
    default: class MockBundledWorker {}
}));

function createDecodeTelemetry(): CustomDecodeSessionTelemetry {
    return {
        activeGeneration: null,
        audioCodec: null,
        droppedFrameCount: 0,
        failureKind: null,
        firstFrameMediaTimeMicroseconds: null,
        lastAudioMediaTimeMicroseconds: null,
        lastFrameMediaTimeMicroseconds: null,
        queuedFrameCount: 0,
        receivedAudioFrameCount: 0,
        receivedAudioSampleCount: 0,
        receivedFrameCount: 0,
        staleAudioSampleCount: 0,
        staleFrameCount: 0,
        state: 'idle',
        submittedAudioFrameCount: 0,
        submittedAudioSampleCount: 0,
        takenFrameCount: 0
    };
}

class FakeVideoDecodeSession implements CustomVideoDecodeSession {
    private readonly queuedFrames: DecodedPresentationFrame[] = [];
    public readonly starts: CustomDecodeSessionStartOptions[] = [];
    public readonly stop = vi.fn((): Promise<void> => {
        for (const queuedFrame of this.queuedFrames) {
            queuedFrame.frame.close();
        }
        this.queuedFrames.length = 0;
        return Promise.resolve();
    });
    public readonly takeFrame = vi.fn(
        (targetTimeMicroseconds: Microseconds): DecodedPresentationFrame | null => {
            let selectedFrameIndex = -1;
            for (let frameIndex = 0; frameIndex < this.queuedFrames.length; frameIndex += 1) {
                if (this.queuedFrames[frameIndex].mediaTimeMicroseconds
                    > targetTimeMicroseconds) {
                    break;
                }
                selectedFrameIndex = frameIndex;
            }
            if (selectedFrameIndex < 0) {
                return null;
            }

            for (let frameIndex = 0; frameIndex < selectedFrameIndex; frameIndex += 1) {
                this.queuedFrames[frameIndex].frame.close();
            }
            const selectedFrame = this.queuedFrames[selectedFrameIndex];
            this.queuedFrames.splice(0, selectedFrameIndex + 1);
            return selectedFrame;
        }
    );

    public constructor(
        private readonly eventHandler: (event: CustomDecodeSessionEvent) => void,
        private readonly audioBridgeFactory: CustomDecodeAudioBridgeFactory | null
    ) {}

    public emit(event: CustomDecodeSessionEvent): void {
        this.eventHandler(event);
    }

    public getTelemetry(): CustomDecodeSessionTelemetry {
        return {
            ...createDecodeTelemetry(),
            queuedFrameCount: this.queuedFrames.length
        };
    }

    public queueFrame(frame: DecodedPresentationFrame): void {
        this.queuedFrames.push(frame);
    }

    public async prepareAudio(
        configuration: DecodeWorkerAudioConfiguration
    ): Promise<CustomDecodeAudioBridge | null> {
        if (!this.audioBridgeFactory) {
            return null;
        }
        return this.audioBridgeFactory(configuration);
    }

    public start(options: CustomDecodeSessionStartOptions): void {
        this.starts.push({ ...options });
    }
}

class FakeAudioOutput implements CustomAudioOutput {
    private currentGeneration = 1;
    public readonly destroy = vi.fn();
    public readonly setMuted = vi.fn();
    public readonly setPlaying = vi.fn();
    public readonly setVolume = vi.fn();
    private readonly telemetryListeners = new Set<(telemetry: AudioWorkletTelemetry) => void>();

    public get generation(): number {
        return this.currentGeneration;
    }

    public getTelemetry(): AudioWorkletTelemetry | null {
        return null;
    }

    public emitTelemetry(
        mediaTimeMicroseconds: Microseconds,
        generation = this.currentGeneration,
        overrides: Partial<AudioWorkletTelemetry> = {}
    ): void {
        const telemetry: AudioWorkletTelemetry = {
            consumedFrames: 1_024,
            droppedFrames: 0,
            muted: false,
            outputFrames: 1_024,
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
            ...overrides,
            generation,
            mediaTimeMicroseconds
        };
        for (const listener of this.telemetryListeners) {
            listener(telemetry);
        }
    }

    public onTelemetry(listener: (telemetry: AudioWorkletTelemetry) => void): () => void {
        this.telemetryListeners.add(listener);
        return (): void => {
            this.telemetryListeners.delete(listener);
        };
    }

    public setGeneration(generation: number): void {
        this.currentGeneration = generation;
    }
}

class FakeAudioBridge {
    private telemetry: CustomDecodeAudioBridgeTelemetry;

    public constructor(workletGeneration: number | null) {
        this.telemetry = {
            activeDecodeGeneration: null,
            failed: false,
            pendingFrameCount: 0,
            pendingSampleCount: 0,
            releasedSampleCredits: 0,
            staleSampleCount: 0,
            submittedFrameCount: 0,
            submittedSampleCount: 0,
            workletGeneration
        };
    }

    public activate(decodeGeneration: number, workletGeneration: number): void {
        this.telemetry = {
            ...this.telemetry,
            activeDecodeGeneration: decodeGeneration,
            workletGeneration
        };
    }

    public getTelemetry(): CustomDecodeAudioBridgeTelemetry {
        return { ...this.telemetry };
    }

    public setPendingFrameCount(pendingFrameCount: number): void {
        this.telemetry = {
            ...this.telemetry,
            pendingFrameCount,
            pendingSampleCount: pendingFrameCount === 0 ? 0 : 1
        };
    }
}

type ControllerHarness = {
    audioBridge: FakeAudioBridge
    audioOutput: FakeAudioOutput | null
    controller: CustomPlaybackController
    events: CustomPlaybackControllerEvent[]
    fallbackRequests: CustomPlaybackFallbackRequest[]
    setMonotonicTime: (timeMicroseconds: Microseconds) => void
    videoDecodeSession: FakeVideoDecodeSession
};

function createPlayOptions(audioTrackIndex: number | null = null): CustomPlaybackPlayOptions {
    return {
        audioTrackIndex,
        durationMicroseconds: secondsToMicroseconds(120),
        startTimeMicroseconds: secondsToMicroseconds(5),
        url: 'http://localhost/video.mkv?ApiKey=secret',
        videoTrackIndex: 0
    };
}

function createDecodedFrame(mediaTimeMicroseconds: Microseconds): DecodedPresentationFrame {
    return {
        durationMicroseconds: millisecondsToMicroseconds(40),
        frame: { close: vi.fn() } as unknown as VideoFrame,
        mediaTimeMicroseconds
    };
}

function createControllerHarness(withAudio: boolean): ControllerHarness {
    const events: CustomPlaybackControllerEvent[] = [];
    const fallbackRequests: CustomPlaybackFallbackRequest[] = [];
    let videoDecodeSession: FakeVideoDecodeSession | null = null;
    const audioOutput = withAudio ? new FakeAudioOutput() : null;
    const fakeAudioBridge = new FakeAudioBridge(audioOutput?.generation ?? null);
    let monotonicTime = secondsToMicroseconds(10);
    const controller = new CustomPlaybackController({
        audioOutputFactory: audioOutput ?
            (configuration: DecodeWorkerAudioConfiguration): CustomAudioOutputBinding => ({
                bridge: fakeAudioBridge as unknown as CustomDecodeAudioBridge,
                configuration: { ...configuration },
                output: audioOutput
            }) :
            undefined,
        eventHandler: (event: CustomPlaybackControllerEvent): void => {
            events.push(event);
        },
        fallbackHook: (request: CustomPlaybackFallbackRequest): void => {
            fallbackRequests.push(request);
        },
        monotonicTimeSource: (): Microseconds => monotonicTime,
        pipelineStopTimeoutMicroseconds: millisecondsToMicroseconds(100),
        startupTimeoutMicroseconds: millisecondsToMicroseconds(100),
        videoDecodeSessionFactory: (eventHandler, audioBridgeFactory) => {
            videoDecodeSession = new FakeVideoDecodeSession(eventHandler, audioBridgeFactory);
            return videoDecodeSession;
        }
    });
    if (!videoDecodeSession) {
        throw new Error('Video decode session factory was not called');
    }

    return {
        audioBridge: fakeAudioBridge,
        audioOutput,
        controller,
        events,
        fallbackRequests,
        setMonotonicTime: (timeMicroseconds: Microseconds): void => {
            monotonicTime = timeMicroseconds;
        },
        videoDecodeSession
    };
}

async function flushAsyncWork(): Promise<void> {
    for (let iteration = 0; iteration < 32; iteration += 1) {
        await Promise.resolve();
    }
}

type Deferred<Value> = {
    promise: Promise<Value>
    reject: (error: unknown) => void
    resolve: (value: Value) => void
};

function createDeferred<Value>(): Deferred<Value> {
    let rejectPromise: (error: unknown) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    let resolvePromise: (value: Value) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    const promise = new Promise<Value>((resolve, reject) => {
        rejectPromise = reject;
        resolvePromise = resolve;
    });
    return {
        promise,
        reject: rejectPromise,
        resolve: resolvePromise
    };
}

async function startReadyPlayback(harness: ControllerHarness, withAudio: boolean): Promise<number> {
    const startPromise = harness.controller.play(createPlayOptions(withAudio ? 1 : null));
    await flushAsyncWork();
    const generation = harness.videoDecodeSession.starts.at(-1)?.generation;
    if (!generation) {
        throw new Error('Video decode did not start');
    }
    const audioConfiguration: DecodeWorkerAudioConfiguration | null = withAudio ? {
        channelCount: 2,
        codec: 'opus',
        sampleRate: 48_000
    } : null;
    if (audioConfiguration) {
        await harness.videoDecodeSession.prepareAudio(audioConfiguration);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        harness.audioBridge.activate(generation, harness.audioOutput.generation);
    }
    harness.videoDecodeSession.emit({
        audio: audioConfiguration,
        codec: 'avc1.640028',
        generation,
        type: 'ready'
    });
    await expect(startPromise).resolves.toEqual({
        fallbackReason: null,
        generation,
        status: 'started'
    });
    return generation;
}

describe('CustomPlaybackController', () => {
    it('owns decode, PCM output, clock controls, events, and telemetry', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);

        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            audioTrackIndex: 1,
            generation,
            startTimeMicroseconds: 5_000_000
        });
        expect(harness.audioOutput?.setPlaying).toHaveBeenLastCalledWith(true);
        expect(harness.events.some(event => event.type === 'ready')).toBe(true);
        expect(harness.events.some(event => event.type === 'playing')).toBe(true);

        harness.setMonotonicTime(secondsToMicroseconds(10.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_250_000);
        const clockGeneration = harness.controller.getTelemetry().clock.generation;
        harness.audioOutput?.emitTelemetry(secondsToMicroseconds(7));
        expect(harness.controller.currentTimeMicroseconds).toBe(7_000_000);
        expect(harness.controller.getTelemetry().clock.generation).toBe(clockGeneration);
        harness.controller.pause();
        harness.setMonotonicTime(secondsToMicroseconds(11));
        expect(harness.controller.currentTimeMicroseconds).toBe(7_000_000);
        harness.controller.resume();
        harness.setMonotonicTime(secondsToMicroseconds(11.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(7_250_000);

        harness.controller.setVolume(0.25);
        harness.controller.setMuted(true);
        expect(harness.controller.setPlaybackRate(1)).toBe(true);
        expect(harness.audioOutput?.setVolume).toHaveBeenLastCalledWith(0.25);
        expect(harness.audioOutput?.setMuted).toHaveBeenLastCalledWith(true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        expect(harness.controller.getTelemetry()).toMatchObject({
            activeGeneration: generation,
            audioPath: 'ready',
            currentTimeMicroseconds: 7_250_000,
            durationMicroseconds: 120_000_000,
            muted: true,
            state: 'playing',
            volume: 0.25
        });

        await harness.controller.destroy();
        await harness.controller.destroy();
        expect(harness.audioOutput?.destroy).toHaveBeenCalledTimes(1);
    });

    it('freezes the audio-master clock across underflow and reanchors on recovery', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);

        harness.setMonotonicTime(secondsToMicroseconds(10.1));
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.08),
            undefined,
            { reason: 'underflow' }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_080_000);
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'audio-buffer')).toHaveLength(1);

        harness.setMonotonicTime(secondsToMicroseconds(12));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_080_000);
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(9),
            undefined,
            { reason: 'periodic' }
        );
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(9),
            undefined,
            { reason: 'underflow' }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_080_000);
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'audio-buffer')).toHaveLength(1);

        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.12),
            undefined,
            { reason: 'underflow-recovered' }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_120_000);
        harness.setMonotonicTime(secondsToMicroseconds(12.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_370_000);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);
    });

    it('ignores old worklet telemetry during and after a seek generation change', async () => {
        const harness = createControllerHarness(true);
        const firstGeneration = await startReadyPlayback(harness, true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }

        const seekPromise = harness.controller.seek(secondsToMicroseconds(42));
        await flushAsyncWork();
        const secondGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!secondGeneration) {
            throw new Error('Seek generation did not start');
        }
        harness.audioOutput.setGeneration(2);
        harness.audioOutput.emitTelemetry(secondsToMicroseconds(99), 1);
        expect(harness.controller.currentTimeMicroseconds).toBe(42_000_000);

        const audioConfiguration: DecodeWorkerAudioConfiguration = {
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        };
        await harness.videoDecodeSession.prepareAudio(audioConfiguration);
        harness.audioBridge.activate(secondGeneration, harness.audioOutput.generation);
        harness.videoDecodeSession.emit({
            audio: audioConfiguration,
            codec: 'avc1.640028',
            generation: secondGeneration,
            type: 'ready'
        });
        await seekPromise;

        harness.audioOutput.emitTelemetry(secondsToMicroseconds(100), 1);
        expect(harness.controller.currentTimeMicroseconds).toBe(42_000_000);
        harness.audioOutput.emitTelemetry(secondsToMicroseconds(43), 2);
        expect(harness.controller.currentTimeMicroseconds).toBe(43_000_000);
        expect(secondGeneration).toBeGreaterThan(firstGeneration);
    });

    it('freezes a video-only clock while starved and resumes without a logical pause', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);

        harness.setMonotonicTime(secondsToMicroseconds(10.25));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.currentTimeMicroseconds).toBe(5_250_000);
        harness.setMonotonicTime(secondsToMicroseconds(11));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_250_000);

        const recoveredFrame = createDecodedFrame(secondsToMicroseconds(5.5));
        harness.videoDecodeSession.queueFrame(recoveredFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(recoveredFrame);
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.controller.notifyFramePresented(recoveredFrame)).toBe(true);
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(1);
        expect(harness.events.filter(event => event.type === 'statechange'
            && event.state === 'paused')).toHaveLength(0);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);

        harness.setMonotonicTime(secondsToMicroseconds(11.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_750_000);
    });

    it('prepares paused playback and exposes frame-provider waiting recovery', async () => {
        const harness = createControllerHarness(false);
        const preparePromise = harness.controller.prepare(createPlayOptions());
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0].generation;
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'vp09.00.10.08',
            generation,
            type: 'ready'
        });
        await preparePromise;

        expect(harness.controller.playbackState).toBe('paused');
        harness.controller.resume();
        const initialTimeUpdateCount = harness.events.filter(
            event => event.type === 'timeupdate'
        ).length;
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(secondsToMicroseconds(10.249));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'timeupdate')).toHaveLength(
            initialTimeUpdateCount
        );
        harness.setMonotonicTime(secondsToMicroseconds(10.25));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'timeupdate')).toHaveLength(
            initialTimeUpdateCount + 1
        );
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(1);

        const decodedFrame = {
            durationMicroseconds: millisecondsToMicroseconds(40),
            frame: { close: vi.fn() } as unknown as VideoFrame,
            mediaTimeMicroseconds: secondsToMicroseconds(5)
        };
        harness.videoDecodeSession.takeFrame.mockReturnValueOnce(decodedFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(decodedFrame);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);

        await harness.controller.stop();
        expect(harness.controller.playbackState).toBe('idle');
    });

    it('waits for submitted video and consumed audio before emitting ended', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        const firstFrame = createDecodedFrame(secondsToMicroseconds(5));
        const finalFrame = createDecodedFrame(secondsToMicroseconds(5.04));
        harness.videoDecodeSession.queueFrame(firstFrame);
        harness.videoDecodeSession.queueFrame(finalFrame);
        harness.audioBridge.setPendingFrameCount(2_048);

        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.events.filter(event => event.type === 'ended')).toHaveLength(0);
        expect(harness.audioOutput?.setPlaying).toHaveBeenLastCalledWith(true);
        expect(harness.controller.takeCurrentFrame()).toBe(firstFrame);
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.controller.notifyFramePresented(firstFrame)).toBe(true);

        harness.audioOutput?.emitTelemetry(secondsToMicroseconds(5.04));
        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        expect(harness.controller.playbackState).toBe('playing');

        harness.audioBridge.setPendingFrameCount(0);
        harness.audioOutput?.emitTelemetry(secondsToMicroseconds(5.08));
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'ended')).toEqual([
            { generation, type: 'ended' }
        ]);
        expect(harness.audioOutput?.setPlaying).toHaveBeenLastCalledWith(false);
        expect(firstFrame.frame.close).not.toHaveBeenCalled();
        expect(finalFrame.frame.close).not.toHaveBeenCalled();
    });

    it('requires an exact presenter acknowledgment before video-only ended', async () => {
        const harness = createControllerHarness(false);
        const generation = await startReadyPlayback(harness, false);
        const finalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(finalFrame);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.controller.notifyFramePresented(
            createDecodedFrame(secondsToMicroseconds(5))
        )).toBe(false);
        expect(harness.controller.playbackState).toBe('playing');

        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'ended')).toEqual([
            { generation, type: 'ended' }
        ]);
    });

    it('invalidates a pending end drain when seeking to a new generation', async () => {
        const harness = createControllerHarness(false);
        const firstGeneration = await startReadyPlayback(harness, false);
        const staleFinalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(staleFinalFrame);
        harness.videoDecodeSession.emit({ generation: firstGeneration, type: 'ended' });
        expect(harness.controller.takeCurrentFrame()).toBe(staleFinalFrame);

        const seekPromise = harness.controller.seek(secondsToMicroseconds(42));
        await flushAsyncWork();
        const secondGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!secondGeneration) {
            throw new Error('Seek generation did not start');
        }
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'avc1.640028',
            generation: secondGeneration,
            type: 'ready'
        });
        await seekPromise;

        harness.videoDecodeSession.emit({ generation: firstGeneration, type: 'ended' });
        expect(harness.controller.notifyFramePresented(staleFinalFrame)).toBe(false);
        expect(staleFinalFrame.frame.close).not.toHaveBeenCalled();
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.events.filter(event => event.type === 'ended')).toHaveLength(0);
        expect(harness.controller.getTelemetry().staleEventCount).toBe(1);
    });

    it('invalidates a transferred final frame when playback stops', async () => {
        const harness = createControllerHarness(false);
        const generation = await startReadyPlayback(harness, false);
        const staleFinalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(staleFinalFrame);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });
        expect(harness.controller.takeCurrentFrame()).toBe(staleFinalFrame);

        await harness.controller.stop();

        expect(harness.controller.notifyFramePresented(staleFinalFrame)).toBe(false);
        expect(harness.controller.playbackState).toBe('idle');
        expect(harness.events.filter(event => event.type === 'ended')).toHaveLength(0);
    });

    it('invalidates drain and audio starvation when fallback activates', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        const staleFinalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(staleFinalFrame);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });
        expect(harness.controller.takeCurrentFrame()).toBe(staleFinalFrame);
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5),
            undefined,
            { reason: 'underflow' }
        );

        expect(harness.controller.setPlaybackRate(2)).toBe(false);
        expect(harness.controller.notifyFramePresented(staleFinalFrame)).toBe(false);
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(6),
            undefined,
            { reason: 'underflow-recovered' }
        );
        expect(harness.controller.playbackState).toBe('fallback');
        expect(harness.events.filter(event => event.type === 'ended')).toHaveLength(0);
        expect(harness.fallbackRequests).toHaveLength(1);
    });

    it('seeks by generation and ignores stale decoder events', async () => {
        const harness = createControllerHarness(false);
        const firstGeneration = await startReadyPlayback(harness, false);
        harness.controller.pause();

        const seekPromise = harness.controller.seek(secondsToMicroseconds(42));
        await flushAsyncWork();
        const secondGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        expect(secondGeneration).toBeGreaterThan(firstGeneration);
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'avc1.640028',
            generation: firstGeneration,
            type: 'ready'
        });
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'avc1.640028',
            generation: secondGeneration as number,
            type: 'ready'
        });

        await expect(seekPromise).resolves.toMatchObject({
            generation: secondGeneration,
            status: 'started'
        });
        expect(harness.controller.playbackState).toBe('paused');
        expect(harness.controller.currentTimeMicroseconds).toBe(42_000_000);
        expect(harness.controller.getTelemetry().staleEventCount).toBe(1);
    });

    it('switches audio tracks by restarting generations at the audio-master time', async () => {
        const harness = createControllerHarness(true);
        const firstGeneration = await startReadyPlayback(harness, true);
        expect(harness.controller.canSetAudioStreamIndex()).toBe(true);
        harness.audioOutput?.emitTelemetry(secondsToMicroseconds(33));

        const switchPromise = harness.controller.setAudioStreamIndex(4);
        await flushAsyncWork();
        const secondGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        expect(secondGeneration).toBeGreaterThan(firstGeneration);
        expect(harness.videoDecodeSession.starts.at(-1)).toMatchObject({
            audioTrackIndex: 4,
            generation: secondGeneration,
            startTimeMicroseconds: 33_000_000
        });
        const audioConfiguration: DecodeWorkerAudioConfiguration = {
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        };
        await harness.videoDecodeSession.prepareAudio(audioConfiguration);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        harness.audioBridge.activate(secondGeneration as number, harness.audioOutput.generation);
        harness.videoDecodeSession.emit({
            audio: audioConfiguration,
            codec: 'avc1.640028',
            generation: secondGeneration as number,
            type: 'ready'
        });
        await expect(switchPromise).resolves.toMatchObject({
            generation: secondGeneration,
            status: 'started'
        });
        expect(harness.controller.audioStreamIndex).toBe(4);
        expect(harness.controller.playbackState).toBe('playing');
    });

    it('requests same-session HTML fallback when custom audio is unavailable', async () => {
        const harness = createControllerHarness(false);
        const result = await harness.controller.play(createPlayOptions(0));

        expect(result).toMatchObject({
            fallbackReason: 'audio-output-unavailable',
            status: 'fallback'
        });
        expect(harness.fallbackRequests).toEqual([ {
            generation: result.generation,
            mediaTimeMicroseconds: 5_000_000,
            preserveHTMLSession: true,
            reason: 'audio-output-unavailable'
        } ]);
        expect(harness.videoDecodeSession.starts).toHaveLength(0);
        expect(harness.controller.playbackState).toBe('fallback');
    });

    it('bounds startup and latches one fallback request', async () => {
        vi.useFakeTimers();
        try {
            const harness = createControllerHarness(false);
            const startPromise = harness.controller.play(createPlayOptions());
            await flushAsyncWork();
            await vi.advanceTimersByTimeAsync(100);

            await expect(startPromise).resolves.toMatchObject({
                fallbackReason: 'startup-timeout',
                status: 'fallback'
            });
            expect(harness.fallbackRequests).toHaveLength(1);

            const generation = harness.videoDecodeSession.starts[0].generation;
            harness.videoDecodeSession.emit({
                failureKind: 'decode-failed',
                generation,
                message: 'late failure',
                type: 'error'
            });
            expect(harness.fallbackRequests).toHaveLength(1);
            expect(harness.controller.getTelemetry().staleEventCount).toBe(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it('falls back when rate-adjusted audio is not implemented', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);

        expect(harness.controller.setPlaybackRate(2)).toBe(false);
        expect(harness.fallbackRequests[0]).toMatchObject({
            preserveHTMLSession: true,
            reason: 'playback-rate-unsupported'
        });
        expect(harness.controller.playbackState).toBe('fallback');
    });

    it('does not finish startup until asynchronous audio playback starts', async () => {
        const harness = createControllerHarness(true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        const playbackStarted = createDeferred<void>();
        harness.audioOutput.setPlaying.mockImplementation((playing: boolean) => (
            playing ? playbackStarted.promise : undefined
        ));

        const startPromise = harness.controller.play(createPlayOptions(1));
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0].generation;
        const audioConfiguration: DecodeWorkerAudioConfiguration = {
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        };
        await harness.videoDecodeSession.prepareAudio(audioConfiguration);
        harness.audioBridge.activate(generation, harness.audioOutput.generation);
        harness.videoDecodeSession.emit({
            audio: audioConfiguration,
            codec: 'avc1.640028',
            generation,
            type: 'ready'
        });
        await flushAsyncWork();

        expect(harness.controller.playbackState).toBe('starting');
        expect(harness.events.filter(event => event.type === 'ready')).toHaveLength(0);
        playbackStarted.resolve(undefined);
        await expect(startPromise).resolves.toEqual({
            fallbackReason: null,
            generation,
            status: 'started'
        });
        expect(harness.controller.playbackState).toBe('playing');
    });

    it('latches one fallback when asynchronous audio startup fails', async () => {
        const harness = createControllerHarness(true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        harness.audioOutput.setPlaying.mockImplementation((playing: boolean) => (
            playing ? Promise.reject(new Error('AudioContext resume failed')) : undefined
        ));

        const startPromise = harness.controller.play(createPlayOptions(1));
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0].generation;
        const audioConfiguration: DecodeWorkerAudioConfiguration = {
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        };
        await harness.videoDecodeSession.prepareAudio(audioConfiguration);
        harness.audioBridge.activate(generation, harness.audioOutput.generation);
        harness.videoDecodeSession.emit({
            audio: audioConfiguration,
            codec: 'avc1.640028',
            generation,
            type: 'ready'
        });

        await expect(startPromise).resolves.toEqual({
            fallbackReason: 'audio-output-failed',
            generation,
            status: 'fallback'
        });
        expect(harness.fallbackRequests).toHaveLength(1);
        expect(harness.controller.playbackState).toBe('fallback');
    });

    it('requests one fallback when asynchronous audio resume fails', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }

        harness.controller.pause();
        await flushAsyncWork();
        harness.audioOutput.setPlaying.mockImplementationOnce(
            (): Promise<void> => Promise.reject(new Error('AudioContext resume failed'))
        );
        harness.controller.resume();
        await flushAsyncWork();

        expect(harness.fallbackRequests).toHaveLength(1);
        expect(harness.fallbackRequests[0].reason).toBe('audio-output-failed');
        expect(harness.controller.playbackState).toBe('fallback');
    });

    it('waits for asynchronous audio destruction and records close failure', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        const outputDestroyed = createDeferred<void>();
        harness.audioOutput.destroy.mockReturnValueOnce(outputDestroyed.promise);

        let destroySettled = false;
        const destroyPromise = harness.controller.destroy().then((): void => {
            destroySettled = true;
        });
        await flushAsyncWork();
        expect(harness.audioOutput.destroy).toHaveBeenCalledTimes(1);
        expect(destroySettled).toBe(false);
        outputDestroyed.reject(new Error('AudioContext close failed'));

        await expect(destroyPromise).resolves.toBeUndefined();
        expect(harness.controller.getTelemetry().lastErrorMessage).toContain(
            'AudioContext close failed'
        );
    });

    it('waits for and releases an audio factory that outlives destruction', async () => {
        const audioOutput = new FakeAudioOutput();
        const audioBridge = new FakeAudioBridge(audioOutput.generation);
        const audioConfiguration: DecodeWorkerAudioConfiguration = {
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        };
        const factoryResult = createDeferred<CustomAudioOutputBinding>();
        let videoDecodeSession: FakeVideoDecodeSession | null = null;
        const controller = new CustomPlaybackController({
            audioOutputFactory: (): Promise<CustomAudioOutputBinding> => factoryResult.promise,
            monotonicTimeSource: (): Microseconds => secondsToMicroseconds(10),
            pipelineStopTimeoutMicroseconds: millisecondsToMicroseconds(100),
            startupTimeoutMicroseconds: millisecondsToMicroseconds(100),
            videoDecodeSessionFactory: (eventHandler, audioBridgeFactory) => {
                videoDecodeSession = new FakeVideoDecodeSession(eventHandler, audioBridgeFactory);
                return videoDecodeSession;
            }
        });
        const startPromise = controller.play(createPlayOptions(1));
        await flushAsyncWork();
        if (!videoDecodeSession) {
            throw new Error('Expected a video decode session');
        }
        const audioPreparation = (
            videoDecodeSession as FakeVideoDecodeSession
        ).prepareAudio(audioConfiguration).catch((): null => null);
        await flushAsyncWork();

        let destroySettled = false;
        const destroyPromise = controller.destroy().then((): void => {
            destroySettled = true;
        });
        await flushAsyncWork();
        expect(destroySettled).toBe(false);

        factoryResult.resolve({
            bridge: audioBridge as unknown as CustomDecodeAudioBridge,
            configuration: audioConfiguration,
            output: audioOutput
        });
        await expect(audioPreparation).resolves.toBeNull();
        await expect(destroyPromise).resolves.toBeUndefined();
        await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
        expect(audioOutput.destroy).toHaveBeenCalledOnce();
    });

    it('settles an in-flight start exactly once when stopped', async () => {
        const harness = createControllerHarness(false);
        const startPromise = harness.controller.play(createPlayOptions());
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0].generation;

        const stopPromise = harness.controller.stop();
        await expect(startPromise).resolves.toEqual({
            fallbackReason: null,
            generation,
            status: 'stopped'
        });
        await stopPromise;

        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'vp8',
            generation,
            type: 'ready'
        });
        expect(harness.controller.playbackState).toBe('idle');
        expect(harness.controller.getTelemetry().staleEventCount).toBe(1);
    });
});
