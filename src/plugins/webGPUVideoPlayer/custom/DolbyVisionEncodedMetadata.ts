import { EncodedPacket } from 'mediabunny';

import { requireMicroseconds } from './TimeMath';
import {
    DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION,
    MAXIMUM_DOLBY_VISION_ENHANCEMENT_ACCESS_UNIT_BYTE_LENGTH,
    MAXIMUM_DOLBY_VISION_RPU_FRAME_BYTE_LENGTH,
    MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_BYTE_LENGTH,
    MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_COUNT,
    type DolbyVisionEncodedFrameMetadata
} from './DolbyVisionEncodedMetadataProtocol';
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from './DolbyVisionRPUParser';
import {
    splitDolbyVisionHEVCAccessUnit,
    type HEVCNALFormat
} from './DolbyVisionHEVCSplitter';
import { parseHEVCDecoderConfiguration } from './HEVCSoftwareVideoDecoder';

export const MAXIMUM_DOLBY_VISION_PENDING_FRAME_COUNT = 64;
export const MAXIMUM_DOLBY_VISION_PENDING_METADATA_BYTE_LENGTH = 64 * 1_024 * 1_024;

export type ProcessedDolbyVisionHEVCPacket = {
    baseLayerPacket: EncodedPacket | null
    hasBaseLayerVCL: boolean
};

export type DolbyVisionRPUDataParser = {
    parse: (rpuNALUnit: Uint8Array) => Promise<ArrayBuffer>
};

type PendingFrameMetadata = {
    byteLength: number
    metadata: DolbyVisionEncodedFrameMetadata | null
};

function toUint8Array(data: AllowSharedBufferSource): Uint8Array {
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    throw new TypeError('The HEVC decoder description is not a buffer source');
}

/** Resolves whether encoded HEVC access units use HVCC lengths or Annex B. */
export function getHEVCNALFormat(decoderConfig: VideoDecoderConfig): HEVCNALFormat {
    if (decoderConfig.description === undefined) {
        return { kind: 'annex-b' };
    }

    const decoderConfiguration = parseHEVCDecoderConfiguration(
        toUint8Array(decoderConfig.description)
    );
    return {
        kind: 'length-prefixed',
        lengthSize: decoderConfiguration.lengthSize
    };
}

function getMetadataByteLength(
    rpuNALUnits: readonly Uint8Array[],
    parsedRPUData: readonly ArrayBuffer[],
    enhancementLayerData: Uint8Array | null
): number {
    if (rpuNALUnits.length > MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_COUNT) {
        throw new TypeError('A Dolby Vision frame contains too many RPU NAL units');
    }

    let rpuByteLength = 0;
    for (const rpuNALUnit of rpuNALUnits) {
        if (
            rpuNALUnit.byteLength === 0
            || rpuNALUnit.byteLength > MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_BYTE_LENGTH
        ) {
            throw new TypeError('A Dolby Vision RPU NAL unit exceeds its size bound');
        }
        rpuByteLength += rpuNALUnit.byteLength;
    }
    if (rpuByteLength > MAXIMUM_DOLBY_VISION_RPU_FRAME_BYTE_LENGTH) {
        throw new TypeError('Dolby Vision RPU data exceeds its per-frame size bound');
    }
    if (parsedRPUData.length !== rpuNALUnits.length
        || parsedRPUData.some(data => data.byteLength !== DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH)) {
        throw new TypeError('Parsed Dolby Vision RPU data does not match its encoded frame');
    }

    const enhancementLayerByteLength = enhancementLayerData?.byteLength ?? 0;
    if (enhancementLayerByteLength > MAXIMUM_DOLBY_VISION_ENHANCEMENT_ACCESS_UNIT_BYTE_LENGTH) {
        throw new TypeError('A Dolby Vision enhancement access unit exceeds its size bound');
    }
    return rpuByteLength
        + (parsedRPUData.length * DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH)
        + enhancementLayerByteLength;
}

/** Owns split HEVC metadata until the decoder emits the matching frame PTS. */
export default class DolbyVisionEncodedMetadataQueue {
    private pendingByteLength = 0;
    private pendingFrameCount = 0;
    private readonly pendingFrames = new Map<number, PendingFrameMetadata[]>();

