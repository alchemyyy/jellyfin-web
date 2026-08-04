import {
    DOLBY_VISION_RPU_BASE_LAYER_BIT_DEPTH_WORD_OFFSET,
    DOLBY_VISION_RPU_COLOR_WORD_OFFSET,
    DOLBY_VISION_RPU_COMPONENT_WORD_OFFSET,
    DOLBY_VISION_RPU_COMPONENT_WORD_STRIDE,
    DOLBY_VISION_RPU_PACKED_COMPONENT_MMR_OFFSET,
    DOLBY_VISION_RPU_PACKED_COMPONENT_PIVOT_OFFSET,
    DOLBY_VISION_RPU_PACKED_COMPONENT_SEGMENT_OFFSET,
    DOLBY_VISION_RPU_ENHANCEMENT_LAYER_BIT_DEPTH_WORD_OFFSET,
    DOLBY_VISION_RPU_NLQ_WORD_OFFSET,
    MAXIMUM_DOLBY_VISION_RPU_MMR_VECTOR_COUNT,
    MAXIMUM_DOLBY_VISION_RPU_PIVOT_COUNT
} from '../custom/DolbyVisionRPUDataLayout';
import {
    decodeDolbyVisionRPUSnapshot,
    DOLBY_VISION_RPU_PARSER_REVISION_PREFIX,
    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
    DOLBY_VISION_RPU_SCHEMA_MAGIC,
    DOLBY_VISION_RPU_SCHEMA_VERSION
} from '../custom/DolbyVisionRPUParser';
import type { ColorTriplet } from './ColorPipeline';

const BYTES_PER_PACKED_WORD = Uint32Array.BYTES_PER_ELEMENT;
const PACKED_WORDS_PER_MMR_VECTOR = 4;
const DOLBY_VISION_RPU_PACKED_WORD_COUNT =
    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH / BYTES_PER_PACKED_WORD;
const COMPONENT_PIVOT_WORD_OFFSET =
    DOLBY_VISION_RPU_PACKED_COMPONENT_PIVOT_OFFSET / BYTES_PER_PACKED_WORD;
const COMPONENT_SEGMENT_WORD_OFFSET =
    DOLBY_VISION_RPU_PACKED_COMPONENT_SEGMENT_OFFSET / BYTES_PER_PACKED_WORD;
const COMPONENT_MMR_WORD_OFFSET =
    DOLBY_VISION_RPU_PACKED_COMPONENT_MMR_OFFSET / BYTES_PER_PACKED_WORD;
const DOLBY_VISION_RPU_FLAGS_WORD_OFFSET = 3;
const DOLBY_VISION_RPU_FEL_FLAG = 1 << 6;

const PQ_M1 = 2610 / 16384;
const PQ_M2 = 2523 / 32;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = 2413 / 128;
const PQ_C3 = 2392 / 128;

const BT2020_HPE_LMS_TO_RGB: readonly ColorTriplet[] = [
    [ 3.06441879, -2.16597676, 0.10155818 ],
    [ -0.65612108, 1.78554118, -0.12943749 ],
    [ 0.01736321, -0.04725154, 1.03004253 ]
];

type ColorQuadruplet = readonly [number, number, number, number];

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function readFloat(view: DataView, wordOffset: number): number {
    return view.getFloat32(wordOffset * BYTES_PER_PACKED_WORD, true);
}

function readUnsignedInteger(view: DataView, wordOffset: number): number {
    return view.getUint32(wordOffset * BYTES_PER_PACKED_WORD, true);
}

function multiplyMatrixRows(
    rows: readonly ColorTriplet[],
    signal: ColorTriplet
): ColorTriplet {
    return [
        (rows[0][0] * signal[0]) + (rows[0][1] * signal[1]) + (rows[0][2] * signal[2]),
        (rows[1][0] * signal[0]) + (rows[1][1] * signal[1]) + (rows[1][2] * signal[2]),
        (rows[2][0] * signal[0]) + (rows[2][1] * signal[1]) + (rows[2][2] * signal[2])
    ];
}

