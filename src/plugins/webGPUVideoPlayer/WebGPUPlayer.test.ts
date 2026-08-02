import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLAYBACK_SUPERSEDED } from 'constants/playbackResult';
import { MediaError } from 'types/mediaError';
import Events from 'utils/events';

import { microsecondsToMilliseconds, secondsToMicroseconds } from './MediaTime';
import type {
    NativeMediaAudioCapabilities,
    NativeMediaAudioChannelCount,
    NativeMediaAudioCodec,
    NativeMediaAudioCodecCapability,
    NativeMediaAudioLayoutCapability
} from './custom/NativeMediaAudioCapabilities';

type MockAudioEligibilityOverride = {
    audioOutputMode?: 'native-media'
    audioTrackIndex?: number
    eligible: boolean
    reason?: string
};

type MockEligibilityOptions = {
    allowDolbyVision?: boolean
    allowRawHDR: boolean
    nativeMediaAudioCapabilities?: NativeMediaAudioCapabilities | null
};

const htmlPlayerMockState = vi.hoisted(() => ({
    instances: [] as object[],
    owners: [] as object[]
}));
const presenterMockState = vi.hoisted(() => ({
    authorizedRawHDRRouteKeys: [] as string[],
    dolbyVisionAuthorized: false,
    instances: [] as object[]
}));
const webSettingsMockState = vi.hoisted(() => ({
    customDecodeEnabled: false,
    customDecodeEnabledPromises: [] as Array<Promise<boolean>>,
    hdrToneMappingEnabled: false
}));
const customDecodeMockState = vi.hoisted(() => ({
    audioEligibilityOverride: null as ((
        options: unknown,
        eligibilityOptions: MockEligibilityOptions
    ) => MockAudioEligibilityOverride) | null,
    audioOutputMode: 'decoded-pcm' as 'decoded-pcm' | 'native-media',
    audioTrackIndex: null as number | null,
    dolbyVision: false,
    eligible: false,
    hdr: false,
    instances: [] as object[],
    maximumCodedHeight: 1_080,
    maximumCodedWidth: 1_920,
    startupFallback: false,
    videoDecoderBackend: 'native' as 'bundled-hevc' | 'native',
    videoOutputMode: 'video-frame' as 'raw-planes' | 'video-frame'
}));
const customProfileMockState = vi.hoisted(() => ({
    augmentationCalls: [] as Array<{ options: unknown, profile: unknown }>,
    runtimeAvailable: true
}));
const animationFrameMockState = vi.hoisted(() => ({
    callbacks: new Map<number, FrameRequestCallback>(),
    nextIdentifier: 1
}));
const colorValidationMockState = vi.hoisted(() => ({
    decision: null as object | null,
    error: null as Error | null,
    requests: [] as object[]
}));
const colorValidationMediaMockState = vi.hoisted(() => ({
    options: [] as object[],
    providers: [] as Array<{
        destroy: ReturnType<typeof vi.fn>
        getFrame: ReturnType<typeof vi.fn>
    }>
}));
const audioPrewarmMockState = vi.hoisted(() => ({
    factoryLeases: [] as unknown[],
    leases: [] as Array<{
        audioContext: { sampleRate: number }
        close: ReturnType<typeof vi.fn>
        resumePromise: Promise<void>
    }>,
    nextClosePromise: null as Promise<void> | null,
    sampleRates: [] as number[]
}));
const nativeAudioCapabilityMockState = vi.hoisted(() => ({
    capabilities: null as object | null
}));

vi.mock('scripts/settings/webSettings', () => ({
    getWebGPUCustomDecodeEnabled: vi.fn(() => (
        webSettingsMockState.customDecodeEnabledPromises.shift()
        ?? Promise.resolve(webSettingsMockState.customDecodeEnabled)
    )),
    getWebGPUHDRToneMappingEnabled: vi.fn(() => Promise.resolve(
        webSettingsMockState.hdrToneMappingEnabled
    )),
    isWebGPUCustomDecodeEnabled: vi.fn(() => webSettingsMockState.customDecodeEnabled)
}));

vi.mock('./custom/CustomPlaybackEligibility', () => ({
    getCustomPlaybackEligibility: vi.fn((options: unknown, _capabilities: unknown, eligibilityOptions: MockEligibilityOptions) => {
        let HDRPresentationAllowed = eligibilityOptions.allowRawHDR;
        if (customDecodeMockState.dolbyVision) {
            HDRPresentationAllowed = eligibilityOptions.allowDolbyVision === true;
        }
        const audioEligibilityOverride = customDecodeMockState.audioEligibilityOverride?.(
            options,
            eligibilityOptions
        ) ?? null;
        const eligible = customDecodeMockState.eligible
            && (!customDecodeMockState.hdr || HDRPresentationAllowed)
            && audioEligibilityOverride?.eligible !== false;
        return eligible ? {
            audioOutputMode: audioEligibilityOverride?.audioOutputMode
                ?? (customDecodeMockState.audioTrackIndex === null ?
                    null :
                    customDecodeMockState.audioOutputMode),
            audioTrackIndex: audioEligibilityOverride?.audioTrackIndex
                ?? customDecodeMockState.audioTrackIndex,
            durationMicroseconds: 60_000_000,
            eligible: true,
            hdr: customDecodeMockState.hdr,
            maximumCodedHeight: customDecodeMockState.maximumCodedHeight,
            maximumCodedWidth: customDecodeMockState.maximumCodedWidth,
            rawVideoFrameFormat: customDecodeMockState.videoOutputMode === 'raw-planes' ?
                'I420P10' :
                null,
            startTimeMicroseconds: 1_000_000,
            url: 'http://localhost/video.mp4?api_key=custom-decode-secret',
            videoDecoderBackend: customDecodeMockState.videoDecoderBackend,
            videoOutputMode: customDecodeMockState.videoOutputMode,
            videoTrackIndex: 0
        } : {
            eligible: false,
            reason: audioEligibilityOverride?.reason ?? 'invalid-options'
        };
    })
}));

vi.mock('./custom/BrowserAudioContextPrewarm', () => ({
    prewarmBrowserAudioContext: vi.fn((sampleRate: number) => {
        const lease = {
            audioContext: { sampleRate },
            close: vi.fn(() => (
                audioPrewarmMockState.nextClosePromise ?? Promise.resolve()
            )),
            resumePromise: Promise.resolve()
        };
        audioPrewarmMockState.sampleRates.push(sampleRate);
        audioPrewarmMockState.leases.push(lease);
        return lease;
    })
}));

vi.mock('./custom/CustomDecodeCapabilities', () => ({
    probeCustomDecodeCapabilities: vi.fn(() => Promise.resolve({
        audio: {},
        telemetry: { reason: 'complete' },
        video: {}
    }))
}));

vi.mock('./custom/NativeMediaAudioCapabilities', () => ({
    probeCachedNativeMediaAudioCapabilities: vi.fn(() => Promise.resolve(
        nativeAudioCapabilityMockState.capabilities
    ))
}));

vi.mock('./custom/CustomDeviceProfile', () => ({
    augmentDeviceProfileForCustomDecode: vi.fn((profile: object, _capabilities: object, options: unknown) => {
        customProfileMockState.augmentationCalls.push({ options, profile });
        return {
            profile: { ...profile, CustomDecode: true },
            telemetry: {
                addedAudioProfileCount: 0,
                addedProfileCount: 1,
                addedVideoProfileCount: 1,
                reason: 'augmented',
                supportedAudioCodecs: [ 'aac' ],
                supportedVideoCodecs: [ 'h264' ],
                widenedHDRCodecProfileCount: 0
            }
        };
    })
}));

vi.mock('./custom/CustomPlaybackRuntime', () => ({
    getCustomPlaybackRuntimeAvailability: vi.fn(() => ({
        available: customProfileMockState.runtimeAvailable,
        environment: {},
        reason: customProfileMockState.runtimeAvailable ? null : 'webgpu-unavailable'
    }))
}));

vi.mock('./custom/BrowserCustomAudioOutput', () => ({
    createBrowserCustomAudioOutputFactory: vi.fn((audioPrewarm: unknown) => {
        audioPrewarmMockState.factoryLeases.push(audioPrewarm);
        return vi.fn();
    })
}));

vi.mock('./validation/WebGPUExternalTextureValidationRunner', () => ({
    WebGPUExternalTextureValidationRunner: class MockColorValidationRunner {
        validate = vi.fn((request: object): Promise<object | null> => {
            colorValidationMockState.requests.push(request);
            if (colorValidationMockState.error) {
                return Promise.reject(colorValidationMockState.error);
            }
            return Promise.resolve(colorValidationMockState.decision);
        });
    }
}));

vi.mock('./validation/MediabunnyReferenceFrameProvider', () => ({
    createMediabunnyReferenceFrameProvider: vi.fn((options: object) => {
        const provider = {
            destroy: vi.fn(() => Promise.resolve()),
            getFrame: vi.fn(() => Promise.reject(new Error('not invoked by mock')))
        };
        colorValidationMediaMockState.options.push(options);
        colorValidationMediaMockState.providers.push(provider);
        return Promise.resolve(provider);
    })
}));

vi.mock('./custom/CustomPlaybackController', () => {
    class MockCustomPlaybackController {
        readonly eventHandler: (event: object) => void;
        readonly fallbackHook: (request: object) => Promise<void>;
        readonly nativeAudioBridgeFactory: (() => object) | undefined;
        currentTimeMicroseconds = 1_000_000;
        durationMicroseconds: number | null = 60_000_000;
        playbackRate = 1;
        playbackState = 'idle';
        playbackVolume = 1;
        isMuted = false;

        constructor(options: {
            eventHandler: (event: object) => void
            fallbackHook: (request: object) => Promise<void>
            nativeAudioBridgeFactory?: () => object
        }) {
            this.eventHandler = options.eventHandler;
            this.fallbackHook = options.fallbackHook;
            this.nativeAudioBridgeFactory = options.nativeAudioBridgeFactory;
            customDecodeMockState.instances.push(this);
        }

        play = vi.fn((options: { startTimeMicroseconds: number }) => {
            this.currentTimeMicroseconds = options.startTimeMicroseconds;
            if (customDecodeMockState.startupFallback) {
                this.playbackState = 'fallback';
                void this.fallbackHook({
                    disposition: 'renegotiate-source',
                    generation: 1,
                    mediaTimeMicroseconds: this.currentTimeMicroseconds,
                    preserveHTMLSession: true,
                    reason: 'decode-failed'
                }).catch(() => undefined);
                return Promise.resolve({
                    fallbackReason: 'decode-failed',
                    generation: 1,
                    status: 'fallback'
                });
            }
            this.playbackState = 'playing';
            this.eventHandler({
                generation: 1,
                previousState: 'starting',
                state: 'playing',
                type: 'statechange'
            });
            this.eventHandler({
                durationMicroseconds: this.durationMicroseconds,
                generation: 1,
                startupDurationMicroseconds: 10_000,
                type: 'ready'
            });
            this.eventHandler({ generation: 1, type: 'playing' });
            return Promise.resolve({
                fallbackReason: null,
                generation: 1,
                status: 'started'
            });
        });
        seek = vi.fn((mediaTimeMicroseconds: number) => {
            this.currentTimeMicroseconds = mediaTimeMicroseconds;
            const previousState = this.playbackState;
            const desiredPlaying = previousState === 'playing';
            this.playbackState = 'seeking';
            this.eventHandler({
                generation: 2,
                previousState,
                state: 'seeking',
                type: 'statechange'
            });
            return Promise.resolve().then(() => {
                this.playbackState = desiredPlaying ? 'playing' : 'paused';
                this.eventHandler({
                    generation: 2,
                    previousState: 'seeking',
                    state: this.playbackState,
                    type: 'statechange'
                });
                if (desiredPlaying) {
                    this.eventHandler({ generation: 2, type: 'playing' });
                }
                return {
                    fallbackReason: null,
                    generation: 2,
                    status: 'started'
                };
            });
        });
        pause = vi.fn(() => {
            this.playbackState = 'paused';
            this.eventHandler({
                generation: 1,
                previousState: 'playing',
                state: 'paused',
                type: 'statechange'
            });
        });
        resume = vi.fn(() => {
            this.playbackState = 'playing';
            this.eventHandler({
                generation: 1,
                previousState: 'paused',
                state: 'playing',
                type: 'statechange'
            });
            this.eventHandler({ generation: 1, type: 'playing' });
        });
        destroy = vi.fn(() => Promise.resolve());
        takeCurrentFrame = vi.fn(() => null);
        notifyFrameDiscarded = vi.fn(() => true);
        notifyFramePresented = vi.fn(() => true);
        canSetAudioStreamIndex = vi.fn(() => true);
        setAudioStreamIndex = vi.fn(() => Promise.resolve({
            fallbackReason: null,
            generation: 2,
            status: 'started'
        }));
        setVolume = vi.fn((volume: number) => {
            this.playbackVolume = volume;
        });
        setMuted = vi.fn((muted: boolean) => {
            this.isMuted = muted;
        });
        setPlaybackRate = vi.fn((playbackRate: number) => {
            this.playbackRate = playbackRate;
            return true;
        });
        getTelemetry = vi.fn(() => ({
            activeGeneration: null,
            audioBridge: null,
            audioOutput: null,
            audioPath: 'disabled',
            clock: {},
            currentTimeMicroseconds: this.currentTimeMicroseconds,
            durationMicroseconds: this.durationMicroseconds,
            fallbackCount: 0,
            fallbackReason: null,
            lastErrorMessage: null,
            muted: this.isMuted,
            playCount: 1,
            staleEventCount: 0,
            startupDurationMicroseconds: 10_000,
            state: 'idle',
            videoDecode: {
                activeGeneration: null,
                audioCodec: null,
                droppedFrameCount: 0,
                failureKind: null,
                firstFrameMediaTimeMicroseconds: null,
                lastAudioMediaTimeMicroseconds: null,
                lastFrameMediaTimeMicroseconds: null,
                queuedFrameCount: 0,
                receivedAudioFrameCount: 0,
                receivedAudioSampleCount: 0,
                receivedFrameCount: 0,
                staleAudioSampleCount: 0,
                staleFrameCount: 0,
                state: 'idle',
                submittedAudioFrameCount: 0,
                submittedAudioSampleCount: 0,
                takenFrameCount: 0
            },
            volume: this.playbackVolume
        }));
    }

    return { default: MockCustomPlaybackController };
});

