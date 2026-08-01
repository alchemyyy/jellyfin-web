import { getWebGPUHDRToneMappingEnabled } from 'scripts/settings/webSettings';

import {
    millisecondsToMicroseconds,
    secondsToMicroseconds,
    type Microseconds
} from './MediaTime';
import {
    assertValidRenderSettings,
    createDefaultRenderSettings,
    createRenderSettingsUniformData,
    RENDER_SETTINGS_UNIFORM_BYTE_LENGTH,
    type HDRToSDRRenderSettings,
    type IdentitySDRRenderSettings,
    type RenderMode,
    type RenderSettings
} from './RenderSettings';
import {
    assertValidInputColorMetadata,
    type InputColorMetadata
} from './color/ColorMetadata';
import { createColorPipelineWGSL } from './color/ColorPipelineShader';
import { type ColorValidationCapabilityDecision } from './validation/ColorValidationHarness';
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
    | 'decoded-frame-color-mismatch'
    | 'frame-import-failed'
    | 'frame-render-failed'
    | 'gpu-unavailable'
    | 'hdr-color-configuration-invalid'
    | 'hdr-color-validation-failed'
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

export type DecodedPresentationFrame = {
    durationMicroseconds: Microseconds
    frame: VideoFrame
    mediaTimeMicroseconds: Microseconds
};

/** Supplies owned decoded frames synchronized to the HTML backend clock. */
export type DecodedFrameProvider = {
    takeFrame: (targetTimeMicroseconds: Microseconds) => DecodedPresentationFrame | null
};

export type IdentityColorPipelineConfiguration = {
    settings: IdentitySDRRenderSettings
};

export type HDRColorPipelineConfiguration = {
    metadata: InputColorMetadata
    settings: HDRToSDRRenderSettings
    validation: ColorValidationCapabilityDecision | null
    validationDevice?: GPUDevice | null
};

export type PresentationColorPipelineConfiguration =
    | HDRColorPipelineConfiguration
    | IdentityColorPipelineConfiguration;

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

type PendingColorConfiguration = {
    generation: number
    revision: number
};

