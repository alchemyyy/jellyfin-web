import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLAYBACK_SUPERSEDED } from 'constants/playbackResult';
import browser from 'scripts/browser';
import appSettings from 'scripts/settings/appSettings';
import Events from 'utils/events';

type Deferred<Value> = {
    promise: Promise<Value>
    resolve: (value: Value) => void
};

type SubtitleTrackEvent = {
    EndPositionTicks: number
    StartPositionTicks: number
    Text: string
};

type SpecializedSubtitleRendererOptions = Record<string, unknown> & {
    aspectRatio?: string
    canvas?: HTMLCanvasElement
    onError?: () => void
    renderAhead?: number
    timeOffset?: number
    video?: EventTarget & { currentTime: number }
};

type TestMediaStream = {
    Codec?: string
    DeliveryMethod?: string
    DeliveryUrl?: string
    Index: number
    IsExternal?: boolean
    Type: string
};

type TestPlayOptions = {
    aspectRatio?: string
    fullscreen: boolean
    item: { ServerId: string }
    mediaSource: {
        Container: string
        DefaultAudioStreamIndex: number
        DefaultSecondarySubtitleStreamIndex: number
        DefaultSubtitleStreamIndex: number
        MediaAttachments?: Array<{ DeliveryUrl: string, MimeType: string }>
        MediaStreams: TestMediaStream[]
        TranscodingUrl?: string
    }
    playMethod: string
    playerStartPositionTicks: number
    transcodingOffsetTicks?: number
    url: string
};

type HtmlVideoPlayerTestHarness = {
    _currentPlayOptions: unknown
    cancelPendingPlay: () => void
    createMediaElement: (options: { fullscreen: boolean }, playSessionGeneration?: number) => Promise<HTMLVideoElement | null>
    _setSubtitleOffset: (offset: number | string) => void
    currentTime: (timeMilliseconds?: number) => number | undefined
    currentSrc: () => string | undefined
    destroy: () => void
    getPresentationSurface: () => { container: HTMLDivElement, video: HTMLVideoElement } | null
    isFetching: boolean
    onError: (event: Event) => void
    notifyCustomPlaybackEnded: () => boolean
    notifyCustomPlaybackPaused: () => boolean
    notifyCustomPlaybackPlaying: () => boolean
    notifyCustomPlaybackTimeUpdate: (timeMilliseconds: number) => boolean
    notifyCustomPlaybackVolumeChange: () => boolean
    notifyCustomPlaybackWaiting: () => boolean
    onPlay: () => void
    play: (options: ReturnType<typeof createPlayOptions>) => Promise<unknown>
    prepareCustomPlayback: (options: ReturnType<typeof createPlayOptions>) => Promise<
        { container: HTMLDivElement, video: HTMLVideoElement } | string | null
    >
    setAspectRatio: (aspectRatio: string) => void
    setSubtitleStreamIndex: (index: number) => void
    stop: (destroyPlayer: boolean) => Promise<void>
    updateVideoUrl: (options: ReturnType<typeof createPlayOptions>, playSessionGeneration?: number) => Promise<void>
    updateSubtitleText: (timeMilliseconds: number) => void
};

const subtitleAppearanceHelperMock = vi.hoisted(() => ({
    applyStyles: vi.fn(),
    getStyles: vi.fn(() => ({ text: [] }))
}));

const playbackManagerMock = vi.hoisted(() => ({
    getSubtitleUrl: vi.fn((track: { DeliveryUrl: string }) => track.DeliveryUrl),
    getMaxStreamingBitrate: vi.fn(() => 10_000_000),
    trackHasSecondarySubtitleSupport: vi.fn(() => true)
}));

const htmlMediaHelperMock = vi.hoisted(() => ({
    applySrc: vi.fn<(element: { src: string }, source: string) => Promise<void>>().mockResolvedValue(undefined),
    bindEventsToHlsPlayer: vi.fn<(...eventArguments: unknown[]) => void>(),
    destroyCastPlayer: vi.fn(),
    destroyFlvPlayer: vi.fn(),
    destroyHlsPlayer: vi.fn(),
    enableHlsJsPlayerForCodecs: vi.fn<(mediaSource?: { Container?: string }, mediaType?: string) => boolean>().mockReturnValue(false),
    getBufferedRanges: vi.fn(() => []),
    getCrossOriginValue: vi.fn(() => null),
    getHLSPlaybackPosition: vi.fn((_hlsPlayer: unknown, currentPositionSeconds: number) => currentPositionSeconds),
    getSavedVolume: vi.fn(() => 1),
    handleHlsJsMediaError: vi.fn(),
    isValidDuration: vi.fn(() => true),
    onEndedInternal: vi.fn(),
    onErrorInternal: vi.fn(),
    playWithPromise: vi.fn(() => Promise.resolve()),
    prepareHLSSeek: vi.fn(),
    resetSrc: vi.fn(),
    saveVolume: vi.fn(),
    seekOnPlaybackStart: vi.fn()
}));

const itemHelperMock = vi.hoisted(() => ({
    isLocalItem: vi.fn(() => false)
}));

const webSettingsMock = vi.hoisted(() => ({
    getIncludeCorsCredentials: vi.fn(() => Promise.resolve(false))
}));

const hlsModuleMock = vi.hoisted(() => {
    const instances: Array<{ config: Record<string, unknown> }> = [];
    const webGPUInstances: Array<{ config: Record<string, unknown> }> = [];

    class MockHls {
        static readonly ErrorTypes = Object.freeze({
            ['MEDIA_ERROR']: 'legacy-media-error',
            ['NETWORK_ERROR']: 'legacy-network-error'
        });
        static readonly Events = Object.freeze({
            ['ERROR']: 'legacy-error',
            ['MANIFEST_PARSED']: 'legacy-manifest-parsed'
        });
        static readonly DefaultConfig = {
            backBufferLength: Number.POSITIVE_INFINITY,
            fragLoadPolicy: {
                default: {
                    maxTimeToFirstByteMs: 0
                }
            },
            liveBackBufferLength: null,
            lowLatencyMode: true
        };

        attachMedia = vi.fn();
        readonly config: Record<string, unknown>;
        destroy = vi.fn();
        loadSource = vi.fn();
        on = vi.fn();
        startLoad = vi.fn();

        constructor(config: Record<string, unknown>) {
            this.config = config;
            instances.push(this);
        }
    }

    class MockWebGPUHLS {
        static readonly ErrorTypes = Object.freeze({
            ['MEDIA_ERROR']: 'webgpu-media-error',
            ['NETWORK_ERROR']: 'webgpu-network-error'
        });
        static readonly Events = Object.freeze({
            ['ERROR']: 'webgpu-error',
            ['MANIFEST_PARSED']: 'webgpu-manifest-parsed'
        });
        static readonly DefaultConfig = {
            backBufferLength: Number.POSITIVE_INFINITY,
            fragLoadPolicy: {
                default: {
                    maxTimeToFirstByteMs: 0
                }
            },
            liveBackBufferLength: null,
            lowLatencyMode: true
        };

        attachMedia = vi.fn();
        readonly config: Record<string, unknown>;
        destroy = vi.fn();
        loadSource = vi.fn();
        on = vi.fn();
        startLoad = vi.fn();

        constructor(config: Record<string, unknown>) {
            this.config = config;
            webGPUInstances.push(this);
        }
    }

    return { instances, MockHls, MockWebGPUHLS, webGPUInstances };
});

