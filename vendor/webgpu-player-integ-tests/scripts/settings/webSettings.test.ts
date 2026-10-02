import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchLocalMock = vi.hoisted(() => vi.fn());

vi.mock('utils/fetchLocal', () => ({
    default: fetchLocalMock
}));

function createConfigResponse(): Pick<Response, 'json' | 'ok'> {
    return {
        json: () => Promise.resolve({
            plugins: [
                'htmlAudioPlayer/plugin',
                'htmlVideoPlayer/plugin',
                'photoPlayer/plugin'
            ]
        }),
        ok: true
    };
}

describe('webSettings player registration', () => {
    beforeEach(() => {
        vi.resetModules();
        fetchLocalMock.mockReset();
    });

    it('inserts the WebGPU player immediately before the HTML fallback', async () => {
        fetchLocalMock.mockResolvedValue(createConfigResponse());
        const { getPlugins } = await import('scripts/settings/webSettings');

        await expect(getPlugins()).resolves.toEqual([
            'htmlAudioPlayer/plugin',
            'webGPUPlayer/plugin',
            'htmlVideoPlayer/plugin',
            'photoPlayer/plugin'
        ]);
    });

    it('normalizes an explicitly listed WebGPU plugin', async () => {
        fetchLocalMock.mockResolvedValue({
            json: () => Promise.resolve({
                plugins: ['webGPUPlayer/plugin', 'htmlVideoPlayer/plugin']
            }),
            ok: true
        });
        const { getPlugins } = await import('scripts/settings/webSettings');

        await expect(getPlugins()).resolves.toEqual([
            'webGPUPlayer/plugin',
            'htmlVideoPlayer/plugin'
        ]);
    });

    it('reads independent custom decode and HDR flags', async () => {
        fetchLocalMock.mockResolvedValue({
            json: () => Promise.resolve({
                enableWebGPUCustomDecode: true,
                enableWebGPUHDRToneMapping: true,
                plugins: []
            }),
            ok: true
        });
        const {
            getWebGPUCustomDecodeEnabled,
            getWebGPUHDRToneMappingEnabled,
            isWebGPUCustomDecodeEnabled
        } = await import('scripts/settings/webSettings');

        expect(isWebGPUCustomDecodeEnabled()).toBe(true);
        await expect(getWebGPUCustomDecodeEnabled()).resolves.toBe(true);
        expect(isWebGPUCustomDecodeEnabled()).toBe(true);
        await expect(getWebGPUHDRToneMappingEnabled()).resolves.toBe(true);
    });
});
