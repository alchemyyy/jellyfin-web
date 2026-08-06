import { describe, expect, it, vi } from 'vitest';

import {
    millisecondsToMicroseconds,
    secondsToMicroseconds,
    type Microseconds
} from '../MediaTime';
import type {
    DecodedPresentationFrame,
    DecodedVideoPresentationFrame
} from '../WebGPUPresenter';
import type { AudioWorkletTelemetry } from './AudioWorkletProtocol';
import { CUSTOM_AUDIO_DOWNMIX_ALGORITHMS } from './CustomAudioDownmixAlgorithm';
import type { AudioDownmixSettings } from './CustomAudioDownmix';
import type CustomDecodeAudioBridge from './CustomDecodeAudioBridge';
import type { CustomDecodeAudioBridgeTelemetry } from './CustomDecodeAudioBridge';
import type {
    CustomDecodeAudioBridgeFactory,
    CustomDecodeNativeAudioBridgeFactory,
    CustomDecodeSessionEvent,
    CustomDecodeSessionStartOptions,
    CustomDecodeSessionTelemetry
} from './CustomDecodeSession';
import type { DecodeWorkerAudioConfiguration } from './DecodeWorkerProtocol';
import { addMicroseconds, requireMicroseconds } from './TimeMath';
import CustomPlaybackController from './CustomPlaybackController';
import type {
    CustomAudioOutput,
    CustomAudioOutputBinding,
    CustomPlaybackControllerEvent,
    CustomPlaybackControllerOptions,
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
        abandonedRawFrameCount: 0,
        audioChannelCount: null,
        audioCodec: null,
        audioSampleRate: null,
        audioSourceChannelCount: null,
        audioSourceSampleRate: null,
        droppedFrameCount: 0,
        failureKind: null,
        firstFrameMediaTimeMicroseconds: null,
        lastAudioMediaTimeMicroseconds: null,
        lastFrameMediaTimeMicroseconds: null,
        nativeAudioClockReady: false,
        peakFrameCount: 0,
        pendingFrameCount: 0,
        queuedFrameCount: 0,
        receivedAudioFrameCount: 0,
        receivedAudioSampleCount: 0,
        receivedDolbyVisionEnhancementFrameCount: 0,
        receivedDolbyVisionFrameCount: 0,
        receivedDolbyVisionRPUCount: 0,
        receivedHDR10PlusAbsentFrameCount: 0,
        receivedHDR10PlusConflictingFrameCount: 0,
        receivedHDR10PlusMalformedFrameCount: 0,
        receivedHDR10PlusUnsupportedFrameCount: 0,
        receivedHDR10PlusValidFrameCount: 0,
        receivedFrameCount: 0,
        receivedNativeAudioSegmentCount: 0,
        recycledRawFrameCount: 0,
        staleAudioSampleCount: 0,
        staleFrameCount: 0,
        state: 'idle',
        staticHDRMetadataFirstAccessUnitIndex: null,
        staticHDRMetadataScanAccessUnitCount: 0,
        staticHDRMetadataStatus: null,
        submittedAudioFrameCount: 0,
        submittedAudioSampleCount: 0,
        submittedVideoPacketCount: 0,
        takenFrameCount: 0,
        videoProgressPhase: null
    };
}

class FakeVideoDecodeSession implements CustomVideoDecodeSession {
    private activeGeneration: number | null = null;
    private nativeAudioTimeMicroseconds: Microseconds | null = null;
    private pendingFrameCount = 0;
    private readonly queuedFrames: DecodedPresentationFrame[] = [];
    public readonly starts: CustomDecodeSessionStartOptions[] = [];
    public readonly acknowledgeFrame = vi.fn((): boolean => true);
    public readonly discardFrame = vi.fn((): boolean => true);
    public readonly setNativeAudioMuted = vi.fn();
    public readonly setNativeAudioPlaying = vi.fn(async (): Promise<void> => undefined);
    public readonly setNativeAudioVolume = vi.fn();
    public readonly updateAudioDownmixSettings = vi.fn((): boolean => false);
    public readonly stop = vi.fn((): Promise<void> => {
        this.activeGeneration = null;
        for (const queuedFrame of this.queuedFrames) {
            if (queuedFrame.outputMode === 'video-frame') {
                queuedFrame.frame.close();
            }
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
                const queuedFrame = this.queuedFrames[frameIndex];
                if (queuedFrame.outputMode === 'video-frame') {
                    queuedFrame.frame.close();
                }
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
            activeGeneration: this.activeGeneration,
            pendingFrameCount: this.pendingFrameCount,
            queuedFrameCount: this.queuedFrames.length
        };
    }

    public getNativeAudioTimeMicroseconds(): Microseconds | null {
        return this.nativeAudioTimeMicroseconds;
    }

    public queueFrame(frame: DecodedPresentationFrame): void {
        this.queuedFrames.push(frame);
    }

    public setPendingFrameCount(pendingFrameCount: number): void {
        this.pendingFrameCount = pendingFrameCount;
    }

    public setNativeAudioTimeMicroseconds(
        nativeAudioTimeMicroseconds: Microseconds | null
    ): void {
        this.nativeAudioTimeMicroseconds = nativeAudioTimeMicroseconds;
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
        this.activeGeneration = options.generation;
        this.starts.push({ ...options });
    }
}

class FakeAudioOutput implements CustomAudioOutput {
    private currentGeneration = 1;
    private estimatedOutputLatencyMicroseconds: Microseconds | null = null;
    private lastTelemetry: AudioWorkletTelemetry | null = null;
    public readonly destroy = vi.fn();
    public readonly setMuted = vi.fn();
    public readonly setPlaying = vi.fn();
    public readonly setVolume = vi.fn();
    private readonly telemetryListeners = new Set<(telemetry: AudioWorkletTelemetry) => void>();

    public get generation(): number {
        return this.currentGeneration;
    }

    public getEstimatedOutputLatencyMicroseconds(): Microseconds | null {
        return this.estimatedOutputLatencyMicroseconds;
    }

    public getTelemetry(): AudioWorkletTelemetry | null {
        return this.lastTelemetry ? { ...this.lastTelemetry } : null;
    }

