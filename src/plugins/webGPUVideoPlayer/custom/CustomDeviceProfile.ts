import type { CodecProfile } from '@jellyfin/sdk/lib/generated-client/models/codec-profile';
import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import type { DirectPlayProfile } from '@jellyfin/sdk/lib/generated-client/models/direct-play-profile';
import type { ProfileCondition } from '@jellyfin/sdk/lib/generated-client/models/profile-condition';

import {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_BUNDLED_HEVC_BASELINE_MAXIMUM_FRAMES_PER_SECOND,
    CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
    CUSTOM_NATIVE_VIDEO_BIT_DEPTH,
    CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT,
    CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH,
    CUSTOM_RAW_HDR_VIDEO_CODECS,
    CUSTOM_VIDEO_CODECS,
    CUSTOM_WEB_CODECS_AUDIO_CODECS,
    isCustomHDRVideoMaximumFramesPerSecond,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomNativeHDRHEVCCapability,
    type CustomNativeSurroundAudioCodecCapability,
    type CustomNativeUltraHDVideoCodecCapability,
    type CustomRawHDRVideoCodecCapability,
    type CustomVideoCodec
} from './CustomDecodeCapabilities';
import {
    CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT,
    CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
    CUSTOM_SURROUND_INPUT_CHANNEL_COUNT,
    getSupportedCustomAudioInputChannelCounts,
    getSupportedCustomAudioInputSampleRates,
    isCustomMediabunnyPCMAudioCodec
} from './CustomAudioOutputPolicy';
import {
    DTS_EXACT_INPUT_ROUTES,
    DTS_PROFILE_VALUE_BY_TOKEN,
    TRUEHD_EXACT_INPUT_ROUTES,
    type DTSProfileToken
} from './CustomCompressedAudioRoute';
import {
    NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS,
    NATIVE_MEDIA_AUDIO_SAMPLE_RATE,
    type NativeMediaAudioCapabilities,
    type NativeMediaAudioChannelCount,
    type NativeMediaAudioCodec
} from './NativeMediaAudioCapabilities';
import { getSupportedH264JellyfinProfileNames } from './H264ProfileCapabilities';
import type { BundledHEVCExactTierCapability } from './HEVCExactCapabilityProbe';
import type {
    ExternalHDRAuthorizationRouteKey
} from '../validation/ExternalHDRPresentationAuthorization';
import type { RawHDRAuthorizationRouteKey } from '../validation/RawHDRPresentationAuthorization';

export type CustomDeviceProfileOptions = {
    allowDolbyVision?: boolean
    allowDolbyVisionProfile7?: boolean
    allowDolbyVisionProfile7HDR10Base?: boolean
    allowNativeDolbyVision?: boolean
    allowNativeHDR?: boolean
    allowRawHDR?: boolean
    authorizedExternalHDRRouteKeys?: readonly ExternalHDRAuthorizationRouteKey[]
    authorizedRawHDRRouteKeys?: readonly RawHDRAuthorizationRouteKey[]
    isRetry?: boolean
    nativeMediaAudioCapabilities?: NativeMediaAudioCapabilities | null
};

export type CustomDeviceProfileReason =
    | 'already-advertised'
    | 'augmented'
    | 'no-compatible-combinations'
    | 'no-supported-codecs'
    | 'retry-not-widened';

export type CustomDeviceProfileTelemetry = {
    addedAudioProfileCount: number
    addedProfileCount: number
    addedVideoProfileCount: number
    reason: CustomDeviceProfileReason
    supportedAudioCodecs: readonly CustomAudioCodec[]
    supportedVideoCodecs: readonly CustomVideoCodec[]
    widenedHDRCodecProfileCount: number
};

export type CustomDeviceProfileResult = {
    profile: DeviceProfile
    telemetry: CustomDeviceProfileTelemetry
};

type VideoContainerRule = {
    audioCodecs: readonly CustomAudioCodec[]
    container: string
    videoCodecs: readonly CustomVideoCodec[]
};

type AuthorizedHDRRoutes = {
    allowNativeDolbyVision: boolean
    allowNativeHDR: boolean
    allowRawDolbyVision: boolean
    dolbyVisionVideoRangeTypes: readonly string[]
    nativeHDRVideoRangeTypes: readonly string[]
    rawHDRVideoRangeTypes: readonly string[]
};

type MeasuredVideoRouteOptions = {
    allowNativeDolbyVision: boolean
    allowNativeHDR: boolean
    nativeDolbyVisionVideoRangeTypes: readonly string[]
    nativeHDRVideoRangeTypes: readonly string[]
    rawDolbyVisionVideoRangeTypes: readonly string[]
    rawHDRVideoRangeTypes: readonly string[]
};

type AuthorizedHEVCProfilePlan = {
    limits: RawHDRCapabilityLimits
    rangeTypes: readonly string[]
};

const CUSTOM_COMPRESSED_AUDIO_CODECS: readonly CustomAudioCodec[] = [
    'aac',
    'opus',
    'flac',
    'mp3',
    'vorbis',
    'ac3',
    'eac3'
];
const CUSTOM_NATIVE_VIDEO_CODECS: readonly CustomVideoCodec[] =
    CUSTOM_VIDEO_CODECS.filter((codec: CustomVideoCodec): boolean => (
        codec !== 'jpeg2000' && codec !== 'mpeg2video'
    ));
const ISO_BASE_MEDIA_VIDEO_RULE: VideoContainerRule = {
    audioCodecs: CUSTOM_COMPRESSED_AUDIO_CODECS,
    container: 'mp4,m4v,mov',
    videoCodecs: CUSTOM_NATIVE_VIDEO_CODECS
};
const ISO_BASE_MEDIA_PCM_VIDEO_RULE: VideoContainerRule = {
    audioCodecs: [
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
    ],
    container: 'mp4,m4v,mov',
    videoCodecs: CUSTOM_NATIVE_VIDEO_CODECS
};
const QUICKTIME_PCM_VIDEO_RULE: VideoContainerRule = {
    audioCodecs: CUSTOM_MEDIABUNNY_PCM_AUDIO_CODECS,
    container: 'mov',
    videoCodecs: CUSTOM_NATIVE_VIDEO_CODECS
};
const MATROSKA_VIDEO_RULE: VideoContainerRule = {
    audioCodecs: [
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
    ],
    container: 'mkv',
    videoCodecs: CUSTOM_NATIVE_VIDEO_CODECS
};
const JPEG2000_ISO_BASE_MEDIA_VIDEO_RULE: VideoContainerRule = {
    audioCodecs: CUSTOM_WEB_CODECS_AUDIO_CODECS,
    container: 'mov,mj2',
    videoCodecs: [ 'jpeg2000' ]
};
const LEGACY_MATROSKA_VIDEO_RULE: VideoContainerRule = {
    audioCodecs: CUSTOM_WEB_CODECS_AUDIO_CODECS,
    container: 'mkv',
    videoCodecs: [ 'mpeg2video' ]
};
const WEBM_VIDEO_RULE: VideoContainerRule = {
    audioCodecs: [ 'opus', 'vorbis' ],
    container: 'webm',
    videoCodecs: [ 'vp8', 'vp9', 'av1' ]
};
const MPEG_TS_VIDEO_RULE: VideoContainerRule = {
    audioCodecs: [ 'aac', 'mp3', 'ac3', 'eac3' ],
    container: 'ts,m2ts,mts',
    videoCodecs: [ 'h264', 'hevc' ]
};
const VIDEO_CONTAINER_RULES: readonly VideoContainerRule[] = [
    ISO_BASE_MEDIA_VIDEO_RULE,
    ISO_BASE_MEDIA_PCM_VIDEO_RULE,
    QUICKTIME_PCM_VIDEO_RULE,
    MATROSKA_VIDEO_RULE,
    JPEG2000_ISO_BASE_MEDIA_VIDEO_RULE,
    LEGACY_MATROSKA_VIDEO_RULE,
    WEBM_VIDEO_RULE,
    MPEG_TS_VIDEO_RULE
];
const CUSTOM_VIDEO_CONTAINERS = [
    'mp4',
    'm4v',
    'mov',
    'mj2',
    'mkv',
    'webm',
    'ts',
    'm2ts',
    'mts'
] as const;
const CUSTOM_VIDEO_CONTAINER_SET = new Set<string>(CUSTOM_VIDEO_CONTAINERS);
const CUSTOM_VIDEO_CONTAINER_VALUE = CUSTOM_VIDEO_CONTAINERS.join(',');
const NON_CUSTOM_VIDEO_CONTAINER_VALUE = `-${CUSTOM_VIDEO_CONTAINER_VALUE}`;
const VIDEO_CODEC_PROFILE_TYPE = 'Video';
const AUDIO_BITRATE_PROPERTY = 'AudioBitrate';
const VIDEO_RANGE_TYPE_PROPERTY = 'VideoRangeType';
const VIDEO_BIT_DEPTH_PROPERTY = 'VideoBitDepth';
const VIDEO_BITRATE_PROPERTY = 'VideoBitrate';
const VIDEO_FRAMERATE_PROPERTY = 'VideoFramerate';
const VIDEO_HEIGHT_PROPERTY = 'Height';
const VIDEO_INTERLACED_PROPERTY = 'IsInterlaced';
const VIDEO_LEVEL_PROPERTY = 'VideoLevel';
const VIDEO_PROFILE_PROPERTY = 'VideoProfile';
const VIDEO_WIDTH_PROPERTY = 'Width';
const AUDIO_CHANNELS_PROPERTY = 'AudioChannels';
const AUDIO_PROFILE_PROPERTY = 'AudioProfile';
const AUDIO_SAMPLE_RATE_PROPERTY = 'AudioSampleRate';
const EQUALS_ANY_CONDITION = 'EqualsAny';
const LESS_THAN_EQUAL_CONDITION = 'LessThanEqual';
const MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH = 10;
const DOLBY_VISION_VIDEO_RANGE_TYPES = [
    'DOVI',
    'DOVIWithHDR10',
    'DOVIWithHLG'
] as const;
const BITRATE_CONDITION_PROPERTIES = new Set<string>([
    AUDIO_BITRATE_PROPERTY,
    VIDEO_BITRATE_PROPERTY
]);
const SUPPORTED_DTS_AUDIO_PROFILES: readonly string[] =
    Object.freeze(Object.values(DTS_PROFILE_VALUE_BY_TOKEN));

