import type { CodecProfile } from '@jellyfin/sdk/lib/generated-client/models/codec-profile';
import type { ContainerProfile } from '@jellyfin/sdk/lib/generated-client/models/container-profile';
import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import type { DirectPlayProfile } from '@jellyfin/sdk/lib/generated-client/models/direct-play-profile';
import type { ProfileCondition } from '@jellyfin/sdk/lib/generated-client/models/profile-condition';
import type { SubtitleProfile } from '@jellyfin/sdk/lib/generated-client/models/subtitle-profile';

import {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_BUNDLED_HEVC_BASELINE_MAXIMUM_FRAMES_PER_SECOND,
    CUSTOM_NATIVE_VIDEO_BIT_DEPTH,
    CUSTOM_RAW_HDR_VIDEO_CODECS,
    CUSTOM_VIDEO_CODECS,
    hasSupportedNativeSDRVideoCodec,
    isCustomHDRVideoMaximumFramesPerSecond,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomNativeHDRHEVCCapability,
    type CustomNativeSurroundAudioCodecCapability,
    type CustomRawHDRVideoCodecCapability,
    type CustomVideoCodec
} from './CustomDecodeCapabilities';
import {
    CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT,
    CUSTOM_SURROUND_INPUT_CHANNEL_COUNT,
    getSupportedCustomAudioInputChannelCounts,
    isCustomMediabunnyPCMAudioCodec
} from './CustomAudioOutputPolicy';
import {
    CUSTOM_CONTAINER_CODEC_RULES,
    CUSTOM_MATROSKA_PROFILE_CONTAINER,
    CUSTOM_PROFILE_VIDEO_CONTAINERS
} from './CustomContainerCodecSupport';
import {
    DTS_DIRECT_PLAY_PROFILE_TOKENS,
    DTS_PROFILE_VALUE_BY_TOKEN,
    DTS_SUPPORTED_INPUT_ROUTES,
    TRUEHD_CAPABILITY_FIXTURE_ROUTES,
    isDTSDirectPlayProfileToken,
    type DTSDirectPlayProfileToken
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
    allowNativeDolbyVisionProfile7HDR10Base?: boolean
    allowNativeDolbyVisionProfile8HDR10Base?: boolean
    allowNativeHDR?: boolean
    allowRawHDR?: boolean
    authorizedExternalHDRRouteKeys?: readonly ExternalHDRAuthorizationRouteKey[]
    authorizedRawHDRRouteKeys?: readonly RawHDRAuthorizationRouteKey[]
    isRetry?: boolean
    nativeMediaAudioCapabilities?: NativeMediaAudioCapabilities | null
    subtitleCapabilities?: CustomSubtitleCapabilities
};

export type CustomSubtitleCapabilities = Readonly<{
    externalASS: boolean
    externalPGS: boolean
    externalText: boolean
}>;

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
    subtitleProfileChanged: boolean
    widenedHDRCodecProfileCount: number
};

export type CustomDeviceProfileResult = {
    profile: DeviceProfile
    telemetry: CustomDeviceProfileTelemetry
};

type AuthorizedHDRRoutes = {
    allowNativeDolbyVision: boolean
    allowNativeHDR: boolean
    allowRawDolbyVision: boolean
    dolbyVisionVideoRangeTypes: readonly string[]
    nativeHDRVideoRangeTypes: readonly string[]
    rawHEVCHDRVideoRangeTypes: readonly string[]
    rawHDRVideoRangeTypes: readonly string[]
};

type MeasuredVideoRouteOptions = {
    allowNativeDolbyVision: boolean
    allowNativeHDR: boolean
    nativeDolbyVisionVideoRangeTypes: readonly string[]
    nativeHDRVideoRangeTypes: readonly string[]
    rawDolbyVisionVideoRangeTypes: readonly string[]
    rawHEVCHDRVideoRangeTypes: readonly string[]
    rawHDRVideoRangeTypes: readonly string[]
};

type AuthorizedHEVCProfilePlan = {
    limits: RawHDRCapabilityLimits
    rangeTypes: readonly string[]
};

const CUSTOM_VIDEO_CONTAINERS: readonly string[] = CUSTOM_PROFILE_VIDEO_CONTAINERS;
const CUSTOM_VIDEO_CONTAINER_SET = new Set<string>(CUSTOM_VIDEO_CONTAINERS);
const CUSTOM_VIDEO_CONTAINER_VALUE = CUSTOM_VIDEO_CONTAINERS.join(',');
const NON_CUSTOM_VIDEO_CONTAINER_VALUE = `-${CUSTOM_VIDEO_CONTAINER_VALUE}`;
const VIDEO_CODEC_PROFILE_TYPE = 'Video';
const AUDIO_BIT_DEPTH_PROPERTY = 'AudioBitDepth';
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
const GREATER_THAN_EQUAL_CONDITION = 'GreaterThanEqual';
const LESS_THAN_EQUAL_CONDITION = 'LessThanEqual';
const NOT_EQUALS_CONDITION = 'NotEquals';
const EXTERNAL_SUBTITLE_METHOD = 'External';
const CUSTOM_EXTERNAL_TEXT_SUBTITLE_FORMAT = 'vtt';
const CUSTOM_EXTERNAL_ASS_SUBTITLE_FORMATS = [ 'ass', 'ssa' ] as const;
const CUSTOM_EXTERNAL_PGS_SUBTITLE_FORMAT = 'pgssub';
const DTS_HIGH_SAMPLE_RATE_MINIMUM = 96_001;
const MAXIMUM_RAW_HDR_VIDEO_BIT_DEPTH = 10;
const HDR10_PLUS_VIDEO_RANGE_TYPE = 'HDR10Plus';
const DOLBY_VISION_VIDEO_RANGE_TYPES = [
    'DOVI',
    'DOVIWithHDR10',
    'DOVIWithHLG'
] as const;
const BITRATE_CONDITION_PROPERTIES = new Set<string>([
    AUDIO_BITRATE_PROPERTY,
    VIDEO_BITRATE_PROPERTY
]);
const NATIVE_VIDEO_RUNTIME_CONDITION_PROPERTIES = new Set<string>([
    VIDEO_FRAMERATE_PROPERTY,
    VIDEO_HEIGHT_PROPERTY,
    VIDEO_LEVEL_PROPERTY,
    VIDEO_WIDTH_PROPERTY
]);
const SUPPORTED_DTS_AUDIO_PROFILES: readonly string[] =
    Object.freeze(DTS_DIRECT_PLAY_PROFILE_TOKENS.map(profileToken => (
        DTS_PROFILE_VALUE_BY_TOKEN[profileToken]
    )));

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

