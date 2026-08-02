import { EncodedPacket } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import DolbyVisionEncodedMetadataQueue, {
    MAXIMUM_DOLBY_VISION_PENDING_FRAME_COUNT
} from './DolbyVisionEncodedMetadata';
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from './DolbyVisionRPUParser';

function createRPUParser(): {
    parse: ReturnType<typeof vi.fn>
} {
    return {
        parse: vi.fn(async (): Promise<ArrayBuffer> => (
            new ArrayBuffer(DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH)
        ))
    };
}

function createNALUnit(type: number, payload: readonly number[]): Uint8Array {
    return new Uint8Array([ (type & 0x3F) << 1, 1, ...payload ]);
}

function encodeAnnexBNALUnits(nalUnits: readonly Uint8Array[]): Uint8Array {
    const startCode = new Uint8Array([ 0, 0, 0, 1 ]);
    const byteLength = nalUnits.reduce(
        (totalByteLength: number, nalUnit: Uint8Array): number => (
            totalByteLength + startCode.byteLength + nalUnit.byteLength
        ),
        0
    );
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const nalUnit of nalUnits) {
        output.set(startCode, offset);
        offset += startCode.byteLength;
        output.set(nalUnit, offset);
        offset += nalUnit.byteLength;
    }
    return output;
}

function getAnnexBNALUnitTypes(data: Uint8Array): number[] {
    const types: number[] = [];
    for (let offset = 0; offset < data.byteLength;) {
        expect(Array.from(data.subarray(offset, offset + 4))).toEqual([ 0, 0, 0, 1 ]);
        const nalUnitOffset = offset + 4;
        types.push((data[nalUnitOffset] >> 1) & 0x3F);
        let nextOffset = nalUnitOffset + 2;
        while (
            nextOffset + 4 <= data.byteLength
            && !(data[nextOffset] === 0
                && data[nextOffset + 1] === 0
                && data[nextOffset + 2] === 0
                && data[nextOffset + 3] === 1)
        ) {
            nextOffset += 1;
        }
        offset = nextOffset + 4 <= data.byteLength ? nextOffset : data.byteLength;
    }
    return types;
}

function createPacket(
    data: Uint8Array,
    timestampSeconds: number,
    sequenceNumber = 1
): EncodedPacket {
    return new EncodedPacket(data, 'key', timestampSeconds, 1 / 24, sequenceNumber);
}

describe('DolbyVisionEncodedMetadataQueue', () => {
    it('strips RPU and EL NAL units while retaining owned metadata by integer PTS', async () => {
        const basePicture = createNALUnit(19, [ 1, 2, 3 ]);
        const rpu = createNALUnit(62, [ 25, 8, 9, 10 ]);
        const enhancementPicture = createNALUnit(1, [ 4, 5, 6 ]);
        const enhancementWrapper = createNALUnit(63, Array.from(enhancementPicture));
        const packetData = encodeAnnexBNALUnits([
            rpu,
            basePicture,
            enhancementWrapper
        ]);
        const rpuParser = createRPUParser();
        const queue = new DolbyVisionEncodedMetadataQueue({ kind: 'annex-b' }, rpuParser);

        const processedPacket = await queue.processPacket(createPacket(packetData, 1.25, 7));
        packetData.fill(0);

        expect(processedPacket.hasBaseLayerVCL).toBe(true);
        expect(processedPacket.baseLayerPacket?.sequenceNumber).toBe(7);
        expect(getAnnexBNALUnitTypes(
            processedPacket.baseLayerPacket?.data ?? new Uint8Array()
        )).toEqual([ 19 ]);
        const metadata = queue.takeFrameMetadata(1_250_000);
        expect(metadata?.rpuNALUnits).toEqual([ rpu ]);
        expect(metadata?.parsedRPUData).toHaveLength(1);
        expect(rpuParser.parse).toHaveBeenCalledWith(rpu);
        expect(getAnnexBNALUnitTypes(
            metadata?.enhancementLayerData ?? new Uint8Array()
        )).toEqual([ 1 ]);
        expect(metadata?.hasEnhancementLayerVCL).toBe(true);
        queue.requireDrained();
    });

    it('tracks ordinary HEVC pictures without manufacturing Dolby Vision data', async () => {
        const rpuParser = createRPUParser();
        const queue = new DolbyVisionEncodedMetadataQueue({ kind: 'annex-b' }, rpuParser);
        const basePicture = createNALUnit(1, [ 1 ]);

        await queue.processPacket(createPacket(encodeAnnexBNALUnits([ basePicture ]), 2));

        expect(queue.takeFrameMetadata(2_000_000)).toBeNull();
        expect(rpuParser.parse).not.toHaveBeenCalled();
        queue.requireDrained();
    });

    it('preserves decode-order entries that share a presentation timestamp', async () => {
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            createRPUParser()
        );
        const firstRPU = createNALUnit(62, [ 1 ]);
        const secondRPU = createNALUnit(62, [ 2 ]);
        const basePicture = createNALUnit(1, [ 3 ]);

        await queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ firstRPU, basePicture ]),
            3,
            1
        ));
        await queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ secondRPU, basePicture ]),
            3,
            2
        ));

        expect(queue.takeFrameMetadata(3_000_000)?.rpuNALUnits).toEqual([ firstRPU ]);
        expect(queue.takeFrameMetadata(3_000_000)?.rpuNALUnits).toEqual([ secondRPU ]);
        queue.requireDrained();
    });

    it('rejects unpaired metadata and mismatched decoder output', async () => {
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            createRPUParser()
        );
        const rpu = createNALUnit(62, [ 1 ]);

        await expect(queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ rpu ]),
            4
        ))).rejects.toThrow('not paired with a base-layer picture');
        expect(() => queue.takeFrameMetadata(4_000_000)).toThrow(
            'no matching encoded packet metadata'
        );
    });

    it('does not enqueue a frame when RPU parsing fails', async () => {
        const parseFailure = new Error('RPU parse failed');
        const rpuParser = createRPUParser();
        rpuParser.parse.mockRejectedValue(parseFailure);
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            rpuParser
        );
        const rpu = createNALUnit(62, [ 1 ]);
        const basePicture = createNALUnit(1, [ 2 ]);

        await expect(queue.processPacket(createPacket(
            encodeAnnexBNALUnits([ rpu, basePicture ]),
            5
        ))).rejects.toBe(parseFailure);
        expect(() => queue.takeFrameMetadata(5_000_000)).toThrow(
            'no matching encoded packet metadata'
        );
        queue.requireDrained();
    });

    it('bounds pending metadata even when access units contain no DV bytes', async () => {
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            createRPUParser()
        );
        const basePicture = createNALUnit(1, [ 1 ]);
        const packetData = encodeAnnexBNALUnits([ basePicture ]);
        for (
            let packetIndex = 0;
            packetIndex < MAXIMUM_DOLBY_VISION_PENDING_FRAME_COUNT;
            packetIndex += 1
        ) {
            await queue.processPacket(createPacket(
                packetData,
                packetIndex / 24,
                packetIndex
            ));
        }

        await expect(queue.processPacket(createPacket(packetData, 10, 100))).rejects.toThrow(
            'frame window exceeded its bound'
        );
        queue.clear();
        queue.requireDrained();
    });
});
