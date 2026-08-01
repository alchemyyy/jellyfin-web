import assert from 'node:assert/strict';
import test from 'node:test';

import {
    median,
    nearestRankPercentile,
    p95,
    RELEASE_MEMORY_SOAK_THRESHOLDS,
    theilSenSlope,
    validateDOMAndObjectCountSeries,
    validateHTMLVersusCustomStartupSamples,
    validateHTMLVersusPresentationStartupSamples,
    validateReleaseMemorySoakSeries,
    validateSoakScalarSeries
} from './release-validation-metrics.mjs';

const STARTUP_SAMPLE_COUNT = 10;

function createStartupObservations(values) {
    return values.map((value, valueIndex) => ({
        sampleNumber: valueIndex + 1,
        value
    }));
}

function repeatStartupSample(value, count = STARTUP_SAMPLE_COUNT) {
    return createStartupObservations(Array.from({ length: count }, () => value));
}

function createObservations(values) {
    return values.map((value, valueIndex) => ({
        session: valueIndex + 1,
        value
    }));
}

function createPassingPresentationStartupSamples() {
    return {
        htmlFirstVisibleFrameMilliseconds: repeatStartupSample(2_000),
        htmlPlayingMilliseconds: repeatStartupSample(1_000),
        presentationAttachToFrameMilliseconds: createStartupObservations([
            ...Array.from({ length: STARTUP_SAMPLE_COUNT - 1 }, () => 100),
            250
        ]),
        presentationFirstVisibleFrameMilliseconds: createStartupObservations([
            ...Array.from({ length: STARTUP_SAMPLE_COUNT - 1 }, () => 2_200),
            2_300
        ]),
        presentationPlayingMilliseconds: createStartupObservations([
            ...Array.from({ length: STARTUP_SAMPLE_COUNT - 1 }, () => 1_100),
            1_150
        ])
    };
}

function createPassingCustomStartupSamples() {
    return {
        customFirstVisibleFrameMilliseconds: createStartupObservations([
            ...Array.from({ length: STARTUP_SAMPLE_COUNT - 1 }, () => 2_400),
            2_600
        ]),
        customPlayingMilliseconds: createStartupObservations([
            ...Array.from({ length: STARTUP_SAMPLE_COUNT - 1 }, () => 1_250),
            1_500
        ]),
        htmlFirstVisibleFrameMilliseconds: repeatStartupSample(2_000),
        htmlPlayingMilliseconds: repeatStartupSample(1_000)
    };
}

function createPassingDOMSeries() {
    return {
        documentCount: createObservations([ 2, 2, 2, 2 ]),
        listenerCount: createObservations([ 10, 26, 26, 26 ]),
        liveObjectCounts: {
            VideoFrame: createObservations([ 1, 2, 2, 2 ])
        },
        nodeCount: createObservations([ 100, 132, 132, 132 ]),
        workerCount: createObservations([ 0, 0, 0, 0 ])
    };
}

test('computes odd and even medians without changing the source array', () => {
    const values = [ 4, -2, 1, 3 ];

    assert.equal(median(values), 2);
    assert.equal(median([ 9, 1, 5 ]), 5);
    assert.deepEqual(values, [ 4, -2, 1, 3 ]);
});

test('computes nearest-rank percentiles including p95', () => {
    const values = [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 ];

    assert.equal(nearestRankPercentile(values, 1), 1);
    assert.equal(nearestRankPercentile(values, 50), 5);
    assert.equal(nearestRankPercentile(values, 100), 10);
    assert.equal(p95(values), 10);
});

test('rejects invalid statistical inputs', () => {
    assert.throws(() => median([]), /must not be empty/u);
    assert.throws(() => median([ Number.NaN ]), /finite number/u);
    assert.throws(() => nearestRankPercentile([ 1 ], 0), /range/u);
    assert.throws(() => nearestRankPercentile([ 1 ], 101), /range/u);
});

test('computes a Theil-Sen slope from unordered observations', () => {
    assert.equal(theilSenSlope([
        { session: 4, value: 9 },
        { session: 1, value: 3 },
        { session: 3, value: 7 },
        { session: 2, value: 5 }
    ]), 2);
    assert.equal(theilSenSlope([
        { session: 1, value: 3 },
        { session: 2, value: 2 },
        { session: 3, value: 1 }
    ]), -1);
});