function getAuthorizedRawHEVCHDRVideoRangeTypes(
    rawHDRVideoRangeTypes: readonly string[]
): string[] {
    const rangeTypes: string[] = [ ...rawHDRVideoRangeTypes ];
    if (
        rangeTypes.includes('HDR10')
        && !rangeTypes.includes(HDR10_PLUS_VIDEO_RANGE_TYPE)
    ) {
        rangeTypes.push(HDR10_PLUS_VIDEO_RANGE_TYPE);
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
                rangeTypes.push(HDR10_PLUS_VIDEO_RANGE_TYPE);
                break;
        }
    }
    return rangeTypes;
}

function authorizeNativeDolbyVisionHDR10BaseRanges(
    capabilities: CustomDecodeCapabilities,
    options: CustomDeviceProfileOptions,
    nativeHDRVideoRangeTypes: string[]
): ReadonlySet<string> {
    const overlappingRawRangeTypes = new Set<string>();
    if (!nativeHDRVideoRangeTypes.includes('HDR10')
        || capabilities.nativeHDRHEVC?.status !== 'supported') {
        return overlappingRawRangeTypes;
    }
    if (options.allowNativeDolbyVisionProfile7HDR10Base === true) {
        nativeHDRVideoRangeTypes.push('DOVIWithEL');
        overlappingRawRangeTypes.add('DOVIWithEL');
        overlappingRawRangeTypes.add('HDR10');
    }
    if (options.allowNativeDolbyVisionProfile8HDR10Base === true) {
        nativeHDRVideoRangeTypes.push('DOVIWithHDR10');
        overlappingRawRangeTypes.add('DOVIWithHDR10');
    }
    return overlappingRawRangeTypes;
}

