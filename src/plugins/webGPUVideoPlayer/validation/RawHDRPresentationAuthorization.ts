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
import { createRawYUVColorPipelineWGSL } from '../color/ColorPipelineShader';
import {
    millisecondsToMicroseconds
} from '../MediaTime';
import {
    createRawYUVRenderPipeline,
    createRawYUVRenderResources,
    destroyRawPlaneTextureSet,
    renderRawYUVFrame,
    type RawPlaneTextureSet,
    type RawYUVTexturePresentation
} from '../RawYUVGPURenderer';
import {
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    type RawVideoPlaneDescriptor,
    type SupportedRawVideoFrameFormat,
    type TransferableRawVideoFrame
} from '../custom/RawVideoFrameCopy';
import {
    GPUCanvasPixelReader,
    getValidationTextureUsage
} from './GPUCanvasReadback';
import GPUAuthorizationDeadline, {
    GPU_AUTHORIZATION_TIMEOUT_MICROSECONDS
} from './GPUAuthorizationDeadline';

export const RAW_HDR_AUTHORIZATION_FIXTURE_VERSION = 1;
export const RAW_HDR_AUTHORIZATION_TIMEOUT_MICROSECONDS =
    GPU_AUTHORIZATION_TIMEOUT_MICROSECONDS;

const FIXTURE_HEIGHT = 8;
const FIXTURE_WIDTH = 16;
const MAXIMUM_CODE = 1_023;
const NEUTRAL_CHROMA_CODE = 512;
const AUTHORIZATION_TOLERANCE = 3 / 255;
const AUTHORIZED_TARGET_FORMATS = new Set<GPUTextureFormat>([
    'bgra8unorm',
    'rgba8unorm'
]);

export type RawHDRAuthorizationRouteKey =
    | 'I420P10:bt2020-ncl:bt2020:limited:hlg'
    | 'I420P10:bt2020-ncl:bt2020:limited:pq';

export const RAW_HDR_AUTHORIZATION_ROUTE_KEYS: readonly RawHDRAuthorizationRouteKey[] = [
    'I420P10:bt2020-ncl:bt2020:limited:pq',
    'I420P10:bt2020-ncl:bt2020:limited:hlg'
];

export type RawHDRAuthorizationFailureReason =
    | 'device-lost'
    | 'gpu-api-unavailable'
    | 'gpu-validation-failed'
    | 'pixel-mismatch'
    | 'readback-failed'
    | 'route-unsupported'
    | 'target-format-unsupported'
    | 'timeout'
    | 'unexpected-error';

export type RawHDRRouteAuthorizationDecision = {
    authorizedRouteKeys: readonly RawHDRAuthorizationRouteKey[]
    device: GPUDevice
    failureReason: RawHDRAuthorizationFailureReason | null
    fixtureVersion: typeof RAW_HDR_AUTHORIZATION_FIXTURE_VERSION
    maximumChannelError: number | null
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    routeKey: RawHDRAuthorizationRouteKey
    sampleCount: number
    shaderSignature: string
    status: 'authorized' | 'rejected'
    targetFormat: GPUTextureFormat
};

export type RawHDRAuthorizationTelemetry = {
    authorizedRouteKeys: readonly RawHDRAuthorizationRouteKey[]
    failureReasons: Readonly<Partial<Record<RawHDRAuthorizationRouteKey, RawHDRAuthorizationFailureReason>>>
    fixtureVersion: typeof RAW_HDR_AUTHORIZATION_FIXTURE_VERSION
    pendingRouteKeys: readonly RawHDRAuthorizationRouteKey[]
    rejectedRouteKeys: readonly RawHDRAuthorizationRouteKey[]
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    status: 'authorized' | 'pending' | 'rejected' | 'unavailable'
    targetFormat: GPUTextureFormat | null
};

export type RawHDRFixtureObservation = {
    linearRGB: ColorTriplet
    sampleX: number
    sampleY: number
};

type FixtureSample = {
    sampleX: number
    sampleY: number
};

type CachedRouteProbe = {
    decision: RawHDRRouteAuthorizationDecision | null
    promise: Promise<RawHDRRouteAuthorizationDecision>
};

type DeviceProbeCache = {
    lossObserved: boolean
    routes: Map<string, CachedRouteProbe>
};

