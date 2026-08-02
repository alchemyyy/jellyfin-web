import { getPresentationInputColorMetadata } from '../PresentationInput';
import {
    jellyfinTicksToMicroseconds,
    type Microseconds
} from '../MediaTime';
import {
    CUSTOM_BUNDLED_AUDIO_CODECS,
    CUSTOM_NATIVE_VIDEO_BIT_DEPTH,
    CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT,
    CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH,
    CUSTOM_RAW_HDR_VIDEO_MAXIMUM_FRAMES_PER_SECOND,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomRawHDRVideoCodec,
    type CustomRawHDRVideoCodecCapability,
    type CustomVideoCodec
} from './CustomDecodeCapabilities';
import {
    getSupportedNativeMediaAudioRoute,
    type NativeMediaAudioCapabilities,
    type NativeMediaAudioCodec
} from './NativeMediaAudioCapabilities';
import type { BundledHEVCExactTierCapability } from './HEVCExactCapabilityProbe';
import {
    getCustomPlaybackRuntimeAvailability,
    type CustomPlaybackRuntimeAvailability,
    type CustomPlaybackRuntimeRequirements
} from './CustomPlaybackRuntime';
import { isSupportedCustomAudioOutputLayout } from './CustomAudioOutputPolicy';
import { supportsH264JellyfinProfile } from './H264ProfileCapabilities';
import {
    getRawHDRAuthorizationRouteKey,
    type RawHDRAuthorizationRouteKey
} from '../validation/RawHDRPresentationAuthorization';
import type {
    CustomDecodeAudioOutputMode,
    CustomDecodeRawVideoFrameFormat,
    CustomDecodeVideoDecoderBackend,
    CustomDecodeVideoOutputMode
} from './DecodeWorkerProtocol';
import { requireMicroseconds } from './TimeMath';

const DIRECT_PLAY_METHOD = 'DIRECTPLAY';
const BUNDLED_AUDIO_CODEC_SET = new Set<CustomAudioCodec>(CUSTOM_BUNDLED_AUDIO_CODECS);
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
    'TS',
    'WEBM'
]);

type ContainerCodecRule = {
    audioCodecs: ReadonlySet<CustomAudioCodec>
    containers: ReadonlySet<string>
    videoCodecs: ReadonlySet<CustomVideoCodec>
};

const ISO_BASE_MEDIA_CONTAINER_RULE: ContainerCodecRule = {
    audioCodecs: new Set([ 'aac', 'opus', 'flac', 'mp3', 'vorbis', 'ac3', 'eac3' ]),
    containers: new Set([ 'MP4', 'M4V', 'MOV', '3GP', '3G2', 'MJ2' ]),
    videoCodecs: new Set([ 'h264', 'hevc', 'vp8', 'vp9', 'av1' ])
};
const MATROSKA_CONTAINER_RULE: ContainerCodecRule = {
    audioCodecs: ISO_BASE_MEDIA_CONTAINER_RULE.audioCodecs,
    containers: new Set([ 'MKV', 'MATROSKA' ]),
    videoCodecs: ISO_BASE_MEDIA_CONTAINER_RULE.videoCodecs
};
const WEBM_CONTAINER_RULE: ContainerCodecRule = {
    audioCodecs: new Set([ 'opus', 'vorbis' ]),
    containers: new Set([ 'WEBM' ]),
    videoCodecs: new Set([ 'vp8', 'vp9', 'av1' ])
};
const MPEG_TS_CONTAINER_RULE: ContainerCodecRule = {
    audioCodecs: new Set([ 'aac', 'mp3', 'ac3', 'eac3' ]),
    containers: new Set([ 'TS', 'M2TS', 'MTS' ]),
    videoCodecs: new Set([ 'h264', 'hevc' ])
};
const CONTAINER_CODEC_RULES: readonly ContainerCodecRule[] = [
    ISO_BASE_MEDIA_CONTAINER_RULE,
    MATROSKA_CONTAINER_RULE,
    WEBM_CONTAINER_RULE,
    MPEG_TS_CONTAINER_RULE
];

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
    'AC-3': 'ac3',
    AC3: 'ac3',
    'E-AC-3': 'eac3',
    'EC-3': 'eac3',
    EAC3: 'eac3',
    EC3: 'eac3',
    FLAC: 'flac',
    MP3: 'mp3',
    OPUS: 'opus',
    VORBIS: 'vorbis'
};