    public emitTelemetry(
        mediaTimeMicroseconds: Microseconds,
        generation = this.currentGeneration,
        overrides: Partial<AudioWorkletTelemetry> = {}
    ): void {
        const telemetry: AudioWorkletTelemetry = {
            consumedFrames: 1_024,
            droppedFrames: 0,
            hasPhysicalOutputTimeCorrelation: true,
            mediaTimeContextTimeMicroseconds: null,
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
        this.lastTelemetry = { ...telemetry };
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

    public setEstimatedOutputLatencyMicroseconds(
        estimatedOutputLatencyMicroseconds: Microseconds | null
    ): void {
        this.estimatedOutputLatencyMicroseconds = estimatedOutputLatencyMicroseconds;
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
            submittedEndMediaTimeMicroseconds: null,
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

    public setSubmittedEndMediaTimeMicroseconds(
        submittedEndMediaTimeMicroseconds: Microseconds | null
    ): void {
        this.telemetry = {
            ...this.telemetry,
            submittedEndMediaTimeMicroseconds,
            submittedFrameCount: submittedEndMediaTimeMicroseconds === null ? 0 : 1,
            submittedSampleCount: submittedEndMediaTimeMicroseconds === null ? 0 : 1
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
        dolbyVisionProfile: null,
        durationMicroseconds: secondsToMicroseconds(120),
        maximumCodedHeight: 1_080,
        maximumCodedWidth: 1_920,
        nativeHDRTransfer: null,
        neutralizeHDRColorMetadata: false,
        rawVideoFrameFormat: null,
        startTimeMicroseconds: secondsToMicroseconds(5),
        url: 'http://localhost/video.mkv?ApiKey=secret',
        videoDecoderBackend: 'native',
        videoOutputMode: 'video-frame',
        videoTrackIndex: 0
    };
}

function createDecodedFrame(
    mediaTimeMicroseconds: Microseconds,
    durationMicroseconds: Microseconds = millisecondsToMicroseconds(40)
): DecodedVideoPresentationFrame {
    return {
        durationMicroseconds,
        frame: { close: vi.fn() } as unknown as VideoFrame,
        mediaTimeMicroseconds,
        outputMode: 'video-frame'
    };
}

function createControllerHarness(
    withAudio: boolean,
    controllerOptions: Partial<CustomPlaybackControllerOptions> = {}
): ControllerHarness {
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
        },
        ...controllerOptions
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
    it.each([ 'legacy-software', 'openjpeg' ] as const)(
        'starts the qualified %s SDR VideoFrame route',
        async videoDecoderBackend => {
            const harness = createControllerHarness(false);
            const startPromise = harness.controller.play({
                ...createPlayOptions(),
                videoDecoderBackend
            });
            await flushAsyncWork();
            const generation = harness.videoDecodeSession.starts[0]?.generation;
            if (!generation) {
                throw new Error('Software video decode did not start');
            }

            expect(harness.videoDecodeSession.starts[0]).toMatchObject({
                generation,
                videoDecoderBackend,
                videoOutputMode: 'video-frame'
            });
            harness.videoDecodeSession.emit({
                audio: null,
                codec: videoDecoderBackend === 'openjpeg' ? 'mjp2' : 'mpeg2video',
                generation,
                type: 'ready'
            });
            await expect(startPromise).resolves.toMatchObject({
                generation,
                status: 'started'
            });
            await harness.controller.destroy();
        }
    );

    it('forwards native HDR metadata neutralization to the decode session', async () => {
        const harness = createControllerHarness(false);
        const startPromise = harness.controller.play({
            ...createPlayOptions(),
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true
        });
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0]?.generation;
        if (!generation) {
            throw new Error('Native HDR decode did not start');
        }

        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            generation,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            generation,
            type: 'ready'
        });
        await expect(startPromise).resolves.toMatchObject({
            generation,
            status: 'started'
        });
        await harness.controller.destroy();
    });

