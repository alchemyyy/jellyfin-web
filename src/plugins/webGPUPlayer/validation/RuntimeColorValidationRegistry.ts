import { getWebGPUValidationHarnessEnabled } from 'scripts/settings/webSettings';

import {
    assertValidInputColorMetadata,
    type InputColorMetadata
} from '../color/ColorMetadata';
import {
    microsecondsToMilliseconds,
    millisecondsToMicroseconds
} from '../MediaTime';
import {
    createColorValidationRampCacheSignature,
    createTransferValidationRamp,
    type ColorRampSample,
    type ColorValidationRamp,
    type ColorValidationRampOptions
} from '../color/ColorValidation';
import {
    type ColorValidationCapabilityDecision,
    type ColorValidationCaptureRequest,
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
    signal: AbortSignal
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
    cancellation?: ValidationCancellation
    decision?: ColorValidationCapabilityDecision
    generation: number
    pending?: Promise<ColorValidationCapabilityDecision | null>
};

type ValidationCancellation = {
    cancel: () => void
    promise: Promise<typeof VALIDATION_OPERATION_CANCELLED>
    signal: AbortSignal
};

const MINIMUM_MEASURED_SAMPLE_COUNT = 3;
const VALIDATION_KEY_SEPARATOR = '\u0000';
export const RUNTIME_COLOR_VALIDATION_SAMPLE_TIMEOUT_MICROSECONDS =
    millisecondsToMicroseconds(5_000);
const VALIDATION_OPERATION_CANCELLED = Symbol('validation-operation-cancelled');
const VALIDATION_OPERATION_TIMEOUT = Symbol('validation-operation-timeout');

function createValidationCancellation(): ValidationCancellation {
    // WebGPU validation already requires a current secure-context browser
    // eslint-disable-next-line compat/compat
    const abortController = new AbortController();
    let cancelled = false;
    let resolveCancellation: (
        result: typeof VALIDATION_OPERATION_CANCELLED
    ) => void = (result: typeof VALIDATION_OPERATION_CANCELLED): void => {
        if (result === VALIDATION_OPERATION_CANCELLED) {
            return;
        }
    };
    const promise = new Promise<typeof VALIDATION_OPERATION_CANCELLED>(resolve => {
        resolveCancellation = resolve;
    });

    return {
        cancel: (): void => {
            if (cancelled) {
                return;
            }

            cancelled = true;
            abortController.abort();
            resolveCancellation(VALIDATION_OPERATION_CANCELLED);
        },
        promise,
        signal: abortController.signal
    };
}

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

