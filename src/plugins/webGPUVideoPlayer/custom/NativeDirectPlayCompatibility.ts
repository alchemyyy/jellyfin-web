import type { CodecProfile } from '@jellyfin/sdk/lib/generated-client/models/codec-profile';
import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';
import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client/models/media-source-info';
import type { MediaStream } from '@jellyfin/sdk/lib/generated-client/models/media-stream';
import type { ProfileCondition } from '@jellyfin/sdk/lib/generated-client/models/profile-condition';
import type { ProfileConditionValue } from '@jellyfin/sdk/lib/generated-client/models/profile-condition-value';

const DIRECT_PLAY_METHOD = 'DIRECTPLAY';

const KNOWN_CODEC_PROFILE_TYPES = new Set([ 'Audio', 'Video', 'VideoAudio' ]);
const KNOWN_DIRECT_PLAY_PROFILE_TYPES = new Set([
    'Audio',
    'Lyric',
    'Photo',
    'Subtitle',
    'Video'
]);
const KNOWN_MEDIA_STREAM_TYPES = new Set([
    'Audio',
    'Data',
    'EmbeddedImage',
    'Lyric',
    'Subtitle',
    'Video'
]);
const KNOWN_VIDEO_RANGE_TYPES = new Set([
    'DOVI',
    'DOVIINVALID',
    'DOVIWITHEL',
    'DOVIWITHELHDR10PLUS',
    'DOVIWITHHDR10',
    'DOVIWITHHDR10PLUS',
    'DOVIWITHHLG',
    'DOVIWITHSDR',
    'HDR10',
    'HDR10PLUS',
    'HLG',
    'SDR'
]);

const VIDEO_BOOLEAN_PROPERTIES = new Set<ProfileConditionValue>([
    'IsAnamorphic',
    'IsAvc',
    'IsInterlaced'
]);
const VIDEO_NUMBER_PROPERTIES = new Set<ProfileConditionValue>([
    'Height',
    'NumAudioStreams',
    'NumStreams',
    'NumVideoStreams',
    'PacketLength',
    'RefFrames',
    'VideoBitDepth',
    'VideoBitrate',
    'VideoFramerate',
    'VideoLevel',
    'VideoRotation',
    'Width'
]);
const VIDEO_STRING_PROPERTIES = new Set<ProfileConditionValue>([
    'VideoCodecTag',
    'VideoProfile',
    'VideoTimestamp'
]);
const AUDIO_BOOLEAN_PROPERTIES = new Set<ProfileConditionValue>([
    'IsSecondaryAudio'
]);
const AUDIO_NUMBER_PROPERTIES = new Set<ProfileConditionValue>([
    'AudioBitDepth',
    'AudioBitrate',
    'AudioChannels',
    'AudioSampleRate'
]);
const AUDIO_STRING_PROPERTIES = new Set<ProfileConditionValue>([
    'AudioProfile'
]);

type CompatibilityPlaybackOptions = {
    mediaSource?: unknown
    playMethod?: unknown
    url?: unknown
};

type ParsedPlaybackSource = {
    audioStream: MediaStream | null
    audioStreams: readonly MediaStream[]
    container: string
    mediaSource: MediaSourceInfo
    streams: readonly MediaStream[]
    videoStream: MediaStream
};

type ComparableConditionValue =
    | { kind: 'boolean', value: boolean }
    | { kind: 'number', value: number }
    | { kind: 'string', value: string }
    | { kind: 'video-range', value: string };

type ConditionEvaluation = 'matched' | 'not-matched' | 'unknown';

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function normalizeIdentifier(value: string): string {
    return value.toUpperCase();
}

function getNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function getFiniteNumber(value: unknown, allowNegative = false): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    if (!allowNegative && value < 0) {
        return null;
    }
    return value;
}

function getSafeInteger(value: unknown, allowNegative = false): number | null {
    const numericValue = getFiniteNumber(value, allowNegative);
    return numericValue !== null && Number.isSafeInteger(numericValue) ? numericValue : null;
}

function splitProfileTokens(value: string): string[] {
    const tokens: string[] = [];
    for (const token of value.split(',')) {
        if (token.length > 0) {
            tokens.push(normalizeIdentifier(token));
        }
    }
    return tokens;
}

