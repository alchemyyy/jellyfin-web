import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import Events from 'utils/events';

type Deferred<Value> = {
    promise: Promise<Value>
    resolve: (value: Value) => void
};

type PlaybackIdentityState = {
    itemId: string
    mediaSourceId: string
    playMethod: string
    playSessionId: string
    serverId: string
};

type PlayerStatsResult = {
    categories: Array<{
        name: string
        stats: Array<{ label: string, value: string }>
    }>
};

type TestPlayer = {
    getStats: () => Promise<PlayerStatsResult>
    name: string
};

type PlayerStatsHarness = {
    destroy: () => void
    element: HTMLElement
    enabled: {
        (): boolean
        (enabled: boolean): void
    }
};

const playerStatsMocks = vi.hoisted(() => {
    const playbackIdentity: PlaybackIdentityState = {
        itemId: 'item-a',
        mediaSourceId: 'source-a',
        playMethod: 'DirectPlay',
        playSessionId: 'play-session-a',
        serverId: 'server-a'
    };
    const apiClient = {
        deviceId: vi.fn(() => 'device-a'),
        getSessions: vi.fn()
    };

    return {
        apiClient,
        playbackIdentity,
        playbackManager: {
            audioTracks: vi.fn(() => []),
            currentItem: vi.fn(() => ({
                Id: playbackIdentity.itemId,
                ServerId: playbackIdentity.serverId
            })),
            currentMediaSource: vi.fn(() => ({
                Id: playbackIdentity.mediaSourceId,
                MediaStreams: []
            })),
            getAudioStreamIndex: vi.fn(() => -1),
            playMethod: vi.fn(() => playbackIdentity.playMethod),
            playSessionId: vi.fn(() => playbackIdentity.playSessionId)
        }
    };
});

vi.mock('components/layoutManager', () => ({
    default: { tv: false }
}));

vi.mock('components/playback/playbackmanager', () => ({
    playbackManager: playerStatsMocks.playbackManager
}));

vi.mock('components/playback/playmethodhelper', () => ({
    default: {
        getDisplayPlayMethod: vi.fn((session: { PlayState?: { PlayMethod?: string } }) => (
            session.PlayState?.PlayMethod
        ))
    }
}));

vi.mock('components/pluginManager', () => ({
    pluginManager: {
        firstOfType: vi.fn(() => null)
    }
}));

vi.mock('elements/emby-button/paper-icon-button-light', () => ({}));

vi.mock('lib/globalize', () => ({
    default: {
        translate: vi.fn((value: string) => value)
    }
}));

vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        getApiClient: vi.fn(() => playerStatsMocks.apiClient)
    }
}));

vi.mock('utils/file', () => ({
    getReadableSize: vi.fn((value: number) => String(value))
}));

import PlayerStats from './playerstats';

