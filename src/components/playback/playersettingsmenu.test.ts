import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    actionSheetShow: vi.fn(),
    currentItem: vi.fn(),
    currentMediaSource: vi.fn(),
    getRepeatMode: vi.fn(),
    getSupportedCommands: vi.fn()
}));

vi.mock('../actionSheet/actionSheet', () => ({
    default: {
        show: mocks.actionSheetShow
    }
}));

vi.mock('../playback/playbackmanager', () => ({
    playbackManager: {
        currentItem: mocks.currentItem,
        currentMediaSource: mocks.currentMediaSource,
        getRepeatMode: mocks.getRepeatMode,
        getSupportedCommands: mocks.getSupportedCommands
    }
}));

vi.mock('lib/globalize', () => ({
    default: {
        translate: (key: string): string => key
    }
}));

vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {
        getApiClient: vi.fn()
    }
}));

vi.mock('../qualityOptions', () => ({
    default: {
        getVideoQualityOptions: vi.fn()
    }
}));

import { show } from './playersettingsmenu';

describe('player settings menu contributions', () => {
    beforeEach(() => {
        mocks.actionSheetShow.mockReset();
        mocks.currentItem.mockReset().mockReturnValue(null);
        mocks.currentMediaSource.mockReset().mockReturnValue({
            MediaStreams: [],
            RunTimeTicks: 0
        });
        mocks.getRepeatMode.mockReset().mockReturnValue('RepeatNone');
        mocks.getSupportedCommands.mockReset().mockReturnValue([]);
    });

    it('appends contributed items and invokes the selected callback', async () => {
        const onSelect = vi.fn(() => Promise.resolve('opened'));
        const player = {
            getSettingsMenuItems: () => [{
                id: 'render-settings',
                name: 'Tone mapping',
                secondaryText: 'Custom',
                onSelect
            }]
        };
        const positionTo = document.createElement('button');
        mocks.actionSheetShow.mockResolvedValue('render-settings');

        const result = await show({
            player,
            positionTo,
            stats: true,
            suboffset: true
        });

        expect(mocks.actionSheetShow).toHaveBeenCalledWith({
            items: [
                {
                    name: 'SubtitleOffset',
                    id: 'suboffset',
                    asideText: null
                },
                {
                    name: 'PlaybackData',
                    id: 'stats',
                    asideText: null
                },
                {
                    name: 'Tone mapping',
                    id: 'render-settings',
                    secondaryText: 'Custom'
                }
            ],
            positionTo
        });
        expect(onSelect).toHaveBeenCalledOnce();
        expect(result).toBe('opened');
    });

    it('preserves built-in behavior when the player has no contributions', async () => {
        const onOption = vi.fn();
        mocks.actionSheetShow.mockResolvedValue('stats');

        await show({
            player: {},
            stats: true,
            onOption
        });

        expect(mocks.actionSheetShow.mock.calls[0][0].items).toEqual([{
            name: 'PlaybackData',
            id: 'stats',
            asideText: null
        }]);
        expect(onOption).toHaveBeenCalledWith('stats');
    });

    it('ignores malformed, duplicate, and built-in-colliding contributions', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const validOnSelect = vi.fn();
        const player = {
            getSettingsMenuItems: () => [
                null,
                { id: '', name: 'Missing id', onSelect: vi.fn() },
                { id: 'missing-name', name: '', onSelect: vi.fn() },
                { id: 'bad-secondary', name: 'Bad secondary', secondaryText: null, onSelect: vi.fn() },
                { id: 'missing-callback', name: 'Missing callback' },
                { id: 'stats', name: 'Collision', onSelect: vi.fn() },
                { id: 'valid-item', name: 'Valid', onSelect: validOnSelect },
                { id: 'valid-item', name: 'Duplicate', onSelect: vi.fn() }
            ]
        };
        mocks.actionSheetShow.mockResolvedValue('valid-item');

        await show({ player, stats: true });

        expect(mocks.actionSheetShow.mock.calls[0][0].items).toEqual([
            {
                name: 'PlaybackData',
                id: 'stats',
                asideText: null
            },
            {
                name: 'Valid',
                id: 'valid-item',
                secondaryText: undefined
            }
        ]);
        expect(validOnSelect).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledTimes(7);
    });

    it('ignores a non-array contribution result and reports the contract violation', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const player = {
            getSettingsMenuItems: () => ({ id: 'invalid' })
        };
        mocks.actionSheetShow.mockResolvedValue('stats');

        await show({ player, stats: true });

        expect(mocks.actionSheetShow.mock.calls[0][0].items).toHaveLength(1);
        expect(warn).toHaveBeenCalledOnce();
    });

    it('propagates contribution provider errors', () => {
        const providerError = new Error('provider failed');
        const player = {
            getSettingsMenuItems: () => {
                throw providerError;
            }
        };

        expect(() => show({ player })).toThrow(providerError);
        expect(mocks.actionSheetShow).not.toHaveBeenCalled();
    });

    it('propagates selected callback errors through the menu promise', async () => {
        const callbackError = new Error('callback failed');
        const player = {
            getSettingsMenuItems: () => [{
                id: 'failing-item',
                name: 'Failing item',
                onSelect: () => {
                    throw callbackError;
                }
            }]
        };
        mocks.actionSheetShow.mockResolvedValue('failing-item');

        await expect(show({ player })).rejects.toBe(callbackError);
    });
});
