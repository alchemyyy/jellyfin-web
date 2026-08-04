import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHDRToSDRRenderSettings } from '../RenderSettings';
import { createPQColorMetadata } from '../color/ColorMetadata';
import type { ColorTriplet } from '../color/ColorPipeline';
import { parseHEVCSPS } from '../custom/HEVCSPSParser';
import {
    createExpectedExternalHDRAuthorizationObservations,
    createExternalHDRAuthorizationFrame,
    createExternalHDRShaderSignature,
    ExternalHDRPresentationAuthorizationRegistry,
    ExternalHDRPresentationAuthorizationRunner,
    type ExternalHDRAuthorizationRouteKey,
    type ExternalHDRRouteAuthorizationDecision
} from './ExternalHDRPresentationAuthorization';
import type { RawHDRFixtureObservation } from './RawHDRPresentationAuthorization';

type MockFunction = ReturnType<typeof vi.fn>;

type MockBuffer = GPUBuffer & {
    bytes: Uint8Array
};

type DeviceHarness = {
    bindGroupEntries: GPUBindGroupEntry[]
    device: GPUDevice
    draw: MockFunction
    importExternalTexture: MockFunction
    textureDestroy: MockFunction
};

const PQ_ROUTE_KEY: ExternalHDRAuthorizationRouteKey =
    'external-hevc-main10-bt709-limited:pq-v1';
const HLG_ROUTE_KEY: ExternalHDRAuthorizationRouteKey =
    'external-hevc-main10-bt709-limited:hlg-v1';
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

function createSettings() {
    return createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits: 1_000 }
    });
}

function createExpectedObservations(
    routeKey: ExternalHDRAuthorizationRouteKey
): readonly RawHDRFixtureObservation[] {
    return createExpectedExternalHDRAuthorizationObservations(
        routeKey,
        createSettings()
    );
}

