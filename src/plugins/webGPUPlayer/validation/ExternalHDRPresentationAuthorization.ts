import {
    createHDRToSDRRenderSettings,
    RENDER_SETTINGS_VERSION,
    type HDRToSDRRenderSettings
} from '../RenderSettings';
import {
    createHLGColorMetadata,
    createPQColorMetadata,
    type InputColorMetadata
} from '../color/ColorMetadata';
import {
    processEncodedYUV,
    type ColorTriplet
} from '../color/ColorPipeline';
import { createExternalHDRColorPipelineWGSL } from '../color/ColorPipelineShader';
import { rewriteHEVCAccessUnitColorDescriptionToBT709 } from '../custom/DolbyVisionHEVCSplitter';
import {
    createRawYUVRenderSettingsUniformBuffer,
    writeRawYUVRenderSettingsUniform
} from '../RawYUVGPURenderer';
import {
    createExternalHDRAuthorizationAccessUnit,
    EXTERNAL_HDR_AUTHORIZATION_CODED_HEIGHT,
    EXTERNAL_HDR_AUTHORIZATION_CODED_WIDTH,
    EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT,
    EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH,
    EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SAMPLES,
    EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SHA256,
    EXTERNAL_HDR_AUTHORIZATION_FIXTURE_VERSION
} from './ExternalHDRAuthorizationFixture';
import GPUAuthorizationDeadline from './GPUAuthorizationDeadline';
import {
    GPUCanvasPixelReader,
    getValidationTextureUsage
} from './GPUCanvasReadback';
import {
    calculateRawHDRAuthorizationOutputDither,
    evaluateRawHDRFixtureObservations,
    type RawHDRFixtureObservation
} from './RawHDRPresentationAuthorization';

const EXTERNAL_HDR_CODEC = 'hvc1.2.4.L120.B0';
const EXTERNAL_HDR_AUTHORIZATION_TOLERANCE = 10 / 255;
const FLOATS_PER_PRESENTATION_UNIFORM = 4;
const MAXIMUM_10_BIT_CODE = 1_023;
const VERTEX_COUNT = 6;
const AUTHORIZED_TARGET_FORMATS = new Set<GPUTextureFormat>([
    'bgra8unorm',
    'rgba8unorm'
]);

export type ExternalHDRAuthorizationRouteKey =
    | 'external-hevc-main10-bt709-limited:hlg-v1'
    | 'external-hevc-main10-bt709-limited:pq-v1';

export const EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS:
readonly ExternalHDRAuthorizationRouteKey[] = [
    'external-hevc-main10-bt709-limited:pq-v1',
    'external-hevc-main10-bt709-limited:hlg-v1'
];

export type ExternalHDRAuthorizationFailureReason =
    | 'decode-failed'
    | 'decoder-api-unavailable'
    | 'decoder-config-unsupported'
    | 'decoder-output-mismatch'
    | 'device-lost'
    | 'frame-import-failed'
    | 'gpu-api-unavailable'
    | 'gpu-validation-failed'
    | 'pixel-mismatch'
    | 'readback-failed'
    | 'route-unsupported'
    | 'target-format-unsupported'
    | 'timeout'
    | 'unexpected-error';

export type ExternalHDRRouteAuthorizationDecision = {
    authorizedRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
    device: GPUDevice
    failureReason: ExternalHDRAuthorizationFailureReason | null
    fixtureVersion: typeof EXTERNAL_HDR_AUTHORIZATION_FIXTURE_VERSION
    maximumChannelError: number | null
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    routeKey: ExternalHDRAuthorizationRouteKey
    sampleCount: number
    shaderSignature: string
    status: 'authorized' | 'rejected'
    targetFormat: GPUTextureFormat
};