function readMatrixRows(view: DataView, wordOffset: number): readonly ColorTriplet[] {
    const rows: ColorTriplet[] = [];
    for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
        const rowOffset = wordOffset + (rowIndex * 4);
        rows.push([
            readFloat(view, rowOffset),
            readFloat(view, rowOffset + 1),
            readFloat(view, rowOffset + 2)
        ]);
    }
    return rows;
}

function applyPQEOTF(encodedValue: number): number {
    const inversePower = Math.pow(Math.max(encodedValue, 0), 1 / PQ_M2);
    const numerator = Math.max(inversePower - PQ_C1, 0);
    const denominator = Math.max(PQ_C2 - (PQ_C3 * inversePower), 1e-7);
    return Math.pow(numerator / denominator, 1 / PQ_M1);
}

function applyPQOETF(linearValue: number): number {
    const power = Math.pow(Math.max(linearValue, 0), PQ_M1);
    return Math.pow((PQ_C1 + (PQ_C2 * power)) / (1 + (PQ_C3 * power)), PQ_M2);
}

function findSegmentIndex(
    view: DataView,
    componentWordOffset: number,
    pivotCount: number,
    componentSignal: number
): number {
    let segmentIndex = 0;
    for (let pivotIndex = 1; pivotIndex < pivotCount - 1; pivotIndex += 1) {
        const pivot = readFloat(
            view,
            componentWordOffset + COMPONENT_PIVOT_WORD_OFFSET + pivotIndex
        );
        if (componentSignal >= pivot) {
            segmentIndex = pivotIndex;
        }
    }
    return segmentIndex;
}

function evaluatePolynomial(
    view: DataView,
    segmentWordOffset: number,
    componentSignal: number
): number {
    const constant = readFloat(view, segmentWordOffset);
    const linearCoefficient = readFloat(view, segmentWordOffset + 1);
    const quadraticCoefficient = readFloat(view, segmentWordOffset + 2);
    return ((quadraticCoefficient * componentSignal) + linearCoefficient)
        * componentSignal
        + constant;
}

function evaluateMMR(
    view: DataView,
    componentWordOffset: number,
    segmentWordOffset: number,
    sourceSignal: ColorTriplet
): number {
    const mmrVectorIndex = readFloat(view, segmentWordOffset + 1);
    const mmrOrder = readFloat(view, segmentWordOffset + 3);
    if (!Number.isInteger(mmrVectorIndex)
        || !Number.isInteger(mmrOrder)
        || mmrVectorIndex < 0
        || mmrVectorIndex >= MAXIMUM_DOLBY_VISION_RPU_MMR_VECTOR_COUNT
        || mmrOrder < 1
        || mmrOrder > 3) {
        throw new TypeError('Dolby Vision MMR coefficients are invalid');
    }

    const signalProducts: ColorQuadruplet = [
        sourceSignal[0] * sourceSignal[1],
        sourceSignal[0] * sourceSignal[2],
        sourceSignal[1] * sourceSignal[2],
        sourceSignal[0] * sourceSignal[1] * sourceSignal[2]
    ];
    let result = readFloat(view, segmentWordOffset);
    const mmrWordOffset = componentWordOffset
        + COMPONENT_MMR_WORD_OFFSET
        + (mmrVectorIndex * PACKED_WORDS_PER_MMR_VECTOR);
    for (let orderIndex = 0; orderIndex < mmrOrder; orderIndex += 1) {
        const coefficientWordOffset = mmrWordOffset + (orderIndex * 8);
        const exponent = orderIndex + 1;
        for (let signalIndex = 0; signalIndex < 3; signalIndex += 1) {
            result += readFloat(view, coefficientWordOffset + signalIndex)
                * Math.pow(sourceSignal[signalIndex], exponent);
        }
        for (let productIndex = 0; productIndex < 4; productIndex += 1) {
            result += readFloat(view, coefficientWordOffset + 4 + productIndex)
                * Math.pow(signalProducts[productIndex], exponent);
        }
    }
    return result;
}

