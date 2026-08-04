import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MediaError } from 'types/mediaError';
import Events from 'utils/events';
import {
    bindEventsToHlsPlayer,
    getHLSPlaybackPosition,
    prepareHLSSeek
} from './htmlMediaHelper';

type HLSErrorData = {
    details: string
    error: Error
    fatal: boolean
    response?: { code: number }
    sourceBufferName: string
    type: string
};

type HLSEventListener = (eventName: string, data: HLSErrorData) => void;

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
const hlsErrorDetailValues: Record<string, string> = {};
hlsErrorDetailValues['BUFFER_NUDGE_ON_STALL'] = 'bufferNudgeOnStall';
hlsErrorDetailValues['BUFFER_SEEK_OVER_HOLE'] = 'bufferSeekOverHole';
const HLS_ERROR_DETAILS = Object.freeze(hlsErrorDetailValues);
const HLS_RUNTIME = Object.freeze({
    ErrorDetails: HLS_ERROR_DETAILS,
    ErrorTypes: HLS_ERROR_TYPES,
    Events: HLS_EVENTS
});

class MockHLSPlayer {
    readonly config: { startPosition: number };
    readonly destroy = vi.fn();
    hasEnoughToStart = false;
    readonly media: HTMLMediaElement;
    loadingEnabled = false;
    readonly recoverMediaError = vi.fn();
    readonly startPosition: number;
    readonly startLoad = vi.fn();
    readonly stopLoad = vi.fn();
    private readonly listeners = new Map<string, HLSEventListener[]>();

    constructor(
        media: HTMLMediaElement,
        startPosition = 0,
        recoverRestartsLoading = true
    ) {
        this.config = { startPosition };
        this.media = media;
        this.startPosition = startPosition;
        this.startLoad.mockImplementation(() => {
            this.loadingEnabled = true;
        });
        this.stopLoad.mockImplementation(() => {
            this.loadingEnabled = false;
        });
        this.recoverMediaError.mockImplementation(() => {
            if (recoverRestartsLoading && media.currentTime !== 0) {
                this.startLoad(media.currentTime);
            }
        });
    }

