import {
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS,
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    type CustomAudioDownmixAlgorithm as CustomAudioDownmixAlgorithmValue
} from './CustomAudioDownmixAlgorithm';

const FIVE_POINT_ONE_CHANNEL_COUNT = 6;
const SIX_POINT_ONE_CHANNEL_COUNT = 7;
const SEVEN_POINT_ONE_CHANNEL_COUNT = 8;
const FRONT_LEFT_CHANNEL_INDEX = 0;
const FRONT_RIGHT_CHANNEL_INDEX = 1;
const FRONT_CENTER_CHANNEL_INDEX = 2;
const LOW_FREQUENCY_EFFECTS_CHANNEL_INDEX = 3;
const BACK_LEFT_CHANNEL_INDEX = 4;
const BACK_RIGHT_CHANNEL_INDEX = 5;
const BACK_CENTER_CHANNEL_INDEX = 4;
const SURROUND_LEFT_CHANNEL_INDEX = 4;
const SURROUND_RIGHT_CHANNEL_INDEX = 5;
const SEVEN_POINT_ONE_SIDE_LEFT_CHANNEL_INDEX = 6;
const SEVEN_POINT_ONE_SIDE_RIGHT_CHANNEL_INDEX = 7;
const SIX_POINT_ONE_SIDE_LEFT_CHANNEL_INDEX = 5;
const SIX_POINT_ONE_SIDE_RIGHT_CHANNEL_INDEX = 6;

const SIX_POINT_ONE_DIRECT_CHANNEL_GAIN = 1 / (1 + 3 / Math.SQRT2);
const SIX_POINT_ONE_MIXED_CHANNEL_GAIN =
    SIX_POINT_ONE_DIRECT_CHANNEL_GAIN / Math.SQRT2;
const STEREO_FINGERPRINT_OFFSET_BASIS = 0x811c9dc5;
const STEREO_FINGERPRINT_PRIME = 0x01000193;

type FivePointOneDownmixCoefficients = Readonly<{
    center: number
    direct: number
    lfe: number
    oppositeSurround: number
    surround: number
}>;

type SevenPointOneDownmixCoefficients = Readonly<{
    back: number
    center: number
    direct: number
    lfe: number
    oppositeBack: number
    oppositeSide: number
    side: number
}>;

const STANDARD_MIXED_CHANNEL_GAIN = Math.SQRT1_2;
const FIVE_POINT_ONE_NORMALIZATION_GAIN =
    1 / (1 + 2 * STANDARD_MIXED_CHANNEL_GAIN);
const SEVEN_POINT_ONE_NORMALIZATION_GAIN =
    1 / (1 + 3 * STANDARD_MIXED_CHANNEL_GAIN);
const AC4_FOLDED_SURROUND_GAIN = 0.5;
const NIGHT_MODE_FOLDED_SURROUND_GAIN = 0.3 * Math.SQRT1_2;

const FIVE_POINT_ONE_STANDARD_COEFFICIENTS: FivePointOneDownmixCoefficients =
    Object.freeze({
        center: STANDARD_MIXED_CHANNEL_GAIN,
        direct: 1,
        lfe: 0,
        oppositeSurround: 0,
        surround: STANDARD_MIXED_CHANNEL_GAIN
    });
const FIVE_POINT_ONE_DAVE750_COEFFICIENTS: FivePointOneDownmixCoefficients =
    Object.freeze({
        center: 0.5,
        direct: 0.707,
        lfe: 0.5,
        oppositeSurround: 0,
        surround: 0.707
    });
const FIVE_POINT_ONE_NIGHT_MODE_COEFFICIENTS: FivePointOneDownmixCoefficients =
    Object.freeze({
        center: 1,
        direct: 0.3,
        lfe: 0,
        oppositeSurround: 0,
        surround: 0.3
    });
const FIVE_POINT_ONE_NORMALIZED_COEFFICIENTS: FivePointOneDownmixCoefficients =
    Object.freeze({
        center: STANDARD_MIXED_CHANNEL_GAIN * FIVE_POINT_ONE_NORMALIZATION_GAIN,
        direct: FIVE_POINT_ONE_NORMALIZATION_GAIN,
        lfe: 0,
        oppositeSurround: 0,
        surround: STANDARD_MIXED_CHANNEL_GAIN * FIVE_POINT_ONE_NORMALIZATION_GAIN
    });
const FIVE_POINT_ONE_RFC7845_COEFFICIENTS: FivePointOneDownmixCoefficients =
    Object.freeze({
        center: 0.374107,
        direct: 0.529067,
        lfe: 0.374107,
        oppositeSurround: 0.264534,
        surround: 0.458186
    });

