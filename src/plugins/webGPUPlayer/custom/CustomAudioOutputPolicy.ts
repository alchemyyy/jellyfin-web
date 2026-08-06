import {
    CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
    type CustomAudioCodec,
    type CustomMediabunnyPCMAudioCodec
} from './CustomAudioCodec';
import {
    CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT,
    CUSTOM_MONO_INPUT_CHANNEL_COUNT,
    CUSTOM_STEREO_INPUT_CHANNEL_COUNT,
    CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT,
    CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT,
    CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT,
    type CustomAudioOutputChannelCount
} from './CustomAudioChannelLayout';
import {
    DTS_SUPPORTED_INPUT_ROUTES,
    EAC3_SUPPORTED_INPUT_ROUTES,
    TRUEHD_SUPPORTED_INPUT_ROUTES,
    isSupportedTrueHDInputRoute
} from './CustomCompressedAudioRoute';
import { isSupportedCustomAudioSampleRate } from './CustomAudioSampleRate';

export const CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT = CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT;
export const CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE = 48_000;
export const CUSTOM_AUDIO_OUTPUT_CHANNEL_INTERPRETATION = 'speakers' as const;
export const CUSTOM_SURROUND_INPUT_CHANNEL_COUNT =
    CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT;
export { CUSTOM_STEREO_INPUT_CHANNEL_COUNT };
export const CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNTS: readonly CustomAudioOutputChannelCount[] = [
    CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT,
    CUSTOM_FIVE_POINT_ONE_OUTPUT_CHANNEL_COUNT,
    CUSTOM_SEVEN_POINT_ONE_OUTPUT_CHANNEL_COUNT
];

export const MEDIABUNNY_PCM_DECODER_CODECS = [
    'pcm-s16',
    'pcm-s16be',
    'pcm-s24',
    'pcm-s24be',
    'pcm-s32',
    'pcm-s32be',
    'pcm-f32',
    'pcm-f32be',
    'pcm-f64',
    'pcm-f64be',
    'pcm-u8',
    'pcm-s8',
    'ulaw',
    'alaw'
] as const;

export type MediabunnyPCMDecoderCodec = typeof MEDIABUNNY_PCM_DECODER_CODECS[number];

const CUSTOM_STEREO_INPUT_CHANNEL_COUNTS: readonly number[] = [
    CUSTOM_STEREO_INPUT_CHANNEL_COUNT
];
const CUSTOM_SURROUND_INPUT_CHANNEL_COUNTS: readonly number[] = [
    CUSTOM_STEREO_INPUT_CHANNEL_COUNT,
    CUSTOM_SURROUND_INPUT_CHANNEL_COUNT
];
const CUSTOM_EAC3_INPUT_CHANNEL_COUNTS: readonly number[] = [
    ...new Set(EAC3_SUPPORTED_INPUT_ROUTES.map(route => route.channelCount))
];
const CUSTOM_DTS_INPUT_CHANNEL_COUNTS: readonly number[] = [
    ...new Set(DTS_SUPPORTED_INPUT_ROUTES.map(route => route.channelCount))
];
const CUSTOM_TRUEHD_INPUT_CHANNEL_COUNTS: readonly number[] = [
    ...new Set(TRUEHD_SUPPORTED_INPUT_ROUTES
        .filter(route => route.codec === 'truehd')
        .map(route => route.channelCount))
];
const CUSTOM_PCM_INPUT_CHANNEL_COUNTS: readonly number[] = [
    CUSTOM_MONO_INPUT_CHANNEL_COUNT,
    CUSTOM_STEREO_INPUT_CHANNEL_COUNT,
    CUSTOM_SURROUND_INPUT_CHANNEL_COUNT
];
const CUSTOM_MEDIABUNNY_PCM_AUDIO_CODEC_SET = new Set<string>(
    CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS
);
const MEDIABUNNY_PCM_DECODER_CODEC_SET = new Set<string>(
    MEDIABUNNY_PCM_DECODER_CODECS
);

