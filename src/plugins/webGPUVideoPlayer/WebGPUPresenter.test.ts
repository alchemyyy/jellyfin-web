import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const webSettingsMockState = vi.hoisted(() => ({
    hdrToneMappingEnabled: false
}));
const rawHDRAuthorizationMockState = vi.hoisted(() => ({
    authorized: true,
    prewarmCalls: [] as Array<{ device: GPUDevice, targetFormat: GPUTextureFormat }>
}));
const dolbyVisionAuthorizationMockState = vi.hoisted(() => ({
    authorizeCalls: [] as GPUDevice[],
    authorized: true,
    prewarmCalls: [] as Array<{ device: GPUDevice, targetFormat: GPUTextureFormat }>
}));

vi.mock('scripts/settings/webSettings', () => ({
    getWebGPUHDRToneMappingEnabled: vi.fn(
        (): Promise<boolean> => Promise.resolve(webSettingsMockState.hdrToneMappingEnabled)
    )
}));

vi.mock('./validation/RawHDRPresentationAuthorization', () => ({
    getRawHDRAuthorizationRouteKey: vi.fn(() => (
        'I420P10:bt2020-ncl:bt2020:limited:pq'
    )),
    RawHDRPresentationAuthorizationRegistry: class MockRawHDRAuthorizationRegistry {
        authorize = vi.fn(async () => ({
            status: rawHDRAuthorizationMockState.authorized ? 'authorized' : 'rejected'
        }));

        prewarm = vi.fn((device: GPUDevice, targetFormat: GPUTextureFormat): void => {
            rawHDRAuthorizationMockState.prewarmCalls.push({ device, targetFormat });
        });

        isAuthorized = vi.fn((): boolean => rawHDRAuthorizationMockState.authorized);

        getTelemetry = vi.fn((_device: GPUDevice | null, targetFormat: GPUTextureFormat | null) => ({
            authorizedRouteKeys: rawHDRAuthorizationMockState.authorized ?
                [
                    'I420P10:bt2020-ncl:bt2020:limited:pq',
                    'I420P10:bt2020-ncl:bt2020:limited:hlg'
                ] :
                [],
            failureReasons: {},
            fixtureVersion: 1,
            pendingRouteKeys: [],
            rejectedRouteKeys: rawHDRAuthorizationMockState.authorized ? [] :
                [
                    'I420P10:bt2020-ncl:bt2020:limited:pq',
                    'I420P10:bt2020-ncl:bt2020:limited:hlg'
                ],
            renderSettingsVersion: 4,
            status: rawHDRAuthorizationMockState.authorized ? 'authorized' : 'rejected',
            targetFormat
        }));
    }
}));

vi.mock('./validation/DolbyVisionPresentationAuthorization', () => ({
    DolbyVisionPresentationAuthorizationRegistry: class MockDolbyVisionAuthorizationRegistry {
        authorize = vi.fn(async (device: GPUDevice) => {
            dolbyVisionAuthorizationMockState.authorizeCalls.push(device);
            return {
                status: dolbyVisionAuthorizationMockState.authorized ? 'authorized' : 'rejected'
            };
        });

        prewarm = vi.fn((device: GPUDevice, targetFormat: GPUTextureFormat): void => {
            dolbyVisionAuthorizationMockState.prewarmCalls.push({ device, targetFormat });
        });

        waitForPending = vi.fn((): Promise<void> => Promise.resolve());

        isAuthorized = vi.fn((): boolean => dolbyVisionAuthorizationMockState.authorized);

        getTelemetry = vi.fn((_device: GPUDevice | null, targetFormat: GPUTextureFormat | null) => ({
            failureReason: dolbyVisionAuthorizationMockState.authorized ? null : 'pixel-mismatch',
            fixtureVersion: 1,
            maximumChannelError: dolbyVisionAuthorizationMockState.authorized ? 0 : 1,
            renderSettingsVersion: 4,
            routeKey: 'I420P10:dovi-rpu-v1',
            sampleCount: 4,
            status: dolbyVisionAuthorizationMockState.authorized ? 'authorized' : 'rejected',
            targetFormat
        }));
    }
}));

import { createPQColorMetadata, type InputColorMetadata } from './color/ColorMetadata';
import {
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from './custom/RawVideoFrameCopy';
import {
    DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION,
    type TransferableDolbyVisionEncodedFrameMetadata
} from './custom/DolbyVisionEncodedMetadataProtocol';
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from './custom/DolbyVisionRPUParser';
import { microsecondsToMilliseconds, secondsToMicroseconds } from './MediaTime';
import { createHDRToSDRRenderSettings } from './RenderSettings';
import { createDolbyVisionAuthorizationRPUFixture } from './validation/DolbyVisionAuthorizationFixture';
import WebGPUPresenter, {
    type PresentationSurface,
    WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS
} from './WebGPUPresenter';

type MockFunction = ReturnType<typeof vi.fn>;

type Deferred<Value> = {
    promise: Promise<Value>
    resolve: (value: Value) => void
};

type CanvasContextHarness = {
    context: GPUCanvasContext
    configure: MockFunction
    getCurrentTexture: MockFunction
    unconfigure: MockFunction
};

type DeviceHarness = {
    createBindGroup: MockFunction
    createBuffer: MockFunction
    createShaderModule: MockFunction
    createTexture: MockFunction
    createRenderPipelineAsync: MockFunction
    device: GPUDevice
    dispatchUncapturedError: (error: GPUError) => boolean
    destroy: MockFunction
    importExternalTexture: MockFunction
    lost: Deferred<GPUDeviceLostInfo>
    popErrorScope: MockFunction
    pushErrorScope: MockFunction
    queueSubmit: MockFunction
    queueWriteBuffer: MockFunction
    queueWriteTexture: MockFunction
    renderPassSetViewport: MockFunction
    textureDestroy: MockFunction
};

type GPUHarness = {
    devices: DeviceHarness[]
    gpu: GPU
    requestAdapter: MockFunction
    requestDevice: MockFunction
};

type SurfaceHarness = {
    callbacks: Map<number, VideoFrameRequestCallback>
    cancelVideoFrameCallback: MockFunction
    requestVideoFrameCallback: MockFunction
    surface: PresentationSurface
};

const originalCanvasGetContext = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    'getContext'
);
const originalDevicePixelRatio = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
const originalGPU = Object.getOwnPropertyDescriptor(navigator, 'gpu');
const originalGPUBufferUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUBufferUsage');
const originalGPUTextureUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUTextureUsage');
const originalGPUValidationError = Object.getOwnPropertyDescriptor(globalThis, 'GPUValidationError');
const originalResizeObserver = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
const originalSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');

