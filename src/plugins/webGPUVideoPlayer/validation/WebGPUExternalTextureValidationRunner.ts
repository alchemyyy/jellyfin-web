import {
    assertValidInputColorMetadata,
    type InputColorMetadata
} from '../color/ColorMetadata';
import {
    type ColorRampSample,
    type ColorValidationRamp,
    type ColorValidationRampOptions
} from '../color/ColorValidation';
import { type ColorTriplet } from '../color/ColorPipeline';
import { type Microseconds } from '../MediaTime';
import {
    GPUCanvasColorValidationHarness,
    type BrowserColorMetadata,
    type ColorValidationCapabilityDecision,
    type ColorValidationHarnessOptions,
    type ReferenceFrameMetadataInput,
    type VideoFrameColorSpaceMetadata
} from './ColorValidationHarness';
import { getValidationCanvasUsage } from './GPUCanvasReadback';
import {
    RuntimeColorValidationRegistry,
    type RuntimeColorValidationCaptureInput,
    type RuntimeColorValidationHarness,
    type RuntimeColorValidationSampleContext
} from './RuntimeColorValidationRegistry';

export type ExternalTextureReferenceFrameRequest = {
    encodedInputRGB: ColorTriplet
    generation: number
    inputColorMetadata: InputColorMetadata
    sampleIndex: number
    timestampMicroseconds: Microseconds
};

export type ExternalTextureReferenceFrameProvider = (
    frameRequest: Readonly<ExternalTextureReferenceFrameRequest>
) => Promise<VideoFrame>;

export type WebGPUExternalTextureValidationRequest = {
    adapterInfo?: Pick<GPUAdapterInfo, 'architecture' | 'description' | 'device' | 'vendor'>
    browserMetadata?: BrowserColorMetadata
    device: GPUDevice
    getFrame: ExternalTextureReferenceFrameProvider
    metadata: InputColorMetadata
    rampOptions?: ColorValidationRampOptions
};

export type WebGPUExternalTextureValidationRunnerOptions = {
    createCanvas?: () => HTMLCanvasElement
    createHarness?: (options: ColorValidationHarnessOptions) => RuntimeColorValidationHarness
    isEnabled?: () => Promise<boolean>
};

type ValidationResourcesOptions = {
    adapterInfo?: WebGPUExternalTextureValidationRequest['adapterInfo']
    browserMetadata?: BrowserColorMetadata
    canvas: HTMLCanvasElement
    createHarness: NonNullable<WebGPUExternalTextureValidationRunnerOptions['createHarness']>
    device: GPUDevice
    ramp: ColorValidationRamp
    usedFrames: WeakSet<VideoFrame>
};

const VALIDATION_CANVAS_FORMAT: GPUTextureFormat = 'rgba16float';
const VALIDATION_CANVAS_SIZE = 1;
const VALIDATION_VERTEX_COUNT = 6;

function toWGSLFloat(value: number): string {
    if (!Number.isFinite(value)) {
        throw new RangeError('WGSL constants must be finite');
    }

    return value.toFixed(9);
}