function reshapeComponent(
    view: DataView,
    sourceSignal: ColorTriplet,
    componentIndex: number
): number {
    const componentWordOffset = DOLBY_VISION_RPU_COMPONENT_WORD_OFFSET
        + (componentIndex * DOLBY_VISION_RPU_COMPONENT_WORD_STRIDE);
    const pivotCount = readUnsignedInteger(view, componentWordOffset);
    const mappingMethod = readUnsignedInteger(view, componentWordOffset + 2);
    const componentSignal = clamp(sourceSignal[componentIndex], 0, 1);
    const segmentIndex = findSegmentIndex(
        view,
        componentWordOffset,
        pivotCount,
        componentSignal
    );
    const segmentWordOffset = componentWordOffset
        + COMPONENT_SEGMENT_WORD_OFFSET
        + (segmentIndex * 4);

    let reshapedSignal: number;
    switch (mappingMethod) {
        case 1:
            reshapedSignal = evaluatePolynomial(view, segmentWordOffset, componentSignal);
            break;
        case 2:
            reshapedSignal = evaluateMMR(
                view,
                componentWordOffset,
                segmentWordOffset,
                sourceSignal
            );
            break;
        default:
            throw new TypeError('Dolby Vision mapping method is invalid');
    }

    const lowerPivot = readFloat(
        view,
        componentWordOffset + COMPONENT_PIVOT_WORD_OFFSET
    );
    const upperPivot = readFloat(
        view,
        componentWordOffset + COMPONENT_PIVOT_WORD_OFFSET + pivotCount - 1
    );
    return clamp(reshapedSignal, lowerPivot, upperPivot);
}

/** Applies the libplacebo reshape model to one normalized base-layer signal. */
export function reshapeDolbyVisionSignal(
    normalizedBaseSignal: ColorTriplet,
    packedRPUData: ArrayBuffer
): ColorTriplet {
    decodeDolbyVisionRPUSnapshot(packedRPUData);
    const view = new DataView(packedRPUData);
    const sourceSignal: ColorTriplet = [
        clamp(normalizedBaseSignal[0], 0, 1),
        clamp(normalizedBaseSignal[1], 0, 1),
        clamp(normalizedBaseSignal[2], 0, 1)
    ];
    return [
        reshapeComponent(view, sourceSignal, 0),
        reshapeComponent(view, sourceSignal, 1),
        reshapeComponent(view, sourceSignal, 2)
    ];
}

/** Reconstructs one Dolby Vision base signal into encoded BT.2020 PQ RGB. */
export function reconstructDolbyVisionBT2020PQ(
    normalizedBaseSignal: ColorTriplet,
    packedRPUData: ArrayBuffer
): ColorTriplet {
    const snapshot = decodeDolbyVisionRPUSnapshot(packedRPUData);
    const view = new DataView(packedRPUData);
    const reshapedSignal = reshapeDolbyVisionSignal(normalizedBaseSignal, packedRPUData);
    return reconstructDolbyVisionReshapedBT2020PQ(
        reshapedSignal,
        snapshot.baseLayerBitDepth,
        view
    );
}