const SEVEN_POINT_ONE_STANDARD_COEFFICIENTS: SevenPointOneDownmixCoefficients =
    Object.freeze({
        back: STANDARD_MIXED_CHANNEL_GAIN,
        center: STANDARD_MIXED_CHANNEL_GAIN,
        direct: 1,
        lfe: 0,
        oppositeBack: 0,
        oppositeSide: 0,
        side: STANDARD_MIXED_CHANNEL_GAIN
    });
const SEVEN_POINT_ONE_AC4_COEFFICIENTS: SevenPointOneDownmixCoefficients =
    Object.freeze({
        back: AC4_FOLDED_SURROUND_GAIN,
        center: STANDARD_MIXED_CHANNEL_GAIN,
        direct: 1,
        lfe: 0,
        oppositeBack: 0,
        oppositeSide: 0,
        side: AC4_FOLDED_SURROUND_GAIN
    });
const SEVEN_POINT_ONE_DAVE750_COEFFICIENTS: SevenPointOneDownmixCoefficients =
    Object.freeze({
        back: AC4_FOLDED_SURROUND_GAIN,
        center: 0.5,
        direct: 0.707,
        lfe: 0.5,
        oppositeBack: 0,
        oppositeSide: 0,
        side: AC4_FOLDED_SURROUND_GAIN
    });
const SEVEN_POINT_ONE_NIGHT_MODE_COEFFICIENTS: SevenPointOneDownmixCoefficients =
    Object.freeze({
        back: NIGHT_MODE_FOLDED_SURROUND_GAIN,
        center: 1,
        direct: 0.3,
        lfe: 0,
        oppositeBack: 0,
        oppositeSide: 0,
        side: NIGHT_MODE_FOLDED_SURROUND_GAIN
    });
const SEVEN_POINT_ONE_NORMALIZED_COEFFICIENTS: SevenPointOneDownmixCoefficients =
    Object.freeze({
        back: STANDARD_MIXED_CHANNEL_GAIN * SEVEN_POINT_ONE_NORMALIZATION_GAIN,
        center: STANDARD_MIXED_CHANNEL_GAIN * SEVEN_POINT_ONE_NORMALIZATION_GAIN,
        direct: SEVEN_POINT_ONE_NORMALIZATION_GAIN,
        lfe: 0,
        oppositeBack: 0,
        oppositeSide: 0,
        side: STANDARD_MIXED_CHANNEL_GAIN * SEVEN_POINT_ONE_NORMALIZATION_GAIN
    });
const SEVEN_POINT_ONE_RFC7845_COEFFICIENTS: SevenPointOneDownmixCoefficients =
    Object.freeze({
        back: 0.336565,
        center: 0.274804,
        direct: 0.388631,
        lfe: 0.274804,
        oppositeBack: 0.194316,
        oppositeSide: 0.194316,
        side: 0.336565
    });

export const CUSTOM_SEVEN_POINT_ONE_DOWNMIX_POLICY = 'mpv-default-limited' as const;
export const FIVE_POINT_ONE_DIRECT_CHANNEL_GAIN = 1;
export const FIVE_POINT_ONE_MIXED_CHANNEL_GAIN = STANDARD_MIXED_CHANNEL_GAIN;
export const FIVE_POINT_ONE_MAXIMUM_CORRELATED_PEAK =
    FIVE_POINT_ONE_DIRECT_CHANNEL_GAIN
    + 2 * FIVE_POINT_ONE_MIXED_CHANNEL_GAIN;
export const SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN = 1;
export const SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN = STANDARD_MIXED_CHANNEL_GAIN;
export const SEVEN_POINT_ONE_MAXIMUM_CORRELATED_PEAK =
    SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN
    + 3 * SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN;

export type StereoChannelData = [ Float32Array, Float32Array ];

function getFivePointOneDownmixCoefficients(
    algorithm: CustomAudioDownmixAlgorithmValue
): FivePointOneDownmixCoefficients {
    switch (algorithm) {
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4:
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO:
            return FIVE_POINT_ONE_STANDARD_COEFFICIENTS;
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750:
            return FIVE_POINT_ONE_DAVE750_COEFFICIENTS;
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue:
            return FIVE_POINT_ONE_NIGHT_MODE_COEFFICIENTS;
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO:
            return FIVE_POINT_ONE_NORMALIZED_COEFFICIENTS;
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845:
            return FIVE_POINT_ONE_RFC7845_COEFFICIENTS;
    }
}

