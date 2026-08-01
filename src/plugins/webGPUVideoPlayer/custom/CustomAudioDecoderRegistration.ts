import { registerBundledAC3SoftwareAudioDecoder } from 'plugins/webGPUVideoPlayer/custom/BundledAC3SoftwareDecoderBuild';

export type BundledAudioDecoderRegistrar = () => Promise<void>;

/** Loads a bundled decoder only when the selected track actually requires it. */
export function registerRequiredCustomAudioDecoder(
    codec: string,
    registerBundledAudioDecoder: BundledAudioDecoderRegistrar =
    registerBundledAC3SoftwareAudioDecoder
): Promise<void> {
    switch (codec) {
        case 'ac3':
        case 'eac3':
            return registerBundledAudioDecoder();
        default:
            return Promise.resolve();
    }
}
