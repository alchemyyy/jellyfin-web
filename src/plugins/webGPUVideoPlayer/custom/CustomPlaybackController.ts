import {
    microsecondsToMilliseconds,
    millisecondsToMicroseconds,
    type Microseconds
} from '../MediaTime';
import type {
    DecodedFrameProvider,
    DecodedPresentationFrame
} from '../WebGPUPresenter';
import AudioWorkletController from './AudioWorkletController';
import type { AudioWorkletTelemetry } from './AudioWorkletProtocol';
import CustomDecodeAudioBridge from './CustomDecodeAudioBridge';
import CustomDecodeSession, {
    type CustomDecodeAudioBridgeFactory,
    type CustomDecodeSessionEvent
} from './CustomDecodeSession';
import type { DecodeWorkerAudioConfiguration } from './DecodeWorkerProtocol';
import MediaClock from './MediaClock';
import { addMicroseconds, requireMicroseconds } from './TimeMath';
import type {
    CustomAudioOutput,
    CustomAudioOutputBinding,
    CustomAudioOutputFactory,
    CustomPlaybackControllerEvent,
    CustomPlaybackControllerEventHandler,
    CustomPlaybackControllerOptions,
    CustomPlaybackFallbackReason,
    CustomPlaybackFallbackRequest,
    CustomPlaybackHTMLFallbackHook,
    CustomPlaybackClock,
    CustomPlaybackPlayOptions,
    CustomPlaybackStartResult,
    CustomPlaybackState,
    CustomPlaybackTelemetry,
    CustomVideoDecodeSession,
    CustomVideoDecodeSessionFactory
} from './CustomPlaybackControllerTypes';

export const DEFAULT_CUSTOM_PLAYBACK_STARTUP_TIMEOUT_MICROSECONDS =
    millisecondsToMicroseconds(8_000);
export const DEFAULT_CUSTOM_PLAYBACK_STOP_TIMEOUT_MICROSECONDS =
    millisecondsToMicroseconds(1_500);
export const DEFAULT_CUSTOM_PLAYBACK_TIME_UPDATE_INTERVAL_MICROSECONDS =
    millisecondsToMicroseconds(250);

type PendingStartup = {
    completing: boolean
    desiredPlaying: boolean
    generation: number
    phase: 'seeking' | 'starting'
    promise: Promise<CustomPlaybackStartResult>
    resolve: (result: CustomPlaybackStartResult) => void
    settled: boolean
    startedAtMicroseconds: Microseconds
    timer: ReturnType<typeof globalThis.setTimeout>
    videoReady: boolean
};

type ClockStarvation = 'audio' | 'video';

const MAXIMUM_CONTROLLER_TIMEOUT_MICROSECONDS = millisecondsToMicroseconds(60_000);
const ZERO_MICROSECONDS = millisecondsToMicroseconds(0);

function createVideoDecodeSession(
    eventHandler: (event: CustomDecodeSessionEvent) => void,
    audioBridgeFactory: CustomDecodeAudioBridgeFactory | null
): CustomVideoDecodeSession {
    return new CustomDecodeSession(eventHandler, undefined, null, audioBridgeFactory);
}

function createNoopEventHandler(): CustomPlaybackControllerEventHandler {
    return (): void => undefined;
}

function createNoopFallbackHook(): CustomPlaybackHTMLFallbackHook {
    return (): void => undefined;
}

function defaultMonotonicTimeSource(): Microseconds {
    return millisecondsToMicroseconds(performance.now());
}

function requirePositiveTimeout(value: Microseconds, label: string): Microseconds {
    requireMicroseconds(value, label);
    if (value <= 0 || value > MAXIMUM_CONTROLLER_TIMEOUT_MICROSECONDS) {
        throw new RangeError(`${label} must be from 1 through 60000000 microseconds`);
    }
    return value;
}

function validateTrackIndex(trackIndex: number, label: string): void {
    if (!Number.isSafeInteger(trackIndex) || trackIndex < 0) {
        throw new RangeError(`${label} must be a non-negative safe integer`);
    }
}

function validatePlayOptions(options: CustomPlaybackPlayOptions): void {
    requireMicroseconds(options.startTimeMicroseconds, 'Playback start time');
    if (options.durationMicroseconds !== null) {
        requireMicroseconds(options.durationMicroseconds, 'Playback duration');
        if (options.durationMicroseconds < 0) {
            throw new RangeError('Playback duration cannot be negative');
        }
    }
    if (typeof options.url !== 'string' || options.url.length === 0) {
        throw new TypeError('Custom playback URL must be a non-empty string');
    }
    validateTrackIndex(options.videoTrackIndex, 'Video track index');
    if (options.audioTrackIndex !== null) {
        validateTrackIndex(options.audioTrackIndex, 'Audio track index');
    }
}

function copyPlayOptions(options: CustomPlaybackPlayOptions): CustomPlaybackPlayOptions {
    return {
        audioTrackIndex: options.audioTrackIndex,
        durationMicroseconds: options.durationMicroseconds,
        startTimeMicroseconds: options.startTimeMicroseconds,
        url: options.url,
        videoTrackIndex: options.videoTrackIndex
    };
}

function hasSameAudioLayout(
    left: DecodeWorkerAudioConfiguration,
    right: DecodeWorkerAudioConfiguration
): boolean {
    return left.channelCount === right.channelCount
        && left.sampleRate === right.sampleRate;
}

