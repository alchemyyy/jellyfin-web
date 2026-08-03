import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createFrameBoundarySeekMilliseconds,
    isExpectedAudioStreamReady,
    parseReferenceCaptureConfiguration,
    summarizeAudioSignal,
    summarizePacingSamples,
    validateReferenceCapturePlan
} from './browser-reference-capture-helpers.mjs';

test('biases exact source PTS seeks past the frame boundary', () => {
    assert.equal(createFrameBoundarySeekMilliseconds(60_018_000), 60_019);
    assert.equal(createFrameBoundarySeekMilliseconds(60_018_999), 60_019);
    assert.throws(
        () => createFrameBoundarySeekMilliseconds(-1),
        /Frame boundary seek target/
    );
});

function createPlan() {
    return {
        caseId: 'hdr-reference',
        jellyfin: {
            audioStreamIndex: 1,
            expected: {
                audioCodec: 'flac',
                audioPath: 'ready',
                videoDecoder: 'native',
                videoOutput: 'video-frame'
            },
            itemId: 'item-id'
        },
        pacing: {
            durationMilliseconds: 10_000,
            startTimeMicroseconds: 60_000_000
        },
        schemaVersion: 1,
        visual: {
            captureToleranceMicroseconds: 100_000,
            height: 1_080,
            timestampsMicroseconds: [ 60_000_000, 120_000_000 ],
            width: 1_920
        }
    };
}

test('validates and normalizes a reference capture plan', () => {
    assert.deepEqual(validateReferenceCapturePlan(createPlan()), {
        caseID: 'hdr-reference',
        jellyfin: {
            audioStreamIndex: 1,
            expected: {
                audioCodec: 'flac',
                audioPath: 'ready',
                videoDecoder: 'native',
                videoOutput: 'video-frame'
            },
            itemID: 'item-id'
        },
        pacing: {
            durationMilliseconds: 10_000,
            startTimeMicroseconds: 60_000_000
        },
        schemaVersion: 1,
        visual: {
            captureToleranceMicroseconds: 100_000,
            height: 1_080,
            timestampsMicroseconds: [ 60_000_000, 120_000_000 ],
            width: 1_920
        }
    });
});

test('rejects duplicate visual timestamps and excessive pacing duration', () => {
    const duplicatePlan = createPlan();
    duplicatePlan.visual.timestampsMicroseconds = [ 60_000_000, 60_000_000 ];
    assert.throws(() => validateReferenceCapturePlan(duplicatePlan), /unique/);

    const longPlan = createPlan();
    longPlan.pacing.durationMilliseconds = 12_001;
    assert.throws(() => validateReferenceCapturePlan(longPlan), /Pacing duration/);
});

test('parses CLI values before environment fallbacks', () => {
    const commandCredential = 'command-credential';
    const environmentCredential = 'environment-credential';
    const configuration = parseReferenceCaptureConfiguration([
        '--plan', 'plan.json',
        '--output-directory', 'output',
        '--debug-url', 'http://localhost:9224',
        '--frontend-url', 'http://localhost:8096/web/',
        '--server-url', 'http://localhost:8096',
        '--username', 'command-user',
        '--password', commandCredential
    ], {
        WEBGPU_AB_USERNAME: 'environment-user',
        WEBGPU_AB_PASSWORD: environmentCredential
    });

    assert.equal(configuration.username, 'command-user');
    assert.equal(configuration.password, commandCredential);
    assert.equal(configuration.timeoutMilliseconds, 90_000);
});

test('summarizes changed-frame wall and media intervals', () => {
    const summary = summarizePacingSamples([
        {
            presentedFrameCount: 1,
            presentedMediaTimeMicroseconds: 1_000_000,
            wallTimeMilliseconds: 0
        },
        {
            presentedFrameCount: 1,
            presentedMediaTimeMicroseconds: 1_000_000,
            wallTimeMilliseconds: 16
        },
        {
            presentedFrameCount: 2,
            presentedMediaTimeMicroseconds: 1_041_708,
            wallTimeMilliseconds: 50
        },
        {
            presentedFrameCount: 3,
            presentedMediaTimeMicroseconds: 1_083_416,
            wallTimeMilliseconds: 83
        }
    ]);

    assert.deepEqual(summary, {
        changedFrameCount: 2,
        mediaIntervalMicroseconds: {
            maximum: 41_708,
            median: 41_708,
            p95: 41_708
        },
        wallIntervalMilliseconds: {
            maximum: 50,
            median: 33,
            p95: 50
        }
    });
});

test('summarizes post-gain audio amplitude without inventing loudness', () => {
    const summary = summarizeAudioSignal({
        analyzedFrameCount: 2,
        analyzedSampleCount: 4,
        clippedSampleCount: 0,
        nonFiniteSampleCount: 0,
        samplePeak: 1,
        sampleSquareSum: 1
    });

    assert.equal(summary.rootMeanSquare, 0.5);
    assert.equal(summary.peakDecibelsFullScale, 0);
    assert.equal(summary.rootMeanSquareDecibelsFullScale, 20 * Math.log10(0.5));
    assert.equal(summary.crestFactorDecibels, 20 * Math.log10(2));
});

test('waits for the selected custom audio route without requiring a restart', () => {
    const plan = validateReferenceCapturePlan(createPlan());
    const pendingSnapshot = {
        customPlayback: {
            audioPath: 'pending',
            jellyfinAudioStreamIndex: 1,
            state: 'playing',
            videoDecode: { audioCodec: 'flac' }
        },
        presentation: { state: 'presenting' }
    };
    assert.equal(isExpectedAudioStreamReady(pendingSnapshot, plan), false);

    pendingSnapshot.customPlayback.audioPath = 'ready';
    assert.equal(isExpectedAudioStreamReady(pendingSnapshot, plan), true);

    pendingSnapshot.customPlayback.jellyfinAudioStreamIndex = 2;
    assert.equal(isExpectedAudioStreamReady(pendingSnapshot, plan), false);
});
