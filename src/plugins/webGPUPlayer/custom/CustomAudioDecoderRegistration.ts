import {
    registerMediabunnyPCMBuiltinDecoderAvailability
} from './MediabunnyPCMBuiltinDecoderAvailability';

const MEDIABUNNY_AC3_IMPLEMENTATION_ARTIFACT_SENTINEL =
    'jellyfin-webgpu-mediabunny-ac3-v2';

export type CustomAudioDecoderRegistrar = () => Promise<void>;

async function registerMediabunnyAC3SoftwareAudioDecoder(): Promise<void> {
    try {
        const { registerAC3SoftwareAudioDecoder } = await import('./AC3SoftwareAudioDecoder');
        registerAC3SoftwareAudioDecoder();
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${MEDIABUNNY_AC3_IMPLEMENTATION_ARTIFACT_SENTINEL}: ${detail}`);
    }
}

/** Loads an official Mediabunny decoder only when the selected track requires it. */
export function registerRequiredCustomAudioDecoder(
    codec: string,
    registerCustomAudioDecoder: CustomAudioDecoderRegistrar =
    registerMediabunnyAC3SoftwareAudioDecoder
): Promise<void> {
    switch (codec) {
        case 'ac3':
            return registerCustomAudioDecoder();
        case 'ulaw':
        case 'alaw':
            registerMediabunnyPCMBuiltinDecoderAvailability();
            return Promise.resolve();
        default:
            return Promise.resolve();
    }
}
