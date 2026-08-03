import {
    CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
    type CustomAudioCodec,
    type CustomMediabunnyPCMAudioCodec
} from './CustomAudioCodec';
import {
    CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT,
    CUSTOM_MONO_INPUT_CHANNEL_COUNT,
    CUSTOM_STEREO_INPUT_CHANNEL_COUNT
} from './CustomAudioChannelLayout';
import {
    DTS_EXACT_INPUT_ROUTES,
    TRUEHD_EXACT_INPUT_ROUTES,
    isQualifiedTrueHDInputRoute
} from './CustomCompressedAudioRoute';

export const CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT = 2;
export const CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE = 48_000;
export const CUSTOM_AUDIO_OUTPUT_CHANNEL_INTERPRETATION = 'speakers' as const;
export const CUSTOM_SURROUND_INPUT_CHANNEL_COUNT =
    CUSTOM_FIVE_POINT_ONE_INPUT_CHANNEL_COUNT;
export { CUSTOM_STEREO_INPUT_CHANNEL_COUNT };

export const CUSTOM_QUALIFIED_PCM_INPUT_SAMPLE_RATES = [
    8_000,
    11_025,
    12_000,
    16_000,
    22_050,
    24_000,
    32_000,
    44_100,
    48_000,
    88_200,
    96_000,
    176_400,
    192_000
] as const;

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
const CUSTOM_DTS_INPUT_CHANNEL_COUNTS: readonly number[] = [
    ...new Set(DTS_EXACT_INPUT_ROUTES.map(route => route.channelCount))
];
const CUSTOM_DTS_INPUT_SAMPLE_RATES: readonly number[] = [
    ...new Set(DTS_EXACT_INPUT_ROUTES.map(route => route.sampleRate))
];
const CUSTOM_TRUEHD_INPUT_CHANNEL_COUNTS: readonly number[] = [
    ...new Set(TRUEHD_EXACT_INPUT_ROUTES
        .filter(route => route.codec === 'truehd')
        .map(route => route.channelCount))
];
const CUSTOM_TRUEHD_INPUT_SAMPLE_RATES: readonly number[] = [
    ...new Set(TRUEHD_EXACT_INPUT_ROUTES
        .filter(route => route.codec === 'truehd')
        .map(route => route.sampleRate))
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
const CUSTOM_QUALIFIED_PCM_INPUT_SAMPLE_RATE_SET = new Set<number>(
    CUSTOM_QUALIFIED_PCM_INPUT_SAMPLE_RATES
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
        case 'eac3':
        case 'flac':
        case 'opus':
        case 'vorbis':
            return CUSTOM_SURROUND_INPUT_CHANNEL_COUNTS;
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

/** Returns exact source rates covered by the codec's normalization route. */
export function getSupportedCustomAudioInputSampleRates(
    codec: CustomAudioCodec
): readonly number[] {
    switch (codec) {
        case 'dts':
            return CUSTOM_DTS_INPUT_SAMPLE_RATES;
        case 'mlp':
            return [ 48_000 ];
        case 'truehd':
            return CUSTOM_TRUEHD_INPUT_SAMPLE_RATES;
    }
    return isCustomMediabunnyPCMAudioCodec(codec) ?
        CUSTOM_QUALIFIED_PCM_INPUT_SAMPLE_RATES :
        [ CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE ];
}

/** Accepts source layouts with a complete decoded PCM presentation path. */
export function isSupportedCustomAudioInputLayout(
    codec: string,
    channelCount: unknown,
    sampleRate: unknown
): boolean {
    if (typeof channelCount !== 'number' || typeof sampleRate !== 'number') {
        return false;
    }

    if (isPCMCodecIdentifier(codec)) {
        return CUSTOM_PCM_INPUT_CHANNEL_COUNTS.includes(channelCount)
            && CUSTOM_QUALIFIED_PCM_INPUT_SAMPLE_RATE_SET.has(sampleRate);
    }
    if (codec === 'dts') {
        for (const route of DTS_EXACT_INPUT_ROUTES) {
            if (route.channelCount === channelCount && route.sampleRate === sampleRate) {
                return true;
            }
        }
        return false;
    }
    if (codec === 'mlp' || codec === 'truehd') {
        return isQualifiedTrueHDInputRoute(codec, channelCount, sampleRate);
    }
    if (sampleRate !== CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE) {
        return false;
    }

    switch (codec) {
        case 'aac':
        case 'ac3':
        case 'eac3':
        case 'flac':
        case 'opus':
        case 'vorbis':
            return CUSTOM_SURROUND_INPUT_CHANNEL_COUNTS.includes(channelCount);
        case 'mp3':
            return CUSTOM_STEREO_INPUT_CHANNEL_COUNTS.includes(channelCount);
        default:
            return false;
    }
}

/** Accepts the fixed stereo, 48 kHz layout after any required input transform. */
export function isSupportedCustomAudioOutputLayout(
    channelCount: unknown,
    sampleRate: unknown
): boolean {
    return channelCount === CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT
        && sampleRate === CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE;
}

/** Rejects decoded output that exceeds the measured audio presentation route. */
export function assertSupportedCustomAudioOutputLayout(
    channelCount: unknown,
    sampleRate: unknown
): void {
    if (!isSupportedCustomAudioOutputLayout(channelCount, sampleRate)) {
        throw new RangeError(
            `Custom audio output requires ${CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT} channels at `
            + `${CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE} Hz`
        );
    }
}
