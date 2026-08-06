import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';

import { PlayerEvent } from 'apps/legacy/features/playback/constants/playerEvent';
import { PluginType } from 'constants/pluginType';
import { PLAYBACK_SUPERSEDED } from 'constants/playbackResult';
import {
    getWebGPUCustomDecodeEnabled,
    getWebGPUHDRToneMappingEnabled,
    isWebGPUCustomDecodeEnabled
} from 'scripts/settings/webSettings';
import Events from 'utils/events';
import { MediaError } from 'types/mediaError';

import { HTMLPlayerDelegate } from './HTMLPlayerDelegate';
import {
    jellyfinTicksToMicroseconds,
    microsecondsToJellyfinTicks,
    microsecondsToMilliseconds,
    millisecondsToMicroseconds,
    type Microseconds
} from './MediaTime';
import {
    getDolbyVisionPresentationDescriptor,
    getDolbyVisionPresentationSelection,
    getDolbyVisionProfile7HDR10BaseColorMetadata,
    getDolbyVisionProfile8HDR10BaseColorMetadata,
    getPresentationInputColorMetadata,
    isDolbyVisionProfile7HDR10BaseLayerDescriptor,
    isDolbyVisionProfile8HDR10BaseLayerDescriptor,
    isKnownSDRPresentationInput,
    type DolbyVisionPresentationDescriptor
} from './PresentationInput';
import {
    createDefaultRenderSettings,
    type HDRToSDRRenderSettings,
    type RenderSettings
} from './RenderSettings';
import {
    createConfiguredHDRRenderSettings,
    loadWebGPUUserSettings,
    type WebGPUUserSettings
} from './WebGPUUserSettings';
import {
    assertValidAudioDownmixSettings,
    type AudioDownmixSettings
} from './custom/CustomAudioDownmix';
import {
    createPQColorMetadata,
    type InputColorMetadata
} from './color/ColorMetadata';
import {
    prewarmBrowserAudioContext,
    type BrowserAudioContextPrewarmLease
} from './custom/BrowserAudioContextPrewarm';
import { CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE } from './custom/CustomAudioOutputPolicy';
import type { CustomAudioDownmixAlgorithm } from './custom/CustomAudioDownmixAlgorithm';
import { isSupportedCustomAudioSampleRate } from './custom/CustomAudioSampleRate';
import {
    getCustomPlaybackEligibility,
    hasPotentialCustomPlaybackVideoRoute,
    type CustomPlaybackEligibility,
    type CustomPlaybackEligibilityOptions,
    type CustomPlaybackIneligibilityReason,
    type EligibleCustomPlayback
} from './custom/CustomPlaybackEligibility';
import {
    type CustomDecodeCapabilities,
    probeCustomDecodeCapabilities
} from './custom/CustomDecodeCapabilities';
import { getAudioNormalizationLinearGain } from './custom/AudioNormalization';
import type CustomPlaybackController from './custom/CustomPlaybackController';
import type {
    CustomAudioOutputFactory,
    CustomPlaybackControllerEvent,
    CustomPlaybackFallbackRequest,
    CustomPlaybackStartResult,
    CustomPlaybackTelemetry
} from './custom/CustomPlaybackControllerTypes';
import type { CustomDecodeSessionTelemetry } from './custom/CustomDecodeSession';
import type {
    CustomDecodeAudioOutputMode,
    CustomDecodeNativeHDRTransfer,
    CustomDecodeRawVideoFrameFormat,
    CustomDecodeVideoDecoderBackend,
    CustomDecodeVideoOutputMode
} from './custom/DecodeWorkerProtocol';
import {
    probeCachedNativeMediaAudioCapabilities,
    type NativeMediaAudioCapabilities
} from './custom/NativeMediaAudioCapabilities';
import { selectCustomAudioOutputChannelCount } from './custom/NativeMultichannelAudioOutput';
import {
    getStaticHDRToneMappingPeakNits,
    type StaticHDRMetadata
} from './custom/StaticHDRMetadata';
import {
    augmentDeviceProfileForCustomDecode,
    createBitrateIndependentDeviceProfile,
    type CustomDeviceProfileOptions,
    type CustomDeviceProfileTelemetry,
    type CustomSubtitleCapabilities
} from './custom/CustomDeviceProfile';
import { isSameSessionNativePlaybackCompatible } from './custom/NativeDirectPlayCompatibility';
import {
    getCustomPlaybackRuntimeAvailability,
    type CustomPlaybackRuntimeAvailability
} from './custom/CustomPlaybackRuntime';
import WebGPUPresenter, {
    type DecodedPresentationFrame,
    type PresentationFallbackReason,
    type PresentationSurface,
    type PresentationTelemetry
} from './WebGPUPresenter';
import type { ColorValidationCapabilityDecision } from './validation/ColorValidationHarness';
import type { DolbyVisionAuthorizationTelemetry } from './validation/DolbyVisionPresentationAuthorization';
import type {
    ExternalDolbyVisionAuthorizationTelemetry
} from './validation/ExternalDolbyVisionPresentationAuthorization';
import {
    getExternalHDRAuthorizationRouteKey,
    type ExternalHDRAuthorizationTelemetry,
    type ExternalHDRAuthorizationRouteKey
} from './validation/ExternalHDRPresentationAuthorization';
import type { MediabunnyReferenceFrameProviderOptions } from './validation/MediabunnyReferenceFrameProvider';
import type {
    ExternalTextureReferenceFrameRequest,
    WebGPUExternalTextureValidationRequest,
    WebGPUExternalTextureValidationRunner
} from './validation/WebGPUExternalTextureValidationRunner';
import type {
    RawHDRAuthorizationRouteKey,
    RawHDRAuthorizationTelemetry
} from './validation/RawHDRPresentationAuthorization';

type OptionalItemCompatibility = {
    canPlayItem?: (item: unknown, playOptions?: unknown) => boolean
};

type RuntimeHTMLPlayerProperties = {
    forcedFullscreen?: boolean
};

type PlaybackRateOption = {
    id: number
    name: string
};

type AspectRatioOption = {
    id: string
    name: string
};

type BackendPlayer = HTMLPlayerDelegate['player'];

type DeviceProfileRequestOptions = {
    isRetry?: unknown
};

type StreamingBitrateRequest = {
    fallbackBitrate?: number | null
    purpose?: 'playback-selection' | 'transcode-output'
};

type HTMLPlayerSelectionContract = {
    canPlayMediaType: (mediaType: string | null | undefined) => boolean
    supportsPlayMethod: (playMethod: string, item: unknown) => boolean
    getDeviceProfile: (item: unknown, options?: unknown) => Promise<unknown>
};

type HTMLCustomPlaybackContract = {
    notifyCustomPlaybackEnded: () => boolean
    notifyCustomPlaybackPaused: () => boolean
    notifyCustomPlaybackPlaying: (emitUnpause?: boolean) => boolean
    notifyCustomPlaybackTimeUpdate: (timeMilliseconds: number) => boolean
    notifyCustomPlaybackWaiting: () => boolean
    prepareCustomPlayback: (options: unknown) => Promise<
        PresentationSurface | typeof PLAYBACK_SUPERSEDED | null
    >
};

type PlaybackOptionsRecord = Record<string, unknown>;

type DeviceProfileItem = {
    MediaSources?: unknown
    MediaStreams?: unknown
};

type DeviceProfileMediaSource = {
    Id?: unknown
    MediaStreams?: unknown
};

type PlayerSettingsMenuItem = {
    id: string
    name: string
    onSelect: () => unknown
    secondaryText?: string
};

type HDRDeviceProfileProbeScope =
    | 'dolby-vision'
    | 'dolby-vision-profile7'
    | 'dolby-vision-profile8-hdr10-base'
    | 'none'
    | 'static-hdr'
    | 'unknown';

type CustomPresentationAuthorizations = {
    authorizedExternalHDRRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
    authorizedRawHDRRouteKeys: readonly RawHDRAuthorizationRouteKey[]
};

type NativeDeviceProfileProof = {
    generation: number | null
    itemKey: string
    profile: DeviceProfile
};

export type CustomPlaybackEligibilityTelemetry =
    | {
        eligible: false
        reason: CustomPlaybackIneligibilityReason
    }
    | {
        audioOutputMode: CustomDecodeAudioOutputMode | null
        eligible: true
        hdr: boolean
        nativeHDRTransfer: CustomDecodeNativeHDRTransfer
        neutralizeHDRColorMetadata: boolean
        videoDecoderBackend: CustomDecodeVideoDecoderBackend
        videoOutputMode: CustomDecodeVideoOutputMode
    };

export type CustomPlaybackSetupStage =
    | 'capabilities'
    | 'complete'
    | 'controller'
    | 'idle'
    | 'modules'
    | 'presentation'
    | 'surface';

export type CustomPlaybackSetupTelemetry = {
    stage: CustomPlaybackSetupStage
    status: 'complete' | 'idle' | 'in-progress' | 'timeout'
};

function getItemKey(item: unknown): string | null {
    if (!item || typeof item !== 'object') {
        return null;
    }
    const itemRecord = item as PlaybackOptionsRecord;
    const itemId = typeof itemRecord.Id === 'string' ? itemRecord.Id.trim() : '';
    if (!itemId) {
        return null;
    }
    const serverId = typeof itemRecord.ServerId === 'string' ? itemRecord.ServerId.trim() : '';
    return `${serverId}\u0000${itemId}`;
}

function getPlaybackItemKey(options: unknown): string | null {
    if (!options || typeof options !== 'object') {
        return null;
    }
    return getItemKey((options as PlaybackOptionsRecord).item);
}

function hasExactSeparateProfile7Source(item: unknown): boolean {
    if (!item || typeof item !== 'object') {
        return false;
    }
    const itemRecord = item as DeviceProfileItem;
    let mediaStreams = itemRecord.MediaStreams;
    if (Array.isArray(itemRecord.MediaSources)) {
        if (itemRecord.MediaSources.length !== 1) {
            return false;
        }
        const mediaSource = itemRecord.MediaSources[0];
        if (!mediaSource || typeof mediaSource !== 'object') {
            return false;
        }
        mediaStreams = (mediaSource as DeviceProfileMediaSource).MediaStreams;
    }
    if (!Array.isArray(mediaStreams)) {
        return false;
    }
    let videoStreamCount = 0;
    for (const stream of mediaStreams) {
        if (
            stream
            && typeof stream === 'object'
            && typeof (stream as PlaybackOptionsRecord).Type === 'string'
            && ((stream as PlaybackOptionsRecord).Type as string).trim().toLowerCase()
                === 'video'
        ) {
            videoStreamCount += 1;
        }
    }
    if (videoStreamCount !== 2) {
        return false;
    }
    const selection = getDolbyVisionPresentationSelection({
        mediaSource: { MediaStreams: mediaStreams }
    });
    return selection?.descriptor.profile === 7
        && selection.descriptor.enhancementLayerPresent;
}

function hasExactProfile7HDR10BaseSource(item: unknown): boolean {
    const presentationOptions = getDeviceProfilePresentationOptions(item);
    return presentationOptions !== null
        && getDolbyVisionProfile7HDR10BaseColorMetadata(presentationOptions) !== null;
}

function hasExactProfile8HDR10BaseSource(item: unknown): boolean {
    const presentationOptions = getDeviceProfilePresentationOptions(item);
    return presentationOptions !== null
        && getDolbyVisionProfile8HDR10BaseColorMetadata(presentationOptions) !== null;
}

function getDeviceProfilePresentationOptions(
    item: unknown,
    mediaSourceId?: string | null
): unknown | null {
    if (!item || typeof item !== 'object') {
        return null;
    }
    const itemRecord = item as DeviceProfileItem;
    let mediaStreams = itemRecord.MediaStreams;
    if (Array.isArray(itemRecord.MediaSources)) {
        const mediaSources: unknown[] = itemRecord.MediaSources;
        let mediaSource: unknown = null;
        if (mediaSources.length === 1) {
            mediaSource = mediaSources[0];
        } else if (typeof mediaSourceId === 'string' && mediaSourceId.length > 0) {
            mediaSource = mediaSources.find(candidate => (
                candidate !== null
                && typeof candidate === 'object'
                && (candidate as DeviceProfileMediaSource).Id === mediaSourceId
            ));
        }
        if (!mediaSource || typeof mediaSource !== 'object') {
            return null;
        }
        mediaStreams = (mediaSource as DeviceProfileMediaSource).MediaStreams;
    }
    if (!Array.isArray(mediaStreams)) {
        return null;
    }
    return { mediaSource: { MediaStreams: mediaStreams } };
}

function getHDRDeviceProfileProbeScope(item: unknown): HDRDeviceProfileProbeScope {
    const presentationOptions = getDeviceProfilePresentationOptions(item);
    if (!presentationOptions) {
        return 'unknown';
    }
    const dolbyVisionDescriptor = getDolbyVisionPresentationDescriptor(presentationOptions);
    if (dolbyVisionDescriptor) {
        if (getDolbyVisionProfile7HDR10BaseColorMetadata(presentationOptions) !== null) {
            return 'dolby-vision-profile7';
        }
        if (getDolbyVisionProfile8HDR10BaseColorMetadata(presentationOptions) !== null) {
            return 'dolby-vision-profile8-hdr10-base';
        }
        return 'dolby-vision';
    }
    const colorMetadata = getPresentationInputColorMetadata(presentationOptions);
    if (colorMetadata?.transfer === 'pq' || colorMetadata?.transfer === 'hlg') {
        return 'static-hdr';
    }
    return isKnownSDRPresentationInput(presentationOptions) ? 'none' : 'unknown';
}

const DOLBY_VISION_HDR10_BASE_COLOR_METADATA = Object.freeze(createPQColorMetadata());

function hasAuthorizedDolbyVisionHDR10BaseRoute(
    routeKeys: readonly ExternalHDRAuthorizationRouteKey[]
): boolean {
    const routeKey = getExternalHDRAuthorizationRouteKey(
        DOLBY_VISION_HDR10_BASE_COLOR_METADATA
    );
    return routeKey !== null && routeKeys.includes(routeKey);
}

type AudioPrewarmMediaStream = {
    Index?: unknown
    SampleRate?: unknown
    Type?: unknown
};

type AudioPrewarmMediaSource = {
    DefaultAudioStreamIndex?: unknown
    MediaStreams?: unknown
};

type CustomPlaybackAudioPrewarm = {
    backendGeneration: number
    lease: BrowserAudioContextPrewarmLease
};

type CustomPlaybackAttemptResult =
    | { status: 'native-required' }
    | { result: unknown, status: 'handled' }
    | { status: 'superseded' };

type SourceRenegotiationRequest = {
    accept: () => void
    errorType: MediaError
    reason: CustomPlaybackFallbackRequest['reason']
};

type PendingPausedPresentationRefresh = {
    backendGeneration: number
    controller: CustomPlaybackController
    mediaTimeMicroseconds: Microseconds
    presentationGeneration: number
};

export type WebGPUPlayerColorValidationRequest = Omit<
    WebGPUExternalTextureValidationRequest,
    'device'
>;

export type WebGPUPlayerColorValidationMediaRequest = Omit<
    WebGPUPlayerColorValidationRequest,
    'getFrame'
> & MediabunnyReferenceFrameProviderOptions;

const CUSTOM_VOLUME_STEP = 2;
export const CUSTOM_PLAYBACK_SETUP_TIMEOUT_MICROSECONDS = millisecondsToMicroseconds(25_000);
const JELLYFIN_VOLUME_CURVE_EXPONENT = 3;
const MAX_JELLYFIN_VOLUME = 100;
const MIN_JELLYFIN_VOLUME = 0;
const CUSTOM_PLAYBACK_SETUP_TIMEOUT = Symbol('custom-playback-setup-timeout');

function waitForCustomPlaybackSetup<T>(
    promise: Promise<T>
): Promise<T | typeof CUSTOM_PLAYBACK_SETUP_TIMEOUT> {
    return new Promise<T | typeof CUSTOM_PLAYBACK_SETUP_TIMEOUT>((resolve, reject) => {
        const timeout = globalThis.setTimeout((): void => {
            resolve(CUSTOM_PLAYBACK_SETUP_TIMEOUT);
        }, microsecondsToMilliseconds(CUSTOM_PLAYBACK_SETUP_TIMEOUT_MICROSECONDS));
        promise.then((value: T): void => {
            globalThis.clearTimeout(timeout);
            resolve(value);
        }, (error: unknown): void => {
            globalThis.clearTimeout(timeout);
            reject(error);
        });
    });
}

function normalizeStreamType(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalizedValue = value.trim().toUpperCase();
    return normalizedValue || null;
}

