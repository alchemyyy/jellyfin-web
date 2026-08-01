import type { DeviceProfile } from '@jellyfin/sdk/lib/generated-client/models/device-profile';

import { PluginType } from 'constants/pluginType';
import { PLAYBACK_SUPERSEDED } from 'constants/playbackResult';
import {
    getWebGPUCustomDecodeEnabled,
    isWebGPUCustomDecodeEnabled
} from 'scripts/settings/webSettings';
import Events from 'utils/events';

import { HTMLPlayerDelegate } from './HTMLPlayerDelegate';
import {
    microsecondsToJellyfinTicks,
    microsecondsToMilliseconds,
    millisecondsToMicroseconds,
    type Microseconds
} from './MediaTime';
import {
    getPresentationInputColorMetadata,
    isKnownSDRPresentationInput
} from './PresentationInput';
import {
    createDefaultRenderSettings,
    createHDRToSDRRenderSettings,
    type HDRToSDRRenderSettings,
    type RenderSettings
} from './RenderSettings';
import type { InputColorMetadata } from './color/ColorMetadata';
import {
    prewarmBrowserAudioContext,
    type BrowserAudioContextPrewarmLease
} from './custom/BrowserAudioContextPrewarm';
import {
    getCustomPlaybackEligibility,
    type CustomPlaybackEligibility
} from './custom/CustomPlaybackEligibility';
import {
    type CustomDecodeCapabilities,
    probeCustomDecodeCapabilities
} from './custom/CustomDecodeCapabilities';
import type CustomPlaybackController from './custom/CustomPlaybackController';
import type {
    CustomAudioOutputFactory,
    CustomPlaybackControllerEvent,
    CustomPlaybackFallbackRequest,
    CustomPlaybackStartResult,
    CustomPlaybackTelemetry
} from './custom/CustomPlaybackControllerTypes';
import type { CustomDecodeSessionTelemetry } from './custom/CustomDecodeSession';
import {
    augmentDeviceProfileForCustomDecode,
    type CustomDeviceProfileTelemetry
} from './custom/CustomDeviceProfile';
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
import type { MediabunnyReferenceFrameProviderOptions } from './validation/MediabunnyReferenceFrameProvider';
import type {
    ExternalTextureReferenceFrameRequest,
    WebGPUExternalTextureValidationRequest,
    WebGPUExternalTextureValidationRunner
} from './validation/WebGPUExternalTextureValidationRunner';

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

export type WebGPUPlayerColorValidationRequest = Omit<
    WebGPUExternalTextureValidationRequest,
    'device'
>;

export type WebGPUPlayerColorValidationMediaRequest = Omit<
    WebGPUPlayerColorValidationRequest,
    'getFrame'
> & MediabunnyReferenceFrameProviderOptions;

const CUSTOM_VOLUME_STEP = 2;
const MAX_JELLYFIN_VOLUME = 100;
const MIN_JELLYFIN_VOLUME = 0;

function normalizeStreamType(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalizedValue = value.trim().toUpperCase();
    return normalizedValue || null;
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

    return Number.isSafeInteger(selectedAudioStream.sampleRate)
        && Number(selectedAudioStream.sampleRate) > 0 ?
        Number(selectedAudioStream.sampleRate) :
        null;
}

/**
 * Jellyfin-facing player that owns the HTML player as its playback backend.
 * WebGPU presentation is optional and must never replace backend playback.
 */