    it('forwards the selected Dolby Vision profile to the decode session', async () => {
        const harness = createControllerHarness(false);
        const startPromise = harness.controller.play({
            ...createPlayOptions(),
            dolbyVisionProfile: 7,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            rawVideoFrameFormat: 'I420P10',
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes'
        });
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0]?.generation;
        if (!generation) {
            throw new Error('Dolby Vision decode did not start');
        }

        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            dolbyVisionProfile: 7,
            generation,
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes'
        });
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'hev1.2.4.L153.B0',
            generation,
            type: 'ready'
        });
        await expect(startPromise).resolves.toMatchObject({
            generation,
            status: 'started'
        });
        await harness.controller.destroy();
    });

    it('starts one 8K 10-bit raw transfer without imposing a 4K ceiling', async () => {
        const harness = createControllerHarness(false);
        const startPromise = harness.controller.play({
            ...createPlayOptions(),
            maximumCodedHeight: 4_320,
            maximumCodedWidth: 7_680,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0]?.generation;
        if (!generation) {
            throw new Error('8K raw decode did not start');
        }

        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            maximumCodedHeight: 4_320,
            maximumCodedWidth: 7_680,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'hvc1.2.6.L183.B0',
            generation,
            type: 'ready'
        });
        await expect(startPromise).resolves.toMatchObject({
            generation,
            status: 'started'
        });
        await harness.controller.destroy();
    });

    it('rejects raw playback only when the transfer byte budget is exceeded', async () => {
        const harness = createControllerHarness(false);
        const oversizedOptions: CustomPlaybackPlayOptions = {
            ...createPlayOptions(),
            maximumCodedHeight: 8_640,
            maximumCodedWidth: 15_360,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        };

        expect(() => harness.controller.play(oversizedOptions)).toThrow(
            'Raw custom playback exceeds its transfer memory budget'
        );
        expect(() => harness.controller.play({
            ...oversizedOptions,
            dolbyVisionProfile: 7,
            maximumCodedHeight: 4_320,
            maximumCodedWidth: 7_680
        })).toThrow('Raw custom playback exceeds its transfer memory budget');
        expect(harness.videoDecodeSession.starts).toEqual([]);
        await harness.controller.destroy();
    });

    it('forwards the selected decoded audio layout and downmix algorithm', async () => {
        const harness = createControllerHarness(true);
        const options = createPlayOptions(0);
        options.audioDownmixAlgorithm = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845;
        const audioDownmixSettings: AudioDownmixSettings = {
            centerLevel: 0.4,
            outputGain: 0.6,
            surroundLevel: 0.5,
            version: 1
        };
        options.audioDownmixSettings = audioDownmixSettings;
        options.decodedAudioOutputChannelCount = 8;

        const startPromise = harness.controller.play(options);
        await flushAsyncWork();

        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            audioDownmixAlgorithm: CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845,
            audioDownmixSettings,
            audioTrackIndex: 0,
            decodedAudioOutputChannelCount: 8
        });

        await harness.controller.stop();
        await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('retains a pending-startup gain update for the new decode generation', async () => {
        const harness = createControllerHarness(true);
        const decoderStop = createDeferred<void>();
        harness.videoDecodeSession.stop.mockImplementationOnce(
            (): Promise<void> => decoderStop.promise
        );
        const startPromise = harness.controller.play(createPlayOptions(0));
        await flushAsyncWork();
        const settings: {
            centerLevel: number
            outputGain: number
            surroundLevel: number
            version: 1
        } = {
            centerLevel: 0.75,
            outputGain: 1.5,
            surroundLevel: 0.5,
            version: 1
        };

        expect(harness.controller.updateAudioDownmixSettings(settings)).toBe(false);
        expect(harness.videoDecodeSession.updateAudioDownmixSettings)
            .not.toHaveBeenCalled();
        settings.outputGain = 9;
        decoderStop.resolve();
        await flushAsyncWork();

        expect(harness.videoDecodeSession.starts).toHaveLength(1);
        expect(harness.videoDecodeSession.starts[0].audioDownmixSettings).toEqual({
            centerLevel: 0.75,
            outputGain: 1.5,
            surroundLevel: 0.5,
            version: 1
        });

        await harness.controller.stop();
        await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('delegates to the current configured worker while overall startup remains pending', async () => {
        const harness = createControllerHarness(true);
        const startPromise = harness.controller.play(createPlayOptions(0));
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0]?.generation;
        if (!generation) {
            throw new Error('Video decode did not start');
        }
        harness.videoDecodeSession.emit({
            audio: {
                channelCount: 2,
                codec: 'opus',
                sampleRate: 48_000,
                sourceChannelCount: 6,
                sourceSampleRate: 48_000
            },
            codec: 'avc1.640028',
            generation,
            type: 'configured'
        });
        harness.videoDecodeSession.updateAudioDownmixSettings.mockReturnValueOnce(true);
        const settings: AudioDownmixSettings = {
            centerLevel: 0.75,
            outputGain: 1.5,
            surroundLevel: 0.5,
            version: 1
        };

        expect(harness.controller.updateAudioDownmixSettings(settings)).toBe(true);
        expect(harness.videoDecodeSession.updateAudioDownmixSettings)
            .toHaveBeenCalledWith(settings);
        expect(harness.controller.playbackState).toBe('starting');

        await harness.controller.stop();
        await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('persists a live gain snapshot across a client-side audio switch', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        harness.videoDecodeSession.updateAudioDownmixSettings.mockReturnValueOnce(true);
        const settings: {
            centerLevel: number
            outputGain: number
            surroundLevel: number
            version: 1
        } = {
            centerLevel: 0.5,
            outputGain: 1.25,
            surroundLevel: 0.75,
            version: 1
        };

        expect(harness.controller.updateAudioDownmixSettings(settings)).toBe(true);
        expect(harness.videoDecodeSession.updateAudioDownmixSettings)
            .toHaveBeenCalledWith(settings);
        settings.centerLevel = 2;
        const switchPromise = harness.controller.setAudioStreamIndex(2);
        await flushAsyncWork();

        expect(harness.videoDecodeSession.starts.at(-1)).toMatchObject({
            audioDownmixSettings: {
                centerLevel: 0.5,
                outputGain: 1.25,
                surroundLevel: 0.75,
                version: 1
            },
            audioTrackIndex: 2
        });
        await harness.controller.stop();
        await expect(switchPromise).resolves.toMatchObject({ status: 'stopped' });
    });

    it('owns decode, PCM output, clock controls, events, and telemetry', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);

        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            audioTrackIndex: 1,
            generation,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 5_000_000,
            videoDecoderBackend: 'native'
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
        harness.controller.setNormalizationGain(2);
        harness.controller.setMuted(true);
        expect(harness.controller.setPlaybackRate(1)).toBe(true);
        expect(harness.audioOutput?.setVolume).toHaveBeenLastCalledWith(0.5);
        expect(harness.audioOutput?.setMuted).toHaveBeenLastCalledWith(true);
        expect(() => harness.controller.setNormalizationGain(-1)).toThrow(RangeError);
        expect(() => harness.controller.setNormalizationGain(Number.POSITIVE_INFINITY))
            .toThrow(RangeError);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        expect(harness.controller.getTelemetry()).toMatchObject({
            activeGeneration: generation,
            audioPath: 'ready',
            currentTimeMicroseconds: 7_250_000,
            durationMicroseconds: 120_000_000,
            muted: true,
            normalizationGain: 2,
            state: 'playing',
            volume: 0.25
        });

        await harness.controller.destroy();
        await harness.controller.destroy();
        expect(harness.audioOutput?.destroy).toHaveBeenCalledTimes(1);
    });

    it('owns native media audio controls and hands clock authority over once', async () => {
        const nativeAudioBridgeFactory = (
            vi.fn() as unknown as CustomDecodeNativeAudioBridgeFactory
        );
        const harness = createControllerHarness(false, { nativeAudioBridgeFactory });
        const playOptions: CustomPlaybackPlayOptions = {
            ...createPlayOptions(0),
            audioOutputMode: 'native-media'
        };
        const startPromise = harness.controller.play(playOptions);
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!generation) {
            throw new Error('Native media audio decode did not start');
        }

        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            audioOutputMode: 'native-media',
            audioTrackIndex: 0,
            durationMicroseconds: secondsToMicroseconds(120),
            generation
        });
        harness.videoDecodeSession.emit({
            audio: {
                channelCount: 6,
                codec: 'ec-3',
                mimeType: 'audio/mp4; codecs="ec-3"',
                outputMode: 'native-media',
                sampleRate: 48_000
            },
            codec: 'hvc1.2.4.L153.B0',
            generation,
            type: 'ready'
        });
        await expect(startPromise).resolves.toEqual({
            fallbackReason: null,
            generation,
            status: 'started'
        });
        expect(harness.videoDecodeSession.setNativeAudioVolume)
            .toHaveBeenLastCalledWith(1);
        expect(harness.videoDecodeSession.setNativeAudioMuted)
            .toHaveBeenLastCalledWith(false);
        expect(harness.videoDecodeSession.setNativeAudioPlaying)
            .toHaveBeenLastCalledWith(true);
        expect(harness.controller.canSetAudioStreamIndex()).toBe(true);

        harness.setMonotonicTime(secondsToMicroseconds(10.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_250_000);
        harness.videoDecodeSession.setNativeAudioTimeMicroseconds(secondsToMicroseconds(6));
        expect(harness.controller.currentTimeMicroseconds).toBe(6_000_000);
        expect(harness.controller.getTelemetry().clock.mediaTimeMicroseconds)
            .toBe(6_000_000);

        harness.videoDecodeSession.setNativeAudioTimeMicroseconds(null);
        harness.setMonotonicTime(secondsToMicroseconds(10.5));
        expect(harness.controller.currentTimeMicroseconds).toBe(6_000_000);

        harness.controller.setNormalizationGain(2);
        harness.controller.setVolume(0.4);
        harness.controller.setMuted(true);
        expect(harness.videoDecodeSession.setNativeAudioVolume)
            .toHaveBeenLastCalledWith(0.8);
        expect(harness.videoDecodeSession.setNativeAudioMuted)
            .toHaveBeenLastCalledWith(true);

        harness.controller.setNormalizationGain(4);
        expect(harness.videoDecodeSession.setNativeAudioVolume)
            .toHaveBeenLastCalledWith(1);

        harness.controller.pause();
        expect(harness.videoDecodeSession.setNativeAudioPlaying)
            .toHaveBeenLastCalledWith(false);
        harness.controller.resume();
        expect(harness.videoDecodeSession.setNativeAudioPlaying)
            .toHaveBeenLastCalledWith(true);

        harness.videoDecodeSession.setNativeAudioTimeMicroseconds(
            secondsToMicroseconds(120)
        );
        harness.videoDecodeSession.emit({ generation, type: 'ended' });
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'ended')).toHaveLength(1);
        await harness.controller.destroy();
    });

    it('falls back in the same session when owned native audio play is rejected', async () => {
        const nativeAudioBridgeFactory = (
            vi.fn() as unknown as CustomDecodeNativeAudioBridgeFactory
        );
        const harness = createControllerHarness(false, { nativeAudioBridgeFactory });
        const startPromise = harness.controller.play({
            ...createPlayOptions(0),
            audioOutputMode: 'native-media'
        });
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!generation) {
            throw new Error('Native media audio decode did not start');
        }
        harness.videoDecodeSession.setNativeAudioPlaying.mockRejectedValueOnce(
            new Error('Native audio playback was blocked')
        );
        harness.videoDecodeSession.emit({
            audio: {
                channelCount: 2,
                codec: 'ac-3',
                mimeType: 'audio/mp4; codecs="ac-3"',
                outputMode: 'native-media',
                sampleRate: 48_000
            },
            codec: 'hvc1.2.4.L153.B0',
            generation,
            type: 'ready'
        });

        await expect(startPromise).resolves.toEqual({
            fallbackReason: 'audio-output-failed',
            generation,
            status: 'fallback'
        });
        expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
            disposition: 'same-session-native',
            generation,
            reason: 'audio-output-failed'
        }) ]);
        expect(harness.controller.playbackState).toBe('fallback');
        await harness.controller.destroy();
    });

    it('does not pin the audio-master clock to repeated uncorrelated telemetry', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);

        harness.setMonotonicTime(secondsToMicroseconds(10.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_250_000);
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5),
            undefined,
            { hasPhysicalOutputTimeCorrelation: false }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_250_000);

        harness.setMonotonicTime(secondsToMicroseconds(10.5));
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5),
            undefined,
            { hasPhysicalOutputTimeCorrelation: false }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_500_000);
    });

    it('passes an explicit raw frame format into the decode session', async () => {
        const harness = createControllerHarness(false);
        const playOptions: CustomPlaybackPlayOptions = {
            ...createPlayOptions(),
            rawVideoFrameFormat: 'I420P12',
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes'
        };
        const startPromise = harness.controller.prepare(playOptions);
        await vi.waitFor(() => expect(harness.videoDecodeSession.starts).toHaveLength(1));
        const generation = harness.videoDecodeSession.starts[0].generation;

        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            generation,
            type: 'ready'
        });

        await expect(startPromise).resolves.toMatchObject({ status: 'started' });
        expect(harness.videoDecodeSession.starts[0]).toMatchObject({
            rawVideoFrameFormat: 'I420P12',
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes'
        });
        await harness.controller.destroy();
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

    it('preserves audio underflow suspension without an output-time correlation', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);

        harness.setMonotonicTime(secondsToMicroseconds(10.1));
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5),
            undefined,
            {
                hasPhysicalOutputTimeCorrelation: false,
                reason: 'underflow'
            }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_100_000);
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'audio-buffer')).toHaveLength(1);

        harness.setMonotonicTime(secondsToMicroseconds(12));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_100_000);
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5),
            undefined,
            {
                hasPhysicalOutputTimeCorrelation: false,
                reason: 'underflow-recovered'
            }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(5_100_000);

        harness.setMonotonicTime(secondsToMicroseconds(12.25));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_350_000);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);
    });

    it('renegotiates after a sustained audio underflow', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        harness.setMonotonicTime(secondsToMicroseconds(10.1));
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.08),
            undefined,
            { reason: 'underflow' }
        );
        harness.setMonotonicTime(secondsToMicroseconds(20.1));

        expect(harness.controller.takeCurrentFrame()).toBeNull();

        expect(harness.controller.playbackState).toBe('fallback');
        expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
            disposition: 'renegotiate-source',
            reason: 'playback-stalled'
        }) ]);
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
        harness.audioOutput.emitTelemetry(
            secondsToMicroseconds(99),
            1,
            { hasPhysicalOutputTimeCorrelation: false }
        );
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

        harness.audioOutput.emitTelemetry(
            secondsToMicroseconds(100),
            1,
            { hasPhysicalOutputTimeCorrelation: false }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(42_000_000);
        harness.audioOutput.emitTelemetry(
            secondsToMicroseconds(100),
            2,
            { hasPhysicalOutputTimeCorrelation: false }
        );
        expect(harness.controller.currentTimeMicroseconds).toBe(42_000_000);
        harness.audioOutput.emitTelemetry(secondsToMicroseconds(43), 2);
        expect(harness.controller.currentTimeMicroseconds).toBe(43_000_000);
        expect(harness.controller.getTelemetry().staleEventCount).toBe(2);
        expect(secondGeneration).toBeGreaterThan(firstGeneration);
    });

    it('freezes a video-only clock while starved and resumes without a logical pause', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);

        harness.setMonotonicTime(secondsToMicroseconds(10.25));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.currentTimeMicroseconds).toBe(5_250_000);
        harness.setMonotonicTime(millisecondsToMicroseconds(10_349));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(0);
        harness.setMonotonicTime(millisecondsToMicroseconds(10_350));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.currentTimeMicroseconds).toBe(5_350_000);
        harness.setMonotonicTime(secondsToMicroseconds(11));
        expect(harness.controller.currentTimeMicroseconds).toBe(5_350_000);

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

    it('renegotiates after sustained video starvation', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);

        harness.setMonotonicTime(millisecondsToMicroseconds(10_100));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_200));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(20_199));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('playing');
        harness.setMonotonicTime(millisecondsToMicroseconds(20_200));

        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('fallback');
        expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
            disposition: 'renegotiate-source',
            reason: 'playback-stalled'
        }) ]);
    });

    it('renegotiates when decoded video falls materially behind the clock', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);
        const lateFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(lateFrame);
        harness.setMonotonicTime(secondsToMicroseconds(13));

        expect(harness.controller.takeCurrentFrame()).toBeNull();

        expect(harness.videoDecodeSession.discardFrame).toHaveBeenCalledWith(lateFrame);
        expect(harness.controller.playbackState).toBe('fallback');
        expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
            disposition: 'renegotiate-source',
            reason: 'playback-stalled'
        }) ]);
    });

    it('does not count a user pause toward the sustained starvation bound', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);

        harness.setMonotonicTime(millisecondsToMicroseconds(10_100));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_200));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.controller.pause();
        harness.setMonotonicTime(millisecondsToMicroseconds(30_000));
        harness.controller.resume();
        expect(harness.controller.takeCurrentFrame()).toBeNull();

        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);
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
        harness.setMonotonicTime(millisecondsToMicroseconds(10_099));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(0);
        harness.setMonotonicTime(millisecondsToMicroseconds(10_100));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(1);
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
            mediaTimeMicroseconds: secondsToMicroseconds(5),
            outputMode: 'video-frame' as const
        };
        harness.videoDecodeSession.takeFrame.mockReturnValueOnce(decodedFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(decodedFrame);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);

        await harness.controller.stop();
        expect(harness.controller.playbackState).toBe('idle');
    });

    it('holds normal future-dated frames without video waiting and playing churn', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);
        const firstFrame = createDecodedFrame(secondsToMicroseconds(5));
        const secondFrame = createDecodedFrame(millisecondsToMicroseconds(5_040));
        const thirdFrame = createDecodedFrame(millisecondsToMicroseconds(5_080));
        harness.videoDecodeSession.queueFrame(firstFrame);
        harness.videoDecodeSession.queueFrame(secondFrame);
        harness.videoDecodeSession.queueFrame(thirdFrame);

        expect(harness.controller.takeCurrentFrame()).toBe(firstFrame);
        expect(harness.controller.notifyFramePresented(firstFrame)).toBe(true);
        harness.setMonotonicTime(millisecondsToMicroseconds(10_016));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_032));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_040));
        expect(harness.controller.takeCurrentFrame()).toBe(secondFrame);
        expect(harness.controller.notifyFramePresented(secondFrame)).toBe(true);
        harness.setMonotonicTime(millisecondsToMicroseconds(10_056));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_080));
        expect(harness.controller.takeCurrentFrame()).toBe(thirdFrame);
        expect(harness.controller.notifyFramePresented(thirdFrame)).toBe(true);

        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(0);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(1);
        await harness.controller.destroy();
    });

    it('debounces a short empty raw-frame handoff below the starvation grace', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);
        const firstFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(firstFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(firstFrame);
        expect(harness.controller.notifyFramePresented(firstFrame)).toBe(true);

        for (const elapsedMilliseconds of [ 16, 32, 64, 96 ]) {
            harness.setMonotonicTime(millisecondsToMicroseconds(10_000 + elapsedMilliseconds));
            expect(harness.controller.takeCurrentFrame()).toBeNull();
        }
        const nextFrame = createDecodedFrame(millisecondsToMicroseconds(5_080));
        harness.videoDecodeSession.queueFrame(nextFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(nextFrame);
        expect(harness.controller.notifyFramePresented(nextFrame)).toBe(true);

        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(0);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(1);
        await harness.controller.destroy();
    });

    it('does not report playback recovery until overlapping video and audio waits clear', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);

        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_100));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.audioOutput?.emitTelemetry(
            millisecondsToMicroseconds(5_100),
            undefined,
            { reason: 'underflow' }
        );
        expect(harness.events.filter(event => event.type === 'waiting')).toHaveLength(2);

        const recoveredVideoFrame = createDecodedFrame(millisecondsToMicroseconds(5_100));
        harness.videoDecodeSession.queueFrame(recoveredVideoFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(recoveredVideoFrame);
        expect(harness.controller.notifyFramePresented(recoveredVideoFrame)).toBe(true);
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(1);

        harness.audioOutput?.emitTelemetry(
            millisecondsToMicroseconds(5_120),
            undefined,
            { reason: 'underflow-recovered' }
        );
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);
        await harness.controller.destroy();
    });

    it('does not count user-paused time toward video starvation', async () => {
        const harness = createControllerHarness(false);
        await startReadyPlayback(harness, false);

        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_050));
        harness.controller.pause();
        harness.setMonotonicTime(secondsToMicroseconds(12));
        harness.controller.resume();
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(12_099));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(0);
        harness.setMonotonicTime(millisecondsToMicroseconds(12_100));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(1);
        await harness.controller.destroy();
    });

    it('holds the final frame without video starvation while audio drains', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        harness.audioBridge.setPendingFrameCount(1_024);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        expect(harness.controller.takeCurrentFrame()).toBeNull();
        harness.setMonotonicTime(millisecondsToMicroseconds(10_500));
        expect(harness.controller.takeCurrentFrame()).toBeNull();

        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'video-frame')).toHaveLength(0);
        await harness.controller.destroy();
    });

    it('waits for submitted video and consumed audio before emitting ended', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        const firstFrame = createDecodedFrame(secondsToMicroseconds(5));
        const finalFrame = createDecodedFrame(secondsToMicroseconds(5.04));
        harness.videoDecodeSession.queueFrame(firstFrame);
        harness.videoDecodeSession.queueFrame(finalFrame);
        harness.audioBridge.setPendingFrameCount(2_048);
        harness.audioBridge.setSubmittedEndMediaTimeMicroseconds(
            secondsToMicroseconds(5.08)
        );

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
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.08),
            undefined,
            { queuedFrames: 0 }
        );
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'ended')).toEqual([
            { generation, type: 'ended' }
        ]);
        expect(harness.audioOutput?.setPlaying).toHaveBeenLastCalledWith(false);
        expect(firstFrame.frame.close).not.toHaveBeenCalled();
        expect(finalFrame.frame.close).not.toHaveBeenCalled();
    });

    it('recovers a pre-EOF underflow and waits for correlated physical audio tail output', async () => {
        const harness = createControllerHarness(true, {
            playbackStallTimeoutMicroseconds: millisecondsToMicroseconds(100)
        });
        const generation = await startReadyPlayback(harness, true);
        const finalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(finalFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        harness.audioBridge.setSubmittedEndMediaTimeMicroseconds(
            secondsToMicroseconds(5.12)
        );

        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.04),
            undefined,
            { queuedFrames: 0, reason: 'underflow' }
        );
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'audio-buffer')).toHaveLength(1);

        harness.videoDecodeSession.emit({ generation, type: 'ended' });
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.events.filter(event => event.type === 'playing')).toHaveLength(2);

        harness.setMonotonicTime(secondsToMicroseconds(11));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);

        harness.audioOutput?.emitTelemetry(
            requireMicroseconds(5_119_999),
            undefined,
            { queuedFrames: 0 }
        );
        expect(harness.controller.playbackState).toBe('playing');
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.12),
            undefined,
            { queuedFrames: 0 }
        );

        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'ended')).toEqual([ {
            generation,
            type: 'ended'
        } ]);
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it('continues the presentation clock through a video tail after physical audio drains', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        const finalFrame = createDecodedFrame(
            secondsToMicroseconds(5.12),
            millisecondsToMicroseconds(40)
        );
        harness.videoDecodeSession.queueFrame(finalFrame);
        harness.audioBridge.setSubmittedEndMediaTimeMicroseconds(
            secondsToMicroseconds(5.08)
        );
        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.04),
            undefined,
            { queuedFrames: 0, reason: 'underflow' }
        );
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.08),
            undefined,
            { queuedFrames: 0 }
        );
        expect(harness.controller.playbackState).toBe('playing');

        harness.setMonotonicTime(millisecondsToMicroseconds(10_030));
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.08),
            undefined,
            { queuedFrames: 0, reason: 'periodic' }
        );
        harness.setMonotonicTime(millisecondsToMicroseconds(10_040));
        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        expect(harness.controller.playbackState).toBe('playing');

        harness.setMonotonicTime(millisecondsToMicroseconds(10_080));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.fallbackRequests).toHaveLength(0);
    });

    it('uses a bounded latency-based grace when physical output correlation is unavailable', async () => {
        const harness = createControllerHarness(true, {
            playbackStallTimeoutMicroseconds: millisecondsToMicroseconds(100)
        });
        const generation = await startReadyPlayback(harness, true);
        const finalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(finalFrame);
        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        harness.audioBridge.setSubmittedEndMediaTimeMicroseconds(
            secondsToMicroseconds(5.08)
        );
        harness.audioOutput?.setEstimatedOutputLatencyMicroseconds(
            millisecondsToMicroseconds(50)
        );
        harness.videoDecodeSession.emit({ generation, type: 'ended' });
        harness.audioOutput?.emitTelemetry(
            secondsToMicroseconds(5.08),
            undefined,
            {
                hasPhysicalOutputTimeCorrelation: false,
                queuedFrames: 0,
                reason: 'underflow'
            }
        );

        harness.setMonotonicTime(millisecondsToMicroseconds(10_149));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('playing');
        expect(harness.fallbackRequests).toHaveLength(0);

        harness.setMonotonicTime(millisecondsToMicroseconds(10_150));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'waiting'
            && event.reason === 'audio-buffer')).toHaveLength(0);
        expect(harness.fallbackRequests).toHaveLength(0);
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
        expect(harness.videoDecodeSession.acknowledgeFrame).toHaveBeenCalledWith(finalFrame);
        expect(harness.controller.playbackState).toBe('playing');
        harness.setMonotonicTime(millisecondsToMicroseconds(10_039));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('playing');
        harness.setMonotonicTime(millisecondsToMicroseconds(10_040));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'ended')).toEqual([
            { generation, type: 'ended' }
        ]);
    });

    it('holds a submitted final frame when the decoder ends after its acknowledgment', async () => {
        const harness = createControllerHarness(false);
        const generation = await startReadyPlayback(harness, false);
        const finalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(finalFrame);

        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });
        expect(harness.controller.playbackState).toBe('playing');

        harness.setMonotonicTime(millisecondsToMicroseconds(10_040));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.events.filter(event => event.type === 'ended')).toEqual([
            { generation, type: 'ended' }
        ]);
    });

    it.each([
        {
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            label: '24 fps'
        },
        {
            durationMicroseconds: secondsToMicroseconds(2),
            label: 'long VFR still'
        }
    ])('holds a $label final frame for its complete duration', async ({
        durationMicroseconds
    }) => {
        const harness = createControllerHarness(false);
        const generation = await startReadyPlayback(harness, false);
        const finalFrame = createDecodedFrame(
            secondsToMicroseconds(5),
            durationMicroseconds
        );
        harness.videoDecodeSession.queueFrame(finalFrame);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        harness.setMonotonicTime(
            addMicroseconds(
                secondsToMicroseconds(10),
                addMicroseconds(durationMicroseconds, millisecondsToMicroseconds(-0.001))
            )
        );
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('playing');

        harness.setMonotonicTime(addMicroseconds(
            secondsToMicroseconds(10),
            durationMicroseconds
        ));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('ended');
    });

    it('does not invent a hold duration for a zero-duration final frame', async () => {
        const harness = createControllerHarness(false);
        const generation = await startReadyPlayback(harness, false);
        const finalFrame = createDecodedFrame(
            secondsToMicroseconds(5),
            secondsToMicroseconds(0)
        );
        harness.videoDecodeSession.queueFrame(finalFrame);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFramePresented(finalFrame)).toBe(true);
        expect(harness.controller.playbackState).toBe('ended');
    });

    it('releases a discarded presentation frame and completes end drain', async () => {
        const harness = createControllerHarness(false);
        const generation = await startReadyPlayback(harness, false);
        const finalFrame = createDecodedFrame(secondsToMicroseconds(5));
        harness.videoDecodeSession.queueFrame(finalFrame);
        harness.videoDecodeSession.emit({ generation, type: 'ended' });

        expect(harness.controller.takeCurrentFrame()).toBe(finalFrame);
        expect(harness.controller.notifyFrameDiscarded(finalFrame)).toBe(true);
        expect(harness.videoDecodeSession.discardFrame).toHaveBeenCalledWith(finalFrame);
        expect(harness.controller.playbackState).toBe('playing');
        harness.setMonotonicTime(millisecondsToMicroseconds(10_040));
        expect(harness.controller.takeCurrentFrame()).toBeNull();
        expect(harness.controller.playbackState).toBe('ended');
        expect(harness.controller.notifyFrameDiscarded(finalFrame)).toBe(false);
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

    it('does not let delayed seek preparation stop the latest generation', async () => {
        const harness = createControllerHarness(true);
        await startReadyPlayback(harness, true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        const delayedAudioSuspension = createDeferred<void>();
        harness.audioOutput.setPlaying.mockImplementationOnce(
            (): Promise<void> => delayedAudioSuspension.promise
        );

        const firstSeek = harness.controller.seek(secondsToMicroseconds(10));
        const secondSeek = harness.controller.seek(secondsToMicroseconds(20));
        await flushAsyncWork();
        const latestGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!latestGeneration) {
            throw new Error('Latest seek generation did not start');
        }
        expect(harness.videoDecodeSession.starts.at(-1)?.startTimeMicroseconds)
            .toBe(secondsToMicroseconds(20));
        const stopCallCount = harness.videoDecodeSession.stop.mock.calls.length;

        delayedAudioSuspension.resolve(undefined);
        await flushAsyncWork();
        expect(harness.videoDecodeSession.stop).toHaveBeenCalledTimes(stopCallCount);

        const audioConfiguration: DecodeWorkerAudioConfiguration = {
            channelCount: 2,
            codec: 'opus',
            sampleRate: 48_000
        };
        await harness.videoDecodeSession.prepareAudio(audioConfiguration);
        harness.audioBridge.activate(latestGeneration, harness.audioOutput.generation);
        harness.videoDecodeSession.emit({
            audio: audioConfiguration,
            codec: 'avc1.640028',
            generation: latestGeneration,
            type: 'ready'
        });

        await expect(firstSeek).resolves.toMatchObject({ status: 'superseded' });
        await expect(secondSeek).resolves.toMatchObject({
            generation: latestGeneration,
            status: 'started'
        });
        await harness.controller.destroy();
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

    it('switches between decoded PCM and owned native media audio routes', async () => {
        const nativeAudioBridgeFactory = (
            vi.fn() as unknown as CustomDecodeNativeAudioBridgeFactory
        );
        const harness = createControllerHarness(true, { nativeAudioBridgeFactory });
        const firstGeneration = await startReadyPlayback(harness, true);
        harness.audioOutput?.emitTelemetry(secondsToMicroseconds(33));

        const nativeSwitchPromise = harness.controller.setAudioStreamIndex(4, 'native-media');
        await flushAsyncWork();
        const nativeGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!nativeGeneration) {
            throw new Error('Native audio switch generation did not start');
        }
        expect(nativeGeneration).toBeGreaterThan(firstGeneration);
        expect(harness.videoDecodeSession.starts.at(-1)).toMatchObject({
            audioOutputMode: 'native-media',
            audioTrackIndex: 4,
            startTimeMicroseconds: secondsToMicroseconds(33)
        });
        harness.videoDecodeSession.emit({
            audio: {
                channelCount: 6,
                codec: 'ec-3',
                mimeType: 'audio/mp4; codecs="ec-3"',
                outputMode: 'native-media',
                sampleRate: 48_000
            },
            codec: 'hvc1.2.4.L153.B0',
            generation: nativeGeneration,
            type: 'ready'
        });
        await expect(nativeSwitchPromise).resolves.toMatchObject({
            generation: nativeGeneration,
            status: 'started'
        });

        harness.videoDecodeSession.setNativeAudioTimeMicroseconds(secondsToMicroseconds(44));
        const decodedSwitchPromise = harness.controller.setAudioStreamIndex(5, 'decoded-pcm');
        await flushAsyncWork();
        const decodedGeneration = harness.videoDecodeSession.starts.at(-1)?.generation;
        if (!decodedGeneration) {
            throw new Error('Decoded audio switch generation did not start');
        }
        expect(decodedGeneration).toBeGreaterThan(nativeGeneration);
        expect(harness.videoDecodeSession.starts.at(-1)).toMatchObject({
            audioOutputMode: 'decoded-pcm',
            audioTrackIndex: 5,
            startTimeMicroseconds: secondsToMicroseconds(44)
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
        harness.audioBridge.activate(decodedGeneration, harness.audioOutput.generation);
        harness.videoDecodeSession.emit({
            audio: audioConfiguration,
            codec: 'avc1.640028',
            generation: decodedGeneration,
            type: 'ready'
        });
        await expect(decodedSwitchPromise).resolves.toMatchObject({
            generation: decodedGeneration,
            status: 'started'
        });
        expect(harness.controller.audioStreamIndex).toBe(5);
    });

    it('requests same-session HTML fallback when custom audio is unavailable', async () => {
        const harness = createControllerHarness(false);
        const result = await harness.controller.play(createPlayOptions(0));

        expect(result).toMatchObject({
            fallbackReason: 'audio-output-unavailable',
            status: 'fallback'
        });
        expect(harness.fallbackRequests).toEqual([ {
            disposition: 'same-session-native',
            generation: result.generation,
            mediaTimeMicroseconds: 5_000_000,
            preserveHTMLSession: true,
            reason: 'audio-output-unavailable'
        } ]);
        expect(harness.videoDecodeSession.starts).toHaveLength(0);
        expect(harness.controller.playbackState).toBe('fallback');
    });

    it('forwards static HDR metadata before playback becomes ready', async () => {
        const harness = createControllerHarness(false);
        const startPromise = harness.controller.play(createPlayOptions());
        await flushAsyncWork();
        const generation = harness.videoDecodeSession.starts[0]?.generation;
        if (!generation) {
            throw new Error('Video decode did not start');
        }
        const staticHDRMetadata = {
            masteringDisplayMaximumLuminanceNits: 4_000,
            masteringDisplayMinimumLuminanceNits: 0.005,
            maximumContentLightLevelNits: 500,
            maximumFrameAverageLightLevelNits: 200
        };
        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            generation,
            staticHDRMetadata,
            type: 'configured'
        });
        expect(harness.events.filter(event => event.type === 'static-hdr-metadata'))
            .toEqual([ {
                generation,
                metadata: staticHDRMetadata,
                type: 'static-hdr-metadata'
            } ]);
        expect(harness.events.some(event => event.type === 'ready')).toBe(false);

        harness.videoDecodeSession.emit({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            generation,
            staticHDRMetadata,
            type: 'ready'
        });
        await expect(startPromise).resolves.toMatchObject({
            generation,
            status: 'started'
        });
    });

    it('keeps configured-without-media startup bounded and latches one fallback request', async () => {
        vi.useFakeTimers();
        try {
            const harness = createControllerHarness(false);
            const startPromise = harness.controller.play(createPlayOptions());
            await flushAsyncWork();
            const generation = harness.videoDecodeSession.starts[0].generation;
            harness.videoDecodeSession.emit({
                audio: null,
                codec: 'avc1.640028',
                generation,
                type: 'configured'
            });
            expect(harness.controller.playbackState).toBe('starting');
            await vi.advanceTimersByTimeAsync(100);

            await expect(startPromise).resolves.toMatchObject({
                fallbackReason: 'startup-timeout',
                status: 'fallback'
            });
            expect(harness.fallbackRequests).toHaveLength(1);
            expect(harness.fallbackRequests[0]).toMatchObject({
                disposition: 'renegotiate-source',
                reason: 'startup-timeout'
            });

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
            disposition: 'same-session-native',
            preserveHTMLSession: true,
            reason: 'playback-rate-unsupported'
        });
        expect(harness.controller.playbackState).toBe('fallback');
    });

    it.each([
        [ 'decode-failed', 'renegotiate-source' ],
        [ 'network-failed', 'renegotiate-source' ],
        [ 'range-unsupported', 'renegotiate-source' ],
        [ 'source-unsupported', 'renegotiate-source' ],
        [ 'audio-output-failed', 'same-session-native' ]
    ] as const)(
        'preserves worker failure %s and assigns %s fallback',
        async (failureKind, disposition) => {
            const harness = createControllerHarness(false);
            const startPromise = harness.controller.play(createPlayOptions());
            await flushAsyncWork();
            const generation = harness.videoDecodeSession.starts[0].generation;

            harness.videoDecodeSession.emit({
                failureKind,
                generation,
                message: `simulated ${failureKind}`,
                type: 'error'
            });

            await expect(startPromise).resolves.toMatchObject({
                fallbackReason: failureKind,
                status: 'fallback'
            });
            expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
                disposition,
                generation,
                reason: failureKind
            }) ]);
        }
    );

    it('latches a recoverable decode fallback and leaves owned audio stopped', async () => {
        const harness = createControllerHarness(true);
        const generation = await startReadyPlayback(harness, true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        const decodeFailure: CustomDecodeSessionEvent = {
            failureKind: 'decode-failed',
            generation,
            message: 'simulated bounded decode failure',
            type: 'error'
        };

        harness.videoDecodeSession.emit(decodeFailure);
        await flushAsyncWork();
        harness.videoDecodeSession.emit(decodeFailure);
        await flushAsyncWork();

        expect(harness.fallbackRequests).toHaveLength(1);
        expect(harness.events.filter(event => event.type === 'error')).toEqual([{
            generation,
            message: 'simulated bounded decode failure',
            recoverable: true,
            type: 'error'
        }]);
        expect(harness.audioOutput.setPlaying).toHaveBeenLastCalledWith(false);

        await harness.controller.destroy();
        expect(harness.audioOutput.destroy).toHaveBeenCalledOnce();
        expect(harness.audioOutput.setPlaying).toHaveBeenLastCalledWith(false);
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

    it('rejects an unmeasured decoder layout before invoking the audio output factory', async () => {
        const harness = createControllerHarness(true);
        if (!harness.audioOutput) {
            throw new Error('Expected an audio output');
        }
        const startPromise = harness.controller.play(createPlayOptions(1));
        await flushAsyncWork();

        await expect(harness.videoDecodeSession.prepareAudio({
            channelCount: 7,
            codec: 'ac3',
            sampleRate: 48_000
        })).rejects.toThrow('Custom audio output requires 2, 6, or 8 channels at 48000 Hz');
        expect(harness.audioOutput.setVolume).not.toHaveBeenCalled();
        expect(harness.audioOutput.setMuted).not.toHaveBeenCalled();

        await harness.controller.stop();
        await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
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

    it('bounds stalled audio destruction', async () => {
        vi.useFakeTimers();
        try {
            const harness = createControllerHarness(true);
            await startReadyPlayback(harness, true);
            if (!harness.audioOutput) {
                throw new Error('Expected an audio output');
            }
            harness.audioOutput.destroy.mockReturnValueOnce(
                new Promise<void>(() => undefined)
            );
            const destroyPromise = harness.controller.destroy();

            await vi.advanceTimersByTimeAsync(100);

            await expect(destroyPromise).resolves.toBeUndefined();
            expect(harness.audioOutput.destroy).toHaveBeenCalledOnce();
            expect(harness.controller.getTelemetry().lastErrorMessage).toContain(
                'Custom audio output destruction exceeded its bound'
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds stalled audio suspension while stopping the decode pipeline', async () => {
        vi.useFakeTimers();
        try {
            const harness = createControllerHarness(true);
            await startReadyPlayback(harness, true);
            if (!harness.audioOutput) {
                throw new Error('Expected an audio output');
            }
            harness.audioOutput.setPlaying.mockImplementation((playing: boolean) => (
                playing ? undefined : new Promise<void>(() => undefined)
            ));

            const stopPromise = harness.controller.stop();
            expect(harness.videoDecodeSession.stop).toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(100);

            await expect(stopPromise).resolves.toBeUndefined();
            expect(harness.controller.getTelemetry().lastErrorMessage).toContain(
                'Custom playback shutdown exceeded its bound'
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds an unresolved audio suspension before preparing a replacement generation', async () => {
        vi.useFakeTimers();
        try {
            const harness = createControllerHarness(true, {
                startupTimeoutMicroseconds: millisecondsToMicroseconds(200)
            });
            await startReadyPlayback(harness, true);
            if (!harness.audioOutput) {
                throw new Error('Expected an audio output');
            }
            harness.audioOutput.setPlaying.mockImplementation((playing: boolean) => (
                playing ? undefined : new Promise<void>(() => undefined)
            ));

            const seekPromise = harness.controller.seek(secondsToMicroseconds(42));
            await vi.advanceTimersByTimeAsync(100);

            await expect(seekPromise).resolves.toMatchObject({
                fallbackReason: 'audio-output-failed',
                status: 'fallback'
            });
            expect(harness.controller.getTelemetry().lastErrorMessage).toContain(
                'Custom audio suspension exceeded its bound'
            );
            expect(harness.fallbackRequests).toEqual([ expect.objectContaining({
                reason: 'audio-output-failed'
            }) ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it('bounds an unresolved initial audio suspension and destroys the rejected binding', async () => {
        vi.useFakeTimers();
        try {
            const harness = createControllerHarness(true, {
                startupTimeoutMicroseconds: millisecondsToMicroseconds(200)
            });
            if (!harness.audioOutput) {
                throw new Error('Expected an audio output');
            }
            harness.audioOutput.setPlaying.mockImplementation((playing: boolean) => (
                playing ? undefined : new Promise<void>(() => undefined)
            ));
            const startPromise = harness.controller.play(createPlayOptions(1));
            await flushAsyncWork();
            const audioPreparation = harness.videoDecodeSession.prepareAudio({
                channelCount: 2,
                codec: 'opus',
                sampleRate: 48_000
            });
            const audioPreparationRejection = expect(audioPreparation).rejects.toThrow(
                'Custom audio initialization suspension exceeded its bound'
            );

            await vi.advanceTimersByTimeAsync(100);

            await audioPreparationRejection;
            expect(harness.audioOutput.destroy).toHaveBeenCalledOnce();
            const stopPromise = harness.controller.stop();
            await vi.advanceTimersByTimeAsync(100);
            await expect(stopPromise).resolves.toBeUndefined();
            await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('settles destruction and asynchronously releases an audio factory that outlives it', async () => {
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
        expect(destroySettled).toBe(true);

        factoryResult.resolve({
            bridge: audioBridge as unknown as CustomDecodeAudioBridge,
            configuration: audioConfiguration,
            output: audioOutput
        });
        await expect(audioPreparation).resolves.toBeNull();
        await expect(destroyPromise).resolves.toBeUndefined();
        await expect(startPromise).resolves.toMatchObject({ status: 'stopped' });
        await flushAsyncWork();
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