function supportsCustomSubtitleCanvas(): boolean {
    if (typeof document === 'undefined') {
        return false;
    }

    try {
        return document.createElement('canvas').getContext('2d') !== null;
    } catch {
        return false;
    }
}

/** Qualifies the locked subtitle renderers without inheriting the HTML PGS experiment flag. */
function getCustomSubtitleCapabilities(
    profile: DeviceProfile,
    runtimeAvailability: CustomPlaybackRuntimeAvailability
): CustomSubtitleCapabilities | null {
    if (!profile.SubtitleProfiles) {
        return null;
    }

    const externalFormats = new Set<string>();
    for (const subtitleProfile of profile.SubtitleProfiles) {
        if (normalizeStreamType(subtitleProfile.Method) !== 'EXTERNAL') {
            continue;
        }
        const format: string | null = normalizeStreamType(subtitleProfile.Format);
        if (format) {
            externalFormats.add(format);
        }
    }
    const specializedRendererRuntimeAvailable = runtimeAvailability.environment.worker
        && typeof WebAssembly === 'object'
        && typeof WebAssembly.instantiate === 'function'
        && supportsCustomSubtitleCanvas();
    return {
        externalASS: specializedRendererRuntimeAvailable,
        externalPGS: specializedRendererRuntimeAvailable,
        externalText: externalFormats.has('VTT')
    };
}

function getAudioPrewarmStreams(
    mediaStreamsValue: unknown
): Array<{ sampleRate: unknown, streamIndex: number }> | null {
    if (!Array.isArray(mediaStreamsValue)) {
        return null;
    }

    const audioStreams: Array<{ sampleRate: unknown, streamIndex: number }> = [];
    for (let streamPosition = 0; streamPosition < mediaStreamsValue.length; streamPosition += 1) {
        const streamValue = mediaStreamsValue[streamPosition];
        if (!streamValue || typeof streamValue !== 'object') {
            continue;
        }
        const stream = streamValue as AudioPrewarmMediaStream;
        if (normalizeStreamType(stream.Type) !== 'AUDIO') {
            continue;
        }

        const streamIndexValue = stream.Index ?? streamPosition;
        if (!Number.isSafeInteger(streamIndexValue) || Number(streamIndexValue) < 0) {
            return null;
        }
        audioStreams.push({
            sampleRate: stream.SampleRate,
            streamIndex: Number(streamIndexValue)
        });
    }
    return audioStreams.length === 0 ? null : audioStreams;
}

function getPlaybackStartTimeMicroseconds(options: unknown): Microseconds {
    if (!options || typeof options !== 'object') {
        return millisecondsToMicroseconds(0);
    }

    const startPositionTicks = (options as PlaybackOptionsRecord).playerStartPositionTicks;
    if (startPositionTicks == null) {
        return millisecondsToMicroseconds(0);
    }
    if (!Number.isSafeInteger(startPositionTicks) || Number(startPositionTicks) < 0) {
        return millisecondsToMicroseconds(0);
    }
    return jellyfinTicksToMicroseconds(Number(startPositionTicks));
}

function selectAudioPrewarmStream(
    mediaSource: AudioPrewarmMediaSource,
    audioStreams: Array<{ sampleRate: unknown, streamIndex: number }>
): { sampleRate: unknown, streamIndex: number } | null {
    const requestedIndex = mediaSource.DefaultAudioStreamIndex;
    if (requestedIndex == null) {
        return audioStreams[0];
    }
    if (!Number.isSafeInteger(requestedIndex) || Number(requestedIndex) < 0) {
        return null;
    }
    return audioStreams.find(audioStream => (
        audioStream.streamIndex === requestedIndex
    )) ?? null;
}

function getSelectedAudioSampleRate(options: unknown): number | null {
    if (!options || typeof options !== 'object') {
        return null;
    }
    const mediaSourceValue = (options as { mediaSource?: unknown }).mediaSource;
    if (!mediaSourceValue || typeof mediaSourceValue !== 'object') {
        return null;
    }

    const mediaSource = mediaSourceValue as AudioPrewarmMediaSource;
    const audioStreams = getAudioPrewarmStreams(mediaSource.MediaStreams);
    if (!audioStreams) {
        return null;
    }
    const selectedAudioStream = selectAudioPrewarmStream(mediaSource, audioStreams);
    if (!selectedAudioStream) {
        return null;
    }

    return isSupportedCustomAudioSampleRate(selectedAudioStream.sampleRate) ?
        selectedAudioStream.sampleRate :
        null;
}

function selectDecodedAudioOutputChannelCount(
    eligibility: EligibleCustomPlayback,
    audioContext: AudioContext | null,
    forceStereoDownmix: boolean
): 2 | 6 | 8 | undefined {
    if (eligibility.audioOutputMode !== 'decoded-pcm') {
        return undefined;
    }
    if (forceStereoDownmix) {
        return 2;
    }
    return selectCustomAudioOutputChannelCount(
        audioContext,
        eligibility.audioSourceChannelCount
    );
}

function selectAudioDownmixAlgorithm(
    audioTrackIndex: number | null,
    selectedAlgorithm: CustomAudioDownmixAlgorithm
): CustomAudioDownmixAlgorithm | undefined {
    return audioTrackIndex === null ? undefined : selectedAlgorithm;
}

function getDecodedAudioDownmixSettings(
    eligibility: EligibleCustomPlayback,
    settings: WebGPUUserSettings
): AudioDownmixSettings | undefined {
    return eligibility.audioOutputMode === 'decoded-pcm' ?
        settings.audio.downmix :
        undefined;
}

/**
 * Jellyfin-facing player that owns the HTML player as its playback backend.
 * WebGPU presentation is optional and must never replace backend playback.
 */
export default class WebGPUPlayer {
    name = 'WebGPU Player';
    type = PluginType.MediaPlayer;
    id = 'webgpuplayer';
    // The wrapper preserves the HTML player's SyncPlay timing, rate, and events.
    syncPlayWrapAs = 'htmlvideoplayer';
    priority = 0;

    private readonly htmlDelegate: HTMLPlayerDelegate;
    private readonly presenter: WebGPUPresenter;
    private readonly pendingAudioPrewarmClosePromises = new Set<Promise<void>>();
    private readonly pendingBackendStopPromises = new Set<Promise<unknown>>();
    private readonly pendingStopCounts = new Map<number, number>();

    private backendOperationTail: Promise<void> | null = null;
    private backendStopCallBarrier: Promise<void> | null = null;
    private backendStopCallDepth = 0;
    private releaseBackendStopCall: (() => void) | null = null;
    private backendPlayPendingGeneration: number | null = null;
    private backendSessionActive = false;
    private customPlaybackController: CustomPlaybackController | null = null;
    private customPlaybackAudioSettings: WebGPUUserSettings['audio'] | null = null;
    private customPlaybackBackendGeneration: number | null = null;
    private customPlaybackAudioPrewarm: CustomPlaybackAudioPrewarm | null = null;
    private customPlaybackFallbackPromise: Promise<unknown> | null = null;
    private customPlaybackFrameCallback: number | null = null;
    private customPlaybackFrameGeneration: number | null = null;
    private pendingPausedPresentationRefresh: PendingPausedPresentationRefresh | null = null;
    private customPlaybackHasPlayed = false;
    private customPlaybackAudioSelectionRevision = 0;
    private customPlaybackSeekRevision = 0;
    private customPlaybackSetupRevision = 0;
    private customPlaybackSetupTelemetry: CustomPlaybackSetupTelemetry = {
        stage: 'idle',
        status: 'idle'
    };
    private customPlaybackStartingGeneration: number | null = null;
    private customPlaybackStopPromise: Promise<void> | null = null;
    private customPlaybackTerminalErrorGeneration: number | null = null;
    private customPlaybackEmitUnpause = false;
    private customPlaybackVolume = MAX_JELLYFIN_VOLUME;
    private customPlaybackMuted = false;
    private customPlaybackNormalizationGain = 1;
    private customPlaybackRecoveryTimeMicroseconds: Microseconds | null = null;
    private htmlPlaybackNormalizationGain: number | null = null;
    private currentPlaybackOptions: unknown = null;
    private currentNativeDeviceProfileProof: NativeDeviceProfileProof | null = null;
    private currentPlaybackRequiresSourceRenegotiation = false;
    private currentDolbyVisionPresentationDescriptor: DolbyVisionPresentationDescriptor | null =
        null;
    private currentPresentationColorMetadata: InputColorMetadata | null = null;
    private activeDetectedInputPeakNits: number | null = null;
    private colorValidationDecision: ColorValidationCapabilityDecision | null = null;
    private colorValidationDevice: GPUDevice | null = null;
    private colorValidationRunner: WebGPUExternalTextureValidationRunner | null = null;
    private lastCustomDecodeCapabilities: CustomDecodeCapabilities | null = null;
    private lastCustomDecodeTelemetry: CustomDecodeSessionTelemetry | null = null;
    private lastCustomPlaybackEligibility: CustomPlaybackEligibility | null = null;
    private lastCustomPlaybackTelemetry: CustomPlaybackTelemetry | null = null;
    private lastCustomDeviceProfileTelemetry: CustomDeviceProfileTelemetry | null = null;
    private lastCustomPlaybackRuntimeAvailability: CustomPlaybackRuntimeAvailability | null = null;
    private lastNativeMediaAudioCapabilities: NativeMediaAudioCapabilities | null = null;
    private pendingNativeDeviceProfileProof: NativeDeviceProfileProof | null = null;
    private customProfileAugmentationAvailable = false;
    private webGPUPresentationEnabled = false;
    private presentationGeneration = 0;
    private backendSessionGeneration = 0;
    private ownedBackendSessionGeneration: number | null = null;
    private lastKnownTimeMicroseconds: Microseconds = millisecondsToMicroseconds(0);

    constructor() {
        this.htmlDelegate = new HTMLPlayerDelegate(
            this,
            this.handleBackendStopped,
            this.handleBackendError
        );
        this.presenter = new WebGPUPresenter(
            this.handlePresentationFallback,
            this.handleDecodedPresentationRefresh
        );
    }

    get isFetching(): boolean {
        const customPlaybackState = this.customPlaybackController?.playbackState;
        if (this.customPlaybackStartingGeneration !== null
            || customPlaybackState === 'starting'
            || customPlaybackState === 'seeking') {
            return true;
        }
        return this.htmlDelegate.player.isFetching;
    }

    get forcedFullscreen(): boolean {
        const backend = this.htmlDelegate.player as BackendPlayer & RuntimeHTMLPlayerProperties;
        return Boolean(backend.forcedFullscreen);
    }

    currentSrc(): string | null | undefined {
        return this.htmlDelegate.player.currentSrc();
    }

    /** Keeps bitrate out of selection while retaining an explicit transcode target. */
    getMaxStreamingBitrate(request?: StreamingBitrateRequest): number | null {
        if (request?.purpose === 'transcode-output') {
            return request.fallbackBitrate ?? null;
        }
        return null;
    }

    /** Synchronously reports media-type compatibility for player selection. */
    canPlayMediaType = (mediaType: string | null | undefined): boolean => {
        const backend = this.htmlDelegate.player as unknown as HTMLPlayerSelectionContract;
        return backend.canPlayMediaType(mediaType);
    };

    /** Synchronously preserves the optional HTML backend item check. */
    canPlayItem(item: unknown, playOptions?: unknown): boolean {
        const backend = this.htmlDelegate.player as BackendPlayer & OptionalItemCompatibility;
        const backendCanPlay = backend.canPlayItem?.(item, playOptions) ?? true;
        if (!backendCanPlay || !isWebGPUCustomDecodeEnabled()) {
            return backendCanPlay;
        }
        return hasPotentialCustomPlaybackVideoRoute(item, playOptions);
    }

    supportsPlayMethod(playMethod: string, item: unknown): boolean {
        const backend = this.htmlDelegate.player as unknown as HTMLPlayerSelectionContract;
        return backend.supportsPlayMethod(playMethod, item);
    }

    /** Contributes one plugin-owned settings surface to Jellyfin's generic menu seam. */
    getSettingsMenuItems(): readonly PlayerSettingsMenuItem[] {
        return [ {
            id: 'webgpu-playback-settings',
            name: 'WebGPU Settings',
            onSelect: (): Promise<void> => import(
                /* webpackChunkName: "webgpu-playback-settings" */
                './ui/WebGPUPlaybackSettingsDialog'
            ).then(module => module.showWebGPUPlaybackSettingsPanel(this))
        } ];
    }

    /** Blocks HLS video copy for Dolby Vision sources while preserving direct play. */
    supportsVideoStreamCopy(
        item: unknown,
        mediaSourceId?: string | null,
        mediaStreams?: unknown
    ): boolean {
        const presentationOptions = Array.isArray(mediaStreams) ?
            { mediaSource: { MediaStreams: mediaStreams } } :
            getDeviceProfilePresentationOptions(item, mediaSourceId);
        return presentationOptions === null
            || getDolbyVisionPresentationDescriptor(presentationOptions) === null;
    }

    async getDeviceProfile(item: unknown, options?: unknown): Promise<unknown> {
        const backend = this.htmlDelegate.player as unknown as HTMLPlayerSelectionContract;
        const isRetry = this.isDeviceProfileRetry(options);
        const profile = await backend.getDeviceProfile(item, options);
        if (!isRetry && profile && typeof profile === 'object') {
            this.rememberNativeDeviceProfile(item, profile as DeviceProfile);
        }
        const playbackProfile = !isRetry && profile && typeof profile === 'object' ?
            createBitrateIndependentDeviceProfile(profile as DeviceProfile) :
            profile;
        if (!await getWebGPUCustomDecodeEnabled()) {
            this.lastCustomDecodeCapabilities = null;
            this.lastCustomDeviceProfileTelemetry = null;
            this.lastCustomPlaybackRuntimeAvailability = null;
            this.lastNativeMediaAudioCapabilities = null;
            return playbackProfile;
        }

        const runtimeAvailability = getCustomPlaybackRuntimeAvailability();
        this.lastCustomPlaybackRuntimeAvailability = runtimeAvailability;
        if (!runtimeAvailability.available) {
            this.lastCustomDecodeCapabilities = null;
            this.lastCustomDeviceProfileTelemetry = null;
            this.lastNativeMediaAudioCapabilities = null;
            return playbackProfile;
        }
        const subtitleCapabilities = !isRetry && profile && typeof profile === 'object' ?
            getCustomSubtitleCapabilities(
                profile as DeviceProfile,
                runtimeAvailability
            ) :
            null;

        const [ capabilities, nativeMediaAudioCapabilities ] = await Promise.all([
            probeCustomDecodeCapabilities(),
            isRetry ? Promise.resolve(null) : probeCachedNativeMediaAudioCapabilities()
        ]);
        const HDRDeviceProfileOptions = await this.getHDRDeviceProfileOptions(item, isRetry);
        const profileResult = augmentDeviceProfileForCustomDecode(
            playbackProfile as DeviceProfile,
            capabilities,
            {
                ...HDRDeviceProfileOptions,
                isRetry,
                nativeMediaAudioCapabilities,
                ...(subtitleCapabilities ? { subtitleCapabilities } : {})
            }
        );
        this.lastCustomDecodeCapabilities = capabilities;
        this.lastNativeMediaAudioCapabilities = nativeMediaAudioCapabilities;
        this.lastCustomDeviceProfileTelemetry = profileResult.telemetry;
        if (!isRetry && (
            profileResult.telemetry.addedProfileCount > 0
            || profileResult.telemetry.widenedHDRCodecProfileCount > 0
            || profileResult.telemetry.subtitleProfileChanged
        )) {
            this.customProfileAugmentationAvailable = true;
        }
        return profileResult.profile;
    }

    supports(feature: string): boolean {
        switch (feature) {
            case 'AirPlay':
            case 'PictureInPicture':
            case 'PlaybackRate':
            case 'SetBrightness':
                return this.hasAuthoritativeHTMLPlaybackSurface()
                    && this.htmlDelegate.player.supports(feature);
            default:
                return this.htmlDelegate.player.supports(feature);
        }
    }

