// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    DOLBY_VISION_RPU_COMPONENT_WORD_OFFSET,
    DOLBY_VISION_RPU_COMPONENT_WORD_STRIDE,
    DOLBY_VISION_RPU_PACKED_COMPONENT_MMR_OFFSET,
    DOLBY_VISION_RPU_PACKED_COMPONENT_PIVOT_OFFSET,
    DOLBY_VISION_RPU_PACKED_COMPONENT_SEGMENT_OFFSET
} from '../custom/DolbyVisionRPUDataLayout';
import DolbyVisionRPUParser, {
    DOLBY_VISION_RPU_PARSER_REVISION_PREFIX,
    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
    DOLBY_VISION_RPU_SCHEMA_MAGIC,
    DOLBY_VISION_RPU_SCHEMA_VERSION,
    type DolbyVisionRPUParserDependencies
} from '../custom/DolbyVisionRPUParser';
import type { ColorTriplet } from './ColorPipeline';
import {
    createDolbyVisionColorTransformWGSL,
    reconstructDolbyVisionBT2020PQ,
    reshapeDolbyVisionSignal
} from './DolbyVisionColorTransform';
import { createDolbyVisionAuthorizationRPUFixture } from '../validation/DolbyVisionAuthorizationFixture';

const PARSER_DIRECTORY = resolve(
    process.cwd(),
    'scripts/webgpu/dolby-vision-parser'
);
const PARSER_WASM_BYTES = new Uint8Array(readFileSync(resolve(
    PARSER_DIRECTORY,
    'artifacts/dovi-rpu-parser.wasm'
)));
const REFERENCE_DECIMAL_PRECISION = 6;
const LIBPLACEBO_REFERENCE_MAXIMUM_ABSOLUTE_ERROR = 0.000_01;
const BYTES_PER_PACKED_WORD = Uint32Array.BYTES_PER_ELEMENT;
const PACKED_BYTES_PER_MMR_VECTOR = 4 * Float32Array.BYTES_PER_ELEMENT;

interface LibplaceboReferenceSample {
    input: ColorTriplet;
    output: ColorTriplet;
}

// Generated through pl_shader_decode_color_ex at libplacebo
// 4d82c6898551068d4ae6a6b5538efcddc2c7cf64 into a Vulkan float target
const LIBPLACEBO_PROFILE_8_4_REFERENCE_SAMPLES: readonly LibplaceboReferenceSample[] = [
    {
        input: [ 0.180000007, 0.400000006, 0.699999988 ],
        output: [ 0.443903804, 0.118706532, 0.000000730957538 ]
    },
    {
        input: [ 0.75, 0.25, 0.899999976 ],
        output: [ 0.936488032, 0.521081865, 0.306210458 ]
    },
    {
        input: [ 0.129999995, 0.800000012, 0.200000003 ],
        output: [ 0.000000730957538, 0.442302763, 0.232457832 ]
    },
    {
        input: [ 0.910000026, 0.100000001, 0.600000024 ],
        output: [ 0.831091762, 0.757029593, 0.316223025 ]
    },
    {
        input: [ 0.0615835786, 0.5, 0.5 ],
        output: [ 0.00403126096, 0.00556820584, 0.000000730957538 ]
    },
    {
        input: [ 0.92082113, 0.949999988, 0.0500000007 ],
        output: [ 0.689419568, 0.701194286, 1.56446576 ]
    }
];

async function instantiateParserModule(): Promise<WebAssembly.Instance> {
    const result = await WebAssembly.instantiate(PARSER_WASM_BYTES, {});
    return result.instance;
}

const ACTUAL_PARSER_DEPENDENCIES: DolbyVisionRPUParserDependencies = {
    loadInstance: instantiateParserModule
};

function readFixture(fileName: string): Uint8Array {
    return new Uint8Array(readFileSync(resolve(
        PARSER_DIRECTORY,
        'fixtures',
        fileName
    )));
}