/** Identifies Jellyfin metadata names backed by Mediabunny's PCM decoders. */
export function isCustomMediabunnyPCMAudioCodec(
    codec: string
): codec is CustomMediabunnyPCMAudioCodec {
    return CUSTOM_MEDIABUNNY_PCM_AUDIO_CODEC_SET.has(codec);
}

/** Identifies the codec names returned by Mediabunny input tracks. */
export function isMediabunnyPCMDecoderCodec(
    codec: string
): codec is MediabunnyPCMDecoderCodec {
    return MEDIABUNNY_PCM_DECODER_CODEC_SET.has(codec);
}

function isPCMCodecIdentifier(codec: string): boolean {
    return isCustomMediabunnyPCMAudioCodec(codec)
        || isMediabunnyPCMDecoderCodec(codec);
}

/** Returns the source layouts covered by the codec's decoded PCM route. */
export function getSupportedCustomAudioInputChannelCounts(
    codec: CustomAudioCodec
): readonly number[] {
    if (isCustomMediabunnyPCMAudioCodec(codec)) {
        return CUSTOM_PCM_INPUT_CHANNEL_COUNTS;
    }
    switch (codec) {
        case 'aac':
        case 'ac3':
        case 'flac':
        case 'opus':
        case 'vorbis':
            return CUSTOM_SURROUND_INPUT_CHANNEL_COUNTS;
        case 'eac3':
            return CUSTOM_EAC3_INPUT_CHANNEL_COUNTS;
        case 'dts':
            return CUSTOM_DTS_INPUT_CHANNEL_COUNTS;
        case 'mlp':
            return [ CUSTOM_STEREO_INPUT_CHANNEL_COUNT ];
        case 'truehd':
            return CUSTOM_TRUEHD_INPUT_CHANNEL_COUNTS;
        case 'mp3':
            return CUSTOM_STEREO_INPUT_CHANNEL_COUNTS;
    }
}

/** Accepts source layouts with a complete decoded PCM presentation path. */
export function isSupportedCustomAudioInputLayout(
    codec: string,
    channelCount: unknown,
    sampleRate: unknown
): boolean {
    if (typeof channelCount !== 'number'
        || !isSupportedCustomAudioSampleRate(sampleRate)) {
        return false;
    }

    if (isPCMCodecIdentifier(codec)) {
        return CUSTOM_PCM_INPUT_CHANNEL_COUNTS.includes(channelCount);
    }
    if (codec === 'dts') {
        return CUSTOM_DTS_INPUT_CHANNEL_COUNTS.includes(channelCount);
    }
    if (codec === 'mlp' || codec === 'truehd') {
        return isSupportedTrueHDInputRoute(codec, channelCount, sampleRate);
    }

    switch (codec) {
        case 'aac':
        case 'ac3':
        case 'flac':
        case 'opus':
        case 'vorbis':
            return CUSTOM_SURROUND_INPUT_CHANNEL_COUNTS.includes(channelCount);
        case 'eac3':
            return CUSTOM_EAC3_INPUT_CHANNEL_COUNTS.includes(channelCount);
        case 'mp3':
            return CUSTOM_STEREO_INPUT_CHANNEL_COUNTS.includes(channelCount);
        default:
            return false;
    }
}

/** Accepts the measured stereo, 5.1, and 7.1 worklet layouts at 48 kHz. */
export function isSupportedCustomAudioOutputLayout(
    channelCount: unknown,
    sampleRate: unknown
): boolean {
    return typeof channelCount === 'number'
        && CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNTS.includes(
            channelCount as CustomAudioOutputChannelCount
        )
        && sampleRate === CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE;
}

/** Rejects decoded output that exceeds the measured audio presentation route. */
export function assertSupportedCustomAudioOutputLayout(
    channelCount: unknown,
    sampleRate: unknown
): void {
    if (!isSupportedCustomAudioOutputLayout(channelCount, sampleRate)) {
        throw new RangeError(
            'Custom audio output requires 2, 6, or 8 channels at '
            + `${CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE} Hz`
        );
    }
}
