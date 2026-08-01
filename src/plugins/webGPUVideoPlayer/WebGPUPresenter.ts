import {
    millisecondsToMicroseconds,
    secondsToMicroseconds,
    type Microseconds
} from './MediaTime';
import {
    createDefaultRenderSettings,
    type RenderMode,
    type RenderSettings
} from './RenderSettings';
import identityShader from './shaders/identity.wgsl';

const CANVAS_CLASS = 'webgpuVideoPlayerCanvas';
const CANVAS_VISIBLE_CLASS = 'webgpuVideoPlayerCanvas-visible';
const FLOATS_PER_PRESENTATION_UNIFORM = 4;
const MAX_DEVICE_RECOVERY_ATTEMPTS = 1;
const MIN_CANVAS_DIMENSION = 1;
const VIDEO_READY_STATE_CURRENT_DATA = 2;
const VERTEX_COUNT = 6;

export type PresentationSurface = {
    container: HTMLDivElement
    video: HTMLVideoElement
};

export type PresentationFallbackReason =
    | 'adapter-unavailable'
    | 'canvas-context-unavailable'
    | 'canvas-configuration-failed'
    | 'device-recovery-failed'
    | 'device-request-failed'
    | 'frame-import-failed'
    | 'frame-render-failed'
    | 'gpu-unavailable'
    | 'insecure-context'
    | 'pipeline-creation-failed'
    | 'request-video-frame-callback-unavailable';

export type PresentationTelemetry = {
    deviceRecoveryCount: number
    fallbackReason: PresentationFallbackReason | null
    firstFrameLatencyMicroseconds: Microseconds | null
    firstPresentedMediaTimeMicroseconds: Microseconds | null
    lastCallbackTimeMicroseconds: Microseconds | null
    lastExpectedDisplayTimeMicroseconds: Microseconds | null
    lastPresentedMediaTimeMicroseconds: Microseconds | null
    mode: RenderMode
    presentedFrameCount: number
    sessionStartedMicroseconds: Microseconds
    state: 'fallback' | 'idle' | 'initializing' | 'presenting'
};

type PresentationFallbackHandler = (
    generation: number,
    reason: PresentationFallbackReason
) => void;

type PendingFrameCallback = {
    generation: number
    id: number
    video: HTMLVideoElement
};

type FrameSubmission = {
    device: GPUDevice
    validationResult: Promise<GPUError | null> | null
};

type PendingSubmissionValidation = {
    device: GPUDevice
    generation: number
    validationResult: Promise<GPUError | null>
};

type CanvasGeometry = {
    height: number
    width: number
};

type CachedPresentationLayout = {
    devicePixelRatio: number
    geometry: CanvasGeometry
    presentation: TexturePresentation
    videoHeight: number
    videoWidth: number
};

type TexturePresentation = {
    textureOffsetX: number
    textureOffsetY: number
    textureScaleX: number
    textureScaleY: number
    viewportHeight: number
    viewportWidth: number
    viewportX: number
    viewportY: number
};

function getMonotonicMicroseconds(): Microseconds {
    return millisecondsToMicroseconds(performance.now());
}

function createTelemetry(settings: RenderSettings): PresentationTelemetry {
    return {
        deviceRecoveryCount: 0,
        fallbackReason: null,
        firstFrameLatencyMicroseconds: null,
        firstPresentedMediaTimeMicroseconds: null,
        lastCallbackTimeMicroseconds: null,
        lastExpectedDisplayTimeMicroseconds: null,
        lastPresentedMediaTimeMicroseconds: null,
        mode: settings.mode,
        presentedFrameCount: 0,
        sessionStartedMicroseconds: getMonotonicMicroseconds(),
        state: 'idle'
    };
}

/** Presents frames from an owned HTML video without taking over playback. */
export default class WebGPUPresenter {
    private readonly fallbackHandler: PresentationFallbackHandler;
    private readonly presentationUniformValues = new Float32Array(FLOATS_PER_PRESENTATION_UNIFORM);