function reconstructDolbyVisionReshapedBT2020PQ(
    reshapedSignal: ColorTriplet,
    baseLayerBitDepth: number,
    view: DataView
): ColorTriplet {
    const codeScale = (2 ** baseLayerBitDepth)
        / ((2 ** baseLayerBitDepth) - 1);
    const nonlinearOffset: ColorTriplet = [
        readFloat(view, DOLBY_VISION_RPU_COLOR_WORD_OFFSET),
        readFloat(view, DOLBY_VISION_RPU_COLOR_WORD_OFFSET + 1),
        readFloat(view, DOLBY_VISION_RPU_COLOR_WORD_OFFSET + 2)
    ];
    const offsetSignal: ColorTriplet = [
        reshapedSignal[0] - (nonlinearOffset[0] * codeScale),
        reshapedSignal[1] - (nonlinearOffset[1] * codeScale),
        reshapedSignal[2] - (nonlinearOffset[2] * codeScale)
    ];
    const nonlinearMatrix = readMatrixRows(view, DOLBY_VISION_RPU_COLOR_WORD_OFFSET + 4);
    const linearMatrix = readMatrixRows(view, DOLBY_VISION_RPU_COLOR_WORD_OFFSET + 16);
    const nonlinearRGB = multiplyMatrixRows(nonlinearMatrix, offsetSignal);
    const linearizedSignal: ColorTriplet = [
        applyPQEOTF(nonlinearRGB[0]),
        applyPQEOTF(nonlinearRGB[1]),
        applyPQEOTF(nonlinearRGB[2])
    ];
    const linearLMS = multiplyMatrixRows(linearMatrix, linearizedSignal);
    const linearBT2020 = multiplyMatrixRows(BT2020_HPE_LMS_TO_RGB, linearLMS);
    return [
        applyPQOETF(linearBT2020[0]),
        applyPQOETF(linearBT2020[1]),
        applyPQOETF(linearBT2020[2])
    ];
}

/** Applies Profile 7 LINEAR_DZ residual composition before the Dolby matrices. */
export function reconstructDolbyVisionBT2020PQWithEnhancement(
    normalizedBaseSignal: ColorTriplet,
    normalizedEnhancementSignal: ColorTriplet,
    packedRPUData: ArrayBuffer
): ColorTriplet {
    const snapshot = decodeDolbyVisionRPUSnapshot(packedRPUData);
    if (snapshot.layerMode !== 'fel' || !snapshot.nlqActive) {
        throw new TypeError('Dolby Vision enhancement reconstruction requires active FEL NLQ');
    }
    const reshapedSignal = reshapeDolbyVisionSignal(normalizedBaseSignal, packedRPUData);
    const reconstructedSignal = composeDolbyVisionEnhancementSignal(
        reshapedSignal,
        normalizedEnhancementSignal,
        packedRPUData
    );
    return reconstructDolbyVisionReshapedBT2020PQ(
        reconstructedSignal,
        snapshot.baseLayerBitDepth,
        new DataView(packedRPUData)
    );
}

/** Composes normalized LINEAR_DZ EL residuals into an already reshaped BL signal. */
export function composeDolbyVisionEnhancementSignal(
    reshapedSignal: ColorTriplet,
    normalizedEnhancementSignal: ColorTriplet,
    packedRPUData: ArrayBuffer
): ColorTriplet {
    const snapshot = decodeDolbyVisionRPUSnapshot(packedRPUData);
    if (snapshot.layerMode !== 'fel' || !snapshot.nlqActive) {
        throw new TypeError('Dolby Vision enhancement composition requires active FEL NLQ');
    }
    const reconstructedSignal: [number, number, number] = [ 0, 0, 0 ];
    for (let componentIndex = 0; componentIndex < 3; componentIndex += 1) {
        const nlq = snapshot.nlq[componentIndex];
        const centeredEnhancement = clamp(
            normalizedEnhancementSignal[componentIndex],
            0,
            1
        ) - nlq.offset;
        const residual = Math.sign(centeredEnhancement)
            * (
                Math.abs(centeredEnhancement) * nlq.deadzoneSlope
                + nlq.deadzoneThreshold
            );
        reconstructedSignal[componentIndex] = reshapedSignal[componentIndex] + residual;
    }
    return reconstructedSignal;
}

function requireBinding(binding: number): number {
    if (!Number.isSafeInteger(binding) || binding < 0) {
        throw new RangeError('Dolby Vision RPU binding must be a non-negative integer');
    }
    return binding;
}

