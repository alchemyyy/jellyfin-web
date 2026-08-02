import {
    createHDRToSDRRenderSettings,
    RENDER_SETTINGS_VERSION,
    type HDRToSDRRenderSettings
} from '../RenderSettings';
import { createPQColorMetadata } from '../color/ColorMetadata';
import {
    processEncodedYUV,
    processEncodedRGB,
    type ColorTriplet
} from '../color/ColorPipeline';
import {
    createRawDolbyVisionColorPipelineWGSL,
    createRawDolbyVisionProfile7ColorPipelineWGSL
} from '../color/ColorPipelineShader';
import { reconstructDolbyVisionBT2020PQ } from '../color/DolbyVisionColorTransform';
import { DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH } from '../custom/DolbyVisionRPUParser';
import type { SupportedRawVideoFrameFormat } from '../custom/RawVideoFrameCopy';
import {
    createRawYUVRenderPipeline,
    createRawYUVRenderResources,
    destroyRawPlaneTextureSet,
    renderRawYUVFrame,
    type RawPlaneTextureSet,
    type RawYUVTexturePresentation
} from '../RawYUVGPURenderer';
import { createDolbyVisionAuthorizationRPUFixture } from './DolbyVisionAuthorizationFixture';
import GPUAuthorizationDeadline from './GPUAuthorizationDeadline';
import {
    GPUCanvasPixelReader,
    getValidationTextureUsage
} from './GPUCanvasReadback';
import {
    calculateRawHDRAuthorizationOutputDither,
    createRawHDRAuthorizationFixture,
    evaluateRawHDRFixtureObservations,
    RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES,
    sampleRawI420P10Frame,
    type RawHDRFixtureObservation
} from './RawHDRPresentationAuthorization';

export const DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION = 3;
export const DOLBY_VISION_AUTHORIZATION_ROUTE_KEY = 'I420P10:dovi-rpu-v1';
export const DOLBY_VISION_PROFILE7_AUTHORIZATION_ROUTE_KEY =
    'I420P10:dovi-profile7-base-v1';

export type DolbyVisionAuthorizationRoute = 'profile7-base' | 'single-layer';
export type DolbyVisionAuthorizationRouteKey =
    | typeof DOLBY_VISION_AUTHORIZATION_ROUTE_KEY
    | typeof DOLBY_VISION_PROFILE7_AUTHORIZATION_ROUTE_KEY;

const MAXIMUM_10_BIT_CODE = 1_023;
const AUTHORIZED_TARGET_FORMATS = new Set<GPUTextureFormat>([
    'bgra8unorm',
    'rgba8unorm'
]);

export type DolbyVisionAuthorizationFailureReason =
    | 'device-lost'
    | 'gpu-api-unavailable'
    | 'gpu-validation-failed'
    | 'pixel-mismatch'
    | 'readback-failed'
    | 'route-unsupported'
    | 'target-format-unsupported'
    | 'timeout'
    | 'unexpected-error';

export type DolbyVisionAuthorizationDecision = {
    device: GPUDevice
    failureReason: DolbyVisionAuthorizationFailureReason | null
    fixtureVersion: typeof DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION
    maximumChannelError: number | null
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    routeKey: DolbyVisionAuthorizationRouteKey
    sampleCount: number
    shaderSignature: string
    status: 'authorized' | 'rejected'
    targetFormat: GPUTextureFormat
};

export type DolbyVisionAuthorizationTelemetry = {
    failureReason: DolbyVisionAuthorizationFailureReason | null
    fixtureVersion: typeof DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION
    maximumChannelError: number | null
    renderSettingsVersion: typeof RENDER_SETTINGS_VERSION
    routeKey: DolbyVisionAuthorizationRouteKey
    sampleCount: number
    status: 'authorized' | 'pending' | 'rejected' | 'unavailable'
    targetFormat: GPUTextureFormat | null
};

type CachedProbe = {
    decision: DolbyVisionAuthorizationDecision | null
    promise: Promise<DolbyVisionAuthorizationDecision>
};

type DeviceProbeCache = {
    probes: Map<string, CachedProbe>
};

type DolbyVisionAuthorizationScenario = {
    expectedObservations: readonly RawHDRFixtureObservation[]
    packedRPUData: ArrayBuffer
};