function createDeferred<Value>(): Deferred<Value> {
    let resolvePromise: (value: Value) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    const promise = new Promise<Value>(resolve => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

function createCanvasContextHarness(): CanvasContextHarness {
    const configure = vi.fn();
    const unconfigure = vi.fn();
    const getCurrentTexture = vi.fn(() => ({
        createView: vi.fn(() => ({}))
    }));
    const context = {
        canvas: document.createElement('canvas'),
        configure,
        getCurrentTexture,
        unconfigure
    } as unknown as GPUCanvasContext;
    return { configure, context, getCurrentTexture, unconfigure };
}

function createDeviceHarness(): DeviceHarness {
    const deviceEventTarget = new EventTarget();
    const lost = createDeferred<GPUDeviceLostInfo>();
    const renderPassSetViewport = vi.fn();
    const renderPass = {
        draw: vi.fn(),
        end: vi.fn(),
        setBindGroup: vi.fn(),
        setPipeline: vi.fn(),
        setViewport: renderPassSetViewport
    };
    const commandEncoder = {
        beginRenderPass: vi.fn(() => renderPass),
        finish: vi.fn(() => ({}))
    };
    const pipeline = {
        getBindGroupLayout: vi.fn(() => ({}))
    };
    const queueSubmit = vi.fn();
    const queueWriteBuffer = vi.fn();
    const queueWriteTexture = vi.fn();
    const importExternalTexture = vi.fn(() => ({}));
    const createRenderPipelineAsync = vi.fn(() => Promise.resolve(pipeline));
    const createShaderModule = vi.fn(() => ({}));
    const createBindGroup = vi.fn(() => ({}));
    const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => ({
        destroy: vi.fn(),
        label: descriptor.label
    }));
    const textureDestroy = vi.fn();
    const createTexture = vi.fn((descriptor: GPUTextureDescriptor) => ({
        createView: vi.fn(() => ({ label: descriptor.label })),
        destroy: textureDestroy,
        label: descriptor.label
    }));
    const destroy = vi.fn();
    const popErrorScope = vi.fn(() => Promise.resolve(null));
    const pushErrorScope = vi.fn();
    const device = {
        addEventListener: deviceEventTarget.addEventListener.bind(deviceEventTarget),
        createBindGroup,
        createBuffer,
        createCommandEncoder: vi.fn(() => commandEncoder),
        createRenderPipelineAsync,
        createSampler: vi.fn(() => ({})),
        createShaderModule,
        createTexture,
        destroy,
        features: new Set<GPUFeatureName>(),
        importExternalTexture,
        label: '',
        limits: { maxTextureDimension2D: 8_192 },
        lost: lost.promise,
        popErrorScope,
        pushErrorScope,
        queue: {
            submit: queueSubmit,
            writeBuffer: queueWriteBuffer,
            writeTexture: queueWriteTexture
        },
        removeEventListener: deviceEventTarget.removeEventListener.bind(deviceEventTarget)
    } as unknown as GPUDevice;
    const dispatchUncapturedError = (error: GPUError): boolean => {
        const event = new Event('uncapturederror', { cancelable: true });
        Object.defineProperty(event, 'error', { value: error });
        return deviceEventTarget.dispatchEvent(event);
    };

    return {
        createBindGroup,
        createBuffer,
        createShaderModule,
        createTexture,
        createRenderPipelineAsync,
        device,
        dispatchUncapturedError,
        destroy,
        importExternalTexture,
        lost,
        popErrorScope,
        pushErrorScope,
        queueSubmit,
        queueWriteBuffer,
        queueWriteTexture,
        renderPassSetViewport,
        textureDestroy
    };
}

function createGPUHarness(deviceCount = 1): GPUHarness {
    const devices: DeviceHarness[] = [];
    for (let deviceIndex = 0; deviceIndex < deviceCount; deviceIndex += 1) {
        devices.push(createDeviceHarness());
    }

    let requestedDeviceIndex = 0;
    const requestDevice = vi.fn(() => {
        const deviceHarness = devices[requestedDeviceIndex];
        requestedDeviceIndex += 1;
        return Promise.resolve(deviceHarness?.device);
    });
    const adapter = { requestDevice } as unknown as GPUAdapter;
    const requestAdapter = vi.fn(() => Promise.resolve(adapter));
    const gpu = {
        getPreferredCanvasFormat: vi.fn(() => 'bgra8unorm'),
        requestAdapter
    } as unknown as GPU;
    return { devices, gpu, requestAdapter, requestDevice };
}

function createRectangle(left: number, top: number, width: number, height: number): DOMRect {
    return {
        bottom: top + height,
        height,
        left,
        right: left + width,
        toJSON: () => ({}),
        top,
        width,
        x: left,
        y: top
    };
}

function createSurfaceHarness(width = 1_280, height = 720): SurfaceHarness {
    const container = document.createElement('div');
    const video = document.createElement('video');
    const callbacks = new Map<number, VideoFrameRequestCallback>();
    let nextCallbackId = 1;
    const requestVideoFrameCallback = vi.fn((callback: VideoFrameRequestCallback) => {
        const callbackId = nextCallbackId;
        nextCallbackId += 1;
        callbacks.set(callbackId, callback);
        return callbackId;
    });
    const cancelVideoFrameCallback = vi.fn();

    Object.defineProperties(container, {
        clientHeight: { configurable: true, value: height },
        clientWidth: { configurable: true, value: width }
    });
    Object.defineProperties(video, {
        cancelVideoFrameCallback: { configurable: true, value: cancelVideoFrameCallback },
        readyState: { configurable: true, value: VIDEO_READY_STATE_CURRENT_DATA },
        requestVideoFrameCallback: { configurable: true, value: requestVideoFrameCallback },
        videoHeight: { configurable: true, value: 1_080 },
        videoWidth: { configurable: true, value: 1_920 }
    });
    container.getBoundingClientRect = vi.fn(() => createRectangle(0, 0, width, height));
    video.getBoundingClientRect = vi.fn(() => createRectangle(0, 0, width, height));
    container.appendChild(video);
    document.body.appendChild(container);

    return {
        callbacks,
        cancelVideoFrameCallback,
        requestVideoFrameCallback,
        surface: { container, video }
    };
}

function createFrameMetadata(mediaTime = 1.234567): VideoFrameCallbackMetadata {
    const callbackTime = performance.now();
    return {
        expectedDisplayTime: callbackTime + 1,
        height: 1_080,
        mediaTime,
        presentationTime: callbackTime,
        presentedFrames: 1,
        processingDuration: 0.001,
        width: 1_920
    };
}

type RawPlaneDefinition = {
    bytesPerComponent: 1 | 2
    componentsPerTexel: 1 | 2
    heightDivisor: 1 | 2
    kind: 'u' | 'uv' | 'v' | 'y'
    widthDivisor: 1 | 2
};

function createRawFrame(
    format: SupportedRawVideoFrameFormat,
    metadata: InputColorMetadata,
    codedWidth = 8,
    codedHeight = 4,
    visibleRectangle = { height: codedHeight, width: codedWidth, x: 0, y: 0 }
): TransferableRawVideoFrame {
    const planeDefinitions: RawPlaneDefinition[] = [];
    switch (format) {
        case 'I420':
            planeDefinitions.push(
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 1, kind: 'y', widthDivisor: 1 },
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 2, kind: 'u', widthDivisor: 2 },
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 2, kind: 'v', widthDivisor: 2 }
            );
            break;
        case 'I420P10':
        case 'I420P12':
            planeDefinitions.push(
                { bytesPerComponent: 2, componentsPerTexel: 1, heightDivisor: 1, kind: 'y', widthDivisor: 1 },
                { bytesPerComponent: 2, componentsPerTexel: 1, heightDivisor: 2, kind: 'u', widthDivisor: 2 },
                { bytesPerComponent: 2, componentsPerTexel: 1, heightDivisor: 2, kind: 'v', widthDivisor: 2 }
            );
            break;
        case 'NV12':
            planeDefinitions.push(
                { bytesPerComponent: 1, componentsPerTexel: 1, heightDivisor: 1, kind: 'y', widthDivisor: 1 },
                { bytesPerComponent: 1, componentsPerTexel: 2, heightDivisor: 2, kind: 'uv', widthDivisor: 2 }
            );
            break;
    }

    const planes: TransferableRawVideoFrame['planes'][number][] = [];
    let byteOffset = 0;
    for (const definition of planeDefinitions) {
        const width = Math.ceil(codedWidth / definition.widthDivisor);
        const height = Math.ceil(codedHeight / definition.heightDivisor);
        const rowByteLength = width
            * definition.componentsPerTexel
            * definition.bytesPerComponent;
        const bytesPerRow = Math.ceil(rowByteLength / 256) * 256;
        const byteLength = bytesPerRow * height;
        planes.push({
            byteLength,
            byteOffset,
            bytesPerComponent: definition.bytesPerComponent,
            bytesPerRow,
            componentsPerTexel: definition.componentsPerTexel,
            height,
            kind: definition.kind,
            rowByteLength,
            width
        });
        byteOffset += byteLength;
    }

    const durationMicroseconds = secondsToMicroseconds(1 / 24);
    const timestampMicroseconds = secondsToMicroseconds(2);
    return {
        bitDepth: metadata.bitDepth as 8 | 10 | 12,
        codedHeight,
        codedWidth,
        colorSpace: {
            fullRange: metadata.range === 'full',
            matrix: metadata.matrix,
            primaries: metadata.primaries,
            transfer: metadata.transfer === 'pq' ? 'smpte2084' : 'arib-std-b67'
        },
        data: new ArrayBuffer(byteOffset),
        displayHeight: visibleRectangle.height,
        displayWidth: visibleRectangle.width,
        durationMicroseconds,
        format,
        planes,
        timestampMicroseconds,
        visibleRectangle
    };
}

