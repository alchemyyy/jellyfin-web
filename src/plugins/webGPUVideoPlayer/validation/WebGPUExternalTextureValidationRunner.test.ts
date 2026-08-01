import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createHLGColorMetadata,
    createPQColorMetadata,
    createSDRColorMetadata,
    type InputColorMetadata
} from '../color/ColorMetadata';
import {
    createTransferValidationRamp,
    type ColorRampObservation
} from '../color/ColorValidation';
import {
    type ColorValidationCapabilityDecision,
    type ColorValidationCaptureRequest,
    type ColorValidationCaptureResult,
    type ColorValidationHarnessOptions,
    type ReferenceFrameColorMetadata,
    type VideoFrameColorSpaceMetadata
} from './ColorValidationHarness';
import {
    createExternalTextureValidationWGSL,
    WebGPUExternalTextureValidationRunner,
    type ExternalTextureReferenceFrameRequest
} from './WebGPUExternalTextureValidationRunner';

type MockFunction = ReturnType<typeof vi.fn>;

type Deferred = {
    promise: Promise<void>
    resolve: () => void
};

type GPUHarness = {
    beginRenderPass: MockFunction
    canvas: HTMLCanvasElement
    commandFinish: MockFunction
    configure: MockFunction
    context: GPUCanvasContext
    createBindGroup: MockFunction
    createCommandEncoder: MockFunction
    createRenderPipelineAsync: MockFunction
    createSampler: MockFunction
    createShaderModule: MockFunction
    device: GPUDevice
    draw: MockFunction
    getBindGroupLayout: MockFunction
    importExternalTexture: MockFunction
    onSubmittedWorkDone: MockFunction
    popErrorScope: MockFunction
    pushErrorScope: MockFunction
    queueSubmit: MockFunction
    removeCanvas: MockFunction
    shaderDescriptors: GPUShaderModuleDescriptor[]
    texture: GPUTexture
    unconfigure: MockFunction
};

type FakeHarnessCollection = {
    captureRequests: ColorValidationCaptureRequest[]
    createHarness: MockFunction
    destroyHarness: MockFunction
    options: ColorValidationHarnessOptions[]
};

const originalGPUTextureUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUTextureUsage');
const COPY_SOURCE_USAGE = 2;
const RENDER_ATTACHMENT_USAGE = 1;

