import type { Microseconds } from '../MediaTime';
import {
    isTransferableDolbyVisionEncodedFrameMetadata,
    type TransferableDolbyVisionEncodedFrameMetadata
} from './DolbyVisionEncodedMetadataProtocol';
import {
    MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH,
    MAXIMUM_NATIVE_AUDIO_SEGMENT_DURATION_MICROSECONDS
} from './NativeMediaAudioLimits';
import {
    MAXIMUM_COMPOUND_RAW_FRAME_COPY_BYTE_LENGTH,
    MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH,
    MAXIMUM_RAW_VIDEO_CODED_HEIGHT,
    MAXIMUM_RAW_VIDEO_CODED_WIDTH,
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    type RawVideoPlaneDescriptor,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from './RawVideoFrameCopy';
import {
    isStaticHDRMetadataScanResult,
    type StaticHDRMetadataScanResult
} from './StaticHDRMetadata';

export const MAX_DECODED_FRAME_CREDITS = 4;
export const MAX_DECODED_RAW_FRAME_CREDITS = 2;
export const MAX_DECODED_AUDIO_SAMPLE_CREDITS = 8;
export const MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE = 65_536;
export const MAX_DECODED_AUDIO_CHANNELS = 32;
export const MAX_DECODED_AUDIO_SAMPLE_RATE = 192_000;
export const MAXIMUM_VIDEO_STARTUP_PROGRESS_PACKET_COUNT = 512;
const MAXIMUM_CODEC_ASSET_URL_LENGTH = 2_048;

export type CustomDecodeVideoOutputMode = 'raw-planes' | 'video-frame';
export type CustomDecodeRawVideoFrameFormat = 'I420P10' | 'I420P12';
export type CustomDecodeVideoDecoderBackend =
    | 'bundled-hevc'
    | 'legacy-software'
    | 'native'
    | 'openjpeg';
export type CustomDecodeAudioOutputMode = 'decoded-pcm' | 'native-media';
export type CustomDecodeDolbyVisionProfile = 5 | 7 | 8 | null;
export type CustomDecodeNativeHDRTransfer = 'hlg' | 'pq' | null;
export type CustomDecodeWorkerProgressPhase =
    | 'video-decoder-ready'
    | 'video-key-packet-ready'
    | 'video-packet-decoded'
    | 'video-packet-started';

/** Matches a qualified decoder backend to its measured acceleration preference. */
export function getCustomDecodeHardwareAcceleration(
    videoOutputMode: CustomDecodeVideoOutputMode,
    videoDecoderBackend: CustomDecodeVideoDecoderBackend = 'native'
): HardwareAcceleration {
    if (videoDecoderBackend !== 'native') {
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
    /** Defaults to decoded-pcm for compatibility with existing session callers. */
    audioOutputMode?: CustomDecodeAudioOutputMode
    audioSampleCredits: number
    /** Zero-based ordinal within input.getAudioTracks(), not a Jellyfin stream index. */
    audioTrackIndex: number | null
    dolbyVisionProfile: CustomDecodeDolbyVisionProfile
    dolbyVisionRPUParserWASMURL: string
    frameCredits: number
    generation: number
    maximumCodedHeight: number
    maximumCodedWidth: number
    nativeHDRTransfer: CustomDecodeNativeHDRTransfer
    neutralizeHDRColorMetadata: boolean
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
    sourceChannelCount?: number
    sourceSampleRate?: number
};

export type DecodeWorkerNativeMediaAudioConfiguration = DecodeWorkerAudioConfiguration & {
    mimeType: string
    outputMode: 'native-media'
};

export type DecodeWorkerReadyAudioConfiguration =
    | DecodeWorkerAudioConfiguration
    | DecodeWorkerNativeMediaAudioConfiguration;

export type DecodeWorkerReadyResponse = {
    audio: DecodeWorkerReadyAudioConfiguration | null
    codec: string
    codedHeight: number
    codedWidth: number
    displayHeight: number
    displayWidth: number
    generation: number
    staticHDRMetadataScan?: StaticHDRMetadataScanResult
    type: 'ready'
};

type DecodeWorkerFrameResponseBase = {
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata?: TransferableDolbyVisionEncodedFrameMetadata
    generation: number
    mediaTimeMicroseconds: Microseconds
    type: 'frame'
};

export type DecodeWorkerVideoFrameResponse = DecodeWorkerFrameResponseBase & {
    frame: VideoFrame
    outputMode: 'video-frame'
};

export type DecodeWorkerRawFrameResponse = DecodeWorkerFrameResponseBase & {
    enhancementFrame?: TransferableRawVideoFrame | null
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

export type DecodeWorkerNativeAudioInitializationResponse = {
    data: ArrayBuffer
    generation: number
    type: 'native-audio-init'
};

export type DecodeWorkerNativeAudioMediaResponse = {
    data: ArrayBuffer
    endTimeMicroseconds: Microseconds
    generation: number
    startTimeMicroseconds: Microseconds
    type: 'native-audio-media'
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

export type DecodeWorkerProgressResponse = {
    generation: number
    mediaTimeMicroseconds: Microseconds | null
    packetCount: number
    phase: CustomDecodeWorkerProgressPhase
    type: 'progress'
};

export type DecodeWorkerResponse =
    | DecodeWorkerAudioResponse
    | DecodeWorkerEndedResponse
    | DecodeWorkerErrorResponse
    | DecodeWorkerFrameResponse
    | DecodeWorkerNativeAudioInitializationResponse
    | DecodeWorkerNativeAudioMediaResponse
    | DecodeWorkerProgressResponse
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

function isVideoStartupProgressPacketCount(value: unknown): value is number {
    return Number.isSafeInteger(value)
        && Number(value) >= 0
        && Number(value) <= MAXIMUM_VIDEO_STARTUP_PROGRESS_PACKET_COUNT;
}

function isCustomDecodeWorkerProgressPhase(
    value: unknown
): value is CustomDecodeWorkerProgressPhase {
    switch (value) {
        case 'video-decoder-ready':
        case 'video-key-packet-ready':
        case 'video-packet-decoded':
        case 'video-packet-started':
            return true;
        default:
            return false;
    }
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
    return value === 'bundled-hevc'
        || value === 'legacy-software'
        || value === 'native'
        || value === 'openjpeg';
}

function isNativeHDRTransfer(value: unknown): value is CustomDecodeNativeHDRTransfer {
    return value === null || value === 'hlg' || value === 'pq';
}

function isAudioOutputMode(value: unknown): value is CustomDecodeAudioOutputMode {
    return value === 'decoded-pcm' || value === 'native-media';
}

function isRawVideoFrameFormat(value: unknown): value is CustomDecodeRawVideoFrameFormat {
    return value === 'I420P10' || value === 'I420P12';
}

function isCodecAssetURL(value: unknown): value is string {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > MAXIMUM_CODEC_ASSET_URL_LENGTH) {
        return false;
    }
    try {
        const parsedURL = new URL(value);
        return (parsedURL.protocol === 'http:' || parsedURL.protocol === 'https:')
            && parsedURL.username.length === 0
            && parsedURL.password.length === 0;
    } catch {
        return false;
    }
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
    const frameEndOffset = getTransferableRawVideoFrameEndOffset(value, 0);
    return frameEndOffset !== null
        && (value as TransferableRawVideoFrame).data.byteLength === frameEndOffset;
}

function getTransferableRawVideoFrameEndOffset(
    value: unknown,
    expectedStartOffset: number
): number | null {
    if (!isRecord(value)) {
        return null;
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
        return null;
    }

    let expectedByteOffset = expectedStartOffset;
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
            return null;
        }
        expectedByteOffset += Number((plane as RawVideoPlaneDescriptor).byteLength);
    }
    const frameByteLength = expectedByteOffset - expectedStartOffset;
    return frameByteLength > 0
        && frameByteLength <= MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH
        && expectedByteOffset <= value.data.byteLength ?
        expectedByteOffset :
        null;
}

function isTransferableRawVideoFramePair(
    baseFrameValue: unknown,
    enhancementFrameValue: unknown
): boolean {
    const baseFrameEndOffset = getTransferableRawVideoFrameEndOffset(baseFrameValue, 0);
    if (baseFrameEndOffset === null) {
        return false;
    }
    const baseFrame = baseFrameValue as TransferableRawVideoFrame;
    if (
        baseFrame.data.byteLength <= baseFrameEndOffset
        || baseFrame.data.byteLength > MAXIMUM_COMPOUND_RAW_FRAME_COPY_BYTE_LENGTH
    ) {
        return false;
    }
    if (enhancementFrameValue === null) {
        return true;
    }

    const enhancementFrameOffset = Math.ceil(
        baseFrameEndOffset / RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT
    ) * RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT;
    const enhancementFrameEndOffset = getTransferableRawVideoFrameEndOffset(
        enhancementFrameValue,
        enhancementFrameOffset
    );
    if (enhancementFrameEndOffset === null) {
        return false;
    }
    const enhancementFrame = enhancementFrameValue as TransferableRawVideoFrame;
    return enhancementFrame.data === baseFrame.data
        && enhancementFrameEndOffset === baseFrame.data.byteLength
        && enhancementFrame.format === baseFrame.format
        && Math.abs(
            enhancementFrame.timestampMicroseconds - baseFrame.timestampMicroseconds
        ) <= 1;
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

function isAudioConfiguration(value: unknown): value is DecodeWorkerReadyAudioConfiguration {
    if (!isRecord(value)) {
        return false;
    }

    const commonFieldsValid = typeof value.codec === 'string'
        && value.codec.length > 0
        && isPositiveInteger(value.channelCount)
        && Number(value.channelCount) <= MAX_DECODED_AUDIO_CHANNELS
        && isPositiveInteger(value.sampleRate)
        && Number(value.sampleRate) <= MAX_DECODED_AUDIO_SAMPLE_RATE;
    if (!commonFieldsValid) {
        return false;
    }
    if ((value.sourceChannelCount !== undefined
            && (!isPositiveInteger(value.sourceChannelCount)
                || Number(value.sourceChannelCount) > MAX_DECODED_AUDIO_CHANNELS))
        || (value.sourceSampleRate !== undefined
            && (!isPositiveInteger(value.sourceSampleRate)
                || Number(value.sourceSampleRate) > MAX_DECODED_AUDIO_SAMPLE_RATE))) {
        return false;
    }
    if (value.outputMode === undefined) {
        return true;
    }
    return value.outputMode === 'native-media'
        && (value.codec === 'ac-3' || value.codec === 'ec-3')
        && (value.channelCount === 2 || value.channelCount === 6)
        && value.sampleRate === 48_000
        && typeof value.mimeType === 'string'
        && value.mimeType.length > 0;
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

function hasValidOptionalDolbyVisionMetadata(value: Record<string, unknown>): boolean {
    return value.encodedDolbyVisionMetadata === undefined
        || isTransferableDolbyVisionEncodedFrameMetadata(
            value.encodedDolbyVisionMetadata
        );
}

function isDolbyVisionProfile(value: unknown): value is CustomDecodeDolbyVisionProfile {
    return value === null || value === 5 || value === 7 || value === 8;
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
            const audioOutputMode = value.audioOutputMode ?? 'decoded-pcm';
            const hasValidVideoOutput = value.videoOutputMode === 'raw-planes' ?
                isRawVideoFrameFormat(value.rawVideoFrameFormat) :
                value.videoOutputMode === 'video-frame'
                    && value.rawVideoFrameFormat === null;
            const hasValidOpenJPEGRoute = value.videoDecoderBackend !== 'openjpeg'
                || (value.videoOutputMode === 'video-frame'
                    && value.rawVideoFrameFormat === null
                    && value.dolbyVisionProfile === null
                    && value.neutralizeHDRColorMetadata === false
                    && value.nativeHDRTransfer === null);
            const hasValidLegacySoftwareRoute =
                value.videoDecoderBackend !== 'legacy-software'
                || (value.videoOutputMode === 'video-frame'
                    && value.rawVideoFrameFormat === null
                    && value.dolbyVisionProfile === null
                    && value.neutralizeHDRColorMetadata === false
                    && value.nativeHDRTransfer === null);
            return typeof value.url === 'string'
                && value.url.length > 0
                && isDolbyVisionProfile(value.dolbyVisionProfile)
                && isCodecAssetURL(value.dolbyVisionRPUParserWASMURL)
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
                && isNativeHDRTransfer(value.nativeHDRTransfer)
                && typeof value.neutralizeHDRColorMetadata === 'boolean'
                && (value.neutralizeHDRColorMetadata ?
                    (value.nativeHDRTransfer !== null
                        && value.videoOutputMode === 'video-frame'
                        && value.videoDecoderBackend === 'native'
                        && value.dolbyVisionProfile === null) :
                    value.nativeHDRTransfer === null)
                && hasValidVideoOutput
                && hasValidOpenJPEGRoute
                && hasValidLegacySoftwareRoute
                && isFrameCredit(value.frameCredits)
                && (value.videoOutputMode !== 'raw-planes'
                    || value.frameCredits === MAX_DECODED_RAW_FRAME_CREDITS)
                && (hasAudioTrack || hasNoAudioTrack)
                && isAudioOutputMode(audioOutputMode)
                && (hasAudioTrack || value.audioOutputMode === undefined)
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

function isDecodeWorkerFrameResponse(value: Record<string, unknown>): boolean {
    if (!isMicroseconds(value.mediaTimeMicroseconds)
        || !isMicroseconds(value.durationMicroseconds)
        || Number(value.durationMicroseconds) < 0
        || !hasValidOptionalDolbyVisionMetadata(value)
    ) {
        return false;
    }
    switch (value.outputMode) {
        case 'video-frame':
            return isRecord(value.frame)
                && typeof value.frame.close === 'function';
        case 'raw-planes': {
            const hasValidFrame = (
                Object.prototype.hasOwnProperty.call(value, 'enhancementFrame') ?
                    isTransferableRawVideoFramePair(
                        value.frame,
                        value.enhancementFrame
                    ) :
                    isTransferableRawVideoFrame(value.frame)
            );
            if (!hasValidFrame) {
                return false;
            }
            const frame = value.frame as TransferableRawVideoFrame;
            return frame.timestampMicroseconds === value.mediaTimeMicroseconds
                && (frame.durationMicroseconds === null
                    || frame.durationMicroseconds === value.durationMicroseconds);
        }
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
                && (value.audio === null || isAudioConfiguration(value.audio))
                && (!Object.prototype.hasOwnProperty.call(value, 'staticHDRMetadataScan')
                    || isStaticHDRMetadataScanResult(value.staticHDRMetadataScan));
        case 'frame':
            return isDecodeWorkerFrameResponse(value);
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
        case 'native-audio-init':
            return value.data instanceof ArrayBuffer
                && value.data.byteLength > 0
                && value.data.byteLength <= MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH;
        case 'native-audio-media': {
            if (!(value.data instanceof ArrayBuffer)
                || value.data.byteLength <= 0
                || value.data.byteLength > MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH
                || !isMicroseconds(value.startTimeMicroseconds)
                || !isMicroseconds(value.endTimeMicroseconds)) {
                return false;
            }
            const durationMicroseconds = Number(value.endTimeMicroseconds)
                - Number(value.startTimeMicroseconds);
            return durationMicroseconds > 0
                && durationMicroseconds <= MAXIMUM_NATIVE_AUDIO_SEGMENT_DURATION_MICROSECONDS;
        }
        case 'progress':
            return isCustomDecodeWorkerProgressPhase(value.phase)
                && isVideoStartupProgressPacketCount(value.packetCount)
                && (value.mediaTimeMicroseconds === null
                    || isMicroseconds(value.mediaTimeMicroseconds));
        case 'ended':
        case 'stopped':
            return true;
        case 'error':
            return isFailureKind(value.failureKind) && typeof value.message === 'string';
        default:
            return false;
    }
}
