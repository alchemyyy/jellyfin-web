const DEFAULT_REQUIRED_SOAK_SESSION_COUNT = 4;
const DEFAULT_REQUIRED_STARTUP_SAMPLE_COUNT = 10;
const BYTES_PER_KIBIBYTE = 1_024;
const BYTES_PER_MEBIBYTE = 1_024 * BYTES_PER_KIBIBYTE;
const LAST_SESSION_MEDIAN_COUNT = 3;

export const RELEASE_MEMORY_SOAK_THRESHOLDS = Object.freeze({
    backingStorage: Object.freeze({
        maximumGrowth: 8 * BYTES_PER_MEBIBYTE,
        maximumSlope: 128 * BYTES_PER_KIBIBYTE
    }),
    embedderHeap: Object.freeze({
        maximumGrowth: 16 * BYTES_PER_MEBIBYTE,
        maximumSlope: 256 * BYTES_PER_KIBIBYTE
    }),
    jsUsedHeap: Object.freeze({
        maximumGrowth: 16 * BYTES_PER_MEBIBYTE,
        maximumSlope: 256 * BYTES_PER_KIBIBYTE
    })
});

export const RELEASE_DOM_SOAK_THRESHOLDS = Object.freeze({
    listeners: Object.freeze({ maximumGrowth: 16, maximumSlope: 0.25 }),
    liveObjects: Object.freeze({ maximumGrowth: 1, maximumSlope: 0.1 }),
    nodes: Object.freeze({ maximumGrowth: 32, maximumSlope: 0.5 })
});

export const RELEASE_PERFORMANCE_OBJECT_SOAK_THRESHOLDS = Object.freeze({
    arrayBufferContents: Object.freeze({ maximumGrowth: 32, maximumSlope: 0.1 }),
    retainedResources: Object.freeze({ maximumGrowth: 0, maximumSlope: 0 })
});

function requireArray(value, label) {
    if (!Array.isArray(value)) {
        throw new TypeError(`${label} must be an array`);
    }
    return value;
}

function requireFiniteNonnegativeNumber(value, label) {
    if (!Number.isFinite(value) || value < 0) {
        throw new TypeError(`${label} must be a finite nonnegative number`);
    }
    return value;
}

function requireFiniteNumber(value, label) {
    if (!Number.isFinite(value)) {
        throw new TypeError(`${label} must be a finite number`);
    }
    return value;
}

function requirePositiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`${label} must be a positive safe integer`);
    }
    return value;
}

function requireNumericSamples(values, label, allowEmpty = true, allowNegative = false) {
    const samples = requireArray(values, label);
    if (!allowEmpty && samples.length === 0) {
        throw new TypeError(`${label} must not be empty`);
    }
    for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex++) {
        if (allowNegative) {
            requireFiniteNumber(samples[sampleIndex], `${label}[${sampleIndex}]`);
        } else {
            requireFiniteNonnegativeNumber(samples[sampleIndex], `${label}[${sampleIndex}]`);
        }
    }
    return samples;
}

function requireObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function createValidationResult(failures, metrics) {
    return {
        failures,
        metrics,
        passed: failures.length === 0
    };
}

/** Returns the arithmetic median without mutating the input samples. */
export function median(values) {
    const samples = requireNumericSamples(values, 'Median samples', false, true);
    const sortedSamples = [ ...samples ].sort((firstValue, secondValue) => (
        firstValue - secondValue
    ));
    const middleIndex = Math.floor(sortedSamples.length / 2);
    if (sortedSamples.length % 2 === 1) {
        return sortedSamples[middleIndex];
    }
    return (sortedSamples[middleIndex - 1] + sortedSamples[middleIndex]) / 2;
}

/** Returns a nearest-rank percentile for a percentile in the range (0, 100]. */
export function nearestRankPercentile(values, percentile) {
    const samples = requireNumericSamples(values, 'Percentile samples', false, true);
    if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
        throw new TypeError('Percentile must be in the range (0, 100]');
    }
    const sortedSamples = [ ...samples ].sort((firstValue, secondValue) => (
        firstValue - secondValue
    ));
    const rank = Math.ceil(percentile / 100 * sortedSamples.length);
    return sortedSamples[rank - 1];
}

/** Returns the nearest-rank 95th percentile. */
export function p95(values) {
    return nearestRankPercentile(values, 95);
}

