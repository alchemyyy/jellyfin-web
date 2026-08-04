import type { Microseconds } from '../MediaTime';
import type {
    DecodeWorkerNativeAudioInitializationResponse,
    DecodeWorkerNativeAudioMediaResponse,
    DecodeWorkerNativeMediaAudioConfiguration
} from './DecodeWorkerProtocol';
import OwnedNativeMediaAudioBackend, {
    type OwnedNativeMediaAudioEvent,
    type OwnedNativeMediaAudioEventHandler,
    type OwnedNativeMediaAudioSegment,
    type OwnedNativeMediaAudioStartOptions,
    type OwnedNativeMediaAudioTelemetry
} from './OwnedNativeMediaAudioBackend';
import { requireMicroseconds } from './TimeMath';

export const INITIAL_NATIVE_AUDIO_SEGMENT_CREDITS = 2;

export type CustomDecodeNativeAudioBridgeCallbacks = {
    onClockReady: (generation: number) => void
    onCreditsReleased: (audioSegmentCredits: number) => void
    onEvent?: (event: OwnedNativeMediaAudioEvent) => void
    onFailure: (message: string) => void
};

export type CustomDecodeNativeAudioBridgeStartOptions = {
    audioConfiguration: DecodeWorkerNativeMediaAudioConfiguration
    callbacks: CustomDecodeNativeAudioBridgeCallbacks
    durationMicroseconds: Microseconds
    generation: number
    startTimeMicroseconds: Microseconds
};

export type CustomDecodeNativeAudioBridgeTelemetry = {
    activeGeneration: number | null
    backend: OwnedNativeMediaAudioTelemetry
    initializationSegmentCount: number
    mediaSegmentCount: number
    releasedCreditCount: number
    staleMessageCount: number
    state: 'destroyed' | 'idle' | 'ready' | 'starting' | 'stopped'
};

export type OwnedNativeMediaAudioBackendPort = {
    appendInitializationSegment: (generation: number, data: Uint8Array) => Promise<boolean>
    appendMediaSegment: (
        generation: number,
        segment: OwnedNativeMediaAudioSegment
    ) => Promise<boolean>
    destroy: () => Promise<void>
    endOfStream: (generation: number) => Promise<boolean>
    getAuthoritativeTimeMicroseconds: () => Microseconds | null
    getTelemetry: () => OwnedNativeMediaAudioTelemetry
    seek: (generation: number, mediaTimeMicroseconds: Microseconds) => boolean
    setMuted: (muted: boolean) => void
    setPlaybackRate: (playbackRate: number) => void
    setPlaying: (generation: number, playing: boolean) => Promise<boolean>
    setVolume: (volume: number) => void
    start: (options: OwnedNativeMediaAudioStartOptions) => Promise<void>
    stop: (generation: number) => Promise<boolean>
};

export type OwnedNativeMediaAudioBackendFactory = (
    eventHandler: OwnedNativeMediaAudioEventHandler
) => OwnedNativeMediaAudioBackendPort;

function createDefaultBackend(
    eventHandler: OwnedNativeMediaAudioEventHandler
): OwnedNativeMediaAudioBackend {
    return new OwnedNativeMediaAudioBackend({ eventHandler });
}

function getSafeErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Native media audio output failed';
}

/** Connects bounded decode-worker fMP4 responses to one owned MSE audio backend. */
export default class CustomDecodeNativeAudioBridge {
    private activeGeneration: number | null = null;
    private readonly backend: OwnedNativeMediaAudioBackendPort;
    private callbacks: CustomDecodeNativeAudioBridgeCallbacks | null = null;
    private destroyed = false;
    private failedGeneration: number | null = null;
    private initializationReceived = false;
    private initializationSegmentCount = 0;
    private lastMediaEndTimeMicroseconds: Microseconds | null = null;
    private lifecycleRevision = 0;
    private lifecycleTail: Promise<void> = Promise.resolve();
    private mediaSegmentCount = 0;
    private pendingGeneration: number | null = null;
    private releasedCreditCount = 0;
    private staleMessageCount = 0;
    private state: CustomDecodeNativeAudioBridgeTelemetry['state'] = 'idle';

    public constructor(
        backendFactory: OwnedNativeMediaAudioBackendFactory = createDefaultBackend
    ) {
        this.backend = backendFactory(this.handleBackendEvent);
    }

    public get initialAudioSegmentCredits(): number {
        return INITIAL_NATIVE_AUDIO_SEGMENT_CREDITS;
    }

