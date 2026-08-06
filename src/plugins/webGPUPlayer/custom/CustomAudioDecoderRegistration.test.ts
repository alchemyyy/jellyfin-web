import { describe, expect, it, vi } from 'vitest';

const registerAC3SoftwareAudioDecoder = vi.hoisted(() => vi.fn());
const registerMediabunnyPCMBuiltinDecoderAvailability = vi.hoisted(() => vi.fn());

vi.mock('./AC3SoftwareAudioDecoder', () => ({ registerAC3SoftwareAudioDecoder }));
vi.mock('./MediabunnyPCMBuiltinDecoderAvailability', () => ({
    registerMediabunnyPCMBuiltinDecoderAvailability
}));

import { registerRequiredCustomAudioDecoder } from './CustomAudioDecoderRegistration';

describe('registerRequiredCustomAudioDecoder', () => {
    it('registers a supplied custom decoder for AC-3', async () => {
        const registerCustomAudioDecoder = vi.fn(() => Promise.resolve());

        await registerRequiredCustomAudioDecoder('ac3', registerCustomAudioDecoder);

        expect(registerCustomAudioDecoder).toHaveBeenCalledOnce();
    });

    it('loads the official Mediabunny decoder in an ordinary build for AC-3', async () => {
        await registerRequiredCustomAudioDecoder('ac3');

        expect(registerAC3SoftwareAudioDecoder).toHaveBeenCalledOnce();
    });

    it.each([ 'aac', 'eac3', 'flac', 'mp3', 'opus', 'vorbis' ])(
        'does not load a custom decoder for %s',
        async (codec: string) => {
            const registerCustomAudioDecoder = vi.fn(() => Promise.resolve());

            await registerRequiredCustomAudioDecoder(codec, registerCustomAudioDecoder);

            expect(registerCustomAudioDecoder).not.toHaveBeenCalled();
        }
    );

    it.each([ 'ulaw', 'alaw' ])(
        'enables Mediabunny built-in %s decoding without loading another decoder',
        async (codec: string) => {
            const registerCustomAudioDecoder = vi.fn(() => Promise.resolve());

            await registerRequiredCustomAudioDecoder(codec, registerCustomAudioDecoder);

            expect(registerMediabunnyPCMBuiltinDecoderAvailability).toHaveBeenCalledOnce();
            expect(registerCustomAudioDecoder).not.toHaveBeenCalled();
        }
    );

    it('propagates a custom decoder loading failure', async () => {
        const registerCustomAudioDecoder = vi.fn(() => (
            Promise.reject(new Error('decoder asset failed'))
        ));

        await expect(registerRequiredCustomAudioDecoder(
            'ac3',
            registerCustomAudioDecoder
        )).rejects.toThrow('decoder asset failed');
    });
});
