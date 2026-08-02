import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHDRToSDRRenderSettings } from '../RenderSettings';
import {
    createHLGColorMetadata,
    createPQColorMetadata,
    type InputColorMetadata
} from '../color/ColorMetadata';
import type { ColorTriplet } from '../color/ColorPipeline';
import { createRawYUVColorPipelineWGSL } from '../color/ColorPipelineShader';
import type { TransferableRawVideoFrame } from '../custom/RawVideoFrameCopy';
import {
    createExpectedRawHDRFixtureObservations,
    createRawHDRAuthorizationFixture,
    createRawHDRShaderSignature,
    evaluateRawHDRFixtureObservations,
    getRawHDRAuthorizationRouteKey,
    RAW_HDR_AUTHORIZATION_FIXTURE_VERSION,
    RawHDRPresentationAuthorizationRegistry,
    RawHDRPresentationAuthorizationRunner,
    type RawHDRAuthorizationRouteKey,
    type RawHDRFixtureObservation,
    type RawHDRRouteAuthorizationDecision
} from './RawHDRPresentationAuthorization';

type MockFunction = ReturnType<typeof vi.fn>;

type MockBuffer = GPUBuffer & {
    bytes: Uint8Array
};

type DeviceHarness = {
    bufferDestroy: MockFunction
    createRenderPipelineAsync: MockFunction
    device: GPUDevice
    draw: MockFunction
    lostResolve: (info: GPUDeviceLostInfo) => void
    popErrorScope: MockFunction
    textureDestroy: MockFunction
    writeTexture: MockFunction
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

function getRouteMetadata(routeKey: RawHDRAuthorizationRouteKey): InputColorMetadata {
    return routeKey.endsWith(':pq') ? createPQColorMetadata() : createHLGColorMetadata();
}

function createRouteObservations(
    routeKey: RawHDRAuthorizationRouteKey,
    metadata = getRouteMetadata(routeKey),
    frame = createRawHDRAuthorizationFixture(routeKey)
): readonly RawHDRFixtureObservation[] {
    return createExpectedRawHDRFixtureObservations(
        frame,
        metadata,
        createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: metadata.nominalPeakNits }
        })
    );
}

function createDeviceHarness(
    observations: readonly RawHDRFixtureObservation[],
    pipelinePromise?: Promise<GPURenderPipeline>,
    mapAsyncFactory?: () => Promise<void>
): DeviceHarness {
    const observationMap = new Map<string, ColorTriplet>();
    for (const observation of observations) {
        observationMap.set(
            `${observation.sampleX}:${observation.sampleY}`,
            observation.linearRGB
        );
    }

    let lostResolve: (info: GPUDeviceLostInfo) => void = (): void => undefined;
    const lost = new Promise<GPUDeviceLostInfo>(resolve => {
        lostResolve = resolve;
    });
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
    const writeTexture = vi.fn();
    const popErrorScope = vi.fn(() => Promise.resolve(null));
    const pipeline = {
        getBindGroupLayout: vi.fn(() => ({}))
    } as unknown as GPURenderPipeline;
    const createRenderPipelineAsync = vi.fn(() => pipelinePromise ?? Promise.resolve(pipeline));
    const device = {
        createBindGroup: vi.fn(() => ({})),
        createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
            const bytes = new Uint8Array(Number(descriptor.size));
            return {
                bytes,
                destroy: bufferDestroy,
                getMappedRange: vi.fn((offset = 0, size = bytes.byteLength) => (
                    bytes.buffer.slice(offset, offset + size)
                )),
                mapAsync: vi.fn(() => mapAsyncFactory?.() ?? Promise.resolve()),
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
        createRenderPipelineAsync,
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
        popErrorScope,
        pushErrorScope: vi.fn(),
        queue: {
            onSubmittedWorkDone: vi.fn(() => Promise.resolve()),
            submit: vi.fn(),
            writeBuffer: vi.fn(),
            writeTexture
        }
    } as unknown as GPUDevice;
    return {
        bufferDestroy,
        createRenderPipelineAsync,
        device,
        draw,
        lostResolve,
        popErrorScope,
        textureDestroy,
        writeTexture
    };
}

function swapFixtureChroma(frame: TransferableRawVideoFrame): TransferableRawVideoFrame {
    const swappedData = frame.data.slice(0);
    const chromaUPlane = frame.planes[1];
    const chromaVPlane = frame.planes[2];
    const sourceData = new Uint8Array(frame.data);
    const destinationData = new Uint8Array(swappedData);
    destinationData.set(
        sourceData.slice(
            chromaVPlane.byteOffset,
            chromaVPlane.byteOffset + chromaVPlane.byteLength
        ),
        chromaUPlane.byteOffset
    );
    destinationData.set(
        sourceData.slice(
            chromaUPlane.byteOffset,
            chromaUPlane.byteOffset + chromaUPlane.byteLength
        ),
        chromaVPlane.byteOffset
    );
    return { ...frame, data: swappedData };
}

function mutateFirstPixel(
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

function createAuthorizedDecision(
    device: GPUDevice,
    routeKey: RawHDRAuthorizationRouteKey,
    targetFormat: GPUTextureFormat
): RawHDRRouteAuthorizationDecision {
    const metadata = getRouteMetadata(routeKey);
    const settings = createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits: metadata.nominalPeakNits }
    });
    const shaderCode = `shader-${metadata.transfer}-${settings.version}`;
    return {
        authorizedRouteKeys: [ routeKey ],
        device,
        failureReason: null,
        fixtureVersion: RAW_HDR_AUTHORIZATION_FIXTURE_VERSION,
        maximumChannelError: 0,
        renderSettingsVersion: 4,
        routeKey,
        sampleCount: 9,
        shaderSignature: createRawHDRShaderSignature(targetFormat, shaderCode),
        status: 'authorized',
        targetFormat
    };
}

