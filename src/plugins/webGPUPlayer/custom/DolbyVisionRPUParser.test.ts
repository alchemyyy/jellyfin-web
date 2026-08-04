// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import DolbyVisionRPUParser, {
    decodeDolbyVisionRPUSnapshot,
    DOLBY_VISION_RPU_PARSER_REVISION_PREFIX,
    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
    DOLBY_VISION_RPU_SCHEMA_VERSION,
    DolbyVisionRPUParseError,
    MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH,
    MAXIMUM_DOLBY_VISION_RPU_PARSER_MEMORY_BYTE_LENGTH,
    resolveDolbyVisionRPUParserWASMURL,
    type DolbyVisionRPUParserDependencies,
    type DolbyVisionRPULayerMode
} from './DolbyVisionRPUParser';

const PARSER_DIRECTORY = resolve(
    process.cwd(),
    'scripts/webgpu/dolby-vision-parser'
);
const PARSER_WASM_PATH = resolve(
    PARSER_DIRECTORY,
    'artifacts/dovi-rpu-parser.wasm'
);
const PARSER_WASM_BYTES = new Uint8Array(readFileSync(PARSER_WASM_PATH));
const WASM_PAGE_BYTE_LENGTH = 64 * 1_024;

describe('Dolby Vision parser asset URL', () => {
    it('resolves the copied artifact against the active frontend directory', () => {
        expect(resolveDolbyVisionRPUParserWASMURL(
            'https://example.test/web/index.html#!/details'
        )).toBe('https://example.test/web/libraries/libdovi/dovi-rpu-parser.wasm');
    });
});

type ParserFixture = {
    componentMMRVectorCounts: readonly [number, number, number]
    componentPivotCounts: readonly [number, number, number]
    fileName: string
    layerMode: DolbyVisionRPULayerMode
    level1: readonly [number, number, number]
    profile: number
    sha256: string
    sourcePQ: readonly [number, number]
};

