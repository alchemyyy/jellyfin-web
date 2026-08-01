import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type ColorPrimaries,
    type ColorRange,
    type ColorTransfer,
    type InputColorMetadata,
    type YUVMatrix
} from './color/ColorMetadata';

type MediaStreamMetadata = {
    BitDepth?: unknown
    BlPresentFlag?: unknown
    ColorPrimaries?: unknown
    ColorRange?: unknown
    ColorSpace?: unknown
    ColorTransfer?: unknown
    DvBlSignalCompatibilityId?: unknown
    DvLevel?: unknown
    DvProfile?: unknown
    DvVersionMajor?: unknown
    DvVersionMinor?: unknown
    ElPresentFlag?: unknown
    Hdr10PlusPresentFlag?: unknown
    RpuPresentFlag?: unknown
    Type?: unknown
    VideoDoViTitle?: unknown
    VideoRange?: unknown
    VideoRangeType?: unknown
};

type PlaybackOptions = {
    mediaSource?: {
        MediaStreams?: unknown
    }
};

const SDR_VIDEO_RANGE = 'SDR';
const HDR_VIDEO_RANGE = 'HDR';
const HDR_COLOR_TRANSFERS = new Set([
    'ARIB-STD-B67',
    'HLG',
    'PQ',
    'SMPTE ST 2084',
    'SMPTEST2084',
    'SMPTE2084'
]);
const PQ_VIDEO_RANGE_TYPES = new Set([ 'HDR10', 'HDR10PLUS' ]);
const HLG_VIDEO_RANGE_TYPES = new Set([ 'HLG' ]);
const SDR_VIDEO_RANGE_TYPES = new Set([ SDR_VIDEO_RANGE ]);
const DOLBY_VISION_PREFIX = 'DOVI';
const DEFAULT_SDR_BIT_DEPTH = 8;
const DEFAULT_HDR_BIT_DEPTH = 10;

type ParsedTransfer = ColorTransfer | 'dolby-vision' | 'unknown';

function normalizeMetadataValue(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalizedValue = value.trim().toUpperCase();
    return normalizedValue || null;
}

function normalizeMetadataToken(value: unknown): string | null {
    const normalizedValue = normalizeMetadataValue(value);
    return normalizedValue?.replace(/[^A-Z0-9]/g, '') ?? null;
}

function parseRangeType(value: unknown): ParsedTransfer | null {
    const normalizedValue = normalizeMetadataToken(value);
    if (!normalizedValue) {
        return null;
    }
    if (normalizedValue.startsWith(DOLBY_VISION_PREFIX)) {
        return 'dolby-vision';
    }
    if (PQ_VIDEO_RANGE_TYPES.has(normalizedValue)) {
        return 'pq';
    }
    if (HLG_VIDEO_RANGE_TYPES.has(normalizedValue)) {
        return 'hlg';
    }
    if (SDR_VIDEO_RANGE_TYPES.has(normalizedValue)) {
        return 'sdr';
    }

    return 'unknown';
}

function parseTransfer(value: unknown): ParsedTransfer | null {
    const normalizedValue = normalizeMetadataToken(value);
    if (!normalizedValue) {
        return null;
    }

    switch (normalizedValue) {
        case 'ARIBSTDB67':
        case 'HLG':
            return 'hlg';
        case 'PQ':
        case 'SMPTE2084':
        case 'SMPTEST2084':
            return 'pq';
        case 'BT709':
        case 'IEC6196621':
        case 'SMPTE170M':
            return 'sdr';
        default:
            return 'unknown';
    }
}

function parseVideoRange(value: unknown): 'hdr' | 'sdr' | 'unknown' | null {
    const normalizedValue = normalizeMetadataToken(value);
    if (!normalizedValue) {
        return null;
    }

    switch (normalizedValue) {
        case HDR_VIDEO_RANGE:
            return 'hdr';
        case SDR_VIDEO_RANGE:
            return 'sdr';
        default:
            return 'unknown';
    }
}

function parseColorRange(value: unknown): ColorRange | 'unknown' | null {
    const normalizedValue = normalizeMetadataToken(value);
    if (!normalizedValue) {
        return null;
    }

    switch (normalizedValue) {
        case 'FULL':
        case 'JPEG':
        case 'PC':
            return 'full';
        case 'LIMITED':
        case 'MPEG':
        case 'TV':
            return 'limited';
        default:
            return 'unknown';
    }
}