const serverConnectionsMock = vi.hoisted(() => {
    const apiClient = {
        accessToken: vi.fn(() => 'test-token'),
        getJSON: vi.fn(() => Promise.resolve([])),
        getNamedConfiguration: vi.fn(() => Promise.resolve({ EnableFallbackFont: false })),
        getUrl: vi.fn((url: string) => url)
    };
    return {
        apiClient,
        getApiClient: vi.fn(() => apiClient)
    };
});

const specializedSubtitleRendererMock = vi.hoisted(() => {
    const assInstances: Array<{
        dispose: ReturnType<typeof vi.fn>
        options: SpecializedSubtitleRendererOptions
        resetRenderAheadCache: ReturnType<typeof vi.fn>
        resize: ReturnType<typeof vi.fn>
        setCurrentTime: ReturnType<typeof vi.fn>
        setIsPaused: ReturnType<typeof vi.fn>
        timeOffset: number
    }> = [];
    const pgsInstances: Array<{
        aspectRatio: string
        dispose: ReturnType<typeof vi.fn>
        options: SpecializedSubtitleRendererOptions
        renderAtTimestamp: ReturnType<typeof vi.fn>
        timeOffset: number
    }> = [];

    class MockAssRenderer {
        readonly dispose = vi.fn();
        readonly options: SpecializedSubtitleRendererOptions;
        readonly resetRenderAheadCache = vi.fn();
        readonly resize = vi.fn();
        readonly setCurrentTime = vi.fn();
        readonly setIsPaused = vi.fn();
        timeOffset: number;

        constructor(options: SpecializedSubtitleRendererOptions) {
            this.options = options;
            this.timeOffset = options.timeOffset ?? 0;
            assInstances.push(this);
        }
    }

    class MockPgsRenderer {
        aspectRatio: string;
        readonly dispose = vi.fn();
        readonly options: SpecializedSubtitleRendererOptions;
        readonly renderAtTimestamp = vi.fn();
        timeOffset: number;
        readonly timeUpdateListener: () => void;

        constructor(options: SpecializedSubtitleRendererOptions) {
            this.options = options;
            this.aspectRatio = options.aspectRatio ?? 'contain';
            this.timeOffset = options.timeOffset ?? 0;
            this.timeUpdateListener = () => {
                if (this.options.video) {
                    this.renderAtTimestamp(this.options.video.currentTime + this.timeOffset);
                }
            };
            options.video?.addEventListener('timeupdate', this.timeUpdateListener);
            this.dispose.mockImplementation(() => {
                options.video?.removeEventListener('timeupdate', this.timeUpdateListener);
            });
            pgsInstances.push(this);
        }
    }

    return {
        assInstances,
        MockAssRenderer,
        MockPgsRenderer,
        pgsInstances
    };
});

vi.mock('screenfull', () => ({
    default: {
        exit: vi.fn(),
        isEnabled: false,
        request: vi.fn(() => Promise.resolve())
    }
}));

vi.mock('apps/legacy/features/playback/utils/subtitleStyles', () => ({
    useCustomSubtitles: vi.fn(() => false)
}));

vi.mock('components/subtitlesettings/subtitleappearancehelper', () => ({
    default: subtitleAppearanceHelperMock
}));

vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: serverConnectionsMock
}));

vi.mock('@jellyfin/libass-wasm', () => ({
    default: specializedSubtitleRendererMock.MockAssRenderer
}));

vi.mock('libpgs', () => ({
    PgsRenderer: specializedSubtitleRendererMock.MockPgsRenderer
}));

vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        getSubtitleAppearanceSettings: vi.fn(() => ({ verticalPosition: '0' }))
    }
}));

vi.mock('scripts/browser', () => ({
    default: {
        edge: false,
        firefox: false,
        iOS: false,
        ps4: false,
        slow: false,
        supportsCssAnimation: vi.fn(() => false),
        web0s: false
    }
}));

vi.mock('scripts/settings/appSettings', () => ({
    default: {
        aspectRatio: vi.fn(() => 'auto'),
        alwaysBurnInSubtitleWhenTranscoding: vi.fn(() => false)
    }
}));

vi.mock('components/apphost', () => ({
    appHost: {
        supports: vi.fn(() => true)
    }
}));

vi.mock('components/loading/loading', () => ({
    default: {
        hide: vi.fn(),
        show: vi.fn()
    }
}));

vi.mock('utils/dom', () => ({
    default: {
        addEventListener: vi.fn(),
        whichAnimationEvent: vi.fn(() => 'animationend')
    }
}));

vi.mock('components/playback/playbackmanager', () => ({
    playbackManager: playbackManagerMock
}));

vi.mock('components/router/appRouter', () => ({
    appRouter: {
        baseUrl: vi.fn(() => ''),
        showVideoOsd: vi.fn(() => Promise.resolve())
    }
}));

vi.mock('components/htmlMediaHelper', () => htmlMediaHelperMock);

vi.mock('components/itemHelper', () => ({
    default: itemHelperMock
}));

vi.mock('lib/globalize', () => ({
    default: {
        translate: vi.fn((value: string) => value)
    }
}));

vi.mock('scripts/browserDeviceProfile', () => ({
    canPlaySecondaryAudio: vi.fn(() => false),
    default: vi.fn(() => ({}))
}));

vi.mock('scripts/settings/webSettings', () => ({
    getIncludeCorsCredentials: webSettingsMock.getIncludeCorsCredentials
}));

vi.mock('hls.js/dist/hls.js', () => ({
    default: hlsModuleMock.MockHls
}));

