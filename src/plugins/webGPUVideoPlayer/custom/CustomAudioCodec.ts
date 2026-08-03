export const CUSTOM_WEB_CODECS_AUDIO_CODECS = [
    'aac',
    'opus',
    'flac',
    'mp3',
    'vorbis'
] as const;

export const CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS = [
    'pcm_s16le',
    'pcm_s16be',
    'pcm_s24le',
    'pcm_s24be',
    'pcm_s32le',
    'pcm_s32be',
    'pcm_f32le',
    'pcm_f32be',
    'pcm_f64le',
    'pcm_f64be',
    'pcm_u8',
    'pcm_s8',
    'pcm_mulaw',
    'pcm_alaw'
] as const;

export const CUSTOM_BUNDLED_AUDIO_CODECS = [
    'ac3',
    'eac3',
    'dts',
    'mlp',
    'truehd',
    ...CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS
] as const;

export const CUSTOM_AUDIO_CODECS = [
    ...CUSTOM_WEB_CODECS_AUDIO_CODECS,
    ...CUSTOM_BUNDLED_AUDIO_CODECS
] as const;

export type CustomAudioCodec = typeof CUSTOM_AUDIO_CODECS[number];
export type CustomBundledAudioCodec = typeof CUSTOM_BUNDLED_AUDIO_CODECS[number];
export type CustomMediabunnyPCMAudioCodec =
    typeof CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS[number];
