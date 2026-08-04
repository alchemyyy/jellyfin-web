import {
    DOLBY_VISION_RPU_PACKED_COLOR_BYTE_LENGTH,
    DOLBY_VISION_RPU_PACKED_COMPONENT_BYTE_LENGTH,
    DOLBY_VISION_RPU_PACKED_COMPONENT_COUNT,
    DOLBY_VISION_RPU_PACKED_COMPONENT_MMR_OFFSET,
    DOLBY_VISION_RPU_PACKED_COMPONENT_PIVOT_OFFSET,
    DOLBY_VISION_RPU_PACKED_COMPONENT_SEGMENT_OFFSET,
    DOLBY_VISION_RPU_PACKED_HEADER_BYTE_LENGTH,
    DOLBY_VISION_RPU_PACKED_NLQ_BYTE_LENGTH,
    MAXIMUM_DOLBY_VISION_RPU_MMR_VECTOR_COUNT,
    MAXIMUM_DOLBY_VISION_RPU_PIVOT_COUNT,
    MAXIMUM_DOLBY_VISION_RPU_SEGMENT_COUNT
} from './DolbyVisionRPUDataLayout';

export const DOLBY_VISION_RPU_PARSER_WASM_ASSET =
    'libraries/libdovi/dovi-rpu-parser.wasm';
export const DOLBY_VISION_RPU_SCHEMA_VERSION = 1;
export const DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH = 3_232;
export const DOLBY_VISION_RPU_PARSER_REVISION_PREFIX = 0x38AD_EC04;
export const DOLBY_VISION_RPU_SCHEMA_MAGIC = 0x5052_5644;
export const MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH = 64 * 1_024;
export const MAXIMUM_DOLBY_VISION_RPU_PARSER_MEMORY_BYTE_LENGTH = 16 * 1_024 * 1_024;

const MAXIMUM_PARSER_ARTIFACT_BYTE_LENGTH = 2 * 1_024 * 1_024;
const MAXIMUM_PARSER_ERROR_BYTE_LENGTH = 512;
const PACKED_COMPONENT_OFFSET = DOLBY_VISION_RPU_PACKED_HEADER_BYTE_LENGTH
    + DOLBY_VISION_RPU_PACKED_COLOR_BYTE_LENGTH
    + DOLBY_VISION_RPU_PACKED_NLQ_BYTE_LENGTH;
const KNOWN_SCHEMA_FLAGS = 0x1FF;
const MISSING_UNSIGNED_INTEGER = 0xFFFF_FFFF;

const FLAG_USED_PREVIOUS_MAPPING = 1 << 0;
const FLAG_EXPLICIT_COLOR_METADATA = 1 << 1;
const FLAG_LEVEL1_METADATA = 1 << 2;
const FLAG_NLQ_PRESENT = 1 << 3;
const FLAG_NLQ_ACTIVE = 1 << 4;
const FLAG_MEL = 1 << 5;
const FLAG_FEL = 1 << 6;
const FLAG_SCENE_REFRESH = 1 << 7;
const FLAG_DEFAULT_COLOR_METADATA = 1 << 8;

type WASMFunction = (...argumentsList: number[]) => number;

type DolbyVisionRPUParserWASMExports = {
    allocate: WASMFunction
    createContext: WASMFunction
    deallocate: WASMFunction
    destroyContext: WASMFunction
    getLastErrorByteLength: WASMFunction
    getLastErrorPointer: WASMFunction
    getMaximumBufferByteLength: WASMFunction
    getMaximumMemoryByteLength: WASMFunction
    getOutputByteLength: WASMFunction
    getRevisionPrefix: WASMFunction
    getSchemaVersion: WASMFunction
    memory: WebAssembly.Memory
    parse: WASMFunction
    reset: WASMFunction
};

export type DolbyVisionRPULayerMode = 'fel' | 'mel' | 'single-layer';

export type DolbyVisionRPUComponentSummary = {
    mappingMethod: 'mmr' | 'polynomial'
    mmrVectorCount: number
    numPivots: number
    pivots: readonly number[]
};

export type DolbyVisionRPUNLQData = {
    deadzoneSlope: number
    deadzoneThreshold: number
    offset: number
    vdrInMaximum: number
};