export default class WebGPUPlayer {
    name = 'WebGPU Video Player';
    type = PluginType.MediaPlayer;
    id = 'webgpuvideoplayer';
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
    private customPlaybackBackendGeneration: number | null = null;
    private customPlaybackAudioPrewarm: CustomPlaybackAudioPrewarm | null = null;
    private customPlaybackFallbackPromise: Promise<unknown> | null = null;
    private customPlaybackFrameCallback: number | null = null;
    private customPlaybackFrameGeneration: number | null = null;
    private customPlaybackHasPlayed = false;
    private customPlaybackStartingGeneration: number | null = null;
    private customPlaybackStopPromise: Promise<void> | null = null;
    private customPlaybackTerminalErrorGeneration: number | null = null;
    private customPlaybackEmitUnpause = false;
    private customPlaybackVolume = MAX_JELLYFIN_VOLUME;
    private customPlaybackMuted = false;
    private currentPlaybackOptions: unknown = null;
    private currentPresentationColorMetadata: InputColorMetadata | null = null;
    private colorValidationDecision: ColorValidationCapabilityDecision | null = null;
    private colorValidationDevice: GPUDevice | null = null;
    private colorValidationRunner: WebGPUExternalTextureValidationRunner | null = null;
    private lastCustomDecodeCapabilities: CustomDecodeCapabilities | null = null;
    private lastCustomDecodeTelemetry: CustomDecodeSessionTelemetry | null = null;
    private lastCustomPlaybackEligibility: CustomPlaybackEligibility | null = null;
    private lastCustomPlaybackTelemetry: CustomPlaybackTelemetry | null = null;
    private lastCustomDeviceProfileTelemetry: CustomDeviceProfileTelemetry | null = null;
    private lastCustomPlaybackRuntimeAvailability: CustomPlaybackRuntimeAvailability | null = null;
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
        this.presenter = new WebGPUPresenter(this.handlePresentationFallback);
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

    /** Synchronously reports media-type compatibility for player selection. */
    canPlayMediaType = (mediaType: string | null | undefined): boolean => {
        const backend = this.htmlDelegate.player as unknown as HTMLPlayerSelectionContract;
        return backend.canPlayMediaType(mediaType);
    };

    /** Synchronously preserves the optional HTML backend item check. */
    canPlayItem(item: unknown, playOptions?: unknown): boolean {
        const backend = this.htmlDelegate.player as BackendPlayer & OptionalItemCompatibility;
        return backend.canPlayItem?.(item, playOptions) ?? true;
    }

    supportsPlayMethod(playMethod: string, item: unknown): boolean {
        const backend = this.htmlDelegate.player as unknown as HTMLPlayerSelectionContract;
        return backend.supportsPlayMethod(playMethod, item);
    }

    async getDeviceProfile(item: unknown, options?: unknown): Promise<unknown> {
        const backend = this.htmlDelegate.player as unknown as HTMLPlayerSelectionContract;
        const profile = await backend.getDeviceProfile(item, options);
        if (!await getWebGPUCustomDecodeEnabled()) {
            this.lastCustomDecodeCapabilities = null;
            this.lastCustomDeviceProfileTelemetry = null;
            this.lastCustomPlaybackRuntimeAvailability = null;
            return profile;
        }

        const runtimeAvailability = getCustomPlaybackRuntimeAvailability();
        this.lastCustomPlaybackRuntimeAvailability = runtimeAvailability;
        if (!runtimeAvailability.available) {
            this.lastCustomDecodeCapabilities = null;
            this.lastCustomDeviceProfileTelemetry = null;
            return profile;
        }

        const capabilities = await probeCustomDecodeCapabilities();
        const profileResult = augmentDeviceProfileForCustomDecode(
            profile as DeviceProfile,
            capabilities,
            { isRetry: this.isDeviceProfileRetry(options) }
        );
        this.lastCustomDecodeCapabilities = capabilities;
        this.lastCustomDeviceProfileTelemetry = profileResult.telemetry;
        return profileResult.profile;
    }

