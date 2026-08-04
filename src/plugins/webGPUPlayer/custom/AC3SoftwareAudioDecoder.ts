import { registerAc3Decoder } from '@mediabunny/ac3';

let registered = false;

/** Registers Mediabunny's bundled AC-3/E-AC-3 decoder once in the decode worker. */
export function registerAC3SoftwareAudioDecoder(): void {
    if (registered) {
        return;
    }

    registerAc3Decoder();
    registered = true;
}