function createDeferred(): Deferred {
    let resolvePromise: () => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    const promise = new Promise<void>(resolve => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

function restoreGPUTextureUsage(): void {
    if (originalGPUTextureUsage) {
        Object.defineProperty(globalThis, 'GPUTextureUsage', originalGPUTextureUsage);
        return;
    }

    Reflect.deleteProperty(globalThis, 'GPUTextureUsage');
}

function createGPUHarness(): GPUHarness {
    const shaderDescriptors: GPUShaderModuleDescriptor[] = [];
    const configure = vi.fn();
    const unconfigure = vi.fn();
    const removeCanvas = vi.fn();
    const texture = {
        createView: vi.fn(() => ({})),
        format: 'rgba16float',
        height: 1,
        usage: COPY_SOURCE_USAGE | RENDER_ATTACHMENT_USAGE,
        width: 1
    } as unknown as GPUTexture;
    const context = {
        configure,
        getCurrentTexture: vi.fn(() => texture),
        unconfigure
    } as unknown as GPUCanvasContext;
    const canvas = {
        getContext: vi.fn(() => context),
        height: 0,
        hidden: false,
        remove: removeCanvas,
        width: 0
    } as unknown as HTMLCanvasElement;
    const draw = vi.fn();
    const renderPass = {
        draw,
        end: vi.fn(),
        setBindGroup: vi.fn(),
        setPipeline: vi.fn()
    };
    const beginRenderPass = vi.fn(() => renderPass);
    const commandFinish = vi.fn(() => ({}));
    const createCommandEncoder = vi.fn(() => ({
        beginRenderPass,
        finish: commandFinish
    }));
    const getBindGroupLayout = vi.fn(() => ({}));
    const pipeline = {
        getBindGroupLayout
    } as unknown as GPURenderPipeline;
    const createRenderPipelineAsync = vi.fn(async () => pipeline);
    const createShaderModule = vi.fn((descriptor: GPUShaderModuleDescriptor) => {
        shaderDescriptors.push(descriptor);
        return {} as GPUShaderModule;
    });
    const createSampler = vi.fn(() => ({} as GPUSampler));
    const createBindGroup = vi.fn(() => ({} as GPUBindGroup));
    const importExternalTexture = vi.fn(() => ({} as GPUExternalTexture));
    const queueSubmit = vi.fn();
    const onSubmittedWorkDone = vi.fn(async () => undefined);
    const pushErrorScope = vi.fn();
    const popErrorScope = vi.fn(async () => null);
    const device = {
        createBindGroup,
        createCommandEncoder,
        createRenderPipelineAsync,
        createSampler,
        createShaderModule,
        features: new Set<GPUFeatureName>(),
        importExternalTexture,
        label: 'exact-test-device',
        limits: { maxTextureDimension2D: 8_192 },
        lost: new Promise<GPUDeviceLostInfo>(() => undefined),
        popErrorScope,
        pushErrorScope,
        queue: {
            onSubmittedWorkDone,
            submit: queueSubmit
        }
    } as unknown as GPUDevice;
    return {
        beginRenderPass,
        canvas,
        commandFinish,
        configure,
        context,
        createBindGroup,
        createCommandEncoder,
        createRenderPipelineAsync,
        createSampler,
        createShaderModule,
        device,
        draw,
        getBindGroupLayout,
        importExternalTexture,
        onSubmittedWorkDone,
        popErrorScope,
        pushErrorScope,
        queueSubmit,
        removeCanvas,
        shaderDescriptors,
        texture,
        unconfigure
    };
}

function createDecision(
    options: ColorValidationHarnessOptions,
    frames: readonly ReferenceFrameColorMetadata[],
    observations: readonly ColorRampObservation[]
): ColorValidationCapabilityDecision {
    return {
        browser: options.browserMetadata ?? {
            colorGamut: 'display-p3',
            dynamicRange: 'high',
            language: 'en-US',
            secureContext: true,
            userAgent: 'External texture validation test'
        },
        canvas: {
            alphaMode: options.canvasConfiguration.alphaMode ?? 'opaque',
            colorSpace: options.canvasConfiguration.colorSpace ?? 'srgb',
            format: options.canvasConfiguration.format,
            height: options.canvas.height,
            toneMappingMode: options.canvasConfiguration.toneMapping?.mode ?? 'browser-default',
            width: options.canvas.width
        },
        capability: 'supported',
        classification: 'valid',
        frames,
        gpu: {
            architecture: options.adapterInfo?.architecture ?? '',
            description: options.adapterInfo?.description ?? '',
            device: options.adapterInfo?.device ?? '',
            deviceLabel: options.device.label,
            features: [],
            maximumTextureDimension2D: options.device.limits.maxTextureDimension2D,
            vendor: options.adapterInfo?.vendor ?? ''
        },
        observations,
        readbackFailure: null,
        validation: {
            accepted: true,
            classification: 'valid',
            maximumAbsoluteError: 0,
            rootMeanSquareError: 0,
            sampleCount: options.ramp.samples.length
        }
    };
}

function createFakeHarnessCollection(): FakeHarnessCollection {
    const captureRequests: ColorValidationCaptureRequest[] = [];
    const destroyHarness = vi.fn();
    const optionsCollection: ColorValidationHarnessOptions[] = [];
    const createHarness = vi.fn((options: ColorValidationHarnessOptions) => {
        optionsCollection.push(options);
        const frames: ReferenceFrameColorMetadata[] = [];
        const observations: ColorRampObservation[] = [];
        return {
            captureCurrentFrame: async (
                captureRequest: ColorValidationCaptureRequest
            ): Promise<ColorValidationCaptureResult> => {
                captureRequests.push(captureRequest);
                const sample = options.ramp.samples.find(candidate =>
                    candidate.timestampMicroseconds === captureRequest.timestampMicroseconds
                );
                if (!sample || !captureRequest.frame) {
                    return {
                        failure: {
                            code: 'validation-error',
                            message: 'The sample or frame metadata is missing'
                        },
                        observation: null
                    };
                }

                const observation: ColorRampObservation = {
                    linearRGB: [ ...sample.expectedLinearRGB ],
                    timestampMicroseconds: sample.timestampMicroseconds
                };
                observations.push(observation);
                frames.push({
                    codedHeight: captureRequest.frame.codedHeight ?? 1,
                    codedWidth: captureRequest.frame.codedWidth ?? 1,
                    displayHeight: captureRequest.frame.displayHeight ?? 1,
                    displayWidth: captureRequest.frame.displayWidth ?? 1,
                    inputColorMetadata: { ...options.ramp.metadata },
                    timestampMicroseconds: sample.timestampMicroseconds,
                    videoColorSpace: captureRequest.frame.videoColorSpace ?? null
                });
                return { failure: null, observation };
            },
            destroy: destroyHarness,
            evaluate: (): ColorValidationCapabilityDecision =>
                createDecision(options, frames, observations)
        };
    });
    return {
        captureRequests,
        createHarness,
        destroyHarness,
        options: optionsCollection
    };
}

function getVideoTransfer(metadata: InputColorMetadata): string {
    return metadata.transfer === 'sdr' ? 'bt709' : metadata.transfer;
}

function createVideoFrame(
    frameRequest: ExternalTextureReferenceFrameRequest,
    overrides: {
        colorSpace?: Partial<VideoFrameColorSpaceMetadata>
        timestamp?: number
    } = {}
): VideoFrame & { close: MockFunction } {
    const close = vi.fn();
    return {
        close,
        codedHeight: 16,
        codedWidth: 16,
        colorSpace: {
            fullRange: frameRequest.inputColorMetadata.range === 'full',
            matrix: frameRequest.inputColorMetadata.matrix,
            primaries: frameRequest.inputColorMetadata.primaries,
            transfer: getVideoTransfer(frameRequest.inputColorMetadata),
            ...overrides.colorSpace
        },
        displayHeight: 16,
        displayWidth: 16,
        timestamp: overrides.timestamp ?? frameRequest.timestampMicroseconds
    } as unknown as VideoFrame & { close: MockFunction };
}

beforeEach(() => {
    Object.defineProperty(globalThis, 'GPUTextureUsage', {
        configurable: true,
        value: {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            COPY_SRC: COPY_SOURCE_USAGE,
            // eslint-disable-next-line @typescript-eslint/naming-convention
            RENDER_ATTACHMENT: RENDER_ATTACHMENT_USAGE
        }
    });
});

afterEach(() => {
    restoreGPUTextureUsage();
});

describe('createExternalTextureValidationWGSL', () => {
    it.each([
        [ 'SDR', createSDRColorMetadata(), 'encodedValue / 4.5' ],
        [ 'PQ', createPQColorMetadata(), '2523.0 / 32.0' ],
        [ 'HLG', createHLGColorMetadata(), 'applyReferenceInverseOETF' ]
    ])('builds a single-EOTF %s shader', (
        _name: string,
        metadata: InputColorMetadata,
        expectedCode: string
    ) => {
        const shader = createExternalTextureValidationWGSL(
            createTransferValidationRamp(metadata)
        );

        expect(shader).toContain('texture_external');
        expect(shader).toContain(expectedCode);
        expect(shader).toContain('decodeReferenceRGB(encodedRGB)');
        expect(shader).toContain('/ 100.000000000');
        expect(shader).not.toContain('toneMap');
        expect(shader).not.toContain('convertToBT709');
        expect(shader).not.toContain('expandYUVRange');
    });
});

describe('WebGPUExternalTextureValidationRunner', () => {
    it('validates fresh exact-timestamp HDR frames on the supplied GPUDevice', async () => {
        const gpuHarness = createGPUHarness();
        const fakeHarness = createFakeHarnessCollection();
        const frames: Array<VideoFrame & { close: MockFunction }> = [];
        const getFrame = vi.fn(async (frameRequest: ExternalTextureReferenceFrameRequest) => {
            const frame = createVideoFrame(frameRequest);
            frames.push(frame);
            return frame;
        });
        const runner = new WebGPUExternalTextureValidationRunner({
            createCanvas: () => gpuHarness.canvas,
            createHarness: fakeHarness.createHarness,
            isEnabled: async () => true
        });
        const metadata = createPQColorMetadata();

        const decision = await runner.validate({
            adapterInfo: {
                architecture: 'test-architecture',
                description: 'test-description',
                device: 'test-device',
                vendor: 'test-vendor'
            },
            device: gpuHarness.device,
            getFrame,
            metadata
        });

        expect(decision?.capability).toBe('supported');
        expect(getFrame).toHaveBeenCalledTimes(5);
        for (let sampleIndex = 0; sampleIndex < getFrame.mock.calls.length; sampleIndex += 1) {
            const frameRequest = getFrame.mock.calls[sampleIndex][0];
            expect(Number.isSafeInteger(frameRequest.timestampMicroseconds)).toBe(true);
            expect(frameRequest.sampleIndex).toBe(sampleIndex);
            expect(frameRequest.inputColorMetadata).toEqual(metadata);
            expect(frames[sampleIndex].close).toHaveBeenCalledOnce();
        }
        expect(gpuHarness.configure).toHaveBeenCalledWith({
            alphaMode: 'opaque',
            colorSpace: 'srgb',
            device: gpuHarness.device,
            format: 'rgba16float',
            toneMapping: { mode: 'extended' },
            usage: COPY_SOURCE_USAGE | RENDER_ATTACHMENT_USAGE
        });
        expect(fakeHarness.options[0]).toMatchObject({
            canvas: gpuHarness.canvas,
            configureCanvas: false,
            context: gpuHarness.context,
            device: gpuHarness.device
        });
        expect(gpuHarness.importExternalTexture).toHaveBeenCalledTimes(5);
        expect(gpuHarness.queueSubmit).toHaveBeenCalledTimes(5);
        expect(gpuHarness.onSubmittedWorkDone).toHaveBeenCalledTimes(5);
        expect(fakeHarness.captureRequests).toHaveLength(5);
        expect(fakeHarness.captureRequests.every(captureRequest =>
            captureRequest.sourceTexture === gpuHarness.texture
        )).toBe(true);
        expect(fakeHarness.destroyHarness).toHaveBeenCalledOnce();
        expect(gpuHarness.unconfigure).toHaveBeenCalledOnce();
        expect(gpuHarness.removeCanvas).toHaveBeenCalledOnce();
        expect(gpuHarness.canvas.width).toBe(0);
        expect(gpuHarness.canvas.height).toBe(0);
        expect(gpuHarness.shaderDescriptors[0].code).toContain('2523.0 / 32.0');
    });

    it('does not create GPU resources or request frames when disabled', async () => {
        const gpuHarness = createGPUHarness();
        const fakeHarness = createFakeHarnessCollection();
        const getFrame = vi.fn(async (frameRequest: ExternalTextureReferenceFrameRequest) =>
            createVideoFrame(frameRequest));
        const runner = new WebGPUExternalTextureValidationRunner({
            createCanvas: () => gpuHarness.canvas,
            createHarness: fakeHarness.createHarness,
            isEnabled: async () => false
        });

        await expect(runner.validate({
            device: gpuHarness.device,
            getFrame,
            metadata: createPQColorMetadata()
        })).resolves.toBeNull();
        expect(gpuHarness.configure).not.toHaveBeenCalled();
        expect(fakeHarness.createHarness).not.toHaveBeenCalled();
        expect(getFrame).not.toHaveBeenCalled();
    });

    it('rejects and closes a frame whose timestamp does not exactly match', async () => {
        const gpuHarness = createGPUHarness();
        const fakeHarness = createFakeHarnessCollection();
        const frameState: {
            returnedFrame?: VideoFrame & { close: MockFunction }
        } = {};
        const getFrame = vi.fn(async (frameRequest: ExternalTextureReferenceFrameRequest) => {
            frameState.returnedFrame = createVideoFrame(frameRequest, {
                timestamp: frameRequest.timestampMicroseconds + 1
            });
            return frameState.returnedFrame;
        });
        const runner = new WebGPUExternalTextureValidationRunner({
            createCanvas: () => gpuHarness.canvas,
            createHarness: fakeHarness.createHarness,
            isEnabled: async () => true
        });

        await expect(runner.validate({
            device: gpuHarness.device,
            getFrame,
            metadata: createPQColorMetadata()
        })).resolves.toBeNull();
        expect(frameState.returnedFrame?.close).toHaveBeenCalledOnce();
        expect(gpuHarness.importExternalTexture).not.toHaveBeenCalled();
        expect(fakeHarness.destroyHarness).toHaveBeenCalledOnce();
        expect(gpuHarness.unconfigure).toHaveBeenCalledOnce();
    });

    it('rejects and closes a frame with mismatched color metadata', async () => {
        const gpuHarness = createGPUHarness();
        const fakeHarness = createFakeHarnessCollection();
        const frames: Array<VideoFrame & { close: MockFunction }> = [];
        const getFrame = vi.fn(async (frameRequest: ExternalTextureReferenceFrameRequest) => {
            const frame = createVideoFrame(frameRequest, {
                colorSpace: { transfer: 'hlg' }
            });
            frames.push(frame);
            return frame;
        });
        const runner = new WebGPUExternalTextureValidationRunner({
            createCanvas: () => gpuHarness.canvas,
            createHarness: fakeHarness.createHarness,
            isEnabled: async () => true
        });

        await expect(runner.validate({
            device: gpuHarness.device,
            getFrame,
            metadata: createPQColorMetadata()
        })).resolves.toBeNull();
        expect(frames[0].close).toHaveBeenCalledOnce();
        expect(gpuHarness.importExternalTexture).not.toHaveBeenCalled();
    });

    it('rejects reuse of the same VideoFrame for a second sample', async () => {
        const gpuHarness = createGPUHarness();
        const fakeHarness = createFakeHarnessCollection();
        const frameState: {
            firstFrameRequest?: ExternalTextureReferenceFrameRequest
            reusedFrame?: VideoFrame & { close: MockFunction }
        } = {};
        const getFrame = vi.fn(async (frameRequest: ExternalTextureReferenceFrameRequest) => {
            if (!frameState.reusedFrame) {
                frameState.firstFrameRequest = frameRequest;
                frameState.reusedFrame = createVideoFrame(frameRequest);
            } else if (frameState.firstFrameRequest) {
                Object.defineProperty(frameState.reusedFrame, 'timestamp', {
                    configurable: true,
                    value: frameRequest.timestampMicroseconds
                });
            }
            return frameState.reusedFrame;
        });
        const runner = new WebGPUExternalTextureValidationRunner({
            createCanvas: () => gpuHarness.canvas,
            createHarness: fakeHarness.createHarness,
            isEnabled: async () => true
        });

        await expect(runner.validate({
            device: gpuHarness.device,
            getFrame,
            metadata: createPQColorMetadata()
        })).resolves.toBeNull();
        expect(getFrame).toHaveBeenCalledTimes(2);
        expect(frameState.reusedFrame?.close).toHaveBeenCalledTimes(2);
        expect(gpuHarness.importExternalTexture).toHaveBeenCalledOnce();
    });

    it('closes a frame and discards rendering when invalidated during frame acquisition', async () => {
        const gpuHarness = createGPUHarness();
        const fakeHarness = createFakeHarnessCollection();
        const frameRequested = createDeferred();
        const releaseFrame = createDeferred();
        const frameState: {
            returnedFrame?: VideoFrame & { close: MockFunction }
        } = {};
        const getFrame = vi.fn(async (frameRequest: ExternalTextureReferenceFrameRequest) => {
            frameRequested.resolve();
            await releaseFrame.promise;
            frameState.returnedFrame = createVideoFrame(frameRequest);
            return frameState.returnedFrame;
        });
        const runner = new WebGPUExternalTextureValidationRunner({
            createCanvas: () => gpuHarness.canvas,
            createHarness: fakeHarness.createHarness,
            isEnabled: async () => true
        });
        const metadata = createPQColorMetadata();
        const validation = runner.validate({
            device: gpuHarness.device,
            getFrame,
            metadata
        });

        await frameRequested.promise;
        runner.invalidate(gpuHarness.device, metadata);
        releaseFrame.resolve();

        await expect(validation).resolves.toBeNull();
        expect(frameState.returnedFrame?.close).toHaveBeenCalledOnce();
        expect(gpuHarness.importExternalTexture).not.toHaveBeenCalled();
        expect(fakeHarness.destroyHarness).toHaveBeenCalledOnce();
        expect(gpuHarness.unconfigure).toHaveBeenCalledOnce();
    });

    it('cleans up without requesting frames when pipeline creation fails', async () => {
        const gpuHarness = createGPUHarness();
        const fakeHarness = createFakeHarnessCollection();
        gpuHarness.createRenderPipelineAsync.mockRejectedValue(new Error('shader failed'));
        const getFrame = vi.fn(async (frameRequest: ExternalTextureReferenceFrameRequest) =>
            createVideoFrame(frameRequest));
        const runner = new WebGPUExternalTextureValidationRunner({
            createCanvas: () => gpuHarness.canvas,
            createHarness: fakeHarness.createHarness,
            isEnabled: async () => true
        });

        await expect(runner.validate({
            device: gpuHarness.device,
            getFrame,
            metadata: createHLGColorMetadata()
        })).resolves.toBeNull();
        expect(getFrame).not.toHaveBeenCalled();
        expect(fakeHarness.destroyHarness).toHaveBeenCalledOnce();
        expect(gpuHarness.unconfigure).toHaveBeenCalledOnce();
        expect(gpuHarness.removeCanvas).toHaveBeenCalledOnce();
    });

    it('releases the dedicated canvas when a WebGPU context is unavailable', async () => {
        const gpuHarness = createGPUHarness();
        const fakeHarness = createFakeHarnessCollection();
        (gpuHarness.canvas.getContext as MockFunction).mockReturnValue(null);
        const getFrame = vi.fn(async (frameRequest: ExternalTextureReferenceFrameRequest) =>
            createVideoFrame(frameRequest));
        const runner = new WebGPUExternalTextureValidationRunner({
            createCanvas: () => gpuHarness.canvas,
            createHarness: fakeHarness.createHarness,
            isEnabled: async () => true
        });

        await expect(runner.validate({
            device: gpuHarness.device,
            getFrame,
            metadata: createPQColorMetadata()
        })).resolves.toBeNull();
        expect(fakeHarness.createHarness).not.toHaveBeenCalled();
        expect(getFrame).not.toHaveBeenCalled();
        expect(gpuHarness.removeCanvas).toHaveBeenCalledOnce();
        expect(gpuHarness.canvas.width).toBe(0);
        expect(gpuHarness.canvas.height).toBe(0);
    });

    it('does not expose or retain URL and credential fields in frame requests or decisions', async () => {
        const gpuHarness = createGPUHarness();
        const fakeHarness = createFakeHarnessCollection();
        const requestSnapshots: string[] = [];
        const getFrameMock = vi.fn(async (frameRequest: ExternalTextureReferenceFrameRequest) => {
            requestSnapshots.push(JSON.stringify(frameRequest));
            return createVideoFrame(frameRequest);
        });
        const getFrame = getFrameMock as typeof getFrameMock & {
            sourceUrl?: string
            token?: string
        };
        getFrame.sourceUrl = 'https://media.invalid/video?api_key=secret-token';
        getFrame.token = 'secret-token';
        const runner = new WebGPUExternalTextureValidationRunner({
            createCanvas: () => gpuHarness.canvas,
            createHarness: fakeHarness.createHarness,
            isEnabled: async () => true
        });

        const decision = await runner.validate({
            device: gpuHarness.device,
            getFrame,
            metadata: createSDRColorMetadata()
        });

        expect(requestSnapshots.join('')).not.toContain('media.invalid');
        expect(requestSnapshots.join('')).not.toContain('secret-token');
        expect(JSON.stringify(decision)).not.toContain('secret-token');
    });
});