type TelemetryAccumulator = {
    authorizedRouteKeys: RawHDRAuthorizationRouteKey[]
    failureReasons: Partial<Record<
        RawHDRAuthorizationRouteKey,
        RawHDRAuthorizationFailureReason
    >>
    pendingRouteKeys: RawHDRAuthorizationRouteKey[]
    rejectedRouteKeys: RawHDRAuthorizationRouteKey[]
};

export const RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES: readonly FixtureSample[] = [
    { sampleX: 0, sampleY: 0 },
    { sampleX: 3, sampleY: 0 },
    { sampleX: 7, sampleY: 0 },
    { sampleX: 11, sampleY: 0 },
    { sampleX: 15, sampleY: 0 },
    { sampleX: 2, sampleY: 6 },
    { sampleX: 7, sampleY: 6 },
    { sampleX: 12, sampleY: 6 },
    { sampleX: 15, sampleY: 6 }
];

const FULL_FRAME_PRESENTATION: RawYUVTexturePresentation = {
    textureOffsetX: 0,
    textureOffsetY: 0,
    textureScaleX: 1,
    textureScaleY: 1,
    viewportHeight: FIXTURE_HEIGHT,
    viewportWidth: FIXTURE_WIDTH,
    viewportX: 0,
    viewportY: 0
};

function alignTo(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function createMetadata(routeKey: RawHDRAuthorizationRouteKey): InputColorMetadata {
    switch (routeKey) {
        case 'I420P10:bt2020-ncl:bt2020:limited:hlg':
            return createHLGColorMetadata();
        case 'I420P10:bt2020-ncl:bt2020:limited:pq':
            return createPQColorMetadata();
    }
}

function createSettings(metadata: InputColorMetadata): HDRToSDRRenderSettings {
    return createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits: metadata.nominalPeakNits }
    });
}

/** Returns the only raw HDR tuples currently covered by production probes. */
export function getRawHDRAuthorizationRouteKey(
    format: SupportedRawVideoFrameFormat,
    metadata: InputColorMetadata
): RawHDRAuthorizationRouteKey | null {
    if (
        format !== 'I420P10'
        || metadata.bitDepth !== 10
        || metadata.matrix !== 'bt2020-ncl'
        || metadata.primaries !== 'bt2020'
        || metadata.range !== 'limited'
    ) {
        return null;
    }
    switch (metadata.transfer) {
        case 'hlg':
            return 'I420P10:bt2020-ncl:bt2020:limited:hlg';
        case 'pq':
            return 'I420P10:bt2020-ncl:bt2020:limited:pq';
        case 'sdr':
            return null;
    }
}

