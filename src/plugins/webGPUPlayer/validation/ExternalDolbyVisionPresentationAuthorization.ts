import {
    createHDRToSDRRenderSettings,
    RENDER_SETTINGS_VERSION,
    type HDRToSDRRenderSettings
} from '../RenderSettings';
import { createPQColorMetadata } from '../color/ColorMetadata';
import {
    processEncodedRGB,
    type ColorTriplet
} from '../color/ColorPipeline';
import {
    createExternalDolbyVisionColorPipelineWGSL,
    createExternalDolbyVisionInputProbeWGSL
} from '../color/ColorPipelineShader';
import { reconstructDolbyVisionBT2020PQ } from '../color/DolbyVisionColorTransform';
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from '../custom/DolbyVisionRPUParser';
import type {
    RawVideoPlaneDescriptor,
    TransferableRawVideoFrame
} from '../custom/RawVideoFrameCopy';
import {
    createRawYUVRenderSettingsUniformBuffer,
    writeRawYUVRenderSettingsUniform
} from '../RawYUVGPURenderer';
import { createDolbyVisionAuthorizationRPUFixture } from './DolbyVisionAuthorizationFixture';
import GPUAuthorizationDeadline from './GPUAuthorizationDeadline';
import {
    GPUCanvasPixelReader,
    getValidationTextureUsage,
    type GPUCanvasPixelsReadbackResult
} from './GPUCanvasReadback';
import {
    calculateRawHDRAuthorizationOutputDither,
    createRawHDRAuthorizationFixture,
    evaluateRawHDRFixtureObservations,
    RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES,
    type RawHDRFixtureObservation
} from './RawHDRPresentationAuthorization';

export const EXTERNAL_DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION = 2;
export const EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY =
    'external-I420P10-bt709-limited:dovi-p5-rpu-v1';

const FLOATS_PER_PRESENTATION_UNIFORM = 4;
const MAXIMUM_10_BIT_CODE = 1_023;
const EXTERNAL_AUTHORIZATION_TOLERANCE = 8 / 255;
const EXTERNAL_INPUT_PROBE_TARGET_FORMAT: GPUTextureFormat = 'rgba16float';
const EXTERNAL_INPUT_SIGNAL_TOLERANCE = 8 / MAXIMUM_10_BIT_CODE;
const VERTEX_COUNT = 6;
const AUTHORIZED_TARGET_FORMATS = new Set<GPUTextureFormat>([
    'bgra8unorm',
    'rgba8unorm'
]);

type ExtendedVideoFrameBufferInit = Omit<VideoFrameBufferInit, 'format'> & {
    format: 'I420P10'
};

type CachedProbe = {
    decision: ExternalDolbyVisionAuthorizationDecision | null
    promise: Promise<ExternalDolbyVisionAuthorizationDecision>
};

type DeviceProbeCache = {
    probes: Map<string, CachedProbe>
};

type AuthorizationPhase =
    | 'frame-create'
    | 'frame-import'
    | 'gpu-render';

export type ExternalDolbyVisionAuthorizationFailureReason =
    | 'device-lost'
    | 'frame-import-failed'
    | 'gpu-api-unavailable'
    | 'gpu-validation-failed'
    | 'input-mismatch'
    | 'pixel-mismatch'
    | 'readback-failed'
    | 'target-format-unsupported'
    | 'timeout'
    | 'unexpected-error'
    | 'video-frame-creation-failed';

export type ExternalDolbyVisionAuthorizationDecision = {
    device: GPUDevice
    failureReason: ExternalDolbyVisionAuthorizationFailureReason | null
    fixtureVersion: typeof EXTERNAL_DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION
    maximumChannelError: number | null
    maximumInputChannelError: number | null
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    routeKey: typeof EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY
    sampleCount: number
    shaderSignature: string
    status: 'authorized' | 'rejected'
    targetFormat: GPUTextureFormat
};

export type ExternalDolbyVisionAuthorizationTelemetry = {
    failureReason: ExternalDolbyVisionAuthorizationFailureReason | null
    fixtureVersion: typeof EXTERNAL_DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION
    maximumChannelError: number | null
    maximumInputChannelError: number | null
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    routeKey: typeof EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY
    sampleCount: number
    status: 'authorized' | 'pending' | 'rejected' | 'unavailable'
    targetFormat: GPUTextureFormat | null
};