/** Generates the fixed-storage-buffer libplacebo-equivalent reshape stage. */
export function createDolbyVisionColorTransformWGSL(bindingValue: number): string {
    const binding = requireBinding(bindingValue);
    return /* wgsl */ `
struct DolbyVisionRPUData {
    words: array<u32, ${DOLBY_VISION_RPU_PACKED_WORD_COUNT}>,
}

@group(0) @binding(${binding}) var<storage, read> dolbyVisionRPU: DolbyVisionRPUData;

fn loadDolbyVisionFloat(wordOffset: u32) -> f32 {
    return bitcast<f32>(dolbyVisionRPU.words[wordOffset]);
}

fn hasCompatibleDolbyVisionRPU() -> bool {
    return dolbyVisionRPU.words[0] == ${DOLBY_VISION_RPU_SCHEMA_MAGIC}u
        && dolbyVisionRPU.words[1] == ${DOLBY_VISION_RPU_SCHEMA_VERSION}u
        && dolbyVisionRPU.words[2] == ${DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH}u
        && dolbyVisionRPU.words[4] == ${DOLBY_VISION_RPU_PARSER_REVISION_PREFIX}u;
}

fn isDolbyVisionFEL() -> bool {
    return hasCompatibleDolbyVisionRPU()
        && (dolbyVisionRPU.words[${DOLBY_VISION_RPU_FLAGS_WORD_OFFSET}]
            & ${DOLBY_VISION_RPU_FEL_FLAG}u) != 0u;
}

fn applyDolbyVisionEnhancementResidual(
    reshapedSignal: vec3f,
    rawEnhancementSignal: vec3f
) -> vec3f {
    let enhancementLayerBitDepth = dolbyVisionRPU.words[
        ${DOLBY_VISION_RPU_ENHANCEMENT_LAYER_BIT_DEPTH_WORD_OFFSET}
    ];
    if (enhancementLayerBitDepth < 8u || enhancementLayerBitDepth > 16u) {
        return reshapedSignal;
    }
    let enhancementCodeMaximum = exp2(f32(enhancementLayerBitDepth)) - 1.0;
    let normalizedEnhancement = clamp(
        rawEnhancementSignal / enhancementCodeMaximum,
        vec3f(0.0),
        vec3f(1.0)
    );
    var reconstructedSignal = reshapedSignal;
    for (var componentIndex = 0u; componentIndex < 3u; componentIndex += 1u) {
        let nlqWordOffset = ${DOLBY_VISION_RPU_NLQ_WORD_OFFSET}u
            + (componentIndex * 4u);
        let centeredEnhancement = normalizedEnhancement[componentIndex]
            - loadDolbyVisionFloat(nlqWordOffset);
        let residual = sign(centeredEnhancement) * (
            abs(centeredEnhancement) * loadDolbyVisionFloat(nlqWordOffset + 1u)
                + loadDolbyVisionFloat(nlqWordOffset + 2u)
        );
        reconstructedSignal[componentIndex] += residual;
    }
    return reconstructedSignal;
}

fn multiplyDolbyVisionMatrix(matrixWordOffset: u32, signal: vec3f) -> vec3f {
    return vec3f(
        dot(vec3f(
            loadDolbyVisionFloat(matrixWordOffset),
            loadDolbyVisionFloat(matrixWordOffset + 1u),
            loadDolbyVisionFloat(matrixWordOffset + 2u)
        ), signal),
        dot(vec3f(
            loadDolbyVisionFloat(matrixWordOffset + 4u),
            loadDolbyVisionFloat(matrixWordOffset + 5u),
            loadDolbyVisionFloat(matrixWordOffset + 6u)
        ), signal),
        dot(vec3f(
            loadDolbyVisionFloat(matrixWordOffset + 8u),
            loadDolbyVisionFloat(matrixWordOffset + 9u),
            loadDolbyVisionFloat(matrixWordOffset + 10u)
        ), signal)
    );
}

fn evaluateDolbyVisionMMR(
    componentWordOffset: u32,
    segmentWordOffset: u32,
    sourceSignal: vec3f
) -> f32 {
    let mmrVectorIndex = u32(loadDolbyVisionFloat(segmentWordOffset + 1u));
    let mmrOrder = u32(loadDolbyVisionFloat(segmentWordOffset + 3u));
    let signalProducts = vec4f(
        sourceSignal.x * sourceSignal.y,
        sourceSignal.x * sourceSignal.z,
        sourceSignal.y * sourceSignal.z,
        sourceSignal.x * sourceSignal.y * sourceSignal.z
    );
    let mmrWordOffset = componentWordOffset + ${COMPONENT_MMR_WORD_OFFSET}u
        + (mmrVectorIndex * ${PACKED_WORDS_PER_MMR_VECTOR}u);
    var result = loadDolbyVisionFloat(segmentWordOffset);
    for (var orderIndex = 0u; orderIndex < 3u; orderIndex += 1u) {
        if (orderIndex >= mmrOrder) {
            break;
        }
        let coefficientWordOffset = mmrWordOffset + (orderIndex * 8u);
        let exponent = f32(orderIndex + 1u);
        result += dot(vec3f(
            loadDolbyVisionFloat(coefficientWordOffset),
            loadDolbyVisionFloat(coefficientWordOffset + 1u),
            loadDolbyVisionFloat(coefficientWordOffset + 2u)
        ), pow(sourceSignal, vec3f(exponent)));
        result += dot(vec4f(
            loadDolbyVisionFloat(coefficientWordOffset + 4u),
            loadDolbyVisionFloat(coefficientWordOffset + 5u),
            loadDolbyVisionFloat(coefficientWordOffset + 6u),
            loadDolbyVisionFloat(coefficientWordOffset + 7u)
        ), pow(signalProducts, vec4f(exponent)));
    }
    return result;
}

fn reshapeDolbyVisionComponent(
    sourceSignal: vec3f,
    componentIndex: u32
) -> f32 {
    let componentWordOffset = ${DOLBY_VISION_RPU_COMPONENT_WORD_OFFSET}u
        + (componentIndex * ${DOLBY_VISION_RPU_COMPONENT_WORD_STRIDE}u);
    let pivotCount = dolbyVisionRPU.words[componentWordOffset];
    let mappingMethod = dolbyVisionRPU.words[componentWordOffset + 2u];
    let componentSignal = clamp(sourceSignal[componentIndex], 0.0, 1.0);
    var segmentIndex = 0u;
    for (var pivotIndex = 1u; pivotIndex < ${MAXIMUM_DOLBY_VISION_RPU_PIVOT_COUNT}u; pivotIndex += 1u) {
        if (pivotIndex >= pivotCount - 1u) {
            break;
        }
        let pivot = loadDolbyVisionFloat(
            componentWordOffset + ${COMPONENT_PIVOT_WORD_OFFSET}u + pivotIndex
        );
        if (componentSignal >= pivot) {
            segmentIndex = pivotIndex;
        }
    }
    let segmentWordOffset = componentWordOffset + ${COMPONENT_SEGMENT_WORD_OFFSET}u
        + (segmentIndex * 4u);
    var reshapedSignal: f32;
    if (mappingMethod == 1u) {
        let constant = loadDolbyVisionFloat(segmentWordOffset);
        let linearCoefficient = loadDolbyVisionFloat(segmentWordOffset + 1u);
        let quadraticCoefficient = loadDolbyVisionFloat(segmentWordOffset + 2u);
        reshapedSignal = ((quadraticCoefficient * componentSignal) + linearCoefficient)
            * componentSignal + constant;
    } else {
        reshapedSignal = evaluateDolbyVisionMMR(
            componentWordOffset,
            segmentWordOffset,
            sourceSignal
        );
    }
    let lowerPivot = loadDolbyVisionFloat(
        componentWordOffset + ${COMPONENT_PIVOT_WORD_OFFSET}u
    );
    let upperPivot = loadDolbyVisionFloat(
        componentWordOffset + ${COMPONENT_PIVOT_WORD_OFFSET}u + pivotCount - 1u
    );
    return clamp(reshapedSignal, lowerPivot, upperPivot);
}

fn applyDolbyVisionPQEOTF(encodedValue: f32) -> f32 {
    let inversePower = pow(max(encodedValue, 0.0), 1.0 / (2523.0 / 32.0));
    let numerator = max(inversePower - (3424.0 / 4096.0), 0.0);
    let denominator = max(
        (2413.0 / 128.0) - ((2392.0 / 128.0) * inversePower),
        0.0000001
    );
    return pow(numerator / denominator, 1.0 / (2610.0 / 16384.0));
}

fn applyDolbyVisionPQOETF(linearValue: f32) -> f32 {
    let power = pow(max(linearValue, 0.0), 2610.0 / 16384.0);
    return pow(
        ((3424.0 / 4096.0) + ((2413.0 / 128.0) * power))
            / (1.0 + ((2392.0 / 128.0) * power)),
        2523.0 / 32.0
    );
}

fn reconstructDolbyVisionBT2020PQWithEnhancement(
    rawBaseSignal: vec3f,
    rawEnhancementSignal: vec3f,
    enhancementPresent: bool
) -> vec3f {
    if (!hasCompatibleDolbyVisionRPU()) {
        return vec3f(0.0);
    }
    let baseLayerBitDepth = dolbyVisionRPU.words[
        ${DOLBY_VISION_RPU_BASE_LAYER_BIT_DEPTH_WORD_OFFSET}
    ];
    if (baseLayerBitDepth < 8u || baseLayerBitDepth > 16u) {
        return vec3f(0.0);
    }
    let codeValueCount = exp2(f32(baseLayerBitDepth));
    let sourceSignal = clamp(rawBaseSignal / (codeValueCount - 1.0), vec3f(0.0), vec3f(1.0));
    var reshapedSignal = vec3f(
        reshapeDolbyVisionComponent(sourceSignal, 0u),
        reshapeDolbyVisionComponent(sourceSignal, 1u),
        reshapeDolbyVisionComponent(sourceSignal, 2u)
    );
    if (enhancementPresent && isDolbyVisionFEL()) {
        reshapedSignal = applyDolbyVisionEnhancementResidual(
            reshapedSignal,
            rawEnhancementSignal
        );
    }
    let offsetScale = codeValueCount / (codeValueCount - 1.0);
    let nonlinearOffset = vec3f(
        loadDolbyVisionFloat(${DOLBY_VISION_RPU_COLOR_WORD_OFFSET}u),
        loadDolbyVisionFloat(${DOLBY_VISION_RPU_COLOR_WORD_OFFSET + 1}u),
        loadDolbyVisionFloat(${DOLBY_VISION_RPU_COLOR_WORD_OFFSET + 2}u)
    ) * offsetScale;
    let nonlinearRGB = multiplyDolbyVisionMatrix(
        ${DOLBY_VISION_RPU_COLOR_WORD_OFFSET + 4}u,
        reshapedSignal - nonlinearOffset
    );
    let linearizedSignal = vec3f(
        applyDolbyVisionPQEOTF(nonlinearRGB.r),
        applyDolbyVisionPQEOTF(nonlinearRGB.g),
        applyDolbyVisionPQEOTF(nonlinearRGB.b)
    );
    let linearLMS = multiplyDolbyVisionMatrix(
        ${DOLBY_VISION_RPU_COLOR_WORD_OFFSET + 16}u,
        linearizedSignal
    );
    let linearBT2020 = vec3f(
        dot(vec3f(3.06441879, -2.16597676, 0.10155818), linearLMS),
        dot(vec3f(-0.65612108, 1.78554118, -0.12943749), linearLMS),
        dot(vec3f(0.01736321, -0.04725154, 1.03004253), linearLMS)
    );
    return vec3f(
        applyDolbyVisionPQOETF(linearBT2020.r),
        applyDolbyVisionPQOETF(linearBT2020.g),
        applyDolbyVisionPQOETF(linearBT2020.b)
    );
}


fn reconstructDolbyVisionBT2020PQ(rawBaseSignal: vec3f) -> vec3f {
    return reconstructDolbyVisionBT2020PQWithEnhancement(
        rawBaseSignal,
        vec3f(0.0),
        false
    );
}
`;
}
