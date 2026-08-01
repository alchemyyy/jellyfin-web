import { type ColorTriplet } from '../color/ColorPipeline';
import {
    microsecondsToMilliseconds,
    millisecondsToMicroseconds
} from '../MediaTime';

export const COPY_BYTES_PER_ROW_ALIGNMENT = 256;
export const GPU_CANVAS_READBACK_TIMEOUT_MICROSECONDS = millisecondsToMicroseconds(5_000);
const GPU_CANVAS_READBACK_OPERATION_DESTROYED = Symbol('gpu-canvas-readback-operation-destroyed');
const GPU_CANVAS_READBACK_OPERATION_TIMEOUT = Symbol('gpu-canvas-readback-operation-timeout');

export type ReadableCanvasFormat =
    | 'bgra8unorm'
    | 'bgra8unorm-srgb'
    | 'rgb10a2unorm'
    | 'rgba16float'
    | 'rgba8unorm'
    | 'rgba8unorm-srgb';

export type GPUCanvasReadbackFailureCode =
    | 'capture-in-progress'
    | 'copy-source-disabled'
    | 'destroyed'
    | 'gpu-api-unavailable'
    | 'mapping-failed'
    | 'observation-limit-reached'
    | 'operation-timeout'
    | 'unsupported-format'
    | 'validation-error';

export type GPUCanvasReadbackFailure = {
    code: GPUCanvasReadbackFailureCode
    message: string
};

export type GPUCanvasPixelReadbackResult = {
    failure: GPUCanvasReadbackFailure | null
    linearRGB: ColorTriplet | null
};

export type GPUCanvasPixelReaderOptions = {
    context?: GPUCanvasContext
    device: GPUDevice
    format: GPUTextureFormat
    maximumReadbacks: number
};

type GPUUsageConstants = {
    bufferCopyDestination: GPUFlagsConstant
    bufferMapRead: GPUFlagsConstant
    mapRead: GPUFlagsConstant
    textureCopySource: GPUFlagsConstant
};

const MAXIMUM_READBACKS = 64;