type MeasuredVideoRoute = {
    bitDepth: number
    codec: CustomVideoCodec
    maximumFrameRate: number | null
    maximumHeight: number | null
    maximumLevel: number | null
    maximumWidth: number | null
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
    vc1: [ 'advanced' ],
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
    switch (codec) {
        case 'h264':
            return getNativeVideoProfiles(codec, capabilities).length > 0;
        case 'hevc':
            return hasSupportedNativeSDRVideoCodec(codec, capabilities)
                || capabilities.bundledHEVC?.tiers['main-1080p'].status === 'supported';
        case 'av1':
        case 'vp9':
            return hasSupportedNativeSDRVideoCodec(codec, capabilities);
        case 'jpeg2000':
            return capabilities.bundledJPEG2000?.status === 'supported';
        case 'mpeg2video':
            return capabilities.bundledLegacyVideo?.status === 'supported';
        case 'vc1':
            return capabilities.bundledVC1?.status === 'supported';
        case 'vp8':
            return capabilities.video[codec].status === 'supported';
    }
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

function normalizeSubtitleProfileValue(value: string | null | undefined): string {
    return value?.trim().toLowerCase() ?? '';
}

function getSubtitleProfileKey(profile: SubtitleProfile): string {
    return [
        normalizeSubtitleProfileValue(profile.Method),
        normalizeSubtitleProfileValue(profile.Format),
        normalizeSubtitleProfileValue(profile.Container),
        normalizeSubtitleProfileValue(profile.Language),
        normalizeSubtitleProfileValue(profile.DidlMode)
    ].join('|');
}

function addUniqueSubtitleProfile(
    profiles: SubtitleProfile[],
    profileKeys: Set<string>,
    profile: SubtitleProfile
): void {
    const profileKey: string = getSubtitleProfileKey(profile);
    if (profileKeys.has(profileKey)) {
        return;
    }
    profiles.push({ ...profile });
    profileKeys.add(profileKey);
}

/** Restricts custom playback to subtitle formats rendered by its owned HTML layers. */
function applyCustomSubtitleProfiles(
    profile: DeviceProfile,
    capabilities: CustomSubtitleCapabilities
): boolean {
    const originalProfiles: readonly SubtitleProfile[] = profile.SubtitleProfiles ?? [];
    const customProfiles: SubtitleProfile[] = [];
    const profileKeys = new Set<string>();

    for (const subtitleProfile of originalProfiles) {
        if (normalizeSubtitleProfileValue(subtitleProfile.Method) === 'external') {
            continue;
        }
        addUniqueSubtitleProfile(customProfiles, profileKeys, subtitleProfile);
    }

    if (capabilities.externalText) {
        addUniqueSubtitleProfile(customProfiles, profileKeys, {
            Format: CUSTOM_EXTERNAL_TEXT_SUBTITLE_FORMAT,
            Method: EXTERNAL_SUBTITLE_METHOD
        });
    }
    if (capabilities.externalASS) {
        for (const format of CUSTOM_EXTERNAL_ASS_SUBTITLE_FORMATS) {
            addUniqueSubtitleProfile(customProfiles, profileKeys, {
                Format: format,
                Method: EXTERNAL_SUBTITLE_METHOD
            });
        }
    }
    if (capabilities.externalPGS) {
        addUniqueSubtitleProfile(customProfiles, profileKeys, {
            Format: CUSTOM_EXTERNAL_PGS_SUBTITLE_FORMAT,
            Method: EXTERNAL_SUBTITLE_METHOD
        });
    }

    profile.SubtitleProfiles = customProfiles;
    if (originalProfiles.length !== customProfiles.length) {
        return true;
    }
    return originalProfiles.some((subtitleProfile: SubtitleProfile, index: number): boolean => (
        getSubtitleProfileKey(subtitleProfile) !== getSubtitleProfileKey(customProfiles[index])
    ));
}

function applyOptionalCustomSubtitleProfiles(
    profile: DeviceProfile,
    capabilities: CustomSubtitleCapabilities | undefined
): boolean {
    if (!capabilities) {
        return false;
    }
    return applyCustomSubtitleProfiles(profile, capabilities);
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

    for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
        const videoCodecs = selectCompatibleCodecs(rule.videoCodecs, supportedVideoSet);
        const audioCodecs = selectCompatibleCodecs(rule.audioCodecs, supportedAudioSet);
        if (videoCodecs.length === 0 || audioCodecs.length === 0) {
            continue;
        }
        profiles.push({
            AudioCodec: audioCodecs.join(','),
            Container: rule.profileContainers.join(','),
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
    widenedHDRCodecProfileCount: number,
    subtitleProfileChanged = false
): CustomDeviceProfileTelemetry {
    return {
        addedAudioProfileCount: addedProfiles.filter(profile => profile.Type === 'Audio').length,
        addedProfileCount: addedProfiles.length,
        addedVideoProfileCount: addedProfiles.filter(profile => profile.Type === 'Video').length,
        reason,
        supportedAudioCodecs: [ ...supportedAudioCodecs ],
        supportedVideoCodecs: [ ...supportedVideoCodecs ],
        subtitleProfileChanged,
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

type CustomContainerScope = {
    customContainers: string[]
    nonCustomContainerValue: string | null
};

function getUniqueTokens(tokens: readonly string[]): string[] {
    const uniqueTokens: string[] = [];
    for (const token of tokens) {
        if (!uniqueTokens.includes(token)) {
            uniqueTokens.push(token);
        }
    }
    return uniqueTokens;
}

function getCustomContainerScope(
    containerValue: string | null | undefined
): CustomContainerScope {
    const normalizedValue = containerValue?.trim().toLowerCase() ?? '';
    if (!normalizedValue) {
        return {
            customContainers: [ ...CUSTOM_VIDEO_CONTAINERS ],
            nonCustomContainerValue: NON_CUSTOM_VIDEO_CONTAINER_VALUE
        };
    }

    if (normalizedValue.startsWith('-')) {
        const excludedContainers = getCodecTokens(normalizedValue.slice(1));
        return {
            customContainers: CUSTOM_VIDEO_CONTAINERS.filter(container => (
                !excludedContainers.includes(container)
            )),
            nonCustomContainerValue: `-${getUniqueTokens([
                ...excludedContainers,
                ...CUSTOM_VIDEO_CONTAINERS
            ]).join(',')}`
        };
    }

    const configuredContainers = getCodecTokens(normalizedValue);
    const nonCustomContainers = configuredContainers.filter(container => (
        !CUSTOM_VIDEO_CONTAINER_SET.has(container)
    ));
    return {
        customContainers: configuredContainers.filter(container => (
            CUSTOM_VIDEO_CONTAINER_SET.has(container)
        )),
        nonCustomContainerValue: nonCustomContainers.length > 0 ?
            nonCustomContainers.join(',') :
            null
    };
}

function hasNativeRuntimeConditions(
    conditions: readonly ProfileCondition[] | null | undefined
): boolean {
    return conditions?.some(condition => NATIVE_VIDEO_RUNTIME_CONDITION_PROPERTIES.has(
        condition.Property ?? ''
    )) === true;
}

function removeNativeRuntimeConditions(
    conditions: readonly ProfileCondition[] | null | undefined
): ProfileCondition[] | undefined {
    if (!conditions) {
        return undefined;
    }
    return conditions.filter(condition => !NATIVE_VIDEO_RUNTIME_CONDITION_PROPERTIES.has(
        condition.Property ?? ''
    ));
}

function getDeclaredDirectPlayVideoCodecs(profile: DeviceProfile): string[] {
    const codecs: string[] = [];
    for (const directPlayProfile of profile.DirectPlayProfiles ?? []) {
        if (directPlayProfile.Type !== 'Video') {
            continue;
        }
        for (const codec of getCodecTokens(directPlayProfile.VideoCodec)) {
            if (!codecs.includes(codec)) {
                codecs.push(codec);
            }
        }
    }
    return codecs;
}

function getSupportedProfileVideoCodecs(
    candidateCodecs: readonly string[],
    supportedVideoCodecs: readonly CustomVideoCodec[]
): CustomVideoCodec[] {
    const supportedProfileCodecs: CustomVideoCodec[] = [];
    for (const candidateCodec of candidateCodecs) {
        const supportedCodec = supportedVideoCodecs.find(codec => codec === candidateCodec);
        if (supportedCodec) {
            supportedProfileCodecs.push(supportedCodec);
        }
    }
    return supportedProfileCodecs;
}

function createRuntimeConditionProfile(
    codecProfile: CodecProfile,
    codec: CustomVideoCodec,
    containers: readonly string[]
): CodecProfile {
    const runtimeProfile: CodecProfile = {
        ...codecProfile,
        Codec: codec,
        Container: containers.join(',')
    };
    if (codecProfile.ApplyConditions) {
        runtimeProfile.ApplyConditions = removeNativeRuntimeConditions(
            codecProfile.ApplyConditions
        );
    }
    if (codecProfile.Conditions) {
        runtimeProfile.Conditions = removeNativeRuntimeConditions(
            codecProfile.Conditions
        );
    }
    return runtimeProfile;
}

function createSupportedCodecContainerProfiles(
    codecProfile: CodecProfile,
    codec: CustomVideoCodec,
    customContainers: readonly string[]
): CodecProfile[] {
    const profiles: CodecProfile[] = [];
    const routeContainerSet = new Set(getCustomContainersForVideoCodec(codec));
    const runtimeContainers = customContainers.filter(container => (
        routeContainerSet.has(container)
    ));
    const preservedContainers = customContainers.filter(container => (
        !routeContainerSet.has(container)
    ));
    if (preservedContainers.length > 0) {
        profiles.push({
            ...codecProfile,
            Codec: codec,
            Container: preservedContainers.join(',')
        });
    }
    if (runtimeContainers.length > 0) {
        profiles.push(createRuntimeConditionProfile(
            codecProfile,
            codec,
            runtimeContainers
        ));
    }
    return profiles;
}

function createScopedVideoRuntimeProfiles(
    codecProfile: CodecProfile,
    supportedVideoCodecs: readonly CustomVideoCodec[],
    declaredVideoCodecs: readonly string[]
): CodecProfile[] | null {
    if (
        codecProfile.Type !== VIDEO_CODEC_PROFILE_TYPE
        || codecProfile.SubContainer
        || isMeasuredVideoRouteProfile(codecProfile)
        || (!hasNativeRuntimeConditions(codecProfile.Conditions)
            && !hasNativeRuntimeConditions(codecProfile.ApplyConditions))
    ) {
        return null;
    }

    const configuredCodecs = getCodecTokens(codecProfile.Codec);
    const candidateCodecs = configuredCodecs.length > 0 ?
        configuredCodecs :
        declaredVideoCodecs;
    const supportedProfileCodecs = getSupportedProfileVideoCodecs(
        candidateCodecs,
        supportedVideoCodecs
    );
    const containerScope = getCustomContainerScope(codecProfile.Container);
    if (supportedProfileCodecs.length === 0 || containerScope.customContainers.length === 0) {
        return null;
    }

    const profiles: CodecProfile[] = [];
    if (containerScope.nonCustomContainerValue) {
        profiles.push({
            ...codecProfile,
            Container: containerScope.nonCustomContainerValue
        });
    }
    const supportedCodecSet = new Set<string>(supportedVideoCodecs);
    const unsupportedProfileCodecs = candidateCodecs.filter(codec => (
        !supportedCodecSet.has(codec)
    ));
    if (unsupportedProfileCodecs.length > 0) {
        profiles.push({
            ...codecProfile,
            Codec: unsupportedProfileCodecs.join(','),
            Container: containerScope.customContainers.join(',')
        });
    }
    for (const supportedProfileCodec of supportedProfileCodecs) {
        profiles.push(...createSupportedCodecContainerProfiles(
            codecProfile,
            supportedProfileCodec,
            containerScope.customContainers
        ));
    }
    return profiles;
}

/** Isolates browser-native source checks from cumulative HTML codec ceilings. */
function scopeOriginalVideoRuntimeConditions(
    profile: DeviceProfile,
    supportedVideoCodecs: readonly CustomVideoCodec[]
): void {
    if (!profile.CodecProfiles || supportedVideoCodecs.length === 0) {
        return;
    }

    const declaredVideoCodecs = getDeclaredDirectPlayVideoCodecs(profile);
    const scopedProfiles: CodecProfile[] = [];
    for (const codecProfile of profile.CodecProfiles) {
        const profileSplits = createScopedVideoRuntimeProfiles(
            codecProfile,
            supportedVideoCodecs,
            declaredVideoCodecs
        );
        scopedProfiles.push(...(profileSplits ?? [ codecProfile ]));
    }
    profile.CodecProfiles = scopedProfiles;
}

/** Removes container-level source ceilings only from custom WebGPU containers. */
function scopeOriginalContainerRuntimeConditions(profile: DeviceProfile): void {
    if (!profile.ContainerProfiles) {
        return;
    }

    const scopedProfiles: ContainerProfile[] = [];
    for (const containerProfile of profile.ContainerProfiles) {
        if (
            containerProfile.Type !== 'Video'
            || containerProfile.SubContainer
            || !hasNativeRuntimeConditions(containerProfile.Conditions)
        ) {
            scopedProfiles.push(containerProfile);
            continue;
        }

        const containerScope = getCustomContainerScope(containerProfile.Container);
        if (containerScope.customContainers.length === 0) {
            scopedProfiles.push(containerProfile);
            continue;
        }
        if (containerScope.nonCustomContainerValue) {
            scopedProfiles.push({
                ...containerProfile,
                Container: containerScope.nonCustomContainerValue
            });
        }
        scopedProfiles.push({
            ...containerProfile,
            Conditions: removeNativeRuntimeConditions(containerProfile.Conditions),
            Container: containerScope.customContainers.join(',')
        });
    }
    profile.ContainerProfiles = scopedProfiles;
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
    dimensionsValidatedAtRuntime: boolean
    maximumCodedHeight: number
    maximumCodedWidth: number
    maximumFramesPerSecond: number | null
    maximumLevel: number | null
};

function getRawHDRVideoProfiles(rawHDRCodecs: readonly string[]): string[] {
    const profiles: string[] = [];
    for (const codec of rawHDRCodecs) {
        let codecProfiles: readonly string[] = [];
        switch (codec) {
            case 'av1':
                codecProfiles = RAW_VIDEO_PROFILES.av1;
                break;
            case 'hevc':
                codecProfiles = RAW_VIDEO_PROFILES.hevc;
                break;
            case 'vp9':
                codecProfiles = RAW_VIDEO_PROFILES.vp9;
                break;
            default:
                continue;
        }
        for (const codecProfile of codecProfiles) {
            if (!profiles.includes(codecProfile)) {
                profiles.push(codecProfile);
            }
        }
    }
    return profiles;
}

function createRawHDRConditions(
    conditions: NonNullable<CodecProfile['Conditions']>,
    includeSDR: boolean,
    limits: RawHDRCapabilityLimits,
    rawHDRCodecs: readonly string[],
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

    const applicableConditions = conditions.filter(condition => (
        condition.Property !== VIDEO_PROFILE_PROPERTY
        && (!limits.dimensionsValidatedAtRuntime
            || !NATIVE_VIDEO_RUNTIME_CONDITION_PROPERTIES.has(condition.Property ?? ''))
    ));
    const widenedConditions = applicableConditions.map(condition => {
        if (condition.Condition === EQUALS_ANY_CONDITION
            && condition.Property === VIDEO_RANGE_TYPE_PROPERTY) {
            return {
                ...condition,
                Value: getRawHDRVideoRangeTypeValue(includeSDR, rawHDRVideoRangeTypes)
            };
        }

        let widenedCondition = limits.maximumFramesPerSecond === null ?
            condition :
            widenNumericMaximumCondition(
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
        if (!limits.dimensionsValidatedAtRuntime) {
            widenedCondition = widenNumericMaximumCondition(
                widenedCondition,
                VIDEO_WIDTH_PROPERTY,
                limits.maximumCodedWidth
            );
            widenedCondition = widenNumericMaximumCondition(
                widenedCondition,
                VIDEO_HEIGHT_PROPERTY,
                limits.maximumCodedHeight
            );
        }
        return widenedCondition;
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
    const rawVideoProfiles = getRawHDRVideoProfiles(rawHDRCodecs);
    if (rawVideoProfiles.length > 0) {
        widenedConditions.push({
            Condition: EQUALS_ANY_CONDITION,
            IsRequired: true,
            Property: VIDEO_PROFILE_PROPERTY,
            Value: rawVideoProfiles.join('|')
        });
    }
    if (!widenedConditions.some(condition => (
        condition.IsRequired === true
        && condition.Property === VIDEO_INTERLACED_PROPERTY
        && condition.Condition === 'Equals'
        && condition.Value === 'false'
    ))) {
        widenedConditions.push({
            Condition: 'Equals',
            IsRequired: true,
            Property: VIDEO_INTERLACED_PROPERTY,
            Value: 'false'
        });
    }
    const maximumFramesPerSecond = limits.maximumFramesPerSecond;
    if (maximumFramesPerSecond !== null && !widenedConditions.some(condition => (
        numericConditionCapsAt(
            condition,
            VIDEO_FRAMERATE_PROPERTY,
            maximumFramesPerSecond
        )
    ))) {
        widenedConditions.push({
            Condition: LESS_THAN_EQUAL_CONDITION,
            IsRequired: true,
            Property: VIDEO_FRAMERATE_PROPERTY,
            Value: String(maximumFramesPerSecond)
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
    if (!limits.dimensionsValidatedAtRuntime && !widenedConditions.some(condition => (
        numericConditionCapsAt(
            condition,
            VIDEO_WIDTH_PROPERTY,
            limits.maximumCodedWidth
        )
    ))) {
        widenedConditions.push({
            Condition: LESS_THAN_EQUAL_CONDITION,
            IsRequired: true,
            Property: VIDEO_WIDTH_PROPERTY,
            Value: String(limits.maximumCodedWidth)
        });
    }
    if (!limits.dimensionsValidatedAtRuntime && !widenedConditions.some(condition => (
        numericConditionCapsAt(
            condition,
            VIDEO_HEIGHT_PROPERTY,
            limits.maximumCodedHeight
        )
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
    profiles: CodecProfile[]
};

type RawHDRCodecRoutePlan = {
    profiles: CodecProfile[]
    widened: boolean
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
    let dimensionsValidatedAtRuntime = false;
    let maximumCodedHeight = Number.MAX_SAFE_INTEGER;
    let maximumCodedWidth = Number.MAX_SAFE_INTEGER;
    let maximumFramesPerSecond: number | null = null;
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
        if (capability.reason !== 'bundled-software-decoder') {
            dimensionsValidatedAtRuntime = true;
            continue;
        }

        maximumFramesPerSecond = maximumFramesPerSecond === null ?
            capability.maximumFramesPerSecond :
            Math.min(maximumFramesPerSecond, capability.maximumFramesPerSecond);
        const bundledTier = getBundledRawHEVCTier(capabilities, capability);
        if (!bundledTier) {
            return null;
        }
        maximumLevel = maximumLevel === null ?
            bundledTier.maximumLevel :
            Math.min(maximumLevel, bundledTier.maximumLevel);
    }

    return {
        dimensionsValidatedAtRuntime,
        maximumCodedHeight,
        maximumCodedWidth,
        maximumFramesPerSecond: dimensionsValidatedAtRuntime ?
            null :
            maximumFramesPerSecond,
        maximumLevel: dimensionsValidatedAtRuntime ? null : maximumLevel
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
        dimensionsValidatedAtRuntime: true,
        maximumCodedHeight: capability.maximumCodedHeight,
        maximumCodedWidth: capability.maximumCodedWidth,
        maximumFramesPerSecond: null,
        maximumLevel: null
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
        dimensionsValidatedAtRuntime: true,
        maximumCodedHeight: capability.maximumCodedHeight,
        maximumCodedWidth: capability.maximumCodedWidth,
        maximumFramesPerSecond: null,
        maximumLevel: null
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
        dimensionsValidatedAtRuntime: first.dimensionsValidatedAtRuntime
            || second.dimensionsValidatedAtRuntime,
        maximumCodedHeight: Math.max(
            first.maximumCodedHeight,
            second.maximumCodedHeight
        ),
        maximumCodedWidth: Math.max(
            first.maximumCodedWidth,
            second.maximumCodedWidth
        ),
        maximumFramesPerSecond: expandOptionalMaximum(
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

    const profiles: CodecProfile[] = [];
    const nonRawHDRCodecs = codecs.filter(codec => !rawHDRCodecs.includes(codec));
    if (nonRawHDRCodecs.length > 0) {
        profiles.push({
            ...codecProfile,
            Codec: nonRawHDRCodecs.join(',')
        });
    }

    const containerScope = getCustomContainerScope(codecProfile.Container);
    let widened = false;
    for (const rawHDRCodec of rawHDRCodecs) {
        const routePlan = createRawHDRCodecRoutePlan(
            codecProfile,
            rawHDRCodec as CustomVideoCodec,
            containerScope,
            supportedNativeVideoCodecs,
            capabilities,
            rawHDRVideoRangeTypes,
            capabilityLimits
        );
        profiles.push(...routePlan.profiles);
        widened ||= routePlan.widened;
    }
    return widened ? { profiles } : null;
}

function haveProfileConditionsChanged(
    conditions: readonly ProfileCondition[],
    widenedConditions: readonly ProfileCondition[]
): boolean {
    return widenedConditions.length !== conditions.length
        || conditions.some((condition, conditionIndex) => {
            const widenedCondition = widenedConditions[conditionIndex];
            return !widenedCondition
                || condition.Condition !== widenedCondition.Condition
                || condition.IsRequired !== widenedCondition.IsRequired
                || condition.Property !== widenedCondition.Property
                || condition.Value !== widenedCondition.Value;
        });
}

function createRawHDRCodecRoutePlan(
    codecProfile: CodecProfile,
    codec: CustomVideoCodec,
    containerScope: CustomContainerScope,
    supportedNativeVideoCodecs: ReadonlySet<CustomVideoCodec>,
    capabilities: CustomDecodeCapabilities,
    rawHDRVideoRangeTypes: readonly string[],
    capabilityLimits: RawHDRCapabilityLimits | null
): RawHDRCodecRoutePlan {
    const limits = capabilityLimits ?? getRawHDRCapabilityLimits(
        [ codec ],
        capabilities
    );
    const conditions = codecProfile.Conditions ?? [];
    const widenedConditions = limits ? createRawHDRConditions(
        conditions,
        supportedNativeVideoCodecs.has(codec),
        limits,
        [ codec ],
        rawHDRVideoRangeTypes
    ) : null;
    const routeContainerSet = new Set(getCustomContainersForVideoCodec(codec));
    const customContainers = containerScope.customContainers.filter(container => (
        routeContainerSet.has(container)
    ));
    if (
        !widenedConditions
        || customContainers.length === 0
        || !haveProfileConditionsChanged(conditions, widenedConditions)
    ) {
        return {
            profiles: [ {
                ...codecProfile,
                Codec: codec
            } ],
            widened: false
        };
    }

    const profiles: CodecProfile[] = [];
    if (containerScope.nonCustomContainerValue) {
        profiles.push({
            ...codecProfile,
            Codec: codec,
            Container: containerScope.nonCustomContainerValue
        });
    }
    const preservedCustomContainers = containerScope.customContainers.filter(container => (
        !routeContainerSet.has(container)
    ));
    if (preservedCustomContainers.length > 0) {
        profiles.push({
            ...codecProfile,
            Codec: codec,
            Container: preservedCustomContainers.join(',')
        });
    }
    profiles.push({
        ...codecProfile,
        Codec: codec,
        Conditions: widenedConditions,
        Container: customContainers.join(',')
    });
    return { profiles, widened: true };
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

        widenedProfiles.push(...plan.profiles);
        widenedProfileCount += 1;
    }

    profile.CodecProfiles = widenedProfiles;
    return widenedProfileCount;
}

function getCustomContainersForVideoCodec(codec: CustomVideoCodec): string[] {
    const containers: string[] = [];
    const containerSet = new Set<string>();
    for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
        if (!rule.videoCodecs.includes(codec)) {
            continue;
        }
        for (const container of rule.profileContainers) {
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
    if (route.maximumWidth !== null && route.maximumHeight !== null) {
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
    }
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

    if (codec === 'mpeg2video' || codec === 'vc1') {
        const capability = codec === 'vc1' ?
            capabilities.bundledVC1 :
            capabilities.bundledLegacyVideo;
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
            profiles: NATIVE_VIDEO_PROFILES[codec],
            rangeTypes: [ 'SDR' ]
        };
    }

    let bundledMain: BundledHEVCExactTierCapability | null = null;
    if (codec === 'hevc' && !hasSupportedNativeSDRVideoCodec(codec, capabilities)) {
        const mainTier = capabilities.bundledHEVC?.tiers['main-1080p'];
        bundledMain = mainTier?.status === 'supported' ? mainTier : null;
    }
    return {
        bitDepth: CUSTOM_NATIVE_VIDEO_BIT_DEPTH,
        codec,
        maximumFrameRate: bundledMain ?
            CUSTOM_BUNDLED_HEVC_BASELINE_MAXIMUM_FRAMES_PER_SECOND :
            null,
        maximumHeight: bundledMain?.maximumCodedHeight ?? null,
        maximumLevel: bundledMain?.maximumLevel ?? null,
        maximumWidth: bundledMain?.maximumCodedWidth ?? null,
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
        maximumFrameRate: bundledTier ? rawCapability.maximumFramesPerSecond : null,
        maximumHeight: bundledTier?.maximumCodedHeight ?? null,
        maximumLevel: bundledTier?.maximumLevel ?? null,
        maximumWidth: bundledTier?.maximumCodedWidth ?? null,
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
        maximumFrameRate: null,
        maximumHeight: null,
        maximumLevel: null,
        maximumWidth: null,
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
        maximumFrameRate: null,
        maximumHeight: null,
        maximumLevel: null,
        maximumWidth: null,
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
                ...options.rawHEVCHDRVideoRangeTypes,
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
        for (const rangeType of authorizedRoutes.rawHEVCHDRVideoRangeTypes) {
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
    const hasHEVCSpecificRawRanges = authorizedRoutes.rawHEVCHDRVideoRangeTypes.some(
        (rangeType: string): boolean => (
            !authorizedRoutes.rawHDRVideoRangeTypes.includes(rangeType)
        )
    );
    const dedicatedRouteRequired = nativeDolbyVisionLimits !== null
        || nativeHDRLimits !== null
        || authorizedRoutes.allowRawDolbyVision
        || hasHEVCSpecificRawRanges;
    const rawRouteAuthorized = authorizedRoutes.rawHEVCHDRVideoRangeTypes.length > 0
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

type AudioSampleRateConstraint = Readonly<{
    kind: 'bounded'
}> | Readonly<{
    kind: 'exact'
    sampleRates: readonly number[]
}>;

function createAudioSampleRateConditions(
    constraint: AudioSampleRateConstraint
): ProfileCondition[] {
    switch (constraint.kind) {
        case 'bounded':
            // Jellyfin reuses Equals/LTE conditions as transcode output targets.
            // Paired complement profiles also reject valid in-range routes on
            // Jellyfin 12. Keep negotiation target-neutral and let runtime
            // eligibility enforce the qualified resampler envelope.
            return [ {
                Condition: NOT_EQUALS_CONDITION,
                IsRequired: true,
                Property: AUDIO_SAMPLE_RATE_PROPERTY,
                Value: '0'
            } ];
        case 'exact':
            return [ {
                Condition: constraint.sampleRates.length === 1 ? 'Equals' : EQUALS_ANY_CONDITION,
                IsRequired: true,
                Property: AUDIO_SAMPLE_RATE_PROPERTY,
                Value: constraint.sampleRates.join('|')
            } ];
    }
}

function createMeasuredAudioRouteProfile(
    codecs: readonly CustomAudioCodec[],
    channelCounts: readonly number[],
    sampleRateConstraint: AudioSampleRateConstraint
): CodecProfile {
    const conditions: ProfileCondition[] = [ {
        Condition: channelCounts.length === 1 ? 'Equals' : EQUALS_ANY_CONDITION,
        IsRequired: true,
        Property: AUDIO_CHANNELS_PROPERTY,
        Value: channelCounts.join('|')
    } ];
    conditions.push(...createAudioSampleRateConditions(sampleRateConstraint));
    return {
        Codec: codecs.join(','),
        Conditions: conditions,
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
        Container: CUSTOM_MATROSKA_PROFILE_CONTAINER,
        Type: 'VideoAudio'
    };
}

type DTSProfileRouteGroup = {
    channelCount: number
    profileTokens: DTSDirectPlayProfileToken[]
};

function createMeasuredDTSRouteProfiles(): CodecProfile[] {
    const measuredProfiles: CodecProfile[] = [];
    const routeGroupsByChannelCount = new Map<number, DTSProfileRouteGroup>();
    for (const route of DTS_SUPPORTED_INPUT_ROUTES) {
        for (const profileToken of route.profileTokens) {
            if (!isDTSDirectPlayProfileToken(profileToken)) {
                continue;
            }
            let routeGroup = routeGroupsByChannelCount.get(route.channelCount);
            if (!routeGroup) {
                routeGroup = {
                    channelCount: route.channelCount,
                    profileTokens: []
                };
                routeGroupsByChannelCount.set(route.channelCount, routeGroup);
            }
            if (!routeGroup.profileTokens.includes(profileToken)) {
                routeGroup.profileTokens.push(profileToken);
            }
        }
    }

    measuredProfiles.push(createMeasuredExactAudioRouteProfile('dts', [
        createRequiredAudioRouteCondition(
            AUDIO_CHANNELS_PROPERTY,
            [ ...routeGroupsByChannelCount.keys() ]
        ),
        ...createAudioSampleRateConditions({ kind: 'bounded' }),
        createRequiredAudioRouteCondition(AUDIO_PROFILE_PROPERTY, SUPPORTED_DTS_AUDIO_PROFILES)
    ]));
    measuredProfiles.push(createMeasuredExactAudioRouteProfile(
        'dts',
        [
            {
                Condition: LESS_THAN_EQUAL_CONDITION,
                IsRequired: true,
                Property: AUDIO_CHANNELS_PROPERTY,
                Value: '6'
            },
            createRequiredAudioRouteCondition(
                AUDIO_PROFILE_PROPERTY,
                [ 'DTS-HD MA', 'DTS-HD MA + DTS:X' ]
            )
        ],
        [ {
            Condition: GREATER_THAN_EQUAL_CONDITION,
            IsRequired: true,
            Property: AUDIO_SAMPLE_RATE_PROPERTY,
            Value: String(DTS_HIGH_SAMPLE_RATE_MINIMUM)
        } ]
    ));

    for (const routeGroup of routeGroupsByChannelCount.values()) {
        const profileValues = DTS_DIRECT_PLAY_PROFILE_TOKENS
            .filter(profileToken => routeGroup.profileTokens.includes(profileToken))
            .map(profileToken => DTS_PROFILE_VALUE_BY_TOKEN[profileToken]);
        measuredProfiles.push(createMeasuredExactAudioRouteProfile(
            'dts',
            [ createRequiredAudioRouteCondition(AUDIO_PROFILE_PROPERTY, profileValues) ],
            [
                createRequiredAudioRouteCondition(
                    AUDIO_CHANNELS_PROPERTY,
                    [ routeGroup.channelCount ]
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
    const channelCounts: number[] = [];
    for (const route of TRUEHD_CAPABILITY_FIXTURE_ROUTES) {
        if (route.codec === codec && !channelCounts.includes(route.channelCount)) {
            channelCounts.push(route.channelCount);
        }
    }
    channelCounts.sort((left, right) => left - right);
    if (channelCounts.length === 0) {
        return measuredProfiles;
    }

    measuredProfiles.push(createMeasuredExactAudioRouteProfile(codec, [
        createRequiredAudioRouteCondition(AUDIO_CHANNELS_PROPERTY, channelCounts),
        ...createAudioSampleRateConditions({ kind: 'bounded' })
    ]));
    return measuredProfiles;
}

const CUSTOM_AUDIO_ROUTE_PROPERTIES = new Set<string>([
    AUDIO_BIT_DEPTH_PROPERTY,
    AUDIO_CHANNELS_PROPERTY,
    AUDIO_SAMPLE_RATE_PROPERTY,
    'IsSecondaryAudio'
]);

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

function shouldSplitAudioRouteProfile(
    codecProfile: CodecProfile,
    measuredProfileKeys: ReadonlySet<string>
): boolean {
    const conditions = codecProfile.Conditions ?? [];
    return codecProfile.Type === 'VideoAudio'
        && !codecProfile.SubContainer
        && !codecProfile.Container?.trim().startsWith('-')
        && !measuredProfileKeys.has(getCodecProfileKey(codecProfile))
        && conditions.some(condition => (
            CUSTOM_AUDIO_ROUTE_PROPERTIES.has(condition.Property ?? '')
        ));
}

function createSplitAudioRouteProfiles(
    codecProfile: CodecProfile,
    supportedAudioCodecs: readonly CustomAudioCodec[],
    supportedAudioCodecSet: ReadonlySet<string>,
    measuredProfileKeys: ReadonlySet<string>,
    declaredDirectPlayAudioCodecs: readonly string[]
): CodecProfile[] | null {
    if (!shouldSplitAudioRouteProfile(codecProfile, measuredProfileKeys)) {
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
 * bit-depth, channel, sample-rate, and secondary-track limits replaced by
 * measured decoded-PCM routes.
 */
function splitOriginalAudioRouteProfiles(
    profile: DeviceProfile,
    supportedAudioCodecs: readonly CustomAudioCodec[],
    measuredProfileKeys: ReadonlySet<string>
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
            measuredProfileKeys,
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
): void {
    if (!nativeMediaAudioCapabilities) {
        return;
    }

    for (const codec of [ 'ac3', 'eac3' ] as const) {
        if (capabilities.audio[codec].status === 'supported') {
            // The decoded-PCM profile below covers the native route at 48 kHz
            // without letting its exact rate veto the software fallback
            continue;
        }
        const channelCounts = getSupportedNativeMediaChannelCounts(
            nativeMediaAudioCapabilities,
            codec
        );
        if (channelCounts.length === 0) {
            continue;
        }
        measuredProfiles.push(createMeasuredAudioRouteProfile(
            [ codec ],
            channelCounts,
            {
                kind: 'exact',
                sampleRates: [ NATIVE_MEDIA_AUDIO_SAMPLE_RATE ]
            }
        ));
    }
}

function getDecodedAudioCodecs(
    capabilities: CustomDecodeCapabilities
): CustomAudioCodec[] {
    const decodedAudioCodecs: CustomAudioCodec[] = [];
    for (const codec of CUSTOM_AUDIO_CODECS) {
        if (capabilities.audio[codec].status !== 'supported') {
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
                    === CUSTOM_SURROUND_INPUT_CHANNEL_COUNT;
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
    const decodedAudioCodecs = getDecodedAudioCodecs(capabilities);
    const measuredProfiles: CodecProfile[] = [];
    appendMeasuredNativeAudioRouteProfiles(
        measuredProfiles,
        capabilities,
        nativeMediaAudioCapabilities
    );
    const decodedAudioRouteGroups = new Map<string, {
        channelCounts: readonly number[]
        codecs: CustomAudioCodec[]
    }>();
    for (const codec of decodedAudioCodecs) {
        if (codec === 'dts' || codec === 'mlp' || codec === 'truehd') {
            continue;
        }
        const channelCounts = hasQualifiedDecodedSurroundRoute(codec, capabilities) ?
            getSupportedCustomAudioInputChannelCounts(codec) :
            [ CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT ];
        const routeKey = channelCounts.join(',');
        let routeGroup = decodedAudioRouteGroups.get(routeKey);
        if (!routeGroup) {
            routeGroup = {
                channelCounts,
                codecs: []
            };
            decodedAudioRouteGroups.set(routeKey, routeGroup);
        }
        routeGroup.codecs.push(codec);
    }
    for (const routeGroup of decodedAudioRouteGroups.values()) {
        measuredProfiles.push(createMeasuredAudioRouteProfile(
            routeGroup.codecs,
            routeGroup.channelCounts,
            { kind: 'bounded' }
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

    const measuredProfileKeys = new Set(measuredProfiles.map(getCodecProfileKey));
    splitOriginalAudioRouteProfiles(
        profile,
        supportedAudioCodecs,
        measuredProfileKeys
    );
    const codecProfiles = profile.CodecProfiles ?? [];
    profile.CodecProfiles = codecProfiles;
    const existingProfileKeys = new Set(codecProfiles.map(getCodecProfileKey));
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
    const overlappingRawDolbyVisionRangeTypes =
        authorizeNativeDolbyVisionHDR10BaseRanges(
            capabilities,
            options,
            nativeHDRVideoRangeTypes
        );
    const rawHDRVideoRangeTypes = options.allowRawHDR === true ?
        getAuthorizedRawHDRVideoRangeTypes(options.authorizedRawHDRRouteKeys ?? []) :
        [];
    const rawHEVCHDRVideoRangeTypes = getAuthorizedRawHEVCHDRVideoRangeTypes(
        rawHDRVideoRangeTypes
    );
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
    let rawDolbyVisionVideoRangeTypes = nativeDolbyVisionVideoRangeTypes.includes('DOVI') ?
        availableRawDolbyVisionVideoRangeTypes.filter(rangeType => rangeType !== 'DOVI') :
        availableRawDolbyVisionVideoRangeTypes;
    const allowRawDolbyVision = rawDolbyVisionVideoRangeTypes.length > 0;
    if (overlappingRawDolbyVisionRangeTypes.size > 0) {
        // Runtime prefers full Dolby Vision inside the measured raw envelope
        rawDolbyVisionVideoRangeTypes = rawDolbyVisionVideoRangeTypes.filter(rangeType => (
            !overlappingRawDolbyVisionRangeTypes.has(rangeType)
        ));
    }
    const dolbyVisionVideoRangeTypes = [
        ...new Set([
            ...rawDolbyVisionVideoRangeTypes,
            ...nativeDolbyVisionVideoRangeTypes
        ])
    ];
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

    const subtitleProfileChanged = applyOptionalCustomSubtitleProfiles(
        clonedProfile,
        options.subtitleCapabilities
    );

    scopeOriginalVideoRuntimeConditions(clonedProfile, supportedVideoCodecs);
    scopeOriginalContainerRuntimeConditions(clonedProfile);

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
                rawHEVCHDRVideoRangeTypes,
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
            rawHEVCHDRVideoRangeTypes,
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
            addedProfiles.length > 0 || subtitleProfileChanged ?
                'augmented' :
                'already-advertised',
            supportedVideoCodecs,
            supportedAudioCodecs,
            addedProfiles,
            widenedHDRCodecProfileCount,
            subtitleProfileChanged
        )
    };
}
