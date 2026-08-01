import { beforeEach, describe, expect, it, vi } from 'vitest';

const registerAc3Decoder = vi.hoisted(() => vi.fn());

vi.mock('@mediabunny/ac3', () => ({ registerAc3Decoder }));

describe('registerAC3SoftwareAudioDecoder', () => {
    beforeEach(() => {
        registerAc3Decoder.mockClear();
        vi.resetModules();
    });

    it('registers the official Mediabunny decoder exactly once', async () => {
        const { registerAC3SoftwareAudioDecoder } = await import('./AC3SoftwareAudioDecoder');

        registerAC3SoftwareAudioDecoder();
        registerAC3SoftwareAudioDecoder();

        expect(registerAc3Decoder).toHaveBeenCalledOnce();
    });
});
