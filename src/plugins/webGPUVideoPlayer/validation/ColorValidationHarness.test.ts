import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type InputColorMetadata
} from '../color/ColorMetadata';
import {
    createTransferValidationRamp,
    type ColorRampSample,
    type ColorValidationRamp
} from '../color/ColorValidation';
import { type ColorTriplet } from '../color/ColorPipeline';
import {
    GPUCanvasColorValidationHarness,
    type BrowserColorMetadata
} from './ColorValidationHarness';
import {
    COPY_BYTES_PER_ROW_ALIGNMENT,
    GPUCanvasPixelReader
} from './GPUCanvasReadback';

type MockFunction = ReturnType<typeof vi.fn>;

type Deferred = {
    promise: Promise<void>
    resolve: () => void
};

type GPUHarness = {
    bufferDestroy: MockFunction
    bufferDescriptors: GPUBufferDescriptor[]
    configure: MockFunction
    context: GPUCanvasContext
    copyTextureToBuffer: MockFunction
    device: GPUDevice
    mapAsync: MockFunction
    texture: GPUTexture
    unconfigure: MockFunction
};

const originalGPUBufferUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUBufferUsage');
const originalGPUMapMode = Object.getOwnPropertyDescriptor(globalThis, 'GPUMapMode');
const originalGPUTextureUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUTextureUsage');

const browserMetadata: BrowserColorMetadata = {
    colorGamut: 'display-p3',
    dynamicRange: 'high',
    language: 'en-US',
    secureContext: true,
    userAgent: 'Validation Browser'
};

function createDeferred(): Deferred {
    let resolvePromise: () => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    const promise = new Promise<void>(resolve => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

function restoreProperty(
    propertyName: 'GPUBufferUsage' | 'GPUMapMode' | 'GPUTextureUsage',
    descriptor: PropertyDescriptor | undefined
): void {
    if (descriptor) {
        Object.defineProperty(globalThis, propertyName, descriptor);
    } else {
        Reflect.deleteProperty(globalThis, propertyName);
    }
}

function encodeFloat16(value: number): number {
    if (Number.isNaN(value)) {
        return 0x7e00;
    }
    const sign = value < 0 ? 0x8000 : 0;
    const absoluteValue = Math.abs(value);
    if (absoluteValue === 0) {
        return sign;
    }
    if (absoluteValue >= 65_504) {
        return sign | 0x7bff;
    }

    let exponent = Math.floor(Math.log2(absoluteValue));
    let significand: number;
    if (exponent < -14) {
        significand = Math.round(absoluteValue / (2 ** -24));
        return sign | Math.min(significand, 0x03ff);
    }

    significand = Math.round(((absoluteValue / (2 ** exponent)) - 1) * 1024);
    if (significand === 1024) {
        exponent += 1;
        significand = 0;
    }
    return sign | ((exponent + 15) << 10) | significand;
}

function encodeRGBA16Float(linearRGB: ColorTriplet): Uint8Array {
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, encodeFloat16(linearRGB[0]), true);
    view.setUint16(2, encodeFloat16(linearRGB[1]), true);
    view.setUint16(4, encodeFloat16(linearRGB[2]), true);
    view.setUint16(6, encodeFloat16(1), true);
    return bytes;
}

function encodeRGBA8(linearRGB: ColorTriplet): Uint8Array {
    return new Uint8Array([
        Math.round(linearRGB[0] * 255),
        Math.round(linearRGB[1] * 255),
        Math.round(linearRGB[2] * 255),
        255
    ]);
}

function createGPUHarness(
    pixels: readonly Uint8Array[],
    mapPromise?: Promise<void>,
    textureUsage = 0x05,
    textureFormat: GPUTextureFormat = 'rgba16float'
): GPUHarness {
    const bufferDescriptors: GPUBufferDescriptor[] = [];
    const bufferDestroy = vi.fn();
    const mapAsync = vi.fn(() => mapPromise ?? Promise.resolve());
    let bufferIndex = 0;
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor): GPUBuffer => {
        bufferDescriptors.push(descriptor);
        const mappedBytes = new Uint8Array(Number(descriptor.size));
        mappedBytes.set(pixels[bufferIndex] ?? new Uint8Array(8));
        bufferIndex += 1;
        return {
            destroy: bufferDestroy,
            getMappedRange: vi.fn(() => mappedBytes.buffer),
            label: descriptor.label ?? '',
            mapAsync,
            unmap: vi.fn()
        } as unknown as GPUBuffer;
    });
    const copyTextureToBuffer = vi.fn();
    const finish = vi.fn(() => ({} as GPUCommandBuffer));
    const device = {
        createBuffer,
        createCommandEncoder: vi.fn(() => ({ copyTextureToBuffer, finish })),
        features: new Set<GPUFeatureName>([ 'float32-filterable' ]),
        label: 'Validation Device',
        limits: { maxTextureDimension2D: 8_192 },
        popErrorScope: vi.fn(() => Promise.resolve(null)),
        pushErrorScope: vi.fn(),
        queue: { submit: vi.fn() }
    } as unknown as GPUDevice;
    const texture = {
        format: textureFormat,
        height: 8,
        usage: textureUsage,
        width: 8
    } as unknown as GPUTexture;
    const configure = vi.fn();
    const unconfigure = vi.fn();
    const context = {
        configure,
        getCurrentTexture: vi.fn(() => texture),
        unconfigure
    } as unknown as GPUCanvasContext;
    return {
        bufferDestroy,
        bufferDescriptors,
        configure,
        context,
        copyTextureToBuffer,
        device,
        mapAsync,
        texture,
        unconfigure
    };
}

