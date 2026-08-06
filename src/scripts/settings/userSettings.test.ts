import { beforeEach, describe, expect, it, vi } from 'vitest';

import { VideoPlayerPreference } from 'components/playback/PreferredVideoPlayer';
import {
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS,
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
} from 'plugins/webGPUPlayer/custom/CustomAudioDownmixAlgorithm';

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

describe('UserSettings WebGPU audio downmix algorithm', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('defaults to standard Lo/Ro with dynamic peak limiting', () => {
        const settings = new UserSettings();

        expect(settings.webGPUAudioDownmixAlgorithm())
            .toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
    });

    it('persists a supported selection for the current user on this client', () => {
        const settings = new UserSettings();
        settings.currentUserId = 'user-1';

        settings.webGPUAudioDownmixAlgorithm(
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845
        );

        expect(localStorage.getItem('user-1-webGPUAudioDownmixAlgorithm'))
            .toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845);
        expect(settings.webGPUAudioDownmixAlgorithm())
            .toBe(CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845);
    });

    it('normalizes invalid persisted and assigned values to the default', () => {
        const settings = new UserSettings();
        settings.currentUserId = 'user-1';
        localStorage.setItem('user-1-webGPUAudioDownmixAlgorithm', 'unsupported');

        expect(settings.webGPUAudioDownmixAlgorithm())
            .toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);

        const untypedSettings = settings as unknown as {
            webGPUAudioDownmixAlgorithm: (value: string) => string
        };
        untypedSettings.webGPUAudioDownmixAlgorithm('also-unsupported');

        expect(localStorage.getItem('user-1-webGPUAudioDownmixAlgorithm'))
            .toBe(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
    });
});
