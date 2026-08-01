import type { Microseconds } from '../MediaTime';
import type { DecodedPresentationFrame } from '../WebGPUPresenter';
import type {
    AudioTelemetryListener,
    AudioWorkletControllerOptions
} from './AudioWorkletController';
import type { AudioWorkletTelemetry } from './AudioWorkletProtocol';
import type CustomDecodeAudioBridge from './CustomDecodeAudioBridge';
import type { CustomDecodeAudioBridgeTelemetry } from './CustomDecodeAudioBridge';
import type {
    CustomDecodeAudioBridgeFactory,
    CustomDecodeSessionEvent,
    CustomDecodeSessionEventHandler,
    CustomDecodeSessionStartOptions,
    CustomDecodeSessionTelemetry
} from './CustomDecodeSession';
import type { DecodeWorkerAudioConfiguration } from './DecodeWorkerProtocol';
import type { MediaClockSnapshot, MonotonicTimeSource } from './MediaClock';

export type CustomPlaybackState =
    | 'ended'
    | 'error'
    | 'fallback'
    | 'idle'
    | 'paused'
    | 'playing'
    | 'seeking'
    | 'starting'
    | 'stopping';

export type CustomPlaybackFallbackReason =
    | 'audio-output-failed'
    | 'audio-output-unavailable'
    | 'decode-failed'
    | 'ended-before-ready'
    | 'lifecycle-failed'
    | 'playback-rate-unsupported'
    | 'startup-timeout';

export type CustomPlaybackPlayOptions = {
    audioTrackIndex: number | null
    durationMicroseconds: Microseconds | null
    startTimeMicroseconds: Microseconds
    url: string
    videoTrackIndex: number
};

export type CustomPlaybackStartResult = {
    fallbackReason: CustomPlaybackFallbackReason | null
    generation: number
    status: 'fallback' | 'started' | 'stopped' | 'superseded'
};

export type CustomPlaybackFallbackRequest = {
    generation: number
    mediaTimeMicroseconds: Microseconds
    preserveHTMLSession: true
    reason: CustomPlaybackFallbackReason
};

export type CustomPlaybackHTMLFallbackHook = (
    request: CustomPlaybackFallbackRequest
) => Promise<void> | void;

export type CustomAudioOutput = {
    readonly generation: number
    destroy: () => Promise<void> | void
    getTelemetry: () => AudioWorkletTelemetry | null
    onTelemetry: (listener: AudioTelemetryListener) => () => void
    setMuted: (muted: boolean) => void
    setPlaying: (playing: boolean) => Promise<void> | void
    setVolume: (volume: number) => void
};

export type CustomAudioOutputBinding = {
    bridge: CustomDecodeAudioBridge
    configuration: DecodeWorkerAudioConfiguration
    output: CustomAudioOutput
};

export type CustomAudioOutputFactory = (
    configuration: DecodeWorkerAudioConfiguration
) => CustomAudioOutputBinding | Promise<CustomAudioOutputBinding>;

export type CustomVideoDecodeSession = {
    getTelemetry: () => CustomDecodeSessionTelemetry
    start: (options: CustomDecodeSessionStartOptions) => void
    stop: () => Promise<void>
    takeFrame: (targetTimeMicroseconds: Microseconds) => DecodedPresentationFrame | null
};

export type CustomVideoDecodeSessionFactory = (
    eventHandler: CustomDecodeSessionEventHandler,
    audioBridgeFactory: CustomDecodeAudioBridgeFactory | null
) => CustomVideoDecodeSession;

export type CustomPlaybackClock = {
    readonly generation: number
    readonly isPaused: boolean
    readonly mediaTimeMicroseconds: Microseconds
    readonly rate: number
    pause: () => number
    reset: (mediaTimeMicroseconds?: Microseconds) => number
    resume: () => number
    seek: (mediaTimeMicroseconds: Microseconds) => number
    setPlaybackRate: (playbackRate: number) => number
    snapshot: () => MediaClockSnapshot
    synchronize: (mediaTimeMicroseconds: Microseconds) => void
};

export type CustomPlaybackTelemetry = {
    activeGeneration: number | null
    audioBridge: CustomDecodeAudioBridgeTelemetry | null
    audioOutput: AudioWorkletTelemetry | null
    audioPath: 'disabled' | 'pending' | 'ready' | 'unavailable'
    clock: MediaClockSnapshot
    currentTimeMicroseconds: Microseconds
    durationMicroseconds: Microseconds | null
    fallbackCount: number
    fallbackReason: CustomPlaybackFallbackReason | null
    lastErrorMessage: string | null
    muted: boolean
    playCount: number
    staleEventCount: number
    startupDurationMicroseconds: Microseconds | null
    state: CustomPlaybackState
    videoDecode: CustomDecodeSessionTelemetry
    volume: number
};

export type CustomPlaybackControllerEvent =
    | {
        generation: number
        previousState: CustomPlaybackState
        state: CustomPlaybackState
        type: 'statechange'
    }
    | {
        generation: number
        durationMicroseconds: Microseconds | null
        startupDurationMicroseconds: Microseconds
        type: 'ready'
    }
    | {
        generation: number
        type: 'playing'
    }
    | {
        currentTimeMicroseconds: Microseconds
        durationMicroseconds: Microseconds | null
        generation: number
        type: 'timeupdate'
    }
    | {
        generation: number
        reason: 'audio-buffer' | 'startup' | 'video-frame'
        type: 'waiting'
    }
    | {
        generation: number
        type: 'ended'
    }
    | {
        generation: number
        message: string
        recoverable: boolean
        type: 'error'
    }
    | {
        request: CustomPlaybackFallbackRequest
        type: 'fallback-requested'
    }
    | {
        telemetry: CustomPlaybackTelemetry
        type: 'telemetry'
    };

export type CustomPlaybackControllerEventHandler = (
    event: CustomPlaybackControllerEvent
) => void;

export type CustomPlaybackControllerOptions = {
    audioContext?: AudioContext
    audioOutputFactory?: CustomAudioOutputFactory
    audioWorkletOptions?: Omit<AudioWorkletControllerOptions, 'channelCount'>
    clock?: CustomPlaybackClock
    eventHandler?: CustomPlaybackControllerEventHandler
    fallbackHook?: CustomPlaybackHTMLFallbackHook
    monotonicTimeSource?: MonotonicTimeSource
    pipelineStopTimeoutMicroseconds?: Microseconds
    startupTimeoutMicroseconds?: Microseconds
    timeUpdateIntervalMicroseconds?: Microseconds
    videoDecodeSessionFactory?: CustomVideoDecodeSessionFactory
};

export type { CustomDecodeSessionEvent };
