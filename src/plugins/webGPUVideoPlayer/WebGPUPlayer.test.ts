import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PLAYBACK_SUPERSEDED } from 'constants/playbackResult';
import Events from 'utils/events';

const htmlPlayerMockState = vi.hoisted(() => ({
    instances: [] as object[],
    owners: [] as object[]
}));
const presenterMockState = vi.hoisted(() => ({
    instances: [] as object[]
}));

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

        constructor(fallbackHandler: (generation: number) => void) {
            this.fallbackHandler = fallbackHandler;
            presenterMockState.instances.push(this);
        }

        startSession = vi.fn();
        attach = vi.fn();
        seek = vi.fn();
        refresh = vi.fn();
        endSession = vi.fn();
        getTelemetry = vi.fn(() => ({
            deviceRecoveryCount: 0,
            fallbackReason: null,
            firstFrameLatencyMicroseconds: null,
            firstPresentedMediaTimeMicroseconds: null,
            lastCallbackTimeMicroseconds: null,
            lastExpectedDisplayTimeMicroseconds: null,
            lastPresentedMediaTimeMicroseconds: null,
            mode: 'identity-sdr',
            presentedFrameCount: 0,
            sessionStartedMicroseconds: 0,
            state: 'idle'
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
import WebGPUPlayer from './WebGPUPlayer';

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
    attach: MockFunction
    endSession: MockFunction
    fallbackHandler: (generation: number) => void
    refresh: MockFunction
    seek: MockFunction
    startSession: MockFunction
};

function getBackend(): MockHTMLPlayer {
    const backendIndex = htmlPlayerMockState.instances.length - 1;
    return htmlPlayerMockState.instances[backendIndex] as MockHTMLPlayer;
}

function getPresenter(): MockPresenter {
    const presenterIndex = presenterMockState.instances.length - 1;
    return presenterMockState.instances[presenterIndex] as MockPresenter;
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

describe('WebGPUPlayer HTML delegation', () => {
    beforeEach(() => {
        htmlPlayerMockState.instances.length = 0;
        htmlPlayerMockState.owners.length = 0;
        presenterMockState.instances.length = 0;
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

    it('mirrors backend status properties and masks unimplemented native-output modes', () => {
        const player = new WebGPUPlayer();
        const backend = getBackend();
        backend.isFetching = true;
        backend.forcedFullscreen = true;

        expect(player.isFetching).toBe(true);
        expect(player.forcedFullscreen).toBe(true);
        expect(player.supports('PictureInPicture')).toBe(false);
        expect(player.supports('AirPlay')).toBe(false);
        expect(player.supports('PlaybackRate')).toBe(true);
    });
});

describe('WebGPUPlayer event and lifecycle contract', () => {
    beforeEach(() => {
        htmlPlayerMockState.instances.length = 0;
        htmlPlayerMockState.owners.length = 0;
        presenterMockState.instances.length = 0;
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