function requireObservations(observations, label, allowEmpty = true) {
    const inputObservations = requireArray(observations, label);
    if (!allowEmpty && inputObservations.length === 0) {
        throw new TypeError(`${label} must not be empty`);
    }
    const sessions = new Set();
    const validatedObservations = [];
    for (
        let observationIndex = 0;
        observationIndex < inputObservations.length;
        observationIndex++
    ) {
        const observation = requireObject(
            inputObservations[observationIndex],
            `${label}[${observationIndex}]`
        );
        const session = requirePositiveInteger(
            observation.session,
            `${label}[${observationIndex}].session`
        );
        const value = requireFiniteNonnegativeNumber(
            observation.value,
            `${label}[${observationIndex}].value`
        );
        if (sessions.has(session)) {
            throw new TypeError(`${label} contains duplicate session ${session}`);
        }
        sessions.add(session);
        validatedObservations.push({ session, value });
    }
    return validatedObservations.sort((firstObservation, secondObservation) => (
        firstObservation.session - secondObservation.session
    ));
}

/** Returns the median pairwise slope for session/value observations. */
export function theilSenSlope(observations) {
    const sortedObservations = requireObservations(
        observations,
        'Theil-Sen observations',
        false
    );
    if (sortedObservations.length < 2) {
        throw new TypeError('Theil-Sen slope requires at least two observations');
    }
    const slopes = [];
    for (
        let firstIndex = 0;
        firstIndex < sortedObservations.length - 1;
        firstIndex++
    ) {
        const firstObservation = sortedObservations[firstIndex];
        for (
            let secondIndex = firstIndex + 1;
            secondIndex < sortedObservations.length;
            secondIndex++
        ) {
            const secondObservation = sortedObservations[secondIndex];
            slopes.push(
                (secondObservation.value - firstObservation.value)
                    / (secondObservation.session - firstObservation.session)
            );
        }
    }
    return median(slopes.map(slope => Object.is(slope, -0) ? 0 : slope));
}

function summarizeSamples(samples) {
    if (samples.length === 0) {
        return null;
    }
    return {
        medianMilliseconds: median(samples),
        p95Milliseconds: p95(samples),
        sampleCount: samples.length
    };
}

function requireStartupObservations(observations, label) {
    const inputObservations = requireArray(observations, label);
    const sampleNumbers = new Set();
    const validatedObservations = [];
    for (
        let observationIndex = 0;
        observationIndex < inputObservations.length;
        observationIndex++
    ) {
        const observation = requireObject(
            inputObservations[observationIndex],
            `${label}[${observationIndex}]`
        );
        const sampleNumber = requirePositiveInteger(
            observation.sampleNumber,
            `${label}[${observationIndex}].sampleNumber`
        );
        const value = requireFiniteNonnegativeNumber(
            observation.value,
            `${label}[${observationIndex}].value`
        );
        if (sampleNumbers.has(sampleNumber)) {
            throw new TypeError(`${label} contains duplicate sampleNumber ${sampleNumber}`);
        }
        sampleNumbers.add(sampleNumber);
        validatedObservations.push({ sampleNumber, value });
    }
    return validatedObservations.sort((firstObservation, secondObservation) => (
        firstObservation.sampleNumber - secondObservation.sampleNumber
    ));
}

function summarizeStartupObservations(observations) {
    const summary = summarizeSamples(observations.map(observation => observation.value));
    if (summary === null) {
        return null;
    }
    return {
        ...summary,
        sampleNumbers: observations.map(observation => observation.sampleNumber)
    };
}

function haveIdenticalSampleNumbers(baselineObservations, candidateObservations) {
    if (baselineObservations.length !== candidateObservations.length) {
        return false;
    }
    return baselineObservations.every((baselineObservation, observationIndex) => (
        baselineObservation.sampleNumber
            === candidateObservations[observationIndex].sampleNumber
    ));
}