export type ExternalHDRAuthorizationTelemetry = {
    authorizedRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
    failureReasons: Readonly<Partial<Record<
        ExternalHDRAuthorizationRouteKey,
        ExternalHDRAuthorizationFailureReason
    >>>
    fixtureVersion: typeof EXTERNAL_HDR_AUTHORIZATION_FIXTURE_VERSION
    maximumChannelErrors: Readonly<Partial<Record<
        ExternalHDRAuthorizationRouteKey,
        number
    >>>
    pendingRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
    rejectedRouteKeys: readonly ExternalHDRAuthorizationRouteKey[]
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    sampleCounts: Readonly<Partial<Record<ExternalHDRAuthorizationRouteKey, number>>>
    status: 'authorized' | 'pending' | 'rejected' | 'unavailable'
    targetFormat: GPUTextureFormat | null
};

export type ExternalHDRAuthorizationFrameFactory = (
    signal: AbortSignal
) => Promise<VideoFrame>;

type CachedRouteProbe = {
    decision: ExternalHDRRouteAuthorizationDecision | null
    promise: Promise<ExternalHDRRouteAuthorizationDecision>
};

type DeviceProbeCache = {
    routes: Map<string, CachedRouteProbe>
};

type AuthorizationPhase = 'frame-create' | 'frame-import' | 'gpu-render';

type TelemetryAccumulator = {
    authorizedRouteKeys: ExternalHDRAuthorizationRouteKey[]
    failureReasons: Partial<Record<
        ExternalHDRAuthorizationRouteKey,
        ExternalHDRAuthorizationFailureReason
    >>
    maximumChannelErrors: Partial<Record<ExternalHDRAuthorizationRouteKey, number>>
    pendingRouteKeys: ExternalHDRAuthorizationRouteKey[]
    rejectedRouteKeys: ExternalHDRAuthorizationRouteKey[]
    sampleCounts: Partial<Record<ExternalHDRAuthorizationRouteKey, number>>
};

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function createMetadata(routeKey: ExternalHDRAuthorizationRouteKey): InputColorMetadata {
    switch (routeKey) {
        case 'external-hevc-main10-bt709-limited:hlg-v1':
            return createHLGColorMetadata();
        case 'external-hevc-main10-bt709-limited:pq-v1':
            return createPQColorMetadata();
    }
}

function createSettings(metadata: InputColorMetadata): HDRToSDRRenderSettings {
    return createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits: metadata.nominalPeakNits }
    });
}

/** Returns the exact Main10 HDR metadata routes covered by the native-frame probe. */
export function getExternalHDRAuthorizationRouteKey(
    metadata: InputColorMetadata
): ExternalHDRAuthorizationRouteKey | null {
    if (
        metadata.bitDepth !== 10
        || metadata.matrix !== 'bt2020-ncl'
        || metadata.primaries !== 'bt2020'
        || metadata.range !== 'limited'
    ) {
        return null;
    }
    switch (metadata.transfer) {
        case 'hlg':
            return 'external-hevc-main10-bt709-limited:hlg-v1';
        case 'pq':
            return 'external-hevc-main10-bt709-limited:pq-v1';
        case 'sdr':
            return null;
    }
}

/** Creates a stable identity for the exact native frame and production shader route. */
export function createExternalHDRShaderSignature(
    targetFormat: GPUTextureFormat,
    routeKey: ExternalHDRAuthorizationRouteKey,
    shaderCode: string
): string {
    const signatureInput = [
        `fixture=${EXTERNAL_HDR_AUTHORIZATION_FIXTURE_VERSION}`,
        `fixture-sha256=${EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SHA256}`,
        `uniform=${RENDER_SETTINGS_VERSION}`,
        `route=${routeKey}`,
        `codec=${EXTERNAL_HDR_CODEC}`,
        'frame=opaque:bt709:bt709:bt709:limited',
        `tolerance=${EXTERNAL_HDR_AUTHORIZATION_TOLERANCE}`,
        `target=${targetFormat}`,
        shaderCode
    ].join('\u0000');
    let hash = 0x811C_9DC5;
    for (let characterIndex = 0; characterIndex < signatureInput.length; characterIndex += 1) {
        hash ^= signatureInput.charCodeAt(characterIndex);
        hash = Math.imul(hash, 0x0100_0193) >>> 0;
    }
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
}

