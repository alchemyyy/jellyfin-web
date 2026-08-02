import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHDRToSDRRenderSettings } from '../RenderSettings';
import type { ColorTriplet } from '../color/ColorPipeline';
import { createDolbyVisionAuthorizationRPUFixture } from './DolbyVisionAuthorizationFixture';
import {
    createExpectedExternalDolbyVisionAuthorizationObservations,
    createExternalDolbyVisionShaderSignature,
    EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
    ExternalDolbyVisionPresentationAuthorizationRegistry,
    ExternalDolbyVisionPresentationAuthorizationRunner,
    type ExternalDolbyVisionAuthorizationDecision
} from './ExternalDolbyVisionPresentationAuthorization';
import type { RawHDRFixtureObservation } from './RawHDRPresentationAuthorization';

type MockFunction = ReturnType<typeof vi.fn>;

type MockBuffer = GPUBuffer & {
    bytes: Uint8Array
};

type DeviceHarness = {
    bindGroupEntries: GPUBindGroupEntry[]
    bufferDescriptors: GPUBufferDescriptor[]
    device: GPUDevice
    draw: MockFunction
    importExternalTexture: MockFunction
    textureDestroy: MockFunction
};

const originalGPUBufferUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUBufferUsage');
const originalGPUMapMode = Object.getOwnPropertyDescriptor(globalThis, 'GPUMapMode');
const originalGPUTextureUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUTextureUsage');

function restoreProperty(
    target: object,
    propertyName: PropertyKey,
    descriptor: PropertyDescriptor | undefined
): void {
    if (descriptor) {
        Object.defineProperty(target, propertyName, descriptor);
    } else {
        Reflect.deleteProperty(target, propertyName);
    }
}

function createExpectedObservations(): readonly RawHDRFixtureObservation[] {
    return createExpectedExternalDolbyVisionAuthorizationObservations(
        createDolbyVisionAuthorizationRPUFixture(5),
        createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 4_000 }
        })
    );
}

function createFrame(close: MockFunction): VideoFrame {
    return {
        close,
        displayHeight: 8,
        displayWidth: 16
    } as unknown as VideoFrame;
}

function createDeviceHarness(
    observations: readonly RawHDRFixtureObservation[]
): DeviceHarness {
    const observationMap = new Map<string, ColorTriplet>();
    for (const observation of observations) {
        observationMap.set(
            `${observation.sampleX}:${observation.sampleY}`,
            observation.linearRGB
        );
    }
    const lost = new Promise<GPUDeviceLostInfo>(() => undefined);
    const draw = vi.fn();
    const renderPass = {
        draw,
        end: vi.fn(),
        setBindGroup: vi.fn(),
        setPipeline: vi.fn(),
        setViewport: vi.fn()
    };
    const bindGroupEntries: GPUBindGroupEntry[] = [];
    const bufferDescriptors: GPUBufferDescriptor[] = [];
    const textureDestroy = vi.fn();
    const importExternalTexture = vi.fn(() => ({}));
    const pipeline = {
        getBindGroupLayout: vi.fn(() => ({}))
    } as unknown as GPURenderPipeline;
    const device = {
        createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => {
            bindGroupEntries.push(...descriptor.entries);
            return {};
        }),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            bufferDescriptors.push(descriptor);
            const bytes = new Uint8Array(Number(descriptor.size));
            return {
                bytes,
                destroy: vi.fn(),
                getMappedRange: vi.fn((offset = 0, size = bytes.byteLength) => (
                    bytes.buffer.slice(offset, offset + size)
                )),
                mapAsync: vi.fn(() => Promise.resolve()),
                unmap: vi.fn()
            } as unknown as MockBuffer;
        }),
        createCommandEncoder: vi.fn(() => ({
            beginRenderPass: vi.fn(() => renderPass),
            copyTextureToBuffer: vi.fn((
                source: GPUTexelCopyTextureInfo,
                destination: GPUTexelCopyBufferInfo
            ) => {
                const origin = source.origin as GPUOrigin3DDict;
                const sampleX = Number(origin.x ?? 0);
                const sampleY = Number(origin.y ?? 0);
                const linearRGB = observationMap.get(`${sampleX}:${sampleY}`);
                if (!linearRGB) {
                    throw new Error('Unexpected readback coordinate');
                }
                const destinationBuffer = destination.buffer as MockBuffer;
                const byteOffset = Number(destination.offset ?? 0);
                destinationBuffer.bytes[byteOffset] = Math.round(linearRGB[2] * 255);
                destinationBuffer.bytes[byteOffset + 1] = Math.round(linearRGB[1] * 255);
                destinationBuffer.bytes[byteOffset + 2] = Math.round(linearRGB[0] * 255);
                destinationBuffer.bytes[byteOffset + 3] = 255;
            }),
            finish: vi.fn(() => ({}))
        })),
        createRenderPipelineAsync: vi.fn(() => Promise.resolve(pipeline)),
        createSampler: vi.fn(() => ({})),
        createShaderModule: vi.fn(() => ({})),
        createTexture: vi.fn((descriptor: GPUTextureDescriptor) => ({
            createView: vi.fn(() => ({})),
            depthOrArrayLayers: 1,
            destroy: textureDestroy,
            format: descriptor.format,
            height: Number((descriptor.size as GPUExtent3DDict).height ?? 1),
            usage: descriptor.usage,
            width: Number((descriptor.size as GPUExtent3DDict).width ?? 1)
        })),
        importExternalTexture,
        limits: { maxTextureDimension2D: 8_192 },
        lost,
        popErrorScope: vi.fn(() => Promise.resolve(null)),
        pushErrorScope: vi.fn(),
        queue: {
            onSubmittedWorkDone: vi.fn(() => Promise.resolve()),
            submit: vi.fn(),
            writeBuffer: vi.fn()
        }
    } as unknown as GPUDevice;
    return {
        bindGroupEntries,
        bufferDescriptors,
        device,
        draw,
        importExternalTexture,
        textureDestroy
    };
}