function validateStartupComparison(options) {
    const {
        baselineSamples,
        baselineSamplesMissingCode,
        candidateSamples,
        candidateSamplesMissingCode,
        failureCodePrefix,
        maximumMedianFraction,
        maximumMedianMilliseconds,
        maximumP95Fraction,
        maximumP95Milliseconds,
        requiredSampleCount
    } = options;
    const failures = [];
    const baselineSummary = summarizeStartupObservations(baselineSamples);
    const candidateSummary = summarizeStartupObservations(candidateSamples);
    if (baselineSamples.length !== requiredSampleCount) {
        failures.push(baselineSamplesMissingCode);
    }
    if (candidateSamples.length !== requiredSampleCount) {
        failures.push(candidateSamplesMissingCode);
    }
    const sampleNumbersMatch = haveIdenticalSampleNumbers(
        baselineSamples,
        candidateSamples
    );
    if (!sampleNumbersMatch) {
        failures.push(`${failureCodePrefix}-sample-numbers-mismatched`);
    }
    const metrics = {
        allowedMedianRegressionMilliseconds: null,
        allowedP95RegressionMilliseconds: null,
        baseline: baselineSummary,
        candidate: candidateSummary,
        medianExcessMilliseconds: null,
        medianRegressionMilliseconds: null,
        p95ExcessMilliseconds: null,
        p95RegressionMilliseconds: null,
        regression: null
    };
    if (
        baselineSamples.length !== requiredSampleCount
        || candidateSamples.length !== requiredSampleCount
        || !sampleNumbersMatch
    ) {
        return { failures, metrics };
    }
    const regressionSamples = [];
    const medianAllowedRegressionSamples = [];
    const medianExcessSamples = [];
    const p95AllowedRegressionSamples = [];
    const p95ExcessSamples = [];
    for (
        let observationIndex = 0;
        observationIndex < baselineSamples.length;
        observationIndex++
    ) {
        const baselineObservation = baselineSamples[observationIndex];
        const candidateObservation = candidateSamples[observationIndex];
        const regression = candidateObservation.value - baselineObservation.value;
        const medianAllowedRegression = Math.max(
            maximumMedianMilliseconds,
            baselineObservation.value * maximumMedianFraction
        );
        const p95AllowedRegression = Math.max(
            maximumP95Milliseconds,
            baselineObservation.value * maximumP95Fraction
        );
        regressionSamples.push(regression);
        medianAllowedRegressionSamples.push(medianAllowedRegression);
        medianExcessSamples.push(regression - medianAllowedRegression);
        p95AllowedRegressionSamples.push(p95AllowedRegression);
        p95ExcessSamples.push(regression - p95AllowedRegression);
    }
    const allowedMedianRegressionMilliseconds = median(
        medianAllowedRegressionSamples
    );
    const allowedP95RegressionMilliseconds = p95(p95AllowedRegressionSamples);
    const medianRegressionMilliseconds = median(regressionSamples);
    const p95RegressionMilliseconds = p95(regressionSamples);
    const medianExcessMilliseconds = median(medianExcessSamples);
    const p95ExcessMilliseconds = p95(p95ExcessSamples);
    metrics.allowedMedianRegressionMilliseconds = allowedMedianRegressionMilliseconds;
    metrics.allowedP95RegressionMilliseconds = allowedP95RegressionMilliseconds;
    metrics.medianExcessMilliseconds = medianExcessMilliseconds;
    metrics.medianRegressionMilliseconds = medianRegressionMilliseconds;
    metrics.p95ExcessMilliseconds = p95ExcessMilliseconds;
    metrics.p95RegressionMilliseconds = p95RegressionMilliseconds;
    metrics.regression = summarizeSamples(regressionSamples);
    if (medianExcessMilliseconds > 0) {
        failures.push(`${failureCodePrefix}-median-regression-exceeded`);
    }
    if (p95ExcessMilliseconds > 0) {
        failures.push(`${failureCodePrefix}-p95-regression-exceeded`);
    }
    return { failures, metrics };
}

function validateAbsoluteStartupSamples(options) {
    const {
        failureCodePrefix,
        maximumMedianMilliseconds,
        maximumP95Milliseconds,
        requiredSampleCount,
        samples,
        samplesMissingCode
    } = options;
    const failures = [];
    const summary = summarizeStartupObservations(samples);
    if (samples.length !== requiredSampleCount) {
        failures.push(samplesMissingCode);
    } else {
        if (summary.medianMilliseconds > maximumMedianMilliseconds) {
            failures.push(`${failureCodePrefix}-median-exceeded`);
        }
        if (summary.p95Milliseconds > maximumP95Milliseconds) {
            failures.push(`${failureCodePrefix}-p95-exceeded`);
        }
    }
    return {
        failures,
        metrics: {
            maximumMedianMilliseconds,
            maximumP95Milliseconds,
            samples: summary
        }
    };
}