function matchesProfileList(
    profileValue: unknown,
    inputValue: string,
    supportsBlacklist: boolean
): boolean | null {
    if (profileValue == null || profileValue === '') {
        return true;
    }
    if (typeof profileValue !== 'string' || inputValue.length === 0) {
        return null;
    }

    const isBlacklist = supportsBlacklist && profileValue.startsWith('-');
    const listValue = isBlacklist ? profileValue.slice(1) : profileValue;
    const profileTokens = splitProfileTokens(listValue);
    const inputTokens = splitProfileTokens(inputValue);
    if (profileTokens.length === 0 || inputTokens.length === 0) {
        return null;
    }

    const matches = inputTokens.some(inputToken => profileTokens.includes(inputToken));
    return isBlacklist ? !matches : matches;
}

function getStreams(mediaSource: MediaSourceInfo): MediaStream[] | null {
    if (!Array.isArray(mediaSource.MediaStreams)) {
        return null;
    }

    const streams: MediaStream[] = [];
    const indexes = new Set<number>();
    for (const streamValue of mediaSource.MediaStreams) {
        if (!isRecord(streamValue)
            || typeof streamValue.Type !== 'string'
            || !KNOWN_MEDIA_STREAM_TYPES.has(streamValue.Type)
        ) {
            return null;
        }
        const streamIndex = getSafeInteger(streamValue.Index);
        if (streamIndex === null || indexes.has(streamIndex)) {
            return null;
        }
        indexes.add(streamIndex);
        streams.push(streamValue as MediaStream);
    }
    return streams;
}

function selectAudioStream(
    mediaSource: MediaSourceInfo,
    audioStreams: readonly MediaStream[]
): MediaStream | null | undefined {
    const requestedIndex = mediaSource.DefaultAudioStreamIndex;
    if (requestedIndex == null) {
        const sortedAudioStreams = [ ...audioStreams ].sort((left, right) => (
            Number(left.Index) - Number(right.Index)
        ));
        return sortedAudioStreams[0] ?? null;
    }
    if (getSafeInteger(requestedIndex) === null) {
        return undefined;
    }
    return audioStreams.find(stream => stream.Index === requestedIndex);
}

function parsePlaybackSource(options: unknown): ParsedPlaybackSource | null {
    if (!isRecord(options)) {
        return null;
    }
    const playbackOptions = options as CompatibilityPlaybackOptions;
    if (
        typeof playbackOptions.playMethod !== 'string'
        || normalizeIdentifier(playbackOptions.playMethod) !== DIRECT_PLAY_METHOD
        || getNonEmptyString(playbackOptions.url) === null
        || !isRecord(playbackOptions.mediaSource)
    ) {
        return null;
    }

    const mediaSource = playbackOptions.mediaSource as MediaSourceInfo;
    const container = getNonEmptyString(mediaSource.Container);
    const streams = getStreams(mediaSource);
    if (!container || !streams || mediaSource.SupportsDirectPlay !== true) {
        return null;
    }

    const videoStreams = streams.filter(stream => stream.Type === 'Video');
    const audioStreams = streams.filter(stream => stream.Type === 'Audio');
    if (videoStreams.length !== 1 || getNonEmptyString(videoStreams[0].Codec) === null) {
        return null;
    }
    const audioStream = selectAudioStream(mediaSource, audioStreams);
    if (audioStream === undefined
        || (audioStream !== null && getNonEmptyString(audioStream.Codec) === null)
    ) {
        return null;
    }

    return {
        audioStream,
        audioStreams,
        container,
        mediaSource,
        streams,
        videoStream: videoStreams[0]
    };
}

function getReferenceFrameRate(stream: MediaStream): number | null {
    const candidates = [
        stream.ReferenceFrameRate,
        stream.AverageFrameRate,
        stream.RealFrameRate
    ];
    for (const candidate of candidates) {
        const frameRate = getFiniteNumber(candidate);
        if (frameRate !== null && frameRate > 0) {
            return frameRate;
        }
    }
    return null;
}

function getVideoNumericValue(
    property: ProfileConditionValue,
    source: ParsedPlaybackSource
): number | null {
    const stream = source.videoStream;
    switch (property) {
        case 'Height': return getSafeInteger(stream.Height);
        case 'NumAudioStreams': return source.audioStreams.length;
        case 'NumStreams': return source.streams.length;
        case 'NumVideoStreams': return 1;
        case 'PacketLength': return getSafeInteger(stream.PacketLength);
        case 'RefFrames': return getSafeInteger(stream.RefFrames);
        case 'VideoBitDepth': return getSafeInteger(stream.BitDepth);
        case 'VideoBitrate': return getSafeInteger(stream.BitRate);
        case 'VideoFramerate': return getReferenceFrameRate(stream);
        case 'VideoLevel': return getFiniteNumber(stream.Level);
        case 'VideoRotation': return getSafeInteger(stream.Rotation, true);
        case 'Width': return getSafeInteger(stream.Width);
        default: return null;
    }
}