/** Creates a stable, non-cryptographic identity for an exact compiled route. */
export function createRawHDRShaderSignature(
    targetFormat: GPUTextureFormat,
    shaderCode: string
): string {
    const signatureInput = [
        `fixture=${RAW_HDR_AUTHORIZATION_FIXTURE_VERSION}`,
        `uniform=${RENDER_SETTINGS_VERSION}`,
        `target=${targetFormat}`,
        shaderCode
    ].join('\u0000');
    let hash = 0x811c9dc5;
    for (let characterIndex = 0; characterIndex < signatureInput.length; characterIndex += 1) {
        hash ^= signatureInput.charCodeAt(characterIndex);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return `fnv1a32-${hash.toString(16).padStart(8, '0')}`;
}

function createPlaneDescriptor(
    kind: RawVideoPlaneDescriptor['kind'],
    width: number,
    height: number,
    byteOffset: number
): RawVideoPlaneDescriptor {
    const rowByteLength = width * Uint16Array.BYTES_PER_ELEMENT;
    const bytesPerRow = alignTo(rowByteLength, RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT);
    return {
        byteLength: bytesPerRow * height,
        byteOffset,
        bytesPerComponent: 2,
        bytesPerRow,
        componentsPerTexel: 1,
        height,
        kind,
        rowByteLength,
        width
    };
}

function setPlaneCode(
    data: ArrayBuffer,
    plane: RawVideoPlaneDescriptor,
    x: number,
    y: number,
    code: number
): void {
    const view = new DataView(data);
    view.setUint16(
        plane.byteOffset + (y * plane.bytesPerRow) + (x * Uint16Array.BYTES_PER_ELEMENT),
        code,
        true
    );
}

function populateFixtureLuma(
    data: ArrayBuffer,
    lumaPlane: RawVideoPlaneDescriptor
): void {
    for (let y = 0; y < FIXTURE_HEIGHT; y += 1) {
        for (let x = 0; x < FIXTURE_WIDTH; x += 1) {
            const rampCode = 64 + Math.round((876 * x) / (FIXTURE_WIDTH - 1));
            const lumaCode = y < FIXTURE_HEIGHT / 2 ? rampCode : 480 + (x * 18);
            setPlaneCode(data, lumaPlane, x, y, lumaCode);
        }
    }
}

function getFixtureChromaCodes(x: number, y: number): readonly [number, number] {
    if (y < FIXTURE_HEIGHT / 4) {
        return [ NEUTRAL_CHROMA_CODE, NEUTRAL_CHROMA_CODE ];
    }
    return x < FIXTURE_WIDTH / 4 ? [ 720, 304 ] : [ 304, 720 ];
}

function populateFixtureChroma(
    data: ArrayBuffer,
    chromaUPlane: RawVideoPlaneDescriptor,
    chromaVPlane: RawVideoPlaneDescriptor
): void {
    for (let y = 0; y < chromaUPlane.height; y += 1) {
        for (let x = 0; x < chromaUPlane.width; x += 1) {
            const [ chromaUCode, chromaVCode ] = getFixtureChromaCodes(x, y);
            setPlaneCode(data, chromaUPlane, x, y, chromaUCode);
            setPlaneCode(data, chromaVPlane, x, y, chromaVCode);
        }
    }
}

/** Builds one padded I420P10 luma-ramp and chromatic-macroblock fixture. */
export function createRawHDRAuthorizationFixture(
    routeKey: RawHDRAuthorizationRouteKey
): TransferableRawVideoFrame {
    const chromaWidth = FIXTURE_WIDTH / 2;
    const chromaHeight = FIXTURE_HEIGHT / 2;
    const lumaPlane = createPlaneDescriptor('y', FIXTURE_WIDTH, FIXTURE_HEIGHT, 0);
    const chromaUPlane = createPlaneDescriptor(
        'u',
        chromaWidth,
        chromaHeight,
        lumaPlane.byteLength
    );
    const chromaVPlane = createPlaneDescriptor(
        'v',
        chromaWidth,
        chromaHeight,
        lumaPlane.byteLength + chromaUPlane.byteLength
    );
    const data = new ArrayBuffer(
        lumaPlane.byteLength + chromaUPlane.byteLength + chromaVPlane.byteLength
    );
    populateFixtureLuma(data, lumaPlane);
    populateFixtureChroma(data, chromaUPlane, chromaVPlane);

    const metadata = createMetadata(routeKey);
    return {
        bitDepth: 10,
        codedHeight: FIXTURE_HEIGHT,
        codedWidth: FIXTURE_WIDTH,
        colorSpace: {
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: metadata.transfer === 'pq' ? 'smpte2084' : 'arib-std-b67'
        },
        data,
        displayHeight: FIXTURE_HEIGHT,
        displayWidth: FIXTURE_WIDTH,
        durationMicroseconds: null,
        format: 'I420P10',
        planes: [ lumaPlane, chromaUPlane, chromaVPlane ],
        timestampMicroseconds: millisecondsToMicroseconds(0),
        visibleRectangle: {
            height: FIXTURE_HEIGHT,
            width: FIXTURE_WIDTH,
            x: 0,
            y: 0
        }
    };
}

function readPlaneCode(
    frame: TransferableRawVideoFrame,
    plane: RawVideoPlaneDescriptor,
    x: number,
    y: number
): number {
    const clampedX = clamp(x, 0, plane.width - 1);
    const clampedY = clamp(y, 0, plane.height - 1);
    return new DataView(frame.data).getUint16(
        plane.byteOffset
            + (clampedY * plane.bytesPerRow)
            + (clampedX * Uint16Array.BYTES_PER_ELEMENT),
        true
    );
}

function mix(firstValue: number, secondValue: number, amount: number): number {
    return firstValue + ((secondValue - firstValue) * amount);
}

function samplePlaneCode(
    frame: TransferableRawVideoFrame,
    plane: RawVideoPlaneDescriptor,
    textureCoordinateX: number,
    textureCoordinateY: number
): number {
    const samplePositionX = (textureCoordinateX * plane.width) - 0.5;
    const samplePositionY = (textureCoordinateY * plane.height) - 0.5;
    const baseX = Math.floor(samplePositionX);
    const baseY = Math.floor(samplePositionY);
    const fractionX = samplePositionX - baseX;
    const fractionY = samplePositionY - baseY;
    const top = mix(
        readPlaneCode(frame, plane, baseX, baseY),
        readPlaneCode(frame, plane, baseX + 1, baseY),
        fractionX
    );
    const bottom = mix(
        readPlaneCode(frame, plane, baseX, baseY + 1),
        readPlaneCode(frame, plane, baseX + 1, baseY + 1),
        fractionX
    );
    return mix(top, bottom, fractionY);
}

function getPlane(
    frame: TransferableRawVideoFrame,
    kind: RawVideoPlaneDescriptor['kind']
): RawVideoPlaneDescriptor {
    const plane = frame.planes.find(candidate => candidate.kind === kind);
    if (!plane) {
        throw new Error(`Fixture does not contain a ${kind} plane`);
    }
    return plane;
}

/** Reproduces the production shader's bounded output dither at one pixel. */
export function calculateRawHDRAuthorizationOutputDither(
    sampleX: number,
    sampleY: number
): number {
    const pixelCoordinateX = sampleX + 0.5;
    const pixelCoordinateY = sampleY + 0.5;
    const innerValue = (pixelCoordinateX * 0.06711056) + (pixelCoordinateY * 0.00583715);
    const innerFraction = innerValue - Math.floor(innerValue);
    const noiseValue = 52.9829189 * innerFraction;
    return ((noiseValue - Math.floor(noiseValue)) - 0.5) / 255;
}

/** Samples one padded planar fixture through the production bilinear filter. */
export function sampleRawI420P10Frame(
    frame: TransferableRawVideoFrame,
    sampleX: number,
    sampleY: number
): ColorTriplet {
    const textureCoordinateX = (sampleX + 0.5) / frame.displayWidth;
    const textureCoordinateY = (sampleY + 0.5) / frame.displayHeight;
    return [
        samplePlaneCode(frame, getPlane(frame, 'y'), textureCoordinateX, textureCoordinateY),
        samplePlaneCode(frame, getPlane(frame, 'u'), textureCoordinateX, textureCoordinateY),
        samplePlaneCode(frame, getPlane(frame, 'v'), textureCoordinateX, textureCoordinateY)
    ];
}

/** Computes CPU-reference observations independently from the GPU render. */
export function createExpectedRawHDRFixtureObservations(
    frame: TransferableRawVideoFrame,
    metadata: InputColorMetadata,
    settings: HDRToSDRRenderSettings
): readonly RawHDRFixtureObservation[] {
    return RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES.map((
        sample: FixtureSample
    ): RawHDRFixtureObservation => {
        const rawYUV = sampleRawI420P10Frame(frame, sample.sampleX, sample.sampleY);
        const encodedYUV: ColorTriplet = [
            rawYUV[0] / MAXIMUM_CODE,
            rawYUV[1] / MAXIMUM_CODE,
            rawYUV[2] / MAXIMUM_CODE
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

/** Compares bounded readbacks with quantization and shader arithmetic tolerance. */
export function evaluateRawHDRFixtureObservations(
    expectedObservations: readonly RawHDRFixtureObservation[],
    actualObservations: readonly RawHDRFixtureObservation[]
): { accepted: boolean, maximumChannelError: number } {
    if (actualObservations.length !== expectedObservations.length) {
        return { accepted: false, maximumChannelError: Number.POSITIVE_INFINITY };
    }

    let maximumChannelError = 0;
    for (let sampleIndex = 0; sampleIndex < expectedObservations.length; sampleIndex += 1) {
        const expected = expectedObservations[sampleIndex];
        const actual = actualObservations[sampleIndex];
        if (actual.sampleX !== expected.sampleX || actual.sampleY !== expected.sampleY) {
            return { accepted: false, maximumChannelError: Number.POSITIVE_INFINITY };
        }
        for (let componentIndex = 0; componentIndex < 3; componentIndex += 1) {
            const channelError = Math.abs(
                actual.linearRGB[componentIndex] - expected.linearRGB[componentIndex]
            );
            if (!Number.isFinite(channelError)) {
                return { accepted: false, maximumChannelError: Number.POSITIVE_INFINITY };
            }
            maximumChannelError = Math.max(maximumChannelError, channelError);
        }
    }
    return {
        accepted: maximumChannelError <= AUTHORIZATION_TOLERANCE,
        maximumChannelError
    };
}

function classifyFailure(error: unknown): RawHDRAuthorizationFailureReason {
    const message = getErrorMessage(error);
    switch (message) {
        case 'device-lost':
            return 'device-lost';
        case 'timeout':
            return 'timeout';
        default:
            return 'unexpected-error';
    }
}

function createRejectedDecision(
    device: GPUDevice,
    targetFormat: GPUTextureFormat,
    routeKey: RawHDRAuthorizationRouteKey,
    shaderSignature: string,
    failureReason: RawHDRAuthorizationFailureReason,
    sampleCount = 0,
    maximumChannelError: number | null = null
): RawHDRRouteAuthorizationDecision {
    return {
        authorizedRouteKeys: [],
        device,
        failureReason,
        fixtureVersion: RAW_HDR_AUTHORIZATION_FIXTURE_VERSION,
        maximumChannelError,
        renderSettingsVersion: RENDER_SETTINGS_VERSION,
        routeKey,
        sampleCount,
        shaderSignature,
        status: 'rejected',
        targetFormat
    };
}

function getCachedRouteProbe(
    deviceCache: DeviceProbeCache | undefined,
    targetFormat: GPUTextureFormat,
    routeKey: RawHDRAuthorizationRouteKey
): CachedRouteProbe | undefined {
    const metadata = createMetadata(routeKey);
    const settings = createSettings(metadata);
    const shaderCode = createRawYUVColorPipelineWGSL(metadata, settings, 'I420P10');
    const signature = createRawHDRShaderSignature(targetFormat, shaderCode);
    return deviceCache?.routes.get(`${targetFormat}\u0000${signature}\u0000${routeKey}`);
}

function recordRouteTelemetry(
    accumulator: TelemetryAccumulator,
    routeKey: RawHDRAuthorizationRouteKey,
    probe: CachedRouteProbe | undefined
): void {
    if (!probe) {
        return;
    }
    const decision = probe.decision;
    if (!decision) {
        accumulator.pendingRouteKeys.push(routeKey);
        return;
    }
    if (decision.status === 'authorized') {
        accumulator.authorizedRouteKeys.push(routeKey);
        return;
    }

    accumulator.rejectedRouteKeys.push(routeKey);
    if (decision.failureReason) {
        accumulator.failureReasons[routeKey] = decision.failureReason;
    }
}

function getAuthorizationTelemetryStatus(
    accumulator: TelemetryAccumulator
): RawHDRAuthorizationTelemetry['status'] {
    if (accumulator.authorizedRouteKeys.length > 0) {
        return 'authorized';
    }
    if (accumulator.pendingRouteKeys.length > 0) {
        return 'pending';
    }
    return accumulator.rejectedRouteKeys.length > 0 ? 'rejected' : 'unavailable';
}

/** Runs the exact production raw upload, binding, shader, viewport, and draw path. */
export class RawHDRPresentationAuthorizationRunner {
    public async validate(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: RawHDRAuthorizationRouteKey
    ): Promise<RawHDRRouteAuthorizationDecision> {
        const metadata = createMetadata(routeKey);
        const settings = createSettings(metadata);
        const shaderCode = createRawYUVColorPipelineWGSL(metadata, settings, 'I420P10');
        const shaderSignature = createRawHDRShaderSignature(targetFormat, shaderCode);
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
        let textureSet: RawPlaneTextureSet | null = null;
        let presentationUniformBuffer: GPUBuffer | null = null;
        let renderSettingsUniformBuffer: GPUBuffer | null = null;
        let pixelReader: GPUCanvasPixelReader | null = null;
        let errorScopePushed = false;
        const deadline = new GPUAuthorizationDeadline(
            device,
            RAW_HDR_AUTHORIZATION_TIMEOUT_MICROSECONDS
        );
        try {
            const pipeline = await deadline.wait(
                createRawYUVRenderPipeline(device, targetFormat, shaderCode)
            );
            const resources = createRawYUVRenderResources(device, pipeline, settings);
            presentationUniformBuffer = resources.presentationUniformBuffer;
            renderSettingsUniformBuffer = resources.renderSettingsUniformBuffer;
            const frame = createRawHDRAuthorizationFixture(routeKey);
            targetTexture = device.createTexture({
                dimension: '2d',
                format: targetFormat,
                label: 'WebGPU raw HDR authorization target',
                size: {
                    depthOrArrayLayers: 1,
                    height: FIXTURE_HEIGHT,
                    width: FIXTURE_WIDTH
                },
                usage: targetUsage
            });
            device.pushErrorScope('validation');
            errorScopePushed = true;
            const renderResult = renderRawYUVFrame({
                ...resources,
                device,
                frame,
                presentation: FULL_FRAME_PRESENTATION,
                targetView: targetTexture.createView(),
                textureSet
            });
            textureSet = renderResult.textureSet;
            await deadline.wait(device.queue.onSubmittedWorkDone());
            const validationPromise = device.popErrorScope();
            errorScopePushed = false;
            const validationError = await deadline.wait(validationPromise);
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
                maximumReadbacks: RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES.length
            });
            const actualObservations: RawHDRFixtureObservation[] = [];
            for (const sample of RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES) {
                const readback = await deadline.wait(
                    pixelReader.readPixel(
                        sample.sampleX,
                        sample.sampleY,
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
                        'readback-failed',
                        actualObservations.length
                    );
                }
                actualObservations.push({
                    linearRGB: readback.linearRGB,
                    sampleX: sample.sampleX,
                    sampleY: sample.sampleY
                });
            }
            const expectedObservations = createExpectedRawHDRFixtureObservations(
                frame,
                metadata,
                settings
            );
            const comparison = evaluateRawHDRFixtureObservations(
                expectedObservations,
                actualObservations
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
                fixtureVersion: RAW_HDR_AUTHORIZATION_FIXTURE_VERSION,
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
                classifyFailure(error)
            );
        } finally {
            deadline.destroy();
            if (errorScopePushed) {
                // popErrorScope can throw synchronously after device loss
                // eslint-disable-next-line sonarjs/no-try-promise
                try {
                    void device.popErrorScope().catch((): void => undefined);
                } catch {
                    // Device loss can synchronously invalidate the scope stack
                }
            }
            pixelReader?.destroy();
            destroyRawPlaneTextureSet(textureSet);
            presentationUniformBuffer?.destroy();
            renderSettingsUniformBuffer?.destroy();
            targetTexture?.destroy();
        }
    }
}

/** Device-scoped, exact-shader cache for production raw HDR authorization. */
export class RawHDRPresentationAuthorizationRegistry {
    private readonly devices = new WeakMap<GPUDevice, DeviceProbeCache>();
    private readonly runner: RawHDRPresentationAuthorizationRunner;

    public constructor(runner = new RawHDRPresentationAuthorizationRunner()) {
        this.runner = runner;
    }

    /** Starts both exact route probes and deduplicates concurrent requests. */
    public prewarm(device: GPUDevice, targetFormat: GPUTextureFormat): void {
        for (const routeKey of RAW_HDR_AUTHORIZATION_ROUTE_KEYS) {
            void this.authorize(device, targetFormat, routeKey);
        }
    }

    /** Waits only probes that were already started for this exact device and format. */
    public async waitForPending(device: GPUDevice, targetFormat: GPUTextureFormat): Promise<void> {
        const deviceCache = this.devices.get(device);
        if (!deviceCache) {
            return;
        }
        const pendingPromises: Promise<RawHDRRouteAuthorizationDecision>[] = [];
        for (const routeKey of RAW_HDR_AUTHORIZATION_ROUTE_KEYS) {
            const probe = getCachedRouteProbe(deviceCache, targetFormat, routeKey);
            if (probe && !probe.decision) {
                pendingPromises.push(probe.promise);
            }
        }
        if (pendingPromises.length > 0) {
            await Promise.all(pendingPromises);
        }
    }

    /** Returns a deduplicated decision for one exact device/format/shader route. */
    public authorize(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        routeKey: RawHDRAuthorizationRouteKey
    ): Promise<RawHDRRouteAuthorizationDecision> {
        const metadata = createMetadata(routeKey);
        const settings = createSettings(metadata);
        const shaderCode = createRawYUVColorPipelineWGSL(metadata, settings, 'I420P10');
        const shaderSignature = createRawHDRShaderSignature(targetFormat, shaderCode);
        const cacheKey = `${targetFormat}\u0000${shaderSignature}\u0000${routeKey}`;
        const deviceCache = this.getDeviceCache(device);
        const cachedProbe = deviceCache.routes.get(cacheKey);
        if (cachedProbe) {
            return cachedProbe.promise;
        }

        const probe = { decision: null } as CachedRouteProbe;
        probe.promise = Promise.resolve().then(() => (
            this.runner.validate(device, targetFormat, routeKey)
        )).then(
            (decision: RawHDRRouteAuthorizationDecision): RawHDRRouteAuthorizationDecision => {
                probe.decision = decision;
                return decision;
            },
            (): RawHDRRouteAuthorizationDecision => {
                const decision = createRejectedDecision(
                    device,
                    targetFormat,
                    routeKey,
                    shaderSignature,
                    'unexpected-error'
                );
                probe.decision = decision;
                return decision;
            }
        );
        deviceCache.routes.set(cacheKey, probe);
        return probe.promise;
    }

    /** Checks only settled exact-device authorization and never waits optimistically. */
    public isAuthorized(
        device: GPUDevice,
        targetFormat: GPUTextureFormat,
        metadata: InputColorMetadata,
        settings: HDRToSDRRenderSettings,
        format: SupportedRawVideoFrameFormat
    ): boolean {
        const routeKey = getRawHDRAuthorizationRouteKey(format, metadata);
        if (!routeKey) {
            return false;
        }
        const shaderCode = createRawYUVColorPipelineWGSL(metadata, settings, format);
        const shaderSignature = createRawHDRShaderSignature(targetFormat, shaderCode);
        const cacheKey = `${targetFormat}\u0000${shaderSignature}\u0000${routeKey}`;
        const decision = this.devices.get(device)?.routes.get(cacheKey)?.decision;
        return decision?.status === 'authorized'
            && decision.device === device
            && decision.targetFormat === targetFormat
            && decision.shaderSignature === shaderSignature
            && decision.authorizedRouteKeys.includes(routeKey);
    }

    /** Returns bounded state for diagnostics without exposing GPU objects. */
    public getTelemetry(
        device: GPUDevice | null,
        targetFormat: GPUTextureFormat | null
    ): RawHDRAuthorizationTelemetry {
        if (!device || !targetFormat) {
            return {
                authorizedRouteKeys: [],
                failureReasons: {},
                fixtureVersion: RAW_HDR_AUTHORIZATION_FIXTURE_VERSION,
                pendingRouteKeys: [],
                rejectedRouteKeys: [],
                renderSettingsVersion: RENDER_SETTINGS_VERSION,
                status: 'unavailable',
                targetFormat
            };
        }

        const accumulator: TelemetryAccumulator = {
            authorizedRouteKeys: [],
            failureReasons: {},
            pendingRouteKeys: [],
            rejectedRouteKeys: []
        };
        const deviceCache = this.devices.get(device);
        for (const routeKey of RAW_HDR_AUTHORIZATION_ROUTE_KEYS) {
            recordRouteTelemetry(
                accumulator,
                routeKey,
                getCachedRouteProbe(deviceCache, targetFormat, routeKey)
            );
        }

        return {
            authorizedRouteKeys: accumulator.authorizedRouteKeys,
            failureReasons: accumulator.failureReasons,
            fixtureVersion: RAW_HDR_AUTHORIZATION_FIXTURE_VERSION,
            pendingRouteKeys: accumulator.pendingRouteKeys,
            rejectedRouteKeys: accumulator.rejectedRouteKeys,
            renderSettingsVersion: RENDER_SETTINGS_VERSION,
            status: getAuthorizationTelemetryStatus(accumulator),
            targetFormat
        };
    }

    private getDeviceCache(device: GPUDevice): DeviceProbeCache {
        const existingCache = this.devices.get(device);
        if (existingCache) {
            return existingCache;
        }
        const deviceCache: DeviceProbeCache = {
            lossObserved: false,
            routes: new Map<string, CachedRouteProbe>()
        };
        this.devices.set(device, deviceCache);
        if (!deviceCache.lossObserved) {
            deviceCache.lossObserved = true;
            void device.lost.then((): void => {
                this.devices.delete(device);
            });
        }
        return deviceCache;
    }
}