    emit(eventName: string, data: HLSErrorData): void {
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

function createAppendErrorData(details: string, error: Error): HLSErrorData {
    return {
        details,
        error,
        fatal: false,
        sourceBufferName: 'audiovideo',
        type: 'mediaError'
    };
}

function createFatalErrorData(type: string): HLSErrorData {
    return {
        details: 'fatalTestError',
        error: new Error('fatal test error'),
        fatal: true,
        sourceBufferName: 'audiovideo',
        type
    };
}

function emitLogicalAppendFailure(hlsPlayer: MockHLSPlayer, label: string): void {
    const error = new Error(label);
    hlsPlayer.emit(HLS_EVENTS.ERROR, createAppendErrorData('bufferAppendingError', error));
    hlsPlayer.emit(HLS_EVENTS.ERROR, createAppendErrorData('bufferAppendError', error));
}

function setBufferedRanges(
    media: HTMLMediaElement,
    ranges: Array<{ end: number, start: number }>
): void {
    Object.defineProperty(media, 'buffered', {
        configurable: true,
        value: {
            end: (rangeIndex: number) => ranges[rangeIndex].end,
            length: ranges.length,
            start: (rangeIndex: number) => ranges[rangeIndex].start
        }
    });
}

function setSeekableRanges(
    media: HTMLMediaElement,
    ranges: Array<{ end: number, start: number }>
): void {
    Object.defineProperty(media, 'seekable', {
        configurable: true,
        value: {
            end: (rangeIndex: number) => ranges[rangeIndex].end,
            length: ranges.length,
            start: (rangeIndex: number) => ranges[rangeIndex].start
        }
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
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('bindEventsToHlsPlayer append liveness', () => {
    it('records an explicit seek without overriding hls.js loading', () => {
        const media = document.createElement('video');
        const hlsPlayer = new MockHLSPlayer(media);

        prepareHLSSeek(hlsPlayer, 3_600);

        expect(getHLSPlaybackPosition(hlsPlayer, media.currentTime)).toBe(3_600);
        expect(hlsPlayer.startLoad).not.toHaveBeenCalled();
    });

    it('logs bounded numeric state for quota and stall diagnosis', () => {
        const media = document.createElement('video');
        const bufferedRanges: Array<{ end: number, start: number }> = [];
        for (let rangeIndex = 0; rangeIndex < 8; rangeIndex++) {
            bufferedRanges.push({
                end: rangeIndex * 100 + 10,
                start: rangeIndex * 100
            });
        }
        setBufferedRanges(media, bufferedRanges);
        setSeekableRanges(media, [{ start: 0, end: 1_000 }]);
        media.currentTime = 350;
        const hlsPlayer = new MockHLSPlayer(media);
        bindTestPlayer(hlsPlayer);

        hlsPlayer.emit(
            HLS_EVENTS.ERROR,
            createAppendErrorData('bufferFullError', new Error('quota'))
        );

        expect(console.error).toHaveBeenCalledWith(
            expect.stringContaining('Details: bufferFullError'),
            expect.objectContaining({
                buffered: {
                    count: 8,
                    ranges: expect.any(Array)
                },
                currentTime: 350,
                recoveryPosition: 350,
                seekable: {
                    count: 1,
                    ranges: [{ start: 0, end: 1_000 }]
                }
            })
        );
        const playbackState = vi.mocked(console.error).mock.calls[0][1] as {
            buffered: { ranges: unknown[] }
        };
        expect(playbackState.buffered.ranges).toHaveLength(6);
    });

    it('deduplicates paired errors, resets MediaSource once, then settles one terminal error', () => {
        const media = document.createElement('video');
        const hlsPlayer = new MockHLSPlayer(media);
        const { instance, reject } = bindTestPlayer(hlsPlayer);

        emitLogicalAppendFailure(hlsPlayer, 'failure-1');
        emitLogicalAppendFailure(hlsPlayer, 'failure-2');
        expect(hlsPlayer.recoverMediaError).not.toHaveBeenCalled();

        emitLogicalAppendFailure(hlsPlayer, 'failure-3');
        expect(hlsPlayer.stopLoad).toHaveBeenCalledOnce();
        expect(hlsPlayer.recoverMediaError).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledWith(0);
        expect(reject).not.toHaveBeenCalled();

        emitLogicalAppendFailure(hlsPlayer, 'failure-4');
        emitLogicalAppendFailure(hlsPlayer, 'failure-5');
        emitLogicalAppendFailure(hlsPlayer, 'failure-6');
        expect(hlsPlayer.destroy).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledWith(MediaError.MEDIA_DECODE_ERROR);
        expect(instance._hlsPlayer).toBeNull();

        emitLogicalAppendFailure(hlsPlayer, 'stale-after-terminal');
        expect(hlsPlayer.destroy).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledOnce();
    });

    it('resets the active error budget only after forward media progress', () => {
        const media = document.createElement('video');
        const hlsPlayer = new MockHLSPlayer(media);
        bindTestPlayer(hlsPlayer);

        emitLogicalAppendFailure(hlsPlayer, 'failure-1');
        emitLogicalAppendFailure(hlsPlayer, 'failure-2');
        media.currentTime = 1;
        emitLogicalAppendFailure(hlsPlayer, 'failure-after-progress');
        expect(hlsPlayer.recoverMediaError).not.toHaveBeenCalled();

        emitLogicalAppendFailure(hlsPlayer, 'failure-4');
        emitLogicalAppendFailure(hlsPlayer, 'failure-5');
        expect(hlsPlayer.recoverMediaError).toHaveBeenCalledOnce();
    });

    it('recovers an initial resume from the configured HLS start position', () => {
        const media = document.createElement('video');
        const resumePositionSeconds = 3_600;
        const hlsPlayer = new MockHLSPlayer(media, resumePositionSeconds);
        bindTestPlayer(hlsPlayer);

        expect(media.currentTime).toBe(0);
        emitLogicalAppendFailure(hlsPlayer, 'failure-1');
        emitLogicalAppendFailure(hlsPlayer, 'failure-2');
        emitLogicalAppendFailure(hlsPlayer, 'failure-3');

        expect(hlsPlayer.recoverMediaError).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledWith(resumePositionSeconds);
    });

    it('keeps an established seek to the beginning instead of restoring the initial resume', () => {
        const media = document.createElement('video');
        const hlsPlayer = new MockHLSPlayer(media, 3_600);
        hlsPlayer.hasEnoughToStart = true;
        bindTestPlayer(hlsPlayer);
        prepareHLSSeek(hlsPlayer, 0);
        media.dispatchEvent(new Event('seeked'));

        expect(media.currentTime).toBe(0);
        emitLogicalAppendFailure(hlsPlayer, 'failure-1');
        emitLogicalAppendFailure(hlsPlayer, 'failure-2');
        emitLogicalAppendFailure(hlsPlayer, 'failure-3');

        expect(hlsPlayer.recoverMediaError).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledWith(0);
    });

    it('does not replace a nonzero initial resume with an unexplained established zero', () => {
        const media = document.createElement('video');
        const resumePositionSeconds = 3_600;
        const hlsPlayer = new MockHLSPlayer(media, resumePositionSeconds);
        hlsPlayer.hasEnoughToStart = true;
        bindTestPlayer(hlsPlayer);

        expect(media.currentTime).toBe(0);
        emitLogicalAppendFailure(hlsPlayer, 'failure-1');
        emitLogicalAppendFailure(hlsPlayer, 'failure-2');
        emitLogicalAppendFailure(hlsPlayer, 'failure-3');

        expect(hlsPlayer.recoverMediaError).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledWith(resumePositionSeconds);
    });

    it('recovers at the last stable position after a group rollback', () => {
        const media = document.createElement('video');
        const hlsPlayer = new MockHLSPlayer(media);
        hlsPlayer.hasEnoughToStart = true;
        bindTestPlayer(hlsPlayer);
        media.currentTime = 3_660;
        media.dispatchEvent(new Event('timeupdate'));
        media.currentTime = 3_000;
        media.dispatchEvent(new Event('seeked'));
        expect(getHLSPlaybackPosition(hlsPlayer, media.currentTime)).toBe(3_660);

        hlsPlayer.emit(
            HLS_EVENTS.ERROR,
            createFatalErrorData(HLS_ERROR_TYPES.MEDIA_ERROR)
        );

        expect(hlsPlayer.recoverMediaError).toHaveBeenCalledOnce();
        expect(hlsPlayer.stopLoad).toHaveBeenCalledTimes(2);
        expect(hlsPlayer.startLoad.mock.calls).toEqual([
            [3_000],
            [3_660]
        ]);
    });

    it('retargets recovery after a stale higher group follows a completed backward seek', () => {
        const media = document.createElement('video');
        const hlsPlayer = new MockHLSPlayer(media);
        hlsPlayer.hasEnoughToStart = true;
        bindTestPlayer(hlsPlayer);
        media.currentTime = 3_600;
        media.dispatchEvent(new Event('timeupdate'));
        prepareHLSSeek(hlsPlayer, 900);
        media.currentTime = 900;
        media.dispatchEvent(new Event('seeked'));

        media.currentTime = 3_600;
        media.dispatchEvent(new Event('timeupdate'));
        expect(getHLSPlaybackPosition(hlsPlayer, media.currentTime)).toBe(900);

        hlsPlayer.emit(
            HLS_EVENTS.ERROR,
            createFatalErrorData(HLS_ERROR_TYPES.MEDIA_ERROR)
        );

        expect(hlsPlayer.stopLoad).toHaveBeenCalledTimes(2);
        expect(hlsPlayer.startLoad.mock.calls).toEqual([
            [3_600],
            [900]
        ]);
    });

    it('continues clock authority after an in-buffer seek and a network stall event', () => {
        const media = document.createElement('video');
        Object.defineProperties(media, {
            ended: { configurable: true, value: false },
            paused: { configurable: true, value: false },
            readyState: { configurable: true, value: 3 }
        });
        let monotonicTimeMilliseconds = 10_000;
        vi.spyOn(performance, 'now').mockImplementation(() => monotonicTimeMilliseconds);
        const hlsPlayer = new MockHLSPlayer(media);
        bindTestPlayer(hlsPlayer);
        media.dispatchEvent(new Event('playing'));
        media.currentTime = 3_600;
        media.dispatchEvent(new Event('timeupdate'));

        prepareHLSSeek(hlsPlayer, 900);
        media.dispatchEvent(new Event('seeking'));
        media.currentTime = 900;
        media.dispatchEvent(new Event('seeked'));
        media.dispatchEvent(new Event('stalled'));

        monotonicTimeMilliseconds = 11_000;
        media.currentTime = 901;
        media.dispatchEvent(new Event('timeupdate'));

        expect(getHLSPlaybackPosition(hlsPlayer, media.currentTime)).toBe(901);
    });

    it.each([
        HLS_ERROR_DETAILS.BUFFER_SEEK_OVER_HOLE,
        HLS_ERROR_DETAILS.BUFFER_NUDGE_ON_STALL
    ])('accepts the hls.js-owned %s clock movement during seek probation', (details) => {
        const media = document.createElement('video');
        const hlsPlayer = new MockHLSPlayer(media);
        bindTestPlayer(hlsPlayer);
        media.currentTime = 3_600;
        media.dispatchEvent(new Event('timeupdate'));
        prepareHLSSeek(hlsPlayer, 900);
        media.currentTime = 900;
        media.dispatchEvent(new Event('seeked'));

        media.currentTime = 902;
        hlsPlayer.emit(
            HLS_EVENTS.ERROR,
            createAppendErrorData(details, new Error(details))
        );

        expect(getHLSPlaybackPosition(hlsPlayer, media.currentTime)).toBe(902);
    });

    it('restarts loading after recovering at the unchanged nonzero position', () => {
        const media = document.createElement('video');
        const hlsPlayer = new MockHLSPlayer(media);
        hlsPlayer.hasEnoughToStart = true;
        bindTestPlayer(hlsPlayer);
        media.currentTime = 120;
        media.dispatchEvent(new Event('timeupdate'));

        hlsPlayer.emit(
            HLS_EVENTS.ERROR,
            createFatalErrorData(HLS_ERROR_TYPES.MEDIA_ERROR)
        );

        expect(hlsPlayer.stopLoad).toHaveBeenCalledOnce();
        expect(hlsPlayer.recoverMediaError).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledWith(120);
    });

    it('explicitly restarts the modern runtime after nonzero recovery', () => {
        const media = document.createElement('video');
        const hlsPlayer = new MockHLSPlayer(media, 0, false);
        hlsPlayer.hasEnoughToStart = true;
        bindTestPlayer(hlsPlayer);
        media.currentTime = 120;
        media.dispatchEvent(new Event('timeupdate'));

        hlsPlayer.emit(
            HLS_EVENTS.ERROR,
            createFatalErrorData(HLS_ERROR_TYPES.MEDIA_ERROR)
        );

        expect(hlsPlayer.stopLoad).toHaveBeenCalledOnce();
        expect(hlsPlayer.recoverMediaError).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledWith(120);
    });

    it('does not turn an unexplained zero reset into the recovery target', () => {
        const media = document.createElement('video');
        const hlsPlayer = new MockHLSPlayer(media);
        hlsPlayer.hasEnoughToStart = true;
        bindTestPlayer(hlsPlayer);
        media.currentTime = 3_600;
        media.dispatchEvent(new Event('timeupdate'));
        media.currentTime = 0;
        media.dispatchEvent(new Event('timeupdate'));

        hlsPlayer.emit(
            HLS_EVENTS.ERROR,
            createFatalErrorData(HLS_ERROR_TYPES.MEDIA_ERROR)
        );

        expect(hlsPlayer.recoverMediaError).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledWith(3_600);
    });

    it('preserves an explicit seek to exact zero during recovery', () => {
        const media = document.createElement('video');
        const hlsPlayer = new MockHLSPlayer(media);
        hlsPlayer.hasEnoughToStart = true;
        bindTestPlayer(hlsPlayer);
        media.currentTime = 3_600;
        media.dispatchEvent(new Event('timeupdate'));
        media.currentTime = 0;
        prepareHLSSeek(hlsPlayer, 0);
        media.dispatchEvent(new Event('seeked'));
        expect(getHLSPlaybackPosition(hlsPlayer, media.currentTime)).toBe(0);
        hlsPlayer.startLoad.mockClear();

        hlsPlayer.emit(
            HLS_EVENTS.ERROR,
            createFatalErrorData(HLS_ERROR_TYPES.MEDIA_ERROR)
        );

        expect(hlsPlayer.recoverMediaError).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledWith(0);
    });

    it('recovers at the final target from a far non-monotonic seek burst', () => {
        const media = document.createElement('video');
        const hlsPlayer = new MockHLSPlayer(media);
        hlsPlayer.hasEnoughToStart = true;
        bindTestPlayer(hlsPlayer);
        for (const targetSeconds of [1_000, 5_000, 2_000]) {
            media.currentTime = targetSeconds;
            prepareHLSSeek(hlsPlayer, targetSeconds);
        }
        media.currentTime = 1_000;
        media.dispatchEvent(new Event('seeked'));
        media.currentTime = 5_000;
        media.dispatchEvent(new Event('timeupdate'));
        hlsPlayer.startLoad.mockClear();
        media.currentTime = 1_000;

        hlsPlayer.emit(
            HLS_EVENTS.ERROR,
            createFatalErrorData(HLS_ERROR_TYPES.MEDIA_ERROR)
        );

        expect(hlsPlayer.recoverMediaError).toHaveBeenCalledOnce();
        expect(hlsPlayer.stopLoad).toHaveBeenCalledTimes(2);
        expect(hlsPlayer.startLoad.mock.calls).toEqual([
            [1_000],
            [2_000]
        ]);
    });

    it('preserves the automatic live-edge start sentinel during recovery', () => {
        const media = document.createElement('audio');
        const hlsPlayer = new MockHLSPlayer(media, -1);
        bindTestPlayer(hlsPlayer);

        emitLogicalAppendFailure(hlsPlayer, 'failure-1');
        emitLogicalAppendFailure(hlsPlayer, 'failure-2');
        emitLogicalAppendFailure(hlsPlayer, 'failure-3');

        expect(hlsPlayer.recoverMediaError).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledOnce();
        expect(hlsPlayer.startLoad).toHaveBeenCalledWith(-1);
    });

    it('restarts one fatal network error per HLS instance then terminates', () => {
        const firstMedia = document.createElement('video');
        const firstHLSPlayer = new MockHLSPlayer(firstMedia);
        const { reject } = bindTestPlayer(firstHLSPlayer);
        const fatalNetworkError = createFatalErrorData(HLS_ERROR_TYPES.NETWORK_ERROR);

        firstHLSPlayer.emit(HLS_EVENTS.ERROR, fatalNetworkError);
        expect(firstHLSPlayer.startLoad).toHaveBeenCalledOnce();
        expect(firstHLSPlayer.destroy).not.toHaveBeenCalled();
        expect(reject).not.toHaveBeenCalled();

        firstHLSPlayer.emit(HLS_EVENTS.ERROR, fatalNetworkError);
        expect(firstHLSPlayer.startLoad).toHaveBeenCalledOnce();
        expect(firstHLSPlayer.destroy).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledOnce();
        expect(reject).toHaveBeenCalledWith(MediaError.NETWORK_ERROR);

        const secondMedia = document.createElement('video');
        const secondHLSPlayer = new MockHLSPlayer(secondMedia);
        const secondBinding = bindTestPlayer(secondHLSPlayer);
        secondHLSPlayer.emit(HLS_EVENTS.ERROR, fatalNetworkError);
        expect(secondHLSPlayer.startLoad).toHaveBeenCalledOnce();
        expect(secondHLSPlayer.destroy).not.toHaveBeenCalled();
        expect(secondBinding.reject).not.toHaveBeenCalled();
    });

    it('ignores events from a retired HLS instance', () => {
        const media = document.createElement('video');
        const retiredHLSPlayer = new MockHLSPlayer(media);
        const { instance, reject } = bindTestPlayer(retiredHLSPlayer);
        instance._hlsPlayer = new MockHLSPlayer(media);

        for (let failureIndex = 0; failureIndex < 10; failureIndex++) {
            emitLogicalAppendFailure(retiredHLSPlayer, `retired-${failureIndex}`);
        }

        expect(retiredHLSPlayer.recoverMediaError).not.toHaveBeenCalled();
        expect(retiredHLSPlayer.destroy).not.toHaveBeenCalled();
        expect(reject).not.toHaveBeenCalled();
    });

    it('does not resolve startup after an append failure settles it', async () => {
        const media = document.createElement('video');
        let finishPlay = (): void => undefined;
        const playPromise = new Promise<void>((resolve) => {
            finishPlay = resolve;
        });
        Object.defineProperty(media, 'play', {
            configurable: true,
            value: vi.fn(() => playPromise)
        });
        const hlsPlayer = new MockHLSPlayer(media);
        const { reject, resolve } = bindTestPlayer(hlsPlayer);

        hlsPlayer.emit(
            HLS_EVENTS.MANIFEST_PARSED,
            createAppendErrorData('manifest', new Error('manifest'))
        );
        for (let failureIndex = 0; failureIndex < 6; failureIndex++) {
            emitLogicalAppendFailure(hlsPlayer, `terminal-${failureIndex}`);
        }
        expect(reject).toHaveBeenCalledOnce();

        finishPlay();
        await playPromise;
        await Promise.resolve();

        expect(resolve).not.toHaveBeenCalled();
        expect(reject).toHaveBeenCalledOnce();
    });

    it('emits post-start terminal errors instead of rejecting a settled startup', async () => {
        const media = document.createElement('audio');
        Object.defineProperty(media, 'play', {
            configurable: true,
            value: vi.fn(() => Promise.resolve())
        });
        const hlsPlayer = new MockHLSPlayer(media);
        const { instance, reject, resolve } = bindTestPlayer(hlsPlayer);
        const errorListener = vi.fn();
        Events.on(instance, 'error', errorListener);

        hlsPlayer.emit(
            HLS_EVENTS.MANIFEST_PARSED,
            createAppendErrorData('manifest', new Error('manifest'))
        );
        await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());

        for (let failureIndex = 0; failureIndex < 6; failureIndex++) {
            emitLogicalAppendFailure(hlsPlayer, `post-start-${failureIndex}`);
        }

        expect(reject).not.toHaveBeenCalled();
        expect(errorListener).toHaveBeenCalledOnce();
        expect(errorListener.mock.calls[0][1]).toEqual({
            type: MediaError.MEDIA_DECODE_ERROR
        });
    });

    it('delegates established video errors to the owning session callback', async () => {
        const media = document.createElement('video');
        Object.defineProperty(media, 'play', {
            configurable: true,
            value: vi.fn(() => Promise.resolve())
        });
        const hlsPlayer = new MockHLSPlayer(media);
        const establishedError = vi.fn();
        const { instance, reject, resolve } = bindTestPlayer(
            hlsPlayer,
            establishedError
        );
        const errorListener = vi.fn();
        Events.on(instance, 'error', errorListener);

        hlsPlayer.emit(
            HLS_EVENTS.MANIFEST_PARSED,
            createAppendErrorData('manifest', new Error('manifest'))
        );
        await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());

        for (let failureIndex = 0; failureIndex < 6; failureIndex++) {
            emitLogicalAppendFailure(hlsPlayer, `post-start-${failureIndex}`);
        }

        expect(reject).not.toHaveBeenCalled();
        expect(establishedError).toHaveBeenCalledOnce();
        expect(establishedError).toHaveBeenCalledWith(MediaError.MEDIA_DECODE_ERROR);
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
