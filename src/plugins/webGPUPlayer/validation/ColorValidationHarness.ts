import { type Microseconds } from '../MediaTime';
import {
    validateColorRamp,
    type ColorRampObservation,
    type ColorRampTolerances,
    type ColorValidationClassification,
    type ColorValidationRamp,
    type ColorValidationRampIdentity,
    type ColorValidationResult
} from '../color/ColorValidation';
import { type InputColorMetadata } from '../color/ColorMetadata';
import {
    getValidationCanvasUsage,
    GPUCanvasPixelReader,
    type GPUCanvasReadbackFailure
} from './GPUCanvasReadback';

export type BrowserColorMetadata = {
    colorGamut: 'display-p3' | 'rec2020' | 'srgb' | 'unknown'
    dynamicRange: 'high' | 'standard' | 'unknown'
    language: string
    secureContext: boolean
    userAgent: string
};

export type GPUColorMetadata = {
    architecture: string
    description: string
    device: string
    deviceLabel: string
    features: readonly string[]
    maximumTextureDimension2D: number | null
    vendor: string
};

export type CanvasColorMetadata = {
    alphaMode: GPUCanvasAlphaMode
    colorSpace: PredefinedColorSpace
    format: GPUTextureFormat
    height: number
    toneMappingMode: GPUCanvasToneMappingMode | 'browser-default'
    width: number
};

export type VideoFrameColorSpaceMetadata = {
    fullRange: boolean | null
    matrix: string | null
    primaries: string | null
    transfer: string | null
};

export type ReferenceFrameColorMetadata = {
    codedHeight: number
    codedWidth: number
    displayHeight: number
    displayWidth: number
    inputColorMetadata: InputColorMetadata
    timestampMicroseconds: Microseconds
    videoColorSpace: VideoFrameColorSpaceMetadata | null
};

export type ReferenceFrameMetadataInput = {
    codedHeight?: number
    codedWidth?: number
    displayHeight?: number
    displayWidth?: number
    videoColorSpace?: VideoFrameColorSpaceMetadata | null
};

export type ColorValidationCaptureRequest = {
    frame?: ReferenceFrameMetadataInput
    sampleX?: number
    sampleY?: number
    sourceTexture?: GPUTexture
    timestampMicroseconds: Microseconds
};

export type ColorValidationCaptureResult = {
    failure: GPUCanvasReadbackFailure | null
    observation: ColorRampObservation | null
};

export type ColorValidationCapability = 'supported' | 'unavailable' | 'unsupported';
export type ColorValidationHarnessClassification =
    | ColorValidationClassification
    | 'readback-unavailable';

export type ColorValidationDiagnosticKind =
    | 'external-texture-conversion'
    | 'gpu-texture-readback';

export type ColorValidationDiagnosticMetadata = {
    kind: ColorValidationDiagnosticKind
    productionAuthorization: false
    rampIdentity: ColorValidationRampIdentity
};

export type ColorValidationCapabilityDecision = {
    browser: BrowserColorMetadata
    canvas: CanvasColorMetadata
    /** Diagnostic match status retained for telemetry compatibility. */
    capability: ColorValidationCapability
    classification: ColorValidationHarnessClassification
    diagnostic: ColorValidationDiagnosticMetadata
    frames: readonly ReferenceFrameColorMetadata[]
    gpu: GPUColorMetadata
    observations: readonly ColorRampObservation[]
    readbackFailure: GPUCanvasReadbackFailure | null
    validation: ColorValidationResult | null
};

export type ValidationCanvasConfiguration = {
    alphaMode?: GPUCanvasAlphaMode
    colorSpace?: PredefinedColorSpace
    format: GPUTextureFormat
    toneMapping?: GPUCanvasToneMapping
};

export type ColorValidationHarnessOptions = {
    adapterInfo?: Pick<GPUAdapterInfo, 'architecture' | 'description' | 'device' | 'vendor'>
    browserMetadata?: BrowserColorMetadata
    canvas: HTMLCanvasElement
    canvasConfiguration: ValidationCanvasConfiguration
    configureCanvas?: boolean
    context?: GPUCanvasContext
    device: GPUDevice
    diagnosticKind?: ColorValidationDiagnosticKind
    ramp: ColorValidationRamp
    tolerances?: ColorRampTolerances
};