function frameMatchesAuthorizationContract(frame: VideoFrame): boolean {
    const visibleRectangle = frame.visibleRect;
    return frame.format === null
        && frame.codedWidth === EXTERNAL_HDR_AUTHORIZATION_CODED_WIDTH
        && frame.codedHeight === EXTERNAL_HDR_AUTHORIZATION_CODED_HEIGHT
        && frame.displayWidth === EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH
        && frame.displayHeight === EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT
        && frame.timestamp === 0
        && visibleRectangle !== null
        && visibleRectangle.x === 0
        && visibleRectangle.y === 0
        && visibleRectangle.width === EXTERNAL_HDR_AUTHORIZATION_DISPLAY_WIDTH
        && visibleRectangle.height === EXTERNAL_HDR_AUTHORIZATION_DISPLAY_HEIGHT
        && frame.colorSpace.fullRange === false
        && frame.colorSpace.matrix === 'bt709'
        && frame.colorSpace.primaries === 'bt709'
        && frame.colorSpace.transfer === 'bt709';
}

async function flushVideoDecoderUntilAbort(
    decoder: VideoDecoder,
    signal?: AbortSignal
): Promise<void> {
    if (!signal) {
        await decoder.flush();
        return;
    }
    if (signal.aborted) {
        throw new DOMException(
            'External HDR authorization decode was aborted',
            'AbortError'
        );
    }

    let rejectAbort: ((reason: DOMException) => void) | null = null;
    const abortPromise = new Promise<never>((_resolve, reject): void => {
        rejectAbort = reject;
    });
    const handleAbort = (): void => {
        rejectAbort?.(new DOMException(
            'External HDR authorization decode was aborted',
            'AbortError'
        ));
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    try {
        await Promise.race([ decoder.flush(), abortPromise ]);
    } finally {
        signal.removeEventListener('abort', handleAbort);
        rejectAbort = null;
    }
}

/** Decodes one neutralized Main10 fixture and requires Chromium's opaque hardware output. */
export async function createExternalHDRAuthorizationFrame(
    signal?: AbortSignal
): Promise<VideoFrame> {
    if (
        typeof VideoDecoder === 'undefined'
        || typeof EncodedVideoChunk === 'undefined'
        || typeof VideoDecoder.isConfigSupported !== 'function'
    ) {
        throw new Error('decoder-api-unavailable');
    }
    if (signal?.aborted) {
        throw new DOMException('External HDR authorization decode was aborted', 'AbortError');
    }

    const sourceAccessUnit = createExternalHDRAuthorizationAccessUnit();
    const neutralizedAccessUnit = rewriteHEVCAccessUnitColorDescriptionToBT709(
        sourceAccessUnit,
        { kind: 'annex-b' }
    );
    if (!neutralizedAccessUnit) {
        throw new Error('decoder-output-mismatch');
    }
    const configuration: VideoDecoderConfig = {
        codec: EXTERNAL_HDR_CODEC,
        codedHeight: EXTERNAL_HDR_AUTHORIZATION_CODED_HEIGHT,
        codedWidth: EXTERNAL_HDR_AUTHORIZATION_CODED_WIDTH,
        colorSpace: {
            fullRange: false,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'bt709'
        },
        hardwareAcceleration: 'prefer-hardware',
        optimizeForLatency: true
    };
    // eslint-disable-next-line compat/compat -- Authorization is capability-gated
    const support = await VideoDecoder.isConfigSupported(configuration);
    if (!support.supported) {
        throw new Error('decoder-config-unsupported');
    }

    const decodeState: {
        decoderError: DOMException | null
        decodedFrame: VideoFrame | null
        outputCount: number
    } = {
        decoderError: null,
        decodedFrame: null,
        outputCount: 0
    };
    // eslint-disable-next-line compat/compat -- Authorization is capability-gated
    const decoder = new VideoDecoder({
        error: (error: DOMException): void => {
            decodeState.decoderError = error;
        },
        output: (frame: VideoFrame): void => {
            decodeState.outputCount += 1;
            if (decodeState.decodedFrame) {
                frame.close();
                return;
            }
            decodeState.decodedFrame = frame;
        }
    });
    try {
        decoder.configure(configuration);
        // eslint-disable-next-line compat/compat -- Authorization is capability-gated
        decoder.decode(new EncodedVideoChunk({
            data: neutralizedAccessUnit,
            timestamp: 0,
            type: 'key'
        }));
        await flushVideoDecoderUntilAbort(decoder, signal);
        if (signal?.aborted) {
            throw new DOMException(
                'External HDR authorization decode was aborted',
                'AbortError'
            );
        }
        if (decodeState.decoderError) {
            throw decodeState.decoderError;
        }
        const decodedFrame = decodeState.decodedFrame;
        if (!decodedFrame || decodeState.outputCount !== 1) {
            throw new Error('decode-failed');
        }
        if (!frameMatchesAuthorizationContract(decodedFrame)) {
            throw new Error('decoder-output-mismatch');
        }
        const authorizedFrame = decodedFrame;
        decodeState.decodedFrame = null;
        return authorizedFrame;
    } finally {
        decoder.close();
        decodeState.decodedFrame?.close();
    }
}

/** Computes CPU-reference samples from the fixture's exact decoded YUV codes. */
export function createExpectedExternalHDRAuthorizationObservations(
    routeKey: ExternalHDRAuthorizationRouteKey,
    settings: HDRToSDRRenderSettings
): readonly RawHDRFixtureObservation[] {
    const metadata = createMetadata(routeKey);
    return EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SAMPLES.map(sample => {
        const encodedYUV: ColorTriplet = [
            sample.rawYUVCode[0] / MAXIMUM_10_BIT_CODE,
            sample.rawYUVCode[1] / MAXIMUM_10_BIT_CODE,
            sample.rawYUVCode[2] / MAXIMUM_10_BIT_CODE
        ];
        const referenceRGB = processEncodedYUV(encodedYUV, metadata, settings);
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

function classifyFailure(
    error: unknown,
    phase: AuthorizationPhase
): ExternalHDRAuthorizationFailureReason {
    switch (getErrorMessage(error)) {
        case 'decode-failed':
            return 'decode-failed';
        case 'decoder-api-unavailable':
            return 'decoder-api-unavailable';
        case 'decoder-config-unsupported':
            return 'decoder-config-unsupported';
        case 'decoder-output-mismatch':
            return 'decoder-output-mismatch';
        case 'device-lost':
            return 'device-lost';
        case 'timeout':
            return 'timeout';
        default:
            break;
    }
    switch (phase) {
        case 'frame-create':
            return 'decode-failed';
        case 'frame-import':
            return 'frame-import-failed';
        case 'gpu-render':
            return 'unexpected-error';
    }
}

function createRejectedDecision(
    device: GPUDevice,
    targetFormat: GPUTextureFormat,
    routeKey: ExternalHDRAuthorizationRouteKey,
    shaderSignature: string,
    failureReason: ExternalHDRAuthorizationFailureReason,
    sampleCount = 0,
    maximumChannelError: number | null = null
): ExternalHDRRouteAuthorizationDecision {
    return {
        authorizedRouteKeys: [],
        device,
        failureReason,
        fixtureVersion: EXTERNAL_HDR_AUTHORIZATION_FIXTURE_VERSION,
        maximumChannelError,
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        routeKey,
        sampleCount,
        shaderSignature,
        status: 'rejected',
        targetFormat
    };
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

/** Runs native decode, external import, production shader, draw, and readback. */
export class ExternalHDRPresentationAuthorizationRunner {
    public constructor(
        private readonly createFrame: ExternalHDRAuthorizationFrameFactory =
        createExternalHDRAuthorizationFrame
    ) {}

    public async validate(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: ExternalHDRAuthorizationRouteKey
    ): Promise<ExternalHDRRouteAuthorizationDecision> {
        const metadata = createMetadata(routeKey);
        const settings = createSettings(metadata);
        const shaderCode = createExternalHDRColorPipelineWGSL(metadata, settings);
        const shaderSignature = createExternalHDRShaderSignature(
            targetFormat,
            routeKey,
            shaderCode
        );
        if (!EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS.includes(routeKey)) {
            return createRejectedDecision(
                device,
                targetFormat,
                routeKey,
                shaderSignature,
                'route-unsupported'
            );
        }
        if (!AUTHORIZED_TARGET_FORMATS.has(targetFormat)) {
            return createRejectedDecision(
                device,
                targetFormat,
                routeKey,
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
                routeKey,
                shaderSignature,
                'gpu-api-unavailable'
            );
        }

        let targetTexture: GPUTexture | null = null;
        let presentationUniformBuffer: GPUBuffer | null = null;
        let renderSettingsUniformBuffer: GPUBuffer | null = null;
        let pixelReader: GPUCanvasPixelReader | null = null;
        let frame: VideoFrame | null = null;
        let frameAbortController: AbortController | null = null;
        let errorScopePushed = false;
        let phase: AuthorizationPhase = 'gpu-render';
        const deadline = new GPUAuthorizationDeadline(device);
        try {
            const pipeline = await deadline.wait(
                createRenderPipeline(device, targetFormat, shaderCode)
            );
            const sampler = device.createSampler({
                magFilter: 'linear',
                minFilter: 'linear'
            });
            presentationUniformBuffer = device.createBuffer({
                label: 'WebGPU external HDR authorization presentation uniforms',
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

            phase = 'frame-create';
            // eslint-disable-next-line compat/compat -- WebGPU custom decode targets modern Chromium
            frameAbortController = new AbortController();
            const activeFrameAbortController = frameAbortController;
            const framePromise = this.createFrame(activeFrameAbortController.signal);
            void framePromise.then((resolvedFrame: VideoFrame): void => {
                if (activeFrameAbortController.signal.aborted) {
                    resolvedFrame.close();
                }
            }, (): void => undefined);
            frame = await deadline.wait(
                framePromise,
                (): void => activeFrameAbortController.abort()
            );
            frameAbortController = null;
            targetTexture = device.createTexture({
                dimension: '2d',
                format: targetFormat,
                label: 'WebGPU external HDR authorization target',
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
                }],
                layout: pipeline.getBindGroupLayout(0)
            });
            const commandEncoder = device.createCommandEncoder({
                label: 'WebGPU external HDR authorization commands'
            });
            const renderPass = commandEncoder.beginRenderPass({
                colorAttachments: [{
                    clearValue: { a: 1, b: 0, g: 0, r: 0 },
                    loadOp: 'clear',
                    storeOp: 'store',
                    view: targetTexture.createView()
                }],
                label: 'WebGPU external HDR authorization pass'
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
            const validationError = await deadline.wait(device.popErrorScope());
            errorScopePushed = false;
            if (validationError) {
                return createRejectedDecision(
                    device,
                    targetFormat,
                    routeKey,
                    shaderSignature,
                    'gpu-validation-failed'
                );
            }

            pixelReader = new GPUCanvasPixelReader({
                device,
                format: targetFormat,
                maximumReadbacks: EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SAMPLES.length
            });
            const readback = await deadline.wait(
                pixelReader.readPixels(
                    EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SAMPLES,
                    targetTexture
                ),
                (): void => pixelReader?.destroy()
            );
            if (readback.failure || !readback.linearRGB) {
                return createRejectedDecision(
                    device,
                    targetFormat,
                    routeKey,
                    shaderSignature,
                    'readback-failed'
                );
            }
            const actualObservations: RawHDRFixtureObservation[] = [];
            for (let sampleIndex = 0;
                sampleIndex < EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SAMPLES.length;
                sampleIndex += 1) {
                const sample = EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SAMPLES[sampleIndex];
                actualObservations.push({
                    linearRGB: readback.linearRGB[sampleIndex],
                    sampleX: sample.sampleX,
                    sampleY: sample.sampleY
                });
            }
            const expectedObservations = createExpectedExternalHDRAuthorizationObservations(
                routeKey,
                settings
            );
            const comparison = evaluateRawHDRFixtureObservations(
                expectedObservations,
                actualObservations,
                EXTERNAL_HDR_AUTHORIZATION_TOLERANCE
            );
            if (!comparison.accepted) {
                return createRejectedDecision(
                    device,
                    targetFormat,
                    routeKey,
                    shaderSignature,
                    'pixel-mismatch',
                    actualObservations.length,
                    comparison.maximumChannelError
                );
            }
            return {
                authorizedRouteKeys: [ routeKey ],
                device,
                failureReason: null,
                fixtureVersion: EXTERNAL_HDR_AUTHORIZATION_FIXTURE_VERSION,
                maximumChannelError: comparison.maximumChannelError,
                renderSettingsVersion: RENDER_SETTINGS_VERSION,
                routeKey,
                sampleCount: actualObservations.length,
                shaderSignature,
                status: 'authorized',
                targetFormat
            };
        } catch (error) {
            return createRejectedDecision(
                device,
                targetFormat,
                routeKey,
                shaderSignature,
                classifyFailure(error, phase)
            );
        } finally {
            deadline.destroy();
            frameAbortController?.abort();
            if (errorScopePushed) {
                discardErrorScope(device);
            }
            frame?.close();
            pixelReader?.destroy();
            presentationUniformBuffer?.destroy();
            renderSettingsUniformBuffer?.destroy();
            targetTexture?.destroy();
        }
    }
}

function getAuthorizationTelemetryStatus(
    accumulator: TelemetryAccumulator
): ExternalHDRAuthorizationTelemetry['status'] {
    if (accumulator.pendingRouteKeys.length > 0) {
        return 'pending';
    }
    if (accumulator.authorizedRouteKeys.length > 0) {
        return 'authorized';
    }
    return accumulator.rejectedRouteKeys.length > 0 ? 'rejected' : 'unavailable';
}

/** Device-scoped cache for exact opaque native Main10 presentation evidence. */
export class ExternalHDRPresentationAuthorizationRegistry {
    private readonly devices = new WeakMap<GPUDevice, DeviceProbeCache>();

    public constructor(
        private readonly runner = new ExternalHDRPresentationAuthorizationRunner()
    ) {}

    /** Starts both exact shader probes without delaying ordinary playback. */
    public prewarm(device: GPUDevice, targetFormat: GPUTextureFormat): void {
        for (const routeKey of EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS) {
            void this.authorize(device, targetFormat, routeKey);
        }
    }

    /** Waits only route probes already started for this device and target. */
    public async waitForPending(
        device: GPUDevice,
        targetFormat: GPUTextureFormat
    ): Promise<void> {
        const pendingPromises: Promise<ExternalHDRRouteAuthorizationDecision>[] = [];
        for (const routeKey of EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS) {
            const probe = this.getCachedProbe(device, targetFormat, routeKey);
            if (probe && !probe.decision) {
                pendingPromises.push(probe.promise);
            }
        }
        if (pendingPromises.length > 0) {
            await Promise.all(pendingPromises);
        }
    }

    /** Returns one deduplicated exact-device, target, decoder, and shader decision. */
    public authorize(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: ExternalHDRAuthorizationRouteKey
    ): Promise<ExternalHDRRouteAuthorizationDecision> {
        const cacheKey = this.createCacheKey(targetFormat, routeKey);
        const deviceCache = this.getDeviceCache(device);
        const cachedProbe = deviceCache.routes.get(cacheKey);
        if (cachedProbe) {
            return cachedProbe.promise;
        }

        const probe = { decision: null } as CachedRouteProbe;
        probe.promise = Promise.resolve().then(() => (
            this.runner.validate(device, targetFormat, routeKey)
        )).then(
            (decision: ExternalHDRRouteAuthorizationDecision):
            ExternalHDRRouteAuthorizationDecision => {
                probe.decision = decision;
                return decision;
            },
            (): ExternalHDRRouteAuthorizationDecision => {
                const metadata = createMetadata(routeKey);
                const shaderCode = createExternalHDRColorPipelineWGSL(
                    metadata,
                    createSettings(metadata)
                );
                const decision = createRejectedDecision(
                    device,
                    targetFormat,
                    routeKey,
                    createExternalHDRShaderSignature(targetFormat, routeKey, shaderCode),
                    'unexpected-error'
                );
                probe.decision = decision;
                return decision;
            }
        );
        deviceCache.routes.set(cacheKey, probe);
        return probe.promise;
    }

    /** Checks only settled exact shader evidence and never waits optimistically. */
    public isAuthorized(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        metadata: InputColorMetadata,
        settings: HDRToSDRRenderSettings
    ): boolean {
        const routeKey = getExternalHDRAuthorizationRouteKey(metadata);
        if (!routeKey) {
            return false;
        }
        const shaderCode = createExternalHDRColorPipelineWGSL(metadata, settings);
        const shaderSignature = createExternalHDRShaderSignature(
            targetFormat,
            routeKey,
            shaderCode
        );
        const decision = this.getCachedProbe(device, targetFormat, routeKey)?.decision;
        return decision?.status === 'authorized'
            && decision.device === device
            && decision.targetFormat === targetFormat
            && decision.shaderSignature === shaderSignature
            && decision.authorizedRouteKeys.includes(routeKey);
    }

    /** Returns bounded diagnostics without exposing retained decoder or GPU objects. */
    public getTelemetry(
        device: GPUDevice | null,
        targetFormat: GPUTextureFormat | null
    ): ExternalHDRAuthorizationTelemetry {
        const accumulator: TelemetryAccumulator = {
            authorizedRouteKeys: [],
            failureReasons: {},
            maximumChannelErrors: {},
            pendingRouteKeys: [],
            rejectedRouteKeys: [],
            sampleCounts: {}
        };
        if (!device || !targetFormat) {
            return {
                ...accumulator,
                fixtureVersion: EXTERNAL_HDR_AUTHORIZATION_FIXTURE_VERSION,
                renderSettingsVersion: RENDER_SETTINGS_VERSION,
                status: 'unavailable',
                targetFormat
            };
        }

        for (const routeKey of EXTERNAL_HDR_AUTHORIZATION_ROUTE_KEYS) {
            const probe = this.getCachedProbe(device, targetFormat, routeKey);
            if (!probe) {
                continue;
            }
            if (!probe.decision) {
                accumulator.pendingRouteKeys.push(routeKey);
                continue;
            }
            if (probe.decision.maximumChannelError !== null) {
                accumulator.maximumChannelErrors[routeKey] =
                    probe.decision.maximumChannelError;
            }
            accumulator.sampleCounts[routeKey] = probe.decision.sampleCount;
            if (probe.decision.status === 'authorized') {
                accumulator.authorizedRouteKeys.push(routeKey);
            } else {
                accumulator.rejectedRouteKeys.push(routeKey);
                if (probe.decision.failureReason) {
                    accumulator.failureReasons[routeKey] = probe.decision.failureReason;
                }
            }
        }
        return {
            ...accumulator,
            fixtureVersion: EXTERNAL_HDR_AUTHORIZATION_FIXTURE_VERSION,
            renderSettingsVersion: RENDER_SETTINGS_VERSION,
            status: getAuthorizationTelemetryStatus(accumulator),
            targetFormat
        };
    }

    private createCacheKey(
        targetFormat: GPUTextureFormat,
        routeKey: ExternalHDRAuthorizationRouteKey
    ): string {
        const metadata = createMetadata(routeKey);
        const shaderCode = createExternalHDRColorPipelineWGSL(
            metadata,
            createSettings(metadata)
        );
        return `${targetFormat}\u0000${routeKey}\u0000${createExternalHDRShaderSignature(
            targetFormat,
            routeKey,
            shaderCode
        )}`;
    }

    private getCachedProbe(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: ExternalHDRAuthorizationRouteKey
    ): CachedRouteProbe | undefined {
        return this.devices.get(device)?.routes.get(
            this.createCacheKey(targetFormat, routeKey)
        );
    }

    private getDeviceCache(device: GPUDevice): DeviceProbeCache {
        const cached = this.devices.get(device);
        if (cached) {
            return cached;
        }
        const created: DeviceProbeCache = { routes: new Map() };
        this.devices.set(device, created);
        void device.lost.then((): void => {
            this.devices.delete(device);
        });
        return created;
    }
}
