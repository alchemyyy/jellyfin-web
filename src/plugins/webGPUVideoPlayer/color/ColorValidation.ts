import {
    millisecondsToMicroseconds,
    type Microseconds
} from '../MediaTime';
import {
    decodeEncodedRGBToNits,
    type ColorTriplet
} from './ColorPipeline';
import {
    assertValidInputColorMetadata,
    type InputColorMetadata
} from './ColorMetadata';

export type ColorRampSample = {
    doubleTransformedLinearRGB: ColorTriplet
    encodedInputRGB: ColorTriplet
    expectedLinearRGB: ColorTriplet
    timestampMicroseconds: Microseconds
};

export type ColorValidationRamp = {
    metadata: InputColorMetadata
    normalizationNits: number
    samples: readonly ColorRampSample[]
};

export type ColorRampObservation = {
    linearRGB: ColorTriplet
    timestampMicroseconds: Microseconds
};

export type ColorRampTolerances = {
    maximumAbsoluteError: number
    rootMeanSquareError: number
};

export type ColorValidationClassification =
    | 'clamped'
    | 'double-transformed'
    | 'invalid-samples'
    | 'mismatch'
    | 'valid';

export type ColorValidationResult = {
    accepted: boolean
    classification: ColorValidationClassification
    maximumAbsoluteError: number
    rootMeanSquareError: number
    sampleCount: number
};

export type ColorValidationRampOptions = {
    encodedRGBTriplets?: readonly ColorTriplet[]
    encodedSignalLevels?: readonly number[]
    frameIntervalMicroseconds?: Microseconds
    normalizationNits?: number
    startTimestampMicroseconds?: Microseconds
};

type ErrorMetrics = {
    maximumAbsoluteError: number
    rootMeanSquareError: number
};

const DEFAULT_FRAME_INTERVAL_MICROSECONDS = millisecondsToMicroseconds(1_000 / 60);
const DEFAULT_SIGNAL_LEVELS: readonly number[] = [ 0, 0.25, 0.5, 0.75, 1 ];
const DEFAULT_TOLERANCES: ColorRampTolerances = {
    maximumAbsoluteError: 0.01,
    rootMeanSquareError: 0.005
};

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function normalizeRGB(linearRGBNits: ColorTriplet, normalizationNits: number): ColorTriplet {
    return [
        linearRGBNits[0] / normalizationNits,
        linearRGBNits[1] / normalizationNits,
        linearRGBNits[2] / normalizationNits
    ];
}

function isFiniteTriplet(value: ColorTriplet): boolean {
    return value.every(Number.isFinite);
}

function hasValidTolerances(tolerances: ColorRampTolerances): boolean {
    return Number.isFinite(tolerances.maximumAbsoluteError)
        && tolerances.maximumAbsoluteError >= 0
        && Number.isFinite(tolerances.rootMeanSquareError)
        && tolerances.rootMeanSquareError >= 0;
}

function metricsPass(metrics: ErrorMetrics, tolerances: ColorRampTolerances): boolean {
    return metrics.maximumAbsoluteError <= tolerances.maximumAbsoluteError
        && metrics.rootMeanSquareError <= tolerances.rootMeanSquareError;
}

function calculateErrorMetrics(
    expectedValues: readonly ColorTriplet[],
    observedValues: readonly ColorTriplet[]
): ErrorMetrics {
    let maximumAbsoluteError = 0;
    let squaredErrorSum = 0;
    let componentCount = 0;
    for (let sampleIndex = 0; sampleIndex < expectedValues.length; sampleIndex += 1) {
        const expectedRGB = expectedValues[sampleIndex];
        const observedRGB = observedValues[sampleIndex];
        for (let componentIndex = 0; componentIndex < 3; componentIndex += 1) {
            const absoluteError = Math.abs(
                expectedRGB[componentIndex] - observedRGB[componentIndex]
            );
            maximumAbsoluteError = Math.max(maximumAbsoluteError, absoluteError);
            squaredErrorSum += absoluteError * absoluteError;
            componentCount += 1;
        }
    }

    return {
        maximumAbsoluteError,
        rootMeanSquareError: Math.sqrt(squaredErrorSum / componentCount)
    };
}

function createResult(
    classification: ColorValidationClassification,
    metrics: ErrorMetrics,
    sampleCount: number
): ColorValidationResult {
    return {
        accepted: classification === 'valid',
        classification,
        maximumAbsoluteError: metrics.maximumAbsoluteError,
        rootMeanSquareError: metrics.rootMeanSquareError,
        sampleCount
    };
}

function createInvalidResult(sampleCount: number): ColorValidationResult {
    return createResult(
        'invalid-samples',
        { maximumAbsoluteError: Number.POSITIVE_INFINITY, rootMeanSquareError: Number.POSITIVE_INFINITY },
        sampleCount
    );
}