function createDefaultAudioOutputFactory(
    options: CustomPlaybackControllerOptions
): CustomAudioOutputFactory | null {
    if (options.audioOutputFactory) {
        return options.audioOutputFactory;
    }
    if (!options.audioContext && !options.audioWorkletOptions) {
        return null;
    }
    if (!options.audioContext || !options.audioWorkletOptions) {
        throw new TypeError('AudioContext and AudioWorklet options must be provided together');
    }

    const audioContext = options.audioContext;
    const audioWorkletOptions = { ...options.audioWorkletOptions };
    return async (
        configuration: DecodeWorkerAudioConfiguration
    ): Promise<CustomAudioOutputBinding> => {
        if (audioContext.sampleRate !== configuration.sampleRate) {
            throw new RangeError('Decoded audio sample rate does not match the AudioContext');
        }
        const output = await AudioWorkletController.create(audioContext, {
            ...audioWorkletOptions,
            channelCount: configuration.channelCount
        });
        return {
            bridge: new CustomDecodeAudioBridge(output),
            configuration: { ...configuration },
            output
        };
    };
}

/** Owns a custom decode, audio-output, and media-clock playback lifecycle. */
export default class CustomPlaybackController implements DecodedFrameProvider {
    private activeGeneration: number | null = null;
    private audioBinding: CustomAudioOutputBinding | null = null;
    private audioOutput: CustomAudioOutput | null = null;
    private readonly audioOutputFactory: CustomAudioOutputFactory | null;
    private audioOutputPromise: Promise<CustomAudioOutputBinding> | null = null;
    private audioOutputPromiseConfiguration: DecodeWorkerAudioConfiguration | null = null;
    private audioPath: CustomPlaybackTelemetry['audioPath'] = 'disabled';
    private audioTelemetryUnsubscribe: (() => void) | null = null;
    private readonly clock: CustomPlaybackClock;
    private clockStarvation: ClockStarvation | null = null;
    private currentGeneration = 0;
    private currentSource: CustomPlaybackPlayOptions | null = null;
    private destroyed = false;
    private destroyPromise: Promise<void> | null = null;
    private readonly eventHandler: CustomPlaybackControllerEventHandler;
    private fallbackCount = 0;
    private fallbackGeneration: number | null = null;
    private fallbackReason: CustomPlaybackFallbackReason | null = null;
    private readonly fallbackHook: CustomPlaybackHTMLFallbackHook;
    private lastErrorMessage: string | null = null;
    private lastTimeUpdateMonotonicMicroseconds: Microseconds | null = null;
    private readonly monotonicTimeSource: () => Microseconds;
    private muted = false;
    private pendingEndedGeneration: number | null = null;
    private readonly pendingPresentationFrames = new Set<DecodedPresentationFrame>();
    private pendingStartup: PendingStartup | null = null;
    private readonly pipelineStopTimeoutMicroseconds: Microseconds;
    private playCount = 0;
    private readonly startupTimeoutMicroseconds: Microseconds;
    private startupDurationMicroseconds: Microseconds | null = null;
    private staleEventCount = 0;
    private state: CustomPlaybackState = 'idle';
    private stopPromise: Promise<void> | null = null;
    private readonly videoDecodeSession: CustomVideoDecodeSession;
    private readonly timeUpdateIntervalMicroseconds: Microseconds;
    private volume = 1;
    private waitingForVideoFrame = false;
    private videoStarvationAnchorMediaTimeMicroseconds: Microseconds | null = null;
    private videoStarvationAnchorMonotonicTimeMicroseconds: Microseconds | null = null;

    public constructor(options: CustomPlaybackControllerOptions = {}) {
        this.eventHandler = options.eventHandler ?? createNoopEventHandler();
        this.fallbackHook = options.fallbackHook ?? createNoopFallbackHook();
        this.monotonicTimeSource = options.monotonicTimeSource ?? defaultMonotonicTimeSource;
        this.clock = options.clock ?? new MediaClock(this.monotonicTimeSource);
        this.pipelineStopTimeoutMicroseconds = requirePositiveTimeout(
            options.pipelineStopTimeoutMicroseconds
                ?? DEFAULT_CUSTOM_PLAYBACK_STOP_TIMEOUT_MICROSECONDS,
            'Pipeline stop timeout'
        );
        this.startupTimeoutMicroseconds = requirePositiveTimeout(
            options.startupTimeoutMicroseconds
                ?? DEFAULT_CUSTOM_PLAYBACK_STARTUP_TIMEOUT_MICROSECONDS,
            'Playback startup timeout'
        );
        this.timeUpdateIntervalMicroseconds = requirePositiveTimeout(
            options.timeUpdateIntervalMicroseconds
                ?? DEFAULT_CUSTOM_PLAYBACK_TIME_UPDATE_INTERVAL_MICROSECONDS,
            'Time update interval'
        );
        this.audioOutputFactory = createDefaultAudioOutputFactory(options);
        const videoDecodeSessionFactory: CustomVideoDecodeSessionFactory =
            options.videoDecodeSessionFactory ?? createVideoDecodeSession;
        this.videoDecodeSession = videoDecodeSessionFactory(
            this.handleVideoDecodeEvent,
            this.audioOutputFactory ? this.createAudioBridge : null
        );
    }

    public get currentTimeMicroseconds(): Microseconds {
        return this.clock.mediaTimeMicroseconds;
    }

    public get durationMicroseconds(): Microseconds | null {
        return this.currentSource?.durationMicroseconds ?? null;
    }

    public get isMuted(): boolean {
        return this.muted;
    }

    public get audioStreamIndex(): number | null {
        return this.currentSource?.audioTrackIndex ?? null;
    }

    public get playbackRate(): number {
        return this.clock.rate;
    }

    public get playbackState(): CustomPlaybackState {
        return this.state;
    }

    public get playbackVolume(): number {
        return this.volume;
    }

    /** Prepares a source at its start timestamp without advancing its clock. */
    public prepare(options: CustomPlaybackPlayOptions): Promise<CustomPlaybackStartResult> {
        return this.beginPlayback(options, false, 'starting');
    }

    /** Starts a fresh custom source and advances its clock after bounded preparation. */
    public play(options: CustomPlaybackPlayOptions): Promise<CustomPlaybackStartResult> {
        return this.beginPlayback(options, true, 'starting');
    }