function getVideoBooleanValue(
    property: ProfileConditionValue,
    source: ParsedPlaybackSource
): boolean | null {
    let value: unknown;
    switch (property) {
        case 'IsAnamorphic':
            value = source.videoStream.IsAnamorphic;
            break;
        case 'IsAvc':
            value = source.videoStream.IsAVC;
            break;
        case 'IsInterlaced':
            value = source.videoStream.IsInterlaced;
            break;
        default: return null;
    }
    return typeof value === 'boolean' ? value : null;
}

function getVideoStringValue(
    property: ProfileConditionValue,
    source: ParsedPlaybackSource
): string | null {
    switch (property) {
        case 'VideoCodecTag': return getNonEmptyString(source.videoStream.CodecTag);
        case 'VideoProfile': return getNonEmptyString(source.videoStream.Profile);
        case 'VideoTimestamp': return getNonEmptyString(source.mediaSource.Timestamp);
        default: return null;
    }
}

function getIsSecondaryAudio(source: ParsedPlaybackSource): boolean | null {
    const selectedAudioStream = source.audioStream;
    if (!selectedAudioStream || typeof selectedAudioStream.IsExternal !== 'boolean') {
        return null;
    }
    if (selectedAudioStream.IsExternal) {
        return false;
    }

    const primaryAudioStream = source.audioStreams.find(stream => stream.IsExternal === false);
    if (!primaryAudioStream) {
        return null;
    }
    return primaryAudioStream.Index !== selectedAudioStream.Index;
}

function getAudioConditionValue(
    property: ProfileConditionValue,
    source: ParsedPlaybackSource
): ComparableConditionValue | null {
    const stream = source.audioStream;
    if (!stream) {
        return null;
    }
    if (AUDIO_BOOLEAN_PROPERTIES.has(property)) {
        const value = getIsSecondaryAudio(source);
        return value === null ? null : { kind: 'boolean', value };
    }
    if (AUDIO_STRING_PROPERTIES.has(property)) {
        const value = getNonEmptyString(stream.Profile);
        return value === null ? null : { kind: 'string', value };
    }
    if (!AUDIO_NUMBER_PROPERTIES.has(property)) {
        return null;
    }

    let mediaValue: unknown;
    switch (property) {
        case 'AudioBitDepth':
            mediaValue = stream.BitDepth;
            break;
        case 'AudioBitrate':
            mediaValue = stream.BitRate;
            break;
        case 'AudioChannels':
            mediaValue = stream.Channels;
            break;
        case 'AudioSampleRate':
            mediaValue = stream.SampleRate;
            break;
        default: return null;
    }
    const value = getSafeInteger(mediaValue);
    return value === null ? null : { kind: 'number', value };
}

function getVideoConditionValue(
    property: ProfileConditionValue,
    source: ParsedPlaybackSource
): ComparableConditionValue | null {
    if (property === 'VideoRangeType') {
        const value = getNonEmptyString(source.videoStream.VideoRangeType);
        if (!value || !KNOWN_VIDEO_RANGE_TYPES.has(normalizeIdentifier(value))) {
            return null;
        }
        return { kind: 'video-range', value };
    }
    if (VIDEO_BOOLEAN_PROPERTIES.has(property)) {
        const value = getVideoBooleanValue(property, source);
        return value === null ? null : { kind: 'boolean', value };
    }
    if (VIDEO_NUMBER_PROPERTIES.has(property)) {
        const value = getVideoNumericValue(property, source);
        return value === null ? null : { kind: 'number', value };
    }
    if (VIDEO_STRING_PROPERTIES.has(property)) {
        const value = getVideoStringValue(property, source);
        return value === null ? null : { kind: 'string', value };
    }
    return null;
}

function compareNumberList(expectedValue: string, currentValue: number): ConditionEvaluation {
    const expectedNumbers = expectedValue.split('|').map(value => Number(value));
    if (expectedNumbers.some(value => !Number.isFinite(value))) {
        return 'unknown';
    }
    return expectedNumbers.includes(currentValue) ? 'matched' : 'not-matched';
}

function compareNumber(condition: ProfileCondition, currentValue: number): ConditionEvaluation {
    const expectedValue = getNonEmptyString(condition.Value);
    if (!expectedValue || typeof condition.Condition !== 'string') {
        return 'unknown';
    }
    if (condition.Condition === 'EqualsAny') {
        return compareNumberList(expectedValue, currentValue);
    }

    const expectedNumber = Number(expectedValue);
    if (!Number.isFinite(expectedNumber)) {
        return 'unknown';
    }
    switch (condition.Condition) {
        case 'Equals': return currentValue === expectedNumber ? 'matched' : 'not-matched';
        case 'GreaterThanEqual': return currentValue >= expectedNumber ? 'matched' : 'not-matched';
        case 'LessThanEqual': return currentValue <= expectedNumber ? 'matched' : 'not-matched';
        case 'NotEquals': return currentValue !== expectedNumber ? 'matched' : 'not-matched';
        default: return 'unknown';
    }
}