/** Builds an absolute-linear reference ramp and its double-EOTF failure model. */
export function createTransferValidationRamp(
    metadata: InputColorMetadata,
    options: ColorValidationRampOptions = {}
): ColorValidationRamp {
    assertValidInputColorMetadata(metadata);
    if (options.encodedRGBTriplets && options.encodedSignalLevels) {
        throw new RangeError(
            'Specify encoded RGB triplets or scalar signal levels, not both'
        );
    }
    const encodedRGBTriplets = options.encodedRGBTriplets
        ?? (options.encodedSignalLevels ?? DEFAULT_SIGNAL_LEVELS).map(
            (encodedSignal: number): ColorTriplet => [
                encodedSignal,
                encodedSignal,
                encodedSignal
            ]
        );
    const frameIntervalMicroseconds = options.frameIntervalMicroseconds
        ?? DEFAULT_FRAME_INTERVAL_MICROSECONDS;
    const normalizationNits = options.normalizationNits ?? metadata.sdrReferenceWhiteNits;
    const startTimestampMicroseconds = options.startTimestampMicroseconds
        ?? millisecondsToMicroseconds(0);
    if (
        encodedRGBTriplets.length < 3
        || encodedRGBTriplets.length > 64
        || !encodedRGBTriplets.every((encodedRGB: ColorTriplet): boolean => (
            encodedRGB.length === 3 && encodedRGB.every(Number.isFinite)
        ))
    ) {
        throw new RangeError(
            'A validation ramp requires from 3 through 64 finite encoded RGB triplets'
        );
    }
    if (!Number.isFinite(normalizationNits) || normalizationNits <= 0) {
        throw new RangeError('Validation normalization luminance must be positive and finite');
    }
    if (!Number.isSafeInteger(frameIntervalMicroseconds)
        || frameIntervalMicroseconds <= 0
        || !Number.isSafeInteger(startTimestampMicroseconds)) {
        throw new RangeError('Validation timestamps must use safe integer microseconds');
    }

    const samples: ColorRampSample[] = [];
    for (let sampleIndex = 0; sampleIndex < encodedRGBTriplets.length; sampleIndex += 1) {
        const encodedRGB = encodedRGBTriplets[sampleIndex];
        const encodedInputRGB: ColorTriplet = [ encodedRGB[0], encodedRGB[1], encodedRGB[2] ];
        const expectedLinearRGB = normalizeRGB(
            decodeEncodedRGBToNits(encodedInputRGB, metadata),
            normalizationNits
        );
        const secondTransferInputRGB: ColorTriplet = [
            clamp(expectedLinearRGB[0], 0, 1),
            clamp(expectedLinearRGB[1], 0, 1),
            clamp(expectedLinearRGB[2], 0, 1)
        ];
        const doubleTransformedLinearRGB = normalizeRGB(
            decodeEncodedRGBToNits(secondTransferInputRGB, metadata),
            normalizationNits
        );
        const timestamp = startTimestampMicroseconds
            + (sampleIndex * frameIntervalMicroseconds);
        if (!Number.isSafeInteger(timestamp)) {
            throw new RangeError('Validation timestamp exceeds the safe integer range');
        }
        samples.push({
            doubleTransformedLinearRGB,
            encodedInputRGB,
            expectedLinearRGB,
            timestampMicroseconds: timestamp as Microseconds
        });
    }

    return { metadata, normalizationNits, samples };
}

/** Compares captured ramp values and explicitly rejects clamping or a second EOTF. */
export function validateColorRamp(
    ramp: ColorValidationRamp,
    observations: readonly ColorRampObservation[],
    tolerances: ColorRampTolerances = DEFAULT_TOLERANCES
): ColorValidationResult {
    if (ramp.samples.length === 0
        || ramp.samples.length !== observations.length
        || !hasValidTolerances(tolerances)) {
        return createInvalidResult(observations.length);
    }

    const observationsByTimestamp = new Map<number, ColorTriplet>();
    for (const observation of observations) {
        if (!Number.isSafeInteger(observation.timestampMicroseconds)
            || !isFiniteTriplet(observation.linearRGB)
            || observationsByTimestamp.has(observation.timestampMicroseconds)) {
            return createInvalidResult(observations.length);
        }
        observationsByTimestamp.set(observation.timestampMicroseconds, observation.linearRGB);
    }

    const expectedValues: ColorTriplet[] = [];
    const clampedValues: ColorTriplet[] = [];
    const doubleTransformedValues: ColorTriplet[] = [];
    const observedValues: ColorTriplet[] = [];
    let referenceExceedsNormalizedRange = false;
    for (const sample of ramp.samples) {
        const observedRGB = observationsByTimestamp.get(sample.timestampMicroseconds);
        if (!observedRGB || !isFiniteTriplet(sample.expectedLinearRGB)) {
            return createInvalidResult(observations.length);
        }

        expectedValues.push(sample.expectedLinearRGB);
        doubleTransformedValues.push(sample.doubleTransformedLinearRGB);
        observedValues.push(observedRGB);
        const clampedRGB: ColorTriplet = [
            clamp(sample.expectedLinearRGB[0], 0, 1),
            clamp(sample.expectedLinearRGB[1], 0, 1),
            clamp(sample.expectedLinearRGB[2], 0, 1)
        ];
        clampedValues.push(clampedRGB);
        if (sample.expectedLinearRGB.some((component: number): boolean => component < 0
            || component > 1)) {
            referenceExceedsNormalizedRange = true;
        }
    }

    const expectedMetrics = calculateErrorMetrics(expectedValues, observedValues);
    if (metricsPass(expectedMetrics, tolerances)) {
        return createResult('valid', expectedMetrics, observations.length);
    }

    if (referenceExceedsNormalizedRange) {
        const clampedMetrics = calculateErrorMetrics(clampedValues, observedValues);
        if (metricsPass(clampedMetrics, tolerances)) {
            return createResult('clamped', expectedMetrics, observations.length);
        }
    }

    const doubleTransformedMetrics = calculateErrorMetrics(
        doubleTransformedValues,
        observedValues
    );
    if (metricsPass(doubleTransformedMetrics, tolerances)) {
        return createResult('double-transformed', expectedMetrics, observations.length);
    }

    return createResult('mismatch', expectedMetrics, observations.length);
}
