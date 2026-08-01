import { getWebGPUHDRToneMappingEnabled } from 'scripts/settings/webSettings';

import {
    microsecondsToMilliseconds,
    millisecondsToMicroseconds,
    secondsToMicroseconds,
    type Microseconds
} from './MediaTime';
import {
    assertValidRenderSettings,
    createDefaultRenderSettings,
    type HDRToSDRRenderSettings,
    type IdentitySDRRenderSettings,
    type RenderMode,
    type RenderSettings
} from './RenderSettings';
import {
    assertValidInputColorMetadata,
    type InputColorMetadata
} from './color/ColorMetadata';
import {
    createRawYUVColorPipelineWGSL
} from './color/ColorPipelineShader';
import {
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from './custom/RawVideoFrameCopy';
import {
    createRawYUVRenderSettingsUniformBuffer,
    createRawYUVRenderPipeline,
    destroyRawPlaneTextureSet,
    hasValidRawVideoFrameLayout,
    renderRawYUVFrame,
    writeRawYUVRenderSettingsUniform,
    type RawPlaneTextureSet
} from './RawYUVGPURenderer';
import {
    calculateTexturePresentationGeometry,
    type TexturePresentationGeometry
} from './PresentationGeometry';
import {
    getRawHDRAuthorizationRouteKey,
    RawHDRPresentationAuthorizationRegistry,
    type RawHDRAuthorizationRouteKey,
    type RawHDRAuthorizationTelemetry
} from './validation/RawHDRPresentationAuthorization';
import identityShader from './shaders/identity.wgsl';

const CANVAS_CLASS = 'webgpuVideoPlayerCanvas';
const CANVAS_VISIBLE_CLASS = 'webgpuVideoPlayerCanvas-visible';
const FLOATS_PER_PRESENTATION_UNIFORM = 4;
const MAX_DEVICE_RECOVERY_ATTEMPTS = 1;
const MIN_CANVAS_DIMENSION = 1;
const VIDEO_READY_STATE_CURRENT_DATA = 2;
const VERTEX_COUNT = 6;
export const WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS = millisecondsToMicroseconds(5_000);
export const RAW_HDR_NEGOTIATION_WAIT_MICROSECONDS = millisecondsToMicroseconds(250);
const WEBGPU_RESOURCE_OPERATION_TIMEOUT = Symbol('webgpu-resource-operation-timeout');

function waitForWebGPUResourceOperation<Value>(
    promise: Promise<Value>
): Promise<Value | typeof WEBGPU_RESOURCE_OPERATION_TIMEOUT> {
    return new Promise<Value | typeof WEBGPU_RESOURCE_OPERATION_TIMEOUT>((resolve, reject) => {
        const timeout = globalThis.setTimeout((): void => {
            resolve(WEBGPU_RESOURCE_OPERATION_TIMEOUT);
        }, microsecondsToMilliseconds(WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS));
        promise.then((value: Value): void => {
            globalThis.clearTimeout(timeout);
            resolve(value);
        }, (error: unknown): void => {
            globalThis.clearTimeout(timeout);
            reject(error);
        });
    });
}

function waitForRawHDRNegotiationProbe(operation: Promise<void>): Promise<void> {
    return new Promise<void>(resolve => {
        let settled = false;
        const settle = (): void => {
            if (settled) {
                return;
            }
            settled = true;
            globalThis.clearTimeout(timeout);
            resolve();
        };
        const timeout = globalThis.setTimeout(
            settle,
            microsecondsToMilliseconds(RAW_HDR_NEGOTIATION_WAIT_MICROSECONDS)
        );
        operation.then(settle, settle);
    });
}

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
    | 'decoded-frame-color-mismatch'
    | 'frame-import-failed'
    | 'frame-render-failed'
    | 'gpu-unavailable'
    | 'hdr-authorization-unavailable'
    | 'hdr-color-configuration-invalid'
    | 'hdr-tone-mapping-disabled'
    | 'insecure-context'
    | 'pipeline-creation-failed'
    | 'request-video-frame-callback-unavailable';

export type PresentationTelemetry = {
    decodedFrameCount: number
    deviceRecoveryCount: number
    fallbackReason: PresentationFallbackReason | null
    firstFrameLatencyMicroseconds: Microseconds | null
    firstPresentedMediaTimeMicroseconds: Microseconds | null
    lastCallbackTimeMicroseconds: Microseconds | null
    lastExpectedDisplayTimeMicroseconds: Microseconds | null
    lastPresentedMediaTimeMicroseconds: Microseconds | null
    mode: RenderMode
    nativeFrameCount: number
    presentationSource: 'decoded' | 'native' | null
    presentedFrameCount: number
    sessionStartedMicroseconds: Microseconds
    state: 'fallback' | 'idle' | 'initializing' | 'presenting'
};

export type DecodedVideoPresentationFrame = {
    durationMicroseconds: Microseconds
    frame: VideoFrame
    mediaTimeMicroseconds: Microseconds
    outputMode: 'video-frame'
};

export type DecodedRawPresentationFrame = {
    durationMicroseconds: Microseconds
    frame: TransferableRawVideoFrame
    mediaTimeMicroseconds: Microseconds
    outputMode: 'raw-planes'
};

export type DecodedPresentationFrame =
    | DecodedRawPresentationFrame
    | DecodedVideoPresentationFrame;

/** Supplies owned decoded frames synchronized to the HTML backend clock. */
export type DecodedFrameProvider = {
    takeFrame: (targetTimeMicroseconds: Microseconds) => DecodedPresentationFrame | null
};

export type IdentityColorPipelineConfiguration = {
    settings: IdentitySDRRenderSettings
};

export type RawHDRColorPipelineConfiguration = {
    inputMode: 'raw-yuv'
    metadata: InputColorMetadata
    rawFrameFormat: SupportedRawVideoFrameFormat
    settings: HDRToSDRRenderSettings
};

export type PresentationColorPipelineConfiguration =
    | IdentityColorPipelineConfiguration
    | RawHDRColorPipelineConfiguration;

type PresentationFallbackHandler = (
    generation: number,
    reason: PresentationFallbackReason
) => void;

type DecodedPresentationRefreshHandler = (generation: number) => void;

type PendingFrameCallback = {
    generation: number
    id: number
    video: HTMLVideoElement
};

type FrameSubmission = {
    device: GPUDevice
    validationResult: Promise<GPUError | null> | null
};

type PendingColorConfiguration = {
    generation: number
    revision: number
};

type PreparedColorPipeline = {
    inputMode: 'external-texture' | 'raw-yuv'
    inputColorMetadata: InputColorMetadata | null
    rawFrameFormat: SupportedRawVideoFrameFormat | null
    settings: RenderSettings
    shaderCode: string
};

type PendingSubmissionValidation = {
    device: GPUDevice
    generation: number
    resourceEpoch: number
    validationResult: Promise<GPUError | null>
};

type CanvasGeometry = {
    cssHeight: number
    cssWidth: number
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

type TexturePresentation = TexturePresentationGeometry;

function getMonotonicMicroseconds(): Microseconds {
    return millisecondsToMicroseconds(performance.now());
}

function createTelemetry(settings: RenderSettings): PresentationTelemetry {
    return {
        decodedFrameCount: 0,
        deviceRecoveryCount: 0,
        fallbackReason: null,
        firstFrameLatencyMicroseconds: null,
        firstPresentedMediaTimeMicroseconds: null,
        lastCallbackTimeMicroseconds: null,
        lastExpectedDisplayTimeMicroseconds: null,
        lastPresentedMediaTimeMicroseconds: null,
        mode: settings.mode,
        nativeFrameCount: 0,
        presentationSource: null,
        presentedFrameCount: 0,
        sessionStartedMicroseconds: getMonotonicMicroseconds(),
        state: 'idle'
    };
}

function cloneRenderSettings(settings: RenderSettings): RenderSettings {
    switch (settings.mode) {
        case 'identity-sdr':
            return { ...settings };
        case 'hdr-to-sdr':
            return {
                ...settings,
                display: { ...settings.display },
                toneMapping: { ...settings.toneMapping }
            };
    }
}

function decodedFrameColorMatches(
    frame: VideoFrame,
    metadata: InputColorMetadata
): boolean {
    const colorSpace = frame.colorSpace;
    return String(colorSpace.transfer) === metadata.transfer
        && String(colorSpace.primaries) === metadata.primaries
        && String(colorSpace.matrix) === metadata.matrix
        && colorSpace.fullRange === (metadata.range === 'full');
}

function rawFrameTransferMatches(
    transfer: string | null,
    metadata: InputColorMetadata
): boolean {
    switch (metadata.transfer) {
        case 'hlg':
            return transfer === 'arib-std-b67' || transfer === 'hlg';
        case 'pq':
            return transfer === 'pq' || transfer === 'smpte2084';
        case 'sdr':
            return transfer === 'bt709';
    }
}

function rawFrameColorMatches(
    frame: TransferableRawVideoFrame,
    metadata: InputColorMetadata
): boolean {
    return frame.bitDepth === metadata.bitDepth
        && frame.colorSpace.fullRange === (metadata.range === 'full')
        && frame.colorSpace.matrix === metadata.matrix
        && frame.colorSpace.primaries === metadata.primaries
        && rawFrameTransferMatches(frame.colorSpace.transfer, metadata);
}

function rawFrameDescriptorMatches(
    decodedFrame: DecodedRawPresentationFrame,
    metadata: InputColorMetadata,
    format: SupportedRawVideoFrameFormat
): boolean {
    const frame = decodedFrame.frame;
    return frame.format === format
        && frame.timestampMicroseconds === decodedFrame.mediaTimeMicroseconds
        && (frame.durationMicroseconds === null
            || frame.durationMicroseconds === decodedFrame.durationMicroseconds)
        && rawFrameColorMatches(frame, metadata)
        && hasValidRawVideoFrameLayout(frame);
}

/** Presents frames from an owned HTML video without taking over playback. */
export default class WebGPUPresenter {
    private readonly fallbackHandler: PresentationFallbackHandler;
    private readonly decodedPresentationRefreshHandler: DecodedPresentationRefreshHandler;
    private readonly presentationUniformValues = new Float32Array(FLOATS_PER_PRESENTATION_UNIFORM);
    private readonly rawHDRAuthorization = new RawHDRPresentationAuthorizationRegistry();

    private activeGeneration = 0;
    private activeInputColorMetadata: InputColorMetadata | null = null;
    private activeInputMode: 'external-texture' | 'raw-yuv' = 'external-texture';
    private activeRawFrameFormat: SupportedRawVideoFrameFormat | null = null;
    private cachedPresentationLayout: CachedPresentationLayout | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private canvasContext: GPUCanvasContext | null = null;
    private canvasFormat: GPUTextureFormat | null = null;
    private colorConfigurationRevision = 0;
    private configuredDevice: GPUDevice | null = null;
    private device: GPUDevice | null = null;
    private deviceRecoveryAttempts = 0;
    private deviceResourceEpoch = 0;
    private decodedFrameProvider: DecodedFrameProvider | null = null;
    private decodedFramePushActive = false;
    private fallbackLatched = false;
    private initializationFailureReason: PresentationFallbackReason = 'gpu-unavailable';
    private initializationPromise: Promise<boolean> | null = null;
    private pendingFrameCallback: PendingFrameCallback | null = null;
    private pendingColorConfiguration: PendingColorConfiguration | null = null;
    private pendingSubmissionValidation: PendingSubmissionValidation | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private pipelineShaderCode: string | null = null;
    private presentationUniformBuffer: GPUBuffer | null = null;
    private renderSettingsUniformBuffer: GPUBuffer | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private rawPlaneTextureSet: RawPlaneTextureSet | null = null;
    private sampler: GPUSampler | null = null;
    private sessionActive = false;
    private settings: RenderSettings = createDefaultRenderSettings();
    private surface: PresentationSurface | null = null;
    private submissionValidated = false;
    private telemetry = createTelemetry(this.settings);
    private desiredShaderCode = identityShader;

    constructor(
        fallbackHandler: PresentationFallbackHandler,
        decodedPresentationRefreshHandler: DecodedPresentationRefreshHandler = (): void => undefined
    ) {
        this.fallbackHandler = fallbackHandler;
        this.decodedPresentationRefreshHandler = decodedPresentationRefreshHandler;
        this.scheduleRawHDRPresentationAuthorizationPrewarm();
    }

    private scheduleRawHDRPresentationAuthorizationPrewarm(): void {
        void Promise.resolve().then((): void => {
            void this.prewarmRawHDRPresentationAuthorization();
        });
    }

    /** Starts a new presentation session without delaying HTML playback. */
    startSession(generation: number): void {
        this.cancelFrameCallback();
        this.unbindResizeHandling();
        this.removeCanvas();
        this.destroyRawPlaneTextures();

        this.activeGeneration = generation;
        this.activeInputColorMetadata = null;
        this.activeInputMode = 'external-texture';
        this.activeRawFrameFormat = null;
        this.colorConfigurationRevision += 1;
        this.decodedFrameProvider = null;
        this.decodedFramePushActive = false;
        this.desiredShaderCode = identityShader;
        this.deviceRecoveryAttempts = 0;
        this.fallbackLatched = false;
        this.pendingColorConfiguration = null;
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
        this.colorConfigurationRevision += 1;
        this.pendingColorConfiguration = null;
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

        if (this.decodedFramePushActive) {
            if (!this.updateCachedPresentationLayoutAfterResize()) {
                return;
            }
            this.requestDecodedPresentationRefresh(generation);
            return;
        }
        this.cachedPresentationLayout = null;
        this.renderCurrentFrameOrFallback(generation);
    }

    /** Ends presentation while retaining reusable GPU resources. */
    endSession(generation: number): void {
        this.activeGeneration = generation;
        this.colorConfigurationRevision += 1;
        this.sessionActive = false;
        this.activeInputColorMetadata = null;
        this.activeInputMode = 'external-texture';
        this.activeRawFrameFormat = null;
        this.decodedFrameProvider = null;
        this.decodedFramePushActive = false;
        this.pendingColorConfiguration = null;
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindResizeHandling();
        this.removeCanvas();
        this.destroyRawPlaneTextures();
        this.surface = null;
        this.telemetry.state = 'idle';
    }

    /** Releases reusable GPU resources while allowing a later fresh session. */
    destroy(): void {
        this.endSession(this.activeGeneration + 1);
        this.deviceResourceEpoch += 1;
        const device = this.device;
        this.device = null;
        this.pipeline = null;
        this.pipelineShaderCode = null;
        this.presentationUniformBuffer = null;
        this.renderSettingsUniformBuffer = null;
        this.sampler = null;
        this.canvasFormat = null;
        this.configuredDevice = null;
        this.initializationPromise = null;
        device?.destroy();
    }

    /** Returns a snapshot of current presentation telemetry. */
    getTelemetry(): PresentationTelemetry {
        return { ...this.telemetry };
    }

    /** Returns a detached snapshot of the active renderer controls. */
    getRenderSettings(): RenderSettings {
        return cloneRenderSettings(this.settings);
    }

    /** Acquires the reusable device used by both validation and presentation. */
    async acquireValidationDevice(): Promise<GPUDevice | null> {
        return await this.ensureDevice() ? this.device : null;
    }

    /** Reports exact GPUDevice identity rather than comparing descriptive fields. */
    isValidationDevice(device: GPUDevice | null): boolean {
        return device !== null && this.device === device;
    }

    /** Starts non-diagnostic raw HDR probes without delaying playback. */
    async prewarmRawHDRPresentationAuthorization(): Promise<void> {
        const featureEnabled = await getWebGPUHDRToneMappingEnabled();
        if (!featureEnabled || !await this.ensureDevice()) {
            return;
        }
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (device && targetFormat) {
            this.rawHDRAuthorization.prewarm(device, targetFormat);
        }
    }

    /** Waits a tightly bounded already-running prewarm before profile negotiation. */
    async waitForRawHDRAuthorizationPrewarm(): Promise<void> {
        await waitForRawHDRNegotiationProbe(
            this.prewarmRawHDRPresentationAuthorization().then((): Promise<void> => {
                const device = this.device;
                const targetFormat = this.canvasFormat;
                return device && targetFormat ?
                    this.rawHDRAuthorization.waitForPending(device, targetFormat) :
                    Promise.resolve();
            })
        );
    }

    /** Returns only settled exact-device routes for negotiation and eligibility. */
    getAuthorizedRawHDRRouteKeys(): readonly RawHDRAuthorizationRouteKey[] {
        return this.rawHDRAuthorization.getTelemetry(
            this.device,
            this.canvasFormat
        ).authorizedRouteKeys;
    }

    /** Returns bounded raw authorization state without exposing GPU objects. */
    getRawHDRAuthorizationTelemetry(): RawHDRAuthorizationTelemetry {
        return this.rawHDRAuthorization.getTelemetry(this.device, this.canvasFormat);
    }

    /** Selects an optional custom decoder as the frame source for this generation. */
    setDecodedFrameProvider(provider: DecodedFrameProvider | null, generation: number): void {
        if (!this.isCurrent(generation)) {
            return;
        }

        this.decodedFrameProvider = provider;
    }

    /** Selects clock-driven decoded-frame ticks before a surface is attached. */
    setDecodedFramePushMode(enabled: boolean, generation: number): void {
        if (!this.isCurrent(generation)) {
            return;
        }

        this.decodedFramePushActive = enabled;
        if (enabled) {
            this.cancelFrameCallback();
        } else {
            this.scheduleFrameCallback(generation);
        }
    }

    /**
     * Takes ownership of one clock-selected decoded frame and closes it on
     * every path. This path does not require a native video-frame callback.
     */
    presentDecodedFrame(
        decodedFrame: DecodedPresentationFrame,
        generation: number
    ): boolean {
        try {
            if (!this.isCurrent(generation) || this.fallbackLatched) {
                return false;
            }
            if (
                !Number.isSafeInteger(decodedFrame.mediaTimeMicroseconds)
                || !Number.isSafeInteger(decodedFrame.durationMicroseconds)
                || decodedFrame.durationMicroseconds < 0
            ) {
                this.fallback(generation, 'frame-render-failed');
                return false;
            }
            if (
                this.pendingColorConfiguration?.generation === generation
                || this.pendingSubmissionValidation
                || !this.hasReadyPresentationResources()
            ) {
                return false;
            }

            let frameWidth: number;
            let frameHeight: number;
            let submission: FrameSubmission | null;
            switch (decodedFrame.outputMode) {
                case 'raw-planes': {
                    const metadata = this.activeInputColorMetadata;
                    const format = this.activeRawFrameFormat;
                    if (
                        this.activeInputMode !== 'raw-yuv'
                        || !metadata
                        || !format
                        || !this.isActiveRawHDRAuthorized(metadata, format)
                        || !rawFrameDescriptorMatches(decodedFrame, metadata, format)
                    ) {
                        this.fallback(generation, 'decoded-frame-color-mismatch');
                        return false;
                    }
                    frameWidth = decodedFrame.frame.displayWidth;
                    frameHeight = decodedFrame.frame.displayHeight;
                    submission = this.renderRawFrame(decodedFrame.frame);
                    break;
                }
                case 'video-frame':
                    if (
                        this.activeInputMode !== 'external-texture'
                        || (this.activeInputColorMetadata
                            && !decodedFrameColorMatches(
                                decodedFrame.frame,
                                this.activeInputColorMetadata
                            ))
                    ) {
                        this.fallback(generation, 'decoded-frame-color-mismatch');
                        return false;
                    }
                    frameWidth = decodedFrame.frame.displayWidth
                        || decodedFrame.frame.codedWidth;
                    frameHeight = decodedFrame.frame.displayHeight
                        || decodedFrame.frame.codedHeight;
                    submission = this.renderCurrentFrame(
                        decodedFrame.frame,
                        frameWidth,
                        frameHeight
                    );
                    break;
            }
            if (frameWidth <= 0 || frameHeight <= 0) {
                this.fallback(generation, 'frame-render-failed');
                return false;
            }

            this.decodedFramePushActive = true;
            this.cancelFrameCallback();
            if (!submission) {
                return false;
            }

            const callbackTimeMicroseconds = getMonotonicMicroseconds();
            this.completeSubmission(submission, generation, () => {
                if (!this.isCurrent(generation) || this.fallbackLatched) {
                    return;
                }
                this.recordPresentedFrame(
                    decodedFrame.mediaTimeMicroseconds,
                    callbackTimeMicroseconds,
                    callbackTimeMicroseconds,
                    'decoded'
                );
            });
            return true;
        } catch (error) {
            console.warn('WebGPU decoded frame presentation failed', error);
            this.fallback(generation, 'frame-import-failed');
            return false;
        } finally {
            if (decodedFrame.outputMode === 'video-frame') {
                decodedFrame.frame.close();
            }
        }
    }

    /** Atomically selects identity external-texture or raw YUV HDR presentation. */
    async configureColorPipeline(
        configuration: PresentationColorPipelineConfiguration,
        generation: number
    ): Promise<boolean> {
        if (!this.isCurrent(generation) || this.fallbackLatched) {
            return false;
        }

        const revision = this.colorConfigurationRevision + 1;
        this.colorConfigurationRevision = revision;
        const pendingConfiguration: PendingColorConfiguration = { generation, revision };
        this.pendingColorConfiguration = pendingConfiguration;
        this.suspendForColorConfiguration();

        const preparedPipeline = await this.prepareColorPipeline(
            configuration,
            pendingConfiguration
        );
        if (!preparedPipeline || !this.isColorConfigurationCurrent(pendingConfiguration)) {
            return false;
        }

        const pipelineInstalled = await this.installPipelineShader(
            preparedPipeline.shaderCode,
            pendingConfiguration,
            preparedPipeline.inputMode
        );
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return false;
        }
        if (!pipelineInstalled) {
            this.failColorConfiguration(
                pendingConfiguration,
                'pipeline-creation-failed'
            );
            return false;
        }
        if (
            preparedPipeline.settings.mode === 'hdr-to-sdr'
            && !this.writeRenderSettingsUniform(preparedPipeline.settings)
        ) {
            this.failColorConfiguration(
                pendingConfiguration,
                'pipeline-creation-failed'
            );
            return false;
        }

        this.desiredShaderCode = preparedPipeline.shaderCode;
        this.activeInputMode = preparedPipeline.inputMode;
        this.activeInputColorMetadata = preparedPipeline.inputColorMetadata ?
            { ...preparedPipeline.inputColorMetadata } :
            null;
        this.activeRawFrameFormat = preparedPipeline.rawFrameFormat;
        this.settings = preparedPipeline.settings;
        this.telemetry.mode = preparedPipeline.settings.mode;
        this.pendingColorConfiguration = null;
        this.resumeAfterColorConfiguration(generation);
        return true;
    }

    private createRenderSettingsUniformBuffer(device: GPUDevice): GPUBuffer {
        return createRawYUVRenderSettingsUniformBuffer(device);
    }

    private writeRenderSettingsUniform(settings: HDRToSDRRenderSettings): boolean {
        const device = this.device;
        if (!device) {
            return false;
        }

        try {
            const renderSettingsUniformBuffer = this.renderSettingsUniformBuffer
                ?? this.createRenderSettingsUniformBuffer(device);
            writeRawYUVRenderSettingsUniform(
                device,
                renderSettingsUniformBuffer,
                settings
            );
            this.renderSettingsUniformBuffer = renderSettingsUniformBuffer;
            return true;
        } catch (error) {
            console.warn('Unable to update WebGPU render settings uniforms', error);
            return false;
        }
    }

    /** Updates live HDR controls through uniforms without rebuilding the shader. */
    updateRenderSettings(
        settings: HDRToSDRRenderSettings,
        generation: number
    ): boolean {
        if (
            !this.isCurrent(generation)
            || this.fallbackLatched
            || this.pendingColorConfiguration !== null
            || this.settings.mode !== 'hdr-to-sdr'
        ) {
            return false;
        }

        try {
            assertValidRenderSettings(settings);
            if (!this.writeRenderSettingsUniform(settings)) {
                return false;
            }
        } catch (error) {
            console.warn('Invalid live WebGPU render settings', error);
            return false;
        }

        this.settings = cloneRenderSettings(settings);
        this.requestDecodedPresentationRefresh(generation);
        return true;
    }

    private async prepareColorPipeline(
        configuration: PresentationColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        if ('inputMode' in configuration && configuration.inputMode === 'raw-yuv') {
            return this.prepareRawHDRColorPipeline(configuration, pendingConfiguration);
        }

        try {
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            console.warn('Invalid WebGPU identity color configuration', error);
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid'
            );
            return null;
        }
        return {
            inputMode: 'external-texture',
            inputColorMetadata: null,
            rawFrameFormat: null,
            settings: cloneRenderSettings(configuration.settings),
            shaderCode: identityShader
        };
    }

    private async prepareRawHDRColorPipeline(
        configuration: RawHDRColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        if (!this.validateRawHDRColorConfiguration(configuration)) {
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid'
            );
            return null;
        }

        const featureEnabled = await getWebGPUHDRToneMappingEnabled();
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        if (!featureEnabled) {
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-tone-mapping-disabled'
            );
            return null;
        }

        const initialized = await this.ensureDevice();
        if (!initialized || !this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (
            !device
            || !targetFormat
            || !this.rawHDRAuthorization.isAuthorized(
                device,
                targetFormat,
                configuration.metadata,
                configuration.settings,
                configuration.rawFrameFormat
            )
        ) {
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-authorization-unavailable'
            );
            return null;
        }

        let shaderCode: string;
        try {
            shaderCode = createRawYUVColorPipelineWGSL(
                configuration.metadata,
                configuration.settings,
                configuration.rawFrameFormat
            );
        } catch (error) {
            console.warn('Invalid WebGPU raw HDR color configuration', error);
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid'
            );
            return null;
        }

        return {
            inputMode: 'raw-yuv',
            inputColorMetadata: { ...configuration.metadata },
            rawFrameFormat: configuration.rawFrameFormat,
            settings: cloneRenderSettings(configuration.settings),
            shaderCode
        };
    }

    private validateRawHDRColorConfiguration(
        configuration: RawHDRColorPipelineConfiguration
    ): boolean {
        try {
            assertValidInputColorMetadata(configuration.metadata);
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            console.warn('Invalid WebGPU HDR color configuration', error);
            return false;
        }

        let validHDRTransfer: boolean;
        switch (configuration.metadata.transfer) {
            case 'hlg':
            case 'pq':
                validHDRTransfer = true;
                break;
            case 'sdr':
                validHDRTransfer = false;
                break;
        }
        if (!validHDRTransfer) {
            return false;
        }

        switch (configuration.rawFrameFormat) {
            case 'I420':
            case 'NV12':
                return configuration.metadata.bitDepth === 8;
            case 'I420P10':
                return configuration.metadata.bitDepth === 10;
            case 'I420P12':
                return configuration.metadata.bitDepth === 12;
        }
    }

    private isActiveRawHDRAuthorized(
        metadata: InputColorMetadata,
        format: SupportedRawVideoFrameFormat
    ): boolean {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        return this.settings.mode === 'hdr-to-sdr'
            && device !== null
            && targetFormat !== null
            && this.rawHDRAuthorization.isAuthorized(
                device,
                targetFormat,
                metadata,
                this.settings,
                format
            );
    }

    private suspendForColorConfiguration(): void {
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindResizeHandling();
        this.removeCanvas();
        this.destroyRawPlaneTextures();
        this.telemetry.state = 'initializing';
    }

    private resumeAfterColorConfiguration(generation: number): void {
        if (!this.surface || !this.isCurrent(generation) || this.fallbackLatched) {
            return;
        }
        if (!this.createAndConfigureCanvas()) {
            this.fallback(generation, this.initializationFailureReason);
            return;
        }

        this.scheduleFrameCallback(generation);
    }

    private failColorConfiguration(
        pendingConfiguration: PendingColorConfiguration,
        reason: PresentationFallbackReason
    ): void {
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return;
        }

        this.pendingColorConfiguration = null;
        this.fallback(pendingConfiguration.generation, reason);
    }

    private isColorConfigurationCurrent(
        pendingConfiguration: PendingColorConfiguration
    ): boolean {
        return this.pendingColorConfiguration === pendingConfiguration
            && this.colorConfigurationRevision === pendingConfiguration.revision
            && this.isCurrent(pendingConfiguration.generation)
            && !this.fallbackLatched;
    }

    private async installPipelineShader(
        shaderCode: string,
        pendingConfiguration: PendingColorConfiguration,
        inputMode: PreparedColorPipeline['inputMode']
    ): Promise<boolean> {
        const initialized = await this.ensureDevice();
        if (!initialized || !this.isColorConfigurationCurrent(pendingConfiguration)) {
            return false;
        }
        if (this.pipeline && this.pipelineShaderCode === shaderCode) {
            return true;
        }

        const device = this.device;
        const canvasFormat = this.canvasFormat;
        if (!device || !canvasFormat) {
            return false;
        }

        let pipeline: GPURenderPipeline;
        try {
            const pipelineResult = await waitForWebGPUResourceOperation(
                this.createRenderPipeline(
                    device,
                    canvasFormat,
                    shaderCode,
                    inputMode === 'raw-yuv'
                )
            );
            if (pipelineResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
                this.initializationFailureReason = 'pipeline-creation-failed';
                return false;
            }
            pipeline = pipelineResult;
        } catch (error) {
            console.warn('WebGPU color pipeline creation failed', error);
            return false;
        }

        if (
            !this.isColorConfigurationCurrent(pendingConfiguration)
            || this.device !== device
        ) {
            return false;
        }

        this.pipeline = pipeline;
        this.pipelineShaderCode = shaderCode;
        this.submissionValidated = false;
        return true;
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
        if (this.pendingColorConfiguration?.generation === generation) {
            return;
        }

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
        let initialized = this.hasBaseDeviceResources();
        if (!initialized && !this.initializationPromise) {
            const resourceEpoch = this.deviceResourceEpoch;
            this.initializationPromise = this.initializeDeviceResources(resourceEpoch);
        }

        const initializationPromise = this.initializationPromise;
        try {
            if (initializationPromise) {
                initialized = await initializationPromise;
            }
        } catch (error) {
            console.warn('Unexpected WebGPU initialization failure', error);
            this.initializationFailureReason = 'pipeline-creation-failed';
            return false;
        } finally {
            if (initializationPromise && this.initializationPromise === initializationPromise) {
                this.initializationPromise = null;
            }
        }

        if (!initialized || !this.hasBaseDeviceResources()) {
            return false;
        }

        return this.ensureDesiredPipeline();
    }

    private hasBaseDeviceResources(): boolean {
        return this.device !== null
            && this.sampler !== null
            && this.presentationUniformBuffer !== null
            && this.canvasFormat !== null;
    }

    private async ensureDesiredPipeline(): Promise<boolean> {
        if (this.pipeline && this.pipelineShaderCode === this.desiredShaderCode) {
            return true;
        }

        const device = this.device;
        const canvasFormat = this.canvasFormat;
        const shaderCode = this.desiredShaderCode;
        const generation = this.activeGeneration;
        const resourceEpoch = this.deviceResourceEpoch;
        if (!device || !canvasFormat) {
            return false;
        }

        let pipelineResult: GPURenderPipeline | typeof WEBGPU_RESOURCE_OPERATION_TIMEOUT;
        try {
            pipelineResult = await waitForWebGPUResourceOperation(
                this.createRenderPipeline(
                    device,
                    canvasFormat,
                    shaderCode,
                    this.activeInputMode === 'raw-yuv'
                )
            );
        } catch (error) {
            console.warn('WebGPU pipeline creation failed', error);
            this.initializationFailureReason = 'pipeline-creation-failed';
            return false;
        }
        if (pipelineResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
            this.initializationFailureReason = 'pipeline-creation-failed';
            return false;
        }
        if (
            this.deviceResourceEpoch !== resourceEpoch
            || this.activeGeneration !== generation
            || this.device !== device
            || this.desiredShaderCode !== shaderCode
        ) {
            return false;
        }

        this.pipeline = pipelineResult;
        this.pipelineShaderCode = shaderCode;
        this.submissionValidated = false;
        return true;
    }

    private createRenderPipeline(
        device: GPUDevice,
        canvasFormat: GPUTextureFormat,
        shaderCode: string,
        rawYUV: boolean
    ): Promise<GPURenderPipeline> {
        if (rawYUV) {
            return createRawYUVRenderPipeline(device, canvasFormat, shaderCode);
        }
        const shaderModule = device.createShaderModule({ code: shaderCode });
        return device.createRenderPipelineAsync({
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
    }

    private async initializeDeviceResources(resourceEpoch: number): Promise<boolean> {
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
            const adapterResult = await waitForWebGPUResourceOperation(gpu.requestAdapter());
            if (adapterResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
                this.initializationFailureReason = 'adapter-unavailable';
                return false;
            }
            adapter = adapterResult;
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
            const devicePromise = adapter.requestDevice();
            const deviceResult = await waitForWebGPUResourceOperation(devicePromise);
            if (deviceResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
                void devicePromise.then((lateDevice: GPUDevice): void => {
                    lateDevice.destroy();
                }, (): void => undefined);
                this.initializationFailureReason = 'device-request-failed';
                return false;
            }
            device = deviceResult;
        } catch (error) {
            console.warn('WebGPU device request failed', error);
            this.initializationFailureReason = 'device-request-failed';
            return false;
        }
        if (this.deviceResourceEpoch !== resourceEpoch) {
            device.destroy();
            return false;
        }

        try {
            const canvasFormat = gpu.getPreferredCanvasFormat();
            const shaderCode = this.desiredShaderCode;
            const pipelineResult = await waitForWebGPUResourceOperation(
                this.createRenderPipeline(
                    device,
                    canvasFormat,
                    shaderCode,
                    this.activeInputMode === 'raw-yuv'
                )
            );
            if (pipelineResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
                device.destroy();
                this.initializationFailureReason = 'pipeline-creation-failed';
                return false;
            }
            const pipeline = pipelineResult;
            if (this.deviceResourceEpoch !== resourceEpoch) {
                device.destroy();
                return false;
            }
            const sampler = device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear'
            });
            const presentationUniformBuffer = device.createBuffer({
                label: 'WebGPU video presentation uniforms',
                size: this.presentationUniformValues.byteLength,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
            });
            let renderSettingsUniformBuffer: GPUBuffer | null = null;
            if (this.settings.mode === 'hdr-to-sdr') {
                renderSettingsUniformBuffer = this.createRenderSettingsUniformBuffer(device);
                writeRawYUVRenderSettingsUniform(
                    device,
                    renderSettingsUniformBuffer,
                    this.settings
                );
            }

            this.canvasFormat = canvasFormat;
            this.device = device;
            this.pipeline = pipeline;
            this.pipelineShaderCode = shaderCode;
            this.presentationUniformBuffer = presentationUniformBuffer;
            this.renderSettingsUniformBuffer = renderSettingsUniformBuffer;
            this.sampler = sampler;
            void getWebGPUHDRToneMappingEnabled().then((enabled: boolean): void => {
                if (enabled && this.device === device && this.canvasFormat === canvasFormat) {
                    this.rawHDRAuthorization.prewarm(device, canvasFormat);
                }
            });
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
            || this.activeInputMode === 'raw-yuv'
            || this.decodedFramePushActive
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

        let decodedFrame: DecodedPresentationFrame | null = null;
        const decodedFrameProvider = this.decodedFrameProvider;
        if (decodedFrameProvider) {
            try {
                decodedFrame = decodedFrameProvider.takeFrame(mediaTimeMicroseconds);
            } catch (error) {
                console.warn('Custom decoded frame provider failed; returning to native frames', error);
                this.decodedFrameProvider = null;
            }
        }

        try {
            const submission = this.renderFrameCallbackSource(
                decodedFrame,
                video,
                generation
            );
            if (!submission) {
                this.scheduleFrameCallback(generation);
                return;
            }

            this.completeFrameSubmission(
                submission,
                generation,
                video,
                decodedFrame?.mediaTimeMicroseconds ?? mediaTimeMicroseconds,
                callbackTimeMicroseconds,
                expectedDisplayTimeMicroseconds,
                decodedFrame ? 'decoded' : 'native'
            );
        } catch (error) {
            console.warn('WebGPU video frame presentation failed', error);
            this.fallback(generation, 'frame-import-failed');
            return;
        } finally {
            if (decodedFrame?.outputMode === 'video-frame') {
                decodedFrame.frame.close();
            }
        }
    }

    private renderFrameCallbackSource(
        decodedFrame: DecodedPresentationFrame | null,
        video: HTMLVideoElement,
        generation: number
    ): FrameSubmission | null {
        if (decodedFrame?.outputMode === 'raw-planes') {
            const inputColorMetadata = this.activeInputColorMetadata;
            const format = this.activeRawFrameFormat;
            if (
                this.activeInputMode !== 'raw-yuv'
                || !inputColorMetadata
                || !format
                || !this.isActiveRawHDRAuthorized(inputColorMetadata, format)
                || !rawFrameDescriptorMatches(decodedFrame, inputColorMetadata, format)
            ) {
                this.fallback(generation, 'decoded-frame-color-mismatch');
                return null;
            }
            return this.renderRawFrame(decodedFrame.frame);
        }

        if (this.activeInputMode !== 'external-texture') {
            this.fallback(generation, 'decoded-frame-color-mismatch');
            return null;
        }
        return this.renderCurrentFrame(decodedFrame?.frame ?? video);
    }

    private hasReadyPresentationResources(): boolean {
        return this.surface !== null
            && this.canvas !== null
            && this.canvasContext !== null
            && this.device !== null
            && this.pipeline !== null
            && this.sampler !== null
            && this.presentationUniformBuffer !== null
            && (
                this.settings.mode === 'identity-sdr'
                || this.renderSettingsUniformBuffer !== null
            );
    }

    private renderCurrentFrame(
        source?: HTMLVideoElement | VideoFrame,
        sourceWidth?: number,
        sourceHeight?: number
    ): FrameSubmission | null {
        if (this.activeInputMode !== 'external-texture') {
            throw new Error('The active WebGPU pipeline does not accept external textures');
        }

        const surface = this.surface;
        const canvas = this.canvas;
        const canvasContext = this.canvasContext;
        const device = this.device;
        const pipeline = this.pipeline;
        const renderSettingsUniformBuffer = this.renderSettingsUniformBuffer;
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
            || (this.settings.mode === 'hdr-to-sdr' && !renderSettingsUniformBuffer)
        ) {
            throw new Error('WebGPU presentation resources are incomplete');
        }

        const layout = this.getPresentationLayout(
            surface,
            canvas,
            device,
            sourceWidth ?? surface.video.videoWidth,
            sourceHeight ?? surface.video.videoHeight
        );
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

            const externalTexture = device.importExternalTexture({
                colorSpace: 'srgb',
                source: source ?? surface.video
            });
            const bindGroupEntries: GPUBindGroupEntry[] = [];
            bindGroupEntries.push({
                binding: 0,
                resource: sampler
            }, {
                binding: 1,
                resource: externalTexture
            }, {
                binding: 2,
                resource: { buffer: presentationUniformBuffer }
            });
            if (this.settings.mode === 'hdr-to-sdr' && renderSettingsUniformBuffer) {
                bindGroupEntries.push({
                    binding: 3,
                    resource: { buffer: renderSettingsUniformBuffer }
                });
            }
            const bindGroup = device.createBindGroup({
                entries: bindGroupEntries,
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

    private renderRawFrame(frame: TransferableRawVideoFrame): FrameSubmission | null {
        const surface = this.surface;
        const canvas = this.canvas;
        const canvasContext = this.canvasContext;
        const device = this.device;
        const pipeline = this.pipeline;
        const presentationUniformBuffer = this.presentationUniformBuffer;
        const renderSettingsUniformBuffer = this.renderSettingsUniformBuffer;
        if (
            this.activeInputMode !== 'raw-yuv'
            || this.activeRawFrameFormat !== frame.format
            || !surface
            || !canvas
            || !canvasContext
            || !device
            || !pipeline
            || !presentationUniformBuffer
            || !renderSettingsUniformBuffer
        ) {
            throw new Error('WebGPU raw presentation resources are incomplete');
        }

        const layout = this.getPresentationLayout(
            surface,
            canvas,
            device,
            frame.displayWidth,
            frame.displayHeight
        );
        if (!layout) {
            return null;
        }

        const validateSubmission = !this.submissionValidated;
        if (validateSubmission) {
            device.pushErrorScope('validation');
        }

        try {
            const renderResult = renderRawYUVFrame({
                device,
                frame,
                pipeline,
                presentation: layout.presentation,
                presentationUniformBuffer,
                renderSettingsUniformBuffer,
                targetView: canvasContext.getCurrentTexture().createView(),
                textureSet: this.rawPlaneTextureSet
            });
            this.rawPlaneTextureSet = renderResult.textureSet;
            this.presentationUniformValues.set(renderResult.presentationUniformValues);
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
        expectedDisplayTimeMicroseconds: Microseconds,
        presentationSource: 'decoded' | 'native'
    ): void {
        this.completeSubmission(submission, generation, () => {
            if (!this.isCurrent(generation) || this.surface?.video !== video) {
                return;
            }

            this.recordPresentedFrame(
                mediaTimeMicroseconds,
                callbackTimeMicroseconds,
                expectedDisplayTimeMicroseconds,
                presentationSource
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
            resourceEpoch: this.deviceResourceEpoch,
            validationResult: submission.validationResult
        };
        this.pendingSubmissionValidation = pendingValidation;
        void this.resolveSubmissionValidation(pendingValidation, validatedHandler);
    }

    private async resolveSubmissionValidation(
        pendingValidation: PendingSubmissionValidation,
        validatedHandler: () => void
    ): Promise<void> {
        let validationResult: GPUError | null | typeof WEBGPU_RESOURCE_OPERATION_TIMEOUT;
        try {
            validationResult = await waitForWebGPUResourceOperation(
                pendingValidation.validationResult
            );
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
            || this.deviceResourceEpoch !== pendingValidation.resourceEpoch
            || this.device !== pendingValidation.device
        ) {
            return;
        }

        if (validationResult === WEBGPU_RESOURCE_OPERATION_TIMEOUT) {
            console.warn('WebGPU submission validation timed out');
            this.fallback(pendingValidation.generation, 'frame-render-failed');
            return;
        }

        if (validationResult) {
            console.warn('WebGPU submission validation failed', validationResult.message);
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

        return {
            cssHeight: canvasHeight,
            cssWidth: canvasWidth,
            height: backingHeight,
            width: backingWidth
        };
    }

    private getPresentationLayout(
        surface: PresentationSurface,
        canvas: HTMLCanvasElement,
        device: GPUDevice,
        sourceWidth: number,
        sourceHeight: number
    ): CachedPresentationLayout | null {
        if (sourceWidth <= 0 || sourceHeight <= 0) {
            return null;
        }

        const devicePixelRatio = Math.max(window.devicePixelRatio || 1, 1);
        const cachedLayout = this.cachedPresentationLayout;
        if (
            cachedLayout
            && cachedLayout.devicePixelRatio === devicePixelRatio
            && cachedLayout.videoHeight === sourceHeight
            && cachedLayout.videoWidth === sourceWidth
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

        const presentation = this.calculateTexturePresentation(
            surface.video,
            geometry,
            sourceWidth,
            sourceHeight
        );
        const layout: CachedPresentationLayout = {
            devicePixelRatio,
            geometry,
            presentation,
            videoHeight: sourceHeight,
            videoWidth: sourceWidth
        };
        this.cachedPresentationLayout = layout;
        return layout;
    }

    private calculateTexturePresentation(
        video: HTMLVideoElement,
        geometry: CanvasGeometry,
        sourceWidth: number,
        sourceHeight: number
    ): TexturePresentation {
        const computedStyle = window.getComputedStyle(video);
        return calculateTexturePresentationGeometry({
            objectFit: computedStyle.objectFit || 'fill',
            objectPosition: computedStyle.objectPosition || '50% 50%',
            sourceHeight,
            sourceWidth,
            targetCSSHeight: geometry.cssHeight,
            targetCSSWidth: geometry.cssWidth,
            targetPixelHeight: geometry.height,
            targetPixelWidth: geometry.width
        });
    }

    private recordPresentedFrame(
        mediaTimeMicroseconds: Microseconds,
        callbackTimeMicroseconds: Microseconds,
        expectedDisplayTimeMicroseconds: Microseconds,
        presentationSource: 'decoded' | 'native'
    ): void {
        this.telemetry.lastCallbackTimeMicroseconds = callbackTimeMicroseconds;
        this.telemetry.lastExpectedDisplayTimeMicroseconds = expectedDisplayTimeMicroseconds;
        this.telemetry.lastPresentedMediaTimeMicroseconds = mediaTimeMicroseconds;
        this.telemetry.presentationSource = presentationSource;
        this.telemetry.presentedFrameCount += 1;
        switch (presentationSource) {
            case 'decoded':
                this.telemetry.decodedFrameCount += 1;
                break;
            case 'native':
                this.telemetry.nativeFrameCount += 1;
                break;
        }

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

        if (!this.updateCachedPresentationLayoutAfterResize()) {
            return;
        }
        if (this.decodedFramePushActive) {
            this.requestDecodedPresentationRefresh(this.activeGeneration);
            return;
        }
        this.renderCurrentFrameOrFallback(this.activeGeneration);
    };

    private updateCachedPresentationLayoutAfterResize(): boolean {
        const cachedLayout = this.cachedPresentationLayout;
        const surface = this.surface;
        const canvas = this.canvas;
        const device = this.device;
        if (!cachedLayout || !surface || !canvas || !device) {
            return false;
        }

        const devicePixelRatio = Math.max(window.devicePixelRatio || 1, 1);
        const geometry = this.synchronizeCanvasGeometry(
            surface,
            canvas,
            device,
            devicePixelRatio
        );
        if (!geometry) {
            return false;
        }
        const presentation = this.calculateTexturePresentation(
            surface.video,
            geometry,
            cachedLayout.videoWidth,
            cachedLayout.videoHeight
        );
        const updatedLayout: CachedPresentationLayout = {
            devicePixelRatio,
            geometry,
            presentation,
            videoHeight: cachedLayout.videoHeight,
            videoWidth: cachedLayout.videoWidth
        };
        this.cachedPresentationLayout = updatedLayout;
        return !this.presentationLayoutsMatch(cachedLayout, updatedLayout);
    }

    private presentationLayoutsMatch(
        first: CachedPresentationLayout,
        second: CachedPresentationLayout
    ): boolean {
        return first.devicePixelRatio === second.devicePixelRatio
            && first.videoHeight === second.videoHeight
            && first.videoWidth === second.videoWidth
            && first.geometry.cssHeight === second.geometry.cssHeight
            && first.geometry.cssWidth === second.geometry.cssWidth
            && first.geometry.height === second.geometry.height
            && first.geometry.width === second.geometry.width
            && first.presentation.textureOffsetX === second.presentation.textureOffsetX
            && first.presentation.textureOffsetY === second.presentation.textureOffsetY
            && first.presentation.textureScaleX === second.presentation.textureScaleX
            && first.presentation.textureScaleY === second.presentation.textureScaleY
            && first.presentation.viewportHeight === second.presentation.viewportHeight
            && first.presentation.viewportWidth === second.presentation.viewportWidth
            && first.presentation.viewportX === second.presentation.viewportX
            && first.presentation.viewportY === second.presentation.viewportY;
    }

    private requestDecodedPresentationRefresh(generation: number): void {
        if (
            !this.decodedFramePushActive
            || !this.surface
            || !this.isCurrent(generation)
            || this.fallbackLatched
        ) {
            return;
        }

        this.decodedPresentationRefreshHandler(generation);
    }

    private renderCurrentFrameOrFallback(generation: number): void {
        const video = this.surface?.video;
        if (
            !this.isCurrent(generation)
            || this.activeInputMode === 'raw-yuv'
            || !video
            || video.readyState < VIDEO_READY_STATE_CURRENT_DATA
            || !this.canvas
            || !this.canvasContext
            || !this.device
            || !this.pipeline
            || !this.presentationUniformBuffer
            || !this.sampler
            || (
                this.settings.mode === 'hdr-to-sdr'
                && !this.renderSettingsUniformBuffer
            )
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

    private destroyRawPlaneTextures(): void {
        const textureSet = this.rawPlaneTextureSet;
        this.rawPlaneTextureSet = null;
        try {
            destroyRawPlaneTextureSet(textureSet);
        } catch (error) {
            console.warn('Unable to destroy WebGPU raw video plane textures', error);
        }
    }

    private async handleDeviceLoss(lostDevice: GPUDevice, deviceLostInfo: GPUDeviceLostInfo): Promise<void> {
        if (this.device !== lostDevice) {
            return;
        }

        console.warn(`WebGPU device lost: ${deviceLostInfo.reason}`, deviceLostInfo.message);
        this.deviceResourceEpoch += 1;
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindResizeHandling();
        this.removeCanvas();
        this.destroyRawPlaneTextures();
        this.device = null;
        this.pipeline = null;
        this.pipelineShaderCode = null;
        this.presentationUniformBuffer = null;
        this.renderSettingsUniformBuffer = null;
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

        if (!recovered) {
            this.fallback(generation, 'device-recovery-failed');
            return;
        }

        if (
            this.activeInputMode === 'raw-yuv'
            && !await this.reauthorizeRawHDRPresentation(generation)
        ) {
            if (this.isCurrent(generation) && !this.fallbackLatched) {
                this.fallback(generation, 'device-recovery-failed');
            }
            return;
        }

        if (this.pendingColorConfiguration?.generation === generation) {
            return;
        }

        if (!this.createAndConfigureCanvas()) {
            this.fallback(generation, 'device-recovery-failed');
            return;
        }

        if (this.decodedFramePushActive) {
            this.requestDecodedPresentationRefresh(generation);
        } else {
            this.scheduleFrameCallback(generation);
        }
    }

    private async reauthorizeRawHDRPresentation(generation: number): Promise<boolean> {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        const metadata = this.activeInputColorMetadata;
        const rawFrameFormat = this.activeRawFrameFormat;
        if (
            !device
            || !targetFormat
            || !metadata
            || !rawFrameFormat
            || this.settings.mode !== 'hdr-to-sdr'
        ) {
            return false;
        }
        const routeKey = getRawHDRAuthorizationRouteKey(rawFrameFormat, metadata);
        if (!routeKey) {
            return false;
        }

        const decision = await this.rawHDRAuthorization.authorize(
            device,
            targetFormat,
            routeKey
        );
        if (
            !this.isCurrent(generation)
            || this.fallbackLatched
            || this.device !== device
            || decision.status !== 'authorized'
        ) {
            return false;
        }
        return this.rawHDRAuthorization.isAuthorized(
            device,
            targetFormat,
            metadata,
            this.settings,
            rawFrameFormat
        );
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
        this.colorConfigurationRevision += 1;
        this.pendingColorConfiguration = null;
        this.telemetry.fallbackReason = reason;
        this.telemetry.state = 'fallback';
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindResizeHandling();
        this.removeCanvas();
        this.destroyRawPlaneTextures();
        this.decodedFrameProvider = null;
        this.decodedFramePushActive = false;
        this.activeInputColorMetadata = null;
        this.activeInputMode = 'external-texture';
        this.activeRawFrameFormat = null;
        this.surface = null;
        console.warn(`WebGPU presentation disabled for this session: ${reason}`);
        this.fallbackHandler(generation, reason);
    }

    private isCurrent(generation: number): boolean {
        return this.sessionActive && this.activeGeneration === generation;
    }
}
