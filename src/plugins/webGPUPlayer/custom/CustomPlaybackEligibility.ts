import {
    getDolbyVisionPresentationDescriptor,
    getDolbyVisionProfile7HDR10BaseColorMetadata,
    getDolbyVisionProfile8HDR10BaseColorMetadata,
    getPresentationInputColorMetadata,
    getPresentationVideoTrackOrdinal
} from '../PresentationInput';
import type { InputColorMetadata } from '../color/ColorMetadata';
import {
    jellyfinTicksToMicroseconds,
    type Microseconds
} from '../MediaTime';
import {
    CUSTOM_BUNDLED_AUDIO_CODECS,
    CUSTOM_BUNDLED_HEVC_BASELINE_MAXIMUM_FRAMES_PER_SECOND,
    CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
    CUSTOM_NATIVE_VIDEO_BIT_DEPTH,
    CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT,
    CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH,
    hasSupportedNativeSDRVideoCodec,
    isCustomHDRVideoMaximumFramesPerSecond,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomNativeHDRHEVCCapability,
    type CustomNativeSurroundAudioCodecCapability,
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
import {
    isCustomMediabunnyPCMAudioCodec,
    isSupportedCustomAudioInputLayout
} from './CustomAudioOutputPolicy';
import {
    isSupportedDTSInputRoute,
    isSupportedTrueHDInputRoute
} from './CustomCompressedAudioRoute';
import {
    getH264ProfileFromJellyfinValue,
    supportsH264JellyfinProfile
} from './H264ProfileCapabilities';
import {
    getExternalHDRAuthorizationRouteKey,
    type ExternalHDRAuthorizationRouteKey
} from '../validation/ExternalHDRPresentationAuthorization';
import {
    getRawHDRAuthorizationRouteKey,
    type RawHDRAuthorizationRouteKey
} from '../validation/RawHDRPresentationAuthorization';
import type {
    CustomDecodeAudioOutputMode,
    CustomDecodeNativeHDRTransfer,
    CustomDecodeRawVideoFrameFormat,
    CustomDecodeVideoDecoderBackend,
    CustomDecodeVideoOutputMode
} from './DecodeWorkerProtocol';
import { requireMicroseconds } from './TimeMath';
import {
    hasRawVideoFrameResourceBudget,
    RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT,
    RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT,
    type RawVideoFrameGeometry
} from './RawVideoFrameCopy';

const DIRECT_PLAY_METHOD = 'DIRECTPLAY';
const POTENTIAL_JPEG2000_MAXIMUM_CODED_HEIGHT = 540;
const POTENTIAL_JPEG2000_MAXIMUM_CODED_WIDTH = 960;
const POTENTIAL_SOFTWARE_VIDEO_MAXIMUM_FRAMES_PER_SECOND = 24;
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
const JPEG2000_ISO_BASE_MEDIA_CONTAINER_RULE: ContainerCodecRule = {
    audioCodecs: new Set([
        ...ISO_BASE_MEDIA_CONTAINER_RULE.audioCodecs,
        ...CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS
    ]),
    containers: new Set([ 'MJ2', 'MOV' ]),
    videoCodecs: new Set([ 'jpeg2000' ])
};
const ISO_BASE_MEDIA_PCM_CONTAINER_RULE: ContainerCodecRule = {
    audioCodecs: new Set([
        'pcm_s16le',
        'pcm_s16be',
        'pcm_s24le',
        'pcm_s24be',
        'pcm_s32le',
        'pcm_s32be',
        'pcm_f32le',
        'pcm_f32be',
        'pcm_f64le',
        'pcm_f64be'
    ]),
    containers: new Set([ 'MP4', 'M4V', 'MOV' ]),
    videoCodecs: ISO_BASE_MEDIA_CONTAINER_RULE.videoCodecs
};
const QUICKTIME_PCM_CONTAINER_RULE: ContainerCodecRule = {
    audioCodecs: new Set(CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS),
    containers: new Set([ 'MOV' ]),
    videoCodecs: ISO_BASE_MEDIA_CONTAINER_RULE.videoCodecs
};
const MATROSKA_CONTAINER_RULE: ContainerCodecRule = {
    audioCodecs: new Set([
        ...ISO_BASE_MEDIA_CONTAINER_RULE.audioCodecs,
        'dts',
        'mlp',
        'truehd',
        'pcm_u8',
        'pcm_s16le',
        'pcm_s16be',
        'pcm_s24le',
        'pcm_s24be',
        'pcm_s32le',
        'pcm_s32be',
        'pcm_f32le',
        'pcm_f64le'
    ]),
    containers: new Set([ 'MKV', 'MATROSKA' ]),
    videoCodecs: new Set([
        ...ISO_BASE_MEDIA_CONTAINER_RULE.videoCodecs,
        'mpeg2video',
        'vc1'
    ])
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
    JPEG2000_ISO_BASE_MEDIA_CONTAINER_RULE,
    ISO_BASE_MEDIA_PCM_CONTAINER_RULE,
    QUICKTIME_PCM_CONTAINER_RULE,
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
    J2K: 'jpeg2000',
    'JPEG 2000': 'jpeg2000',
    JPEG2000: 'jpeg2000',
    'MPEG-2': 'mpeg2video',
    MPEG2: 'mpeg2video',
    MPEG2VIDEO: 'mpeg2video',
    'VC-1': 'vc1',
    VC1: 'vc1',
    VP8: 'vp8',
    VP9: 'vp9'
};

const AUDIO_CODEC_ALIASES = new Map<string, CustomAudioCodec>([
    [ 'AAC', 'aac' ],
    [ 'AC-3', 'ac3' ],
    [ 'AC3', 'ac3' ],
    [ 'E-AC-3', 'eac3' ],
    [ 'EC-3', 'eac3' ],
    [ 'EAC3', 'eac3' ],
    [ 'EC3', 'eac3' ],
    [ 'DCA', 'dts' ],
    [ 'DTS', 'dts' ],
    [ 'FLAC', 'flac' ],
    [ 'MP3', 'mp3' ],
    [ 'OPUS', 'opus' ],
    [ 'MLP', 'mlp' ],
    [ 'PCM_ALAW', 'pcm_alaw' ],
    [ 'PCM_F32BE', 'pcm_f32be' ],
    [ 'PCM_F32LE', 'pcm_f32le' ],
    [ 'PCM_F64BE', 'pcm_f64be' ],
    [ 'PCM_F64LE', 'pcm_f64le' ],
    [ 'PCM_MULAW', 'pcm_mulaw' ],
    [ 'PCM_S16BE', 'pcm_s16be' ],
    [ 'PCM_S16LE', 'pcm_s16le' ],
    [ 'PCM_S24BE', 'pcm_s24be' ],
    [ 'PCM_S24LE', 'pcm_s24le' ],
    [ 'PCM_S32BE', 'pcm_s32be' ],
    [ 'PCM_S32LE', 'pcm_s32le' ],
    [ 'PCM_S8', 'pcm_s8' ],
    [ 'PCM_U8', 'pcm_u8' ],
    [ 'TRUEHD', 'truehd' ],
    [ 'TRUE-HD', 'truehd' ],
    [ 'VORBIS', 'vorbis' ]
]);

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
    Id?: unknown
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

type PlaybackSelectionItem = MediaSource & {
    MediaSources?: unknown
};

type PlaybackSelectionOptions = {
    mediaSourceId?: unknown
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
    | { status: 'invalid' }
    | { status: 'none' }
    | { status: 'selected', stream: MediaStream, trackOrdinal: number };

type VideoStreamSelection =
    | { status: 'invalid' }
    | { status: 'selected', stream: MediaStream, trackOrdinal: number };

type VideoOutputSelection =
    | {
        dolbyVisionProfile?: 5 | 7 | 8
        hdr: boolean
        maximumCodedHeight: number
        maximumCodedWidth: number
        nativeHDRTransfer?: Exclude<CustomDecodeNativeHDRTransfer, null>
        nativeVideoDecoderRequired: boolean
        neutralizeHDRColorMetadata: boolean
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

type PlaybackAudioSelection =
    | {
        audioCodec: CustomAudioCodec | null
        audioOutputMode: CustomDecodeAudioOutputMode | null
        audioSourceChannelCount: number | null
        audioTrackIndex: number | null
        status: 'selected'
    }
    | {
        reason: 'audio-codec-unsupported' | 'audio-layout-unsupported' | 'audio-track-invalid'
        status: 'invalid'
    };

function getNativeHDRTransferResult(
    videoOutput: Extract<VideoOutputSelection, { status: 'selected' }>
): Pick<EligibleCustomPlayback, 'nativeHDRTransfer'> {
    if (!videoOutput.nativeHDRTransfer) {
        return {};
    }
    return { nativeHDRTransfer: videoOutput.nativeHDRTransfer };
}

export type CustomPlaybackIneligibilityReason =
    | 'audio-codec-unsupported'
    | 'audio-layout-unsupported'
    | 'audio-track-invalid'
    | 'codec-unsupported'
    | 'combined-software-decode-unqualified'
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
    allowDolbyVision?: boolean
    allowDolbyVisionProfile7?: boolean
    allowNativeDolbyVision?: boolean
    allowNativeDolbyVisionProfile7HDR10Base?: boolean
    allowNativeDolbyVisionProfile8HDR10Base?: boolean
    allowNativeHDR?: boolean
    allowRawHDR: boolean
    authorizedExternalHDRRouteKeys?: readonly ExternalHDRAuthorizationRouteKey[]
    authorizedRawHDRRouteKeys?: readonly RawHDRAuthorizationRouteKey[]
    nativeMediaAudioCapabilities?: NativeMediaAudioCapabilities | null
    runtimeAvailability: CustomPlaybackRuntimeAvailability
};

export type EligibleCustomPlayback = {
    audioOutputMode: CustomDecodeAudioOutputMode | null
    audioSourceChannelCount: number | null
    /** Zero-based ordinal within container audio tracks, not MediaStream.Index. */
    audioTrackIndex: number | null
    durationMicroseconds: Microseconds
    dolbyVisionProfile: 5 | 7 | 8 | null
    eligible: true
    hdr: boolean
    maximumCodedHeight: number
    maximumCodedWidth: number
    nativeHDRTransfer?: Exclude<CustomDecodeNativeHDRTransfer, null>
    neutralizeHDRColorMetadata: boolean
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
    if (isCustomMediabunnyPCMAudioCodec(codec)) {
        return null;
    }
    switch (codec) {
        case 'ac3':
        case 'eac3':
            return codec;
        case 'aac':
        case 'dts':
        case 'flac':
        case 'mlp':
        case 'mp3':
        case 'opus':
        case 'truehd':
        case 'vorbis':
            return null;
    }
}

function hasQualifiedDecodedPCMInputLayout(
    codec: CustomAudioCodec,
    stream: MediaStream,
    capabilities: CustomDecodeCapabilities
): boolean {
    if (!isSupportedCustomAudioInputLayout(codec, stream.Channels, stream.SampleRate)) {
        return false;
    }
    if (isCustomMediabunnyPCMAudioCodec(codec)) {
        return true;
    }
    if (codec === 'dts') {
        const profile = normalizeMetadataToken(stream.Profile);
        if (capabilities.bundledDTS?.status !== 'supported') {
            return false;
        }
        return isSupportedDTSInputRoute(stream.Channels, stream.SampleRate, profile);
    }
    if (codec === 'mlp' || codec === 'truehd') {
        const exactCapability = capabilities.bundledTrueHD;
        return exactCapability?.status === 'supported'
            && exactCapability.channelBedOnly
            && exactCapability.objectAudioRendered === false
            && exactCapability.passthrough === false
            && exactCapability.codecs.includes(codec)
            && isSupportedTrueHDInputRoute(codec, stream.Channels, stream.SampleRate);
    }
    if (stream.Channels !== 6) {
        return true;
    }

    switch (codec) {
        case 'ac3':
        case 'eac3':
            return true;
        case 'aac':
        case 'flac':
        case 'opus':
        case 'vorbis': {
            const surroundCapability: CustomNativeSurroundAudioCodecCapability | undefined =
                capabilities.nativeSurroundAudio?.[codec];
            return surroundCapability?.status === 'supported'
                && surroundCapability.inputChannelCount === stream.Channels;
        }
        case 'mp3':
            return false;
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
    if (!hasQualifiedDecodedPCMInputLayout(codec, stream, capabilities)) {
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
    tier: BundledHEVCExactTierCapability,
    maximumFramesPerSecond: number
): boolean {
    const frameRate = getEffectiveVideoFrameRate(stream);
    return frameRate !== null
        && frameRate <= maximumFramesPerSecond
        && isPositiveSafeInteger(stream.Level)
        && stream.Level <= tier.maximumLevel
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
        case 'mpeg2video':
        case 'vc1':
        case 'jpeg2000':
            return false;
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
        case 'jpeg2000':
        case 'mpeg2video':
        case 'vc1':
        case 'vp8':
            return false;
    }
}

type SDRVideoSelection = {
    maximumCodedHeight: number
    maximumCodedWidth: number
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
};

function getJPEG2000SDRVideoSelection(
    capabilities: CustomDecodeCapabilities,
    stream: MediaStream,
    bitDepth: number
): SDRVideoSelection | null {
    const capability = capabilities.bundledJPEG2000;
    const frameRate = getEffectiveVideoFrameRate(stream);
    if (
        capability?.status !== 'supported'
        || capability.bitDepth !== bitDepth
        || capability.maximumFramesPerSecond !== 24
        || frameRate === null
        || frameRate > capability.maximumFramesPerSecond
        || !isPositiveSafeInteger(stream.Width)
        || !isPositiveSafeInteger(stream.Height)
        || stream.Width > capability.maximumCodedWidth
        || stream.Height > capability.maximumCodedHeight
    ) {
        return null;
    }
    return {
        maximumCodedHeight: Number(stream.Height),
        maximumCodedWidth: Number(stream.Width),
        videoDecoderBackend: 'openjpeg'
    };
}

function getLegacyVideoSDRSelection(
    capabilities: CustomDecodeCapabilities,
    codec: 'mpeg2video' | 'vc1',
    stream: MediaStream,
    bitDepth: number
): SDRVideoSelection | null {
    const capability = codec === 'vc1' ?
        capabilities.bundledVC1 :
        capabilities.bundledLegacyVideo;
    const requiredProfile = codec === 'vc1' ? 'ADVANCED' : 'MAIN';
    const frameRate = getEffectiveVideoFrameRate(stream);
    if (
        capability?.status !== 'supported'
        || bitDepth !== CUSTOM_NATIVE_VIDEO_BIT_DEPTH
        || normalizeMetadataToken(stream.Profile) !== requiredProfile
        || capability.maximumFramesPerSecond !== 24
        || frameRate === null
        || frameRate > capability.maximumFramesPerSecond
        || !isPositiveSafeInteger(stream.Width)
        || !isPositiveSafeInteger(stream.Height)
        || stream.Width > capability.maximumCodedWidth
        || stream.Height > capability.maximumCodedHeight
    ) {
        return null;
    }
    return {
        maximumCodedHeight: Number(stream.Height),
        maximumCodedWidth: Number(stream.Width),
        videoDecoderBackend: 'legacy-software'
    };
}

function getOrdinarySDRVideoSelection(
    capabilities: CustomDecodeCapabilities,
    codec: Exclude<CustomVideoCodec, 'jpeg2000' | 'mpeg2video' | 'vc1'>,
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
    const maximumCodedWidth = stream.Width;
    const maximumCodedHeight = stream.Height;
    switch (codec) {
        case 'h264':
            if (
                !capabilities.h264Profiles
                || !supportsH264JellyfinProfile(capabilities.h264Profiles, stream.Profile)
            ) {
                return null;
            }
            break;
        case 'hevc':
            if (!hasSupportedNativeVideoProfile(codec, stream)) {
                return null;
            }
            if (!hasSupportedNativeSDRVideoCodec(codec, capabilities)) {
                const bundledMain = capabilities.bundledHEVC?.tiers['main-1080p'];
                if (bundledMain?.status !== 'supported'
                    || !matchesBundledHEVCTier(
                        stream,
                        bundledMain,
                        CUSTOM_BUNDLED_HEVC_BASELINE_MAXIMUM_FRAMES_PER_SECOND
                    )) {
                    return null;
                }
                videoDecoderBackend = 'bundled-hevc';
            }
            break;
        case 'av1':
        case 'vp9':
            if (
                !hasSupportedNativeSDRVideoCodec(codec, capabilities)
                || !hasSupportedNativeVideoProfile(codec, stream)
            ) {
                return null;
            }
            break;
        case 'vp8':
            if (
                capabilities.video[codec].status !== 'supported'
                || !hasSupportedNativeVideoProfile(codec, stream)
            ) {
                return null;
            }
            break;
    }

    return { maximumCodedHeight, maximumCodedWidth, videoDecoderBackend };
}

function getStreamRawVideoGeometry(stream: MediaStream): RawVideoFrameGeometry | null {
    if (!isPositiveSafeInteger(stream.Width) || !isPositiveSafeInteger(stream.Height)) {
        return null;
    }
    return {
        codedHeight: stream.Height,
        codedWidth: stream.Width,
        displayHeight: stream.Height,
        displayWidth: stream.Width
    };
}

function getSDRVideoSelection(
    capabilities: CustomDecodeCapabilities,
    codec: CustomVideoCodec,
    stream: MediaStream,
    bitDepth: number
): SDRVideoSelection | null {
    if (codec === 'jpeg2000') {
        return getJPEG2000SDRVideoSelection(capabilities, stream, bitDepth);
    }
    if (codec === 'mpeg2video' || codec === 'vc1') {
        return getLegacyVideoSDRSelection(capabilities, codec, stream, bitDepth);
    }
    return getOrdinarySDRVideoSelection(capabilities, codec, stream, bitDepth);
}

function supportsRawHDRVideo(
    capabilities: CustomDecodeCapabilities,
    codec: CustomVideoCodec,
    stream: MediaStream,
    format: CustomDecodeRawVideoFrameFormat,
    frameLayerCount = RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT
): boolean {
    if (codec !== 'hevc' && codec !== 'vp9' && codec !== 'av1') {
        return false;
    }
    const capability = capabilities.rawHDRVideo[codec];
    if (capability.status !== 'supported'
        || capability.format !== format
        || capability.bitDepth !== stream.BitDepth
        || !isCustomHDRVideoMaximumFramesPerSecond(
            capability.maximumFramesPerSecond
        )
        || !hasSupportedRawVideoProfile(codec, stream)) {
        return false;
    }
    const geometry = getStreamRawVideoGeometry(stream);
    if (!geometry || !hasRawVideoFrameResourceBudget(
        geometry,
        format,
        frameLayerCount
    )) {
        return false;
    }
    if (capability.reason !== 'bundled-software-decoder') {
        return true;
    }

    const frameRate = getEffectiveVideoFrameRate(stream);
    if (frameRate === null) {
        return false;
    }
    const bundledTier = getBundledRawHEVCTier(capabilities, capability);
    return bundledTier !== null && matchesBundledHEVCTier(
        stream,
        bundledTier,
        capability.maximumFramesPerSecond
    );
}

function supportsNativeDolbyVisionProfile5(
    capabilities: CustomDecodeCapabilities,
    videoCodec: CustomVideoCodec,
    stream: MediaStream
): boolean {
    const capability = capabilities.nativeDolbyVisionHEVC;
    return videoCodec === 'hevc'
        && capability?.status === 'supported'
        && stream.BitDepth === capability.bitDepth
        && hasSupportedRawVideoProfile(videoCodec, stream)
        && isCustomHDRVideoMaximumFramesPerSecond(
            capability.maximumFramesPerSecond
        )
        && isPositiveSafeInteger(stream.Width)
        && isPositiveSafeInteger(stream.Height);
}

function supportsNativeHDRHEVC(
    capability: CustomNativeHDRHEVCCapability | undefined,
    videoCodec: CustomVideoCodec,
    stream: MediaStream
): capability is CustomNativeHDRHEVCCapability {
    return videoCodec === 'hevc'
        && capability?.status === 'supported'
        && stream.BitDepth === capability.bitDepth
        && hasSupportedRawVideoProfile(videoCodec, stream)
        && isCustomHDRVideoMaximumFramesPerSecond(
            capability.maximumFramesPerSecond
        )
        && isPositiveSafeInteger(stream.Width)
        && isPositiveSafeInteger(stream.Height);
}

type NativeHDRColorDescriptionStream = MediaStream & {
    ColorPrimaries?: unknown
    ColorSpace?: unknown
    ColorTransfer?: unknown
};

function hasExplicitNativeHDRChromaticity(stream: MediaStream): boolean {
    const colorDescription = stream as NativeHDRColorDescriptionStream;
    if (
        typeof colorDescription.ColorTransfer !== 'string'
        || colorDescription.ColorTransfer.trim().length === 0
    ) {
        return false;
    }
    if (
        typeof colorDescription.ColorPrimaries !== 'string'
        || colorDescription.ColorPrimaries.trim().length === 0
    ) {
        return false;
    }
    if (
        typeof colorDescription.ColorSpace !== 'string'
        || colorDescription.ColorSpace.trim().length === 0
    ) {
        return false;
    }
    return true;
}

function getAuthorizedDolbyVisionHDR10BaseMetadata(
    options: unknown,
    eligibilityOptions: CustomPlaybackEligibilityOptions
): InputColorMetadata | null {
    const profile7Metadata = getDolbyVisionProfile7HDR10BaseColorMetadata(options);
    if (profile7Metadata !== null) {
        return eligibilityOptions.allowNativeDolbyVisionProfile7HDR10Base === true ?
            profile7Metadata :
            null;
    }
    const profile8Metadata = getDolbyVisionProfile8HDR10BaseColorMetadata(options);
    return profile8Metadata !== null
        && eligibilityOptions.allowNativeDolbyVisionProfile8HDR10Base === true ?
        profile8Metadata :
        null;
}

function selectDolbyVisionVideoOutput(
    options: unknown,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream
): VideoOutputSelection | null {
    const descriptor = getDolbyVisionPresentationDescriptor(options);
    if (!descriptor) {
        return null;
    }
    if (
        descriptor.profile === 5
        && eligibilityOptions.allowNativeDolbyVision === true
        && supportsNativeDolbyVisionProfile5(
            capabilities,
            videoCodec,
            videoStream
        )
    ) {
        const nativeCapability = capabilities.nativeDolbyVisionHEVC;
        if (!nativeCapability) {
            return { reason: 'hdr-codec-unsupported', status: 'invalid' };
        }
        return {
            dolbyVisionProfile: descriptor.profile,
            hdr: true,
            maximumCodedHeight: Number(videoStream.Height),
            maximumCodedWidth: Number(videoStream.Width),
            nativeVideoDecoderRequired: true,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            status: 'selected',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        };
    }
    const rawPresentationAllowed = descriptor.profile === 7 ?
        eligibilityOptions.allowDolbyVisionProfile7 === true :
        eligibilityOptions.allowDolbyVision === true;
    const rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat = 'I420P10';
    if (
        rawPresentationAllowed
        && videoCodec === 'hevc'
        && supportsRawHDRVideo(
            capabilities,
            videoCodec,
            videoStream,
            rawVideoFrameFormat,
            descriptor.profile === 7 ?
                RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT :
                RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT
        )
    ) {
        const rawVideoCapability = capabilities.rawHDRVideo.hevc;
        return {
            dolbyVisionProfile: descriptor.profile,
            hdr: true,
            maximumCodedHeight: Number(videoStream.Height),
            maximumCodedWidth: Number(videoStream.Width),
            nativeVideoDecoderRequired: rawVideoCapability.reason !== 'bundled-software-decoder',
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat,
            status: 'selected',
            videoDecoderBackend: rawVideoCapability.reason === 'bundled-software-decoder' ?
                'bundled-hevc' :
                'native',
            videoOutputMode: 'raw-planes'
        };
    }

    const dolbyVisionHDR10BaseMetadata = getAuthorizedDolbyVisionHDR10BaseMetadata(
        options,
        eligibilityOptions
    );
    const dolbyVisionHDR10BaseRouteKey = dolbyVisionHDR10BaseMetadata ?
        getExternalHDRAuthorizationRouteKey(dolbyVisionHDR10BaseMetadata) :
        null;
    const nativeHDRCapability = capabilities.nativeHDRHEVC;
    if (
        eligibilityOptions.allowNativeHDR === true
        && dolbyVisionHDR10BaseMetadata !== null
        && dolbyVisionHDR10BaseRouteKey !== null
        && (eligibilityOptions.authorizedExternalHDRRouteKeys ?? []).includes(
            dolbyVisionHDR10BaseRouteKey
        )
        && hasExplicitNativeHDRChromaticity(videoStream)
        && supportsNativeHDRHEVC(nativeHDRCapability, videoCodec, videoStream)
    ) {
        return {
            hdr: true,
            maximumCodedHeight: Number(videoStream.Height),
            maximumCodedWidth: Number(videoStream.Width),
            nativeHDRTransfer: 'pq',
            nativeVideoDecoderRequired: true,
            neutralizeHDRColorMetadata: true,
            rawVideoFrameFormat: null,
            status: 'selected',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        };
    }

    return {
        reason: rawPresentationAllowed ?
            'hdr-codec-unsupported' :
            'hdr-presentation-unavailable',
        status: 'invalid'
    };
}

function selectVideoOutput(
    options: unknown,
    capabilities: CustomDecodeCapabilities,
    eligibilityOptions: CustomPlaybackEligibilityOptions,
    videoCodec: CustomVideoCodec,
    videoStream: MediaStream
): VideoOutputSelection {
    const dolbyVisionSelection = selectDolbyVisionVideoOutput(
        options,
        capabilities,
        eligibilityOptions,
        videoCodec,
        videoStream
    );
    if (dolbyVisionSelection) {
        return dolbyVisionSelection;
    }
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
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            status: 'selected',
            videoDecoderBackend: sdrSelection.videoDecoderBackend,
            videoOutputMode: 'video-frame'
        };
    }
    const externalHDRRouteKey = getExternalHDRAuthorizationRouteKey(colorMetadata);
    const nativeHDRTransfer = colorMetadata.transfer === 'sdr' ?
        null :
        colorMetadata.transfer;
    const nativeHDRCapability = capabilities.nativeHDRHEVC;
    if (
        eligibilityOptions.allowNativeHDR === true
        && externalHDRRouteKey !== null
        && (eligibilityOptions.authorizedExternalHDRRouteKeys ?? []).includes(
            externalHDRRouteKey
        )
        && nativeHDRTransfer !== null
        && hasExplicitNativeHDRChromaticity(videoStream)
        && supportsNativeHDRHEVC(nativeHDRCapability, videoCodec, videoStream)
    ) {
        return {
            hdr: true,
            maximumCodedHeight: Number(videoStream.Height),
            maximumCodedWidth: Number(videoStream.Width),
            nativeHDRTransfer,
            nativeVideoDecoderRequired: true,
            neutralizeHDRColorMetadata: true,
            rawVideoFrameFormat: null,
            status: 'selected',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        };
    }
    if (!eligibilityOptions.allowRawHDR) {
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
    if (
        !rawHDRRouteKey
        || !(eligibilityOptions.authorizedRawHDRRouteKeys ?? []).includes(rawHDRRouteKey)
    ) {
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
        maximumCodedHeight: Number(videoStream.Height),
        maximumCodedWidth: Number(videoStream.Width),
        nativeVideoDecoderRequired: rawVideoCapability.reason !== 'bundled-software-decoder',
        neutralizeHDRColorMetadata: false,
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

function selectVideoStream(
    options: unknown,
    streams: readonly MediaStream[]
): VideoStreamSelection {
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

    const videoTrackOrdinal = getPresentationVideoTrackOrdinal(options);
    if (videoTrackOrdinal === null || videoTrackOrdinal >= videoStreams.length) {
        return { status: 'invalid' };
    }

    return {
        status: 'selected',
        stream: videoStreams[videoTrackOrdinal].stream,
        trackOrdinal: videoTrackOrdinal
    };
}

function selectPlaybackAudio(
    mediaSource: MediaSource,
    streams: readonly MediaStream[],
    capabilities: CustomDecodeCapabilities,
    nativeMediaAudioCapabilities: NativeMediaAudioCapabilities | null | undefined
): PlaybackAudioSelection {
    const selectedAudio = getSelectedAudioStream(mediaSource, streams);
    if (selectedAudio.status === 'invalid') {
        return { reason: 'audio-track-invalid', status: 'invalid' };
    }
    if (selectedAudio.status === 'none') {
        return {
            audioCodec: null,
            audioOutputMode: null,
            audioSourceChannelCount: null,
            audioTrackIndex: null,
            status: 'selected'
        };
    }

    const audioCodec = AUDIO_CODEC_ALIASES.get(
        normalizeMetadataValue(selectedAudio.stream.Codec) ?? ''
    );
    if (!audioCodec) {
        return { reason: 'audio-codec-unsupported', status: 'invalid' };
    }
    const audioOutput = selectAudioOutput(
        audioCodec,
        selectedAudio.stream,
        capabilities,
        nativeMediaAudioCapabilities
    );
    if (audioOutput.status === 'invalid') {
        return audioOutput;
    }
    return {
        audioCodec,
        audioOutputMode: audioOutput.outputMode,
        audioSourceChannelCount: Number(selectedAudio.stream.Channels),
        audioTrackIndex: selectedAudio.trackOrdinal,
        status: 'selected'
    };
}

function hasPotentialCustomVideoDimensions(
    stream: MediaStream,
    maximumCodedWidth: number | null = null,
    maximumCodedHeight: number | null = null
): boolean {
    return isPositiveSafeInteger(stream.Width)
        && isPositiveSafeInteger(stream.Height)
        && (maximumCodedWidth === null || stream.Width <= maximumCodedWidth)
        && (maximumCodedHeight === null || stream.Height <= maximumCodedHeight);
}

function hasPotentialSoftwareVideoFrameRate(stream: MediaStream): boolean {
    const frameRate = getEffectiveVideoFrameRate(stream);
    return frameRate !== null
        && frameRate <= POTENTIAL_SOFTWARE_VIDEO_MAXIMUM_FRAMES_PER_SECOND;
}

function hasPotentialSDRVideoRoute(
    codec: CustomVideoCodec,
    stream: MediaStream,
    containerTokens: readonly string[],
    bitDepth: number
): boolean {
    if (bitDepth !== CUSTOM_NATIVE_VIDEO_BIT_DEPTH) {
        return false;
    }
    switch (codec) {
        case 'mpeg2video':
        case 'vc1':
            return containerTokens.some(container => container === 'MKV' || container === 'MATROSKA')
                && normalizeMetadataToken(stream.Profile) === (
                    codec === 'vc1' ? 'ADVANCED' : 'MAIN'
                )
                && hasPotentialSoftwareVideoFrameRate(stream)
                && hasPotentialCustomVideoDimensions(
                    stream,
                    CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH,
                    CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT
                );
        case 'jpeg2000':
            return containerTokens.some(container => container === 'MJ2' || container === 'MOV')
                && hasPotentialSoftwareVideoFrameRate(stream)
                && hasPotentialCustomVideoDimensions(
                    stream,
                    POTENTIAL_JPEG2000_MAXIMUM_CODED_WIDTH,
                    POTENTIAL_JPEG2000_MAXIMUM_CODED_HEIGHT
                );
        case 'h264':
            return getH264ProfileFromJellyfinValue(stream.Profile) !== null
                && hasPotentialCustomVideoDimensions(stream);
        case 'av1':
        case 'hevc':
        case 'vp8':
        case 'vp9':
            return hasSupportedNativeVideoProfile(codec, stream)
                && hasPotentialCustomVideoDimensions(stream);
    }
}

function hasPotentialHDRVideoRoute(
    codec: CustomVideoCodec,
    stream: MediaStream,
    bitDepth: number
): boolean {
    return (bitDepth === 10 || bitDepth === 12)
        && hasSupportedRawVideoProfile(codec, stream)
        && hasPotentialCustomVideoDimensions(stream);
}

function hasCompletePotentialSDRVideoMetadata(
    codec: CustomVideoCodec,
    stream: MediaStream
): boolean {
    if (!isPositiveSafeInteger(stream.Width) || !isPositiveSafeInteger(stream.Height)) {
        return false;
    }
    switch (codec) {
        case 'jpeg2000':
        case 'mpeg2video':
        case 'vc1':
            return getEffectiveVideoFrameRate(stream) !== null
                && (codec === 'jpeg2000' || normalizeMetadataToken(stream.Profile) !== null);
        case 'av1':
        case 'h264':
        case 'hevc':
        case 'vp8':
        case 'vp9':
            return normalizeMetadataToken(stream.Profile) !== null;
    }
}

function hasCompletePotentialHDRVideoMetadata(stream: MediaStream): boolean {
    return normalizeMetadataToken(stream.Profile) !== null
        && isPositiveSafeInteger(stream.Width)
        && isPositiveSafeInteger(stream.Height);
}

type PotentialVideoCodecSelection =
    | { codec: CustomVideoCodec, status: 'selected' }
    | { status: 'unknown' | 'unsupported' };

function selectPotentialVideoCodec(
    stream: MediaStream,
    containerTokens: readonly string[]
): PotentialVideoCodecSelection {
    const normalizedCodec: string | null = normalizeMetadataValue(stream.Codec);
    if (!normalizedCodec) {
        return { status: 'unknown' };
    }
    const codec: CustomVideoCodec | undefined = VIDEO_CODEC_ALIASES[normalizedCodec];
    if (!codec || !supportsContainerCodecCombination(containerTokens, codec, null)) {
        return { status: 'unsupported' };
    }
    return { codec, status: 'selected' };
}

function hasPotentialCustomVideoRoute(mediaSource: MediaSource): boolean {
    const containerTokens = getContainerTokens(mediaSource.Container);
    if (containerTokens.length === 0) {
        return true;
    }
    if (!containerTokens.some(container => SUPPORTED_VIDEO_CONTAINERS.has(container))) {
        return false;
    }

    const playbackOptions = { mediaSource };
    const selectedVideo = selectVideoStream(playbackOptions, getStreams(mediaSource));
    if (selectedVideo.status === 'invalid') {
        return true;
    }

    const codecSelection: PotentialVideoCodecSelection = selectPotentialVideoCodec(
        selectedVideo.stream,
        containerTokens
    );
    if (codecSelection.status !== 'selected') {
        return codecSelection.status === 'unknown';
    }
    const codec: CustomVideoCodec = codecSelection.codec;
    if (selectedVideo.stream.IsInterlaced === true
        || hasUnsupportedRotation(selectedVideo.stream)) {
        return false;
    }
    if (selectedVideo.stream.IsInterlaced !== false) {
        return true;
    }

    const dolbyVisionDescriptor = getDolbyVisionPresentationDescriptor(playbackOptions);
    if (dolbyVisionDescriptor) {
        if (!hasCompletePotentialHDRVideoMetadata(selectedVideo.stream)) {
            return true;
        }
        return codec === 'hevc'
            && selectedVideo.stream.BitDepth === 10
            && hasPotentialHDRVideoRoute(codec, selectedVideo.stream, 10);
    }

    const colorMetadata = getPresentationInputColorMetadata(playbackOptions);
    if (!colorMetadata) {
        return true;
    }
    if (colorMetadata.transfer === 'sdr') {
        if (!hasCompletePotentialSDRVideoMetadata(codec, selectedVideo.stream)) {
            return true;
        }
        return hasPotentialSDRVideoRoute(
            codec,
            selectedVideo.stream,
            containerTokens,
            colorMetadata.bitDepth
        );
    }
    if (!hasCompletePotentialHDRVideoMetadata(selectedVideo.stream)) {
        return true;
    }
    return hasPotentialHDRVideoRoute(codec, selectedVideo.stream, colorMetadata.bitDepth);
}

function getCompletePlaybackSelectionMediaSources(
    sourceValues: readonly unknown[]
): MediaSource[] | null {
    const sources: MediaSource[] = [];
    for (const sourceValue of sourceValues) {
        if (!sourceValue || typeof sourceValue !== 'object') {
            return null;
        }
        const source = sourceValue as MediaSource;
        if (!Array.isArray(source.MediaStreams)) {
            return null;
        }
        sources.push(source);
    }
    return sources.length > 0 ? sources : null;
}

function getRequestedPlaybackSelectionMediaSource(
    sourceValues: readonly unknown[],
    requestedMediaSourceId: string
): MediaSource[] | null {
    for (const sourceValue of sourceValues) {
        if (!sourceValue || typeof sourceValue !== 'object') {
            continue;
        }
        const source = sourceValue as MediaSource;
        if (source.Id !== requestedMediaSourceId) {
            continue;
        }
        return Array.isArray(source.MediaStreams) ? [ source ] : null;
    }
    return null;
}

function getPlaybackSelectionMediaSources(
    item: unknown,
    playOptions: unknown
): MediaSource[] | null {
    if (!item || typeof item !== 'object') {
        return null;
    }

    const selectionItem = item as PlaybackSelectionItem;
    if (!Array.isArray(selectionItem.MediaSources)) {
        return Array.isArray(selectionItem.MediaStreams) ? [ selectionItem ] : null;
    }

    const requestedMediaSourceId = playOptions && typeof playOptions === 'object' ?
        (playOptions as PlaybackSelectionOptions).mediaSourceId :
        null;
    if (typeof requestedMediaSourceId === 'string' && requestedMediaSourceId.length > 0) {
        return getRequestedPlaybackSelectionMediaSource(
            selectionItem.MediaSources,
            requestedMediaSourceId
        );
    }
    return getCompletePlaybackSelectionMediaSources(selectionItem.MediaSources);
}

/**
 * Rejects the wrapper only when item metadata proves every candidate video
 * route is outside the custom decoder's structural envelope. Runtime probes
 * still make the final capability decision after player selection.
 */
export function hasPotentialCustomPlaybackVideoRoute(
    item: unknown,
    playOptions?: unknown
): boolean {
    const mediaSources = getPlaybackSelectionMediaSources(item, playOptions);
    if (!mediaSources) {
        return true;
    }
    return mediaSources.some(hasPotentialCustomVideoRoute);
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

    const selectedVideo = selectVideoStream(options, parsedSource.streams);
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
        eligibilityOptions,
        videoCodec,
        selectedVideo.stream
    );
    if (videoOutput.status === 'invalid') {
        return { eligible: false, reason: videoOutput.reason };
    }

    const audioSelection = selectPlaybackAudio(
        parsedSource.mediaSource,
        parsedSource.streams,
        capabilities,
        eligibilityOptions.nativeMediaAudioCapabilities
    );
    if (audioSelection.status === 'invalid') {
        return { eligible: false, reason: audioSelection.reason };
    }
    const audioOutputMode = audioSelection.audioOutputMode;
    const audioSourceChannelCount = audioSelection.audioSourceChannelCount;
    const audioTrackIndex = audioSelection.audioTrackIndex;
    const selectedAudioCodec = audioSelection.audioCodec;
    if (!supportsContainerCodecCombination(
        parsedSource.containerTokens,
        videoCodec,
        selectedAudioCodec
    )) {
        return { eligible: false, reason: 'container-unsupported' };
    }
    const synchronousSoftwareVideo = videoOutput.videoDecoderBackend === 'legacy-software'
        || videoOutput.videoDecoderBackend === 'openjpeg';
    const synchronousSoftwareAudio = audioOutputMode === 'decoded-pcm'
        && selectedAudioCodec !== null
        && BUNDLED_AUDIO_CODEC_SET.has(selectedAudioCodec);
    if (synchronousSoftwareVideo && synchronousSoftwareAudio) {
        return { eligible: false, reason: 'combined-software-decode-unqualified' };
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
        audioSourceChannelCount,
        audioTrackIndex,
        durationMicroseconds: parsedSource.durationMicroseconds,
        dolbyVisionProfile: videoOutput.dolbyVisionProfile ?? null,
        eligible: true,
        hdr: videoOutput.hdr,
        maximumCodedHeight: videoOutput.maximumCodedHeight,
        maximumCodedWidth: videoOutput.maximumCodedWidth,
        ...getNativeHDRTransferResult(videoOutput),
        neutralizeHDRColorMetadata: videoOutput.neutralizeHDRColorMetadata,
        rawVideoFrameFormat: videoOutput.rawVideoFrameFormat,
        startTimeMicroseconds: parsedSource.startTimeMicroseconds,
        url: parsedSource.url,
        videoDecoderBackend: videoOutput.videoDecoderBackend,
        videoOutputMode: videoOutput.videoOutputMode,
        videoTrackIndex: selectedVideo.trackOrdinal
    };
}
