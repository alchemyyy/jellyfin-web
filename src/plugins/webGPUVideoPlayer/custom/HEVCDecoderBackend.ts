import type {
    DecoderOptions,
    HEVCFrame,
    HEVCStreamInfo
} from '@hevcjs/core';

const DRAINED_FRAME_STRUCTURE_BYTE_LENGTH = 48;
const STREAM_INFO_STRUCTURE_BYTE_LENGTH = 24;
export const MAXIMUM_HEVC_DRAINED_FRAME_COUNT = 64;
const MAXIMUM_HEVC_CODED_HEIGHT = 2_160;
const MAXIMUM_HEVC_CODED_WIDTH = 3_840;
/** Maximum transient JS plane storage copied for one decoded 4K Main10 frame. */
export const MAXIMUM_HEVC_COPIED_FRAME_BYTE_LENGTH = (
    MAXIMUM_HEVC_CODED_WIDTH * MAXIMUM_HEVC_CODED_HEIGHT
    + (2 * Math.ceil(MAXIMUM_HEVC_CODED_WIDTH / 2) * Math.ceil(MAXIMUM_HEVC_CODED_HEIGHT / 2))
) * Uint16Array.BYTES_PER_ELEMENT;

type EmscriptenReturnType = 'number' | null;

type EmscriptenHEVCModule = {
    readonly HEAPU16: Uint16Array
    _free: (pointer: number) => void
    _malloc: (byteLength: number) => number
    cwrap: (
        name: string,
        returnType: EmscriptenReturnType,
        argumentTypes: readonly string[]
    ) => (...nativeArguments: number[]) => number
    getValue: (pointer: number, type: '*' | 'i32') => number
};

type EmscriptenHEVCModuleOptions = {
    locateFile?: (path: string, scriptDirectory: string) => string
};

type EmscriptenHEVCModuleFactory = (
    options: EmscriptenHEVCModuleOptions
) => Promise<EmscriptenHEVCModule>;

type HEVCDecoderGlobal = typeof globalThis & {
    HEVCDecoderModule?: unknown
};

type HEVCNativeAPI = {
    create: () => number
    destroy: (decoderPointer: number) => number
    drain: (decoderPointer: number, countPointer: number) => number
    feed: (decoderPointer: number, dataPointer: number, byteLength: number) => number
    flush: (decoderPointer: number) => number
    getDrainedFrame: (
        decoderPointer: number,
        frameIndex: number,
        framePointer: number
    ) => number
    getInfo: (decoderPointer: number, infoPointer: number) => number
};

type HEVCPlaneLayout = {
    height: number
    pointer: number
    stride: number
    width: number
};

type HEVCFrameLayout = {
    bitDepth: 8 | 10
    chromaBlue: HEVCPlaneLayout
    chromaHeight: number
    chromaRed: HEVCPlaneLayout
    chromaWidth: number
    height: number
    luma: HEVCPlaneLayout
    poc: number
    width: number
};

export type HEVCDecodedFrameHandler = (frame: HEVCFrame) => void;

export type HEVCDecoderBackend = {
    readonly info: HEVCStreamInfo | null
    destroy: () => void
    drain: (frameHandler: HEVCDecodedFrameHandler) => number
    feed: (data: Uint8Array) => void
    flush: (frameHandler: HEVCDecodedFrameHandler) => number
};

