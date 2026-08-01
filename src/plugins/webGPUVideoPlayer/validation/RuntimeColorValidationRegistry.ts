import { getWebGPUValidationHarnessEnabled } from 'scripts/settings/webSettings';

import {
    assertValidInputColorMetadata,
    type InputColorMetadata
} from '../color/ColorMetadata';
import {
    createTransferValidationRamp,
    type ColorRampSample,
    type ColorValidationRamp,
    type ColorValidationRampOptions
} from '../color/ColorValidation';
import {
    type ColorValidationCapabilityDecision,
    type ColorValidationCaptureRequest,
    type ColorValidationCaptureResult,
    type GPUCanvasColorValidationHarness
} from './ColorValidationHarness';

export type RuntimeColorValidationHarness = Pick<
    GPUCanvasColorValidationHarness,
    'captureCurrentFrame' | 'destroy' | 'evaluate'
>;

export type RuntimeColorValidationSampleContext = {
    generation: number
    isCurrent: () => boolean
    sampleIndex: number
};

export type RuntimeColorValidationCaptureInput = Omit<
    ColorValidationCaptureRequest,
    'timestampMicroseconds'
>;

export type RuntimeColorValidationRequest = {
    createHarness: (
        ramp: ColorValidationRamp,
        generation: number
    ) => RuntimeColorValidationHarness
    device: GPUDevice
    metadata: InputColorMetadata
    rampOptions?: ColorValidationRampOptions
    renderSample: (
        sample: Readonly<ColorRampSample>,
        context: RuntimeColorValidationSampleContext
    ) => Promise<RuntimeColorValidationCaptureInput | undefined>
};

export type RuntimeColorValidationRegistryOptions = {
    isEnabled?: () => Promise<boolean>
};

type ValidationCacheEntry = {
    decision?: ColorValidationCapabilityDecision
    generation: number
    pending?: Promise<ColorValidationCapabilityDecision | null>
};

const MINIMUM_MEASURED_SAMPLE_COUNT = 3;

function createMetadataKey(metadata: InputColorMetadata): string {
    return JSON.stringify([
        metadata.version,
        metadata.bitDepth,
        metadata.matrix,
        metadata.nominalPeakNits,
        metadata.primaries,
        metadata.range,
        metadata.sdrReferenceWhiteNits,
        metadata.transfer
    ]);
}

