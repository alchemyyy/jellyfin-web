import { describe, expect, it, vi } from 'vitest';

import { registerRequiredCustomAudioDecoder } from './CustomAudioDecoderRegistration';

describe('registerRequiredCustomAudioDecoder', () => {
    it.each([ 'ac3', 'eac3' ])('registers the bundled decoder for %s', async codec => {
        const registerBundledAudioDecoder = vi.fn(() => Promise.resolve());

        await registerRequiredCustomAudioDecoder(codec, registerBundledAudioDecoder);

        expect(registerBundledAudioDecoder).toHaveBeenCalledOnce();
    });

    it.each([ 'aac', 'flac', 'mp3', 'opus', 'vorbis' ])(
        'does not load the bundled decoder for %s',
        async codec => {
            const registerBundledAudioDecoder = vi.fn(() => Promise.resolve());

            await registerRequiredCustomAudioDecoder(codec, registerBundledAudioDecoder);

            expect(registerBundledAudioDecoder).not.toHaveBeenCalled();
        }
    );

    it('propagates a bundled decoder loading failure', async () => {
        const registerBundledAudioDecoder = vi.fn(() => (
            Promise.reject(new Error('decoder asset failed'))
        ));

        await expect(registerRequiredCustomAudioDecoder(
            'ac3',
            registerBundledAudioDecoder
        )).rejects.toThrow('decoder asset failed');
    });
});