export type ExternalDolbyVisionAuthorizationFrameFactory = () => VideoFrame;

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function createSettings(): HDRToSDRRenderSettings {
    return createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits: 4_000 }
    });
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function getPlane(
    frame: TransferableRawVideoFrame,
    kind: RawVideoPlaneDescriptor['kind']
): RawVideoPlaneDescriptor {
    const plane = frame.planes.find(candidate => candidate.kind === kind);
    if (!plane) {
        throw new Error(`External authorization fixture has no ${kind} plane`);
    }
    return plane;
}

function readPlaneCode(
    frame: TransferableRawVideoFrame,
    plane: RawVideoPlaneDescriptor,
    x: number,
    y: number
): number {
    return new DataView(frame.data).getUint16(
        plane.byteOffset
            + (y * plane.bytesPerRow)
            + (x * Uint16Array.BYTES_PER_ELEMENT),
        true
    );
}

function sampleExternalI420P10Fixture(
    frame: TransferableRawVideoFrame,
    sampleX: number,
    sampleY: number
): ColorTriplet {
    const chromaX = Math.floor(sampleX / 2);
    const chromaY = Math.floor(sampleY / 2);
    return [
        readPlaneCode(frame, getPlane(frame, 'y'), sampleX, sampleY),
        readPlaneCode(frame, getPlane(frame, 'u'), chromaX, chromaY),
        readPlaneCode(frame, getPlane(frame, 'v'), chromaX, chromaY)
    ];
}

/** Returns the ideal normalized base signal at each bounded fixture coordinate. */
export function createExpectedExternalDolbyVisionInputObservations():
readonly RawHDRFixtureObservation[] {
    const frame = createRawHDRAuthorizationFixture(
        'I420P10:bt2020-ncl:bt2020:limited:pq'
    );
    return RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES.map(sample => {
        const rawSignal = sampleExternalI420P10Fixture(
            frame,
            sample.sampleX,
            sample.sampleY
        );
        const normalizedSignal: ColorTriplet = [
            rawSignal[0] / MAXIMUM_10_BIT_CODE,
            rawSignal[1] / MAXIMUM_10_BIT_CODE,
            rawSignal[2] / MAXIMUM_10_BIT_CODE
        ];
        return {
            linearRGB: normalizedSignal,
            sampleX: sample.sampleX,
            sampleY: sample.sampleY
        };
    });
}

/** Computes output references from the base signal recovered by the browser bridge. */
export function createExpectedExternalDolbyVisionAuthorizationObservationsFromInput(
    recoveredInput: readonly ColorTriplet[],
    packedRPUData: ArrayBuffer,
    settings: HDRToSDRRenderSettings
): readonly RawHDRFixtureObservation[] {
    if (recoveredInput.length !== RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES.length) {
        throw new RangeError('Recovered external Dolby Vision input sample count is invalid');
    }
    const outputMetadata = createPQColorMetadata({ range: 'full' });
    return RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES.map((sample, sampleIndex) => {
        const encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(
            recoveredInput[sampleIndex],
            packedRPUData
        );
        const referenceRGB = processEncodedRGB(
            encodedBT2020PQ,
            outputMetadata,
            settings
        );
        const dither = calculateRawHDRAuthorizationOutputDither(
            sample.sampleX,
            sample.sampleY
        );
        return {
            linearRGB: [
                clamp(referenceRGB[0] + dither, 0, 1),
                clamp(referenceRGB[1] + dither, 0, 1),
                clamp(referenceRGB[2] + dither, 0, 1)
            ],
            sampleX: sample.sampleX,
            sampleY: sample.sampleY
        };
    });
}

/** Computes the ideal CPU reference before browser external-texture quantization. */
export function createExpectedExternalDolbyVisionAuthorizationObservations(
    packedRPUData: ArrayBuffer,
    settings: HDRToSDRRenderSettings
): readonly RawHDRFixtureObservation[] {
    const idealInput = createExpectedExternalDolbyVisionInputObservations().map(
        (observation: RawHDRFixtureObservation): ColorTriplet => observation.linearRGB
    );
    return createExpectedExternalDolbyVisionAuthorizationObservationsFromInput(
        idealInput,
        packedRPUData,
        settings
    );
}

