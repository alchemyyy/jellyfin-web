import type { EncodedPacket } from 'mediabunny';

import { DOLBY_VISION_FRAME_PAIR_TOLERANCE_MICROSECONDS } from './DolbyVisionFramePairQueue';
import { requireMicroseconds } from './TimeMath';

export type DolbyVisionEncodedPacketIterator = {
    next: () => Promise<IteratorResult<EncodedPacket>>
    return?: () => Promise<IteratorResult<EncodedPacket>>
};

/** Aligns a bounded forward-only EL packet stream to monotonically ordered BL PTS. */
export default class DolbyVisionEncodedPacketPairer {
    private ended = false;
    private retirementPromise: Promise<void> | null = null;

    public constructor(public readonly iterator: DolbyVisionEncodedPacketIterator) {}

    /** Returns whether iterator retirement has started. */
    public get retired(): boolean {
        return this.retirementPromise !== null;
    }

    /** Takes the next decode-order EL packet and verifies its BL PTS. */
    public async takeMatchingPacket(
        baseTimestampMicrosecondsValue: number
    ): Promise<EncodedPacket | null> {
        const baseTimestampMicroseconds = requireMicroseconds(
            baseTimestampMicrosecondsValue,
            'Dolby Vision base packet timestamp'
        );
        if (this.ended) {
            return null;
        }
        const iteratorResult = await this.iterator.next();
        if (iteratorResult.done) {
            this.ended = true;
            return null;
        }
        const enhancementTimestampMicroseconds = requireMicroseconds(
            iteratorResult.value.microsecondTimestamp,
            'Dolby Vision enhancement packet timestamp'
        );
        if (Math.abs(enhancementTimestampMicroseconds - baseTimestampMicroseconds)
            > DOLBY_VISION_FRAME_PAIR_TOLERANCE_MICROSECONDS) {
            throw new RangeError(
                'Separate Dolby Vision packets are not aligned in decode order'
            );
        }
        return iteratorResult.value;
    }

    /** Retires the iterator exactly once and releases its retained future packet. */
    public retire(): Promise<void> {
        if (this.retirementPromise) {
            return this.retirementPromise;
        }
        this.ended = true;
        this.retirementPromise = this.retireIterator();
        return this.retirementPromise;
    }

    private async retireIterator(): Promise<void> {
        try {
            await this.iterator.return?.();
        } catch {
            // Input disposal remains the authoritative cancellation signal
        }
    }
}
