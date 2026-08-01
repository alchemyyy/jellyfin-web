type MediaStreamMetadata = {
    ColorTransfer?: unknown
    DvProfile?: unknown
    Hdr10PlusPresentFlag?: unknown
    RpuPresentFlag?: unknown
    Type?: unknown
    VideoRange?: unknown
    VideoRangeType?: unknown
};

type PlaybackOptions = {
    mediaSource?: {
        MediaStreams?: unknown
    }
};

const SDR_VIDEO_RANGE = 'SDR';
const HDR_COLOR_TRANSFERS = new Set([
    'ARIB-STD-B67',
    'HLG',
    'PQ',
    'SMPTE ST 2084',
    'SMPTEST2084',
    'SMPTE2084'
]);

function normalizeMetadataValue(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalizedValue = value.trim().toUpperCase();
    return normalizedValue || null;
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
