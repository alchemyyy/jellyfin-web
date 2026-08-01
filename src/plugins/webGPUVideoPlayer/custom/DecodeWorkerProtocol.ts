import type { Microseconds } from '../MediaTime';
import {
    MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH,
    MAXIMUM_RAW_VIDEO_CODED_HEIGHT,
    MAXIMUM_RAW_VIDEO_CODED_WIDTH,
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    type RawVideoPlaneDescriptor,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from './RawVideoFrameCopy';

export const MAX_DECODED_FRAME_CREDITS = 4;
export const MAX_DECODED_RAW_FRAME_CREDITS = 2;
export const MAX_DECODED_AUDIO_SAMPLE_CREDITS = 8;
export const MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE = 65_536;
export const MAX_DECODED_AUDIO_CHANNELS = 32;
export const MAX_DECODED_AUDIO_SAMPLE_RATE = 192_000;

export type CustomDecodeVideoOutputMode = 'raw-planes' | 'video-frame';
export type CustomDecodeRawVideoFrameFormat = 'I420P10' | 'I420P12';
export type CustomDecodeVideoDecoderBackend = 'bundled-hevc' | 'native';

/** Matches a qualified decoder backend to its measured acceleration preference. */
export function getCustomDecodeHardwareAcceleration(
    videoOutputMode: CustomDecodeVideoOutputMode,
    videoDecoderBackend: CustomDecodeVideoDecoderBackend = 'native'
): HardwareAcceleration {
    if (videoDecoderBackend === 'bundled-hevc') {
        return 'prefer-software';
    }
    switch (videoOutputMode) {
        case 'raw-planes':
            return 'prefer-software';
        case 'video-frame':
            return 'prefer-hardware';
    }
}

export type CustomDecodeFailureKind =
    | 'audio-output-failed'
    | 'decode-failed'
    | 'network-failed'
    | 'range-unsupported'
    | 'source-unsupported';

export type DecodeWorkerStartRequest = {
    audioSampleCredits: number
    /** Zero-based ordinal within input.getAudioTracks(), not a Jellyfin stream index. */
    audioTrackIndex: number | null
    frameCredits: number
    generation: number
    maximumCodedHeight: number
    maximumCodedWidth: number
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    startTimeMicroseconds: Microseconds
    type: 'start'
    url: string
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    videoOutputMode: CustomDecodeVideoOutputMode
    /** Zero-based ordinal within input.getVideoTracks(), not a Jellyfin stream index. */
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

export type DecodeWorkerRecycleFrameRequest = {
    buffer: ArrayBuffer
    generation: number
    type: 'recycle-frame'
};

export type DecodeWorkerStopRequest = {
    generation: number
    type: 'stop'
};

export type DecodeWorkerRequest =
    | DecodeWorkerAudioPullRequest
    | DecodeWorkerPullRequest
    | DecodeWorkerRecycleFrameRequest
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

type DecodeWorkerFrameResponseBase = {
    durationMicroseconds: Microseconds
    generation: number
    mediaTimeMicroseconds: Microseconds
    type: 'frame'
};

export type DecodeWorkerVideoFrameResponse = DecodeWorkerFrameResponseBase & {
    frame: VideoFrame
    outputMode: 'video-frame'
};

export type DecodeWorkerRawFrameResponse = DecodeWorkerFrameResponseBase & {
    frame: TransferableRawVideoFrame
    outputMode: 'raw-planes'
};

export type DecodeWorkerFrameResponse =
    | DecodeWorkerRawFrameResponse
    | DecodeWorkerVideoFrameResponse;

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

function isCodedDimensionBound(
    value: unknown,
    absoluteMaximum: number
): value is number {
    return isPositiveInteger(value) && Number(value) <= absoluteMaximum;
}

function isVideoOutputMode(value: unknown): value is CustomDecodeVideoOutputMode {
    return value === 'raw-planes' || value === 'video-frame';
}

function isVideoDecoderBackend(value: unknown): value is CustomDecodeVideoDecoderBackend {
    return value === 'bundled-hevc' || value === 'native';
}

function isRawVideoFrameFormat(value: unknown): value is CustomDecodeRawVideoFrameFormat {
    return value === 'I420P10' || value === 'I420P12';
}

type RawVideoFormatValidation = {
    bitDepth: 8 | 10 | 12
    planeKinds: readonly RawVideoPlaneDescriptor['kind'][]
};

function getRawVideoFormatValidation(
    format: unknown
): RawVideoFormatValidation | null {
    switch (format) {
        case 'I420':
            return { bitDepth: 8, planeKinds: [ 'y', 'u', 'v' ] };
        case 'I420P10':
            return { bitDepth: 10, planeKinds: [ 'y', 'u', 'v' ] };
        case 'I420P12':
            return { bitDepth: 12, planeKinds: [ 'y', 'u', 'v' ] };
        case 'NV12':
            return { bitDepth: 8, planeKinds: [ 'y', 'uv' ] };
        default:
            return null;
    }
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function isRawVideoColorSpace(value: unknown): boolean {
    if (!isRecord(value)) {
        return false;
    }

    return (value.fullRange === null || typeof value.fullRange === 'boolean')
        && isNullableString(value.matrix)
        && isNullableString(value.primaries)
        && isNullableString(value.transfer);
}

function isRawVideoRectangle(
    value: unknown,
    codedWidth: number,
    codedHeight: number
): boolean {
    if (!isRecord(value)) {
        return false;
    }

    const x = Number(value.x);
    const y = Number(value.y);
    const width = Number(value.width);
    const height = Number(value.height);
    return Number.isSafeInteger(x)
        && Number.isSafeInteger(y)
        && Number.isSafeInteger(width)
        && Number.isSafeInteger(height)
        && x >= 0
        && y >= 0
        && width > 0
        && height > 0
        && x + width <= codedWidth
        && y + height <= codedHeight;
}

function isRawVideoPlane(
    value: unknown,
    expectedKind: RawVideoPlaneDescriptor['kind'],
    format: SupportedRawVideoFrameFormat,
    codedWidth: number,
    codedHeight: number,
    expectedByteOffset: number
): value is RawVideoPlaneDescriptor {
    if (!isRecord(value) || value.kind !== expectedKind) {
        return false;
    }

    const isChromaPlane = expectedKind !== 'y';
    const expectedWidth = isChromaPlane ? Math.ceil(codedWidth / 2) : codedWidth;
    const expectedHeight = isChromaPlane ? Math.ceil(codedHeight / 2) : codedHeight;
    const expectedBytesPerComponent = format === 'I420P10' || format === 'I420P12' ? 2 : 1;
    const expectedComponentsPerTexel = expectedKind === 'uv' ? 2 : 1;
    const rowByteLength = expectedWidth
        * expectedBytesPerComponent
        * expectedComponentsPerTexel;
    const bytesPerRow = Number(value.bytesPerRow);
    const byteLength = Number(value.byteLength);
    return value.byteOffset === expectedByteOffset
        && value.bytesPerComponent === expectedBytesPerComponent
        && value.componentsPerTexel === expectedComponentsPerTexel
        && value.width === expectedWidth
        && value.height === expectedHeight
        && value.rowByteLength === rowByteLength
        && Number.isSafeInteger(bytesPerRow)
        && bytesPerRow >= rowByteLength
        && bytesPerRow % RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT === 0
        && Number.isSafeInteger(byteLength)
        && byteLength === bytesPerRow * expectedHeight;
}

function isTransferableRawVideoFrame(value: unknown): value is TransferableRawVideoFrame {
    if (!isRecord(value)) {
        return false;
    }

    const formatValidation = getRawVideoFormatValidation(value.format);
    const codedWidth = Number(value.codedWidth);
    const codedHeight = Number(value.codedHeight);
    if (
        !formatValidation
        || !(value.data instanceof ArrayBuffer)
        || !isPositiveInteger(value.codedWidth)
        || !isPositiveInteger(value.codedHeight)
        || Number(value.codedWidth) > MAXIMUM_RAW_VIDEO_CODED_WIDTH
        || Number(value.codedHeight) > MAXIMUM_RAW_VIDEO_CODED_HEIGHT
        || !isPositiveInteger(value.displayWidth)
        || !isPositiveInteger(value.displayHeight)
        || value.bitDepth !== formatValidation.bitDepth
        || !isRawVideoColorSpace(value.colorSpace)
        || !isMicroseconds(value.timestampMicroseconds)
        || !(value.durationMicroseconds === null
            || (isMicroseconds(value.durationMicroseconds)
                && Number(value.durationMicroseconds) >= 0))
        || !isRawVideoRectangle(value.visibleRectangle, codedWidth, codedHeight)
        || !Array.isArray(value.planes)
        || value.planes.length !== formatValidation.planeKinds.length
    ) {
        return false;
    }

    let expectedByteOffset = 0;
    for (let planeIndex = 0; planeIndex < value.planes.length; planeIndex += 1) {
        const plane = value.planes[planeIndex];
        if (!isRawVideoPlane(
            plane,
            formatValidation.planeKinds[planeIndex],
            value.format as SupportedRawVideoFrameFormat,
            codedWidth,
            codedHeight,
            expectedByteOffset
        )) {
            return false;
        }
        expectedByteOffset += Number((plane as RawVideoPlaneDescriptor).byteLength);
    }
    return expectedByteOffset === value.data.byteLength
        && expectedByteOffset <= MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH;
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
        && isPositiveInteger(value.sampleRate)
        && Number(value.sampleRate) <= MAX_DECODED_AUDIO_SAMPLE_RATE;
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
            const hasValidVideoOutput = value.videoOutputMode === 'raw-planes' ?
                isRawVideoFrameFormat(value.rawVideoFrameFormat) :
                value.videoOutputMode === 'video-frame'
                    && value.rawVideoFrameFormat === null;
            return typeof value.url === 'string'
                && value.url.length > 0
                && isMicroseconds(value.startTimeMicroseconds)
                && isTrackIndex(value.videoTrackIndex)
                && isCodedDimensionBound(
                    value.maximumCodedWidth,
                    MAXIMUM_RAW_VIDEO_CODED_WIDTH
                )
                && isCodedDimensionBound(
                    value.maximumCodedHeight,
                    MAXIMUM_RAW_VIDEO_CODED_HEIGHT
                )
                && isVideoOutputMode(value.videoOutputMode)
                && isVideoDecoderBackend(value.videoDecoderBackend)
                && hasValidVideoOutput
                && isFrameCredit(value.frameCredits)
                && (value.videoOutputMode !== 'raw-planes'
                    || value.frameCredits === MAX_DECODED_RAW_FRAME_CREDITS)
                && (hasAudioTrack || hasNoAudioTrack)
                && hasValidAudioCredits
                && (hasAudioTrack || Number(value.audioSampleCredits) === 0);
        }
        case 'pull':
            return isFrameCredit(value.frameCredits);
        case 'pull-audio':
            return isAudioSampleCredit(value.audioSampleCredits, false);
        case 'recycle-frame':
            return value.buffer instanceof ArrayBuffer && value.buffer.byteLength > 0;
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
                && Number(value.codedHeight) <= MAXIMUM_RAW_VIDEO_CODED_HEIGHT
                && Number(value.codedWidth) <= MAXIMUM_RAW_VIDEO_CODED_WIDTH
                && isPositiveInteger(value.displayHeight)
                && isPositiveInteger(value.displayWidth)
                && Number(value.displayHeight) <= MAXIMUM_RAW_VIDEO_CODED_HEIGHT
                && Number(value.displayWidth) <= MAXIMUM_RAW_VIDEO_CODED_WIDTH
                && (value.audio === null || isAudioConfiguration(value.audio));
        case 'frame': {
            if (!isMicroseconds(value.mediaTimeMicroseconds)
                || !isMicroseconds(value.durationMicroseconds)
                || Number(value.durationMicroseconds) < 0
            ) {
                return false;
            }
            switch (value.outputMode) {
                case 'video-frame':
                    return isRecord(value.frame)
                        && typeof value.frame.close === 'function';
                case 'raw-planes':
                    return isTransferableRawVideoFrame(value.frame)
                        && value.frame.timestampMicroseconds === value.mediaTimeMicroseconds
                        && (value.frame.durationMicroseconds === null
                            || value.frame.durationMicroseconds === value.durationMicroseconds);
                default:
                    return false;
            }
        }
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
                && Number(value.sampleRate) <= MAX_DECODED_AUDIO_SAMPLE_RATE
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
