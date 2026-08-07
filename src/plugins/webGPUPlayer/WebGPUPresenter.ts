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
    type HDR10PlusFrameRenderSettings,
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
    createExternalDolbyVisionColorPipelineWGSL,
    createExternalHDRColorPipelineWGSL,
    createRawDolbyVisionColorPipelineWGSL,
    createRawDolbyVisionProfile7ColorPipelineWGSL,
    createRawDolbyVisionProfile7FELColorPipelineWGSL,
    createRawYUVColorPipelineWGSL
} from './color/ColorPipelineShader';
import {
    decodeDolbyVisionRPUSnapshot,
    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH
} from './custom/DolbyVisionRPUParser';
import {
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from './custom/RawVideoFrameCopy';
import {
    isTransferableDolbyVisionEncodedFrameMetadata,
    type TransferableDolbyVisionEncodedFrameMetadata
} from './custom/DolbyVisionEncodedMetadataProtocol';
import {
    getHDR10PlusSceneLuminance,
    isHDR10PlusFrameMetadata,
    type HDR10PlusFrameMetadata
} from './custom/HDR10PlusMetadata';
import {
    createRawYUVRenderSettingsUniformBuffer,
    createRawYUVEnhancementUniformBuffer,
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
    DolbyVisionPresentationAuthorizationRegistry,
    type DolbyVisionAuthorizationTelemetry
} from './validation/DolbyVisionPresentationAuthorization';
import {
    ExternalDolbyVisionPresentationAuthorizationRegistry,
    type ExternalDolbyVisionAuthorizationTelemetry
} from './validation/ExternalDolbyVisionPresentationAuthorization';
import {
    ExternalHDRPresentationAuthorizationRegistry,
    getExternalHDRAuthorizationRouteKey,
    type ExternalHDRAuthorizationRouteKey,
    type ExternalHDRAuthorizationTelemetry
} from './validation/ExternalHDRPresentationAuthorization';
import {
    getRawHDRAuthorizationRouteKey,
    RawHDRPresentationAuthorizationRegistry,
    type RawHDRAuthorizationRouteKey,
    type RawHDRAuthorizationTelemetry
} from './validation/RawHDRPresentationAuthorization';
import identityShader from './shaders/identity.wgsl';

const CANVAS_CLASS = 'webgpuPlayerCanvas';
const CANVAS_VISIBLE_CLASS = 'webgpuPlayerCanvas-visible';
const FLOATS_PER_PRESENTATION_UNIFORM = 4;
const LAYOUT_MOTION_END_EVENTS = [
    'animationcancel',
    'animationend',
    'transitioncancel',
    'transitionend'
] as const;
const LAYOUT_MOTION_ITERATION_EVENT = 'animationiteration';
const LAYOUT_MOTION_START_EVENTS = [ 'animationstart', 'transitionrun' ] as const;
const MAX_DEVICE_RECOVERY_ATTEMPTS = 1;
const MIN_CANVAS_DIMENSION = 1;
const VIDEO_READY_STATE_CURRENT_DATA = 2;
const VERTEX_COUNT = 6;
export const WEBGPU_RESOURCE_OPERATION_TIMEOUT_MICROSECONDS = millisecondsToMicroseconds(5_000);
export const RAW_HDR_NEGOTIATION_WAIT_MICROSECONDS = millisecondsToMicroseconds(5_000);
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
    | 'dolby-vision-metadata-invalid'
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
    appliedHDR10PlusFrameCount: number
    decodedFrameCount: number
    deviceRecoveryCount: number
    dolbyVisionProfile7FELBaseFallbackPresentedFrameCount: number
    dolbyVisionProfile7FELPresentedFrameCount: number
    dolbyVisionProfile7MELPresentedFrameCount: number
    fallbackReason: PresentationFallbackReason | null
    firstFrameLatencyMicroseconds: Microseconds | null
    firstPresentedMediaTimeMicroseconds: Microseconds | null
    lastCallbackTimeMicroseconds: Microseconds | null
    lastExpectedDisplayTimeMicroseconds: Microseconds | null
    lastPresentedMediaTimeMicroseconds: Microseconds | null
    lastHDR10PlusInputPeakNits: number | null
    lastHDR10PlusMetadataStatus: HDR10PlusFrameMetadata['status'] | null
    mode: RenderMode
    nativeFrameCount: number
    presentationSource: 'decoded' | 'native' | null
    presentedFrameCount: number
    staticFallbackHDR10PlusFrameCount: number
    sessionStartedMicroseconds: Microseconds
    state: 'fallback' | 'idle' | 'initializing' | 'presenting'
};

export type DecodedVideoPresentationFrame = {
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata?: TransferableDolbyVisionEncodedFrameMetadata
    HDR10PlusMetadata?: HDR10PlusFrameMetadata
    frame: VideoFrame
    mediaTimeMicroseconds: Microseconds
    outputMode: 'video-frame'
};