/** Creates a stable identity for the exact external-texture production route. */
export function createExternalDolbyVisionShaderSignature(
    targetFormat: GPUTextureFormat,
    shaderCode: string,
    inputProbeShaderCode = createExternalDolbyVisionInputProbeWGSL()
): string {
    const signatureInput = [
        `fixture=${EXTERNAL_DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION}`,
        `uniform=${RENDER_SETTINGS_VERSION}`,
        `schema=${DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH}`,
        'frame=I420P10:bt709:bt709:bt709:limited',
        `input-format=${EXTERNAL_INPUT_PROBE_TARGET_FORMAT}`,
        `input-tolerance=${EXTERNAL_INPUT_SIGNAL_TOLERANCE}`,
        `tolerance=${EXTERNAL_AUTHORIZATION_TOLERANCE}`,
        `target=${targetFormat}`,
        shaderCode,
        inputProbeShaderCode
    ].join('\u0000');
    let hash = 0x811C_9DC5;
    for (let characterIndex = 0; characterIndex < signatureInput.length; characterIndex += 1) {
        hash ^= signatureInput.charCodeAt(characterIndex);
        hash = Math.imul(hash, 0x0100_0193) >>> 0;
    }
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
}

/** Builds the exact software-backed 10-bit BT.709 frame imported by the probe. */
export function createExternalDolbyVisionAuthorizationFrame(): VideoFrame {
    if (typeof VideoFrame === 'undefined') {
        throw new Error('video-frame-api-unavailable');
    }
    const sourceFrame = createRawHDRAuthorizationFixture(
        'I420P10:bt2020-ncl:bt2020:limited:pq'
    );
    const frameInit: ExtendedVideoFrameBufferInit = {
        codedHeight: sourceFrame.codedHeight,
        codedWidth: sourceFrame.codedWidth,
        colorSpace: {
            fullRange: false,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'bt709'
        },
        displayHeight: sourceFrame.displayHeight,
        displayWidth: sourceFrame.displayWidth,
        format: 'I420P10',
        layout: sourceFrame.planes.map(plane => ({
            offset: plane.byteOffset,
            stride: plane.bytesPerRow
        })),
        timestamp: 0,
        visibleRect: { ...sourceFrame.visibleRectangle }
    };
    // eslint-disable-next-line compat/compat -- Authorization is capability-gated
    return new VideoFrame(
        sourceFrame.data,
        frameInit as unknown as VideoFrameBufferInit
    );
}

function classifyFailure(
    error: unknown,
    phase: AuthorizationPhase
): ExternalDolbyVisionAuthorizationFailureReason {
    switch (getErrorMessage(error)) {
        case 'device-lost':
            return 'device-lost';
        case 'timeout':
            return 'timeout';
        case 'video-frame-api-unavailable':
            return 'gpu-api-unavailable';
        default:
            break;
    }
    switch (phase) {
        case 'frame-create':
            return 'video-frame-creation-failed';
        case 'frame-import':
            return 'frame-import-failed';
        case 'gpu-render':
            return 'unexpected-error';
    }
}

function createRejectedDecision(
    device: GPUDevice,
    targetFormat: GPUTextureFormat,
    shaderSignature: string,
    failureReason: ExternalDolbyVisionAuthorizationFailureReason,
    sampleCount = 0,
    maximumChannelError: number | null = null,
    maximumInputChannelError: number | null = null
): ExternalDolbyVisionAuthorizationDecision {
    return {
        device,
        failureReason,
        fixtureVersion: EXTERNAL_DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION,
        maximumChannelError,
        maximumInputChannelError,
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        routeKey: EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
        sampleCount,
        shaderSignature,
        status: 'rejected',
        targetFormat
    };
}

function createAuthorizationShaderSignature(
    targetFormat: GPUTextureFormat,
    settings: HDRToSDRRenderSettings
): string {
    return createExternalDolbyVisionShaderSignature(
        targetFormat,
        createExternalDolbyVisionColorPipelineWGSL(settings),
        createExternalDolbyVisionInputProbeWGSL()
    );
}