const PARSER_FIXTURES: readonly ParserFixture[] = [
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'profile5.bin',
        layerMode: 'single-layer',
        level1: [ 2, 3_383, 819 ],
        profile: 5,
        sha256: '0355f79fbbaac16fda35482f9eb734f4a5fd59fc90d0cbf91a7638c815060e13',
        sourcePQ: [ 62, 3_696 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 3, 2, 2 ],
        fileName: 'profile5-02.bin',
        layerMode: 'single-layer',
        level1: [ 0, 2_081, 819 ],
        profile: 5,
        sha256: '9166784ce6633ca16aa6da1fd875639d137d93cce8e9e871351a1e5edc4756b6',
        sourcePQ: [ 7, 3_079 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'profile8.bin',
        layerMode: 'single-layer',
        level1: [ 2, 3_383, 819 ],
        profile: 8,
        sha256: 'bb4d6b3923f489950010f02919d92b3880b7f527232544fc20445946cde3446b',
        sourcePQ: [ 62, 3_696 ]
    },
    {
        componentMMRVectorCounts: [ 0, 6, 6 ],
        componentPivotCounts: [ 9, 2, 2 ],
        fileName: 'profile84.bin',
        layerMode: 'single-layer',
        level1: [ 2, 3_383, 819 ],
        profile: 8,
        sha256: '499ac7b241f02c357d37d0ff918b20b34977e26d4dabc58313ca782ae602aff0',
        sourcePQ: [ 62, 3_696 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'mel_rpu.bin',
        layerMode: 'mel',
        level1: [ 0, 2_081, 1_340 ],
        profile: 7,
        sha256: '08d55bfad4555c8f797d78710127dd4552a318c0bfef93f9f2ac614371641eb4',
        sourcePQ: [ 7, 3_079 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'mel_variable_l8_length13.bin',
        layerMode: 'mel',
        level1: [ 0, 3_100, 2_048 ],
        profile: 7,
        sha256: '71e59494eec47e7f15f01ce8bf77e6e74ebbe4449d1a0d8d25cac3f195634ed1',
        sourcePQ: [ 7, 3_079 ]
    },
    {
        componentMMRVectorCounts: [ 0, 6, 6 ],
        componentPivotCounts: [ 9, 2, 2 ],
        fileName: 'fel_rpu.bin',
        layerMode: 'fel',
        level1: [ 0, 2_873, 1_060 ],
        profile: 7,
        sha256: '8d85c1be0a59e9583526714ec07cf9e9b23a2418203f80c670395a0aab829c81',
        sourcePQ: [ 7, 3_079 ]
    },
    {
        componentMMRVectorCounts: [ 0, 0, 0 ],
        componentPivotCounts: [ 2, 2, 2 ],
        fileName: 'trailing_bytes_rpu.bin',
        layerMode: 'fel',
        level1: [ 12, 2_452, 887 ],
        profile: 7,
        sha256: '3a8e16df1b283cc33c551383d678614b5e41dfcb954fc5d6f28c8850deaf76ea',
        sourcePQ: [ 62, 3_696 ]
    }
];

function readFixture(fileName: string): Uint8Array {
    return new Uint8Array(readFileSync(resolve(PARSER_DIRECTORY, 'fixtures', fileName)));
}

async function instantiateParserModule(): Promise<WebAssembly.Instance> {
    const result = await WebAssembly.instantiate(PARSER_WASM_BYTES, {});
    return result.instance;
}

const ACTUAL_PARSER_DEPENDENCIES: DolbyVisionRPUParserDependencies = {
    loadInstance: instantiateParserModule
};

async function createActualParser(): Promise<DolbyVisionRPUParser> {
    return DolbyVisionRPUParser.create('local-parser.wasm', ACTUAL_PARSER_DEPENDENCIES);
}

describe('DolbyVisionRPUParser pinned WASM integration', () => {
    it.each(PARSER_FIXTURES)(
        'packs $fileName into the stable shader schema',
        async fixture => {
            const parser = await createActualParser();
            try {
                const snapshot = parser.parse(readFixture(fixture.fileName));
                expect(snapshot).toMatchObject({
                    layerMode: fixture.layerMode,
                    level1AveragePQ: fixture.level1[2],
                    level1MaximumPQ: fixture.level1[1],
                    level1MinimumPQ: fixture.level1[0],
                    parserRevisionPrefix: DOLBY_VISION_RPU_PARSER_REVISION_PREFIX,
                    profile: fixture.profile,
                    schemaVersion: DOLBY_VISION_RPU_SCHEMA_VERSION,
                    sourceMaximumPQ: fixture.sourcePQ[1],
                    sourceMinimumPQ: fixture.sourcePQ[0]
                });
                expect(snapshot.packedData.byteLength).toBe(
                    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH
                );
                expect(snapshot.components.map(component => component.numPivots)).toEqual(
                    fixture.componentPivotCounts
                );
                expect(snapshot.components.map(component => component.mmrVectorCount)).toEqual(
                    fixture.componentMMRVectorCounts
                );
                expect(createHash('sha256')
                    .update(new Uint8Array(snapshot.packedData))
                    .digest('hex')).toBe(fixture.sha256);
            } finally {
                parser.close();
            }
        }
    );

    it('reports unsupported Profile 4 without poisoning the parser', async () => {
        const parser = await createActualParser();
        try {
            let parseError: unknown;
            try {
                parser.parse(readFixture('profile4.bin'));
            } catch (error) {
                parseError = error;
            }
            expect(parseError).toBeInstanceOf(DolbyVisionRPUParseError);
            expect(parseError).toMatchObject({
                message: 'Dolby Vision profile 4 is unsupported',
                statusCode: 4
            });
            expect(parser.parse(readFixture('profile8.bin')).profile).toBe(8);
        } finally {
            parser.close();
        }
    });

    it('matches the pinned libplacebo Profile 8.4 cumulative pivots', async () => {
        const parser = await createActualParser();
        try {
            const pivots = parser.parse(readFixture('profile84.bin')).components[0].pivots;
            const referencePivots = [
                0.0615835786,
                0.129032254,
                0.353861183,
                0.604105592,
                0.854349971,
                0.890518069,
                0.906158328,
                0.913978517,
                0.92082113
            ];
            expect(pivots).toHaveLength(referencePivots.length);
            for (let pivotIndex = 0; pivotIndex < pivots.length; pivotIndex += 1) {
                expect(pivots[pivotIndex]).toBeCloseTo(referencePivots[pivotIndex], 7);
            }
        } finally {
            parser.close();
        }
    });

    it('rejects a corrupt RPU and remains reusable', async () => {
        const parser = await createActualParser();
        const corruptRPU = readFixture('profile8.bin');
        corruptRPU[corruptRPU.byteLength - 1] ^= 1;
        try {
            expect(() => parser.parse(corruptRPU)).toThrowError(
                expect.objectContaining({ statusCode: 3 })
            );
            expect(parser.parse(readFixture('profile8.bin')).profile).toBe(8);
        } finally {
            parser.close();
        }
    });

    it('returns owned snapshots and enforces reset and close state', async () => {
        const parser = await createActualParser();
        const firstSnapshot = parser.parse(readFixture('profile5.bin'));
        const firstHash = createHash('sha256')
            .update(new Uint8Array(firstSnapshot.packedData))
            .digest('hex');

        parser.parse(readFixture('fel_rpu.bin'));
        parser.reset();
        expect(createHash('sha256')
            .update(new Uint8Array(firstSnapshot.packedData))
            .digest('hex')).toBe(firstHash);

        parser.close();
        parser.close();
        expect(() => parser.parse(readFixture('profile5.bin'))).toThrow('parser is closed');
        expect(() => parser.reset()).toThrow('parser is closed');
    });

    it('has no imports and cannot exceed its fixed memory maximum', async () => {
        const module = await WebAssembly.compile(PARSER_WASM_BYTES);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = await WebAssembly.instantiate(module, {});
        const exportsValue = instance.exports as unknown as Record<string, unknown>;
        expect(exportsValue.dovi_parser_allocate).toBeTypeOf('function');
        const allocate = exportsValue.dovi_parser_allocate as (byteLength: number) => number;
        const memory = exportsValue.memory;
        expect(memory).toBeInstanceOf(WebAssembly.Memory);
        const parserMemory = memory as WebAssembly.Memory;
        const maximumPageCount = MAXIMUM_DOLBY_VISION_RPU_PARSER_MEMORY_BYTE_LENGTH
            / WASM_PAGE_BYTE_LENGTH;
        const initialPageCount = parserMemory.buffer.byteLength / WASM_PAGE_BYTE_LENGTH;

        expect(initialPageCount).toBeGreaterThanOrEqual(64);
        expect(allocate(MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH + 1)).toBe(0);
        parserMemory.grow(maximumPageCount - initialPageCount);
        expect(parserMemory.buffer.byteLength).toBe(
            MAXIMUM_DOLBY_VISION_RPU_PARSER_MEMORY_BYTE_LENGTH
        );
        expect(() => parserMemory.grow(1)).toThrow(RangeError);
    });
});

describe('decodeDolbyVisionRPUSnapshot validation', () => {
    it('rejects incompatible headers and non-finite shader data', async () => {
        const parser = await createActualParser();
        const validPackedData = parser.parse(readFixture('profile8.bin')).packedData;
        parser.close();

        const corruptMagic = validPackedData.slice(0);
        new DataView(corruptMagic).setUint32(0, 0, true);
        expect(() => decodeDolbyVisionRPUSnapshot(corruptMagic)).toThrow(
            'snapshot header is incompatible'
        );

        const unknownFlags = validPackedData.slice(0);
        new DataView(unknownFlags).setUint32(12, 1 << 31, true);
        expect(() => decodeDolbyVisionRPUSnapshot(unknownFlags)).toThrow(
            'snapshot header is incompatible'
        );

        const nonFiniteMatrix = validPackedData.slice(0);
        new DataView(nonFiniteMatrix).setUint32(208, 0x7FC0_0000, true);
        expect(() => decodeDolbyVisionRPUSnapshot(nonFiniteMatrix)).toThrow(
            'is not finite'
        );
    });

    it('releases the context and fixed buffers exactly once', async () => {
        const memory = new WebAssembly.Memory({ initial: 2 });
        let nextPointer = 1_024;
        const allocate = vi.fn((byteLength: number): number => {
            const pointer = nextPointer;
            nextPointer += byteLength;
            return pointer;
        });
        const deallocate = vi.fn();
        const destroy = vi.fn();
        /* eslint-disable @typescript-eslint/naming-convention -- Mirrors the external WASM ABI */
        const instance = {
            exports: {
                dovi_parser_allocate: allocate,
                dovi_parser_create: (): number => 512,
                dovi_parser_deallocate: deallocate,
                dovi_parser_destroy: destroy,
                dovi_parser_last_error_byte_length: (): number => 0,
                dovi_parser_last_error_pointer: (): number => 0,
                dovi_parser_maximum_buffer_byte_length: (): number => (
                    MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH
                ),
                dovi_parser_maximum_memory_byte_length: (): number => (
                    MAXIMUM_DOLBY_VISION_RPU_PARSER_MEMORY_BYTE_LENGTH
                ),
                dovi_parser_output_byte_length: (): number => (
                    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH
                ),
                dovi_parser_parse: (): number => 0,
                dovi_parser_reset: (): number => 0,
                dovi_parser_revision_prefix: (): number => (
                    DOLBY_VISION_RPU_PARSER_REVISION_PREFIX
                ),
                dovi_parser_schema_version: (): number => (
                    DOLBY_VISION_RPU_SCHEMA_VERSION
                ),
                memory
            }
        } as unknown as WebAssembly.Instance;
        /* eslint-enable @typescript-eslint/naming-convention */
        const parser = await DolbyVisionRPUParser.create('mock.wasm', {
            loadInstance: async (): Promise<WebAssembly.Instance> => instance
        });

        parser.close();
        parser.close();

        expect(allocate).toHaveBeenCalledTimes(2);
        expect(deallocate).toHaveBeenCalledTimes(2);
        expect(destroy).toHaveBeenCalledTimes(1);
    });
});
