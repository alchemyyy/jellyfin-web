import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHDRToSDRRenderSettings } from '../RenderSettings';
import type { ColorTriplet } from '../color/ColorPipeline';
import { decodeDolbyVisionRPUSnapshot } from '../custom/DolbyVisionRPUParser';
import { createDolbyVisionAuthorizationRPUFixture } from './DolbyVisionAuthorizationFixture';
import {
    createDolbyVisionShaderSignature,
    createExpectedDolbyVisionAuthorizationObservations,
    DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
    DOLBY_VISION_PROFILE7_AUTHORIZATION_ROUTE_KEY,
    DolbyVisionPresentationAuthorizationRegistry,
    DolbyVisionPresentationAuthorizationRunner,
    type DolbyVisionAuthorizationDecision
} from './DolbyVisionPresentationAuthorization';
import type { RawHDRFixtureObservation } from './RawHDRPresentationAuthorization';

type MockFunction = ReturnType<typeof vi.fn>;

type MockBuffer = GPUBuffer & {
    bytes: Uint8Array
};

type DeviceHarness = {
    bindGroupEntries: GPUBindGroupEntry[]
    bufferDescriptors: GPUBufferDescriptor[]
    bufferDestroy: MockFunction
    device: GPUDevice
    draw: MockFunction
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
    return createExpectedDolbyVisionAuthorizationObservations(
        createDolbyVisionAuthorizationRPUFixture(),
        createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 4_000 }
        })
    );
}