function createTransferDecodeWGSL(metadata: InputColorMetadata): string {
    switch (metadata.transfer) {
        case 'pq':
            return `
fn applyReferenceEOTF(encodedValue: f32) -> f32 {
    let inversePower = pow(clamp(encodedValue, 0.0, 1.0), 1.0 / (2523.0 / 32.0));
    let numerator = max(inversePower - (3424.0 / 4096.0), 0.0);
    let denominator = max((2413.0 / 128.0) - (2392.0 / 128.0) * inversePower, 0.0000001);
    return 10000.0 * pow(numerator / denominator, 1.0 / (2610.0 / 16384.0));
}

fn decodeReferenceRGB(encodedRGB: vec3f) -> vec3f {
    return vec3f(
        applyReferenceEOTF(encodedRGB.r),
        applyReferenceEOTF(encodedRGB.g),
        applyReferenceEOTF(encodedRGB.b)
    );
}`;
        case 'sdr':
            return `
fn applyReferenceEOTF(encodedValue: f32) -> f32 {
    if (encodedValue < 0.081) {
        return (encodedValue / 4.5) * ${toWGSLFloat(metadata.sdrReferenceWhiteNits)};
    }
    return pow((encodedValue + 0.099) / 1.099, 1.0 / 0.45)
        * ${toWGSLFloat(metadata.sdrReferenceWhiteNits)};
}

fn decodeReferenceRGB(encodedRGB: vec3f) -> vec3f {
    return vec3f(
        applyReferenceEOTF(encodedRGB.r),
        applyReferenceEOTF(encodedRGB.g),
        applyReferenceEOTF(encodedRGB.b)
    );
}`;
        case 'hlg': {
            const redCoefficient = metadata.primaries === 'bt709' ? 0.2126 : 0.2627;
            const greenCoefficient = metadata.primaries === 'bt709' ? 0.7152 : 0.6780;
            const blueCoefficient = metadata.primaries === 'bt709' ? 0.0722 : 0.0593;
            const systemGamma = 1.2
                + (0.42 * Math.log10(metadata.nominalPeakNits / 1_000));
            return `
fn applyReferenceInverseOETF(encodedValue: f32) -> f32 {
    let clampedValue = clamp(encodedValue, 0.0, 1.0);
    if (clampedValue <= 0.5) {
        return clampedValue * clampedValue / 3.0;
    }
    let hlgA = 0.178832770;
    let hlgB = 1.0 - 4.0 * hlgA;
    let hlgC = 0.5 - hlgA * log(4.0 * hlgA);
    return (exp((clampedValue - hlgC) / hlgA) + hlgB) / 12.0;
}

fn decodeReferenceRGB(encodedRGB: vec3f) -> vec3f {
    let sceneRGB = vec3f(
        applyReferenceInverseOETF(encodedRGB.r),
        applyReferenceInverseOETF(encodedRGB.g),
        applyReferenceInverseOETF(encodedRGB.b)
    );
    let sceneLuminance = max(dot(
        sceneRGB,
        vec3f(
            ${toWGSLFloat(redCoefficient)},
            ${toWGSLFloat(greenCoefficient)},
            ${toWGSLFloat(blueCoefficient)}
        )
    ), 0.0);
    if (sceneLuminance == 0.0) {
        return vec3f(0.0);
    }
    let luminanceScale = ${toWGSLFloat(metadata.nominalPeakNits)}
        * pow(sceneLuminance, ${toWGSLFloat(systemGamma - 1)});
    return sceneRGB * luminanceScale;
}`;
        }
    }
}

/** Builds the single-EOTF external-texture reference shader. */
export function createExternalTextureValidationWGSL(ramp: ColorValidationRamp): string {
    assertValidInputColorMetadata(ramp.metadata);
    if (!Number.isFinite(ramp.normalizationNits) || ramp.normalizationNits <= 0) {
        throw new RangeError('Validation normalization luminance must be positive and finite');
    }

    return /* wgsl */ `
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) textureCoordinate: vec2f,
}

@group(0) @binding(0) var videoSampler: sampler;
@group(0) @binding(1) var videoTexture: texture_external;

${createTransferDecodeWGSL(ramp.metadata)}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    let positions = array<vec2f, 6>(
        vec2f(-1.0, 1.0),
        vec2f(1.0, 1.0),
        vec2f(-1.0, -1.0),
        vec2f(-1.0, -1.0),
        vec2f(1.0, 1.0),
        vec2f(1.0, -1.0),
    );
    let textureCoordinates = array<vec2f, 6>(
        vec2f(0.0, 0.0),
        vec2f(1.0, 0.0),
        vec2f(0.0, 1.0),
        vec2f(0.0, 1.0),
        vec2f(1.0, 0.0),
        vec2f(1.0, 1.0),
    );

    var output: VertexOutput;
    output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
    output.textureCoordinate = textureCoordinates[vertexIndex];
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    let encodedRGB = textureSampleBaseClampToEdge(
        videoTexture,
        videoSampler,
        input.textureCoordinate
    ).rgb;
    let normalizedLinearRGB = decodeReferenceRGB(encodedRGB)
        / ${toWGSLFloat(ramp.normalizationNits)};
    return vec4f(normalizedLinearRGB, 1.0);
}
`;
}

function createDefaultCanvas(): HTMLCanvasElement {
    if (typeof document === 'undefined') {
        throw new Error('A browser document is required for color validation');
    }

    return document.createElement('canvas');
}

function createDefaultHarness(
    options: ColorValidationHarnessOptions
): RuntimeColorValidationHarness {
    return new GPUCanvasColorValidationHarness(options);
}

