import {
    CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
    CUSTOM_VIDEO_CODECS,
    CUSTOM_WEB_CODECS_AUDIO_CODECS,
    type CustomAudioCodec,
    type CustomVideoCodec
} from './CustomDecodeCapabilities';

export type CustomContainerCodecRule = Readonly<{
    audioCodecs: readonly CustomAudioCodec[]
    containerAliases: readonly string[]
    profileContainers: readonly string[]
    videoCodecs: readonly CustomVideoCodec[]
}>;

const CUSTOM_COMPRESSED_AUDIO_CODECS: readonly CustomAudioCodec[] = Object.freeze([
    ...CUSTOM_WEB_CODECS_AUDIO_CODECS,
    'ac3',
    'eac3'
]);
const CUSTOM_ISO_BASE_MEDIA_PCM_AUDIO_CODECS: readonly CustomAudioCodec[] = Object.freeze([
    'pcm_s16le',
    'pcm_s16be',
    'pcm_s24le',
    'pcm_s24be',
    'pcm_s32le',
    'pcm_s32be',
    'pcm_f32le',
    'pcm_f32be',
    'pcm_f64le',
    'pcm_f64be'
]);
const CUSTOM_MATROSKA_AUDIO_CODECS: readonly CustomAudioCodec[] = Object.freeze([
    ...CUSTOM_COMPRESSED_AUDIO_CODECS,
    'dts',
    'mlp',
    'truehd',
    'pcm_u8',
    'pcm_s16le',
    'pcm_s16be',
    'pcm_s24le',
    'pcm_s24be',
    'pcm_s32le',
    'pcm_s32be',
    'pcm_f32le',
    'pcm_f64le'
]);
const CUSTOM_NATIVE_VIDEO_CODECS: readonly CustomVideoCodec[] = Object.freeze(
    CUSTOM_VIDEO_CODECS.filter((codec: CustomVideoCodec): boolean => (
        codec !== 'jpeg2000' && codec !== 'mpeg2video' && codec !== 'vc1'
    ))
);
const CUSTOM_MATROSKA_VIDEO_CODECS: readonly CustomVideoCodec[] = Object.freeze([
    ...CUSTOM_NATIVE_VIDEO_CODECS,
    'mpeg2video',
    'vc1'
]);
export const CUSTOM_MATROSKA_PROFILE_CONTAINER = 'mkv';

/**
 * Defines container compatibility independently of the selected decoder
 * backends. Exact codec and layout probes decide whether each track is
 * supported; these rules only decide whether the container can carry them.
 */
export const CUSTOM_CONTAINER_CODEC_RULES: readonly CustomContainerCodecRule[] =
    Object.freeze([
        Object.freeze({
            audioCodecs: CUSTOM_COMPRESSED_AUDIO_CODECS,
            containerAliases: Object.freeze([ '3gp', '3g2', 'mj2' ]),
            profileContainers: Object.freeze([ 'mp4', 'm4v', 'mov' ]),
            videoCodecs: CUSTOM_NATIVE_VIDEO_CODECS
        }),
        Object.freeze({
            audioCodecs: CUSTOM_ISO_BASE_MEDIA_PCM_AUDIO_CODECS,
            containerAliases: Object.freeze([]),
            profileContainers: Object.freeze([ 'mp4', 'm4v', 'mov' ]),
            videoCodecs: CUSTOM_NATIVE_VIDEO_CODECS
        }),
        Object.freeze({
            audioCodecs: CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
            containerAliases: Object.freeze([]),
            profileContainers: Object.freeze([ 'mov' ]),
            videoCodecs: CUSTOM_NATIVE_VIDEO_CODECS
        }),
        Object.freeze({
            audioCodecs: Object.freeze([
                ...CUSTOM_COMPRESSED_AUDIO_CODECS,
                ...CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS
            ] as const),
            containerAliases: Object.freeze([]),
            profileContainers: Object.freeze([ 'mov', 'mj2' ]),
            videoCodecs: Object.freeze([ 'jpeg2000' ] as const)
        }),
        Object.freeze({
            audioCodecs: CUSTOM_MATROSKA_AUDIO_CODECS,
            containerAliases: Object.freeze([ 'matroska' ]),
            profileContainers: Object.freeze([ CUSTOM_MATROSKA_PROFILE_CONTAINER ]),
            videoCodecs: CUSTOM_MATROSKA_VIDEO_CODECS
        }),
        Object.freeze({
            audioCodecs: Object.freeze([ 'opus', 'vorbis' ] as const),
            containerAliases: Object.freeze([]),
            profileContainers: Object.freeze([ 'webm' ]),
            videoCodecs: Object.freeze([ 'vp8', 'vp9', 'av1' ] as const)
        }),
        Object.freeze({
            audioCodecs: Object.freeze([ 'aac', 'mp3', 'ac3', 'eac3' ] as const),
            containerAliases: Object.freeze([]),
            profileContainers: Object.freeze([ 'ts', 'm2ts', 'mts' ]),
            videoCodecs: Object.freeze([ 'h264', 'hevc' ] as const)
        })
    ]);

const customProfileVideoContainers: string[] = [];
for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
    for (const container of rule.profileContainers) {
        if (!customProfileVideoContainers.includes(container)) {
            customProfileVideoContainers.push(container);
        }
    }
}

export const CUSTOM_PROFILE_VIDEO_CONTAINERS: readonly string[] =
    Object.freeze(customProfileVideoContainers);

function ruleContainsContainer(
    rule: CustomContainerCodecRule,
    normalizedContainer: string
): boolean {
    return rule.profileContainers.some(container => (
        container.toUpperCase() === normalizedContainer
    )) || rule.containerAliases.some(container => (
        container.toUpperCase() === normalizedContainer
    ));
}

/** Returns whether any custom route owns the normalized container token. */
export function isCustomPlaybackContainer(container: string): boolean {
    const normalizedContainer: string = container.trim().toUpperCase();
    return CUSTOM_CONTAINER_CODEC_RULES.some(rule => (
        ruleContainsContainer(rule, normalizedContainer)
    ));
}

/** Composes independently supported tracks only when their container permits both. */
export function supportsCustomContainerCodecCombination(
    containers: readonly string[],
    videoCodec: CustomVideoCodec,
    audioCodec: CustomAudioCodec | null
): boolean {
    for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
        const containerSupported: boolean = containers.some(container => (
            ruleContainsContainer(rule, container.trim().toUpperCase())
        ));
        if (!containerSupported
            || !rule.videoCodecs.includes(videoCodec)
            || (audioCodec !== null && !rule.audioCodecs.includes(audioCodec))) {
            continue;
        }
        return true;
    }
    return false;
}
