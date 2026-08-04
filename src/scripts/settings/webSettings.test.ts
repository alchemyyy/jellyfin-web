import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchLocalMock = vi.hoisted(() => vi.fn());

vi.mock('../../utils/fetchLocal', () => ({
    default: fetchLocalMock
}));

function createConfigResponse(enableWebGPUPlayer: boolean): Pick<Response, 'json' | 'ok'> {
    return {
        json: () => Promise.resolve({
            enableWebGPUPlayer,
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

    it('keeps WebGPU available when a legacy config flag is false', async () => {
        fetchLocalMock.mockResolvedValue(createConfigResponse(false));
        const { getPlugins } = await import('./webSettings');

        await expect(getPlugins()).resolves.toEqual([
            'htmlAudioPlayer/plugin',
            'webGPUPlayer/plugin',
            'htmlVideoPlayer/plugin',
            'photoPlayer/plugin'
        ]);
    });

    it('inserts the WebGPU player immediately before the HTML fallback when enabled', async () => {
        fetchLocalMock.mockResolvedValue(createConfigResponse(true));
        const { getPlugins } = await import('./webSettings');

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
                enableWebGPUPlayer: false,
                plugins: ['webGPUPlayer/plugin', 'htmlVideoPlayer/plugin']
            }),
            ok: true
        });
        const { getPlugins } = await import('./webSettings');

        await expect(getPlugins()).resolves.toEqual([
            'webGPUPlayer/plugin',
            'htmlVideoPlayer/plugin'
        ]);
    });

    it('reads independent custom decode, HDR, and validation flags', async () => {
        fetchLocalMock.mockResolvedValue({
            json: () => Promise.resolve({
                enableWebGPUCustomDecode: true,
                enableWebGPUHDRToneMapping: true,
                enableWebGPUValidationHarness: false,
                plugins: []
            }),
            ok: true
        });
        const {
            getWebGPUCustomDecodeEnabled,
            getWebGPUHDRToneMappingEnabled,
            getWebGPUValidationHarnessEnabled,
            isWebGPUCustomDecodeEnabled
        } = await import('./webSettings');

        expect(isWebGPUCustomDecodeEnabled()).toBe(true);
        await expect(getWebGPUCustomDecodeEnabled()).resolves.toBe(true);
        expect(isWebGPUCustomDecodeEnabled()).toBe(true);
        await expect(getWebGPUHDRToneMappingEnabled()).resolves.toBe(true);
        await expect(getWebGPUValidationHarnessEnabled()).resolves.toBe(false);
    });
});
