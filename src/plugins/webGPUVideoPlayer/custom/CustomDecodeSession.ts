import CustomDecodeWorker from './CustomDecode.worker';
import type { Microseconds } from '../MediaTime';
import type {
    DecodedFrameProvider,
    DecodedPresentationFrame
} from '../WebGPUPresenter';
import type CustomDecodeAudioBridge from './CustomDecodeAudioBridge';
import { requireMicroseconds } from './TimeMath';
import {
    isDecodeWorkerResponse,
    MAX_DECODED_FRAME_CREDITS,
    type CustomDecodeFailureKind,
    type DecodeWorkerAudioConfiguration,
    type DecodeWorkerAudioResponse,
    type DecodeWorkerFrameResponse,
    type DecodeWorkerRequest
} from './DecodeWorkerProtocol';

const WORKER_STOP_TIMEOUT_MILLISECONDS = 1_000;

export type CustomDecodeSessionStartOptions = {
    audioTrackIndex?: number | null
    generation: number
    startTimeMicroseconds: Microseconds
    url: string
    videoTrackIndex: number
};

export type CustomDecodeSessionEvent =
    | {
        audio: DecodeWorkerAudioConfiguration | null
        codec: string
        generation: number
        type: 'ready'
    }
    | {
        failureKind: CustomDecodeFailureKind
        generation: number
        message: string
        type: 'error'
    }
    | {
        generation: number
        type: 'ended'
    };

export type CustomDecodeSessionTelemetry = {
    activeGeneration: number | null
    audioCodec: string | null
    droppedFrameCount: number
    failureKind: CustomDecodeFailureKind | null
    firstFrameMediaTimeMicroseconds: Microseconds | null
    lastAudioMediaTimeMicroseconds: Microseconds | null
    lastFrameMediaTimeMicroseconds: Microseconds | null
    queuedFrameCount: number
    receivedAudioFrameCount: number
    receivedAudioSampleCount: number
    receivedFrameCount: number
    staleAudioSampleCount: number
    staleFrameCount: number
    state: 'ended' | 'error' | 'idle' | 'ready' | 'starting'
    submittedAudioFrameCount: number
    submittedAudioSampleCount: number
    takenFrameCount: number
};

export type CustomDecodeSessionEventHandler = (event: CustomDecodeSessionEvent) => void;
export type CustomDecodeWorkerFactory = () => Worker;
export type CustomDecodeAudioBridgeFactory = (
    audioConfiguration: DecodeWorkerAudioConfiguration
) => CustomDecodeAudioBridge | Promise<CustomDecodeAudioBridge>;

type QueuedFrame = {
    durationMicroseconds: Microseconds
    frame: VideoFrame
    mediaTimeMicroseconds: Microseconds
};

type WorkerRecord = {
    audioConfiguration: DecodeWorkerAudioConfiguration | null
    audioRequested: boolean
    errorHandler: (event: ErrorEvent) => void
    generation: number
    messageHandler: (event: MessageEvent<unknown>) => void
    resolveRetirement: (() => void) | null
    retirementPromise: Promise<void> | null
    retirementTimer: ReturnType<typeof globalThis.setTimeout> | null
    readyPending: boolean
    startTimeMicroseconds: Microseconds
    videoCodec: string | null
    worker: Worker
};

