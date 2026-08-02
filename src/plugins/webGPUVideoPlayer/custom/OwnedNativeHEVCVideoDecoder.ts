import type { EncodedPacket } from 'mediabunny';

import {
    hasHEVCRASLPicture,
    sanitizeHEVCAccessUnitForChromium,
    type HEVCNALFormat
} from './DolbyVisionHEVCSplitter';

export type OwnedNativeHEVCVideoDecoderCallbacks = {
    onError: (error: unknown) => void
    onFrame: (frame: VideoFrame) => unknown
    onProgress: () => void
};

export type NativeVideoDecoderPort = {
    close: () => void
    configure: (config: VideoDecoderConfig) => void
    decode: (chunk: EncodedVideoChunk) => void
    readonly decodeQueueSize: number
    flush: () => Promise<void>
    ondequeue: ((event: Event) => unknown) | null
};

export type OwnedNativeHEVCVideoDecoderDependencies = {
    createDecoder: (init: VideoDecoderInit) => NativeVideoDecoderPort
    createEncodedVideoChunk: (packet: EncodedPacket) => EncodedVideoChunk
};

const DEFAULT_DEPENDENCIES: OwnedNativeHEVCVideoDecoderDependencies = {
    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
    createDecoder: (init: VideoDecoderInit): NativeVideoDecoderPort => new VideoDecoder(init),
    createEncodedVideoChunk: (packet: EncodedPacket): EncodedVideoChunk => (
        packet.toEncodedVideoChunk()
    )
};

/** Owns one native HEVC VideoDecoder and its packet-to-frame lifecycle. */
export default class OwnedNativeHEVCVideoDecoder {
    private closed = false;
    private currentPacketIndex = 0;
    private decoder: NativeVideoDecoderPort | null = null;
    private raslSkipped = false;

    public constructor(
        private readonly config: VideoDecoderConfig,
        private readonly inputFormat: HEVCNALFormat,
        private readonly callbacks: OwnedNativeHEVCVideoDecoderCallbacks,
        private readonly dependencies: OwnedNativeHEVCVideoDecoderDependencies = DEFAULT_DEPENDENCIES
    ) {}

    /** Creates and configures the native decoder exactly once. */
    public async init(): Promise<void> {
        if (this.closed) {
            throw new Error('The owned native HEVC decoder is closed');
        }
        if (this.decoder) {
            throw new Error('The owned native HEVC decoder is already initialized');
        }

        const decoder = this.dependencies.createDecoder({
            error: (error: DOMException): void => this.callbacks.onError(error),
            output: (frame: VideoFrame): void => this.handleOutput(frame)
        });
        decoder.ondequeue = (): void => this.callbacks.onProgress();
        try {
            decoder.configure(this.config);
        } catch (error) {
            decoder.ondequeue = null;
            decoder.close();
            throw error;
        }
        if (this.closed) {
            decoder.ondequeue = null;
            decoder.close();
            return;
        }
        this.decoder = decoder;
    }

    /** Queues one cleaned base-layer packet or deliberately drops leading RASL. */
    public decode(packet: EncodedPacket): boolean {
        const decoder = this.requireDecoder();
        if (this.currentPacketIndex > 0 && !this.raslSkipped) {
            if (hasHEVCRASLPicture(packet.data, this.inputFormat)) {
                return false;
            }
            this.raslSkipped = true;
        }

        let decodedPacket = packet;
        if (this.currentPacketIndex === 0) {
            const sanitizedData = sanitizeHEVCAccessUnitForChromium(
                packet.data,
                this.inputFormat
            );
            if (sanitizedData?.byteLength === 0) {
                return false;
            }
            if (sanitizedData) {
                decodedPacket = packet.clone({ data: sanitizedData });
            }
        }

        decoder.decode(this.dependencies.createEncodedVideoChunk(decodedPacket));
        this.currentPacketIndex += 1;
        return true;
    }

    /** Flushes all native output and resets random-access packet state. */
    public async flush(): Promise<void> {
        await this.requireDecoder().flush();
        this.currentPacketIndex = 0;
        this.raslSkipped = false;
    }

    public getDecodeQueueSize(): number {
        return this.decoder?.decodeQueueSize ?? 0;
    }

    /** Closes the decoder exactly once and rejects later callbacks. */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const decoder = this.decoder;
        this.decoder = null;
        if (!decoder) {
            return;
        }
        decoder.ondequeue = null;
        decoder.close();
    }

    private handleOutput(frame: VideoFrame): void {
        if (this.closed) {
            frame.close();
            return;
        }

        let ownedFrame: VideoFrame | null = frame;
        try {
            this.callbacks.onFrame(ownedFrame);
            ownedFrame = null;
        } catch (error) {
            ownedFrame?.close();
            this.callbacks.onError(error);
        } finally {
            this.callbacks.onProgress();
        }
    }

    private requireDecoder(): NativeVideoDecoderPort {
        if (this.closed) {
            throw new Error('The owned native HEVC decoder is closed');
        }
        if (!this.decoder) {
            throw new Error('The owned native HEVC decoder is not initialized');
        }
        return this.decoder;
    }
}