function discardErrorScope(device: GPUDevice): void {
    // popErrorScope can throw synchronously after device loss
    // eslint-disable-next-line sonarjs/no-try-promise
    try {
        void device.popErrorScope().catch((): void => undefined);
    } catch {
        // Device loss can synchronously invalidate the scope stack
    }
}

function createRenderPipeline(
    device: GPUDevice,
    targetFormat: GPUTextureFormat,
    shaderCode: string
): Promise<GPURenderPipeline> {
    const shaderModule = device.createShaderModule({ code: shaderCode });
    return device.createRenderPipelineAsync({
        fragment: {
            entryPoint: 'fragmentMain',
            module: shaderModule,
            targets: [{ format: targetFormat }]
        },
        layout: 'auto',
        primitive: { topology: 'triangle-list' },
        vertex: {
            entryPoint: 'vertexMain',
            module: shaderModule
        }
    });
}

/** Runs the exact external texture, Profile 5 shader, binding, and draw path. */
export class ExternalDolbyVisionPresentationAuthorizationRunner {
    private readonly createFrame: ExternalDolbyVisionAuthorizationFrameFactory;

    public constructor(
        createFrame: ExternalDolbyVisionAuthorizationFrameFactory =
        createExternalDolbyVisionAuthorizationFrame
    ) {
        this.createFrame = createFrame;
    }

    public async validate(
        device: GPUDevice,
        targetFormat: GPUTextureFormat
    ): Promise<ExternalDolbyVisionAuthorizationDecision> {
        const settings = createSettings();
        const shaderCode = createExternalDolbyVisionColorPipelineWGSL(settings);
        const inputProbeShaderCode = createExternalDolbyVisionInputProbeWGSL();
        const shaderSignature = createExternalDolbyVisionShaderSignature(
            targetFormat,
            shaderCode,
            inputProbeShaderCode
        );
        if (!AUTHORIZED_TARGET_FORMATS.has(targetFormat)) {
            return createRejectedDecision(
                device,
                targetFormat,
                shaderSignature,
                'target-format-unsupported'
            );
        }
        const targetUsage = getValidationTextureUsage();
        if (
            targetUsage === null
            || typeof GPUBufferUsage === 'undefined'
            || typeof GPUTextureUsage === 'undefined'
        ) {
            return createRejectedDecision(
                device,
                targetFormat,
                shaderSignature,
                'gpu-api-unavailable'
            );
        }

        let targetTexture: GPUTexture | null = null;
        let inputProbeTexture: GPUTexture | null = null;
        let presentationUniformBuffer: GPUBuffer | null = null;
        let renderSettingsUniformBuffer: GPUBuffer | null = null;
        let RPUStorageBuffer: GPUBuffer | null = null;
        let pixelReader: GPUCanvasPixelReader | null = null;
        let inputPixelReader: GPUCanvasPixelReader | null = null;
        let frame: VideoFrame | null = null;
        let errorScopePushed = false;
        let phase: AuthorizationPhase = 'gpu-render';
        const deadline = new GPUAuthorizationDeadline(device);
        try {
            const pipelines = await deadline.wait(
                Promise.all([
                    createRenderPipeline(device, targetFormat, shaderCode),
                    createRenderPipeline(
                        device,
                        EXTERNAL_INPUT_PROBE_TARGET_FORMAT,
                        inputProbeShaderCode
                    )
                ])
            );
            const pipeline: GPURenderPipeline = pipelines[0];
            const inputProbePipeline: GPURenderPipeline = pipelines[1];
            const sampler = device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear'
            });
            presentationUniformBuffer = device.createBuffer({
                label: 'WebGPU external Dolby Vision authorization presentation uniforms',
                size: FLOATS_PER_PRESENTATION_UNIFORM * Float32Array.BYTES_PER_ELEMENT,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.UNIFORM
            });
            device.queue.writeBuffer(
                presentationUniformBuffer,
                0,
                new Float32Array([ 1, 1, 0, 0 ])
            );
            renderSettingsUniformBuffer = createRawYUVRenderSettingsUniformBuffer(device);
            writeRawYUVRenderSettingsUniform(device, renderSettingsUniformBuffer, settings);
            const packedRPUData = createDolbyVisionAuthorizationRPUFixture(5);
            RPUStorageBuffer = device.createBuffer({
                label: 'WebGPU external Dolby Vision authorization RPU',
                size: packedRPUData.byteLength,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
            });
            device.queue.writeBuffer(RPUStorageBuffer, 0, packedRPUData);