type PreparedColorPipeline = {
    hdrValidation: ColorValidationCapabilityDecision | null
    inputColorMetadata: InputColorMetadata | null
    settings: RenderSettings
    shaderCode: string
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

function metadataMatches(
    left: InputColorMetadata,
    right: InputColorMetadata
): boolean {
    return left.bitDepth === right.bitDepth
        && left.matrix === right.matrix
        && left.nominalPeakNits === right.nominalPeakNits
        && left.primaries === right.primaries
        && left.range === right.range
        && left.sdrReferenceWhiteNits === right.sdrReferenceWhiteNits
        && left.transfer === right.transfer
        && left.version === right.version;
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

function hasAcceptedColorValidation(
    validation: ColorValidationCapabilityDecision | null,
    metadata: InputColorMetadata
): validation is ColorValidationCapabilityDecision {
    if (
        !validation
        || validation.capability !== 'supported'
        || validation.classification !== 'valid'
        || validation.validation?.accepted !== true
        || validation.frames.length === 0
        || validation.frames.length !== validation.validation.sampleCount
    ) {
        return false;
    }

    return validation.frames.every(frame => metadataMatches(
        frame.inputColorMetadata,
        metadata
    ));
}

function hasMatchingGPUValidation(
    validation: ColorValidationCapabilityDecision,
    device: GPUDevice
): boolean {
    if (
        validation.gpu.maximumTextureDimension2D !== null
        && validation.gpu.maximumTextureDimension2D !== device.limits.maxTextureDimension2D
    ) {
        return false;
    }
    if (validation.gpu.deviceLabel && validation.gpu.deviceLabel !== device.label) {
        return false;
    }

    const currentFeatures: string[] = [];
    for (const feature of device.features) {
        currentFeatures.push(feature);
    }
    currentFeatures.sort((left: string, right: string): number => left.localeCompare(right));
    return currentFeatures.length === validation.gpu.features.length
        && currentFeatures.every((feature: string, index: number): boolean => (
            feature === validation.gpu.features[index]
        ));
}

/** Presents frames from an owned HTML video without taking over playback. */
export default class WebGPUPresenter {
    private readonly fallbackHandler: PresentationFallbackHandler;
    private readonly presentationUniformValues = new Float32Array(FLOATS_PER_PRESENTATION_UNIFORM);

    private activeGeneration = 0;
    private activeInputColorMetadata: InputColorMetadata | null = null;
    private cachedPresentationLayout: CachedPresentationLayout | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private canvasContext: GPUCanvasContext | null = null;
    private canvasFormat: GPUTextureFormat | null = null;
    private colorConfigurationRevision = 0;
    private configuredDevice: GPUDevice | null = null;
    private device: GPUDevice | null = null;
    private deviceRecoveryAttempts = 0;
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
    private sampler: GPUSampler | null = null;
    private sessionActive = false;
    private settings: RenderSettings = createDefaultRenderSettings();
    private surface: PresentationSurface | null = null;
    private submissionValidated = false;
    private telemetry = createTelemetry(this.settings);
    private desiredShaderCode = identityShader;

    constructor(fallbackHandler: PresentationFallbackHandler) {
        this.fallbackHandler = fallbackHandler;
    }

    /** Starts a new presentation session without delaying HTML playback. */
    startSession(generation: number): void {
        this.cancelFrameCallback();
        this.unbindResizeHandling();
        this.removeCanvas();

        this.activeGeneration = generation;
        this.activeInputColorMetadata = null;
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

        this.cachedPresentationLayout = null;
        this.renderCurrentFrameOrFallback(generation);
    }

    /** Ends presentation while retaining reusable GPU resources. */
    endSession(generation: number): void {
        this.activeGeneration = generation;
        this.colorConfigurationRevision += 1;
        this.sessionActive = false;
        this.activeInputColorMetadata = null;
        this.decodedFrameProvider = null;
        this.decodedFramePushActive = false;
        this.pendingColorConfiguration = null;
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
            if (this.activeInputColorMetadata
                && !decodedFrameColorMatches(
                    decodedFrame.frame,
                    this.activeInputColorMetadata
                )) {
                this.fallback(generation, 'decoded-frame-color-mismatch');
                return false;
            }
            if (
                this.pendingColorConfiguration?.generation === generation
                || this.pendingSubmissionValidation
                || !this.hasReadyPresentationResources()
            ) {
                return false;
            }

            const frameWidth = decodedFrame.frame.displayWidth
                || decodedFrame.frame.codedWidth;
            const frameHeight = decodedFrame.frame.displayHeight
                || decodedFrame.frame.codedHeight;
            if (frameWidth <= 0 || frameHeight <= 0) {
                this.fallback(generation, 'frame-render-failed');
                return false;
            }

            this.decodedFramePushActive = true;
            this.cancelFrameCallback();
            const submission = this.renderCurrentFrame(
                decodedFrame.frame,
                frameWidth,
                frameHeight
            );
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
            decodedFrame.frame.close();
        }
    }

    /**
     * Atomically selects identity SDR or a validated HDR-to-SDR pipeline.
     * HDR requests keep native video visible until the feature gate, validation,
     * runtime GPU identity, and shader compilation all succeed.
     */
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
            pendingConfiguration
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
            preparedPipeline.hdrValidation
            && (
                !this.device
                || !hasMatchingGPUValidation(preparedPipeline.hdrValidation, this.device)
            )
        ) {
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-validation-failed'
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
        this.activeInputColorMetadata = preparedPipeline.inputColorMetadata ?
            { ...preparedPipeline.inputColorMetadata } :
            null;
        this.settings = preparedPipeline.settings;
        this.telemetry.mode = preparedPipeline.settings.mode;
        this.pendingColorConfiguration = null;
        this.resumeAfterColorConfiguration(generation);
        return true;
    }

    private createRenderSettingsUniformBuffer(device: GPUDevice): GPUBuffer {
        return device.createBuffer({
            label: 'WebGPU video render settings uniforms',
            size: RENDER_SETTINGS_UNIFORM_BYTE_LENGTH,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
        });
    }

    private writeRenderSettingsUniform(settings: HDRToSDRRenderSettings): boolean {
        const device = this.device;
        if (!device) {
            return false;
        }

        try {
            const renderSettingsUniformBuffer = this.renderSettingsUniformBuffer
                ?? this.createRenderSettingsUniformBuffer(device);
            const uniformData = createRenderSettingsUniformData(settings);
            device.queue.writeBuffer(renderSettingsUniformBuffer, 0, uniformData);
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
        return true;
    }

    private async prepareColorPipeline(
        configuration: PresentationColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        if ('metadata' in configuration) {
            return this.prepareHDRColorPipeline(configuration, pendingConfiguration);
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
            hdrValidation: null,
            inputColorMetadata: null,
            settings: cloneRenderSettings(configuration.settings),
            shaderCode: identityShader
        };
    }

    private async prepareHDRColorPipeline(
        configuration: HDRColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        if (!this.validateHDRColorConfiguration(configuration)) {
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
        if (!hasAcceptedColorValidation(
            configuration.validation,
            configuration.metadata
        )) {
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-validation-failed'
            );
            return null;
        }

        const initialized = await this.ensureDevice();
        if (!this.isColorConfigurationCurrent(pendingConfiguration)) {
            return null;
        }
        const device = this.device;
        if (!initialized || !device) {
            this.failColorConfiguration(
                pendingConfiguration,
                this.initializationFailureReason
            );
            return null;
        }
        if (!hasMatchingGPUValidation(configuration.validation, device)) {
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-validation-failed'
            );
            return null;
        }
        if (configuration.validationDevice
            && configuration.validationDevice !== device) {
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-validation-failed'
            );
            return null;
        }

        return {
            hdrValidation: configuration.validation,
            inputColorMetadata: { ...configuration.metadata },
            settings: cloneRenderSettings(configuration.settings),
            shaderCode: createColorPipelineWGSL(
                configuration.metadata,
                configuration.settings
            )
        };
    }

    private validateHDRColorConfiguration(
        configuration: HDRColorPipelineConfiguration
    ): boolean {
        try {
            assertValidInputColorMetadata(configuration.metadata);
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            console.warn('Invalid WebGPU HDR color configuration', error);
            return false;
        }

        switch (configuration.metadata.transfer) {
            case 'hlg':
            case 'pq':
                return true;
            case 'sdr':
                return false;
        }
    }

    private suspendForColorConfiguration(): void {
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindResizeHandling();
        this.removeCanvas();
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
        pendingConfiguration: PendingColorConfiguration
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
            pipeline = await this.createRenderPipeline(device, canvasFormat, shaderCode);
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
            this.initializationPromise = this.initializeDeviceResources();
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
        if (!device || !canvasFormat) {
            return false;
        }

        let pipeline: GPURenderPipeline;
        try {
            pipeline = await this.createRenderPipeline(device, canvasFormat, shaderCode);
        } catch (error) {
            console.warn('WebGPU pipeline creation failed', error);
            this.initializationFailureReason = 'pipeline-creation-failed';
            return false;
        }
        if (this.device !== device || this.desiredShaderCode !== shaderCode) {
            return false;
        }

        this.pipeline = pipeline;
        this.pipelineShaderCode = shaderCode;
        this.submissionValidated = false;
        return true;
    }

    private createRenderPipeline(
        device: GPUDevice,
        canvasFormat: GPUTextureFormat,
        shaderCode: string
    ): Promise<GPURenderPipeline> {
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
            const shaderCode = this.desiredShaderCode;
            const pipeline = await this.createRenderPipeline(device, canvasFormat, shaderCode);
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
                device.queue.writeBuffer(
                    renderSettingsUniformBuffer,
                    0,
                    createRenderSettingsUniformData(this.settings)
                );
            }

            this.canvasFormat = canvasFormat;
            this.device = device;
            this.pipeline = pipeline;
            this.pipelineShaderCode = shaderCode;
            this.presentationUniformBuffer = presentationUniformBuffer;
            this.renderSettingsUniformBuffer = renderSettingsUniformBuffer;
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
            const submission = this.renderCurrentFrame(decodedFrame?.frame ?? video);
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
            decodedFrame?.frame.close();
        }
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
        const sourceAspectRatio = sourceWidth / sourceHeight;
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

        this.cachedPresentationLayout = null;
        if (this.decodedFramePushActive) {
            return;
        }
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

        // A replacement device has not passed the measured HDR input ramp
        if (this.activeInputColorMetadata) {
            this.fallback(generation, 'hdr-color-validation-failed');
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

        if (this.pendingColorConfiguration?.generation === generation) {
            return;
        }

        if (!this.createAndConfigureCanvas()) {
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
        this.colorConfigurationRevision += 1;
        this.pendingColorConfiguration = null;
        this.telemetry.fallbackReason = reason;
        this.telemetry.state = 'fallback';
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindResizeHandling();
        this.removeCanvas();
        this.decodedFrameProvider = null;
        this.decodedFramePushActive = false;
        this.activeInputColorMetadata = null;
        this.surface = null;
        console.warn(`WebGPU presentation disabled for this session: ${reason}`);
        this.fallbackHandler(generation, reason);
    }

    private isCurrent(generation: number): boolean {
        return this.sessionActive && this.activeGeneration === generation;
    }
}