test('rejects insufficient and duplicate Theil-Sen observations', () => {
    assert.throws(
        () => theilSenSlope([ { session: 1, value: 3 } ]),
        /at least two/u
    );
    assert.throws(
        () => theilSenSlope([
            { session: 1, value: 3 },
            { session: 1, value: 4 }
        ]),
        /duplicate session/u
    );
});

test('accepts presentation startup values exactly at every release boundary', () => {
    const result = validateHTMLVersusPresentationStartupSamples(
        createPassingPresentationStartupSamples()
    );

    assert.equal(result.passed, true);
    assert.deepEqual(result.failures, []);
    assert.equal(result.metrics.playing.medianRegressionMilliseconds, 100);
    assert.equal(result.metrics.playing.p95RegressionMilliseconds, 150);
    assert.equal(result.metrics.attachToFrame.samples.p95Milliseconds, 250);
    assert.equal(result.metrics.firstAudioApplicable, false);
    assert.equal(result.metrics.firstAudio, null);
});

test('applies presentation startup limits to every expected audio sample', () => {
    const samples = createPassingPresentationStartupSamples();
    samples.htmlFirstAudioMilliseconds = repeatStartupSample(1_000);
    samples.presentationFirstAudioMilliseconds = createStartupObservations([
        ...Array.from({ length: STARTUP_SAMPLE_COUNT - 1 }, () => 1_100),
        1_150
    ]);

    const result = validateHTMLVersusPresentationStartupSamples(samples, {
        validateFirstAudio: true
    });

    assert.equal(result.passed, true);
    assert.equal(result.metrics.firstAudioApplicable, true);
    assert.equal(result.metrics.firstAudio.medianRegressionMilliseconds, 100);
    assert.equal(result.metrics.firstAudio.p95RegressionMilliseconds, 150);
});

test('reports independent presentation startup regression failures', () => {
    const samples = createPassingPresentationStartupSamples();
    samples.presentationPlayingMilliseconds = createStartupObservations([
        ...Array.from({ length: STARTUP_SAMPLE_COUNT - 1 }, () => 1_101),
        1_151
    ]);
    samples.presentationAttachToFrameMilliseconds = createStartupObservations([
        ...Array.from({ length: STARTUP_SAMPLE_COUNT - 1 }, () => 101),
        251
    ]);

    const result = validateHTMLVersusPresentationStartupSamples(samples);

    assert.deepEqual(result.failures, [
        'presentation-playing-median-regression-exceeded',
        'presentation-playing-p95-regression-exceeded',
        'presentation-attach-to-frame-median-exceeded',
        'presentation-attach-to-frame-p95-exceeded'
    ]);
});

test('accepts custom startup values exactly at every release boundary', () => {
    const result = validateHTMLVersusCustomStartupSamples(
        createPassingCustomStartupSamples()
    );

    assert.equal(result.passed, true);
    assert.equal(result.metrics.playing.medianRegressionMilliseconds, 250);
    assert.equal(result.metrics.playing.p95RegressionMilliseconds, 500);
    assert.equal(result.metrics.firstVisibleFrame.medianRegressionMilliseconds, 400);
    assert.equal(result.metrics.firstVisibleFrame.p95RegressionMilliseconds, 600);
});

test('reports missing startup samples as gate failures', () => {
    const samples = createPassingCustomStartupSamples();
    samples.customPlayingMilliseconds.pop();

    const result = validateHTMLVersusCustomStartupSamples(samples);

    assert.deepEqual(result.failures, [
        'custom-playing-samples-missing',
        'custom-playing-sample-numbers-mismatched'
    ]);
    assert.equal(result.passed, false);
});

test('rejects startup comparisons with mismatched sample numbers', () => {
    const samples = createPassingCustomStartupSamples();
    samples.customPlayingMilliseconds.at(-1).sampleNumber = 11;

    const result = validateHTMLVersusCustomStartupSamples(samples);

    assert.deepEqual(result.failures, [
        'custom-playing-sample-numbers-mismatched'
    ]);
    assert.equal(result.metrics.playing.medianRegressionMilliseconds, null);
});