const EXPECTED_HTML_PLAYER_EVENTS = [
    'beginFetch',
    'endFetch',
    'timeupdate',
    'volumechange',
    'playing',
    'unpause',
    'click',
    'dblclick',
    'pause',
    'waiting',
    'brightnesschange',
    'error',
    'stopped'
] as const;

vi.mock('./WebGPUPresenter', () => {
    class MockWebGPUPresenter {
        readonly fallbackHandler: (generation: number) => void;
        readonly decodedPresentationRefreshHandler: (generation: number) => void;
        readonly validationDevice = { label: 'validation-device' } as GPUDevice;

        constructor(
            fallbackHandler: (generation: number) => void,
            decodedPresentationRefreshHandler: (generation: number) => void
        ) {
            this.fallbackHandler = fallbackHandler;
            this.decodedPresentationRefreshHandler = decodedPresentationRefreshHandler;
            presenterMockState.instances.push(this);
        }

        startSession = vi.fn();
        attach = vi.fn();
        configureColorPipeline = vi.fn(() => Promise.resolve(true));
        setDecodedFrameProvider = vi.fn();
        setDecodedFramePushMode = vi.fn();
        presentDecodedFrame = vi.fn(() => true);
        seek = vi.fn();
        refresh = vi.fn();
        endSession = vi.fn();
        destroy = vi.fn();
        getTelemetry = vi.fn(() => ({
            decodedFrameCount: 0,
            deviceRecoveryCount: 0,
            fallbackReason: null,
            firstFrameLatencyMicroseconds: null,
            firstPresentedMediaTimeMicroseconds: null,
            lastCallbackTimeMicroseconds: null,
            lastExpectedDisplayTimeMicroseconds: null,
            lastPresentedMediaTimeMicroseconds: null,
            mode: 'identity-sdr',
            nativeFrameCount: 0,
            presentationSource: null,
            presentedFrameCount: 0,
            sessionStartedMicroseconds: 0,
            state: 'idle'
        }));
        getRenderSettings = vi.fn(() => ({ mode: 'identity-sdr', version: 4 }));
        updateRenderSettings = vi.fn(() => true);
        acquireValidationDevice = vi.fn(() => Promise.resolve(this.validationDevice));
        isValidationDevice = vi.fn((device: GPUDevice | null) => (
            device === this.validationDevice
        ));
        prewarmRawHDRPresentationAuthorization = vi.fn(() => Promise.resolve());
        waitForRawHDRAuthorizationPrewarm = vi.fn(() => Promise.resolve());
        prewarmDolbyVisionPresentationAuthorization = vi.fn(() => Promise.resolve());
        waitForDolbyVisionAuthorizationPrewarm = vi.fn(() => Promise.resolve());
        isDolbyVisionPresentationAuthorized = vi.fn(() => (
            presenterMockState.dolbyVisionAuthorized
        ));
        getAuthorizedRawHDRRouteKeys = vi.fn(() => (
            [ ...presenterMockState.authorizedRawHDRRouteKeys ]
        ));
        getRawHDRAuthorizationTelemetry = vi.fn(() => ({
            authorizedRouteKeys: [ ...presenterMockState.authorizedRawHDRRouteKeys ],
            failureReasons: {},
            fixtureVersion: 1,
            pendingRouteKeys: [],
            rejectedRouteKeys: [],
            renderSettingsVersion: 4,
            status: presenterMockState.authorizedRawHDRRouteKeys.length > 0 ?
                'authorized' :
                'unavailable',
            targetFormat: 'bgra8unorm'
        }));
        getDolbyVisionAuthorizationTelemetry = vi.fn(() => ({
            failureReason: presenterMockState.dolbyVisionAuthorized ? null : 'pixel-mismatch',
            fixtureVersion: 1,
            maximumChannelError: presenterMockState.dolbyVisionAuthorized ? 0 : 1,
            renderSettingsVersion: 4,
            routeKey: 'I420P10:dovi-rpu-v1',
            sampleCount: 4,
            status: presenterMockState.dolbyVisionAuthorized ? 'authorized' : 'rejected',
            targetFormat: 'bgra8unorm'
        }));
    }

    return { default: MockWebGPUPresenter };
});

vi.mock('plugins/htmlVideoPlayer/plugin', () => {
    class MockHtmlVideoPlayer {
        isFetching = false;
        forcedFullscreen = false;
        currentTimeMilliseconds = 0;
        durationMilliseconds = 60_000;
        readonly profile = { Name: 'HTML profile' };
        presentationSurface: { container: HTMLDivElement, video: HTMLVideoElement } | null = null;

        constructor(owner: object) {
            htmlPlayerMockState.instances.push(this);
            htmlPlayerMockState.owners.push(owner);
        }

        currentSrc = vi.fn(() => 'backend-source');
        cancelPendingPlay = vi.fn();
        getPresentationSurface = vi.fn(() => this.presentationSurface);
        prepareCustomPlayback = vi.fn(() => Promise.resolve(this.presentationSurface));
        notifyCustomPlaybackEnded = vi.fn(() => {
            Events.trigger(this, 'stopped');
            return true;
        });
        notifyCustomPlaybackPaused = vi.fn(() => {
            Events.trigger(this, 'pause');
            return true;
        });
        notifyCustomPlaybackPlaying = vi.fn((emitUnpause = true) => {
            if (emitUnpause) {
                Events.trigger(this, 'unpause');
            }
            Events.trigger(this, 'playing');
            return true;
        });
        notifyCustomPlaybackTimeUpdate = vi.fn(() => {
            Events.trigger(this, 'timeupdate');
            return true;
        });
        notifyCustomPlaybackVolumeChange = vi.fn(() => {
            Events.trigger(this, 'volumechange');
            return true;
        });
        notifyCustomPlaybackWaiting = vi.fn(() => {
            Events.trigger(this, 'waiting');
            return true;
        });
        canPlayMediaType = vi.fn((mediaType: string | null | undefined) => mediaType?.toLowerCase() === 'video');
        supportsPlayMethod = vi.fn(() => true);
        getDeviceProfile = vi.fn(() => Promise.resolve(this.profile));
        supports = vi.fn(() => true);
        play = vi.fn((options: unknown) => Promise.resolve(options));
        stop = vi.fn<(destroyPlayer: boolean) => Promise<void>>(() => Promise.resolve());
        destroy = vi.fn();
        currentTime = vi.fn((value?: number) => {
            if (value != null) {
                this.currentTimeMilliseconds = value;
                return undefined;
            }

            return this.currentTimeMilliseconds;
        });
        duration = vi.fn(() => this.durationMilliseconds);
        seekable = vi.fn(() => true);
        pause = vi.fn();
        resume = vi.fn();
        unpause = vi.fn();
        paused = vi.fn(() => false);
        setSubtitleStreamIndex = vi.fn();
        setSecondarySubtitleStreamIndex = vi.fn();
        resetSubtitleOffset = vi.fn();
        setSubtitleOffset = vi.fn();
        getSubtitleOffset = vi.fn(() => 0);
        enableShowingSubtitleOffset = vi.fn();
        disableShowingSubtitleOffset = vi.fn();
        isShowingSubtitleOffsetEnabled = vi.fn(() => false);
        canSetAudioStreamIndex = vi.fn(() => true);
        setAudioStreamIndex = vi.fn();
        setVolume = vi.fn();
        getVolume = vi.fn(() => 50);
        volumeUp = vi.fn();
        volumeDown = vi.fn();
        setMute = vi.fn();
        isMuted = vi.fn(() => false);
        setPlaybackRate = vi.fn();
        getPlaybackRate = vi.fn(() => 1);
        getSupportedPlaybackRates = vi.fn(() => [{ id: 1, name: '1x' }]);
        setBrightness = vi.fn();
        getBrightness = vi.fn(() => 100);
        setAspectRatio = vi.fn();
        getAspectRatio = vi.fn(() => 'auto');
        getSupportedAspectRatios = vi.fn(() => [{ id: 'auto', name: 'Auto' }]);
        setPictureInPictureEnabled = vi.fn();
        isPictureInPictureEnabled = vi.fn(() => false);
        togglePictureInPicture = vi.fn();
        setAirPlayEnabled = vi.fn();
        isAirPlayEnabled = vi.fn(() => false);
        toggleAirPlay = vi.fn();
        getBufferedRanges = vi.fn(() => []);
        getStats = vi.fn(() => Promise.resolve({ categories: [] }));
    }

    return {
        default: MockHtmlVideoPlayer,
        HtmlVideoPlayer: MockHtmlVideoPlayer
    };
});

import { HTML_PLAYER_EVENTS } from './HTMLPlayerDelegate';
import WebGPUPlayer, { CUSTOM_PLAYBACK_SETUP_TIMEOUT_MICROSECONDS } from './WebGPUPlayer';

type MockFunction = ReturnType<typeof vi.fn>;

type MockHTMLPlayer = {
    isFetching: boolean
    forcedFullscreen: boolean
    currentTimeMilliseconds: number
    durationMilliseconds: number
    profile: object
    presentationSurface: { container: HTMLDivElement, video: HTMLVideoElement } | null
    cancelPendingPlay: MockFunction
    currentSrc: MockFunction
    prepareCustomPlayback: MockFunction
    notifyCustomPlaybackEnded: MockFunction
    notifyCustomPlaybackPaused: MockFunction
    notifyCustomPlaybackPlaying: MockFunction
    notifyCustomPlaybackTimeUpdate: MockFunction
    notifyCustomPlaybackVolumeChange: MockFunction
    notifyCustomPlaybackWaiting: MockFunction
    canPlayItem?: MockFunction
    canPlayMediaType: MockFunction
    supportsPlayMethod: MockFunction
    getDeviceProfile: MockFunction
    supports: MockFunction
    play: MockFunction
    stop: MockFunction
    destroy: MockFunction
    currentTime: MockFunction
    pause: MockFunction
    resume: MockFunction
    unpause: MockFunction
    resetSubtitleOffset: MockFunction
    setVolume: MockFunction
    getVolume: MockFunction
    setMute: MockFunction
    isMuted: MockFunction
    setPlaybackRate: MockFunction
    getPlaybackRate: MockFunction
    setBrightness: MockFunction
    getBrightness: MockFunction
    setAspectRatio: MockFunction
    setSubtitleStreamIndex: MockFunction
    setSecondarySubtitleStreamIndex: MockFunction
    setAudioStreamIndex: MockFunction
    setPictureInPictureEnabled: MockFunction
    isPictureInPictureEnabled: MockFunction
    togglePictureInPicture: MockFunction
    setAirPlayEnabled: MockFunction
    isAirPlayEnabled: MockFunction
    toggleAirPlay: MockFunction
    getBufferedRanges: MockFunction
    getStats: MockFunction
};

type MockPresenter = {
    acquireValidationDevice: MockFunction
    attach: MockFunction
    configureColorPipeline: MockFunction
    destroy: MockFunction
    decodedPresentationRefreshHandler: (generation: number) => void
    endSession: MockFunction
    fallbackHandler: (generation: number) => void
    getRenderSettings: MockFunction
    getTelemetry: MockFunction
    isValidationDevice: MockFunction
    refresh: MockFunction
    seek: MockFunction
    presentDecodedFrame: MockFunction
    prewarmDolbyVisionPresentationAuthorization: MockFunction
    setDecodedFrameProvider: MockFunction
    setDecodedFramePushMode: MockFunction
    startSession: MockFunction
    updateRenderSettings: MockFunction
    validationDevice: GPUDevice
    waitForDolbyVisionAuthorizationPrewarm: MockFunction
    waitForRawHDRAuthorizationPrewarm: MockFunction
};