    /** Starts a new exact native-media route after serially retiring its predecessor. */
    public start(options: CustomDecodeNativeAudioBridgeStartOptions): Promise<boolean> {
        this.requireUsable();
        requireMicroseconds(options.startTimeMicroseconds, 'Native audio bridge start time');
        requireMicroseconds(options.durationMicroseconds, 'Native audio bridge duration');
        if (options.durationMicroseconds <= 0) {
            throw new RangeError('Native audio bridge duration must be positive');
        }
        if (options.audioConfiguration.outputMode !== 'native-media') {
            throw new TypeError('Native audio bridge requires a native-media configuration');
        }
        const revision = this.advanceLifecycleRevision();
        this.pendingGeneration = options.generation;
        this.state = 'starting';
        const operation = this.lifecycleTail.then(async (): Promise<boolean> => {
            const previousGeneration = this.activeGeneration;
            this.activeGeneration = null;
            if (previousGeneration !== null) {
                await this.backend.stop(previousGeneration);
            }
            if (revision !== this.lifecycleRevision || this.destroyed) {
                if (this.pendingGeneration === options.generation) {
                    this.pendingGeneration = null;
                }
                return false;
            }

            await this.backend.start({
                durationMicroseconds: options.durationMicroseconds,
                generation: options.generation,
                mimeType: options.audioConfiguration.mimeType,
                startTimeMicroseconds: options.startTimeMicroseconds
            });
            if (revision !== this.lifecycleRevision || this.destroyed) {
                await this.backend.stop(options.generation);
                if (this.pendingGeneration === options.generation) {
                    this.pendingGeneration = null;
                }
                return false;
            }

            this.activeGeneration = options.generation;
            this.pendingGeneration = null;
            this.callbacks = options.callbacks;
            this.failedGeneration = null;
            this.initializationReceived = false;
            this.initializationSegmentCount = 0;
            this.lastMediaEndTimeMicroseconds = null;
            this.mediaSegmentCount = 0;
            this.releasedCreditCount = 0;
            this.state = 'ready';
            return true;
        });
        this.lifecycleTail = operation.then((): void => undefined, (): void => undefined);
        return operation;
    }

    /** Appends the one initialization segment emitted for this generation. */
    public async enqueueInitialization(
        message: DecodeWorkerNativeAudioInitializationResponse
    ): Promise<boolean> {
        if (!this.isCurrent(message.generation)) {
            this.staleMessageCount += 1;
            return false;
        }
        if (this.initializationReceived) {
            this.fail(message.generation, 'Native audio worker sent duplicate initialization');
            return false;
        }
        this.initializationReceived = true;
        try {
            const appended = await this.backend.appendInitializationSegment(
                message.generation,
                new Uint8Array(message.data)
            );
            if (!appended || !this.isCurrent(message.generation)) {
                this.staleMessageCount += 1;
                return false;
            }
            this.initializationSegmentCount += 1;
            return true;
        } catch (error) {
            this.fail(message.generation, getSafeErrorMessage(error));
            return false;
        }
    }

    /** Appends one bounded media fragment and releases exactly one producer credit. */
    public async enqueueMedia(
        message: DecodeWorkerNativeAudioMediaResponse
    ): Promise<boolean> {
        if (!this.isCurrent(message.generation)) {
            this.staleMessageCount += 1;
            return false;
        }
        if (!this.initializationReceived) {
            this.fail(message.generation, 'Native audio media arrived before initialization');
            return false;
        }
        if (this.lastMediaEndTimeMicroseconds !== null
            && message.startTimeMicroseconds < this.lastMediaEndTimeMicroseconds) {
            this.fail(message.generation, 'Native audio media fragments overlapped or moved backward');
            return false;
        }
        this.lastMediaEndTimeMicroseconds = message.endTimeMicroseconds;
        try {
            const appended = await this.backend.appendMediaSegment(message.generation, {
                data: new Uint8Array(message.data),
                endTimeMicroseconds: message.endTimeMicroseconds,
                startTimeMicroseconds: message.startTimeMicroseconds
            });
            if (!appended || !this.isCurrent(message.generation)) {
                this.staleMessageCount += 1;
                return false;
            }
            this.mediaSegmentCount += 1;
            this.releasedCreditCount += 1;
            try {
                this.callbacks?.onCreditsReleased(1);
            } catch {
                this.fail(message.generation, 'Native audio credit callback failed');
                return false;
            }
            return true;
        } catch (error) {
            this.fail(message.generation, getSafeErrorMessage(error));
            return false;
        }
    }