test('uses matched-round excess so aggregate quantiles cannot hide a regression', () => {
    const samples = createPassingPresentationStartupSamples();
    samples.htmlPlayingMilliseconds = createStartupObservations([
        100, 100, 100, 100, 100, 100, 100, 100, 100, 1_000
    ]);
    samples.presentationPlayingMilliseconds = createStartupObservations([
        1_000, 100, 100, 100, 100, 100, 100, 100, 100, 100
    ]);

    const result = validateHTMLVersusPresentationStartupSamples(samples);

    assert.equal(
        result.metrics.playing.baseline.medianMilliseconds,
        result.metrics.playing.candidate.medianMilliseconds
    );
    assert.equal(
        result.metrics.playing.baseline.p95Milliseconds,
        result.metrics.playing.candidate.p95Milliseconds
    );
    assert.equal(result.metrics.playing.medianRegressionMilliseconds, 0);
    assert.equal(result.metrics.playing.p95RegressionMilliseconds, 900);
    assert.equal(result.metrics.playing.p95ExcessMilliseconds, 800);
    assert.deepEqual(result.failures, [
        'presentation-playing-p95-regression-exceeded'
    ]);
});

test('requires all custom first-audio samples only for an audio-capable gate', () => {
    const samples = createPassingCustomStartupSamples();
    samples.htmlFirstAudioMilliseconds = repeatStartupSample(1_000);
    samples.customFirstAudioMilliseconds = repeatStartupSample(
        1_250,
        STARTUP_SAMPLE_COUNT - 1
    );

    const result = validateHTMLVersusCustomStartupSamples(samples, {
        validateFirstAudio: true
    });

    assert.deepEqual(result.failures, [
        'custom-first-audio-samples-missing',
        'custom-first-audio-sample-numbers-mismatched'
    ]);
    assert.equal(result.metrics.firstAudioApplicable, true);
});

test('throws for malformed startup sample input', () => {
    const samples = createPassingPresentationStartupSamples();
    samples.presentationPlayingMilliseconds[0].value = -1;

    assert.throws(
        () => validateHTMLVersusPresentationStartupSamples(samples),
        /finite nonnegative/u
    );
    assert.throws(
        () => validateHTMLVersusCustomStartupSamples({}),
        /must be an array/u
    );
    const duplicateSamples = createPassingPresentationStartupSamples();
    duplicateSamples.presentationPlayingMilliseconds[1].sampleNumber = 1;
    assert.throws(
        () => validateHTMLVersusPresentationStartupSamples(duplicateSamples),
        /duplicate sampleNumber 1/u
    );
    const invalidSampleNumberSamples = createPassingPresentationStartupSamples();
    invalidSampleNumberSamples.presentationPlayingMilliseconds[0].sampleNumber = 0;
    assert.throws(
        () => validateHTMLVersusPresentationStartupSamples(invalidSampleNumberSamples),
        /positive safe integer/u
    );
});

test('accepts scalar soak growth and slope exactly at their limits', () => {
    const result = validateSoakScalarSeries(
        createObservations([ 100, 102, 104, 110 ]),
        {
            failureCodePrefix: 'test-value',
            maximumGrowth: 10,
            maximumSlope: 4
        }
    );

    assert.equal(result.passed, true);
    assert.equal(result.metrics.finalGrowth, 10);
    assert.equal(result.metrics.slopePerSession, 4);
});

test('checks the last-three median separately from final growth', () => {
    const result = validateSoakScalarSeries(
        createObservations([ 100, 110, 110, 100 ]),
        {
            maximumGrowth: 10,
            maximumSlope: 10
        }
    );

    assert.equal(result.passed, true);
    assert.equal(result.metrics.finalGrowth, 0);
    assert.equal(result.metrics.lastThreeMedianGrowth, 10);
});

test('reports every exceeded scalar soak gate with stable codes', () => {
    const result = validateSoakScalarSeries(
        createObservations([ 100, 102, 120, 115 ]),
        {
            failureCodePrefix: 'test-value',
            maximumGrowth: 10,
            maximumSlope: 4
        }
    );

    assert.deepEqual(result.failures, [
        'test-value-final-growth-exceeded',
        'test-value-last-three-median-growth-exceeded',
        'test-value-slope-exceeded'
    ]);
});

test('reports missing or gapped soak sessions without calculating gates', () => {
    const result = validateSoakScalarSeries([
        { session: 1, value: 100 },
        { session: 2, value: 101 },
        { session: 4, value: 102 },
        { session: 5, value: 103 }
    ], {
        maximumGrowth: 10,
        maximumSlope: 1
    });

    assert.deepEqual(result.failures, [ 'soak-scalar-samples-missing' ]);
    assert.equal(result.metrics.slopePerSession, null);
});

test('throws for malformed scalar soak input and thresholds', () => {
    assert.throws(
        () => validateSoakScalarSeries(createObservations([ 1, 2, 3, 4 ]), {
            maximumGrowth: -1,
            maximumSlope: 1
        }),
        /finite nonnegative/u
    );
    assert.throws(
        () => validateSoakScalarSeries([
            { session: 1, value: 1 },
            { session: 1, value: 2 }
        ], {
            maximumGrowth: 1,
            maximumSlope: 1
        }),
        /duplicate session/u
    );
});