type MockCustomPlaybackController = {
    eventHandler: (event: object) => void
    fallbackHook: (request: object) => Promise<void>
    nativeAudioBridgeFactory: (() => object) | undefined
    getTelemetry: MockFunction
    play: MockFunction
    seek: MockFunction
    pause: MockFunction
    resume: MockFunction
    destroy: MockFunction
    takeCurrentFrame: MockFunction
    notifyFrameDiscarded: MockFunction
    notifyFramePresented: MockFunction
    canSetAudioStreamIndex: MockFunction
    setAudioStreamIndex: MockFunction
    setVolume: MockFunction
    setMuted: MockFunction
    setPlaybackRate: MockFunction
    currentTimeMicroseconds: number
    durationMicroseconds: number | null
    playbackRate: number
    playbackState: string
};

function getBackend(): MockHTMLPlayer {
    const backendIndex = htmlPlayerMockState.instances.length - 1;
    return htmlPlayerMockState.instances[backendIndex] as MockHTMLPlayer;
}

function getPresenter(): MockPresenter {
    const presenterIndex = presenterMockState.instances.length - 1;
    return presenterMockState.instances[presenterIndex] as MockPresenter;
}

function getCustomPlaybackController(): MockCustomPlaybackController {
    const sessionIndex = customDecodeMockState.instances.length - 1;
    return customDecodeMockState.instances[sessionIndex] as MockCustomPlaybackController;
}

type Deferred<Value> = {
    promise: Promise<Value>
    resolve: (value: Value) => void
};

function createDeferred<Value>(): Deferred<Value> {
    let resolvePromise: (value: Value) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    const promise = new Promise<Value>(resolve => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

function runNextAnimationFrame(timestamp = 0): void {
    const entry = animationFrameMockState.callbacks.entries().next();
    if (entry.done) {
        throw new Error('No animation frame is scheduled');
    }
    const [ identifier, callback ] = entry.value;
    animationFrameMockState.callbacks.delete(identifier);
    callback(timestamp);
}

function createKnownSDRPlayOptions(
    properties: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        ...properties,
        mediaSource: {
            MediaStreams: [{ Type: 'Video', VideoRangeType: 'SDR' }]
        }
    };
}

function createKnownSDRAudioPlayOptions(sampleRate: unknown = 48_000): Record<string, unknown> {
    return {
        playMethod: 'DirectPlay',
        mediaSource: {
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
                { Index: 0, Type: 'Video', VideoRangeType: 'SDR' },
                { Index: 1, SampleRate: sampleRate, Type: 'Audio' }
            ]
        }
    };
}

function createKnownSDRNativeAudioPlayOptions(channelCount: number): Record<string, unknown> {
    return {
        playMethod: 'DirectPlay',
        mediaSource: {
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
                { Index: 0, Type: 'Video', VideoRangeType: 'SDR' },
                {
                    Channels: channelCount,
                    Codec: 'eac3',
                    Index: 1,
                    SampleRate: 48_000,
                    Type: 'Audio'
                }
            ]
        }
    };
}

function createPartialNativeMediaAudioCapabilities(): NativeMediaAudioCapabilities {
    const supportedRouteKey = 'eac3:6:48000';
    const audio = {} as Record<NativeMediaAudioCodec, NativeMediaAudioCodecCapability>;
    for (const codec of [ 'ac3', 'eac3' ] as const) {
        const codecString = codec === 'ac3' ? 'ac-3' : 'ec-3';
        const mimeType = `audio/mp4; codecs="${codecString}"`;
        const layouts = {} as Record<
            NativeMediaAudioChannelCount,
            NativeMediaAudioLayoutCapability
        >;
        let codecSupported = false;
        for (const channelCount of [ 2, 6 ] as const) {
            const supported = `${codec}:${channelCount}:48000` === supportedRouteKey;
            codecSupported ||= supported;
            layouts[channelCount] = {
                channelCount,
                codec,
                codecString,
                mimeType,
                reason: supported ? 'decoded-playback-advanced' : 'playback-not-advanced',
                sampleRate: 48_000,
                status: supported ? 'supported' : 'unsupported'
            };
        }
        audio[codec] = {
            codec,
            codecString,
            layouts,
            mimeType,
            status: codecSupported ? 'supported' : 'unsupported'
        };
    }
    return {
        audio,
        telemetry: {
            probeCount: 4,
            supportedLayoutCount: 1,
            unknownLayoutCount: 0
        }
    };
}

function selectExactNativeAudioRouteForMock(
    options: unknown,
    eligibilityOptions: MockEligibilityOptions
): MockAudioEligibilityOverride {
    const unsupported: MockAudioEligibilityOverride = {
        eligible: false,
        reason: 'audio-layout-unsupported'
    };
    if (!options || typeof options !== 'object') {
        return unsupported;
    }
    const mediaSource = (options as Record<string, unknown>).mediaSource;
    if (!mediaSource || typeof mediaSource !== 'object') {
        return unsupported;
    }
    const mediaSourceRecord = mediaSource as Record<string, unknown>;
    if (!Array.isArray(mediaSourceRecord.MediaStreams)) {
        return unsupported;
    }

    const audioStreams: Array<Record<string, unknown>> = [];
    for (const mediaStream of mediaSourceRecord.MediaStreams) {
        if (mediaStream
            && typeof mediaStream === 'object'
            && (mediaStream as Record<string, unknown>).Type === 'Audio') {
            audioStreams.push(mediaStream as Record<string, unknown>);
        }
    }
    const selectedStreamIndex = mediaSourceRecord.DefaultAudioStreamIndex;
    const audioTrackIndex = audioStreams.findIndex(
        audioStream => audioStream.Index === selectedStreamIndex
    );
    if (audioTrackIndex < 0) {
        return unsupported;
    }

    const selectedAudioStream = audioStreams[audioTrackIndex];
    const codec = selectedAudioStream.Codec;
    const channelCount = selectedAudioStream.Channels;
    if ((codec !== 'ac3' && codec !== 'eac3')
        || (channelCount !== 2 && channelCount !== 6)) {
        return unsupported;
    }
    const layout = eligibilityOptions.nativeMediaAudioCapabilities
        ?.audio[codec].layouts[channelCount];
    if (layout?.status !== 'supported'
        || layout.sampleRate !== selectedAudioStream.SampleRate) {
        return unsupported;
    }

    return {
        audioOutputMode: 'native-media',
        audioTrackIndex,
        eligible: true
    };
}

function createKnownHDRPlayOptions(
    properties: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        ...properties,
        mediaSource: {
            MediaStreams: [{
                BitDepth: 10,
                Codec: 'hevc',
                ColorPrimaries: 'bt2020',
                ColorRange: 'limited',
                ColorSpace: 'bt2020-ncl',
                ColorTransfer: 'smpte2084',
                Index: 0,
                Type: 'Video',
                VideoRange: 'HDR',
                VideoRangeType: 'HDR10'
            }]
        }
    };
}

function createKnownDolbyVisionPlayOptions(
    properties: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        ...properties,
        mediaSource: {
            MediaStreams: [{
                BitDepth: 10,
                BlPresentFlag: true,
                Codec: 'hevc',
                DvBlSignalCompatibilityId: 1,
                DvProfile: 8,
                ElPresentFlag: false,
                Index: 0,
                RpuPresentFlag: true,
                Type: 'Video',
                VideoRange: 'HDR',
                VideoRangeType: 'DOVIWithHDR10'
            }]
        }
    };
}

function createNativeCompatibleProfile(): Record<string, unknown> {
    return {
        CodecProfiles: [],
        ContainerProfiles: [],
        DirectPlayProfiles: [ {
            AudioCodec: 'aac',
            Container: 'mp4',
            Type: 'Video',
            VideoCodec: 'h264'
        } ],
        Name: 'HTML profile'
    };
}

function createNativeCompatiblePlayOptions(): Record<string, unknown> {
    return {
        item: { Id: 'item' },
        mediaSource: {
            Container: 'mp4',
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
                {
                    Codec: 'h264',
                    Index: 0,
                    Type: 'Video',
                    VideoRangeType: 'SDR'
                },
                { Codec: 'aac', Index: 1, Type: 'Audio' }
            ],
            RunTimeTicks: 60_000_000,
            SupportsDirectPlay: true
        },
        playMethod: 'DirectPlay',
        url: '/Videos/item/stream.mp4'
    };
}