function mutateFirstObservation(
    observations: readonly RawHDRFixtureObservation[]
): readonly RawHDRFixtureObservation[] {
    return observations.map((observation, observationIndex) => observationIndex === 0 ? {
        ...observation,
        linearRGB: [
            Math.min(observation.linearRGB[0] + 0.1, 1),
            observation.linearRGB[1],
            observation.linearRGB[2]
        ]
    } : observation);
}

describe('External Dolby Vision presentation authorization', () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, 'GPUBufferUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 1, MAP_READ: 2, STORAGE: 4, UNIFORM: 8 }
        });
        Object.defineProperty(globalThis, 'GPUMapMode', {
            configurable: true,
            value: { READ: 1 }
        });
        Object.defineProperty(globalThis, 'GPUTextureUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_SRC: 1, RENDER_ATTACHMENT: 2 }
        });
    });

    afterEach(() => {
        restoreProperty(globalThis, 'GPUBufferUsage', originalGPUBufferUsage);
        restoreProperty(globalThis, 'GPUMapMode', originalGPUMapMode);
        restoreProperty(globalThis, 'GPUTextureUsage', originalGPUTextureUsage);
        vi.restoreAllMocks();
    });

    it('authorizes exact external output, binds the RPU, and closes the frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const close = vi.fn();
        const frame = createFrame(close);
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner(
            (): VideoFrame => frame
        );

        const decision = await runner.validate(harness.device, 'bgra8unorm');

        expect(decision).toMatchObject({
            failureReason: null,
            routeKey: EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
            sampleCount: 9,
            status: 'authorized'
        });
        expect(harness.importExternalTexture).toHaveBeenCalledWith({
            colorSpace: 'srgb',
            source: frame
        });
        expect(harness.bindGroupEntries.map(entry => entry.binding)).toEqual([
            0, 1, 2, 3, 4
        ]);
        expect(harness.draw).toHaveBeenCalledOnce();
        expect(close).toHaveBeenCalledOnce();
        expect(harness.textureDestroy).toHaveBeenCalledOnce();
    });

    it('rejects a bounded pixel mismatch and still closes the frame', async () => {
        const harness = createDeviceHarness(mutateFirstObservation(
            createExpectedObservations()
        ));
        const close = vi.fn();
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner(
            (): VideoFrame => createFrame(close)
        );

        await expect(runner.validate(harness.device, 'bgra8unorm')).resolves.toMatchObject({
            failureReason: 'pixel-mismatch',
            status: 'rejected'
        });
        expect(close).toHaveBeenCalledOnce();
    });

    it('classifies an external-texture import failure and closes the frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        harness.importExternalTexture.mockImplementation(() => {
            throw new Error('simulated import failure');
        });
        const close = vi.fn();
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner(
            (): VideoFrame => createFrame(close)
        );

        await expect(runner.validate(harness.device, 'bgra8unorm')).resolves.toMatchObject({
            failureReason: 'frame-import-failed',
            status: 'rejected'
        });
        expect(close).toHaveBeenCalledOnce();
    });

    it('deduplicates exact-device authorization and exposes settled state', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner(
            (): VideoFrame => createFrame(vi.fn())
        );
        const validate = vi.spyOn(runner, 'validate');
        const registry = new ExternalDolbyVisionPresentationAuthorizationRegistry(runner);

        const firstDecision = registry.authorize(harness.device, 'bgra8unorm');
        const secondDecision = registry.authorize(harness.device, 'bgra8unorm');
        expect(secondDecision).toBe(firstDecision);
        expect(registry.getTelemetry(harness.device, 'bgra8unorm').status).toBe('pending');

        const decision: ExternalDolbyVisionAuthorizationDecision = await firstDecision;
        expect(decision.status).toBe('authorized');
        expect(validate).toHaveBeenCalledOnce();
        expect(registry.isAuthorized(
            harness.device,
            'bgra8unorm',
            createHDRToSDRRenderSettings()
        )).toBe(true);
        expect(registry.getTelemetry(harness.device, 'bgra8unorm')).toMatchObject({
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        });
    });

    it('rejects unsupported targets before constructing a frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const createFrameFactory = vi.fn(() => createFrame(vi.fn()));
        const runner = new ExternalDolbyVisionPresentationAuthorizationRunner(
            createFrameFactory
        );

        await expect(runner.validate(harness.device, 'rgba16float')).resolves.toMatchObject({
            failureReason: 'target-format-unsupported',
            status: 'rejected'
        });
        expect(createFrameFactory).not.toHaveBeenCalled();
    });

    it('includes the production shader and target in the stable signature', () => {
        expect(createExternalDolbyVisionShaderSignature('bgra8unorm', 'shader')).toBe(
            createExternalDolbyVisionShaderSignature('bgra8unorm', 'shader')
        );
        expect(createExternalDolbyVisionShaderSignature('bgra8unorm', 'shader')).not.toBe(
            createExternalDolbyVisionShaderSignature('rgba8unorm', 'shader')
        );
    });
});
