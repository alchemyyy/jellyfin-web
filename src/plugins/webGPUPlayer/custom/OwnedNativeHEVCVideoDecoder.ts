import type { EncodedPacket } from 'mediabunny';

import {
    hasHEVCRASLPicture,
    rewriteHEVCAccessUnitColorDescriptionToBT709,
    sanitizeHEVCAccessUnitForChromium,
    type HEVCNALFormat
} from './DolbyVisionHEVCSplitter';
import { neutralizeNativeHDRHEVCDecoderConfig } from './NativeHDRHEVCColorNeutralizer';
import type { HEVCHDRTransfer } from './HEVCSPSParser';

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

export type OwnedNativeHEVCVideoDecoderOptions = {
    nativeHDRTransfer?: HEVCHDRTransfer
    neutralizeHDRColorMetadata?: boolean
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
    private nativeHDRColorDescriptionValidated = false;
    private raslSkipped = false;

    public constructor(
        private readonly config: VideoDecoderConfig,
        private readonly inputFormat: HEVCNALFormat,
        private readonly callbacks: OwnedNativeHEVCVideoDecoderCallbacks,
        private readonly dependencies: OwnedNativeHEVCVideoDecoderDependencies = DEFAULT_DEPENDENCIES,
        private readonly options: OwnedNativeHEVCVideoDecoderOptions = {}
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
            const neutralizeHDRColorMetadata =
                this.options.neutralizeHDRColorMetadata === true;
            decoder.configure(neutralizeHDRColorMetadata ?
                neutralizeNativeHDRHEVCDecoderConfig(
                    this.config,
                    this.requireNativeHDRTransfer()
                ) :
                this.config);
            this.nativeHDRColorDescriptionValidated = neutralizeHDRColorMetadata
                && this.config.description !== undefined;
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

        let decodedPacketData = packet.data;
        if (this.currentPacketIndex === 0) {
            const sanitizedData = sanitizeHEVCAccessUnitForChromium(
                decodedPacketData,
                this.inputFormat
            );
            if (sanitizedData?.byteLength === 0) {
                return false;
            }
            if (sanitizedData) {
                decodedPacketData = sanitizedData;
            }
        }

        decodedPacketData = this.neutralizeHDRPacketData(packet, decodedPacketData);

        const decodedPacket = decodedPacketData === packet.data ?
            packet :
            packet.clone({ data: decodedPacketData });

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

    private requireNativeHDRTransfer(): HEVCHDRTransfer {
        const transfer = this.options.nativeHDRTransfer;
        if (transfer !== 'hlg' && transfer !== 'pq') {
            throw new TypeError('Native HDR color neutralization requires an exact HDR transfer');
        }
        return transfer;
    }

    private neutralizeHDRPacketData(
        packet: EncodedPacket,
        packetData: Uint8Array
    ): Uint8Array {
        if (this.options.neutralizeHDRColorMetadata !== true) {
            return packetData;
        }
        if (packet.type === 'key') {
            const neutralizedData = rewriteHEVCAccessUnitColorDescriptionToBT709(
                packetData,
                this.inputFormat,
                this.requireNativeHDRTransfer()
            );
            if (neutralizedData) {
                this.nativeHDRColorDescriptionValidated = true;
                return neutralizedData;
            }
        }
        if (!this.nativeHDRColorDescriptionValidated) {
            throw new TypeError(
                'Native HDR color neutralization requires a validated HEVC SPS'
            );
        }
        return packetData;
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