    private activeGeneration = 0;
    private cachedPresentationLayout: CachedPresentationLayout | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private canvasContext: GPUCanvasContext | null = null;
    private canvasFormat: GPUTextureFormat | null = null;
    private configuredDevice: GPUDevice | null = null;
    private device: GPUDevice | null = null;
    private deviceRecoveryAttempts = 0;
    private fallbackLatched = false;
    private initializationFailureReason: PresentationFallbackReason = 'gpu-unavailable';
    private initializationPromise: Promise<boolean> | null = null;
    private pendingFrameCallback: PendingFrameCallback | null = null;
    private pendingSubmissionValidation: PendingSubmissionValidation | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private presentationUniformBuffer: GPUBuffer | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private sampler: GPUSampler | null = null;
    private sessionActive = false;
    private settings = createDefaultRenderSettings();
    private surface: PresentationSurface | null = null;
    private submissionValidated = false;
    private telemetry = createTelemetry(this.settings);

    constructor(fallbackHandler: PresentationFallbackHandler) {
        this.fallbackHandler = fallbackHandler;
    }

    /** Starts a new presentation session without delaying HTML playback. */
    startSession(generation: number): void {
        this.cancelFrameCallback();
        this.unbindResizeHandling();
        this.removeCanvas();

        this.activeGeneration = generation;
        this.deviceRecoveryAttempts = 0;
        this.fallbackLatched = false;
        this.pendingSubmissionValidation = null;
        this.sessionActive = true;
        this.settings = createDefaultRenderSettings();
        this.submissionValidated = false;
        this.surface = null;
        this.telemetry = createTelemetry(this.settings);
        this.telemetry.state = 'initializing';

        void this.prepareGeneration(generation);
    }

    /** Attaches presentation to the owned backend surface. */
    attach(surface: PresentationSurface, generation: number): void {
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        if (surface.video.parentElement !== surface.container) {
            this.fallback(generation, 'canvas-context-unavailable');
            return;
        }

        this.surface = surface;
        this.cachedPresentationLayout = null;
        void this.activateSurface(generation);
    }

    /** Invalidates pending frame work while continuing the same backend session. */
    seek(generation: number): void {
        if (!this.sessionActive) {
            return;
        }

        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.activeGeneration = generation;
        if (this.surface && !this.fallbackLatched) {
            void this.activateSurface(generation);
        }
    }

    /** Refreshes geometry and object-fit state without changing generations. */
    refresh(generation: number): void {
        if (!this.isCurrent(generation) || this.fallbackLatched || !this.surface) {
            return;
        }

        this.cachedPresentationLayout = null;
        this.renderCurrentFrameOrFallback(generation);
    }

    /** Ends presentation while retaining reusable GPU resources. */
    endSession(generation: number): void {
        this.activeGeneration = generation;
        this.sessionActive = false;
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindResizeHandling();
        this.removeCanvas();
        this.surface = null;
        this.telemetry.state = 'idle';
    }

    /** Returns a snapshot of current presentation telemetry. */
    getTelemetry(): PresentationTelemetry {
        return { ...this.telemetry };
    }

    private async prepareGeneration(generation: number): Promise<void> {
        const initialized = await this.ensureDevice();
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        if (!initialized) {
            this.fallback(generation, this.initializationFailureReason);
        }
    }

    private async activateSurface(generation: number): Promise<void> {
        const initialized = await this.ensureDevice();
        if (!this.isCurrent(generation) || this.fallbackLatched || !this.surface) {
            return;
        }

        if (!initialized) {
            this.fallback(generation, this.initializationFailureReason);
            return;
        }

        if (!this.createAndConfigureCanvas()) {
            this.fallback(generation, this.initializationFailureReason);
            return;
        }

        this.scheduleFrameCallback(generation);
    }

    private async ensureDevice(): Promise<boolean> {
        if (this.device && this.pipeline && this.sampler && this.presentationUniformBuffer && this.canvasFormat) {
            return true;
        }

        if (this.initializationPromise) {
            return this.initializationPromise;
        }

        const initializationPromise = this.initializeDeviceResources();
        this.initializationPromise = initializationPromise;
        try {
            return await initializationPromise;
        } catch (error) {
            console.warn('Unexpected WebGPU initialization failure', error);
            this.initializationFailureReason = 'pipeline-creation-failed';
            return false;
        } finally {
            if (this.initializationPromise === initializationPromise) {
                this.initializationPromise = null;
            }
        }
    }

