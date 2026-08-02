import CustomDecodeWorker from './CustomDecode.worker';
import type { Microseconds } from '../MediaTime';
import type {
    DecodedFrameProvider,
    DecodedPresentationFrame
} from '../WebGPUPresenter';
import type CustomDecodeAudioBridge from './CustomDecodeAudioBridge';
import type CustomDecodeNativeAudioBridge from './CustomDecodeNativeAudioBridge';
import {
    DecodedVideoGeometryError,
    requireConsistentDecodedVideoGeometry
} from './DecodedVideoGeometry';
import { resolveDolbyVisionRPUParserWASMURL } from './DolbyVisionRPUParser';
import { requireMicroseconds } from './TimeMath';
import {
    isDecodeWorkerResponse,
    MAX_DECODED_FRAME_CREDITS,
    MAX_DECODED_RAW_FRAME_CREDITS,
    type CustomDecodeFailureKind,
    type CustomDecodeAudioOutputMode,
    type CustomDecodeRawVideoFrameFormat,
    type CustomDecodeVideoDecoderBackend,
    type CustomDecodeVideoOutputMode,
    type DecodeWorkerAudioConfiguration,
    type DecodeWorkerAudioResponse,
    type DecodeWorkerFrameResponse,
    type DecodeWorkerReadyResponse,
    type DecodeWorkerNativeAudioInitializationResponse,
    type DecodeWorkerNativeAudioMediaResponse,
    type DecodeWorkerNativeMediaAudioConfiguration,
    type DecodeWorkerReadyAudioConfiguration,
    type DecodeWorkerRequest
} from './DecodeWorkerProtocol';
import {
    MAXIMUM_RAW_VIDEO_CODED_HEIGHT,
    MAXIMUM_RAW_VIDEO_CODED_WIDTH,
    type RawVideoFrameGeometry
} from './RawVideoFrameCopy';

const WORKER_STOP_TIMEOUT_MILLISECONDS = 1_000;

export type CustomDecodeSessionStartOptions = {
    audioOutputMode?: CustomDecodeAudioOutputMode
    audioTrackIndex?: number | null
    durationMicroseconds?: Microseconds | null
    generation: number
    maximumCodedHeight: number
    maximumCodedWidth: number
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    startTimeMicroseconds: Microseconds
    url: string
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    videoOutputMode: CustomDecodeVideoOutputMode
    videoTrackIndex: number
};

export type CustomDecodeSessionEvent =
    | {
        audio: DecodeWorkerReadyAudioConfiguration | null
        codec: string
        generation: number
        type: 'configured'
    }
    | {
        audio: DecodeWorkerReadyAudioConfiguration | null
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
    abandonedRawFrameCount: number
    audioCodec: string | null
    droppedFrameCount: number
    failureKind: CustomDecodeFailureKind | null
    firstFrameMediaTimeMicroseconds: Microseconds | null
    lastAudioMediaTimeMicroseconds: Microseconds | null
    lastFrameMediaTimeMicroseconds: Microseconds | null
    nativeAudioClockReady: boolean
    peakFrameCount: number
    pendingFrameCount: number
    queuedFrameCount: number
    receivedAudioFrameCount: number
    receivedAudioSampleCount: number
    receivedDolbyVisionEnhancementFrameCount: number
    receivedDolbyVisionFrameCount: number
    receivedDolbyVisionRPUCount: number
    receivedNativeAudioSegmentCount: number
    receivedFrameCount: number
    recycledRawFrameCount: number
    staleAudioSampleCount: number
    staleFrameCount: number
    state: 'configured' | 'ended' | 'error' | 'idle' | 'ready' | 'starting'
    submittedAudioFrameCount: number
    submittedAudioSampleCount: number
    takenFrameCount: number
};

export type CustomDecodeSessionEventHandler = (event: CustomDecodeSessionEvent) => void;
export type CustomDecodeWorkerFactory = () => Worker;
export type CustomDecodeAudioBridgeFactory = (
    audioConfiguration: DecodeWorkerAudioConfiguration
) => CustomDecodeAudioBridge | Promise<CustomDecodeAudioBridge>;
export type CustomDecodeNativeAudioBridgeFactory = () => CustomDecodeNativeAudioBridge;

type QueuedFrame = {
    presentationFrame: DecodedPresentationFrame
    workerRecord: WorkerRecord
};

type WorkerRecord = {
    audioConfiguration: DecodeWorkerReadyAudioConfiguration | null
    audioMediaReady: boolean
    audioOutputMode: CustomDecodeAudioOutputMode
    audioRequested: boolean
    configurationReceived: boolean
    decodedVideoGeometry: RawVideoFrameGeometry | null
    errorHandler: (event: ErrorEvent) => void
    generation: number
    maximumCodedHeight: number
    maximumCodedWidth: number
    messageHandler: (event: MessageEvent<unknown>) => void
    nativeAudioElementEnded: boolean
    nativeAudioEndOfStreamAccepted: boolean
    resolveRetirement: (() => void) | null
    retirementPromise: Promise<void> | null
    retirementTimer: ReturnType<typeof globalThis.setTimeout> | null
    startTimeMicroseconds: Microseconds
    durationMicroseconds: Microseconds | null
    videoGeometry: RawVideoFrameGeometry | null
    videoCodec: string | null
    videoMediaReady: boolean
    videoOutputMode: CustomDecodeVideoOutputMode
    worker: Worker
};