    public constructor(
        private readonly inputFormat: HEVCNALFormat,
        private readonly rpuParser: DolbyVisionRPUDataParser
    ) {}

    /** Removes DV NAL units from one packet and records bounded frame metadata. */
    public async processPacket(packet: EncodedPacket): Promise<ProcessedDolbyVisionHEVCPacket> {
        const timestampMicroseconds = requireMicroseconds(
            packet.microsecondTimestamp,
            'Encoded HEVC packet timestamp'
        );
        const splitResult = splitDolbyVisionHEVCAccessUnit(packet.data, this.inputFormat);
        const hasDolbyVisionData = splitResult.rpuNALUnits.length > 0
            || splitResult.enhancementLayerData !== null;
        if (hasDolbyVisionData && !splitResult.hasBaseLayerVCL) {
            throw new TypeError('Dolby Vision metadata is not paired with a base-layer picture');
        }

        const parsedRPUData: ArrayBuffer[] = [];
        for (const rpuNALUnit of splitResult.rpuNALUnits) {
            parsedRPUData.push(await this.rpuParser.parse(rpuNALUnit));
        }

        if (splitResult.hasBaseLayerVCL) {
            const metadataByteLength = getMetadataByteLength(
                splitResult.rpuNALUnits,
                parsedRPUData,
                splitResult.enhancementLayerData
            );
            this.enqueueFrame(timestampMicroseconds, {
                byteLength: metadataByteLength,
                metadata: hasDolbyVisionData ? {
                    enhancementLayerData: splitResult.enhancementLayerData,
                    hasEnhancementLayerVCL: splitResult.hasEnhancementLayerVCL,
                    parsedRPUData,
                    rpuNALUnits: splitResult.rpuNALUnits,
                    schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
                } : null
            });
        }

        return {
            baseLayerPacket: splitResult.baseLayerData ?
                packet.clone({ data: splitResult.baseLayerData }) :
                null,
            hasBaseLayerVCL: splitResult.hasBaseLayerVCL
        };
    }

    /** Takes the unique metadata entry associated with one decoded frame. */
    public takeFrameMetadata(
        timestampMicrosecondsValue: number
    ): DolbyVisionEncodedFrameMetadata | null {
        const timestampMicroseconds = requireMicroseconds(
            timestampMicrosecondsValue,
            'Decoded HEVC frame timestamp'
        );
        const frames = this.pendingFrames.get(timestampMicroseconds);
        if (!frames || frames.length === 0) {
            throw new Error('A decoded HEVC frame has no matching encoded packet metadata');
        }

        const pendingFrame = frames.shift() as PendingFrameMetadata;
        if (frames.length === 0) {
            this.pendingFrames.delete(timestampMicroseconds);
        }
        this.pendingFrameCount -= 1;
        this.pendingByteLength -= pendingFrame.byteLength;
        return pendingFrame.metadata;
    }

    /** Rejects decoder packet loss instead of attaching stale RPU data later. */
    public requireDrained(): void {
        if (this.pendingFrameCount !== 0 || this.pendingByteLength !== 0) {
            throw new Error('The HEVC decoder ended before every metadata entry was matched');
        }
    }

    /** Discards all generation-owned encoded metadata. */
    public clear(): void {
        this.pendingFrames.clear();
        this.pendingFrameCount = 0;
        this.pendingByteLength = 0;
    }

    private enqueueFrame(
        timestampMicroseconds: number,
        pendingFrame: PendingFrameMetadata
    ): void {
        if (this.pendingFrameCount >= MAXIMUM_DOLBY_VISION_PENDING_FRAME_COUNT) {
            throw new Error('The Dolby Vision metadata frame window exceeded its bound');
        }
        if (
            this.pendingByteLength + pendingFrame.byteLength
            > MAXIMUM_DOLBY_VISION_PENDING_METADATA_BYTE_LENGTH
        ) {
            throw new Error('The Dolby Vision metadata byte window exceeded its bound');
        }

        const frames = this.pendingFrames.get(timestampMicroseconds) ?? [];
        if (!this.pendingFrames.has(timestampMicroseconds)) {
            this.pendingFrames.set(timestampMicroseconds, frames);
        }
        frames.push(pendingFrame);
        this.pendingFrameCount += 1;
        this.pendingByteLength += pendingFrame.byteLength;
    }
}