    /** Pauses the application-owned clock and PCM output. */
    public pause(): void {
        this.requireUsable();
        if (this.pendingStartup) {
            this.pendingStartup.desiredPlaying = false;
            return;
        }
        if (this.state !== 'playing') {
            return;
        }

        const generation = this.requireActiveGeneration();
        if (!this.clock.isPaused) {
            this.clock.pause();
        }
        if (this.clockStarvation === 'video') {
            this.videoStarvationAnchorMonotonicTimeMicroseconds = null;
        }
        void this.setAudioPlaying(false).catch((error: unknown): void => {
            this.activateFallback(generation, 'audio-output-failed', this.getErrorMessage(error));
        });
        this.setState('paused', generation);
        this.emitTimeUpdate();
    }

    /** Resumes a prepared or paused source without restarting decoders. */
    public resume(): void {
        this.requireUsable();
        if (this.pendingStartup) {
            this.pendingStartup.desiredPlaying = true;
            return;
        }
        if (this.state !== 'paused') {
            return;
        }

        const generation = this.requireActiveGeneration();
        if (this.clockStarvation === 'video') {
            this.videoStarvationAnchorMediaTimeMicroseconds = this.currentTimeMicroseconds;
            this.videoStarvationAnchorMonotonicTimeMicroseconds = this.readMonotonicTime();
        } else if (this.clockStarvation === null) {
            this.clock.resume();
        }
        void this.setAudioPlaying(true).catch((error: unknown): void => {
            this.activateFallback(generation, 'audio-output-failed', this.getErrorMessage(error));
        });
        this.setState('playing', generation);
        if (this.clockStarvation === null) {
            this.emitEvent({ generation, type: 'playing' });
        }
        this.emitTimeUpdate();
    }

    /** Restarts both decode paths at one signed integer-microsecond timestamp. */
    public seek(mediaTimeMicroseconds: Microseconds): Promise<CustomPlaybackStartResult> {
        this.requireUsable();
        requireMicroseconds(mediaTimeMicroseconds, 'Seek time');
        if (!this.currentSource
            || this.state === 'fallback'
            || this.state === 'idle'
            || this.state === 'stopping') {
            throw new Error('Custom playback does not have an active seekable source');
        }

        const desiredPlaying = this.state === 'playing'
            || this.pendingStartup?.desiredPlaying === true;
        const seekOptions: CustomPlaybackPlayOptions = {
            ...this.currentSource,
            startTimeMicroseconds: mediaTimeMicroseconds
        };
        return this.beginPlayback(seekOptions, desiredPlaying, 'seeking');
    }

    /** Stops custom playback and invalidates all decoder callbacks. */
    public stop(): Promise<void> {
        if (this.destroyed) {
            return this.destroyPromise ?? Promise.resolve();
        }
        return this.stopController(false);
    }

    /** Sets normalized output gain without changing mute state. */
    public setVolume(volume: number): void {
        this.requireUsable();
        if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
            throw new RangeError('Custom playback volume must be between zero and one');
        }

