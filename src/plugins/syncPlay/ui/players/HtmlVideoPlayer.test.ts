import { describe, expect, it, vi } from 'vitest';

vi.mock('./NoActivePlayer', () => ({
    default: class MockNoActivePlayer {
        public constructor(
            public readonly player: unknown,
            public readonly manager: unknown
        ) {}
    }
}));

import HtmlVideoPlayer from './HtmlVideoPlayer';

type PlaybackRateWrapper = {
    hasPlaybackRate: () => boolean
    player: {
        supports?: (feature: string) => boolean
    }
};

function createWrapper(
    supports?: (feature: string) => boolean
): PlaybackRateWrapper {
    const wrapper = Object.create(HtmlVideoPlayer.prototype) as PlaybackRateWrapper;
    wrapper.player = { supports };
    return wrapper;
}

describe('SyncPlay HtmlVideoPlayer playback-rate capability', () => {
    it('honors a composed player that explicitly masks playback-rate control', () => {
        const supports = vi.fn((): boolean => false);
        const wrapper = createWrapper(supports);

        expect(wrapper.hasPlaybackRate()).toBe(false);
        expect(supports).toHaveBeenCalledWith('PlaybackRate');
    });

    it('preserves legacy support for players without a feature query', () => {
        expect(createWrapper().hasPlaybackRate()).toBe(true);
    });
});