            phase = 'frame-create';
            frame = this.createFrame();
            targetTexture = device.createTexture({
                dimension: '2d',
                format: targetFormat,
                label: 'WebGPU external Dolby Vision authorization target',
                size: {
                    depthOrArrayLayers: 1,
                    height: frame.displayHeight,
                    width: frame.displayWidth
                },
                usage: targetUsage
            });
            inputProbeTexture = device.createTexture({
                dimension: '2d',
                format: EXTERNAL_INPUT_PROBE_TARGET_FORMAT,
                label: 'WebGPU external Dolby Vision authorization input probe',
                size: {
                    depthOrArrayLayers: 1,
                    height: frame.displayHeight,
                    width: frame.displayWidth
                },
                usage: targetUsage
            });

            device.pushErrorScope('validation');
            errorScopePushed = true;
            phase = 'frame-import';
            const externalTexture = device.importExternalTexture({
                colorSpace: 'srgb',
                source: frame
            });
            phase = 'gpu-render';
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
                }, {
                    binding: 3,
                    resource: { buffer: renderSettingsUniformBuffer }
                }, {
                    binding: 4,
                    resource: { buffer: RPUStorageBuffer }
                }],
                layout: pipeline.getBindGroupLayout(0)
            });
            const inputProbeBindGroup = device.createBindGroup({
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
                layout: inputProbePipeline.getBindGroupLayout(0)
            });
            const commandEncoder = device.createCommandEncoder({
                label: 'WebGPU external Dolby Vision authorization commands'
            });
            const inputProbeRenderPass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    clearValue: { a: 1, b: 0, g: 0, r: 0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                    view: inputProbeTexture.createView()
                }],
                label: 'WebGPU external Dolby Vision authorization input probe pass'
            });
            inputProbeRenderPass.setPipeline(inputProbePipeline);
            inputProbeRenderPass.setBindGroup(0, inputProbeBindGroup);
            inputProbeRenderPass.setViewport(
                0,
                0,
                frame.displayWidth,
                frame.displayHeight,
                0,
                1
            );
            inputProbeRenderPass.draw(VERTEX_COUNT);
            inputProbeRenderPass.end();
            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    clearValue: { a: 1, b: 0, g: 0, r: 0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                    view: targetTexture.createView()
                }],
                label: 'WebGPU external Dolby Vision authorization pass'
            });
            renderPass.setPipeline(pipeline);
            renderPass.setBindGroup(0, bindGroup);
            renderPass.setViewport(
                0,
                0,
                frame.displayWidth,
                frame.displayHeight,
                0,
                1
            );
            renderPass.draw(VERTEX_COUNT);
            renderPass.end();
            device.queue.submit([ commandEncoder.finish() ]);
            await deadline.wait(device.queue.onSubmittedWorkDone());
            const validationPromise = device.popErrorScope();
            errorScopePushed = false;
            const validationError = await deadline.wait(validationPromise);
            if (validationError) {
                return createRejectedDecision(
                    device,
                    targetFormat,
                    shaderSignature,
                    'gpu-validation-failed'
                );
            }

            inputPixelReader = new GPUCanvasPixelReader({
                device,
                format: EXTERNAL_INPUT_PROBE_TARGET_FORMAT,
                maximumReadbacks: RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES.length
            });
            const inputReadback: GPUCanvasPixelsReadbackResult = await deadline.wait(
                inputPixelReader.readPixels(
                    RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES,
                    inputProbeTexture
                ),
                (): void => inputPixelReader?.destroy()
            );
            if (inputReadback.failure || !inputReadback.linearRGB) {
                return createRejectedDecision(
                    device,
                    targetFormat,
                    shaderSignature,
                    'readback-failed'
                );
            }
            const recoveredInputObservations: RawHDRFixtureObservation[] = [];
            for (let sampleIndex = 0;
                sampleIndex < RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES.length;
                sampleIndex += 1) {
                const sample = RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES[sampleIndex];
                recoveredInputObservations.push({
                    linearRGB: inputReadback.linearRGB[sampleIndex],
                    sampleX: sample.sampleX,
                    sampleY: sample.sampleY
                });
            }
            const expectedInputObservations =
                createExpectedExternalDolbyVisionInputObservations();
            const inputComparison = evaluateRawHDRFixtureObservations(
                expectedInputObservations,
                recoveredInputObservations,
                EXTERNAL_INPUT_SIGNAL_TOLERANCE
            );
            if (!inputComparison.accepted) {
                return createRejectedDecision(
                    device,
                    targetFormat,
                    shaderSignature,
                    'input-mismatch',
                    recoveredInputObservations.length,
                    null,
                    inputComparison.maximumChannelError
                );
            }

            pixelReader = new GPUCanvasPixelReader({
                device,
                format: targetFormat,
                maximumReadbacks: RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES.length
            });
            const readback = await deadline.wait(
                pixelReader.readPixels(RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES, targetTexture),
                (): void => pixelReader?.destroy()
            );
            if (readback.failure || !readback.linearRGB) {
                return createRejectedDecision(
                    device,
                    targetFormat,
                    shaderSignature,
                    'readback-failed'
                );
            }
            const actualObservations: RawHDRFixtureObservation[] = [];
            for (let sampleIndex = 0;
                sampleIndex < RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES.length;
                sampleIndex += 1) {
                const sample = RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES[sampleIndex];
                actualObservations.push({
                    linearRGB: readback.linearRGB[sampleIndex],
                    sampleX: sample.sampleX,
                    sampleY: sample.sampleY
                });
            }
            const expectedObservations =
                createExpectedExternalDolbyVisionAuthorizationObservationsFromInput(
                    inputReadback.linearRGB,
                    packedRPUData,
                    settings
                );
            const comparison = evaluateRawHDRFixtureObservations(
                expectedObservations,
                actualObservations,
                EXTERNAL_AUTHORIZATION_TOLERANCE
            );
            if (!comparison.accepted) {
                return createRejectedDecision(
                    device,
                    targetFormat,
                    shaderSignature,
                    'pixel-mismatch',
                    actualObservations.length,
                    comparison.maximumChannelError,
                    inputComparison.maximumChannelError
                );
            }
            return {
                device,
                failureReason: null,
                fixtureVersion: EXTERNAL_DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION,
                maximumChannelError: comparison.maximumChannelError,
                maximumInputChannelError: inputComparison.maximumChannelError,
                renderSettingsVersion: RENDER_SETTINGS_VERSION,
                routeKey: EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
                sampleCount: actualObservations.length,
                shaderSignature,
                status: 'authorized',
                targetFormat
            };
        } catch (error) {
            return createRejectedDecision(
                device,
                targetFormat,
                shaderSignature,
                classifyFailure(error, phase)
            );
        } finally {
            deadline.destroy();
            if (errorScopePushed) {
                discardErrorScope(device);
            }
            frame?.close();
            inputPixelReader?.destroy();
            pixelReader?.destroy();
            presentationUniformBuffer?.destroy();
            renderSettingsUniformBuffer?.destroy();
            RPUStorageBuffer?.destroy();
            inputProbeTexture?.destroy();
            targetTexture?.destroy();
        }
    }
}