vi.mock('hls.js-webgpu/dist/hls.js', () => ({
    default: hlsModuleMock.MockWebGPUHLS
}));

vi.mock('components/backdrop/backdrop', () => ({
    setBackdropTransparency: vi.fn(),
    ['TRANSPARENCY_LEVEL']: {
        Backdrop: 'backdrop',
        None: 'none'
    }
}));

import { HtmlVideoPlayer } from './plugin';

const TRACK_START_TICKS = 0;
const TRACK_END_TICKS = 20_000_000;

function createDeferred<Value>(): Deferred<Value> {
    let resolvePromise: (value: Value) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    const promise = new Promise<Value>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

function createFetchResponse(trackEvents: SubtitleTrackEvent[]): Response {
    return {
        json: vi.fn(() => Promise.resolve({ TrackEvents: trackEvents })),
        ok: true
    } as unknown as Response;
}

function createTrack(index: number, deliveryUrl: string) {
    return {
        Codec: 'srt',
        DeliveryMethod: 'External',
        DeliveryUrl: deliveryUrl,
        Index: index,
        IsExternal: true,
        Type: 'Subtitle'
    };
}

function createSpecializedTrack(index: number, codec: string, deliveryUrl: string): TestMediaStream {
    return {
        Codec: codec,
        DeliveryMethod: 'External',
        DeliveryUrl: deliveryUrl,
        Index: index,
        IsExternal: true,
        Type: 'Subtitle'
    };
}

function createRectangle(left: number, top: number, width: number, height: number): DOMRect {
    return {
        bottom: top + height,
        height,
        left,
        right: left + width,
        top,
        width,
        x: left,
        y: top,
        toJSON: () => ({})
    };
}

class ImmediateXMLHttpRequest {
    onerror: (() => void) | null = null;
    onload: (() => void) | null = null;
    responseURL = '';

    open(...requestArguments: [string, string, boolean]): void {
        this.responseURL = requestArguments[1];
    }

    send(): void {
        this.onload?.();
    }
}

function createPlayOptions(url: string, container = 'MP4'): TestPlayOptions {
    return {
        fullscreen: false,
        item: { ServerId: 'server' },
        mediaSource: {
            Container: container,
            DefaultAudioStreamIndex: 0,
            DefaultSecondarySubtitleStreamIndex: -1,
            DefaultSubtitleStreamIndex: -1,
            MediaStreams: []
        },
        playMethod: 'DirectPlay',
        playerStartPositionTicks: 0,
        url
    };
}

async function createPlayer(useWebGPUHLSRuntime = false): Promise<HtmlVideoPlayerTestHarness> {
    const player = new HtmlVideoPlayer(
        undefined,
        true,
        useWebGPUHLSRuntime
    ) as unknown as HtmlVideoPlayerTestHarness;
    await player.createMediaElement({ fullscreen: false });
    player._currentPlayOptions = {
        item: { ServerId: 'server' },
        mediaSource: {
            MediaStreams: [
                createTrack(0, 'https://example.test/first.vtt'),
                createTrack(1, 'https://example.test/second.vtt')
            ]
        },
        playMethod: 'DirectPlay'
    };
    return player;
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(browser.supportsCssAnimation).mockReturnValue(false);
    htmlMediaHelperMock.applySrc.mockImplementation((element: { src: string }, source: string) => {
        element.src = source;
        return Promise.resolve();
    });
    htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(false);
    htmlMediaHelperMock.getHLSPlaybackPosition.mockImplementation(
        (_hlsPlayer: unknown, currentPositionSeconds: number) => currentPositionSeconds
    );
    htmlMediaHelperMock.playWithPromise.mockReturnValue(Promise.resolve());
    itemHelperMock.isLocalItem.mockReturnValue(false);
    webSettingsMock.getIncludeCorsCredentials.mockReturnValue(Promise.resolve(false));
    hlsModuleMock.instances.length = 0;
    hlsModuleMock.webGPUInstances.length = 0;
    specializedSubtitleRendererMock.assInstances.length = 0;
    specializedSubtitleRendererMock.pgsInstances.length = 0;
    vi.mocked(appSettings.aspectRatio).mockReturnValue('auto');
    serverConnectionsMock.apiClient.getNamedConfiguration.mockResolvedValue({ EnableFallbackFont: false });
    serverConnectionsMock.apiClient.getJSON.mockResolvedValue([]);
});

describe('HtmlVideoPlayer custom presentation shell', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('prepares the normal DOM surface without assigning a native source', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');

        const surface = await player.prepareCustomPlayback(options);

        expect(surface).toMatchObject({
            container: expect.any(HTMLDivElement),
            video: expect.any(HTMLVideoElement)
        });
        expect(player.currentSrc()).toBe(options.url);
        expect(htmlMediaHelperMock.applySrc).not.toHaveBeenCalled();
        expect(htmlMediaHelperMock.playWithPromise).not.toHaveBeenCalled();
        expect(htmlMediaHelperMock.resetSrc).toHaveBeenCalledOnce();
    });

    it('does not gate a custom fullscreen surface on the cosmetic zoom animation', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.fullscreen = true;
        vi.mocked(browser.supportsCssAnimation).mockReturnValue(true);

        const surface = await player.prepareCustomPlayback(options);

        expect(surface).toMatchObject({
            container: expect.any(HTMLDivElement),
            video: expect.any(HTMLVideoElement)
        });
        expect(typeof surface === 'object' ? surface?.container.style.animation : null).toBe('');
    });

    it('forwards custom clock events and retires natural end exactly once', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const eventOrder: string[] = [];
        for (const eventName of [
            'unpause',
            'playing',
            'timeupdate',
            'pause',
            'waiting',
            'volumechange'
        ]) {
            Events.on(player, eventName, () => eventOrder.push(eventName));
        }
        const updateSubtitleText = vi.spyOn(player, 'updateSubtitleText');
        await player.prepareCustomPlayback(createPlayOptions('https://example.test/custom.mp4'));

        expect(player.notifyCustomPlaybackPlaying()).toBe(true);
        expect(player.notifyCustomPlaybackTimeUpdate(2_500)).toBe(true);
        expect(player.notifyCustomPlaybackPaused()).toBe(true);
        expect(player.notifyCustomPlaybackWaiting()).toBe(true);
        expect(player.notifyCustomPlaybackVolumeChange()).toBe(true);

        expect(player.currentTime()).toBe(2_500);
        expect(updateSubtitleText).toHaveBeenCalledWith(2_500);
        expect(eventOrder).toEqual([
            'unpause',
            'playing',
            'timeupdate',
            'pause',
            'waiting',
            'volumechange'
        ]);
        expect(player.notifyCustomPlaybackEnded()).toBe(true);
        expect(player.notifyCustomPlaybackEnded()).toBe(false);
        expect(htmlMediaHelperMock.onEndedInternal).toHaveBeenCalledOnce();
        expect(player.currentSrc()).toBeUndefined();
    });

    it('suppresses only the first native unpause during same-session fallback', () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const unpauseListener = vi.fn();
        Events.on(player, 'unpause', unpauseListener);
        player._currentPlayOptions = { suppressInitialUnpause: true };

        player.onPlay();
        player.onPlay();

        expect(unpauseListener).toHaveBeenCalledOnce();
    });
});