function createFrame(close: MockFunction): VideoFrame {
    return {
        close,
        displayHeight: 1_080,
        displayWidth: 1_920
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
    const draw = vi.fn();
    const renderPass = {
        draw,
        end: vi.fn(),
        setBindGroup: vi.fn(),
        setPipeline: vi.fn(),
        setViewport: vi.fn()
    };
    const bindGroupEntries: GPUBindGroupEntry[] = [];
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
        lost: new Promise<GPUDeviceLostInfo>(() => undefined),
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

function findAnnexBNALUnit(data: Uint8Array, nalUnitType: number): Uint8Array {
    const startOffsets: number[] = [];
    for (let offset = 0; offset + 4 <= data.byteLength; offset += 1) {
        if (
            data[offset] === 0
            && data[offset + 1] === 0
            && data[offset + 2] === 0
            && data[offset + 3] === 1
        ) {
            startOffsets.push(offset);
        }
    }
    for (let startIndex = 0; startIndex < startOffsets.length; startIndex += 1) {
        const nalUnitStart = startOffsets[startIndex] + 4;
        const nalUnitEnd = startOffsets[startIndex + 1] ?? data.byteLength;
        const nalUnit = data.subarray(nalUnitStart, nalUnitEnd);
        if (((nalUnit[0] >> 1) & 0x3F) === nalUnitType) {
            return nalUnit;
        }
    }
    throw new TypeError(`Access unit has no HEVC NAL unit type ${nalUnitType}`);
}

describe('External HDR presentation authorization', () => {
    beforeEach(() => {
        Object.defineProperty(globalThis, 'GPUBufferUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 1, MAP_READ: 2, UNIFORM: 4 }
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
        vi.useRealTimers();
        restoreProperty(globalThis, 'GPUBufferUsage', originalGPUBufferUsage);
        restoreProperty(globalThis, 'GPUMapMode', originalGPUMapMode);
        restoreProperty(globalThis, 'GPUTextureUsage', originalGPUTextureUsage);
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it.each([ PQ_ROUTE_KEY, HLG_ROUTE_KEY ])(
        'authorizes exact output and closes the frame for %s',
        async (routeKey: ExternalHDRAuthorizationRouteKey) => {
            const harness = createDeviceHarness(createExpectedObservations(routeKey));
            const close = vi.fn();
            const frame = createFrame(close);
            const runner = new ExternalHDRPresentationAuthorizationRunner(
                async (): Promise<VideoFrame> => frame
            );

            const decision = await runner.validate(harness.device, 'bgra8unorm', routeKey);

            expect(decision).toMatchObject({
                authorizedRouteKeys: [ routeKey ],
                failureReason: null,
                routeKey,
                sampleCount: 8,
                status: 'authorized'
            });
            expect(harness.importExternalTexture).toHaveBeenCalledWith({
                colorSpace: 'srgb',
                source: frame
            });
            expect(harness.bindGroupEntries.map(entry => entry.binding)).toEqual([
                0, 1, 2, 3
            ]);
            expect(harness.draw).toHaveBeenCalledOnce();
            expect(close).toHaveBeenCalledOnce();
            expect(harness.textureDestroy).toHaveBeenCalledOnce();
        }
    );

    it('rejects a bounded pixel mismatch and still closes the frame', async () => {
        const harness = createDeviceHarness(mutateFirstObservation(
            createExpectedObservations(PQ_ROUTE_KEY)
        ));
        const close = vi.fn();
        const runner = new ExternalHDRPresentationAuthorizationRunner(
            async (): Promise<VideoFrame> => createFrame(close)
        );

        await expect(runner.validate(harness.device, 'bgra8unorm', PQ_ROUTE_KEY))
            .resolves.toMatchObject({
                failureReason: 'pixel-mismatch',
                status: 'rejected'
            });
        expect(close).toHaveBeenCalledOnce();
    });

    it('classifies external-texture import failure and closes the frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        harness.importExternalTexture.mockImplementation(() => {
            throw new Error('simulated import failure');
        });
        const close = vi.fn();
        const runner = new ExternalHDRPresentationAuthorizationRunner(
            async (): Promise<VideoFrame> => createFrame(close)
        );

        await expect(runner.validate(harness.device, 'bgra8unorm', PQ_ROUTE_KEY))
            .resolves.toMatchObject({
                failureReason: 'frame-import-failed',
                status: 'rejected'
            });
        expect(close).toHaveBeenCalledOnce();
    });

    it('bounds an authorization frame that never resolves', async () => {
        vi.useFakeTimers();
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const lateClose = vi.fn();
        const deferredFrame: {
            resolve: ((frame: VideoFrame) => void) | null
        } = { resolve: null };
        const createFrameFactory = vi.fn(() => new Promise<VideoFrame>(resolve => {
            deferredFrame.resolve = resolve;
        }));
        const runner = new ExternalHDRPresentationAuthorizationRunner(createFrameFactory);

        const decisionPromise = runner.validate(harness.device, 'bgra8unorm', PQ_ROUTE_KEY);
        await Promise.resolve();
        await Promise.resolve();
        expect(createFrameFactory).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(5_000);

        await expect(decisionPromise).resolves.toMatchObject({
            failureReason: 'timeout',
            status: 'rejected'
        });
        const resolveFrame = deferredFrame.resolve;
        if (!resolveFrame) {
            throw new Error('The late frame resolver was not initialized');
        }
        resolveFrame(createFrame(lateClose));
        await Promise.resolve();
        await Promise.resolve();
        expect(lateClose).toHaveBeenCalledOnce();
    });

    it('deduplicates route authorization and exposes settled telemetry', async () => {
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const runner = new ExternalHDRPresentationAuthorizationRunner(
            async (): Promise<VideoFrame> => createFrame(vi.fn())
        );
        const validate = vi.spyOn(runner, 'validate');
        const registry = new ExternalHDRPresentationAuthorizationRegistry(runner);

        const firstDecision = registry.authorize(
            harness.device,
            'bgra8unorm',
            PQ_ROUTE_KEY
        );
        const secondDecision = registry.authorize(
            harness.device,
            'bgra8unorm',
            PQ_ROUTE_KEY
        );
        expect(secondDecision).toBe(firstDecision);
        expect(registry.getTelemetry(harness.device, 'bgra8unorm').status).toBe('pending');

        const decision: ExternalHDRRouteAuthorizationDecision = await firstDecision;
        expect(decision.status).toBe('authorized');
        expect(validate).toHaveBeenCalledOnce();
        expect(registry.isAuthorized(
            harness.device,
            'bgra8unorm',
            createPQColorMetadata(),
            createSettings()
        )).toBe(true);
        expect(registry.getTelemetry(harness.device, 'bgra8unorm')).toMatchObject({
            authorizedRouteKeys: [ PQ_ROUTE_KEY ],
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        });
    });

    it('scopes authorization to exact GPUDevice identity', async () => {
        const firstHarness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const secondHarness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const runner = new ExternalHDRPresentationAuthorizationRunner(
            async (): Promise<VideoFrame> => createFrame(vi.fn())
        );
        const validate = vi.spyOn(runner, 'validate');
        const registry = new ExternalHDRPresentationAuthorizationRegistry(runner);

        await registry.authorize(firstHarness.device, 'bgra8unorm', PQ_ROUTE_KEY);
        expect(registry.isAuthorized(
            secondHarness.device,
            'bgra8unorm',
            createPQColorMetadata(),
            createSettings()
        )).toBe(false);
        await registry.authorize(secondHarness.device, 'bgra8unorm', PQ_ROUTE_KEY);

        expect(validate).toHaveBeenCalledTimes(2);
        expect(registry.isAuthorized(
            secondHarness.device,
            'bgra8unorm',
            createPQColorMetadata(),
            createSettings()
        )).toBe(true);
    });

    it('rejects unsupported targets before constructing a frame', async () => {
        const harness = createDeviceHarness(createExpectedObservations(PQ_ROUTE_KEY));
        const createFrameFactory = vi.fn(async (): Promise<VideoFrame> => (
            createFrame(vi.fn())
        ));
        const runner = new ExternalHDRPresentationAuthorizationRunner(createFrameFactory);

        await expect(runner.validate(harness.device, 'rgba16float', PQ_ROUTE_KEY))
            .resolves.toMatchObject({
                failureReason: 'target-format-unsupported',
                status: 'rejected'
            });
        expect(createFrameFactory).not.toHaveBeenCalled();
    });

    it('includes route, shader, and target in the stable signature', () => {
        const signature = createExternalHDRShaderSignature(
            'bgra8unorm',
            PQ_ROUTE_KEY,
            'shader'
        );
        expect(signature).toBe(createExternalHDRShaderSignature(
            'bgra8unorm',
            PQ_ROUTE_KEY,
            'shader'
        ));
        expect(signature).not.toBe(createExternalHDRShaderSignature(
            'rgba8unorm',
            PQ_ROUTE_KEY,
            'shader'
        ));
        expect(signature).not.toBe(createExternalHDRShaderSignature(
            'bgra8unorm',
            HLG_ROUTE_KEY,
            'shader'
        ));
    });

    it('creates only an opaque, neutralized hardware decoder frame', async () => {
        const close = vi.fn();
        const configured = vi.fn();
        const closed = vi.fn();
        let decodedAccessUnit: Uint8Array | null = null;
        const outputFrame = {
            close,
            codedHeight: 1_088,
            codedWidth: 1_920,
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            displayHeight: 1_080,
            displayWidth: 1_920,
            format: null,
            timestamp: 0,
            visibleRect: { height: 1_080, width: 1_920, x: 0, y: 0 }
        } as unknown as VideoFrame;
        let decoderInit: VideoDecoderInit | null = null;

        class FakeEncodedVideoChunk {
            public constructor(init: EncodedVideoChunkInit) {
                const source = init.data;
                decodedAccessUnit = ArrayBuffer.isView(source) ?
                    new Uint8Array(source.buffer, source.byteOffset, source.byteLength).slice() :
                    new Uint8Array(source).slice();
            }
        }
        class FakeVideoDecoder {
            public static readonly isConfigSupported = vi.fn(
                async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
                    config,
                    supported: true
                })
            );

            public constructor(init: VideoDecoderInit) {
                decoderInit = init;
            }

            public close(): void {
                closed();
            }

            public configure(config: VideoDecoderConfig): void {
                configured(config);
            }

            public decode(): void {
                decoderInit?.output(outputFrame);
            }

            public async flush(): Promise<void> {
                return undefined;
            }
        }
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);

        const frame = await createExternalHDRAuthorizationFrame();

        expect(frame).toBe(outputFrame);
        expect(configured).toHaveBeenCalledWith(expect.objectContaining({
            codec: 'hvc1.2.4.L120.B0',
            codedHeight: 1_088,
            codedWidth: 1_920,
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            hardwareAcceleration: 'prefer-hardware'
        }));
        expect(decodedAccessUnit).not.toBeNull();
        expect(parseHEVCSPS(findAnnexBNALUnit(
            decodedAccessUnit as unknown as Uint8Array,
            33
        )).colorSpace).toEqual({
            fullRange: false,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'bt709'
        });
        expect(closed).toHaveBeenCalledOnce();
        expect(close).not.toHaveBeenCalled();
        frame.close();
        expect(close).toHaveBeenCalledOnce();
    });

    it('rejects an unsupported decoder configuration before constructing a decoder', async () => {
        const constructed = vi.fn();
        class FakeEncodedVideoChunk {}
        class FakeVideoDecoder {
            public static readonly isConfigSupported = vi.fn(
                async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
                    config,
                    supported: false
                })
            );

            public constructor() {
                constructed();
            }
        }
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);

        await expect(createExternalHDRAuthorizationFrame())
            .rejects.toThrow('decoder-config-unsupported');
        expect(constructed).not.toHaveBeenCalled();
    });

    it('closes the decoder after a decoder error', async () => {
        const closed = vi.fn();
        let decoderInit: VideoDecoderInit | null = null;
        class FakeEncodedVideoChunk {}
        class FakeVideoDecoder {
            public static readonly isConfigSupported = vi.fn(
                async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
                    config,
                    supported: true
                })
            );

            public constructor(init: VideoDecoderInit) {
                decoderInit = init;
            }

            public close(): void {
                closed();
            }

            public configure(): void {
                return undefined;
            }

            public decode(): void {
                decoderInit?.error(new DOMException('fixture decode failed'));
            }

            public async flush(): Promise<void> {
                return undefined;
            }
        }
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);

        await expect(createExternalHDRAuthorizationFrame())
            .rejects.toThrow('fixture decode failed');
        expect(closed).toHaveBeenCalledOnce();
    });

    it('closes a decoder whose flush is cancelled', async () => {
        const closed = vi.fn();
        const flush = vi.fn(() => new Promise<void>(() => undefined));
        class FakeEncodedVideoChunk {}
        class FakeVideoDecoder {
            public static readonly isConfigSupported = vi.fn(
                async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
                    config,
                    supported: true
                })
            );

            public close(): void {
                closed();
            }

            public configure(): void {
                return undefined;
            }

            public decode(): void {
                return undefined;
            }

            public flush(): Promise<void> {
                return flush();
            }
        }
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        // eslint-disable-next-line compat/compat -- WebGPU custom decode targets modern Chromium
        const abortController = new AbortController();

        const framePromise = createExternalHDRAuthorizationFrame(abortController.signal);
        await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
        abortController.abort();

        await expect(framePromise).rejects.toMatchObject({ name: 'AbortError' });
        expect(closed).toHaveBeenCalledOnce();
    });
});