type MediaStream = {
    AverageFrameRate?: unknown
    BitDepth?: unknown
    BitRate?: unknown
    Channels?: unknown
    Codec?: unknown
    Height?: unknown
    Index?: unknown
    IsInterlaced?: unknown
    Level?: unknown
    Profile?: unknown
    RealFrameRate?: unknown
    Rotation?: unknown
    SampleRate?: unknown
    Type?: unknown
    Width?: unknown
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
    containerTokens: string[]
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
    | { status: 'selected', stream: MediaStream, trackOrdinal: number };

type VideoStreamSelection =
    | { status: 'invalid' }
    | { status: 'selected', stream: MediaStream, trackOrdinal: number };

type VideoOutputSelection =
    | {
        hdr: boolean
        maximumCodedHeight: number
        maximumCodedWidth: number
        nativeVideoDecoderRequired: boolean
        rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
        status: 'selected'
        videoDecoderBackend: CustomDecodeVideoDecoderBackend
        videoOutputMode: CustomDecodeVideoOutputMode
    }
    | { reason: CustomPlaybackIneligibilityReason, status: 'invalid' };

type TypedStreamCandidate = {
    jellyfinStreamIndex: number
    stream: MediaStream
};

type AudioOutputSelection =
    | {
        outputMode: CustomDecodeAudioOutputMode
        status: 'selected'
    }
    | {
        reason: 'audio-codec-unsupported' | 'audio-layout-unsupported'
        status: 'invalid'
    };

export type CustomPlaybackIneligibilityReason =
    | 'audio-codec-unsupported'
    | 'audio-layout-unsupported'
    | 'audio-track-invalid'
    | 'codec-unsupported'
    | 'container-unsupported'
    | 'duration-unavailable'
    | 'hdr-codec-unsupported'
    | 'hdr-presentation-unavailable'
    | 'invalid-options'
    | 'interlaced-video-unsupported'
    | 'live-stream-unsupported'
    | 'metadata-unsupported'
    | 'play-method-unsupported'
    | 'rotation-unsupported'
    | 'runtime-unavailable'
    | 'url-unsupported'
    | 'video-track-unavailable';

export type CustomPlaybackEligibilityOptions = {
    allowRawHDR: boolean
    authorizedRawHDRRouteKeys?: readonly RawHDRAuthorizationRouteKey[]
    nativeMediaAudioCapabilities?: NativeMediaAudioCapabilities | null
    runtimeAvailability: CustomPlaybackRuntimeAvailability
};

export type EligibleCustomPlayback = {
    audioOutputMode: CustomDecodeAudioOutputMode | null
    /** Zero-based ordinal within container audio tracks, not MediaStream.Index. */
    audioTrackIndex: number | null
    durationMicroseconds: Microseconds
    eligible: true
    hdr: boolean
    maximumCodedHeight: number
    maximumCodedWidth: number
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    startTimeMicroseconds: Microseconds
    url: string
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    videoOutputMode: CustomDecodeVideoOutputMode
    /** Zero-based ordinal within container video tracks, not MediaStream.Index. */
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
        if (parsedURL.username || parsedURL.password) {
            return null;
        }
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

function supportsContainerCodecCombination(
    containerTokens: readonly string[],
    videoCodec: CustomVideoCodec,
    audioCodec: CustomAudioCodec | null
): boolean {
    for (const rule of CONTAINER_CODEC_RULES) {
        if (!containerTokens.some(container => rule.containers.has(container))
            || !rule.videoCodecs.has(videoCodec)
            || (audioCodec !== null && !rule.audioCodecs.has(audioCodec))) {
            continue;
        }
        return true;
    }
    return false;
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

function getJellyfinStreamIndex(stream: MediaStream, fallbackIndex: number): number | null {
    const streamIndex = stream.Index ?? fallbackIndex;
    return Number.isSafeInteger(streamIndex) && Number(streamIndex) >= 0 ?
        Number(streamIndex) :
        null;
}

function getSelectedAudioStream(
    mediaSource: MediaSource,
    streams: readonly MediaStream[]
): AudioStreamSelection {
    const audioStreams: TypedStreamCandidate[] = [];
    for (let streamPosition = 0; streamPosition < streams.length; streamPosition += 1) {
        const stream = streams[streamPosition];
        if (normalizeMetadataValue(stream.Type) !== 'AUDIO') {
            continue;
        }
        const jellyfinStreamIndex = getJellyfinStreamIndex(stream, streamPosition);
        if (jellyfinStreamIndex === null) {
            return { status: 'invalid' };
        }
        audioStreams.push({
            jellyfinStreamIndex,
            stream
        });
    }
    audioStreams.sort((left, right) => left.jellyfinStreamIndex - right.jellyfinStreamIndex);
    if (audioStreams.length === 0) {
        return { status: 'none' };
    }

    const requestedIndex = mediaSource.DefaultAudioStreamIndex;
    if (requestedIndex == null) {
        return {
            status: 'selected',
            stream: audioStreams[0].stream,
            trackOrdinal: 0
        };
    }
    if (!Number.isSafeInteger(requestedIndex) || Number(requestedIndex) < 0) {
        return { status: 'invalid' };
    }

    const trackOrdinal = audioStreams.findIndex(audioStream => (
        audioStream.jellyfinStreamIndex === requestedIndex
    ));
    if (trackOrdinal < 0) {
        return { status: 'invalid' };
    }

    return {
        status: 'selected',
        stream: audioStreams[trackOrdinal].stream,
        trackOrdinal
    };
}

function hasUnsupportedRotation(stream: MediaStream): boolean {
    if (stream.Rotation == null || stream.Rotation === '') {
        return false;
    }
    return !Number.isFinite(Number(stream.Rotation)) || Number(stream.Rotation) !== 0;
}

function getRawVideoFrameFormat(bitDepth: number): CustomDecodeRawVideoFrameFormat | null {
    switch (bitDepth) {
        case 10:
            return 'I420P10';
        case 12:
            return 'I420P12';
        default:
            return null;
    }
}

function isPositiveSafeInteger(value: unknown): value is number {
    return Number.isSafeInteger(value) && Number(value) > 0;
}

function getNativeMediaAudioCodec(codec: CustomAudioCodec): NativeMediaAudioCodec | null {
    switch (codec) {
        case 'ac3':
        case 'eac3':
            return codec;
        case 'aac':
        case 'flac':
        case 'mp3':
        case 'opus':
        case 'vorbis':
            return null;
    }
}

function selectAudioOutput(
    codec: CustomAudioCodec,
    stream: MediaStream,
    capabilities: CustomDecodeCapabilities,
    nativeMediaAudioCapabilities: NativeMediaAudioCapabilities | null | undefined
): AudioOutputSelection {
    const nativeCodec = getNativeMediaAudioCodec(codec);
    if (nativeCodec && nativeMediaAudioCapabilities) {
        const nativeRoute = getSupportedNativeMediaAudioRoute(
            nativeMediaAudioCapabilities,
            nativeCodec,
            Number(stream.Channels),
            Number(stream.SampleRate)
        );
        if (nativeRoute) {
            return { outputMode: 'native-media', status: 'selected' };
        }
    }

    if (capabilities.audio[codec].status !== 'supported') {
        const nativeCodecSupported = nativeCodec !== null
            && nativeMediaAudioCapabilities?.audio[nativeCodec].status === 'supported';
        return {
            reason: nativeCodecSupported ?
                'audio-layout-unsupported' :
                'audio-codec-unsupported',
            status: 'invalid'
        };
    }
    if (!isSupportedCustomAudioOutputLayout(stream.Channels, stream.SampleRate)) {
        return { reason: 'audio-layout-unsupported', status: 'invalid' };
    }
    return { outputMode: 'decoded-pcm', status: 'selected' };
}

function getEffectiveVideoFrameRate(stream: MediaStream): number | null {
    if (stream.RealFrameRate != null) {
        if (typeof stream.RealFrameRate !== 'number'
            || !Number.isFinite(stream.RealFrameRate)
            || stream.RealFrameRate <= 0) {
            return null;
        }
        return stream.RealFrameRate;
    }

    if (typeof stream.AverageFrameRate !== 'number'
        || !Number.isFinite(stream.AverageFrameRate)
        || stream.AverageFrameRate <= 0) {
        return null;
    }
    return stream.AverageFrameRate;
}

function matchesBundledHEVCTier(
    stream: MediaStream,
    tier: BundledHEVCExactTierCapability
): boolean {
    const frameRate = getEffectiveVideoFrameRate(stream);
    return frameRate !== null
        && frameRate <= CUSTOM_RAW_HDR_VIDEO_MAXIMUM_FRAMES_PER_SECOND
        && isPositiveSafeInteger(stream.Level)
        && stream.Level <= tier.maximumLevel
        && isPositiveSafeInteger(stream.BitRate)
        && stream.BitRate <= tier.maximumBitrate
        && isPositiveSafeInteger(stream.Width)
        && stream.Width <= tier.maximumCodedWidth
        && isPositiveSafeInteger(stream.Height)
        && stream.Height <= tier.maximumCodedHeight;
}

function getBundledRawHEVCTier(
    capabilities: CustomDecodeCapabilities,
    capability: CustomRawHDRVideoCodecCapability
): BundledHEVCExactTierCapability | null {
    const bundledTiers = capabilities.bundledHEVC?.tiers;
    if (!bundledTiers) {
        return null;
    }

    for (const tier of [ bundledTiers['main10-4k'], bundledTiers['main10-1080p'] ]) {
        if (tier.status === 'supported'
            && tier.codecString === capability.codecString
            && tier.maximumCodedWidth === capability.maximumCodedWidth
            && tier.maximumCodedHeight === capability.maximumCodedHeight) {
            return tier;
        }
    }
    return null;
}

function normalizeMetadataToken(value: unknown): string | null {
    return normalizeMetadataValue(value)?.replace(/[^A-Z0-9]/g, '') ?? null;
}

function hasSupportedNativeVideoProfile(
    codec: CustomVideoCodec,
    stream: MediaStream
): boolean {
    const profile = normalizeMetadataToken(stream.Profile);
    switch (codec) {
        case 'h264':
            return profile === 'HIGH';
        case 'hevc':
            return profile === 'MAIN';
        case 'vp8':
            return profile === null || profile === 'PROFILE0';
        case 'vp9':
            return profile === 'PROFILE0' || profile === '0';
        case 'av1':
            return profile === 'MAIN';
    }
}

function hasSupportedRawVideoProfile(
    codec: CustomVideoCodec,
    stream: MediaStream
): boolean {
    const profile = normalizeMetadataToken(stream.Profile);
    switch (codec) {
        case 'hevc':
            return profile === 'MAIN10';
        case 'vp9':
            return profile === 'PROFILE2' || profile === '2';
        case 'av1':
            return profile === 'MAIN';
        case 'h264':
        case 'vp8':
            return false;
    }
}

type SDRVideoSelection = {
    maximumCodedHeight: number
    maximumCodedWidth: number
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
};

function getSDRVideoSelection(
    capabilities: CustomDecodeCapabilities,
    codec: CustomVideoCodec,
    stream: MediaStream,
    bitDepth: number
): SDRVideoSelection | null {
    if (
        bitDepth !== CUSTOM_NATIVE_VIDEO_BIT_DEPTH
        || !isPositiveSafeInteger(stream.Width)
        || !isPositiveSafeInteger(stream.Height)
    ) {
        return null;
    }

    let videoDecoderBackend: CustomDecodeVideoDecoderBackend = 'native';
    let maximumCodedWidth = CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH;
    let maximumCodedHeight = CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT;
    if (codec === 'h264') {
        if (
            !capabilities.h264Profiles
            || !supportsH264JellyfinProfile(capabilities.h264Profiles, stream.Profile)
        ) {
            return null;
        }
    } else if (codec === 'hevc') {
        if (!hasSupportedNativeVideoProfile(codec, stream)) {
            return null;
        }
        if (capabilities.video.hevc.status !== 'supported') {
            const bundledMain = capabilities.bundledHEVC?.tiers['main-1080p'];
            if (bundledMain?.status !== 'supported'
                || !matchesBundledHEVCTier(stream, bundledMain)) {
                return null;
            }
            videoDecoderBackend = 'bundled-hevc';
            maximumCodedWidth = bundledMain.maximumCodedWidth;
            maximumCodedHeight = bundledMain.maximumCodedHeight;
        }
    } else if (
        capabilities.video[codec].status !== 'supported'
        || !hasSupportedNativeVideoProfile(codec, stream)
    ) {
        return null;
    }

    if (stream.Width > maximumCodedWidth || stream.Height > maximumCodedHeight) {
        return null;
    }
    return { maximumCodedHeight, maximumCodedWidth, videoDecoderBackend };
}

function supportsRawHDRVideo(
    capabilities: CustomDecodeCapabilities,
    codec: CustomVideoCodec,
    stream: MediaStream,
    format: CustomDecodeRawVideoFrameFormat
): boolean {
    if (codec !== 'hevc' && codec !== 'vp9' && codec !== 'av1') {
        return false;
    }
    const capability = capabilities.rawHDRVideo[codec];
    const frameRate = getEffectiveVideoFrameRate(stream);
    if (capability.status !== 'supported'
        || capability.format !== format
        || capability.bitDepth !== stream.BitDepth
        || !hasSupportedRawVideoProfile(codec, stream)
        || frameRate === null
        || frameRate > CUSTOM_RAW_HDR_VIDEO_MAXIMUM_FRAMES_PER_SECOND
        || !isPositiveSafeInteger(stream.Width)
        || !isPositiveSafeInteger(stream.Height)) {
        return false;
    }
    if (stream.Width > capability.maximumCodedWidth
        || stream.Height > capability.maximumCodedHeight) {
        return false;
    }
    if (capability.reason !== 'bundled-software-decoder') {
        return true;
    }

    const bundledTier = getBundledRawHEVCTier(capabilities, capability);
    return bundledTier !== null && matchesBundledHEVCTier(stream, bundledTier);
}

function selectVideoOutput(
    options: unknown,
    capabilities: CustomDecodeCapabilities,
    allowRawHDR: boolean,
    authorizedRawHDRRouteKeys: readonly RawHDRAuthorizationRouteKey[],
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream
): VideoOutputSelection {
    const colorMetadata = getPresentationInputColorMetadata(options);
    if (!colorMetadata) {
        return { reason: 'metadata-unsupported', status: 'invalid' };
    }
    const hdr = colorMetadata.transfer !== 'sdr';
    if (!hdr) {
        const sdrSelection = getSDRVideoSelection(
            capabilities,
            videoCodec,
            videoStream,
            colorMetadata.bitDepth
        );
        if (!sdrSelection) {
            return {
                reason: 'codec-unsupported',
                status: 'invalid'
            };
        }
        return {
            hdr: false,
            maximumCodedHeight: sdrSelection.maximumCodedHeight,
            maximumCodedWidth: sdrSelection.maximumCodedWidth,
            nativeVideoDecoderRequired: sdrSelection.videoDecoderBackend === 'native',
            rawVideoFrameFormat: null,
            status: 'selected',
            videoDecoderBackend: sdrSelection.videoDecoderBackend,
            videoOutputMode: 'video-frame'
        };
    }
    if (!allowRawHDR) {
        return { reason: 'hdr-presentation-unavailable', status: 'invalid' };
    }

    const rawVideoFrameFormat = getRawVideoFrameFormat(colorMetadata.bitDepth);
    if (!rawVideoFrameFormat) {
        return { reason: 'metadata-unsupported', status: 'invalid' };
    }
    const rawHDRRouteKey = getRawHDRAuthorizationRouteKey(
        rawVideoFrameFormat,
        colorMetadata
    );
    if (!rawHDRRouteKey || !authorizedRawHDRRouteKeys.includes(rawHDRRouteKey)) {
        return { reason: 'hdr-presentation-unavailable', status: 'invalid' };
    }
    if (!supportsRawHDRVideo(
        capabilities,
        videoCodec,
        videoStream,
        rawVideoFrameFormat
    )) {
        return { reason: 'hdr-codec-unsupported', status: 'invalid' };
    }
    const rawVideoCapability = capabilities.rawHDRVideo[
        videoCodec as CustomRawHDRVideoCodec
    ];
    return {
        hdr: true,
        maximumCodedHeight: rawVideoCapability.maximumCodedHeight,
        maximumCodedWidth: rawVideoCapability.maximumCodedWidth,
        nativeVideoDecoderRequired: rawVideoCapability.reason !== 'bundled-software-decoder',
        rawVideoFrameFormat,
        status: 'selected',
        videoDecoderBackend: rawVideoCapability.reason === 'bundled-software-decoder' ?
            'bundled-hevc' :
            'native',
        videoOutputMode: 'raw-planes'
    };
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
    const containerTokens = getContainerTokens(mediaSource.Container);
    if (!containerTokens.some(container => (
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
        containerTokens,
        durationMicroseconds,
        mediaSource,
        parsed: true,
        startTimeMicroseconds,
        streams: getStreams(mediaSource),
        url
    };
}

function selectVideoStream(streams: readonly MediaStream[]): VideoStreamSelection {
    const videoStreams: TypedStreamCandidate[] = [];
    for (let streamPosition = 0; streamPosition < streams.length; streamPosition += 1) {
        const stream = streams[streamPosition];
        if (normalizeMetadataValue(stream.Type) !== 'VIDEO') {
            continue;
        }
        const jellyfinStreamIndex = getJellyfinStreamIndex(stream, streamPosition);
        if (jellyfinStreamIndex === null) {
            return { status: 'invalid' };
        }
        videoStreams.push({
            jellyfinStreamIndex,
            stream
        });
    }

    if (videoStreams.length !== 1) {
        return { status: 'invalid' };
    }

    return {
        status: 'selected',
        stream: videoStreams[0].stream,
        trackOrdinal: 0
    };
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
    if (!videoCodec) {
        return { eligible: false, reason: 'codec-unsupported' };
    }
    if (hasUnsupportedRotation(selectedVideo.stream)) {
        return { eligible: false, reason: 'rotation-unsupported' };
    }
    if (selectedVideo.stream.IsInterlaced !== false) {
        return { eligible: false, reason: 'interlaced-video-unsupported' };
    }

    const videoOutput = selectVideoOutput(
        options,
        capabilities,
        eligibilityOptions.allowRawHDR,
        eligibilityOptions.authorizedRawHDRRouteKeys ?? [],
        videoCodec,
        selectedVideo.stream
    );
    if (videoOutput.status === 'invalid') {
        return { eligible: false, reason: videoOutput.reason };
    }

    const selectedAudio = getSelectedAudioStream(
        parsedSource.mediaSource,
        parsedSource.streams
    );
    if (selectedAudio.status === 'invalid') {
        return { eligible: false, reason: 'audio-track-invalid' };
    }
    let audioTrackIndex: number | null = null;
    let audioOutputMode: CustomDecodeAudioOutputMode | null = null;
    let selectedAudioCodec: CustomAudioCodec | null = null;
    if (selectedAudio.status === 'selected') {
        const audioCodec = AUDIO_CODEC_ALIASES[normalizeMetadataValue(selectedAudio.stream.Codec) ?? ''];
        if (!audioCodec) {
            return { eligible: false, reason: 'audio-codec-unsupported' };
        }
        const audioOutput = selectAudioOutput(
            audioCodec,
            selectedAudio.stream,
            capabilities,
            eligibilityOptions.nativeMediaAudioCapabilities
        );
        if (audioOutput.status === 'invalid') {
            return { eligible: false, reason: audioOutput.reason };
        }
        selectedAudioCodec = audioCodec;
        audioOutputMode = audioOutput.outputMode;
        audioTrackIndex = selectedAudio.trackOrdinal;
    }
    if (!supportsContainerCodecCombination(
        parsedSource.containerTokens,
        videoCodec,
        selectedAudioCodec
    )) {
        return { eligible: false, reason: 'container-unsupported' };
    }

    const runtimeRequirements: CustomPlaybackRuntimeRequirements = {
        audioOutput: audioOutputMode === 'decoded-pcm',
        nativeAudioDecoder: audioOutputMode === 'decoded-pcm'
            && selectedAudioCodec !== null
            && !BUNDLED_AUDIO_CODEC_SET.has(selectedAudioCodec),
        nativeVideoDecoder: videoOutput.nativeVideoDecoderRequired
    };
    const sourceRuntimeAvailability = getCustomPlaybackRuntimeAvailability(
        eligibilityOptions.runtimeAvailability.environment,
        runtimeRequirements
    );
    if (!sourceRuntimeAvailability.available) {
        return { eligible: false, reason: 'runtime-unavailable' };
    }

    return {
        audioOutputMode,
        audioTrackIndex,
        durationMicroseconds: parsedSource.durationMicroseconds,
        eligible: true,
        hdr: videoOutput.hdr,
        maximumCodedHeight: videoOutput.maximumCodedHeight,
        maximumCodedWidth: videoOutput.maximumCodedWidth,
        rawVideoFrameFormat: videoOutput.rawVideoFrameFormat,
        startTimeMicroseconds: parsedSource.startTimeMicroseconds,
        url: parsedSource.url,
        videoDecoderBackend: videoOutput.videoDecoderBackend,
        videoOutputMode: videoOutput.videoOutputMode,
        videoTrackIndex: selectedVideo.trackOrdinal
    };
}