function createHarness(
    ramp: ColorValidationRamp,
    pixels: readonly Uint8Array[],
    format: GPUTextureFormat,
    harnessOverrides: Partial<GPUHarness> = {}
): { gpuHarness: GPUHarness; harness: GPUCanvasColorValidationHarness } {
    const baseHarness = createGPUHarness(pixels, undefined, 0x05, format);
    const gpuHarness: GPUHarness = { ...baseHarness, ...harnessOverrides };
    const canvas = document.createElement('canvas');
    canvas.width = 8;
    canvas.height = 8;
    const harness = new GPUCanvasColorValidationHarness({
        adapterInfo: {
            architecture: 'test-architecture',
            description: 'Test GPU',
            device: 'test-device',
            vendor: 'test-vendor'
        },
        browserMetadata,
        canvas,
        canvasConfiguration: {
            colorSpace: 'display-p3',
            format,
            toneMapping: { mode: 'extended' }
        },
        context: gpuHarness.context,
        device: gpuHarness.device,
        ramp
    });
    return { gpuHarness, harness };
}

async function captureRamp(
    harness: GPUCanvasColorValidationHarness,
    ramp: ColorValidationRamp
): Promise<void> {
    for (const sample of ramp.samples) {
        await harness.captureCurrentFrame({
            frame: {
                videoColorSpace: {
                    fullRange: ramp.metadata.range === 'full',
                    matrix: ramp.metadata.matrix,
                    primaries: ramp.metadata.primaries,
                    transfer: ramp.metadata.transfer
                }
            },
            timestampMicroseconds: sample.timestampMicroseconds
        });
    }
}

function expectedPixels(
    ramp: ColorValidationRamp,
    selectRGB: (sample: ColorRampSample) => ColorTriplet,
    encode: (linearRGB: ColorTriplet) => Uint8Array
): Uint8Array[] {
    const pixels: Uint8Array[] = [];
    for (const sample of ramp.samples) {
        pixels.push(encode(selectRGB(sample)));
    }
    return pixels;
}