function createDeferred<Value>(): Deferred<Value> {
    let resolvePromise: (value: Value) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    const promise = new Promise<Value>((resolve) => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

function createPlayerStatsResult(value: string): PlayerStatsResult {
    return {
        categories: [{
            name: 'Runtime',
            stats: [{ label: 'Marker', value }]
        }]
    };
}

function createSession(itemId: string, mediaSourceId: string, playMethod: string) {
    return {
        NowPlayingItem: { Id: itemId },
        PlayState: {
            MediaSourceId: mediaSourceId,
            PlayMethod: playMethod
        }
    };
}

function createPlayer(getStats: () => Promise<PlayerStatsResult>): TestPlayer {
    return {
        getStats,
        name: 'Test Player'
    };
}

function getRenderedStatValue(playerStats: PlayerStatsHarness, label: string): string | null {
    const rows = Array.from(playerStats.element.querySelectorAll('.playerStats-stat'));
    const matchingRow = rows.find((row) => (
        row.querySelector('.playerStats-stat-label')?.textContent === label
    ));
    return matchingRow?.querySelector('.playerStats-stat-value')?.textContent ?? null;
}

async function flushPromises(): Promise<void> {
    for (let iteration = 0; iteration < 5; iteration++) {
        await Promise.resolve();
    }
}

describe('PlayerStats asynchronous rendering', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(1_000);
        vi.clearAllMocks();
        Object.assign(playerStatsMocks.playbackIdentity, {
            itemId: 'item-a',
            mediaSourceId: 'source-a',
            playMethod: 'DirectPlay',
            playSessionId: 'play-session-a',
            serverId: 'server-a'
        });
    });

    afterEach(() => {
        document.body.innerHTML = '';
        vi.useRealTimers();
    });

    it('discards an in-flight result when the overlay is closed and reopened', async () => {
        const firstStats = createDeferred<PlayerStatsResult>();
        const secondStats = createDeferred<PlayerStatsResult>();
        const getStats = vi.fn<() => Promise<PlayerStatsResult>>()
            .mockReturnValueOnce(firstStats.promise)
            .mockReturnValueOnce(secondStats.promise);
        const player = createPlayer(getStats);
        const session = createSession('item-a', 'source-a', 'DirectPlay');
        playerStatsMocks.apiClient.getSessions.mockResolvedValue([session]);
        const playerStats = new PlayerStats({ player }) as PlayerStatsHarness;

        Events.trigger(player, 'timeupdate');
        playerStats.enabled(false);
        playerStats.enabled(true);
        vi.setSystemTime(1_001);
        Events.trigger(player, 'timeupdate');

        firstStats.resolve(createPlayerStatsResult('stale'));
        await flushPromises();
        expect(getRenderedStatValue(playerStats, 'Marker')).toBeNull();

        secondStats.resolve(createPlayerStatsResult('current'));
        await flushPromises();
        expect(getRenderedStatValue(playerStats, 'Marker')).toBe('current');

        playerStats.destroy();
    });

    it('discards an in-flight result when the overlay is destroyed', async () => {
        const pendingStats = createDeferred<PlayerStatsResult>();
        const player = createPlayer(vi.fn(() => pendingStats.promise));
        playerStatsMocks.apiClient.getSessions.mockResolvedValue([
            createSession('item-a', 'source-a', 'DirectPlay')
        ]);
        const playerStats = new PlayerStats({ player }) as PlayerStatsHarness;

        Events.trigger(player, 'timeupdate');
        await flushPromises();
        playerStats.destroy();
        pendingStats.resolve(createPlayerStatsResult('destroyed'));
        await flushPromises();

        expect(document.querySelector('.playerStats')).toBeNull();
    });

    it('keeps repeated enabled calls idempotent', async () => {
        const getStats = vi.fn<() => Promise<PlayerStatsResult>>()
            .mockResolvedValue(createPlayerStatsResult('current'));
        const player = createPlayer(getStats);
        playerStatsMocks.apiClient.getSessions.mockResolvedValue([
            createSession('item-a', 'source-a', 'DirectPlay')
        ]);
        const playerStats = new PlayerStats({ player }) as PlayerStatsHarness;

        playerStats.enabled(true);
        playerStats.enabled(true);
        Events.trigger(player, 'timeupdate');
        await flushPromises();
        expect(getStats).toHaveBeenCalledOnce();

        playerStats.enabled(false);
        playerStats.enabled(false);
        vi.setSystemTime(2_000);
        Events.trigger(player, 'timeupdate');
        await flushPromises();
        expect(getStats).toHaveBeenCalledOnce();

        playerStats.enabled(true);
        playerStats.enabled(true);
        Events.trigger(player, 'timeupdate');
        await flushPromises();
        expect(getStats).toHaveBeenCalledTimes(2);

        playerStats.destroy();
    });

    it('keeps a newer render when an older request completes last', async () => {
        const firstStats = createDeferred<PlayerStatsResult>();
        const secondStats = createDeferred<PlayerStatsResult>();
        const getStats = vi.fn<() => Promise<PlayerStatsResult>>()
            .mockReturnValueOnce(firstStats.promise)
            .mockReturnValueOnce(secondStats.promise);
        const player = createPlayer(getStats);
        playerStatsMocks.apiClient.getSessions.mockResolvedValue([
            createSession('item-a', 'source-a', 'DirectPlay')
        ]);
        const playerStats = new PlayerStats({ player }) as PlayerStatsHarness;

        Events.trigger(player, 'timeupdate');
        await flushPromises();
        vi.setSystemTime(1_701);
        Events.trigger(player, 'timeupdate');

        secondStats.resolve(createPlayerStatsResult('newer'));
        await flushPromises();
        expect(getRenderedStatValue(playerStats, 'Marker')).toBe('newer');

        firstStats.resolve(createPlayerStatsResult('older'));
        await flushPromises();
        expect(getRenderedStatValue(playerStats, 'Marker')).toBe('newer');

        playerStats.destroy();
    });

    it('refreshes the session cache on a route change and selects the matching session', async () => {
        const getStats = vi.fn<() => Promise<PlayerStatsResult>>()
            .mockResolvedValueOnce(createPlayerStatsResult('direct stats'))
            .mockResolvedValueOnce(createPlayerStatsResult('transcode stats'));
        const player = createPlayer(getStats);
        const directSession = createSession('item-a', 'source-a', 'DirectPlay');
        const transcodeSession = createSession('item-a', 'source-b', 'Transcode');
        playerStatsMocks.apiClient.getSessions
            .mockResolvedValueOnce([directSession])
            .mockResolvedValueOnce([directSession, transcodeSession]);
        const playerStats = new PlayerStats({ player }) as PlayerStatsHarness;

        Events.trigger(player, 'timeupdate');
        await flushPromises();
        expect(getRenderedStatValue(playerStats, 'LabelPlayer')).toContain('DirectPlaying');

        Object.assign(playerStatsMocks.playbackIdentity, {
            mediaSourceId: 'source-b',
            playMethod: 'Transcode',
            playSessionId: 'play-session-b'
        });
        vi.setSystemTime(1_100);
        Events.trigger(player, 'timeupdate');
        await flushPromises();

        expect(playerStatsMocks.apiClient.getSessions).toHaveBeenCalledTimes(2);
        expect(getRenderedStatValue(playerStats, 'Marker')).toBe('transcode stats');
        expect(getRenderedStatValue(playerStats, 'LabelPlayer')).toContain('Transcoding');

        playerStats.destroy();
    });

    it('does not reuse an unmatched server session after the route changes', async () => {
        const getStats = vi.fn<() => Promise<PlayerStatsResult>>()
            .mockResolvedValueOnce(createPlayerStatsResult('direct stats'))
            .mockResolvedValueOnce(createPlayerStatsResult('new route stats'));
        const player = createPlayer(getStats);
        const directSession = createSession('item-a', 'source-a', 'DirectPlay');
        playerStatsMocks.apiClient.getSessions
            .mockResolvedValueOnce([directSession])
            .mockResolvedValueOnce([directSession]);
        const playerStats = new PlayerStats({ player }) as PlayerStatsHarness;

        Events.trigger(player, 'timeupdate');
        await flushPromises();
        expect(getRenderedStatValue(playerStats, 'LabelPlayer')).toContain('DirectPlaying');

        Object.assign(playerStatsMocks.playbackIdentity, {
            mediaSourceId: 'source-b',
            playMethod: 'Transcode',
            playSessionId: 'play-session-b'
        });
        vi.setSystemTime(1_100);
        Events.trigger(player, 'timeupdate');
        await flushPromises();

        expect(playerStatsMocks.apiClient.getSessions).toHaveBeenCalledTimes(2);
        expect(getRenderedStatValue(playerStats, 'Marker')).toBe('new route stats');
        expect(getRenderedStatValue(playerStats, 'LabelPlayer')).toBe('Test Player');

        playerStats.destroy();
    });

    it('discards an in-flight result after the playback identity changes', async () => {
        const pendingStats = createDeferred<PlayerStatsResult>();
        const player = createPlayer(vi.fn(() => pendingStats.promise));
        playerStatsMocks.apiClient.getSessions.mockResolvedValue([
            createSession('item-a', 'source-a', 'DirectPlay')
        ]);
        const playerStats = new PlayerStats({ player }) as PlayerStatsHarness;

        Events.trigger(player, 'timeupdate');
        await flushPromises();
        Object.assign(playerStatsMocks.playbackIdentity, {
            itemId: 'item-b',
            mediaSourceId: 'source-b',
            playSessionId: 'play-session-b'
        });
        pendingStats.resolve(createPlayerStatsResult('stale playback'));
        await flushPromises();

        expect(getRenderedStatValue(playerStats, 'Marker')).toBeNull();

        playerStats.destroy();
    });
});