test('applies the fixed memory thresholds at their exact boundaries', () => {
    const jsThreshold = RELEASE_MEMORY_SOAK_THRESHOLDS.jsUsedHeap;
    const embedderThreshold = RELEASE_MEMORY_SOAK_THRESHOLDS.embedderHeap;
    const backingThreshold = RELEASE_MEMORY_SOAK_THRESHOLDS.backingStorage;
    const result = validateReleaseMemorySoakSeries({
        backingStorageBytes: createObservations([
            100,
            100 + backingThreshold.maximumGrowth,
            100 + backingThreshold.maximumGrowth,
            100 + backingThreshold.maximumGrowth
        ]),
        embedderHeapBytes: createObservations([
            100,
            100 + embedderThreshold.maximumGrowth,
            100 + embedderThreshold.maximumGrowth,
            100 + embedderThreshold.maximumGrowth
        ]),
        jsUsedHeapBytes: createObservations([
            100,
            100 + jsThreshold.maximumGrowth,
            100 + jsThreshold.maximumGrowth,
            100 + jsThreshold.maximumGrowth
        ])
    });

    assert.equal(result.passed, true);
    assert.deepEqual(result.failures, []);
});

test('accepts release DOM limits and an empty optional live-object record', () => {
    const completeResult = validateDOMAndObjectCountSeries(createPassingDOMSeries());
    const emptyLiveObjects = createPassingDOMSeries();
    emptyLiveObjects.liveObjectCounts = {};
    const emptyResult = validateDOMAndObjectCountSeries(emptyLiveObjects);

    assert.equal(completeResult.passed, true);
    assert.equal(emptyResult.passed, true);
});

test('requires the reusable AudioWorkletNode count to match its expected bound', () => {
    const stableSeries = createPassingDOMSeries();
    stableSeries.liveObjectCounts.AudioWorkletNode = createObservations([
        1, 1, 1, 1
    ]);
    stableSeries.performanceObjectCounts = {
        AudioWorkletProcessors: createObservations([ 1, 1, 1, 1 ])
    };
    const growingSeries = createPassingDOMSeries();
    growingSeries.liveObjectCounts.AudioWorkletNode = createObservations([
        1, 2, 1, 1
    ]);
    growingSeries.performanceObjectCounts = {
        AudioWorkletProcessors: createObservations([ 1, 1, 1, 1 ])
    };
    const overAllocatedSeries = createPassingDOMSeries();
    overAllocatedSeries.liveObjectCounts.AudioWorkletNode = createObservations([
        2, 2, 2, 2
    ]);
    overAllocatedSeries.performanceObjectCounts = {
        AudioWorkletProcessors: createObservations([ 1, 1, 1, 1 ])
    };
    const disabledSeries = createPassingDOMSeries();
    disabledSeries.liveObjectCounts.AudioWorkletNode = createObservations([
        0, 0, 0, 0
    ]);
    disabledSeries.performanceObjectCounts = {
        AudioWorkletProcessors: createObservations([ 0, 0, 0, 0 ])
    };

    const stableResult = validateDOMAndObjectCountSeries(stableSeries, {
        expectedAudioWorkletCount: 1
    });
    const growingResult = validateDOMAndObjectCountSeries(growingSeries, {
        expectedAudioWorkletCount: 1
    });
    const overAllocatedResult = validateDOMAndObjectCountSeries(overAllocatedSeries, {
        expectedAudioWorkletCount: 1
    });
    const disabledResult = validateDOMAndObjectCountSeries(disabledSeries, {
        expectedAudioWorkletCount: 0
    });

    assert.equal(stableResult.passed, true);
    assert.deepEqual(growingResult.failures, [
        'live-object-audio-worklet-node-changed',
        'live-object-audio-worklet-node-expected-count-mismatch'
    ]);
    assert.deepEqual(overAllocatedResult.failures, [
        'live-object-audio-worklet-node-expected-count-mismatch'
    ]);
    assert.equal(disabledResult.passed, true);
});