function createValidationKey(
    ramp: ColorValidationRamp
): string {
    return `${createMetadataKey(ramp.metadata)}${VALIDATION_KEY_SEPARATOR}`
        + createColorValidationRampCacheSignature(ramp);
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
        || !decision.diagnostic
        || decision.diagnostic.productionAuthorization !== false
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

function matchesRampIdentity(
    decision: ColorValidationCapabilityDecision,
    ramp: ColorValidationRamp
): boolean {
    return Boolean(decision.diagnostic?.rampIdentity)
        && decision.diagnostic.rampIdentity.version === ramp.identity.version
        && decision.diagnostic.rampIdentity.kind === ramp.identity.kind
        && decision.diagnostic.rampIdentity.hash === ramp.identity.hash;
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

/** Returns true only for a secure-context diagnostic backed by measured frames. */
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

/**
 * Returns true for a measured external-texture conversion diagnostic. This is
 * never production authorization because imported textures are browser-converted.
 */
export function isMeasuredExternalTextureDiagnosticDecision(
    decision: ColorValidationCapabilityDecision,
    metadata: InputColorMetadata
): boolean {
    return decision.diagnostic?.kind === 'external-texture-conversion'
        && isMeasuredColorValidationDecision(decision, metadata);
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
        diagnostic: {
            kind: decision.diagnostic.kind,
            productionAuthorization: false,
            rampIdentity: { ...decision.diagnostic.rampIdentity }
        },
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
 * Runs and caches diagnostics by exact GPUDevice, metadata, and complete ramp
 * signature. The cache is memory-only and never stores media URLs.
 */
export class RuntimeColorValidationRegistry {
    private readonly activeCancellations = new Set<ValidationCancellation>();
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
        metadata: InputColorMetadata,
        rampOptions: ColorValidationRampOptions = {}
    ): Promise<ColorValidationCapabilityDecision | null> {
        if (this.destroyed || !this.isValidMetadata(metadata)) {
            return null;
        }

        let ramp: ColorValidationRamp;
        try {
            ramp = createTransferValidationRamp(metadata, rampOptions);
        } catch {
            return null;
        }
        const validationKey = createValidationKey(ramp);
        const entry = this.decisionsByDevice.get(device)?.get(validationKey);
        if (!entry?.decision || !await this.readFeatureFlag()) {
            return null;
        }

        const currentEntry = this.decisionsByDevice.get(device)?.get(validationKey);
        if (currentEntry !== entry || !currentEntry.decision) {
            return null;
        }

        const decision = currentEntry.decision;
        if (
            decision.capability === 'supported'
            && !isMeasuredColorValidationDecision(decision, ramp.metadata)
        ) {
            this.decisionsByDevice.get(device)?.delete(validationKey);
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

        let ramp: ColorValidationRamp;
        try {
            ramp = createTransferValidationRamp(
                validationRequest.metadata,
                validationRequest.rampOptions
            );
        } catch {
            return null;
        }
        const validationKey = createValidationKey(ramp);
        const entries = this.getDeviceEntries(validationRequest.device);
        const existingEntry = entries.get(validationKey);
        if (existingEntry?.decision) {
            return this.getCachedDecision(
                validationRequest.device,
                validationRequest.metadata,
                validationRequest.rampOptions
            );
        }
        if (existingEntry?.pending) {
            const pendingDecision = await existingEntry.pending;
            return pendingDecision ? snapshotDecision(pendingDecision) : null;
        }

        const generation = this.nextGeneration();
        const cancellation = createValidationCancellation();
        this.activeCancellations.add(cancellation);
        const pending = this.executeValidation(
            validationRequest,
            validationKey,
            generation,
            ramp,
            cancellation
        ).finally((): void => {
            this.activeCancellations.delete(cancellation);
        });
        entries.set(validationKey, { cancellation, generation, pending });
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
            const entries = this.decisionsByDevice.get(device);
            const metadataPrefix = `${createMetadataKey(metadata)}${VALIDATION_KEY_SEPARATOR}`;
            if (entries) {
                for (const [ validationKey, entry ] of entries) {
                    if (validationKey.startsWith(metadataPrefix)) {
                        entry.cancellation?.cancel();
                        entries.delete(validationKey);
                    }
                }
            }
            return;
        }

        const entries = this.decisionsByDevice.get(device);
        if (entries) {
            for (const entry of entries.values()) {
                entry.cancellation?.cancel();
            }
        }
        this.decisionsByDevice.delete(device);
    }

    /** Invalidates all cached and in-flight validation without retaining GPU devices. */
    public invalidateAll(): void {
        if (this.destroyed) {
            return;
        }

        this.nextGeneration();
        this.cancelActiveValidations();
        this.decisionsByDevice = new WeakMap<GPUDevice, Map<string, ValidationCacheEntry>>();
    }

    /** Permanently stops the registry and discards every cached decision. */
    public destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.nextGeneration();
        this.cancelActiveValidations();
        this.decisionsByDevice = new WeakMap<GPUDevice, Map<string, ValidationCacheEntry>>();
    }

    private async executeValidation(
        validationRequest: RuntimeColorValidationRequest,
        validationKey: string,
        generation: number,
        ramp: ColorValidationRamp,
        cancellation: ValidationCancellation
    ): Promise<ColorValidationCapabilityDecision | null> {
        const enabledResult = await this.waitForValidationOperation(
            this.readFeatureFlag(),
            cancellation
        );
        if (
            enabledResult !== true
            || !this.isCurrent(validationRequest.device, validationKey, generation)
        ) {
            this.removeCurrentEntry(validationRequest.device, validationKey, generation);
            return null;
        }
        let harness: RuntimeColorValidationHarness;
        try {
            harness = validationRequest.createHarness(ramp, generation);
        } catch {
            this.removeCurrentEntry(validationRequest.device, validationKey, generation);
            return null;
        }

        let decision: ColorValidationCapabilityDecision | null;
        try {
            decision = await this.collectValidationDecision(
                validationRequest,
                validationKey,
                generation,
                ramp,
                cancellation,
                harness
            );
        } catch {
            decision = null;
        }
        try {
            harness.destroy();
        } catch {
            decision = null;
        }

        const finalEnabledResult = decision ?
            await this.waitForValidationOperation(this.readFeatureFlag(), cancellation) :
            false;
        if (
            !decision
            || !this.isCurrent(validationRequest.device, validationKey, generation)
            || finalEnabledResult !== true
            || !this.isCurrent(validationRequest.device, validationKey, generation)
        ) {
            this.removeCurrentEntry(validationRequest.device, validationKey, generation);
            return null;
        }

        if (
            !matchesRampIdentity(decision, ramp)
            || (
                decision.capability === 'supported'
                && (
                    !isMeasuredColorValidationDecision(decision, ramp.metadata)
                    || !matchesRampTimestamps(decision, ramp)
                )
            )
        ) {
            this.removeCurrentEntry(validationRequest.device, validationKey, generation);
            return null;
        }

        const storedDecision = snapshotDecision(decision);
        this.decisionsByDevice.get(validationRequest.device)?.set(validationKey, {
            decision: storedDecision,
            generation
        });
        return storedDecision;
    }

    private async collectValidationDecision(
        validationRequest: RuntimeColorValidationRequest,
        validationKey: string,
        generation: number,
        ramp: ColorValidationRamp,
        cancellation: ValidationCancellation,
        harness: RuntimeColorValidationHarness
    ): Promise<ColorValidationCapabilityDecision | null> {
        for (let sampleIndex = 0; sampleIndex < ramp.samples.length; sampleIndex += 1) {
            if (
                cancellation.signal.aborted
                || !this.isCurrent(validationRequest.device, validationKey, generation)
            ) {
                return null;
            }

            const sample = ramp.samples[sampleIndex];
            const renderResult = await this.waitForValidationOperation(
                validationRequest.renderSample(sample, {
                    generation,
                    isCurrent: (): boolean => this.isCurrent(
                        validationRequest.device,
                        validationKey,
                        generation
                    ),
                    sampleIndex,
                    signal: cancellation.signal
                }),
                cancellation
            );
            if (
                renderResult === VALIDATION_OPERATION_CANCELLED
                || renderResult === VALIDATION_OPERATION_TIMEOUT
                || !this.isCurrent(validationRequest.device, validationKey, generation)
            ) {
                return null;
            }

            const captureResult = await this.waitForValidationOperation(
                harness.captureCurrentFrame({
                    ...renderResult,
                    timestampMicroseconds: sample.timestampMicroseconds
                }),
                cancellation
            );
            if (
                captureResult === VALIDATION_OPERATION_CANCELLED
                || captureResult === VALIDATION_OPERATION_TIMEOUT
                || !this.isCurrent(validationRequest.device, validationKey, generation)
            ) {
                return null;
            }
            if (captureResult.failure || !captureResult.observation) {
                break;
            }
        }

        return harness.evaluate();
    }

    private cancelActiveValidations(): void {
        for (const cancellation of [ ...this.activeCancellations ]) {
            cancellation.cancel();
        }
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

    private isCurrent(device: GPUDevice, validationKey: string, generation: number): boolean {
        return !this.destroyed
            && this.decisionsByDevice.get(device)?.get(validationKey)?.generation === generation;
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

    private waitForValidationOperation<Value>(
        operation: Promise<Value>,
        cancellation: ValidationCancellation
    ): Promise<
        Value
        | typeof VALIDATION_OPERATION_CANCELLED
        | typeof VALIDATION_OPERATION_TIMEOUT
        > {
        if (cancellation.signal.aborted) {
            return Promise.resolve(VALIDATION_OPERATION_CANCELLED);
        }

        return new Promise((resolve, reject) => {
            let settled = false;
            const timeout = globalThis.setTimeout((): void => {
                if (settled) {
                    return;
                }

                cancellation.cancel();
                settle(VALIDATION_OPERATION_TIMEOUT);
            }, microsecondsToMilliseconds(
                RUNTIME_COLOR_VALIDATION_SAMPLE_TIMEOUT_MICROSECONDS
            ));
            const settle = (
                result:
                    | Value
                    | typeof VALIDATION_OPERATION_CANCELLED
                    | typeof VALIDATION_OPERATION_TIMEOUT
            ): void => {
                if (settled) {
                    return;
                }

                settled = true;
                globalThis.clearTimeout(timeout);
                resolve(result);
            };
            const rejectOperation = (error: unknown): void => {
                if (settled) {
                    return;
                }

                settled = true;
                globalThis.clearTimeout(timeout);
                reject(error);
            };

            operation.then(settle, rejectOperation);
            void cancellation.promise.then(settle);
        });
    }

    private removeCurrentEntry(
        device: GPUDevice,
        validationKey: string,
        generation: number
    ): void {
        if (this.decisionsByDevice.get(device)?.get(validationKey)?.generation === generation) {
            this.decisionsByDevice.get(device)?.delete(validationKey);
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
