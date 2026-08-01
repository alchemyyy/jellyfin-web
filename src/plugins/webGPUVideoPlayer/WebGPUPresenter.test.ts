import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import WebGPUPresenter, { type PresentationSurface } from './WebGPUPresenter';

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
    renderPassSetViewport: MockFunction
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
const originalGPU = Object.getOwnPropertyDescriptor(navigator, 'gpu');
const originalGPUBufferUsage = Object.getOwnPropertyDescriptor(globalThis, 'GPUBufferUsage');
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
    const importExternalTexture = vi.fn(() => ({}));
    const createRenderPipelineAsync = vi.fn(() => Promise.resolve(pipeline));
    const destroy = vi.fn();
    const popErrorScope = vi.fn(() => Promise.resolve(null));
    const pushErrorScope = vi.fn();
    const device = {
        addEventListener: deviceEventTarget.addEventListener.bind(deviceEventTarget),
        createBindGroup: vi.fn(() => ({})),
        createBuffer: vi.fn(() => ({})),
        createCommandEncoder: vi.fn(() => commandEncoder),
        createRenderPipelineAsync,
        createSampler: vi.fn(() => ({})),
        createShaderModule: vi.fn(() => ({})),
        destroy,
        importExternalTexture,
        limits: { maxTextureDimension2D: 8_192 },
        lost: lost.promise,
        popErrorScope,
        pushErrorScope,
        queue: {
            submit: queueSubmit,
            writeBuffer: queueWriteBuffer
        },
        removeEventListener: deviceEventTarget.removeEventListener.bind(deviceEventTarget)
    } as unknown as GPUDevice;
    const dispatchUncapturedError = (error: GPUError): boolean => {
        const event = new Event('uncapturederror', { cancelable: true });
        Object.defineProperty(event, 'error', { value: error });
        return deviceEventTarget.dispatchEvent(event);
    };

    return {
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
        renderPassSetViewport
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
        Object.defineProperty(window, 'isSecureContext', {
            configurable: true,
            value: true
        });
        Object.defineProperty(globalThis, 'GPUBufferUsage', {
            configurable: true,
            // WebGPU defines these external names
            // eslint-disable-next-line @typescript-eslint/naming-convention
            value: { COPY_DST: 8, UNIFORM: 64 }
        });
        Object.defineProperty(globalThis, 'GPUValidationError', {
            configurable: true,
            value: class extends Error {}
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
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        restoreProperty(HTMLCanvasElement.prototype, 'getContext', originalCanvasGetContext);
        restoreProperty(navigator, 'gpu', originalGPU);
        restoreProperty(globalThis, 'GPUBufferUsage', originalGPUBufferUsage);
        restoreProperty(globalThis, 'GPUValidationError', originalGPUValidationError);
        restoreProperty(globalThis, 'ResizeObserver', originalResizeObserver);
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