    /** Cancels only an unresolved backend startup, leaving established playback intact. */
    cancelPendingPlay(): void {
        this.htmlDelegate.cancelPendingPlay();
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(
            this.backendSessionGeneration
        );
        if (audioPrewarmClose) {
            void audioPrewarmClose;
        }
        const pendingGeneration = this.backendPlayPendingGeneration;
        if (pendingGeneration == null || !this.isRequestedSessionCurrent(pendingGeneration)) {
            return;
        }

        void this.detachCustomPlaybackController();
        this.customPlaybackAudioSelectionRevision += 1;
        this.customPlaybackSeekRevision += 1;
        this.customPlaybackSetupRevision += 1;
        this.backendSessionActive = false;
        this.webGPUPresentationEnabled = false;
        this.currentPlaybackOptions = null;
        this.currentNativeDeviceProfileProof = null;
        this.currentPlaybackRequiresSourceRenegotiation = false;
        this.customPlaybackRecoveryTimeMicroseconds = null;
        this.resetHTMLPlaybackNormalization();
        this.customPlaybackNormalizationGain = 1;
        this.currentDolbyVisionPresentationDescriptor = null;
        this.currentPresentationColorMetadata = null;
        this.htmlDelegate.endSession(pendingGeneration);
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
    }

    play(options: unknown): Promise<unknown> {
        this.resetHTMLPlaybackNormalization();
        this.customPlaybackNormalizationGain = 1;
        this.cancelPendingPlay();
        this.customPlaybackAudioSelectionRevision += 1;
        this.customPlaybackSeekRevision += 1;
        this.customPlaybackSetupRevision += 1;
        this.customPlaybackRecoveryTimeMicroseconds = null;
        const customPlaybackStop = this.detachCustomPlaybackController();
        const previousSessionGeneration = this.backendSessionGeneration;
        const generation = this.advancePresentationGeneration();
        if (
            previousSessionGeneration > 0
            && !this.pendingStopCounts.has(previousSessionGeneration)
        ) {
            this.htmlDelegate.endSession(previousSessionGeneration);
        }

        this.backendSessionActive = true;
        this.backendSessionGeneration = generation;
        this.currentNativeDeviceProfileProof = this.consumeNativeDeviceProfileProof(
            options,
            generation
        );
        this.backendPlayPendingGeneration = generation;
        this.customPlaybackFallbackPromise = null;
        this.customPlaybackHasPlayed = false;
        this.customPlaybackStartingGeneration = null;
        this.customPlaybackTerminalErrorGeneration = null;
        this.lastCustomDecodeTelemetry = null;
        this.lastCustomPlaybackEligibility = null;
        this.lastCustomPlaybackTelemetry = null;
        this.currentPlaybackOptions = options;
        this.activeDetectedInputPeakNits = null;
        this.lastKnownTimeMicroseconds = getPlaybackStartTimeMicroseconds(options);
        this.currentPlaybackRequiresSourceRenegotiation =
            this.customProfileAugmentationAvailable
            && this.isNonTranscodedSourceOptions(options)
            && !this.isCurrentSourceNativeCompatible(options);
        this.startCustomPlaybackAudioPrewarm(options, generation);
        this.currentDolbyVisionPresentationDescriptor =
            getDolbyVisionPresentationDescriptor(options);
        this.currentPresentationColorMetadata = getPresentationInputColorMetadata(options);
        const customHDRPresentation = isWebGPUCustomDecodeEnabled()
            && (
                this.currentDolbyVisionPresentationDescriptor !== null
                || (this.currentPresentationColorMetadata !== null
                    && this.currentPresentationColorMetadata.transfer !== 'sdr')
            );
        this.webGPUPresentationEnabled = isKnownSDRPresentationInput(options)
            || customHDRPresentation;
        if (this.webGPUPresentationEnabled) {
            this.presenter.startSession(generation);
        } else {
            this.presenter.endSession(generation);
        }

        const backendStopCallBarrier = this.backendStopCallBarrier;
        const startPlayback = (): Promise<unknown> => {
            if (customPlaybackStop) {
                return customPlaybackStop.then(() => (
                    this.startBackendPlayback(options, generation)
                ));
            }
            return this.startBackendPlayback(options, generation);
        };
        const playPromise = this.enqueueBackendOperation(() => {
            if (backendStopCallBarrier) {
                return backendStopCallBarrier
                    .then(() => this.waitForPendingBackendStops())
                    .then(startPlayback);
            }
            if (this.pendingBackendStopPromises.size > 0) {
                return this.waitForPendingBackendStops().then(startPlayback);
            }

            return startPlayback();
        });
        return playPromise.finally(() => {
            if (this.backendPlayPendingGeneration === generation) {
                this.backendPlayPendingGeneration = null;
            }
        });
    }

    stop(destroyPlayer: boolean): Promise<unknown> {
        const sessionGeneration = this.backendSessionGeneration;
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(sessionGeneration);
        this.htmlDelegate.cancelPendingPlay();
        this.customPlaybackAudioSelectionRevision += 1;
        this.customPlaybackSeekRevision += 1;
        this.customPlaybackSetupRevision += 1;
        const customPlaybackStop = this.detachCustomPlaybackController();
        this.backendSessionActive = false;
        this.webGPUPresentationEnabled = false;
        this.currentPlaybackOptions = null;
        this.currentNativeDeviceProfileProof = null;
        this.currentPlaybackRequiresSourceRenegotiation = false;
        this.customPlaybackRecoveryTimeMicroseconds = null;
        this.resetHTMLPlaybackNormalization();
        this.customPlaybackNormalizationGain = 1;
        this.currentDolbyVisionPresentationDescriptor = null;
        this.currentPresentationColorMetadata = null;
        this.incrementPendingStopCount(sessionGeneration);
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);

