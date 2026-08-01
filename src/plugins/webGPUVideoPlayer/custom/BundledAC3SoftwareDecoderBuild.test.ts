import { describe, expect, it, vi } from 'vitest';

import { registerBundledAC3SoftwareAudioDecoder } from 'plugins/webGPUVideoPlayer/custom/BundledAC3SoftwareDecoderBuild';

const registerAC3Decoder = vi.hoisted(() => vi.fn());

vi.mock('@mediabunny/ac3', () => ({ registerAc3Decoder: registerAC3Decoder }));

describe('bundled AC-3 software decoder build selection', () => {
    it('matches the configured build gate', async () => {
        await registerBundledAC3SoftwareAudioDecoder();

        expect(registerAC3Decoder).toHaveBeenCalledTimes(
            __ENABLE_BUNDLED_AC3_SOFTWARE_DECODER__ ? 1 : 0
        );
    });
});