function requireAllocation(module: EmscriptenHEVCModule, byteLength: number): number {
    const pointer = module._malloc(byteLength);
    if (!Number.isSafeInteger(pointer) || pointer <= 0) {
        throw new Error('The HEVC WASM decoder could not allocate memory');
    }
    return pointer;
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function validatePlaneLayout(
    module: EmscriptenHEVCModule,
    pointer: number,
    width: number,
    height: number,
    stride: number
): HEVCPlaneLayout {
    const sampleCount = width * height;
    if (
        !isPositiveSafeInteger(pointer)
        || pointer % Uint16Array.BYTES_PER_ELEMENT !== 0
        || !isPositiveSafeInteger(width)
        || !isPositiveSafeInteger(height)
        || !Number.isSafeInteger(stride)
        || stride < width
        || !Number.isSafeInteger(sampleCount)
    ) {
        throw new TypeError('The HEVC WASM decoder returned an invalid plane');
    }

    const baseSampleOffset = pointer / Uint16Array.BYTES_PER_ELEMENT;
    const finalSourceEnd = baseSampleOffset + ((height - 1) * stride) + width;
    if (!Number.isSafeInteger(finalSourceEnd) || finalSourceEnd > module.HEAPU16.length) {
        throw new TypeError('The HEVC WASM decoder plane exceeds its memory');
    }
    return { height, pointer, stride, width };
}

function validateFrameLayout(
    module: EmscriptenHEVCModule,
    frameValues: {
        bitDepth: number
        chromaBluePointer: number
        chromaHeight: number
        chromaRedPointer: number
        chromaStride: number
        chromaWidth: number
        height: number
        lumaPointer: number
        lumaStride: number
        poc: number
        width: number
    }
): HEVCFrameLayout {
    if (frameValues.bitDepth !== 8 && frameValues.bitDepth !== 10) {
        throw new TypeError('The HEVC WASM decoder returned an unsupported bit depth');
    }
    if (
        !isPositiveSafeInteger(frameValues.width)
        || !isPositiveSafeInteger(frameValues.height)
        || frameValues.width > MAXIMUM_HEVC_CODED_WIDTH
        || frameValues.height > MAXIMUM_HEVC_CODED_HEIGHT
        || frameValues.chromaWidth !== Math.ceil(frameValues.width / 2)
        || frameValues.chromaHeight !== Math.ceil(frameValues.height / 2)
    ) {
        throw new TypeError('The HEVC WASM decoder returned invalid 4:2:0 dimensions');
    }

    const lumaSampleCount = frameValues.width * frameValues.height;
    const chromaSampleCount = frameValues.chromaWidth * frameValues.chromaHeight;
    const totalSampleCount = lumaSampleCount + (2 * chromaSampleCount);
    const copiedByteLength = totalSampleCount * Uint16Array.BYTES_PER_ELEMENT;
    if (
        !Number.isSafeInteger(lumaSampleCount)
        || !Number.isSafeInteger(chromaSampleCount)
        || !Number.isSafeInteger(totalSampleCount)
        || !Number.isSafeInteger(copiedByteLength)
        || copiedByteLength <= 0
        || copiedByteLength > MAXIMUM_HEVC_COPIED_FRAME_BYTE_LENGTH
    ) {
        throw new TypeError('The HEVC WASM decoder frame exceeds its memory bound');
    }

    const luma = validatePlaneLayout(
        module,
        frameValues.lumaPointer,
        frameValues.width,
        frameValues.height,
        frameValues.lumaStride
    );
    const chromaBlue = validatePlaneLayout(
        module,
        frameValues.chromaBluePointer,
        frameValues.chromaWidth,
        frameValues.chromaHeight,
        frameValues.chromaStride
    );
    const chromaRed = validatePlaneLayout(
        module,
        frameValues.chromaRedPointer,
        frameValues.chromaWidth,
        frameValues.chromaHeight,
        frameValues.chromaStride
    );
    return {
        bitDepth: frameValues.bitDepth,
        chromaBlue,
        chromaHeight: frameValues.chromaHeight,
        chromaRed,
        chromaWidth: frameValues.chromaWidth,
        height: frameValues.height,
        luma,
        poc: frameValues.poc,
        width: frameValues.width
    };
}

function copyPlane(module: EmscriptenHEVCModule, layout: HEVCPlaneLayout): Uint16Array {
    const output = new Uint16Array(layout.width * layout.height);
    const baseSampleOffset = layout.pointer / Uint16Array.BYTES_PER_ELEMENT;
    for (let rowIndex = 0; rowIndex < layout.height; rowIndex += 1) {
        const sourceOffset = baseSampleOffset + (rowIndex * layout.stride);
        output.set(
            module.HEAPU16.subarray(sourceOffset, sourceOffset + layout.width),
            rowIndex * layout.width
        );
    }
    return output;
}

class HEVCWASMDecoderBackend implements HEVCDecoderBackend {
    private decoderPointer: number;
    private readonly nativeAPI: HEVCNativeAPI;

    public constructor(private readonly module: EmscriptenHEVCModule) {
        this.nativeAPI = {
            create: module.cwrap('hevc_decoder_create', 'number', []) as () => number,
            destroy: module.cwrap(
                'hevc_decoder_destroy',
                null,
                [ 'number' ]
            ) as (decoderPointer: number) => number,
            drain: module.cwrap(
                'hevc_decoder_drain',
                'number',
                [ 'number', 'number' ]
            ) as (decoderPointer: number, countPointer: number) => number,
            feed: module.cwrap(
                'hevc_decoder_feed',
                'number',
                [ 'number', 'number', 'number' ]
            ) as (decoderPointer: number, dataPointer: number, byteLength: number) => number,
            flush: module.cwrap(
                'hevc_decoder_flush',
                'number',
                [ 'number' ]
            ) as (decoderPointer: number) => number,
            getDrainedFrame: module.cwrap(
                'hevc_decoder_get_drained_frame',
                'number',
                [ 'number', 'number', 'number' ]
            ) as (
                decoderPointer: number,
                frameIndex: number,
                framePointer: number
            ) => number,
            getInfo: module.cwrap(
                'hevc_decoder_get_info',
                'number',
                [ 'number', 'number' ]
            ) as (decoderPointer: number, infoPointer: number) => number
        };
        this.decoderPointer = this.nativeAPI.create();
        if (!isPositiveSafeInteger(this.decoderPointer)) {
            throw new Error('The HEVC WASM decoder could not create a decoder');
        }
    }

    public get info(): HEVCStreamInfo | null {
        this.requireOpen();
        const infoPointer = requireAllocation(this.module, STREAM_INFO_STRUCTURE_BYTE_LENGTH);
        try {
            if (this.nativeAPI.getInfo(this.decoderPointer, infoPointer) !== 0) {
                return null;
            }
            return {
                bitDepth: this.module.getValue(infoPointer + 8, 'i32'),
                chromaFormat: this.module.getValue(infoPointer + 12, 'i32'),
                height: this.module.getValue(infoPointer + 4, 'i32'),
                level: this.module.getValue(infoPointer + 20, 'i32'),
                profile: this.module.getValue(infoPointer + 16, 'i32'),
                width: this.module.getValue(infoPointer, 'i32')
            };
        } finally {
            this.module._free(infoPointer);
        }
    }

    public feed(data: Uint8Array): void {
        this.requireOpen();
        const dataPointer = requireAllocation(this.module, data.byteLength);
        try {
            new Uint8Array(this.module.HEAPU16.buffer).set(data, dataPointer);
            const result = this.nativeAPI.feed(
                this.decoderPointer,
                dataPointer,
                data.byteLength
            );
            if (result !== 0) {
                throw new Error(`The HEVC WASM decoder feed failed with code ${result}`);
            }
        } finally {
            this.module._free(dataPointer);
        }
    }

    public drain(frameHandler: HEVCDecodedFrameHandler): number {
        this.requireOpen();
        const countPointer = requireAllocation(this.module, 4);
        try {
            const result = this.nativeAPI.drain(this.decoderPointer, countPointer);
            if (result !== 0) {
                throw new Error(`The HEVC WASM decoder drain failed with code ${result}`);
            }
            const frameCount = this.module.getValue(countPointer, 'i32');
            if (
                !Number.isSafeInteger(frameCount)
                || frameCount < 0
                || frameCount > MAXIMUM_HEVC_DRAINED_FRAME_COUNT
            ) {
                throw new TypeError('The HEVC WASM decoder returned an invalid frame count');
            }

            for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
                const frame = this.extractDrainedFrame(frameIndex);
                if (!frame) {
                    throw new Error('The HEVC WASM decoder omitted a reported frame');
                }
                // Deliver each copied frame before extracting the next one
                frameHandler(frame);
            }
            return frameCount;
        } finally {
            this.module._free(countPointer);
        }
    }

    public flush(frameHandler: HEVCDecodedFrameHandler): number {
        this.requireOpen();
        const result = this.nativeAPI.flush(this.decoderPointer);
        if (result !== 0) {
            throw new Error(`The HEVC WASM decoder flush failed with code ${result}`);
        }

        for (
            let frameIndex = 0;
            frameIndex <= MAXIMUM_HEVC_DRAINED_FRAME_COUNT;
            frameIndex += 1
        ) {
            const frame = this.extractDrainedFrame(frameIndex);
            if (!frame) {
                return frameIndex;
            }
            if (frameIndex === MAXIMUM_HEVC_DRAINED_FRAME_COUNT) {
                throw new Error('The HEVC WASM decoder flush exceeded its frame bound');
            }
            // Flush preserves display order without retaining a decoded frame batch
            frameHandler(frame);
        }
        throw new Error('The HEVC WASM decoder flush exceeded its frame bound');
    }

    public destroy(): void {
        if (this.decoderPointer === 0) {
            return;
        }
        const decoderPointer = this.decoderPointer;
        this.decoderPointer = 0;
        this.nativeAPI.destroy(decoderPointer);
    }

    private extractDrainedFrame(frameIndex: number): HEVCFrame | null {
        const framePointer = requireAllocation(
            this.module,
            DRAINED_FRAME_STRUCTURE_BYTE_LENGTH
        );
        try {
            if (
                this.nativeAPI.getDrainedFrame(
                    this.decoderPointer,
                    frameIndex,
                    framePointer
                ) !== 0
            ) {
                return null;
            }

            const lumaPointer = this.module.getValue(framePointer, '*');
            const chromaBluePointer = this.module.getValue(framePointer + 4, '*');
            const chromaRedPointer = this.module.getValue(framePointer + 8, '*');
            const width = this.module.getValue(framePointer + 12, 'i32');
            const height = this.module.getValue(framePointer + 16, 'i32');
            const lumaStride = this.module.getValue(framePointer + 20, 'i32');
            const chromaStride = this.module.getValue(framePointer + 24, 'i32');
            const chromaWidth = this.module.getValue(framePointer + 28, 'i32');
            const chromaHeight = this.module.getValue(framePointer + 32, 'i32');
            const bitDepth = this.module.getValue(framePointer + 36, 'i32');
            const poc = this.module.getValue(framePointer + 40, 'i32');
            const frameLayout = validateFrameLayout(this.module, {
                bitDepth,
                chromaBluePointer,
                chromaHeight,
                chromaRedPointer,
                chromaStride,
                chromaWidth,
                height,
                lumaPointer,
                lumaStride,
                poc,
                width
            });
            return {
                bitDepth: frameLayout.bitDepth,
                cb: copyPlane(this.module, frameLayout.chromaBlue),
                chromaHeight: frameLayout.chromaHeight,
                chromaWidth: frameLayout.chromaWidth,
                cr: copyPlane(this.module, frameLayout.chromaRed),
                height: frameLayout.height,
                poc: frameLayout.poc,
                width: frameLayout.width,
                y: copyPlane(this.module, frameLayout.luma)
            };
        } finally {
            this.module._free(framePointer);
        }
    }

    private requireOpen(): void {
        if (this.decoderPointer === 0) {
            throw new Error('The HEVC WASM decoder is destroyed');
        }
    }
}

/** Creates a decoder from the @hevcjs/core glue module loaded in this worker. */
export async function createHEVCDecoderBackend(
    options: DecoderOptions
): Promise<HEVCDecoderBackend> {
    const decoderGlobal = globalThis as HEVCDecoderGlobal;
    if (typeof decoderGlobal.HEVCDecoderModule !== 'function') {
        throw new Error('The HEVC WASM decoder module factory is unavailable');
    }

    const moduleFactory = decoderGlobal.HEVCDecoderModule as EmscriptenHEVCModuleFactory;
    const moduleOptions: EmscriptenHEVCModuleOptions = {};
    if (options.wasmBinaryUrl) {
        moduleOptions.locateFile = (): string => options.wasmBinaryUrl as string;
    }
    const module = await moduleFactory(moduleOptions);
    return new HEVCWASMDecoderBackend(module);
}