function requireStartupSamples(samples, fields) {
    const inputSamples = requireObject(samples, 'Startup samples');
    const validatedSamples = {};
    for (const field of fields) {
        validatedSamples[field] = requireStartupObservations(
            inputSamples[field],
            `Startup samples.${field}`
        );
    }
    return validatedSamples;
}

function requireSampleCount(options) {
    requireObject(options, 'Startup validation options');
    return requirePositiveInteger(
        options.requiredSampleCount ?? DEFAULT_REQUIRED_STARTUP_SAMPLE_COUNT,
        'Required startup sample count'
    );
}

function requireFirstAudioValidation(options) {
    const value = options.validateFirstAudio ?? false;
    if (typeof value !== 'boolean') {
        throw new TypeError('Startup first-audio validation must be a boolean');
    }
    return value;
}

/** Validates HTML baseline and WebGPU presentation startup samples. */
export function validateHTMLVersusPresentationStartupSamples(samples, options = {}) {
    const requiredSampleCount = requireSampleCount(options);
    const validateFirstAudio = requireFirstAudioValidation(options);
    const fields = [
        'htmlPlayingMilliseconds',
        'htmlFirstVisibleFrameMilliseconds',
        'presentationPlayingMilliseconds',
        'presentationFirstVisibleFrameMilliseconds',
        'presentationAttachToFrameMilliseconds'
    ];
    if (validateFirstAudio) {
        fields.push(
            'htmlFirstAudioMilliseconds',
            'presentationFirstAudioMilliseconds'
        );
    }
    const validatedSamples = requireStartupSamples(samples, fields);
    const playing = validateStartupComparison({
        baselineSamples: validatedSamples.htmlPlayingMilliseconds,
        baselineSamplesMissingCode: 'html-playing-samples-missing',
        candidateSamples: validatedSamples.presentationPlayingMilliseconds,
        candidateSamplesMissingCode: 'presentation-playing-samples-missing',
        failureCodePrefix: 'presentation-playing',
        maximumMedianFraction: 0.1,
        maximumMedianMilliseconds: 50,
        maximumP95Fraction: 0.15,
        maximumP95Milliseconds: 100,
        requiredSampleCount
    });
    const firstVisibleFrame = validateStartupComparison({
        baselineSamples: validatedSamples.htmlFirstVisibleFrameMilliseconds,
        baselineSamplesMissingCode: 'html-first-visible-frame-samples-missing',
        candidateSamples: validatedSamples.presentationFirstVisibleFrameMilliseconds,
        candidateSamplesMissingCode: 'presentation-first-visible-frame-samples-missing',
        failureCodePrefix: 'presentation-first-visible-frame',
        maximumMedianFraction: 0.1,
        maximumMedianMilliseconds: 50,
        maximumP95Fraction: 0.15,
        maximumP95Milliseconds: 100,
        requiredSampleCount
    });
    const attachToFrame = validateAbsoluteStartupSamples({
        failureCodePrefix: 'presentation-attach-to-frame',
        maximumMedianMilliseconds: 100,
        maximumP95Milliseconds: 250,
        requiredSampleCount,
        samples: validatedSamples.presentationAttachToFrameMilliseconds,
        samplesMissingCode: 'presentation-attach-to-frame-samples-missing'
    });
    const firstAudio = validateFirstAudio ? validateStartupComparison({
        baselineSamples: validatedSamples.htmlFirstAudioMilliseconds,
        baselineSamplesMissingCode: 'html-first-audio-samples-missing',
        candidateSamples: validatedSamples.presentationFirstAudioMilliseconds,
        candidateSamplesMissingCode: 'presentation-first-audio-samples-missing',
        failureCodePrefix: 'presentation-first-audio',
        maximumMedianFraction: 0.1,
        maximumMedianMilliseconds: 50,
        maximumP95Fraction: 0.15,
        maximumP95Milliseconds: 100,
        requiredSampleCount
    }) : null;
    const failures = [
        ...playing.failures,
        ...firstVisibleFrame.failures,
        ...attachToFrame.failures,
        ...(firstAudio?.failures ?? [])
    ];
    return createValidationResult(failures, {
        attachToFrame: attachToFrame.metrics,
        firstAudio: firstAudio?.metrics ?? null,
        firstAudioApplicable: validateFirstAudio,
        firstVisibleFrame: firstVisibleFrame.metrics,
        playing: playing.metrics,
        requiredSampleCount
    });
}