describe('WebGPUPlayer HTML delegation', () => {
    beforeEach(() => {
        htmlPlayerMockState.instances.length = 0;
        htmlPlayerMockState.owners.length = 0;
        presenterMockState.instances.length = 0;
        presenterMockState.authorizedRawHDRRouteKeys = [];
        presenterMockState.dolbyVisionAuthorized = false;
        webSettingsMockState.customDecodeEnabled = false;
        webSettingsMockState.customDecodeEnabledPromises.length = 0;
        webSettingsMockState.hdrToneMappingEnabled = false;
        customDecodeMockState.audioEligibilityOverride = null;
        customDecodeMockState.eligible = false;
        customDecodeMockState.dolbyVision = false;
        customDecodeMockState.hdr = false;
        customDecodeMockState.audioOutputMode = 'decoded-pcm';
        customDecodeMockState.audioTrackIndex = null;
        customDecodeMockState.instances.length = 0;
        customDecodeMockState.startupFallback = false;
        customDecodeMockState.videoDecoderBackend = 'native';
        customDecodeMockState.videoOutputMode = 'video-frame';
        customProfileMockState.augmentationCalls.length = 0;
        customProfileMockState.runtimeAvailable = true;
        animationFrameMockState.callbacks.clear();
        animationFrameMockState.nextIdentifier = 1;
        colorValidationMockState.decision = null;
        colorValidationMockState.error = null;
        colorValidationMockState.requests.length = 0;
        colorValidationMediaMockState.options.length = 0;
        colorValidationMediaMockState.providers.length = 0;
        audioPrewarmMockState.factoryLeases.length = 0;
        audioPrewarmMockState.leases.length = 0;
        audioPrewarmMockState.nextClosePromise = null;
        audioPrewarmMockState.sampleRates.length = 0;
        nativeAudioCapabilityMockState.capabilities = null;
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback): number => {
            const identifier = animationFrameMockState.nextIdentifier;
            animationFrameMockState.nextIdentifier += 1;
            animationFrameMockState.callbacks.set(identifier, callback);
            return identifier;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn((identifier: number): void => {
            animationFrameMockState.callbacks.delete(identifier);
        }));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('owns exactly one HTML backend with the wrapper as manager identity', () => {
        const player = new WebGPUPlayer();

        expect(htmlPlayerMockState.instances).toHaveLength(1);
        expect(htmlPlayerMockState.owners).toEqual([player]);
        expect(player.id).toBe('webgpuvideoplayer');
        expect(player.syncPlayWrapAs).toBe('htmlvideoplayer');
        expect(player.priority).toBe(0);
    });

    it('keeps player selection synchronous and safe when called unbound', () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const canPlayMediaType = player.canPlayMediaType;
        const item = { Id: 'item' };
        const playOptions = { fullscreen: true };
        const canPlayItem = vi.fn(() => false);
        backend.canPlayItem = canPlayItem;

        expect(canPlayMediaType('Video')).toBe(true);
        expect(canPlayMediaType('Audio')).toBe(false);
        expect(player.canPlayItem(item, playOptions)).toBe(false);
        expect(canPlayItem).toHaveBeenCalledWith(item, playOptions);
        expect(backend.canPlayMediaType).toHaveBeenCalledTimes(2);
    });

    it('delegates profile and source objects without mutation', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const item = { Id: 'item' };
        const profileOptions = { MaxStreamingBitrate: 1 };
        const playOptions = {
            url: '/Videos/item/stream',
            mediaSource: { Id: 'source' }
        };

        await expect(player.getDeviceProfile(item, profileOptions)).resolves.toBe(backend.profile);
        await expect(player.play(playOptions)).resolves.toBe(playOptions);
        expect(backend.getDeviceProfile).toHaveBeenCalledWith(item, profileOptions);
        expect(backend.play).toHaveBeenCalledWith(playOptions);
    });

    it('widens a custom-decode profile only when enabled and never on retry', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const item = { Id: 'item' };
        webSettingsMockState.customDecodeEnabled = true;

        const profile = await player.getDeviceProfile(item, { isRetry: false }) as {
            CustomDecode?: boolean
        };
        expect(profile.CustomDecode).toBe(true);
        expect(profile).not.toBe(backend.profile);
        expect(customProfileMockState.augmentationCalls[0]).toEqual({
            options: {
                allowDolbyVision: false,
                allowRawHDR: false,
                authorizedRawHDRRouteKeys: [],
                isRetry: false,
                nativeMediaAudioCapabilities: null
            },
            profile: backend.profile
        });

        await player.getDeviceProfile(item, { isRetry: true });
        expect(customProfileMockState.augmentationCalls[1]?.options).toEqual({
            allowDolbyVision: false,
            allowRawHDR: false,
            authorizedRawHDRRouteKeys: [],
            isRetry: true,
            nativeMediaAudioCapabilities: null
        });
        expect(player.getCustomDeviceProfileTelemetry()).toMatchObject({
            reason: 'augmented',
            supportedVideoCodecs: [ 'h264' ]
        });
    });

    it('passes a partial native-media audio capability into non-retry profile augmentation', async () => {
        const player = new WebGPUPlayer();
        const capabilities = createPartialNativeMediaAudioCapabilities();
        webSettingsMockState.customDecodeEnabled = true;
        nativeAudioCapabilityMockState.capabilities = capabilities;

        await player.getDeviceProfile({ Id: 'native-audio-item' }, { isRetry: false });

        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            isRetry: false,
            nativeMediaAudioCapabilities: capabilities
        });
        expect(player.getNativeMediaAudioCapabilities()).toEqual(capabilities);
    });

    it('does not pass a measured native-media audio capability into retry widening', async () => {
        const player = new WebGPUPlayer();
        const capabilities = createPartialNativeMediaAudioCapabilities();
        webSettingsMockState.customDecodeEnabled = true;
        nativeAudioCapabilityMockState.capabilities = capabilities;

        await player.getDeviceProfile({ Id: 'native-audio-item' }, { isRetry: true });

        expect(customProfileMockState.augmentationCalls[0]?.options).toMatchObject({
            isRetry: true,
            nativeMediaAudioCapabilities: null
        });
        expect(player.getNativeMediaAudioCapabilities()).toBeNull();
    });

    it('widens custom profile HDR ranges only when raw HDR presentation is enabled', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        webSettingsMockState.customDecodeEnabled = true;
        webSettingsMockState.hdrToneMappingEnabled = true;
        presenterMockState.authorizedRawHDRRouteKeys = [
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        ];

        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });

        expect(customProfileMockState.augmentationCalls[0]).toEqual({
            options: {
                allowDolbyVision: false,
                allowRawHDR: true,
                authorizedRawHDRRouteKeys: [
                    'I420P10:bt2020-ncl:bt2020:limited:pq'
                ],
                isRetry: false,
                nativeMediaAudioCapabilities: null
            },
            profile: backend.profile
        });
    });

    it('widens Dolby Vision capability only after exact-device authorization', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        webSettingsMockState.customDecodeEnabled = true;
        webSettingsMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;

        await player.getDeviceProfile({ Id: 'dolby-vision-item' }, { isRetry: false });

        expect(presenter.waitForRawHDRAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(presenter.waitForDolbyVisionAuthorizationPrewarm).toHaveBeenCalledOnce();
        expect(customProfileMockState.augmentationCalls[0]).toEqual({
            options: {
                allowDolbyVision: true,
                allowRawHDR: false,
                authorizedRawHDRRouteKeys: [],
                isRetry: false,
                nativeMediaAudioCapabilities: null
            },
            profile: backend.profile
        });
    });

    it('keeps the native profile when the complete custom runtime is unavailable', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        webSettingsMockState.customDecodeEnabled = true;
        customProfileMockState.runtimeAvailable = false;

        await expect(player.getDeviceProfile({}, {})).resolves.toBe(backend.profile);
        expect(customProfileMockState.augmentationCalls).toHaveLength(0);
        expect(player.getCustomPlaybackRuntimeAvailability()).toMatchObject({
            available: false,
            reason: 'webgpu-unavailable'
        });
    });

    it('runs color validation on the exact reusable presentation device', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        const metadata = {
            bitDepth: 10,
            matrix: 'bt2020-ncl' as const,
            nominalPeakNits: 1_000,
            primaries: 'bt2020' as const,
            range: 'limited' as const,
            sdrReferenceWhiteNits: 100,
            transfer: 'pq' as const,
            version: 1 as const
        };
        const decision = {
            capability: 'supported',
            classification: 'valid',
            validation: { accepted: true }
        };
        colorValidationMockState.decision = decision;
        const getFrame = vi.fn(() => Promise.reject(new Error('not invoked by mock')));

        await expect(player.validateColorPipelineReference({
            getFrame,
            metadata
        })).resolves.toBe(decision);

        expect(presenter.acquireValidationDevice).toHaveBeenCalledOnce();
        expect(colorValidationMockState.requests).toContainEqual({
            device: presenter.validationDevice,
            getFrame,
            metadata
        });
        expect(player.getColorValidationDecision()).toBe(decision);
    });

    it('never treats a valid external-texture diagnostic as raw HDR authorization', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        webSettingsMockState.customDecodeEnabled = true;
        webSettingsMockState.hdrToneMappingEnabled = true;
        player.setColorValidationDecision({
            capability: 'supported',
            classification: 'valid',
            validation: { accepted: true }
        } as never, presenter.validationDevice);

        await player.getDeviceProfile({ Id: 'hdr-item' }, { isRetry: false });

        expect(customProfileMockState.augmentationCalls[0]?.options).toEqual({
            allowDolbyVision: false,
            allowRawHDR: false,
            authorizedRawHDRRouteKeys: [],
            isRetry: false,
            nativeMediaAudioCapabilities: null
        });
        expect(player.getColorValidationDecision()).toMatchObject({
            classification: 'valid'
        });
        expect(player.getRawHDRAuthorizationTelemetry()).toMatchObject({
            authorizedRouteKeys: [],
            status: 'unavailable'
        });
    });

    it('validates generated media without passing its URL into retained runner state', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        const metadata = {
            bitDepth: 10,
            matrix: 'bt2020-ncl' as const,
            nominalPeakNits: 1_000,
            primaries: 'bt2020' as const,
            range: 'limited' as const,
            sdrReferenceWhiteNits: 100,
            transfer: 'pq' as const,
            version: 1 as const
        };
        const decision = {
            capability: 'supported',
            classification: 'valid',
            validation: { accepted: true }
        };
        const timestampsMicroseconds = [
            secondsToMicroseconds(0),
            secondsToMicroseconds(1),
            secondsToMicroseconds(2)
        ];
        colorValidationMockState.decision = decision;

        await expect(player.validateColorPipelineReferenceMedia({
            globalTrackIndex: 0,
            metadata,
            rampOptions: {
                encodedRGBTriplets: [
                    [ 0, 0, 0 ],
                    [ 0.5, 0.5, 0.5 ],
                    [ 0.75, 0.25, 0.25 ]
                ],
                frameIntervalMicroseconds: secondsToMicroseconds(1)
            },
            timestampsMicroseconds,
            url: 'http://localhost/reference.mp4?api_key=secret'
        })).resolves.toBe(decision);

        expect(colorValidationMediaMockState.options).toEqual([{
            globalTrackIndex: 0,
            timestampsMicroseconds,
            url: 'http://localhost/reference.mp4?api_key=secret'
        }]);
        expect(colorValidationMediaMockState.providers[0].destroy).toHaveBeenCalledOnce();
        expect(colorValidationMockState.requests[0]).toMatchObject({
            device: presenter.validationDevice,
            metadata
        });
        expect(colorValidationMockState.requests[0]).not.toHaveProperty('url');
        expect(colorValidationMockState.requests[0]).not.toHaveProperty('timestampsMicroseconds');
        expect(colorValidationMockState.requests[0]).not.toHaveProperty('globalTrackIndex');
    });

    it('destroys generated validation media after a runner failure', async () => {
        const player = new WebGPUPlayer();
        colorValidationMockState.error = new Error('simulated validation failure');

        await expect(player.validateColorPipelineReferenceMedia({
            globalTrackIndex: 0,
            metadata: {
                bitDepth: 8,
                matrix: 'bt709',
                nominalPeakNits: 100,
                primaries: 'bt709',
                range: 'limited',
                sdrReferenceWhiteNits: 100,
                transfer: 'sdr',
                version: 1
            },
            timestampsMicroseconds: [
                secondsToMicroseconds(0),
                secondsToMicroseconds(1),
                secondsToMicroseconds(2)
            ],
            url: 'http://localhost/reference.mp4'
        })).rejects.toThrow('simulated validation failure');

        expect(colorValidationMediaMockState.providers[0].destroy).toHaveBeenCalledOnce();
    });

    it('attaches the presenter after HTML playback and invalidates it on seek and stop', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };

        await player.play(createKnownSDRPlayOptions());
        expect(presenter.startSession).toHaveBeenCalledWith(1);
        expect(presenter.attach).toHaveBeenCalledWith(backend.presentationSurface, 1);

        player.currentTime(1_000);
        expect(presenter.seek).toHaveBeenCalledWith(2);
        player.setAspectRatio('cover');
        expect(presenter.refresh).toHaveBeenCalledWith(2);

        await player.stop(false);
        expect(presenter.endSession).toHaveBeenCalledWith(3);
    });

    it('uses eligible custom playback without starting the native media source', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        const options = createKnownSDRPlayOptions({ playMethod: 'DirectPlay' });
        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();
        expect(backend.prepareCustomPlayback).toHaveBeenCalledWith(options);
        expect(backend.play).not.toHaveBeenCalled();
        expect(customPlaybackController.play).toHaveBeenCalledWith({
            audioTrackIndex: null,
            durationMicroseconds: 60_000_000,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 1_000_000,
            url: 'http://localhost/video.mp4?api_key=custom-decode-secret',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });
        expect(presenter.setDecodedFramePushMode).toHaveBeenCalledWith(true, 1);
        expect(presenter.attach).toHaveBeenCalledWith(backend.presentationSurface, 1);
        const eligibilityTelemetry = player.getCustomPlaybackEligibility();
        expect(eligibilityTelemetry).toEqual({
            audioOutputMode: null,
            eligible: true,
            hdr: false,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
        expect(eligibilityTelemetry).not.toHaveProperty('url');
        expect(JSON.stringify(eligibilityTelemetry)).not.toContain('custom-decode-secret');

        player.currentTime(2_500);
        await Promise.resolve();
        expect(customPlaybackController.seek).toHaveBeenCalledWith(2_500_000);
        expect(presenter.seek).toHaveBeenCalledWith(2);

        await player.stop(false);
        expect(customPlaybackController.destroy).toHaveBeenCalledOnce();
        expect(backend.stop).toHaveBeenCalledOnce();
    });

    it('uses raw 10-bit frames for enabled custom HDR tone mapping', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        webSettingsMockState.hdrToneMappingEnabled = true;
        presenterMockState.authorizedRawHDRRouteKeys = [
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        ];
        customDecodeMockState.eligible = true;
        customDecodeMockState.hdr = true;
        customDecodeMockState.videoDecoderBackend = 'bundled-hevc';
        customDecodeMockState.videoOutputMode = 'raw-planes';

        const options = createKnownHDRPlayOptions({ playMethod: 'DirectPlay' });
        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();

        expect(backend.play).not.toHaveBeenCalled();
        expect(presenter.configureColorPipeline).toHaveBeenCalledWith({
            inputMode: 'raw-yuv',
            metadata: expect.objectContaining({
                bitDepth: 10,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: 'pq'
            }),
            rawFrameFormat: 'I420P10',
            settings: expect.objectContaining({
                mode: 'hdr-to-sdr',
                outputTransfer: 'srgb'
            })
        }, 1);
        expect(customPlaybackController.play).toHaveBeenCalledWith(
            expect.objectContaining({
                rawVideoFrameFormat: 'I420P10',
                videoDecoderBackend: 'bundled-hevc',
                videoOutputMode: 'raw-planes'
            })
        );
    });

    it('selects the per-frame Dolby Vision reconstruction pipeline', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        webSettingsMockState.hdrToneMappingEnabled = true;
        presenterMockState.dolbyVisionAuthorized = true;
        customDecodeMockState.dolbyVision = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.hdr = true;
        customDecodeMockState.videoDecoderBackend = 'bundled-hevc';
        customDecodeMockState.videoOutputMode = 'raw-planes';

        const options = createKnownDolbyVisionPlayOptions({ playMethod: 'DirectPlay' });
        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();

        expect(backend.play).not.toHaveBeenCalled();
        expect(presenter.prewarmDolbyVisionPresentationAuthorization).toHaveBeenCalled();
        expect(presenter.configureColorPipeline).toHaveBeenCalledWith({
            inputMode: 'raw-dolby-vision',
            profile: 8,
            rawFrameFormat: 'I420P10',
            settings: expect.objectContaining({
                mode: 'hdr-to-sdr',
                outputTransfer: 'srgb',
                toneMapping: expect.objectContaining({ inputPeakNits: 4_000 })
            })
        }, 1);
        expect(customPlaybackController.play).toHaveBeenCalledWith(
            expect.objectContaining({
                rawVideoFrameFormat: 'I420P10',
                videoDecoderBackend: 'bundled-hevc',
                videoOutputMode: 'raw-planes'
            })
        );
    });

    it('keeps HDR on native video when custom tone mapping is disabled', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.hdr = true;
        customDecodeMockState.videoOutputMode = 'raw-planes';

        const options = createKnownHDRPlayOptions({ playMethod: 'DirectPlay' });
        await player.play(options);

        expect(customDecodeMockState.instances).toHaveLength(0);
        expect(backend.play).toHaveBeenCalledWith(options);
        expect(presenter.attach).not.toHaveBeenCalled();
        expect(presenter.endSession).toHaveBeenLastCalledWith(1);
    });

    it('prewarms selected audio synchronously and transfers it to custom playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;
        const options = createKnownSDRAudioPlayOptions();

        const playPromise = player.play(options);
        expect(audioPrewarmMockState.sampleRates).toEqual([48_000]);
        await playPromise;

        expect(audioPrewarmMockState.factoryLeases).toEqual([
            audioPrewarmMockState.leases[0]
        ]);
        await player.stop(false);
        expect(audioPrewarmMockState.leases[0].close).toHaveBeenCalledOnce();
    });

    it('closes the PCM prewarm before starting exact native media audio', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioOutputMode = 'native-media';
        customDecodeMockState.audioTrackIndex = 1;

        await player.play(createKnownSDRAudioPlayOptions());

        const customPlaybackController = getCustomPlaybackController();
        expect(audioPrewarmMockState.sampleRates).toEqual([ 48_000 ]);
        expect(audioPrewarmMockState.leases).toHaveLength(1);
        expect(audioPrewarmMockState.leases[0].close).toHaveBeenCalledOnce();
        expect(audioPrewarmMockState.factoryLeases).toEqual([ null ]);
        expect(customPlaybackController.play).toHaveBeenCalledWith(
            expect.objectContaining({
                audioOutputMode: 'native-media',
                audioTrackIndex: 1
            })
        );
        expect(player.getCustomPlaybackEligibility()).toMatchObject({
            audioOutputMode: 'native-media',
            eligible: true
        });
    });

    it('supplies the owned native-audio bridge factory to an audio controller', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioOutputMode = 'native-media';
        customDecodeMockState.audioTrackIndex = 1;

        await player.play(createKnownSDRAudioPlayOptions());

        expect(getCustomPlaybackController().nativeAudioBridgeFactory).toEqual(
            expect.any(Function)
        );
    });

    it.each([
        { channelCount: 6, expectedAudioOutputMode: 'native-media' },
        { channelCount: 2, expectedAudioOutputMode: null }
    ])('selects native media only for the exact measured layout %#', async ({
        channelCount,
        expectedAudioOutputMode
    }) => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.audioEligibilityOverride = selectExactNativeAudioRouteForMock;
        customDecodeMockState.eligible = true;
        nativeAudioCapabilityMockState.capabilities =
            createPartialNativeMediaAudioCapabilities();
        const options = createKnownSDRNativeAudioPlayOptions(channelCount);

        await player.play(options);

        if (expectedAudioOutputMode === 'native-media') {
            const customPlaybackController = getCustomPlaybackController();
            expect(backend.play).not.toHaveBeenCalled();
            expect(customPlaybackController.play).toHaveBeenCalledWith(
                expect.objectContaining({
                    audioOutputMode: 'native-media',
                    audioTrackIndex: 0
                })
            );
            expect(player.getNativeMediaAudioCapabilities()).toEqual(
                nativeAudioCapabilityMockState.capabilities
            );
            return;
        }

        expect(customDecodeMockState.instances).toHaveLength(0);
        expect(backend.play).toHaveBeenCalledWith(options);
        expect(player.getCustomPlaybackEligibility()).toEqual({
            eligible: false,
            reason: 'audio-layout-unsupported'
        });
    });

    it('closes an unused audio prewarm before native playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = false;
        const options = createKnownSDRAudioPlayOptions();

        const playPromise = player.play(options);
        expect(audioPrewarmMockState.sampleRates).toEqual([48_000]);
        await playPromise;

        expect(audioPrewarmMockState.factoryLeases).toHaveLength(0);
        expect(audioPrewarmMockState.leases[0].close).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledWith(options);
    });

    it('starts native playback before prewarm close and makes stop await cleanup', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const deferredClose = createDeferred<void>();
        audioPrewarmMockState.nextClosePromise = deferredClose.promise;
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = false;

        await player.play(createKnownSDRAudioPlayOptions());
        expect(backend.play).toHaveBeenCalledOnce();

        const stopPromise = player.stop(false);
        let stopSettled = false;
        const observedStopPromise = stopPromise.then((): void => {
            stopSettled = true;
        });
        await Promise.resolve();
        expect(stopSettled).toBe(false);

        deferredClose.resolve();
        await stopPromise;
        await observedStopPromise;
        expect(stopSettled).toBe(true);
        expect(audioPrewarmMockState.leases[0].close).toHaveBeenCalledOnce();
    });

    it('does not prewarm disabled or unsafe selected audio metadata', async () => {
        const disabledPlayer = new WebGPUPlayer();
        await disabledPlayer.play(createKnownSDRAudioPlayOptions());
        expect(audioPrewarmMockState.sampleRates).toHaveLength(0);

        webSettingsMockState.customDecodeEnabled = true;
        const unsafePlayer = new WebGPUPlayer();
        await unsafePlayer.play(createKnownSDRAudioPlayOptions('48000'));
        expect(audioPrewarmMockState.sampleRates).toHaveLength(0);
    });

    it('closes a transferred prewarm once when custom playback falls back', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;

        await player.play(createKnownSDRAudioPlayOptions());
        const customPlaybackController = getCustomPlaybackController();
        await customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 2_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        expect(audioPrewarmMockState.leases[0].close).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledOnce();
    });

    it('falls back to the same HTML session at the custom clock position', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        const options = createKnownSDRPlayOptions({ playMethod: 'DirectPlay' });
        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();
        customPlaybackController.currentTimeMicroseconds = 2_500_000;
        await customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 2_500_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        expect(backend.play).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledWith({
            ...options,
            playerStartPositionTicks: 25_000_000,
            suppressInitialUnpause: true
        });
        expect(backend.stop).not.toHaveBeenCalled();
        expect(presenter.endSession).toHaveBeenCalledWith(2);
        expect(customPlaybackController.destroy).toHaveBeenCalledOnce();

        player.currentTime(2_500);
        expect(customPlaybackController.seek).not.toHaveBeenCalled();
        expect(backend.currentTime).toHaveBeenCalledWith(2_500);
    });

    it('requests source renegotiation without replaying a custom-only URL natively', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        customPlaybackController.currentTimeMicroseconds = 2_500_000;
        const fallbackRequest = {
            disposition: 'renegotiate-source',
            generation: 1,
            mediaTimeMicroseconds: 2_500_000,
            preserveHTMLSession: true,
            reason: 'source-unsupported'
        };

        await expect(customPlaybackController.fallbackHook(fallbackRequest))
            .resolves.toBeUndefined();
        await expect(customPlaybackController.fallbackHook(fallbackRequest))
            .resolves.toBeUndefined();

        expect(backend.play).not.toHaveBeenCalled();
        expect(customPlaybackController.destroy).toHaveBeenCalledOnce();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_NOT_SUPPORTED
        });
        expect(player.currentTime()).toBe(2_500);
    });

    it('presents clock-selected decoded frames through the push renderer', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const decodedFrame = {
            durationMicroseconds: 41_667,
            frame: { close: vi.fn() },
            mediaTimeMicroseconds: 1_000_000,
            outputMode: 'video-frame'
        };
        customPlaybackController.takeCurrentFrame.mockReturnValueOnce(decodedFrame);

        runNextAnimationFrame();

        expect(presenter.presentDecodedFrame).toHaveBeenCalledWith(decodedFrame, 1);
        expect(customPlaybackController.notifyFramePresented).toHaveBeenCalledWith(decodedFrame);
        expect(animationFrameMockState.callbacks.size).toBe(1);
    });

    it('does not acknowledge a decoded frame rejected by the presenter', async () => {
        const consoleWarning = vi.spyOn(console, 'warn').mockImplementation((): void => undefined);
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const decodedFrame = {
            durationMicroseconds: 41_667,
            frame: { close: vi.fn() },
            mediaTimeMicroseconds: 1_000_000,
            outputMode: 'video-frame'
        };
        customPlaybackController.takeCurrentFrame.mockReturnValueOnce(decodedFrame);
        presenter.presentDecodedFrame.mockReturnValueOnce(false);

        runNextAnimationFrame();

        expect(customPlaybackController.notifyFramePresented).not.toHaveBeenCalled();
        expect(customPlaybackController.notifyFrameDiscarded).toHaveBeenCalledWith(decodedFrame);
        expect(animationFrameMockState.callbacks.size).toBe(0);
        expect(consoleWarning).toHaveBeenCalledOnce();
        consoleWarning.mockRestore();
    });

    it('discards and retries while the presenter is recovering', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const decodedFrame = {
            durationMicroseconds: 41_667,
            frame: { close: vi.fn() },
            mediaTimeMicroseconds: 1_000_000,
            outputMode: 'video-frame'
        };
        customPlaybackController.takeCurrentFrame.mockReturnValueOnce(decodedFrame);
        presenter.presentDecodedFrame.mockReturnValueOnce(false);
        presenter.getTelemetry.mockReturnValueOnce({ state: 'initializing' });

        runNextAnimationFrame();

        expect(customPlaybackController.notifyFrameDiscarded).toHaveBeenCalledWith(decodedFrame);
        expect(backend.play).not.toHaveBeenCalled();
        expect(animationFrameMockState.callbacks.size).toBe(1);
    });

    it('keeps polling a paused generation until its first decoded frame arrives', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        player.pause();
        expect(animationFrameMockState.callbacks.size).toBe(1);

        runNextAnimationFrame();
        expect(animationFrameMockState.callbacks.size).toBe(1);
        const decodedFrame = {
            durationMicroseconds: 41_667,
            frame: { close: vi.fn() },
            mediaTimeMicroseconds: 1_000_000,
            outputMode: 'video-frame'
        };
        customPlaybackController.takeCurrentFrame.mockReturnValueOnce(decodedFrame);
        runNextAnimationFrame();

        expect(presenter.presentDecodedFrame).toHaveBeenCalledWith(decodedFrame, 1);
        expect(customPlaybackController.notifyFramePresented).toHaveBeenCalledWith(decodedFrame);
        expect(animationFrameMockState.callbacks.size).toBe(0);
    });

    it('replaces the one-shot paused poll with a continuous loop on resume', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        player.pause();
        player.resume();

        expect(animationFrameMockState.callbacks.size).toBe(1);
        runNextAnimationFrame();
        expect(animationFrameMockState.callbacks.size).toBe(1);
    });

    it('re-decodes one paused frame after presentation invalidation without restarting HTML playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        customPlaybackController.currentTimeMicroseconds = 2_750_000;
        player.pause();
        expect(backend.notifyCustomPlaybackPaused).toHaveBeenCalledOnce();

        presenter.decodedPresentationRefreshHandler(1);
        presenter.decodedPresentationRefreshHandler(2);
        presenter.decodedPresentationRefreshHandler(1);
        customPlaybackController.eventHandler({
            generation: 2,
            reason: 'startup',
            type: 'waiting'
        });

        expect(presenter.seek).toHaveBeenCalledWith(2);
        expect(presenter.setDecodedFramePushMode).toHaveBeenCalledWith(true, 2);
        expect(customPlaybackController.seek).toHaveBeenCalledOnce();
        expect(customPlaybackController.seek).toHaveBeenCalledWith(2_750_000);
        expect(backend.notifyCustomPlaybackWaiting).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(customPlaybackController.playbackState).toBe('paused'));
        expect(backend.notifyCustomPlaybackPaused).toHaveBeenCalledOnce();
        expect(animationFrameMockState.callbacks.size).toBe(1);
        expect(backend.play).not.toHaveBeenCalled();
    });

    it('preserves an unpause requested during a paused presentation refresh', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const deferredRefresh = createDeferred<{
            fallbackReason: null
            generation: number
            status: 'started'
        }>();
        let resumeRequested = false;
        customPlaybackController.seek.mockImplementationOnce((mediaTimeMicroseconds: number) => {
            customPlaybackController.currentTimeMicroseconds = mediaTimeMicroseconds;
            customPlaybackController.playbackState = 'seeking';
            customPlaybackController.eventHandler({
                generation: 2,
                previousState: 'paused',
                state: 'seeking',
                type: 'statechange'
            });
            customPlaybackController.eventHandler({
                generation: 2,
                reason: 'startup',
                type: 'waiting'
            });
            return deferredRefresh.promise.then(result => {
                customPlaybackController.playbackState = resumeRequested ? 'playing' : 'paused';
                customPlaybackController.eventHandler({
                    generation: 2,
                    previousState: 'seeking',
                    state: customPlaybackController.playbackState,
                    type: 'statechange'
                });
                if (resumeRequested) {
                    customPlaybackController.eventHandler({ generation: 2, type: 'playing' });
                }
                return result;
            });
        });
        customPlaybackController.resume.mockImplementationOnce(() => {
            resumeRequested = true;
        });
        customPlaybackController.currentTimeMicroseconds = 2_750_000;
        player.pause();
        const unpauseListener = vi.fn();
        Events.on(player, 'unpause', unpauseListener);

        presenter.decodedPresentationRefreshHandler(1);
        expect(customPlaybackController.playbackState).toBe('seeking');
        expect(backend.notifyCustomPlaybackWaiting).not.toHaveBeenCalled();
        player.resume();
        deferredRefresh.resolve({
            fallbackReason: null,
            generation: 2,
            status: 'started'
        });

        await vi.waitFor(() => expect(customPlaybackController.playbackState).toBe('playing'));
        expect(backend.notifyCustomPlaybackPlaying).toHaveBeenLastCalledWith(true);
        expect(unpauseListener).toHaveBeenCalledOnce();
        expect(backend.notifyCustomPlaybackPaused).toHaveBeenCalledOnce();
        expect(backend.notifyCustomPlaybackWaiting).not.toHaveBeenCalled();
        expect(backend.play).not.toHaveBeenCalled();
    });

    it('preserves the paused shell event when a user seek supersedes a refresh', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const deferredRefresh = createDeferred<{
            fallbackReason: null
            generation: number
            status: 'superseded'
        }>();
        customPlaybackController.seek.mockImplementationOnce((mediaTimeMicroseconds: number) => {
            customPlaybackController.currentTimeMicroseconds = mediaTimeMicroseconds;
            customPlaybackController.playbackState = 'seeking';
            customPlaybackController.eventHandler({
                generation: 2,
                previousState: 'paused',
                state: 'seeking',
                type: 'statechange'
            });
            customPlaybackController.eventHandler({
                generation: 2,
                reason: 'startup',
                type: 'waiting'
            });
            return deferredRefresh.promise;
        }).mockImplementationOnce((mediaTimeMicroseconds: number) => {
            customPlaybackController.currentTimeMicroseconds = mediaTimeMicroseconds;
            customPlaybackController.eventHandler({
                generation: 3,
                reason: 'startup',
                type: 'waiting'
            });
            return Promise.resolve().then(() => {
                customPlaybackController.playbackState = 'playing';
                customPlaybackController.eventHandler({
                    generation: 3,
                    previousState: 'seeking',
                    state: 'playing',
                    type: 'statechange'
                });
                customPlaybackController.eventHandler({ generation: 3, type: 'playing' });
                return {
                    fallbackReason: null,
                    generation: 3,
                    status: 'started'
                };
            });
        });
        customPlaybackController.resume.mockImplementationOnce(() => undefined);
        customPlaybackController.currentTimeMicroseconds = 2_750_000;
        player.pause();
        const unpauseListener = vi.fn();
        Events.on(player, 'unpause', unpauseListener);

        presenter.decodedPresentationRefreshHandler(1);
        player.resume();
        player.currentTime(3_250);

        await vi.waitFor(() => expect(customPlaybackController.playbackState).toBe('playing'));
        expect(customPlaybackController.seek).toHaveBeenCalledTimes(2);
        expect(customPlaybackController.seek).toHaveBeenLastCalledWith(3_250_000);
        expect(backend.notifyCustomPlaybackPlaying).toHaveBeenLastCalledWith(true);
        expect(unpauseListener).toHaveBeenCalledOnce();
        expect(backend.notifyCustomPlaybackPaused).toHaveBeenCalledOnce();
        expect(backend.notifyCustomPlaybackWaiting).toHaveBeenCalledOnce();

        deferredRefresh.resolve({
            fallbackReason: null,
            generation: 2,
            status: 'superseded'
        });
        await Promise.resolve();
        await Promise.resolve();
        expect(unpauseListener).toHaveBeenCalledOnce();
    });

    it('discards a pending paused presentation refresh when playback stops', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const deferredRefresh = createDeferred<{
            fallbackReason: null
            generation: number
            status: 'started'
        }>();
        customPlaybackController.seek.mockReturnValueOnce(deferredRefresh.promise);
        player.pause();
        presenter.decodedPresentationRefreshHandler(1);
        expect(customPlaybackController.seek).toHaveBeenCalledOnce();

        await player.stop(false);
        deferredRefresh.resolve({
            fallbackReason: null,
            generation: 2,
            status: 'started'
        });
        await Promise.resolve();
        await Promise.resolve();

        expect(animationFrameMockState.callbacks.size).toBe(0);
        expect(backend.play).not.toHaveBeenCalled();
        expect(customPlaybackController.destroy).toHaveBeenCalledOnce();
    });

    it('routes custom clock, pause, gain, mute, and stream controls through the shell', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const pauseListener = vi.fn();
        const playingListener = vi.fn();
        const timeListener = vi.fn();
        const waitingListener = vi.fn();
        Events.on(player, 'pause', pauseListener);
        Events.on(player, 'playing', playingListener);
        Events.on(player, 'timeupdate', timeListener);
        Events.on(player, 'waiting', waitingListener);

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        customPlaybackController.currentTimeMicroseconds = 3_250_000;
        customPlaybackController.eventHandler({
            currentTimeMicroseconds: 3_250_000,
            durationMicroseconds: 60_000_000,
            generation: 1,
            type: 'timeupdate'
        });
        customPlaybackController.eventHandler({
            generation: 1,
            reason: 'video-frame',
            type: 'waiting'
        });
        player.pause();
        player.resume();
        player.setVolume(80);
        player.setMute(true);
        customDecodeMockState.audioTrackIndex = 1;
        player.setAudioStreamIndex(3);
        await vi.waitFor(() => (
            expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledWith(
                1,
                'decoded-pcm'
            )
        ));

        expect(player.currentTime()).toBe(3_250);
        expect(player.duration()).toBe(60_000);
        expect(timeListener).toHaveBeenCalled();
        expect(waitingListener).toHaveBeenCalledOnce();
        expect(pauseListener).toHaveBeenCalledOnce();
        expect(playingListener).toHaveBeenCalledTimes(2);
        expect(customPlaybackController.pause).toHaveBeenCalledOnce();
        expect(customPlaybackController.resume).toHaveBeenCalledOnce();
        const lastVolume = customPlaybackController.setVolume.mock.calls.at(-1)?.[0];
        expect(lastVolume).toBeCloseTo(0.512);
        expect(customPlaybackController.setMuted).toHaveBeenLastCalledWith(true);
        expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledWith(
            1,
            'decoded-pcm'
        );
        expect(backend.notifyCustomPlaybackVolumeChange).not.toHaveBeenCalled();
        expect(player.getVolume()).toBe(80);
        expect(player.isMuted()).toBe(true);
    });

    it('makes overlapping custom audio selections strictly last-write-wins', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.audioTrackIndex = 1;
        await player.play(createKnownSDRAudioPlayOptions());
        const customPlaybackController = getCustomPlaybackController();
        const firstSelection = createDeferred<boolean>();
        const secondSelection = createDeferred<boolean>();
        webSettingsMockState.customDecodeEnabledPromises.push(
            firstSelection.promise,
            secondSelection.promise
        );

        player.setAudioStreamIndex(3);
        player.setAudioStreamIndex(4);
        secondSelection.resolve(true);
        await vi.waitFor(() => (
            expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledOnce()
        ));
        firstSelection.resolve(true);
        await Promise.resolve();
        await Promise.resolve();

        expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledOnce();
        expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledWith(
            1,
            'decoded-pcm'
        );
    });

    it('reports custom pipeline stats and delegates live renderer controls', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const stats = await player.getStats() as {
            categories: Array<{ stats: Array<{ label: string, value: string }> }>
        };
        const settings = {
            display: { brightness: 0, contrast: 1, saturation: 1 },
            mode: 'hdr-to-sdr' as const,
            outputTransfer: 'srgb' as const,
            toneMapping: {
                desaturationStrength: 0.25,
                exposure: 0,
                inputPeakNits: 1_000,
                operator: 'aces' as const,
                outputPeakNits: 100,
                paperWhiteNits: 203
            },
            version: 4 as const
        };

        expect(stats.categories[0].stats).toContainEqual({
            label: 'Playback pipeline',
            value: 'WebCodecs / WebGPU'
        });
        expect(backend.getStats).not.toHaveBeenCalled();
        expect(player.updateRenderSettings(settings)).toBe(true);
        expect(presenter.updateRenderSettings).toHaveBeenCalledWith(settings, 1);
        expect(player.getRenderSettings()).toEqual({ mode: 'identity-sdr', version: 4 });
    });

    it('preserves a custom audio switch when later falling back to native playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const options = {
            audioStreamIndex: 1,
            mediaSource: {
                DefaultAudioStreamIndex: 1,
                MediaStreams: [{ Type: 'Video', VideoRangeType: 'SDR' }]
            },
            playMethod: 'DirectPlay'
        };

        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();
        customDecodeMockState.audioTrackIndex = 1;
        player.setAudioStreamIndex(3);
        await vi.waitFor(() => (
            expect(customPlaybackController.setAudioStreamIndex).toHaveBeenCalledWith(
                1,
                'decoded-pcm'
            )
        ));
        await customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 2,
            mediaTimeMicroseconds: 4_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        expect(backend.play).toHaveBeenCalledWith({
            ...options,
            audioStreamIndex: 3,
            mediaSource: {
                ...options.mediaSource,
                DefaultAudioStreamIndex: 3
            },
            playerStartPositionTicks: 40_000_000,
            suppressInitialUnpause: true
        });
    });

    it('uses same-session native fallback after augmentation only with exact base-profile proof', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        backend.profile = createNativeCompatibleProfile();
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });
        const options = createNativeCompatiblePlayOptions();

        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();
        await customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 4_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        expect(backend.play).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledWith({
            ...options,
            playerStartPositionTicks: 40_000_000,
            suppressInitialUnpause: true
        });
    });

    it('does not use a prior item native profile as current-session fallback proof', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        backend.profile = createNativeCompatibleProfile();
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);
        await player.getDeviceProfile({ Id: 'previous-item' }, { isRetry: false });
        const options = createNativeCompatiblePlayOptions();

        await player.play(options);
        const customPlaybackController = getCustomPlaybackController();
        await customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 4_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.PLAYER_ERROR
        });
    });

    it('coalesces repeated custom fallback requests into one native start', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const nativePlay = createDeferred<unknown>();
        backend.play.mockReturnValue(nativePlay.promise);

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const request = {
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 4_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        };
        const firstFallback = customPlaybackController.fallbackHook(request);
        const secondFallback = customPlaybackController.fallbackHook(request);
        await vi.waitFor(() => expect(backend.play).toHaveBeenCalledOnce());
        nativePlay.resolve(undefined);
        await Promise.all([ firstFallback, secondFallback ]);

        expect(customPlaybackController.destroy).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledOnce();
    });

    it('emits one terminal error when an established native fallback fails', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);

        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const fallbackError = new Error('native fallback failed');
        backend.play.mockRejectedValueOnce(fallbackError);
        await expect(customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 4_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        })).rejects.toBe(fallbackError);

        expect(backend.play).toHaveBeenCalledOnce();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.PLAYER_ERROR
        });
    });

    it('renegotiates a decoder failure during custom startup without a native source attempt', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        customDecodeMockState.startupFallback = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);

        await expect(player.play(
            createKnownSDRPlayOptions({ playMethod: 'DirectPlay' })
        )).resolves.toBe(PLAYBACK_SUPERSEDED);

        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_DECODE_ERROR
        });
        expect(player.currentTime()).toBe(1_000);
    });

    it('uses native playback when the custom presentation cannot initialize', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        presenter.configureColorPipeline.mockResolvedValueOnce(false);
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;

        const options = createKnownSDRPlayOptions({ playMethod: 'DirectPlay' });
        await player.play(options);

        expect(backend.prepareCustomPlayback).toHaveBeenCalledOnce();
        expect(customDecodeMockState.instances).toHaveLength(0);
        expect(backend.play).toHaveBeenCalledWith(options);
    });

    it('renegotiates instead of replaying a widened source when presentation fails', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        presenter.configureColorPipeline.mockResolvedValueOnce(false);
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });

        const result = await player.play(createKnownSDRPlayOptions({
            playMethod: 'DirectPlay',
            playerStartPositionTicks: 20_000_000
        }));

        expect(result).toBe(PLAYBACK_SUPERSEDED);
        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.PLAYER_ERROR
        });
        expect(player.currentTime()).toBe(2_000);
    });

    it('renegotiates a widened source when custom decode is disabled before play', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        webSettingsMockState.customDecodeEnabled = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });
        webSettingsMockState.customDecodeEnabled = false;

        const result = await player.play(createKnownSDRPlayOptions({
            playMethod: 'DirectPlay',
            playerStartPositionTicks: 20_000_000
        }));

        expect(result).toBe(PLAYBACK_SUPERSEDED);
        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_NOT_SUPPORTED
        });
        expect(player.currentTime()).toBe(2_000);
    });

    it('bounds custom setup and retries a widened source from its session start', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        presenter.configureColorPipeline.mockReturnValue(new Promise<boolean>(() => undefined));
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });
        vi.useFakeTimers();

        const playPromise = player.play(createKnownSDRPlayOptions({
            playMethod: 'DirectPlay',
            playerStartPositionTicks: 30_000_000
        }));
        await vi.advanceTimersByTimeAsync(0);
        expect(presenter.configureColorPipeline).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(
            microsecondsToMilliseconds(CUSTOM_PLAYBACK_SETUP_TIMEOUT_MICROSECONDS)
        );

        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);
        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_DECODE_ERROR
        });
        expect(player.currentTime()).toBe(3_000);
    });

    it('keeps augmentation conservative across an overlapping retry profile query', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = false;
        const errorListener = vi.fn();
        Events.on(player, 'error', errorListener);
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: false });
        await player.getDeviceProfile({ Id: 'item' }, { isRetry: true });
        player.currentTime(42_000);

        const result = await player.play(createKnownSDRPlayOptions({
            playMethod: 'DirectPlay',
            playerStartPositionTicks: 0
        }));

        expect(result).toBe(PLAYBACK_SUPERSEDED);
        expect(backend.play).not.toHaveBeenCalled();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_NOT_SUPPORTED
        });
        expect(player.currentTime()).toBe(0);
    });

    it('advances the shared generation when presentation falls back', async () => {
        const player = new WebGPUPlayer();
        const presenter = getPresenter();
        await player.play(createKnownSDRPlayOptions());

        presenter.fallbackHandler(1);
        player.currentTime(1_000);

        expect(presenter.seek).toHaveBeenCalledWith(3);
    });

    it('keeps unknown and HDR inputs on direct HTML presentation', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        const HDRPlayOptions = {
            mediaSource: {
                MediaStreams: [{ Type: 'Video', VideoRangeType: 'HDR10' }]
            }
        };

        await expect(player.play(HDRPlayOptions)).resolves.toBe(HDRPlayOptions);

        expect(presenter.startSession).not.toHaveBeenCalled();
        expect(presenter.attach).not.toHaveBeenCalled();
        expect(presenter.endSession).toHaveBeenCalledWith(1);
    });

    it('converts player timing through integer microseconds at millisecond boundaries', () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();

        backend.currentTimeMilliseconds = 12.3456789;
        backend.durationMilliseconds = 98.7654321;
        expect(player.currentTime()).toBe(12.346);
        expect(player.duration()).toBe(98.765);

        player.currentTime(-12.3456789);
        expect(backend.currentTime).toHaveBeenLastCalledWith(-12.346);
    });

    it('exposes the complete manager-facing delegation surface', () => {
        const player = new WebGPUPlayer();
        const methodNames = [
            'canPlayMediaType', 'canPlayItem', 'supportsPlayMethod', 'getDeviceProfile',
            'supports', 'currentSrc', 'cancelPendingPlay', 'play', 'stop', 'destroy', 'currentTime',
            'duration', 'seekable', 'pause', 'resume', 'unpause', 'paused',
            'setSubtitleStreamIndex', 'setSecondarySubtitleStreamIndex',
            'resetSubtitleOffset', 'setSubtitleOffset', 'getSubtitleOffset',
            'enableShowingSubtitleOffset',
            'disableShowingSubtitleOffset', 'isShowingSubtitleOffsetEnabled',
            'canSetAudioStreamIndex', 'setAudioStreamIndex', 'setVolume', 'getVolume',
            'volumeUp', 'volumeDown', 'setMute', 'isMuted', 'setPlaybackRate',
            'getPlaybackRate', 'getSupportedPlaybackRates', 'setBrightness',
            'getBrightness', 'setAspectRatio', 'getAspectRatio',
            'getSupportedAspectRatios', 'setPictureInPictureEnabled',
            'isPictureInPictureEnabled', 'togglePictureInPicture',
            'setAirPlayEnabled', 'isAirPlayEnabled', 'toggleAirPlay',
            'getBufferedRanges', 'getStats', 'getPresentationTelemetry'
        ];

        for (const methodName of methodNames) {
            expect(typeof player[methodName as keyof WebGPUPlayer]).toBe('function');
        }
    });

    it('delegates playback, track, output, and reporting methods to the owned backend', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const bufferedRanges = [{ start: 1, end: 2 }];
        const stats = { categories: [{ type: 'video' }] };
        const statsPromise = Promise.resolve(stats);
        backend.getBufferedRanges.mockReturnValue(bufferedRanges);
        backend.getStats.mockReturnValue(statsPromise);

        player.pause();
        player.resume();
        player.unpause();
        player.resetSubtitleOffset();
        player.setSubtitleStreamIndex(3);
        player.setSecondarySubtitleStreamIndex(4);
        player.setAudioStreamIndex(5);
        player.setVolume(62);
        player.setMute(true);
        player.setPlaybackRate(1.25);
        player.setBrightness(80);
        player.setAspectRatio('cover');
        player.setPictureInPictureEnabled(true);
        player.togglePictureInPicture();
        player.setAirPlayEnabled(true);
        player.toggleAirPlay();

        expect(backend.pause).toHaveBeenCalledOnce();
        expect(backend.resume).toHaveBeenCalledOnce();
        expect(backend.unpause).toHaveBeenCalledOnce();
        expect(backend.resetSubtitleOffset).toHaveBeenCalledOnce();
        expect(backend.setSubtitleStreamIndex).toHaveBeenCalledWith(3);
        expect(backend.setSecondarySubtitleStreamIndex).toHaveBeenCalledWith(4);
        expect(backend.setAudioStreamIndex).toHaveBeenCalledWith(5);
        expect(backend.setVolume).toHaveBeenCalledWith(62);
        expect(backend.setMute).toHaveBeenCalledWith(true);
        expect(backend.setPlaybackRate).toHaveBeenCalledWith(1.25);
        expect(backend.setBrightness).toHaveBeenCalledWith(80);
        expect(backend.setAspectRatio).toHaveBeenCalledWith('cover');
        expect(presenter.refresh).toHaveBeenCalledWith(0);
        expect(backend.setPictureInPictureEnabled).toHaveBeenCalledWith(true);
        expect(backend.togglePictureInPicture).toHaveBeenCalledOnce();
        expect(backend.setAirPlayEnabled).toHaveBeenCalledWith(true);
        expect(backend.toggleAirPlay).toHaveBeenCalledOnce();
        expect(player.getVolume()).toBe(50);
        expect(player.isMuted()).toBe(false);
        expect(player.getPlaybackRate()).toBe(1);
        expect(player.getBrightness()).toBe(100);
        expect(player.isPictureInPictureEnabled()).toBe(false);
        expect(player.isAirPlayEnabled()).toBe(false);
        expect(player.getBufferedRanges()).toBe(bufferedRanges);
        expect(player.getStats()).toBe(statsPromise);
        await expect(statsPromise).resolves.toBe(stats);
    });

    it('mirrors backend status properties and masks native-output modes without an HTML session', () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        backend.isFetching = true;
        backend.forcedFullscreen = true;

        expect(player.isFetching).toBe(true);
        expect(player.forcedFullscreen).toBe(true);
        expect(player.supports('PictureInPicture')).toBe(false);
        expect(player.supports('AirPlay')).toBe(false);
        expect(player.supports('PlaybackRate')).toBe(false);
        expect(player.supports('SetBrightness')).toBe(false);
        expect(player.supports('SetAspectRatio')).toBe(true);
    });

    it('exposes native-output capabilities only while direct HTML playback is authoritative', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const nativeOutputFeatures = [
            'AirPlay',
            'PictureInPicture',
            'PlaybackRate',
            'SetBrightness'
        ];

        await player.play({
            mediaSource: {
                MediaStreams: [{ Type: 'Video', VideoRangeType: 'HDR10' }]
            }
        });

        for (const feature of nativeOutputFeatures) {
            expect(player.supports(feature)).toBe(true);
        }

        await player.stop(false);
        for (const feature of nativeOutputFeatures) {
            expect(player.supports(feature)).toBe(false);
        }
        expect(backend.supports).toHaveBeenCalledTimes(nativeOutputFeatures.length);
    });

    it('restores native-output capabilities after WebGPU presentation falls back', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };

        await player.play(createKnownSDRPlayOptions());

        expect(player.supports('PictureInPicture')).toBe(false);
        expect(player.supports('PlaybackRate')).toBe(false);

        presenter.fallbackHandler(1);

        expect(player.supports('PictureInPicture')).toBe(true);
        expect(player.supports('PlaybackRate')).toBe(true);
    });

    it('keeps custom capabilities and ranges masked until native fallback is established', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const container = document.createElement('div');
        const video = document.createElement('video');
        const bufferedRanges = [{ start: 1, end: 2 }];
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        backend.getBufferedRanges.mockReturnValue(bufferedRanges);
        webSettingsMockState.customDecodeEnabled = true;
        customDecodeMockState.eligible = true;
        await player.play(createKnownSDRPlayOptions({ playMethod: 'DirectPlay' }));
        const customPlaybackController = getCustomPlaybackController();
        const customDestroy = createDeferred<void>();
        const nativePlay = createDeferred<unknown>();
        customPlaybackController.destroy.mockReturnValueOnce(customDestroy.promise);
        backend.play.mockReturnValueOnce(nativePlay.promise);

        expect(player.supports('AirPlay')).toBe(false);
        expect(player.supports('SetBrightness')).toBe(false);
        expect(player.getBufferedRanges()).toEqual([]);

        const fallbackPromise = customPlaybackController.fallbackHook({
            disposition: 'same-session-native',
            generation: 1,
            mediaTimeMicroseconds: 4_000_000,
            preserveHTMLSession: true,
            reason: 'lifecycle-failed'
        });

        expect(customPlaybackController.destroy).toHaveBeenCalledOnce();
        expect(backend.play).not.toHaveBeenCalled();
        expect(player.supports('AirPlay')).toBe(false);
        expect(player.getBufferedRanges()).toEqual([]);

        customDestroy.resolve(undefined);
        await vi.waitFor(() => expect(backend.play).toHaveBeenCalledOnce());
        expect(player.supports('AirPlay')).toBe(false);
        expect(player.getBufferedRanges()).toEqual([]);

        nativePlay.resolve(undefined);
        await fallbackPromise;

        expect(player.supports('AirPlay')).toBe(true);
        expect(player.supports('SetBrightness')).toBe(true);
        expect(player.getBufferedRanges()).toBe(bufferedRanges);
    });
});

