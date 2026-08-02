import {
    DOLBY_VISION_RPU_COLOR_WORD_OFFSET,
    DOLBY_VISION_RPU_COMPONENT_WORD_OFFSET,
    DOLBY_VISION_RPU_COMPONENT_WORD_STRIDE,
    DOLBY_VISION_RPU_PACKED_COMPONENT_MMR_OFFSET,
    DOLBY_VISION_RPU_PACKED_COMPONENT_PIVOT_OFFSET,
    DOLBY_VISION_RPU_PACKED_COMPONENT_SEGMENT_OFFSET
} from '../custom/DolbyVisionRPUDataLayout';
import {
    decodeDolbyVisionRPUSnapshot,
    DOLBY_VISION_RPU_PARSER_REVISION_PREFIX,
    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
    DOLBY_VISION_RPU_SCHEMA_MAGIC,
    DOLBY_VISION_RPU_SCHEMA_VERSION
} from '../custom/DolbyVisionRPUParser';

const BYTES_PER_WORD = Uint32Array.BYTES_PER_ELEMENT;
const DEFAULT_COLOR_METADATA_FLAG = 1 << 8;
const MISSING_UNSIGNED_INTEGER = 0xFFFF_FFFF;
const POLYNOMIAL_MAPPING_METHOD = 1;
const MMR_MAPPING_METHOD = 2;

const COEFFICIENT_LOG2_DENOMINATOR_BYTE_OFFSET = 44;
const BASE_LAYER_BIT_DEPTH_BYTE_OFFSET = 48;
const ENHANCEMENT_LAYER_BIT_DEPTH_BYTE_OFFSET = 52;
const VDR_BIT_DEPTH_BYTE_OFFSET = 56;
const DISABLE_RESIDUAL_BYTE_OFFSET = 80;
const MAPPING_ID_BYTE_OFFSET = 84;
const PREVIOUS_MAPPING_ID_BYTE_OFFSET = 88;
const SIGNAL_BIT_DEPTH_BYTE_OFFSET = 124;
const SOURCE_MINIMUM_PQ_BYTE_OFFSET = 140;
const SOURCE_MAXIMUM_PQ_BYTE_OFFSET = 144;
const LEVEL1_MINIMUM_PQ_BYTE_OFFSET = 152;
const LEVEL1_MAXIMUM_PQ_BYTE_OFFSET = 156;
const LEVEL1_AVERAGE_PQ_BYTE_OFFSET = 160;

const NONLINEAR_MATRIX: readonly number[] = [
    1, 0, 1.4746,
    1, -0.164553, -0.571353,
    1, 1.8814, 0
];
const LINEAR_RGB_TO_LMS_MATRIX: readonly number[] = [
    0.356750488, 0.592163086, 0.051086426,
    0.156738281, 0.748046875, 0.095275879,
    0, 0.041442871, 0.958557129
];

type SyntheticRPUComponent = {
    mappingMethod: typeof MMR_MAPPING_METHOD | typeof POLYNOMIAL_MAPPING_METHOD
    mmrVectors: readonly (readonly number[])[]
    pivots: readonly number[]
    segments: readonly (readonly number[])[]
};

const SYNTHETIC_COMPONENTS: readonly SyntheticRPUComponent[] = [
    {
        mappingMethod: POLYNOMIAL_MAPPING_METHOD,
        mmrVectors: [],
        pivots: [ 0, 0.5, 1 ],
        segments: [
            [ 0, 0.9, 0.2, 0 ],
            [ -0.05, 1.2, -0.2, 0 ]
        ]
    },
    {
        mappingMethod: MMR_MAPPING_METHOD,
        mmrVectors: [
            [ 0.02, 0.85, 0.01, 0 ],
            [ 0.08, 0, 0, 0 ],
            [ 0, 0.04, 0, 0 ],
            [ 0, 0, 0, 0 ],
            [ 0, 0.01, 0, 0 ],
            [ 0, 0, 0, 0 ]
        ],
        pivots: [ 0, 1 ],
        segments: [ [ 0, 0, 0, 3 ] ]
    },
    {
        mappingMethod: MMR_MAPPING_METHOD,
        mmrVectors: [
            [ 0.01, 0.02, 0.87, 0 ],
            [ 0, 0.06, 0, 0 ],
            [ 0, 0, 0.02, 0 ],
            [ 0, 0, 0, 0 ],
            [ 0, 0, 0.01, 0 ],
            [ 0, 0, 0, 0 ]
        ],
        pivots: [ 0, 1 ],
        segments: [ [ 0, 0, 0, 3 ] ]
    }
];

function writeFloatArray(
    view: DataView,
    byteOffset: number,
    values: readonly number[]
): void {
    for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
        view.setFloat32(byteOffset + (valueIndex * BYTES_PER_WORD), values[valueIndex], true);
    }
}