    supports(feature: string): boolean {
        switch (feature) {
            case 'AirPlay':
            case 'PictureInPicture':
            case 'PlaybackRate':
            case 'SetBrightness':
                return false;
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
        this.backendSessionActive = false;
        this.webGPUPresentationEnabled = false;
        this.currentPlaybackOptions = null;
        this.currentPresentationColorMetadata = null;
        this.htmlDelegate.endSession(pendingGeneration);
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
    }

    play(options: unknown): Promise<unknown> {
        this.cancelPendingPlay();
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
        this.backendPlayPendingGeneration = generation;
        this.customPlaybackFallbackPromise = null;
        this.customPlaybackHasPlayed = false;
        this.customPlaybackStartingGeneration = null;
        this.customPlaybackTerminalErrorGeneration = null;
        this.lastCustomDecodeTelemetry = null;
        this.lastCustomPlaybackEligibility = null;
        this.lastCustomPlaybackTelemetry = null;
        this.currentPlaybackOptions = options;
        this.startCustomPlaybackAudioPrewarm(options, generation);
        this.currentPresentationColorMetadata = getPresentationInputColorMetadata(options);
        const validatedHDRPresentation = this.currentPresentationColorMetadata?.transfer !== 'sdr'
            && this.hasCurrentColorValidation();
        this.webGPUPresentationEnabled = isKnownSDRPresentationInput(options)
            || validatedHDRPresentation;
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
        const customPlaybackStop = this.detachCustomPlaybackController();
        this.backendSessionActive = false;
        this.webGPUPresentationEnabled = false;
        this.currentPlaybackOptions = null;
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
        void this.detachCustomPlaybackController();
        this.backendSessionActive = false;
        this.webGPUPresentationEnabled = false;
        this.currentPlaybackOptions = null;
        this.currentPresentationColorMetadata = null;
        const sessionGeneration = this.backendSessionGeneration;
        const invalidatedGeneration = this.advancePresentationGeneration();
        this.presenter.endSession(invalidatedGeneration);
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
            if (isWebGPUCustomDecodeEnabled()) {
                const customPlaybackResult = await this.tryStartCustomPlayback(
                    options,
                    generation
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
            this.currentPresentationColorMetadata = null;
            const invalidatedGeneration = this.advancePresentationGeneration();
            this.presenter.endSession(invalidatedGeneration);
            throw error;
        }
    }

    currentTime(value?: number): number | undefined {
        if (value != null) {
            const requestedTimeMicroseconds = millisecondsToMicroseconds(value);
            this.lastKnownTimeMicroseconds = requestedTimeMicroseconds;
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
                    this.handleCustomPlaybackStartResult(
                        customPlaybackController,
                        this.backendSessionGeneration,
                        result
                    );
                }).catch((error: unknown): void => {
                    this.requestCustomPlaybackFallbackForError(
                        customPlaybackController,
                        this.backendSessionGeneration,
                        error
                    );
                });
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
            this.updateCustomPlaybackAudioSelection(index);
            void Promise.resolve().then(() => (
                customPlaybackController.setAudioStreamIndex(index)
            )).then(result => {
                this.handleCustomPlaybackStartResult(
                    customPlaybackController,
                    this.backendSessionGeneration,
                    result
                );
            }).catch((error: unknown): void => {
                this.requestCustomPlaybackFallbackForError(
                    customPlaybackController,
                    this.backendSessionGeneration,
                    error
                );
            });
            return;
        }
        this.htmlDelegate.player.setAudioStreamIndex(index);
    }

    setVolume(value: number): void {
        this.customPlaybackVolume = this.requireJellyfinVolume(value);
        this.htmlDelegate.player.setVolume(value);
        const customPlaybackController = this.getActiveCustomPlaybackController();
        if (customPlaybackController) {
            customPlaybackController.setVolume(this.getLinearVolume(value));
        }
    }

    getVolume(): number | undefined {
        if (this.getActiveCustomPlaybackController()) {
            return this.customPlaybackVolume;
        }
        return this.htmlDelegate.player.getVolume();
    }

    volumeUp(): void {
        if (this.getActiveCustomPlaybackController()) {
            this.setVolume(Math.min(
                this.customPlaybackVolume + CUSTOM_VOLUME_STEP,
                MAX_JELLYFIN_VOLUME
            ));
            return;
        }
        this.htmlDelegate.player.volumeUp();
    }