    /** Completes the audio-only MediaSource after all fragment appends drain. */
    public async endOfStream(generation: number): Promise<boolean> {
        if (!this.isCurrent(generation)) {
            this.staleMessageCount += 1;
            return false;
        }
        try {
            return await this.backend.endOfStream(generation);
        } catch (error) {
            this.fail(generation, getSafeErrorMessage(error));
            return false;
        }
    }

    public setPlaying(playing: boolean): Promise<boolean> {
        const generation = this.activeGeneration;
        return generation === null ?
            Promise.resolve(false) :
            this.backend.setPlaying(generation, playing);
    }

    public seek(mediaTimeMicroseconds: Microseconds): boolean {
        const generation = this.activeGeneration;
        return generation !== null && this.backend.seek(generation, mediaTimeMicroseconds);
    }

    public setVolume(volume: number): void {
        this.backend.setVolume(volume);
    }

    public setMuted(muted: boolean): void {
        this.backend.setMuted(muted);
    }

    public setPlaybackRate(playbackRate: number): void {
        this.backend.setPlaybackRate(playbackRate);
    }

    /** Returns null until the owned element proves decoded clock advancement. */
    public getAuthoritativeTimeMicroseconds(): Microseconds | null {
        return this.backend.getAuthoritativeTimeMicroseconds();
    }

    /** Invalidates callbacks before retiring the active backend generation. */
    public stop(
        generation: number | null = this.activeGeneration ?? this.pendingGeneration
    ): Promise<boolean> {
        if (generation === null
            || (generation !== this.activeGeneration && generation !== this.pendingGeneration)) {
            this.staleMessageCount += generation === null ? 0 : 1;
            return Promise.resolve(false);
        }
        const revision = this.advanceLifecycleRevision();
        this.activeGeneration = null;
        this.pendingGeneration = null;
        this.callbacks = null;
        this.initializationReceived = false;
        this.state = 'stopped';
        const operation = this.lifecycleTail.then(async (): Promise<boolean> => {
            if (revision !== this.lifecycleRevision || this.destroyed) {
                return false;
            }
            if (this.backend.getTelemetry().activeGeneration !== generation) {
                return false;
            }
            return this.backend.stop(generation);
        });
        this.lifecycleTail = operation.then((): void => undefined, (): void => undefined);
        return operation;
    }

    public destroy(): Promise<void> {
        if (this.destroyed) {
            return this.lifecycleTail;
        }
        this.destroyed = true;
        this.advanceLifecycleRevision();
        this.activeGeneration = null;
        this.pendingGeneration = null;
        this.callbacks = null;
        this.initializationReceived = false;
        this.state = 'destroyed';
        const operation = this.lifecycleTail.then((): Promise<void> => this.backend.destroy());
        this.lifecycleTail = operation.catch((): void => undefined);
        return operation;
    }

    public getTelemetry(): CustomDecodeNativeAudioBridgeTelemetry {
        return {
            activeGeneration: this.activeGeneration,
            backend: this.backend.getTelemetry(),
            initializationSegmentCount: this.initializationSegmentCount,
            mediaSegmentCount: this.mediaSegmentCount,
            releasedCreditCount: this.releasedCreditCount,
            staleMessageCount: this.staleMessageCount,
            state: this.state
        };
    }

    private readonly handleBackendEvent = (event: OwnedNativeMediaAudioEvent): void => {
        if (!this.isCurrent(event.generation)) {
            return;
        }
        try {
            this.callbacks?.onEvent?.(event);
        } catch {
            this.fail(event.generation, 'Native audio event callback failed');
            return;
        }
        switch (event.type) {
            case 'clock-ready':
                try {
                    this.callbacks?.onClockReady(event.generation);
                } catch {
                    this.fail(event.generation, 'Native audio clock callback failed');
                }
                break;
            case 'error':
                this.fail(event.generation, event.message);
                break;
            case 'ended':
            case 'pause':
            case 'playing':
            case 'waiting':
                break;
        }
    };

    private fail(generation: number, message: string): void {
        if (!this.isCurrent(generation) || this.failedGeneration === generation) {
            return;
        }
        this.failedGeneration = generation;
        try {
            this.callbacks?.onFailure(message);
        } catch {
            // A consumer callback cannot compromise backend teardown
        }
    }

    private isCurrent(generation: number): boolean {
        return !this.destroyed
            && this.state === 'ready'
            && this.activeGeneration === generation;
    }

    private advanceLifecycleRevision(): number {
        if (this.lifecycleRevision === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Native audio bridge lifecycle revision exhausted');
        }
        this.lifecycleRevision += 1;
        return this.lifecycleRevision;
    }

    private requireUsable(): void {
        if (this.destroyed) {
            throw new Error('Native audio bridge is destroyed');
        }
    }
}