export type DolbyVisionAuthorizationObservationMode =
    | 'fel-hdr10-base'
    | 'reconstruct';

const FULL_FRAME_PRESENTATION: RawYUVTexturePresentation = {
    textureOffsetX: 0,
    textureOffsetY: 0,
    textureScaleX: 1,
    textureScaleY: 1,
    viewportHeight: 8,
    viewportWidth: 16,
    viewportX: 0,
    viewportY: 0
};

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function createSettings(): HDRToSDRRenderSettings {
    return createHDRToSDRRenderSettings({
        toneMapping: { inputPeakNits: 4_000 }
    });
}

/** Creates a stable identity for the exact DV fixture, shader, and target. */
export function createDolbyVisionShaderSignature(
    targetFormat: GPUTextureFormat,
    shaderCode: string
): string {
    const signatureInput = [
        `fixture=${DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION}`,
        `uniform=${RENDER_SETTINGS_VERSION}`,
        `schema=${DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH}`,
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

/** Computes CPU-reference samples for the exact synthetic authorization fixture. */
export function createExpectedDolbyVisionAuthorizationObservations(
    packedRPUData: ArrayBuffer,
    settings: HDRToSDRRenderSettings,
    mode: DolbyVisionAuthorizationObservationMode = 'reconstruct'
): readonly RawHDRFixtureObservation[] {
    const frame = createRawHDRAuthorizationFixture(
        'I420P10:bt2020-ncl:bt2020:limited:pq'
    );
    const outputMetadata = createPQColorMetadata({ range: 'full' });
    return RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES.map(sample => {
        const rawSignal = sampleRawI420P10Frame(frame, sample.sampleX, sample.sampleY);
        const normalizedSignal: ColorTriplet = [
            rawSignal[0] / MAXIMUM_10_BIT_CODE,
            rawSignal[1] / MAXIMUM_10_BIT_CODE,
            rawSignal[2] / MAXIMUM_10_BIT_CODE
        ];
        const referenceRGB = mode === 'fel-hdr10-base' ?
            processEncodedYUV(
                normalizedSignal,
                createPQColorMetadata(),
                settings
            ) :
            processEncodedRGB(
                reconstructDolbyVisionBT2020PQ(
                    normalizedSignal,
                    packedRPUData
                ),
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

function getAuthorizationRouteKey(
    route: DolbyVisionAuthorizationRoute
): DolbyVisionAuthorizationRouteKey {
    return route === 'profile7-base' ?
        DOLBY_VISION_PROFILE7_AUTHORIZATION_ROUTE_KEY :
        DOLBY_VISION_AUTHORIZATION_ROUTE_KEY;
}

function createAuthorizationShader(
    route: DolbyVisionAuthorizationRoute,
    settings: HDRToSDRRenderSettings
): string {
    return route === 'profile7-base' ?
        createRawDolbyVisionProfile7ColorPipelineWGSL(settings, 'I420P10') :
        createRawDolbyVisionColorPipelineWGSL(settings, 'I420P10');
}

function createAuthorizationScenarios(
    route: DolbyVisionAuthorizationRoute,
    settings: HDRToSDRRenderSettings
): DolbyVisionAuthorizationScenario[] {
    const scenarios: DolbyVisionAuthorizationScenario[] = [];
    if (route === 'single-layer') {
        const packedRPUData = createDolbyVisionAuthorizationRPUFixture();
        scenarios.push({
            expectedObservations: createExpectedDolbyVisionAuthorizationObservations(
                packedRPUData,
                settings
            ),
            packedRPUData
        });
        return scenarios;
    }

    const melRPUData = createDolbyVisionAuthorizationRPUFixture(7, 'mel');
    scenarios.push({
        expectedObservations: createExpectedDolbyVisionAuthorizationObservations(
            melRPUData,
            settings
        ),
        packedRPUData: melRPUData
    });
    const felRPUData = createDolbyVisionAuthorizationRPUFixture(7, 'fel');
    scenarios.push({
        expectedObservations: createExpectedDolbyVisionAuthorizationObservations(
            felRPUData,
            settings,
            'fel-hdr10-base'
        ),
        packedRPUData: felRPUData
    });
    return scenarios;
}

function classifyFailure(error: unknown): DolbyVisionAuthorizationFailureReason {
    switch (getErrorMessage(error)) {
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
    shaderSignature: string,
    routeKey: DolbyVisionAuthorizationRouteKey,
    failureReason: DolbyVisionAuthorizationFailureReason,
    sampleCount = 0,
    maximumChannelError: number | null = null
): DolbyVisionAuthorizationDecision {
    return {
        device,
        failureReason,
        fixtureVersion: DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION,
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

/** Runs the exact production raw upload, RPU binding, shader, and draw path. */
export class DolbyVisionPresentationAuthorizationRunner {
    public readonly routeKey: DolbyVisionAuthorizationRouteKey;

    public constructor(
        public readonly route: DolbyVisionAuthorizationRoute = 'single-layer'
    ) {
        this.routeKey = getAuthorizationRouteKey(route);
    }

    /** Returns the exact production shader covered by this runner. */
    public createShader(settings: HDRToSDRRenderSettings): string {
        return createAuthorizationShader(this.route, settings);
    }

    public async validate(
        device: GPUDevice,
        targetFormat: GPUTextureFormat
    ): Promise<DolbyVisionAuthorizationDecision> {
        const settings = createSettings();
        const shaderCode = this.createShader(settings);
        const shaderSignature = createDolbyVisionShaderSignature(
            targetFormat,
            shaderCode
        );
        if (!AUTHORIZED_TARGET_FORMATS.has(targetFormat)) {
            return createRejectedDecision(
                device,
                targetFormat,
                shaderSignature,
                this.routeKey,
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
                this.routeKey,
                'gpu-api-unavailable'
            );
        }

        let targetTexture: GPUTexture | null = null;
        let textureSet: RawPlaneTextureSet | null = null;
        let presentationUniformBuffer: GPUBuffer | null = null;
        let renderSettingsUniformBuffer: GPUBuffer | null = null;
        let RPUStorageBuffer: GPUBuffer | null = null;
        let pixelReader: GPUCanvasPixelReader | null = null;
        let errorScopePushed = false;
        const deadline = new GPUAuthorizationDeadline(device);
        try {
            const scenarios = createAuthorizationScenarios(this.route, settings);
            const pipeline = await deadline.wait(
                createRawYUVRenderPipeline(device, targetFormat, shaderCode)
            );
            const resources = createRawYUVRenderResources(device, pipeline, settings);
            presentationUniformBuffer = resources.presentationUniformBuffer;
            renderSettingsUniformBuffer = resources.renderSettingsUniformBuffer;
            RPUStorageBuffer = device.createBuffer({
                label: 'WebGPU Dolby Vision authorization RPU',
                size: DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE
            });
            const frame = createRawHDRAuthorizationFixture(
                'I420P10:bt2020-ncl:bt2020:limited:pq'
            );
            targetTexture = device.createTexture({
                dimension: '2d',
                format: targetFormat,
                label: 'WebGPU Dolby Vision authorization target',
                size: {
                    depthOrArrayLayers: 1,
                    height: frame.displayHeight,
                    width: frame.displayWidth
                },
                usage: targetUsage
            });
            pixelReader = new GPUCanvasPixelReader({
                device,
                format: targetFormat,
                maximumReadbacks: RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES.length
                    * scenarios.length
            });
            let maximumChannelError = 0;
            let sampleCount = 0;
            for (const scenario of scenarios) {
                device.queue.writeBuffer(RPUStorageBuffer, 0, scenario.packedRPUData);
                device.pushErrorScope('validation');
                errorScopePushed = true;
                const renderResult = renderRawYUVFrame({
                    ...resources,
                    device,
                    dolbyVisionRPUStorageBuffer: RPUStorageBuffer,
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
                        shaderSignature,
                        this.routeKey,
                        'gpu-validation-failed'
                    );
                }

                const readback = await deadline.wait(
                    pixelReader.readPixels(RAW_HDR_AUTHORIZATION_FIXTURE_SAMPLES, targetTexture),
                    (): void => pixelReader?.destroy()
                );
                const actualObservations: RawHDRFixtureObservation[] = [];
                if (readback.failure || !readback.linearRGB) {
                    return createRejectedDecision(
                        device,
                        targetFormat,
                        shaderSignature,
                        this.routeKey,
                        'readback-failed'
                    );
                }
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
                const comparison = evaluateRawHDRFixtureObservations(
                    scenario.expectedObservations,
                    actualObservations
                );
                sampleCount += actualObservations.length;
                maximumChannelError = Math.max(
                    maximumChannelError,
                    comparison.maximumChannelError
                );
                if (!comparison.accepted) {
                    return createRejectedDecision(
                        device,
                        targetFormat,
                        shaderSignature,
                        this.routeKey,
                        'pixel-mismatch',
                        sampleCount,
                        maximumChannelError
                    );
                }
            }
            return {
                device,
                failureReason: null,
                fixtureVersion: DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION,
                maximumChannelError,
                renderSettingsVersion: RENDER_SETTINGS_VERSION,
                routeKey: this.routeKey,
                sampleCount,
                shaderSignature,
                status: 'authorized',
                targetFormat
            };
        } catch (error) {
            return createRejectedDecision(
                device,
                targetFormat,
                shaderSignature,
                this.routeKey,
                classifyFailure(error)
            );
        } finally {
            deadline.destroy();
            if (errorScopePushed) {
                discardErrorScope(device);
            }
            pixelReader?.destroy();
            destroyRawPlaneTextureSet(textureSet);
            presentationUniformBuffer?.destroy();
            renderSettingsUniformBuffer?.destroy();
            RPUStorageBuffer?.destroy();
            targetTexture?.destroy();
        }
    }
}

/** Device-scoped cache for the exact Dolby Vision shader authorization. */
export class DolbyVisionPresentationAuthorizationRegistry {
    private readonly devices = new WeakMap<GPUDevice, DeviceProbeCache>();
    private readonly runner: DolbyVisionPresentationAuthorizationRunner;

    public constructor(
        runnerOrRoute: DolbyVisionPresentationAuthorizationRunner | DolbyVisionAuthorizationRoute =
        'single-layer'
    ) {
        this.runner = typeof runnerOrRoute === 'string' ?
            new DolbyVisionPresentationAuthorizationRunner(runnerOrRoute) :
            runnerOrRoute;
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
    ): Promise<DolbyVisionAuthorizationDecision> {
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
            (decision: DolbyVisionAuthorizationDecision): DolbyVisionAuthorizationDecision => {
                probe.decision = decision;
                return decision;
            },
            (): DolbyVisionAuthorizationDecision => {
                const shaderCode = this.runner.createShader(createSettings());
                const decision = createRejectedDecision(
                    device,
                    targetFormat,
                    createDolbyVisionShaderSignature(targetFormat, shaderCode),
                    this.runner.routeKey,
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
        settings: HDRToSDRRenderSettings,
        format: SupportedRawVideoFrameFormat
    ): boolean {
        if (format !== 'I420P10') {
            return false;
        }
        const shaderCode = this.runner.createShader(settings);
        const shaderSignature = createDolbyVisionShaderSignature(targetFormat, shaderCode);
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
    ): DolbyVisionAuthorizationTelemetry {
        const unavailable: DolbyVisionAuthorizationTelemetry = {
            failureReason: null,
            fixtureVersion: DOLBY_VISION_AUTHORIZATION_FIXTURE_VERSION,
            maximumChannelError: null,
            renderSettingsVersion: RENDER_SETTINGS_VERSION,
            routeKey: this.runner.routeKey,
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
            renderSettingsVersion: probe.decision.renderSettingsVersion,
            routeKey: probe.decision.routeKey,
            sampleCount: probe.decision.sampleCount,
            status: probe.decision.status,
            targetFormat: probe.decision.targetFormat
        };
    }

    private createCacheKey(targetFormat: GPUTextureFormat): string {
        const shaderCode = this.runner.createShader(createSettings());
        return `${targetFormat}\u0000${createDolbyVisionShaderSignature(
            targetFormat,
            shaderCode
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
        const created: DeviceProbeCache = { probes: new Map<string, CachedProbe>() };
        this.devices.set(device, created);
        void device.lost.then((): void => {
            created.probes.clear();
        });
        return created;
    }
}