describe('RawHDRPresentationAuthorization', () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, 'GPUBufferUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 8, MAP_READ: 1, UNIFORM: 64 }
        });
        Object.defineProperty(globalThis, 'GPUMapMode', {
            configurable: true,
            // WebGPU defines this external name
            value: { READ: 1 }
        });
        Object.defineProperty(globalThis, 'GPUTextureUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 2, COPY_SRC: 1, RENDER_ATTACHMENT: 16, TEXTURE_BINDING: 4 }
        });
    });

    afterEach(() => {
        vi.useRealTimers();
        restoreProperty(globalThis, 'GPUBufferUsage', originalGPUBufferUsage);
        restoreProperty(globalThis, 'GPUMapMode', originalGPUMapMode);
        restoreProperty(globalThis, 'GPUTextureUsage', originalGPUTextureUsage);
    });

    it('whitelists only exact I420P10 BT.2020 limited PQ and HLG tuples', () => {
        expect(getRawHDRAuthorizationRouteKey('I420P10', createPQColorMetadata())).toBe(
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        );
        expect(getRawHDRAuthorizationRouteKey('I420P10', createHLGColorMetadata())).toBe(
            'I420P10:bt2020-ncl:bt2020:limited:hlg'
        );
        expect(getRawHDRAuthorizationRouteKey(
            'I420P10',
            createPQColorMetadata({ range: 'full' })
        )).toBeNull();
        expect(getRawHDRAuthorizationRouteKey(
            'I420P12',
            createPQColorMetadata({ bitDepth: 12 })
        )).toBeNull();
    });

    it.each([
        'I420P10:bt2020-ncl:bt2020:limited:pq',
        'I420P10:bt2020-ncl:bt2020:limited:hlg'
    ] as const)('authorizes %s through the shared production render primitive', async routeKey => {
        const observations = createRouteObservations(routeKey);
        const harness = createDeviceHarness(observations);
        const runner = new RawHDRPresentationAuthorizationRunner();

        const decision = await runner.validate(harness.device, 'bgra8unorm', routeKey);

        expect(decision).toMatchObject({
            authorizedRouteKeys: [ routeKey ],
            failureReason: null,
            routeKey,
            sampleCount: 9,
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        });
        expect(harness.createRenderPipelineAsync).toHaveBeenCalledOnce();
        expect(harness.writeTexture).toHaveBeenCalledTimes(3);
        expect(harness.draw).toHaveBeenCalledWith(6);
        expect(harness.textureDestroy).toHaveBeenCalledTimes(4);
        expect(harness.bufferDestroy).toHaveBeenCalledTimes(3);
    });

    it.each([
        {
            label: 'U/V swap',
            observations: (): readonly RawHDRFixtureObservation[] => createRouteObservations(
                'I420P10:bt2020-ncl:bt2020:limited:pq',
                createPQColorMetadata(),
                swapFixtureChroma(createRawHDRAuthorizationFixture(
                    'I420P10:bt2020-ncl:bt2020:limited:pq'
                ))
            )
        },
        {
            label: 'full range',
            observations: (): readonly RawHDRFixtureObservation[] => createRouteObservations(
                'I420P10:bt2020-ncl:bt2020:limited:pq',
                createPQColorMetadata({ range: 'full' })
            )
        },
        {
            label: 'BT.709 matrix',
            observations: (): readonly RawHDRFixtureObservation[] => createRouteObservations(
                'I420P10:bt2020-ncl:bt2020:limited:pq',
                createPQColorMetadata({ matrix: 'bt709' })
            )
        },
        {
            label: 'HLG transfer',
            observations: (): readonly RawHDRFixtureObservation[] => createRouteObservations(
                'I420P10:bt2020-ncl:bt2020:limited:pq',
                createHLGColorMetadata()
            )
        },
        {
            label: 'expected pixel',
            observations: (): readonly RawHDRFixtureObservation[] => mutateFirstPixel(
                createRouteObservations('I420P10:bt2020-ncl:bt2020:limited:pq')
            )
        }
    ])('rejects a corrupted $label result and cleans resources', async testCase => {
        const harness = createDeviceHarness(testCase.observations());
        const runner = new RawHDRPresentationAuthorizationRunner();

        const decision = await runner.validate(
            harness.device,
            'bgra8unorm',
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        );

        expect(decision).toMatchObject({
            authorizedRouteKeys: [],
            failureReason: 'pixel-mismatch',
            status: 'rejected'
        });
        expect(harness.textureDestroy).toHaveBeenCalledTimes(4);
        expect(harness.bufferDestroy).toHaveBeenCalledTimes(3);
    });

    it('rejects an unreadable production target format before creating resources', async () => {
        const harness = createDeviceHarness([]);
        const runner = new RawHDRPresentationAuthorizationRunner();

        await expect(runner.validate(
            harness.device,
            'rgba16float',
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        )).resolves.toMatchObject({
            failureReason: 'target-format-unsupported',
            status: 'rejected'
        });
        expect(harness.createRenderPipelineAsync).not.toHaveBeenCalled();
        expect(harness.textureDestroy).not.toHaveBeenCalled();
    });

    it('rejects a GPU validation error and releases every created resource', async () => {
        const observations = createRouteObservations(
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        );
        const harness = createDeviceHarness(observations);
        harness.popErrorScope.mockResolvedValueOnce(new Error('invalid bind group'));
        const runner = new RawHDRPresentationAuthorizationRunner();

        await expect(runner.validate(
            harness.device,
            'bgra8unorm',
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        )).resolves.toMatchObject({
            failureReason: 'gpu-validation-failed',
            status: 'rejected'
        });
        expect(harness.textureDestroy).toHaveBeenCalledTimes(4);
        expect(harness.bufferDestroy).toHaveBeenCalledTimes(2);
    });

    it('rejects a bounded pipeline timeout', async () => {
        vi.useFakeTimers();
        const observations = createRouteObservations(
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        );
        const harness = createDeviceHarness(
            observations,
            new Promise<GPURenderPipeline>(() => undefined)
        );
        const runner = new RawHDRPresentationAuthorizationRunner();
        const decisionPromise = runner.validate(
            harness.device,
            'bgra8unorm',
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        );

        await vi.runAllTimersAsync();

        await expect(decisionPromise).resolves.toMatchObject({
            failureReason: 'timeout',
            status: 'rejected'
        });
    });

    it('applies the whole-route deadline to a batched readback', async () => {
        vi.useFakeTimers();
        const observations = createRouteObservations(
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        );
        const harness = createDeviceHarness(
            observations,
            undefined,
            () => new Promise<void>(() => undefined)
        );
        const runner = new RawHDRPresentationAuthorizationRunner();
        const decisionPromise = runner.validate(
            harness.device,
            'bgra8unorm',
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        );

        await vi.advanceTimersByTimeAsync(5_000);

        await expect(decisionPromise).resolves.toMatchObject({
            failureReason: 'timeout',
            status: 'rejected'
        });
        expect(harness.textureDestroy).toHaveBeenCalledTimes(4);
        expect(harness.bufferDestroy).toHaveBeenCalled();
    });

    it('rejects device loss without waiting for the timeout', async () => {
        const observations = createRouteObservations(
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        );
        const harness = createDeviceHarness(
            observations,
            new Promise<GPURenderPipeline>(() => undefined)
        );
        const runner = new RawHDRPresentationAuthorizationRunner();
        const decisionPromise = runner.validate(
            harness.device,
            'bgra8unorm',
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        );

        harness.lostResolve({
            message: 'authorization device lost',
            reason: 'unknown'
        } as GPUDeviceLostInfo);

        await expect(decisionPromise).resolves.toMatchObject({
            failureReason: 'device-lost',
            status: 'rejected'
        });
    });

    it('detects independently corrupted expected observations', () => {
        const expected = createRouteObservations(
            'I420P10:bt2020-ncl:bt2020:limited:pq'
        );
        expect(evaluateRawHDRFixtureObservations(expected, expected)).toMatchObject({
            accepted: true
        });
        expect(evaluateRawHDRFixtureObservations(
            expected,
            mutateFirstPixel(expected)
        )).toMatchObject({ accepted: false });
    });

    it('deduplicates probes and never authorizes a stale device identity', async () => {
        const firstHarness = createDeviceHarness([]);
        const secondHarness = createDeviceHarness([]);
        const routeKey = 'I420P10:bt2020-ncl:bt2020:limited:pq';
        const targetFormat = 'bgra8unorm';
        let resolveDecision: (decision: RawHDRRouteAuthorizationDecision) => void = (
            (decision: RawHDRRouteAuthorizationDecision): void => {
                throw new Error(`Decision resolver was not initialized: ${decision.status}`);
            }
        );
        const pendingDecision = new Promise<RawHDRRouteAuthorizationDecision>(resolve => {
            resolveDecision = resolve;
        });
        const runner = {
            validate: vi.fn(() => pendingDecision)
        } as unknown as RawHDRPresentationAuthorizationRunner;
        const registry = new RawHDRPresentationAuthorizationRegistry(runner);

        const firstPromise = registry.authorize(firstHarness.device, targetFormat, routeKey);
        const secondPromise = registry.authorize(firstHarness.device, targetFormat, routeKey);
        expect(firstPromise).toBe(secondPromise);
        await Promise.resolve();
        expect(runner.validate).toHaveBeenCalledOnce();
        expect(registry.getTelemetry(firstHarness.device, targetFormat)).toMatchObject({
            pendingRouteKeys: [ routeKey ],
            status: 'pending'
        });

        const decision = createAuthorizedDecision(firstHarness.device, routeKey, targetFormat);
        const metadata = createPQColorMetadata();
        const settings = createHDRToSDRRenderSettings();
        const exactShaderCode = createRawYUVColorPipelineWGSL(
            metadata,
            settings,
            'I420P10'
        );
        decision.shaderSignature = createRawHDRShaderSignature(targetFormat, exactShaderCode);
        resolveDecision(decision);
        await expect(firstPromise).resolves.toBe(decision);

        expect(registry.isAuthorized(
            firstHarness.device,
            targetFormat,
            metadata,
            settings,
            'I420P10'
        )).toBe(true);
        expect(registry.isAuthorized(
            secondHarness.device,
            targetFormat,
            metadata,
            settings,
            'I420P10'
        )).toBe(false);
        expect(registry.isAuthorized(
            firstHarness.device,
            'rgba8unorm',
            metadata,
            settings,
            'I420P10'
        )).toBe(false);
        expect(registry.isAuthorized(
            firstHarness.device,
            targetFormat,
            createPQColorMetadata({ range: 'full' }),
            settings,
            'I420P10'
        )).toBe(false);

        firstHarness.lostResolve({
            message: 'test loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await Promise.resolve();
        expect(registry.getTelemetry(firstHarness.device, targetFormat).status).toBe('unavailable');
    });
});
