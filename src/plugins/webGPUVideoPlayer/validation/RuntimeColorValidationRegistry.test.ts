import { describe, expect, it, vi } from 'vitest';

import {
    createHLGColorMetadata,
    createPQColorMetadata,
    type InputColorMetadata
} from '../color/ColorMetadata';
import {
    type ColorRampObservation,
    type ColorValidationRamp
} from '../color/ColorValidation';
import {
    type ColorValidationCapabilityDecision,
    type ColorValidationCaptureRequest,
    type ColorValidationCaptureResult,
    type ReferenceFrameColorMetadata
} from './ColorValidationHarness';
import {
    isMeasuredColorValidationDecision,
    RuntimeColorValidationRegistry,
    type RuntimeColorValidationHarness,
    type RuntimeColorValidationRequest
} from './RuntimeColorValidationRegistry';

type Deferred = {
    promise: Promise<void>
    resolve: () => void
};

type TestDevice = {
    device: GPUDevice
    lose: () => void
};

type HarnessOverrides = {
    decision?: (
        ramp: ColorValidationRamp,
        frames: readonly ReferenceFrameColorMetadata[],
        observations: readonly ColorRampObservation[]
    ) => ColorValidationCapabilityDecision
};

function createDeferred(): Deferred {
    let resolvePromise: () => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    const promise = new Promise<void>(resolve => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

function createDevice(): TestDevice {
    const deviceLost = createDeferred();
    return {
        device: {
            lost: deviceLost.promise
        } as unknown as GPUDevice,
        lose: deviceLost.resolve
    };
}

function createDecision(
    ramp: ColorValidationRamp,
    frames: readonly ReferenceFrameColorMetadata[],
    observations: readonly ColorRampObservation[],
    capability: ColorValidationCapabilityDecision['capability'] = 'supported'
): ColorValidationCapabilityDecision {
    const accepted = capability === 'supported';
    return {
        browser: {
            colorGamut: 'display-p3',
            dynamicRange: 'high',
            language: 'en-US',
            secureContext: true,
            userAgent: 'Runtime validation test'
        },
        canvas: {
            alphaMode: 'opaque',
            colorSpace: 'srgb',
            format: 'rgba16float',
            height: 16,
            toneMappingMode: 'extended',
            width: 16
        },
        capability,
        classification: accepted ? 'valid' : 'mismatch',
        frames,
        gpu: {
            architecture: 'test-architecture',
            description: 'test-gpu',
            device: 'test-device',
            deviceLabel: 'test-label',
            features: [ 'float32-filterable' ],
            maximumTextureDimension2D: 8_192,
            vendor: 'test-vendor'
        },
        observations,
        readbackFailure: null,
        validation: {
            accepted,
            classification: accepted ? 'valid' : 'mismatch',
            maximumAbsoluteError: accepted ? 0 : 1,
            rootMeanSquareError: accepted ? 0 : 1,
            sampleCount: ramp.samples.length
        }
    };
}

function createHarness(
    ramp: ColorValidationRamp,
    overrides: HarnessOverrides = {}
): RuntimeColorValidationHarness & { destroy: ReturnType<typeof vi.fn> } {
    const frames: ReferenceFrameColorMetadata[] = [];
    const observations: ColorRampObservation[] = [];
    const destroy = vi.fn();
    return {
        captureCurrentFrame: async (
            request: ColorValidationCaptureRequest
        ): Promise<ColorValidationCaptureResult> => {
            const sample = ramp.samples.find(candidate =>
                candidate.timestampMicroseconds === request.timestampMicroseconds
            );
            if (!sample) {
                return {
                    failure: {
                        code: 'validation-error',
                        message: 'Unexpected sample timestamp'
                    },
                    observation: null
                };
            }

            const observation: ColorRampObservation = {
                linearRGB: [ ...sample.expectedLinearRGB ],
                timestampMicroseconds: request.timestampMicroseconds
            };
            observations.push(observation);
            frames.push({
                codedHeight: request.frame?.codedHeight ?? 16,
                codedWidth: request.frame?.codedWidth ?? 16,
                displayHeight: request.frame?.displayHeight ?? 16,
                displayWidth: request.frame?.displayWidth ?? 16,
                inputColorMetadata: { ...ramp.metadata },
                timestampMicroseconds: request.timestampMicroseconds,
                videoColorSpace: request.frame?.videoColorSpace ?? null
            });
            return { failure: null, observation };
        },
        destroy,
        evaluate: (): ColorValidationCapabilityDecision =>
            overrides.decision?.(ramp, frames, observations)
            ?? createDecision(ramp, frames, observations)
    };
}

function createRequest(
    device: GPUDevice,
    metadata: InputColorMetadata,
    createHarnessOverride?: RuntimeColorValidationRequest['createHarness']
): RuntimeColorValidationRequest {
    return {
        createHarness: createHarnessOverride ?? ((ramp: ColorValidationRamp) =>
            createHarness(ramp)),
        device,
        metadata,
        renderSample: async () => undefined
    };
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('RuntimeColorValidationRegistry', () => {
    it('does not create a harness when the feature is disabled', async () => {
        const device = createDevice();
        const createHarnessMock = vi.fn((ramp: ColorValidationRamp) => createHarness(ramp));
        const registry = new RuntimeColorValidationRegistry({
            isEnabled: async () => false
        });

        await expect(registry.validate(createRequest(
            device.device,
            createPQColorMetadata(),
            createHarnessMock
        ))).resolves.toBeNull();
        expect(createHarnessMock).not.toHaveBeenCalled();
    });

    it('produces and retrieves a measured HDR decision', async () => {
        const device = createDevice();
        const metadata = createPQColorMetadata();
        const createHarnessMock = vi.fn((ramp: ColorValidationRamp) => createHarness(ramp));
        const renderSample = vi.fn(async () => ({
            frame: {
                codedHeight: 2_160,
                codedWidth: 3_840,
                displayHeight: 2_160,
                displayWidth: 3_840
            }
        }));
        const registry = new RuntimeColorValidationRegistry({
            isEnabled: async () => true
        });
        const request = createRequest(device.device, metadata, createHarnessMock);
        request.renderSample = renderSample;

        const produced = await registry.validate(request);
        const cached = await registry.getCachedDecision(device.device, metadata);

        expect(produced?.capability).toBe('supported');
        expect(produced && isMeasuredColorValidationDecision(produced, metadata)).toBe(true);
        expect(cached).toEqual(produced);
        expect(cached).not.toBe(produced);
        expect(createHarnessMock).toHaveBeenCalledOnce();
        expect(renderSample).toHaveBeenCalledTimes(5);
    });

    it('reuses one in-flight validation and returns isolated snapshots', async () => {
        const device = createDevice();
        const renderStarted = createDeferred();
        const releaseRender = createDeferred();
        const createHarnessMock = vi.fn((ramp: ColorValidationRamp) => createHarness(ramp));
        const request = createRequest(device.device, createPQColorMetadata(), createHarnessMock);
        let renderCount = 0;
        request.renderSample = async () => {
            renderCount += 1;
            if (renderCount === 1) {
                renderStarted.resolve();
                await releaseRender.promise;
            }
            return undefined;
        };
        const registry = new RuntimeColorValidationRegistry({
            isEnabled: async () => true
        });

        const firstValidation = registry.validate(request);
        await renderStarted.promise;
        const secondValidation = registry.validate(request);
        releaseRender.resolve();
        const [ firstDecision, secondDecision ] = await Promise.all([
            firstValidation,
            secondValidation
        ]);

        expect(firstDecision).toEqual(secondDecision);
        expect(firstDecision).not.toBe(secondDecision);
        expect(createHarnessMock).toHaveBeenCalledOnce();
    });

    it('rejects a claimed HDR result without measured frames', async () => {
        const device = createDevice();
        const metadata = createHLGColorMetadata();
        const registry = new RuntimeColorValidationRegistry({
            isEnabled: async () => true
        });
        const request = createRequest(
            device.device,
            metadata,
            (ramp: ColorValidationRamp) => createHarness(ramp, {
                decision: () => createDecision(ramp, [], [])
            })
        );

        await expect(registry.validate(request)).resolves.toBeNull();
        await expect(registry.getCachedDecision(device.device, metadata)).resolves.toBeNull();
    });

    it('rejects a measured result whose frame metadata does not match the key', async () => {
        const device = createDevice();
        const metadata = createPQColorMetadata();
        const registry = new RuntimeColorValidationRegistry({
            isEnabled: async () => true
        });
        const request = createRequest(
            device.device,
            metadata,
            (ramp: ColorValidationRamp) => createHarness(ramp, {
                decision: (
                    currentRamp: ColorValidationRamp,
                    frames: readonly ReferenceFrameColorMetadata[],
                    observations: readonly ColorRampObservation[]
                ) => createDecision(
                    currentRamp,
                    frames.map(frame => ({
                        ...frame,
                        inputColorMetadata: createHLGColorMetadata()
                    })),
                    observations
                )
            })
        );

        await expect(registry.validate(request)).resolves.toBeNull();
    });

    it('caches unsupported diagnostics without treating them as accepted', async () => {
        const device = createDevice();
        const metadata = createPQColorMetadata();
        const registry = new RuntimeColorValidationRegistry({
            isEnabled: async () => true
        });
        const request = createRequest(
            device.device,
            metadata,
            (ramp: ColorValidationRamp) => createHarness(ramp, {
                decision: (
                    currentRamp: ColorValidationRamp,
                    frames: readonly ReferenceFrameColorMetadata[],
                    observations: readonly ColorRampObservation[]
                ) => createDecision(currentRamp, frames, observations, 'unsupported')
            })
        );

        const produced = await registry.validate(request);
        const cached = await registry.getCachedDecision(device.device, metadata);

        expect(produced?.capability).toBe('unsupported');
        expect(cached?.capability).toBe('unsupported');
        expect(cached && isMeasuredColorValidationDecision(cached, metadata)).toBe(false);
    });

    it('strips unrecognized source and credential fields from snapshots', async () => {
        const device = createDevice();
        const metadata = createPQColorMetadata();
        const registry = new RuntimeColorValidationRegistry({
            isEnabled: async () => true
        });
        const request = createRequest(
            device.device,
            metadata,
            (ramp: ColorValidationRamp) => createHarness(ramp, {
                decision: (
                    currentRamp: ColorValidationRamp,
                    frames: readonly ReferenceFrameColorMetadata[],
                    observations: readonly ColorRampObservation[]
                ) => {
                    const decision = createDecision(currentRamp, frames, observations) as
                        ColorValidationCapabilityDecision & {
                            accessToken: string
                            sourceUrl: string
                        };
                    decision.accessToken = 'secret-token';
                    decision.sourceUrl = 'https://media.invalid/video?api_key=secret-token';
                    const firstFrame = decision.frames[0];
                    (firstFrame.inputColorMetadata as InputColorMetadata & {
                        sourceUrl: string
                    }).sourceUrl = decision.sourceUrl;
                    return decision;
                }
            })
        );

        const produced = await registry.validate(request);
        const cached = await registry.getCachedDecision(device.device, metadata);

        expect(JSON.stringify(produced)).not.toContain('secret-token');
        expect(JSON.stringify(cached)).not.toContain('media.invalid');
    });

    it('invalidates one metadata key without affecting another key', async () => {
        const device = createDevice();
        const pqMetadata = createPQColorMetadata();
        const hlgMetadata = createHLGColorMetadata();
        const registry = new RuntimeColorValidationRegistry({
            isEnabled: async () => true
        });

        await registry.validate(createRequest(device.device, pqMetadata));
        await registry.validate(createRequest(device.device, hlgMetadata));
        registry.invalidate(device.device, pqMetadata);

        await expect(registry.getCachedDecision(device.device, pqMetadata)).resolves.toBeNull();
        await expect(
            registry.getCachedDecision(device.device, hlgMetadata)
        ).resolves.toMatchObject({ capability: 'supported' });
    });

    it('does not reuse a decision for another GPU device', async () => {
        const firstDevice = createDevice();
        const secondDevice = createDevice();
        const metadata = createPQColorMetadata();
        const registry = new RuntimeColorValidationRegistry({
            isEnabled: async () => true
        });

        await registry.validate(createRequest(firstDevice.device, metadata));

        await expect(
            registry.getCachedDecision(secondDevice.device, metadata)
        ).resolves.toBeNull();
    });

    it('discards a validation invalidated while a sample is rendering', async () => {
        const device = createDevice();
        const metadata = createPQColorMetadata();
        const renderStarted = createDeferred();
        const releaseRender = createDeferred();
        const destroyHarness = vi.fn();
        const sampleState: { isCurrent?: () => boolean } = {};
        const request = createRequest(
            device.device,
            metadata,
            (ramp: ColorValidationRamp) => {
                const harness = createHarness(ramp);
                harness.destroy = destroyHarness;
                return harness;
            }
        );
        request.renderSample = async (_sample, context) => {
            sampleState.isCurrent = context.isCurrent;
            renderStarted.resolve();
            await releaseRender.promise;
            return undefined;
        };
        const registry = new RuntimeColorValidationRegistry({
            isEnabled: async () => true
        });

        const validation = registry.validate(request);
        await renderStarted.promise;
        registry.invalidate(device.device, metadata);
        expect(sampleState.isCurrent?.()).toBe(false);
        releaseRender.resolve();

        await expect(validation).resolves.toBeNull();
        expect(destroyHarness).toHaveBeenCalledOnce();
        await expect(registry.getCachedDecision(device.device, metadata)).resolves.toBeNull();
    });

    it('discards a completed measurement when the feature is disabled before caching', async () => {
        const device = createDevice();
        const metadata = createPQColorMetadata();
        let featureReadCount = 0;
        const registry = new RuntimeColorValidationRegistry({
            isEnabled: async () => {
                featureReadCount += 1;
                return featureReadCount !== 2;
            }
        });

        await expect(
            registry.validate(createRequest(device.device, metadata))
        ).resolves.toBeNull();
        await expect(registry.getCachedDecision(device.device, metadata)).resolves.toBeNull();
    });

    it('invalidates cached decisions when the GPU device is lost', async () => {
        const device = createDevice();
        const metadata = createPQColorMetadata();
        const registry = new RuntimeColorValidationRegistry({
            isEnabled: async () => true
        });

        await registry.validate(createRequest(device.device, metadata));
        device.lose();
        await flushMicrotasks();

        await expect(registry.getCachedDecision(device.device, metadata)).resolves.toBeNull();
    });

    it('discards cached and in-flight decisions when destroyed', async () => {
        const device = createDevice();
        const metadata = createPQColorMetadata();
        const registry = new RuntimeColorValidationRegistry({
            isEnabled: async () => true
        });

        await registry.validate(createRequest(device.device, metadata));
        registry.destroy();

        await expect(registry.getCachedDecision(device.device, metadata)).resolves.toBeNull();
        await expect(
            registry.validate(createRequest(device.device, metadata))
        ).resolves.toBeNull();
    });
});