beforeEach(() => {
    const bufferUsage: Record<string, number> = {};
    bufferUsage['COPY_DST'] = 0x08;
    bufferUsage['MAP_READ'] = 0x01;
    Object.defineProperty(globalThis, 'GPUBufferUsage', {
        configurable: true,
        value: bufferUsage
    });
    Object.defineProperty(globalThis, 'GPUMapMode', {
        configurable: true,
        value: { READ: 0x01 }
    });
    const textureUsage: Record<string, number> = {};
    textureUsage['COPY_SRC'] = 0x01;
    textureUsage['RENDER_ATTACHMENT'] = 0x10;
    Object.defineProperty(globalThis, 'GPUTextureUsage', {
        configurable: true,
        value: textureUsage
    });
});

afterEach(() => {
    restoreProperty('GPUBufferUsage', originalGPUBufferUsage);
    restoreProperty('GPUMapMode', originalGPUMapMode);
    restoreProperty('GPUTextureUsage', originalGPUTextureUsage);
});

describe('GPUCanvasColorValidationHarness', () => {
    it.each([
        [ 'SDR', createSDRColorMetadata(), 'rgba8unorm', encodeRGBA8 ],
        [ 'PQ', createPQColorMetadata(), 'rgba16float', encodeRGBA16Float ],
        [ 'HLG', createHLGColorMetadata(), 'rgba16float', encodeRGBA16Float ]
    ] as const)(
        'accepts a known %s ramp and reports browser, GPU, canvas, and frame metadata',
        async (
            _name: string,
            metadata: InputColorMetadata,
            format: GPUTextureFormat,
            encode: (linearRGB: ColorTriplet) => Uint8Array
        ) => {
            const ramp = createTransferValidationRamp(metadata);
            const pixels = expectedPixels(ramp, sample => sample.expectedLinearRGB, encode);
            const { gpuHarness, harness } = createHarness(ramp, pixels, format);

            await captureRamp(harness, ramp);
            const decision = harness.evaluate();

            expect(decision).toMatchObject({
                browser: browserMetadata,
                canvas: {
                    colorSpace: 'display-p3',
                    format,
                    toneMappingMode: 'extended'
                },
                capability: 'supported',
                classification: 'valid',
                gpu: {
                    architecture: 'test-architecture',
                    deviceLabel: 'Validation Device',
                    maximumTextureDimension2D: 8_192,
                    vendor: 'test-vendor'
                },
                readbackFailure: null
            });
            expect(decision.frames).toHaveLength(ramp.samples.length);
            expect(decision.frames[0]).toMatchObject({
                inputColorMetadata: metadata,
                timestampMicroseconds: ramp.samples[0].timestampMicroseconds,
                videoColorSpace: { transfer: metadata.transfer }
            });
            expect(gpuHarness.configure).toHaveBeenCalledWith(expect.objectContaining({
                usage: 0x11
            }));
            expect(gpuHarness.bufferDescriptors.every(
                (descriptor: GPUBufferDescriptor): boolean => descriptor.size
                    === COPY_BYTES_PER_ROW_ALIGNMENT
            )).toBe(true);
            expect(gpuHarness.copyTextureToBuffer).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ bytesPerRow: COPY_BYTES_PER_ROW_ALIGNMENT }),
                { depthOrArrayLayers: 1, height: 1, width: 1 }
            );

            harness.destroy();
            harness.destroy();
            expect(gpuHarness.unconfigure).toHaveBeenCalledTimes(1);
            expect(gpuHarness.bufferDestroy).toHaveBeenCalledTimes(ramp.samples.length);
        }
    );

    it.each([
        [
            'clamped',
            createPQColorMetadata(),
            (sample: ColorRampSample): ColorTriplet => [
                Math.min(Math.max(sample.expectedLinearRGB[0], 0), 1),
                Math.min(Math.max(sample.expectedLinearRGB[1], 0), 1),
                Math.min(Math.max(sample.expectedLinearRGB[2], 0), 1)
            ]
        ],
        [
            'double-transformed',
            createSDRColorMetadata(),
            (sample: ColorRampSample): ColorTriplet => sample.doubleTransformedLinearRGB
        ],
        [
            'mismatch',
            createHLGColorMetadata(),
            (): ColorTriplet => [ 0.123, 0.456, 0.789 ]
        ]
    ] as const)(
        'rejects a %s browser color path',
        async (
            classification: string,
            metadata: InputColorMetadata,
            selectRGB: (sample: ColorRampSample) => ColorTriplet
        ) => {
            const ramp = createTransferValidationRamp(metadata);
            const pixels = expectedPixels(ramp, selectRGB, encodeRGBA16Float);
            const { harness } = createHarness(ramp, pixels, 'rgba16float');

            await captureRamp(harness, ramp);

            expect(harness.evaluate()).toMatchObject({
                capability: 'unsupported',
                classification
            });
            harness.destroy();
        }
    );

    it('returns an unavailable decision when the canvas texture cannot be copied', async () => {
        const ramp = createTransferValidationRamp(createSDRColorMetadata());
        const gpuHarness = createGPUHarness(
            [ encodeRGBA8([ 0, 0, 0 ]) ],
            undefined,
            0x10,
            'rgba8unorm'
        );
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 8;
        const harness = new GPUCanvasColorValidationHarness({
            browserMetadata,
            canvas,
            canvasConfiguration: { format: 'rgba8unorm' },
            configureCanvas: false,
            context: gpuHarness.context,
            device: gpuHarness.device,
            ramp
        });

        const capture = await harness.captureCurrentFrame({
            timestampMicroseconds: ramp.samples[0].timestampMicroseconds
        });

        expect(capture.failure?.code).toBe('copy-source-disabled');
        expect(harness.evaluate()).toMatchObject({
            capability: 'unavailable',
            classification: 'readback-unavailable',
            readbackFailure: { code: 'copy-source-disabled' }
        });
        harness.destroy();
        expect(gpuHarness.unconfigure).not.toHaveBeenCalled();
    });

    it('returns an unavailable decision when mapping fails', async () => {
        const ramp = createTransferValidationRamp(createSDRColorMetadata());
        const gpuHarness = createGPUHarness(
            [ encodeRGBA8([ 0, 0, 0 ]) ],
            Promise.reject(new Error('map failed')),
            0x05,
            'rgba8unorm'
        );
        const canvas = document.createElement('canvas');
        canvas.width = 8;
        canvas.height = 8;
        const harness = new GPUCanvasColorValidationHarness({
            browserMetadata,
            canvas,
            canvasConfiguration: { format: 'rgba8unorm' },
            context: gpuHarness.context,
            device: gpuHarness.device,
            ramp
        });

        await harness.captureCurrentFrame({
            timestampMicroseconds: ramp.samples[0].timestampMicroseconds
        });

        expect(harness.evaluate()).toMatchObject({
            capability: 'unavailable',
            classification: 'readback-unavailable',
            readbackFailure: { code: 'mapping-failed', message: 'map failed' }
        });
        expect(gpuHarness.bufferDestroy).toHaveBeenCalledTimes(1);
        harness.destroy();
    });

    it('destroys an outstanding readback buffer and rejects captures after cleanup', async () => {
        const deferred = createDeferred();
        const gpuHarness = createGPUHarness(
            [ encodeRGBA8([ 0, 0, 0 ]) ],
            deferred.promise,
            0x05,
            'rgba8unorm'
        );
        const reader = new GPUCanvasPixelReader({
            context: gpuHarness.context,
            device: gpuHarness.device,
            format: 'rgba8unorm',
            maximumReadbacks: 1
        });

        const pendingCapture = reader.readPixel(0, 0);
        reader.destroy();
        deferred.resolve();

        await expect(pendingCapture).resolves.toMatchObject({
            failure: { code: 'destroyed' },
            linearRGB: null
        });
        await expect(reader.readPixel(0, 0)).resolves.toMatchObject({
            failure: { code: 'destroyed' },
            linearRGB: null
        });
        expect(gpuHarness.bufferDestroy).toHaveBeenCalled();
    });
});
