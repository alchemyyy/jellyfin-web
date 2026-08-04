// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { EncodedPacket } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import DolbyVisionEncodedMetadataQueue from './DolbyVisionEncodedMetadata';
import {
    getDolbyVisionEncodedMetadataTransferList,
    isTransferableDolbyVisionEncodedFrameMetadata,
    takeTransferableDolbyVisionEncodedFrameMetadata
} from './DolbyVisionEncodedMetadataProtocol';
import DolbyVisionRPUParser, {
    decodeDolbyVisionRPUSnapshot
} from './DolbyVisionRPUParser';
import DolbyVisionRPUParserSession from './DolbyVisionRPUParserSession';

const PARSER_DIRECTORY = resolve(
    process.cwd(),
    'scripts/webgpu/dolby-vision-parser'
);
const PARSER_WASM_BYTES = new Uint8Array(readFileSync(resolve(
    PARSER_DIRECTORY,
    'artifacts/dovi-rpu-parser.wasm'
)));

function encodeAnnexBNALUnits(nalUnits: readonly Uint8Array[]): Uint8Array {
    const startCode = new Uint8Array([ 0, 0, 0, 1 ]);
    const byteLength = nalUnits.reduce(
        (totalByteLength: number, nalUnit: Uint8Array): number => (
            totalByteLength + startCode.byteLength + nalUnit.byteLength
        ),
        0
    );
    const output = new Uint8Array(byteLength);
    let byteOffset = 0;
    for (const nalUnit of nalUnits) {
        output.set(startCode, byteOffset);
        byteOffset += startCode.byteLength;
        output.set(nalUnit, byteOffset);
        byteOffset += nalUnit.byteLength;
    }
    return output;
}

async function createActualParser(): Promise<DolbyVisionRPUParser> {
    return DolbyVisionRPUParser.create('local-parser.wasm', {
        loadInstance: async (): Promise<WebAssembly.Instance> => {
            const result = await WebAssembly.instantiate(PARSER_WASM_BYTES, {});
            return result.instance;
        }
    });
}

describe('Dolby Vision metadata integration', () => {
    it('parses an RPU before BL decode and transfers its exact PTS snapshot', async () => {
        const fixture = new Uint8Array(readFileSync(resolve(
            PARSER_DIRECTORY,
            'fixtures/profile8.bin'
        )));
        const rpuNALUnit = new Uint8Array(2 + fixture.byteLength - 4);
        rpuNALUnit.set([ 0x7C, 0x01 ]);
        rpuNALUnit.set(fixture.subarray(4), 2);
        const baseLayerNALUnit = new Uint8Array([ 19 << 1, 1, 7, 8, 9 ]);
        const parserSession = DolbyVisionRPUParserSession.create('local-parser.wasm', {
            createParser: createActualParser
        });
        const queue = new DolbyVisionEncodedMetadataQueue(
            { kind: 'annex-b' },
            parserSession
        );
        const packet = new EncodedPacket(
            encodeAnnexBNALUnits([ rpuNALUnit, baseLayerNALUnit ]),
            'key',
            1.25,
            1 / 24,
            7
        );

        try {
            const processedPacket = await queue.processPacket(packet);
            expect(processedPacket.hasBaseLayerVCL).toBe(true);
            const metadata = queue.takeFrameMetadata(1_250_000);
            expect(metadata?.parsedRPUData).toHaveLength(1);
            expect(decodeDolbyVisionRPUSnapshot(
                metadata?.parsedRPUData[0] ?? new ArrayBuffer(0)
            )).toMatchObject({
                profile: 8,
                sourceMaximumPQ: 3_696,
                sourceMinimumPQ: 62
            });

            const transferable = takeTransferableDolbyVisionEncodedFrameMetadata(metadata);
            expect(isTransferableDolbyVisionEncodedFrameMetadata(transferable)).toBe(true);
            expect(getDolbyVisionEncodedMetadataTransferList(transferable)).toHaveLength(1);
            queue.requireDrained();
        } finally {
            queue.clear();
            parserSession.close();
        }
    });
});
