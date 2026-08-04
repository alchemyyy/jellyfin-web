import { EncodedPacket } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import DolbyVisionEncodedPacketPairer, {
    type DolbyVisionEncodedPacketIterator
} from './DolbyVisionEncodedPacketPairer';

function createPacket(timestampSeconds: number, sequenceNumber: number): EncodedPacket {
    return new EncodedPacket(
        new Uint8Array([ sequenceNumber ]),
        'key',
        timestampSeconds,
        1 / 24,
        sequenceNumber
    );
}

function createIterator(packets: readonly EncodedPacket[]): {
    iterator: DolbyVisionEncodedPacketIterator
    iteratorReturn: ReturnType<typeof vi.fn>
} {
    let packetIndex = 0;
    const iteratorReturn = vi.fn(async (): Promise<IteratorResult<EncodedPacket>> => ({
        done: true,
        value: undefined
    }));
    return {
        iterator: {
            next: vi.fn(async (): Promise<IteratorResult<EncodedPacket>> => {
                const packet = packets[packetIndex];
                packetIndex += 1;
                return packet ?
                    { done: false, value: packet } :
                    { done: true, value: undefined };
            }),
            return: iteratorReturn
        },
        iteratorReturn
    };
}

describe('DolbyVisionEncodedPacketPairer', () => {
    it('pairs exact and one-microsecond timestamps in decode order', async () => {
        const firstPacket = createPacket(2, 1);
        const secondPacket = createPacket(1.000_001, 2);
        const { iterator } = createIterator([ firstPacket, secondPacket ]);
        const pairer = new DolbyVisionEncodedPacketPairer(iterator);

        await expect(pairer.takeMatchingPacket(2_000_000)).resolves.toBe(firstPacket);
        await expect(pairer.takeMatchingPacket(1_000_000)).resolves.toBe(secondPacket);
    });

    it('rejects a decode-order packet with a mismatched PTS', async () => {
        const { iterator } = createIterator([ createPacket(0.5, 1) ]);
        const pairer = new DolbyVisionEncodedPacketPairer(iterator);

        await expect(pairer.takeMatchingPacket(1_000_000)).rejects.toThrow(
            'not aligned in decode order'
        );
    });

    it('returns null after enhancement EOF', async () => {
        const { iterator } = createIterator([]);
        const pairer = new DolbyVisionEncodedPacketPairer(iterator);

        await expect(pairer.takeMatchingPacket(1_000_000)).resolves.toBeNull();
        await expect(pairer.takeMatchingPacket(2_000_000)).resolves.toBeNull();
    });

    it('retires its iterator exactly once', async () => {
        const { iterator, iteratorReturn } = createIterator([ createPacket(1, 1) ]);
        const pairer = new DolbyVisionEncodedPacketPairer(iterator);

        await pairer.retire();
        await pairer.retire();

        expect(iteratorReturn).toHaveBeenCalledTimes(1);
        await expect(pairer.takeMatchingPacket(1_000_000)).resolves.toBeNull();
    });
});
