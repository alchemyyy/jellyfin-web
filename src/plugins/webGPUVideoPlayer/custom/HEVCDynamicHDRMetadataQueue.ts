import type { EncodedPacket } from 'mediabunny';

import {
    parseHEVCNALUnits,
    type HEVCNALFormat
} from './DolbyVisionHEVCSplitter';
import {
    parseHEVCHDR10PlusMetadata,
    type HDR10PlusFrameMetadata
} from './HDR10PlusMetadata';
import { requireMicroseconds } from './TimeMath';

export const MAXIMUM_PENDING_DYNAMIC_HDR_FRAME_COUNT = 64;

/** Associates per-access-unit HDR10+ metadata with reordered decoded frames. */
export default class HEVCDynamicHDRMetadataQueue {
    private pendingFrameCount = 0;
    private readonly pendingFrames = new Map<number, HDR10PlusFrameMetadata[]>();

    public constructor(private readonly inputFormat: HEVCNALFormat) {}

    /** Parses and queues metadata when an encoded packet contains a picture. */
    public processPacket(packet: EncodedPacket): boolean {
        const hasVCL = parseHEVCNALUnits(packet.data, this.inputFormat).some(
            (nalUnit): boolean => nalUnit.type <= 31
        );
        if (!hasVCL) {
            return false;
        }
        const timestampMicroseconds = requireMicroseconds(
            packet.microsecondTimestamp,
            'Encoded HEVC dynamic HDR packet timestamp'
        );
        if (this.pendingFrameCount >= MAXIMUM_PENDING_DYNAMIC_HDR_FRAME_COUNT) {
            throw new Error('The dynamic HDR metadata frame window exceeded its bound');
        }
        const frames = this.pendingFrames.get(timestampMicroseconds) ?? [];
        if (!this.pendingFrames.has(timestampMicroseconds)) {
            this.pendingFrames.set(timestampMicroseconds, frames);
        }
        frames.push(parseHEVCHDR10PlusMetadata(packet.data, this.inputFormat));
        this.pendingFrameCount += 1;
        return true;
    }

    /** Takes the unique dynamic metadata state for one decoded frame timestamp. */
    public takeFrameMetadata(timestampMicrosecondsValue: number): HDR10PlusFrameMetadata {
        const timestampMicroseconds = requireMicroseconds(
            timestampMicrosecondsValue,
            'Decoded HEVC dynamic HDR frame timestamp'
        );
        const frames = this.pendingFrames.get(timestampMicroseconds);
        if (!frames || frames.length === 0) {
            throw new Error('A decoded HEVC frame has no matching dynamic HDR metadata state');
        }
        const metadata = frames.shift() as HDR10PlusFrameMetadata;
        if (frames.length === 0) {
            this.pendingFrames.delete(timestampMicroseconds);
        }
        this.pendingFrameCount -= 1;
        return metadata;
    }

    /** Rejects decoder packet loss instead of attaching stale frame metadata. */
    public requireDrained(): void {
        if (this.pendingFrameCount !== 0) {
            throw new Error('The HEVC decoder ended before dynamic HDR metadata was matched');
        }
    }

    /** Discards all generation-owned metadata on stop, source change, or seek. */
    public clear(): void {
        this.pendingFrames.clear();
        this.pendingFrameCount = 0;
    }
}