function createTelemetry(): CustomDecodeSessionTelemetry {
    return {
        activeGeneration: null,
        abandonedRawFrameCount: 0,
        audioCodec: null,
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
        receivedNativeAudioSegmentCount: 0,
        receivedFrameCount: 0,
        recycledRawFrameCount: 0,
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

function isValidCodedDimension(value: number, maximum: number): boolean {
    return Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

function isValidTrackIndex(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

function isValidOptionalTrackIndex(value: number | null | undefined): boolean {
    return value == null || isValidTrackIndex(value);
}

function isValidVideoOutputMode(value: string): value is CustomDecodeVideoOutputMode {
    return value === 'raw-planes' || value === 'video-frame';
}

function isValidVideoDecoderBackend(value: string): value is CustomDecodeVideoDecoderBackend {
    return value === 'bundled-hevc' || value === 'native';
}

function isNativeMediaAudioConfiguration(
    configuration: DecodeWorkerReadyAudioConfiguration
): configuration is DecodeWorkerNativeMediaAudioConfiguration {
    return 'outputMode' in configuration
        && configuration.outputMode === 'native-media';
}

function hasValidRawVideoFrameFormat(options: CustomDecodeSessionStartOptions): boolean {
    switch (options.videoOutputMode) {
        case 'raw-planes':
            return options.rawVideoFrameFormat === 'I420P10'
                || options.rawVideoFrameFormat === 'I420P12';
        case 'video-frame':
            return options.rawVideoFrameFormat === null;
    }
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

function closePresentationFrame(presentationFrame: DecodedPresentationFrame): void {
    if (presentationFrame.outputMode !== 'video-frame') {
        return;
    }

    try {
        presentationFrame.frame.close();
    } catch {
        // Ownership ends even if a platform implementation throws while closing
    }
}

function validateAudioStartOptions(
    options: CustomDecodeSessionStartOptions,
    decodedAudioAvailable: boolean,
    nativeAudioAvailable: boolean
): void {
    if (!isValidOptionalTrackIndex(options.audioTrackIndex)) {
        throw new RangeError('Custom decode audio track index must be a non-negative safe integer');
    }
    const audioOutputMode = options.audioOutputMode ?? 'decoded-pcm';
    if (audioOutputMode !== 'decoded-pcm' && audioOutputMode !== 'native-media') {
        throw new TypeError('Custom decode audio output mode is invalid');
    }
    if (options.durationMicroseconds != null) {
        requireMicroseconds(options.durationMicroseconds, 'Custom decode duration');
        if (options.durationMicroseconds <= 0) {
            throw new RangeError('Custom decode duration must be positive');
        }
    }
    if (options.audioTrackIndex == null && options.audioOutputMode !== undefined) {
        throw new TypeError('Custom decode cannot select an audio output mode without audio');
    }
    if (options.audioTrackIndex == null) {
        return;
    }
    if (audioOutputMode === 'decoded-pcm' && !decodedAudioAvailable) {
        throw new Error('Custom audio decode requires an AudioWorklet bridge');
    }
    if (audioOutputMode === 'native-media'
        && (!nativeAudioAvailable || options.durationMicroseconds == null)) {
        throw new Error(
            'Native media audio requires an owned backend factory and a finite duration'
        );
    }
}

/** Owns one bounded, generation-safe custom video decode worker session. */
export default class CustomDecodeSession implements DecodedFrameProvider {
    private activeAudioBridge: CustomDecodeAudioBridge | null = null;
    private activeNativeAudioBridge: CustomDecodeNativeAudioBridge | null = null;
    private readonly audioBridgeFactory: CustomDecodeAudioBridgeFactory | null;
    private readonly configuredAudioBridge: CustomDecodeAudioBridge | null;
    private readonly eventHandler: CustomDecodeSessionEventHandler;
    private readonly nativeAudioBridgeFactory: CustomDecodeNativeAudioBridgeFactory | null;
    private nativeAudioStopScheduled = false;
    private nativeAudioStopTail: Promise<void> = Promise.resolve();
    private readonly retiringWorkers = new Set<WorkerRecord>();
    private readonly workerFactory: CustomDecodeWorkerFactory;
    private readonly queuedFrames: QueuedFrame[] = [];
    private readonly pendingFrames = new Map<DecodedPresentationFrame, WorkerRecord>();

    private activeWorker: WorkerRecord | null = null;
    private telemetry = createTelemetry();

    public constructor(
        eventHandler: CustomDecodeSessionEventHandler = () => undefined,
        workerFactory: CustomDecodeWorkerFactory = createDefaultWorker,
        audioBridge: CustomDecodeAudioBridge | null = null,
        audioBridgeFactory: CustomDecodeAudioBridgeFactory | null = null,
        nativeAudioBridgeFactory: CustomDecodeNativeAudioBridgeFactory | null = null
    ) {
        if (audioBridge && audioBridgeFactory) {
            throw new TypeError('Provide either a decoded audio bridge or a bridge factory, not both');
        }
        this.audioBridgeFactory = audioBridgeFactory;
        this.configuredAudioBridge = audioBridge;
        this.eventHandler = eventHandler;
        this.nativeAudioBridgeFactory = nativeAudioBridgeFactory;
        this.workerFactory = workerFactory;
    }

    /** Starts a fresh worker and retires any previous generation. */
    public start(options: CustomDecodeSessionStartOptions): void {
        this.validateStartOptions(options);

        const previousWorker = this.activeWorker;
        this.activeWorker = null;
        this.stopActiveAudioPaths(previousWorker?.generation ?? null);
        if (previousWorker) {
            void this.beginWorkerRetirement(previousWorker);
        }
        this.closeQueuedFrames();
        this.clearPendingFrames();

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

        const workerRecord = this.createWorkerRecord(worker, options);
        this.activeWorker = workerRecord;
        worker.addEventListener('message', workerRecord.messageHandler);
        worker.addEventListener('error', workerRecord.errorHandler);

        try {
            const startRequest: DecodeWorkerRequest = {
                audioSampleCredits: 0,
                audioTrackIndex: options.audioTrackIndex ?? null,
                dolbyVisionRPUParserWASMURL: resolveDolbyVisionRPUParserWASMURL(),
                frameCredits: options.videoOutputMode === 'raw-planes' ?
                    MAX_DECODED_RAW_FRAME_CREDITS :
                    MAX_DECODED_FRAME_CREDITS,
                generation: options.generation,
                maximumCodedHeight: options.maximumCodedHeight,
                maximumCodedWidth: options.maximumCodedWidth,
                rawVideoFrameFormat: options.rawVideoFrameFormat,
                startTimeMicroseconds: options.startTimeMicroseconds,
                type: 'start',
                url: options.url,
                videoDecoderBackend: options.videoDecoderBackend,
                videoOutputMode: options.videoOutputMode,
                videoTrackIndex: options.videoTrackIndex
            };
            if (workerRecord.audioOutputMode === 'native-media') {
                startRequest.audioOutputMode = 'native-media';
            }
            this.postRequest(workerRecord, startRequest);
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
        this.stopActiveAudioPaths(workerRecord?.generation ?? null);
        this.closeQueuedFrames();
        this.clearPendingFrames();
        this.telemetry.activeGeneration = null;
        this.telemetry.state = 'idle';

        if (workerRecord) {
            void this.beginWorkerRetirement(workerRecord);
        }

        const retirementPromises: Promise<void>[] = [];
        if (this.nativeAudioStopScheduled) {
            retirementPromises.push(this.nativeAudioStopTail);
        }
        for (const retiringWorker of this.retiringWorkers) {
            retirementPromises.push(this.beginWorkerRetirement(retiringWorker));
        }
        switch (retirementPromises.length) {
            case 0:
                return Promise.resolve();
            case 1:
                return retirementPromises[0];
            default:
                return Promise.all(retirementPromises).then((): void => undefined);
        }
    }

    /** Returns a snapshot of custom decode state and queue accounting. */
    public getTelemetry(): CustomDecodeSessionTelemetry {
        return {
            ...this.telemetry,
            queuedFrameCount: this.queuedFrames.length
        };
    }

    /** Returns native audio time only after decoded element progress qualified it. */
    public getNativeAudioTimeMicroseconds(): Microseconds | null {
        return this.activeNativeAudioBridge?.getAuthoritativeTimeMicroseconds() ?? null;
    }

    /** Starts or pauses the optional owned native audio element. */
    public async setNativeAudioPlaying(playing: boolean): Promise<void> {
        const nativeAudioBridge = this.activeNativeAudioBridge;
        if (!nativeAudioBridge) {
            return;
        }
        if (!await nativeAudioBridge.setPlaying(playing)) {
            throw new Error('Native media audio generation became stale');
        }
    }

    public setNativeAudioVolume(volume: number): void {
        this.activeNativeAudioBridge?.setVolume(volume);
    }

    public setNativeAudioMuted(muted: boolean): void {
        this.activeNativeAudioBridge?.setMuted(muted);
    }

    /** Transfers the newest decoded frame at or before the HTML clock time. */
    public takeFrame(targetTimeMicroseconds: Microseconds): DecodedPresentationFrame | null {
        requireMicroseconds(targetTimeMicroseconds, 'Presentation target time');

        let selectedFrameIndex = -1;
        for (let frameIndex = 0; frameIndex < this.queuedFrames.length; frameIndex += 1) {
            if (this.queuedFrames[frameIndex].presentationFrame.mediaTimeMicroseconds
                > targetTimeMicroseconds) {
                break;
            }
            selectedFrameIndex = frameIndex;
        }

        if (selectedFrameIndex < 0) {
            return null;
        }

        const consumedFrames = this.queuedFrames.splice(0, selectedFrameIndex + 1);
        const selectedQueuedFrame = consumedFrames.pop();
        if (!selectedQueuedFrame) {
            return null;
        }
        this.telemetry.queuedFrameCount = this.queuedFrames.length;
        this.telemetry.droppedFrameCount += consumedFrames.length;
        for (let frameIndex = 0; frameIndex < consumedFrames.length; frameIndex += 1) {
            const droppedFrame = consumedFrames[frameIndex];
            if (droppedFrame.presentationFrame.outputMode === 'video-frame') {
                closePresentationFrame(droppedFrame.presentationFrame);
                continue;
            }
            if (!this.recycleFrameBuffer(
                droppedFrame.workerRecord,
                droppedFrame.presentationFrame.frame.data
            )) {
                this.abandonPresentationFrame(droppedFrame.presentationFrame);
                for (
                    let abandonedFrameIndex = frameIndex + 1;
                    abandonedFrameIndex < consumedFrames.length;
                    abandonedFrameIndex += 1
                ) {
                    this.abandonPresentationFrame(
                        consumedFrames[abandonedFrameIndex].presentationFrame
                    );
                }
                this.abandonPresentationFrame(selectedQueuedFrame.presentationFrame);
                return null;
            }
        }

        this.telemetry.takenFrameCount += 1;
        this.pendingFrames.set(
            selectedQueuedFrame.presentationFrame,
            selectedQueuedFrame.workerRecord
        );
        this.telemetry.pendingFrameCount = this.pendingFrames.size;
        if (selectedQueuedFrame.presentationFrame.outputMode === 'video-frame') {
            this.requestReplacementFrames(
                selectedQueuedFrame.workerRecord,
                consumedFrames.length
            );
        }

        return selectedQueuedFrame.presentationFrame;
    }

    /** Releases one selected frame credit after successful GPU submission. */
    public acknowledgeFrame(presentationFrame: DecodedPresentationFrame): boolean {
        return this.releasePendingFrame(presentationFrame);
    }

    /** Releases one selected frame credit after the presentation owner discards it. */
    public discardFrame(presentationFrame: DecodedPresentationFrame): boolean {
        return this.releasePendingFrame(presentationFrame);
    }

    private validateStartOptions(options: CustomDecodeSessionStartOptions): void {
        if (!isValidGeneration(options.generation)) {
            throw new RangeError('Custom decode generation must be a positive safe integer');
        }
        requireMicroseconds(options.startTimeMicroseconds, 'Custom decode start time');
        if (typeof options.url !== 'string' || !options.url) {
            throw new TypeError('Custom decode URL must be a non-empty string');
        }
        if (
            !isValidCodedDimension(
                options.maximumCodedWidth,
                MAXIMUM_RAW_VIDEO_CODED_WIDTH
            )
            || !isValidCodedDimension(
                options.maximumCodedHeight,
                MAXIMUM_RAW_VIDEO_CODED_HEIGHT
            )
        ) {
            throw new RangeError('Custom decode coded dimensions exceed the absolute route bound');
        }
        if (!isValidTrackIndex(options.videoTrackIndex)) {
            throw new RangeError('Custom decode video track index must be a non-negative safe integer');
        }
        validateAudioStartOptions(
            options,
            Boolean(this.configuredAudioBridge || this.audioBridgeFactory),
            this.nativeAudioBridgeFactory !== null
        );
        if (!isValidVideoOutputMode(options.videoOutputMode)) {
            throw new TypeError('Custom decode video output mode is invalid');
        }
        if (!isValidVideoDecoderBackend(options.videoDecoderBackend)) {
            throw new TypeError('Custom decode video decoder backend is invalid');
        }
        if (!hasValidRawVideoFrameFormat(options)) {
            const message = options.videoOutputMode === 'raw-planes' ?
                'Raw custom decode requires a requested raw frame format' :
                'VideoFrame custom decode cannot request a raw frame format';
            throw new TypeError(message);
        }
    }

    private createWorkerRecord(
        worker: Worker,
        options: CustomDecodeSessionStartOptions
    ): WorkerRecord {
        const workerRecord: WorkerRecord = {
            audioConfiguration: null,
            audioMediaReady: false,
            audioOutputMode: options.audioOutputMode ?? 'decoded-pcm',
            audioRequested: options.audioTrackIndex != null,
            configurationReceived: false,
            decodedVideoGeometry: null,
            errorHandler: (): void => undefined,
            generation: options.generation,
            maximumCodedHeight: options.maximumCodedHeight,
            maximumCodedWidth: options.maximumCodedWidth,
            messageHandler: (): void => undefined,
            nativeAudioElementEnded: false,
            nativeAudioEndOfStreamAccepted: false,
            resolveRetirement: null,
            retirementPromise: null,
            retirementTimer: null,
            startTimeMicroseconds: options.startTimeMicroseconds,
            durationMicroseconds: options.durationMicroseconds ?? null,
            videoCodec: null,
            videoGeometry: null,
            videoMediaReady: false,
            videoOutputMode: options.videoOutputMode,
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
                this.stopActiveAudioPaths(workerRecord.generation);
                this.closeQueuedFrames();
                this.clearPendingFrames();
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
                if (messageValue.outputMode === 'video-frame') {
                    messageValue.frame.close();
                } else {
                    this.telemetry.abandonedRawFrameCount += 1;
                }
                this.telemetry.staleFrameCount += 1;
            } else if (messageValue.type === 'audio'
                || messageValue.type === 'native-audio-init'
                || messageValue.type === 'native-audio-media') {
                this.telemetry.staleAudioSampleCount += 1;
            }
            return;
        }

        switch (messageValue.type) {
            case 'ready':
                this.handleReadyResponse(workerRecord, messageValue);
                break;
            case 'frame':
                this.enqueueFrame(workerRecord, messageValue);
                break;
            case 'audio':
                this.enqueueAudioSample(workerRecord, messageValue);
                break;
            case 'native-audio-init':
                this.enqueueNativeAudioInitialization(workerRecord, messageValue);
                break;
            case 'native-audio-media':
                this.enqueueNativeAudioMedia(workerRecord, messageValue);
                break;
            case 'ended':
                this.handleWorkerEnded(workerRecord);
                break;
            case 'error':
                this.activeWorker = null;
                this.stopActiveAudioPaths(workerRecord.generation);
                this.closeQueuedFrames();
                this.clearPendingFrames();
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
        message: DecodeWorkerReadyResponse
    ): void {
        if (workerRecord.configurationReceived || this.telemetry.state !== 'starting') {
            this.handleDecodeProtocolFailure(workerRecord, 'The custom decode worker sent duplicate readiness');
            return;
        }
        if (
            message.codedWidth > workerRecord.maximumCodedWidth
            || message.codedHeight > workerRecord.maximumCodedHeight
        ) {
            this.handleDecodeProtocolFailure(
                workerRecord,
                'The selected video track exceeds its negotiated decode route'
            );
            return;
        }
        const audioConfiguration = message.audio;
        const videoCodec = message.codec;
        workerRecord.configurationReceived = true;
        workerRecord.audioConfiguration = audioConfiguration;
        workerRecord.videoGeometry = {
            codedHeight: message.codedHeight,
            codedWidth: message.codedWidth,
            displayHeight: message.displayHeight,
            displayWidth: message.displayWidth
        };
        if (workerRecord.audioRequested !== Boolean(audioConfiguration)) {
            this.handleAudioOutputFailure(workerRecord, 'Decoded audio configuration did not match the request');
            return;
        }
        if (audioConfiguration) {
            const responseOutputMode = isNativeMediaAudioConfiguration(audioConfiguration) ?
                'native-media' :
                'decoded-pcm';
            if (responseOutputMode !== workerRecord.audioOutputMode) {
                this.handleAudioOutputFailure(
                    workerRecord,
                    'Decoded audio output mode did not match the request'
                );
                return;
            }
        }

        workerRecord.videoCodec = videoCodec;
        workerRecord.audioMediaReady = audioConfiguration === null;
        this.telemetry.state = 'configured';
        this.emitEvent({
            audio: audioConfiguration,
            codec: videoCodec,
            generation: workerRecord.generation,
            type: 'configured'
        });

        if (!audioConfiguration) {
            this.completeReady(workerRecord, videoCodec, null, null);
            return;
        }

        if (isNativeMediaAudioConfiguration(audioConfiguration)) {
            this.completeNativeAudioReady(workerRecord, audioConfiguration);
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

    private completeNativeAudioReady(
        workerRecord: WorkerRecord,
        audioConfiguration: DecodeWorkerNativeMediaAudioConfiguration
    ): void {
        void this.startNativeAudioBridge(workerRecord, audioConfiguration);
    }

    private async startNativeAudioBridge(
        workerRecord: WorkerRecord,
        audioConfiguration: DecodeWorkerNativeMediaAudioConfiguration
    ): Promise<void> {
        const bridgeFactory = this.nativeAudioBridgeFactory;
        const durationMicroseconds = workerRecord.durationMicroseconds;
        if (!bridgeFactory || durationMicroseconds === null) {
            this.handleAudioOutputFailure(workerRecord, 'Native media audio has no configured output');
            return;
        }

        try {
            await this.nativeAudioStopTail;
        } catch {
            if (this.isWorkerCurrent(workerRecord)) {
                this.handleAudioOutputFailure(
                    workerRecord,
                    'Unable to retire the previous native media audio output'
                );
            }
            return;
        }
        if (!this.isWorkerCurrent(workerRecord)) {
            return;
        }

        let nativeAudioBridge: CustomDecodeNativeAudioBridge;
        try {
            nativeAudioBridge = bridgeFactory();
        } catch {
            this.handleAudioOutputFailure(workerRecord, 'Unable to create native media audio output');
            return;
        }
        this.activeNativeAudioBridge = nativeAudioBridge;
        try {
            const started = await nativeAudioBridge.start({
                audioConfiguration,
                callbacks: {
                    onClockReady: generation => {
                        if (this.isWorkerCurrent(workerRecord)
                            && this.activeNativeAudioBridge === nativeAudioBridge
                            && generation === workerRecord.generation) {
                            this.telemetry.nativeAudioClockReady = true;
                        }
                    },
                    onCreditsReleased: audioSegmentCredits => {
                        this.requestReplacementAudioSamples(workerRecord, audioSegmentCredits);
                    },
                    onFailure: message => {
                        this.handleAudioOutputFailure(workerRecord, message);
                    },
                    onEvent: event => {
                        if (event.type === 'ended'
                            && this.isWorkerCurrent(workerRecord)
                            && this.activeNativeAudioBridge === nativeAudioBridge
                            && event.generation === workerRecord.generation) {
                            workerRecord.nativeAudioElementEnded = true;
                            this.completeNativeAudioWorkerEndedIfReady(workerRecord);
                        }
                    }
                },
                durationMicroseconds,
                generation: workerRecord.generation,
                startTimeMicroseconds: workerRecord.startTimeMicroseconds
            });
            if (!started
                || !this.isWorkerCurrent(workerRecord)
                || this.activeNativeAudioBridge !== nativeAudioBridge) {
                return;
            }
            this.requestReplacementAudioSamples(
                workerRecord,
                nativeAudioBridge.initialAudioSegmentCredits
            );
        } catch {
            if (this.isWorkerCurrent(workerRecord)
                && this.activeNativeAudioBridge === nativeAudioBridge) {
                this.handleAudioOutputFailure(
                    workerRecord,
                    'Unable to initialize native media audio output'
                );
            }
        }
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

        this.emitReadyEventIfMediaReady(workerRecord);
    }

    private emitReadyEventIfMediaReady(workerRecord: WorkerRecord): void {
        const videoCodec = workerRecord.videoCodec;
        if (
            !this.isWorkerCurrent(workerRecord)
            || this.telemetry.state !== 'configured'
            || !workerRecord.configurationReceived
            || !workerRecord.audioMediaReady
            || !workerRecord.videoMediaReady
            || !videoCodec
        ) {
            return;
        }

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

    private stopActiveAudioPaths(generation: number | null): void {
        this.activeAudioBridge?.stop(generation);
        this.activeAudioBridge = null;
        if (this.activeNativeAudioBridge) {
            const nativeAudioBridge = this.activeNativeAudioBridge;
            const stopPromise = generation === null ?
                nativeAudioBridge.stop() :
                nativeAudioBridge.stop(generation);
            this.nativeAudioStopScheduled = true;
            this.nativeAudioStopTail = Promise.all([
                this.nativeAudioStopTail,
                stopPromise
            ]).then((): void => undefined);
            void this.nativeAudioStopTail.catch((): void => undefined);
            this.activeNativeAudioBridge = null;
        }
    }

    private handleDecodeProtocolFailure(workerRecord: WorkerRecord, message: string): void {
        if (!this.isWorkerCurrent(workerRecord)) {
            return;
        }

        this.activeWorker = null;
        this.stopActiveAudioPaths(workerRecord.generation);
        this.closeQueuedFrames();
        this.clearPendingFrames();
        void this.beginWorkerRetirement(workerRecord);
        this.failSession(workerRecord.generation, 'decode-failed', message);
    }

    private enqueueFrame(workerRecord: WorkerRecord, message: DecodeWorkerFrameResponse): void {
        if (!this.validateRawFrameGeometry(workerRecord, message)) {
            return;
        }
        const maximumQueuedFrames = workerRecord.videoOutputMode === 'raw-planes' ?
            MAX_DECODED_RAW_FRAME_CREDITS :
            MAX_DECODED_FRAME_CREDITS;
        const boundedFrameCount = workerRecord.videoOutputMode === 'raw-planes' ?
            this.queuedFrames.length + this.pendingFrames.size :
            this.queuedFrames.length;
        if (
            message.outputMode !== workerRecord.videoOutputMode
            || boundedFrameCount >= maximumQueuedFrames
        ) {
            if (message.outputMode === 'video-frame') {
                message.frame.close();
            } else {
                this.telemetry.abandonedRawFrameCount += 1;
            }
            this.activeWorker = null;
            this.stopActiveAudioPaths(workerRecord.generation);
            this.closeQueuedFrames();
            this.clearPendingFrames();
            void this.beginWorkerRetirement(workerRecord);
            const messageText = message.outputMode === workerRecord.videoOutputMode ?
                'The custom decode frame queue exceeded its bound' :
                'The custom decode worker returned an unexpected video output mode';
            this.failSession(workerRecord.generation, 'decode-failed', messageText);
            return;
        }

        const presentationFrame: DecodedPresentationFrame = {
            durationMicroseconds: message.durationMicroseconds,
            encodedDolbyVisionMetadata: message.encodedDolbyVisionMetadata,
            frame: message.frame,
            mediaTimeMicroseconds: message.mediaTimeMicroseconds,
            outputMode: message.outputMode
        } as DecodedPresentationFrame;
        const queuedFrame: QueuedFrame = {
            presentationFrame,
            workerRecord
        };
        let insertionIndex = this.queuedFrames.length;
        while (
            insertionIndex > 0
            && this.queuedFrames[insertionIndex - 1].presentationFrame.mediaTimeMicroseconds
                > presentationFrame.mediaTimeMicroseconds
        ) {
            insertionIndex -= 1;
        }
        this.queuedFrames.splice(insertionIndex, 0, queuedFrame);

        workerRecord.videoMediaReady = true;
        this.telemetry.firstFrameMediaTimeMicroseconds ??= presentationFrame.mediaTimeMicroseconds;
        this.telemetry.lastFrameMediaTimeMicroseconds = presentationFrame.mediaTimeMicroseconds;
        this.telemetry.queuedFrameCount = this.queuedFrames.length;
        this.telemetry.peakFrameCount = Math.max(
            this.telemetry.peakFrameCount,
            this.queuedFrames.length + this.pendingFrames.size
        );
        this.telemetry.receivedFrameCount += 1;
        this.recordDolbyVisionMetadata(message);
        this.emitReadyEventIfMediaReady(workerRecord);
    }

    private recordDolbyVisionMetadata(message: DecodeWorkerFrameResponse): void {
        const metadata = message.encodedDolbyVisionMetadata;
        if (!metadata) {
            return;
        }

        this.telemetry.receivedDolbyVisionFrameCount += 1;
        this.telemetry.receivedDolbyVisionRPUCount += metadata.parsedRPUData.length;
        if (metadata.enhancementLayerData) {
            this.telemetry.receivedDolbyVisionEnhancementFrameCount += 1;
        }
    }

    private validateRawFrameGeometry(
        workerRecord: WorkerRecord,
        message: DecodeWorkerFrameResponse
    ): boolean {
        if (message.outputMode !== 'raw-planes') {
            return true;
        }
        const videoGeometry = workerRecord.videoGeometry;
        if (!videoGeometry) {
            this.telemetry.abandonedRawFrameCount += 1;
            this.handleDecodeProtocolFailure(
                workerRecord,
                'Decoded raw frame arrived before video track configuration'
            );
            return false;
        }
        try {
            workerRecord.decodedVideoGeometry = requireConsistentDecodedVideoGeometry(
                {
                    codedHeight: message.frame.codedHeight,
                    codedWidth: message.frame.codedWidth,
                    displayHeight: message.frame.displayHeight,
                    displayWidth: message.frame.displayWidth
                },
                videoGeometry,
                workerRecord.maximumCodedWidth,
                workerRecord.maximumCodedHeight,
                workerRecord.decodedVideoGeometry
            );
            return true;
        } catch (error) {
            this.telemetry.abandonedRawFrameCount += 1;
            const messageText = error instanceof DecodedVideoGeometryError ?
                error.message :
                'Decoded raw frame geometry is invalid';
            this.handleDecodeProtocolFailure(workerRecord, messageText);
            return false;
        }
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
                workerRecord.audioMediaReady = true;
                this.emitReadyEventIfMediaReady(workerRecord);
                break;
            case 'stale-generation':
                this.telemetry.staleAudioSampleCount += 1;
                if (this.activeWorker === workerRecord) {
                    this.handleAudioOutputFailure(workerRecord, 'Decoded audio output generation became stale');
                }
                break;
            case 'controller-rejected':
            case 'output-capacity':
            case 'timestamp-discontinuity':
                // The bridge synchronously reports these failures through its callback
                break;
        }
    }

    private enqueueNativeAudioInitialization(
        workerRecord: WorkerRecord,
        message: DecodeWorkerNativeAudioInitializationResponse
    ): void {
        const nativeAudioBridge = this.activeNativeAudioBridge;
        if (workerRecord.audioOutputMode !== 'native-media' || !nativeAudioBridge) {
            this.handleDecodeProtocolFailure(
                workerRecord,
                'The custom decode worker returned unexpected native audio initialization'
            );
            return;
        }
        void nativeAudioBridge.enqueueInitialization(message);
    }

    private enqueueNativeAudioMedia(
        workerRecord: WorkerRecord,
        message: DecodeWorkerNativeAudioMediaResponse
    ): void {
        const nativeAudioBridge = this.activeNativeAudioBridge;
        if (workerRecord.audioOutputMode !== 'native-media' || !nativeAudioBridge) {
            this.handleDecodeProtocolFailure(
                workerRecord,
                'The custom decode worker returned unexpected native audio media'
            );
            return;
        }
        this.telemetry.lastAudioMediaTimeMicroseconds = message.startTimeMicroseconds;
        this.telemetry.receivedAudioSampleCount += 1;
        this.telemetry.receivedNativeAudioSegmentCount += 1;
        void nativeAudioBridge.enqueueMedia(message).then(appended => {
            if (appended
                && this.isWorkerCurrent(workerRecord)
                && this.activeNativeAudioBridge === nativeAudioBridge) {
                workerRecord.audioMediaReady = true;
                this.emitReadyEventIfMediaReady(workerRecord);
            }
        });
    }

    private handleWorkerEnded(workerRecord: WorkerRecord): void {
        const nativeAudioBridge = this.activeNativeAudioBridge;
        if (workerRecord.audioOutputMode !== 'native-media' || !workerRecord.audioRequested) {
            this.completeWorkerEnded(workerRecord);
            return;
        }
        if (!nativeAudioBridge) {
            this.handleAudioOutputFailure(
                workerRecord,
                'Native audio output ended without an active backend'
            );
            return;
        }
        void nativeAudioBridge.endOfStream(workerRecord.generation).then(ended => {
            if (ended && this.isWorkerCurrent(workerRecord)) {
                workerRecord.nativeAudioEndOfStreamAccepted = true;
                this.completeNativeAudioWorkerEndedIfReady(workerRecord);
            } else if (this.isWorkerCurrent(workerRecord)) {
                this.handleAudioOutputFailure(
                    workerRecord,
                    'Native audio output rejected end of stream'
                );
            }
        });
    }

    private completeNativeAudioWorkerEndedIfReady(workerRecord: WorkerRecord): void {
        if (!workerRecord.nativeAudioElementEnded
            || !workerRecord.nativeAudioEndOfStreamAccepted) {
            return;
        }
        this.completeWorkerEnded(workerRecord);
    }

    private completeWorkerEnded(workerRecord: WorkerRecord): void {
        if (!this.isWorkerCurrent(workerRecord) || this.telemetry.state === 'ended') {
            return;
        }
        this.telemetry.state = 'ended';
        this.emitEvent({ generation: workerRecord.generation, type: 'ended' });
    }

    private requestReplacementFrames(
        workerRecord: WorkerRecord,
        frameCredits: number
    ): void {
        if (!this.isWorkerCurrent(workerRecord) || frameCredits <= 0) {
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
            this.stopActiveAudioPaths(workerRecord.generation);
            this.closeQueuedFrames();
            this.clearPendingFrames();
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
        this.stopActiveAudioPaths(workerRecord.generation);
        this.closeQueuedFrames();
        this.clearPendingFrames();
        void this.beginWorkerRetirement(workerRecord);
        this.failSession(workerRecord.generation, 'audio-output-failed', message);
    }

    private handleWorkerCrash(workerRecord: WorkerRecord): void {
        if (this.activeWorker === workerRecord) {
            this.activeWorker = null;
            this.stopActiveAudioPaths(workerRecord.generation);
            this.closeQueuedFrames();
            this.clearPendingFrames();
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

    private postRequest(
        workerRecord: WorkerRecord,
        request: DecodeWorkerRequest,
        transfer?: Transferable[]
    ): void {
        workerRecord.worker.postMessage(request, transfer ?? []);
    }

    private abandonPresentationFrame(presentationFrame: DecodedPresentationFrame): void {
        if (presentationFrame.outputMode === 'raw-planes') {
            this.telemetry.abandonedRawFrameCount += 1;
            return;
        }

        closePresentationFrame(presentationFrame);
    }

    private closeQueuedFrames(): void {
        for (const queuedFrame of this.queuedFrames) {
            this.abandonPresentationFrame(queuedFrame.presentationFrame);
        }
        this.queuedFrames.length = 0;
        this.telemetry.queuedFrameCount = 0;
    }

    private clearPendingFrames(): void {
        for (const presentationFrame of this.pendingFrames.keys()) {
            this.abandonPresentationFrame(presentationFrame);
        }
        this.pendingFrames.clear();
        this.telemetry.pendingFrameCount = 0;
    }

    private releasePendingFrame(presentationFrame: DecodedPresentationFrame): boolean {
        const workerRecord = this.pendingFrames.get(presentationFrame);
        if (!workerRecord) {
            return false;
        }

        this.pendingFrames.delete(presentationFrame);
        this.telemetry.pendingFrameCount = this.pendingFrames.size;
        if (presentationFrame.outputMode === 'raw-planes') {
            if (!this.recycleFrameBuffer(workerRecord, presentationFrame.frame.data)) {
                this.abandonPresentationFrame(presentationFrame);
            }
        } else {
            this.requestReplacementFrames(workerRecord, 1);
        }
        return true;
    }

    private recycleFrameBuffer(workerRecord: WorkerRecord, buffer: ArrayBuffer): boolean {
        if (!this.isWorkerCurrent(workerRecord)) {
            return false;
        }

        try {
            this.postRequest(workerRecord, {
                buffer,
                generation: workerRecord.generation,
                type: 'recycle-frame'
            }, [ buffer ]);
            this.telemetry.recycledRawFrameCount += 1;
            return true;
        } catch {
            this.activeWorker = null;
            this.stopActiveAudioPaths(workerRecord.generation);
            this.closeQueuedFrames();
            this.clearPendingFrames();
            this.failSession(
                workerRecord.generation,
                'decode-failed',
                'Unable to recycle the decoded raw frame buffer'
            );
            this.finishWorker(workerRecord);
            return false;
        }
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
            console.warn(
                `Custom decode worker generation ${workerRecord.generation} did not acknowledge shutdown`
            );
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
