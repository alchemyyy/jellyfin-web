import type { Microseconds } from '../MediaTime';

export const MAX_DECODED_FRAME_CREDITS = 4;
export const MAX_DECODED_AUDIO_SAMPLE_CREDITS = 8;
export const MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE = 65_536;
export const MAX_DECODED_AUDIO_CHANNELS = 32;

export type CustomDecodeFailureKind =
    | 'audio-output-failed'
    | 'decode-failed'
    | 'network-failed'
    | 'range-unsupported'
    | 'source-unsupported';

export type DecodeWorkerStartRequest = {
    audioSampleCredits: number
    audioTrackIndex: number | null
    frameCredits: number
    generation: number
    startTimeMicroseconds: Microseconds
    type: 'start'
    url: string
    videoTrackIndex: number
};

export type DecodeWorkerPullRequest = {
    frameCredits: number
    generation: number
    type: 'pull'
};

export type DecodeWorkerAudioPullRequest = {
    audioSampleCredits: number
    generation: number
    type: 'pull-audio'
};

export type DecodeWorkerStopRequest = {
    generation: number
    type: 'stop'
};

export type DecodeWorkerRequest =
    | DecodeWorkerAudioPullRequest
    | DecodeWorkerPullRequest
    | DecodeWorkerStartRequest
    | DecodeWorkerStopRequest;

export type DecodeWorkerAudioConfiguration = {
    channelCount: number
    codec: string
    sampleRate: number
};

export type DecodeWorkerReadyResponse = {
    audio: DecodeWorkerAudioConfiguration | null
    codec: string
    codedHeight: number
    codedWidth: number
    displayHeight: number
    displayWidth: number
    generation: number
    type: 'ready'
};

export type DecodeWorkerFrameResponse = {
    durationMicroseconds: Microseconds
    frame: VideoFrame
    generation: number
    mediaTimeMicroseconds: Microseconds
    type: 'frame'
};

export type DecodeWorkerAudioResponse = {
    channelCount: number
    channelData: readonly Float32Array[]
    durationMicroseconds: Microseconds
    frameCount: number
    generation: number
    mediaTimeMicroseconds: Microseconds
    sampleRate: number
    type: 'audio'
};

export type DecodeWorkerEndedResponse = {
    generation: number
    type: 'ended'
};

export type DecodeWorkerErrorResponse = {
    failureKind: CustomDecodeFailureKind
    generation: number
    message: string
    type: 'error'
};

export type DecodeWorkerStoppedResponse = {
    generation: number
    type: 'stopped'
};

export type DecodeWorkerResponse =
    | DecodeWorkerAudioResponse
    | DecodeWorkerEndedResponse
    | DecodeWorkerErrorResponse
    | DecodeWorkerFrameResponse
    | DecodeWorkerReadyResponse
    | DecodeWorkerStoppedResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function isGeneration(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

function isMicroseconds(value: unknown): value is Microseconds {
    return Number.isSafeInteger(value);
}

function isFrameCredit(value: unknown): value is number {
    return Number.isSafeInteger(value)
        && Number(value) > 0
        && Number(value) <= MAX_DECODED_FRAME_CREDITS;
}

function isAudioSampleCredit(value: unknown, allowZero: boolean): value is number {
    return Number.isSafeInteger(value)
        && Number(value) >= (allowZero ? 0 : 1)
        && Number(value) <= MAX_DECODED_AUDIO_SAMPLE_CREDITS;
}

function isPositiveInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

function isTrackIndex(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isFailureKind(value: unknown): value is CustomDecodeFailureKind {
    switch (value) {
        case 'audio-output-failed':
        case 'decode-failed':
        case 'network-failed':
        case 'range-unsupported':
        case 'source-unsupported':
            return true;
        default:
            return false;
    }
}

function isAudioConfiguration(value: unknown): value is DecodeWorkerAudioConfiguration {
    if (!isRecord(value)) {
        return false;
    }

    return typeof value.codec === 'string'
        && value.codec.length > 0
        && isPositiveInteger(value.channelCount)
        && Number(value.channelCount) <= MAX_DECODED_AUDIO_CHANNELS
        && isPositiveInteger(value.sampleRate);
}

function isChannelData(
    value: unknown,
    channelCount: number,
    frameCount: number
): value is readonly Float32Array[] {
    if (!Array.isArray(value) || value.length !== channelCount) {
        return false;
    }

    for (const channel of value) {
        if (!(channel instanceof Float32Array) || channel.length !== frameCount) {
            return false;
        }
    }
    return true;
}

/** Validates a message before the decode worker acts on it. */
export function isDecodeWorkerRequest(value: unknown): value is DecodeWorkerRequest {
    if (!isRecord(value) || !isGeneration(value.generation)) {
        return false;
    }

    switch (value.type) {
        case 'start': {
            const hasAudioTrack = isTrackIndex(value.audioTrackIndex);
            const hasNoAudioTrack = value.audioTrackIndex === null;
            const hasValidAudioCredits = isAudioSampleCredit(value.audioSampleCredits, true);
            return typeof value.url === 'string'
                && value.url.length > 0
                && isMicroseconds(value.startTimeMicroseconds)
                && isTrackIndex(value.videoTrackIndex)
                && isFrameCredit(value.frameCredits)
                && (hasAudioTrack || hasNoAudioTrack)
                && hasValidAudioCredits
                && (hasAudioTrack || Number(value.audioSampleCredits) === 0);
        }
        case 'pull':
            return isFrameCredit(value.frameCredits);
        case 'pull-audio':
            return isAudioSampleCredit(value.audioSampleCredits, false);
        case 'stop':
            return true;
        default:
            return false;
    }
}

/** Validates a worker response before it mutates the active session. */
export function isDecodeWorkerResponse(value: unknown): value is DecodeWorkerResponse {
    if (!isRecord(value) || !isGeneration(value.generation)) {
        return false;
    }

    switch (value.type) {
        case 'ready':
            return typeof value.codec === 'string'
                && value.codec.length > 0
                && isPositiveInteger(value.codedHeight)
                && isPositiveInteger(value.codedWidth)
                && isPositiveInteger(value.displayHeight)
                && isPositiveInteger(value.displayWidth)
                && (value.audio === null || isAudioConfiguration(value.audio));
        case 'frame':
            return isMicroseconds(value.mediaTimeMicroseconds)
                && isMicroseconds(value.durationMicroseconds)
                && Number(value.durationMicroseconds) >= 0
                && isRecord(value.frame)
                && typeof value.frame.close === 'function';
        case 'audio': {
            const channelCount = Number(value.channelCount);
            const frameCount = Number(value.frameCount);
            return isMicroseconds(value.mediaTimeMicroseconds)
                && isMicroseconds(value.durationMicroseconds)
                && Number(value.durationMicroseconds) >= 0
                && isPositiveInteger(value.channelCount)
                && channelCount <= MAX_DECODED_AUDIO_CHANNELS
                && isPositiveInteger(value.frameCount)
                && frameCount <= MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE
                && isPositiveInteger(value.sampleRate)
                && isChannelData(value.channelData, channelCount, frameCount);
        }
        case 'ended':
        case 'stopped':
            return true;
        case 'error':
            return isFailureKind(value.failureKind) && typeof value.message === 'string';
        default:
            return false;
    }
}
