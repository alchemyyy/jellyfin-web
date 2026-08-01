import type { Microseconds } from '../MediaTime';

export type TransferablePlanarPCM = {
    channelData: readonly Float32Array[]
    timestampMicroseconds: Microseconds
};

export type AudioWorkletEnqueueMessage = {
    channelData: readonly Float32Array[]
    generation: number
    sequence: number
    timestampMicroseconds: Microseconds
    type: 'enqueue'
};

export type AudioWorkletFlushMessage = {
    generation: number
    mediaTimeMicroseconds: Microseconds
    type: 'flush'
};

export type AudioWorkletPlaybackMessage = {
    playing: boolean
    type: 'playback'
};

export type AudioWorkletGainMessage = {
    muted: boolean
    type: 'gain'
    volume: number
};

export type AudioWorkletDestroyMessage = {
    type: 'destroy'
};

export type CustomAudioWorkletMessage =
    | AudioWorkletDestroyMessage
    | AudioWorkletEnqueueMessage
    | AudioWorkletFlushMessage
    | AudioWorkletGainMessage
    | AudioWorkletPlaybackMessage;

export type AudioWorkletTelemetryReason =
    | 'enqueue'
    | 'flush'
    | 'overflow'
    | 'periodic'
    | 'stale-generation'
    | 'underflow'
    | 'underflow-recovered';

export type AudioWorkletTelemetry = {
    consumedFrames: number
    droppedFrames: number
    generation: number
    mediaTimeMicroseconds: Microseconds
    muted: boolean
    outputFrames: number
    overflowEvents: number
    overflowFrames: number
    playing: boolean
    queuedFrames: number
    reason: AudioWorkletTelemetryReason
    sequence: number | null
    staleChunks: number
    type: 'telemetry'
    underflowEvents: number
    underflowFrames: number
    volume: number
};