const DEFAULT_SAMPLE_COORDINATE_DIVISOR = 2;

function matchesMediaQuery(query: string): boolean | null {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return null;
    }

    try {
        return window.matchMedia(query).matches;
    } catch {
        return null;
    }
}

function detectColorGamut(): BrowserColorMetadata['colorGamut'] {
    if (matchesMediaQuery('(color-gamut: rec2020)')) {
        return 'rec2020';
    }
    if (matchesMediaQuery('(color-gamut: p3)')) {
        return 'display-p3';
    }
    if (matchesMediaQuery('(color-gamut: srgb)')) {
        return 'srgb';
    }

    return 'unknown';
}

function detectDynamicRange(): BrowserColorMetadata['dynamicRange'] {
    const highDynamicRange = matchesMediaQuery('(dynamic-range: high)');
    if (highDynamicRange === true) {
        return 'high';
    }
    if (highDynamicRange === false) {
        return 'standard';
    }

    return 'unknown';
}

/** Collects browser color capabilities without treating media queries as validation. */
export function collectBrowserColorMetadata(): BrowserColorMetadata {
    const runtimeNavigator = typeof navigator === 'undefined' ? null : navigator;
    return {
        colorGamut: detectColorGamut(),
        dynamicRange: detectDynamicRange(),
        language: runtimeNavigator?.language ?? '',
        // eslint-disable-next-line compat/compat -- The harness records capability-gated WebGPU environments
        secureContext: typeof window !== 'undefined' && window.isSecureContext === true,
        userAgent: runtimeNavigator?.userAgent ?? ''
    };
}

function collectDeviceFeatures(device: GPUDevice): string[] {
    const features: string[] = [];
    for (const feature of device.features) {
        features.push(feature);
    }
    features.sort((left: string, right: string): number => left.localeCompare(right));
    return features;
}

function collectGPUMetadata(
    device: GPUDevice,
    adapterInfo?: Pick<GPUAdapterInfo, 'architecture' | 'description' | 'device' | 'vendor'>
): GPUColorMetadata {
    return {
        architecture: adapterInfo?.architecture ?? '',
        description: adapterInfo?.description ?? '',
        device: adapterInfo?.device ?? '',
        deviceLabel: device.label,
        features: collectDeviceFeatures(device),
        maximumTextureDimension2D: Number.isFinite(device.limits.maxTextureDimension2D) ?
            device.limits.maxTextureDimension2D :
            null,
        vendor: adapterInfo?.vendor ?? ''
    };
}

function createInitializationFailure(message: string): GPUCanvasReadbackFailure {
    return { code: 'gpu-api-unavailable', message };
}