    private async initializeDeviceResources(): Promise<boolean> {
        if (!window.isSecureContext) {
            this.initializationFailureReason = 'insecure-context';
            return false;
        }

        const gpu = navigator.gpu;
        if (!gpu) {
            this.initializationFailureReason = 'gpu-unavailable';
            return false;
        }

        let adapter: GPUAdapter | null;
        try {
            adapter = await gpu.requestAdapter();
        } catch (error) {
            console.warn('WebGPU adapter request failed', error);
            this.initializationFailureReason = 'adapter-unavailable';
            return false;
        }

        if (!adapter) {
            this.initializationFailureReason = 'adapter-unavailable';
            return false;
        }

        let device: GPUDevice;
        try {
            device = await adapter.requestDevice();
        } catch (error) {
            console.warn('WebGPU device request failed', error);
            this.initializationFailureReason = 'device-request-failed';
            return false;
        }

        try {
            const canvasFormat = gpu.getPreferredCanvasFormat();
            const shaderModule = device.createShaderModule({ code: identityShader });
            const pipeline = await device.createRenderPipelineAsync({
                fragment: {
                    entryPoint: 'fragmentMain',
                    module: shaderModule,
                    targets: [{ format: canvasFormat }]
                },
                layout: 'auto',
                primitive: { topology: 'triangle-list' },
                vertex: {
                    entryPoint: 'vertexMain',
                    module: shaderModule
                }
            });
            const sampler = device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear'
            });
            const presentationUniformBuffer = device.createBuffer({
                label: 'WebGPU video presentation uniforms',
                size: this.presentationUniformValues.byteLength,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
            });

