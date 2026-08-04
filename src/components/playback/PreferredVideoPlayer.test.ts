import { describe, expect, it } from 'vitest';

import {
    normalizeVideoPlayerPreference,
    orderVideoPlayersByPreference,
    VideoPlayerPreference
} from './PreferredVideoPlayer';

type TestPlayer = {
    id: string
};

const PLAYERS: readonly TestPlayer[] = [
    { id: 'webgpuplayer' },
    { id: 'htmlvideoplayer' },
    { id: 'youtubeplayer' }
];

describe('PreferredVideoPlayer', () => {
    it.each([
        VideoPlayerPreference.Auto,
        VideoPlayerPreference.HTML,
        VideoPlayerPreference.WEBGPU
    ])('preserves supported preference %s', preference => {
        expect(normalizeVideoPlayerPreference(preference)).toBe(preference);
    });

    it.each([ undefined, null, '', 'native', 1 ])(
        'normalizes unsupported preference %s to auto',
        preference => {
            expect(normalizeVideoPlayerPreference(preference))
                .toBe(VideoPlayerPreference.Auto);
        }
    );

    it('preserves priority order for automatic selection', () => {
        expect(orderVideoPlayersByPreference(
            PLAYERS,
            'Video',
            VideoPlayerPreference.Auto
        )).toEqual(PLAYERS);
    });

    it('moves HTML ahead of WebGPU for new video sessions', () => {
        expect(orderVideoPlayersByPreference(
            PLAYERS,
            'Video',
            VideoPlayerPreference.HTML
        ).map(player => player.id)).toEqual([
            'htmlvideoplayer',
            'webgpuplayer',
            'youtubeplayer'
        ]);
    });

    it('moves WebGPU ahead of HTML for new video sessions', () => {
        const reversedPlayers = [ PLAYERS[1], PLAYERS[0], PLAYERS[2] ];

        expect(orderVideoPlayersByPreference(
            reversedPlayers,
            'Video',
            VideoPlayerPreference.WEBGPU
        ).map(player => player.id)).toEqual([
            'webgpuplayer',
            'htmlvideoplayer',
            'youtubeplayer'
        ]);
    });

    it('does not reorder audio players', () => {
        expect(orderVideoPlayersByPreference(
            PLAYERS,
            'Audio',
            VideoPlayerPreference.HTML
        )).toEqual(PLAYERS);
    });

    it('retains normal fallbacks when the preferred player is unavailable', () => {
        const playersWithoutWebGPU = PLAYERS.filter(player => (
            player.id !== 'webgpuplayer'
        ));

        expect(orderVideoPlayersByPreference(
            playersWithoutWebGPU,
            'Video',
            VideoPlayerPreference.WEBGPU
        )).toEqual(playersWithoutWebGPU);
    });
});