function getDolbyVisionVideoRangeTypes(
    capabilities: CustomDecodeCapabilities,
    allowRawDolbyVision: boolean,
    allowRawDolbyVisionProfile7: boolean,
    allowRawDolbyVisionProfile7HDR10Base: boolean,
    allowNativeDolbyVision: boolean
): string[] {
    const rangeTypes: string[] = [];
    if (
        allowNativeDolbyVision
        && capabilities.nativeDolbyVisionHEVC?.status === 'supported'
        && isCustomHDRVideoMaximumFramesPerSecond(
            capabilities.nativeDolbyVisionHEVC.maximumFramesPerSecond
        )
    ) {
        rangeTypes.push('DOVI');
    }
    if (capabilities.rawHDRVideo.hevc.status !== 'supported') {
        return rangeTypes;
    }
    if (allowRawDolbyVision) {
        for (const rangeType of DOLBY_VISION_VIDEO_RANGE_TYPES) {
            if (!rangeTypes.includes(rangeType)) {
                rangeTypes.push(rangeType);
            }
        }
    }
    if (allowRawDolbyVisionProfile7) {
        rangeTypes.push('DOVIWithEL');
        if (allowRawDolbyVisionProfile7HDR10Base) {
            rangeTypes.push('HDR10');
        }
    }
    return rangeTypes;
}

function getAuthorizedRawHDRVideoRangeTypes(
    routeKeys: readonly RawHDRAuthorizationRouteKey[]
): string[] {
    const rangeTypes: string[] = [];
    for (const routeKey of routeKeys) {
        switch (routeKey) {
            case 'I420P10:bt2020-ncl:bt2020:limited:hlg':
                if (!rangeTypes.includes('HLG')) {
                    rangeTypes.push('HLG');
                }
                break;
            case 'I420P10:bt2020-ncl:bt2020:limited:pq':
                if (!rangeTypes.includes('HDR10')) {
                    rangeTypes.push('HDR10');
                }
                break;
        }
    }
    return rangeTypes;
}

function getAuthorizedExternalHDRVideoRangeTypes(
    routeKeys: readonly ExternalHDRAuthorizationRouteKey[]
): string[] {
    const rangeTypes: string[] = [];
    for (const routeKey of routeKeys) {
        switch (routeKey) {
            case 'external-hevc-main10-bt709-limited:hlg-v1':
                rangeTypes.push('HLG');
                break;
            case 'external-hevc-main10-bt709-limited:pq-v1':
                rangeTypes.push('HDR10');
                break;
        }
    }
    return rangeTypes;
}

type MeasuredVideoRoute = {
    bitDepth: number
    codec: CustomVideoCodec
    maximumFrameRate: number | null
    maximumHeight: number
    maximumLevel: number | null
    maximumWidth: number
    profiles: readonly string[]
    rangeTypes: readonly string[]
};

function getBundledRawHEVCTier(
    capabilities: CustomDecodeCapabilities,
    capability: CustomRawHDRVideoCodecCapability
): BundledHEVCExactTierCapability | null {
    const bundledTiers = capabilities.bundledHEVC?.tiers;
    if (!bundledTiers) {
        return null;
    }

    for (const tier of [ bundledTiers['main10-4k'], bundledTiers['main10-1080p'] ]) {
        if (tier.status === 'supported'
            && tier.codecString === capability.codecString
            && tier.maximumCodedWidth === capability.maximumCodedWidth
            && tier.maximumCodedHeight === capability.maximumCodedHeight) {
            return tier;
        }
    }
    return null;
}

const NATIVE_VIDEO_PROFILES: Readonly<Record<CustomVideoCodec, readonly string[]>> = {
    av1: [ 'main' ],
    h264: [],
    hevc: [ 'main' ],
    jpeg2000: [],
    mpeg2video: [ 'main' ],
    vp8: [],
    vp9: [ 'profile 0' ]
};

function getNativeVideoProfiles(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities
): readonly string[] {
    if (codec !== 'h264') {
        return NATIVE_VIDEO_PROFILES[codec];
    }
    if (!capabilities.h264Profiles) {
        return [];
    }
    return getSupportedH264JellyfinProfileNames(capabilities.h264Profiles);
}

function supportsNativeVideoCodec(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities
): boolean {
    if (codec === 'h264') {
        return getNativeVideoProfiles(codec, capabilities).length > 0;
    }
    if (codec === 'hevc') {
        return capabilities.video.hevc.status === 'supported'
            || capabilities.bundledHEVC?.tiers['main-1080p'].status === 'supported';
    }
    if (codec === 'jpeg2000') {
        return capabilities.bundledJPEG2000?.status === 'supported';
    }
    if (codec === 'mpeg2video') {
        return capabilities.bundledLegacyVideo?.status === 'supported';
    }
    return capabilities.video[codec].status === 'supported';
}
const RAW_VIDEO_PROFILES: Readonly<Record<'av1' | 'hevc' | 'vp9', readonly string[]>> = {
    av1: [ 'main' ],
    hevc: [ 'main 10' ],
    vp9: [ 'profile 2' ]
};

function cloneDeviceProfile(profile: DeviceProfile): DeviceProfile {
    const clonedProfile: DeviceProfile = { ...profile };
    if (profile.DirectPlayProfiles) {
        clonedProfile.DirectPlayProfiles = profile.DirectPlayProfiles.map(directPlayProfile => ({
            ...directPlayProfile
        }));
    }
    if (profile.TranscodingProfiles) {
        clonedProfile.TranscodingProfiles = profile.TranscodingProfiles.map(transcodingProfile => ({
            ...transcodingProfile,
            Conditions: transcodingProfile.Conditions?.map(condition => ({ ...condition }))
        }));
    }
    if (profile.ContainerProfiles) {
        clonedProfile.ContainerProfiles = profile.ContainerProfiles.map(containerProfile => ({
            ...containerProfile,
            Conditions: containerProfile.Conditions?.map(condition => ({ ...condition }))
        }));
    }
    if (profile.CodecProfiles) {
        clonedProfile.CodecProfiles = profile.CodecProfiles.map(codecProfile => ({
            ...codecProfile,
            ...(codecProfile.ApplyConditions ? {
                ApplyConditions: codecProfile.ApplyConditions.map(condition => ({ ...condition }))
            } : {}),
            ...(codecProfile.Conditions ? {
                Conditions: codecProfile.Conditions.map(condition => ({ ...condition }))
            } : {})
        }));
    }
    if (profile.SubtitleProfiles) {
        clonedProfile.SubtitleProfiles = profile.SubtitleProfiles.map(subtitleProfile => ({
            ...subtitleProfile
        }));
    }
    return clonedProfile;
}

function removeBitrateConditions(
    conditions: NonNullable<CodecProfile['Conditions']>
): NonNullable<CodecProfile['Conditions']> {
    return conditions.filter(condition => (
        !condition.Property || !BITRATE_CONDITION_PROPERTIES.has(condition.Property)
    ));
}

/** Removes every client bitrate input that Jellyfin can use for playback selection. */
function removeBitratePlaybackConstraints(profile: DeviceProfile): void {
    profile.MaxStreamingBitrate = null;
    profile.MaxStaticBitrate = null;
    profile.MaxStaticMusicBitrate = null;

    for (const codecProfile of profile.CodecProfiles ?? []) {
        if (codecProfile.ApplyConditions) {
            codecProfile.ApplyConditions = removeBitrateConditions(
                codecProfile.ApplyConditions
            );
        }
        if (codecProfile.Conditions) {
            codecProfile.Conditions = removeBitrateConditions(codecProfile.Conditions);
        }
    }
    for (const containerProfile of profile.ContainerProfiles ?? []) {
        if (containerProfile.Conditions) {
            containerProfile.Conditions = removeBitrateConditions(
                containerProfile.Conditions
            );
        }
    }
}

/** Clones a device profile and removes bitrate from playback selection. */
export function createBitrateIndependentDeviceProfile(
    profile: DeviceProfile
): DeviceProfile {
    const clonedProfile = cloneDeviceProfile(profile);
    removeBitratePlaybackConstraints(clonedProfile);
    return clonedProfile;
}

function getSupportedVideoCodecs(
    capabilities: CustomDecodeCapabilities,
    allowRawHDR: boolean,
    allowDolbyVision = false,
    allowNativeDolbyVision = false,
    allowNativeHDR = false
): CustomVideoCodec[] {
    const supportedCodecs: CustomVideoCodec[] = [];
    for (const codec of CUSTOM_VIDEO_CODECS) {
        const rawCapability = codec === 'hevc' || codec === 'vp9' || codec === 'av1' ?
            capabilities.rawHDRVideo[codec] :
            null;
        const rawPresentationAllowed = allowRawHDR
            || (allowDolbyVision && codec === 'hevc');
        if (supportsNativeVideoCodec(codec, capabilities)
            || (rawPresentationAllowed
                && rawCapability?.status === 'supported'
                && isCustomHDRVideoMaximumFramesPerSecond(
                    rawCapability.maximumFramesPerSecond
                ))
            || (allowNativeDolbyVision
                && codec === 'hevc'
                && capabilities.nativeDolbyVisionHEVC?.status === 'supported'
                && isCustomHDRVideoMaximumFramesPerSecond(
                    capabilities.nativeDolbyVisionHEVC.maximumFramesPerSecond
                ))
            || (allowNativeHDR
                && codec === 'hevc'
                && capabilities.nativeHDRHEVC?.status === 'supported'
                && isCustomHDRVideoMaximumFramesPerSecond(
                    capabilities.nativeHDRHEVC.maximumFramesPerSecond
                ))) {
            supportedCodecs.push(codec);
        }
    }
    return supportedCodecs;
}

function getSupportedAudioCodecs(
    capabilities: CustomDecodeCapabilities,
    nativeMediaAudioCapabilities: NativeMediaAudioCapabilities | null | undefined
): CustomAudioCodec[] {
    const supportedCodecs: CustomAudioCodec[] = [];
    for (const codec of CUSTOM_AUDIO_CODECS) {
        if (codec === 'dts' && capabilities.bundledDTS?.status !== 'supported') {
            continue;
        }
        if ((codec === 'mlp' || codec === 'truehd')
            && capabilities.bundledTrueHD?.status !== 'supported') {
            continue;
        }
        const nativeMediaSupported = (codec === 'ac3' || codec === 'eac3')
            && nativeMediaAudioCapabilities?.audio[codec].status === 'supported';
        if (capabilities.audio[codec].status === 'supported' || nativeMediaSupported) {
            supportedCodecs.push(codec);
        }
    }
    return supportedCodecs;
}

function getSupportedRawHDRVideoCodecs(
    capabilities: CustomDecodeCapabilities
): CustomVideoCodec[] {
    const supportedCodecs: CustomVideoCodec[] = [];
    const rawHDRVideoCapabilities = capabilities.rawHDRVideo;

    for (const codec of CUSTOM_RAW_HDR_VIDEO_CODECS) {
        if (rawHDRVideoCapabilities[codec].status === 'supported'
            && isCustomHDRVideoMaximumFramesPerSecond(
                rawHDRVideoCapabilities[codec].maximumFramesPerSecond
            )) {
            supportedCodecs.push(codec);
        }
    }
    return supportedCodecs;
}