function createCompoundDolbyVisionRawFrames(): {
    baseFrame: TransferableRawVideoFrame
    enhancementFrame: TransferableRawVideoFrame
} {
    const metadata = createPQColorMetadata();
    const baseFrameTemplate = createRawFrame('I420P10', metadata, 8, 4);
    const enhancementFrameTemplate = createRawFrame('I420P10', metadata, 4, 2);
    const enhancementByteOffset = baseFrameTemplate.data.byteLength;
    const data = new ArrayBuffer(
        enhancementByteOffset + enhancementFrameTemplate.data.byteLength
    );
    return {
        baseFrame: {
            ...baseFrameTemplate,
            data
        },
        enhancementFrame: {
            ...enhancementFrameTemplate,
            data,
            planes: enhancementFrameTemplate.planes.map(plane => ({
                ...plane,
                byteOffset: plane.byteOffset + enhancementByteOffset
            }))
        }
    };
}

function createDolbyVisionEncodedMetadata(
    packedRPUData = createDolbyVisionAuthorizationRPUFixture(),
    enhancementLayerDisposition: TransferableDolbyVisionEncodedFrameMetadata[
        'enhancementLayerDisposition'
    ] = 'absent',
    hasEnhancementLayerVCL = false
): TransferableDolbyVisionEncodedFrameMetadata {
    return {
        enhancementLayerDisposition,
        hasEnhancementLayerVCL,
        parsedRPUData: [ packedRPUData ],
        schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
    };
}

function installGPU(gpu: GPU): void {
    Object.defineProperty(navigator, 'gpu', {
        configurable: true,
        value: gpu
    });
}

function installCanvasContext(context: GPUCanvasContext | null): void {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: vi.fn((contextId: string) => contextId === 'webgpu' ? context : null)
    });
}

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

const VIDEO_READY_STATE_CURRENT_DATA = 2;