    volumeDown(): void {
        if (this.getActiveCustomPlaybackController()) {
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
        if (this.getActiveCustomPlaybackController()) {
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

    /** Applies live HDR display controls without rebuilding the shader pipeline. */
    updateRenderSettings(settings: HDRToSDRRenderSettings): boolean {
        return this.presenter.updateRenderSettings(
            settings,
            this.presentationGeneration
        );
    }

    /** Returns a detached renderer-settings snapshot for diagnostics and UI. */
    getRenderSettings(): RenderSettings {
        return this.presenter.getRenderSettings();
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

    /** Returns the last full-pipeline eligibility decision. */
    getCustomPlaybackEligibility(): CustomPlaybackEligibility | null {
        return this.lastCustomPlaybackEligibility ?
            { ...this.lastCustomPlaybackEligibility } :
            null;
    }

    /** Returns the last custom-codec capability snapshot used for negotiation. */
    getCustomDecodeCapabilities(): CustomDecodeCapabilities | null {
        return this.lastCustomDecodeCapabilities;
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

        const presentationSurface = this.htmlDelegate.player.getPresentationSurface();
        if (!presentationSurface) {
            return;
        }

        const generation = this.presentationGeneration;
        this.presenter.attach(presentationSurface, generation);
        void this.configurePresentationColorPipeline(generation).then(configured => {
            if (!configured && this.isRequestedSessionCurrent(this.backendSessionGeneration)) {
                console.warn('WebGPU presentation returned to the native video surface');
            }
        });
    }

    private configurePresentationColorPipeline(generation: number): Promise<boolean> {
        const metadata = this.currentPresentationColorMetadata;
        if (!metadata) {
            return Promise.resolve(false);
        }
        if (metadata.transfer === 'sdr') {
            return this.presenter.configureColorPipeline({
                settings: createDefaultRenderSettings()
            }, generation);
        }

        return this.presenter.configureColorPipeline({
            metadata,
            settings: createHDRToSDRRenderSettings({
                toneMapping: { inputPeakNits: metadata.nominalPeakNits }
            }),
            validation: this.colorValidationDecision,
            validationDevice: this.colorValidationDevice
        }, generation);
    }

    private startCustomPlaybackAudioPrewarm(options: unknown, backendGeneration: number): void {
        if (!isWebGPUCustomDecodeEnabled()) {
            return;
        }

        const sampleRate = getSelectedAudioSampleRate(options);
        if (sampleRate === null) {
            return;
        }

        try {
            this.customPlaybackAudioPrewarm = {
                backendGeneration,
                lease: prewarmBrowserAudioContext(sampleRate)
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
        backendGeneration: number
    ): BrowserAudioContextPrewarmLease | null {
        if (audioTrackIndex !== null) {
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

    private async tryStartCustomPlayback(
        options: unknown,
        backendGeneration: number
    ): Promise<CustomPlaybackAttemptResult> {
        const eligibility = await this.getCustomPlaybackEligibilityForOptions(
            options,
            backendGeneration
        );
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return { status: 'superseded' };
        }
        if (!eligibility?.eligible || !this.webGPUPresentationEnabled) {
            return { status: 'native-required' };
        }

        const audioPrewarm = this.getCustomPlaybackAudioPrewarmForTrack(
            eligibility.audioTrackIndex,
            backendGeneration
        );

        this.customPlaybackStartingGeneration = backendGeneration;
        let completedStartResult: CustomPlaybackStartResult | null = null;
        try {
            const [ controllerModule, audioOutputModule ] = await Promise.all([
                import(
                    /* webpackChunkName: "webgpu-custom-playback" */
                    './custom/CustomPlaybackController'
                ),
                import(
                    /* webpackChunkName: "webgpu-custom-playback" */
                    './custom/BrowserCustomAudioOutput'
                )
            ]);
            if (!this.isRequestedSessionCurrent(backendGeneration)) {
                return { status: 'superseded' };
            }

            const htmlBackend = this.getHTMLCustomPlaybackBackend();
            const presentationSurface = await htmlBackend.prepareCustomPlayback(options);
            if (!this.isRequestedSessionCurrent(backendGeneration)) {
                return { status: 'superseded' };
            }
            if (!presentationSurface || presentationSurface === PLAYBACK_SUPERSEDED) {
                return presentationSurface === PLAYBACK_SUPERSEDED ?
                    { status: 'superseded' } :
                    { status: 'native-required' };
            }

            const presentationGeneration = this.presentationGeneration;
            this.presenter.setDecodedFramePushMode(true, presentationGeneration);
            this.presenter.attach(presentationSurface, presentationGeneration);
            const colorPipelineConfigured = await this.configurePresentationColorPipeline(
                presentationGeneration
            );
            if (!this.isRequestedSessionCurrent(backendGeneration)) {
                return { status: 'superseded' };
            }
            if (!colorPipelineConfigured || !this.webGPUPresentationEnabled) {
                return { status: 'native-required' };
            }

            const controllerReference: { controller: CustomPlaybackController | null } = {
                controller: null
            };
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
                }
            });
            controllerReference.controller = customPlaybackController;
            this.customPlaybackController = customPlaybackController;
            this.customPlaybackBackendGeneration = backendGeneration;
            this.customPlaybackFrameGeneration = presentationGeneration;
            this.customPlaybackEmitUnpause = true;
            this.initializeCustomPlaybackGain(customPlaybackController);

            const startResult = await customPlaybackController.play({
                audioTrackIndex: eligibility.audioTrackIndex,
                durationMicroseconds: eligibility.durationMicroseconds,
                startTimeMicroseconds: eligibility.startTimeMicroseconds,
                url: eligibility.url,
                videoTrackIndex: eligibility.videoTrackIndex
            });
            if (!this.isRequestedSessionCurrent(backendGeneration)) {
                return { status: 'superseded' };
            }
            this.handleCustomPlaybackStartResult(
                customPlaybackController,
                backendGeneration,
                startResult
            );
            completedStartResult = startResult;
        } catch (error) {
            if (!this.isRequestedSessionCurrent(backendGeneration)) {
                return { status: 'superseded' };
            }
            console.warn('Custom playback startup failed; using the HTML backend', error);
            await this.detachCustomPlaybackController();
            return { status: 'native-required' };
        } finally {
            if (this.customPlaybackStartingGeneration === backendGeneration) {
                this.customPlaybackStartingGeneration = null;
            }
        }

        if (!completedStartResult) {
            return { status: 'native-required' };
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
                    return { status: 'native-required' };
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
        const capabilities = this.lastCustomDecodeCapabilities
            ?? await probeCustomDecodeCapabilities();
        if (!this.isRequestedSessionCurrent(backendGeneration)) {
            return null;
        }

        this.lastCustomDecodeCapabilities = capabilities;
        const metadata = this.currentPresentationColorMetadata;
        const eligibility = getCustomPlaybackEligibility(options, capabilities, {
            allowHDR: metadata?.transfer !== 'sdr'
                && this.hasCurrentColorValidation(),
            runtimeAvailability
        });
        this.lastCustomPlaybackEligibility = eligibility;
        return eligibility;
    }

    private initializeCustomPlaybackGain(
        customPlaybackController: CustomPlaybackController
    ): void {
        const backendVolume = this.htmlDelegate.player.getVolume();
        if (typeof backendVolume === 'number'
            && Number.isFinite(backendVolume)
            && backendVolume >= MIN_JELLYFIN_VOLUME
            && backendVolume <= MAX_JELLYFIN_VOLUME) {
            this.customPlaybackVolume = backendVolume;
        }
        this.customPlaybackMuted = this.htmlDelegate.player.isMuted();
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
            case 'statechange':
                if (event.state === 'paused') {
                    this.cancelCustomPlaybackFrameCallback();
                    htmlBackend.notifyCustomPlaybackPaused();
                    this.scheduleCustomPlaybackFrame(customPlaybackController, false);
                } else if (event.state === 'playing') {
                    this.customPlaybackEmitUnpause = event.previousState === 'paused'
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
                htmlBackend.notifyCustomPlaybackWaiting();
                break;
            case 'ended':
                this.cancelCustomPlaybackFrameCallback();
                htmlBackend.notifyCustomPlaybackEnded();
                break;
            case 'error':
                console.warn('Custom playback pipeline error', event.message);
                if (!event.recoverable) {
                    this.emitCustomPlaybackTerminalError(
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
            if (decodedFrame) {
                const frameSubmitted = this.presenter.presentDecodedFrame(
                    decodedFrame,
                    generation
                );
                if (!frameSubmitted
                    || !customPlaybackController.notifyFramePresented(decodedFrame)) {
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
            } else if (!decodedFrame
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

    private requestCustomPlaybackFallbackForError(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        error: unknown
    ): void {
        const request: CustomPlaybackFallbackRequest = {
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

        const fallbackPromise = this.runCustomPlaybackFallback(
            customPlaybackController,
            backendGeneration,
            request
        );
        this.customPlaybackFallbackPromise = fallbackPromise;
        void fallbackPromise.catch((error: unknown): void => {
            if (this.backendPlayPendingGeneration !== backendGeneration) {
                this.emitCustomPlaybackTerminalError(backendGeneration, error);
            }
        }).finally((): void => {
            if (this.customPlaybackFallbackPromise === fallbackPromise) {
                this.customPlaybackFallbackPromise = null;
            }
        });
        return fallbackPromise;
    }

    private async runCustomPlaybackFallback(
        customPlaybackController: CustomPlaybackController,
        backendGeneration: number,
        request: CustomPlaybackFallbackRequest
    ): Promise<unknown> {
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

        const nativeOptions = this.createNativeFallbackOptions(
            request.mediaTimeMicroseconds
        );
        this.currentPlaybackOptions = nativeOptions;
        return this.htmlDelegate.player.play(nativeOptions);
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
    }

    private detachCustomPlaybackController(): Promise<void> | null {
        const customPlaybackController = this.customPlaybackController;
        if (!customPlaybackController) {
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

        this.cancelCustomPlaybackFrameCallback();
        this.customPlaybackController = null;
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

    private getHTMLCustomPlaybackBackend(): HTMLCustomPlaybackContract {
        return this.htmlDelegate.player as unknown as HTMLCustomPlaybackContract;
    }

    private requireJellyfinVolume(value: number): number {
        if (!Number.isFinite(value)
            || value < MIN_JELLYFIN_VOLUME
            || value > MAX_JELLYFIN_VOLUME) {
            throw new RangeError('Playback volume must be between zero and one hundred');
        }
        return value;
    }

    private getLinearVolume(value: number): number {
        return (value / MAX_JELLYFIN_VOLUME) ** 3;
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
        Events.trigger(this, 'error', [error]);
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
        this.advancePresentationGeneration();
        if (customPlaybackController) {
            const request: CustomPlaybackFallbackRequest = {
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

    private hasCurrentColorValidation(): boolean {
        const decision = this.colorValidationDecision;
        return decision?.capability === 'supported'
            && decision.classification === 'valid'
            && decision.validation?.accepted === true
            && this.presenter.isValidationDevice(this.colorValidationDevice);
    }

    private isDeviceProfileRetry(options: unknown): boolean {
        return Boolean(
            options
            && typeof options === 'object'
            && (options as DeviceProfileRequestOptions).isRetry === true
        );
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