/** Validates HTML baseline and custom decode startup samples. */
export function validateHTMLVersusCustomStartupSamples(samples, options = {}) {
    const requiredSampleCount = requireSampleCount(options);
    const validateFirstAudio = requireFirstAudioValidation(options);
    const fields = [
        'htmlPlayingMilliseconds',
        'htmlFirstVisibleFrameMilliseconds',
        'customPlayingMilliseconds',
        'customFirstVisibleFrameMilliseconds'
    ];
    if (validateFirstAudio) {
        fields.push('htmlFirstAudioMilliseconds', 'customFirstAudioMilliseconds');
    }
    const validatedSamples = requireStartupSamples(samples, fields);
    const playing = validateStartupComparison({
        baselineSamples: validatedSamples.htmlPlayingMilliseconds,
        baselineSamplesMissingCode: 'html-playing-samples-missing',
        candidateSamples: validatedSamples.customPlayingMilliseconds,
        candidateSamplesMissingCode: 'custom-playing-samples-missing',
        failureCodePrefix: 'custom-playing',
        maximumMedianFraction: 0.2,
        maximumMedianMilliseconds: 250,
        maximumP95Fraction: 0.3,
        maximumP95Milliseconds: 500,
        requiredSampleCount
    });
    const firstVisibleFrame = validateStartupComparison({
        baselineSamples: validatedSamples.htmlFirstVisibleFrameMilliseconds,
        baselineSamplesMissingCode: 'html-first-visible-frame-samples-missing',
        candidateSamples: validatedSamples.customFirstVisibleFrameMilliseconds,
        candidateSamplesMissingCode: 'custom-first-visible-frame-samples-missing',
        failureCodePrefix: 'custom-first-visible-frame',
        maximumMedianFraction: 0.2,
        maximumMedianMilliseconds: 250,
        maximumP95Fraction: 0.3,
        maximumP95Milliseconds: 500,
        requiredSampleCount
    });
    const firstAudio = validateFirstAudio ? validateStartupComparison({
        baselineSamples: validatedSamples.htmlFirstAudioMilliseconds,
        baselineSamplesMissingCode: 'html-first-audio-samples-missing',
        candidateSamples: validatedSamples.customFirstAudioMilliseconds,
        candidateSamplesMissingCode: 'custom-first-audio-samples-missing',
        failureCodePrefix: 'custom-first-audio',
        maximumMedianFraction: 0.2,
        maximumMedianMilliseconds: 250,
        maximumP95Fraction: 0.3,
        maximumP95Milliseconds: 500,
        requiredSampleCount
    }) : null;
    const failures = [
        ...playing.failures,
        ...firstVisibleFrame.failures,
        ...(firstAudio?.failures ?? [])
    ];
    return createValidationResult(failures, {
        firstAudio: firstAudio?.metrics ?? null,
        firstAudioApplicable: validateFirstAudio,
        firstVisibleFrame: firstVisibleFrame.metrics,
        playing: playing.metrics,
        requiredSampleCount
    });
}

function requireFailureCodePrefix(value) {
    if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/u.test(value)) {
        throw new TypeError('Failure code prefix must contain lowercase letters, numbers, or hyphens');
    }
    return value;
}

function hasCompleteSessionSequence(observations, requiredSessionCount) {
    if (observations.length < requiredSessionCount) {
        return false;
    }
    for (let observationIndex = 0; observationIndex < observations.length; observationIndex++) {
        if (observations[observationIndex].session !== observationIndex + 1) {
            return false;
        }
    }
    return true;
}

function createIncompleteSoakMetrics(observations) {
    return {
        baseline: observations[0]?.session === 1 ? observations[0].value : null,
        final: observations.at(-1)?.value ?? null,
        finalGrowth: null,
        lastThreeMedian: null,
        lastThreeMedianGrowth: null,
        sampleCount: observations.length,
        slopePerSession: null
    };
}