describe('HtmlVideoPlayer specialized subtitle renderers', () => {
    beforeEach(() => {
        vi.stubGlobal('XMLHttpRequest', ImmediateXMLHttpRequest);
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.unstubAllGlobals();
    });

    it('owns ASS canvas clocking, pause state, seeking, offsets, resize, and stop cleanup', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'ass', 'https://example.test/subtitles.ass')
        ];
        options.transcodingOffsetTicks = 5_000_000;
        await player.prepareCustomPlayback(options);
        const surface = player.getPresentationSurface();
        expect(surface).not.toBeNull();
        if (!surface) {
            throw new Error('Custom presentation surface was not created');
        }
        vi.spyOn(surface.video, 'pause').mockImplementation(() => undefined);

        Object.defineProperty(surface.container, 'clientWidth', { configurable: true, value: 800 });
        Object.defineProperty(surface.container, 'clientHeight', { configurable: true, value: 450 });
        vi.spyOn(surface.container, 'getBoundingClientRect')
            .mockReturnValue(createRectangle(10, 20, 800, 450));
        vi.spyOn(surface.video, 'getBoundingClientRect')
            .mockReturnValue(createRectangle(110, 70, 600, 300));

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.assInstances).toHaveLength(1);
        });
        const renderer = specializedSubtitleRendererMock.assInstances[0];
        const canvas = renderer.options.canvas;

        expect(renderer.options.video).toBeUndefined();
        expect(renderer.options.timeOffset).toBe(0);
        expect(renderer.options.renderAhead).toBe(0);
        expect(canvas).toBeInstanceOf(HTMLCanvasElement);
        expect(canvas?.style.left).toBe('100px');
        expect(canvas?.style.top).toBe('50px');
        expect(canvas?.style.width).toBe('600px');
        expect(canvas?.style.height).toBe('300px');
        expect(renderer.resize).toHaveBeenLastCalledWith(600, 300, 0, 0);
        expect(renderer.setCurrentTime).toHaveBeenLastCalledWith(0.5);
        expect(renderer.setIsPaused).toHaveBeenLastCalledWith(true, 0.5);

        expect(player.notifyCustomPlaybackPlaying()).toBe(true);
        expect(renderer.setIsPaused).toHaveBeenLastCalledWith(false, 0.5);
        expect(player.notifyCustomPlaybackTimeUpdate(2_000)).toBe(true);
        expect(renderer.setCurrentTime).toHaveBeenLastCalledWith(2.5);
        expect(player.notifyCustomPlaybackPaused()).toBe(true);
        expect(renderer.setIsPaused).toHaveBeenLastCalledWith(true, 2.5);

        player.currentTime(6_000);
        expect(renderer.resetRenderAheadCache).toHaveBeenLastCalledWith(false);
        expect(renderer.setCurrentTime).toHaveBeenLastCalledWith(6.5);
        player._setSubtitleOffset(1.25);
        expect(renderer.setCurrentTime).toHaveBeenLastCalledWith(7.75);

        await player.stop(false);
        expect(renderer.dispose).toHaveBeenCalledOnce();
        expect(canvas?.isConnected).toBe(false);
        expect(document.querySelectorAll('.htmlVideoPlayerCustomSubtitleCanvas')).toHaveLength(0);
    });

    it('owns PGS timing, offsets, aspect changes, track switching, and cleanup', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'pgssub', 'https://example.test/first.sup'),
            createSpecializedTrack(1, 'pgssub', 'https://example.test/second.sup')
        ];
        options.transcodingOffsetTicks = 2_500_000;
        await player.prepareCustomPlayback(options);
        const surface = player.getPresentationSurface();
        expect(surface).not.toBeNull();
        if (!surface) {
            throw new Error('Custom presentation surface was not created');
        }
        vi.spyOn(surface.video, 'pause').mockImplementation(() => undefined);

        Object.defineProperty(surface.container, 'clientWidth', { configurable: true, value: 1_000 });
        Object.defineProperty(surface.container, 'clientHeight', { configurable: true, value: 600 });
        vi.spyOn(surface.container, 'getBoundingClientRect')
            .mockReturnValue(createRectangle(0, 0, 1_000, 600));
        const videoRectangle = vi.spyOn(surface.video, 'getBoundingClientRect')
            .mockReturnValue(createRectangle(100, 75, 800, 450));

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.pgsInstances).toHaveLength(1);
        });
        const firstRenderer = specializedSubtitleRendererMock.pgsInstances[0];
        const firstCanvas = firstRenderer.options.canvas;

        expect(firstRenderer.options.video).toBeInstanceOf(EventTarget);
        expect(firstRenderer.options.video).not.toBe(surface.video);
        expect(firstRenderer.options.timeOffset).toBe(0);
        expect(firstCanvas?.style.left).toBe('100px');
        expect(firstCanvas?.style.top).toBe('75px');
        expect(player.notifyCustomPlaybackTimeUpdate(3_000)).toBe(true);
        expect(firstRenderer.renderAtTimestamp).toHaveBeenLastCalledWith(3.25);
        player._setSubtitleOffset(-0.75);
        expect(firstRenderer.renderAtTimestamp).toHaveBeenLastCalledWith(2.5);

        vi.mocked(appSettings.aspectRatio).mockReturnValue('cover');
        player.setAspectRatio('cover');
        expect(firstRenderer.aspectRatio).toBe('cover');
        videoRectangle.mockReturnValue(createRectangle(200, 150, 600, 300));
        player.notifyCustomPlaybackTimeUpdate(4_000);
        expect(firstCanvas?.style.left).toBe('200px');
        expect(firstCanvas?.style.top).toBe('150px');
        expect(firstCanvas?.style.width).toBe('600px');
        expect(firstCanvas?.style.height).toBe('300px');

        player.setSubtitleStreamIndex(1);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.pgsInstances).toHaveLength(2);
        });
        const secondRenderer = specializedSubtitleRendererMock.pgsInstances[1];
        const secondCanvas = secondRenderer.options.canvas;
        expect(firstRenderer.dispose).toHaveBeenCalledOnce();
        expect(firstCanvas?.isConnected).toBe(false);
        expect(secondRenderer.renderAtTimestamp).toHaveBeenLastCalledWith(4.25);
        expect(document.querySelectorAll('.htmlVideoPlayerCustomSubtitleCanvas')).toHaveLength(1);

        await player.stop(false);
        expect(secondRenderer.dispose).toHaveBeenCalledOnce();
        expect(secondCanvas?.isConnected).toBe(false);
    });

    it('does not install an ASS renderer after its track generation is retired', async () => {
        const configuration = createDeferred<{ EnableFallbackFont: boolean }>();
        serverConnectionsMock.apiClient.getNamedConfiguration.mockReturnValueOnce(configuration.promise);
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/custom.mkv', 'MKV');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'ass', 'https://example.test/subtitles.ass')
        ];
        await player.prepareCustomPlayback(options);

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(serverConnectionsMock.apiClient.getNamedConfiguration).toHaveBeenCalledOnce();
        });
        player.setSubtitleStreamIndex(-1);
        await Promise.resolve();
        configuration.resolve({ EnableFallbackFont: false });
        await Promise.resolve();
        await Promise.resolve();

        expect(specializedSubtitleRendererMock.assInstances).toHaveLength(0);
        expect(document.querySelectorAll('.htmlVideoPlayerCustomSubtitleCanvas')).toHaveLength(0);
    });

    it('preserves the native video-coupled specialized renderer paths', async () => {
        const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
        const options = createPlayOptions('https://example.test/native.mp4');
        options.mediaSource.MediaStreams = [
            createSpecializedTrack(0, 'ass', 'https://example.test/subtitles.ass'),
            createSpecializedTrack(1, 'pgssub', 'https://example.test/subtitles.sup')
        ];
        options.transcodingOffsetTicks = 10_000_000;
        await player.play(options);
        const nativeVideo = player.getPresentationSurface()?.video;
        expect(nativeVideo).toBeDefined();
        vi.spyOn(nativeVideo as HTMLVideoElement, 'pause').mockImplementation(() => undefined);

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.assInstances).toHaveLength(1);
        });
        const renderer = specializedSubtitleRendererMock.assInstances[0];

        expect(renderer.options.video).toBe(player.getPresentationSurface()?.video);
        expect(renderer.options.canvas).toBeUndefined();
        expect(renderer.options.timeOffset).toBe(1);
        expect(renderer.options.renderAhead).toBe(90);
        expect(document.querySelectorAll('.htmlVideoPlayerCustomSubtitleCanvas')).toHaveLength(0);

        player.setSubtitleStreamIndex(1);
        await vi.waitFor(() => {
            expect(specializedSubtitleRendererMock.pgsInstances).toHaveLength(1);
        });
        const pgsRenderer = specializedSubtitleRendererMock.pgsInstances[0];
        expect(renderer.dispose).toHaveBeenCalledOnce();
        expect(pgsRenderer.options.video).toBe(player.getPresentationSurface()?.video);
        expect(pgsRenderer.options.canvas).toBeUndefined();
        expect(pgsRenderer.options.timeOffset).toBe(1);

        await player.stop(false);
        expect(pgsRenderer.dispose).toHaveBeenCalledOnce();
    });
});