function selectCompatibleCodecs<Codec extends CustomAudioCodec | CustomVideoCodec>(
    compatibleCodecs: readonly Codec[],
    supportedCodecs: ReadonlySet<Codec>
): Codec[] {
    const selectedCodecs: Codec[] = [];
    for (const codec of compatibleCodecs) {
        if (supportedCodecs.has(codec)) {
            selectedCodecs.push(codec);
        }
    }
    return selectedCodecs;
}

function createCompatibleProfiles(
    supportedVideoCodecs: readonly CustomVideoCodec[],
    supportedAudioCodecs: readonly CustomAudioCodec[]
): DirectPlayProfile[] {
    const profiles: DirectPlayProfile[] = [];
    const supportedVideoSet = new Set(supportedVideoCodecs);
    const supportedAudioSet = new Set(supportedAudioCodecs);

    for (const rule of VIDEO_CONTAINER_RULES) {
        const videoCodecs = selectCompatibleCodecs(rule.videoCodecs, supportedVideoSet);
        const audioCodecs = selectCompatibleCodecs(rule.audioCodecs, supportedAudioSet);
        if (videoCodecs.length === 0 || audioCodecs.length === 0) {
            continue;
        }
        profiles.push({
            AudioCodec: audioCodecs.join(','),
            Container: rule.container,
            Type: 'Video',
            VideoCodec: videoCodecs.join(',')
        });
    }

    return profiles;
}

function normalizeList(value: string | null | undefined): string {
    if (!value) {
        return '';
    }
    return value.split(',')
        .map(part => part.trim().toLowerCase())
        .filter(Boolean)
        .sort((left, right) => left.localeCompare(right))
        .join(',');
}

function getProfileKey(profile: DirectPlayProfile): string {
    return [
        profile.Type ?? '',
        normalizeList(profile.Container),
        normalizeList(profile.VideoCodec),
        normalizeList(profile.AudioCodec)
    ].join('|');
}

function createTelemetry(
    reason: CustomDeviceProfileReason,
    supportedVideoCodecs: readonly CustomVideoCodec[],
    supportedAudioCodecs: readonly CustomAudioCodec[],
    addedProfiles: readonly DirectPlayProfile[],
    widenedHDRCodecProfileCount: number
): CustomDeviceProfileTelemetry {
    return {
        addedAudioProfileCount: addedProfiles.filter(profile => profile.Type === 'Audio').length,
        addedProfileCount: addedProfiles.length,
        addedVideoProfileCount: addedProfiles.filter(profile => profile.Type === 'Video').length,
        reason,
        supportedAudioCodecs: [ ...supportedAudioCodecs ],
        supportedVideoCodecs: [ ...supportedVideoCodecs ],
        widenedHDRCodecProfileCount
    };
}

function getCodecTokens(value: string | null | undefined): string[] {
    if (!value) {
        return [];
    }

    const codecs: string[] = [];
    for (const codec of value.split(',')) {
        const normalizedCodec = codec.trim().toLowerCase();
        if (normalizedCodec) {
            codecs.push(normalizedCodec);
        }
    }
    return codecs;
}

function getRawHDRVideoRangeTypeValue(
    includeSDR: boolean,
    rawHDRVideoRangeTypes: readonly string[]
): string {
    const rangeTypes: string[] = [];
    if (includeSDR) {
        rangeTypes.push('SDR');
    }
    rangeTypes.push(...rawHDRVideoRangeTypes);
    return rangeTypes.join('|');
}

function parseFiniteNumber(value: string | null | undefined): number | null {
    if (typeof value !== 'string' || !value.trim()) {
        return null;
    }
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
}

function bitDepthConditionAllowsTenBit(condition: ProfileCondition): boolean {
    if (condition.Property !== VIDEO_BIT_DEPTH_PROPERTY) {
        return true;
    }

    switch (condition.Condition) {
        case 'Equals':
            return parseFiniteNumber(condition.Value) === MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH;
        case 'NotEquals':
            return parseFiniteNumber(condition.Value) !== MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH;
        case LESS_THAN_EQUAL_CONDITION: {
            const maximumBitDepth = parseFiniteNumber(condition.Value);
            return maximumBitDepth !== null
                && MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH <= maximumBitDepth;
        }
        case 'GreaterThanEqual': {
            const minimumBitDepth = parseFiniteNumber(condition.Value);
            return minimumBitDepth !== null
                && MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH >= minimumBitDepth;
        }
        case EQUALS_ANY_CONDITION:
            return condition.Value?.split('|').some(value => (
                parseFiniteNumber(value) === MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH
            )) === true;
        default:
            return false;
    }
}

function bitDepthConditionCapsAtTenBit(condition: ProfileCondition): boolean {
    if (condition.Property !== VIDEO_BIT_DEPTH_PROPERTY) {
        return false;
    }

    switch (condition.Condition) {
        case 'Equals': {
            const bitDepth = parseFiniteNumber(condition.Value);
            return bitDepth !== null && bitDepth <= MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH;
        }
        case LESS_THAN_EQUAL_CONDITION: {
            const maximumBitDepth = parseFiniteNumber(condition.Value);
            return maximumBitDepth !== null
                && maximumBitDepth <= MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH;
        }
        case EQUALS_ANY_CONDITION: {
            const bitDepths = condition.Value?.split('|').map(parseFiniteNumber) ?? [];
            return bitDepths.length > 0 && bitDepths.every(bitDepth => (
                bitDepth !== null && bitDepth <= MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH
            ));
        }
        default:
            return false;
    }
}

function numericConditionCapsAt(
    condition: ProfileCondition,
    property: string,
    maximumValue: number
): boolean {
    if (condition.Property !== property) {
        return false;
    }
    const conditionValue = parseFiniteNumber(condition.Value);
    switch (condition.Condition) {
        case 'Equals':
        case LESS_THAN_EQUAL_CONDITION:
            return conditionValue !== null && conditionValue <= maximumValue;
        default:
            return false;
    }
}

function widenNumericMaximumCondition(
    condition: ProfileCondition,
    property: string,
    maximumValue: number
): ProfileCondition {
    if (condition.Property !== property) {
        return condition;
    }

    let conditionMaximum: number | null = null;
    switch (condition.Condition) {
        case 'Equals':
        case LESS_THAN_EQUAL_CONDITION:
            conditionMaximum = parseFiniteNumber(condition.Value);
            break;
        case EQUALS_ANY_CONDITION: {
            const conditionValues = condition.Value?.split('|').map(parseFiniteNumber) ?? [];
            if (conditionValues.length > 0 && conditionValues.every(value => value !== null)) {
                conditionMaximum = Math.max(...conditionValues as number[]);
            }
            break;
        }
        default:
            break;
    }
    if (conditionMaximum === null || conditionMaximum > maximumValue) {
        return condition;
    }
    return {
        ...condition,
        Condition: LESS_THAN_EQUAL_CONDITION,
        Value: String(maximumValue)
    };
}

type RawHDRCapabilityLimits = {
    maximumCodedHeight: number
    maximumCodedWidth: number
    maximumFramesPerSecond: number
    maximumLevel: number | null
};

function createRawHDRConditions(
    conditions: NonNullable<CodecProfile['Conditions']>,
    includeSDR: boolean,
    limits: RawHDRCapabilityLimits,
    rawHDRVideoRangeTypes: readonly string[]
): NonNullable<CodecProfile['Conditions']> | null {
    if (conditions.some(condition => !bitDepthConditionAllowsTenBit(condition))) {
        return null;
    }
    const videoRangeConditions = conditions.filter(condition => (
        condition.Property === VIDEO_RANGE_TYPE_PROPERTY
    ));
    if (videoRangeConditions.some(condition => condition.Condition !== EQUALS_ANY_CONDITION)) {
        return null;
    }

    const widenedConditions = conditions.map(condition => {
        if (condition.Condition === EQUALS_ANY_CONDITION
            && condition.Property === VIDEO_RANGE_TYPE_PROPERTY) {
            return {
                ...condition,
                Value: getRawHDRVideoRangeTypeValue(includeSDR, rawHDRVideoRangeTypes)
            };
        }

        let widenedCondition = widenNumericMaximumCondition(
            condition,
            VIDEO_FRAMERATE_PROPERTY,
            limits.maximumFramesPerSecond
        );
        if (limits.maximumLevel !== null) {
            widenedCondition = widenNumericMaximumCondition(
                widenedCondition,
                VIDEO_LEVEL_PROPERTY,
                limits.maximumLevel
            );
        }
        widenedCondition = widenNumericMaximumCondition(
            widenedCondition,
            VIDEO_WIDTH_PROPERTY,
            limits.maximumCodedWidth
        );
        return widenNumericMaximumCondition(
            widenedCondition,
            VIDEO_HEIGHT_PROPERTY,
            limits.maximumCodedHeight
        );
    });
    const hasVideoRangeCondition = conditions.some(condition => (
        condition.Property === VIDEO_RANGE_TYPE_PROPERTY
    ));
    if (!hasVideoRangeCondition) {
        widenedConditions.push({
            Condition: EQUALS_ANY_CONDITION,
            IsRequired: false,
            Property: VIDEO_RANGE_TYPE_PROPERTY,
            Value: getRawHDRVideoRangeTypeValue(includeSDR, rawHDRVideoRangeTypes)
        });
    }
    if (!conditions.some(bitDepthConditionCapsAtTenBit)) {
        widenedConditions.push({
            Condition: LESS_THAN_EQUAL_CONDITION,
            IsRequired: true,
            Property: VIDEO_BIT_DEPTH_PROPERTY,
            Value: String(MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH)
        });
    }
    if (!widenedConditions.some(condition => numericConditionCapsAt(
        condition,
        VIDEO_FRAMERATE_PROPERTY,
        limits.maximumFramesPerSecond
    ))) {
        widenedConditions.push({
            Condition: LESS_THAN_EQUAL_CONDITION,
            IsRequired: true,
            Property: VIDEO_FRAMERATE_PROPERTY,
            Value: String(limits.maximumFramesPerSecond)
        });
    }
    const maximumLevel = limits.maximumLevel;
    if (maximumLevel !== null && !widenedConditions.some(condition => numericConditionCapsAt(
        condition,
        VIDEO_LEVEL_PROPERTY,
        maximumLevel
    ))) {
        widenedConditions.push({
            Condition: LESS_THAN_EQUAL_CONDITION,
            IsRequired: true,
            Property: VIDEO_LEVEL_PROPERTY,
            Value: String(maximumLevel)
        });
    }
    if (!widenedConditions.some(condition => numericConditionCapsAt(
        condition,
        VIDEO_WIDTH_PROPERTY,
        limits.maximumCodedWidth
    ))) {
        widenedConditions.push({
            Condition: LESS_THAN_EQUAL_CONDITION,
            IsRequired: true,
            Property: VIDEO_WIDTH_PROPERTY,
            Value: String(limits.maximumCodedWidth)
        });
    }
    if (!widenedConditions.some(condition => numericConditionCapsAt(
        condition,
        VIDEO_HEIGHT_PROPERTY,
        limits.maximumCodedHeight
    ))) {
        widenedConditions.push({
            Condition: LESS_THAN_EQUAL_CONDITION,
            IsRequired: true,
            Property: VIDEO_HEIGHT_PROPERTY,
            Value: String(limits.maximumCodedHeight)
        });
    }
    return widenedConditions;
}