function parseColorPrimaries(value: unknown): ColorPrimaries | 'unknown' | null {
    const normalizedValue = normalizeMetadataToken(value);
    if (!normalizedValue) {
        return null;
    }

    switch (normalizedValue) {
        case 'BT2020':
            return 'bt2020';
        case 'BT709':
            return 'bt709';
        default:
            return 'unknown';
    }
}

function parseYUVMatrix(value: unknown): YUVMatrix | 'unknown' | null {
    const normalizedValue = normalizeMetadataToken(value);
    if (!normalizedValue) {
        return null;
    }

    switch (normalizedValue) {
        case 'BT2020NC':
        case 'BT2020NCL':
            return 'bt2020-ncl';
        case 'BT709':
            return 'bt709';
        default:
            return 'unknown';
    }
}

function parseBitDepth(value: unknown, defaultBitDepth: number): number | null {
    if (value == null) {
        return defaultBitDepth;
    }
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 8 || value > 16) {
        return null;
    }

    return value;
}

function resolveTransfer(videoStream: MediaStreamMetadata): ColorTransfer | null {
    const rangeTypeTransfer = parseRangeType(videoStream.VideoRangeType);
    const explicitTransfer = parseTransfer(videoStream.ColorTransfer);
    if (
        rangeTypeTransfer === 'dolby-vision'
        || rangeTypeTransfer === 'unknown'
        || explicitTransfer === 'dolby-vision'
        || explicitTransfer === 'unknown'
    ) {
        return null;
    }
    if (rangeTypeTransfer && explicitTransfer && rangeTypeTransfer !== explicitTransfer) {
        return null;
    }

    const videoRange = parseVideoRange(videoStream.VideoRange);
    if (videoRange === 'unknown') {
        return null;
    }
    const transfer = rangeTypeTransfer
        ?? explicitTransfer
        ?? (videoRange === 'sdr' ? 'sdr' : null);
    if (!transfer) {
        return null;
    }
    switch (transfer) {
        case 'sdr':
            return videoRange === 'hdr' ? null : transfer;
        case 'hlg':
        case 'pq':
            return videoRange === 'sdr' ? null : transfer;
    }
}

function hasEnabledMetadataFlag(value: unknown): boolean {
    switch (typeof value) {
        case 'boolean':
            return value;
        case 'number':
            return value !== 0;
        case 'string': {
            const normalizedValue = value.trim().toUpperCase();
            return normalizedValue !== ''
                && normalizedValue !== '0'
                && normalizedValue !== 'FALSE'
                && normalizedValue !== 'NO';
        }
        default:
            return false;
    }
}

function hasDolbyVisionProfile(value: unknown): boolean {
    return value != null && normalizeMetadataValue(String(value)) != null;
}

function hasDolbyVisionMetadata(videoStream: MediaStreamMetadata): boolean {
    return hasDolbyVisionProfile(videoStream.DvProfile)
        || hasDolbyVisionProfile(videoStream.DvVersionMajor)
        || hasDolbyVisionProfile(videoStream.DvVersionMinor)
        || hasDolbyVisionProfile(videoStream.DvLevel)
        || hasDolbyVisionProfile(videoStream.DvBlSignalCompatibilityId)
        || hasDolbyVisionProfile(videoStream.VideoDoViTitle)
        || hasEnabledMetadataFlag(videoStream.BlPresentFlag)
        || hasEnabledMetadataFlag(videoStream.ElPresentFlag)
        || hasEnabledMetadataFlag(videoStream.RpuPresentFlag);
}

/**
 * Converts one Jellyfin video stream into renderer metadata. Unsupported,
 * contradictory, unknown, and Dolby Vision descriptions return null.
 */
