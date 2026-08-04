import {
    CustomAudioDecoder,
    registerDecoder,
    type AudioCodec
} from 'mediabunny';

let registered = false;

/**
 * Makes Mediabunny 1.52's input-track probe recognize its own mu-law and A-law
 * decoders. AudioSampleSink still selects Mediabunny's private PCM decoder
 * before it could instantiate this compatibility marker.
 */
class MediabunnyPCMBuiltinDecoderAvailability extends CustomAudioDecoder {
    public static supports(codec: AudioCodec, configuration: AudioDecoderConfig): boolean {
        return (codec === 'ulaw' || codec === 'alaw')
            && configuration.codec === codec;
    }

    public close(): void {
        throw new Error('Mediabunny PCM compatibility marker must not be instantiated');
    }

    public decode(): void {
        throw new Error('Mediabunny PCM compatibility marker must not be instantiated');
    }

    public flush(): void {
        throw new Error('Mediabunny PCM compatibility marker must not be instantiated');
    }

    public init(): void {
        throw new Error('Mediabunny PCM compatibility marker must not be instantiated');
    }
}

/** Registers the bounded Mediabunny 1.52 G.711 availability workaround once. */
export function registerMediabunnyPCMBuiltinDecoderAvailability(): void {
    if (registered) {
        return;
    }
    registerDecoder(MediabunnyPCMBuiltinDecoderAvailability);
    registered = true;
}