type RawHDRCodecProfilePlan = {
    customContainers: string[]
    nonCustomContainers: string[]
    nonRawHDRCodecs: string[]
    rawHDRCodecs: string[]
    widenedConditions: NonNullable<CodecProfile['Conditions']>
};

function isMeasuredVideoRouteProfile(codecProfile: CodecProfile): boolean {
    return codecProfile.Conditions?.some(condition => (
        condition.IsRequired === true
        && condition.Property === VIDEO_INTERLACED_PROPERTY
        && condition.Condition === 'Equals'
        && condition.Value === 'false'
    )) === true;
}

function getRawHDRCapabilityLimits(
    rawHDRCodecs: readonly string[],
    capabilities: CustomDecodeCapabilities
): RawHDRCapabilityLimits | null {
    let maximumCodedHeight = Number.MAX_SAFE_INTEGER;
    let maximumCodedWidth = Number.MAX_SAFE_INTEGER;
    let maximumFramesPerSecond = Number.MAX_SAFE_INTEGER;
    let maximumLevel: number | null = null;
    for (const rawHDRCodec of rawHDRCodecs) {
        const capability = capabilities.rawHDRVideo[
            rawHDRCodec as 'av1' | 'hevc' | 'vp9'
        ];
        if (!isCustomHDRVideoMaximumFramesPerSecond(
            capability.maximumFramesPerSecond
        )) {
            return null;
        }
        maximumCodedHeight = Math.min(
            maximumCodedHeight,
            capability.maximumCodedHeight
        );
        maximumCodedWidth = Math.min(
            maximumCodedWidth,
            capability.maximumCodedWidth
        );
        maximumFramesPerSecond = Math.min(
            maximumFramesPerSecond,
            capability.maximumFramesPerSecond
        );
        if (capability.reason !== 'bundled-software-decoder') {
            continue;
        }

        const bundledTier = getBundledRawHEVCTier(capabilities, capability);
        if (!bundledTier) {
            return null;
        }
        maximumLevel = maximumLevel === null ?
            bundledTier.maximumLevel :
            Math.min(maximumLevel, bundledTier.maximumLevel);
    }

    return {
        maximumCodedHeight,
        maximumCodedWidth,
        maximumFramesPerSecond,
        maximumLevel
    };
}

function getNativeDolbyVisionCapabilityLimits(
    capabilities: CustomDecodeCapabilities,
    enabled: boolean
): RawHDRCapabilityLimits | null {
    if (!enabled) {
        return null;
    }
    const capability = capabilities.nativeDolbyVisionHEVC;
    if (capability?.status !== 'supported'
        || !isCustomHDRVideoMaximumFramesPerSecond(
            capability.maximumFramesPerSecond
        )) {
        return null;
    }
    return {
        maximumCodedHeight: capability.maximumCodedHeight,
        maximumCodedWidth: capability.maximumCodedWidth,
        maximumFramesPerSecond: capability.maximumFramesPerSecond,
        maximumLevel: capability.maximumLevel
    };
}

function getNativeHDRCapabilityLimits(
    capabilities: CustomDecodeCapabilities,
    enabled: boolean
): RawHDRCapabilityLimits | null {
    if (!enabled) {
        return null;
    }
    const capability: CustomNativeHDRHEVCCapability | undefined =
        capabilities.nativeHDRHEVC;
    if (capability?.status !== 'supported'
        || !isCustomHDRVideoMaximumFramesPerSecond(
            capability.maximumFramesPerSecond
        )) {
        return null;
    }
    return {
        maximumCodedHeight: capability.maximumCodedHeight,
        maximumCodedWidth: capability.maximumCodedWidth,
        maximumFramesPerSecond: capability.maximumFramesPerSecond,
        maximumLevel: capability.maximumLevel
    };
}

function expandOptionalMaximum(first: number | null, second: number | null): number | null {
    if (first === null || second === null) {
        return null;
    }
    return Math.max(first, second);
}

function createCapabilityEnvelope(
    first: RawHDRCapabilityLimits,
    second: RawHDRCapabilityLimits
): RawHDRCapabilityLimits {
    return {
        maximumCodedHeight: Math.max(
            first.maximumCodedHeight,
            second.maximumCodedHeight
        ),
        maximumCodedWidth: Math.max(
            first.maximumCodedWidth,
            second.maximumCodedWidth
        ),
        maximumFramesPerSecond: Math.max(
            first.maximumFramesPerSecond,
            second.maximumFramesPerSecond
        ),
        maximumLevel: expandOptionalMaximum(
            first.maximumLevel,
            second.maximumLevel
        )
    };
}

function createRawHDRCodecProfilePlan(
    codecProfile: CodecProfile,
    supportedRawHDRCodecs: ReadonlySet<CustomVideoCodec>,
    supportedNativeVideoCodecs: ReadonlySet<CustomVideoCodec>,
    capabilities: CustomDecodeCapabilities,
    rawHDRVideoRangeTypes: readonly string[],
    capabilityLimits: RawHDRCapabilityLimits | null = null
): RawHDRCodecProfilePlan | null {
    if (
        codecProfile.Type !== VIDEO_CODEC_PROFILE_TYPE
        || codecProfile.SubContainer
        || codecProfile.Container?.trim().startsWith('-')
        || isMeasuredVideoRouteProfile(codecProfile)
    ) {
        return null;
    }

    const codecs = getCodecTokens(codecProfile.Codec);
    const rawHDRCodecs = codecs.filter(codec => (
        supportedRawHDRCodecs.has(codec as CustomVideoCodec)
    ));
    if (rawHDRCodecs.length === 0) {
        return null;
    }

    const limits = capabilityLimits ?? getRawHDRCapabilityLimits(
        rawHDRCodecs,
        capabilities
    );
    if (!limits) {
        return null;
    }

    const conditions = codecProfile.Conditions ?? [];
    const widenedConditions = createRawHDRConditions(
        conditions,
        rawHDRCodecs.every(codec => supportedNativeVideoCodecs.has(codec as CustomVideoCodec)),
        limits,
        rawHDRVideoRangeTypes
    );
    const conditionsChanged = widenedConditions?.length !== conditions.length
        || conditions.some((condition, conditionIndex) => {
            const widenedCondition = widenedConditions?.[conditionIndex];
            return !widenedCondition
                || condition.Condition !== widenedCondition.Condition
                || condition.IsRequired !== widenedCondition.IsRequired
                || condition.Property !== widenedCondition.Property
                || condition.Value !== widenedCondition.Value;
        });
    if (!widenedConditions || !conditionsChanged) {
        return null;
    }

    const configuredContainers = getCodecTokens(codecProfile.Container);
    const customContainers = configuredContainers.length === 0 ?
        [ ...CUSTOM_VIDEO_CONTAINERS ] :
        configuredContainers.filter(container => CUSTOM_VIDEO_CONTAINER_SET.has(container));
    if (customContainers.length === 0) {
        return null;
    }

    return {
        customContainers,
        nonCustomContainers: configuredContainers.filter(container => (
            !CUSTOM_VIDEO_CONTAINER_SET.has(container)
        )),
        nonRawHDRCodecs: codecs.filter(codec => !rawHDRCodecs.includes(codec)),
        rawHDRCodecs,
        widenedConditions
    };
}

function appendRawHDRCodecProfilePlan(
    widenedProfiles: CodecProfile[],
    codecProfile: CodecProfile,
    plan: RawHDRCodecProfilePlan
): void {
    if (plan.nonRawHDRCodecs.length > 0) {
        widenedProfiles.push({
            ...codecProfile,
            Codec: plan.nonRawHDRCodecs.join(',')
        });
    }

    const configuredContainers = getCodecTokens(codecProfile.Container);
    if (configuredContainers.length === 0) {
        widenedProfiles.push({
            ...codecProfile,
            Codec: plan.rawHDRCodecs.join(','),
            Container: NON_CUSTOM_VIDEO_CONTAINER_VALUE
        });
    } else if (plan.nonCustomContainers.length > 0) {
        widenedProfiles.push({
            ...codecProfile,
            Codec: plan.rawHDRCodecs.join(','),
            Container: plan.nonCustomContainers.join(',')
        });
    }

    widenedProfiles.push({
        ...codecProfile,
        Codec: plan.rawHDRCodecs.join(','),
        Conditions: plan.widenedConditions,
        Container: plan.customContainers.join(',')
    });
}

function widenRawHDRCodecProfiles(
    profile: DeviceProfile,
    supportedRawHDRVideoCodecs: readonly CustomVideoCodec[],
    supportedNativeVideoCodecs: readonly CustomVideoCodec[],
    capabilities: CustomDecodeCapabilities,
    rawHDRVideoRangeTypes: readonly string[],
    capabilityLimits: RawHDRCapabilityLimits | null = null
): number {
    const supportedRawHDRCodecs = new Set<CustomVideoCodec>(supportedRawHDRVideoCodecs);
    const supportedNativeCodecs = new Set<CustomVideoCodec>(supportedNativeVideoCodecs);
    if (supportedRawHDRCodecs.size === 0 || !profile.CodecProfiles) {
        return 0;
    }

    const widenedProfiles: CodecProfile[] = [];
    let widenedProfileCount = 0;
    for (const codecProfile of profile.CodecProfiles) {
        const plan = createRawHDRCodecProfilePlan(
            codecProfile,
            supportedRawHDRCodecs,
            supportedNativeCodecs,
            capabilities,
            rawHDRVideoRangeTypes,
            capabilityLimits
        );
        if (!plan) {
            widenedProfiles.push(codecProfile);
            continue;
        }

        appendRawHDRCodecProfilePlan(widenedProfiles, codecProfile, plan);
        widenedProfileCount += 1;
    }

    profile.CodecProfiles = widenedProfiles;
    return widenedProfileCount;
}

function getCustomContainersForVideoCodec(codec: CustomVideoCodec): string[] {
    const containers: string[] = [];
    const containerSet = new Set<string>();
    for (const rule of VIDEO_CONTAINER_RULES) {
        if (!rule.videoCodecs.includes(codec)) {
            continue;
        }
        for (const container of rule.container.split(',')) {
            if (!containerSet.has(container)) {
                containerSet.add(container);
                containers.push(container);
            }
        }
    }
    return containers;
}