describe('WebGPUPlayer event and lifecycle contract', () => {
    beforeEach(() => {
        htmlPlayerMockState.instances.length = 0;
        htmlPlayerMockState.owners.length = 0;
        presenterMockState.instances.length = 0;
        webSettingsMockState.customDecodeEnabled = false;
        customDecodeMockState.audioEligibilityOverride = null;
        customDecodeMockState.eligible = false;
        customDecodeMockState.audioOutputMode = 'decoded-pcm';
        customDecodeMockState.audioTrackIndex = null;
        customDecodeMockState.instances.length = 0;
        customProfileMockState.augmentationCalls.length = 0;
        customProfileMockState.runtimeAvailable = true;
        nativeAudioCapabilityMockState.capabilities = null;
    });

    it('pins the complete HTML backend event surface', () => {
        expect(HTML_PLAYER_EVENTS).toEqual(EXPECTED_HTML_PLAYER_EVENTS);
    });

    it.each(EXPECTED_HTML_PLAYER_EVENTS)('forwards %s once with wrapper identity and unchanged arguments', async eventName => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const listener = vi.fn();
        const firstArgument = { value: 1 };
        const secondArgument = ['second'];
        Events.on(player, eventName, listener);

        await player.play({});
        Events.trigger(backend, eventName, [firstArgument, secondArgument]);

        expect(listener).toHaveBeenCalledOnce();
        expect(listener.mock.contexts[0]).toBe(player);
        expect(listener.mock.calls[0][0]).toEqual({ type: eventName });
        expect(listener.mock.calls[0][1]).toBe(firstArgument);
        expect(listener.mock.calls[0][2]).toBe(secondArgument);
    });

    it('replaces forwarding handlers without duplicating events across sessions', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const listener = vi.fn();
        Events.on(player, 'timeupdate', listener);

        await player.play({ source: 1 });
        await player.play({ source: 2 });
        Events.trigger(backend, 'timeupdate');

        expect(listener).toHaveBeenCalledOnce();
    });

    it('serializes overlapping backend play requests and skips stale presentation', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const firstPlayDeferred = createDeferred<unknown>();
        const secondPlayDeferred = createDeferred<unknown>();
        backend.play.mockImplementation((options: { source: number }) => {
            return options.source === 1 ? firstPlayDeferred.promise : secondPlayDeferred.promise;
        });

        const firstPlayPromise = player.play({ source: 1 });
        const secondPlayPromise = player.play({ source: 2 });

        expect(backend.play).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledWith({ source: 1 });

        firstPlayDeferred.resolve('first');
        await vi.waitFor(() => expect(backend.play).toHaveBeenCalledTimes(2));
        expect(backend.stop).toHaveBeenCalledOnce();
        expect(backend.stop).toHaveBeenCalledWith(false);
        expect(backend.play).toHaveBeenLastCalledWith({ source: 2 });

        secondPlayDeferred.resolve('second');
        await expect(firstPlayPromise).resolves.toBe(PLAYBACK_SUPERSEDED);
        await expect(secondPlayPromise).resolves.toBe('second');
        expect(getPresenter().attach).not.toHaveBeenCalled();
    });

    it('does not queue stop behind an unresolved backend play request', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const playDeferred = createDeferred<unknown>();
        backend.play.mockReturnValueOnce(playDeferred.promise);

        const playPromise = player.play({ source: 1 });
        const stopPromise = player.stop(false);

        expect(backend.cancelPendingPlay).toHaveBeenCalled();
        expect(backend.stop).toHaveBeenCalledOnce();
        expect(backend.stop).toHaveBeenCalledWith(false);

        playDeferred.resolve(undefined);
        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);
        await stopPromise;
    });

    it('cancels replacement playback while it waits for an asynchronous stop', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const destructiveStopDeferred = createDeferred<void>();
        await player.play({ source: 1 });
        backend.stop.mockReturnValueOnce(destructiveStopDeferred.promise);

        const stopPromise = player.stop(true);
        const replacementPlayPromise = player.play({ source: 2 });
        expect(backend.play).toHaveBeenCalledTimes(1);

        player.cancelPendingPlay();
        destructiveStopDeferred.resolve(undefined);

        await stopPromise;
        await expect(replacementPlayPromise).resolves.toBe(PLAYBACK_SUPERSEDED);
        expect(backend.play).toHaveBeenCalledTimes(1);
        expect(backend.play).not.toHaveBeenCalledWith({ source: 2 });
    });

    it('leaves established playback active when there is no pending play', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const waitingListener = vi.fn();
        Events.on(player, 'waiting', waitingListener);
        await player.play({ source: 1 });
        const endSessionCallCount = presenter.endSession.mock.calls.length;
        backend.cancelPendingPlay.mockClear();

        player.cancelPendingPlay();
        Events.trigger(backend, 'waiting');

        expect(backend.cancelPendingPlay).toHaveBeenCalledOnce();
        expect(waitingListener).toHaveBeenCalledOnce();
        expect(presenter.endSession).toHaveBeenCalledTimes(endSessionCallCount);
        expect(backend.stop).not.toHaveBeenCalled();
    });

    it('discards a retained forwarding callback from an older generation', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend() as MockHTMLPlayer & {
            _callbacks: Record<string, Array<(event: { type: string }) => void>>
        };
        const listener = vi.fn();
        Events.on(player, 'timeupdate', listener);

        await player.play({ source: 1 });
        const staleHandler = backend._callbacks.timeupdate[0];
        await player.play({ source: 2 });
        staleHandler.call(backend, { type: 'timeupdate' });

        expect(listener).not.toHaveBeenCalled();
    });

    it('forwards stop(false) once per session and reuses the owned backend', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        await player.play({ source: 1 });

        await player.stop(false);
        await player.stop(false);
        expect(backend.stop).toHaveBeenCalledTimes(1);
        expect(backend.stop).toHaveBeenCalledWith(false);
        expect(backend.destroy).not.toHaveBeenCalled();

        await player.play({ source: 2 });
        await player.stop(false);
        expect(htmlPlayerMockState.instances).toHaveLength(1);
        expect(backend.stop).toHaveBeenCalledTimes(2);
    });

    it('prevents reentrant destroy from duplicating backend teardown during stop(true)', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        backend.stop.mockImplementation((destroyPlayer: boolean) => {
            Events.trigger(backend, 'stopped', [{ src: 'backend-source' }]);
            if (destroyPlayer) {
                backend.destroy();
            }
            return Promise.resolve();
        });
        Events.on(player, 'stopped', () => player.destroy());
        await player.play({});

        await player.stop(true);

        expect(backend.stop).toHaveBeenCalledOnce();
        expect(backend.stop).toHaveBeenCalledWith(true);
        expect(backend.destroy).toHaveBeenCalledOnce();
    });

    it('retires stopped forwarding before a listener requests another stop', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const stoppedListener = vi.fn();
        let nestedStopPromise: Promise<unknown> | null = null;
        backend.stop.mockImplementation(() => {
            Events.trigger(backend, 'stopped');
            return Promise.resolve();
        });
        Events.on(player, 'stopped', () => {
            stoppedListener();
            nestedStopPromise = player.stop(false);
        });
        await player.play({});

        await player.stop(false);
        await nestedStopPromise;

        expect(stoppedListener).toHaveBeenCalledOnce();
        expect(backend.stop).toHaveBeenCalledOnce();
    });

    it('starts a play requested by stopped only after destructive stop completes', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const operationOrder: string[] = [];
        let replacementPlayPromise: Promise<unknown> | null = null;
        backend.play.mockImplementation((options: { source: number }) => {
            operationOrder.push(`play-${options.source}`);
            return Promise.resolve(options);
        });
        backend.destroy.mockImplementation(() => {
            operationOrder.push('destroy');
        });
        backend.stop.mockImplementation((destroyPlayer: boolean) => {
            operationOrder.push('stop-start');
            Events.trigger(backend, 'stopped');
            if (destroyPlayer) {
                backend.destroy();
            }
            operationOrder.push('stop-end');
            return Promise.resolve();
        });
        Events.on(player, 'stopped', () => {
            replacementPlayPromise = player.play({ source: 2 });
        });
        await player.play({ source: 1 });
        operationOrder.length = 0;

        await player.stop(true);
        await replacementPlayPromise;

        expect(operationOrder).toEqual([
            'stop-start',
            'destroy',
            'stop-end',
            'play-2'
        ]);
    });

    it('invalidates presentation and forwarding when the backend stops naturally', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const playResult = { source: 1 };
        const playDeferred = createDeferred<unknown>();
        const stoppedListener = vi.fn();
        const waitingListener = vi.fn();
        const container = document.createElement('div');
        const video = document.createElement('video');
        container.appendChild(video);
        backend.presentationSurface = { container, video };
        backend.play.mockReturnValue(playDeferred.promise);
        Events.on(player, 'stopped', stoppedListener);
        Events.on(player, 'waiting', waitingListener);

        const playerPlayPromise = player.play(playResult);
        Events.trigger(backend, 'stopped', [{ src: 'backend-source' }]);
        playDeferred.resolve(playResult);
        await expect(playerPlayPromise).resolves.toBe(PLAYBACK_SUPERSEDED);
        Events.trigger(backend, 'waiting');

        expect(stoppedListener).toHaveBeenCalledOnce();
        expect(presenter.endSession).toHaveBeenCalledWith(2);
        expect(presenter.attach).not.toHaveBeenCalled();
        expect(waitingListener).not.toHaveBeenCalled();
    });

    it('starts replacement playback from natural stopped without stopping the ended backend again', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        let replacementPlayPromise: Promise<unknown> | null = null;
        Events.on(player, 'stopped', () => {
            replacementPlayPromise = player.play({ source: 2 });
        });
        await player.play({ source: 1 });

        Events.trigger(backend, 'stopped');
        await replacementPlayPromise;

        expect(backend.stop).not.toHaveBeenCalled();
        expect(backend.play).toHaveBeenCalledTimes(2);
        expect(backend.play).toHaveBeenLastCalledWith({ source: 2 });
    });

    it('detaches forwarding and never attaches presentation after rejected playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const waitingListener = vi.fn();
        const playbackError = new Error('simulated playback rejection');
        backend.play.mockRejectedValueOnce(playbackError);
        Events.on(player, 'waiting', waitingListener);

        await expect(player.play({})).rejects.toBe(playbackError);
        Events.trigger(backend, 'waiting');

        expect(presenter.endSession).toHaveBeenCalledWith(2);
        expect(presenter.attach).not.toHaveBeenCalled();
        expect(waitingListener).not.toHaveBeenCalled();
    });

    it('invalidates unresolved playback before forwarding a backend error', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const presenter = getPresenter();
        const playDeferred = createDeferred<unknown>();
        const errorListener = vi.fn();
        backend.play.mockReturnValueOnce(playDeferred.promise);
        Events.on(player, 'error', errorListener);

        const playPromise = player.play(createKnownSDRPlayOptions());
        Events.trigger(backend, 'error', [{ code: 3 }]);
        playDeferred.resolve(undefined);

        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);
        expect(errorListener).toHaveBeenCalledOnce();
        expect(presenter.endSession).toHaveBeenCalledWith(2);
        expect(presenter.attach).not.toHaveBeenCalled();
    });

    it('retires backend forwarding after the first terminal error', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const errorListener = vi.fn();
        const waitingListener = vi.fn();
        Events.on(player, 'error', errorListener);
        Events.on(player, 'waiting', waitingListener);
        await player.play({});

        Events.trigger(backend, 'error', [{ code: 3 }]);
        Events.trigger(backend, 'error', [{ code: 3 }]);
        Events.trigger(backend, 'waiting');

        expect(errorListener).toHaveBeenCalledOnce();
        expect(waitingListener).not.toHaveBeenCalled();
    });

    it('escalates a pending reusable stop to destructive teardown', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const reusableStopDeferred = createDeferred<void>();
        backend.stop.mockImplementation((destroyPlayer: boolean) => {
            if (destroyPlayer) {
                backend.destroy();
                return Promise.resolve();
            }

            return reusableStopDeferred.promise;
        });
        await player.play({});

        const reusableStopPromise = player.stop(false);
        const destructiveStopPromise = player.stop(true);
        expect(backend.stop).toHaveBeenCalledTimes(2);
        expect(backend.stop).toHaveBeenNthCalledWith(1, false);
        expect(backend.stop).toHaveBeenNthCalledWith(2, true);
        expect(backend.destroy).toHaveBeenCalledOnce();
        await Promise.all([reusableStopPromise, destructiveStopPromise]);

        expect(backend.stop).toHaveBeenCalledTimes(2);
        expect(backend.stop).toHaveBeenNthCalledWith(1, false);
        expect(backend.stop).toHaveBeenNthCalledWith(2, true);
        expect(backend.destroy).toHaveBeenCalledOnce();
        reusableStopDeferred.resolve();
    });

    it('finishes queued teardown before starting a newer session', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const reusableStopDeferred = createDeferred<void>();
        backend.stop.mockImplementation((destroyPlayer: boolean) => {
            if (destroyPlayer) {
                backend.destroy();
                return Promise.resolve();
            }

            return reusableStopDeferred.promise;
        });
        await player.play({ source: 1 });

        const reusableStopPromise = player.stop(false);
        const destructiveStopPromise = player.stop(true);
        const replacementPlayPromise = player.play({ source: 2 });
        expect(backend.play).toHaveBeenCalledTimes(1);
        await Promise.all([
            reusableStopPromise,
            destructiveStopPromise,
            replacementPlayPromise
        ]);

        expect(backend.stop).toHaveBeenCalledTimes(2);
        expect(backend.stop).toHaveBeenNthCalledWith(1, false);
        expect(backend.stop).toHaveBeenNthCalledWith(2, true);
        expect(backend.destroy).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenLastCalledWith({ source: 2 });
        reusableStopDeferred.resolve();
    });

    it('waits for asynchronous destructive teardown before starting playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const destructiveStopDeferred = createDeferred<void>();
        backend.stop.mockImplementation((destroyPlayer: boolean) => {
            if (destroyPlayer) {
                return destructiveStopDeferred.promise;
            }

            return Promise.resolve();
        });
        await player.play({ source: 1 });

        const stopPromise = player.stop(true);
        const replacementPlayPromise = player.play({ source: 2 });
        expect(backend.play).toHaveBeenCalledTimes(1);

        destructiveStopDeferred.resolve();
        await Promise.all([stopPromise, replacementPlayPromise]);

        expect(backend.play).toHaveBeenCalledTimes(2);
        expect(backend.play).toHaveBeenLastCalledWith({ source: 2 });
    });

    it('allows destroy to retire a pending reusable stop before later playback', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const reusableStopDeferred = createDeferred<void>();
        backend.stop.mockImplementation(() => {
            Events.trigger(backend, 'stopped');
            return reusableStopDeferred.promise;
        });
        await player.play({ source: 1 });

        const stopPromise = player.stop(false);
        player.destroy();
        const replacementPlayPromise = player.play({ source: 2 });

        await Promise.all([stopPromise, replacementPlayPromise]);
        expect(backend.destroy).toHaveBeenCalledOnce();
        expect(backend.play).toHaveBeenCalledTimes(2);
        expect(backend.play).toHaveBeenLastCalledWith({ source: 2 });
        reusableStopDeferred.resolve();
    });

    it('returns the original stop promise when stopped starts a new session reentrantly', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        backend.stop.mockImplementation(() => {
            Events.trigger(backend, 'stopped');
            return Promise.resolve('stopped');
        });
        Events.on(player, 'stopped', () => {
            void player.play({ source: 2 });
        });
        await player.play({ source: 1 });

        await expect(player.stop(false)).resolves.toBe('stopped');

        expect(backend.play).toHaveBeenCalledTimes(2);
    });

    it('allows destroy to finish teardown after stop(true) throws synchronously', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const stopError = new Error('simulated stop throw');
        backend.stop.mockImplementation(() => {
            throw stopError;
        });
        await player.play({});

        await expect(player.stop(true)).rejects.toBe(stopError);
        player.destroy();

        expect(backend.stop).toHaveBeenCalledOnce();
        expect(backend.destroy).toHaveBeenCalledOnce();
    });

    it('allows destroy to finish teardown after stop(true) rejects', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const stopError = new Error('simulated stop rejection');
        backend.stop.mockRejectedValueOnce(stopError);
        await player.play({});

        await expect(player.stop(true)).rejects.toBe(stopError);
        player.destroy();

        expect(backend.stop).toHaveBeenCalledOnce();
        expect(backend.destroy).toHaveBeenCalledOnce();
    });

    it('makes direct destroy idempotent and rebinds on the next play', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        await player.play({ source: 1 });

        player.destroy();
        player.destroy();
        expect(backend.destroy).toHaveBeenCalledTimes(1);

        await player.play({ source: 2 });
        player.destroy();
        expect(backend.destroy).toHaveBeenCalledTimes(2);
    });

    it('does not forward backend events after destroy', async () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        const listener = vi.fn();
        Events.on(player, 'waiting', listener);
        await player.play({});

        player.destroy();
        Events.trigger(backend, 'waiting');

        expect(listener).not.toHaveBeenCalled();
    });
});