test('requires AudioWorkletProcessor count to match the expected audio path', () => {
    const customAudioSeries = createPassingDOMSeries();
    customAudioSeries.liveObjectCounts.AudioWorkletNode = createObservations([
        1, 1, 1, 1
    ]);
    customAudioSeries.performanceObjectCounts = {
        AudioWorkletProcessors: createObservations([ 1, 1, 1, 1 ])
    };
    const overAllocatedSeries = createPassingDOMSeries();
    overAllocatedSeries.liveObjectCounts.AudioWorkletNode = createObservations([
        1, 1, 1, 1
    ]);
    overAllocatedSeries.performanceObjectCounts = {
        AudioWorkletProcessors: createObservations([ 2, 2, 2, 2 ])
    };
    const disabledAudioSeries = createPassingDOMSeries();
    disabledAudioSeries.liveObjectCounts.AudioWorkletNode = createObservations([
        0, 0, 0, 0
    ]);
    disabledAudioSeries.performanceObjectCounts = {
        AudioWorkletProcessors: createObservations([ 0, 0, 0, 0 ])
    };

    assert.equal(validateDOMAndObjectCountSeries(customAudioSeries, {
        expectedAudioWorkletCount: 1
    }).passed, true);
    assert.deepEqual(validateDOMAndObjectCountSeries(overAllocatedSeries, {
        expectedAudioWorkletCount: 1
    }).failures, [
        'performance-count-audio-worklet-processors-expected-count-mismatch'
    ]);
    assert.equal(validateDOMAndObjectCountSeries(disabledAudioSeries, {
        expectedAudioWorkletCount: 0
    }).passed, true);
    assert.throws(
        () => validateDOMAndObjectCountSeries(disabledAudioSeries, {
            expectedAudioWorkletCount: -1
        }),
        /nonnegative safe integer/u
    );

    const unavailableSeries = createPassingDOMSeries();
    const unavailableResult = validateDOMAndObjectCountSeries(unavailableSeries, {
        expectedAudioWorkletCount: 1
    });
    assert.deepEqual(unavailableResult.failures, [
        'live-object-audio-worklet-node-unavailable',
        'performance-count-audio-worklet-processors-unavailable'
    ]);
});

test('rejects positive Performance resource trends from the warmed baseline', () => {
    const stableSeries = createPassingDOMSeries();
    stableSeries.performanceObjectCounts = {
        AudioHandlers: createObservations([ 1, 1, 1, 1 ]),
        AudioWorkletProcessors: createObservations([ 1, 1, 1, 1 ]),
        WorkerGlobalScopes: createObservations([ 0, 0, 0, 0 ])
    };
    const stableResult = validateDOMAndObjectCountSeries(stableSeries);
    const growingSeries = createPassingDOMSeries();
    growingSeries.performanceObjectCounts = {
        AudioWorkletProcessors: createObservations([ 1, 2, 3, 4 ])
    };
    const growingResult = validateDOMAndObjectCountSeries(growingSeries);
    const noisyArrayBuffers = createPassingDOMSeries();
    noisyArrayBuffers.performanceObjectCounts = {
        ArrayBufferContents: createObservations([ 100, 132, 131, 132 ])
    };
    const noisyArrayBufferResult = validateDOMAndObjectCountSeries(noisyArrayBuffers);

    assert.equal(stableResult.passed, true);
    assert.equal(noisyArrayBufferResult.passed, true);
    assert.deepEqual(growingResult.failures, [
        'performance-count-audio-worklet-processors-final-growth-exceeded',
        'performance-count-audio-worklet-processors-last-three-median-growth-exceeded',
        'performance-count-audio-worklet-processors-slope-exceeded'
    ]);
});

test('reports DOM, stopped-worker, and named live-object failures', () => {
    const series = createPassingDOMSeries();
    series.documentCount = createObservations([ 2, 2, 3, 2 ]);
    series.workerCount = createObservations([ 0, 0, 1, 0 ]);
    series.liveObjectCounts.VideoFrame = createObservations([ 1, 2, 2, 3 ]);

    const result = validateDOMAndObjectCountSeries(series);

    assert.deepEqual(result.failures, [
        'document-count-changed',
        'worker-count-nonzero',
        'live-object-video-frame-final-growth-exceeded',
        'live-object-video-frame-slope-exceeded'
    ]);
});

test('reports missing DOM samples and throws for bad object-count input', () => {
    const missingSeries = createPassingDOMSeries();
    missingSeries.nodeCount.pop();

    const result = validateDOMAndObjectCountSeries(missingSeries);

    assert.ok(result.failures.includes('node-count-samples-missing'));
    assert.throws(
        () => validateDOMAndObjectCountSeries({}),
        /must be an object/u
    );
});
