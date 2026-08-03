import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoPlayerPreference } from 'components/playback/PreferredVideoPlayer';

vi.mock('hooks/api/useDisplayPreferences', () => ({
    getDisplayPreferencesQuery: vi.fn()
}));

vi.mock('hooks/api/useUser', () => ({
    getUserQuery: vi.fn()
}));

vi.mock('hooks/useUsers', () => ({
    ['QUERY_KEY']: 'users'
}));

vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {}
}));

vi.mock('utils/events', () => ({
    default: {
        trigger: vi.fn()
    }
}));

vi.mock('utils/query/queryClient', () => ({
    queryClient: {}
}));

vi.mock('../browser', () => ({
    default: {}
}));

vi.mock('./appSettings', () => ({
    default: {
        get: (name: string, userID?: string): string | null => localStorage.getItem(
            userID ? `${userID}-${name}` : name
        ),
        set: (name: string, value: unknown, userID?: string): void => {
            localStorage.setItem(
                userID ? `${userID}-${name}` : name,
                String(value)
            );
        }
    }
}));

import { UserSettings } from './userSettings';

describe('UserSettings preferred video player', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('defaults to automatic selection', () => {
        const settings = new UserSettings();

        expect(settings.preferredVideoPlayer()).toBe(VideoPlayerPreference.Auto);
    });

    it('persists the selection for the current user on this client', () => {
        const settings = new UserSettings();
        settings.currentUserId = 'user-1';

        settings.preferredVideoPlayer(VideoPlayerPreference.HTML);

        expect(localStorage.getItem('user-1-preferredVideoPlayer'))
            .toBe(VideoPlayerPreference.HTML);
        expect(settings.preferredVideoPlayer()).toBe(VideoPlayerPreference.HTML);
    });

    it('normalizes invalid persisted values to automatic selection', () => {
        const settings = new UserSettings();
        settings.currentUserId = 'user-1';
        localStorage.setItem('user-1-preferredVideoPlayer', 'unsupported');

        expect(settings.preferredVideoPlayer()).toBe(VideoPlayerPreference.Auto);
    });
});