describe('HtmlVideoPlayer subtitle generations', () => {
    let fetchMock: ReturnType<typeof vi.fn>;
    let pendingResponses: Map<string, Deferred<Response>>;

    beforeEach(() => {
        pendingResponses = new Map<string, Deferred<Response>>();
        pendingResponses.set('https://example.test/first.js', createDeferred<Response>());
        pendingResponses.set('https://example.test/second.js', createDeferred<Response>());
        fetchMock = vi.fn((input: RequestInfo | URL) => {
            const pendingResponse = pendingResponses.get(input.toString());
            if (!pendingResponse) {
                return Promise.reject(new Error(`Unexpected subtitle URL: ${input.toString()}`));
            }

            return pendingResponse.promise;
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        document.body.innerHTML = '';
        document.head.querySelectorAll('[id$="-cuestyle"]').forEach((element) => {
            element.remove();
        });
        vi.unstubAllGlobals();
    });

    it('discards a subtitle fetch completed after a newer track selection', async () => {
        const player = await createPlayer();

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        player.setSubtitleStreamIndex(1);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

        pendingResponses.get('https://example.test/second.js')?.resolve(createFetchResponse([{
            EndPositionTicks: TRACK_END_TICKS,
            StartPositionTicks: TRACK_START_TICKS,
            Text: 'Second track'
        }]));
        await vi.waitFor(() => expect(document.querySelector('.videoSubtitlesInner')).not.toBeNull());

        pendingResponses.get('https://example.test/first.js')?.resolve(createFetchResponse([{
            EndPositionTicks: TRACK_END_TICKS,
            StartPositionTicks: TRACK_START_TICKS,
            Text: 'Stale first track'
        }]));
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        player.updateSubtitleText(1_000);

        const subtitlesElement = document.querySelector('.videoSubtitlesInner');
        expect(subtitlesElement?.textContent).toContain('Second track');
        expect(subtitlesElement?.textContent).not.toContain('Stale first track');
    });

    it('discards a subtitle fetch completed after a retained player is stopped', async () => {
        const player = await createPlayer();
        const endFetchListener = vi.fn();
        Events.on(player, 'endFetch', endFetchListener);

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(player.isFetching).toBe(true);
        await player.stop(false);
        expect(player.isFetching).toBe(false);

        pendingResponses.get('https://example.test/first.js')?.resolve(createFetchResponse([{
            EndPositionTicks: TRACK_END_TICKS,
            StartPositionTicks: TRACK_START_TICKS,
            Text: 'Stopped track'
        }]));
        await Promise.resolve();
        await Promise.resolve();

        expect(player.getPresentationSurface()).not.toBeNull();
        expect(document.querySelector('.videoSubtitlesInner')).toBeNull();
        expect(endFetchListener).not.toHaveBeenCalled();
    });

    it('renders a local text track in the forced DOM subtitle layer', async () => {
        itemHelperMock.isLocalItem.mockReturnValue(true);
        fetchMock.mockResolvedValue(createFetchResponse([{
            EndPositionTicks: TRACK_END_TICKS,
            StartPositionTicks: TRACK_START_TICKS,
            Text: 'Local track'
        }]));
        const player = await createPlayer();
        const localTrack = {
            ...createTrack(0, 'https://example.test/local.vtt'),
            IsExternal: false,
            Path: 'https://example.test/local.js'
        };
        player._currentPlayOptions = {
            item: { ServerId: 'server' },
            mediaSource: { MediaStreams: [localTrack] },
            playMethod: 'DirectPlay'
        };

        player.setSubtitleStreamIndex(0);
        await vi.waitFor(() => expect(document.querySelector('.videoSubtitlesInner')).not.toBeNull());
        player.updateSubtitleText(1_000);

        expect(document.querySelector('.videoSubtitlesInner')?.textContent).toContain('Local track');
        expect(player.getPresentationSurface()?.video.textTracks.length).toBe(0);
    });
});

describe('HtmlVideoPlayer play generations', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('resolves a superseded play and blocks its deferred source continuation', async () => {
        const player = await createPlayer();
        const firstApply = createDeferred<void>();
        htmlMediaHelperMock.applySrc.mockImplementationOnce(async (element: { src: string }, source: string) => {
            await firstApply.promise;
            element.src = source;
        });

        const firstPlay = player.play(createPlayOptions('https://example.test/first.mp4'));
        await vi.waitFor(() => expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1));

        const secondPlay = player.play(createPlayOptions('https://example.test/second.mp4'));
        await expect(firstPlay).resolves.toBe(PLAYBACK_SUPERSEDED);
        await secondPlay;

        firstApply.resolve(undefined);
        await Promise.resolve();
        await Promise.resolve();

        expect(player.getPresentationSurface()?.video.src).toBe('https://example.test/second.mp4');
        expect(player.currentSrc()).toBe('https://example.test/second.mp4');
        expect(htmlMediaHelperMock.playWithPromise).toHaveBeenCalledTimes(1);
    });

    it('does not continue a play whose media element creation was superseded', async () => {
        const player = await createPlayer();
        const currentVideo = player.getPresentationSurface()?.video;
        expect(currentVideo).toBeDefined();

        const firstCreate = createDeferred<HTMLVideoElement | null>();
        const originalCreateMediaElement = player.createMediaElement.bind(player);
        vi.spyOn(player, 'createMediaElement')
            .mockImplementationOnce(() => firstCreate.promise)
            .mockImplementation((options, playSessionGeneration) => originalCreateMediaElement(options, playSessionGeneration));

        const firstPlay = player.play(createPlayOptions('https://example.test/first.mp4'));
        const secondPlay = player.play(createPlayOptions('https://example.test/second.mp4'));
        await expect(firstPlay).resolves.toBe(PLAYBACK_SUPERSEDED);
        await secondPlay;

        firstCreate.resolve(currentVideo ?? null);
        await Promise.resolve();
        await Promise.resolve();

        expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1);
        expect(player.currentSrc()).toBe('https://example.test/second.mp4');
    });

    it('does not continue a play whose URL update was superseded', async () => {
        const player = await createPlayer();
        const firstUrlUpdate = createDeferred<void>();
        const originalUpdateVideoUrl = player.updateVideoUrl.bind(player);
        vi.spyOn(player, 'updateVideoUrl')
            .mockImplementationOnce(() => firstUrlUpdate.promise)
            .mockImplementation((options, playSessionGeneration) => originalUpdateVideoUrl(options, playSessionGeneration));

        const firstPlay = player.play(createPlayOptions('https://example.test/first.mp4'));
        await vi.waitFor(() => expect(player.updateVideoUrl).toHaveBeenCalledTimes(1));
        const secondPlay = player.play(createPlayOptions('https://example.test/second.mp4'));
        await expect(firstPlay).resolves.toBe(PLAYBACK_SUPERSEDED);
        await secondPlay;

        firstUrlUpdate.resolve(undefined);
        await Promise.resolve();
        await Promise.resolve();

        expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1);
        expect(player.currentSrc()).toBe('https://example.test/second.mp4');
    });

    it('invalidates guarded source mutations after playback setup rejects', async () => {
        const player = await createPlayer();
        let guardedSourceElement: { src: string } | null = null;
        const setupError = new Error('Source setup failed');
        htmlMediaHelperMock.applySrc.mockImplementationOnce((element: { src: string }) => {
            guardedSourceElement = element;
            return Promise.reject(setupError);
        });

        await expect(player.play(createPlayOptions('https://example.test/failed.mp4'))).rejects.toBe(setupError);
        expect(guardedSourceElement).not.toBeNull();

        const staleSourceElement = guardedSourceElement as unknown as { src: string };
        staleSourceElement.src = 'https://example.test/stale.mp4';

        expect(player.getPresentationSurface()?.video.src).not.toBe('https://example.test/stale.mp4');
        expect(player.currentSrc()).toBeUndefined();
    });

    it('stops an in-flight play without allowing it to call play afterward', async () => {
        const player = await createPlayer();
        const pendingApply = createDeferred<void>();
        htmlMediaHelperMock.applySrc.mockImplementationOnce(async () => pendingApply.promise);

        const playPromise = player.play(createPlayOptions('https://example.test/stopped.mp4'));
        await vi.waitFor(() => expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1));
        await player.stop(false);
        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);

        pendingApply.resolve(undefined);
        await Promise.resolve();
        await Promise.resolve();

        expect(htmlMediaHelperMock.playWithPromise).not.toHaveBeenCalled();
    });

    it('pauses a native source whose play promise is explicitly canceled', async () => {
        const player = await createPlayer();
        const video = player.getPresentationSurface()?.video;
        expect(video).toBeDefined();
        const pause = vi.spyOn(video as HTMLVideoElement, 'pause').mockImplementation(() => undefined);
        const pendingNativePlay = createDeferred<void>();
        htmlMediaHelperMock.playWithPromise.mockReturnValueOnce(pendingNativePlay.promise);

        const playPromise = player.play(createPlayOptions('https://example.test/pending.mp4'));
        await vi.waitFor(() => expect(htmlMediaHelperMock.playWithPromise).toHaveBeenCalledTimes(1));
        player.cancelPendingPlay();
        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);

        expect(pause).toHaveBeenCalledTimes(1);
        pendingNativePlay.resolve(undefined);
    });

    it('destroys an in-flight play without allowing it to call play afterward', async () => {
        const player = await createPlayer();
        const pendingApply = createDeferred<void>();
        htmlMediaHelperMock.applySrc.mockImplementationOnce(async () => pendingApply.promise);

        const playPromise = player.play(createPlayOptions('https://example.test/destroyed.mp4'));
        await vi.waitFor(() => expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1));
        player.destroy();
        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);

        pendingApply.resolve(undefined);
        await Promise.resolve();
        await Promise.resolve();

        expect(htmlMediaHelperMock.playWithPromise).not.toHaveBeenCalled();
        expect(player.getPresentationSurface()).toBeNull();
    });

    it('cancels an in-flight play when the media element ends', async () => {
        const player = await createPlayer();
        const pendingApply = createDeferred<void>();
        htmlMediaHelperMock.applySrc.mockImplementationOnce(async () => pendingApply.promise);

        const playPromise = player.play(createPlayOptions('https://example.test/ended.mp4'));
        await vi.waitFor(() => expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1));
        player.getPresentationSurface()?.video.dispatchEvent(new Event('ended'));
        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);

        pendingApply.resolve(undefined);
        await Promise.resolve();
        expect(htmlMediaHelperMock.playWithPromise).not.toHaveBeenCalled();
    });

    it('cancels an in-flight play on a fatal media error', async () => {
        const player = await createPlayer();
        const pendingApply = createDeferred<void>();
        htmlMediaHelperMock.applySrc.mockImplementationOnce(async () => pendingApply.promise);
        const video = player.getPresentationSurface()?.video;
        expect(video).toBeDefined();
        Object.defineProperty(video, 'error', {
            configurable: true,
            value: { code: 4, message: 'Unsupported source' }
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const playPromise = player.play(createPlayOptions('https://example.test/error.mp4'));
        await vi.waitFor(() => expect(htmlMediaHelperMock.applySrc).toHaveBeenCalledTimes(1));
        player.onError({ target: video } as unknown as Event);
        await expect(playPromise).resolves.toBe(PLAYBACK_SUPERSEDED);

        pendingApply.resolve(undefined);
        await Promise.resolve();
        expect(htmlMediaHelperMock.playWithPromise).not.toHaveBeenCalled();
        expect(htmlMediaHelperMock.onErrorInternal).toHaveBeenCalled();
        consoleError.mockRestore();
    });

    it('does not construct HLS after its credential lookup is superseded', async () => {
        const player = await createPlayer();
        const firstCredentialLookup = createDeferred<boolean>();
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockImplementation((mediaSource?: { Container?: string }) => {
            return mediaSource?.Container === 'HLS';
        });
        webSettingsMock.getIncludeCorsCredentials
            .mockImplementationOnce(() => firstCredentialLookup.promise)
            .mockResolvedValue(false);

        const firstPlay = player.play(createPlayOptions('https://example.test/first.m3u8', 'HLS'));
        await vi.waitFor(() => expect(webSettingsMock.getIncludeCorsCredentials).toHaveBeenCalledTimes(1));
        const secondPlay = player.play(createPlayOptions('https://example.test/second.mp4'));
        await expect(firstPlay).resolves.toBe(PLAYBACK_SUPERSEDED);
        await secondPlay;

        firstCredentialLookup.resolve(false);
        await Promise.resolve();
        await Promise.resolve();

        expect(hlsModuleMock.instances).toHaveLength(0);
        expect(htmlMediaHelperMock.bindEventsToHlsPlayer).not.toHaveBeenCalled();
        expect(player.currentSrc()).toBe('https://example.test/second.mp4');
    });

    it.each([
        [ 'legacy then WebGPU', false, true ],
        [ 'WebGPU then legacy', true, false ]
    ])('isolates HLS runtimes and workers when loaded %s', async (
        _loadOrder,
        firstUsesWebGPUHLSRuntime,
        secondUsesWebGPUHLSRuntime
    ) => {
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
        htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementation((...eventArguments: unknown[]) => {
            const resolveHlsSource = eventArguments[4] as () => void;
            resolveHlsSource();
        });

        const firstPlayer = await createPlayer(firstUsesWebGPUHLSRuntime);
        await firstPlayer.play(createPlayOptions('https://example.test/first.m3u8', 'HLS'));
        const secondPlayer = await createPlayer(secondUsesWebGPUHLSRuntime);
        await secondPlayer.play(createPlayOptions('https://example.test/second.m3u8', 'HLS'));

        expect(hlsModuleMock.instances).toHaveLength(1);
        expect(hlsModuleMock.webGPUInstances).toHaveLength(1);
        expect(hlsModuleMock.instances[0].config).toEqual(expect.objectContaining({
            workerPath: 'libraries/hls.worker.js'
        }));
        expect(hlsModuleMock.webGPUInstances[0].config).toEqual(expect.objectContaining({
            workerPath: 'libraries/hls.webgpu-1.7.0-rc.2.worker.js'
        }));

        const firstSessionCallbacks = htmlMediaHelperMock.bindEventsToHlsPlayer.mock.calls[0][6] as {
            hlsRuntime: unknown
        };
        const secondSessionCallbacks = htmlMediaHelperMock.bindEventsToHlsPlayer.mock.calls[1][6] as {
            hlsRuntime: unknown
        };
        expect(firstSessionCallbacks.hlsRuntime).toBe(
            firstUsesWebGPUHLSRuntime ? hlsModuleMock.MockWebGPUHLS : hlsModuleMock.MockHls
        );
        expect(secondSessionCallbacks.hlsRuntime).toBe(
            secondUsesWebGPUHLSRuntime ? hlsModuleMock.MockWebGPUHLS : hlsModuleMock.MockHls
        );
    });

    it('configures HLS to select an encoded SDR video rendition', async () => {
        const player = await createPlayer();
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
        htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementationOnce((...eventArguments: unknown[]) => {
            const resolveHlsSource = eventArguments[4] as () => void;
            resolveHlsSource();
        });
        const options = createPlayOptions(
            'https://example.test/master.m3u8?TranscodeReasons=AudioCodecNotSupported%2CVideoRangeTypeNotSupported',
            'HLS'
        );
        options.playMethod = 'Transcode';

        await player.play(options);

        expect(hlsModuleMock.instances).toHaveLength(1);
        expect(hlsModuleMock.instances[0].config).toEqual(expect.objectContaining({
            videoPreference: { preferHDR: false }
        }));
    });

    it('configures HLS to retain copied HDR for audio-only transcoding', async () => {
        const player = await createPlayer();
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
        htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementationOnce((...eventArguments: unknown[]) => {
            const resolveHlsSource = eventArguments[4] as () => void;
            resolveHlsSource();
        });
        const options = createPlayOptions(
            'https://example.test/master.m3u8?TranscodeReasons=AudioCodecNotSupported%2CAudioChannelsNotSupported',
            'HLS'
        );
        options.playMethod = 'Transcode';

        await player.play(options);

        expect(hlsModuleMock.instances).toHaveLength(1);
        expect(hlsModuleMock.instances[0].config).toEqual(expect.objectContaining({
            videoPreference: { preferHDR: true }
        }));
    });

    it('keeps established HLS callbacks current when no startup is pending', async () => {
        const player = await createPlayer();
        const terminalError = 'established-hls-error';
        let rejectHlsSource: ((error?: unknown) => void) | null = null;
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
        htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementationOnce((...eventArguments: unknown[]) => {
            const resolveHlsSource = eventArguments[4] as () => void;
            rejectHlsSource = eventArguments[5] as (error?: unknown) => void;
            resolveHlsSource();
        });

        await player.play(createPlayOptions('https://example.test/established.m3u8', 'HLS'));
        expect(rejectHlsSource).not.toBeNull();
        const destroyHlsCallCount = htmlMediaHelperMock.destroyHlsPlayer.mock.calls.length;
        player.cancelPendingPlay();
        expect(htmlMediaHelperMock.destroyHlsPlayer).toHaveBeenCalledTimes(destroyHlsCallCount);
        const rejectEstablishedHlsSource = rejectHlsSource as unknown as (error?: unknown) => void;
        rejectEstablishedHlsSource(terminalError);

        expect(htmlMediaHelperMock.onErrorInternal).toHaveBeenCalledWith(player, terminalError);
    });

    it('turns an HLS rejection after startup into a terminal player error', async () => {
        const player = await createPlayer();
        const terminalError = 'fatal-hls-after-start';
        let rejectHlsSource: ((error?: unknown) => void) | null = null;
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
        htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementationOnce((...eventArguments: unknown[]) => {
            const resolveHlsSource = eventArguments[4] as () => void;
            rejectHlsSource = eventArguments[5] as (error?: unknown) => void;
            resolveHlsSource();
        });

        await player.play(createPlayOptions('https://example.test/started.m3u8', 'HLS'));
        expect(rejectHlsSource).not.toBeNull();
        const rejectStartedHlsSource = rejectHlsSource as unknown as (error?: unknown) => void;
        rejectStartedHlsSource(terminalError);

        expect(htmlMediaHelperMock.destroyHlsPlayer).toHaveBeenCalled();
        expect(htmlMediaHelperMock.onErrorInternal).toHaveBeenCalledWith(player, terminalError);
    });

    it('bounds WebGPU-owned HLS ranges while retaining byte-aware forward buffering', async () => {
        const player = await createPlayer(true);
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
        htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementationOnce((...eventArguments: unknown[]) => {
            const resolveHlsSource = eventArguments[4] as () => void;
            resolveHlsSource();
        });

        await player.play(createPlayOptions('https://example.test/master.m3u8', 'HLS'));

        expect(hlsModuleMock.webGPUInstances).toHaveLength(1);
        expect(hlsModuleMock.webGPUInstances[0].config).toEqual(expect.objectContaining({
            backBufferLength: 6,
            fragLoadPolicy: expect.objectContaining({
                default: expect.objectContaining({
                    maxTimeToFirstByteMs: 20_000
                })
            }),
            frontBufferFlushThreshold: 6,
            lowLatencyMode: false,
            maxBufferLength: 6,
            maxMaxBufferLength: 30
        }));
        expect(hlsModuleMock.MockWebGPUHLS.DefaultConfig.backBufferLength)
            .toBe(Number.POSITIVE_INFINITY);
        expect(hlsModuleMock.MockWebGPUHLS.DefaultConfig.fragLoadPolicy.default.maxTimeToFirstByteMs)
            .toBe(0);
        expect(hlsModuleMock.MockWebGPUHLS.DefaultConfig.liveBackBufferLength).toBeNull();
        expect(hlsModuleMock.MockWebGPUHLS.DefaultConfig.lowLatencyMode).toBe(true);
    });

    it('preserves legacy HTML HLS retention without bitrate-based selection', async () => {
        const player = await createPlayer();
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
        htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementationOnce((...eventArguments: unknown[]) => {
            const resolveHlsSource = eventArguments[4] as () => void;
            resolveHlsSource();
        });

        await player.play(createPlayOptions('https://example.test/master.m3u8', 'HLS'));

        expect(hlsModuleMock.instances).toHaveLength(1);
        expect(hlsModuleMock.instances[0].config).toEqual(expect.objectContaining({
            backBufferLength: Number.POSITIVE_INFINITY,
            liveBackBufferLength: 90,
            maxBufferLength: 30,
            maxMaxBufferLength: 30
        }));
        expect(hlsModuleMock.instances[0].config).not.toHaveProperty(
            'frontBufferFlushThreshold'
        );
    });

    it('publishes an explicit HLS seek before changing the media element', async () => {
        const player = await createPlayer();
        htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(true);
        htmlMediaHelperMock.bindEventsToHlsPlayer.mockImplementationOnce((...eventArguments: unknown[]) => {
            const resolveHlsSource = eventArguments[4] as () => void;
            resolveHlsSource();
        });
        await player.play(createPlayOptions('https://example.test/master.m3u8', 'HLS'));
        const video = player.getPresentationSurface()?.video;
        expect(video).toBeDefined();
        let mediaTimeWhenPrepared: number | null = null;
        htmlMediaHelperMock.prepareHLSSeek.mockImplementationOnce(() => {
            mediaTimeWhenPrepared = video?.currentTime ?? null;
        });

        player.currentTime(3_600_000);

        expect(player.currentTime()).toBe(3_600_000);
        expect(mediaTimeWhenPrepared).toBe(0);
        expect(video?.currentTime).toBe(3_600);
        expect(htmlMediaHelperMock.prepareHLSSeek).toHaveBeenCalledWith(
            hlsModuleMock.instances[0],
            3_600
        );

        htmlMediaHelperMock.getHLSPlaybackPosition.mockReturnValueOnce(3_600);
        if (video) {
            video.currentTime = 3_000;
            video.dispatchEvent(new Event('timeupdate'));
        }
        expect(player.currentTime()).toBe(3_600_000);

        player.currentTime(0);
        expect(player.currentTime()).toBe(0);
    });
});
