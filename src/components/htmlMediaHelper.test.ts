import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaError } from 'types/mediaError';
import Events from 'utils/events';
import { bindEventsToHlsPlayer } from 'components/htmlMediaHelper';

type HLSEventData = {
    details: string
    fatal: boolean
    response?: { code: number }
    type: string
};

type HLSEventListener = (eventName: string, data: HLSEventData) => void;

type BoundTestPlayer = {
    instance: { _hlsPlayer: MockHLSPlayer | null }
    reject: ReturnType<typeof vi.fn>
    resolve: ReturnType<typeof vi.fn>
};

const hlsEventValues: Record<string, string> = {};
hlsEventValues['ERROR'] = 'error';
hlsEventValues['MANIFEST_PARSED'] = 'manifestParsed';
const HLS_EVENTS = Object.freeze(hlsEventValues);

const hlsErrorTypeValues: Record<string, string> = {};
hlsErrorTypeValues['MEDIA_ERROR'] = 'mediaError';
hlsErrorTypeValues['NETWORK_ERROR'] = 'networkError';
const HLS_ERROR_TYPES = Object.freeze(hlsErrorTypeValues);
const HLS_RUNTIME = Object.freeze({
    ErrorTypes: HLS_ERROR_TYPES,
    Events: HLS_EVENTS
});

const SERVER_ERROR_RESPONSE_CODE = 404;

class MockHLSPlayer {
    readonly destroy = vi.fn();
    readonly media: HTMLMediaElement;
    readonly recoverMediaError = vi.fn();
    readonly startLoad = vi.fn();
    readonly swapAudioCodec = vi.fn();
    private readonly listeners = new Map<string, HLSEventListener[]>();

    constructor(media: HTMLMediaElement) {
        this.media = media;
    }

    emit(eventName: string, data: HLSEventData): void {
        const listeners = this.listeners.get(eventName) ?? [];
        for (const listener of listeners) {
            listener(eventName, data);
        }
    }

    on(eventName: string, listener: HLSEventListener): void {
        const listeners = this.listeners.get(eventName) ?? [];
        listeners.push(listener);
        this.listeners.set(eventName, listeners);
    }
}

function createManifestData(): HLSEventData {
    return { details: 'manifest', fatal: false, type: 'manifest' };
}

function createFatalErrorData(type: string): HLSEventData {
    return { details: 'fatalTestError', fatal: true, type };
}

function createServerErrorData(): HLSEventData {
    return {
        details: 'fragLoadError',
        fatal: true,
        response: { code: SERVER_ERROR_RESPONSE_CODE },
        type: HLS_ERROR_TYPES.NETWORK_ERROR
    };
}

function setPlayResult(media: HTMLMediaElement, playResult: Promise<void>): void {
    Object.defineProperty(media, 'play', {
        configurable: true,
        value: vi.fn(() => playResult)
    });
}

function bindTestPlayer(
    hlsPlayer: MockHLSPlayer,
    onEstablishedError?: (errorType: string) => void
): BoundTestPlayer {
    const instance = { _hlsPlayer: hlsPlayer as MockHLSPlayer | null };
    const reject = vi.fn();
    const resolve = vi.fn();
    bindEventsToHlsPlayer(
        instance,
        hlsPlayer,
        hlsPlayer.media,
        vi.fn(),
        resolve,
        reject,
        {
            hlsRuntime: HLS_RUNTIME,
            onEstablishedError
        }
    );
    return { instance, reject, resolve };
}

beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('bindEventsToHlsPlayer session ownership', () => {
    it('requires the owning hls.js runtime', () => {
        const hlsPlayer = new MockHLSPlayer(document.createElement('video'));

        expect(() => {
            bindEventsToHlsPlayer({ _hlsPlayer: hlsPlayer }, hlsPlayer, hlsPlayer.media, vi.fn(), vi.fn(), vi.fn());
        }).toThrow(TypeError);
    });

    it('ignores events from a retired HLS instance', () => {
        const media = document.createElement('video');
        const retiredHLSPlayer = new MockHLSPlayer(media);
        const { instance, reject } = bindTestPlayer(retiredHLSPlayer);
        instance._hlsPlayer = new MockHLSPlayer(media);

        retiredHLSPlayer.emit(HLS_EVENTS.ERROR, createServerErrorData());
        retiredHLSPlayer.emit(HLS_EVENTS.ERROR, createFatalErrorData('unrecoverable'));

        expect(retiredHLSPlayer.destroy).not.toHaveBeenCalled();
        expect(reject).not.toHaveBeenCalled();
    });

    it('does not resolve startup after a terminal error settles it', async () => {
        const media = document.createElement('video');
        let finishPlay = (): void => undefined;
        const playPromise = new Promise<void>((resolve) => {
            finishPlay = resolve;
        });
        setPlayResult(media, playPromise);
        const hlsPlayer = new MockHLSPlayer(media);
        const { reject, resolve } = bindTestPlayer(hlsPlayer);

        hlsPlayer.emit(HLS_EVENTS.MANIFEST_PARSED, createManifestData());
        hlsPlayer.emit(HLS_EVENTS.ERROR, createServerErrorData());
        expect(reject).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledWith(MediaError.SERVER_ERROR);

        finishPlay();
        await playPromise;
        await Promise.resolve();

        expect(resolve).not.toHaveBeenCalled();
        expect(reject).toHaveBeenCalledOnce();
    });

    it('emits post-start terminal errors instead of rejecting a settled startup', async () => {
        const media = document.createElement('audio');
        setPlayResult(media, Promise.resolve());
        const hlsPlayer = new MockHLSPlayer(media);
        const { instance, reject, resolve } = bindTestPlayer(hlsPlayer);
        const errorListener = vi.fn();
        Events.on(instance, 'error', errorListener);

        hlsPlayer.emit(HLS_EVENTS.MANIFEST_PARSED, createManifestData());
        await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());

        hlsPlayer.emit(HLS_EVENTS.ERROR, createServerErrorData());
        hlsPlayer.emit(HLS_EVENTS.ERROR, createServerErrorData());

        expect(reject).not.toHaveBeenCalled();
        expect(hlsPlayer.destroy).toHaveBeenCalledOnce();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.SERVER_ERROR
        });
    });

    it('delegates established video errors to the owning session callback', async () => {
        const media = document.createElement('video');
        setPlayResult(media, Promise.resolve());
        const hlsPlayer = new MockHLSPlayer(media);
        const establishedError = vi.fn();
        const { instance, reject, resolve } = bindTestPlayer(
            hlsPlayer,
            establishedError
        );
        const errorListener = vi.fn();
        Events.on(instance, 'error', errorListener);

        hlsPlayer.emit(HLS_EVENTS.MANIFEST_PARSED, createManifestData());
        await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());

        hlsPlayer.emit(HLS_EVENTS.ERROR, createFatalErrorData('unrecoverable'));

        expect(reject).not.toHaveBeenCalled();
        expect(establishedError).toHaveBeenCalledOnce();
        expect(establishedError).toHaveBeenCalledWith(MediaError.FATAL_HLS_ERROR);
        expect(errorListener).not.toHaveBeenCalled();
    });

    it('settles a terminal error when HLS destruction throws', () => {
        const media = document.createElement('video');
        const hlsPlayer = new MockHLSPlayer(media);
        hlsPlayer.destroy.mockImplementationOnce(() => {
            throw new Error('destroy failed');
        });
        const { instance, reject } = bindTestPlayer(hlsPlayer);

        expect(() => {
            hlsPlayer.emit(HLS_EVENTS.ERROR, createFatalErrorData('unrecoverable'));
        }).not.toThrow();

        expect(instance._hlsPlayer).toBeNull();
        expect(reject).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledWith(MediaError.FATAL_HLS_ERROR);
    });
});