function snapshotInputMetadata(metadata: InputColorMetadata): InputColorMetadata {
    return {
        bitDepth: metadata.bitDepth,
        matrix: metadata.matrix,
        nominalPeakNits: metadata.nominalPeakNits,
        primaries: metadata.primaries,
        range: metadata.range,
        sdrReferenceWhiteNits: metadata.sdrReferenceWhiteNits,
        transfer: metadata.transfer,
        version: metadata.version
    };
}

function getExpectedFrameTransfer(metadata: InputColorMetadata): string {
    switch (metadata.transfer) {
        case 'hlg':
            return 'hlg';
        case 'pq':
            return 'pq';
        case 'sdr':
            return 'bt709';
    }
}

function getFrameColorSpace(frame: VideoFrame): VideoFrameColorSpaceMetadata {
    return {
        fullRange: frame.colorSpace.fullRange,
        matrix: frame.colorSpace.matrix,
        primaries: frame.colorSpace.primaries,
        transfer: frame.colorSpace.transfer
    };
}

function assertValidReferenceFrame(
    frame: VideoFrame,
    sample: Readonly<ColorRampSample>,
    metadata: InputColorMetadata,
    usedFrames: WeakSet<VideoFrame>
): void {
    if (!frame || typeof frame !== 'object' || typeof frame.close !== 'function') {
        throw new TypeError('The reference frame provider must return a VideoFrame');
    }
    if (usedFrames.has(frame)) {
        throw new Error('Each validation sample requires a fresh VideoFrame');
    }
    usedFrames.add(frame);

    if (
        !Number.isSafeInteger(frame.timestamp)
        || frame.timestamp !== sample.timestampMicroseconds
    ) {
        throw new RangeError('Reference VideoFrame timestamps must exactly match microsecond samples');
    }
    if (
        !Number.isSafeInteger(frame.codedWidth)
        || frame.codedWidth <= 0
        || !Number.isSafeInteger(frame.codedHeight)
        || frame.codedHeight <= 0
        || !Number.isSafeInteger(frame.displayWidth)
        || frame.displayWidth <= 0
        || !Number.isSafeInteger(frame.displayHeight)
        || frame.displayHeight <= 0
    ) {
        throw new RangeError('Reference VideoFrame dimensions must be positive integers');
    }

    const colorSpace = getFrameColorSpace(frame);
    if (
        colorSpace.fullRange !== (metadata.range === 'full')
        || colorSpace.matrix !== metadata.matrix
        || colorSpace.primaries !== metadata.primaries
        || colorSpace.transfer !== getExpectedFrameTransfer(metadata)
    ) {
        throw new Error('Reference VideoFrame color metadata does not match the validation ramp');
    }
}

function createFrameMetadata(frame: VideoFrame): ReferenceFrameMetadataInput {
    return {
        codedHeight: frame.codedHeight,
        codedWidth: frame.codedWidth,
        displayHeight: frame.displayHeight,
        displayWidth: frame.displayWidth,
        videoColorSpace: getFrameColorSpace(frame)
    };
}

function safelyUnconfigure(context: GPUCanvasContext): void {
    try {
        context.unconfigure();
    } catch {
        // Device loss can invalidate an already configured canvas
    }
}

function releaseCanvas(canvas: HTMLCanvasElement): void {
    canvas.height = 0;
    canvas.width = 0;
    canvas.remove();
}

class ExternalTextureValidationResources implements RuntimeColorValidationHarness {
    private readonly canvas: HTMLCanvasElement;
    private readonly context: GPUCanvasContext;
    private readonly device: GPUDevice;
    private readonly harness: RuntimeColorValidationHarness;
    private readonly ramp: ColorValidationRamp;
    private readonly sampler: GPUSampler;
    private readonly shaderModule: GPUShaderModule;
    private readonly usedFrames: WeakSet<VideoFrame>;
    private destroyed = false;
    private pipeline: Promise<GPURenderPipeline> | null = null;