        this.volume = volume;
        this.audioOutput?.setVolume(volume);
    }

    public setMuted(muted: boolean): void {
        this.requireUsable();
        this.muted = muted;
        this.audioOutput?.setMuted(muted);
    }

    /** Reports whether client-side audio switching can avoid server renegotiation. */
    public canSetAudioStreamIndex(): boolean {
        return !this.destroyed
            && this.audioOutputFactory !== null;
    }

    /** Restarts decode generations and flushes PCM at the current audio-master time. */
    public setAudioStreamIndex(audioStreamIndex: number): Promise<CustomPlaybackStartResult> {
        this.requireUsable();
        validateTrackIndex(audioStreamIndex, 'Audio stream index');
        if (!this.canSetAudioStreamIndex() || !this.currentSource) {
            throw new Error('Client-side audio stream switching is unavailable');
        }
        if (this.state === 'fallback'
            || this.state === 'idle'
            || this.state === 'stopping') {
            throw new Error('Custom playback does not have an active audio-switchable source');
        }

        const desiredPlaying = this.state === 'playing'
            || this.pendingStartup?.desiredPlaying === true;
        const switchTimeMicroseconds = this.currentTimeMicroseconds;
        const switchOptions: CustomPlaybackPlayOptions = {
            ...this.currentSource,
            audioTrackIndex: audioStreamIndex,
            startTimeMicroseconds: switchTimeMicroseconds
        };
        return this.beginPlayback(switchOptions, desiredPlaying, 'seeking');
    }

    /** Changes clock rate when the active audio adapter can supply rate-adjusted PCM. */
    public setPlaybackRate(playbackRate: number): boolean {
        this.requireUsable();
        if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
            throw new RangeError('Custom playback rate must be finite and greater than zero');
        }

        const generation = this.activeGeneration;
        const hasAudio = typeof this.currentSource?.audioTrackIndex === 'number';
        if (hasAudio && playbackRate !== 1) {
            this.activateFallback(
                generation,
                'playback-rate-unsupported',
                'The custom audio path cannot produce rate-adjusted PCM'
            );
            return false;
        }

        this.clock.setPlaybackRate(playbackRate);
        if (this.clockStarvation === 'video') {
            this.videoStarvationAnchorMediaTimeMicroseconds = this.currentTimeMicroseconds;
            this.videoStarvationAnchorMonotonicTimeMicroseconds = this.readMonotonicTime();
        }
        this.emitTimeUpdate();
        return true;
    }

    /** Supplies the renderer with the newest decoded frame for its target time. */
    public takeFrame(targetTimeMicroseconds: Microseconds): DecodedPresentationFrame | null {
        requireMicroseconds(targetTimeMicroseconds, 'Presentation target time');
        const generation = this.activeGeneration;
        if (generation === null
            || (this.state !== 'playing' && this.state !== 'paused')) {
            return null;
        }

        const presentationFrame = this.videoDecodeSession.takeFrame(targetTimeMicroseconds);
        if (!presentationFrame && this.state === 'playing') {
            this.beginVideoStarvationIfNeeded();
            if (!this.waitingForVideoFrame) {
                this.waitingForVideoFrame = true;
                this.emitEvent({
                    generation,
                    reason: 'video-frame',
                    type: 'waiting'
                });
            }
        } else if (presentationFrame) {
            this.pendingPresentationFrames.add(presentationFrame);
            const recoveredFromStarvation = this.recoverVideoStarvation(presentationFrame);
            if (this.waitingForVideoFrame) {
                this.waitingForVideoFrame = false;
                if (this.state === 'playing' && !recoveredFromStarvation) {
                    this.emitEvent({ generation, type: 'playing' });
                }
            }
        }
        this.emitTimeUpdateIfDue();
        return presentationFrame;
    }

    /** Takes a frame against the controller's application-owned clock. */
    public takeCurrentFrame(): DecodedPresentationFrame | null {
        return this.takeFrame(this.getCurrentPresentationTargetTime());
    }

    /** Acknowledges that a transferred decoded frame reached GPU submission. */
    public notifyFramePresented(presentationFrame: DecodedPresentationFrame): boolean {
        if (!this.pendingPresentationFrames.delete(presentationFrame)) {
            return false;
        }

        const generation = this.activeGeneration;
        if (generation !== null) {
            this.completeEndedPlaybackIfDrained(generation);
        }
        return true;
    }

    /** Emits an integration-facing integer-microsecond timing snapshot. */
    public emitTimeUpdate(): void {
        const generation = this.activeGeneration;
        if (generation === null) {
            return;
        }

        this.lastTimeUpdateMonotonicMicroseconds = this.readMonotonicTime();
        this.emitEvent({
            currentTimeMicroseconds: this.currentTimeMicroseconds,
            durationMicroseconds: this.durationMicroseconds,
            generation,
            type: 'timeupdate'
        });
    }

    /** Returns bounded decoder, audio, clock, and fallback diagnostics. */
    public getTelemetry(): CustomPlaybackTelemetry {
        return {
            activeGeneration: this.activeGeneration,
            audioBridge: this.audioBinding?.bridge.getTelemetry() ?? null,
            audioOutput: this.audioOutput?.getTelemetry() ?? null,
            audioPath: this.audioPath,
            clock: this.clock.snapshot(),
            currentTimeMicroseconds: this.currentTimeMicroseconds,
            durationMicroseconds: this.durationMicroseconds,
            fallbackCount: this.fallbackCount,
            fallbackReason: this.fallbackReason,
            lastErrorMessage: this.lastErrorMessage,
            muted: this.muted,
            playCount: this.playCount,
            staleEventCount: this.staleEventCount,
            startupDurationMicroseconds: this.startupDurationMicroseconds,
            state: this.state,
            videoDecode: this.videoDecodeSession.getTelemetry(),
            volume: this.volume
        };
    }

    /** Stops all pipelines and permanently releases the AudioWorklet output. */
    public destroy(): Promise<void> {
        if (this.destroyPromise) {
            return this.destroyPromise;
        }

        this.destroyed = true;
        this.destroyPromise = this.stopController(true).then(
            (): Promise<void> => this.destroyAudioResources(),
            async (error: unknown): Promise<void> => {
                this.lastErrorMessage = this.getErrorMessage(error);
                await this.destroyAudioResources();
            }
        );
        return this.destroyPromise;
    }

    private beginPlayback(
        options: CustomPlaybackPlayOptions,
        desiredPlaying: boolean,
        phase: PendingStartup['phase']
    ): Promise<CustomPlaybackStartResult> {
        this.requireUsable();
        validatePlayOptions(options);
        const generation = this.advanceGeneration();
        this.supersedePendingStartup();
        this.activeGeneration = generation;
        this.currentSource = copyPlayOptions(options);
        this.fallbackGeneration = null;
        this.fallbackReason = null;
        this.lastErrorMessage = null;
        this.startupDurationMicroseconds = null;
        this.lastTimeUpdateMonotonicMicroseconds = null;
        this.resetDrainAndStarvationState();
        this.playCount += 1;
        this.audioPath = options.audioTrackIndex === null ? 'disabled' : 'pending';
        this.clock.reset(options.startTimeMicroseconds);
        this.setState(phase, generation);
        this.emitEvent({ generation, reason: 'startup', type: 'waiting' });
        this.emitTimeUpdate();

        const pendingStartup = this.createPendingStartup(
            generation,
            desiredPlaying,
            phase
        );
        this.pendingStartup = pendingStartup;
        void this.prepareGeneration(generation, options);
        return pendingStartup.promise;
    }

    private createPendingStartup(
        generation: number,
        desiredPlaying: boolean,
        phase: PendingStartup['phase']
    ): PendingStartup {
        let resolveStartup: (result: CustomPlaybackStartResult) => void = () => {
            throw new Error('Startup promise was not initialized');
        };
        const promise = new Promise<CustomPlaybackStartResult>(resolve => {
            resolveStartup = resolve;
        });
        const timer = globalThis.setTimeout(() => {
            this.activateFallback(
                generation,
                'startup-timeout',
                'Custom playback preparation exceeded its bounded timeout'
            );
        }, microsecondsToMilliseconds(this.startupTimeoutMicroseconds));
        return {
            completing: false,
            desiredPlaying,
            generation,
            phase,
            promise,
            resolve: resolveStartup,
            settled: false,
            startedAtMicroseconds: this.readMonotonicTime(),
            timer,
            videoReady: false
        };
    }

    private async prepareGeneration(
        generation: number,
        options: CustomPlaybackPlayOptions
    ): Promise<void> {
        try {
            await this.setAudioPlaying(false);
        } catch (error) {
            this.activateFallback(
                generation,
                'audio-output-failed',
                this.getErrorMessage(error)
            );
            return;
        }

        try {
            await this.waitBounded(this.stopDecodePipelines(), 'Decoder shutdown timed out');
            if (!this.isGenerationActive(generation)) {
                return;
            }

            if (options.audioTrackIndex !== null) {
                if (!this.audioOutputFactory) {
                    this.activateFallback(
                        generation,
                        'audio-output-unavailable',
                        'No custom PCM output is configured'
                    );
                    return;
                }
            }

            if (!this.isGenerationActive(generation)) {
                return;
            }
            this.videoDecodeSession.start({
                audioTrackIndex: options.audioTrackIndex,
                generation,
                startTimeMicroseconds: options.startTimeMicroseconds,
                url: options.url,
                videoTrackIndex: options.videoTrackIndex
            });
        } catch (error) {
            this.activateFallback(
                generation,
                'lifecycle-failed',
                this.getErrorMessage(error)
            );
        }
    }

    private readonly handleVideoDecodeEvent = (event: CustomDecodeSessionEvent): void => {
        if (!this.isGenerationActive(event.generation)) {
            this.staleEventCount += 1;
            return;
        }

        switch (event.type) {
            case 'ready':
                if (this.pendingStartup?.generation === event.generation) {
                    this.audioPath = event.audio ? 'ready' : 'disabled';
                    this.pendingStartup.videoReady = true;
                    void this.completeStartupIfReady(event.generation);
                }
                break;
            case 'ended':
                if (this.pendingStartup?.generation === event.generation) {
                    this.activateFallback(
                        event.generation,
                        'ended-before-ready',
                        'The video decode stream ended before startup completed'
                    );
                    return;
                }
                if (this.state === 'ended'
                    || this.pendingEndedGeneration === event.generation) {
                    return;
                }
                this.pendingEndedGeneration = event.generation;
                this.completeEndedPlaybackIfDrained(event.generation);
                break;
            case 'error':
                this.activateFallback(
                    event.generation,
                    event.failureKind === 'audio-output-failed' ?
                        'audio-output-failed' :
                        'decode-failed',
                    event.message
                );
                break;
        }
    };

    private async completeStartupIfReady(generation: number): Promise<void> {
        const pendingStartup = this.pendingStartup;
        if (!pendingStartup
            || pendingStartup.generation !== generation
            || !pendingStartup.videoReady
            || pendingStartup.completing) {
            return;
        }

        pendingStartup.completing = true;
        try {
            let appliedPlaying = pendingStartup.desiredPlaying;
            while (true) {
                appliedPlaying = pendingStartup.desiredPlaying;
                await this.setAudioPlaying(appliedPlaying);
                if (!this.isPendingStartupActive(pendingStartup)) {
                    return;
                }
                if (appliedPlaying === pendingStartup.desiredPlaying) {
                    break;
                }
            }

            if (appliedPlaying) {
                this.clock.resume();
                this.setState('playing', generation);
            } else {
                this.setState('paused', generation);
            }
        } catch (error) {
            this.activateFallback(
                generation,
                'audio-output-failed',
                this.getErrorMessage(error)
            );
            return;
        } finally {
            if (this.pendingStartup === pendingStartup) {
                pendingStartup.completing = false;
            }
        }

        if (!this.isPendingStartupActive(pendingStartup)) {
            return;
        }

        this.startupDurationMicroseconds = requireMicroseconds(
            this.readMonotonicTime() - pendingStartup.startedAtMicroseconds,
            'Startup duration'
        );
        this.settlePendingStartup({
            fallbackReason: null,
            generation,
            status: 'started'
        });
        this.emitEvent({
            durationMicroseconds: this.durationMicroseconds,
            generation,
            startupDurationMicroseconds: this.startupDurationMicroseconds,
            type: 'ready'
        });
        if (pendingStartup.desiredPlaying) {
            this.emitEvent({ generation, type: 'playing' });
        }
        this.emitTimeUpdate();
    }

    private finishEndedPlayback(generation: number): void {
        if (!this.isGenerationActive(generation)
            || this.pendingEndedGeneration !== generation) {
            return;
        }

        this.pendingEndedGeneration = null;
        this.clockStarvation = null;
        this.videoStarvationAnchorMediaTimeMicroseconds = null;
        this.videoStarvationAnchorMonotonicTimeMicroseconds = null;
        this.waitingForVideoFrame = false;
        if (!this.clock.isPaused) {
            this.clock.pause();
        }
        void this.setAudioPlaying(false).catch((error: unknown): void => {
            this.lastErrorMessage = this.getErrorMessage(error);
        });
        this.setState('ended', generation);
        this.emitTimeUpdate();
        this.emitEvent({ generation, type: 'ended' });
    }

    private completeEndedPlaybackIfDrained(generation: number): void {
        if (this.pendingEndedGeneration !== generation
            || !this.isGenerationActive(generation)) {
            return;
        }

        const queuedFrameCount = this.videoDecodeSession.getTelemetry().queuedFrameCount;
        if (queuedFrameCount !== 0) {
            return;
        }

        if (this.pendingPresentationFrames.size !== 0) {
            return;
        }

        if (typeof this.currentSource?.audioTrackIndex === 'number') {
            const bridgeTelemetry = this.audioBinding?.bridge.getTelemetry();
            if (!bridgeTelemetry
                || bridgeTelemetry.activeDecodeGeneration !== generation
                || bridgeTelemetry.workletGeneration === null
                || bridgeTelemetry.pendingFrameCount !== 0) {
                return;
            }
        }

        if (this.pendingEndedGeneration !== generation) {
            return;
        }
        this.finishEndedPlayback(generation);
    }

    private activateFallback(
        generation: number | null,
        reason: CustomPlaybackFallbackReason,
        message: string
    ): void {
        if (generation === null
            || !this.isGenerationActive(generation)
            || this.fallbackGeneration === generation) {
            return;
        }

        this.fallbackGeneration = generation;
        this.fallbackCount += 1;
        this.fallbackReason = reason;
        this.lastErrorMessage = message;
        this.resetDrainAndStarvationState();
        this.audioPath = 'unavailable';
        const mediaTimeMicroseconds = this.currentTimeMicroseconds;
        void this.setAudioPlaying(false).catch((error: unknown): void => {
            this.lastErrorMessage = `${message}; ${this.getErrorMessage(error)}`;
        });
        if (!this.clock.isPaused) {
            this.clock.pause();
        }
        this.emitEvent({ generation, message, recoverable: true, type: 'error' });
        this.settlePendingStartup({ fallbackReason: reason, generation, status: 'fallback' });
        this.advanceGeneration();
        this.activeGeneration = null;
        this.setState('fallback', generation);

        const fallbackRequest: CustomPlaybackFallbackRequest = {
            generation,
            mediaTimeMicroseconds,
            preserveHTMLSession: true,
            reason
        };
        this.emitEvent({ request: fallbackRequest, type: 'fallback-requested' });
        try {
            const fallbackResult = this.fallbackHook(fallbackRequest);
            void Promise.resolve(fallbackResult).catch((error: unknown): void => {
                this.handleFallbackHookFailure(generation, error);
            });
        } catch (error) {
            this.handleFallbackHookFailure(generation, error);
        }
        void this.stopDecodePipelines().catch((error: unknown): void => {
            this.lastErrorMessage = this.getErrorMessage(error);
        });
    }

    private handleFallbackHookFailure(generation: number, error: unknown): void {
        this.lastErrorMessage = this.getErrorMessage(error);
        if (this.state === 'fallback') {
            this.setState('error', generation);
            this.emitEvent({
                generation,
                message: this.lastErrorMessage,
                recoverable: false,
                type: 'error'
            });
        }
    }

    private readonly createAudioBridge = async (
        configuration: DecodeWorkerAudioConfiguration
    ): Promise<CustomDecodeAudioBridge> => {
        const binding = await this.getOrCreateAudioBinding(configuration);
        return binding.bridge;
    };

    private getOrCreateAudioBinding(
        configuration: DecodeWorkerAudioConfiguration
    ): Promise<CustomAudioOutputBinding> {
        if (!this.audioOutputFactory) {
            return Promise.reject(new Error('Custom audio output is unavailable'));
        }
        if (this.audioBinding
            && hasSameAudioLayout(this.audioBinding.configuration, configuration)) {
            this.audioBinding = {
                ...this.audioBinding,
                configuration: { ...configuration }
            };
            return Promise.resolve(this.audioBinding);
        }
        if (this.audioOutputPromise
            && this.audioOutputPromiseConfiguration
            && hasSameAudioLayout(this.audioOutputPromiseConfiguration, configuration)) {
            return this.audioOutputPromise;
        }

        const previousPromise = this.audioOutputPromise;
        const creationPromise = this.createAudioBinding(
            configuration,
            previousPromise
        ).catch((error: unknown): never => {
            if (this.audioOutputPromise === creationPromise) {
                this.audioOutputPromise = null;
                this.audioOutputPromiseConfiguration = null;
            }
            throw error;
        });
        this.audioOutputPromise = creationPromise;
        this.audioOutputPromiseConfiguration = { ...configuration };
        return creationPromise;
    }

    private async createAudioBinding(
        configuration: DecodeWorkerAudioConfiguration,
        previousPromise: Promise<CustomAudioOutputBinding> | null
    ): Promise<CustomAudioOutputBinding> {
        if (previousPromise) {
            try {
                await previousPromise;
            } catch {
                // A failed prior layout must not prevent a supported later layout
            }
        }
        if (this.destroyed) {
            throw new Error('Custom playback was destroyed during audio initialization');
        }
        if (this.audioBinding
            && hasSameAudioLayout(this.audioBinding.configuration, configuration)) {
            this.audioBinding = {
                ...this.audioBinding,
                configuration: { ...configuration }
            };
            return this.audioBinding;
        }
        if (!this.audioOutputFactory) {
            throw new Error('Custom audio output is unavailable');
        }

        const binding = await this.audioOutputFactory({ ...configuration });
        if (!hasSameAudioLayout(binding.configuration, configuration)) {
            await this.destroyAudioOutput(binding.output);
            throw new RangeError('Custom audio output factory returned the wrong layout');
        }
        if (!this.canAcceptAudioBinding()) {
            await this.destroyAudioOutput(binding.output);
            throw new Error('Custom audio initialization outlived its playback generation');
        }

        this.audioTelemetryUnsubscribe?.();
        this.audioTelemetryUnsubscribe = null;
        const previousAudioOutput = this.audioBinding?.output ?? null;
        if (previousAudioOutput && previousAudioOutput !== binding.output) {
            this.audioBinding = null;
            if (this.audioOutput === previousAudioOutput) {
                this.audioOutput = null;
            }
            await this.destroyAudioOutput(previousAudioOutput);
        }
        try {
            binding.output.setVolume(this.volume);
            binding.output.setMuted(this.muted);
            await binding.output.setPlaying(false);
        } catch (error) {
            await this.destroyAudioOutput(binding.output);
            throw error;
        }
        if (!this.canAcceptAudioBinding()) {
            await this.destroyAudioOutput(binding.output);
            throw new Error('Custom audio initialization outlived its playback generation');
        }
        this.audioBinding = {
            ...binding,
            configuration: { ...configuration }
        };
        this.audioOutput = binding.output;
        this.audioTelemetryUnsubscribe = binding.output.onTelemetry(
            this.handleAudioOutputTelemetry
        );
        return this.audioBinding;
    }

    private canAcceptAudioBinding(): boolean {
        return !this.destroyed
            && this.activeGeneration !== null
            && typeof this.currentSource?.audioTrackIndex === 'number';
    }

    private readonly handleAudioOutputTelemetry = (
        telemetry: AudioWorkletTelemetry
    ): void => {
        const generation = this.activeGeneration;
        const audioOutput = this.audioOutput;
        const bridgeTelemetry = this.audioBinding?.bridge.getTelemetry();
        const telemetryMatchesActiveAudio = generation !== null
            && this.pendingStartup === null
            && typeof this.currentSource?.audioTrackIndex === 'number'
            && audioOutput !== null
            && this.audioBinding?.output === audioOutput
            && telemetry.generation === audioOutput.generation
            && bridgeTelemetry?.activeDecodeGeneration === generation
            && bridgeTelemetry.workletGeneration === telemetry.generation;

        if (telemetryMatchesActiveAudio) {
            this.handleActiveAudioTelemetry(telemetry, generation);
            this.completeEndedPlaybackIfDrained(generation);
        } else if (audioOutput && telemetry.generation !== audioOutput.generation) {
            this.staleEventCount += 1;
        }
        this.emitEvent({ telemetry: this.getTelemetry(), type: 'telemetry' });
    };

    private setAudioPlaying(playing: boolean): Promise<void> {
        const audioOutput = this.audioOutput;
        if (!audioOutput) {
            return Promise.resolve();
        }

        try {
            return Promise.resolve(audioOutput.setPlaying(playing));
        } catch (error) {
            return Promise.reject(error);
        }
    }

    private handleActiveAudioTelemetry(
        telemetry: AudioWorkletTelemetry,
        generation: number
    ): void {
        switch (telemetry.reason) {
            case 'underflow':
                if (this.state !== 'playing' || this.clockStarvation === 'audio') {
                    return;
                }
                this.clock.synchronize(telemetry.mediaTimeMicroseconds);
                if (!this.clock.isPaused) {
                    this.clock.pause();
                }
                this.clockStarvation = 'audio';
                this.emitEvent({ generation, reason: 'audio-buffer', type: 'waiting' });
                this.emitTimeUpdateIfDue();
                return;
            case 'underflow-recovered':
                if (this.clockStarvation === 'audio') {
                    this.clockStarvation = null;
                    if (this.state === 'playing') {
                        this.clock.synchronize(telemetry.mediaTimeMicroseconds);
                        this.clock.resume();
                        this.emitEvent({ generation, type: 'playing' });
                    }
                } else if (this.state === 'playing' && this.clockStarvation === null) {
                    this.clock.synchronize(telemetry.mediaTimeMicroseconds);
                }
                this.emitTimeUpdateIfDue();
                return;
            case 'periodic':
                if (this.state === 'playing' && this.clockStarvation === null) {
                    this.clock.synchronize(telemetry.mediaTimeMicroseconds);
                    this.emitTimeUpdateIfDue();
                }
                return;
            case 'enqueue':
            case 'flush':
            case 'overflow':
            case 'stale-generation':
                return;
        }
    }

    private beginVideoStarvationIfNeeded(): void {
        if (this.clockStarvation !== null
            || typeof this.currentSource?.audioTrackIndex === 'number') {
            return;
        }

        if (!this.clock.isPaused) {
            this.clock.pause();
        }
        this.clockStarvation = 'video';
        this.videoStarvationAnchorMediaTimeMicroseconds = this.currentTimeMicroseconds;
        this.videoStarvationAnchorMonotonicTimeMicroseconds = this.readMonotonicTime();
    }

    private recoverVideoStarvation(
        presentationFrame: DecodedPresentationFrame
    ): boolean {
        if (this.clockStarvation !== 'video') {
            return false;
        }

        this.clock.synchronize(presentationFrame.mediaTimeMicroseconds);
        this.clockStarvation = null;
        this.videoStarvationAnchorMediaTimeMicroseconds = null;
        this.videoStarvationAnchorMonotonicTimeMicroseconds = null;
        if (this.state === 'playing') {
            this.clock.resume();
            const generation = this.activeGeneration;
            if (generation !== null) {
                this.emitEvent({ generation, type: 'playing' });
            }
        }
        return true;
    }

    private getCurrentPresentationTargetTime(): Microseconds {
        if (this.clockStarvation !== 'video'
            || this.state !== 'playing'
            || this.videoStarvationAnchorMediaTimeMicroseconds === null
            || this.videoStarvationAnchorMonotonicTimeMicroseconds === null) {
            return this.currentTimeMicroseconds;
        }

        const monotonicTimeMicroseconds = this.readMonotonicTime();
        const elapsedMicroseconds = monotonicTimeMicroseconds
            - this.videoStarvationAnchorMonotonicTimeMicroseconds;
        if (elapsedMicroseconds < 0) {
            throw new RangeError('Monotonic time moved backwards during video starvation');
        }
        const scaledElapsedMicroseconds = requireMicroseconds(
            Math.round(elapsedMicroseconds * this.clock.rate),
            'Video starvation elapsed time'
        );
        return addMicroseconds(
            this.videoStarvationAnchorMediaTimeMicroseconds,
            scaledElapsedMicroseconds
        );
    }

    private emitTimeUpdateIfDue(): void {
        if (this.activeGeneration === null) {
            return;
        }

        const monotonicTimeMicroseconds = this.readMonotonicTime();
        if (this.lastTimeUpdateMonotonicMicroseconds !== null
            && monotonicTimeMicroseconds - this.lastTimeUpdateMonotonicMicroseconds
                < this.timeUpdateIntervalMicroseconds) {
            return;
        }
        this.lastTimeUpdateMonotonicMicroseconds = monotonicTimeMicroseconds;
        this.emitEvent({
            currentTimeMicroseconds: this.currentTimeMicroseconds,
            durationMicroseconds: this.durationMicroseconds,
            generation: this.activeGeneration,
            type: 'timeupdate'
        });
    }

    private async stopController(destroying: boolean): Promise<void> {
        if (!destroying && this.stopPromise) {
            return this.stopPromise;
        }
        if (!destroying && this.state === 'idle') {
            return;
        }

        const stoppedGeneration = this.activeGeneration;
        const controlGeneration = this.advanceGeneration();
        this.activeGeneration = null;
        this.resetDrainAndStarvationState();
        if (stoppedGeneration !== null) {
            this.settlePendingStartup({
                fallbackReason: null,
                generation: stoppedGeneration,
                status: 'stopped'
            });
        }
        this.setState('stopping', controlGeneration);
        try {
            await this.setAudioPlaying(false);
        } catch (error) {
            this.lastErrorMessage = this.getErrorMessage(error);
        }
        this.clock.reset(ZERO_MICROSECONDS);

        const stopPromise = this.waitBounded(
            this.stopDecodePipelines(),
            'Custom decoder shutdown exceeded its bound'
        ).catch((error: unknown): void => {
            this.lastErrorMessage = this.getErrorMessage(error);
        }).then((): void => {
            if (this.currentGeneration === controlGeneration) {
                this.currentSource = null;
                this.audioPath = 'disabled';
                this.waitingForVideoFrame = false;
                this.setState('idle', controlGeneration);
            }
        }).finally((): void => {
            if (this.stopPromise === stopPromise) {
                this.stopPromise = null;
            }
        });
        this.stopPromise = stopPromise;
        return stopPromise;
    }

    private stopDecodePipelines(): Promise<void> {
        return this.videoDecodeSession.stop();
    }

    private async destroyAudioResources(): Promise<void> {
        const outputs = new Set<CustomAudioOutput>();
        if (this.audioOutput) {
            outputs.add(this.audioOutput);
        }
        if (this.audioBinding) {
            outputs.add(this.audioBinding.output);
        }

        this.audioTelemetryUnsubscribe?.();
        this.audioTelemetryUnsubscribe = null;
        const pendingOutputPromise = this.audioOutputPromise;
        if (pendingOutputPromise) {
            try {
                const binding = await pendingOutputPromise;
                outputs.add(binding.output);
            } catch {
                // Stale factory outputs are released by createAudioBinding
            }
        }

        this.audioBinding = null;
        this.audioOutput = null;
        this.audioOutputPromise = null;
        this.audioOutputPromiseConfiguration = null;
        for (const output of outputs) {
            await this.destroyAudioOutput(output);
        }
    }

    private async destroyAudioOutput(output: CustomAudioOutput): Promise<void> {
        try {
            await output.destroy();
        } catch (error) {
            const message = this.getErrorMessage(error);
            this.lastErrorMessage = this.lastErrorMessage ?
                `${this.lastErrorMessage}; ${message}` :
                message;
        }
    }

    private waitBounded(promise: Promise<void>, timeoutMessage: string): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const timer = globalThis.setTimeout(() => {
                if (settled) {
                    return;
                }
                settled = true;
                reject(new Error(timeoutMessage));
            }, microsecondsToMilliseconds(this.pipelineStopTimeoutMicroseconds));
            promise.then(
                (): void => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    globalThis.clearTimeout(timer);
                    resolve();
                },
                (error: unknown): void => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    globalThis.clearTimeout(timer);
                    reject(error);
                }
            );
        });
    }

    private supersedePendingStartup(): void {
        const pendingStartup = this.pendingStartup;
        if (!pendingStartup) {
            return;
        }
        this.settlePendingStartup({
            fallbackReason: null,
            generation: pendingStartup.generation,
            status: 'superseded'
        });
    }

    private isPendingStartupActive(pendingStartup: PendingStartup): boolean {
        return this.pendingStartup === pendingStartup
            && !pendingStartup.settled
            && this.isGenerationActive(pendingStartup.generation);
    }

    private resetDrainAndStarvationState(): void {
        this.pendingEndedGeneration = null;
        this.pendingPresentationFrames.clear();
        this.clockStarvation = null;
        this.videoStarvationAnchorMediaTimeMicroseconds = null;
        this.videoStarvationAnchorMonotonicTimeMicroseconds = null;
        this.waitingForVideoFrame = false;
    }

    private settlePendingStartup(result: CustomPlaybackStartResult): void {
        const pendingStartup = this.pendingStartup;
        if (!pendingStartup
            || pendingStartup.generation !== result.generation
            || pendingStartup.settled) {
            return;
        }

        pendingStartup.settled = true;
        globalThis.clearTimeout(pendingStartup.timer);
        this.pendingStartup = null;
        pendingStartup.resolve(result);
    }

    private setState(state: CustomPlaybackState, generation: number): void {
        if (this.state === state) {
            return;
        }

        const previousState = this.state;
        this.state = state;
        this.emitEvent({ generation, previousState, state, type: 'statechange' });
    }

    private emitEvent(event: CustomPlaybackControllerEvent): void {
        try {
            this.eventHandler(event);
        } catch (error) {
            console.warn('Custom playback controller event handler failed', error);
        }
    }

    private readMonotonicTime(): Microseconds {
        return requireMicroseconds(this.monotonicTimeSource(), 'Monotonic time');
    }

    private advanceGeneration(): number {
        if (this.currentGeneration === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Custom playback generation exhausted');
        }
        this.currentGeneration += 1;
        return this.currentGeneration;
    }

    private isGenerationActive(generation: number): boolean {
        return this.activeGeneration === generation && !this.destroyed;
    }

    private requireActiveGeneration(): number {
        if (this.activeGeneration === null) {
            throw new Error('Custom playback has no active generation');
        }
        return this.activeGeneration;
    }

    private requireUsable(): void {
        if (this.destroyed) {
            throw new Error('Custom playback controller is destroyed');
        }
    }

    private getErrorMessage(error: unknown): string {
        return error instanceof Error ? error.message : String(error);
    }
}