function createMeasuredRouteConditions(
    route: MeasuredVideoRoute
): NonNullable<CodecProfile['Conditions']> {
    const conditions: NonNullable<CodecProfile['Conditions']> = [];
    conditions.push({
        Condition: EQUALS_ANY_CONDITION,
        IsRequired: true,
        Property: VIDEO_RANGE_TYPE_PROPERTY,
        Value: route.rangeTypes.join('|')
    });
    conditions.push({
        Condition: 'Equals',
        IsRequired: true,
        Property: VIDEO_BIT_DEPTH_PROPERTY,
        Value: String(route.bitDepth)
    });
    conditions.push({
        Condition: LESS_THAN_EQUAL_CONDITION,
        IsRequired: true,
        Property: VIDEO_WIDTH_PROPERTY,
        Value: String(route.maximumWidth)
    });
    conditions.push({
        Condition: LESS_THAN_EQUAL_CONDITION,
        IsRequired: true,
        Property: VIDEO_HEIGHT_PROPERTY,
        Value: String(route.maximumHeight)
    });
    if (route.maximumFrameRate !== null) {
        conditions.push({
            Condition: LESS_THAN_EQUAL_CONDITION,
            IsRequired: true,
            Property: VIDEO_FRAMERATE_PROPERTY,
            Value: String(route.maximumFrameRate)
        });
    }
    if (route.maximumLevel !== null) {
        conditions.push({
            Condition: LESS_THAN_EQUAL_CONDITION,
            IsRequired: true,
            Property: VIDEO_LEVEL_PROPERTY,
            Value: String(route.maximumLevel)
        });
    }
    conditions.push({
        Condition: 'Equals',
        IsRequired: true,
        Property: VIDEO_INTERLACED_PROPERTY,
        Value: 'false'
    });
    if (route.profiles.length > 0) {
        conditions.push({
            Condition: EQUALS_ANY_CONDITION,
            IsRequired: true,
            Property: VIDEO_PROFILE_PROPERTY,
            Value: route.profiles.join('|')
        });
    }
    return conditions;
}

function createMeasuredRouteApplyConditions(
    route: MeasuredVideoRoute
): NonNullable<CodecProfile['ApplyConditions']> {
    return createMeasuredRouteConditions(route).filter(condition => (
        condition.Property === VIDEO_RANGE_TYPE_PROPERTY
    ));
}

function getNativeMeasuredVideoDimensions(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities
): Readonly<{ maximumHeight: number, maximumWidth: number }> {
    let maximumHeight: number = CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_HEIGHT;
    let maximumWidth: number = CUSTOM_NATIVE_VIDEO_MAXIMUM_CODED_WIDTH;
    switch (codec) {
        case 'hevc':
        case 'vp9':
        case 'av1': {
            const ultraHDCapability: CustomNativeUltraHDVideoCodecCapability | undefined =
                capabilities.nativeUltraHDVideo?.[codec];
            if (ultraHDCapability?.status === 'supported'
                && ultraHDCapability.bitDepth === CUSTOM_NATIVE_VIDEO_BIT_DEPTH) {
                maximumHeight = ultraHDCapability.maximumCodedHeight;
                maximumWidth = ultraHDCapability.maximumCodedWidth;
            }
            break;
        }
        case 'h264':
        case 'jpeg2000':
        case 'mpeg2video':
        case 'vp8':
            break;
    }
    return { maximumHeight, maximumWidth };
}

function createNativeMeasuredVideoRoute(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities
): MeasuredVideoRoute | null {
    if (!supportsNativeVideoCodec(codec, capabilities)) {
        return null;
    }

    if (codec === 'jpeg2000') {
        const capability = capabilities.bundledJPEG2000;
        if (
            capability?.status !== 'supported'
            || capability.maximumFramesPerSecond !== 24
        ) {
            return null;
        }
        return {
            bitDepth: capability.bitDepth,
            codec,
            maximumFrameRate: capability.maximumFramesPerSecond,
            maximumHeight: capability.maximumCodedHeight,
            maximumLevel: null,
            maximumWidth: capability.maximumCodedWidth,
            profiles: [],
            rangeTypes: [ 'SDR' ]
        };
    }

    if (codec === 'mpeg2video') {
        const capability = capabilities.bundledLegacyVideo;
        if (
            capability?.status !== 'supported'
            || capability.maximumFramesPerSecond !== 24
        ) {
            return null;
        }
        return {
            bitDepth: CUSTOM_NATIVE_VIDEO_BIT_DEPTH,
            codec,
            maximumFrameRate: capability.maximumFramesPerSecond,
            maximumHeight: capability.maximumCodedHeight,
            maximumLevel: null,
            maximumWidth: capability.maximumCodedWidth,
            profiles: NATIVE_VIDEO_PROFILES.mpeg2video,
            rangeTypes: [ 'SDR' ]
        };
    }

    let bundledMain: BundledHEVCExactTierCapability | null = null;
    if (codec === 'hevc' && capabilities.video.hevc.status !== 'supported') {
        const mainTier = capabilities.bundledHEVC?.tiers['main-1080p'];
        bundledMain = mainTier?.status === 'supported' ? mainTier : null;
    }
    const nativeDimensions: Readonly<{
        maximumHeight: number
        maximumWidth: number
    }> = getNativeMeasuredVideoDimensions(codec, capabilities);
    return {
        bitDepth: CUSTOM_NATIVE_VIDEO_BIT_DEPTH,
        codec,
        maximumFrameRate: bundledMain ?
            CUSTOM_BUNDLED_HEVC_BASELINE_MAXIMUM_FRAMES_PER_SECOND :
            null,
        maximumHeight: bundledMain?.maximumCodedHeight ?? nativeDimensions.maximumHeight,
        maximumLevel: bundledMain?.maximumLevel ?? null,
        maximumWidth: bundledMain?.maximumCodedWidth ?? nativeDimensions.maximumWidth,
        profiles: getNativeVideoProfiles(codec, capabilities),
        rangeTypes: [ 'SDR' ]
    };
}

function createRawHDRMeasuredVideoRoute(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities,
    rawHDRVideoRangeTypes: readonly string[]
): MeasuredVideoRoute | null {
    if (rawHDRVideoRangeTypes.length === 0
        || (codec !== 'hevc' && codec !== 'vp9' && codec !== 'av1')) {
        return null;
    }

    const rawCapability = capabilities.rawHDRVideo[codec];
    if (rawCapability.status !== 'supported'
        || !isCustomHDRVideoMaximumFramesPerSecond(
            rawCapability.maximumFramesPerSecond
        )) {
        return null;
    }
    const bundledTier = rawCapability.reason === 'bundled-software-decoder' ?
        getBundledRawHEVCTier(capabilities, rawCapability) :
        null;
    if (rawCapability.reason === 'bundled-software-decoder' && !bundledTier) {
        return null;
    }
    return {
        bitDepth: rawCapability.bitDepth,
        codec,
        maximumFrameRate: rawCapability.maximumFramesPerSecond,
        maximumHeight: rawCapability.maximumCodedHeight,
        maximumLevel: bundledTier?.maximumLevel ?? null,
        maximumWidth: rawCapability.maximumCodedWidth,
        profiles: RAW_VIDEO_PROFILES[codec],
        rangeTypes: rawHDRVideoRangeTypes
    };
}

function createDolbyVisionMeasuredVideoRoute(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities,
    dolbyVisionVideoRangeTypes: readonly string[],
    enabled: boolean
): MeasuredVideoRoute | null {
    const capability = capabilities.nativeDolbyVisionHEVC;
    if (
        codec !== 'hevc'
        || !enabled
        || dolbyVisionVideoRangeTypes.length === 0
        || capability?.status !== 'supported'
        || !isCustomHDRVideoMaximumFramesPerSecond(
            capability.maximumFramesPerSecond
        )
    ) {
        return null;
    }
    return {
        bitDepth: capability.bitDepth,
        codec,
        maximumFrameRate: capability.maximumFramesPerSecond,
        maximumHeight: capability.maximumCodedHeight,
        maximumLevel: capability.maximumLevel,
        maximumWidth: capability.maximumCodedWidth,
        profiles: RAW_VIDEO_PROFILES.hevc,
        rangeTypes: dolbyVisionVideoRangeTypes
    };
}

function createNativeHDRMeasuredVideoRoute(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities,
    nativeHDRVideoRangeTypes: readonly string[],
    enabled: boolean
): MeasuredVideoRoute | null {
    const capability = capabilities.nativeHDRHEVC;
    if (
        codec !== 'hevc'
        || !enabled
        || nativeHDRVideoRangeTypes.length === 0
        || capability?.status !== 'supported'
        || !isCustomHDRVideoMaximumFramesPerSecond(
            capability.maximumFramesPerSecond
        )
    ) {
        return null;
    }
    return {
        bitDepth: capability.bitDepth,
        codec,
        maximumFrameRate: capability.maximumFramesPerSecond,
        maximumHeight: capability.maximumCodedHeight,
        maximumLevel: capability.maximumLevel,
        maximumWidth: capability.maximumCodedWidth,
        profiles: RAW_VIDEO_PROFILES.hevc,
        rangeTypes: nativeHDRVideoRangeTypes
    };
}

function getMeasuredVideoRoutes(
    codec: CustomVideoCodec,
    capabilities: CustomDecodeCapabilities,
    options: MeasuredVideoRouteOptions
): MeasuredVideoRoute[] {
    const routes: MeasuredVideoRoute[] = [];
    const nativeRoute = createNativeMeasuredVideoRoute(codec, capabilities);
    if (nativeRoute) {
        routes.push(nativeRoute);
    }
    const rawRoute = createRawHDRMeasuredVideoRoute(
        codec,
        capabilities,
        codec === 'hevc' ? [
            ...new Set([
                ...options.rawHDRVideoRangeTypes,
                ...options.rawDolbyVisionVideoRangeTypes
            ])
        ] : options.rawHDRVideoRangeTypes
    );
    if (rawRoute) {
        routes.push(rawRoute);
    }
    const nativeHDRRoute = createNativeHDRMeasuredVideoRoute(
        codec,
        capabilities,
        options.nativeHDRVideoRangeTypes,
        options.allowNativeHDR
    );
    if (nativeHDRRoute) {
        routes.push(nativeHDRRoute);
    }
    const dolbyVisionRoute = createDolbyVisionMeasuredVideoRoute(
        codec,
        capabilities,
        options.nativeDolbyVisionVideoRangeTypes,
        options.allowNativeDolbyVision
    );
    if (dolbyVisionRoute) {
        routes.push(dolbyVisionRoute);
    }
    return routes;
}

function getCodecProfileKey(profile: CodecProfile): string {
    return JSON.stringify({
        ApplyConditions: profile.ApplyConditions ?? [],
        Codec: normalizeList(profile.Codec),
        Conditions: profile.Conditions ?? [],
        Container: normalizeList(profile.Container),
        Type: profile.Type
    });
}

