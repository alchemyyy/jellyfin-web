import { getPresentationInputColorMetadata } from '../PresentationInput';
import {
    jellyfinTicksToMicroseconds,
    type Microseconds
} from '../MediaTime';
import type {
    CustomAudioCodec,
    CustomDecodeCapabilities,
    CustomVideoCodec
} from './CustomDecodeCapabilities';
import type { CustomPlaybackRuntimeAvailability } from './CustomPlaybackRuntime';
import { requireMicroseconds } from './TimeMath';

const DIRECT_PLAY_METHOD = 'DIRECTPLAY';
const SUPPORTED_VIDEO_CONTAINERS = new Set([
    '3G2',
    '3GP',
    'M2TS',
    'M4V',
    'MATROSKA',
    'MJ2',
    'MKV',
    'MOV',
    'MP4',
    'MTS',
    'OGG',
    'TS',
    'WEBM'
]);

const VIDEO_CODEC_ALIASES: Readonly<Record<string, CustomVideoCodec>> = {
    AVC: 'h264',
    AVC1: 'h264',
    AV1: 'av1',
    H264: 'h264',
    H265: 'hevc',
    HEVC: 'hevc',
    VP8: 'vp8',
    VP9: 'vp9'
};

const AUDIO_CODEC_ALIASES: Readonly<Record<string, CustomAudioCodec>> = {
    AAC: 'aac',
    FLAC: 'flac',
    MP3: 'mp3',
    OPUS: 'opus',
    VORBIS: 'vorbis'
};

type MediaStream = {
    Codec?: unknown
    Index?: unknown
    Rotation?: unknown
    Type?: unknown
};

type MediaSource = {
    Container?: unknown
    DefaultAudioStreamIndex?: unknown
    IsInfiniteStream?: unknown
    LiveStreamId?: unknown
    MediaStreams?: unknown
    RunTimeTicks?: unknown
};

type PlaybackOptions = {
    mediaSource?: MediaSource
    playMethod?: unknown
    playerStartPositionTicks?: unknown
    url?: unknown
};

type ParsedPlaybackSource = {
    durationMicroseconds: Microseconds
    mediaSource: MediaSource
    parsed: true
    startTimeMicroseconds: Microseconds
    streams: MediaStream[]
    url: string
};

type PlaybackSourceParseResult = ParsedPlaybackSource | (IneligibleCustomPlayback & {
    parsed: false
});

type AudioStreamSelection =
    | { status: 'invalid' | 'none' }
    | { status: 'selected', stream: MediaStream, streamIndex: number };

type VideoStreamSelection =
    | { status: 'invalid' }
    | { status: 'selected', stream: MediaStream, streamIndex: number };

export type CustomPlaybackIneligibilityReason =
    | 'audio-codec-unsupported'
    | 'audio-track-invalid'
    | 'codec-unsupported'
    | 'container-unsupported'
    | 'duration-unavailable'
    | 'hdr-validation-required'
    | 'invalid-options'
    | 'live-stream-unsupported'
    | 'metadata-unsupported'
    | 'play-method-unsupported'
    | 'rotation-unsupported'
    | 'runtime-unavailable'
    | 'url-unsupported'
    | 'video-track-unavailable';

export type CustomPlaybackEligibilityOptions = {
    allowHDR: boolean
    runtimeAvailability: CustomPlaybackRuntimeAvailability
};

export type EligibleCustomPlayback = {
    audioTrackIndex: number | null
    durationMicroseconds: Microseconds
    eligible: true
    hdr: boolean
    startTimeMicroseconds: Microseconds
    url: string
    videoTrackIndex: number
};

export type IneligibleCustomPlayback = {
    eligible: false
    reason: CustomPlaybackIneligibilityReason
};

export type CustomPlaybackEligibility = EligibleCustomPlayback | IneligibleCustomPlayback;

function normalizeMetadataValue(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalizedValue = value.trim().toUpperCase();
    return normalizedValue || null;
}

function getHTTPURL(value: unknown): string | null {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }

    try {
        const parsedURL = new URL(value, globalThis.location?.href);
        switch (parsedURL.protocol) {
            case 'http:':
            case 'https:':
                return parsedURL.href;
            default:
                return null;
        }
    } catch {
        return null;
    }
}