export type DecodedRawPresentationFrame = {
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata?: TransferableDolbyVisionEncodedFrameMetadata
    HDR10PlusMetadata?: HDR10PlusFrameMetadata
    enhancementFrame?: TransferableRawVideoFrame | null
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

export type RawDolbyVisionColorPipelineConfiguration = {
    inputMode: 'raw-dolby-vision'
    profile: 5 | 7 | 8
    rawFrameFormat: 'I420P10'
    settings: HDRToSDRRenderSettings
};

export type ExternalDolbyVisionColorPipelineConfiguration = {
    inputMode: 'external-dolby-vision'
    profile: 5
    settings: HDRToSDRRenderSettings
};

export type ExternalHDRColorPipelineConfiguration = {
    inputMode: 'external-hdr'
    metadata: InputColorMetadata
    settings: HDRToSDRRenderSettings
};

export type PresentationColorPipelineConfiguration = (
    | ExternalDolbyVisionColorPipelineConfiguration
    | ExternalHDRColorPipelineConfiguration
    | IdentityColorPipelineConfiguration
    | RawDolbyVisionColorPipelineConfiguration
    | RawHDRColorPipelineConfiguration
) & {
    /** Defaults to true for callers without a persisted manual peak policy. */
    automaticInputPeakNits?: boolean
};

type PresentationInputMode =
    | 'external-dolby-vision'
    | 'external-hdr'
    | 'external-texture'
    | 'raw-dolby-vision'
    | 'raw-yuv';

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

type DolbyVisionProfile7LayerPresentation =
    | 'fel'
    | 'fel-base-fallback'
    | 'mel';

type FrameSubmission = {
    device: GPUDevice
    dolbyVisionProfile7LayerMode?: DolbyVisionProfile7LayerPresentation
    validationResult: Promise<GPUError | null> | null
};

type Profile7DolbyVisionRPUData = {
    layerMode: 'fel' | 'mel'
    packedRPUData: ArrayBuffer
};

type PendingColorConfiguration = {
    generation: number
    revision: number
};

type PreparedColorPipeline = {
    dolbyVisionFELReconstruction?: boolean
    dolbyVisionProfile: 5 | 7 | 8 | null
    inputMode: PresentationInputMode
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
        appliedHDR10PlusFrameCount: 0,
        decodedFrameCount: 0,
        deviceRecoveryCount: 0,
        dolbyVisionProfile7FELBaseFallbackPresentedFrameCount: 0,
        dolbyVisionProfile7FELPresentedFrameCount: 0,
        dolbyVisionProfile7MELPresentedFrameCount: 0,
        fallbackReason: null,
        firstFrameLatencyMicroseconds: null,
        firstPresentedMediaTimeMicroseconds: null,
        lastCallbackTimeMicroseconds: null,
        lastExpectedDisplayTimeMicroseconds: null,
        lastPresentedMediaTimeMicroseconds: null,
        lastHDR10PlusInputPeakNits: null,
        lastHDR10PlusMetadataStatus: null,
        mode: settings.mode,
        nativeFrameCount: 0,
        presentationSource: null,
        presentedFrameCount: 0,
        sessionStartedMicroseconds: getMonotonicMicroseconds(),
        staticFallbackHDR10PlusFrameCount: 0,
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

function decodedNeutralBT709FrameColorMatches(frame: VideoFrame): boolean {
    const colorSpace = frame.colorSpace;
    return colorSpace.fullRange === false
        && String(colorSpace.matrix) === 'bt709'
        && String(colorSpace.primaries) === 'bt709'
        && String(colorSpace.transfer) === 'bt709';
}

function isExternalInputMode(inputMode: PresentationInputMode): boolean {
    return inputMode === 'external-texture'
        || inputMode === 'external-hdr'
        || inputMode === 'external-dolby-vision';
}

function isDolbyVisionInputMode(inputMode: PresentationInputMode): boolean {
    return inputMode === 'raw-dolby-vision'
        || inputMode === 'external-dolby-vision';
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

function rawDolbyVisionFrameDescriptorMatches(
    decodedFrame: DecodedRawPresentationFrame,
    format: SupportedRawVideoFrameFormat
): boolean {
    const frame = decodedFrame.frame;
    return format === 'I420P10'
        && frame.format === format
        && frame.bitDepth === 10
        && frame.timestampMicroseconds === decodedFrame.mediaTimeMicroseconds
        && (frame.durationMicroseconds === null
            || frame.durationMicroseconds === decodedFrame.durationMicroseconds)
        && hasValidRawVideoFrameLayout(frame);
}

function rawDolbyVisionEnhancementFrameDescriptorMatches(
    decodedFrame: DecodedRawPresentationFrame
): boolean {
    const enhancementFrame = decodedFrame.enhancementFrame;
    if (!enhancementFrame) {
        return true;
    }
    const baseFrame = decodedFrame.frame;
    const hasCompatibleDimensions = (
        enhancementFrame.codedWidth === baseFrame.codedWidth
        && enhancementFrame.codedHeight === baseFrame.codedHeight
    ) || (
        enhancementFrame.codedWidth * 2 === baseFrame.codedWidth
        && enhancementFrame.codedHeight * 2 === baseFrame.codedHeight
    );
    return enhancementFrame.data === baseFrame.data
        && enhancementFrame.format === 'I420P10'
        && enhancementFrame.bitDepth === 10
        && hasCompatibleDimensions
        && Math.abs(
            enhancementFrame.timestampMicroseconds
            - decodedFrame.mediaTimeMicroseconds
        ) <= 1
        && hasValidRawVideoFrameLayout(enhancementFrame);
}

function getSingleLayerDolbyVisionRPUData(
    metadata: TransferableDolbyVisionEncodedFrameMetadata | undefined,
    expectedProfile: 5 | 8,
    expectedBaseLayerBitDepth: number
): ArrayBuffer | null {
    if (
        !isTransferableDolbyVisionEncodedFrameMetadata(metadata)
        || metadata.hasEnhancementLayerVCL
        || metadata.enhancementLayerDisposition !== 'absent'
        || metadata.parsedRPUData.length !== 1
    ) {
        return null;
    }
    try {
        const packedRPUData = metadata.parsedRPUData[0];
        const snapshot = decodeDolbyVisionRPUSnapshot(packedRPUData);
        return snapshot.profile === expectedProfile
            && snapshot.layerMode === 'single-layer'
            && snapshot.baseLayerBitDepth === expectedBaseLayerBitDepth
            && snapshot.disableResidual
            && !snapshot.nlqActive ?
            packedRPUData :
            null;
    } catch {
        return null;
    }
}

function getProfile7DolbyVisionRPUData(
    metadata: TransferableDolbyVisionEncodedFrameMetadata | undefined,
    expectedBaseLayerBitDepth: number,
    hasDecodedEnhancementFrame: boolean
): Profile7DolbyVisionRPUData | null {
    if (
        !isTransferableDolbyVisionEncodedFrameMetadata(metadata)
        || metadata.parsedRPUData.length !== 1
        || !metadata.hasEnhancementLayerVCL
    ) {
        return null;
    }
    try {
        const packedRPUData = metadata.parsedRPUData[0];
        const snapshot = decodeDolbyVisionRPUSnapshot(packedRPUData);
        if (
            snapshot.profile !== 7
            || snapshot.baseLayerBitDepth !== expectedBaseLayerBitDepth
            || snapshot.disableResidual
        ) {
            return null;
        }
        switch (snapshot.layerMode) {
            case 'mel': {
                const expectedDisposition = hasDecodedEnhancementFrame ?
                    'decoded-mel' :
                    'discarded-mel';
                if (
                    snapshot.nlqActive
                    || metadata.enhancementLayerDisposition !== expectedDisposition
                ) {
                    return null;
                }
                return { layerMode: 'mel', packedRPUData };
            }
            case 'fel': {
                const expectedDisposition = hasDecodedEnhancementFrame ?
                    'decoded-fel' :
                    'discarded-fel';
                if (
                    !snapshot.nlqActive
                    || metadata.enhancementLayerDisposition !== expectedDisposition
                ) {
                    return null;
                }
                return { layerMode: 'fel', packedRPUData };
            }
            case 'single-layer':
                return null;
        }
    } catch {
        return null;
    }
}

function getProfile7LayerPresentation(
    rpuData: Profile7DolbyVisionRPUData,
    reconstructsFEL: boolean,
    enhancementFrame: TransferableRawVideoFrame | null | undefined
): DolbyVisionProfile7LayerPresentation {
    if (rpuData.layerMode === 'mel') {
        return 'mel';
    }
    if (reconstructsFEL && enhancementFrame) {
        return 'fel';
    }
    return 'fel-base-fallback';
}

/** Presents frames from an owned HTML video without taking over playback. */
export default class WebGPUPresenter {
    private readonly fallbackHandler: PresentationFallbackHandler;
    private readonly decodedPresentationRefreshHandler: DecodedPresentationRefreshHandler;
    private readonly presentationUniformValues = new Float32Array(FLOATS_PER_PRESENTATION_UNIFORM);
    private readonly externalDolbyVisionAuthorization =
        new ExternalDolbyVisionPresentationAuthorizationRegistry();
    private readonly externalHDRAuthorization =
        new ExternalHDRPresentationAuthorizationRegistry();
    private readonly rawDolbyVisionAuthorization =
        new DolbyVisionPresentationAuthorizationRegistry();
    private readonly profile7DolbyVisionAuthorization =
        new DolbyVisionPresentationAuthorizationRegistry('profile7-base');
    private readonly profile7FELDolbyVisionAuthorization =
        new DolbyVisionPresentationAuthorizationRegistry('profile7-fel');
    private readonly rawHDRAuthorization = new RawHDRPresentationAuthorizationRegistry();

    private activeGeneration = 0;
    private automaticInputPeakNits = true;
    private activeDolbyVisionProfile: 5 | 7 | 8 | null = null;
    private activeDolbyVisionFELReconstruction = false;
    private activeInputColorMetadata: InputColorMetadata | null = null;
    private activeInputMode: PresentationInputMode =
        'external-texture';
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
    private dynamicHDR10PlusSettingsActive = false;
    private fallbackLatched = false;
    private dolbyVisionRPUStorageBuffer: GPUBuffer | null = null;
    private dolbyVisionEnhancementUniformBuffer: GPUBuffer | null = null;
    private initializationFailureReason: PresentationFallbackReason = 'gpu-unavailable';
    private initializationPromise: Promise<boolean> | null = null;
    private layoutHandlingRevision = 0;
    private layoutInvalidationHandler: (() => void) | null = null;
    private layoutMutationObserver: MutationObserver | null = null;
    private pendingFrameCallback: PendingFrameCallback | null = null;
    private pendingColorConfiguration: PendingColorConfiguration | null = null;
    private pendingSubmissionValidation: PendingSubmissionValidation | null = null;
    private pipeline: GPURenderPipeline | null = null;
    private pipelineShaderCode: string | null = null;
    private presentationLayoutDirty = true;
    private presentationUniformBuffer: GPUBuffer | null = null;
    private renderSettingsUniformBuffer: GPUBuffer | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private rawPlaneTextureSet: RawPlaneTextureSet | null = null;
    private enhancementRawPlaneTextureSet: RawPlaneTextureSet | null = null;
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
        this.scheduleDevicePrewarm();
    }

    private scheduleDevicePrewarm(): void {
        void Promise.resolve().then((): void => {
            void getWebGPUHDRToneMappingEnabled().then((featureEnabled: boolean): void => {
                if (featureEnabled) {
                    void this.ensureDevice();
                }
            });
        });
    }

    /** Starts a new presentation session without delaying HTML playback. */
    startSession(generation: number): void {
        this.cancelFrameCallback();
        this.unbindLayoutHandling();
        this.removeCanvas();
        this.destroyRawPlaneTextures();
        this.destroyDolbyVisionRPUStorageBuffer();
        this.destroyDolbyVisionEnhancementUniformBuffer();

        this.activeGeneration = generation;
        this.automaticInputPeakNits = true;
        this.activeDolbyVisionProfile = null;
        this.activeDolbyVisionFELReconstruction = false;
        this.activeInputColorMetadata = null;
        this.activeInputMode = 'external-texture';
        this.activeRawFrameFormat = null;
        this.colorConfigurationRevision += 1;
        this.decodedFrameProvider = null;
        this.decodedFramePushActive = false;
        this.desiredShaderCode = identityShader;
        this.deviceRecoveryAttempts = 0;
        this.dynamicHDR10PlusSettingsActive = false;
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

        const previousSurface = this.surface;
        if (
            previousSurface
            && (
                previousSurface.container !== surface.container
                || previousSurface.video !== surface.video
            )
        ) {
            this.cancelFrameCallback();
            this.discardPendingSubmissionValidation();
            this.unbindLayoutHandling();
            this.removeCanvas();
        }

        this.surface = surface;
        this.invalidatePresentationLayout();
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
        this.invalidatePresentationLayout();
        if (this.settings.mode === 'hdr-to-sdr') {
            this.writeRenderSettingsUniform(this.settings);
            this.dynamicHDR10PlusSettingsActive = false;
        }
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
            if (!this.resynchronizeCachedPresentationLayout()) {
                return;
            }
            this.requestDecodedPresentationRefresh(generation);
            return;
        }
        this.invalidatePresentationLayout();
        this.renderCurrentFrameOrFallback(generation);
    }

    /** Ends presentation while retaining reusable GPU resources. */
    endSession(generation: number): void {
        this.activeGeneration = generation;
        this.colorConfigurationRevision += 1;
        this.sessionActive = false;
        this.automaticInputPeakNits = true;
        this.activeDolbyVisionProfile = null;
        this.activeDolbyVisionFELReconstruction = false;
        this.activeInputColorMetadata = null;
        this.activeInputMode = 'external-texture';
        this.activeRawFrameFormat = null;
        this.decodedFrameProvider = null;
        this.decodedFramePushActive = false;
        this.dynamicHDR10PlusSettingsActive = false;
        this.pendingColorConfiguration = null;
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindLayoutHandling();
        this.removeCanvas();
        this.destroyRawPlaneTextures();
        this.destroyDolbyVisionRPUStorageBuffer();
        this.destroyDolbyVisionEnhancementUniformBuffer();
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

    /** Starts native Main10 decode and external-texture probes without delaying playback. */
    async prewarmExternalHDRPresentationAuthorization(): Promise<void> {
        const featureEnabled = await getWebGPUHDRToneMappingEnabled();
        if (!featureEnabled || !await this.ensureDevice()) {
            return;
        }
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (device && targetFormat) {
            this.externalHDRAuthorization.prewarm(device, targetFormat);
        }
    }

    /** Starts the exact Dolby Vision storage-buffer probe without delaying playback. */
    async prewarmDolbyVisionPresentationAuthorization(): Promise<void> {
        const featureEnabled = await getWebGPUHDRToneMappingEnabled();
        if (!featureEnabled || !await this.ensureDevice()) {
            return;
        }
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (device && targetFormat) {
            this.externalDolbyVisionAuthorization.prewarm(device, targetFormat);
            this.rawDolbyVisionAuthorization.prewarm(device, targetFormat);
            this.profile7DolbyVisionAuthorization.prewarm(device, targetFormat);
            this.profile7FELDolbyVisionAuthorization.prewarm(device, targetFormat);
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

    /** Waits a tightly bounded already-running native Main10 presentation probe. */
    async waitForExternalHDRAuthorizationPrewarm(): Promise<void> {
        await waitForRawHDRNegotiationProbe(
            this.prewarmExternalHDRPresentationAuthorization().then((): Promise<void> => {
                const device = this.device;
                const targetFormat = this.canvasFormat;
                return device && targetFormat ?
                    this.externalHDRAuthorization.waitForPending(device, targetFormat) :
                    Promise.resolve();
            })
        );
    }

    /** Waits a tightly bounded already-running Dolby Vision probe. */
    async waitForDolbyVisionAuthorizationPrewarm(): Promise<void> {
        await waitForRawHDRNegotiationProbe(
            this.prewarmDolbyVisionPresentationAuthorization().then((): Promise<void> => {
                const device = this.device;
                const targetFormat = this.canvasFormat;
                return device && targetFormat ? Promise.all([
                    this.externalDolbyVisionAuthorization.waitForPending(
                        device,
                        targetFormat
                    ),
                    this.rawDolbyVisionAuthorization.waitForPending(device, targetFormat),
                    this.profile7DolbyVisionAuthorization.waitForPending(
                        device,
                        targetFormat
                    ),
                    this.profile7FELDolbyVisionAuthorization.waitForPending(
                        device,
                        targetFormat
                    )
                ]).then((): void => undefined) : Promise.resolve();
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

    /** Returns only settled native Main10 external-texture routes. */
    getAuthorizedExternalHDRRouteKeys(): readonly ExternalHDRAuthorizationRouteKey[] {
        return this.externalHDRAuthorization.getTelemetry(
            this.device,
            this.canvasFormat
        ).authorizedRouteKeys;
    }

    /** Returns bounded native Main10 external-texture authorization state. */
    getExternalHDRAuthorizationTelemetry(): ExternalHDRAuthorizationTelemetry {
        return this.externalHDRAuthorization.getTelemetry(this.device, this.canvasFormat);
    }

    /** Returns bounded raw authorization state without exposing GPU objects. */
    getRawHDRAuthorizationTelemetry(): RawHDRAuthorizationTelemetry {
        return this.rawHDRAuthorization.getTelemetry(this.device, this.canvasFormat);
    }

    /** Returns bounded Dolby Vision authorization state without GPU objects. */
    getDolbyVisionAuthorizationTelemetry(): DolbyVisionAuthorizationTelemetry {
        return this.rawDolbyVisionAuthorization.getTelemetry(
            this.device,
            this.canvasFormat
        );
    }

    /** Returns exact Profile 7 MEL/base-fallback authorization state. */
    getProfile7DolbyVisionAuthorizationTelemetry(): DolbyVisionAuthorizationTelemetry {
        return this.profile7DolbyVisionAuthorization.getTelemetry(
            this.device,
            this.canvasFormat
        );
    }

    /** Returns exact Profile 7 FEL residual authorization state. */
    getProfile7FELDolbyVisionAuthorizationTelemetry(): DolbyVisionAuthorizationTelemetry {
        return this.profile7FELDolbyVisionAuthorization.getTelemetry(
            this.device,
            this.canvasFormat
        );
    }

    /** Returns exact external Profile 5 authorization state without GPU objects. */
    getExternalDolbyVisionAuthorizationTelemetry(): ExternalDolbyVisionAuthorizationTelemetry {
        return this.externalDolbyVisionAuthorization.getTelemetry(
            this.device,
            this.canvasFormat
        );
    }

    /** Returns only settled raw-plane Dolby Vision authorization. */
    isRawDolbyVisionPresentationAuthorized(): boolean {
        return this.settings.mode === 'hdr-to-sdr' ?
            this.isActiveRawDolbyVisionAuthorized('I420P10') :
            this.rawDolbyVisionAuthorization.getTelemetry(
                this.device,
                this.canvasFormat
            ).status === 'authorized';
    }

    /** Returns only settled raw-plane Profile 7 authorization. */
    isRawDolbyVisionProfile7PresentationAuthorized(): boolean {
        return this.settings.mode === 'hdr-to-sdr' ?
            this.isActiveRawDolbyVisionAuthorized('I420P10', 7) :
            this.profile7DolbyVisionAuthorization.getTelemetry(
                this.device,
                this.canvasFormat
            ).status === 'authorized';
    }

    /** Returns only settled exact-device Profile 7 FEL residual authorization. */
    isRawDolbyVisionProfile7FELPresentationAuthorized(): boolean {
        return this.settings.mode === 'hdr-to-sdr' ?
            this.isActiveRawDolbyVisionFELAuthorized('I420P10') :
            this.profile7FELDolbyVisionAuthorization.getTelemetry(
                this.device,
                this.canvasFormat
            ).status === 'authorized';
    }

    /** Returns only settled external-texture Profile 5 authorization. */
    isExternalDolbyVisionPresentationAuthorized(): boolean {
        return this.settings.mode === 'hdr-to-sdr' ?
            this.isActiveExternalDolbyVisionAuthorized() :
            this.externalDolbyVisionAuthorization.getTelemetry(
                this.device,
                this.canvasFormat
            ).status === 'authorized';
    }

    /** Returns only settled native Main10 external-texture authorization. */
    isExternalHDRPresentationAuthorized(): boolean {
        return this.externalHDRAuthorization.getTelemetry(
            this.device,
            this.canvasFormat
        ).status === 'authorized';
    }

    /** Returns only settled exact-device Dolby Vision authorization. */
    isDolbyVisionPresentationAuthorized(): boolean {
        return this.isRawDolbyVisionPresentationAuthorized()
            || this.isExternalDolbyVisionPresentationAuthorized();
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
            if (!this.applyHDR10PlusFrameMetadata(decodedFrame, generation)) {
                return false;
            }

            let frameWidth: number;
            let frameHeight: number;
            let submission: FrameSubmission | null;
            switch (decodedFrame.outputMode) {
                case 'raw-planes': {
                    frameWidth = decodedFrame.frame.displayWidth;
                    frameHeight = decodedFrame.frame.displayHeight;
                    submission = this.renderDecodedRawFrame(decodedFrame, generation);
                    break;
                }
                case 'video-frame':
                    frameWidth = decodedFrame.frame.displayWidth
                        || decodedFrame.frame.codedWidth;
                    frameHeight = decodedFrame.frame.displayHeight
                        || decodedFrame.frame.codedHeight;
                    submission = this.renderDecodedVideoFrame(decodedFrame, generation);
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
                this.recordDolbyVisionProfile7Presentation(submission);
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
        this.dynamicHDR10PlusSettingsActive = false;
        if (isDolbyVisionInputMode(preparedPipeline.inputMode)
            && !this.createDolbyVisionRPUStorageBuffer()) {
            this.failColorConfiguration(
                pendingConfiguration,
                'pipeline-creation-failed'
            );
            return false;
        }
        if (
            preparedPipeline.dolbyVisionFELReconstruction
            && !this.createDolbyVisionEnhancementUniformBuffer()
        ) {
            this.failColorConfiguration(
                pendingConfiguration,
                'pipeline-creation-failed'
            );
            return false;
        }
        if (!preparedPipeline.dolbyVisionFELReconstruction) {
            this.destroyDolbyVisionEnhancementUniformBuffer();
        }

        this.desiredShaderCode = preparedPipeline.shaderCode;
        this.activeDolbyVisionProfile = preparedPipeline.dolbyVisionProfile;
        this.activeDolbyVisionFELReconstruction =
            preparedPipeline.dolbyVisionFELReconstruction ?? false;
        this.activeInputMode = preparedPipeline.inputMode;
        this.activeInputColorMetadata = preparedPipeline.inputColorMetadata ?
            { ...preparedPipeline.inputColorMetadata } :
            null;
        this.activeRawFrameFormat = preparedPipeline.rawFrameFormat;
        this.automaticInputPeakNits = configuration.automaticInputPeakNits ?? true;
        this.settings = preparedPipeline.settings;
        this.telemetry.mode = preparedPipeline.settings.mode;
        this.pendingColorConfiguration = null;
        this.resumeAfterColorConfiguration(generation);
        return true;
    }

    private createRenderSettingsUniformBuffer(device: GPUDevice): GPUBuffer {
        return createRawYUVRenderSettingsUniformBuffer(device);
    }

    private writeRenderSettingsUniform(
        settings: HDRToSDRRenderSettings,
        dynamicFrameSettings: HDR10PlusFrameRenderSettings | null = null
    ): boolean {
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
                settings,
                dynamicFrameSettings
            );
            this.renderSettingsUniformBuffer = renderSettingsUniformBuffer;
            return true;
        } catch (error) {
            console.warn('Unable to update WebGPU render settings uniforms', error);
            return false;
        }
    }

    private applyHDR10PlusFrameMetadata(
        decodedFrame: DecodedPresentationFrame,
        generation: number
    ): boolean {
        if (!this.isCurrent(generation) || this.settings.mode !== 'hdr-to-sdr') {
            return true;
        }

        const frameMetadata = decodedFrame.HDR10PlusMetadata;
        const status = frameMetadata?.status ?? 'absent';
        this.telemetry.lastHDR10PlusMetadataStatus = status;
        let dynamicFrameSettings: HDR10PlusFrameRenderSettings | null = null;
        const supportsHDR10Plus = (
            this.activeInputMode === 'external-hdr'
            || this.activeInputMode === 'raw-yuv'
        ) && this.activeInputColorMetadata?.transfer === 'pq';
        if (
            status === 'valid'
            && supportsHDR10Plus
            && isHDR10PlusFrameMetadata(frameMetadata)
            && frameMetadata.metadata
        ) {
            const sceneLuminance = getHDR10PlusSceneLuminance(frameMetadata.metadata);
            const inputPeakNits = this.automaticInputPeakNits ?
                Math.max(
                    this.settings.toneMapping.paperWhiteNits,
                    sceneLuminance.peakNits ?? this.settings.toneMapping.inputPeakNits
                ) :
                this.settings.toneMapping.inputPeakNits;
            const averageNits = Math.min(
                inputPeakNits,
                Math.max(0, sceneLuminance.averageNits ?? 0)
            );
            dynamicFrameSettings = {
                averageNits,
                inputPeakNits,
                targetedSystemDisplayMaximumLuminanceNits:
                    frameMetadata.metadata.targetedSystemDisplayMaximumLuminanceNits,
                toneMapping: frameMetadata.metadata.toneMapping
            };
        }

        if (dynamicFrameSettings || this.dynamicHDR10PlusSettingsActive) {
            if (!this.writeRenderSettingsUniform(this.settings, dynamicFrameSettings)) {
                this.fallback(generation, 'frame-render-failed');
                return false;
            }
            this.dynamicHDR10PlusSettingsActive = dynamicFrameSettings !== null;
        }
        if (dynamicFrameSettings) {
            this.telemetry.appliedHDR10PlusFrameCount += 1;
            this.telemetry.lastHDR10PlusInputPeakNits =
                dynamicFrameSettings.inputPeakNits;
        } else {
            this.telemetry.staticFallbackHDR10PlusFrameCount += 1;
            this.telemetry.lastHDR10PlusInputPeakNits = null;
        }
        return true;
    }

    /** Updates live HDR controls through uniforms without rebuilding the shader. */
    updateRenderSettings(
        settings: HDRToSDRRenderSettings,
        generation: number,
        automaticInputPeakNits: boolean = this.automaticInputPeakNits
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
            if (typeof automaticInputPeakNits !== 'boolean') {
                throw new TypeError('Automatic input peak policy must be boolean');
            }
            assertValidRenderSettings(settings);
            if (!this.writeRenderSettingsUniform(settings)) {
                return false;
            }
            this.dynamicHDR10PlusSettingsActive = false;
        } catch (error) {
            console.warn('Invalid live WebGPU render settings', error);
            return false;
        }

        this.settings = cloneRenderSettings(settings);
        this.automaticInputPeakNits = automaticInputPeakNits;
        this.requestDecodedPresentationRefresh(generation);
        return true;
    }

    private async prepareColorPipeline(
        configuration: PresentationColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        if ('inputMode' in configuration) {
            switch (configuration.inputMode) {
                case 'external-dolby-vision':
                    return this.prepareExternalDolbyVisionColorPipeline(
                        configuration,
                        pendingConfiguration
                    );
                case 'external-hdr':
                    return this.prepareExternalHDRColorPipeline(
                        configuration,
                        pendingConfiguration
                    );
                case 'raw-dolby-vision':
                    return this.prepareRawDolbyVisionColorPipeline(
                        configuration,
                        pendingConfiguration
                    );
                case 'raw-yuv':
                    return this.prepareRawHDRColorPipeline(
                        configuration,
                        pendingConfiguration
                    );
            }
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
            dolbyVisionProfile: null,
            inputMode: 'external-texture',
            inputColorMetadata: null,
            rawFrameFormat: null,
            settings: cloneRenderSettings(configuration.settings),
            shaderCode: identityShader
        };
    }

    private async prepareExternalDolbyVisionColorPipeline(
        configuration: ExternalDolbyVisionColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        try {
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            console.warn('Invalid WebGPU external Dolby Vision color configuration', error);
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid'
            );
            return null;
        }
        if (configuration.settings.mode !== 'hdr-to-sdr') {
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
            || !this.externalDolbyVisionAuthorization.isAuthorized(
                device,
                targetFormat,
                configuration.settings
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
            shaderCode = createExternalDolbyVisionColorPipelineWGSL(
                configuration.settings
            );
        } catch (error) {
            console.warn('Invalid WebGPU external Dolby Vision shader configuration', error);
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid'
            );
            return null;
        }
        return {
            dolbyVisionProfile: configuration.profile,
            inputMode: 'external-dolby-vision',
            inputColorMetadata: null,
            rawFrameFormat: null,
            settings: cloneRenderSettings(configuration.settings),
            shaderCode
        };
    }

    private async prepareExternalHDRColorPipeline(
        configuration: ExternalHDRColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        try {
            assertValidInputColorMetadata(configuration.metadata);
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            console.warn('Invalid WebGPU external HDR color configuration', error);
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid'
            );
            return null;
        }
        if (
            configuration.settings.mode !== 'hdr-to-sdr'
            || !getExternalHDRAuthorizationRouteKey(configuration.metadata)
        ) {
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
            || !this.externalHDRAuthorization.isAuthorized(
                device,
                targetFormat,
                configuration.metadata,
                configuration.settings
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
            shaderCode = createExternalHDRColorPipelineWGSL(
                configuration.metadata,
                configuration.settings
            );
        } catch (error) {
            console.warn('Invalid WebGPU external HDR shader configuration', error);
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid'
            );
            return null;
        }
        return {
            dolbyVisionProfile: null,
            inputMode: 'external-hdr',
            inputColorMetadata: { ...configuration.metadata },
            rawFrameFormat: null,
            settings: cloneRenderSettings(configuration.settings),
            shaderCode
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
            dolbyVisionProfile: null,
            inputMode: 'raw-yuv',
            inputColorMetadata: { ...configuration.metadata },
            rawFrameFormat: configuration.rawFrameFormat,
            settings: cloneRenderSettings(configuration.settings),
            shaderCode
        };
    }

    private async prepareRawDolbyVisionColorPipeline(
        configuration: RawDolbyVisionColorPipelineConfiguration,
        pendingConfiguration: PendingColorConfiguration
    ): Promise<PreparedColorPipeline | null> {
        try {
            assertValidRenderSettings(configuration.settings);
        } catch (error) {
            console.warn('Invalid WebGPU Dolby Vision color configuration', error);
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid'
            );
            return null;
        }
        if (configuration.settings.mode !== 'hdr-to-sdr') {
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
        const authorization = configuration.profile === 7 ?
            this.profile7DolbyVisionAuthorization :
            this.rawDolbyVisionAuthorization;
        if (
            !device
            || !targetFormat
            || !authorization.isAuthorized(
                device,
                targetFormat,
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
        const dolbyVisionFELReconstruction = configuration.profile === 7
            && this.profile7FELDolbyVisionAuthorization.isAuthorized(
                device,
                targetFormat,
                configuration.settings,
                configuration.rawFrameFormat
            );
        try {
            if (configuration.profile !== 7) {
                shaderCode = createRawDolbyVisionColorPipelineWGSL(
                    configuration.settings,
                    configuration.rawFrameFormat
                );
            } else if (dolbyVisionFELReconstruction) {
                shaderCode = createRawDolbyVisionProfile7FELColorPipelineWGSL(
                    configuration.settings,
                    configuration.rawFrameFormat
                );
            } else {
                shaderCode = createRawDolbyVisionProfile7ColorPipelineWGSL(
                    configuration.settings,
                    configuration.rawFrameFormat
                );
            }
        } catch (error) {
            console.warn('Invalid WebGPU Dolby Vision shader configuration', error);
            this.failColorConfiguration(
                pendingConfiguration,
                'hdr-color-configuration-invalid'
            );
            return null;
        }
        return {
            dolbyVisionFELReconstruction,
            dolbyVisionProfile: configuration.profile,
            inputMode: 'raw-dolby-vision',
            inputColorMetadata: null,
            rawFrameFormat: configuration.rawFrameFormat,
            settings: cloneRenderSettings(configuration.settings),
            shaderCode
        };
    }

    private createDolbyVisionRPUStorageBuffer(): boolean {
        if (this.dolbyVisionRPUStorageBuffer) {
            return true;
        }
        const device = this.device;
        if (!device) {
            return false;
        }
        try {
            this.dolbyVisionRPUStorageBuffer = device.createBuffer({
                label: 'WebGPU Dolby Vision per-frame RPU',
                size: DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
            });
            return true;
        } catch (error) {
            console.warn('Unable to create WebGPU Dolby Vision RPU buffer', error);
            return false;
        }
    }

    private createDolbyVisionEnhancementUniformBuffer(): boolean {
        if (this.dolbyVisionEnhancementUniformBuffer) {
            return true;
        }
        const device = this.device;
        if (!device) {
            return false;
        }
        try {
            this.dolbyVisionEnhancementUniformBuffer =
                createRawYUVEnhancementUniformBuffer(device);
            return true;
        } catch (error) {
            console.warn('Unable to create WebGPU Dolby Vision enhancement buffer', error);
            return false;
        }
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

    private isActiveExternalHDRAuthorized(metadata: InputColorMetadata): boolean {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        return this.settings.mode === 'hdr-to-sdr'
            && device !== null
            && targetFormat !== null
            && this.externalHDRAuthorization.isAuthorized(
                device,
                targetFormat,
                metadata,
                this.settings
            );
    }

    private isActiveRawDolbyVisionAuthorized(
        format: SupportedRawVideoFrameFormat,
        profile: 5 | 7 | 8 | null = this.activeDolbyVisionProfile
    ): boolean {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        const authorization = profile === 7 ?
            this.profile7DolbyVisionAuthorization :
            this.rawDolbyVisionAuthorization;
        return this.settings.mode === 'hdr-to-sdr'
            && device !== null
            && targetFormat !== null
            && authorization.isAuthorized(
                device,
                targetFormat,
                this.settings,
                format
            );
    }

    private isActiveRawDolbyVisionFELAuthorized(
        format: SupportedRawVideoFrameFormat
    ): boolean {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        return this.settings.mode === 'hdr-to-sdr'
            && device !== null
            && targetFormat !== null
            && this.profile7FELDolbyVisionAuthorization.isAuthorized(
                device,
                targetFormat,
                this.settings,
                format
            );
    }

    private isActiveExternalDolbyVisionAuthorized(): boolean {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        return this.settings.mode === 'hdr-to-sdr'
            && device !== null
            && targetFormat !== null
            && this.externalDolbyVisionAuthorization.isAuthorized(
                device,
                targetFormat,
                this.settings
            );
    }

    private suspendForColorConfiguration(): void {
        this.cancelFrameCallback();
        this.discardPendingSubmissionValidation();
        this.unbindLayoutHandling();
        this.removeCanvas();
        this.destroyRawPlaneTextures();
        this.destroyDolbyVisionRPUStorageBuffer();
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
                    !isExternalInputMode(inputMode)
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
                    !isExternalInputMode(this.activeInputMode)
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
                    !isExternalInputMode(this.activeInputMode)
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
            this.dynamicHDR10PlusSettingsActive = false;
            this.sampler = sampler;
            void getWebGPUHDRToneMappingEnabled().then((enabled: boolean): void => {
                if (enabled && this.device === device && this.canvasFormat === canvasFormat) {
                    this.rawHDRAuthorization.prewarm(device, canvasFormat);
                    this.externalHDRAuthorization.prewarm(device, canvasFormat);
                    this.externalDolbyVisionAuthorization.prewarm(device, canvasFormat);
                    this.rawDolbyVisionAuthorization.prewarm(device, canvasFormat);
                    this.profile7DolbyVisionAuthorization.prewarm(device, canvasFormat);
                    this.profile7FELDolbyVisionAuthorization.prewarm(device, canvasFormat);
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
            this.bindLayoutHandling(surface);
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
            || this.activeInputMode !== 'external-texture'
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
            if (decodedFrame
                && !this.applyHDR10PlusFrameMetadata(decodedFrame, generation)) {
                return;
            }
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
            return this.renderDecodedRawFrame(decodedFrame, generation);
        }
        if (decodedFrame?.outputMode === 'video-frame') {
            return this.renderDecodedVideoFrame(decodedFrame, generation);
        }
        if (this.activeInputMode !== 'external-texture') {
            this.fallback(generation, 'decoded-frame-color-mismatch');
            return null;
        }
        return this.renderCurrentFrame(video);
    }

    private renderDecodedVideoFrame(
        decodedFrame: DecodedVideoPresentationFrame,
        generation: number
    ): FrameSubmission | null {
        const frame = decodedFrame.frame;
        switch (this.activeInputMode) {
            case 'external-texture':
                if (this.activeInputColorMetadata
                    && !decodedFrameColorMatches(frame, this.activeInputColorMetadata)) {
                    this.fallback(generation, 'decoded-frame-color-mismatch');
                    return null;
                }
                break;
            case 'external-dolby-vision': {
                const device = this.device;
                const profile = this.activeDolbyVisionProfile;
                const storageBuffer = this.dolbyVisionRPUStorageBuffer;
                if (
                    !device
                    || profile !== 5
                    || !storageBuffer
                    || !decodedNeutralBT709FrameColorMatches(frame)
                    || !this.isActiveExternalDolbyVisionAuthorized()
                ) {
                    this.fallback(generation, 'decoded-frame-color-mismatch');
                    return null;
                }
                const packedRPUData = getSingleLayerDolbyVisionRPUData(
                    decodedFrame.encodedDolbyVisionMetadata,
                    profile,
                    10
                );
                if (!packedRPUData) {
                    this.fallback(generation, 'dolby-vision-metadata-invalid');
                    return null;
                }
                device.queue.writeBuffer(storageBuffer, 0, packedRPUData);
                break;
            }
            case 'external-hdr': {
                const metadata = this.activeInputColorMetadata;
                if (
                    !metadata
                    || !decodedNeutralBT709FrameColorMatches(frame)
                    || !this.isActiveExternalHDRAuthorized(metadata)
                ) {
                    this.fallback(generation, 'decoded-frame-color-mismatch');
                    return null;
                }
                break;
            }
            case 'raw-dolby-vision':
            case 'raw-yuv':
                this.fallback(generation, 'decoded-frame-color-mismatch');
                return null;
        }

        const frameWidth = frame.displayWidth || frame.codedWidth;
        const frameHeight = frame.displayHeight || frame.codedHeight;
        return this.renderCurrentFrame(frame, frameWidth, frameHeight);
    }

    private renderDecodedRawFrame(
        decodedFrame: DecodedRawPresentationFrame,
        generation: number
    ): FrameSubmission | null {
        const format = this.activeRawFrameFormat;
        if (!format) {
            this.fallback(generation, 'decoded-frame-color-mismatch');
            return null;
        }
        switch (this.activeInputMode) {
            case 'raw-yuv':
                return this.renderDecodedRawYUVFrame(
                    decodedFrame,
                    generation,
                    format
                );
            case 'raw-dolby-vision':
                return this.renderDecodedRawDolbyVisionFrame(
                    decodedFrame,
                    generation,
                    format
                );
            case 'external-dolby-vision':
            case 'external-hdr':
            case 'external-texture':
                this.fallback(generation, 'decoded-frame-color-mismatch');
                return null;
        }
    }

    private renderDecodedRawYUVFrame(
        decodedFrame: DecodedRawPresentationFrame,
        generation: number,
        format: SupportedRawVideoFrameFormat
    ): FrameSubmission | null {
        const inputColorMetadata = this.activeInputColorMetadata;
        if (
            !inputColorMetadata
            || !this.isActiveRawHDRAuthorized(inputColorMetadata, format)
            || !rawFrameDescriptorMatches(decodedFrame, inputColorMetadata, format)
        ) {
            this.fallback(generation, 'decoded-frame-color-mismatch');
            return null;
        }
        return this.renderRawFrame(decodedFrame.frame);
    }

    private renderDecodedRawDolbyVisionFrame(
        decodedFrame: DecodedRawPresentationFrame,
        generation: number,
        format: SupportedRawVideoFrameFormat
    ): FrameSubmission | null {
        const device = this.device;
        const profile = this.activeDolbyVisionProfile;
        const storageBuffer = this.dolbyVisionRPUStorageBuffer;
        if (
            !device
            || !profile
            || !storageBuffer
            || !this.isActiveRawDolbyVisionAuthorized(format)
            || !rawDolbyVisionFrameDescriptorMatches(decodedFrame, format)
            || !rawDolbyVisionEnhancementFrameDescriptorMatches(decodedFrame)
            || (profile !== 7 && decodedFrame.enhancementFrame !== undefined)
        ) {
            this.fallback(generation, 'decoded-frame-color-mismatch');
            return null;
        }

        let packedRPUData: ArrayBuffer | null = null;
        let profile7RPUData: Profile7DolbyVisionRPUData | null = null;
        switch (profile) {
            case 5:
            case 8:
                packedRPUData = getSingleLayerDolbyVisionRPUData(
                    decodedFrame.encodedDolbyVisionMetadata,
                    profile,
                    decodedFrame.frame.bitDepth
                );
                break;
            case 7:
                profile7RPUData = getProfile7DolbyVisionRPUData(
                    decodedFrame.encodedDolbyVisionMetadata,
                    decodedFrame.frame.bitDepth,
                    Boolean(decodedFrame.enhancementFrame)
                );
                packedRPUData = profile7RPUData?.packedRPUData ?? null;
                break;
        }
        if (!packedRPUData) {
            this.fallback(generation, 'dolby-vision-metadata-invalid');
            return null;
        }

        device.queue.writeBuffer(storageBuffer, 0, packedRPUData);
        const enhancementFrame = this.activeDolbyVisionFELReconstruction ?
            decodedFrame.enhancementFrame ?? null :
            null;
        const submission = this.renderRawFrame(
            decodedFrame.frame,
            enhancementFrame
        );
        if (!submission || !profile7RPUData) {
            return submission;
        }
        return {
            ...submission,
            dolbyVisionProfile7LayerMode: getProfile7LayerPresentation(
                profile7RPUData,
                this.activeDolbyVisionFELReconstruction,
                decodedFrame.enhancementFrame
            )
        };
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
            )
            && (
                !isDolbyVisionInputMode(this.activeInputMode)
                || this.dolbyVisionRPUStorageBuffer !== null
            )
            && (
                !this.activeDolbyVisionFELReconstruction
                || this.dolbyVisionEnhancementUniformBuffer !== null
            );
    }

    private renderCurrentFrame(
        source?: HTMLVideoElement | VideoFrame,
        sourceWidth?: number,
        sourceHeight?: number
    ): FrameSubmission | null {
        if (!isExternalInputMode(this.activeInputMode)) {
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
            if (this.activeInputMode === 'external-dolby-vision') {
                const storageBuffer = this.dolbyVisionRPUStorageBuffer;
                if (!storageBuffer) {
                    throw new Error('The external Dolby Vision RPU buffer is unavailable');
                }
                bindGroupEntries.push({
                    binding: 4,
                    resource: { buffer: storageBuffer }
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

    private renderRawFrame(
        frame: TransferableRawVideoFrame,
        enhancementFrame: TransferableRawVideoFrame | null = null
    ): FrameSubmission | null {
        const surface = this.surface;
        const canvas = this.canvas;
        const canvasContext = this.canvasContext;
        const device = this.device;
        const pipeline = this.pipeline;
        const presentationUniformBuffer = this.presentationUniformBuffer;
        const renderSettingsUniformBuffer = this.renderSettingsUniformBuffer;
        if (
            isExternalInputMode(this.activeInputMode)
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
                dolbyVisionEnhancementUniformBuffer:
                    this.activeDolbyVisionFELReconstruction ?
                        this.dolbyVisionEnhancementUniformBuffer ?? undefined :
                        undefined,
                dolbyVisionRPUStorageBuffer: this.activeInputMode === 'raw-dolby-vision' ?
                    this.dolbyVisionRPUStorageBuffer ?? undefined :
                    undefined,
                enhancementFrame,
                enhancementTextureSet: this.enhancementRawPlaneTextureSet,
                frame,
                pipeline,
                presentation: layout.presentation,
                presentationUniformBuffer,
                renderSettingsUniformBuffer,
                targetView: canvasContext.getCurrentTexture().createView(),
                textureSet: this.rawPlaneTextureSet
            });
            this.enhancementRawPlaneTextureSet = renderResult.enhancementTextureSet;
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
            this.recordDolbyVisionProfile7Presentation(submission);
            this.scheduleFrameCallback(generation);
        });
    }

    private recordDolbyVisionProfile7Presentation(submission: FrameSubmission): void {
        switch (submission.dolbyVisionProfile7LayerMode) {
            case 'fel':
                this.telemetry.dolbyVisionProfile7FELPresentedFrameCount += 1;
                break;
            case 'fel-base-fallback':
                this.telemetry.dolbyVisionProfile7FELBaseFallbackPresentedFrameCount += 1;
                break;
            case 'mel':
                this.telemetry.dolbyVisionProfile7MELPresentedFrameCount += 1;
                break;
            case undefined:
                break;
        }
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
            this.invalidatePresentationLayout();
            return null;
        }

        const devicePixelRatio = Math.max(window.devicePixelRatio || 1, 1);
        const cachedLayout = this.cachedPresentationLayout;
        if (
            cachedLayout
            && !this.presentationLayoutDirty
            && cachedLayout.devicePixelRatio === devicePixelRatio
            && cachedLayout.videoHeight === sourceHeight
            && cachedLayout.videoWidth === sourceWidth
        ) {
            return cachedLayout;
        }

        this.invalidatePresentationLayout();
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
        this.presentationLayoutDirty = false;
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

    private invalidatePresentationLayout(): void {
        this.presentationLayoutDirty = true;
    }

    private readonly handleLayoutInvalidation = (): void => {
        if (!this.sessionActive || this.fallbackLatched) {
            return;
        }

        if (!this.resynchronizeCachedPresentationLayout()) {
            return;
        }
        if (this.decodedFramePushActive) {
            this.requestDecodedPresentationRefresh(this.activeGeneration);
            return;
        }
        this.renderCurrentFrameOrFallback(this.activeGeneration);
    };

    private resynchronizeCachedPresentationLayout(): boolean {
        const cachedLayout = this.cachedPresentationLayout;
        const surface = this.surface;
        const canvas = this.canvas;
        const device = this.device;
        this.invalidatePresentationLayout();
        if (!cachedLayout || !surface || !canvas || !device) {
            return false;
        }

        const updatedLayout = this.getPresentationLayout(
            surface,
            canvas,
            device,
            cachedLayout.videoWidth,
            cachedLayout.videoHeight
        );
        if (!updatedLayout) {
            return false;
        }
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
            || this.activeInputMode !== 'external-texture'
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

    private readonly handleLayoutMotionStart = (event: Event): void => {
        if (!this.isObservedLayoutTarget(event.target)) {
            return;
        }

        this.handleLayoutInvalidation();
    };

    private readonly handleLayoutMotionIteration = (event: Event): void => {
        if (!this.isObservedLayoutTarget(event.target)) {
            return;
        }

        this.handleLayoutInvalidation();
    };

    private readonly handleLayoutMotionEnd = (event: Event): void => {
        if (!this.isObservedLayoutTarget(event.target)) {
            return;
        }

        // The final event is required because transforms do not trigger ResizeObserver
        this.handleLayoutInvalidation();
    };

    private isObservedLayoutTarget(target: EventTarget | null): boolean {
        if (!(target instanceof HTMLElement)) {
            return false;
        }

        return target.isSameNode(this.surface?.container ?? null)
            || target.isSameNode(this.surface?.video ?? null);
    }

    private bindLayoutHandling(surface: PresentationSurface): void {
        this.unbindLayoutHandling();
        const layoutHandlingRevision = this.layoutHandlingRevision;
        const layoutInvalidationHandler = (): void => {
            if (this.layoutHandlingRevision !== layoutHandlingRevision) {
                return;
            }
            this.handleLayoutInvalidation();
        };
        this.layoutInvalidationHandler = layoutInvalidationHandler;
        if (typeof ResizeObserver === 'function') {
            this.resizeObserver = new ResizeObserver(layoutInvalidationHandler);
            this.resizeObserver.observe(surface.container);
            this.resizeObserver.observe(surface.video);
        }
        if (typeof MutationObserver === 'function') {
            this.layoutMutationObserver = new MutationObserver(
                layoutInvalidationHandler
            );
            const observerOptions: MutationObserverInit = {
                attributeFilter: [ 'class', 'style' ],
                attributes: true
            };
            const mutationTargets: HTMLElement[] = [];
            mutationTargets.push(surface.video);
            let mutationTarget: HTMLElement | null = surface.container;
            while (mutationTarget) {
                mutationTargets.push(mutationTarget);
                mutationTarget = mutationTarget.parentElement;
            }
            for (const target of mutationTargets) {
                this.layoutMutationObserver.observe(target, observerOptions);
            }
        }
        for (const eventName of LAYOUT_MOTION_START_EVENTS) {
            surface.container.addEventListener(
                eventName,
                this.handleLayoutMotionStart,
                true
            );
        }
        surface.container.addEventListener(
            LAYOUT_MOTION_ITERATION_EVENT,
            this.handleLayoutMotionIteration,
            true
        );
        for (const eventName of LAYOUT_MOTION_END_EVENTS) {
            surface.container.addEventListener(
                eventName,
                this.handleLayoutMotionEnd,
                true
            );
        }
        window.addEventListener('resize', layoutInvalidationHandler);
    }

    private unbindLayoutHandling(): void {
        this.layoutHandlingRevision += 1;
        const container = this.surface?.container;
        if (container) {
            for (const eventName of LAYOUT_MOTION_START_EVENTS) {
                container.removeEventListener(
                    eventName,
                    this.handleLayoutMotionStart,
                    true
                );
            }
            container.removeEventListener(
                LAYOUT_MOTION_ITERATION_EVENT,
                this.handleLayoutMotionIteration,
                true
            );
            for (const eventName of LAYOUT_MOTION_END_EVENTS) {
                container.removeEventListener(
                    eventName,
                    this.handleLayoutMotionEnd,
                    true
                );
            }
        }
        this.layoutMutationObserver?.disconnect();
        this.layoutMutationObserver = null;
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.layoutInvalidationHandler) {
            window.removeEventListener('resize', this.layoutInvalidationHandler);
            this.layoutInvalidationHandler = null;
        }
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
        this.invalidatePresentationLayout();
        this.configuredDevice = null;
    }

    private destroyRawPlaneTextures(): void {
        const textureSet = this.rawPlaneTextureSet;
        const enhancementTextureSet = this.enhancementRawPlaneTextureSet;
        this.rawPlaneTextureSet = null;
        this.enhancementRawPlaneTextureSet = null;
        try {
            destroyRawPlaneTextureSet(textureSet);
            destroyRawPlaneTextureSet(enhancementTextureSet);
        } catch (error) {
            console.warn('Unable to destroy WebGPU raw video plane textures', error);
        }
    }

    private destroyDolbyVisionRPUStorageBuffer(): void {
        const storageBuffer = this.dolbyVisionRPUStorageBuffer;
        this.dolbyVisionRPUStorageBuffer = null;
        try {
            storageBuffer?.destroy();
        } catch (error) {
            console.warn('Unable to destroy WebGPU Dolby Vision RPU buffer', error);
        }
    }

    private destroyDolbyVisionEnhancementUniformBuffer(): void {
        const uniformBuffer = this.dolbyVisionEnhancementUniformBuffer;
        this.dolbyVisionEnhancementUniformBuffer = null;
        try {
            uniformBuffer?.destroy();
        } catch (error) {
            console.warn('Unable to destroy WebGPU Dolby Vision enhancement buffer', error);
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
        this.unbindLayoutHandling();
        this.removeCanvas();
        this.destroyRawPlaneTextures();
        this.destroyDolbyVisionRPUStorageBuffer();
        this.destroyDolbyVisionEnhancementUniformBuffer();
        this.device = null;
        this.pipeline = null;
        this.pipelineShaderCode = null;
        this.presentationUniformBuffer = null;
        this.renderSettingsUniformBuffer = null;
        this.dynamicHDR10PlusSettingsActive = false;
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

        let presentationReauthorized = true;
        switch (this.activeInputMode) {
            case 'external-texture':
                break;
            case 'external-hdr':
                presentationReauthorized = await this.reauthorizeExternalHDRPresentation(
                    generation
                );
                break;
            case 'external-dolby-vision':
            case 'raw-dolby-vision':
                presentationReauthorized = await this.reauthorizeDolbyVisionPresentation(
                    generation
                ) && this.createDolbyVisionRPUStorageBuffer()
                    && (
                        !this.activeDolbyVisionFELReconstruction
                        || this.createDolbyVisionEnhancementUniformBuffer()
                    );
                break;
            case 'raw-yuv':
                presentationReauthorized = await this.reauthorizeRawHDRPresentation(generation);
                break;
        }
        if (!presentationReauthorized) {
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

    private async reauthorizeExternalHDRPresentation(generation: number): Promise<boolean> {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        const metadata = this.activeInputColorMetadata;
        if (
            !device
            || !targetFormat
            || !metadata
            || this.settings.mode !== 'hdr-to-sdr'
        ) {
            return false;
        }
        const routeKey = getExternalHDRAuthorizationRouteKey(metadata);
        if (!routeKey) {
            return false;
        }

        const decision = await this.externalHDRAuthorization.authorize(
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
        return this.externalHDRAuthorization.isAuthorized(
            device,
            targetFormat,
            metadata,
            this.settings
        );
    }

    private async reauthorizeDolbyVisionPresentation(
        generation: number
    ): Promise<boolean> {
        const device = this.device;
        const targetFormat = this.canvasFormat;
        if (
            !device
            || !targetFormat
            || this.settings.mode !== 'hdr-to-sdr'
        ) {
            return false;
        }
        const externalInput = this.activeInputMode === 'external-dolby-vision';
        const rawFrameFormat = this.activeRawFrameFormat;
        const rawAuthorization = this.activeDolbyVisionProfile === 7 ?
            this.profile7DolbyVisionAuthorization :
            this.rawDolbyVisionAuthorization;
        if (!externalInput && !rawFrameFormat) {
            return false;
        }
        const decision = externalInput ?
            await this.externalDolbyVisionAuthorization.authorize(
                device,
                targetFormat
            ) :
            await rawAuthorization.authorize(
                device,
                targetFormat
            );
        if (
            !this.isCurrent(generation)
            || this.fallbackLatched
            || this.device !== device
            || decision.status !== 'authorized'
        ) {
            return false;
        }
        if (!externalInput && this.activeDolbyVisionFELReconstruction) {
            const felDecision = await this.profile7FELDolbyVisionAuthorization.authorize(
                device,
                targetFormat
            );
            if (
                !this.isCurrent(generation)
                || this.fallbackLatched
                || this.device !== device
                || felDecision.status !== 'authorized'
            ) {
                return false;
            }
        }
        return externalInput ?
            this.externalDolbyVisionAuthorization.isAuthorized(
                device,
                targetFormat,
                this.settings
            ) :
            rawAuthorization.isAuthorized(
                device,
                targetFormat,
                this.settings,
                rawFrameFormat as SupportedRawVideoFrameFormat
            ) && (
                !this.activeDolbyVisionFELReconstruction
                || this.profile7FELDolbyVisionAuthorization.isAuthorized(
                    device,
                    targetFormat,
                    this.settings,
                    rawFrameFormat as SupportedRawVideoFrameFormat
                )
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
        this.unbindLayoutHandling();
        this.removeCanvas();
        this.destroyRawPlaneTextures();
        this.destroyDolbyVisionRPUStorageBuffer();
        this.destroyDolbyVisionEnhancementUniformBuffer();
        this.decodedFrameProvider = null;
        this.decodedFramePushActive = false;
        this.activeInputColorMetadata = null;
        this.activeDolbyVisionProfile = null;
        this.activeDolbyVisionFELReconstruction = false;
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
