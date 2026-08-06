const FIVE_POINT_ONE_CHANNEL_COUNT = 6;
const SIX_POINT_ONE_CHANNEL_COUNT = 7;
const SEVEN_POINT_ONE_CHANNEL_COUNT = 8;
const FRONT_LEFT_CHANNEL_INDEX = 0;
const FRONT_RIGHT_CHANNEL_INDEX = 1;
const FRONT_CENTER_CHANNEL_INDEX = 2;
const BACK_LEFT_CHANNEL_INDEX = 4;
const BACK_RIGHT_CHANNEL_INDEX = 5;
const BACK_CENTER_CHANNEL_INDEX = 4;
const SURROUND_LEFT_CHANNEL_INDEX = 4;
const SURROUND_RIGHT_CHANNEL_INDEX = 5;
const SEVEN_POINT_ONE_SIDE_LEFT_CHANNEL_INDEX = 6;
const SEVEN_POINT_ONE_SIDE_RIGHT_CHANNEL_INDEX = 7;
const SIX_POINT_ONE_SIDE_LEFT_CHANNEL_INDEX = 5;
const SIX_POINT_ONE_SIDE_RIGHT_CHANNEL_INDEX = 6;

// Normalize FL + 0.707 * FC + 0.707 * surround to unity at full scale
const DIRECT_CHANNEL_GAIN = Math.SQRT2 - 1;
const CENTER_AND_SURROUND_CHANNEL_GAIN = 1 - (Math.SQRT2 / 2);
const SIX_POINT_ONE_DIRECT_CHANNEL_GAIN = 1 / (1 + 3 / Math.SQRT2);
const SIX_POINT_ONE_MIXED_CHANNEL_GAIN =
    SIX_POINT_ONE_DIRECT_CHANNEL_GAIN / Math.SQRT2;
const STEREO_FINGERPRINT_OFFSET_BASIS = 0x811c9dc5;
const STEREO_FINGERPRINT_PRIME = 0x01000193;

export const CUSTOM_SEVEN_POINT_ONE_DOWNMIX_POLICY = 'mpv-default-limited' as const;
export const SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN = 1;
export const SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN = Math.SQRT1_2;
export const SEVEN_POINT_ONE_MAXIMUM_CORRELATED_PEAK =
    SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN
    + 3 * SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN;

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

function requireSixPointOnePlanarInput(
    channelData: readonly Float32Array[]
): number {
    if (channelData.length !== SIX_POINT_ONE_CHANNEL_COUNT) {
        throw new RangeError('6.1 downmix requires exactly 7 input channels');
    }

    const frameCount = channelData[FRONT_LEFT_CHANNEL_INDEX].length;
    for (const channel of channelData) {
        if (channel.length !== frameCount) {
            throw new RangeError('6.1 downmix requires equal-length input channels');
        }
    }
    return frameCount;
}

/**
 * Downmixes WAVE-order 6.1 planar PCM (FL, FR, FC, LFE, BC, SL, SR) to
 * bounded stereo. The LFE channel is intentionally omitted from the Lo/Ro mix.
 */
export function downmixSixPointOneToStereo(
    channelData: readonly Float32Array[]
): StereoChannelData {
    const frameCount = requireSixPointOnePlanarInput(channelData);
    const frontLeft = channelData[FRONT_LEFT_CHANNEL_INDEX];
    const frontRight = channelData[FRONT_RIGHT_CHANNEL_INDEX];
    const frontCenter = channelData[FRONT_CENTER_CHANNEL_INDEX];
    const backCenter = channelData[BACK_CENTER_CHANNEL_INDEX];
    const sideLeft = channelData[SIX_POINT_ONE_SIDE_LEFT_CHANNEL_INDEX];
    const sideRight = channelData[SIX_POINT_ONE_SIDE_RIGHT_CHANNEL_INDEX];
    const outputLeft = new Float32Array(frameCount);
    const outputRight = new Float32Array(frameCount);

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        outputLeft[frameIndex] =
            frontLeft[frameIndex] * SIX_POINT_ONE_DIRECT_CHANNEL_GAIN
            + frontCenter[frameIndex] * SIX_POINT_ONE_MIXED_CHANNEL_GAIN
            + backCenter[frameIndex] * SIX_POINT_ONE_MIXED_CHANNEL_GAIN
            + sideLeft[frameIndex] * SIX_POINT_ONE_MIXED_CHANNEL_GAIN;
        outputRight[frameIndex] =
            frontRight[frameIndex] * SIX_POINT_ONE_DIRECT_CHANNEL_GAIN
            + frontCenter[frameIndex] * SIX_POINT_ONE_MIXED_CHANNEL_GAIN
            + backCenter[frameIndex] * SIX_POINT_ONE_MIXED_CHANNEL_GAIN
            + sideRight[frameIndex] * SIX_POINT_ONE_MIXED_CHANNEL_GAIN;
    }

    return [ outputLeft, outputRight ];
}