function ticksToMicroseconds(value: unknown, defaultValue: number | null): Microseconds | null {
    if (value == null && defaultValue !== null) {
        return requireMicroseconds(defaultValue);
    }
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        return null;
    }

    return jellyfinTicksToMicroseconds(Number(value));
}

function getContainerTokens(value: unknown): string[] {
    if (typeof value !== 'string') {
        return [];
    }

    const tokens: string[] = [];
    for (const token of value.split(',')) {
        const normalizedToken = normalizeMetadataValue(token);
        if (normalizedToken) {
            tokens.push(normalizedToken);
        }
    }
    return tokens;
}

function getStreams(mediaSource: MediaSource): MediaStream[] {
    const streams: MediaStream[] = [];
    if (!Array.isArray(mediaSource.MediaStreams)) {
        return streams;
    }

    for (const stream of mediaSource.MediaStreams) {
        if (stream && typeof stream === 'object') {
            streams.push(stream as MediaStream);
        }
    }
    return streams;
}

function getTrackIndex(stream: MediaStream, fallbackIndex: number): number | null {
    const streamIndex = stream.Index ?? fallbackIndex;
    return Number.isSafeInteger(streamIndex) && Number(streamIndex) >= 0 ?
        Number(streamIndex) :
        null;
}

function getSelectedAudioStream(
    mediaSource: MediaSource,
    streams: readonly MediaStream[]
): AudioStreamSelection {
    const audioStreams: Array<{ stream: MediaStream, streamIndex: number }> = [];
    for (let streamPosition = 0; streamPosition < streams.length; streamPosition += 1) {
        const stream = streams[streamPosition];
        if (normalizeMetadataValue(stream.Type) !== 'AUDIO') {
            continue;
        }
        const streamIndex = getTrackIndex(stream, streamPosition);
        if (streamIndex === null) {
            return { status: 'invalid' };
        }
        audioStreams.push({ stream, streamIndex });
    }
    if (audioStreams.length === 0) {
        return { status: 'none' };
    }

    const requestedIndex = mediaSource.DefaultAudioStreamIndex;
    if (requestedIndex == null) {
        return { ...audioStreams[0], status: 'selected' };
    }
    if (!Number.isSafeInteger(requestedIndex) || Number(requestedIndex) < 0) {
        return { status: 'invalid' };
    }

    const selectedAudioStream = audioStreams.find(audioStream => (
        audioStream.streamIndex === requestedIndex
    ));
    return selectedAudioStream ?
        { ...selectedAudioStream, status: 'selected' } :
        { status: 'invalid' };
}

function hasUnsupportedRotation(stream: MediaStream): boolean {
    if (stream.Rotation == null || stream.Rotation === '') {
        return false;
    }
    return !Number.isFinite(Number(stream.Rotation)) || Number(stream.Rotation) !== 0;
}

function parsePlaybackSource(
    options: unknown,
    runtimeAvailability: CustomPlaybackRuntimeAvailability
): PlaybackSourceParseResult {
    if (!runtimeAvailability.available) {
        return { eligible: false, parsed: false, reason: 'runtime-unavailable' };
    }
    if (!options || typeof options !== 'object') {
        return { eligible: false, parsed: false, reason: 'invalid-options' };
    }

    const playbackOptions = options as PlaybackOptions;
    if (normalizeMetadataValue(playbackOptions.playMethod) !== DIRECT_PLAY_METHOD) {
        return { eligible: false, parsed: false, reason: 'play-method-unsupported' };
    }
    const mediaSource = playbackOptions.mediaSource;
    if (!mediaSource || typeof mediaSource !== 'object') {
        return { eligible: false, parsed: false, reason: 'invalid-options' };
    }
    if (mediaSource.LiveStreamId || mediaSource.IsInfiniteStream === true) {
        return { eligible: false, parsed: false, reason: 'live-stream-unsupported' };
    }
    if (!getContainerTokens(mediaSource.Container).some(container => (
        SUPPORTED_VIDEO_CONTAINERS.has(container)
    ))) {
        return { eligible: false, parsed: false, reason: 'container-unsupported' };
    }

    const durationMicroseconds = ticksToMicroseconds(mediaSource.RunTimeTicks, null);
    const startTimeMicroseconds = ticksToMicroseconds(
        playbackOptions.playerStartPositionTicks,
        0
    );
    if (durationMicroseconds === null || durationMicroseconds <= 0) {
        return { eligible: false, parsed: false, reason: 'duration-unavailable' };
    }
    if (startTimeMicroseconds === null) {
        return { eligible: false, parsed: false, reason: 'invalid-options' };
    }

    const url = getHTTPURL(playbackOptions.url);
    if (!url) {
        return { eligible: false, parsed: false, reason: 'url-unsupported' };
    }

    return {
        durationMicroseconds,
        mediaSource,
        parsed: true,
        startTimeMicroseconds,
        streams: getStreams(mediaSource),
        url
    };
}