async function parseFixture(fileName: string): Promise<ArrayBuffer> {
    const parser = await DolbyVisionRPUParser.create(
        'local-parser.wasm',
        ACTUAL_PARSER_DEPENDENCIES
    );
    try {
        return parser.parse(readFixture(fileName)).packedData;
    } finally {
        parser.close();
    }
}

function expectColorClose(actual: ColorTriplet, expected: ColorTriplet): void {
    for (let componentIndex = 0; componentIndex < actual.length; componentIndex += 1) {
        expect(actual[componentIndex]).toBeCloseTo(
            expected[componentIndex],
            REFERENCE_DECIMAL_PRECISION
        );
    }
}

function expectColorWithinAbsoluteError(
    actual: ColorTriplet,
    expected: ColorTriplet,
    maximumAbsoluteError: number
): void {
    for (let componentIndex = 0; componentIndex < actual.length; componentIndex += 1) {
        expect(Math.abs(actual[componentIndex] - expected[componentIndex]))
            .toBeLessThanOrEqual(maximumAbsoluteError);
    }
}

function createMultiSegmentMMRFixture(): ArrayBuffer {
    const packedRPUData = createDolbyVisionAuthorizationRPUFixture();
    const view = new DataView(packedRPUData);
    const componentWordOffset = DOLBY_VISION_RPU_COMPONENT_WORD_OFFSET
        + DOLBY_VISION_RPU_COMPONENT_WORD_STRIDE;
    const componentByteOffset = componentWordOffset * BYTES_PER_PACKED_WORD;
    view.setUint32(componentByteOffset, 3, true);
    view.setUint32(componentByteOffset + BYTES_PER_PACKED_WORD, 8, true);
    const pivotByteOffset = componentByteOffset
        + DOLBY_VISION_RPU_PACKED_COMPONENT_PIVOT_OFFSET;
    view.setFloat32(pivotByteOffset, 0, true);
    view.setFloat32(pivotByteOffset + BYTES_PER_PACKED_WORD, 0.5, true);
    view.setFloat32(pivotByteOffset + (2 * BYTES_PER_PACKED_WORD), 1, true);
    const secondSegmentByteOffset = componentByteOffset
        + DOLBY_VISION_RPU_PACKED_COMPONENT_SEGMENT_OFFSET
        + (4 * BYTES_PER_PACKED_WORD);
    view.setFloat32(secondSegmentByteOffset, 0.1, true);
    view.setFloat32(secondSegmentByteOffset + BYTES_PER_PACKED_WORD, 6, true);
    view.setFloat32(secondSegmentByteOffset + (3 * BYTES_PER_PACKED_WORD), 1, true);
    const secondSegmentMMRByteOffset = componentByteOffset
        + DOLBY_VISION_RPU_PACKED_COMPONENT_MMR_OFFSET
        + (6 * PACKED_BYTES_PER_MMR_VECTOR);
    view.setFloat32(secondSegmentMMRByteOffset + BYTES_PER_PACKED_WORD, 0.4, true);
    return packedRPUData;
}