/** Fingerprints exact float32 stereo output in stable channel-major order. */
export function getStereoChannelDataFingerprint(
    channelData: StereoChannelData
): number {
    if (channelData[0].length !== channelData[1].length) {
        throw new RangeError('Stereo fingerprint requires equal-length channels');
    }
    const sampleBytes = new DataView(new ArrayBuffer(Float32Array.BYTES_PER_ELEMENT));
    let fingerprint = STEREO_FINGERPRINT_OFFSET_BASIS;
    for (const channel of channelData) {
        for (const sample of channel) {
            sampleBytes.setFloat32(0, sample, true);
            for (let byteIndex = 0;
                byteIndex < Float32Array.BYTES_PER_ELEMENT;
                byteIndex += 1) {
                fingerprint ^= sampleBytes.getUint8(byteIndex);
                fingerprint = Math.imul(fingerprint, STEREO_FINGERPRINT_PRIME) >>> 0;
            }
        }
    }
    return fingerprint;
}

function requireSevenPointOnePlanarInput(
    channelData: readonly Float32Array[]
): number {
    if (channelData.length !== SEVEN_POINT_ONE_CHANNEL_COUNT) {
        throw new RangeError('7.1 downmix requires exactly 8 input channels');
    }

    const frameCount = channelData[FRONT_LEFT_CHANNEL_INDEX].length;
    for (const channel of channelData) {
        if (channel.length !== frameCount) {
            throw new RangeError('7.1 downmix requires equal-length input channels');
        }
    }
    return frameCount;
}

/**
 * Downmixes WAVE-order 7.1 planar PCM (FL, FR, FC, LFE, BL, BR, SL, SR) to
 * stereo using mpv's default libswresample matrix. The streaming output
 * limiter handles correlated peaks without permanently reducing program gain.
 * LFE is intentionally omitted.
 */
export function downmixSevenPointOneToStereo(
    channelData: readonly Float32Array[]
): StereoChannelData {
    const frameCount = requireSevenPointOnePlanarInput(channelData);
    const frontLeft = channelData[FRONT_LEFT_CHANNEL_INDEX];
    const frontRight = channelData[FRONT_RIGHT_CHANNEL_INDEX];
    const frontCenter = channelData[FRONT_CENTER_CHANNEL_INDEX];
    const backLeft = channelData[BACK_LEFT_CHANNEL_INDEX];
    const backRight = channelData[BACK_RIGHT_CHANNEL_INDEX];
    const sideLeft = channelData[SEVEN_POINT_ONE_SIDE_LEFT_CHANNEL_INDEX];
    const sideRight = channelData[SEVEN_POINT_ONE_SIDE_RIGHT_CHANNEL_INDEX];
    const outputLeft = new Float32Array(frameCount);
    const outputRight = new Float32Array(frameCount);

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        outputLeft[frameIndex] =
            frontLeft[frameIndex] * SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN
            + frontCenter[frameIndex] * SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN
            + backLeft[frameIndex] * SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN
            + sideLeft[frameIndex] * SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN;
        outputRight[frameIndex] =
            frontRight[frameIndex] * SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN
            + frontCenter[frameIndex] * SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN
            + backRight[frameIndex] * SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN
            + sideRight[frameIndex] * SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN;
    }

    return [ outputLeft, outputRight ];
}