function createDeviceHarness(
    ...observationSets: Array<readonly RawHDRFixtureObservation[]>
): DeviceHarness {
    const observationMaps: Array<Map<string, ColorTriplet>> = [];
    for (const observations of observationSets) {
        const observationMap = new Map<string, ColorTriplet>();
        for (const observation of observations) {
            observationMap.set(
                `${observation.sampleX}:${observation.sampleY}`,
                observation.linearRGB
            );
        }
        observationMaps.push(observationMap);
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
    const bufferDestroy = vi.fn();
    const textureDestroy = vi.fn();
    const bindGroupEntries: GPUBindGroupEntry[] = [];
    const bufferDescriptors: GPUBufferDescriptor[] = [];
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
                destroy: bufferDestroy,
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
                const renderIndex = Math.max(draw.mock.calls.length - 1, 0);
                const observationMap = observationMaps[
                    Math.min(renderIndex, observationMaps.length - 1)
                ];
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
        limits: { maxTextureDimension2D: 8_192 },
        lost,
        popErrorScope: vi.fn(() => Promise.resolve(null)),
        pushErrorScope: vi.fn(),
        queue: {
            onSubmittedWorkDone: vi.fn(() => Promise.resolve()),
            submit: vi.fn(),
            writeBuffer: vi.fn(),
            writeTexture: vi.fn()
        }
    } as unknown as GPUDevice;
    return {
        bindGroupEntries,
        bufferDescriptors,
        bufferDestroy,
        device,
        draw,
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

describe('Dolby Vision presentation authorization', () => {
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
            value: { COPY_DST: 1, COPY_SRC: 2, RENDER_ATTACHMENT: 4, TEXTURE_BINDING: 8 }
        });
    });

    afterEach(() => {
        restoreProperty(globalThis, 'GPUBufferUsage', originalGPUBufferUsage);
        restoreProperty(globalThis, 'GPUMapMode', originalGPUMapMode);
        restoreProperty(globalThis, 'GPUTextureUsage', originalGPUTextureUsage);
        vi.restoreAllMocks();
    });

    it('builds a schema-valid fixture covering polynomial and MMR mapping', () => {
        const firstFixture = createDolbyVisionAuthorizationRPUFixture();
        const secondFixture = createDolbyVisionAuthorizationRPUFixture();
        const snapshot = decodeDolbyVisionRPUSnapshot(firstFixture);

        expect(snapshot).toMatchObject({
            baseLayerBitDepth: 10,
            layerMode: 'single-layer',
            profile: 8,
            vdrBitDepth: 12
        });
        expect(snapshot.components.map(component => component.mappingMethod)).toEqual([
            'polynomial',
            'mmr',
            'mmr'
        ]);
        expect(snapshot.components.map(component => component.mmrVectorCount)).toEqual([
            0,
            6,
            6
        ]);
        expect(secondFixture).not.toBe(firstFixture);
        expect(new Uint8Array(secondFixture)).toEqual(new Uint8Array(firstFixture));
    });

    it('builds distinct schema-valid Profile 7 MEL and FEL fixtures', () => {
        const melSnapshot = decodeDolbyVisionRPUSnapshot(
            createDolbyVisionAuthorizationRPUFixture(7, 'mel')
        );
        const felSnapshot = decodeDolbyVisionRPUSnapshot(
            createDolbyVisionAuthorizationRPUFixture(7, 'fel')
        );

        expect(melSnapshot).toMatchObject({
            disableResidual: false,
            layerMode: 'mel',
            nlqActive: false,
            profile: 7
        });
        expect(felSnapshot).toMatchObject({
            disableResidual: false,
            layerMode: 'fel',
            nlqActive: true,
            profile: 7
        });
        expect(melSnapshot.nlq.every(component => component.deadzoneSlope === 0)).toBe(true);
        expect(felSnapshot.nlq.every(component => component.deadzoneSlope > 0)).toBe(true);
    });

    it('authorizes exact shader output and binds the RPU storage buffer', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const runner = new DolbyVisionPresentationAuthorizationRunner();

        const decision = await runner.validate(harness.device, 'bgra8unorm');

        expect(decision).toMatchObject({
            failureReason: null,
            routeKey: DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
            sampleCount: 9,
            status: 'authorized'
        });
        expect(harness.draw).toHaveBeenCalledTimes(1);
        expect(harness.bindGroupEntries.some(entry => entry.binding === 5)).toBe(true);
        expect(harness.bufferDescriptors).toContainEqual(expect.objectContaining({
            size: 3_232,
            usage: 5
        }));
        expect(harness.bufferDestroy).toHaveBeenCalled();
        expect(harness.textureDestroy).toHaveBeenCalled();
    });

    it('authorizes both Profile 7 MEL reconstruction and FEL HDR10-base fallback', async () => {
        const settings = createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 4_000 }
        });
        const melRPUData = createDolbyVisionAuthorizationRPUFixture(7, 'mel');
        const felRPUData = createDolbyVisionAuthorizationRPUFixture(7, 'fel');
        const harness = createDeviceHarness(
            createExpectedDolbyVisionAuthorizationObservations(melRPUData, settings),
            createExpectedDolbyVisionAuthorizationObservations(
                felRPUData,
                settings,
                'fel-hdr10-base'
            )
        );
        const runner = new DolbyVisionPresentationAuthorizationRunner('profile7-base');

        const decision = await runner.validate(harness.device, 'bgra8unorm');

        expect(decision).toMatchObject({
            failureReason: null,
            routeKey: DOLBY_VISION_PROFILE7_AUTHORIZATION_ROUTE_KEY,
            sampleCount: 18,
            status: 'authorized'
        });
        expect(harness.draw).toHaveBeenCalledTimes(2);
    });

    it('rejects a bounded pixel mismatch', async () => {
        const harness = createDeviceHarness(mutateFirstObservation(
            createExpectedObservations()
        ));
        const runner = new DolbyVisionPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, 'bgra8unorm')).resolves.toMatchObject({
            failureReason: 'pixel-mismatch',
            status: 'rejected'
        });
    });

    it('rejects unsupported targets before allocating resources', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const runner = new DolbyVisionPresentationAuthorizationRunner();

        await expect(runner.validate(harness.device, 'rgba16float')).resolves.toMatchObject({
            failureReason: 'target-format-unsupported',
            status: 'rejected'
        });
        expect(harness.bufferDescriptors).toHaveLength(0);
    });

    it('deduplicates exact-device authorization and exposes only settled state', async () => {
        const harness = createDeviceHarness(createExpectedObservations());
        const runner = new DolbyVisionPresentationAuthorizationRunner();
        const validate = vi.spyOn(runner, 'validate');
        const registry = new DolbyVisionPresentationAuthorizationRegistry(runner);

        const firstDecision = registry.authorize(harness.device, 'bgra8unorm');
        const secondDecision = registry.authorize(harness.device, 'bgra8unorm');
        expect(secondDecision).toBe(firstDecision);
        expect(registry.getTelemetry(harness.device, 'bgra8unorm').status).toBe('pending');

        const decision: DolbyVisionAuthorizationDecision = await firstDecision;
        expect(decision.status).toBe('authorized');
        expect(validate).toHaveBeenCalledTimes(1);
        expect(registry.isAuthorized(
            harness.device,
            'bgra8unorm',
            createHDRToSDRRenderSettings(),
            'I420P10'
        )).toBe(true);
        expect(registry.isAuthorized(
            harness.device,
            'bgra8unorm',
            createHDRToSDRRenderSettings(),
            'I420P12'
        )).toBe(false);
        expect(registry.getTelemetry(harness.device, 'bgra8unorm')).toMatchObject({
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        });
    });

    it('includes the fixture and target in the stable signature', () => {
        expect(createDolbyVisionShaderSignature('bgra8unorm', 'shader')).toBe(
            createDolbyVisionShaderSignature('bgra8unorm', 'shader')
        );
        expect(createDolbyVisionShaderSignature('bgra8unorm', 'shader')).not.toBe(
            createDolbyVisionShaderSignature('rgba8unorm', 'shader')
        );
    });
});
