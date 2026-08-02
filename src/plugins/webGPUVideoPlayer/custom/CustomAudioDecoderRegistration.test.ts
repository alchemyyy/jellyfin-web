import { describe, expect, it, vi } from 'vitest';

const registerAC3SoftwareAudioDecoder = vi.hoisted(() => vi.fn());

vi.mock('./AC3SoftwareAudioDecoder', () => ({ registerAC3SoftwareAudioDecoder }));

import { registerRequiredCustomAudioDecoder } from './CustomAudioDecoderRegistration';

describe('registerRequiredCustomAudioDecoder', () => {
    it.each([ 'ac3', 'eac3' ])(
        'registers a supplied custom decoder for %s',
        async (codec: string) => {
            const registerCustomAudioDecoder = vi.fn(() => Promise.resolve());

            await registerRequiredCustomAudioDecoder(codec, registerCustomAudioDecoder);

            expect(registerCustomAudioDecoder).toHaveBeenCalledOnce();
        }
    );

    it.each([ 'ac3', 'eac3' ])(
        'loads the official Mediabunny decoder in an ordinary build for %s',
        async (codec: string) => {
            await registerRequiredCustomAudioDecoder(codec);

            expect(registerAC3SoftwareAudioDecoder).toHaveBeenCalledOnce();
        }
    );

    it.each([ 'aac', 'flac', 'mp3', 'opus', 'vorbis' ])(
        'does not load a custom decoder for %s',
        async (codec: string) => {
            const registerCustomAudioDecoder = vi.fn(() => Promise.resolve());

            await registerRequiredCustomAudioDecoder(codec, registerCustomAudioDecoder);

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