function appendMeasuredVideoRouteProfiles(
    profile: DeviceProfile,
    capabilities: CustomDecodeCapabilities,
    supportedVideoCodecs: readonly CustomVideoCodec[],
    options: MeasuredVideoRouteOptions
): void {
    const codecProfiles = profile.CodecProfiles ?? [];
    profile.CodecProfiles = codecProfiles;
    const existingProfileKeys = new Set(codecProfiles.map(getCodecProfileKey));
    for (const codec of supportedVideoCodecs) {
        const routes = getMeasuredVideoRoutes(
            codec,
            capabilities,
            options
        );
        if (routes.length === 0) {
            continue;
        }
        const container = getCustomContainersForVideoCodec(codec).join(',');
        const measuredProfiles: CodecProfile[] = [];
        if (routes.length === 1) {
            measuredProfiles.push({
                Codec: codec,
                Conditions: createMeasuredRouteConditions(routes[0]),
                Container: container,
                Type: VIDEO_CODEC_PROFILE_TYPE
            });
        } else {
            for (const route of routes) {
                measuredProfiles.push({
                    ApplyConditions: createMeasuredRouteApplyConditions(route),
                    Codec: codec,
                    Conditions: createMeasuredRouteConditions(route),
                    Container: container,
                    Type: VIDEO_CODEC_PROFILE_TYPE
                });
            }
        }

        for (const measuredProfile of measuredProfiles) {
            const profileKey = getCodecProfileKey(measuredProfile);
            if (existingProfileKeys.has(profileKey)) {
                continue;
            }
            codecProfiles.push(measuredProfile);
            existingProfileKeys.add(profileKey);
        }
    }
}

function createCompatibilityCapabilityEnvelope(
    candidates: readonly RawHDRCapabilityLimits[]
): RawHDRCapabilityLimits | null {
    let capabilityEnvelope: RawHDRCapabilityLimits | null = null;
    for (const limits of candidates) {
        capabilityEnvelope = capabilityEnvelope ?
            createCapabilityEnvelope(capabilityEnvelope, limits) :
            limits;
    }
    return capabilityEnvelope;
}

function getAuthorizedHEVCRangeTypes(
    authorizedRoutes: AuthorizedHDRRoutes,
    rawHEVCLimits: RawHDRCapabilityLimits | null,
    nativeHDRLimits: RawHDRCapabilityLimits | null,
    nativeDolbyVisionLimits: RawHDRCapabilityLimits | null
): readonly string[] {
    const rangeTypes = new Set<string>();
    if (rawHEVCLimits) {
        for (const rangeType of authorizedRoutes.rawHDRVideoRangeTypes) {
            rangeTypes.add(rangeType);
        }
    }
    if (nativeHDRLimits) {
        for (const rangeType of authorizedRoutes.nativeHDRVideoRangeTypes) {
            rangeTypes.add(rangeType);
        }
    }
    if (
        nativeDolbyVisionLimits
        || (authorizedRoutes.allowRawDolbyVision && rawHEVCLimits)
    ) {
        for (const rangeType of authorizedRoutes.dolbyVisionVideoRangeTypes) {
            rangeTypes.add(rangeType);
        }
    }
    return [ ...rangeTypes ];
}

function createAuthorizedHEVCProfilePlan(
    capabilities: CustomDecodeCapabilities,
    supportedRawHDRVideoCodecs: readonly CustomVideoCodec[],
    authorizedRoutes: AuthorizedHDRRoutes
): AuthorizedHEVCProfilePlan | null {
    const nativeDolbyVisionLimits = getNativeDolbyVisionCapabilityLimits(
        capabilities,
        authorizedRoutes.allowNativeDolbyVision
    );
    const nativeHDRLimits = getNativeHDRCapabilityLimits(
        capabilities,
        authorizedRoutes.allowNativeHDR
    );
    const dedicatedRouteRequired = nativeDolbyVisionLimits !== null
        || nativeHDRLimits !== null
        || authorizedRoutes.allowRawDolbyVision;
    const rawRouteAuthorized = authorizedRoutes.rawHDRVideoRangeTypes.length > 0
        || authorizedRoutes.allowRawDolbyVision;
    const rawHEVCLimits = dedicatedRouteRequired
        && rawRouteAuthorized
        && supportedRawHDRVideoCodecs.includes('hevc') ?
        getRawHDRCapabilityLimits([ 'hevc' ], capabilities) :
        null;
    const limitCandidates: RawHDRCapabilityLimits[] = [];
    for (const limits of [ rawHEVCLimits, nativeHDRLimits, nativeDolbyVisionLimits ]) {
        if (limits) {
            limitCandidates.push(limits);
        }
    }
    // This shared profile must not reimpose a weaker route's limits. Exact
    // measured profiles below retain the per-range capability boundaries.
    const combinedLimits = createCompatibilityCapabilityEnvelope(limitCandidates);
    const rangeTypes = getAuthorizedHEVCRangeTypes(
        authorizedRoutes,
        rawHEVCLimits,
        nativeHDRLimits,
        nativeDolbyVisionLimits
    );
    if (!combinedLimits || rangeTypes.length === 0) {
        return null;
    }
    return { limits: combinedLimits, rangeTypes };
}

function widenAuthorizedHDRCodecProfiles(
    profile: DeviceProfile,
    capabilities: CustomDecodeCapabilities,
    supportedRawHDRVideoCodecs: readonly CustomVideoCodec[],
    supportedNativeVideoCodecs: readonly CustomVideoCodec[],
    authorizedRoutes: AuthorizedHDRRoutes
): number {
    const authorizedHEVCProfilePlan = createAuthorizedHEVCProfilePlan(
        capabilities,
        supportedRawHDRVideoCodecs,
        authorizedRoutes
    );
    const supportsAuthorizedHEVC = authorizedHEVCProfilePlan !== null;
    let widenedProfileCount = 0;
    if (authorizedHEVCProfilePlan) {
        widenedProfileCount += widenRawHDRCodecProfiles(
            profile,
            [ 'hevc' ],
            supportedNativeVideoCodecs,
            capabilities,
            authorizedHEVCProfilePlan.rangeTypes,
            authorizedHEVCProfilePlan.limits
        );
    }
    if (authorizedRoutes.rawHDRVideoRangeTypes.length === 0) {
        return widenedProfileCount;
    }
    return widenedProfileCount + widenRawHDRCodecProfiles(
        profile,
        supportedRawHDRVideoCodecs.filter(codec => (
            codec !== 'hevc' || !supportsAuthorizedHEVC
        )),
        supportedNativeVideoCodecs,
        capabilities,
        authorizedRoutes.rawHDRVideoRangeTypes
    );
}

function createMeasuredAudioRouteProfile(
    codecs: readonly CustomAudioCodec[],
    channelCounts: readonly number[],
    sampleRates: readonly number[]
): CodecProfile {
    return {
        Codec: codecs.join(','),
        Conditions: [
            {
                Condition: channelCounts.length === 1 ? 'Equals' : EQUALS_ANY_CONDITION,
                IsRequired: true,
                Property: AUDIO_CHANNELS_PROPERTY,
                Value: channelCounts.join('|')
            },
            {
                Condition: sampleRates.length === 1 ? 'Equals' : EQUALS_ANY_CONDITION,
                IsRequired: true,
                Property: AUDIO_SAMPLE_RATE_PROPERTY,
                Value: sampleRates.join('|')
            }
        ],
        Container: CUSTOM_VIDEO_CONTAINER_VALUE,
        Type: 'VideoAudio'
    };
}

function createRequiredAudioRouteCondition(
    property: typeof AUDIO_CHANNELS_PROPERTY
        | typeof AUDIO_PROFILE_PROPERTY
        | typeof AUDIO_SAMPLE_RATE_PROPERTY,
    values: readonly (number | string)[]
): ProfileCondition {
    return {
        Condition: values.length === 1 ? 'Equals' : EQUALS_ANY_CONDITION,
        IsRequired: true,
        Property: property,
        Value: values.join('|')
    };
}

function createMeasuredExactAudioRouteProfile(
    codec: 'dts' | 'mlp' | 'truehd',
    conditions: readonly ProfileCondition[],
    applyConditions: readonly ProfileCondition[] = []
): CodecProfile {
    return {
        ...(applyConditions.length > 0 ? { ApplyConditions: [ ...applyConditions ] } : {}),
        Codec: codec,
        Conditions: [ ...conditions ],
        Container: MATROSKA_VIDEO_RULE.container,
        Type: 'VideoAudio'
    };
}

type DTSProfileRouteGroup = {
    channelCount: number
    profileTokens: DTSProfileToken[]
    sampleRate: number
};

function createMeasuredDTSRouteProfiles(): CodecProfile[] {
    const measuredProfiles: CodecProfile[] = [];
    measuredProfiles.push(createMeasuredExactAudioRouteProfile('dts', [
        createRequiredAudioRouteCondition(AUDIO_CHANNELS_PROPERTY, [ 6, 7, 8 ]),
        createRequiredAudioRouteCondition(AUDIO_SAMPLE_RATE_PROPERTY, [ 48_000, 96_000, 192_000 ]),
        createRequiredAudioRouteCondition(AUDIO_PROFILE_PROPERTY, SUPPORTED_DTS_AUDIO_PROFILES)
    ]));

    const sampleRatesByChannelCount = new Map<number, Set<number>>();
    const routeGroupsByKey = new Map<string, DTSProfileRouteGroup>();
    for (const route of DTS_EXACT_INPUT_ROUTES) {
        let sampleRates = sampleRatesByChannelCount.get(route.channelCount);
        if (!sampleRates) {
            sampleRates = new Set<number>();
            sampleRatesByChannelCount.set(route.channelCount, sampleRates);
        }
        sampleRates.add(route.sampleRate);

        const routeKey = `${route.channelCount}|${route.sampleRate}`;
        let routeGroup = routeGroupsByKey.get(routeKey);
        if (!routeGroup) {
            routeGroup = {
                channelCount: route.channelCount,
                profileTokens: [],
                sampleRate: route.sampleRate
            };
            routeGroupsByKey.set(routeKey, routeGroup);
        }
        for (const profileToken of route.profileTokens) {
            if (!routeGroup.profileTokens.includes(profileToken)) {
                routeGroup.profileTokens.push(profileToken);
            }
        }
    }

    for (const [ channelCount, sampleRateSet ] of sampleRatesByChannelCount) {
        const sampleRates = [ ...sampleRateSet ].sort((left, right) => left - right);
        measuredProfiles.push(createMeasuredExactAudioRouteProfile(
            'dts',
            [ createRequiredAudioRouteCondition(AUDIO_SAMPLE_RATE_PROPERTY, sampleRates) ],
            [ createRequiredAudioRouteCondition(AUDIO_CHANNELS_PROPERTY, [ channelCount ]) ]
        ));
    }
    for (const routeGroup of routeGroupsByKey.values()) {
        const profileValues = routeGroup.profileTokens.map(profileToken => (
            DTS_PROFILE_VALUE_BY_TOKEN[profileToken]
        ));
        measuredProfiles.push(createMeasuredExactAudioRouteProfile(
            'dts',
            [ createRequiredAudioRouteCondition(AUDIO_PROFILE_PROPERTY, profileValues) ],
            [
                createRequiredAudioRouteCondition(
                    AUDIO_CHANNELS_PROPERTY,
                    [ routeGroup.channelCount ]
                ),
                createRequiredAudioRouteCondition(
                    AUDIO_SAMPLE_RATE_PROPERTY,
                    [ routeGroup.sampleRate ]
                )
            ]
        ));
    }
    return measuredProfiles;
}