/** Validates one post-GC scalar series against session-one growth and slope limits. */
export function validateSoakScalarSeries(observations, options) {
    const validationOptions = requireObject(options, 'Soak validation options');
    const maximumGrowth = requireFiniteNonnegativeNumber(
        validationOptions.maximumGrowth,
        'Maximum soak growth'
    );
    const maximumSlope = requireFiniteNonnegativeNumber(
        validationOptions.maximumSlope,
        'Maximum soak slope'
    );
    const requiredSessionCount = requirePositiveInteger(
        validationOptions.requiredSessionCount ?? DEFAULT_REQUIRED_SOAK_SESSION_COUNT,
        'Required soak session count'
    );
    if (requiredSessionCount < LAST_SESSION_MEDIAN_COUNT + 1) {
        throw new TypeError('Required soak session count must include a baseline and three later sessions');
    }
    const failureCodePrefix = requireFailureCodePrefix(
        validationOptions.failureCodePrefix ?? 'soak-scalar'
    );
    const sortedObservations = requireObservations(observations, 'Soak observations');
    if (!hasCompleteSessionSequence(sortedObservations, requiredSessionCount)) {
        return createValidationResult(
            [ `${failureCodePrefix}-samples-missing` ],
            createIncompleteSoakMetrics(sortedObservations)
        );
    }
    const baseline = sortedObservations[0].value;
    const laterObservations = sortedObservations.slice(1);
    const final = laterObservations.at(-1).value;
    const lastThreeValues = laterObservations
        .slice(-LAST_SESSION_MEDIAN_COUNT)
        .map(observation => observation.value);
    const lastThreeMedian = median(lastThreeValues);
    const finalGrowth = final - baseline;
    const lastThreeMedianGrowth = lastThreeMedian - baseline;
    const slopePerSession = theilSenSlope(laterObservations);
    const failures = [];
    if (finalGrowth > maximumGrowth) {
        failures.push(`${failureCodePrefix}-final-growth-exceeded`);
    }
    if (lastThreeMedianGrowth > maximumGrowth) {
        failures.push(`${failureCodePrefix}-last-three-median-growth-exceeded`);
    }
    if (slopePerSession > maximumSlope) {
        failures.push(`${failureCodePrefix}-slope-exceeded`);
    }
    return createValidationResult(failures, {
        baseline,
        final,
        finalGrowth,
        lastThreeMedian,
        lastThreeMedianGrowth,
        maximumGrowth,
        maximumSlope,
        sampleCount: sortedObservations.length,
        slopePerSession
    });
}

function validateNamedSoakSeries(observations, threshold, failureCodePrefix, options) {
    return validateSoakScalarSeries(observations, {
        failureCodePrefix,
        maximumGrowth: threshold.maximumGrowth,
        maximumSlope: threshold.maximumSlope,
        requiredSessionCount: options.requiredSessionCount
    });
}

function combineNamedValidationResults(results, requiredSessionCount) {
    const failures = [];
    const metrics = { requiredSessionCount };
    for (const [ name, result ] of Object.entries(results)) {
        failures.push(...result.failures);
        metrics[name] = result.metrics;
    }
    return createValidationResult(failures, metrics);
}

function requireSoakSessionCount(options) {
    requireObject(options, 'Release soak validation options');
    return requirePositiveInteger(
        options.requiredSessionCount ?? DEFAULT_REQUIRED_SOAK_SESSION_COUNT,
        'Required soak session count'
    );
}

/** Applies the fixed release limits for browser memory telemetry. */
export function validateReleaseMemorySoakSeries(series, options = {}) {
    const requiredSessionCount = requireSoakSessionCount(options);
    const inputSeries = requireObject(series, 'Memory soak series');
    const validationOptions = { requiredSessionCount };
    const results = {
        backingStorageBytes: validateNamedSoakSeries(
            inputSeries.backingStorageBytes,
            RELEASE_MEMORY_SOAK_THRESHOLDS.backingStorage,
            'backing-storage',
            validationOptions
        ),
        embedderHeapBytes: validateNamedSoakSeries(
            inputSeries.embedderHeapBytes,
            RELEASE_MEMORY_SOAK_THRESHOLDS.embedderHeap,
            'embedder-heap',
            validationOptions
        ),
        jsUsedHeapBytes: validateNamedSoakSeries(
            inputSeries.jsUsedHeapBytes,
            RELEASE_MEMORY_SOAK_THRESHOLDS.jsUsedHeap,
            'js-used-heap',
            validationOptions
        )
    };
    return combineNamedValidationResults(results, requiredSessionCount);
}

function normalizeFailureCodeComponent(value) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError('Live object names must be nonempty strings');
    }
    const normalizedValue = value
        .replaceAll(/([a-z0-9])([A-Z])/gu, '$1-$2')
        .replaceAll(/[^a-zA-Z0-9]+/gu, '-')
        .split('-')
        .filter(component => component.length > 0)
        .join('-')
        .toLowerCase();
    if (normalizedValue.length === 0) {
        throw new TypeError('Live object names must contain letters or numbers');
    }
    return normalizedValue;
}