describe('WebGPUPresenter', () => {
    beforeEach(() => {
        webSettingsMockState.hdrToneMappingEnabled = false;
        rawHDRAuthorizationMockState.authorized = true;
        rawHDRAuthorizationMockState.prewarmCalls = [];
        dolbyVisionAuthorizationMockState.authorizeCalls = [];
        dolbyVisionAuthorizationMockState.authorized = true;
        dolbyVisionAuthorizationMockState.prewarmCalls = [];
        Object.defineProperty(window, 'isSecureContext', {
            configurable: true,
            value: true
        });
        Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true,
            value: 1
        });
        Object.defineProperty(globalThis, 'GPUBufferUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 8, STORAGE: 128, UNIFORM: 64 }
        });
        Object.defineProperty(globalThis, 'GPUValidationError', {
            configurable: true,
            value: class extends Error {}
        });
        Object.defineProperty(globalThis, 'GPUTextureUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 2, TEXTURE_BINDING: 4 }
        });
        Object.defineProperty(globalThis, 'ResizeObserver', {
            configurable: true,
            value: class {
                disconnect = vi.fn();
                observe = vi.fn();
            }
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.useRealTimers();
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        restoreProperty(HTMLCanvasElement.prototype, 'getContext', originalCanvasGetContext);
        restoreProperty(navigator, 'gpu', originalGPU);
        restoreProperty(globalThis, 'GPUBufferUsage', originalGPUBufferUsage);
        restoreProperty(globalThis, 'GPUTextureUsage', originalGPUTextureUsage);
        restoreProperty(globalThis, 'GPUValidationError', originalGPUValidationError);
        restoreProperty(globalThis, 'ResizeObserver', originalResizeObserver);
        restoreProperty(window, 'devicePixelRatio', originalDevicePixelRatio);
        restoreProperty(window, 'isSecureContext', originalSecureContext);
    });

    it('falls back once in an insecure context without touching playback DOM', async () => {
        Object.defineProperty(window, 'isSecureContext', {
            configurable: true,
            value: false
        });
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'insecure-context');
        expect(document.querySelector('.webgpuVideoPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('falls back when no WebGPU adapter is available', async () => {
        const gpuHarness = createGPUHarness();
        gpuHarness.requestAdapter.mockResolvedValue(null);
        installGPU(gpuHarness.gpu);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'adapter-unavailable');
        expect(gpuHarness.requestDevice).not.toHaveBeenCalled();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('bounds an adapter request that never settles', async () => {
        vi.useFakeTimers();
        const gpuHarness = createGPUHarness();
        gpuHarness.requestAdapter.mockReturnValue(new Promise<GPUAdapter | null>(() => undefined));
        installGPU(gpuHarness.gpu);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        await vi.advanceTimersByTimeAsync(
            microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS)
        );

        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'adapter-unavailable');
        expect(gpuHarness.requestDevice).not.toHaveBeenCalled();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('falls back when WebGPU device acquisition fails', async () => {
        const gpuHarness = createGPUHarness();
        gpuHarness.requestDevice.mockRejectedValue(new Error('simulated device request failure'));
        installGPU(gpuHarness.gpu);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'device-request-failed');
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('destroys the device and falls back when pipeline creation fails', async () => {
        const gpuHarness = createGPUHarness();
        const deviceHarness = gpuHarness.devices[0];
        deviceHarness.createRenderPipelineAsync.mockRejectedValue(
            new Error('simulated pipeline creation failure')
        );
        installGPU(gpuHarness.gpu);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'pipeline-creation-failed');
        expect(deviceHarness.destroy).toHaveBeenCalledOnce();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('removes the canvas and falls back when canvas configuration throws', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        contextHarness.configure.mockImplementation(() => {
            throw new Error('simulated canvas configuration failure');
        });
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'canvas-configuration-failed');
        expect(contextHarness.unconfigure).toHaveBeenCalledOnce();
        expect(surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('falls back when the initial video frame callback request throws', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        surfaceHarness.requestVideoFrameCallback.mockImplementation(() => {
            throw new Error('simulated frame callback request failure');
        });
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(
            1,
            'request-video-frame-callback-unavailable'
        );
        expect(surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('falls back when requesting the next video frame callback throws', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.requestVideoFrameCallback.mockImplementation(() => {
            throw new Error('simulated next frame callback request failure');
        });

        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(fallbackHandler).toHaveBeenCalledWith(
            1,
            'request-video-frame-callback-unavailable'
        );
        expect(gpuHarness.devices[0].queueSubmit).toHaveBeenCalledOnce();
        expect(surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('imports and submits one external texture in the video frame callback task', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());

        const canvas = surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas');
        expect(canvas).toBeInstanceOf(HTMLCanvasElement);
        expect(canvas?.classList.contains('webgpuVideoPlayerCanvas-visible')).toBe(false);

        const callback = surfaceHarness.callbacks.get(1);
        expect(callback).toBeDefined();
        callback?.(performance.now() + 1, createFrameMetadata());

        const deviceHarness = gpuHarness.devices[0];
        expect(deviceHarness.importExternalTexture).toHaveBeenCalledWith({
            colorSpace: 'srgb',
            source: surfaceHarness.surface.video
        });
        expect(deviceHarness.queueWriteBuffer).toHaveBeenCalledOnce();
        expect(deviceHarness.queueSubmit).toHaveBeenCalledOnce();
        expect(deviceHarness.pushErrorScope).toHaveBeenCalledWith('validation');
        expect(deviceHarness.popErrorScope).toHaveBeenCalledOnce();
        expect(canvas?.classList.contains('webgpuVideoPlayerCanvas-visible')).toBe(false);
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce();
        expect(presenter.getTelemetry().presentedFrameCount).toBe(0);

        await vi.waitFor(() => {
            expect(canvas?.classList.contains('webgpuVideoPlayerCanvas-visible')).toBe(true);
            expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
        });
        expect(presenter.getTelemetry()).toMatchObject({
            fallbackReason: null,
            lastPresentedMediaTimeMicroseconds: 1_234_567,
            mode: 'identity-sdr',
            presentedFrameCount: 1,
            state: 'presenting'
        });
    });

    it('prefers an owned custom decoded frame and closes it after submission', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const closeFrame = vi.fn();
        const decodedFrame = { close: closeFrame } as unknown as VideoFrame;
        const takeFrame = vi.fn(() => ({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame: decodedFrame,
            mediaTimeMicroseconds: secondsToMicroseconds(1.2),
            outputMode: 'video-frame' as const
        }));

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        presenter.setDecodedFrameProvider({ takeFrame }, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());

        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata(1.234567));

        expect(takeFrame).toHaveBeenCalledWith(1_234_567);
        expect(gpuHarness.devices[0].importExternalTexture).toHaveBeenCalledWith({
            colorSpace: 'srgb',
            source: decodedFrame
        });
        expect(closeFrame).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        expect(presenter.getTelemetry()).toMatchObject({
            decodedFrameCount: 1,
            lastPresentedMediaTimeMicroseconds: 1_200_000,
            nativeFrameCount: 0,
            presentationSource: 'decoded'
        });
    });

    it('presents and closes an owned decoded frame without a native callback tick', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const closeFrame = vi.fn();
        const frame = {
            close: closeFrame,
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));

        const submitted = presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1);

        expect(submitted).toBe(true);
        expect(surfaceHarness.requestVideoFrameCallback).not.toHaveBeenCalled();
        expect(gpuHarness.devices[0].importExternalTexture).toHaveBeenCalledWith({
            colorSpace: 'srgb',
            source: frame
        });
        expect(closeFrame).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        expect(surfaceHarness.requestVideoFrameCallback).not.toHaveBeenCalled();
        expect(presenter.getTelemetry()).toMatchObject({
            decodedFrameCount: 1,
            lastPresentedMediaTimeMicroseconds: 2_000_000,
            presentationSource: 'decoded'
        });
    });

    it('requests one generation-safe pushed-frame refresh after device recovery', async () => {
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const refreshHandler = vi.fn();
        const presenter = new WebGPUPresenter(vi.fn(), refreshHandler);
        const frame = {
            close: vi.fn(),
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        gpuHarness.devices[0].lost.resolve({
            message: 'simulated pushed-frame device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);

        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(refreshHandler).toHaveBeenCalledOnce());
        expect(refreshHandler).toHaveBeenCalledWith(1);
        expect(surfaceHarness.requestVideoFrameCallback).not.toHaveBeenCalled();

        presenter.endSession(2);
        gpuHarness.devices[1].lost.resolve({
            message: 'stale pushed-frame device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await Promise.resolve();
        await Promise.resolve();
        expect(refreshHandler).toHaveBeenCalledOnce();
    });

    it('refreshes pushed frames only for changed layout and current object-fit state', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const refreshHandler = vi.fn();
        const presenter = new WebGPUPresenter(vi.fn(), refreshHandler);
        const frame = {
            close: vi.fn(),
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        window.dispatchEvent(new Event('resize'));
        expect(refreshHandler).not.toHaveBeenCalled();

        Object.defineProperties(surfaceHarness.surface.container, {
            clientHeight: { configurable: true, value: 600 },
            clientWidth: { configurable: true, value: 800 }
        });
        surfaceHarness.surface.container.getBoundingClientRect = vi.fn(
            () => createRectangle(0, 0, 800, 600)
        );
        surfaceHarness.surface.video.getBoundingClientRect = vi.fn(
            () => createRectangle(0, 0, 800, 600)
        );
        Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true,
            value: 1.5
        });
        window.dispatchEvent(new Event('resize'));
        window.dispatchEvent(new Event('resize'));

        expect(refreshHandler).toHaveBeenCalledOnce();
        expect(refreshHandler).toHaveBeenCalledWith(1);

        surfaceHarness.surface.video.style.objectFit = 'cover';
        presenter.refresh(1);
        presenter.refresh(1);
        expect(refreshHandler).toHaveBeenCalledTimes(2);
        presenter.seek(2);
        presenter.refresh(1);
        presenter.endSession(3);
        window.dispatchEvent(new Event('resize'));
        expect(refreshHandler).toHaveBeenCalledTimes(2);
    });

    it.each([
        [ 'I420', 8, [ 'r8uint', 'r8uint', 'r8uint' ], [ 0, 1, 2, 3, 4 ] ],
        [ 'I420P10', 10, [ 'r16uint', 'r16uint', 'r16uint' ], [ 0, 1, 2, 3, 4 ] ],
        [ 'I420P12', 12, [ 'r16uint', 'r16uint', 'r16uint' ], [ 0, 1, 2, 3, 4 ] ],
        [ 'NV12', 8, [ 'r8uint', 'rg8uint' ], [ 0, 1, 2, 3 ] ]
    ] as const)(
        'uploads and binds %s raw planes without importing an external texture',
        async (format, bitDepth, expectedTextureFormats, expectedBindings) => {
            webSettingsMockState.hdrToneMappingEnabled = true;
            const gpuHarness = createGPUHarness();
            const contextHarness = createCanvasContextHarness();
            const surfaceHarness = createSurfaceHarness();
            installGPU(gpuHarness.gpu);
            installCanvasContext(contextHarness.context);
            const presenter = new WebGPUPresenter(vi.fn());
            const metadata = createPQColorMetadata({ bitDepth });

            presenter.startSession(1);
            presenter.setDecodedFramePushMode(true, 1);
            presenter.attach(surfaceHarness.surface, 1);
            await vi.waitFor(() => expect(
                surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
            ).toBeInstanceOf(HTMLCanvasElement));
            await expect(presenter.configureColorPipeline({
                inputMode: 'raw-yuv',
                metadata,
                rawFrameFormat: format,
                settings: createHDRToSDRRenderSettings()
            }, 1)).resolves.toBe(true);

            const rawFrame = createRawFrame(format, metadata);
            const submitted = presenter.presentDecodedFrame({
                durationMicroseconds: rawFrame.durationMicroseconds
                    ?? secondsToMicroseconds(0),
                frame: rawFrame,
                mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
                outputMode: 'raw-planes'
            }, 1);

            expect(submitted).toBe(true);
            const deviceHarness = gpuHarness.devices[0];
            expect(deviceHarness.importExternalTexture).not.toHaveBeenCalled();
            expect(deviceHarness.createTexture.mock.calls.map(call => (
                call[0] as GPUTextureDescriptor
            ).format)).toEqual(expectedTextureFormats);
            expect(deviceHarness.queueWriteTexture).toHaveBeenCalledTimes(
                rawFrame.planes.length
            );
            for (let planeIndex = 0; planeIndex < rawFrame.planes.length; planeIndex += 1) {
                const plane = rawFrame.planes[planeIndex];
                const upload = deviceHarness.queueWriteTexture.mock.calls[planeIndex];
                expect(upload[1]).toBe(rawFrame.data);
                expect(upload[2]).toEqual({
                    bytesPerRow: plane.bytesPerRow,
                    offset: plane.byteOffset,
                    rowsPerImage: plane.height
                });
                expect(upload[3]).toEqual({
                    depthOrArrayLayers: 1,
                    height: plane.height,
                    width: plane.width
                });
            }
            const bindGroupDescriptor = deviceHarness.createBindGroup.mock.calls.at(-1)?.[0] as {
                entries: GPUBindGroupEntry[]
            };
            expect(bindGroupDescriptor.entries.map(entry => entry.binding))
                .toEqual(expectedBindings);
            await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        }
    );

    it('composes the visible rectangle, reuses matching plane textures, and releases them', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);
        const deviceHarness = gpuHarness.devices[0];
        deviceHarness.queueWriteBuffer.mockClear();

        const firstFrame = createRawFrame(
            'I420P10',
            metadata,
            8,
            4,
            { height: 4, width: 4, x: 2, y: 0 }
        );
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: firstFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            frame: firstFrame,
            mediaTimeMicroseconds: firstFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);

        expect(deviceHarness.queueWriteBuffer).toHaveBeenCalledOnce();
        const presentationUniforms = deviceHarness.queueWriteBuffer.mock.calls[0][2] as
            Float32Array<ArrayBuffer>;
        expect(Array.from(presentationUniforms)).toEqual([ 0.5, 1, 0.25, 0 ]);
        expect(deviceHarness.createTexture).toHaveBeenCalledTimes(3);

        const recycleChannel = new MessageChannel();
        recycleChannel.port1.postMessage(firstFrame.data, [ firstFrame.data ]);
        recycleChannel.port1.close();
        recycleChannel.port2.close();
        expect(firstFrame.data.byteLength).toBe(0);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        const secondFrame = createRawFrame('I420P10', metadata);
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: secondFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            frame: secondFrame,
            mediaTimeMicroseconds: secondFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        expect(deviceHarness.createTexture).toHaveBeenCalledTimes(3);
        expect(deviceHarness.queueWriteTexture).toHaveBeenCalledTimes(6);

        const resizedFrame = createRawFrame('I420P10', metadata, 10, 6);
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: resizedFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            frame: resizedFrame,
            mediaTimeMicroseconds: resizedFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        expect(deviceHarness.createTexture).toHaveBeenCalledTimes(6);
        expect(deviceHarness.textureDestroy).toHaveBeenCalledTimes(3);

        presenter.endSession(2);
        expect(deviceHarness.textureDestroy).toHaveBeenCalledTimes(6);
    });

    it('uploads, binds, and releases exactly one per-frame Dolby Vision RPU', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-dolby-vision',
            profile: 8,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings({
                toneMapping: { inputPeakNits: 4_000 }
            })
        }, 1)).resolves.toBe(true);

        const deviceHarness = gpuHarness.devices[0];
        const RPUBufferCallIndex = deviceHarness.createBuffer.mock.calls.findIndex(
            (call: unknown[]) => (
                (call[0] as GPUBufferDescriptor).label === 'WebGPU Dolby Vision per-frame RPU'
            )
        );
        expect(RPUBufferCallIndex).toBeGreaterThanOrEqual(0);
        const RPUBufferDescriptor = deviceHarness.createBuffer.mock.calls[
            RPUBufferCallIndex
        ][0] as GPUBufferDescriptor;
        expect(RPUBufferDescriptor).toMatchObject({
            size: DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
        });
        const RPUBuffer = deviceHarness.createBuffer.mock.results[RPUBufferCallIndex].value as {
            destroy: MockFunction
            label: string
        };
        deviceHarness.queueWriteBuffer.mockClear();

        const packedRPUData = createDolbyVisionAuthorizationRPUFixture();
        const rawFrame = createRawFrame('I420P10', createPQColorMetadata());
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: rawFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(packedRPUData),
            frame: rawFrame,
            mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);

        const RPUWrite = deviceHarness.queueWriteBuffer.mock.calls.find(
            (call: unknown[]) => call[0] === RPUBuffer
        );
        expect(RPUWrite).toBeDefined();
        expect(RPUWrite?.[1]).toBe(0);
        expect(RPUWrite?.[2]).toBe(packedRPUData);
        const bindGroupDescriptor = deviceHarness.createBindGroup.mock.calls.at(-1)?.[0] as {
            entries: GPUBindGroupEntry[]
        };
        expect(bindGroupDescriptor.entries.map(entry => entry.binding))
            .toEqual([ 0, 1, 2, 3, 4, 5 ]);
        expect(fallbackHandler).not.toHaveBeenCalled();

        presenter.endSession(2);
        expect(RPUBuffer.destroy).toHaveBeenCalledOnce();
    });

    it('presents Profile 7 MEL and explicit FEL HDR10-base fallback frames', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-dolby-vision',
            profile: 7,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);

        const deviceHarness = gpuHarness.devices[0];
        const profile7Shader = deviceHarness.createShaderModule.mock.calls
            .map((call: unknown[]) => call[0] as { code: string })
            .find(descriptor => descriptor.code.includes('if (isDolbyVisionFEL())'));
        expect(profile7Shader?.code).toContain('if (isDolbyVisionFEL())');

        const melRPUData = createDolbyVisionAuthorizationRPUFixture(7, 'mel');
        const melFrame = createRawFrame('I420P10', createPQColorMetadata());
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: melFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(
                melRPUData,
                'discarded-mel',
                true
            ),
            frame: melFrame,
            mediaTimeMicroseconds: melFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        const felRPUData = createDolbyVisionAuthorizationRPUFixture(7, 'fel');
        const felFrame = createRawFrame('I420P10', createPQColorMetadata());
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: felFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(
                felRPUData,
                'discarded-fel',
                true
            ),
            frame: felFrame,
            mediaTimeMicroseconds: felFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(2));
        expect(presenter.getTelemetry()).toMatchObject({
            dolbyVisionProfile7FELBaseFallbackPresentedFrameCount: 1,
            dolbyVisionProfile7MELPresentedFrameCount: 1
        });

        const RPUBuffers = deviceHarness.queueWriteBuffer.mock.calls
            .map((call: unknown[]) => call[2]);
        expect(RPUBuffers).toContain(melRPUData);
        expect(RPUBuffers).toContain(felRPUData);
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it('presents an atomically owned Profile 7 FEL enhancement frame', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-dolby-vision',
            profile: 7,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);

        const deviceHarness = gpuHarness.devices[0];
        const fullFELShader = deviceHarness.createShaderModule.mock.calls
            .map((call: unknown[]) => call[0] as { code: string })
            .find(descriptor => descriptor.code.includes(
                '@group(0) @binding(9) var<uniform> enhancement'
            ));
        expect(fullFELShader?.code).toContain(
            'reconstructDolbyVisionBT2020PQWithEnhancement'
        );

        const { baseFrame, enhancementFrame } = createCompoundDolbyVisionRawFrames();
        const packedRPUData = createDolbyVisionAuthorizationRPUFixture(7, 'fel');
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: baseFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(
                packedRPUData,
                'decoded-fel',
                true
            ),
            enhancementFrame,
            frame: baseFrame,
            mediaTimeMicroseconds: baseFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        expect(deviceHarness.createTexture).toHaveBeenCalledTimes(6);
        expect(deviceHarness.queueWriteTexture).toHaveBeenCalledTimes(6);
        const bindGroupDescriptor = deviceHarness.createBindGroup.mock.calls.at(-1)?.[0] as {
            entries: GPUBindGroupEntry[]
        };
        expect(bindGroupDescriptor.entries.map(entry => entry.binding))
            .toEqual([ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9 ]);
        expect(presenter.getTelemetry()).toMatchObject({
            dolbyVisionProfile7FELBaseFallbackPresentedFrameCount: 0,
            dolbyVisionProfile7FELPresentedFrameCount: 1,
            dolbyVisionProfile7MELPresentedFrameCount: 0
        });
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it.each([
        {
            name: 'missing metadata',
            profile: 8 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata | undefined => undefined
        },
        {
            name: 'multiple RPUs',
            profile: 8 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata => ({
                ...createDolbyVisionEncodedMetadata(),
                parsedRPUData: [
                    createDolbyVisionAuthorizationRPUFixture(),
                    createDolbyVisionAuthorizationRPUFixture()
                ]
            })
        },
        {
            name: 'discarded enhancement-layer data',
            profile: 8 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata => ({
                ...createDolbyVisionEncodedMetadata(),
                enhancementLayerDisposition: 'discarded-mel',
                hasEnhancementLayerVCL: true
            })
        },
        {
            name: 'an incompatible protocol schema',
            profile: 8 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata => ({
                ...createDolbyVisionEncodedMetadata(),
                schemaVersion: 1
            } as unknown as TransferableDolbyVisionEncodedFrameMetadata)
        },
        {
            name: 'an RPU profile mismatch',
            profile: 5 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata => (
                createDolbyVisionEncodedMetadata()
            )
        },
        {
            name: 'a Profile 7 layer disposition mismatch',
            profile: 7 as const,
            toMetadata: (): TransferableDolbyVisionEncodedFrameMetadata => (
                createDolbyVisionEncodedMetadata(
                    createDolbyVisionAuthorizationRPUFixture(7, 'mel'),
                    'discarded-fel',
                    true
                )
            )
        }
    ])('fails closed for $name in a Dolby Vision frame', async ({ profile, toMetadata }) => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-dolby-vision',
            profile,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);
        const rawFrame = createRawFrame('I420P10', createPQColorMetadata());

        expect(presenter.presentDecodedFrame({
            durationMicroseconds: rawFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: toMetadata(),
            frame: rawFrame,
            mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(false);
        expect(fallbackHandler).toHaveBeenCalledWith(
            1,
            'dolby-vision-metadata-invalid'
        );
        expect(gpuHarness.devices[0].queueWriteTexture).not.toHaveBeenCalled();
    });

    it('rejects malformed raw frame layouts before creating or uploading textures', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);
        const rawFrame = createRawFrame('I420P10', metadata);
        const firstPlane = rawFrame.planes[0];
        rawFrame.planes = [{ ...firstPlane, bytesPerRow: 128 }, ...rawFrame.planes.slice(1) ];

        expect(presenter.presentDecodedFrame({
            durationMicroseconds: rawFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            frame: rawFrame,
            mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(false);
        expect(gpuHarness.devices[0].createTexture).not.toHaveBeenCalled();
        expect(gpuHarness.devices[0].queueWriteTexture).not.toHaveBeenCalled();
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'decoded-frame-color-mismatch');
    });

    it('does not inspect or upload a raw frame from a stale generation', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);
        presenter.seek(2);
        const rawFrame = createRawFrame('I420P10', metadata);

        expect(presenter.presentDecodedFrame({
            durationMicroseconds: rawFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            frame: rawFrame,
            mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(false);
        expect(rawFrame.data.byteLength).toBeGreaterThan(0);
        expect(gpuHarness.devices[0].createTexture).not.toHaveBeenCalled();
        expect(gpuHarness.devices[0].queueWriteTexture).not.toHaveBeenCalled();
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it('reauthorizes raw HDR presentation on one replacement device', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);
        const firstFrame = createRawFrame('I420P10', metadata);
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: firstFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            frame: firstFrame,
            mediaTimeMicroseconds: firstFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        gpuHarness.devices[0].lost.resolve({
            message: 'first raw device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(presenter.getTelemetry().deviceRecoveryCount).toBe(1));
        expect(gpuHarness.devices[0].textureDestroy).toHaveBeenCalledTimes(3);
        expect(fallbackHandler).not.toHaveBeenCalled();

        const recoveredFrame = createRawFrame('I420P10', metadata);
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: recoveredFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            frame: recoveredFrame,
            mediaTimeMicroseconds: recoveredFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(2));

        gpuHarness.devices[1].lost.resolve({
            message: 'second raw device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'device-recovery-failed');
    });

    it('reauthorizes Dolby Vision presentation on one replacement device', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-dolby-vision',
            profile: 8,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);

        const firstFrame = createRawFrame('I420P10', createPQColorMetadata());
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: firstFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(),
            frame: firstFrame,
            mediaTimeMicroseconds: firstFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));

        gpuHarness.devices[0].lost.resolve({
            message: 'first Dolby Vision device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(presenter.getTelemetry().deviceRecoveryCount).toBe(1));
        expect(dolbyVisionAuthorizationMockState.authorizeCalls)
            .toEqual([ gpuHarness.devices[1].device ]);
        expect(gpuHarness.devices[1].createBuffer.mock.calls.some(
            (call: unknown[]) => (
                (call[0] as GPUBufferDescriptor).label
                === 'WebGPU Dolby Vision per-frame RPU'
            )
        )).toBe(true);
        expect(fallbackHandler).not.toHaveBeenCalled();

        const recoveredFrame = createRawFrame('I420P10', createPQColorMetadata());
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: recoveredFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            encodedDolbyVisionMetadata: createDolbyVisionEncodedMetadata(),
            frame: recoveredFrame,
            mediaTimeMicroseconds: recoveredFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(2));

        gpuHarness.devices[1].lost.resolve({
            message: 'second Dolby Vision device loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'device-recovery-failed');
    });

    it('closes but never imports a pushed decoded frame from a stale generation', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const closeFrame = vi.fn();
        const frame = {
            close: closeFrame,
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        } as unknown as VideoFrame;

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        presenter.seek(2);

        const submitted = presenter.presentDecodedFrame({
            durationMicroseconds: secondsToMicroseconds(1 / 24),
            frame,
            mediaTimeMicroseconds: secondsToMicroseconds(2),
            outputMode: 'video-frame'
        }, 1);

        expect(submitted).toBe(false);
        expect(closeFrame).toHaveBeenCalledOnce();
        expect(gpuHarness.devices[0].importExternalTexture).not.toHaveBeenCalled();
    });

    it('keeps HDR input on native video when the tone-mapping flag is disabled', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));

        const configured = await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);

        expect(configured).toBe(false);
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'hdr-tone-mapping-disabled');
        expect(surfaceHarness.surface.container.children).toHaveLength(1);
        expect(surfaceHarness.surface.container.firstChild).toBe(surfaceHarness.surface.video);
        expect(presenter.getTelemetry()).toMatchObject({
            fallbackReason: 'hdr-tone-mapping-disabled',
            mode: 'identity-sdr',
            state: 'fallback'
        });
    });

    it('fails closed when the exact current-device raw route is not authorized', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        rawHDRAuthorizationMockState.authorized = false;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));

        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata: createPQColorMetadata(),
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(false);

        expect(fallbackHandler).toHaveBeenCalledWith(1, 'hdr-authorization-unavailable');
        expect(presenter.getTelemetry()).toMatchObject({
            fallbackReason: 'hdr-authorization-unavailable',
            state: 'fallback'
        });
    });

    it('atomically installs a raw PQ-to-SDR shader and resumes presentation', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        const configured = await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);

        expect(configured).toBe(true);
        expect(fallbackHandler).not.toHaveBeenCalled();
        expect(gpuHarness.devices[0].createShaderModule).toHaveBeenCalledTimes(3);
        const hdrShaderDescriptor = gpuHarness.devices[0].createShaderModule.mock.calls
            .map((call: unknown[]) => call[0] as { code: string })
            .find(descriptor => descriptor.code.includes('lumaTexture'));
        expect(hdrShaderDescriptor).toBeDefined();
        expect(hdrShaderDescriptor?.code).toContain('fn applyPQEOTF');
        expect(hdrShaderDescriptor?.code).toContain('fn toneMapToSDR');
        expect(surfaceHarness.requestVideoFrameCallback).not.toHaveBeenCalled();
        expect(presenter.getTelemetry()).toMatchObject({
            fallbackReason: null,
            mode: 'hdr-to-sdr',
            state: 'initializing'
        });

        const rawFrame = createRawFrame('I420P10', metadata);
        expect(presenter.presentDecodedFrame({
            durationMicroseconds: rawFrame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            frame: rawFrame,
            mediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(true);
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        const hdrBindGroupDescriptor = gpuHarness.devices[0].createBindGroup.mock.calls[0][0] as {
            entries: GPUBindGroupEntry[]
        };
        expect(hdrBindGroupDescriptor.entries.map(entry => entry.binding))
            .toEqual([ 0, 1, 2, 3, 4 ]);
        expect(presenter.getTelemetry()).toMatchObject({
            lastPresentedMediaTimeMicroseconds: rawFrame.timestampMicroseconds,
            mode: 'hdr-to-sdr',
            state: 'presenting'
        });
    });

    it('bounds a retained-device pipeline rebuild and rejects its late result', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        const deviceHarness = gpuHarness.devices[0];
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);
        const retainedPipeline = (
            presenter as unknown as { pipeline: GPURenderPipeline | null }
        ).pipeline;
        const latePipeline = {
            getBindGroupLayout: vi.fn(() => ({}))
        } as unknown as GPURenderPipeline;
        const pipelineResult = createDeferred<GPURenderPipeline>();
        deviceHarness.createRenderPipelineAsync.mockImplementationOnce(
            () => pipelineResult.promise
        );

        presenter.endSession(2);
        vi.useFakeTimers();
        presenter.startSession(3);
        await vi.advanceTimersByTimeAsync(
            microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS)
        );

        expect(deviceHarness.createRenderPipelineAsync).toHaveBeenCalledTimes(4);
        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(fallbackHandler).toHaveBeenCalledWith(3, 'pipeline-creation-failed');
        expect((presenter as unknown as { pipeline: GPURenderPipeline | null }).pipeline)
            .toBe(retainedPipeline);

        pipelineResult.resolve(latePipeline);
        await pipelineResult.promise;
        await Promise.resolve();
        expect((presenter as unknown as { pipeline: GPURenderPipeline | null }).pipeline)
            .toBe(retainedPipeline);
        expect(fallbackHandler).toHaveBeenCalledOnce();
    });

    it('updates live HDR controls through one uniform write without recompiling', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);

        const deviceHarness = gpuHarness.devices[0];
        expect(deviceHarness.createShaderModule).toHaveBeenCalledTimes(3);
        deviceHarness.queueWriteBuffer.mockClear();
        const updated = presenter.updateRenderSettings(
            createHDRToSDRRenderSettings({
                display: {
                    brightness: 0.25,
                    contrast: 1.5,
                    saturation: 0.75
                },
                toneMapping: {
                    exposure: 0.5,
                    operator: 'reinhard',
                    outputPeakNits: 120
                }
            }),
            1
        );

        expect(updated).toBe(true);
        expect(deviceHarness.createShaderModule).toHaveBeenCalledTimes(3);
        expect(deviceHarness.createRenderPipelineAsync).toHaveBeenCalledTimes(3);
        expect(deviceHarness.queueWriteBuffer).toHaveBeenCalledOnce();
        const uniformWrite = deviceHarness.queueWriteBuffer.mock.calls[0];
        expect(uniformWrite[0]).toMatchObject({
            label: 'WebGPU video render settings uniforms'
        });
        const uniformData = uniformWrite[2] as Uint8Array<ArrayBuffer>;
        const integerValues = new Uint32Array(uniformData.buffer);
        const floatValues = new Float32Array(uniformData.buffer);
        expect(integerValues[1]).toBe(1);
        expect(integerValues[2]).toBe(1);
        expect(floatValues[5]).toBeCloseTo(0.5);
        expect(floatValues[7]).toBeCloseTo(120);
        expect(floatValues[9]).toBeCloseTo(0.25);
        expect(floatValues[10]).toBeCloseTo(1.5);
        expect(floatValues[11]).toBeCloseTo(0.75);
    });

    it('rejects a raw frame whose color description contradicts HDR input', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await expect(presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1)).resolves.toBe(true);
        const frame = createRawFrame('I420P10', metadata);
        frame.colorSpace.primaries = 'bt709';

        expect(presenter.presentDecodedFrame({
            durationMicroseconds: frame.durationMicroseconds
                ?? secondsToMicroseconds(0),
            frame,
            mediaTimeMicroseconds: frame.timestampMicroseconds,
            outputMode: 'raw-planes'
        }, 1)).toBe(false);
        expect(gpuHarness.devices[0].importExternalTexture).not.toHaveBeenCalled();
        expect(gpuHarness.devices[0].queueWriteTexture).not.toHaveBeenCalled();
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'decoded-frame-color-mismatch');
    });

    it('rejects live renderer updates from stale generations without a GPU write', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        await presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);
        presenter.seek(2);
        gpuHarness.devices[0].queueWriteBuffer.mockClear();

        expect(presenter.updateRenderSettings(createHDRToSDRRenderSettings(), 1)).toBe(false);
        expect(gpuHarness.devices[0].queueWriteBuffer).not.toHaveBeenCalled();
    });

    it('discards an HDR gate result after the presentation generation changes', async () => {
        webSettingsMockState.hdrToneMappingEnabled = true;
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);
        const metadata = createPQColorMetadata();

        presenter.startSession(1);
        presenter.setDecodedFramePushMode(true, 1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(
            surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')
        ).toBeInstanceOf(HTMLCanvasElement));
        const configuration = presenter.configureColorPipeline({
            inputMode: 'raw-yuv',
            metadata,
            rawFrameFormat: 'I420P10',
            settings: createHDRToSDRRenderSettings()
        }, 1);
        presenter.seek(2);

        await expect(configuration).resolves.toBe(false);
        expect(fallbackHandler).not.toHaveBeenCalled();
        expect(gpuHarness.devices[0].createShaderModule).toHaveBeenCalledTimes(2);
        expect(presenter.getTelemetry().mode).toBe('identity-sdr');
    });

    it('rejects an invalid initial submission before revealing or counting the frame', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        const deviceHarness = gpuHarness.devices[0];
        deviceHarness.popErrorScope.mockResolvedValueOnce(
            new GPUValidationError('simulated invalid submission')
        );
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        const canvas = surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas');

        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());

        expect(deviceHarness.queueSubmit).toHaveBeenCalledOnce();
        expect(canvas?.classList.contains('webgpuVideoPlayerCanvas-visible')).toBe(false);
        expect(presenter.getTelemetry().presentedFrameCount).toBe(0);
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce();
        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'frame-render-failed');
        expect(presenter.getTelemetry()).toMatchObject({
            fallbackReason: 'frame-render-failed',
            presentedFrameCount: 0,
            state: 'fallback'
        });
    });

    it('bounds initial submission validation and ignores its late result', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        const validationResult = createDeferred<GPUError | null>();
        const deviceHarness = gpuHarness.devices[0];
        deviceHarness.popErrorScope.mockImplementationOnce(() => validationResult.promise);
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        vi.useFakeTimers();
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());

        await vi.advanceTimersByTimeAsync(
            microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS)
        );
        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'frame-render-failed');
        expect(surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry()).toMatchObject({
            fallbackReason: 'frame-render-failed',
            presentedFrameCount: 0,
            state: 'fallback'
        });

        validationResult.resolve(null);
        await validationResult.promise;
        await Promise.resolve();
        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(presenter.getTelemetry().presentedFrameCount).toBe(0);
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce();
    });

    it('latches fallback for an uncaptured validation error on the active device', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        const deviceHarness = gpuHarness.devices[0];
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        surfaceHarness.callbacks.get(2)?.(performance.now(), createFrameMetadata(2));
        expect(deviceHarness.pushErrorScope).toHaveBeenCalledOnce();
        expect(deviceHarness.popErrorScope).toHaveBeenCalledOnce();
        expect(deviceHarness.queueSubmit).toHaveBeenCalledTimes(2);
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(3);
        expect(presenter.getTelemetry().presentedFrameCount).toBe(2);

        const wasNotCancelled = deviceHarness.dispatchUncapturedError(
            new GPUValidationError('simulated late validation error')
        );

        expect(wasNotCancelled).toBe(false);
        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'frame-render-failed');
        expect(surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('fallback');
    });

    it('cancels seek callbacks and discards a retained stale callback', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        const staleCallback = surfaceHarness.callbacks.get(1);

        presenter.seek(2);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2));
        expect(surfaceHarness.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
        staleCallback?.(performance.now(), createFrameMetadata());
        expect(gpuHarness.devices[0].importExternalTexture).not.toHaveBeenCalled();

        const currentCallback = surfaceHarness.callbacks.get(2);
        currentCallback?.(performance.now(), createFrameMetadata(2));
        expect(gpuHarness.devices[0].importExternalTexture).toHaveBeenCalledOnce();
    });

    it('discards pending submission validation across a seek generation', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        const staleValidation = createDeferred<GPUError | null>();
        const deviceHarness = gpuHarness.devices[0];
        deviceHarness.popErrorScope.mockImplementationOnce(() => staleValidation.promise);
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        const canvas = surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas');
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce();

        presenter.seek(2);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2));
        staleValidation.resolve(null);
        await staleValidation.promise;
        await Promise.resolve();
        expect(canvas?.classList.contains('webgpuVideoPlayerCanvas-visible')).toBe(false);
        expect(presenter.getTelemetry().presentedFrameCount).toBe(0);
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2);

        surfaceHarness.callbacks.get(2)?.(performance.now(), createFrameMetadata(2));
        await vi.waitFor(() => expect(presenter.getTelemetry().presentedFrameCount).toBe(1));
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(3);
    });

    it('removes the canvas and schedules no more frames after import failure', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        gpuHarness.devices[0].importExternalTexture.mockImplementation(() => {
            throw new Error('simulated import failure');
        });
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());

        expect(fallbackHandler).toHaveBeenCalledWith(1, 'frame-import-failed');
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce();
        expect(surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().fallbackReason).toBe('frame-import-failed');
    });

    it('cancels outstanding frame work and reveals direct video on session end', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        const staleCallback = surfaceHarness.callbacks.get(1);

        presenter.endSession(2);
        staleCallback?.(performance.now(), createFrameMetadata());

        expect(surfaceHarness.cancelVideoFrameCallback).toHaveBeenCalledWith(1);
        expect(gpuHarness.devices[0].importExternalTexture).not.toHaveBeenCalled();
        expect(surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')).toBeNull();
    });

    it('recovers one lost device and falls back after a second loss', async () => {
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        const callbackFromLostDevice = surfaceHarness.callbacks.get(1);

        gpuHarness.devices[0].lost.resolve({
            message: 'first simulated loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2));
        callbackFromLostDevice?.(performance.now(), createFrameMetadata());
        expect(gpuHarness.devices[1].importExternalTexture).not.toHaveBeenCalled();
        expect(presenter.getTelemetry().deviceRecoveryCount).toBe(1);
        expect(fallbackHandler).not.toHaveBeenCalled();

        gpuHarness.devices[1].lost.resolve({
            message: 'second simulated loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'device-recovery-failed');
        expect(surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')).toBeNull();
    });

    it('bounds a device recovery request that never settles', async () => {
        vi.useFakeTimers();
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.advanceTimersByTimeAsync(0);
        expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce();
        gpuHarness.requestDevice.mockImplementationOnce(() => (
            new Promise<GPUDevice>(() => undefined)
        ));
        gpuHarness.devices[0].lost.resolve({
            message: 'simulated deferred loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);
        await vi.advanceTimersByTimeAsync(0);
        expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(
            microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS)
        );

        expect(fallbackHandler).toHaveBeenCalledOnce();
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'device-recovery-failed');
        expect(surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')).toBeNull();
    });

    it('reveals direct video and rejects stale work while device recovery is pending', async () => {
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());
        await vi.waitFor(() => {
            expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
        });
        const callbackFromLostDevice = surfaceHarness.callbacks.get(2);
        const visibleCanvas = surfaceHarness.surface.container.querySelector(
            '.webgpuVideoPlayerCanvas-visible'
        );
        expect(visibleCanvas).toBeInstanceOf(HTMLCanvasElement);

        const recoveryDevice = createDeferred<GPUDevice>();
        gpuHarness.requestDevice.mockImplementationOnce(() => recoveryDevice.promise);
        gpuHarness.devices[0].lost.resolve({
            message: 'simulated deferred loss',
            reason: 'unknown'
        } as GPUDeviceLostInfo);

        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        expect(surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('initializing');

        window.dispatchEvent(new Event('resize'));
        callbackFromLostDevice?.(performance.now(), createFrameMetadata(2));
        expect(gpuHarness.devices[1].importExternalTexture).not.toHaveBeenCalled();
        expect(fallbackHandler).not.toHaveBeenCalled();

        recoveryDevice.resolve(gpuHarness.devices[1].device);
        await vi.waitFor(() => {
            expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(3);
        });
        const recoveredCanvas = surfaceHarness.surface.container.querySelector(
            '.webgpuVideoPlayerCanvas'
        );
        expect(recoveredCanvas).toBeInstanceOf(HTMLCanvasElement);
        expect(recoveredCanvas?.classList.contains('webgpuVideoPlayerCanvas-visible')).toBe(false);

        surfaceHarness.callbacks.get(3)?.(performance.now(), createFrameMetadata(3));
        expect(gpuHarness.devices[1].importExternalTexture).toHaveBeenCalledOnce();
        await vi.waitFor(() => {
            expect(recoveredCanvas?.classList.contains('webgpuVideoPlayerCanvas-visible')).toBe(true);
        });
        expect(presenter.getTelemetry().state).toBe('presenting');
        expect(fallbackHandler).not.toHaveBeenCalled();
    });

    it('matches contain aspect handling with a centered render viewport', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness(1_000, 1_000);
        surfaceHarness.surface.video.style.objectFit = 'contain';
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());

        expect(gpuHarness.devices[0].renderPassSetViewport).toHaveBeenCalledWith(
            0,
            218.75,
            1_000,
            562.5,
            0,
            1
        );
    });

    it('recomputes positioned scale-down geometry across DPR and resize changes', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness(1_000, 1_000);
        surfaceHarness.surface.video.style.objectFit = 'scale-down';
        surfaceHarness.surface.video.style.objectPosition = '25% 75%';
        Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true,
            value: 2
        });
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());
        await vi.waitFor(() => {
            expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2);
        });

        expect(gpuHarness.devices[0].renderPassSetViewport).toHaveBeenLastCalledWith(
            0,
            656.25,
            2_000,
            1_125,
            0,
            1
        );
        const canvas = surfaceHarness.surface.container.querySelector('canvas');
        expect(canvas).toMatchObject({ height: 2_000, width: 2_000 });

        Object.defineProperties(surfaceHarness.surface.container, {
            clientHeight: { configurable: true, value: 600 },
            clientWidth: { configurable: true, value: 800 }
        });
        surfaceHarness.surface.container.getBoundingClientRect = vi.fn(
            () => createRectangle(0, 0, 800, 600)
        );
        surfaceHarness.surface.video.getBoundingClientRect = vi.fn(
            () => createRectangle(0, 0, 800, 600)
        );
        Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true,
            value: 1.5
        });
        window.dispatchEvent(new Event('resize'));

        expect(gpuHarness.devices[0].renderPassSetViewport).toHaveBeenLastCalledWith(
            0,
            168.75,
            1_200,
            675,
            0,
            1
        );
        expect(canvas).toMatchObject({ height: 900, width: 1_200 });
        expect(canvas?.style.height).toBe('600px');
        expect(canvas?.style.width).toBe('800px');
    });

    it('reuses layout across frames and recomputes it after resize', async () => {
        const gpuHarness = createGPUHarness();
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());
        const containerRectangle = surfaceHarness.surface.container.getBoundingClientRect as MockFunction;
        const videoRectangle = surfaceHarness.surface.video.getBoundingClientRect as MockFunction;

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());
        surfaceHarness.callbacks.get(1)?.(performance.now(), createFrameMetadata());
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2));

        surfaceHarness.callbacks.get(2)?.(performance.now(), createFrameMetadata(2));
        expect(containerRectangle).toHaveBeenCalledOnce();
        expect(videoRectangle).toHaveBeenCalledOnce();

        window.dispatchEvent(new Event('resize'));
        expect(containerRectangle).toHaveBeenCalledTimes(2);
        expect(videoRectangle).toHaveBeenCalledTimes(2);
    });

    it('destroys reusable GPU resources and reacquires them for a later session', async () => {
        const gpuHarness = createGPUHarness(2);
        const contextHarness = createCanvasContextHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(contextHarness.context);
        const presenter = new WebGPUPresenter(vi.fn());

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledOnce());

        presenter.destroy();

        expect(gpuHarness.devices[0].destroy).toHaveBeenCalledOnce();
        expect(surfaceHarness.surface.container.querySelector('.webgpuVideoPlayerCanvas')).toBeNull();
        expect(presenter.getTelemetry().state).toBe('idle');

        presenter.startSession(3);
        presenter.attach(surfaceHarness.surface, 3);
        await vi.waitFor(() => expect(gpuHarness.requestDevice).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(surfaceHarness.requestVideoFrameCallback).toHaveBeenCalledTimes(2));
        expect(gpuHarness.devices[1].destroy).not.toHaveBeenCalled();
    });

    it('falls back if a WebGPU canvas context cannot be acquired', async () => {
        const gpuHarness = createGPUHarness();
        const surfaceHarness = createSurfaceHarness();
        installGPU(gpuHarness.gpu);
        installCanvasContext(null);
        const fallbackHandler = vi.fn();
        const presenter = new WebGPUPresenter(fallbackHandler);

        presenter.startSession(1);
        presenter.attach(surfaceHarness.surface, 1);

        await vi.waitFor(() => expect(fallbackHandler).toHaveBeenCalledOnce());
        expect(fallbackHandler).toHaveBeenCalledWith(1, 'canvas-context-unavailable');
        expect(surfaceHarness.surface.container.children).toHaveLength(1);
    });
});