function createMeasuredTrueHDRouteProfiles(
    codec: 'mlp' | 'truehd'
): CodecProfile[] {
    const measuredProfiles: CodecProfile[] = [];
    const sampleRatesByChannelCount = new Map<number, Set<number>>();
    for (const route of TRUEHD_EXACT_INPUT_ROUTES) {
        if (route.codec !== codec) {
            continue;
        }
        let sampleRates = sampleRatesByChannelCount.get(route.channelCount);
        if (!sampleRates) {
            sampleRates = new Set<number>();
            sampleRatesByChannelCount.set(route.channelCount, sampleRates);
        }
        sampleRates.add(route.sampleRate);
    }
    if (sampleRatesByChannelCount.size === 0) {
        return measuredProfiles;
    }

    const channelCounts = [ ...sampleRatesByChannelCount.keys() ].sort(
        (left, right) => left - right
    );
    const allSampleRates = new Set<number>();
    for (const sampleRates of sampleRatesByChannelCount.values()) {
        for (const sampleRate of sampleRates) {
            allSampleRates.add(sampleRate);
        }
    }
    measuredProfiles.push(createMeasuredExactAudioRouteProfile(codec, [
        createRequiredAudioRouteCondition(AUDIO_CHANNELS_PROPERTY, channelCounts),
        createRequiredAudioRouteCondition(
            AUDIO_SAMPLE_RATE_PROPERTY,
            [ ...allSampleRates ].sort((left, right) => left - right)
        )
    ]));
    for (const [ channelCount, sampleRateSet ] of sampleRatesByChannelCount) {
        measuredProfiles.push(createMeasuredExactAudioRouteProfile(
            codec,
            [
                createRequiredAudioRouteCondition(
                    AUDIO_SAMPLE_RATE_PROPERTY,
                    [ ...sampleRateSet ].sort((left, right) => left - right)
                )
            ],
            [ createRequiredAudioRouteCondition(AUDIO_CHANNELS_PROPERTY, [ channelCount ]) ]
        ));
    }
    return measuredProfiles;
}

const CUSTOM_AUDIO_ROUTE_PROPERTIES = new Set<string>([
    AUDIO_CHANNELS_PROPERTY,
    AUDIO_SAMPLE_RATE_PROPERTY,
    'IsSecondaryAudio'
]);

function isMeasuredAudioRouteProfile(codecProfile: CodecProfile): boolean {
    if (codecProfile.Type !== 'VideoAudio'
        || normalizeList(codecProfile.Container) !== normalizeList(CUSTOM_VIDEO_CONTAINER_VALUE)) {
        return false;
    }

    const conditions = codecProfile.Conditions ?? [];
    return conditions.length === 2
        && conditions.every(condition => (
            condition.IsRequired === true
            && CUSTOM_AUDIO_ROUTE_PROPERTIES.has(condition.Property ?? '')
        ))
        && conditions.some(condition => condition.Property === AUDIO_CHANNELS_PROPERTY)
        && conditions.some(condition => condition.Property === AUDIO_SAMPLE_RATE_PROPERTY);
}

function isMeasuredDTS192KHZRouteProfile(codecProfile: CodecProfile): boolean {
    const applyConditions = codecProfile.ApplyConditions ?? [];
    const conditions = codecProfile.Conditions ?? [];
    return codecProfile.Type === 'VideoAudio'
        && normalizeList(codecProfile.Codec) === 'dts'
        && normalizeList(codecProfile.Container) === MATROSKA_VIDEO_RULE.container
        && applyConditions.length === 1
        && applyConditions[0].Condition === 'Equals'
        && applyConditions[0].Property === AUDIO_SAMPLE_RATE_PROPERTY
        && applyConditions[0].Value === '192000'
        && conditions.some(condition => condition.Property === AUDIO_CHANNELS_PROPERTY)
        && conditions.some(condition => condition.Property === AUDIO_PROFILE_PROPERTY);
}

function getDeclaredDirectPlayAudioCodecs(profile: DeviceProfile): string[] {
    const codecs: string[] = [];
    for (const directPlayProfile of profile.DirectPlayProfiles ?? []) {
        if (directPlayProfile.Type !== 'Video') {
            continue;
        }
        for (const codec of getCodecTokens(directPlayProfile.AudioCodec)) {
            if (!codecs.includes(codec)) {
                codecs.push(codec);
            }
        }
    }
    return codecs;
}

function shouldSplitAudioRouteProfile(codecProfile: CodecProfile): boolean {
    const conditions = codecProfile.Conditions ?? [];
    return codecProfile.Type === 'VideoAudio'
        && !codecProfile.SubContainer
        && !codecProfile.Container?.trim().startsWith('-')
        && !isMeasuredAudioRouteProfile(codecProfile)
        && !isMeasuredDTS192KHZRouteProfile(codecProfile)
        && conditions.some(condition => (
            CUSTOM_AUDIO_ROUTE_PROPERTIES.has(condition.Property ?? '')
        ));
}

function createSplitAudioRouteProfiles(
    codecProfile: CodecProfile,
    supportedAudioCodecs: readonly CustomAudioCodec[],
    supportedAudioCodecSet: ReadonlySet<string>,
    declaredDirectPlayAudioCodecs: readonly string[]
): CodecProfile[] | null {
    if (!shouldSplitAudioRouteProfile(codecProfile)) {
        return null;
    }

    const configuredContainers = getCodecTokens(codecProfile.Container);
    const customContainers = configuredContainers.length === 0 ?
        [ ...CUSTOM_VIDEO_CONTAINERS ] :
        configuredContainers.filter(container => CUSTOM_VIDEO_CONTAINER_SET.has(container));
    if (customContainers.length === 0) {
        return null;
    }

    const configuredCodecs = getCodecTokens(codecProfile.Codec);
    const supportedProfileCodecs = configuredCodecs.length === 0 ?
        [ ...supportedAudioCodecs ] :
        configuredCodecs.filter(codec => supportedAudioCodecSet.has(codec));
    if (supportedProfileCodecs.length === 0) {
        return null;
    }

    const splitProfiles: CodecProfile[] = [];
    const nonCustomContainers = configuredContainers.filter(container => (
        !CUSTOM_VIDEO_CONTAINER_SET.has(container)
    ));
    if (configuredContainers.length === 0) {
        splitProfiles.push({
            ...codecProfile,
            Container: NON_CUSTOM_VIDEO_CONTAINER_VALUE
        });
    } else if (nonCustomContainers.length > 0) {
        splitProfiles.push({
            ...codecProfile,
            Container: nonCustomContainers.join(',')
        });
    }

    const unsupportedProfileCodecs = configuredCodecs.length === 0 ?
        declaredDirectPlayAudioCodecs.filter(codec => !supportedAudioCodecSet.has(codec)) :
        configuredCodecs.filter(codec => !supportedAudioCodecSet.has(codec));
    if (unsupportedProfileCodecs.length > 0) {
        splitProfiles.push({
            ...codecProfile,
            Codec: unsupportedProfileCodecs.join(','),
            Container: customContainers.join(',')
        });
    }

    const remainingConditions = (codecProfile.Conditions ?? []).filter(condition => (
        !CUSTOM_AUDIO_ROUTE_PROPERTIES.has(condition.Property ?? '')
    ));
    if (remainingConditions.length > 0) {
        splitProfiles.push({
            ...codecProfile,
            Codec: supportedProfileCodecs.join(','),
            Conditions: remainingConditions,
            Container: customContainers.join(',')
        });
    }
    return splitProfiles;
}

/**
 * Keeps HTML-player audio constraints outside custom routes while removing the
 * channel, sample-rate, and secondary-track limits replaced by measured routes.
 */
function splitOriginalAudioRouteProfiles(
    profile: DeviceProfile,
    supportedAudioCodecs: readonly CustomAudioCodec[]
): void {
    if (!profile.CodecProfiles || supportedAudioCodecs.length === 0) {
        return;
    }

    const supportedAudioCodecSet = new Set<string>(supportedAudioCodecs);
    const declaredDirectPlayAudioCodecs = getDeclaredDirectPlayAudioCodecs(profile);
    const splitProfiles: CodecProfile[] = [];
    for (const codecProfile of profile.CodecProfiles) {
        const profileSplits = createSplitAudioRouteProfiles(
            codecProfile,
            supportedAudioCodecs,
            supportedAudioCodecSet,
            declaredDirectPlayAudioCodecs
        );
        if (profileSplits === null) {
            splitProfiles.push(codecProfile);
        } else {
            splitProfiles.push(...profileSplits);
        }
    }
    profile.CodecProfiles = splitProfiles;
}

function getSupportedNativeMediaChannelCounts(
    nativeMediaAudioCapabilities: NativeMediaAudioCapabilities,
    codec: NativeMediaAudioCodec
): NativeMediaAudioChannelCount[] {
    const channelCounts: NativeMediaAudioChannelCount[] = [];
    for (const channelCount of NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS) {
        if (nativeMediaAudioCapabilities.audio[codec].layouts[channelCount].status === 'supported') {
            channelCounts.push(channelCount);
        }
    }
    return channelCounts;
}

function appendMeasuredNativeAudioRouteProfiles(
    measuredProfiles: CodecProfile[],
    capabilities: CustomDecodeCapabilities,
    nativeMediaAudioCapabilities: NativeMediaAudioCapabilities | null | undefined
): Set<NativeMediaAudioCodec> {
    const nativeMediaCodecs = new Set<NativeMediaAudioCodec>();
    if (!nativeMediaAudioCapabilities) {
        return nativeMediaCodecs;
    }

    for (const codec of [ 'ac3', 'eac3' ] as const) {
        const channelCounts = getSupportedNativeMediaChannelCounts(
            nativeMediaAudioCapabilities,
            codec
        );
        if (channelCounts.length === 0) {
            continue;
        }
        nativeMediaCodecs.add(codec);
        if (capabilities.audio[codec].status === 'supported') {
            for (const channelCount of getSupportedCustomAudioInputChannelCounts(codec)) {
                const nativeChannelCount = channelCount as NativeMediaAudioChannelCount;
                if (!channelCounts.includes(nativeChannelCount)) {
                    channelCounts.push(nativeChannelCount);
                }
            }
            channelCounts.sort((left, right) => left - right);
        }
        measuredProfiles.push(createMeasuredAudioRouteProfile(
            [ codec ],
            channelCounts,
            [ NATIVE_MEDIA_AUDIO_SAMPLE_RATE ]
        ));
    }
    return nativeMediaCodecs;
}

