import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchLocalMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/fetchLocal', () => ({
    default: fetchLocalMock
}));

function createConfigResponse(enableWebGPUVideoPlayer: boolean): Pick<Response, 'json' | 'ok'> {
    return {
        json: () => Promise.resolve({
            enableWebGPUVideoPlayer,
            plugins: [
                'htmlAudioPlayer/plugin',
                'htmlVideoPlayer/plugin',
                'photoPlayer/plugin'
            ]
        }),
        ok: true
    };
}

describe('webSettings player feature flags', () => {
    beforeEach(() => {
        vi.resetModules();
        fetchLocalMock.mockReset();
    });

    it('omits the WebGPU player by default', async () => {
        fetchLocalMock.mockResolvedValue(createConfigResponse(false));
        const { getPlugins } = await import('./webSettings');

        await expect(getPlugins()).resolves.toEqual([
            'htmlAudioPlayer/plugin',
            'htmlVideoPlayer/plugin',
            'photoPlayer/plugin'
        ]);
    });

    it('inserts the WebGPU player immediately before the HTML fallback when enabled', async () => {
        fetchLocalMock.mockResolvedValue(createConfigResponse(true));
        const { getPlugins } = await import('./webSettings');

        await expect(getPlugins()).resolves.toEqual([
            'htmlAudioPlayer/plugin',
            'webGPUVideoPlayer/plugin',
            'htmlVideoPlayer/plugin',
            'photoPlayer/plugin'
        ]);
    });

    it('normalizes an explicitly listed WebGPU plugin through the feature flag', async () => {
        fetchLocalMock.mockResolvedValue({
            json: () => Promise.resolve({
                enableWebGPUVideoPlayer: false,
                plugins: ['webGPUVideoPlayer/plugin', 'htmlVideoPlayer/plugin']
            }),
            ok: true
        });
        const { getPlugins } = await import('./webSettings');

        await expect(getPlugins()).resolves.toEqual(['htmlVideoPlayer/plugin']);
    });
});