export function parseVideoStreamColorMetadata(stream: unknown): InputColorMetadata | null {
    if (!stream || typeof stream !== 'object') {
        return null;
    }

    const videoStream = stream as MediaStreamMetadata;
    const streamType = normalizeMetadataValue(videoStream.Type);
    if (streamType && streamType !== 'VIDEO') {
        return null;
    }
    if (hasDolbyVisionMetadata(videoStream)) {
        return null;
    }

    const transfer = resolveTransfer(videoStream);
    if (!transfer) {
        return null;
    }
    if (transfer !== 'pq' && hasEnabledMetadataFlag(videoStream.Hdr10PlusPresentFlag)) {
        return null;
    }

    const defaultBitDepth = transfer === 'sdr' ? DEFAULT_SDR_BIT_DEPTH : DEFAULT_HDR_BIT_DEPTH;
    const bitDepth = parseBitDepth(videoStream.BitDepth, defaultBitDepth);
    if (!bitDepth || (transfer !== 'sdr' && bitDepth < DEFAULT_HDR_BIT_DEPTH)) {
        return null;
    }

    const parsedRange = parseColorRange(videoStream.ColorRange);
    const parsedPrimaries = parseColorPrimaries(videoStream.ColorPrimaries);
    const parsedMatrix = parseYUVMatrix(videoStream.ColorSpace);
    if (
        parsedRange === 'unknown'
        || parsedPrimaries === 'unknown'
        || parsedMatrix === 'unknown'
    ) {
        return null;
    }

    const range = parsedRange ?? 'limited';
    const primaries = parsedPrimaries ?? (transfer === 'sdr' ? 'bt709' : 'bt2020');
    const matrix = parsedMatrix ?? (transfer === 'sdr' ? 'bt709' : 'bt2020-ncl');
    switch (transfer) {
        case 'sdr':
            return createSDRColorMetadata({ bitDepth, matrix, primaries, range });
        case 'pq':
            return createPQColorMetadata({ bitDepth, matrix, primaries, range });
        case 'hlg':
            return createHLGColorMetadata({ bitDepth, matrix, primaries, range });
    }
}

/**
 * Returns renderer metadata only when playback options contain exactly one
 * unambiguous video stream.
 */
export function getPresentationInputColorMetadata(options: unknown): InputColorMetadata | null {
    if (!options || typeof options !== 'object') {
        return null;
    }

    const playbackOptions = options as PlaybackOptions;
    const mediaStreams = playbackOptions.mediaSource?.MediaStreams;
    if (!Array.isArray(mediaStreams)) {
        return null;
    }

    const videoStreams: unknown[] = [];
    for (const stream of mediaStreams) {
        if (
            stream
            && typeof stream === 'object'
            && normalizeMetadataValue((stream as MediaStreamMetadata).Type) === 'VIDEO'
        ) {
            videoStreams.push(stream);
        }
    }
    if (videoStreams.length !== 1) {
        return null;
    }

    return parseVideoStreamColorMetadata(videoStreams[0]);
}

function isKnownSDRVideoStream(videoStream: MediaStreamMetadata): boolean {
    if (
        hasEnabledMetadataFlag(videoStream.Hdr10PlusPresentFlag)
        || hasEnabledMetadataFlag(videoStream.RpuPresentFlag)
        || hasDolbyVisionProfile(videoStream.DvProfile)
    ) {
        return false;
    }

    const videoRangeType = normalizeMetadataValue(videoStream.VideoRangeType);
    const videoRange = normalizeMetadataValue(videoStream.VideoRange);
    const colorTransfer = normalizeMetadataValue(videoStream.ColorTransfer);
    if (colorTransfer && HDR_COLOR_TRANSFERS.has(colorTransfer)) {
        return false;
    }

    const videoRanges: string[] = [];
    if (videoRangeType) {
        videoRanges.push(videoRangeType);
    }
    if (videoRange) {
        videoRanges.push(videoRange);
    }

    return videoRanges.length > 0
        && videoRanges.every((range: string): boolean => range === SDR_VIDEO_RANGE);
}

/**
 * Returns true only when Jellyfin metadata positively identifies an SDR frame
 * source. Unknown and HDR inputs remain on direct HTML presentation until the
 * external-texture color path has been validated for them.
 */
export function isKnownSDRPresentationInput(options: unknown): boolean {
    if (!options || typeof options !== 'object') {
        return false;
    }

    const playbackOptions = options as PlaybackOptions;
    const mediaStreams = playbackOptions.mediaSource?.MediaStreams;
    if (!Array.isArray(mediaStreams)) {
        return false;
    }

    const videoStreams: MediaStreamMetadata[] = [];
    for (const stream of mediaStreams) {
        if (!stream || typeof stream !== 'object') {
            continue;
        }

        const streamMetadata = stream as MediaStreamMetadata;
        if (normalizeMetadataValue(streamMetadata.Type) === 'VIDEO') {
            videoStreams.push(streamMetadata);
        }
    }

    return videoStreams.length > 0
        && videoStreams.every(isKnownSDRVideoStream);
}