function writePaddedMatrix(
    view: DataView,
    wordOffset: number,
    matrix: readonly number[]
): void {
    for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
        writeFloatArray(
            view,
            (wordOffset + (rowIndex * 4)) * BYTES_PER_WORD,
            matrix.slice(rowIndex * 3, (rowIndex + 1) * 3)
        );
    }
}

function writeComponent(
    view: DataView,
    componentIndex: number,
    component: SyntheticRPUComponent
): void {
    const componentWordOffset = DOLBY_VISION_RPU_COMPONENT_WORD_OFFSET
        + (componentIndex * DOLBY_VISION_RPU_COMPONENT_WORD_STRIDE);
    const componentByteOffset = componentWordOffset * BYTES_PER_WORD;
    view.setUint32(componentByteOffset, component.pivots.length, true);
    view.setUint32(componentByteOffset + 4, component.mmrVectors.length, true);
    view.setUint32(componentByteOffset + 8, component.mappingMethod, true);
    writeFloatArray(
        view,
        componentByteOffset + DOLBY_VISION_RPU_PACKED_COMPONENT_PIVOT_OFFSET,
        component.pivots
    );
    for (let segmentIndex = 0; segmentIndex < component.segments.length; segmentIndex += 1) {
        writeFloatArray(
            view,
            componentByteOffset
                + DOLBY_VISION_RPU_PACKED_COMPONENT_SEGMENT_OFFSET
                + (segmentIndex * 4 * BYTES_PER_WORD),
            component.segments[segmentIndex]
        );
    }
    for (let vectorIndex = 0; vectorIndex < component.mmrVectors.length; vectorIndex += 1) {
        writeFloatArray(
            view,
            componentByteOffset
                + DOLBY_VISION_RPU_PACKED_COMPONENT_MMR_OFFSET
                + (vectorIndex * 4 * BYTES_PER_WORD),
            component.mmrVectors[vectorIndex]
        );
    }
}

/** Builds a deterministic schema-valid fixture that exercises polynomial and MMR paths. */
export function createDolbyVisionAuthorizationRPUFixture(): ArrayBuffer {
    const packedData = new ArrayBuffer(DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH);
    const view = new DataView(packedData);
    view.setUint32(0, DOLBY_VISION_RPU_SCHEMA_MAGIC, true);
    view.setUint32(4, DOLBY_VISION_RPU_SCHEMA_VERSION, true);
    view.setUint32(8, DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH, true);
    view.setUint32(12, DEFAULT_COLOR_METADATA_FLAG, true);
    view.setUint32(16, DOLBY_VISION_RPU_PARSER_REVISION_PREFIX, true);
    view.setUint32(20, 8, true);
    view.setUint32(COEFFICIENT_LOG2_DENOMINATOR_BYTE_OFFSET, 23, true);
    view.setUint32(BASE_LAYER_BIT_DEPTH_BYTE_OFFSET, 10, true);
    view.setUint32(ENHANCEMENT_LAYER_BIT_DEPTH_BYTE_OFFSET, 10, true);
    view.setUint32(VDR_BIT_DEPTH_BYTE_OFFSET, 12, true);
    view.setUint32(DISABLE_RESIDUAL_BYTE_OFFSET, 1, true);
    view.setUint32(MAPPING_ID_BYTE_OFFSET, 0, true);
    view.setUint32(PREVIOUS_MAPPING_ID_BYTE_OFFSET, MISSING_UNSIGNED_INTEGER, true);
    view.setUint32(SIGNAL_BIT_DEPTH_BYTE_OFFSET, 12, true);
    view.setUint32(SOURCE_MINIMUM_PQ_BYTE_OFFSET, 62, true);
    view.setUint32(SOURCE_MAXIMUM_PQ_BYTE_OFFSET, 3_696, true);
    view.setUint32(LEVEL1_MINIMUM_PQ_BYTE_OFFSET, MISSING_UNSIGNED_INTEGER, true);
    view.setUint32(LEVEL1_MAXIMUM_PQ_BYTE_OFFSET, MISSING_UNSIGNED_INTEGER, true);
    view.setUint32(LEVEL1_AVERAGE_PQ_BYTE_OFFSET, MISSING_UNSIGNED_INTEGER, true);

    writeFloatArray(
        view,
        DOLBY_VISION_RPU_COLOR_WORD_OFFSET * BYTES_PER_WORD,
        [ 0.0625, 0.5, 0.5 ]
    );
    writePaddedMatrix(
        view,
        DOLBY_VISION_RPU_COLOR_WORD_OFFSET + 4,
        NONLINEAR_MATRIX
    );
    writePaddedMatrix(
        view,
        DOLBY_VISION_RPU_COLOR_WORD_OFFSET + 16,
        LINEAR_RGB_TO_LMS_MATRIX
    );
    for (let componentIndex = 0; componentIndex < SYNTHETIC_COMPONENTS.length; componentIndex += 1) {
        writeComponent(view, componentIndex, SYNTHETIC_COMPONENTS[componentIndex]);
    }

    decodeDolbyVisionRPUSnapshot(packedData);
    return packedData;
}
