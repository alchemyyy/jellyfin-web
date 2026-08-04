import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    countSubtitleWorkerTargets,
    createSubtitleCueEvidenceExpression,
    isSubtitleResourceURL,
    loadSubtitleValidationCase,
    validateSubtitleCueProbe,
    validateSubtitlePauseProbes,
    validateSubtitleRouteSnapshot
} from './subtitle-smoke-adapter.mjs';

const TEXT_SHA256 = 'a'.repeat(64);
const IMAGE_SHA256 = 'b'.repeat(64);
const EXPECTED_BOUNDS = Object.freeze({
    height: 0.1,
    tolerance: 0.02,
    width: 0.4,
    x: 0.3,
    y: 0.8
});

function createCue(identifier, baseMicroseconds, useImage = false) {
    return {
        activeProbeMicroseconds: baseMicroseconds + 1_500_000,
        afterProbeMicroseconds: baseMicroseconds + 3_500_000,
        beforeProbeMicroseconds: baseMicroseconds + 500_000,
        endMicroseconds: baseMicroseconds + 3_000_000,
        expectedBounds: { ...EXPECTED_BOUNDS },
        id: identifier,
        ...(useImage ? { imageSHA256: IMAGE_SHA256 } : {
            normalizedTextSHA256: TEXT_SHA256
        }),
        startMicroseconds: baseMicroseconds + 1_000_000,
        styleAssertions: [ 'safe-area' ]
    };
}

function createTrack(overrides = {}) {
    return {
        cueAssertions: [
            createCue('cue-one', 0),
            createCue('cue-two', 4_000_000),
            createCue('cue-three', 8_000_000)
        ],
        expectedDeliveredFormat: 'vtt',
        expectedDeliveryMethod: 'External',
        offsetsMicroseconds: [ -1_500_000, 0, 1_500_000 ],
        role: 'primary',
        routeId: 'webvtt-external',
        sourceFormat: 'webvtt',
        sourceKind: 'external',
        streamIndex: 4,
        ...overrides
    };
}

function createSpecification() {
    return {
        $schema: 'subtitle-live-spec-schema.json',
        schemaVersion: 1,
        sources: [ {
            exerciseIds: [ 'directplay-negotiation', 'timing-seek-pause' ],
            expectedPlayMethod: 'DirectPlay',
            failureModes: [ 'subtitle-fetch' ],
            id: 'private-vtt-source',
            itemEnvironment: 'SUBTITLE_ITEM_ID',
            licenseEnvironment: 'SUBTITLE_LICENSE_PATH',
            licenseExpression: 'LicenseRef-Private-Validation-Only',
            media: {
                container: 'matroska',
                packetization: 'avc',
                video: { frameRate: 24 }
            },
            mediaEnvironment: 'SUBTITLE_MEDIA_PATH',
            playerModes: [ 'html', 'custom' ],
            provenance: {
                generatorArguments: [ 'private' ],
                kind: 'upstream',
                revision: 'local-v1',
                source: 'Private source record'
            },
            title: 'Private title that must not enter evidence',
            tracks: [ createTrack() ]
        } ]
    };
}

