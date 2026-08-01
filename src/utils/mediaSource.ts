import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client';

const COPY_TIMESTAMPS_PARAMETER = /[?&]copytimestamps=true(?:[&#]|$)/i;

/**
 * Checks if the media source is an HLS stream.
 * @param mediaSource The media source.
 * @returns _true_ if the media source is an HLS stream, _false_ otherwise.
 */
export function isHls(mediaSource: MediaSourceInfo | null | undefined): boolean {
    return mediaSource?.TranscodingSubProtocol?.toUpperCase() === 'HLS'
        || mediaSource?.Container?.toUpperCase() === 'HLS';
}

/**
 * Gets the offset needed to map a transcoded media timeline to source ticks.
 * HLS and copied-timestamp progressive streams already use the source timeline.
 * @param mediaSource The transcoded media source.
 * @param mediaURL The resolved transcoding URL.
 * @param startPositionTicks The requested source start position.
 * @returns The source timeline offset in ticks.
 */
export function getTranscodingOffsetTicks(
    mediaSource: MediaSourceInfo,
    mediaURL: string,
    startPositionTicks: number | null | undefined
): number {
    const isHLSTranscode = mediaSource.TranscodingSubProtocol?.toUpperCase() === 'HLS';
    const copiesTimestamps = COPY_TIMESTAMPS_PARAMETER.test(mediaURL);

    if (isHLSTranscode || copiesTimestamps) {
        return 0;
    }

    return startPositionTicks || 0;
}