function validateExactBaselineSeries(
    observations,
    failureCodePrefix,
    requiredSessionCount,
    expectedValue = null
) {
    const sortedObservations = requireObservations(observations, `${failureCodePrefix} observations`);
    const failures = [];
    if (!hasCompleteSessionSequence(sortedObservations, requiredSessionCount)) {
        failures.push(`${failureCodePrefix}-samples-missing`);
    }
    const baseline = sortedObservations[0]?.session === 1 ? sortedObservations[0].value : null;
    if (
        baseline !== null
        && sortedObservations.some(observation => observation.value !== baseline)
    ) {
        failures.push(`${failureCodePrefix}-changed`);
    }
    if (
        expectedValue !== null
        && sortedObservations.some(observation => observation.value !== expectedValue)
    ) {
        failures.push(`${failureCodePrefix}-expected-count-mismatch`);
    }
    return createValidationResult(failures, {
        baseline,
        expectedValue,
        sampleCount: sortedObservations.length
    });
}

function getExpectedCount(options, propertyName, label) {
    const expectedCount = options[propertyName];
    if (expectedCount === undefined) {
        return null;
    }
    if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
        throw new TypeError(`${label} must be a nonnegative safe integer`);
    }
    return expectedCount;
}

function validateLiveObjectCountSeries(
    name,
    observations,
    failureCodePrefix,
    requiredSessionCount,
    expectedAudioContextCount,
    expectedAudioWorkletNodeCount
) {
    let expectedValue = null;
    switch (name) {
        case 'AudioContext':
            expectedValue = expectedAudioContextCount;
            break;
        case 'AudioWorkletNode':
            expectedValue = expectedAudioWorkletNodeCount;
            break;
        default:
            break;
    }
    return expectedValue === null ?
        validateNamedSoakSeries(
            observations,
            RELEASE_DOM_SOAK_THRESHOLDS.liveObjects,
            failureCodePrefix,
            { requiredSessionCount }
        ) :
        validateExactBaselineSeries(
            observations,
            failureCodePrefix,
            requiredSessionCount,
            expectedValue
        );
}

function recordUnavailableExpectedCount(
    sourceCounts,
    sourceName,
    expectedValue,
    failureCode,
    failures,
    metrics
) {
    if (expectedValue === null || Object.hasOwn(sourceCounts, sourceName)) {
        return;
    }
    failures.push(failureCode);
    metrics[sourceName] = {
        expectedValue,
        sampleCount: 0
    };
}

function validateZeroSeries(observations, failureCodePrefix, requiredSessionCount) {
    const sortedObservations = requireObservations(observations, `${failureCodePrefix} observations`);
    const failures = [];
    if (!hasCompleteSessionSequence(sortedObservations, requiredSessionCount)) {
        failures.push(`${failureCodePrefix}-samples-missing`);
    }
    if (sortedObservations.some(observation => observation.value !== 0)) {
        failures.push(`${failureCodePrefix}-nonzero`);
    }
    return createValidationResult(failures, {
        maximum: sortedObservations.length === 0 ? null : Math.max(
            ...sortedObservations.map(observation => observation.value)
        ),
        sampleCount: sortedObservations.length
    });
}

/**
 * Applies the fixed release limits for DOM and resource object counts.
 * Worker counts are stopped-session custom decode worker targets, not all browser workers.
 * Performance resource counts must not trend above their warmed session-one baseline.
 * Expected AudioContext and AudioWorklet counts make their CDP probes mandatory and exact.
 */
