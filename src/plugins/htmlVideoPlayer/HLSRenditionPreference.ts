import { TranscodeReason } from '@jellyfin/sdk/lib/generated-client/models/transcode-reason';

const HLS_URL_BASE = 'https://jellyfin.invalid/';
const ALLOW_VIDEO_STREAM_COPY_PARAMETER = 'allowvideostreamcopy';
const TRANSCODE_REASONS_PARAMETER = 'transcodereasons';

const VIDEO_ENCODING_REASONS = new Set<string>([
    TranscodeReason.AnamorphicVideoNotSupported,
    TranscodeReason.InterlacedVideoNotSupported,
    TranscodeReason.RefFramesNotSupported,
    TranscodeReason.SubtitleCodecNotSupported,
    TranscodeReason.UnknownVideoStreamInfo,
    TranscodeReason.VideoBitDepthNotSupported,
    TranscodeReason.VideoBitrateNotSupported,
    TranscodeReason.VideoCodecNotSupported,
    TranscodeReason.VideoCodecTagNotSupported,
    TranscodeReason.VideoFramerateNotSupported,
    TranscodeReason.VideoLevelNotSupported,
    TranscodeReason.VideoProfileNotSupported,
    TranscodeReason.VideoRangeTypeNotSupported,
    TranscodeReason.VideoResolutionNotSupported,
    TranscodeReason.VideoRotationNotSupported
]);

type PlaybackOptionsRecord = Record<string, unknown>;

/** Selects the server's SDR rendition only when negotiation requires video encoding. */
export function shouldPreferHDRHLSRendition(options: unknown): boolean {
    const negotiationURLs = getNegotiationURLs(options);
    for (const negotiationURL of negotiationURLs) {
        const searchParameters = getSearchParameters(negotiationURL);
        if (!searchParameters) {
            continue;
        }

        if (hasDisabledVideoStreamCopy(searchParameters)
            || hasVideoEncodingReason(searchParameters)) {
            return false;
        }
    }

    return true;
}

function getNegotiationURLs(options: unknown): string[] {
    const negotiationURLs: string[] = [];
    if (!options || typeof options !== 'object') {
        return negotiationURLs;
    }

    const playbackOptions = options as PlaybackOptionsRecord;
    appendString(negotiationURLs, playbackOptions.url);
    const mediaSource = playbackOptions.mediaSource;
    if (mediaSource && typeof mediaSource === 'object') {
        appendString(
            negotiationURLs,
            (mediaSource as PlaybackOptionsRecord).TranscodingUrl
        );
    }
    return negotiationURLs;
}

function appendString(values: string[], value: unknown): void {
    if (typeof value === 'string' && value.length > 0 && !values.includes(value)) {
        values.push(value);
    }
}

function getSearchParameters(url: string): URLSearchParams | null {
    try {
        return new URL(url, HLS_URL_BASE).searchParams;
    } catch {
        return null;
    }
}

function hasDisabledVideoStreamCopy(searchParameters: URLSearchParams): boolean {
    return getParameterValues(
        searchParameters,
        ALLOW_VIDEO_STREAM_COPY_PARAMETER
    ).some((value) => value.toLowerCase() === 'false');
}

function hasVideoEncodingReason(searchParameters: URLSearchParams): boolean {
    const encodedReasonLists = getParameterValues(
        searchParameters,
        TRANSCODE_REASONS_PARAMETER
    );
    for (const encodedReasons of encodedReasonLists) {
        const reasons = encodedReasons.split(',');
        for (const reason of reasons) {
            if (VIDEO_ENCODING_REASONS.has(reason.trim())) {
                return true;
            }
        }
    }
    return false;
}

function getParameterValues(
    searchParameters: URLSearchParams,
    normalizedName: string
): string[] {
    const values: string[] = [];
    searchParameters.forEach((value, name) => {
        if (name.toLowerCase() === normalizedName) {
            values.push(value);
        }
    });
    return values;
}