function assertValidDimension(value: number, name: string): void {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive integer`);
    }
}

function snapshotInputColorMetadata(metadata: InputColorMetadata): InputColorMetadata {
    return { ...metadata };
}

/** Captures and classifies a bounded diagnostic ramp from a WebGPU texture. */
export class GPUCanvasColorValidationHarness {
    private readonly browserMetadata: BrowserColorMetadata;
    private readonly canvas: HTMLCanvasElement;
    private readonly canvasConfiguration: ValidationCanvasConfiguration;
    private readonly context: GPUCanvasContext | null;
    private readonly diagnosticKind: ColorValidationDiagnosticKind;
    private readonly frames: ReferenceFrameColorMetadata[] = [];
    private readonly gpuMetadata: GPUColorMetadata;
    private readonly observations: ColorRampObservation[] = [];
    private readonly ownsCanvasConfiguration: boolean;
    private readonly pixelReader: GPUCanvasPixelReader;
    private readonly ramp: ColorValidationRamp;
    private readonly tolerances?: ColorRampTolerances;
    private destroyed = false;
    private readbackFailure: GPUCanvasReadbackFailure | null = null;

    public constructor(options: ColorValidationHarnessOptions) {
        if (options.ramp.samples.length === 0 || options.ramp.samples.length > 64) {
            throw new RangeError('The validation harness requires from 1 through 64 samples');
        }

        assertValidDimension(options.canvas.width, 'Canvas width');
        assertValidDimension(options.canvas.height, 'Canvas height');
        this.browserMetadata = {
            ...(options.browserMetadata ?? collectBrowserColorMetadata())
        };
        this.canvas = options.canvas;
        this.canvasConfiguration = {
            ...options.canvasConfiguration,
            toneMapping: options.canvasConfiguration.toneMapping ?
                { ...options.canvasConfiguration.toneMapping } :
                undefined
        };
        this.context = options.context ?? null;
        this.diagnosticKind = options.diagnosticKind ?? 'gpu-texture-readback';
        this.gpuMetadata = collectGPUMetadata(options.device, options.adapterInfo);
        this.ownsCanvasConfiguration = options.configureCanvas !== false;
        if (this.ownsCanvasConfiguration && !this.context) {
            throw new Error('A WebGPU canvas context is required when configuring the canvas');
        }
        this.ramp = options.ramp;
        this.tolerances = options.tolerances;
        this.pixelReader = new GPUCanvasPixelReader({
            context: options.context,
            device: options.device,
            format: options.canvasConfiguration.format,
            maximumReadbacks: options.ramp.samples.length
        });
        if (this.ownsCanvasConfiguration) {
            this.configureCanvas(options.device);
        }
    }

    /** Captures the selected pixel for a known integer-microsecond reference frame. */
    public async captureCurrentFrame(
        captureRequest: ColorValidationCaptureRequest
    ): Promise<ColorValidationCaptureResult> {
        if (this.destroyed) {
            const failure: GPUCanvasReadbackFailure = {
                code: 'destroyed',
                message: 'The color validation harness has been destroyed'
            };
            this.readbackFailure = failure;
            return { failure, observation: null };
        }
        if (this.readbackFailure) {
            return { failure: this.readbackFailure, observation: null };
        }
        if (!Number.isSafeInteger(captureRequest.timestampMicroseconds)) {
            const failure: GPUCanvasReadbackFailure = {
                code: 'validation-error',
                message: 'Frame timestamps must use safe integer microseconds'
            };
            return { failure, observation: null };
        }

        let frameMetadata: ReferenceFrameColorMetadata;
        try {
            frameMetadata = this.createFrameMetadata(captureRequest);
        } catch (error) {
            const failure: GPUCanvasReadbackFailure = {
                code: 'validation-error',
                message: error instanceof Error ? error.message : String(error)
            };
            return { failure, observation: null };
        }

        const sampleX = captureRequest.sampleX
            ?? Math.floor(this.canvas.width / DEFAULT_SAMPLE_COORDINATE_DIVISOR);
        const sampleY = captureRequest.sampleY
            ?? Math.floor(this.canvas.height / DEFAULT_SAMPLE_COORDINATE_DIVISOR);
        const readback = await this.pixelReader.readPixel(
            sampleX,
            sampleY,
            captureRequest.sourceTexture
        );
        if (readback.failure || !readback.linearRGB) {
            this.readbackFailure = readback.failure ?? createInitializationFailure(
                'Canvas readback completed without a color value'
            );
            return { failure: this.readbackFailure, observation: null };
        }

        const observation: ColorRampObservation = {
            linearRGB: readback.linearRGB,
            timestampMicroseconds: captureRequest.timestampMicroseconds
        };
        this.observations.push(observation);
        this.frames.push(frameMetadata);
        return { failure: null, observation };
    }

    /** Compares all captured pixels and returns a diagnostic capability decision. */
    public evaluate(): ColorValidationCapabilityDecision {
        if (this.readbackFailure || this.destroyed) {
            const failure = this.readbackFailure ?? {
                code: 'destroyed' as const,
                message: 'The color validation harness has been destroyed'
            };
            return this.createDecision(
                'unavailable',
                'readback-unavailable',
                null,
                failure
            );
        }

        const validation = this.tolerances ?
            validateColorRamp(this.ramp, this.observations, this.tolerances) :
            validateColorRamp(this.ramp, this.observations);
        return this.createDecision(
            validation.accepted ? 'supported' : 'unsupported',
            validation.classification,
            validation,
            null
        );
    }

    /** Releases mapped resources and an owned validation canvas configuration. */
    public destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.pixelReader.destroy();
        if (this.ownsCanvasConfiguration) {
            this.context?.unconfigure();
        }
    }

    private configureCanvas(device: GPUDevice): void {
        if (!this.context) {
            this.readbackFailure = createInitializationFailure(
                'A WebGPU canvas context is unavailable'
            );
            return;
        }
        const usage = getValidationCanvasUsage();
        if (usage === null) {
            this.readbackFailure = createInitializationFailure(
                'GPUTextureUsage is unavailable in this browser'
            );
            return;
        }

        try {
            this.context.configure({
                alphaMode: this.canvasConfiguration.alphaMode,
                colorSpace: this.canvasConfiguration.colorSpace,
                device,
                format: this.canvasConfiguration.format,
                toneMapping: this.canvasConfiguration.toneMapping,
                usage
            });
        } catch (error) {
            this.readbackFailure = createInitializationFailure(
                error instanceof Error ? error.message : String(error)
            );
        }
    }

    private createFrameMetadata(
        captureRequest: ColorValidationCaptureRequest
    ): ReferenceFrameColorMetadata {
        const frame = captureRequest.frame;
        const codedWidth = frame?.codedWidth ?? this.canvas.width;
        const codedHeight = frame?.codedHeight ?? this.canvas.height;
        const displayWidth = frame?.displayWidth ?? this.canvas.width;
        const displayHeight = frame?.displayHeight ?? this.canvas.height;
        assertValidDimension(codedWidth, 'Coded width');
        assertValidDimension(codedHeight, 'Coded height');
        assertValidDimension(displayWidth, 'Display width');
        assertValidDimension(displayHeight, 'Display height');
        return {
            codedHeight,
            codedWidth,
            displayHeight,
            displayWidth,
            inputColorMetadata: snapshotInputColorMetadata(this.ramp.metadata),
            timestampMicroseconds: captureRequest.timestampMicroseconds,
            videoColorSpace: frame?.videoColorSpace ? { ...frame.videoColorSpace } : null
        };
    }

    private createDecision(
        capability: ColorValidationCapability,
        classification: ColorValidationHarnessClassification,
        validation: ColorValidationResult | null,
        readbackFailure: GPUCanvasReadbackFailure | null
    ): ColorValidationCapabilityDecision {
        const toneMappingMode = this.canvasConfiguration.toneMapping?.mode
            ?? 'browser-default';
        return {
            browser: { ...this.browserMetadata },
            canvas: {
                alphaMode: this.canvasConfiguration.alphaMode ?? 'opaque',
                colorSpace: this.canvasConfiguration.colorSpace ?? 'srgb',
                format: this.canvasConfiguration.format,
                height: this.canvas.height,
                toneMappingMode,
                width: this.canvas.width
            },
            capability,
            classification,
            diagnostic: {
                kind: this.diagnosticKind,
                productionAuthorization: false,
                rampIdentity: { ...this.ramp.identity }
            },
            frames: this.frames.map((frame: ReferenceFrameColorMetadata) => ({
                ...frame,
                inputColorMetadata: snapshotInputColorMetadata(frame.inputColorMetadata),
                videoColorSpace: frame.videoColorSpace ? { ...frame.videoColorSpace } : null
            })),
            gpu: {
                ...this.gpuMetadata,
                features: [ ...this.gpuMetadata.features ]
            },
            observations: this.observations.map((observation: ColorRampObservation) => ({
                linearRGB: [ ...observation.linearRGB ],
                timestampMicroseconds: observation.timestampMicroseconds
            })),
            readbackFailure: readbackFailure ? { ...readbackFailure } : null,
            validation
        };
    }
}