            this.canvasFormat = canvasFormat;
            this.device = device;
            this.pipeline = pipeline;
            this.presentationUniformBuffer = presentationUniformBuffer;
            this.sampler = sampler;
            device.addEventListener('uncapturederror', event => {
                this.handleUncapturedError(device, event);
            });
            void device.lost.then(deviceLostInfo => this.handleDeviceLoss(device, deviceLostInfo));
            return true;
        } catch (error) {
            console.warn('WebGPU pipeline creation failed', error);
            device.destroy();
            this.initializationFailureReason = 'pipeline-creation-failed';
            return false;
        }
    }

    private createAndConfigureCanvas(): boolean {
        const surface = this.surface;
        const device = this.device;
        const canvasFormat = this.canvasFormat;
        if (!surface || !device || !canvasFormat) {
            this.initializationFailureReason = 'canvas-context-unavailable';
            return false;
        }

        if (!this.canvas) {
            const canvas = document.createElement('canvas');
            canvas.classList.add(CANVAS_CLASS);
            canvas.setAttribute('aria-hidden', 'true');

            const canvasContext = canvas.getContext('webgpu');
            if (!canvasContext) {
                this.initializationFailureReason = 'canvas-context-unavailable';
                return false;
            }

            surface.container.appendChild(canvas);
            this.canvas = canvas;
            this.canvasContext = canvasContext;
            this.bindResizeHandling(surface);
        }

        if (this.configuredDevice === device) {
            return true;
        }

        try {
            this.canvasContext?.configure({
                alphaMode: 'opaque',
                colorSpace: 'srgb',
                device,
                format: canvasFormat
            });
            this.configuredDevice = device;
            return true;
        } catch (error) {
            console.warn('WebGPU canvas configuration failed', error);
            this.initializationFailureReason = 'canvas-configuration-failed';
            return false;
        }
    }

    private scheduleFrameCallback(generation: number): void {
        const video = this.surface?.video;
        if (
            !video
            || !this.isCurrent(generation)
            || this.pendingFrameCallback
            || this.pendingSubmissionValidation
        ) {
            return;
        }

        if (typeof video.requestVideoFrameCallback !== 'function') {
            this.fallback(generation, 'request-video-frame-callback-unavailable');
            return;
        }

        let callbackId = 0;
        try {
            callbackId = video.requestVideoFrameCallback((callbackTimeMilliseconds, metadata) => {
                this.handleVideoFrame(
                    video,
                    generation,
                    callbackId,
                    callbackTimeMilliseconds,
                    metadata
                );
            });
        } catch (error) {
            console.warn('Video frame callback request failed', error);
            this.fallback(generation, 'request-video-frame-callback-unavailable');
            return;
        }
        this.pendingFrameCallback = { generation, id: callbackId, video };
    }

    private handleVideoFrame(
        video: HTMLVideoElement,
        generation: number,
        callbackId: number,
        callbackTimeMilliseconds: DOMHighResTimeStamp,
        metadata: VideoFrameCallbackMetadata
    ): void {
        const pendingFrameCallback = this.pendingFrameCallback;
        const isPendingCallback = pendingFrameCallback?.generation === generation
            && pendingFrameCallback.id === callbackId
            && pendingFrameCallback.video === video;
        if (!isPendingCallback) {
            return;
        }
        this.pendingFrameCallback = null;

        if (!this.isCurrent(generation) || this.fallbackLatched || this.surface?.video !== video) {
            return;
        }

        let mediaTimeMicroseconds: Microseconds;
        let callbackTimeMicroseconds: Microseconds;
        let expectedDisplayTimeMicroseconds: Microseconds;
        try {
            mediaTimeMicroseconds = secondsToMicroseconds(metadata.mediaTime);
            callbackTimeMicroseconds = millisecondsToMicroseconds(callbackTimeMilliseconds);
            expectedDisplayTimeMicroseconds = millisecondsToMicroseconds(metadata.expectedDisplayTime);
        } catch (error) {
            console.warn('Invalid video frame timestamp', error);
            this.fallback(generation, 'frame-render-failed');
            return;
        }

        try {
            const submission = this.renderCurrentFrame();
            if (!submission) {
                this.scheduleFrameCallback(generation);
                return;
            }

            this.completeFrameSubmission(
                submission,
                generation,
                video,
                mediaTimeMicroseconds,
                callbackTimeMicroseconds,
                expectedDisplayTimeMicroseconds
            );
        } catch (error) {
            console.warn('WebGPU video frame presentation failed', error);
            this.fallback(generation, 'frame-import-failed');
            return;
        }
    }

    private renderCurrentFrame(): FrameSubmission | null {
        const surface = this.surface;
        const canvas = this.canvas;
        const canvasContext = this.canvasContext;
        const device = this.device;
        const pipeline = this.pipeline;
        const sampler = this.sampler;
        const presentationUniformBuffer = this.presentationUniformBuffer;
        if (
            !surface
            || !canvas
            || !canvasContext
            || !device
            || !pipeline
            || !sampler
            || !presentationUniformBuffer
        ) {
            throw new Error('WebGPU presentation resources are incomplete');
        }

        const layout = this.getPresentationLayout(surface, canvas, device);
        if (!layout) {
            return null;
        }

        const presentation = layout.presentation;
        this.presentationUniformValues[0] = presentation.textureScaleX;
        this.presentationUniformValues[1] = presentation.textureScaleY;
        this.presentationUniformValues[2] = presentation.textureOffsetX;
        this.presentationUniformValues[3] = presentation.textureOffsetY;
        const validateSubmission = !this.submissionValidated;
        if (validateSubmission) {
            device.pushErrorScope('validation');
        }

        try {
            device.queue.writeBuffer(presentationUniformBuffer, 0, this.presentationUniformValues);

            const externalTexture = device.importExternalTexture({ source: surface.video });
            const bindGroup = device.createBindGroup({
                entries: [{
                    binding: 0,
                    resource: sampler
                }, {
                    binding: 1,
                    resource: externalTexture
                }, {
                    binding: 2,
                    resource: { buffer: presentationUniformBuffer }
                }],
                layout: pipeline.getBindGroupLayout(0)
            });
            const commandEncoder = device.createCommandEncoder();
            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    clearValue: { r: 0, g: 0, b: 0, a: 1 },
                    loadOp: 'clear',
                    storeOp: 'store',
                    view: canvasContext.getCurrentTexture().createView()
                }]
            });
            renderPass.setPipeline(pipeline);
            renderPass.setBindGroup(0, bindGroup);
            renderPass.setViewport(
                presentation.viewportX,
                presentation.viewportY,
                presentation.viewportWidth,
                presentation.viewportHeight,
                0,
                1
            );
            renderPass.draw(VERTEX_COUNT);
            renderPass.end();
            device.queue.submit([commandEncoder.finish()]);
        } catch (error) {
            if (validateSubmission) {
                this.discardErrorScope(device);
            }
            throw error;
        }

        return {
            device,
            validationResult: validateSubmission ? device.popErrorScope() : null
        };
    }

    private completeFrameSubmission(
        submission: FrameSubmission,
        generation: number,
        video: HTMLVideoElement,
        mediaTimeMicroseconds: Microseconds,
        callbackTimeMicroseconds: Microseconds,
        expectedDisplayTimeMicroseconds: Microseconds
    ): void {
        this.completeSubmission(submission, generation, () => {
            if (!this.isCurrent(generation) || this.surface?.video !== video) {
                return;
            }

            this.recordPresentedFrame(
                mediaTimeMicroseconds,
                callbackTimeMicroseconds,
                expectedDisplayTimeMicroseconds
            );
            this.scheduleFrameCallback(generation);
        });
    }

    private completeSubmission(
        submission: FrameSubmission,
        generation: number,
        validatedHandler: () => void
    ): void {
        if (!submission.validationResult) {
            this.markCanvasPresented();
            validatedHandler();
            return;
        }

        const pendingValidation: PendingSubmissionValidation = {
            device: submission.device,
            generation,
            validationResult: submission.validationResult
        };
        this.pendingSubmissionValidation = pendingValidation;
        void this.resolveSubmissionValidation(pendingValidation, validatedHandler);
    }

    private async resolveSubmissionValidation(
        pendingValidation: PendingSubmissionValidation,
        validatedHandler: () => void
    ): Promise<void> {
        let validationError: GPUError | null;
        try {
            validationError = await pendingValidation.validationResult;
        } catch (error) {
            if (this.pendingSubmissionValidation !== pendingValidation) {
                return;
            }

            this.pendingSubmissionValidation = null;
            console.warn('Unable to resolve the WebGPU submission validation scope', error);
            this.fallback(pendingValidation.generation, 'frame-render-failed');
            return;
        }

        if (this.pendingSubmissionValidation !== pendingValidation) {
            return;
        }
        this.pendingSubmissionValidation = null;

        if (
            !this.isCurrent(pendingValidation.generation)
            || this.fallbackLatched
            || this.device !== pendingValidation.device
        ) {
            return;
        }

        if (validationError) {
            console.warn('WebGPU submission validation failed', validationError.message);
            this.fallback(pendingValidation.generation, 'frame-render-failed');
            return;
        }

        this.submissionValidated = true;
        this.markCanvasPresented();
        validatedHandler();
    }

    private markCanvasPresented(): void {
        this.canvas?.classList.add(CANVAS_VISIBLE_CLASS);
        this.telemetry.state = 'presenting';
    }

    private discardErrorScope(device: GPUDevice): void {
        let discardedScope: Promise<GPUError | null>;
        // popErrorScope can also fail synchronously when the scope stack is unavailable
        // eslint-disable-next-line sonarjs/no-try-promise
        try {
            discardedScope = device.popErrorScope();
        } catch (error) {
            console.warn('Unable to discard the WebGPU validation scope', error);
            return;
        }

        void discardedScope.catch(error => {
            console.warn('Unable to discard the WebGPU validation scope', error);
        });
    }

    private synchronizeCanvasGeometry(
        surface: PresentationSurface,
        canvas: HTMLCanvasElement,
        device: GPUDevice,
        devicePixelRatio: number
    ): CanvasGeometry | null {
        const containerRectangle = surface.container.getBoundingClientRect();
        const videoRectangle = surface.video.getBoundingClientRect();
        if (videoRectangle.width <= 0 || videoRectangle.height <= 0) {
            return null;
        }

        const containerScaleX = surface.container.clientWidth > 0 ?
            containerRectangle.width / surface.container.clientWidth :
            1;
        const containerScaleY = surface.container.clientHeight > 0 ?
            containerRectangle.height / surface.container.clientHeight :
            1;
        const normalizedScaleX = containerScaleX > 0 ? containerScaleX : 1;
        const normalizedScaleY = containerScaleY > 0 ? containerScaleY : 1;
        const canvasLeft = (videoRectangle.left - containerRectangle.left) / normalizedScaleX;
        const canvasTop = (videoRectangle.top - containerRectangle.top) / normalizedScaleY;
        const canvasWidth = videoRectangle.width / normalizedScaleX;
        const canvasHeight = videoRectangle.height / normalizedScaleY;

        canvas.style.left = `${canvasLeft}px`;
        canvas.style.top = `${canvasTop}px`;
        canvas.style.width = `${canvasWidth}px`;
        canvas.style.height = `${canvasHeight}px`;

        const maximumDimension = device.limits.maxTextureDimension2D;
        const backingScale = Math.min(
            devicePixelRatio,
            maximumDimension / canvasWidth,
            maximumDimension / canvasHeight
        );
        const backingWidth = Math.max(MIN_CANVAS_DIMENSION, Math.round(canvasWidth * backingScale));
        const backingHeight = Math.max(MIN_CANVAS_DIMENSION, Math.round(canvasHeight * backingScale));

        if (canvas.width !== backingWidth) {
            canvas.width = backingWidth;
        }
        if (canvas.height !== backingHeight) {
            canvas.height = backingHeight;
        }

        return { height: backingHeight, width: backingWidth };
    }

    private getPresentationLayout(
        surface: PresentationSurface,
        canvas: HTMLCanvasElement,
        device: GPUDevice
    ): CachedPresentationLayout | null {
        const videoWidth = surface.video.videoWidth;
        const videoHeight = surface.video.videoHeight;
        if (videoWidth <= 0 || videoHeight <= 0) {
            return null;
        }

        const devicePixelRatio = Math.max(window.devicePixelRatio || 1, 1);
        const cachedLayout = this.cachedPresentationLayout;
        if (
            cachedLayout
            && cachedLayout.devicePixelRatio === devicePixelRatio
            && cachedLayout.videoHeight === videoHeight
            && cachedLayout.videoWidth === videoWidth
        ) {
            return cachedLayout;
        }

        const geometry = this.synchronizeCanvasGeometry(
            surface,
            canvas,
            device,
            devicePixelRatio
        );
        if (!geometry) {
            return null;
        }

        const presentation = this.calculateTexturePresentation(surface.video, geometry);
        const layout: CachedPresentationLayout = {
            devicePixelRatio,
            geometry,
            presentation,
            videoHeight,
            videoWidth
        };
        this.cachedPresentationLayout = layout;
        return layout;
    }

    private calculateTexturePresentation(
        video: HTMLVideoElement,
        geometry: CanvasGeometry
    ): TexturePresentation {
        const sourceAspectRatio = video.videoWidth / video.videoHeight;
        const targetAspectRatio = geometry.width / geometry.height;
        const objectFit = window.getComputedStyle(video).objectFit || 'fill';
        const presentation: TexturePresentation = {
            textureOffsetX: 0,
            textureOffsetY: 0,
            textureScaleX: 1,
            textureScaleY: 1,
            viewportHeight: geometry.height,
            viewportWidth: geometry.width,
            viewportX: 0,
            viewportY: 0
        };

        switch (objectFit) {
            case 'contain':
            case 'scale-down':
                if (sourceAspectRatio > targetAspectRatio) {
                    presentation.viewportHeight = geometry.width / sourceAspectRatio;
                    presentation.viewportY = (geometry.height - presentation.viewportHeight) / 2;
                } else {
                    presentation.viewportWidth = geometry.height * sourceAspectRatio;
                    presentation.viewportX = (geometry.width - presentation.viewportWidth) / 2;
                }
                break;
            case 'cover':
                if (sourceAspectRatio > targetAspectRatio) {
                    presentation.textureScaleX = targetAspectRatio / sourceAspectRatio;
                    presentation.textureOffsetX = (1 - presentation.textureScaleX) / 2;
                } else {
                    presentation.textureScaleY = sourceAspectRatio / targetAspectRatio;
                    presentation.textureOffsetY = (1 - presentation.textureScaleY) / 2;
                }
                break;
            case 'fill':
            case 'none':
            default:
                break;
        }

        return presentation;
    }

    private recordPresentedFrame(
        mediaTimeMicroseconds: Microseconds,
        callbackTimeMicroseconds: Microseconds,
        expectedDisplayTimeMicroseconds: Microseconds
    ): void {
        this.telemetry.lastCallbackTimeMicroseconds = callbackTimeMicroseconds;
        this.telemetry.lastExpectedDisplayTimeMicroseconds = expectedDisplayTimeMicroseconds;
        this.telemetry.lastPresentedMediaTimeMicroseconds = mediaTimeMicroseconds;
        this.telemetry.presentedFrameCount += 1;

        if (this.telemetry.firstPresentedMediaTimeMicroseconds == null) {
            this.telemetry.firstPresentedMediaTimeMicroseconds = mediaTimeMicroseconds;
            this.telemetry.firstFrameLatencyMicroseconds = millisecondsToMicroseconds(
                Number(callbackTimeMicroseconds - this.telemetry.sessionStartedMicroseconds)
                / 1_000
            );
        }
    }

    private readonly handleResize = (): void => {
        if (!this.sessionActive || this.fallbackLatched) {
            return;
        }

        this.cachedPresentationLayout = null;
        this.renderCurrentFrameOrFallback(this.activeGeneration);
    };

    private renderCurrentFrameOrFallback(generation: number): void {
        const video = this.surface?.video;
        if (
            !this.isCurrent(generation)
            || !video
            || video.readyState < VIDEO_READY_STATE_CURRENT_DATA
            || !this.canvas
            || !this.canvasContext
            || !this.device
            || !this.pipeline
            || !this.presentationUniformBuffer
            || !this.sampler
            || this.pendingSubmissionValidation
        ) {
            return;
        }

        this.cancelFrameCallback();
        try {
            const submission = this.renderCurrentFrame();
            if (!submission) {
                this.scheduleFrameCallback(generation);
                return;
            }

            this.completeSubmission(submission, generation, () => {
                this.scheduleFrameCallback(generation);
            });
        } catch (error) {
            console.warn('WebGPU resize presentation failed', error);
            this.fallback(generation, 'frame-render-failed');
        }
    }

    private bindResizeHandling(surface: PresentationSurface): void {
        this.unbindResizeHandling();
        if (typeof ResizeObserver === 'function') {
            this.resizeObserver = new ResizeObserver(this.handleResize);
            this.resizeObserver.observe(surface.container);
            this.resizeObserver.observe(surface.video);
        }
        window.addEventListener('resize', this.handleResize);
    }

    private unbindResizeHandling(): void {
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        window.removeEventListener('resize', this.handleResize);
    }

    private cancelFrameCallback(): void {
        const pendingFrameCallback = this.pendingFrameCallback;
        this.pendingFrameCallback = null;
        if (!pendingFrameCallback) {
            return;
        }

        try {
            pendingFrameCallback.video.cancelVideoFrameCallback(pendingFrameCallback.id);
        } catch (error) {
            console.warn('Unable to cancel the video frame callback', error);
        }
    }

    private discardPendingSubmissionValidation(): void {
        if (!this.pendingSubmissionValidation) {
            return;
        }

        this.pendingSubmissionValidation = null;
        this.submissionValidated = false;
    }

    private removeCanvas(): void {
        try {
            this.canvasContext?.unconfigure();
        } catch (error) {
            console.warn('Unable to unconfigure the WebGPU canvas', error);
        }
        this.canvas?.remove();
        this.canvas = null;
        this.canvasContext = null;
        this.cachedPresentationLayout = null;
        this.configuredDevice = null;
    }

    private async handleDeviceLoss(lostDevice: GPUDevice, deviceLostInfo: GPUDeviceLostInfo): Promise<void> {
        if (this.device !== lostDevice) {
            return;
        }

        console.warn(`WebGPU device lost: ${deviceLostInfo.reason}`, deviceLostInfo.message);
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindResizeHandling();
        this.removeCanvas();
        this.device = null;
        this.pipeline = null;
        this.presentationUniformBuffer = null;
        this.sampler = null;
        this.submissionValidated = false;
        this.configuredDevice = null;

        const generation = this.activeGeneration;
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        this.telemetry.state = 'initializing';

        if (this.deviceRecoveryAttempts >= MAX_DEVICE_RECOVERY_ATTEMPTS) {
            this.fallback(generation, 'device-recovery-failed');
            return;
        }

        this.deviceRecoveryAttempts += 1;
        this.telemetry.deviceRecoveryCount = this.deviceRecoveryAttempts;
        const recovered = await this.ensureDevice();
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        if (!recovered || !this.createAndConfigureCanvas()) {
            this.fallback(generation, 'device-recovery-failed');
            return;
        }

        this.scheduleFrameCallback(generation);
    }

    private handleUncapturedError(device: GPUDevice, event: GPUUncapturedErrorEvent): void {
        if (this.device !== device) {
            return;
        }

        const generation = this.activeGeneration;
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        event.preventDefault();
        console.warn('Uncaptured WebGPU error', event.error.message);
        this.fallback(generation, 'frame-render-failed');
    }

    private fallback(generation: number, reason: PresentationFallbackReason): void {
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }

        this.fallbackLatched = true;
        this.telemetry.fallbackReason = reason;
        this.telemetry.state = 'fallback';
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindResizeHandling();
        this.removeCanvas();
        this.surface = null;
        console.warn(`WebGPU presentation disabled for this session: ${reason}`);
        this.fallbackHandler(generation, reason);
    }

    private isCurrent(generation: number): boolean {
        return this.sessionActive && this.activeGeneration === generation;
    }
}