/** Device-scoped cache for exact external Profile 5 presentation evidence. */
export class ExternalDolbyVisionPresentationAuthorizationRegistry {
    private readonly devices = new WeakMap<GPUDevice, DeviceProbeCache>();
    private readonly runner: ExternalDolbyVisionPresentationAuthorizationRunner;

    public constructor(
        runner = new ExternalDolbyVisionPresentationAuthorizationRunner()
    ) {
        this.runner = runner;
    }

    /** Starts the exact-device probe without delaying ordinary playback. */
    public prewarm(device: GPUDevice, targetFormat: GPUTextureFormat): void {
        void this.authorize(device, targetFormat);
    }

    /** Waits only a probe that has already been started. */
    public async waitForPending(
        device: GPUDevice,
        targetFormat: GPUTextureFormat
    ): Promise<void> {
        const probe = this.getCachedProbe(device, targetFormat);
        if (probe && !probe.decision) {
            await probe.promise;
        }
    }

    /** Returns a deduplicated decision for one exact device, target, and shader. */
    public authorize(
        device: GPUDevice,
        targetFormat: GPUTextureFormat
    ): Promise<ExternalDolbyVisionAuthorizationDecision> {
        const cacheKey = this.createCacheKey(targetFormat);
        const deviceCache = this.getDeviceCache(device);
        const cachedProbe = deviceCache.probes.get(cacheKey);
        if (cachedProbe) {
            return cachedProbe.promise;
        }

        const probe = { decision: null } as CachedProbe;
        probe.promise = Promise.resolve().then(() => (
            this.runner.validate(device, targetFormat)
        )).then(
            (
                decision: ExternalDolbyVisionAuthorizationDecision
            ): ExternalDolbyVisionAuthorizationDecision => {
                probe.decision = decision;
                return decision;
            },
            (): ExternalDolbyVisionAuthorizationDecision => {
                const decision = createRejectedDecision(
                    device,
                    targetFormat,
                    createAuthorizationShaderSignature(targetFormat, createSettings()),
                    'unexpected-error'
                );
                probe.decision = decision;
                return decision;
            }
        );
        deviceCache.probes.set(cacheKey, probe);
        return probe.promise;
    }