        const ownedGeneration = this.ownedBackendSessionGeneration ?? sessionGeneration;
        const stopPromise = this.callBackendStop(ownedGeneration, destroyPlayer);
        const completedStopPromise = stopPromise.catch(error => {
            this.htmlDelegate.destroy(ownedGeneration);
            throw error;
        }).finally(async () => {
            await customPlaybackStop;
            await audioPrewarmClose;
            await this.waitForPendingAudioPrewarmCloses();
            if (destroyPlayer && this.ownedBackendSessionGeneration === ownedGeneration) {
                this.ownedBackendSessionGeneration = null;
            }
            this.decrementPendingStopCount(sessionGeneration);
        });
        this.trackBackendStop(completedStopPromise);
        return completedStopPromise;
    }

    destroy(): void {
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(
            this.backendSessionGeneration
        );
        if (audioPrewarmClose) {
            void audioPrewarmClose;
        }
        this.htmlDelegate.cancelPendingPlay();
        this.customPlaybackAudioSelectionRevision += 1;
        this.customPlaybackSetupRevision += 1;
        void this.detachCustomPlaybackController();
        this.backendSessionActive = false;
        this.webGPUPresentationEnabled = false;
        this.currentPlaybackOptions = null;
        this.currentNativeDeviceProfileProof = null;
        this.currentPlaybackRequiresSourceRenegotiation = false;
        this.customPlaybackRecoveryTimeMicroseconds = null;
        this.resetHTMLPlaybackNormalization();
        this.customPlaybackNormalizationGain = 1;
        this.currentDolbyVisionPresentationDescriptor = null;
        this.currentPresentationColorMetadata = null;
        const sessionGeneration = this.backendSessionGeneration;
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
        this.presenter.destroy();
        this.htmlDelegate.endSession(sessionGeneration);

        const ownedGeneration = this.ownedBackendSessionGeneration ?? sessionGeneration;
        try {
            this.htmlDelegate.destroy(ownedGeneration);
        } finally {
            if (this.ownedBackendSessionGeneration === ownedGeneration) {
                this.ownedBackendSessionGeneration = null;
            }
        }
    }

    private async startBackendPlayback(options: unknown, generation: number): Promise<unknown> {
        if (!this.isRequestedSessionCurrent(generation)) {
            this.beginCustomPlaybackAudioPrewarmClose(generation);
            return PLAYBACK_SUPERSEDED;
        }

        try {
            if (
                this.ownedBackendSessionGeneration != null
                && this.ownedBackendSessionGeneration !== generation
            ) {
                await this.stopOwnedBackendForReplacement(generation);
            }
            if (!this.isRequestedSessionCurrent(generation)) {
                return PLAYBACK_SUPERSEDED;
            }

            this.htmlDelegate.beginSession(generation);
            this.ownedBackendSessionGeneration = generation;
            const customDecodeEnabled = isWebGPUCustomDecodeEnabled();
            if (customDecodeEnabled) {
                const customPlaybackResult = await this.startCustomPlaybackBounded(
                    options,
                    generation,
                    getPlaybackStartTimeMicroseconds(options)
                );
                switch (customPlaybackResult.status) {
                    case 'handled':
                        return customPlaybackResult.result;
                    case 'superseded':
                        this.beginCustomPlaybackAudioPrewarmClose(generation);
                        return PLAYBACK_SUPERSEDED;
                    case 'native-required':
                        break;
                }
            }
            const disabledCustomSourceResult = this.renegotiateCustomOnlySourceWhenDisabled(
                customDecodeEnabled,
                options,
                generation
            );
            if (disabledCustomSourceResult) {
                switch (disabledCustomSourceResult.status) {
                    case 'handled':
                        return disabledCustomSourceResult.result;
                    case 'native-required':
                        break;
                    case 'superseded':
                        return PLAYBACK_SUPERSEDED;
                }
            }

            this.beginCustomPlaybackAudioPrewarmClose(generation);
            if (!this.isRequestedSessionCurrent(generation)) {
                return PLAYBACK_SUPERSEDED;
            }
            const playResult = await this.htmlDelegate.player.play(options);
            if (!this.isRequestedSessionCurrent(generation)) {
                return PLAYBACK_SUPERSEDED;
            }

            this.attachNativePresentation();
            return playResult;
        } catch (error) {
            this.beginCustomPlaybackAudioPrewarmClose(generation);
            this.htmlDelegate.endSession(generation);
            if (!this.isRequestedSessionCurrent(generation)) {
                return PLAYBACK_SUPERSEDED;
            }

            void this.detachCustomPlaybackController();
            this.backendSessionActive = false;
            this.webGPUPresentationEnabled = false;
            this.currentPlaybackOptions = null;
            this.currentDolbyVisionPresentationDescriptor = null;
            this.currentPresentationColorMetadata = null;
            const invalidatedGeneration = this.advancePresentationGeneration();
            this.presenter.endSession(invalidatedGeneration);
            throw error;
        }
    }

    currentTime(value?: number): number | undefined {
        if (value != null) {
            this.cancelPendingPausedPresentationRefresh();
            const requestedTimeMicroseconds = millisecondsToMicroseconds(value);
            this.lastKnownTimeMicroseconds = requestedTimeMicroseconds;
            const recoveryTransitionActive =
                this.customPlaybackRecoveryTimeMicroseconds !== null;
            if (recoveryTransitionActive) {
                this.customPlaybackRecoveryTimeMicroseconds = requestedTimeMicroseconds;
            }
            this.customPlaybackSeekRevision += 1;
            const seekRevision = this.customPlaybackSeekRevision;
            const backendGeneration = this.backendSessionGeneration;
            const seekGeneration = this.advancePresentationGeneration();
            this.presenter.seek(seekGeneration);
            const customPlaybackController = this.getActiveCustomPlaybackController();
            if (customPlaybackController) {
                this.customPlaybackFrameGeneration = seekGeneration;
                this.cancelCustomPlaybackFrameCallback();
                this.presenter.setDecodedFramePushMode(true, seekGeneration);
                void Promise.resolve().then(() => (
                    customPlaybackController.seek(requestedTimeMicroseconds)
                )).then(result => {
                    if (this.customPlaybackSeekRevision !== seekRevision) {
                        return;
                    }
                    this.handleCustomPlaybackStartResult(
                        customPlaybackController,
                        backendGeneration,
                        result
                    );
                }).catch((error: unknown): void => {
                    if (this.customPlaybackSeekRevision !== seekRevision) {
                        return;
                    }
                    this.requestCustomPlaybackFallbackForError(
                        customPlaybackController,
                        backendGeneration,
                        error
                    );
                });
                return undefined;
            }
            if (recoveryTransitionActive) {
                return undefined;
            }
            this.htmlDelegate.player.currentTime(microsecondsToMilliseconds(requestedTimeMicroseconds));
            return undefined;
        }

        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            this.lastKnownTimeMicroseconds = customPlaybackController.currentTimeMicroseconds;
            return microsecondsToMilliseconds(this.lastKnownTimeMicroseconds);
        }

        if (this.customPlaybackRecoveryTimeMicroseconds !== null) {
            return microsecondsToMilliseconds(this.customPlaybackRecoveryTimeMicroseconds);
        }

        const backendTimeMilliseconds = this.htmlDelegate.player.currentTime();
        if (typeof backendTimeMilliseconds !== 'number') {
            return undefined;
        }

        this.lastKnownTimeMicroseconds = millisecondsToMicroseconds(backendTimeMilliseconds);
        return microsecondsToMilliseconds(this.lastKnownTimeMicroseconds);
    }

    duration(): number | null {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            const durationMicroseconds = customPlaybackController.durationMicroseconds;
            return durationMicroseconds === null ?
                null :
                microsecondsToMilliseconds(durationMicroseconds);
        }

        const backendDurationMilliseconds = this.htmlDelegate.player.duration();
        if (typeof backendDurationMilliseconds !== 'number') {
            return null;
        }

        return microsecondsToMilliseconds(millisecondsToMicroseconds(backendDurationMilliseconds));
    }

    seekable(): boolean | undefined {
        if (this.getActiveCustomPlaybackController()) {
            return true;
        }
        return this.htmlDelegate.player.seekable();
    }

    pause(): void {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            customPlaybackController.pause();
            return;
        }
        this.htmlDelegate.player.pause();
    }

    resume(): void {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            customPlaybackController.resume();
            return;
        }
        this.htmlDelegate.player.resume();
    }

    unpause(): void {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            customPlaybackController.resume();
            return;
        }
        this.htmlDelegate.player.unpause();
    }

    paused(): boolean {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            return customPlaybackController.playbackState !== 'playing';
        }
        return this.htmlDelegate.player.paused();
    }

    setSubtitleStreamIndex(index: number): void {
        this.htmlDelegate.player.setSubtitleStreamIndex(index);
    }

    setSecondarySubtitleStreamIndex(index: number): void {
        this.htmlDelegate.player.setSecondarySubtitleStreamIndex(index);
    }

    resetSubtitleOffset(): void {
        this.htmlDelegate.player.resetSubtitleOffset();
    }

    setSubtitleOffset(offset: number | string): void {
        this.htmlDelegate.player.setSubtitleOffset(offset);
    }

    getSubtitleOffset(): number | undefined {
        return this.htmlDelegate.player.getSubtitleOffset();
    }

    enableShowingSubtitleOffset(): void {
        this.htmlDelegate.player.enableShowingSubtitleOffset();
    }

    disableShowingSubtitleOffset(): void {
        this.htmlDelegate.player.disableShowingSubtitleOffset();
    }

    isShowingSubtitleOffsetEnabled(): boolean {
        return Boolean(this.htmlDelegate.player.isShowingSubtitleOffsetEnabled());
    }

    canSetAudioStreamIndex(): boolean {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            return customPlaybackController.canSetAudioStreamIndex();
        }
        return this.htmlDelegate.player.canSetAudioStreamIndex();
    }

    setAudioStreamIndex(index: number): void {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            this.cancelPendingPausedPresentationRefresh();
            this.updateCustomPlaybackAudioSelection(index);
            const backendGeneration = this.backendSessionGeneration;
            const selectionRevision = this.customPlaybackAudioSelectionRevision + 1;
            this.customPlaybackAudioSelectionRevision = selectionRevision;
            void this.restartCustomPlaybackForSelectedAudio(
                customPlaybackController,
                backendGeneration,
                selectionRevision
            ).catch((error: unknown): void => {
                if (this.customPlaybackAudioSelectionRevision !== selectionRevision) {
                    return;
                }
                this.requestCustomPlaybackFallbackForError(
                    customPlaybackController,
                    backendGeneration,
                    error
                );
            });
            return;
        }
        this.htmlDelegate.player.setAudioStreamIndex(index);
    }

    setVolume(value: number | string): void {
        const jellyfinVolume = this.requireJellyfinVolume(value);
        this.customPlaybackVolume = jellyfinVolume;
        this.applyHTMLPlaybackVolume();
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            customPlaybackController.setVolume(this.getLinearVolume(jellyfinVolume));
        }
    }

    getVolume(): number | undefined {
        if (this.getActiveCustomPlaybackController()
            || this.htmlPlaybackNormalizationGain !== null) {
            return this.customPlaybackVolume;
        }
        return this.htmlDelegate.player.getVolume();
    }

    volumeUp(): void {
        if (this.getActiveCustomPlaybackController()
            || this.htmlPlaybackNormalizationGain !== null) {
            this.setVolume(Math.min(
                this.customPlaybackVolume + CUSTOM_VOLUME_STEP,
                MAX_JELLYFIN_VOLUME
            ));
            return;
        }
        this.htmlDelegate.player.volumeUp();
    }

    volumeDown(): void {
        if (this.getActiveCustomPlaybackController()
            || this.htmlPlaybackNormalizationGain !== null) {
            this.setVolume(Math.max(
                this.customPlaybackVolume - CUSTOM_VOLUME_STEP,
                MIN_JELLYFIN_VOLUME
            ));
            return;
        }
        this.htmlDelegate.player.volumeDown();
    }

    setMute(muted: boolean): void {
        this.customPlaybackMuted = muted;
        this.htmlDelegate.player.setMute(muted);
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            customPlaybackController.setMuted(muted);
        }
    }

    isMuted(): boolean {
        if (this.getActiveCustomPlaybackController()) {
            return this.customPlaybackMuted;
        }
        return this.htmlDelegate.player.isMuted();
    }

    setPlaybackRate(value: number): void {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            customPlaybackController.setPlaybackRate(value);
            return;
        }
        this.htmlDelegate.player.setPlaybackRate(value);
    }

    getPlaybackRate(): number | null {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            return customPlaybackController.playbackRate;
        }
        return this.htmlDelegate.player.getPlaybackRate();
    }

    getSupportedPlaybackRates(): PlaybackRateOption[] {
        if (this.getActiveCustomPlaybackController()) {
            return [{ id: 1, name: '1x' }];
        }
        return this.htmlDelegate.player.getSupportedPlaybackRates();
    }

    setBrightness(value: number): void {
        this.htmlDelegate.player.setBrightness(value);
    }

    getBrightness(): number | undefined {
        return this.htmlDelegate.player.getBrightness();
    }

    setAspectRatio(value: string): void {
        this.htmlDelegate.player.setAspectRatio(value);
        this.presenter.refresh(this.presentationGeneration);
    }

    getAspectRatio(): string {
        return this.htmlDelegate.player.getAspectRatio();
    }

    getSupportedAspectRatios(): AspectRatioOption[] {
        return this.htmlDelegate.player.getSupportedAspectRatios();
    }

    setPictureInPictureEnabled(enabled: boolean): void {
        this.htmlDelegate.player.setPictureInPictureEnabled(enabled);
    }

    isPictureInPictureEnabled(): boolean {
        return this.htmlDelegate.player.isPictureInPictureEnabled();
    }

    togglePictureInPicture(): unknown {
        return this.htmlDelegate.player.togglePictureInPicture();
    }

    setAirPlayEnabled(enabled: boolean): void {
        this.htmlDelegate.player.setAirPlayEnabled(enabled);
    }

    isAirPlayEnabled(): boolean {
        return this.htmlDelegate.player.isAirPlayEnabled();
    }

    toggleAirPlay(): unknown {
        return this.htmlDelegate.player.toggleAirPlay();
    }

    getBufferedRanges(): unknown[] {
        if (this.isCustomPlaybackPathActive()) {
            return [];
        }
        return this.htmlDelegate.player.getBufferedRanges();
    }

    getStats(): Promise<unknown> {
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            const customTelemetry = customPlaybackController.getTelemetry();
            const presentationTelemetry = this.presenter.getTelemetry();
            return Promise.resolve({
                categories: [
                    {
                        stats: [
                            { label: 'Playback pipeline', value: 'WebCodecs / WebGPU' },
                            { label: 'State', value: customTelemetry.state },
                            {
                                label: 'Clock',
                                value: `${customTelemetry.currentTimeMicroseconds} us`
                            }
                        ],
                        type: 'media'
                    },
                    {
                        stats: [
                            {
                                label: 'Decoded / presented frames',
                                value: `${customTelemetry.videoDecode.receivedFrameCount} / ${presentationTelemetry.presentedFrameCount}`
                            },
                            {
                                label: 'Dropped / queued frames',
                                value: `${customTelemetry.videoDecode.droppedFrameCount} / ${customTelemetry.videoDecode.queuedFrameCount}`
                            }
                        ],
                        type: 'video'
                    },
                    {
                        stats: [
                            {
                                label: 'Audio path',
                                value: customTelemetry.audioPath
                            },
                            {
                                label: 'Queued / underflow frames',
                                value: `${customTelemetry.audioOutput?.queuedFrames ?? 0} / ${customTelemetry.audioOutput?.underflowFrames ?? 0}`
                            }
                        ],
                        type: 'audio'
                    }
                ]
            });
        }
        return this.htmlDelegate.player.getStats();
    }

    getPresentationTelemetry(): PresentationTelemetry {
        return this.presenter.getTelemetry();
    }

    /** Returns bounded exact-device raw HDR authorization state. */
    getRawHDRAuthorizationTelemetry(): RawHDRAuthorizationTelemetry {
        return this.presenter.getRawHDRAuthorizationTelemetry();
    }

    /** Returns bounded exact-device Dolby Vision authorization state. */
    getDolbyVisionAuthorizationTelemetry(): DolbyVisionAuthorizationTelemetry {
        return this.presenter.getDolbyVisionAuthorizationTelemetry();
    }

    /** Returns exact Profile 7 MEL/base-fallback authorization telemetry. */
    getProfile7DolbyVisionAuthorizationTelemetry(): DolbyVisionAuthorizationTelemetry {
        return this.presenter.getProfile7DolbyVisionAuthorizationTelemetry();
    }

    /** Returns exact Profile 7 FEL residual authorization telemetry. */
    getProfile7FELDolbyVisionAuthorizationTelemetry(): DolbyVisionAuthorizationTelemetry {
        return this.presenter.getProfile7FELDolbyVisionAuthorizationTelemetry();
    }

    /** Returns bounded exact-device external Profile 5 authorization state. */
    getExternalDolbyVisionAuthorizationTelemetry(): ExternalDolbyVisionAuthorizationTelemetry {
        return this.presenter.getExternalDolbyVisionAuthorizationTelemetry();
    }

    /** Returns bounded exact-device native Main10 authorization state. */
    getExternalHDRAuthorizationTelemetry(): ExternalHDRAuthorizationTelemetry {
        return this.presenter.getExternalHDRAuthorizationTelemetry();
    }

    /** Applies live HDR display controls without rebuilding the shader pipeline. */
    updateRenderSettings(
        settings: HDRToSDRRenderSettings,
        automaticInputPeakNits: boolean =
        loadWebGPUUserSettings().render.automaticInputPeakNits
    ): boolean {
        return this.presenter.updateRenderSettings(
            settings,
            this.presentationGeneration,
            automaticInputPeakNits
        );
    }

    /** Applies live gain changes to an active WebGPU stereo downmix when available. */
    updateAudioDownmixSettings(settings: AudioDownmixSettings): boolean {
        assertValidAudioDownmixSettings(settings);
        const customPlaybackController = this.getActiveCustomPlaybackController();
        const audioSettings = this.customPlaybackAudioSettings;
        if (!customPlaybackController || !audioSettings) {
            return false;
        }

        const settingsSnapshot: AudioDownmixSettings = { ...settings };
        this.customPlaybackAudioSettings = {
            ...audioSettings,
            downmix: { ...settingsSnapshot }
        };
        return customPlaybackController.updateAudioDownmixSettings(settingsSnapshot);
    }

    /** Returns a detached renderer-settings snapshot for diagnostics and UI. */
    getRenderSettings(): RenderSettings {
        return this.presenter.getRenderSettings();
    }

    /** Returns the retained source peak used when automatic metadata tracking is enabled. */
    getDetectedInputPeakNits(): number | null {
        if (!this.backendSessionActive
            || !this.webGPUPresentationEnabled) {
            return null;
        }
        return this.activeDetectedInputPeakNits;
    }

    /** Supplies a measured external-texture decision for later HDR sessions. */
    setColorValidationDecision(
        decision: ColorValidationCapabilityDecision | null,
        device: GPUDevice | null = null
    ): void {
        this.colorValidationDecision = decision;
        this.colorValidationDevice = decision ? device : null;
    }

    /** Returns the current measured HDR input decision. */
    getColorValidationDecision(): ColorValidationCapabilityDecision | null {
        return this.colorValidationDecision;
    }

    /** Measures reference VideoFrames on the exact reusable presentation device. */
    async validateColorPipelineReference(
        request: WebGPUPlayerColorValidationRequest
    ): Promise<ColorValidationCapabilityDecision | null> {
        const device = await this.presenter.acquireValidationDevice();
        if (!device) {
            return null;
        }

        if (!this.colorValidationRunner) {
            const validationModule = await import(
                /* webpackChunkName: "webgpu-color-validation" */
                './validation/WebGPUExternalTextureValidationRunner'
            );
            this.colorValidationRunner = new validationModule.WebGPUExternalTextureValidationRunner();
        }
        const decision = await this.colorValidationRunner.validate({
            ...request,
            device
        });
        if (!this.presenter.isValidationDevice(device)) {
            return null;
        }

        this.colorValidationDecision = decision;
        this.colorValidationDevice = decision ? device : null;
        return decision;
    }

    /** Decodes an exact generated validation clip without retaining its URL. */
    async validateColorPipelineReferenceMedia(
        request: WebGPUPlayerColorValidationMediaRequest
    ): Promise<ColorValidationCapabilityDecision | null> {
        const {
            globalTrackIndex,
            timestampsMicroseconds,
            url,
            ...validationRequest
        } = request;
        const providerModule = await import(
            /* webpackChunkName: "webgpu-color-validation" */
            './validation/MediabunnyReferenceFrameProvider'
        );
        const provider = await providerModule.createMediabunnyReferenceFrameProvider({
            globalTrackIndex,
            timestampsMicroseconds,
            url
        });
        try {
            return await this.validateColorPipelineReference({
                ...validationRequest,
                getFrame: (
                    frameRequest: Readonly<ExternalTextureReferenceFrameRequest>
                ): Promise<VideoFrame> => provider.getFrame(frameRequest)
            });
        } finally {
            await provider.destroy();
        }
    }

    /** Returns custom decoder telemetry even after transparent native fallback. */
    getCustomDecodeTelemetry(): CustomDecodeSessionTelemetry | null {
        const telemetry = this.customPlaybackController?.getTelemetry().videoDecode
            ?? this.lastCustomDecodeTelemetry;
        return telemetry ? { ...telemetry } : null;
    }

    /** Returns the combined custom A/V pipeline telemetry. */
    getCustomPlaybackTelemetry(): CustomPlaybackTelemetry | null {
        const telemetry = this.customPlaybackController?.getTelemetry()
            ?? this.lastCustomPlaybackTelemetry;
        return telemetry ? { ...telemetry } : null;
    }

    /** Returns the selected Jellyfin stream index rather than the decoder track ordinal. */
    getCustomPlaybackSelectedAudioStreamIndex(): number | null {
        if (!this.getActiveCustomPlaybackController()
            || !this.currentPlaybackOptions
            || typeof this.currentPlaybackOptions !== 'object') {
            return null;
        }

        const playbackOptions = this.currentPlaybackOptions as PlaybackOptionsRecord;
        const requestedIndex = playbackOptions.audioStreamIndex;
        if (Number.isSafeInteger(requestedIndex) && Number(requestedIndex) >= 0) {
            return Number(requestedIndex);
        }
        const mediaSource = playbackOptions.mediaSource;
        if (!mediaSource || typeof mediaSource !== 'object') {
            return null;
        }
        const defaultIndex = (mediaSource as PlaybackOptionsRecord).DefaultAudioStreamIndex;
        return Number.isSafeInteger(defaultIndex) && Number(defaultIndex) >= 0 ?
            Number(defaultIndex) :
            null;
    }

    /** Returns the last eligibility decision without operational source data. */
    getCustomPlaybackEligibility(): CustomPlaybackEligibilityTelemetry | null {
        const eligibility = this.lastCustomPlaybackEligibility;
        if (!eligibility) {
            return null;
        }
        if (!eligibility.eligible) {
            return {
                eligible: false,
                reason: eligibility.reason
            };
        }
        return {
            audioOutputMode: eligibility.audioOutputMode,
            eligible: true,
            hdr: eligibility.hdr,
            nativeHDRTransfer: eligibility.nativeHDRTransfer ?? null,
            neutralizeHDRColorMetadata: eligibility.neutralizeHDRColorMetadata,
            videoDecoderBackend: eligibility.videoDecoderBackend,
            videoOutputMode: eligibility.videoOutputMode
        };
    }

    /** Returns the last bounded custom-playback setup stage. */
    getCustomPlaybackSetupTelemetry(): CustomPlaybackSetupTelemetry {
        return { ...this.customPlaybackSetupTelemetry };
    }

    /** Returns the last custom-codec capability snapshot used for negotiation. */
    getCustomDecodeCapabilities(): CustomDecodeCapabilities | null {
        return this.lastCustomDecodeCapabilities;
    }

    /** Returns the exact owned native-audio route probe used for negotiation. */
    getNativeMediaAudioCapabilities(): NativeMediaAudioCapabilities | null {
        const capabilities = this.lastNativeMediaAudioCapabilities;
        if (!capabilities) {
            return null;
        }
        return {
            audio: capabilities.audio,
            telemetry: { ...capabilities.telemetry }
        };
    }

    /** Returns the last safe device-profile augmentation decision. */
    getCustomDeviceProfileTelemetry(): CustomDeviceProfileTelemetry | null {
        const telemetry = this.lastCustomDeviceProfileTelemetry;
        return telemetry ? {
            ...telemetry,
            supportedAudioCodecs: [ ...telemetry.supportedAudioCodecs ],
            supportedVideoCodecs: [ ...telemetry.supportedVideoCodecs ]
        } : null;
    }

    /** Returns why custom A/V playback was or was not eligible at negotiation. */
    getCustomPlaybackRuntimeAvailability(): CustomPlaybackRuntimeAvailability | null {
        return this.lastCustomPlaybackRuntimeAvailability;
    }

    private attachNativePresentation(): void {
        if (!this.webGPUPresentationEnabled) {
            return;
        }

        // Native HDR must stay on the browser-managed video path. External
        // textures expose browser-converted sRGB, not the source PQ/HLG signal.
        if (this.currentPresentationColorMetadata?.transfer !== 'sdr') {
            this.webGPUPresentationEnabled = false;
            this.presenter.endSession(this.presentationGeneration);
            return;
        }

        const presentationSurface = this.htmlDelegate.player.getPresentationSurface();
        if (!presentationSurface) {
            return;
        }

        const generation = this.presentationGeneration;
        this.presenter.setDecodedFramePushMode(false, generation);
        this.presenter.attach(presentationSurface, generation);
        void this.configurePresentationColorPipeline(
            generation,
            'video-frame',
            null,
            null
        ).then(configured => {
            if (!configured && this.isRequestedSessionCurrent(this.backendSessionGeneration)) {
                console.warn('WebGPU presentation returned to the native video surface');
            }
        });
    }

    private createHDRRenderConfiguration(
        detectedInputPeakNits: number
    ): Readonly<{
            automaticInputPeakNits: boolean
            settings: HDRToSDRRenderSettings
        }> {
        const userSettings = loadWebGPUUserSettings();
        const automaticUserSettings: WebGPUUserSettings = {
            ...userSettings,
            render: {
                ...userSettings.render,
                automaticInputPeakNits: true
            }
        };
        const automaticSettings = createConfiguredHDRRenderSettings(
            automaticUserSettings,
            detectedInputPeakNits
        );
        this.activeDetectedInputPeakNits = automaticSettings.toneMapping.inputPeakNits;
        return {
            automaticInputPeakNits: userSettings.render.automaticInputPeakNits,
            settings: userSettings.render.automaticInputPeakNits ?
                automaticSettings :
                createConfiguredHDRRenderSettings(userSettings, detectedInputPeakNits)
        };
    }

    private configureDolbyVisionPresentationColorPipeline(
        dolbyVisionDescriptor: DolbyVisionPresentationDescriptor,
        generation: number,
        videoOutputMode: CustomDecodeVideoOutputMode,
        rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    ): Promise<boolean> {
        if (
            dolbyVisionDescriptor.profile === 5
            && videoOutputMode === 'video-frame'
            && rawVideoFrameFormat === null
        ) {
            return this.presenter.configureColorPipeline({
                ...this.createHDRRenderConfiguration(4_000),
                inputMode: 'external-dolby-vision',
                profile: 5
            }, generation);
        }
        if (videoOutputMode !== 'raw-planes' || rawVideoFrameFormat !== 'I420P10') {
            return Promise.resolve(false);
        }
        return this.presenter.configureColorPipeline({
            ...this.createHDRRenderConfiguration(4_000),
            inputMode: 'raw-dolby-vision',
            profile: dolbyVisionDescriptor.profile,
            rawFrameFormat: 'I420P10'
        }, generation);
    }

    private configurePresentationColorPipeline(
        generation: number,
        videoOutputMode: CustomDecodeVideoOutputMode,
        rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null,
        dolbyVisionProfile: 5 | 7 | 8 | null
    ): Promise<boolean> {
        const dolbyVisionDescriptor = this.currentDolbyVisionPresentationDescriptor;
        if (!dolbyVisionDescriptor) {
            return this.configureColorMetadataPresentationPipeline(
                generation,
                videoOutputMode,
                rawVideoFrameFormat
            );
        }
        if (dolbyVisionProfile === null) {
            return this.configureDolbyVisionHDR10BaseColorPipeline(
                dolbyVisionDescriptor,
                generation,
                videoOutputMode,
                rawVideoFrameFormat
            );
        }
        if (dolbyVisionDescriptor.profile !== dolbyVisionProfile) {
            return Promise.resolve(false);
        }

        return this.configureDolbyVisionPresentationColorPipeline(
            dolbyVisionDescriptor,
            generation,
            videoOutputMode,
            rawVideoFrameFormat
        );
    }

    private configureDolbyVisionHDR10BaseColorPipeline(
        dolbyVisionDescriptor: DolbyVisionPresentationDescriptor,
        generation: number,
        videoOutputMode: CustomDecodeVideoOutputMode,
        rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    ): Promise<boolean> {
        const colorMetadata = getDolbyVisionProfile7HDR10BaseColorMetadata(
            this.currentPlaybackOptions
        ) ?? getDolbyVisionProfile8HDR10BaseColorMetadata(this.currentPlaybackOptions);
        const descriptorSupported =
            isDolbyVisionProfile7HDR10BaseLayerDescriptor(dolbyVisionDescriptor)
            || isDolbyVisionProfile8HDR10BaseLayerDescriptor(dolbyVisionDescriptor);
        if (
            !descriptorSupported
            || colorMetadata === null
            || videoOutputMode !== 'video-frame'
            || rawVideoFrameFormat !== null
        ) {
            return Promise.resolve(false);
        }
        return this.presenter.configureColorPipeline({
            ...this.createHDRRenderConfiguration(colorMetadata.nominalPeakNits),
            inputMode: 'external-hdr',
            metadata: colorMetadata
        }, generation);
    }

    private configureColorMetadataPresentationPipeline(
        generation: number,
        videoOutputMode: CustomDecodeVideoOutputMode,
        rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    ): Promise<boolean> {
        const metadata = this.currentPresentationColorMetadata;
        if (!metadata) {
            return Promise.resolve(false);
        }
        if (metadata.transfer === 'sdr') {
            this.activeDetectedInputPeakNits = null;
            if (videoOutputMode !== 'video-frame' || rawVideoFrameFormat !== null) {
                return Promise.resolve(false);
            }
            return this.presenter.configureColorPipeline({
                settings: createDefaultRenderSettings()
            }, generation);
        }

        if (videoOutputMode === 'video-frame' && rawVideoFrameFormat === null) {
            return this.presenter.configureColorPipeline({
                ...this.createHDRRenderConfiguration(metadata.nominalPeakNits),
                inputMode: 'external-hdr',
                metadata
            }, generation);
        }

        if (videoOutputMode !== 'raw-planes' || rawVideoFrameFormat === null) {
            return Promise.resolve(false);
        }

        switch (rawVideoFrameFormat) {
            case 'I420P10':
                if (metadata.bitDepth !== 10) {
                    return Promise.resolve(false);
                }
                break;
            case 'I420P12':
                if (metadata.bitDepth !== 12) {
                    return Promise.resolve(false);
                }
                break;
        }

        return this.presenter.configureColorPipeline({
            ...this.createHDRRenderConfiguration(metadata.nominalPeakNits),
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: rawVideoFrameFormat
        }, generation);
    }

    private applyStaticHDRMetadata(metadata: StaticHDRMetadata): void {
        const dolbyVisionHDR10BasePresentation =
            this.isCurrentDolbyVisionHDR10BasePresentation();
        if (
            (this.currentDolbyVisionPresentationDescriptor
                && !dolbyVisionHDR10BasePresentation)
            || (
                this.currentPresentationColorMetadata?.transfer !== 'pq'
                && !dolbyVisionHDR10BasePresentation
            )
        ) {
            return;
        }

        const inputPeakNits = getStaticHDRToneMappingPeakNits(metadata);
        if (inputPeakNits === null) {
            return;
        }
        const configuration = this.createHDRRenderConfiguration(inputPeakNits);
        if (!configuration.automaticInputPeakNits) {
            return;
        }
        const currentSettings = this.presenter.getRenderSettings();
        if (currentSettings.mode !== 'hdr-to-sdr'
            || currentSettings.toneMapping.inputPeakNits
                === configuration.settings.toneMapping.inputPeakNits) {
            return;
        }
        if (!this.presenter.updateRenderSettings(
            configuration.settings,
            this.presentationGeneration,
            true
        )) {
            console.warn('WebGPU could not apply static HDR luminance metadata');
        }
    }

    private isCurrentDolbyVisionHDR10BasePresentation(): boolean {
        const descriptor = this.currentDolbyVisionPresentationDescriptor;
        const eligibility = this.lastCustomPlaybackEligibility;
        return descriptor !== null
            && (
                isDolbyVisionProfile7HDR10BaseLayerDescriptor(descriptor)
                || isDolbyVisionProfile8HDR10BaseLayerDescriptor(descriptor)
            )
            && (
                getDolbyVisionProfile7HDR10BaseColorMetadata(
                    this.currentPlaybackOptions
                ) !== null
                || getDolbyVisionProfile8HDR10BaseColorMetadata(
                    this.currentPlaybackOptions
                ) !== null
            )
            && eligibility?.eligible === true
            && eligibility.dolbyVisionProfile === null
            && eligibility.nativeHDRTransfer === 'pq'
            && eligibility.neutralizeHDRColorMetadata;
    }

    private startCustomPlaybackAudioPrewarm(options: unknown, backendGeneration: number): void {
        if (!isWebGPUCustomDecodeEnabled()) {
            return;
        }

        const sourceSampleRate = getSelectedAudioSampleRate(options);
        if (sourceSampleRate === null) {
            return;
        }

        try {
            this.customPlaybackAudioPrewarm = {
                backendGeneration,
                lease: prewarmBrowserAudioContext(CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE)
            };
        } catch (error) {
            console.warn('Unable to prewarm custom playback audio', error);
        }
    }

    private getCustomPlaybackAudioPrewarm(
        backendGeneration: number
    ): BrowserAudioContextPrewarmLease | null {
        const audioPrewarm = this.customPlaybackAudioPrewarm;
        return audioPrewarm?.backendGeneration === backendGeneration ?
            audioPrewarm.lease :
            null;
    }

    private getCustomPlaybackAudioPrewarmForTrack(
        audioTrackIndex: number | null,
        audioOutputMode: CustomDecodeAudioOutputMode | null,
        backendGeneration: number
    ): BrowserAudioContextPrewarmLease | null {
        if (audioTrackIndex !== null && audioOutputMode === 'decoded-pcm') {
            return this.getCustomPlaybackAudioPrewarm(backendGeneration);
        }

        this.beginCustomPlaybackAudioPrewarmClose(backendGeneration);
        return null;
    }

    private beginCustomPlaybackAudioPrewarmClose(backendGeneration: number): void {
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(backendGeneration);
        if (audioPrewarmClose) {
            void audioPrewarmClose;
        }
    }

    private closeCustomPlaybackAudioPrewarm(
        backendGeneration: number
    ): Promise<void> | null {
        const audioPrewarm = this.customPlaybackAudioPrewarm;
        if (!audioPrewarm || audioPrewarm.backendGeneration !== backendGeneration) {
            return null;
        }

        this.customPlaybackAudioPrewarm = null;
        let closePromise: Promise<void>;
        // eslint-disable-next-line sonarjs/no-try-promise -- AudioContext close may throw synchronously
        try {
            closePromise = audioPrewarm.lease.close().catch((error: unknown): void => {
                console.warn('Unable to close unused custom playback audio prewarm', error);
            });
        } catch (error) {
            console.warn('Unable to close unused custom playback audio prewarm', error);
            return Promise.resolve();
        }
        this.pendingAudioPrewarmClosePromises.add(closePromise);
        closePromise.then((): void => {
            this.pendingAudioPrewarmClosePromises.delete(closePromise);
        }, (): void => {
            this.pendingAudioPrewarmClosePromises.delete(closePromise);
        });
        return closePromise;
    }

    private waitForPendingAudioPrewarmCloses(): Promise<void> {
        const pendingCloses = Array.from(this.pendingAudioPrewarmClosePromises);
        return Promise.all(pendingCloses).then((): void => undefined);
    }

    private createCustomPlaybackAudioOutputFactory(
        audioOutputModule: typeof import('./custom/BrowserCustomAudioOutput'),
        audioTrackIndex: number | null,
        audioPrewarm: BrowserAudioContextPrewarmLease | null
    ): CustomAudioOutputFactory | undefined {
        return audioTrackIndex === null ?
            undefined :
            audioOutputModule.createBrowserCustomAudioOutputFactory(audioPrewarm);
    }

    private createCustomPlaybackController(
        controllerModule: typeof import('./custom/CustomPlaybackController'),
        audioOutputModule: typeof import('./custom/BrowserCustomAudioOutput'),
        nativeAudioBridgeModule: typeof import('./custom/CustomDecodeNativeAudioBridge'),
        eligibility: EligibleCustomPlayback,
        audioPrewarm: BrowserAudioContextPrewarmLease | null,
        backendGeneration: number
    ): CustomPlaybackController {
        const controllerReference: { controller: CustomPlaybackController | null } = {
            controller: null
        };
        const nativeAudioBridgeFactory = eligibility.audioTrackIndex === null ?
            undefined :
            (): InstanceType<typeof nativeAudioBridgeModule.default> => (
                new nativeAudioBridgeModule.default()
            );
        const customPlaybackController = new controllerModule.default({
            audioOutputFactory: this.createCustomPlaybackAudioOutputFactory(
                audioOutputModule,
                eligibility.audioTrackIndex,
                audioPrewarm
            ),
            eventHandler: (event: CustomPlaybackControllerEvent): void => {
                if (controllerReference.controller) {
                    this.handleCustomPlaybackEvent(
                        controllerReference.controller,
                        backendGeneration,
                        event
                    );
                }
            },
            fallbackHook: (request: CustomPlaybackFallbackRequest): Promise<void> => {
                if (!controllerReference.controller) {
                    return Promise.resolve();
                }
                return this.requestCustomPlaybackFallback(
                    controllerReference.controller,
                    backendGeneration,
                    request
                ).then(() => undefined);
            },
            nativeAudioBridgeFactory
        });
        controllerReference.controller = customPlaybackController;
        return customPlaybackController;
    }

    private async startCustomPlaybackBounded(
        options: unknown,
        backendGeneration: number,
        recoveryAnchorMicroseconds: Microseconds
    ): Promise<CustomPlaybackAttemptResult> {
        const setupRevision = this.customPlaybackSetupRevision;
        this.customPlaybackSetupTelemetry = {
            stage: 'capabilities',
            status: 'in-progress'
        };
        const result = await waitForCustomPlaybackSetup(
            this.tryStartCustomPlayback(
                options,
                backendGeneration,
                setupRevision,
                recoveryAnchorMicroseconds
            )
        );
        if (result !== CUSTOM_PLAYBACK_SETUP_TIMEOUT) {
            if (result.status !== 'superseded') {
                this.customPlaybackSetupTelemetry = {
                    stage: 'complete',
                    status: 'complete'
                };
            }
            return result;
        }

        if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
            return { status: 'superseded' };
        }

        this.customPlaybackSetupTelemetry = {
            stage: this.customPlaybackSetupTelemetry.stage,
            status: 'timeout'
        };
        this.customPlaybackSetupRevision += 1;
        this.customPlaybackStartingGeneration = null;
        this.webGPUPresentationEnabled = false;
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
        void this.detachCustomPlaybackController();
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return { status: 'superseded' };
        }

        console.warn('Custom playback setup exceeded its bounded timeout');
        return this.getCustomPlaybackUnavailableResult(
            backendGeneration,
            'startup-timeout',
            recoveryAnchorMicroseconds
        );
    }

    private async tryStartCustomPlayback(
        options: unknown,
        backendGeneration: number,
        setupRevision: number,
        recoveryAnchorMicroseconds: Microseconds
    ): Promise<CustomPlaybackAttemptResult> {
        this.customPlaybackStartingGeneration = backendGeneration;
        const eligibility = await this.getCustomPlaybackEligibilityForOptions(
            options,
            backendGeneration
        );
        if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
            return { status: 'superseded' };
        }
        if (!eligibility?.eligible || !this.webGPUPresentationEnabled) {
            return this.getCustomPlaybackUnavailableResult(
                backendGeneration,
                'source-unsupported',
                recoveryAnchorMicroseconds
            );
        }
        this.customPlaybackSetupTelemetry = {
            stage: 'modules',
            status: 'in-progress'
        };
        this.lastKnownTimeMicroseconds = eligibility.startTimeMicroseconds;

        const audioPrewarm = this.getCustomPlaybackAudioPrewarmForTrack(
            eligibility.audioTrackIndex,
            eligibility.audioOutputMode,
            backendGeneration
        );
        const webGPUUserSettings = loadWebGPUUserSettings();
        const decodedAudioOutputChannelCount = selectDecodedAudioOutputChannelCount(
            eligibility,
            audioPrewarm?.audioContext ?? null,
            webGPUUserSettings.audio.forceStereoDownmix
        );

        let completedStartResult: CustomPlaybackStartResult | null = null;
        try {
            const [
                controllerModule,
                audioOutputModule,
                nativeAudioBridgeModule,
                userSettingsModule
            ] = await Promise.all([
                import(
                    /* webpackChunkName: "webgpu-custom-playback" */
                    './custom/CustomPlaybackController'
                ),
                import(
                    /* webpackChunkName: "webgpu-custom-playback" */
                    './custom/BrowserCustomAudioOutput'
                ),
                import(
                    /* webpackChunkName: "webgpu-custom-playback" */
                    './custom/CustomDecodeNativeAudioBridge'
                ),
                import(
                    /* webpackChunkName: "webgpu-custom-playback" */
                    'scripts/settings/userSettings'
                )
            ]);
            if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
                return { status: 'superseded' };
            }

            this.customPlaybackSetupTelemetry = {
                stage: 'surface',
                status: 'in-progress'
            };
            const htmlBackend = this.getHTMLCustomPlaybackBackend();
            const presentationSurface = await htmlBackend.prepareCustomPlayback(options);
            if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
                return { status: 'superseded' };
            }
            if (!presentationSurface || presentationSurface === PLAYBACK_SUPERSEDED) {
                return presentationSurface === PLAYBACK_SUPERSEDED ?
                    { status: 'superseded' } :
                    this.getCustomPlaybackUnavailableResult(
                        backendGeneration,
                        'source-unsupported',
                        recoveryAnchorMicroseconds
                    );
            }

            this.customPlaybackSetupTelemetry = {
                stage: 'presentation',
                status: 'in-progress'
            };
            const presentationGeneration = this.presentationGeneration;
            this.presenter.setDecodedFramePushMode(true, presentationGeneration);
            this.presenter.attach(presentationSurface, presentationGeneration);
            const colorPipelineConfigured = await this.configurePresentationColorPipeline(
                presentationGeneration,
                eligibility.videoOutputMode,
                eligibility.rawVideoFrameFormat,
                eligibility.dolbyVisionProfile
            );
            if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
                return { status: 'superseded' };
            }
            if (!colorPipelineConfigured || !this.webGPUPresentationEnabled) {
                return this.getCustomPlaybackUnavailableResult(
                    backendGeneration,
                    'lifecycle-failed',
                    recoveryAnchorMicroseconds
                );
            }

            this.customPlaybackSetupTelemetry = {
                stage: 'controller',
                status: 'in-progress'
            };
            const customPlaybackController = this.createCustomPlaybackController(
                controllerModule,
                audioOutputModule,
                nativeAudioBridgeModule,
                eligibility,
                audioPrewarm,
                backendGeneration
            );
            this.customPlaybackController = customPlaybackController;
            this.customPlaybackAudioSettings = {
                downmix: { ...webGPUUserSettings.audio.downmix },
                forceStereoDownmix: webGPUUserSettings.audio.forceStereoDownmix
            };
            this.customPlaybackBackendGeneration = backendGeneration;
            this.customPlaybackFrameGeneration = presentationGeneration;
            this.customPlaybackEmitUnpause = true;
            this.initializeCustomPlaybackGain(
                customPlaybackController,
                options,
                userSettingsModule.selectAudioNormalization(undefined)
            );
            const audioDownmixAlgorithm = selectAudioDownmixAlgorithm(
                eligibility.audioTrackIndex,
                userSettingsModule.webGPUAudioDownmixAlgorithm(undefined)
            );

            const startResult = await customPlaybackController.play({
                audioDownmixAlgorithm,
                audioDownmixSettings: getDecodedAudioDownmixSettings(
                    eligibility,
                    webGPUUserSettings
                ),
                audioOutputMode: eligibility.audioOutputMode ?? undefined,
                audioTrackIndex: eligibility.audioTrackIndex,
                decodedAudioOutputChannelCount,
                durationMicroseconds: eligibility.durationMicroseconds,
                dolbyVisionProfile: eligibility.dolbyVisionProfile,
                maximumCodedHeight: eligibility.maximumCodedHeight,
                maximumCodedWidth: eligibility.maximumCodedWidth,
                nativeHDRTransfer: eligibility.nativeHDRTransfer ?? null,
                neutralizeHDRColorMetadata: eligibility.neutralizeHDRColorMetadata,
                rawVideoFrameFormat: eligibility.rawVideoFrameFormat,
                startTimeMicroseconds: eligibility.startTimeMicroseconds,
                url: eligibility.url,
                videoDecoderBackend: eligibility.videoDecoderBackend,
                videoOutputMode: eligibility.videoOutputMode,
                videoTrackIndex: eligibility.videoTrackIndex
            });
            if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
                return { status: 'superseded' };
            }
            this.handleCustomPlaybackStartResult(
                customPlaybackController,
                backendGeneration,
                startResult
            );
            completedStartResult = startResult;
        } catch (error) {
            if (!this.isCustomPlaybackSetupCurrent(backendGeneration, setupRevision)) {
                return { status: 'superseded' };
            }
            console.warn('Custom playback startup failed; using the HTML backend', error);
            void this.detachCustomPlaybackController();
            return this.getCustomPlaybackUnavailableResult(
                backendGeneration,
                'decode-failed',
                recoveryAnchorMicroseconds
            );
        } finally {
            if (this.customPlaybackStartingGeneration === backendGeneration) {
                this.customPlaybackStartingGeneration = null;
            }
        }

        if (!completedStartResult) {
            return this.getCustomPlaybackUnavailableResult(
                backendGeneration,
                'lifecycle-failed',
                recoveryAnchorMicroseconds
            );
        }
        return this.resolveCustomPlaybackStartResult(completedStartResult);
    }

    private async resolveCustomPlaybackStartResult(
        startResult: CustomPlaybackStartResult
    ): Promise<CustomPlaybackAttemptResult> {
        switch (startResult.status) {
            case 'started':
                return { result: undefined, status: 'handled' };
            case 'fallback': {
                const fallbackPromise = this.customPlaybackFallbackPromise;
                if (!fallbackPromise) {
                    return this.getCustomPlaybackUnavailableResult(
                        this.backendSessionGeneration,
                        'lifecycle-failed',
                        this.lastKnownTimeMicroseconds
                    );
                }
                return {
                    result: await fallbackPromise,
                    status: 'handled'
                };
            }
            case 'stopped':
            case 'superseded':
                return { status: 'superseded' };
        }
    }

    private getCustomPlaybackUnavailableResult(
        backendGeneration: number,
        reason: CustomPlaybackFallbackRequest['reason'],
        mediaTimeMicroseconds: Microseconds
    ): CustomPlaybackAttemptResult {
        if (!this.currentPlaybackRequiresSourceRenegotiation) {
            return { status: 'native-required' };
        }

        this.lastKnownTimeMicroseconds = mediaTimeMicroseconds;
        this.customPlaybackRecoveryTimeMicroseconds = mediaTimeMicroseconds;
        this.webGPUPresentationEnabled = false;
        this.beginCustomPlaybackAudioPrewarmClose(backendGeneration);
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
        const accepted = this.emitCustomPlaybackRenegotiationRequired(
            backendGeneration,
            reason
        );
        return {
            result: accepted ? undefined : PLAYBACK_SUPERSEDED,
            status: 'handled'
        };
    }

    /** Renegotiates a source widened before custom decode became unavailable. */
    private renegotiateCustomOnlySourceWhenDisabled(
        customDecodeEnabled: boolean,
        options: unknown,
        backendGeneration: number
    ): CustomPlaybackAttemptResult | null {
        if (customDecodeEnabled || !this.currentPlaybackRequiresSourceRenegotiation) {
            return null;
        }
        return this.getCustomPlaybackUnavailableResult(
            backendGeneration,
            'source-unsupported',
            getPlaybackStartTimeMicroseconds(options)
        );
    }

    private async getCustomPlaybackEligibilityForOptions(
        options: unknown,
        backendGeneration: number
    ): Promise<CustomPlaybackEligibility | null> {
        if (!await getWebGPUCustomDecodeEnabled()) {
            return null;
        }
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return null;
        }

        const runtimeAvailability = getCustomPlaybackRuntimeAvailability();
        this.lastCustomPlaybackRuntimeAvailability = runtimeAvailability;
        const [ capabilities, nativeMediaAudioCapabilities ] = await Promise.all([
            this.lastCustomDecodeCapabilities ?? probeCustomDecodeCapabilities(),
            this.lastNativeMediaAudioCapabilities
                ?? probeCachedNativeMediaAudioCapabilities()
        ]);
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return null;
        }

        this.lastCustomDecodeCapabilities = capabilities;
        this.lastNativeMediaAudioCapabilities = nativeMediaAudioCapabilities;
        const presentationOptions = await this.getCustomPresentationEligibilityOptions(
            backendGeneration
        );
        if (!presentationOptions) {
            return null;
        }
        const eligibility = getCustomPlaybackEligibility(options, capabilities, {
            ...presentationOptions,
            nativeMediaAudioCapabilities,
            runtimeAvailability
        });
        this.lastCustomPlaybackEligibility = eligibility;
        return eligibility;
    }

    private async getCustomPresentationEligibilityOptions(
        backendGeneration: number
    ): Promise<Pick<
        CustomPlaybackEligibilityOptions,
        | 'allowDolbyVision'
        | 'allowDolbyVisionProfile7'
        | 'allowNativeDolbyVision'
        | 'allowNativeDolbyVisionProfile7HDR10Base'
        | 'allowNativeDolbyVisionProfile8HDR10Base'
        | 'allowNativeHDR'
        | 'allowRawHDR'
        | 'authorizedExternalHDRRouteKeys'
        | 'authorizedRawHDRRouteKeys'
    > | null> {
        const metadata = this.currentPresentationColorMetadata;
        const rawHDRRequested = metadata !== null
            && metadata.transfer !== 'sdr'
            && (metadata.bitDepth === 10 || metadata.bitDepth === 12);
        const dolbyVisionRequested = this.currentDolbyVisionPresentationDescriptor !== null;
        const profile7HDR10BaseRequested =
            getDolbyVisionProfile7HDR10BaseColorMetadata(
                this.currentPlaybackOptions
            ) !== null;
        const profile8HDR10BaseRequested =
            getDolbyVisionProfile8HDR10BaseColorMetadata(
                this.currentPlaybackOptions
            ) !== null;
        const dolbyVisionHDR10BaseRequested = profile7HDR10BaseRequested
            || profile8HDR10BaseRequested;
        if (!rawHDRRequested && !dolbyVisionRequested) {
            return {
                allowDolbyVision: false,
                allowDolbyVisionProfile7: false,
                allowNativeDolbyVision: false,
                allowNativeHDR: false,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys:
                    this.presenter.getAuthorizedExternalHDRRouteKeys(),
                authorizedRawHDRRouteKeys: this.presenter.getAuthorizedRawHDRRouteKeys()
            };
        }

        const hdrToneMappingEnabled = await getWebGPUHDRToneMappingEnabled();
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return null;
        }
        if (!hdrToneMappingEnabled) {
            return {
                allowDolbyVision: false,
                allowDolbyVisionProfile7: false,
                allowNativeDolbyVision: false,
                allowNativeHDR: false,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [],
                authorizedRawHDRRouteKeys: []
            };
        }
        const {
            authorizedExternalHDRRouteKeys,
            authorizedRawHDRRouteKeys
        } = this.prepareCustomPresentationAuthorizations(
            rawHDRRequested,
            dolbyVisionRequested,
            dolbyVisionHDR10BaseRequested
        );
        return {
            allowDolbyVision: dolbyVisionRequested
                && this.currentDolbyVisionPresentationDescriptor?.profile !== 7
                && this.presenter.isRawDolbyVisionPresentationAuthorized(),
            allowDolbyVisionProfile7: dolbyVisionRequested
                && this.currentDolbyVisionPresentationDescriptor?.profile === 7
                && this.presenter.isRawDolbyVisionProfile7PresentationAuthorized(),
            allowNativeDolbyVision: dolbyVisionRequested
                && this.presenter.isExternalDolbyVisionPresentationAuthorized(),
            allowNativeDolbyVisionProfile7HDR10Base: profile7HDR10BaseRequested
                && hasAuthorizedDolbyVisionHDR10BaseRoute(
                    authorizedExternalHDRRouteKeys
                ),
            allowNativeDolbyVisionProfile8HDR10Base: profile8HDR10BaseRequested
                && hasAuthorizedDolbyVisionHDR10BaseRoute(
                    authorizedExternalHDRRouteKeys
                ),
            allowNativeHDR: (rawHDRRequested || dolbyVisionHDR10BaseRequested)
                && authorizedExternalHDRRouteKeys.length > 0,
            allowRawHDR: rawHDRRequested && authorizedRawHDRRouteKeys.length > 0,
            authorizedExternalHDRRouteKeys,
            authorizedRawHDRRouteKeys
        };
    }

    private prepareCustomPresentationAuthorizations(
        rawHDRRequested: boolean,
        dolbyVisionRequested: boolean,
        dolbyVisionHDR10BaseRequested: boolean
    ): CustomPresentationAuthorizations {
        const externalHDRRequested = rawHDRRequested || dolbyVisionHDR10BaseRequested;
        if (externalHDRRequested) {
            void this.presenter.prewarmExternalHDRPresentationAuthorization();
        }
        if (rawHDRRequested) {
            void this.presenter.prewarmRawHDRPresentationAuthorization();
        }
        if (dolbyVisionRequested) {
            void this.presenter.prewarmDolbyVisionPresentationAuthorization();
        }
        return {
            authorizedExternalHDRRouteKeys: externalHDRRequested ?
                this.presenter.getAuthorizedExternalHDRRouteKeys() :
                [],
            authorizedRawHDRRouteKeys: rawHDRRequested ?
                this.presenter.getAuthorizedRawHDRRouteKeys() :
                []
        };
    }

    private initializeCustomPlaybackGain(
        customPlaybackController: CustomPlaybackController,
        playbackOptions: unknown,
        audioNormalizationMode: unknown
    ): void {
        const backendVolume = this.htmlDelegate.player.getVolume();
        if (typeof backendVolume === 'number'
            && Number.isFinite(backendVolume)
            && backendVolume >= MIN_JELLYFIN_VOLUME
            && backendVolume <= MAX_JELLYFIN_VOLUME) {
            this.customPlaybackVolume = backendVolume;
        }
        this.customPlaybackMuted = this.htmlDelegate.player.isMuted();
        this.htmlPlaybackNormalizationGain = null;
        this.customPlaybackNormalizationGain = getAudioNormalizationLinearGain(
            playbackOptions,
            audioNormalizationMode
        );
        customPlaybackController.setNormalizationGain(this.customPlaybackNormalizationGain);
        customPlaybackController.setVolume(this.getLinearVolume(this.customPlaybackVolume));
        customPlaybackController.setMuted(this.customPlaybackMuted);
    }

    private handleCustomPlaybackStartResult(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        result: CustomPlaybackStartResult
    ): void {
        if (!this.isCustomPlaybackCurrent(customPlaybackController, backendGeneration)) {
            return;
        }
        if (result.status === 'started'
            && customPlaybackController.playbackState === 'paused') {
            this.scheduleCustomPlaybackFrame(customPlaybackController, false);
        }
    }

    private handleCustomPlaybackEvent(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        event: CustomPlaybackControllerEvent
    ): void {
        if (!this.isCustomPlaybackCurrent(customPlaybackController, backendGeneration)) {
            return;
        }

        const htmlBackend = this.getHTMLCustomPlaybackBackend();
        switch (event.type) {
            case 'static-hdr-metadata':
                this.applyStaticHDRMetadata(event.metadata);
                break;
            case 'statechange':
                if (event.state === 'paused') {
                    this.cancelCustomPlaybackFrameCallback();
                    const pausedRefresh = this.getCurrentPausedPresentationRefresh(
                        customPlaybackController,
                        backendGeneration
                    );
                    if (!pausedRefresh) {
                        // Preserve the shell's outstanding pause across any seek generation
                        this.customPlaybackEmitUnpause = true;
                        htmlBackend.notifyCustomPlaybackPaused();
                    }
                    this.scheduleCustomPlaybackFrame(customPlaybackController, false);
                } else if (event.state === 'playing') {
                    this.customPlaybackEmitUnpause = this.customPlaybackEmitUnpause
                        || event.previousState === 'paused'
                        || event.previousState === 'starting';
                    // Replace a one-shot paused poll with the continuous playing loop
                    this.cancelCustomPlaybackFrameCallback();
                    this.scheduleCustomPlaybackFrame(customPlaybackController, true);
                }
                break;
            case 'ready':
                if (customPlaybackController.playbackState === 'paused') {
                    this.scheduleCustomPlaybackFrame(customPlaybackController, false);
                }
                break;
            case 'playing':
                this.customPlaybackHasPlayed = true;
                htmlBackend.notifyCustomPlaybackPlaying(this.customPlaybackEmitUnpause);
                this.customPlaybackEmitUnpause = false;
                this.scheduleCustomPlaybackFrame(customPlaybackController, true);
                break;
            case 'timeupdate':
                this.lastKnownTimeMicroseconds = event.currentTimeMicroseconds;
                htmlBackend.notifyCustomPlaybackTimeUpdate(
                    microsecondsToMilliseconds(event.currentTimeMicroseconds)
                );
                break;
            case 'waiting':
                if (!this.getCurrentPausedPresentationRefresh(
                    customPlaybackController,
                    backendGeneration
                )) {
                    htmlBackend.notifyCustomPlaybackWaiting();
                }
                break;
            case 'ended':
                this.cancelPendingPausedPresentationRefresh();
                this.cancelCustomPlaybackFrameCallback();
                htmlBackend.notifyCustomPlaybackEnded();
                break;
            case 'error':
                console.warn('Custom playback pipeline error', event.message);
                if (!event.recoverable) {
                    this.handleCustomPlaybackTerminalFailure(
                        customPlaybackController,
                        backendGeneration,
                        new Error(event.message)
                    );
                }
                break;
            case 'fallback-requested':
                // The fallback hook owns the one-shot native transition
                break;
            case 'telemetry':
                this.lastCustomPlaybackTelemetry = event.telemetry;
                this.lastCustomDecodeTelemetry = event.telemetry.videoDecode;
                break;
        }
    }

    private scheduleCustomPlaybackFrame(
        customPlaybackController: CustomPlaybackController,
        continueWhilePlaying: boolean
    ): void {
        if (this.customPlaybackFrameCallback !== null
            || !this.isCustomPlaybackCurrent(
                customPlaybackController,
                this.backendSessionGeneration
            )) {
            return;
        }

        const generation = this.customPlaybackFrameGeneration;
        if (generation === null || typeof globalThis.requestAnimationFrame !== 'function') {
            this.requestCustomPlaybackFallbackForError(
                customPlaybackController,
                this.backendSessionGeneration,
                new Error('requestAnimationFrame is unavailable')
            );
            return;
        }

        this.customPlaybackFrameCallback = globalThis.requestAnimationFrame((): void => {
            this.customPlaybackFrameCallback = null;
            if (!this.isCustomPlaybackCurrent(
                customPlaybackController,
                this.backendSessionGeneration
            ) || this.customPlaybackFrameGeneration !== generation) {
                return;
            }

            const decodedFrame: DecodedPresentationFrame | null =
                customPlaybackController.takeCurrentFrame();
            let presentationTemporarilyBusy = false;
            if (decodedFrame) {
                const frameSubmitted = this.presenter.presentDecodedFrame(
                    decodedFrame,
                    generation
                );
                if (!frameSubmitted) {
                    const frameDiscarded = customPlaybackController.notifyFrameDiscarded(
                        decodedFrame
                    );
                    presentationTemporarilyBusy = frameDiscarded
                        && this.presenter.getTelemetry().state === 'initializing';
                    if (!presentationTemporarilyBusy) {
                        this.requestCustomPlaybackFallbackForError(
                            customPlaybackController,
                            this.backendSessionGeneration,
                            new Error('Decoded frame did not reach WebGPU submission')
                        );
                        return;
                    }
                }
                if (frameSubmitted
                    && !customPlaybackController.notifyFramePresented(decodedFrame)) {
                    this.requestCustomPlaybackFallbackForError(
                        customPlaybackController,
                        this.backendSessionGeneration,
                        new Error('Decoded frame did not reach WebGPU submission')
                    );
                    return;
                }
            }
            if (continueWhilePlaying
                && customPlaybackController.playbackState === 'playing') {
                this.scheduleCustomPlaybackFrame(customPlaybackController, true);
            } else if ((!decodedFrame || presentationTemporarilyBusy)
                && customPlaybackController.playbackState === 'paused') {
                // A paused seek still needs to wait for and display its first frame
                this.scheduleCustomPlaybackFrame(customPlaybackController, false);
            }
        });
    }

    private cancelCustomPlaybackFrameCallback(): void {
        const callback = this.customPlaybackFrameCallback;
        this.customPlaybackFrameCallback = null;
        if (callback !== null && typeof globalThis.cancelAnimationFrame === 'function') {
            globalThis.cancelAnimationFrame(callback);
        }
    }

    private readonly handleDecodedPresentationRefresh = (generation: number): void => {
        if (
            generation !== this.presentationGeneration
            || !this.isPresentationSessionCurrent(generation)
            || this.pendingPausedPresentationRefresh !== null
        ) {
            return;
        }

        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (!customPlaybackController || customPlaybackController.playbackState !== 'paused') {
            return;
        }

        const backendGeneration = this.backendSessionGeneration;
        const mediaTimeMicroseconds = customPlaybackController.currentTimeMicroseconds;
        const presentationGeneration = this.advancePresentationGeneration();
        const refresh: PendingPausedPresentationRefresh = {
            backendGeneration,
            controller: customPlaybackController,
            mediaTimeMicroseconds,
            presentationGeneration
        };
        this.pendingPausedPresentationRefresh = refresh;
        this.customPlaybackFrameGeneration = presentationGeneration;
        this.cancelCustomPlaybackFrameCallback();
        this.presenter.seek(presentationGeneration);
        this.presenter.setDecodedFramePushMode(true, presentationGeneration);
        void this.refreshPausedDecodedPresentation(refresh);
    };

    private async refreshPausedDecodedPresentation(
        refresh: PendingPausedPresentationRefresh
    ): Promise<void> {
        try {
            if (!this.isPendingPausedPresentationRefreshCurrent(refresh)) {
                return;
            }

            // The decoder owns transferred frames, so a paused invalidation re-decodes
            // exactly one generation instead of retaining a full-resolution CPU copy
            const result = await refresh.controller.seek(refresh.mediaTimeMicroseconds);
            if (!this.isPendingPausedPresentationRefreshCurrent(refresh)) {
                return;
            }

            this.pendingPausedPresentationRefresh = null;
            this.handleCustomPlaybackStartResult(
                refresh.controller,
                refresh.backendGeneration,
                result
            );
        } catch (error) {
            if (!this.isPendingPausedPresentationRefreshCurrent(refresh)) {
                return;
            }

            this.pendingPausedPresentationRefresh = null;
            this.requestCustomPlaybackFallbackForError(
                refresh.controller,
                refresh.backendGeneration,
                error
            );
        }
    }

    private isPendingPausedPresentationRefreshCurrent(
        refresh: PendingPausedPresentationRefresh
    ): boolean {
        return this.pendingPausedPresentationRefresh === refresh
            && this.presentationGeneration === refresh.presentationGeneration
            && this.customPlaybackFrameGeneration === refresh.presentationGeneration
            && this.isCustomPlaybackCurrent(
                refresh.controller,
                refresh.backendGeneration
            );
    }

    private getCurrentPausedPresentationRefresh(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number
    ): PendingPausedPresentationRefresh | null {
        const refresh = this.pendingPausedPresentationRefresh;
        if (!refresh
            || refresh.controller !== customPlaybackController
            || refresh.backendGeneration !== backendGeneration
            || !this.isPendingPausedPresentationRefreshCurrent(refresh)) {
            return null;
        }

        return refresh;
    }

    private cancelPendingPausedPresentationRefresh(): void {
        this.pendingPausedPresentationRefresh = null;
    }

    private requestCustomPlaybackFallbackForError(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        error: unknown
    ): void {
        const request: CustomPlaybackFallbackRequest = {
            disposition: 'same-session-native',
            generation: 0,
            mediaTimeMicroseconds: customPlaybackController.currentTimeMicroseconds,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        };
        console.warn('Custom playback control failed; using the HTML backend', error);
        void this.requestCustomPlaybackFallback(
            customPlaybackController,
            backendGeneration,
            request
        ).catch((fallbackError: unknown): void => {
            this.emitCustomPlaybackTerminalError(backendGeneration, fallbackError);
        });
    }

    private requestCustomPlaybackFallback(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        request: CustomPlaybackFallbackRequest
    ): Promise<unknown> {
        if (this.customPlaybackFallbackPromise) {
            return this.customPlaybackFallbackPromise;
        }
        if (!this.isCustomPlaybackCurrent(customPlaybackController, backendGeneration)) {
            return Promise.resolve(PLAYBACK_SUPERSEDED);
        }

        const fallbackOperation = this.runCustomPlaybackFallback(
            customPlaybackController,
            backendGeneration,
            request
        );
        const fallbackPromise = fallbackOperation.finally((): void => {
            if (this.customPlaybackFallbackPromise === fallbackPromise) {
                this.customPlaybackFallbackPromise = null;
            }
        });
        this.customPlaybackFallbackPromise = fallbackPromise;
        void fallbackPromise.catch((error: unknown): void => {
            if (this.backendPlayPendingGeneration !== backendGeneration) {
                this.emitCustomPlaybackTerminalError(backendGeneration, error);
            }
        });
        return fallbackPromise;
    }

    private async runCustomPlaybackFallback(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        request: CustomPlaybackFallbackRequest
    ): Promise<unknown> {
        this.customPlaybackRecoveryTimeMicroseconds = request.mediaTimeMicroseconds;
        this.lastKnownTimeMicroseconds = request.mediaTimeMicroseconds;
        this.captureCustomPlaybackTelemetry(customPlaybackController);
        this.clearCustomPlaybackController(customPlaybackController);
        this.webGPUPresentationEnabled = false;
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(backendGeneration);
        await customPlaybackController.destroy();
        await audioPrewarmClose;
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return PLAYBACK_SUPERSEDED;
        }
        const recoveryTimeMicroseconds =
            this.customPlaybackRecoveryTimeMicroseconds ?? request.mediaTimeMicroseconds;
        this.lastKnownTimeMicroseconds = recoveryTimeMicroseconds;

        if (
            request.disposition === 'renegotiate-source'
            || this.currentPlaybackRequiresSourceRenegotiation
        ) {
            const accepted = this.emitCustomPlaybackRenegotiationRequired(
                backendGeneration,
                request.reason
            );
            return accepted ? undefined : PLAYBACK_SUPERSEDED;
        }

        this.htmlPlaybackNormalizationGain = this.customPlaybackNormalizationGain;
        this.applyHTMLPlaybackVolume();
        const nativeOptions = this.createNativeFallbackOptions(
            recoveryTimeMicroseconds
        );
        this.currentPlaybackOptions = nativeOptions;
        try {
            const result = await this.htmlDelegate.player.play(nativeOptions);
            if (!this.isRequestedSessionCurrent(backendGeneration)) {
                return PLAYBACK_SUPERSEDED;
            }
            const latestRecoveryTimeMicroseconds =
                this.customPlaybackRecoveryTimeMicroseconds ?? recoveryTimeMicroseconds;
            if (latestRecoveryTimeMicroseconds !== recoveryTimeMicroseconds) {
                this.htmlDelegate.player.currentTime(
                    microsecondsToMilliseconds(latestRecoveryTimeMicroseconds)
                );
            }
            this.lastKnownTimeMicroseconds = latestRecoveryTimeMicroseconds;
            this.customPlaybackRecoveryTimeMicroseconds = null;
            return result;
        } catch (error) {
            if (this.isRequestedSessionCurrent(backendGeneration)) {
                this.customPlaybackRecoveryTimeMicroseconds = null;
                this.resetHTMLPlaybackNormalization();
            }
            await this.stopFailedNativeFallback(backendGeneration);
            throw error;
        }
    }

    /** Stops a partially started HTML fallback before exposing its terminal error. */
    private async stopFailedNativeFallback(backendGeneration: number): Promise<void> {
        this.htmlDelegate.endSession(backendGeneration);
        try {
            await this.callBackendStop(backendGeneration, false);
        } catch (error) {
            console.warn('Unable to stop failed native fallback cleanly', error);
            this.htmlDelegate.destroy(backendGeneration);
        } finally {
            if (this.ownedBackendSessionGeneration === backendGeneration) {
                this.ownedBackendSessionGeneration = null;
            }
        }
    }

    private createNativeFallbackOptions(
        mediaTimeMicroseconds: Microseconds
    ): PlaybackOptionsRecord {
        if (!this.currentPlaybackOptions
            || typeof this.currentPlaybackOptions !== 'object') {
            throw new TypeError('Custom playback fallback options are unavailable');
        }

        return {
            ...(this.currentPlaybackOptions as PlaybackOptionsRecord),
            playerStartPositionTicks: microsecondsToJellyfinTicks(mediaTimeMicroseconds),
            suppressInitialUnpause: this.customPlaybackHasPlayed
        };
    }

    private updateCustomPlaybackAudioSelection(audioStreamIndex: number): void {
        if (!Number.isSafeInteger(audioStreamIndex) || audioStreamIndex < 0) {
            throw new RangeError('Audio stream index must be a non-negative safe integer');
        }
        if (!this.currentPlaybackOptions
            || typeof this.currentPlaybackOptions !== 'object') {
            return;
        }

        const playbackOptions = this.currentPlaybackOptions as PlaybackOptionsRecord;
        const mediaSource = playbackOptions.mediaSource;
        this.currentPlaybackOptions = {
            ...playbackOptions,
            audioStreamIndex,
            mediaSource: mediaSource && typeof mediaSource === 'object' ? {
                ...(mediaSource as PlaybackOptionsRecord),
                DefaultAudioStreamIndex: audioStreamIndex
            } : mediaSource
        };
        this.currentPlaybackRequiresSourceRenegotiation =
            this.customProfileAugmentationAvailable
            && this.isNonTranscodedSourceOptions(this.currentPlaybackOptions)
            && !this.isCurrentSourceNativeCompatible(this.currentPlaybackOptions);
    }

    private async restartCustomPlaybackForSelectedAudio(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        selectionRevision: number
    ): Promise<void> {
        const eligibility = await this.getCustomPlaybackEligibilityForOptions(
            this.currentPlaybackOptions,
            backendGeneration
        );
        if (!this.isCustomPlaybackAudioSelectionCurrent(
            customPlaybackController,
            backendGeneration,
            selectionRevision
        )) {
            return;
        }
        if (!eligibility?.eligible || eligibility.audioTrackIndex === null) {
            await this.requestCustomPlaybackFallback(
                customPlaybackController,
                backendGeneration,
                {
                    disposition: 'renegotiate-source',
                    generation: 0,
                    mediaTimeMicroseconds: customPlaybackController.currentTimeMicroseconds,
                    preserveHTMLSession: true,
                    reason: 'source-unsupported'
                }
            );
            return;
        }

        const audioSettings = this.customPlaybackAudioSettings;
        if (!audioSettings) {
            throw new Error('Custom playback audio settings snapshot is unavailable');
        }
        const audioOutputMode = eligibility.audioOutputMode ?? 'decoded-pcm';
        const result = await customPlaybackController.setAudioStreamIndex(
            eligibility.audioTrackIndex,
            audioOutputMode,
            selectDecodedAudioOutputChannelCount(
                eligibility,
                this.getCustomPlaybackAudioPrewarm(backendGeneration)?.audioContext ?? null,
                audioSettings.forceStereoDownmix
            ),
            audioOutputMode === 'decoded-pcm' ? audioSettings.downmix : undefined
        );
        if (!this.isCustomPlaybackAudioSelectionCurrent(
            customPlaybackController,
            backendGeneration,
            selectionRevision
        )) {
            return;
        }
        this.handleCustomPlaybackStartResult(
            customPlaybackController,
            backendGeneration,
            result
        );
    }

    private detachCustomPlaybackController(): Promise<void> | null {
        const customPlaybackController = this.customPlaybackController;
        if (!customPlaybackController) {
            this.customPlaybackAudioSettings = null;
            const fallbackPromise = this.customPlaybackFallbackPromise;
            if (fallbackPromise) {
                return fallbackPromise.then(() => undefined, () => undefined);
            }
            return this.customPlaybackStopPromise;
        }

        this.captureCustomPlaybackTelemetry(customPlaybackController);
        this.clearCustomPlaybackController(customPlaybackController);
        const stopPromise = customPlaybackController.destroy().catch((error: unknown): void => {
            console.warn('Unable to destroy custom playback cleanly', error);
        }).finally((): void => {
            if (this.customPlaybackStopPromise === stopPromise) {
                this.customPlaybackStopPromise = null;
            }
        });
        this.customPlaybackStopPromise = stopPromise;
        return stopPromise;
    }

    private captureCustomPlaybackTelemetry(
        customPlaybackController: CustomPlaybackController
    ): void {
        const telemetry = customPlaybackController.getTelemetry();
        this.lastCustomPlaybackTelemetry = telemetry;
        this.lastCustomDecodeTelemetry = telemetry.videoDecode;
    }

    private clearCustomPlaybackController(
        customPlaybackController: CustomPlaybackController
    ): void {
        if (this.customPlaybackController !== customPlaybackController) {
            return;
        }

        this.cancelPendingPausedPresentationRefresh();
        this.cancelCustomPlaybackFrameCallback();
        this.customPlaybackController = null;
        this.customPlaybackAudioSettings = null;
        this.customPlaybackAudioSelectionRevision += 1;
        this.customPlaybackSeekRevision += 1;
        this.customPlaybackBackendGeneration = null;
        this.customPlaybackFrameGeneration = null;
        this.customPlaybackEmitUnpause = false;
    }

    private isCustomPlaybackCurrent(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number
    ): boolean {
        return this.customPlaybackController === customPlaybackController
            && this.customPlaybackBackendGeneration === backendGeneration
            && this.isRequestedSessionCurrent(backendGeneration);
    }

    private isCustomPlaybackAudioSelectionCurrent(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        selectionRevision: number
    ): boolean {
        return this.customPlaybackAudioSelectionRevision === selectionRevision
            && this.isCustomPlaybackCurrent(customPlaybackController, backendGeneration);
    }

    private getActiveCustomPlaybackController(): CustomPlaybackController | null {
        const customPlaybackController = this.customPlaybackController;
        if (!customPlaybackController
            || !this.isCustomPlaybackCurrent(
                customPlaybackController,
                this.backendSessionGeneration
            )) {
            return null;
        }
        return customPlaybackController;
    }

    private isCustomPlaybackPathActive(): boolean {
        return this.customPlaybackStartingGeneration !== null
            || this.getActiveCustomPlaybackController() !== null
            || this.customPlaybackFallbackPromise !== null;
    }

    private hasAuthoritativeHTMLPlaybackSurface(): boolean {
        return this.backendSessionActive
            && this.backendPlayPendingGeneration === null
            && !this.webGPUPresentationEnabled
            && !this.isCustomPlaybackPathActive();
    }

    private getHTMLCustomPlaybackBackend(): HTMLCustomPlaybackContract {
        return this.htmlDelegate.player as unknown as HTMLCustomPlaybackContract;
    }

    private requireJellyfinVolume(value: unknown): number {
        const numericValue = typeof value === 'string' && value.trim() !== '' ?
            Number(value) :
            value;
        if (typeof numericValue !== 'number'
            || !Number.isFinite(numericValue)
            || numericValue < MIN_JELLYFIN_VOLUME
            || numericValue > MAX_JELLYFIN_VOLUME) {
            throw new RangeError('Playback volume must be between zero and one hundred');
        }
        return numericValue;
    }

    private getLinearVolume(value: number): number {
        return (value / MAX_JELLYFIN_VOLUME) ** JELLYFIN_VOLUME_CURVE_EXPONENT;
    }

    private getHTMLPlaybackVolume(value: number): number {
        if (this.htmlPlaybackNormalizationGain === null) {
            return value;
        }
        const normalizedLinearVolume = Math.min(
            this.getLinearVolume(value) * this.htmlPlaybackNormalizationGain,
            1
        );
        return MAX_JELLYFIN_VOLUME
            * normalizedLinearVolume ** (1 / JELLYFIN_VOLUME_CURVE_EXPONENT);
    }

    private applyHTMLPlaybackVolume(): void {
        this.htmlDelegate.player.setVolume(
            this.getHTMLPlaybackVolume(this.customPlaybackVolume)
        );
    }

    private resetHTMLPlaybackNormalization(): void {
        if (this.htmlPlaybackNormalizationGain === null) {
            return;
        }
        this.htmlPlaybackNormalizationGain = null;
        this.htmlDelegate.player.setVolume(this.customPlaybackVolume);
    }

    private emitCustomPlaybackTerminalError(
        backendGeneration: number,
        error: unknown
    ): void {
        if (
            !this.isRequestedSessionCurrent(backendGeneration)
            || this.backendPlayPendingGeneration === backendGeneration
            || this.customPlaybackTerminalErrorGeneration === backendGeneration
        ) {
            return;
        }

        this.customPlaybackTerminalErrorGeneration = backendGeneration;
        console.warn('WebGPU playback fallback failed', error);
        Events.trigger(this, PlayerEvent.Error, [{ type: MediaError.PLAYER_ERROR }]);
    }

    private handleCustomPlaybackTerminalFailure(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        error: unknown
    ): void {
        if (!this.isCustomPlaybackCurrent(customPlaybackController, backendGeneration)) {
            return;
        }

        this.webGPUPresentationEnabled = false;
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
        const customPlaybackStop = this.detachCustomPlaybackController();
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(backendGeneration);
        void Promise.all([
            customPlaybackStop ?? Promise.resolve(),
            audioPrewarmClose ?? Promise.resolve()
        ]).then((): void => {
            this.emitCustomPlaybackTerminalError(backendGeneration, error);
        });
    }

    private emitCustomPlaybackRenegotiationRequired(
        backendGeneration: number,
        reason: CustomPlaybackFallbackRequest['reason']
    ): boolean {
        if (
            !this.isRequestedSessionCurrent(backendGeneration)
            || this.customPlaybackTerminalErrorGeneration === backendGeneration
        ) {
            return false;
        }

        const mediaError = reason === 'network-failed' ?
            MediaError.NETWORK_ERROR :
            MediaError.MEDIA_NOT_SUPPORTED;
        let accepting = true;
        let accepted = false;
        const request: SourceRenegotiationRequest = {
            accept: (): void => {
                if (accepting) {
                    accepted = true;
                }
            },
            errorType: mediaError,
            reason
        };

        Events.trigger(this, PlayerEvent.SourceRenegotiationRequired, [request]);
        accepting = false;
        this.customPlaybackTerminalErrorGeneration = backendGeneration;
        if (accepted) {
            return true;
        }

        // Older controllers use the generic error contract for source retries.
        Events.trigger(this, PlayerEvent.Error, [{ type: mediaError }]);
        return false;
    }

    private readonly handlePresentationFallback = (
        generation: number,
        reason: PresentationFallbackReason
    ): void => {
        if (generation !== this.presentationGeneration) {
            return;
        }

        const customPlaybackController = this.getActiveCustomPlaybackController();
        this.webGPUPresentationEnabled = false;
        this.cancelPendingPausedPresentationRefresh();
        this.advancePresentationGeneration();
        if (customPlaybackController) {
            const request: CustomPlaybackFallbackRequest = {
                disposition: 'same-session-native',
                generation: 0,
                mediaTimeMicroseconds: customPlaybackController.currentTimeMicroseconds,
                preserveHTMLSession: true,
                reason: 'lifecycle-failed'
            };
            console.warn(`Custom playback presentation failed: ${reason}`);
            void this.requestCustomPlaybackFallback(
                customPlaybackController,
                this.backendSessionGeneration,
                request
            );
        }
    };

    private readonly handleBackendStopped = (generation: number): void => {
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(generation);
        if (audioPrewarmClose) {
            void audioPrewarmClose;
        }
        if (this.ownedBackendSessionGeneration === generation) {
            this.ownedBackendSessionGeneration = null;
        }

        if (!this.backendSessionActive || this.backendSessionGeneration !== generation) {
            return;
        }

        void this.detachCustomPlaybackController();
        this.backendSessionActive = false;
        this.webGPUPresentationEnabled = false;
        this.currentPlaybackOptions = null;
        this.currentDolbyVisionPresentationDescriptor = null;
        this.currentPresentationColorMetadata = null;
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
    };

    private readonly handleBackendError = (generation: number): void => {
        const audioPrewarmClose = this.closeCustomPlaybackAudioPrewarm(generation);
        if (audioPrewarmClose) {
            void audioPrewarmClose;
        }
        if (!this.backendSessionActive || this.backendSessionGeneration !== generation) {
            return;
        }

        void this.detachCustomPlaybackController();
        this.backendSessionActive = false;
        this.webGPUPresentationEnabled = false;
        this.currentPlaybackOptions = null;
        this.currentDolbyVisionPresentationDescriptor = null;
        this.currentPresentationColorMetadata = null;
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
    };

    private async stopOwnedBackendForReplacement(nextGeneration: number): Promise<void> {
        const ownedGeneration = this.ownedBackendSessionGeneration;
        if (ownedGeneration == null || ownedGeneration === nextGeneration) {
            return;
        }

        this.htmlDelegate.endSession(ownedGeneration);
        try {
            await this.callBackendStop(ownedGeneration, false);
        } catch (error) {
            console.warn('Reusable HTML player stop failed; destroying it before replacement', error);
            this.htmlDelegate.destroy(ownedGeneration);
        } finally {
            if (this.ownedBackendSessionGeneration === ownedGeneration) {
                this.ownedBackendSessionGeneration = null;
            }
        }
    }

    private callBackendStop(generation: number, destroyPlayer: boolean): Promise<unknown> {
        this.beginBackendStopCall();
        try {
            return this.htmlDelegate.stop(generation, destroyPlayer);
        } finally {
            this.endBackendStopCall();
        }
    }

    private beginBackendStopCall(): void {
        if (this.backendStopCallDepth === 0) {
            let releaseBackendStopCall: () => void = () => undefined;
            this.backendStopCallBarrier = new Promise<void>(resolve => {
                releaseBackendStopCall = resolve;
            });
            this.releaseBackendStopCall = releaseBackendStopCall;
        }

        this.backendStopCallDepth += 1;
    }

    private endBackendStopCall(): void {
        this.backendStopCallDepth -= 1;
        if (this.backendStopCallDepth > 0) {
            return;
        }

        const releaseBackendStopCall = this.releaseBackendStopCall;
        this.backendStopCallBarrier = null;
        this.releaseBackendStopCall = null;
        releaseBackendStopCall?.();
    }

    private enqueueBackendOperation<Result>(
        operation: () => PromiseLike<Result> | Result
    ): Promise<Result> {
        const previousTail = this.backendOperationTail;
        let releaseOperation: () => void = () => undefined;
        const operationTail = new Promise<void>(resolve => {
            releaseOperation = resolve;
        });
        this.backendOperationTail = operationTail;

        let operationPromise: Promise<Result>;
        if (previousTail) {
            operationPromise = previousTail.then(operation);
        } else {
            try {
                operationPromise = Promise.resolve(operation());
            } catch (error) {
                operationPromise = Promise.reject(error);
            }
        }

        const finishOperation = (): void => {
            releaseOperation();
            if (this.backendOperationTail === operationTail) {
                this.backendOperationTail = null;
            }
        };
        void operationPromise.then(finishOperation, finishOperation);
        return operationPromise;
    }

    private trackBackendStop(stopPromise: Promise<unknown>): void {
        this.pendingBackendStopPromises.add(stopPromise);
        const removeStopPromise = (): void => {
            this.pendingBackendStopPromises.delete(stopPromise);
        };
        void stopPromise.then(removeStopPromise, removeStopPromise);
    }

    private async waitForPendingBackendStops(): Promise<void> {
        const pendingStopPromises = Array.from(this.pendingBackendStopPromises);
        if (pendingStopPromises.length === 0) {
            return;
        }

        await Promise.allSettled(pendingStopPromises);
    }

    private incrementPendingStopCount(generation: number): void {
        const pendingStopCount = this.pendingStopCounts.get(generation) ?? 0;
        this.pendingStopCounts.set(generation, pendingStopCount + 1);
    }

    private decrementPendingStopCount(generation: number): void {
        const pendingStopCount = this.pendingStopCounts.get(generation) ?? 0;
        if (pendingStopCount <= 1) {
            this.pendingStopCounts.delete(generation);
            return;
        }

        this.pendingStopCounts.set(generation, pendingStopCount - 1);
    }

    private isRequestedSessionCurrent(generation: number): boolean {
        return this.backendSessionActive && this.backendSessionGeneration === generation;
    }

    private isCustomPlaybackSetupCurrent(
        backendGeneration: number,
        setupRevision: number
    ): boolean {
        return this.customPlaybackSetupRevision === setupRevision
            && this.isRequestedSessionCurrent(backendGeneration);
    }

    private rememberNativeDeviceProfile(item: unknown, profile: DeviceProfile): void {
        const itemKey = getItemKey(item);
        if (!itemKey) {
            this.pendingNativeDeviceProfileProof = null;
            return;
        }
        const proof: NativeDeviceProfileProof = {
            generation: null,
            itemKey,
            profile
        };
        this.pendingNativeDeviceProfileProof = proof;
        if (this.currentNativeDeviceProfileProof?.itemKey === itemKey) {
            this.currentNativeDeviceProfileProof = {
                ...proof,
                generation: this.backendSessionGeneration
            };
        }
    }

    private consumeNativeDeviceProfileProof(
        options: unknown,
        generation: number
    ): NativeDeviceProfileProof | null {
        const pendingProof = this.pendingNativeDeviceProfileProof;
        this.pendingNativeDeviceProfileProof = null;
        if (!pendingProof || pendingProof.itemKey !== getPlaybackItemKey(options)) {
            return null;
        }
        return {
            ...pendingProof,
            generation
        };
    }

    private isCurrentSourceNativeCompatible(options: unknown): boolean {
        const proof = this.currentNativeDeviceProfileProof;
        return proof !== null
            && proof.generation === this.backendSessionGeneration
            && proof.itemKey === getPlaybackItemKey(options)
            && isSameSessionNativePlaybackCompatible(options, proof.profile);
    }

    private isDeviceProfileRetry(options: unknown): boolean {
        return Boolean(
            options
            && typeof options === 'object'
            && (options as DeviceProfileRequestOptions).isRetry === true
        );
    }

    /** Prewarms only the HDR presentation families relevant to the requested item. */
    private async prewarmHDRDeviceProfileRoutes(
        probeScope: HDRDeviceProfileProbeScope
    ): Promise<void> {
        switch (probeScope) {
            case 'static-hdr':
                await this.presenter.waitForExternalHDRAuthorizationPrewarm();
                if (this.presenter.getAuthorizedExternalHDRRouteKeys().length === 0) {
                    await this.presenter.waitForRawHDRAuthorizationPrewarm();
                }
                break;
            case 'dolby-vision':
                await this.presenter.waitForDolbyVisionAuthorizationPrewarm();
                break;
            case 'dolby-vision-profile7':
            case 'dolby-vision-profile8-hdr10-base':
                await Promise.all([
                    this.presenter.waitForExternalHDRAuthorizationPrewarm(),
                    this.presenter.waitForDolbyVisionAuthorizationPrewarm()
                ]);
                break;
            case 'none':
                break;
            case 'unknown':
                await Promise.all([
                    this.presenter.waitForExternalHDRAuthorizationPrewarm(),
                    this.presenter.waitForRawHDRAuthorizationPrewarm(),
                    this.presenter.waitForDolbyVisionAuthorizationPrewarm()
                ]);
                break;
        }
    }

    /** Returns only the HDR routes authorized on the present GPU device. */
    private async getHDRDeviceProfileOptions(
        item: unknown,
        isRetry: boolean
    ): Promise<CustomDeviceProfileOptions> {
        const HDRToneMappingEnabled = !isRetry && await getWebGPUHDRToneMappingEnabled();
        const probeScope = getHDRDeviceProfileProbeScope(item);
        if (HDRToneMappingEnabled) {
            await this.prewarmHDRDeviceProfileRoutes(probeScope);
        }
        const externalHDRProbed = probeScope === 'static-hdr'
            || probeScope === 'dolby-vision-profile7'
            || probeScope === 'dolby-vision-profile8-hdr10-base'
            || probeScope === 'unknown';
        const rawHDRProbed = probeScope === 'static-hdr' || probeScope === 'unknown';
        const DolbyVisionProbed = probeScope === 'dolby-vision'
            || probeScope === 'dolby-vision-profile7'
            || probeScope === 'dolby-vision-profile8-hdr10-base'
            || probeScope === 'unknown';
        const authorizedExternalHDRRouteKeys = HDRToneMappingEnabled && externalHDRProbed ?
            this.presenter.getAuthorizedExternalHDRRouteKeys() :
            [];
        const authorizedRawHDRRouteKeys = HDRToneMappingEnabled
            && rawHDRProbed
            && authorizedExternalHDRRouteKeys.length === 0 ?
            this.presenter.getAuthorizedRawHDRRouteKeys() :
            [];
        const allowDolbyVisionProfile7 = HDRToneMappingEnabled
            && DolbyVisionProbed
            && this.presenter.isRawDolbyVisionProfile7PresentationAuthorized();
        const allowNativeDolbyVisionProfile7HDR10Base = HDRToneMappingEnabled
            && probeScope === 'dolby-vision-profile7'
            && hasExactProfile7HDR10BaseSource(item)
            && hasAuthorizedDolbyVisionHDR10BaseRoute(authorizedExternalHDRRouteKeys);
        const allowNativeDolbyVisionProfile8HDR10Base = HDRToneMappingEnabled
            && probeScope === 'dolby-vision-profile8-hdr10-base'
            && hasExactProfile8HDR10BaseSource(item)
            && hasAuthorizedDolbyVisionHDR10BaseRoute(authorizedExternalHDRRouteKeys);
        return {
            allowDolbyVision: HDRToneMappingEnabled
                && DolbyVisionProbed
                && this.presenter.isRawDolbyVisionPresentationAuthorized(),
            allowDolbyVisionProfile7,
            ...(allowDolbyVisionProfile7 && hasExactSeparateProfile7Source(item) ? {
                allowDolbyVisionProfile7HDR10Base: true
            } : {}),
            allowNativeDolbyVision: HDRToneMappingEnabled
                && DolbyVisionProbed
                && this.presenter.isExternalDolbyVisionPresentationAuthorized(),
            ...(allowNativeDolbyVisionProfile7HDR10Base ? {
                allowNativeDolbyVisionProfile7HDR10Base: true
            } : {}),
            ...(allowNativeDolbyVisionProfile8HDR10Base ? {
                allowNativeDolbyVisionProfile8HDR10Base: true
            } : {}),
            allowNativeHDR: authorizedExternalHDRRouteKeys.length > 0,
            allowRawHDR: authorizedRawHDRRouteKeys.length > 0,
            authorizedExternalHDRRouteKeys,
            authorizedRawHDRRouteKeys
        };
    }

    private isNonTranscodedSourceOptions(options: unknown): boolean {
        if (!options || typeof options !== 'object') {
            return false;
        }
        const playMethod = normalizeStreamType(
            (options as PlaybackOptionsRecord).playMethod
        );
        return playMethod === 'DIRECTPLAY' || playMethod === 'DIRECTSTREAM';
    }

    private isPresentationSessionCurrent(generation: number): boolean {
        return this.backendSessionActive
            && this.webGPUPresentationEnabled
            && this.presentationGeneration === generation;
    }

    private advancePresentationGeneration(): number {
        if (this.presentationGeneration === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('WebGPU player generation exhausted');
        }

        this.presentationGeneration += 1;
        return this.presentationGeneration;
    }
}