function metadataMatches(
    left: InputColorMetadata,
    right: InputColorMetadata
): boolean {
    return left.version === right.version
        && left.bitDepth === right.bitDepth
        && left.matrix === right.matrix
        && left.nominalPeakNits === right.nominalPeakNits
        && left.primaries === right.primaries
        && left.range === right.range
        && left.sdrReferenceWhiteNits === right.sdrReferenceWhiteNits
        && left.transfer === right.transfer;
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

function hasValidMeasuredFrames(
    decision: ColorValidationCapabilityDecision,
    metadata: InputColorMetadata
): boolean {
    const validation = decision.validation;
    if (
        decision.capability !== 'supported'
        || decision.classification !== 'valid'
        || decision.readbackFailure !== null
        || !validation
        || !validation.accepted
        || validation.classification !== 'valid'
        || validation.sampleCount < MINIMUM_MEASURED_SAMPLE_COUNT
        || decision.frames.length !== validation.sampleCount
        || decision.observations.length !== validation.sampleCount
        || !decision.browser.secureContext
    ) {
        return false;
    }

    const frameTimestamps = new Set<number>();
    for (const frame of decision.frames) {
        if (
            !Number.isSafeInteger(frame.timestampMicroseconds)
            || !Number.isSafeInteger(frame.codedHeight)
            || frame.codedHeight <= 0
            || !Number.isSafeInteger(frame.codedWidth)
            || frame.codedWidth <= 0
            || !Number.isSafeInteger(frame.displayHeight)
            || frame.displayHeight <= 0
            || !Number.isSafeInteger(frame.displayWidth)
            || frame.displayWidth <= 0
            || !metadataMatches(frame.inputColorMetadata, metadata)
            || frameTimestamps.has(frame.timestampMicroseconds)
        ) {
            return false;
        }
        frameTimestamps.add(frame.timestampMicroseconds);
    }

    const observationTimestamps = new Set<number>();
    for (const observation of decision.observations) {
        if (
            !Number.isSafeInteger(observation.timestampMicroseconds)
            || !observation.linearRGB.every(Number.isFinite)
            || !frameTimestamps.has(observation.timestampMicroseconds)
            || observationTimestamps.has(observation.timestampMicroseconds)
        ) {
            return false;
        }
        observationTimestamps.add(observation.timestampMicroseconds);
    }

    return observationTimestamps.size === frameTimestamps.size;
}

function matchesRampTimestamps(
    decision: ColorValidationCapabilityDecision,
    ramp: ColorValidationRamp
): boolean {
    if (decision.validation?.sampleCount !== ramp.samples.length) {
        return false;
    }

    const expectedTimestamps = new Set<number>();
    for (const sample of ramp.samples) {
        if (expectedTimestamps.has(sample.timestampMicroseconds)) {
            return false;
        }
        expectedTimestamps.add(sample.timestampMicroseconds);
    }

    for (const frame of decision.frames) {
        if (!expectedTimestamps.has(frame.timestampMicroseconds)) {
            return false;
        }
    }

    return true;
}

/** Returns true only for a secure-context decision backed by valid measured frames. */
export function isMeasuredColorValidationDecision(
    decision: ColorValidationCapabilityDecision,
    metadata: InputColorMetadata
): boolean {
    try {
        assertValidInputColorMetadata(metadata);
    } catch {
        return false;
    }

    return hasValidMeasuredFrames(decision, metadata);
}

function snapshotDecision(
    decision: ColorValidationCapabilityDecision
): ColorValidationCapabilityDecision {
    return {
        browser: {
            colorGamut: decision.browser.colorGamut,
            dynamicRange: decision.browser.dynamicRange,
            language: decision.browser.language,
            secureContext: decision.browser.secureContext,
            userAgent: decision.browser.userAgent
        },
        canvas: {
            alphaMode: decision.canvas.alphaMode,
            colorSpace: decision.canvas.colorSpace,
            format: decision.canvas.format,
            height: decision.canvas.height,
            toneMappingMode: decision.canvas.toneMappingMode,
            width: decision.canvas.width
        },
        capability: decision.capability,
        classification: decision.classification,
        frames: decision.frames.map(frame => ({
            codedHeight: frame.codedHeight,
            codedWidth: frame.codedWidth,
            displayHeight: frame.displayHeight,
            displayWidth: frame.displayWidth,
            inputColorMetadata: snapshotInputMetadata(frame.inputColorMetadata),
            timestampMicroseconds: frame.timestampMicroseconds,
            videoColorSpace: frame.videoColorSpace ? {
                fullRange: frame.videoColorSpace.fullRange,
                matrix: frame.videoColorSpace.matrix,
                primaries: frame.videoColorSpace.primaries,
                transfer: frame.videoColorSpace.transfer
            } : null
        })),
        gpu: {
            architecture: decision.gpu.architecture,
            description: decision.gpu.description,
            device: decision.gpu.device,
            deviceLabel: decision.gpu.deviceLabel,
            features: [ ...decision.gpu.features ],
            maximumTextureDimension2D: decision.gpu.maximumTextureDimension2D,
            vendor: decision.gpu.vendor
        },
        observations: decision.observations.map(observation => ({
            linearRGB: [ ...observation.linearRGB ],
            timestampMicroseconds: observation.timestampMicroseconds
        })),
        readbackFailure: decision.readbackFailure ? {
            code: decision.readbackFailure.code,
            message: decision.readbackFailure.message
        } : null,
        validation: decision.validation ? {
            accepted: decision.validation.accepted,
            classification: decision.validation.classification,
            maximumAbsoluteError: decision.validation.maximumAbsoluteError,
            rootMeanSquareError: decision.validation.rootMeanSquareError,
            sampleCount: decision.validation.sampleCount
        } : null
    };
}

/**
 * Runs and caches color validation by exact GPUDevice identity and canonical
 * input metadata. The cache is memory-only and never stores media URLs.
 */
export class RuntimeColorValidationRegistry {
    private decisionsByDevice = new WeakMap<GPUDevice, Map<string, ValidationCacheEntry>>();
    private destroyed = false;
    private generation = 0;
    private readonly isEnabled: () => Promise<boolean>;
    private readonly watchedDevices = new WeakSet<GPUDevice>();

    public constructor(options: RuntimeColorValidationRegistryOptions = {}) {
        this.isEnabled = options.isEnabled ?? getWebGPUValidationHarnessEnabled;
    }

    /** Returns a cached decision when the feature remains enabled. */
    public async getCachedDecision(
        device: GPUDevice,
        metadata: InputColorMetadata
    ): Promise<ColorValidationCapabilityDecision | null> {
        if (this.destroyed || !this.isValidMetadata(metadata)) {
            return null;
        }

        const metadataKey = createMetadataKey(metadata);
        const entry = this.decisionsByDevice.get(device)?.get(metadataKey);
        if (!entry?.decision || !await this.readFeatureFlag()) {
            return null;
        }

        const currentEntry = this.decisionsByDevice.get(device)?.get(metadataKey);
        if (currentEntry !== entry || !currentEntry.decision) {
            return null;
        }

        const decision = currentEntry.decision;
        if (
            decision.capability === 'supported'
            && !isMeasuredColorValidationDecision(decision, metadata)
        ) {
            this.decisionsByDevice.get(device)?.delete(metadataKey);
            return null;
        }

        return snapshotDecision(decision);
    }

    /** Runs one bounded reference ramp or reuses the exact cached/in-flight result. */
    public async validate(
        validationRequest: RuntimeColorValidationRequest
    ): Promise<ColorValidationCapabilityDecision | null> {
        if (this.destroyed || !this.isValidMetadata(validationRequest.metadata)) {
            return null;
        }

        const metadataKey = createMetadataKey(validationRequest.metadata);
        const entries = this.getDeviceEntries(validationRequest.device);
        const existingEntry = entries.get(metadataKey);
        if (existingEntry?.decision) {
            return this.getCachedDecision(validationRequest.device, validationRequest.metadata);
        }
        if (existingEntry?.pending) {
            const pendingDecision = await existingEntry.pending;
            return pendingDecision ? snapshotDecision(pendingDecision) : null;
        }

        const generation = this.nextGeneration();
        const pending = this.executeValidation(validationRequest, metadataKey, generation);
        entries.set(metadataKey, { generation, pending });
        const decision = await pending;
        return decision ? snapshotDecision(decision) : null;
    }

    /** Invalidates one metadata entry or every entry associated with a GPU device. */
    public invalidate(device: GPUDevice, metadata?: InputColorMetadata): void {
        if (this.destroyed) {
            return;
        }

        this.nextGeneration();
        if (metadata) {
            this.decisionsByDevice.get(device)?.delete(createMetadataKey(metadata));
            return;
        }

        this.decisionsByDevice.delete(device);
    }

    /** Invalidates all cached and in-flight validation without retaining GPU devices. */
    public invalidateAll(): void {
        if (this.destroyed) {
            return;
        }

        this.nextGeneration();
        this.decisionsByDevice = new WeakMap<GPUDevice, Map<string, ValidationCacheEntry>>();
    }

    /** Permanently stops the registry and discards every cached decision. */
    public destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.nextGeneration();
        this.decisionsByDevice = new WeakMap<GPUDevice, Map<string, ValidationCacheEntry>>();
    }

    private async executeValidation(
        validationRequest: RuntimeColorValidationRequest,
        metadataKey: string,
        generation: number
    ): Promise<ColorValidationCapabilityDecision | null> {
        if (
            !await this.readFeatureFlag()
            || !this.isCurrent(validationRequest.device, metadataKey, generation)
        ) {
            this.removeCurrentEntry(validationRequest.device, metadataKey, generation);
            return null;
        }

        const ramp = createTransferValidationRamp(
            validationRequest.metadata,
            validationRequest.rampOptions
        );
        let harness: RuntimeColorValidationHarness;
        try {
            harness = validationRequest.createHarness(ramp, generation);
        } catch {
            this.removeCurrentEntry(validationRequest.device, metadataKey, generation);
            return null;
        }

        let decision: ColorValidationCapabilityDecision | null = null;
        try {
            for (let sampleIndex = 0; sampleIndex < ramp.samples.length; sampleIndex += 1) {
                if (!this.isCurrent(validationRequest.device, metadataKey, generation)) {
                    return null;
                }

                const sample = ramp.samples[sampleIndex];
                const captureInput = await validationRequest.renderSample(sample, {
                    generation,
                    isCurrent: (): boolean => this.isCurrent(
                        validationRequest.device,
                        metadataKey,
                        generation
                    ),
                    sampleIndex
                });
                if (!this.isCurrent(validationRequest.device, metadataKey, generation)) {
                    return null;
                }

                const captureResult: ColorValidationCaptureResult =
                    await harness.captureCurrentFrame({
                        ...captureInput,
                        timestampMicroseconds: sample.timestampMicroseconds
                    });
                if (!this.isCurrent(validationRequest.device, metadataKey, generation)) {
                    return null;
                }
                if (captureResult.failure || !captureResult.observation) {
                    break;
                }
            }

            decision = harness.evaluate();
        } catch {
            decision = null;
        } finally {
            harness.destroy();
        }

        if (
            !decision
            || !this.isCurrent(validationRequest.device, metadataKey, generation)
            || !await this.readFeatureFlag()
            || !this.isCurrent(validationRequest.device, metadataKey, generation)
        ) {
            this.removeCurrentEntry(validationRequest.device, metadataKey, generation);
            return null;
        }

        if (
            decision.capability === 'supported'
            && (
                !isMeasuredColorValidationDecision(decision, validationRequest.metadata)
                || !matchesRampTimestamps(decision, ramp)
            )
        ) {
            this.removeCurrentEntry(validationRequest.device, metadataKey, generation);
            return null;
        }

        const storedDecision = snapshotDecision(decision);
        this.decisionsByDevice.get(validationRequest.device)?.set(metadataKey, {
            decision: storedDecision,
            generation
        });
        return storedDecision;
    }

    private getDeviceEntries(device: GPUDevice): Map<string, ValidationCacheEntry> {
        const existingEntries = this.decisionsByDevice.get(device);
        if (existingEntries) {
            return existingEntries;
        }

        const entries = new Map<string, ValidationCacheEntry>();
        this.decisionsByDevice.set(device, entries);
        this.watchDeviceLoss(device);
        return entries;
    }

    private isCurrent(device: GPUDevice, metadataKey: string, generation: number): boolean {
        return !this.destroyed
            && this.decisionsByDevice.get(device)?.get(metadataKey)?.generation === generation;
    }

    private isValidMetadata(metadata: InputColorMetadata): boolean {
        try {
            assertValidInputColorMetadata(metadata);
            return true;
        } catch {
            return false;
        }
    }

    private nextGeneration(): number {
        this.generation += 1;
        return this.generation;
    }

    private async readFeatureFlag(): Promise<boolean> {
        try {
            return await this.isEnabled();
        } catch {
            return false;
        }
    }

    private removeCurrentEntry(
        device: GPUDevice,
        metadataKey: string,
        generation: number
    ): void {
        if (this.decisionsByDevice.get(device)?.get(metadataKey)?.generation === generation) {
            this.decisionsByDevice.get(device)?.delete(metadataKey);
        }
    }

    private watchDeviceLoss(device: GPUDevice): void {
        if (this.watchedDevices.has(device)) {
            return;
        }

        this.watchedDevices.add(device);
        void device.lost.then((): void => {
            this.invalidate(device);
        }).catch((): void => {
            this.invalidate(device);
        });
    }
}
