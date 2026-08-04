import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    loadHLSRuntime,
    type HLSRuntimeConstructor,
    type HLSRuntimeImporter
} from './HLSRuntimeLoader';

function createRuntime(label: string): HLSRuntimeConstructor {
    return class TestHLSRuntime {
        public static readonly runtimeLabel = label;
    } as unknown as HLSRuntimeConstructor;
}

function createImporter(HLSRuntime: HLSRuntimeConstructor): HLSRuntimeImporter {
    return vi.fn(() => Promise.resolve({ default: HLSRuntime }));
}

describe('loadHLSRuntime', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('loads the isolated WebGPU runtime without touching stable HLS', async () => {
        const stableRuntimeImporter = createImporter(createRuntime('stable'));
        const webGPUHLSRuntime = createRuntime('webgpu');
        const webGPUHLSRuntimeImporter = createImporter(webGPUHLSRuntime);

        await expect(loadHLSRuntime(
            true,
            stableRuntimeImporter,
            webGPUHLSRuntimeImporter
        )).resolves.toEqual({
            HLSRuntime: webGPUHLSRuntime,
            useWebGPUHLSRuntime: true
        });
        expect(stableRuntimeImporter).not.toHaveBeenCalled();
    });

    it('pairs a failed modern import with the stable runtime identity', async () => {
        const stableHLSRuntime = createRuntime('stable');
        const stableRuntimeImporter = createImporter(stableHLSRuntime);
        const importError = new Error('modern chunk unavailable');
        const webGPUHLSRuntimeImporter = vi.fn(() => Promise.reject(importError));
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(loadHLSRuntime(
            true,
            stableRuntimeImporter,
            webGPUHLSRuntimeImporter
        )).resolves.toEqual({
            HLSRuntime: stableHLSRuntime,
            useWebGPUHLSRuntime: false
        });
        expect(console.warn).toHaveBeenCalledWith(
            expect.stringContaining('using the stable runtime'),
            importError
        );
    });

    it('rejects instead of hanging when neither runtime can load', async () => {
        const stableImportError = new Error('stable chunk unavailable');
        const stableRuntimeImporter = vi.fn(() => Promise.reject(stableImportError));
        const webGPUHLSRuntimeImporter = vi.fn(() => Promise.reject(
            new Error('modern chunk unavailable')
        ));
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await expect(loadHLSRuntime(
            true,
            stableRuntimeImporter,
            webGPUHLSRuntimeImporter
        )).rejects.toBe(stableImportError);
    });
});