describe('Dolby Vision CPU color reconstruction', () => {
    it('applies the Profile 8 polynomial reshape and color matrices', async () => {
        const packedRPUData = await parseFixture('profile8.bin');
        const sourceSignal: ColorTriplet = [ 0.18, 0.4, 0.7 ];

        expectColorClose(
            reshapeDolbyVisionSignal(sourceSignal, packedRPUData),
            sourceSignal
        );
        expectColorClose(
            reconstructDolbyVisionBT2020PQ(sourceSignal, packedRPUData),
            [ 0.473382824, 0.027058045, 0.000000731 ]
        );
    });

    it('applies the Profile 8.4 piecewise polynomial and order-three MMR curves', async () => {
        const packedRPUData = await parseFixture('profile84.bin');

        expectColorClose(
            reshapeDolbyVisionSignal([ 0.18, 0.4, 0.7 ], packedRPUData),
            [ 0.227399177, 0.376367672, 0.649622879 ]
        );
        expectColorClose(
            reconstructDolbyVisionBT2020PQ(
                [ 0.75, 0.25, 0.9 ],
                packedRPUData
            ),
            [ 0.936491165, 0.521081246, 0.306211186 ]
        );
    });

    it('matches the pinned libplacebo Profile 8.4 decode-color boundary', async () => {
        const packedRPUData = await parseFixture('profile84.bin');

        for (const referenceSample of LIBPLACEBO_PROFILE_8_4_REFERENCE_SAMPLES) {
            expectColorWithinAbsoluteError(
                reconstructDolbyVisionBT2020PQ(referenceSample.input, packedRPUData),
                referenceSample.output,
                LIBPLACEBO_REFERENCE_MAXIMUM_ABSOLUTE_ERROR
            );
        }
    });

    it('honors the Profile 5 nonlinear chroma offsets', async () => {
        const packedRPUData = await parseFixture('profile5.bin');

        expectColorClose(
            reshapeDolbyVisionSignal([ 0.2, 0.4, 0.7 ], packedRPUData),
            [ 0, 0.5, 0.5 ]
        );
        expectColorClose(
            reconstructDolbyVisionBT2020PQ([ 0.2, 0.4, 0.7 ], packedRPUData),
            [ 0.000083226, 0.000000731, 0.000328088 ]
        );
    });

    it('indexes later MMR segments in packed vec4 units', () => {
        const packedRPUData = createMultiSegmentMMRFixture();

        expect(reshapeDolbyVisionSignal(
            [ 0.2, 0.75, 0.4 ],
            packedRPUData
        )[1]).toBeCloseTo(0.4, REFERENCE_DECIMAL_PRECISION);
    });
});

describe('createDolbyVisionColorTransformWGSL', () => {
    it('generates the fixed-schema libplacebo-equivalent reconstruction order', () => {
        const shader = createDolbyVisionColorTransformWGSL(5);
        const reconstruction = shader.slice(
            shader.indexOf('fn reconstructDolbyVisionBT2020PQ')
        );

        expect(shader).toContain('@binding(5) var<storage, read> dolbyVisionRPU');
        expect(shader).toContain(`array<u32, ${DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH / 4}>`);
        expect(shader).toContain(`dolbyVisionRPU.words[0] == ${DOLBY_VISION_RPU_SCHEMA_MAGIC}u`);
        expect(shader).toContain(`dolbyVisionRPU.words[1] == ${DOLBY_VISION_RPU_SCHEMA_VERSION}u`);
        expect(shader).toContain(`dolbyVisionRPU.words[2] == ${DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH}u`);
        expect(shader).toContain(`dolbyVisionRPU.words[4] == ${DOLBY_VISION_RPU_PARSER_REVISION_PREFIX}u`);
        expect(shader).toContain('fn isDolbyVisionFEL() -> bool');
        expect(shader).toContain('& 64u) != 0u');
        expect(shader).toContain('fn evaluateDolbyVisionMMR');
        expect(shader).toContain('mmrVectorIndex * 4u');
        expect(shader).toContain('quadraticCoefficient * componentSignal');
        expect(reconstruction.indexOf('reshapeDolbyVisionComponent')).toBeLessThan(
            reconstruction.indexOf('multiplyDolbyVisionMatrix')
        );
        expect(reconstruction.indexOf('multiplyDolbyVisionMatrix')).toBeLessThan(
            reconstruction.indexOf('applyDolbyVisionPQEOTF')
        );
        expect(reconstruction.indexOf('applyDolbyVisionPQEOTF')).toBeLessThan(
            reconstruction.indexOf('linearLMS')
        );
        expect(reconstruction.indexOf('linearLMS')).toBeLessThan(
            reconstruction.indexOf('linearBT2020')
        );
        expect(reconstruction.indexOf('linearBT2020')).toBeLessThan(
            reconstruction.indexOf('applyDolbyVisionPQOETF')
        );
    });

    it('rejects invalid storage bindings', () => {
        expect(() => createDolbyVisionColorTransformWGSL(-1)).toThrow(
            'Dolby Vision RPU binding must be a non-negative integer'
        );
        expect(() => createDolbyVisionColorTransformWGSL(1.5)).toThrow(
            'Dolby Vision RPU binding must be a non-negative integer'
        );
    });
});
