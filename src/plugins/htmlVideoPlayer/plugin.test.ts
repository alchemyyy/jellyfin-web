import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PLAYBACK_SUPERSEDED } from 'constants/playbackResult';
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

type HtmlVideoPlayerTestHarness = {
    _currentPlayOptions: unknown
    cancelPendingPlay: () => void
    createMediaElement: (options: { fullscreen: boolean }, playSessionGeneration?: number) => Promise<HTMLVideoElement | null>
    currentSrc: () => string | undefined
    destroy: () => void
    getPresentationSurface: () => { container: HTMLDivElement, video: HTMLVideoElement } | null
    isFetching: boolean
    onError: (event: Event) => void
    play: (options: ReturnType<typeof createPlayOptions>) => Promise<unknown>
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
    getSavedVolume: vi.fn(() => 1),
    handleHlsJsMediaError: vi.fn(),
    isValidDuration: vi.fn(() => true),
    onEndedInternal: vi.fn(),
    onErrorInternal: vi.fn(),
    playWithPromise: vi.fn(() => Promise.resolve()),
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
    const instances: unknown[] = [];

    class MockHls {
        static readonly DefaultConfig = {
            fragLoadPolicy: {
                default: {
                    maxTimeToFirstByteMs: 0
                }
            }
        };

        attachMedia = vi.fn();
        destroy = vi.fn();
        loadSource = vi.fn();
        on = vi.fn();
        startLoad = vi.fn();

        constructor() {
            instances.push(this);
        }
    }

    return { instances, MockHls };
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
    ServerConnections: {
        getApiClient: vi.fn()
    }
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

function createPlayOptions(url: string, container = 'MP4') {
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

async function createPlayer(): Promise<HtmlVideoPlayerTestHarness> {
    const player = new HtmlVideoPlayer(undefined, true) as unknown as HtmlVideoPlayerTestHarness;
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
    htmlMediaHelperMock.applySrc.mockImplementation((element: { src: string }, source: string) => {
        element.src = source;
        return Promise.resolve();
    });
    htmlMediaHelperMock.enableHlsJsPlayerForCodecs.mockReturnValue(false);
    htmlMediaHelperMock.playWithPromise.mockReturnValue(Promise.resolve());
    itemHelperMock.isLocalItem.mockReturnValue(false);
    webSettingsMock.getIncludeCorsCredentials.mockReturnValue(Promise.resolve(false));
    hlsModuleMock.instances.length = 0;
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
});