test('loads, hashes, and sanitizes one exact private subtitle case', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'subtitle-smoke-'));
    const specificationPath = join(directory, 'spec.json');
    const mediaPath = join(directory, 'private-video.mkv');
    const licensePath = join(directory, 'license.txt');
    try {
        await writeFile(mediaPath, 'media-bytes', 'utf8');
        await writeFile(licensePath, 'license-evidence', 'utf8');
        await writeFile(
            specificationPath,
            JSON.stringify(createSpecification()),
            'utf8'
        );
        const result = await loadSubtitleValidationCase(specificationPath, {
            SUBTITLE_ITEM_ID: 'private-item',
            SUBTITLE_LICENSE_PATH: licensePath,
            SUBTITLE_MEDIA_PATH: mediaPath
        }, 'private-item');

        assert.equal(result.case.sourceID, 'private-vtt-source');
        assert.equal(result.case.expectedPlayMethod, 'DirectPlay');
        assert.equal(result.case.frameDurationMicroseconds, 41_667);
        assert.equal(result.case.tracks[0].sourceFormat, 'vtt');
        assert.equal(result.case.tracks[0].expectedRenderer, 'forced-dom-text');
        assert.equal(result.preflightEvidence.media.byteLength, 11);
        assert.match(result.preflightEvidence.media.sha256, /^[a-f0-9]{64}$/u);
        assert.deepEqual(result.privateValues, [ specificationPath, mediaPath, licensePath ]);
        assert.doesNotMatch(
            JSON.stringify({ case: result.case, evidence: result.preflightEvidence }),
            /Private title|private-video|subtitle-smoke-/u
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test('rejects an invalid cue envelope before reading private assets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'subtitle-smoke-invalid-'));
    const specificationPath = join(directory, 'spec.json');
    try {
        const specification = createSpecification();
        specification.sources[0].tracks[0].cueAssertions[0].beforeProbeMicroseconds =
            1_500_000;
        await writeFile(specificationPath, JSON.stringify(specification), 'utf8');
        await assert.rejects(
            loadSubtitleValidationCase(specificationPath, {
                SUBTITLE_ITEM_ID: 'private-item'
            }, 'private-item'),
            /probe times do not bracket the cue/u
        );
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test('counts only scoped libass and libpgs workers without returning URLs', () => {
    const counts = countSubtitleWorkerTargets({
        targetInfos: [
            {
                browserContextId: 'controlled-context',
                openerId: 'controlled-page',
                targetId: 'ass',
                title: 'subtitles-octopus-worker.js',
                type: 'worker',
                url: 'http://private.example/libraries/subtitles-octopus-worker.js'
            },
            {
                browserContextId: 'controlled-context',
                openerId: 'controlled-page',
                targetId: 'pgs',
                title: 'libpgs.worker.js',
                type: 'worker',
                url: 'http://private.example/libraries/libpgs.worker.js'
            },
            {
                browserContextId: 'other-context',
                openerId: 'other-page',
                targetId: 'other',
                title: 'libpgs.worker.js',
                type: 'worker',
                url: 'http://private.example/libraries/libpgs.worker.js'
            }
        ]
    }, {
        browserContextID: 'controlled-context',
        pageTargetID: 'controlled-page'
    });

    assert.deepEqual(counts, {
        libassWorkerCount: 1,
        libpgsWorkerCount: 1,
        subtitleWorkerCount: 2
    });
    assert.doesNotMatch(JSON.stringify(counts), /private|https?:/u);
});

test('recognizes only bounded subtitle resource routes', () => {
    assert.equal(
        isSubtitleResourceURL('http://localhost/Videos/item/Subtitles/4/Stream.vtt?token=secret'),
        true
    );
    assert.equal(isSubtitleResourceURL('http://localhost/private/track.ass'), true);
    assert.equal(isSubtitleResourceURL('http://localhost/Videos/item/stream.mkv'), false);
    assert.equal(isSubtitleResourceURL('not a URL'), false);
});

test('validates selected route metadata and bounded renderer resources', () => {
    const track = {
        expectedDeliveredFormat: 'vtt',
        expectedDeliveryMethod: 'External',
        expectedRenderer: 'forced-dom-text',
        role: 'primary',
        sourceFormat: 'vtt',
        sourceKind: 'external',
        streamIndex: 4
    };
    const snapshot = {
        primary: {
            codec: 'vtt',
            deliveredFormat: 'vtt',
            deliveryMethod: 'External',
            sourceKind: 'external',
            streamIndex: 4
        },
        secondary: null,
        surfaceCounts: {
            primaryTextSurfaceCount: 1,
            secondaryTextSurfaceCount: 0,
            specializedCanvasCount: 0
        },
        workerCounts: {
            subtitleWorkerCount: 0
        }
    };

    assert.deepEqual(validateSubtitleRouteSnapshot(snapshot, track), []);
    assert.deepEqual(
        validateSubtitleRouteSnapshot({
            ...snapshot,
            primary: { ...snapshot.primary, deliveryMethod: 'Encode' },
            surfaceCounts: { ...snapshot.surfaceCounts, primaryTextSurfaceCount: 2 },
            workerCounts: { subtitleWorkerCount: 3 }
        }, track),
        [
            'selected-delivery-method-mismatch',
            'primary-text-surface-count-unbounded',
            'subtitle-worker-count-unbounded',
            'unexpected-subtitle-worker'
        ]
    );
});

test('validates media-time cue hashes, bounds, clear edges, and pause stability', () => {
    const cue = createCue('cue-one', 0);
    const activeProbe = {
        canvasSurfaces: [],
        mediaTimeMicroseconds: cue.activeProbeMicroseconds,
        nativeCueSurfaces: [],
        screenshot: { sha256: IMAGE_SHA256, status: 'captured' },
        textSurfaces: [ {
            bounds: { ...EXPECTED_BOUNDS },
            contentPresent: true,
            kind: 'dom-text',
            pointerEventsNone: true,
            role: 'primary',
            sha256: TEXT_SHA256
        } ]
    };
    const clearProbe = {
        ...activeProbe,
        mediaTimeMicroseconds: cue.beforeProbeMicroseconds,
        textSurfaces: [ {
            ...activeProbe.textSurfaces[0],
            contentPresent: false,
            sha256: null
        } ]
    };

    assert.deepEqual(
        validateSubtitleCueProbe(
            activeProbe,
            cue,
            'active',
            'forced-dom-text',
            62_000
        ),
        []
    );
    assert.deepEqual(
        validateSubtitleCueProbe(clearProbe, cue, 'before', 'forced-dom-text', 62_000),
        []
    );
    assert.deepEqual(
        validateSubtitlePauseProbes(
            activeProbe,
            { ...activeProbe, mediaTimeMicroseconds: activeProbe.mediaTimeMicroseconds + 1_000 },
            62_000
        ),
        []
    );
});

test('cue expression hashes normalized text and pixels without returning raw text', () => {
    const expression = createSubtitleCueEvidenceExpression('private-access-key');

    assert.match(expression, /crypto\.subtle\.digest\('SHA-256'/u);
    assert.match(expression, /getImageData/u);
    assert.match(expression, /mediaTimeMicroseconds/u);
    assert.doesNotMatch(expression, /return\s+\{[^}]*text:/u);
});