function selectVideoStream(streams: readonly MediaStream[]): VideoStreamSelection {
    const videoStreams: Array<{ stream: MediaStream, streamIndex: number }> = [];
    for (let streamPosition = 0; streamPosition < streams.length; streamPosition += 1) {
        const stream = streams[streamPosition];
        if (normalizeMetadataValue(stream.Type) !== 'VIDEO') {
            continue;
        }
        const streamIndex = getTrackIndex(stream, streamPosition);
        if (streamIndex === null) {
            return { status: 'invalid' };
        }
        videoStreams.push({ stream, streamIndex });
    }

    return videoStreams.length === 1 ?
        { ...videoStreams[0], status: 'selected' } :
        { status: 'invalid' };
}

/** Selects only a direct VOD source the complete measured client pipeline can own. */
export function getCustomPlaybackEligibility(
    options: unknown,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions
): CustomPlaybackEligibility {
    const parsedSource = parsePlaybackSource(
        options,
        eligibilityOptions.runtimeAvailability
    );
    if (!parsedSource.parsed) {
        return { eligible: false, reason: parsedSource.reason };
    }

    const selectedVideo = selectVideoStream(parsedSource.streams);
    if (selectedVideo.status === 'invalid') {
        return { eligible: false, reason: 'video-track-unavailable' };
    }

    const videoCodec = VIDEO_CODEC_ALIASES[normalizeMetadataValue(selectedVideo.stream.Codec) ?? ''];
    if (!videoCodec || capabilities.video[videoCodec].status !== 'supported') {
        return { eligible: false, reason: 'codec-unsupported' };
    }
    if (hasUnsupportedRotation(selectedVideo.stream)) {
        return { eligible: false, reason: 'rotation-unsupported' };
    }

    const colorMetadata = getPresentationInputColorMetadata(options);
    if (!colorMetadata) {
        return { eligible: false, reason: 'metadata-unsupported' };
    }
    const hdr = colorMetadata.transfer !== 'sdr';
    if (hdr && !eligibilityOptions.allowHDR) {
        return { eligible: false, reason: 'hdr-validation-required' };
    }

    const selectedAudio = getSelectedAudioStream(
        parsedSource.mediaSource,
        parsedSource.streams
    );
    if (selectedAudio.status === 'invalid') {
        return { eligible: false, reason: 'audio-track-invalid' };
    }
    let audioTrackIndex: number | null = null;
    if (selectedAudio.status === 'selected') {
        const audioCodec = AUDIO_CODEC_ALIASES[normalizeMetadataValue(selectedAudio.stream.Codec) ?? ''];
        if (!audioCodec || capabilities.audio[audioCodec].status !== 'supported') {
            return { eligible: false, reason: 'audio-codec-unsupported' };
        }
        audioTrackIndex = selectedAudio.streamIndex;
    }

    return {
        audioTrackIndex,
        durationMicroseconds: parsedSource.durationMicroseconds,
        eligible: true,
        hdr,
        startTimeMicroseconds: parsedSource.startTimeMicroseconds,
        url: parsedSource.url,
        videoTrackIndex: selectedVideo.streamIndex
    };
}