export function validateDOMAndObjectCountSeries(series, options = {}) {
    const requiredSessionCount = requireSoakSessionCount(options);
    const expectedAudioContextCount = getExpectedCount(
        options,
        'expectedAudioContextCount',
        'Expected AudioContext count'
    );
    const expectedAudioWorkletNodeCount = getExpectedCount(
        options,
        'expectedAudioWorkletNodeCount',
        'Expected AudioWorkletNode count'
    );
    const expectedAudioWorkletProcessorCount = getExpectedCount(
        options,
        'expectedAudioWorkletProcessorCount',
        'Expected AudioWorkletProcessor count'
    );
    const inputSeries = requireObject(series, 'DOM and object-count series');
    const liveObjectCounts = requireObject(
        inputSeries.liveObjectCounts,
        'DOM and object-count series.liveObjectCounts'
    );
    const performanceObjectCounts = inputSeries.performanceObjectCounts === undefined ?
        {} :
        requireObject(
            inputSeries.performanceObjectCounts,
            'DOM and object-count series.performanceObjectCounts'
        );
    const results = {
        documentCount: validateExactBaselineSeries(
            inputSeries.documentCount,
            'document-count',
            requiredSessionCount
        ),
        listenerCount: validateNamedSoakSeries(
            inputSeries.listenerCount,
            RELEASE_DOM_SOAK_THRESHOLDS.listeners,
            'listener-count',
            { requiredSessionCount }
        ),
        nodeCount: validateNamedSoakSeries(
            inputSeries.nodeCount,
            RELEASE_DOM_SOAK_THRESHOLDS.nodes,
            'node-count',
            { requiredSessionCount }
        ),
        workerCount: validateZeroSeries(
            inputSeries.workerCount,
            'worker-count',
            requiredSessionCount
        )
    };
    const normalizedNames = new Set();
    const liveObjectMetrics = {};
    const liveObjectEntries = Object.entries(liveObjectCounts);
    const liveObjectFailures = [];
    for (const [ name, observations ] of liveObjectEntries) {
        const normalizedName = normalizeFailureCodeComponent(name);
        if (normalizedNames.has(normalizedName)) {
            throw new TypeError(`Live object names normalize to duplicate value ${normalizedName}`);
        }
        normalizedNames.add(normalizedName);
        const failureCodePrefix = `live-object-${normalizedName}`;
        const result = validateLiveObjectCountSeries(
            name,
            observations,
            failureCodePrefix,
            requiredSessionCount,
            expectedAudioContextCount,
            expectedAudioWorkletNodeCount
        );
        liveObjectFailures.push(...result.failures);
        liveObjectMetrics[name] = result.metrics;
    }
    recordUnavailableExpectedCount(
        liveObjectCounts,
        'AudioContext',
        expectedAudioContextCount,
        'live-object-audio-context-unavailable',
        liveObjectFailures,
        liveObjectMetrics
    );
    recordUnavailableExpectedCount(
        liveObjectCounts,
        'AudioWorkletNode',
        expectedAudioWorkletNodeCount,
        'live-object-audio-worklet-node-unavailable',
        liveObjectFailures,
        liveObjectMetrics
    );
    results.liveObjectCounts = createValidationResult(
        liveObjectFailures,
        liveObjectMetrics
    );
    const performanceObjectFailures = [];
    const performanceObjectMetrics = {};
    const performanceNames = new Set();
    for (const [ name, observations ] of Object.entries(performanceObjectCounts)) {
        const normalizedName = normalizeFailureCodeComponent(name);
        if (performanceNames.has(normalizedName)) {
            throw new TypeError(
                `Performance object names normalize to duplicate value ${normalizedName}`
            );
        }
        performanceNames.add(normalizedName);
        const threshold = name === 'ArrayBufferContents' ?
            RELEASE_PERFORMANCE_OBJECT_SOAK_THRESHOLDS.arrayBufferContents :
            RELEASE_PERFORMANCE_OBJECT_SOAK_THRESHOLDS.retainedResources;
        const failureCodePrefix = `performance-count-${normalizedName}`;
        const result = name === 'AudioWorkletProcessors'
            && expectedAudioWorkletProcessorCount !== null ?
            validateExactBaselineSeries(
                observations,
                failureCodePrefix,
                requiredSessionCount,
                expectedAudioWorkletProcessorCount
            ) :
            validateNamedSoakSeries(
                observations,
                threshold,
                failureCodePrefix,
                { requiredSessionCount }
            );
        performanceObjectFailures.push(...result.failures);
        performanceObjectMetrics[name] = result.metrics;
    }
    recordUnavailableExpectedCount(
        performanceObjectCounts,
        'AudioWorkletProcessors',
        expectedAudioWorkletProcessorCount,
        'performance-count-audio-worklet-processors-unavailable',
        performanceObjectFailures,
        performanceObjectMetrics
    );
    results.performanceObjectCounts = createValidationResult(
        performanceObjectFailures,
        performanceObjectMetrics
    );
    return combineNamedValidationResults(results, requiredSessionCount);
}