function getDecodedAudioCodecsWithoutNativeProfile(
    capabilities: CustomDecodeCapabilities,
    nativeMediaCodecs: ReadonlySet<NativeMediaAudioCodec>
): CustomAudioCodec[] {
    const decodedAudioCodecs: CustomAudioCodec[] = [];
    for (const codec of CUSTOM_AUDIO_CODECS) {
        if (capabilities.audio[codec].status !== 'supported') {
            continue;
        }
        if ((codec === 'ac3' || codec === 'eac3') && nativeMediaCodecs.has(codec)) {
            continue;
        }
        decodedAudioCodecs.push(codec);
    }
    return decodedAudioCodecs;
}

function hasQualifiedDecodedSurroundRoute(
    codec: CustomAudioCodec,
    capabilities: CustomDecodeCapabilities
): boolean {
    if (isCustomMediabunnyPCMAudioCodec(codec)) {
        return true;
    }
    switch (codec) {
        case 'ac3':
        case 'eac3':
            return true;
        case 'dts':
            return capabilities.bundledDTS?.status === 'supported';
        case 'mlp':
        case 'truehd':
            return capabilities.bundledTrueHD?.status === 'supported';
        case 'aac':
        case 'flac':
        case 'opus':
        case 'vorbis': {
            const surroundCapability: CustomNativeSurroundAudioCodecCapability | undefined =
                capabilities.nativeSurroundAudio?.[codec];
            return surroundCapability?.status === 'supported'
                && surroundCapability.inputChannelCount
                    === CUSTOM_SURROUND_INPUT_CHANNEL_COUNT
                && surroundCapability.sampleRate === CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE;
        }
        case 'mp3':
            return false;
    }
}

function appendMeasuredAudioRouteProfiles(
    profile: DeviceProfile,
    capabilities: CustomDecodeCapabilities,
    nativeMediaAudioCapabilities: NativeMediaAudioCapabilities | null | undefined,
    supportedAudioCodecs: readonly CustomAudioCodec[]
): void {
    splitOriginalAudioRouteProfiles(profile, supportedAudioCodecs);
    const codecProfiles = profile.CodecProfiles ?? [];
    profile.CodecProfiles = codecProfiles;
    const existingProfileKeys = new Set(codecProfiles.map(getCodecProfileKey));
    const measuredProfiles: CodecProfile[] = [];
    const nativeMediaCodecs = appendMeasuredNativeAudioRouteProfiles(
        measuredProfiles,
        capabilities,
        nativeMediaAudioCapabilities
    );
    const decodedAudioCodecs = getDecodedAudioCodecsWithoutNativeProfile(
        capabilities,
        nativeMediaCodecs
    );
    const decodedAudioRouteGroups = new Map<string, {
        channelCounts: readonly number[]
        codecs: CustomAudioCodec[]
        sampleRates: readonly number[]
    }>();
    for (const codec of decodedAudioCodecs) {
        if (codec === 'dts' || codec === 'mlp' || codec === 'truehd') {
            continue;
        }
        const channelCounts = hasQualifiedDecodedSurroundRoute(codec, capabilities) ?
            getSupportedCustomAudioInputChannelCounts(codec) :
            [ CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT ];
        const sampleRates = getSupportedCustomAudioInputSampleRates(codec);
        const routeKey = `${channelCounts.join(',')}|${sampleRates.join(',')}`;
        let routeGroup = decodedAudioRouteGroups.get(routeKey);
        if (!routeGroup) {
            routeGroup = {
                channelCounts,
                codecs: [],
                sampleRates
            };
            decodedAudioRouteGroups.set(routeKey, routeGroup);
        }
        routeGroup.codecs.push(codec);
    }
    for (const routeGroup of decodedAudioRouteGroups.values()) {
        measuredProfiles.push(createMeasuredAudioRouteProfile(
            routeGroup.codecs,
            routeGroup.channelCounts,
            routeGroup.sampleRates
        ));
    }
    if (decodedAudioCodecs.includes('dts')) {
        measuredProfiles.push(...createMeasuredDTSRouteProfiles());
    }
    if (decodedAudioCodecs.includes('mlp')) {
        measuredProfiles.push(...createMeasuredTrueHDRouteProfiles('mlp'));
    }
    if (decodedAudioCodecs.includes('truehd')) {
        measuredProfiles.push(...createMeasuredTrueHDRouteProfiles('truehd'));
    }

    for (const measuredProfile of measuredProfiles) {
        const profileKey = getCodecProfileKey(measuredProfile);
        if (existingProfileKeys.has(profileKey)) {
            continue;
        }
        codecProfiles.push(measuredProfile);
        existingProfileKeys.add(profileKey);
    }
}

/**
 * Clones and widens direct-play declarations only for proven WebCodecs and
 * Mediabunny combinations. Existing transcoding behavior is copied unchanged.
 */
export function augmentDeviceProfileForCustomDecode(
    profile: DeviceProfile,
    capabilities: CustomDecodeCapabilities,
    options: CustomDeviceProfileOptions = {}
): CustomDeviceProfileResult {
    const clonedProfile = cloneDeviceProfile(profile);
    const nativeHDRVideoRangeTypes = options.allowNativeHDR === true ?
        getAuthorizedExternalHDRVideoRangeTypes(
            options.authorizedExternalHDRRouteKeys ?? []
        ) :
        [];
    const rawHDRVideoRangeTypes = options.allowRawHDR === true ?
        getAuthorizedRawHDRVideoRangeTypes(options.authorizedRawHDRRouteKeys ?? []) :
        [];
    const availableRawDolbyVisionVideoRangeTypes = getDolbyVisionVideoRangeTypes(
        capabilities,
        options.allowDolbyVision === true,
        options.allowDolbyVisionProfile7 === true,
        options.allowDolbyVisionProfile7HDR10Base === true,
        false
    );
    const nativeDolbyVisionVideoRangeTypes = getDolbyVisionVideoRangeTypes(
        capabilities,
        false,
        false,
        false,
        options.allowNativeDolbyVision === true
    );
    const rawDolbyVisionVideoRangeTypes = nativeDolbyVisionVideoRangeTypes.includes('DOVI') ?
        availableRawDolbyVisionVideoRangeTypes.filter(rangeType => rangeType !== 'DOVI') :
        availableRawDolbyVisionVideoRangeTypes;
    const dolbyVisionVideoRangeTypes = [
        ...new Set([
            ...rawDolbyVisionVideoRangeTypes,
            ...nativeDolbyVisionVideoRangeTypes
        ])
    ];
    const allowRawDolbyVision = rawDolbyVisionVideoRangeTypes.length > 0;
    const allowNativeDolbyVision = nativeDolbyVisionVideoRangeTypes.length > 0;
    const allowNativeHDR = nativeHDRVideoRangeTypes.length > 0;
    const allowRawHDR = rawHDRVideoRangeTypes.length > 0
        || dolbyVisionVideoRangeTypes.length > 0
        || allowNativeHDR;
    const supportedNativeVideoCodecs = getSupportedVideoCodecs(capabilities, false);
    const supportedVideoCodecs = getSupportedVideoCodecs(
        capabilities,
        rawHDRVideoRangeTypes.length > 0,
        allowRawDolbyVision,
        allowNativeDolbyVision,
        allowNativeHDR
    );
    const supportedAudioCodecs = getSupportedAudioCodecs(
        capabilities,
        options.nativeMediaAudioCapabilities
    );
    const supportedRawHDRVideoCodecs = getSupportedRawHDRVideoCodecs(capabilities);
    if (options.isRetry === true) {
        return {
            profile: clonedProfile,
            telemetry: createTelemetry(
                'retry-not-widened',
                supportedVideoCodecs,
                supportedAudioCodecs,
                [],
                0
            )
        };
    }

    removeBitratePlaybackConstraints(clonedProfile);

    if (supportedVideoCodecs.length === 0 && supportedAudioCodecs.length === 0) {
        return {
            profile: clonedProfile,
            telemetry: createTelemetry(
                'no-supported-codecs',
                supportedVideoCodecs,
                supportedAudioCodecs,
                [],
                0
            )
        };
    }

    const compatibleProfiles = createCompatibleProfiles(supportedVideoCodecs, supportedAudioCodecs);
    if (compatibleProfiles.length === 0) {
        return {
            profile: clonedProfile,
            telemetry: createTelemetry(
                'no-compatible-combinations',
                supportedVideoCodecs,
                supportedAudioCodecs,
                [],
                0
            )
        };
    }

    const widenedHDRCodecProfileCount = allowRawHDR ?
        widenAuthorizedHDRCodecProfiles(
            clonedProfile,
            capabilities,
            supportedRawHDRVideoCodecs,
            supportedNativeVideoCodecs,
            {
                allowNativeDolbyVision,
                allowNativeHDR,
                allowRawDolbyVision,
                dolbyVisionVideoRangeTypes,
                nativeHDRVideoRangeTypes,
                rawHDRVideoRangeTypes
            }
        ) :
        0;
    appendMeasuredVideoRouteProfiles(
        clonedProfile,
        capabilities,
        supportedVideoCodecs,
        {
            allowNativeDolbyVision,
            allowNativeHDR,
            nativeDolbyVisionVideoRangeTypes,
            nativeHDRVideoRangeTypes,
            rawDolbyVisionVideoRangeTypes,
            rawHDRVideoRangeTypes
        }
    );
    appendMeasuredAudioRouteProfiles(
        clonedProfile,
        capabilities,
        options.nativeMediaAudioCapabilities,
        supportedAudioCodecs
    );

    const directPlayProfiles = clonedProfile.DirectPlayProfiles ?? [];
    clonedProfile.DirectPlayProfiles = directPlayProfiles;
    const existingProfileKeys = new Set(directPlayProfiles.map(getProfileKey));
    const addedProfiles: DirectPlayProfile[] = [];
    for (const compatibleProfile of compatibleProfiles) {
        const profileKey = getProfileKey(compatibleProfile);
        if (existingProfileKeys.has(profileKey)) {
            continue;
        }
        directPlayProfiles.push(compatibleProfile);
        existingProfileKeys.add(profileKey);
        addedProfiles.push(compatibleProfile);
    }

    return {
        profile: clonedProfile,
        telemetry: createTelemetry(
            addedProfiles.length > 0 ? 'augmented' : 'already-advertised',
            supportedVideoCodecs,
            supportedAudioCodecs,
            addedProfiles,
            widenedHDRCodecProfileCount
        )
    };
}