    public constructor(options: ValidationResourcesOptions) {
        this.canvas = options.canvas;
        this.canvas.hidden = true;
        this.canvas.height = VALIDATION_CANVAS_SIZE;
        this.canvas.width = VALIDATION_CANVAS_SIZE;
        const usage = getValidationCanvasUsage();
        if (usage === null) {
            releaseCanvas(this.canvas);
            throw new Error('WebGPU validation canvas usage constants are unavailable');
        }

        let context: GPUCanvasContext | null;
        try {
            context = this.canvas.getContext('webgpu') as GPUCanvasContext | null;
        } catch (error) {
            releaseCanvas(this.canvas);
            throw error;
        }
        if (!context) {
            releaseCanvas(this.canvas);
            throw new Error('A WebGPU canvas context is unavailable');
        }
        this.context = context;
        this.device = options.device;
        this.ramp = options.ramp;
        this.usedFrames = options.usedFrames;

        try {
            this.context.configure({
                alphaMode: 'opaque',
                colorSpace: 'srgb',
                device: this.device,
                format: VALIDATION_CANVAS_FORMAT,
                toneMapping: { mode: 'extended' },
                usage
            });
            this.shaderModule = this.device.createShaderModule({
                code: createExternalTextureValidationWGSL(this.ramp),
                label: 'WebGPU external texture color validation shader'
            });
            this.sampler = this.device.createSampler({
                magFilter: 'nearest',
                minFilter: 'nearest'
            });
            this.harness = options.createHarness({
                adapterInfo: options.adapterInfo,
                browserMetadata: options.browserMetadata,
                canvas: this.canvas,
                canvasConfiguration: {
                    alphaMode: 'opaque',
                    colorSpace: 'srgb',
                    format: VALIDATION_CANVAS_FORMAT,
                    toneMapping: { mode: 'extended' }
                },
                configureCanvas: false,
                context: this.context,
                device: this.device,
                ramp: this.ramp
            });
        } catch (error) {
            safelyUnconfigure(this.context);
            releaseCanvas(this.canvas);
            throw error;
        }
    }

    public captureCurrentFrame(
        captureRequest: Parameters<RuntimeColorValidationHarness['captureCurrentFrame']>[0]
    ): ReturnType<RuntimeColorValidationHarness['captureCurrentFrame']> {
        return this.harness.captureCurrentFrame(captureRequest);
    }

    public evaluate(): ColorValidationCapabilityDecision {
        return this.harness.evaluate();
    }

    /** Renders and closes one exact reference VideoFrame before canvas readback. */
    public async renderSample(
        sample: Readonly<ColorRampSample>,
        sampleContext: RuntimeColorValidationSampleContext,
        getFrame: ExternalTextureReferenceFrameProvider
    ): Promise<RuntimeColorValidationCaptureInput> {
        const pipeline = await this.getPipeline();
        if (this.destroyed || !sampleContext.isCurrent()) {
            throw new Error('The color validation generation is stale');
        }

        let frame: VideoFrame | null = null;
        try {
            frame = await getFrame({
                encodedInputRGB: [ ...sample.encodedInputRGB ],
                generation: sampleContext.generation,
                inputColorMetadata: snapshotInputMetadata(this.ramp.metadata),
                sampleIndex: sampleContext.sampleIndex,
                timestampMicroseconds: sample.timestampMicroseconds
            });
            assertValidReferenceFrame(frame, sample, this.ramp.metadata, this.usedFrames);
            if (this.destroyed || !sampleContext.isCurrent()) {
                throw new Error('The color validation generation became stale');
            }

            const frameMetadata = createFrameMetadata(frame);
            const sourceTexture = await this.renderFrame(frame, pipeline);
            return { frame: frameMetadata, sourceTexture };
        } finally {
            frame?.close();
        }
    }