function compareBoolean(condition: ProfileCondition, currentValue: boolean): ConditionEvaluation {
    const expectedValue = getNonEmptyString(condition.Value)?.toLowerCase();
    if (expectedValue !== 'true' && expectedValue !== 'false') {
        return 'unknown';
    }
    const expectedBoolean = expectedValue === 'true';
    switch (condition.Condition) {
        case 'Equals': return currentValue === expectedBoolean ? 'matched' : 'not-matched';
        case 'NotEquals': return currentValue !== expectedBoolean ? 'matched' : 'not-matched';
        default: return 'unknown';
    }
}

function compareString(condition: ProfileCondition, currentValue: string): ConditionEvaluation {
    const expectedValue = getNonEmptyString(condition.Value);
    if (!expectedValue) {
        return 'unknown';
    }
    const normalizedCurrentValue = normalizeIdentifier(currentValue);
    switch (condition.Condition) {
        case 'Equals':
            return normalizedCurrentValue === normalizeIdentifier(expectedValue) ?
                'matched' : 'not-matched';
        case 'EqualsAny':
            return expectedValue.split('|').some(value => (
                normalizeIdentifier(value) === normalizedCurrentValue
            )) ? 'matched' : 'not-matched';
        case 'NotEquals':
            return normalizedCurrentValue !== normalizeIdentifier(expectedValue) ?
                'matched' : 'not-matched';
        default:
            return 'unknown';
    }
}

function compareVideoRange(condition: ProfileCondition, currentValue: string): ConditionEvaluation {
    const expectedValue = getNonEmptyString(condition.Value);
    if (!expectedValue) {
        return 'unknown';
    }
    const expectedRanges = condition.Condition === 'EqualsAny' ?
        expectedValue.split('|') :
        [ expectedValue ];
    if (expectedRanges.some(value => !KNOWN_VIDEO_RANGE_TYPES.has(normalizeIdentifier(value)))) {
        return 'unknown';
    }

    const normalizedCurrentValue = normalizeIdentifier(currentValue);
    if (condition.Condition === 'NotEquals') {
        return normalizedCurrentValue !== normalizeIdentifier(expectedValue) ?
            'matched' : 'not-matched';
    }
    if (condition.Condition !== 'Equals' && condition.Condition !== 'EqualsAny') {
        return 'unknown';
    }

    return expectedRanges.some(expectedRange => (
        normalizedCurrentValue === normalizeIdentifier(expectedRange)
    )) ? 'matched' : 'not-matched';
}

function evaluateCondition(
    condition: ProfileCondition,
    profileType: 'Video' | 'VideoAudio',
    source: ParsedPlaybackSource
): ConditionEvaluation {
    if (!isRecord(condition) || typeof condition.Property !== 'string') {
        return 'unknown';
    }
    const property = condition.Property as ProfileConditionValue;
    const value = profileType === 'Video' ?
        getVideoConditionValue(property, source) :
        getAudioConditionValue(property, source);
    if (!value) {
        return 'unknown';
    }

    switch (value.kind) {
        case 'boolean': return compareBoolean(condition, value.value);
        case 'number': return compareNumber(condition, value.value);
        case 'string': return compareString(condition, value.value);
        case 'video-range': return compareVideoRange(condition, value.value);
    }
}

function evaluateConditions(
    conditions: unknown,
    profileType: 'Video' | 'VideoAudio',
    source: ParsedPlaybackSource
): ConditionEvaluation {
    if (conditions == null) {
        return 'matched';
    }
    if (!Array.isArray(conditions)) {
        return 'unknown';
    }

    for (const condition of conditions) {
        const evaluation = evaluateCondition(condition as ProfileCondition, profileType, source);
        if (evaluation !== 'matched') {
            return evaluation;
        }
    }
    return 'matched';
}

function codecProfileTargets(
    profile: CodecProfile,
    codec: string,
    container: string
): boolean | null {
    const containerMatches = matchesProfileList(profile.Container, container, true);
    const codecMatches = matchesProfileList(profile.Codec, codec, false);
    return containerMatches === null || codecMatches === null ?
        null :
        containerMatches && codecMatches;
}

