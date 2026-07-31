import type {
    MediaSourceInfo,
    MediaStream as JellyfinMediaStream
} from '@jellyfin/sdk/lib/generated-client';

const SUPPORTED_VIDEO_RANGE_TYPES = new Set([
    'HDR10',
    'HDR10Plus',
    'DOVIWithHDR10',
    'DOVIWithHDR10Plus',
    'DOVIWithEL',
    'DOVIWithELHDR10Plus'
]);

export interface ClientHDRToneMappingRuntimeCapabilities {
    chromeVersion: number;
    dynamicRangeHigh: boolean;
    isChrome: boolean;
    isDesktop: boolean;
    isEdgeChromium: boolean;
    isWindows: boolean;
}

const MINIMUM_CHROME_VERSION = 151;

/**
 * Returns whether the runtime can consume timed AGTM metadata on an SDR output.
 */
export function isClientHDRToneMappingRuntimeSupported(
    capabilities: ClientHDRToneMappingRuntimeCapabilities
): boolean {
    return capabilities.isChrome
        && !capabilities.isEdgeChromium
        && capabilities.isWindows
        && capabilities.isDesktop
        && capabilities.chromeVersion >= MINIMUM_CHROME_VERSION
        && !capabilities.dynamicRangeHigh;
}

/**
 * Returns whether the video range has an HDR10 base layer supported by the
 * initial client-side tone-mapping implementation.
 */
export function isClientHDRToneMappingVideoRangeType(
    videoRangeType: string | null | undefined
): boolean {
    return videoRangeType !== null
        && videoRangeType !== undefined
        && SUPPORTED_VIDEO_RANGE_TYPES.has(videoRangeType);
}

/**
 * Returns whether a media source contains a supported HDR video stream.
 */
export function isClientHDRToneMappingMediaSource(
    mediaSource: MediaSourceInfo | null | undefined
): boolean {
    return mediaSource?.IsInfiniteStream !== true
        && hasClientHDRToneMappingVideoStream(mediaSource?.MediaStreams);
}

/**
 * Returns whether a stream list contains a supported HDR video stream.
 */
export function hasClientHDRToneMappingVideoStream(
    mediaStreams: JellyfinMediaStream[] | null | undefined
): boolean {
    return mediaStreams?.some(stream =>
        stream.Type === 'Video'
        && isClientHDRToneMappingVideoRangeType(stream.VideoRangeType)
    ) === true;
}
