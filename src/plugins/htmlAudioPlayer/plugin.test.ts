import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const htmlMediaHelperMock = vi.hoisted(() => ({
    applySrc: vi.fn(() => Promise.resolve()),
    destroyHlsPlayer: vi.fn(),
    enableHlsJsPlayer: vi.fn(() => false),
    getCrossOriginValue: vi.fn(() => null),
    getHLSPlaybackPosition: vi.fn(
        (_hlsPlayer: unknown, currentPositionSeconds: number) => currentPositionSeconds
    ),
    getSavedVolume: vi.fn(() => 1),
    playWithPromise: vi.fn(() => Promise.resolve()),
    prepareHLSSeek: vi.fn()
}));

vi.mock('components/apphost', () => ({
    appHost: {
        supports: vi.fn(() => false)
    }
}));

vi.mock('components/htmlMediaHelper', () => htmlMediaHelperMock);

vi.mock('scripts/browser', () => ({
    default: {
        safari: false,
        tv: false
    }
}));

vi.mock('scripts/browserDeviceProfile', () => ({
    default: vi.fn(() => ({}))
}));

vi.mock('scripts/settings/userSettings', () => ({
    selectAudioNormalization: vi.fn(() => 'None')
}));

vi.mock('scripts/settings/webSettings', () => ({
    getIncludeCorsCredentials: vi.fn(() => Promise.resolve(false))
}));

import HtmlAudioPlayer from './plugin';

type HtmlAudioPlayerHarness = {
    _hlsPlayer: object | null
    _mediaElement: HTMLAudioElement
    currentTime: (positionMilliseconds?: number) => number | undefined
    play: (options: object) => Promise<unknown>
};

function createPlayOptions(): object {
    return {
        item: {},
        mediaSource: {
            RunTimeTicks: 60_000_000
        },
        playerStartPositionTicks: 0,
        url: 'https://example.test/audio.mp3'
    };
}

describe('HtmlAudioPlayer HLS position ownership', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        htmlMediaHelperMock.getHLSPlaybackPosition.mockImplementation(
            (_hlsPlayer: unknown, currentPositionSeconds: number) => currentPositionSeconds
        );
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('publishes explicit seeks before media mutation and preserves exact zero', async () => {
        const player = new HtmlAudioPlayer() as unknown as HtmlAudioPlayerHarness;
        await player.play(createPlayOptions());
        player._hlsPlayer = {};
        let mediaTimeWhenPrepared: number | null = null;
        htmlMediaHelperMock.prepareHLSSeek.mockImplementationOnce(() => {
            mediaTimeWhenPrepared = player._mediaElement.currentTime;
        });

        player.currentTime(3_600_000);

        expect(mediaTimeWhenPrepared).toBe(0);
        expect(htmlMediaHelperMock.prepareHLSSeek).toHaveBeenCalledWith(
            player._hlsPlayer,
            3_600
        );
        expect(player.currentTime()).toBe(3_600_000);

        player.currentTime(0);
        expect(player.currentTime()).toBe(0);
    });

    it('does not expose an unexplained HLS group rollback through the cached clock', async () => {
        const player = new HtmlAudioPlayer() as unknown as HtmlAudioPlayerHarness;
        await player.play(createPlayOptions());
        player._hlsPlayer = {};
        player.currentTime(3_600_000);
        htmlMediaHelperMock.getHLSPlaybackPosition.mockReturnValue(3_600);

        player._mediaElement.currentTime = 3_000;
        player._mediaElement.dispatchEvent(new Event('timeupdate'));

        expect(htmlMediaHelperMock.getHLSPlaybackPosition).toHaveBeenCalledWith(
            player._hlsPlayer,
            3_000
        );
        expect(player.currentTime()).toBe(3_600_000);
    });
});