function createTelemetry(): CustomDecodeSessionTelemetry {
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

function createDefaultWorker(): Worker {
    return new CustomDecodeWorker();
}

function isValidGeneration(generation: number): boolean {
    return Number.isSafeInteger(generation) && generation > 0;
}

function closeFrameFromUnknownMessage(value: unknown): void {
    if (!value || typeof value !== 'object') {
        return;
    }

    const frame = (value as { frame?: unknown }).frame;
    if (frame && typeof frame === 'object' && typeof (frame as { close?: unknown }).close === 'function') {
        (frame as { close: () => void }).close();
    }
}

/** Owns one bounded, generation-safe custom video decode worker session. */
export default class CustomDecodeSession implements DecodedFrameProvider {
    private activeAudioBridge: CustomDecodeAudioBridge | null = null;
    private readonly audioBridgeFactory: CustomDecodeAudioBridgeFactory | null;
    private readonly configuredAudioBridge: CustomDecodeAudioBridge | null;
    private readonly eventHandler: CustomDecodeSessionEventHandler;
    private readonly retiringWorkers = new Set<WorkerRecord>();
    private readonly workerFactory: CustomDecodeWorkerFactory;
    private readonly queuedFrames: QueuedFrame[] = [];

    private activeWorker: WorkerRecord | null = null;
    private telemetry = createTelemetry();

    public constructor(
        eventHandler: CustomDecodeSessionEventHandler = () => undefined,
        workerFactory: CustomDecodeWorkerFactory = createDefaultWorker,
        audioBridge: CustomDecodeAudioBridge | null = null,
        audioBridgeFactory: CustomDecodeAudioBridgeFactory | null = null
    ) {
        if (audioBridge && audioBridgeFactory) {
            throw new TypeError('Provide either a decoded audio bridge or a bridge factory, not both');
        }
        this.audioBridgeFactory = audioBridgeFactory;
        this.configuredAudioBridge = audioBridge;
        this.eventHandler = eventHandler;
        this.workerFactory = workerFactory;
    }

    /** Starts a fresh worker and retires any previous generation. */
    public start(options: CustomDecodeSessionStartOptions): void {
        this.validateStartOptions(options);

        const previousWorker = this.activeWorker;
        this.activeWorker = null;
        this.activeAudioBridge?.stop(previousWorker?.generation ?? null);
        this.activeAudioBridge = null;
        if (previousWorker) {
            void this.beginWorkerRetirement(previousWorker);
        }
        this.closeQueuedFrames();

        this.telemetry = createTelemetry();
        this.telemetry.activeGeneration = options.generation;
        this.telemetry.state = 'starting';

        let worker: Worker;
        try {
            worker = this.workerFactory();
        } catch {
            this.failSession(options.generation, 'decode-failed', 'Unable to create the custom decode worker');
            return;
        }

        const workerRecord = this.createWorkerRecord(
            worker,
            options.generation,
            options.startTimeMicroseconds,
            options.audioTrackIndex != null
        );
        this.activeWorker = workerRecord;
        worker.addEventListener('message', workerRecord.messageHandler);
        worker.addEventListener('error', workerRecord.errorHandler);

        try {
            this.postRequest(workerRecord, {
                audioSampleCredits: 0,
                audioTrackIndex: options.audioTrackIndex ?? null,
                frameCredits: MAX_DECODED_FRAME_CREDITS,
                generation: options.generation,
                startTimeMicroseconds: options.startTimeMicroseconds,
                type: 'start',
                url: options.url,
                videoTrackIndex: options.videoTrackIndex
            });
        } catch {
            this.activeWorker = null;
            this.finishWorker(workerRecord);
            this.failSession(options.generation, 'decode-failed', 'Unable to start the custom decode worker');
        }
    }

    /** Stops decoding, closes queued frames, and terminates the worker after cleanup. */
    public stop(): Promise<void> {
        const workerRecord = this.activeWorker;
        this.activeWorker = null;
        this.activeAudioBridge?.stop(workerRecord?.generation ?? null);
        this.activeAudioBridge = null;
        this.closeQueuedFrames();
        this.telemetry.activeGeneration = null;
        this.telemetry.state = 'idle';

        if (workerRecord) {
            void this.beginWorkerRetirement(workerRecord);
        }

        const retirementPromises: Promise<void>[] = [];
        for (const retiringWorker of this.retiringWorkers) {
            retirementPromises.push(this.beginWorkerRetirement(retiringWorker));
        }
        if (retirementPromises.length === 1) {
            return retirementPromises[0];
        }
        return Promise.all(retirementPromises).then((): void => undefined);
    }

    /** Returns a snapshot of custom decode state and queue accounting. */
    public getTelemetry(): CustomDecodeSessionTelemetry {
        return {
            ...this.telemetry,
            queuedFrameCount: this.queuedFrames.length
        };
    }

    /** Transfers the newest decoded frame at or before the HTML clock time. */
    public takeFrame(targetTimeMicroseconds: Microseconds): DecodedPresentationFrame | null {
        requireMicroseconds(targetTimeMicroseconds, 'Presentation target time');

        let selectedFrameIndex = -1;
        for (let frameIndex = 0; frameIndex < this.queuedFrames.length; frameIndex += 1) {
            if (this.queuedFrames[frameIndex].mediaTimeMicroseconds > targetTimeMicroseconds) {
                break;
            }
            selectedFrameIndex = frameIndex;
        }

        if (selectedFrameIndex < 0) {
            return null;
        }

        for (let frameIndex = 0; frameIndex < selectedFrameIndex; frameIndex += 1) {
            this.queuedFrames[frameIndex].frame.close();
            this.telemetry.droppedFrameCount += 1;
        }

        const releasedFrameCount = selectedFrameIndex + 1;
        const selectedFrame = this.queuedFrames[selectedFrameIndex];
        this.queuedFrames.splice(0, releasedFrameCount);
        this.telemetry.queuedFrameCount = this.queuedFrames.length;
        this.telemetry.takenFrameCount += 1;
        this.requestReplacementFrames(releasedFrameCount);

        return selectedFrame;
    }

    private validateStartOptions(options: CustomDecodeSessionStartOptions): void {
        if (!isValidGeneration(options.generation)) {
            throw new RangeError('Custom decode generation must be a positive safe integer');
        }
        requireMicroseconds(options.startTimeMicroseconds, 'Custom decode start time');
        if (typeof options.url !== 'string' || !options.url) {
            throw new TypeError('Custom decode URL must be a non-empty string');
        }
        if (!Number.isSafeInteger(options.videoTrackIndex) || options.videoTrackIndex < 0) {
            throw new RangeError('Custom decode video track index must be a non-negative safe integer');
        }
        if (
            options.audioTrackIndex !== undefined
            && options.audioTrackIndex !== null
            && (!Number.isSafeInteger(options.audioTrackIndex) || options.audioTrackIndex < 0)
        ) {
            throw new RangeError('Custom decode audio track index must be a non-negative safe integer');
        }
        if (
            options.audioTrackIndex != null
            && !this.configuredAudioBridge
            && !this.audioBridgeFactory
        ) {
            throw new Error('Custom audio decode requires an AudioWorklet bridge');
        }
    }

    private createWorkerRecord(
        worker: Worker,
        generation: number,
        startTimeMicroseconds: Microseconds,
        audioRequested: boolean
    ): WorkerRecord {
        const workerRecord: WorkerRecord = {
            audioConfiguration: null,
            audioRequested,
            errorHandler: (): void => undefined,
            generation,
            messageHandler: (): void => undefined,
            resolveRetirement: null,
            retirementPromise: null,
            retirementTimer: null,
            readyPending: false,
            startTimeMicroseconds,
            videoCodec: null,
            worker
        };

        workerRecord.messageHandler = event => {
            this.handleWorkerMessage(workerRecord, event.data);
        };
        workerRecord.errorHandler = event => {
            event.preventDefault();
            this.handleWorkerCrash(workerRecord);
        };
        return workerRecord;
    }

    private handleWorkerMessage(workerRecord: WorkerRecord, messageValue: unknown): void {
        if (!isDecodeWorkerResponse(messageValue)) {
            closeFrameFromUnknownMessage(messageValue);
            if (this.activeWorker === workerRecord) {
                this.activeWorker = null;
                this.activeAudioBridge?.stop(workerRecord.generation);
                this.activeAudioBridge = null;
                this.closeQueuedFrames();
                void this.beginWorkerRetirement(workerRecord);
                this.failSession(workerRecord.generation, 'decode-failed', 'The custom decode worker sent an invalid message');
            }
            return;
        }

        if (messageValue.type === 'stopped') {
            this.finishWorker(workerRecord);
            return;
        }

        if (
            this.activeWorker !== workerRecord
            || messageValue.generation !== workerRecord.generation
            || this.telemetry.activeGeneration !== workerRecord.generation
        ) {
            if (messageValue.type === 'frame') {
                messageValue.frame.close();
                this.telemetry.staleFrameCount += 1;
            } else if (messageValue.type === 'audio') {
                this.telemetry.staleAudioSampleCount += 1;
            }
            return;
        }

        switch (messageValue.type) {
            case 'ready':
                this.handleReadyResponse(workerRecord, messageValue.audio, messageValue.codec);
                break;
            case 'frame':
                this.enqueueFrame(workerRecord, messageValue);
                break;
            case 'audio':
                this.enqueueAudioSample(workerRecord, messageValue);
                break;
            case 'ended':
                this.telemetry.state = 'ended';
                this.emitEvent({ generation: messageValue.generation, type: 'ended' });
                break;
            case 'error':
                this.activeWorker = null;
                this.activeAudioBridge?.stop(workerRecord.generation);
                this.activeAudioBridge = null;
                this.closeQueuedFrames();
                void this.beginWorkerRetirement(workerRecord);
                this.failSession(
                    messageValue.generation,
                    messageValue.failureKind,
                    messageValue.message
                );
                break;
        }
    }

    private handleReadyResponse(
        workerRecord: WorkerRecord,
        audioConfiguration: DecodeWorkerAudioConfiguration | null,
        videoCodec: string
    ): void {
        if (workerRecord.readyPending || this.telemetry.state !== 'starting') {
            this.handleDecodeProtocolFailure(workerRecord, 'The custom decode worker sent duplicate readiness');
            return;
        }
        workerRecord.readyPending = true;
        workerRecord.audioConfiguration = audioConfiguration;
        if (workerRecord.audioRequested !== Boolean(audioConfiguration)) {
            this.handleAudioOutputFailure(workerRecord, 'Decoded audio configuration did not match the request');
            return;
        }

        if (!audioConfiguration) {
            this.completeReady(workerRecord, videoCodec, null, null);
            return;
        }

        if (this.configuredAudioBridge) {
            this.completeReady(
                workerRecord,
                videoCodec,
                audioConfiguration,
                this.configuredAudioBridge
            );
            return;
        }

        const audioBridgeFactory = this.audioBridgeFactory;
        if (!audioBridgeFactory) {
            this.handleAudioOutputFailure(workerRecord, 'Decoded audio has no configured output');
            return;
        }

        let audioBridgeResult: CustomDecodeAudioBridge | Promise<CustomDecodeAudioBridge>;
        try {
            audioBridgeResult = audioBridgeFactory(audioConfiguration);
        } catch {
            this.handleAudioOutputFailure(workerRecord, 'Unable to create decoded audio output');
            return;
        }
        void Promise.resolve(audioBridgeResult).then(
            audioBridge => {
                if (!this.isWorkerCurrent(workerRecord)) {
                    return;
                }
                this.completeReady(workerRecord, videoCodec, audioConfiguration, audioBridge);
            },
            (): void => {
                if (this.isWorkerCurrent(workerRecord)) {
                    this.handleAudioOutputFailure(workerRecord, 'Unable to create decoded audio output');
                }
            }
        );
    }

    private completeReady(
        workerRecord: WorkerRecord,
        videoCodec: string,
        audioConfiguration: DecodeWorkerAudioConfiguration | null,
        audioBridge: CustomDecodeAudioBridge | null
    ): void {
        if (!this.isWorkerCurrent(workerRecord)) {
            return;
        }
        workerRecord.videoCodec = videoCodec;

        if (audioConfiguration && audioBridge) {
            this.activeAudioBridge = audioBridge;
            try {
                audioBridge.start({
                    audioConfiguration,
                    callbacks: {
                        onCreditsReleased: audioSampleCredits => {
                            this.requestReplacementAudioSamples(workerRecord, audioSampleCredits);
                        },
                        onFailure: message => {
                            this.handleAudioOutputFailure(workerRecord, message);
                        }
                    },
                    decodeGeneration: workerRecord.generation,
                    startTimeMicroseconds: workerRecord.startTimeMicroseconds
                });
            } catch {
                this.handleAudioOutputFailure(workerRecord, 'Unable to initialize decoded audio output');
                return;
            }
            this.requestReplacementAudioSamples(
                workerRecord,
                audioBridge.initialAudioSampleCredits
            );
            if (!this.isWorkerCurrent(workerRecord)) {
                return;
            }
            // Wait for the first submitted PCM sample before starting the clock
            return;
        }

        this.emitReadyEvent(workerRecord);
    }

    private emitReadyEvent(workerRecord: WorkerRecord): void {
        const videoCodec = workerRecord.videoCodec;
        if (!this.isWorkerCurrent(workerRecord) || !videoCodec) {
            return;
        }

        workerRecord.readyPending = false;
        this.telemetry.audioCodec = workerRecord.audioConfiguration?.codec ?? null;
        this.telemetry.state = 'ready';
        this.emitEvent({
            audio: workerRecord.audioConfiguration,
            codec: videoCodec,
            generation: workerRecord.generation,
            type: 'ready'
        });
    }

    private isWorkerCurrent(workerRecord: WorkerRecord): boolean {
        return this.activeWorker === workerRecord
            && this.telemetry.activeGeneration === workerRecord.generation;
    }

    private handleDecodeProtocolFailure(workerRecord: WorkerRecord, message: string): void {
        if (!this.isWorkerCurrent(workerRecord)) {
            return;
        }

        this.activeWorker = null;
        this.activeAudioBridge?.stop(workerRecord.generation);
        this.activeAudioBridge = null;
        this.closeQueuedFrames();
        void this.beginWorkerRetirement(workerRecord);
        this.failSession(workerRecord.generation, 'decode-failed', message);
    }

    private enqueueFrame(workerRecord: WorkerRecord, message: DecodeWorkerFrameResponse): void {
        if (this.queuedFrames.length >= MAX_DECODED_FRAME_CREDITS) {
            message.frame.close();
            this.activeWorker = null;
            this.activeAudioBridge?.stop(workerRecord.generation);
            this.activeAudioBridge = null;
            this.closeQueuedFrames();
            void this.beginWorkerRetirement(workerRecord);
            this.failSession(workerRecord.generation, 'decode-failed', 'The custom decode frame queue exceeded its bound');
            return;
        }

        const queuedFrame: QueuedFrame = {
            durationMicroseconds: message.durationMicroseconds,
            frame: message.frame,
            mediaTimeMicroseconds: message.mediaTimeMicroseconds
        };
        let insertionIndex = this.queuedFrames.length;
        while (
            insertionIndex > 0
            && this.queuedFrames[insertionIndex - 1].mediaTimeMicroseconds > queuedFrame.mediaTimeMicroseconds
        ) {
            insertionIndex -= 1;
        }
        this.queuedFrames.splice(insertionIndex, 0, queuedFrame);

        this.telemetry.firstFrameMediaTimeMicroseconds ??= queuedFrame.mediaTimeMicroseconds;
        this.telemetry.lastFrameMediaTimeMicroseconds = queuedFrame.mediaTimeMicroseconds;
        this.telemetry.queuedFrameCount = this.queuedFrames.length;
        this.telemetry.receivedFrameCount += 1;
    }

    private enqueueAudioSample(
        workerRecord: WorkerRecord,
        message: DecodeWorkerAudioResponse
    ): void {
        this.telemetry.lastAudioMediaTimeMicroseconds = message.mediaTimeMicroseconds;
        this.telemetry.receivedAudioFrameCount += message.frameCount;
        this.telemetry.receivedAudioSampleCount += 1;

        const audioConfiguration = workerRecord.audioConfiguration;
        if (
            !audioConfiguration
            || !this.activeAudioBridge
            || message.channelCount !== audioConfiguration.channelCount
            || message.sampleRate !== audioConfiguration.sampleRate
        ) {
            this.handleAudioOutputFailure(workerRecord, 'Decoded audio did not match the configured output');
            return;
        }

        const enqueueResult = this.activeAudioBridge.enqueue(message, workerRecord.generation);
        switch (enqueueResult.status) {
            case 'submitted':
                this.telemetry.submittedAudioFrameCount += enqueueResult.frameCount;
                this.telemetry.submittedAudioSampleCount += 1;
                if (this.telemetry.state === 'starting') {
                    this.emitReadyEvent(workerRecord);
                }
                break;
            case 'stale-generation':
                this.telemetry.staleAudioSampleCount += 1;
                if (this.activeWorker === workerRecord) {
                    this.handleAudioOutputFailure(workerRecord, 'Decoded audio output generation became stale');
                }
                break;
            case 'controller-rejected':
            case 'output-capacity':
                // The bridge synchronously reports these failures through its callback
                break;
        }
    }

    private requestReplacementFrames(frameCredits: number): void {
        const workerRecord = this.activeWorker;
        if (!workerRecord || frameCredits <= 0) {
            return;
        }

        try {
            this.postRequest(workerRecord, {
                frameCredits,
                generation: workerRecord.generation,
                type: 'pull'
            });
        } catch {
            this.activeWorker = null;
            this.activeAudioBridge?.stop(workerRecord.generation);
            this.activeAudioBridge = null;
            this.closeQueuedFrames();
            this.failSession(workerRecord.generation, 'decode-failed', 'Unable to request more decoded frames');
            this.finishWorker(workerRecord);
        }
    }

    private requestReplacementAudioSamples(
        workerRecord: WorkerRecord,
        audioSampleCredits: number
    ): void {
        if (
            this.activeWorker !== workerRecord
            || audioSampleCredits <= 0
            || !Number.isSafeInteger(audioSampleCredits)
        ) {
            return;
        }

        try {
            this.postRequest(workerRecord, {
                audioSampleCredits,
                generation: workerRecord.generation,
                type: 'pull-audio'
            });
        } catch {
            this.handleAudioOutputFailure(workerRecord, 'Unable to request more decoded audio');
        }
    }

    private handleAudioOutputFailure(workerRecord: WorkerRecord, message: string): void {
        if (this.activeWorker !== workerRecord) {
            return;
        }

        this.activeWorker = null;
        this.activeAudioBridge?.stop(workerRecord.generation);
        this.activeAudioBridge = null;
        this.closeQueuedFrames();
        void this.beginWorkerRetirement(workerRecord);
        this.failSession(workerRecord.generation, 'audio-output-failed', message);
    }

    private handleWorkerCrash(workerRecord: WorkerRecord): void {
        if (this.activeWorker === workerRecord) {
            this.activeWorker = null;
            this.activeAudioBridge?.stop(workerRecord.generation);
            this.activeAudioBridge = null;
            this.closeQueuedFrames();
            this.failSession(workerRecord.generation, 'decode-failed', 'The custom decode worker crashed');
        }
        this.finishWorker(workerRecord);
    }

    private failSession(
        generation: number,
        failureKind: CustomDecodeFailureKind,
        message: string
    ): void {
        this.telemetry.activeGeneration = generation;
        this.telemetry.failureKind = failureKind;
        this.telemetry.state = 'error';
        this.emitEvent({ failureKind, generation, message, type: 'error' });
    }

    private emitEvent(event: CustomDecodeSessionEvent): void {
        try {
            this.eventHandler(event);
        } catch (error) {
            console.warn('Custom decode session event handler failed', error);
        }
    }

    private postRequest(workerRecord: WorkerRecord, request: DecodeWorkerRequest): void {
        workerRecord.worker.postMessage(request);
    }

    private closeQueuedFrames(): void {
        for (const queuedFrame of this.queuedFrames) {
            queuedFrame.frame.close();
        }
        this.queuedFrames.length = 0;
        this.telemetry.queuedFrameCount = 0;
    }

    private beginWorkerRetirement(workerRecord: WorkerRecord): Promise<void> {
        if (workerRecord.retirementPromise) {
            return workerRecord.retirementPromise;
        }

        workerRecord.retirementPromise = new Promise<void>(resolve => {
            workerRecord.resolveRetirement = resolve;
        });
        this.retiringWorkers.add(workerRecord);

        try {
            this.postRequest(workerRecord, {
                generation: workerRecord.generation,
                type: 'stop'
            });
        } catch {
            this.finishWorker(workerRecord);
            return workerRecord.retirementPromise;
        }

        workerRecord.retirementTimer = globalThis.setTimeout(() => {
            this.finishWorker(workerRecord);
        }, WORKER_STOP_TIMEOUT_MILLISECONDS);
        return workerRecord.retirementPromise;
    }

    private finishWorker(workerRecord: WorkerRecord): void {
        if (workerRecord.retirementTimer != null) {
            globalThis.clearTimeout(workerRecord.retirementTimer);
            workerRecord.retirementTimer = null;
        }
        workerRecord.worker.removeEventListener('message', workerRecord.messageHandler);
        workerRecord.worker.removeEventListener('error', workerRecord.errorHandler);
        workerRecord.worker.terminate();
        if (this.activeWorker === workerRecord) {
            this.activeWorker = null;
        }
        this.retiringWorkers.delete(workerRecord);

        const resolveRetirement = workerRecord.resolveRetirement;
        workerRecord.resolveRetirement = null;
        resolveRetirement?.();
    }
}