    /** Checks only settled authorization and never waits optimistically. */
    public isAuthorized(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        settings: HDRToSDRRenderSettings
    ): boolean {
        const shaderSignature = createAuthorizationShaderSignature(targetFormat, settings);
        const decision = this.getCachedProbe(device, targetFormat)?.decision;
        return decision?.status === 'authorized'
            && decision.device === device
            && decision.targetFormat === targetFormat
            && decision.shaderSignature === shaderSignature;
    }

    /** Returns bounded diagnostics without exposing retained GPU objects. */
    public getTelemetry(
        device: GPUDevice | null,
        targetFormat: GPUTextureFormat | null
    ): ExternalDolbyVisionAuthorizationTelemetry {
        const unavailable: ExternalDolbyVisionAuthorizationTelemetry = {
            failureReason: null,
            fixtureVersion: EXTERNAL_DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION,
            maximumChannelError: null,
            maximumInputChannelError: null,
            renderSettingsVersion: RENDER_SETTINGS_VERSION,
            routeKey: EXTERNAL_DOLBY_VISION_AUTHORIZATION_ROUTE_KEY,
            sampleCount: 0,
            status: 'unavailable',
            targetFormat
        };
        if (!device || !targetFormat) {
            return unavailable;
        }
        const probe = this.getCachedProbe(device, targetFormat);
        if (!probe) {
            return unavailable;
        }
        if (!probe.decision) {
            return { ...unavailable, status: 'pending' };
        }
        return {
            failureReason: probe.decision.failureReason,
            fixtureVersion: probe.decision.fixtureVersion,
            maximumChannelError: probe.decision.maximumChannelError,
            maximumInputChannelError: probe.decision.maximumInputChannelError,
            renderSettingsVersion: probe.decision.renderSettingsVersion,
            routeKey: probe.decision.routeKey,
            sampleCount: probe.decision.sampleCount,
            status: probe.decision.status,
            targetFormat: probe.decision.targetFormat
        };
    }

    private createCacheKey(targetFormat: GPUTextureFormat): string {
        return `${targetFormat}\u0000${createAuthorizationShaderSignature(
            targetFormat,
            createSettings()
        )}`;
    }

    private getCachedProbe(
        device: GPUDevice,
        targetFormat: GPUTextureFormat
    ): CachedProbe | undefined {
        return this.devices.get(device)?.probes.get(this.createCacheKey(targetFormat));
    }

    private getDeviceCache(device: GPUDevice): DeviceProbeCache {
        const cached = this.devices.get(device);
        if (cached) {
            return cached;
        }
        const created: DeviceProbeCache = { probes: new Map() };
        this.devices.set(device, created);
        return created;
    }
}
