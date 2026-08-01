import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import type { DirectPlayProfile } from '@jellyfin/sdk/lib/generated-client/models/direct-play-profile';

import {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_VIDEO_CODECS,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomVideoCodec
} from './CustomDecodeCapabilities';

export type CustomDeviceProfileOptions = {
    isRetry?: boolean
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

const ISO_BASE_MEDIA_VIDEO_RULE: VideoContainerRule = {
    audioCodecs: CUSTOM_AUDIO_CODECS,
    container: 'mp4,m4v,mov',
    videoCodecs: CUSTOM_VIDEO_CODECS
};
const MATROSKA_VIDEO_RULE: VideoContainerRule = {
    audioCodecs: CUSTOM_AUDIO_CODECS,
    container: 'mkv',
    videoCodecs: CUSTOM_VIDEO_CODECS
};
const WEBM_VIDEO_RULE: VideoContainerRule = {
    audioCodecs: [ 'opus', 'vorbis' ],
    container: 'webm',
    videoCodecs: [ 'vp8', 'vp9', 'av1' ]
};
const MPEG_TS_VIDEO_RULE: VideoContainerRule = {
    audioCodecs: [ 'aac', 'mp3' ],
    container: 'ts,m2ts,mts',
    videoCodecs: [ 'h264', 'hevc' ]
};
const VIDEO_CONTAINER_RULES: readonly VideoContainerRule[] = [
    ISO_BASE_MEDIA_VIDEO_RULE,
    MATROSKA_VIDEO_RULE,
    WEBM_VIDEO_RULE,
    MPEG_TS_VIDEO_RULE
];

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
            ApplyConditions: codecProfile.ApplyConditions?.map(condition => ({ ...condition })),
            Conditions: codecProfile.Conditions?.map(condition => ({ ...condition }))
        }));
    }
    if (profile.SubtitleProfiles) {
        clonedProfile.SubtitleProfiles = profile.SubtitleProfiles.map(subtitleProfile => ({
            ...subtitleProfile
        }));
    }
    return clonedProfile;
}

function getSupportedVideoCodecs(capabilities: CustomDecodeCapabilities): CustomVideoCodec[] {
    const supportedCodecs: CustomVideoCodec[] = [];
    for (const codec of CUSTOM_VIDEO_CODECS) {
        if (capabilities.video[codec].status === 'supported') {
            supportedCodecs.push(codec);
        }
    }
    return supportedCodecs;
}

function getSupportedAudioCodecs(capabilities: CustomDecodeCapabilities): CustomAudioCodec[] {
    const supportedCodecs: CustomAudioCodec[] = [];
    for (const codec of CUSTOM_AUDIO_CODECS) {
        if (capabilities.audio[codec].status === 'supported') {
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
    addedProfiles: readonly DirectPlayProfile[]
): CustomDeviceProfileTelemetry {
    return {
        addedAudioProfileCount: addedProfiles.filter(profile => profile.Type === 'Audio').length,
        addedProfileCount: addedProfiles.length,
        addedVideoProfileCount: addedProfiles.filter(profile => profile.Type === 'Video').length,
        reason,
        supportedAudioCodecs: [ ...supportedAudioCodecs ],
        supportedVideoCodecs: [ ...supportedVideoCodecs ]
    };
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
    const supportedVideoCodecs = getSupportedVideoCodecs(capabilities);
    const supportedAudioCodecs = getSupportedAudioCodecs(capabilities);
    if (options.isRetry === true) {
        return {
            profile: clonedProfile,
            telemetry: createTelemetry(
                'retry-not-widened',
                supportedVideoCodecs,
                supportedAudioCodecs,
                []
            )
        };
    }

    if (supportedVideoCodecs.length === 0 && supportedAudioCodecs.length === 0) {
        return {
            profile: clonedProfile,
            telemetry: createTelemetry(
                'no-supported-codecs',
                supportedVideoCodecs,
                supportedAudioCodecs,
                []
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
                []
            )
        };
    }

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
            addedProfiles
        )
    };
}