function createFailure(
    code: GPUCanvasReadbackFailureCode,
    message: string
): GPUCanvasPixelReadbackResult {
    return {
        failure: { code, message },
        linearRGB: null
    };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function getUsageConstants(): GPUUsageConstants | null {
    if (typeof GPUBufferUsage === 'undefined'
        || typeof GPUMapMode === 'undefined'
        || typeof GPUTextureUsage === 'undefined') {
        return null;
    }

    return {
        bufferCopyDestination: GPUBufferUsage.COPY_DST,
        bufferMapRead: GPUBufferUsage.MAP_READ,
        mapRead: GPUMapMode.READ,
        textureCopySource: GPUTextureUsage.COPY_SRC
    };
}

function getPixelByteLength(format: ReadableCanvasFormat): number {
    switch (format) {
        case 'rgba16float':
            return 8;
        case 'bgra8unorm':
        case 'bgra8unorm-srgb':
        case 'rgb10a2unorm':
        case 'rgba8unorm':
        case 'rgba8unorm-srgb':
            return 4;
    }
}

function isReadableCanvasFormat(format: GPUTextureFormat): format is ReadableCanvasFormat {
    switch (format) {
        case 'bgra8unorm':
        case 'bgra8unorm-srgb':
        case 'rgb10a2unorm':
        case 'rgba16float':
        case 'rgba8unorm':
        case 'rgba8unorm-srgb':
            return true;
        default:
            return false;
    }
}

function decodeFloat16(value: number): number {
    const sign = (value & 0x8000) === 0 ? 1 : -1;
    const exponent = (value >> 10) & 0x1f;
    const significand = value & 0x03ff;
    switch (exponent) {
        case 0:
            return sign * (significand / 1024) * (2 ** -14);
        case 0x1f:
            return significand === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
        default:
            return sign * (1 + (significand / 1024)) * (2 ** (exponent - 15));
    }
}

function decodeSRGBComponent(encodedValue: number): number {
    if (encodedValue <= 0.04045) {
        return encodedValue / 12.92;
    }

    return ((encodedValue + 0.055) / 1.055) ** 2.4;
}

function decodeRGBA8(bytes: Uint8Array, blueFirst: boolean): ColorTriplet {
    const redIndex = blueFirst ? 2 : 0;
    const blueIndex = blueFirst ? 0 : 2;
    return [
        bytes[redIndex] / 255,
        bytes[1] / 255,
        bytes[blueIndex] / 255
    ];
}

function decodeRGB10A2(bytes: Uint8Array): ColorTriplet {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const packedValue = view.getUint32(0, true);
    return [
        (packedValue & 0x3ff) / 1023,
        ((packedValue >> 10) & 0x3ff) / 1023,
        ((packedValue >> 20) & 0x3ff) / 1023
    ];
}

function decodeRGBA16Float(bytes: Uint8Array): ColorTriplet {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return [
        decodeFloat16(view.getUint16(0, true)),
        decodeFloat16(view.getUint16(2, true)),
        decodeFloat16(view.getUint16(4, true))
    ];
}

function decodePixel(bytes: Uint8Array, format: ReadableCanvasFormat): ColorTriplet {
    let linearRGB: ColorTriplet;
    switch (format) {
        case 'bgra8unorm':
        case 'bgra8unorm-srgb':
            linearRGB = decodeRGBA8(bytes, true);
            break;
        case 'rgb10a2unorm':
            return decodeRGB10A2(bytes);
        case 'rgba16float':
            return decodeRGBA16Float(bytes);
        case 'rgba8unorm':
        case 'rgba8unorm-srgb':
            linearRGB = decodeRGBA8(bytes, false);
            break;
    }

    if (format === 'bgra8unorm-srgb' || format === 'rgba8unorm-srgb') {
        return [
            decodeSRGBComponent(linearRGB[0]),
            decodeSRGBComponent(linearRGB[1]),
            decodeSRGBComponent(linearRGB[2])
        ];
    }

    return linearRGB;
}

/** Returns the texture usage required by a renderable diagnostic target. */
export function getValidationTextureUsage(): GPUTextureUsageFlags | null {
    if (typeof GPUTextureUsage === 'undefined') {
        return null;
    }

    return GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
}

/** Returns the usage required when the diagnostic target is a canvas texture. */
export function getValidationCanvasUsage(): GPUTextureUsageFlags | null {
    return getValidationTextureUsage();
}

/** Copies one texture texel into a short-lived mapped buffer. */
export class GPUCanvasPixelReader {
    private readonly activeBuffers = new Set<GPUBuffer>();
    private readonly pendingOperationCancellations = new Set<() => void>();
    private readonly context: GPUCanvasContext | null;
    private readonly device: GPUDevice;
    private readonly format: GPUTextureFormat;
    private readonly maximumReadbacks: number;
    private captureInProgress = false;
    private destroyed = false;
    private readbackCount = 0;

    public constructor(options: GPUCanvasPixelReaderOptions) {
        if (!Number.isSafeInteger(options.maximumReadbacks)
            || options.maximumReadbacks <= 0
            || options.maximumReadbacks > MAXIMUM_READBACKS) {
            throw new RangeError('Maximum readbacks must be an integer from 1 through 64');
        }

        this.context = options.context ?? null;
        this.device = options.device;
        this.format = options.format;
        this.maximumReadbacks = options.maximumReadbacks;
    }

    /** Captures one pixel without retaining the canvas texture or mapped buffer. */
    public async readPixel(
        sampleX: number,
        sampleY: number,
        sourceTexture?: GPUTexture
    ): Promise<GPUCanvasPixelReadbackResult> {
        const preflightFailure = this.preflight(sampleX, sampleY);
        if (preflightFailure) {
            return preflightFailure;
        }

        this.captureInProgress = true;
        this.readbackCount += 1;
        try {
            return await this.copyAndMapPixel(sampleX, sampleY, sourceTexture);
        } finally {
            this.captureInProgress = false;
        }
    }

    /** Destroys every outstanding map buffer and prevents further captures. */
    public destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        for (const cancelOperation of [ ...this.pendingOperationCancellations ]) {
            cancelOperation();
        }
        for (const buffer of this.activeBuffers) {
            buffer.destroy();
        }
        this.activeBuffers.clear();
    }

    private preflight(sampleX: number, sampleY: number): GPUCanvasPixelReadbackResult | null {
        if (this.destroyed) {
            return createFailure('destroyed', 'The canvas pixel reader has been destroyed');
        }
        if (this.captureInProgress) {
            return createFailure('capture-in-progress', 'A canvas readback is already in progress');
        }
        if (this.readbackCount >= this.maximumReadbacks) {
            return createFailure(
                'observation-limit-reached',
                'The bounded canvas readback limit has been reached'
            );
        }
        if (!Number.isSafeInteger(sampleX)
            || !Number.isSafeInteger(sampleY)
            || sampleX < 0
            || sampleY < 0) {
            return createFailure('validation-error', 'Texture sample coordinates must be non-negative integers');
        }
        if (!isReadableCanvasFormat(this.format)) {
            return createFailure(
                'unsupported-format',
                `Canvas format ${this.format} does not have a validation readback decoder`
            );
        }

        return null;
    }

    private async copyAndMapPixel(
        sampleX: number,
        sampleY: number,
        sourceTexture?: GPUTexture
    ): Promise<GPUCanvasPixelReadbackResult> {
        const usageConstants = getUsageConstants();
        if (!usageConstants) {
            return createFailure('gpu-api-unavailable', 'WebGPU readback constants are unavailable');
        }

        let texture: GPUTexture;
        try {
            if (sourceTexture) {
                texture = sourceTexture;
            } else if (this.context) {
                texture = this.context.getCurrentTexture();
            } else {
                return createFailure(
                    'gpu-api-unavailable',
                    'A source texture or configured WebGPU canvas context is required'
                );
            }
        } catch (error) {
            return createFailure('mapping-failed', getErrorMessage(error));
        }
        if (sampleX >= texture.width || sampleY >= texture.height) {
            return createFailure('validation-error', 'Sample coordinates exceed the texture bounds');
        }
        if (texture.format !== this.format) {
            return createFailure(
                'validation-error',
                `Readback texture format ${texture.format} does not match ${this.format}`
            );
        }
        if ((texture.usage & usageConstants.textureCopySource) === 0) {
            return createFailure(
                'copy-source-disabled',
                'The source texture must include GPUTextureUsage.COPY_SRC'
            );
        }

        return this.submitReadback(texture, sampleX, sampleY, usageConstants);
    }

    private async submitReadback(
        texture: GPUTexture,
        sampleX: number,
        sampleY: number,
        usageConstants: GPUUsageConstants
    ): Promise<GPUCanvasPixelReadbackResult> {
        if (!isReadableCanvasFormat(this.format)) {
            return createFailure('unsupported-format', 'Canvas format changed during readback');
        }

        const pixelByteLength = getPixelByteLength(this.format);
        const bytesPerRow = Math.ceil(pixelByteLength / COPY_BYTES_PER_ROW_ALIGNMENT)
            * COPY_BYTES_PER_ROW_ALIGNMENT;
        let buffer: GPUBuffer | null = null;
        let errorScopePushed = false;
        let mapped = false;
        try {
            this.device.pushErrorScope('validation');
            errorScopePushed = true;
            buffer = this.device.createBuffer({
                label: 'WebGPU color validation readback',
                size: bytesPerRow,
                usage: usageConstants.bufferCopyDestination | usageConstants.bufferMapRead
            });
            this.activeBuffers.add(buffer);
            const commandEncoder = this.device.createCommandEncoder({
                label: 'WebGPU color validation copy'
            });
            commandEncoder.copyTextureToBuffer(
                {
                    origin: { x: sampleX, y: sampleY, z: 0 },
                    texture
                },
                {
                    buffer,
                    bytesPerRow,
                    rowsPerImage: 1
                },
                { depthOrArrayLayers: 1, height: 1, width: 1 }
            );
            this.device.queue.submit([ commandEncoder.finish() ]);
            const mappingResult = await this.waitForOperation(
                buffer.mapAsync(usageConstants.mapRead, 0, pixelByteLength)
            );
            if (mappingResult === GPU_CANVAS_READBACK_OPERATION_DESTROYED) {
                return createFailure('destroyed', 'The reader was destroyed during canvas readback');
            }
            if (mappingResult === GPU_CANVAS_READBACK_OPERATION_TIMEOUT) {
                return createFailure('operation-timeout', 'The GPU buffer mapping operation timed out');
            }
            mapped = true;
            const validationPromise = this.device.popErrorScope();
            errorScopePushed = false;
            const validationResult = await this.waitForOperation(validationPromise);
            if (validationResult === GPU_CANVAS_READBACK_OPERATION_DESTROYED) {
                return createFailure('destroyed', 'The reader was destroyed during canvas readback');
            }
            if (validationResult === GPU_CANVAS_READBACK_OPERATION_TIMEOUT) {
                return createFailure('operation-timeout', 'The GPU validation scope operation timed out');
            }
            if (validationResult) {
                return createFailure('validation-error', validationResult.message);
            }
            if (this.destroyed) {
                return createFailure('destroyed', 'The reader was destroyed during canvas readback');
            }

            const mappedBytes = new Uint8Array(buffer.getMappedRange(0, pixelByteLength));
            const pixelBytes = mappedBytes.slice();
            return {
                failure: null,
                linearRGB: decodePixel(pixelBytes, this.format)
            };
        } catch (error) {
            return createFailure('mapping-failed', getErrorMessage(error));
        } finally {
            if (errorScopePushed) {
                this.discardErrorScope();
            }
            if (buffer) {
                if (mapped) {
                    try {
                        buffer.unmap();
                    } catch {
                        // A destroyed buffer is already unmapped
                    }
                }
                buffer.destroy();
                this.activeBuffers.delete(buffer);
            }
        }
    }

    private discardErrorScope(): void {
        let discardedScope: Promise<GPUError | null>;
        // popErrorScope can fail synchronously when the device is unavailable
        // eslint-disable-next-line sonarjs/no-try-promise
        try {
            discardedScope = this.device.popErrorScope();
        } catch {
            return;
        }

        void discardedScope.catch((): void => {
            // Device destruction can invalidate an outstanding error scope
        });
    }

    private waitForOperation<Value>(
        operation: Promise<Value>
    ): Promise<
        Value
        | typeof GPU_CANVAS_READBACK_OPERATION_DESTROYED
        | typeof GPU_CANVAS_READBACK_OPERATION_TIMEOUT
        > {
        return new Promise((resolve, reject) => {
            let settled = false;
            const timeout = globalThis.setTimeout((): void => {
                settle(GPU_CANVAS_READBACK_OPERATION_TIMEOUT);
            }, microsecondsToMilliseconds(GPU_CANVAS_READBACK_TIMEOUT_MICROSECONDS));
            const cancelOperation = (): void => {
                settle(GPU_CANVAS_READBACK_OPERATION_DESTROYED);
            };
            const settle = (
                result:
                    | Value
                    | typeof GPU_CANVAS_READBACK_OPERATION_DESTROYED
                    | typeof GPU_CANVAS_READBACK_OPERATION_TIMEOUT
            ): void => {
                if (settled) {
                    return;
                }

                settled = true;
                globalThis.clearTimeout(timeout);
                this.pendingOperationCancellations.delete(cancelOperation);
                resolve(result);
            };
            const rejectOperation = (error: unknown): void => {
                if (settled) {
                    return;
                }

                settled = true;
                globalThis.clearTimeout(timeout);
                this.pendingOperationCancellations.delete(cancelOperation);
                reject(error);
            };

            this.pendingOperationCancellations.add(cancelOperation);
            operation.then(settle, rejectOperation);
            if (this.destroyed) {
                cancelOperation();
            }
        });
    }
}