export type DolbyVisionRPUSnapshot = {
    baseLayerBitDepth: number
    coefficientLog2Denominator: number
    components: readonly DolbyVisionRPUComponentSummary[]
    disableResidual: boolean
    enhancementLayerBitDepth: number
    explicitColorMetadata: boolean
    flags: number
    layerMode: DolbyVisionRPULayerMode
    level1AveragePQ: number | null
    level1MaximumPQ: number | null
    level1MinimumPQ: number | null
    linearMatrix: readonly number[]
    mappingID: number
    nonlinearMatrix: readonly number[]
    nonlinearOffset: readonly number[]
    nlq: readonly DolbyVisionRPUNLQData[]
    nlqActive: boolean
    packedData: ArrayBuffer
    parserRevisionPrefix: number
    previousMappingID: number | null
    profile: number
    sceneRefresh: boolean
    schemaVersion: number
    signalBitDepth: number
    sourceMaximumPQ: number
    sourceMinimumPQ: number
    usedPreviousMapping: boolean
    vdrBitDepth: number
};

export type DolbyVisionRPUParserDependencies = {
    loadInstance: (wasmURL: string) => Promise<WebAssembly.Instance>
};

/** Reports one bounded libdovi parser failure with its stable status code. */
export class DolbyVisionRPUParseError extends Error {
    public constructor(
        public readonly statusCode: number,
        message: string
    ) {
        super(message);
        this.name = 'DolbyVisionRPUParseError';
    }
}

async function loadDefaultInstance(wasmURL: string): Promise<WebAssembly.Instance> {
    const response = await fetch(wasmURL);
    if (!response.ok) {
        throw new Error(`Dolby Vision parser request failed with HTTP ${response.status}`);
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_PARSER_ARTIFACT_BYTE_LENGTH) {
        throw new Error('Dolby Vision parser artifact exceeds its byte bound');
    }
    const result = await WebAssembly.instantiate(bytes, {});
    return result.instance;
}

const DEFAULT_DEPENDENCIES: DolbyVisionRPUParserDependencies = {
    loadInstance: loadDefaultInstance
};

/** Resolves the copied parser artifact against the active Jellyfin frontend. */
export function resolveDolbyVisionRPUParserWASMURL(
    baseURL: string | undefined = globalThis.location?.href
): string {
    return baseURL ?
        new URL(DOLBY_VISION_RPU_PARSER_WASM_ASSET, baseURL).href :
        DOLBY_VISION_RPU_PARSER_WASM_ASSET;
}

function getWASMFunction(
    exportsValue: Record<string, unknown>,
    name: string
): WASMFunction {
    if (typeof exportsValue[name] !== 'function') {
        throw new TypeError(`Dolby Vision parser export ${name} is missing`);
    }
    return exportsValue[name] as WASMFunction;
}

function requireParserExports(instance: WebAssembly.Instance): DolbyVisionRPUParserWASMExports {
    const exportsValue = instance.exports as unknown as Record<string, unknown>;
    if (!(exportsValue.memory instanceof WebAssembly.Memory)) {
        throw new TypeError('Dolby Vision parser memory export is missing');
    }
    return {
        allocate: getWASMFunction(exportsValue, 'dovi_parser_allocate'),
        createContext: getWASMFunction(exportsValue, 'dovi_parser_create'),
        deallocate: getWASMFunction(exportsValue, 'dovi_parser_deallocate'),
        destroyContext: getWASMFunction(exportsValue, 'dovi_parser_destroy'),
        getLastErrorByteLength: getWASMFunction(
            exportsValue,
            'dovi_parser_last_error_byte_length'
        ),
        getLastErrorPointer: getWASMFunction(
            exportsValue,
            'dovi_parser_last_error_pointer'
        ),
        getMaximumBufferByteLength: getWASMFunction(
            exportsValue,
            'dovi_parser_maximum_buffer_byte_length'
        ),
        getMaximumMemoryByteLength: getWASMFunction(
            exportsValue,
            'dovi_parser_maximum_memory_byte_length'
        ),
        getOutputByteLength: getWASMFunction(
            exportsValue,
            'dovi_parser_output_byte_length'
        ),
        getRevisionPrefix: getWASMFunction(
            exportsValue,
            'dovi_parser_revision_prefix'
        ),
        getSchemaVersion: getWASMFunction(
            exportsValue,
            'dovi_parser_schema_version'
        ),
        memory: exportsValue.memory,
        parse: getWASMFunction(exportsValue, 'dovi_parser_parse'),
        reset: getWASMFunction(exportsValue, 'dovi_parser_reset')
    };
}

function requireInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${name} is not a non-negative safe integer`);
    }
    return value;
}

function requireMemoryRange(
    memory: WebAssembly.Memory,
    pointerValue: number,
    byteLengthValue: number,
    name: string
): { byteLength: number, pointer: number } {
    const pointer = requireInteger(pointerValue, `${name} pointer`);
    const byteLength = requireInteger(byteLengthValue, `${name} byte length`);
    const end = pointer + byteLength;
    if (!Number.isSafeInteger(end) || end > memory.buffer.byteLength) {
        throw new RangeError(`${name} exceeds parser memory`);
    }
    return { byteLength, pointer };
}

function requireFinite(value: number, name: string): number {
    if (!Number.isFinite(value)) {
        throw new TypeError(`${name} is not finite`);
    }
    return value;
}

function readPaddedMatrix(view: DataView, byteOffset: number, name: string): number[] {
    const matrix: number[] = [];
    for (let rowIndex = 0; rowIndex < 3; rowIndex += 1) {
        for (let columnIndex = 0; columnIndex < 3; columnIndex += 1) {
            const elementOffset = byteOffset + (((rowIndex * 4) + columnIndex) * 4);
            matrix.push(requireFinite(view.getFloat32(elementOffset, true), name));
        }
    }
    return matrix;
}

function readNLQ(view: DataView): DolbyVisionRPUNLQData[] {
    const nlq: DolbyVisionRPUNLQData[] = [];
    const nlqOffset = DOLBY_VISION_RPU_PACKED_HEADER_BYTE_LENGTH
        + DOLBY_VISION_RPU_PACKED_COLOR_BYTE_LENGTH;
    for (
        let componentIndex = 0;
        componentIndex < DOLBY_VISION_RPU_PACKED_COMPONENT_COUNT;
        componentIndex += 1
    ) {
        const componentOffset = nlqOffset + (componentIndex * 16);
        nlq.push({
            deadzoneSlope: requireFinite(
                view.getFloat32(componentOffset + 4, true),
                'Dolby Vision NLQ slope'
            ),
            deadzoneThreshold: requireFinite(
                view.getFloat32(componentOffset + 8, true),
                'Dolby Vision NLQ threshold'
            ),
            offset: requireFinite(
                view.getFloat32(componentOffset, true),
                'Dolby Vision NLQ offset'
            ),
            vdrInMaximum: requireFinite(
                view.getFloat32(componentOffset + 12, true),
                'Dolby Vision NLQ VDR maximum'
            )
        });
    }
    return nlq;
}

function readComponentPivots(
    view: DataView,
    componentOffset: number,
    numPivots: number
): number[] {
    const pivots: number[] = [];
    for (let pivotIndex = 0; pivotIndex < numPivots; pivotIndex += 1) {
        const pivot = requireFinite(
            view.getFloat32(
                componentOffset
                    + DOLBY_VISION_RPU_PACKED_COMPONENT_PIVOT_OFFSET
                    + (pivotIndex * 4),
                true
            ),
            'Dolby Vision pivot'
        );
        if (
            pivot < 0
            || pivot > 1
            || (pivotIndex > 0 && pivot < pivots[pivotIndex - 1])
        ) {
            throw new TypeError('Dolby Vision packed pivots are not ordered in range');
        }
        pivots.push(pivot);
    }
    return pivots;
}

function readSegmentValues(
    view: DataView,
    componentOffset: number,
    segmentIndex: number
): number[] {
    const segmentOffset = componentOffset
        + DOLBY_VISION_RPU_PACKED_COMPONENT_SEGMENT_OFFSET
        + (segmentIndex * 16);
    const segmentValues: number[] = [];
    for (let valueIndex = 0; valueIndex < 4; valueIndex += 1) {
        segmentValues.push(requireFinite(
            view.getFloat32(segmentOffset + (valueIndex * 4), true),
            'Dolby Vision segment coefficient'
        ));
    }
    return segmentValues;
}

function validateMMRSegment(segmentValues: readonly number[], mmrVectorCount: number): void {
    const mmrIndex = segmentValues[1];
    const mmrOrder = segmentValues[3];
    if (
        !Number.isInteger(mmrIndex)
        || mmrIndex < 0
        || mmrIndex % 2 !== 0
        || !Number.isInteger(mmrOrder)
        || mmrOrder < 1
        || mmrOrder > 3
        || mmrIndex + (mmrOrder * 2) > mmrVectorCount
    ) {
        throw new TypeError('Dolby Vision MMR segment references invalid packed data');
    }
}

function validateComponentSegments(
    view: DataView,
    componentOffset: number,
    componentFlags: number,
    mmrVectorCount: number,
    segmentCount: number
): void {
    for (
        let segmentIndex = 0;
        segmentIndex < MAXIMUM_DOLBY_VISION_RPU_SEGMENT_COUNT;
        segmentIndex += 1
    ) {
        const segmentValues = readSegmentValues(view, componentOffset, segmentIndex);
        if (segmentIndex >= segmentCount) {
            continue;
        }
        if (componentFlags === 1 && segmentValues[3] !== 0) {
            throw new TypeError('Dolby Vision polynomial segment has an MMR order');
        }
        if (componentFlags === 2) {
            validateMMRSegment(segmentValues, mmrVectorCount);
        }
    }
}

function validateComponentMMRData(view: DataView, componentOffset: number): void {
    for (
        let valueIndex = 0;
        valueIndex < MAXIMUM_DOLBY_VISION_RPU_MMR_VECTOR_COUNT * 4;
        valueIndex += 1
    ) {
        requireFinite(
            view.getFloat32(
                componentOffset
                    + DOLBY_VISION_RPU_PACKED_COMPONENT_MMR_OFFSET
                    + (valueIndex * 4),
                true
            ),
            'Dolby Vision MMR coefficient'
        );
    }
}

function getComponentMappingMethod(componentFlags: number): 'mmr' | 'polynomial' {
    switch (componentFlags) {
        case 1:
            return 'polynomial';
        case 2:
            return 'mmr';
        default:
            throw new TypeError('Dolby Vision packed component method is invalid');
    }
}

function readComponent(
    view: DataView,
    componentIndex: number
): DolbyVisionRPUComponentSummary {
    const componentOffset = PACKED_COMPONENT_OFFSET
        + (componentIndex * DOLBY_VISION_RPU_PACKED_COMPONENT_BYTE_LENGTH);
    const numPivots = view.getUint32(componentOffset, true);
    const mmrVectorCount = view.getUint32(componentOffset + 4, true);
    const componentFlags = view.getUint32(componentOffset + 8, true);
    if (numPivots < 2 || numPivots > MAXIMUM_DOLBY_VISION_RPU_PIVOT_COUNT) {
        throw new TypeError('Dolby Vision packed pivot count is invalid');
    }
    if (
        mmrVectorCount > MAXIMUM_DOLBY_VISION_RPU_MMR_VECTOR_COUNT
        || mmrVectorCount % 2 !== 0
    ) {
        throw new TypeError('Dolby Vision packed MMR vector count is invalid');
    }
    const mappingMethod = getComponentMappingMethod(componentFlags);
    const pivots = readComponentPivots(view, componentOffset, numPivots);
    validateComponentSegments(
        view,
        componentOffset,
        componentFlags,
        mmrVectorCount,
        numPivots - 1
    );
    validateComponentMMRData(view, componentOffset);

    return {
        mappingMethod,
        mmrVectorCount,
        numPivots,
        pivots
    };
}

function readOptionalUnsignedInteger(value: number): number | null {
    return value === MISSING_UNSIGNED_INTEGER ? null : value;
}

type ValidatedSnapshotFlags = {
    explicitColorMetadata: boolean
    fel: boolean
    layerMode: DolbyVisionRPULayerMode
    mel: boolean
};

function resolveLayerMode(mel: boolean, fel: boolean): DolbyVisionRPULayerMode {
    if (mel && fel) {
        throw new TypeError('Dolby Vision RPU layer flags are contradictory');
    }
    if (mel) {
        return 'mel';
    }
    if (fel) {
        return 'fel';
    }
    return 'single-layer';
}

function validateSnapshotFlags(profile: number, flags: number): ValidatedSnapshotFlags {
    if (![ 5, 7, 8 ].includes(profile)) {
        throw new TypeError('Dolby Vision RPU profile is invalid');
    }
    const mel = (flags & FLAG_MEL) !== 0;
    const fel = (flags & FLAG_FEL) !== 0;
    const layerMode = resolveLayerMode(mel, fel);
    const explicitColorMetadata = (flags & FLAG_EXPLICIT_COLOR_METADATA) !== 0;
    const defaultColorMetadata = (flags & FLAG_DEFAULT_COLOR_METADATA) !== 0;
    if (
        (profile === 7 && layerMode === 'single-layer')
        || (profile !== 7 && layerMode !== 'single-layer')
        || ((flags & FLAG_NLQ_ACTIVE) !== 0 && layerMode !== 'fel')
        || explicitColorMetadata === defaultColorMetadata
    ) {
        throw new TypeError('Dolby Vision RPU flags contradict its profile');
    }
    return { explicitColorMetadata, fel, layerMode, mel };
}

function validateOptionalSnapshotMetadata(
    flags: number,
    mel: boolean,
    fel: boolean,
    previousMappingID: number | null,
    level1MinimumPQ: number | null,
    level1MaximumPQ: number | null,
    level1AveragePQ: number | null
): void {
    const hasCompleteLevel1 = level1MinimumPQ !== null
        && level1MaximumPQ !== null
        && level1AveragePQ !== null;
    if (
        ((flags & FLAG_LEVEL1_METADATA) !== 0) !== hasCompleteLevel1
        || ((flags & FLAG_USED_PREVIOUS_MAPPING) !== 0) !== (previousMappingID !== null)
        || ((flags & FLAG_NLQ_PRESENT) === 0 && (mel || fel))
    ) {
        throw new TypeError('Dolby Vision optional metadata flags are inconsistent');
    }
}

/** Checks the fixed fields needed to safely transport a parser snapshot. */
export function hasCompatibleDolbyVisionRPUSnapshotHeader(
    packedData: unknown
): packedData is ArrayBuffer {
    if (!(packedData instanceof ArrayBuffer)
        || packedData.byteLength !== DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH) {
        return false;
    }
    const view = new DataView(packedData);
    const magic = view.getUint32(0, true);
    const schemaVersion = view.getUint32(4, true);
    const declaredByteLength = view.getUint32(8, true);
    const flags = view.getUint32(12, true);
    const parserRevisionPrefix = view.getUint32(16, true);
    return magic === DOLBY_VISION_RPU_SCHEMA_MAGIC
        && schemaVersion === DOLBY_VISION_RPU_SCHEMA_VERSION
        && declaredByteLength === packedData.byteLength
        && parserRevisionPrefix === DOLBY_VISION_RPU_PARSER_REVISION_PREFIX
        && (flags & ~KNOWN_SCHEMA_FLAGS) === 0;
}

/** Validates and decodes one owned schema-versioned parser snapshot. */
export function decodeDolbyVisionRPUSnapshot(packedData: ArrayBuffer): DolbyVisionRPUSnapshot {
    if (!(packedData instanceof ArrayBuffer)
        || packedData.byteLength !== DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH) {
        throw new TypeError('Dolby Vision RPU snapshot has an invalid byte length');
    }
    if (!hasCompatibleDolbyVisionRPUSnapshotHeader(packedData)) {
        throw new TypeError('Dolby Vision RPU snapshot header is incompatible');
    }
    const view = new DataView(packedData);
    const schemaVersion = view.getUint32(4, true);
    const flags = view.getUint32(12, true);
    const parserRevisionPrefix = view.getUint32(16, true);

    const profile = view.getUint32(20, true);
    const validatedFlags = validateSnapshotFlags(profile, flags);

    const components: DolbyVisionRPUComponentSummary[] = [];
    for (
        let componentIndex = 0;
        componentIndex < DOLBY_VISION_RPU_PACKED_COMPONENT_COUNT;
        componentIndex += 1
    ) {
        components.push(readComponent(view, componentIndex));
    }
    const nonlinearOffset: number[] = [];
    for (let componentIndex = 0; componentIndex < 3; componentIndex += 1) {
        nonlinearOffset.push(requireFinite(
            view.getFloat32(
                DOLBY_VISION_RPU_PACKED_HEADER_BYTE_LENGTH + (componentIndex * 4),
                true
            ),
            'Dolby Vision nonlinear offset'
        ));
    }
    const nonlinearMatrix = readPaddedMatrix(
        view,
        DOLBY_VISION_RPU_PACKED_HEADER_BYTE_LENGTH + 16,
        'Dolby Vision nonlinear matrix'
    );
    const linearMatrix = readPaddedMatrix(
        view,
        DOLBY_VISION_RPU_PACKED_HEADER_BYTE_LENGTH + 64,
        'Dolby Vision linear matrix'
    );
    const previousMappingID = readOptionalUnsignedInteger(view.getUint32(88, true));
    const level1MinimumPQ = readOptionalUnsignedInteger(view.getUint32(152, true));
    const level1MaximumPQ = readOptionalUnsignedInteger(view.getUint32(156, true));
    const level1AveragePQ = readOptionalUnsignedInteger(view.getUint32(160, true));
    validateOptionalSnapshotMetadata(
        flags,
        validatedFlags.mel,
        validatedFlags.fel,
        previousMappingID,
        level1MinimumPQ,
        level1MaximumPQ,
        level1AveragePQ
    );

    return {
        baseLayerBitDepth: view.getUint32(48, true),
        coefficientLog2Denominator: view.getUint32(44, true),
        components,
        disableResidual: view.getUint32(80, true) !== 0,
        enhancementLayerBitDepth: view.getUint32(52, true),
        explicitColorMetadata: validatedFlags.explicitColorMetadata,
        flags,
        layerMode: validatedFlags.layerMode,
        level1AveragePQ,
        level1MaximumPQ,
        level1MinimumPQ,
        linearMatrix,
        mappingID: view.getUint32(84, true),
        nonlinearMatrix,
        nonlinearOffset,
        nlq: readNLQ(view),
        nlqActive: (flags & FLAG_NLQ_ACTIVE) !== 0,
        packedData,
        parserRevisionPrefix,
        previousMappingID,
        profile,
        sceneRefresh: (flags & FLAG_SCENE_REFRESH) !== 0,
        schemaVersion,
        signalBitDepth: view.getUint32(124, true),
        sourceMaximumPQ: view.getUint32(144, true),
        sourceMinimumPQ: view.getUint32(140, true),
        usedPreviousMapping: (flags & FLAG_USED_PREVIOUS_MAPPING) !== 0,
        vdrBitDepth: view.getUint32(56, true)
    };
}

/** Owns one bounded, stateful libdovi WASM parser instance. */
export default class DolbyVisionRPUParser {
    private closed = false;

    private constructor(
        private readonly parserExports: DolbyVisionRPUParserWASMExports,
        private readonly contextPointer: number,
        private readonly inputPointer: number,
        private readonly outputPointer: number
    ) {}

    /** Loads and validates the exact pinned parser ABI. */
    public static async create(
        wasmURL: string,
        dependencies: DolbyVisionRPUParserDependencies = DEFAULT_DEPENDENCIES
    ): Promise<DolbyVisionRPUParser> {
        const instance = await dependencies.loadInstance(wasmURL);
        const parserExports = requireParserExports(instance);
        if (
            parserExports.getSchemaVersion() !== DOLBY_VISION_RPU_SCHEMA_VERSION
            || parserExports.getRevisionPrefix()
                !== DOLBY_VISION_RPU_PARSER_REVISION_PREFIX
            || parserExports.getOutputByteLength()
                !== DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH
            || parserExports.getMaximumBufferByteLength()
                !== MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH
            || parserExports.getMaximumMemoryByteLength()
                !== MAXIMUM_DOLBY_VISION_RPU_PARSER_MEMORY_BYTE_LENGTH
        ) {
            throw new TypeError('Dolby Vision parser ABI does not match the player');
        }

        const contextPointer = requireInteger(
            parserExports.createContext(),
            'Dolby Vision parser context pointer'
        );
        if (contextPointer === 0) {
            throw new Error('Dolby Vision parser context allocation failed');
        }
        let inputPointer = 0;
        let outputPointer = 0;
        try {
            inputPointer = requireInteger(
                parserExports.allocate(
                    MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH
                ),
                'Dolby Vision parser input pointer'
            );
            outputPointer = requireInteger(
                parserExports.allocate(DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH),
                'Dolby Vision parser output pointer'
            );
            if (inputPointer === 0 || outputPointer === 0) {
                throw new Error('Dolby Vision parser buffer allocation failed');
            }
            requireMemoryRange(
                parserExports.memory,
                inputPointer,
                MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH,
                'Dolby Vision parser input'
            );
            requireMemoryRange(
                parserExports.memory,
                outputPointer,
                DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
                'Dolby Vision parser output'
            );
            return new DolbyVisionRPUParser(
                parserExports,
                contextPointer,
                inputPointer,
                outputPointer
            );
        } catch (error) {
            if (outputPointer !== 0) {
                parserExports.deallocate(
                    outputPointer,
                    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH
                );
            }
            if (inputPointer !== 0) {
                parserExports.deallocate(
                    inputPointer,
                    MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH
                );
            }
            parserExports.destroyContext(contextPointer);
            throw error;
        }
    }

    /** Parses one RPU in decode order and returns an owned immutable snapshot. */
    public parse(rpuNALUnit: Uint8Array): DolbyVisionRPUSnapshot {
        this.requireOpen();
        if (!(rpuNALUnit instanceof Uint8Array)
            || rpuNALUnit.byteLength === 0
            || rpuNALUnit.byteLength > MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH) {
            throw new TypeError('Dolby Vision RPU input exceeds its byte bound');
        }
        const inputRange = requireMemoryRange(
            this.parserExports.memory,
            this.inputPointer,
            rpuNALUnit.byteLength,
            'Dolby Vision parser input'
        );
        const inputView = new Uint8Array(
            this.parserExports.memory.buffer,
            inputRange.pointer,
            inputRange.byteLength
        );
        inputView.set(rpuNALUnit);
        try {
            const statusCode = this.parserExports.parse(
                this.contextPointer,
                this.inputPointer,
                rpuNALUnit.byteLength,
                this.outputPointer,
                DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH
            );
            if (statusCode !== 0) {
                throw new DolbyVisionRPUParseError(
                    statusCode,
                    this.readLastError() || `Dolby Vision parser failed with status ${statusCode}`
                );
            }
            const outputRange = requireMemoryRange(
                this.parserExports.memory,
                this.outputPointer,
                DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
                'Dolby Vision parser output'
            );
            const packedData = new Uint8Array(
                this.parserExports.memory.buffer,
                outputRange.pointer,
                outputRange.byteLength
            ).slice().buffer;
            return decodeDolbyVisionRPUSnapshot(packedData);
        } finally {
            new Uint8Array(
                this.parserExports.memory.buffer,
                this.inputPointer,
                rpuNALUnit.byteLength
            ).fill(0);
        }
    }

    /** Clears all prior-mapping state at seek and generation boundaries. */
    public reset(): void {
        this.requireOpen();
        const statusCode = this.parserExports.reset(this.contextPointer);
        if (statusCode !== 0) {
            throw new DolbyVisionRPUParseError(
                statusCode,
                'Dolby Vision parser reset failed'
            );
        }
    }

    /** Releases the parser context and both fixed shared buffers exactly once. */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        this.parserExports.deallocate(
            this.outputPointer,
            DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH
        );
        this.parserExports.deallocate(
            this.inputPointer,
            MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH
        );
        this.parserExports.destroyContext(this.contextPointer);
    }

    private readLastError(): string {
        const byteLength = this.parserExports.getLastErrorByteLength(
            this.contextPointer
        );
        if (byteLength === 0) {
            return '';
        }
        if (byteLength > MAXIMUM_PARSER_ERROR_BYTE_LENGTH) {
            return 'Dolby Vision parser returned an oversized diagnostic';
        }
        const pointer = this.parserExports.getLastErrorPointer(
            this.contextPointer
        );
        const range = requireMemoryRange(
            this.parserExports.memory,
            pointer,
            byteLength,
            'Dolby Vision parser diagnostic'
        );
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        return new TextDecoder().decode(new Uint8Array(
            this.parserExports.memory.buffer,
            range.pointer,
            range.byteLength
        ));
    }

    private requireOpen(): void {
        if (this.closed) {
            throw new Error('Dolby Vision parser is closed');
        }
    }
}