function matchingCodecProfileIsCompatible(
    profile: CodecProfile,
    profileType: 'Video' | 'VideoAudio',
    source: ParsedPlaybackSource
): boolean {
    const applyEvaluation = evaluateConditions(profile.ApplyConditions, profileType, source);
    if (applyEvaluation === 'unknown') {
        return false;
    }
    if (applyEvaluation === 'not-matched') {
        return true;
    }
    return evaluateConditions(profile.Conditions, profileType, source) === 'matched';
}

function codecProfileIsCompatible(
    profile: CodecProfile,
    source: ParsedPlaybackSource
): boolean {
    let profileType: 'Video' | 'VideoAudio';
    let stream: MediaStream | null;
    switch (profile.Type) {
        case 'Audio':
            return true;
        case 'Video':
            profileType = 'Video';
            stream = source.videoStream;
            break;
        case 'VideoAudio':
            profileType = 'VideoAudio';
            stream = source.audioStream;
            break;
        default:
            return false;
    }
    if (!stream) {
        return true;
    }

    const codec = getNonEmptyString(stream.Codec);
    if (!codec) {
        return false;
    }
    const targets = codecProfileTargets(profile, codec, source.container);
    if (targets === null) {
        return false;
    }
    return !targets || matchingCodecProfileIsCompatible(profile, profileType, source);
}

function codecProfilesAreCompatible(
    profiles: DeviceProfile['CodecProfiles'],
    source: ParsedPlaybackSource
): boolean {
    if (profiles == null) {
        return true;
    }
    if (!Array.isArray(profiles)) {
        return false;
    }

    for (const profile of profiles) {
        if (!isRecord(profile)
            || typeof profile.Type !== 'string'
            || !KNOWN_CODEC_PROFILE_TYPES.has(profile.Type)
        ) {
            return false;
        }
        if (!codecProfileIsCompatible(profile as CodecProfile, source)) {
            return false;
        }
    }
    return true;
}

function containerProfilesAreCompatible(
    profiles: DeviceProfile['ContainerProfiles'],
    source: ParsedPlaybackSource
): boolean {
    if (profiles == null) {
        return true;
    }
    if (!Array.isArray(profiles)) {
        return false;
    }

    for (const profile of profiles) {
        if (!isRecord(profile)
            || typeof profile.Type !== 'string'
            || !KNOWN_DIRECT_PLAY_PROFILE_TYPES.has(profile.Type)
        ) {
            return false;
        }
        if (profile.Type !== 'Video') {
            continue;
        }
        const targets = matchesProfileList(profile.Container, source.container, true);
        if (targets === null) {
            return false;
        }
        if (targets && evaluateConditions(profile.Conditions, 'Video', source) !== 'matched') {
            return false;
        }
    }
    return true;
}

function hasMatchingDirectPlayProfile(
    profiles: DeviceProfile['DirectPlayProfiles'],
    source: ParsedPlaybackSource
): boolean {
    if (!Array.isArray(profiles)) {
        return false;
    }

    const videoCodec = source.videoStream.Codec as string;
    const audioCodec = source.audioStream?.Codec ?? null;
    for (const profile of profiles) {
        if (!isRecord(profile)
            || typeof profile.Type !== 'string'
            || !KNOWN_DIRECT_PLAY_PROFILE_TYPES.has(profile.Type)
        ) {
            return false;
        }
        if (profile.Type !== 'Video') {
            continue;
        }
        const containerMatches = matchesProfileList(profile.Container, source.container, true);
        const videoCodecMatches = matchesProfileList(profile.VideoCodec, videoCodec, true);
        const audioCodecMatches = audioCodec === null ?
            true :
            matchesProfileList(profile.AudioCodec, audioCodec, true);
        if (containerMatches === null
            || videoCodecMatches === null
            || audioCodecMatches === null
        ) {
            return false;
        }
        if (containerMatches && videoCodecMatches && audioCodecMatches) {
            return true;
        }
    }
    return false;
}

/** Proves that the selected DirectPlay source satisfies the original HTML profile. */
export function isSameSessionNativePlaybackCompatible(
    options: unknown,
    deviceProfile: DeviceProfile
): boolean {
    if (!isRecord(deviceProfile)) {
        return false;
    }
    const profile = deviceProfile as DeviceProfile;
    const source = parsePlaybackSource(options);
    if (!source
        || !containerProfilesAreCompatible(profile.ContainerProfiles, source)
        || !codecProfilesAreCompatible(profile.CodecProfiles, source)
    ) {
        return false;
    }
    return hasMatchingDirectPlayProfile(profile.DirectPlayProfiles, source);
}
