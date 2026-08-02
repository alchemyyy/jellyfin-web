const FIVE_POINT_ONE_CHANNEL_COUNT = 6;
const FRONT_LEFT_CHANNEL_INDEX = 0;
const FRONT_RIGHT_CHANNEL_INDEX = 1;
const FRONT_CENTER_CHANNEL_INDEX = 2;
const SURROUND_LEFT_CHANNEL_INDEX = 4;
const SURROUND_RIGHT_CHANNEL_INDEX = 5;

// Normalize FL + 0.707 * FC + 0.707 * surround to unity at full scale
const DIRECT_CHANNEL_GAIN = Math.SQRT2 - 1;
const CENTER_AND_SURROUND_CHANNEL_GAIN = 1 - (Math.SQRT2 / 2);

export type StereoChannelData = [ Float32Array, Float32Array ];

function requireFivePointOnePlanarInput(
    channelData: readonly Float32Array[]
): number {
    if (channelData.length !== FIVE_POINT_ONE_CHANNEL_COUNT) {
        throw new RangeError('5.1 downmix requires exactly 6 input channels');
    }

    const frameCount = channelData[FRONT_LEFT_CHANNEL_INDEX].length;
    for (const channel of channelData) {
        if (channel.length !== frameCount) {
            throw new RangeError('5.1 downmix requires equal-length input channels');
        }
    }
    return frameCount;
}

/**
 * Downmixes FFmpeg-order 5.1 planar PCM (FL, FR, FC, LFE, surround L/R) to
 * stereo. The LFE channel is intentionally omitted from the Lo/Ro mix.
 */
export function downmixFivePointOneToStereo(
    channelData: readonly Float32Array[]
): StereoChannelData {
    const frameCount = requireFivePointOnePlanarInput(channelData);
    const frontLeft = channelData[FRONT_LEFT_CHANNEL_INDEX];
    const frontRight = channelData[FRONT_RIGHT_CHANNEL_INDEX];
    const frontCenter = channelData[FRONT_CENTER_CHANNEL_INDEX];
    const surroundLeft = channelData[SURROUND_LEFT_CHANNEL_INDEX];
    const surroundRight = channelData[SURROUND_RIGHT_CHANNEL_INDEX];
    const outputLeft = new Float32Array(frameCount);
    const outputRight = new Float32Array(frameCount);

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        outputLeft[frameIndex] =
            frontLeft[frameIndex] * DIRECT_CHANNEL_GAIN
            + frontCenter[frameIndex] * CENTER_AND_SURROUND_CHANNEL_GAIN
            + surroundLeft[frameIndex] * CENTER_AND_SURROUND_CHANNEL_GAIN;
        outputRight[frameIndex] =
            frontRight[frameIndex] * DIRECT_CHANNEL_GAIN
            + frontCenter[frameIndex] * CENTER_AND_SURROUND_CHANNEL_GAIN
            + surroundRight[frameIndex] * CENTER_AND_SURROUND_CHANNEL_GAIN;
    }

    return [ outputLeft, outputRight ];
}