function getSevenPointOneDownmixCoefficients(
    algorithm: CustomAudioDownmixAlgorithmValue
): SevenPointOneDownmixCoefficients {
    switch (algorithm) {
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4:
            return SEVEN_POINT_ONE_AC4_COEFFICIENTS;
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750:
            return SEVEN_POINT_ONE_DAVE750_COEFFICIENTS;
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue:
            return SEVEN_POINT_ONE_NIGHT_MODE_COEFFICIENTS;
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO:
            return SEVEN_POINT_ONE_NORMALIZED_COEFFICIENTS;
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845:
            return SEVEN_POINT_ONE_RFC7845_COEFFICIENTS;
        case CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO:
            return SEVEN_POINT_ONE_STANDARD_COEFFICIENTS;
    }
}

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
 * stereo with the selected matrix. Standard Lo/Ro intentionally omits LFE.
 */
export function downmixFivePointOneToStereo(
    channelData: readonly Float32Array[],
    algorithm: CustomAudioDownmixAlgorithmValue =
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
): StereoChannelData {
    const frameCount = requireFivePointOnePlanarInput(channelData);
    const coefficients = getFivePointOneDownmixCoefficients(algorithm);
    const frontLeft = channelData[FRONT_LEFT_CHANNEL_INDEX];
    const frontRight = channelData[FRONT_RIGHT_CHANNEL_INDEX];
    const frontCenter = channelData[FRONT_CENTER_CHANNEL_INDEX];
    const lfe = channelData[LOW_FREQUENCY_EFFECTS_CHANNEL_INDEX];
    const surroundLeft = channelData[SURROUND_LEFT_CHANNEL_INDEX];
    const surroundRight = channelData[SURROUND_RIGHT_CHANNEL_INDEX];
    const outputLeft = new Float32Array(frameCount);
    const outputRight = new Float32Array(frameCount);

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        outputLeft[frameIndex] =
            frontLeft[frameIndex] * coefficients.direct
            + frontCenter[frameIndex] * coefficients.center
            + lfe[frameIndex] * coefficients.lfe
            + surroundLeft[frameIndex] * coefficients.surround
            + surroundRight[frameIndex] * coefficients.oppositeSurround;
        outputRight[frameIndex] =
            frontRight[frameIndex] * coefficients.direct
            + frontCenter[frameIndex] * coefficients.center
            + lfe[frameIndex] * coefficients.lfe
            + surroundRight[frameIndex] * coefficients.surround
            + surroundLeft[frameIndex] * coefficients.oppositeSurround;
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
 * stereo with the selected matrix. Standard Lo/Ro uses mpv's default
 * libswresample coefficients and omits LFE; the output limiter handles peaks.
 */
export function downmixSevenPointOneToStereo(
    channelData: readonly Float32Array[],
    algorithm: CustomAudioDownmixAlgorithmValue =
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
): StereoChannelData {
    const frameCount = requireSevenPointOnePlanarInput(channelData);
    const coefficients = getSevenPointOneDownmixCoefficients(algorithm);
    const frontLeft = channelData[FRONT_LEFT_CHANNEL_INDEX];
    const frontRight = channelData[FRONT_RIGHT_CHANNEL_INDEX];
    const frontCenter = channelData[FRONT_CENTER_CHANNEL_INDEX];
    const lfe = channelData[LOW_FREQUENCY_EFFECTS_CHANNEL_INDEX];
    const backLeft = channelData[BACK_LEFT_CHANNEL_INDEX];
    const backRight = channelData[BACK_RIGHT_CHANNEL_INDEX];
    const sideLeft = channelData[SEVEN_POINT_ONE_SIDE_LEFT_CHANNEL_INDEX];
    const sideRight = channelData[SEVEN_POINT_ONE_SIDE_RIGHT_CHANNEL_INDEX];
    const outputLeft = new Float32Array(frameCount);
    const outputRight = new Float32Array(frameCount);

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        outputLeft[frameIndex] =
            frontLeft[frameIndex] * coefficients.direct
            + frontCenter[frameIndex] * coefficients.center
            + lfe[frameIndex] * coefficients.lfe
            + backLeft[frameIndex] * coefficients.back
            + backRight[frameIndex] * coefficients.oppositeBack
            + sideLeft[frameIndex] * coefficients.side
            + sideRight[frameIndex] * coefficients.oppositeSide;
        outputRight[frameIndex] =
            frontRight[frameIndex] * coefficients.direct
            + frontCenter[frameIndex] * coefficients.center
            + lfe[frameIndex] * coefficients.lfe
            + backRight[frameIndex] * coefficients.back
            + backLeft[frameIndex] * coefficients.oppositeBack
            + sideRight[frameIndex] * coefficients.side
            + sideLeft[frameIndex] * coefficients.oppositeSide;
    }

    return [ outputLeft, outputRight ];
}
