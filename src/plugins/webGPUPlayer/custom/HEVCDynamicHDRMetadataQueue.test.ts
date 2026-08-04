import { EncodedPacket } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { createHDR10PlusHEVCFixture } from '../validation/HDR10PlusFixture';
import HEVCDynamicHDRMetadataQueue, {
    MAXIMUM_PENDING_DYNAMIC_HDR_FRAME_COUNT
} from './HEVCDynamicHDRMetadataQueue';

function createPacket(
    kind: Parameters<typeof createHDR10PlusHEVCFixture>[0],
    index: number
): EncodedPacket {
    return new EncodedPacket(
        createHDR10PlusHEVCFixture(kind),
        index === 0 ? 'key' : 'delta',
        index / 24,
        1 / 24,
        index
    );
}

describe('HEVCDynamicHDRMetadataQueue', () => {
    it('matches valid, absent, and malformed states to reordered decoded timestamps', () => {
        const queue = new HEVCDynamicHDRMetadataQueue({ kind: 'annex-b' });
        const validPacket = createPacket('valid', 0);
        const absentPacket = createPacket('absent', 1);
        const malformedPacket = createPacket('malformed', 2);
        queue.processPacket(validPacket);
        queue.processPacket(absentPacket);
        queue.processPacket(malformedPacket);

        expect(queue.takeFrameMetadata(absentPacket.microsecondTimestamp).status)
            .toBe('absent');
        expect(queue.takeFrameMetadata(validPacket.microsecondTimestamp).status)
            .toBe('valid');
        expect(queue.takeFrameMetadata(malformedPacket.microsecondTimestamp).status)
            .toBe('malformed');
        expect(() => queue.requireDrained()).not.toThrow();
    });

    it('clears generation-owned states so a seek cannot reuse stale metadata', () => {
        const queue = new HEVCDynamicHDRMetadataQueue({ kind: 'annex-b' });
        queue.processPacket(createPacket('valid', 0));
        queue.clear();
        queue.processPacket(createPacket('absent', 0));

        expect(queue.takeFrameMetadata(0)).toEqual({
            metadata: null,
            status: 'absent'
        });
        expect(() => queue.requireDrained()).not.toThrow();
    });

    it('bounds pending metadata and detects unmatched decoder output', () => {
        const queue = new HEVCDynamicHDRMetadataQueue({ kind: 'annex-b' });
        for (let frameIndex = 0; frameIndex < MAXIMUM_PENDING_DYNAMIC_HDR_FRAME_COUNT;
            frameIndex += 1) {
            queue.processPacket(createPacket('absent', frameIndex));
        }
        expect(() => queue.processPacket(createPacket(
            'absent',
            MAXIMUM_PENDING_DYNAMIC_HDR_FRAME_COUNT
        ))).toThrow('exceeded its bound');
        expect(() => queue.requireDrained()).toThrow('before dynamic HDR metadata was matched');
        expect(() => queue.takeFrameMetadata(10_000_000)).toThrow('no matching');
    });
});