    public destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        try {
            this.harness.destroy();
        } finally {
            safelyUnconfigure(this.context);
            releaseCanvas(this.canvas);
        }
    }

    private async renderFrame(
        frame: VideoFrame,
        pipeline: GPURenderPipeline
    ): Promise<GPUTexture> {
        this.device.pushErrorScope('validation');
        let errorScopePending = true;
        try {
            const sourceTexture = this.context.getCurrentTexture();
            const externalTexture = this.device.importExternalTexture({
                colorSpace: 'srgb',
                source: frame
            });
            const bindGroup = this.device.createBindGroup({
                entries: [{
                    binding: 0,
                    resource: this.sampler
                }, {
                    binding: 1,
                    resource: externalTexture
                }],
                layout: pipeline.getBindGroupLayout(0)
            });
            const commandEncoder = this.device.createCommandEncoder({
                label: 'WebGPU external texture color validation commands'
            });
            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    clearValue: { a: 1, b: 0, g: 0, r: 0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                    view: sourceTexture.createView()
                }],
                label: 'WebGPU external texture color validation pass'
            });
            renderPass.setPipeline(pipeline);
            renderPass.setBindGroup(0, bindGroup);
            renderPass.draw(VALIDATION_VERTEX_COUNT);
            renderPass.end();
            this.device.queue.submit([ commandEncoder.finish() ]);
            await this.device.queue.onSubmittedWorkDone();
            const validationError = await this.device.popErrorScope();
            errorScopePending = false;
            if (validationError) {
                throw new Error(validationError.message);
            }
            if (this.destroyed) {
                throw new Error('The color validation resources were destroyed during rendering');
            }

            return sourceTexture;
        } finally {
            if (errorScopePending) {
                try {
                    await this.device.popErrorScope();
                } catch {
                    // Device loss can invalidate an outstanding error scope
                }
            }
        }
    }

    private getPipeline(): Promise<GPURenderPipeline> {
        if (this.pipeline) {
            return this.pipeline;
        }

        this.pipeline = this.device.createRenderPipelineAsync({
            fragment: {
                entryPoint: 'fragmentMain',
                module: this.shaderModule,
                targets: [{ format: VALIDATION_CANVAS_FORMAT }]
            },
            label: 'WebGPU external texture color validation pipeline',
            layout: 'auto',
            primitive: { topology: 'triangle-list' },
            vertex: {
                entryPoint: 'vertexMain',
                module: this.shaderModule
            }
        });
        return this.pipeline;
    }
}

/**
 * Validates decoded reference VideoFrames through the exact supplied GPUDevice
 * without retaining reference frames, URLs, credentials, or source callbacks.
 */
export class WebGPUExternalTextureValidationRunner {
    private readonly createCanvas: () => HTMLCanvasElement;
    private readonly createHarness: NonNullable<
        WebGPUExternalTextureValidationRunnerOptions['createHarness']
    >;
    private readonly registry: RuntimeColorValidationRegistry;
    private readonly usedFrames = new WeakSet<VideoFrame>();
    private destroyed = false;

    public constructor(options: WebGPUExternalTextureValidationRunnerOptions = {}) {
        this.createCanvas = options.createCanvas ?? createDefaultCanvas;
        this.createHarness = options.createHarness ?? createDefaultHarness;
        this.registry = new RuntimeColorValidationRegistry({
            isEnabled: options.isEnabled
        });
    }

    /** Runs the reference ramp or returns its exact GPU and metadata cache entry. */
    public validate(
        validationRequest: WebGPUExternalTextureValidationRequest
    ): Promise<ColorValidationCapabilityDecision | null> {
        if (this.destroyed) {
            return Promise.resolve(null);
        }

        let resources: ExternalTextureValidationResources | null = null;
        return this.registry.validate({
            createHarness: (ramp: ColorValidationRamp): RuntimeColorValidationHarness => {
                resources = new ExternalTextureValidationResources({
                    adapterInfo: validationRequest.adapterInfo,
                    browserMetadata: validationRequest.browserMetadata,
                    canvas: this.createCanvas(),
                    createHarness: this.createHarness,
                    device: validationRequest.device,
                    ramp,
                    usedFrames: this.usedFrames
                });
                return resources;
            },
            device: validationRequest.device,
            metadata: validationRequest.metadata,
            rampOptions: validationRequest.rampOptions,
            renderSample: (
                sample: Readonly<ColorRampSample>,
                sampleContext: RuntimeColorValidationSampleContext
            ): Promise<RuntimeColorValidationCaptureInput> => {
                if (!resources) {
                    return Promise.reject(new Error('Color validation resources are unavailable'));
                }
                return resources.renderSample(
                    sample,
                    sampleContext,
                    validationRequest.getFrame
                );
            }
        });
    }

    /** Returns a previously measured decision while the validation flag is enabled. */
    public getCachedDecision(
        device: GPUDevice,
        metadata: InputColorMetadata
    ): Promise<ColorValidationCapabilityDecision | null> {
        if (this.destroyed) {
            return Promise.resolve(null);
        }

        return this.registry.getCachedDecision(device, metadata);
    }

    /** Invalidates one metadata decision or every decision for a GPU device. */
    public invalidate(device: GPUDevice, metadata?: InputColorMetadata): void {
        this.registry.invalidate(device, metadata);
    }

    /** Invalidates every cached or in-flight external-texture validation. */
    public invalidateAll(): void {
        this.registry.invalidateAll();
    }

    /** Cancels in-flight work and permanently releases the runner registry. */
    public destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.registry.destroy();
    }
}
