import assert from 'node:assert/strict';
import test from 'node:test';

/* eslint-disable sonarjs/no-hardcoded-passwords -- Test-only sentinel values */

import {
    createFrontendRouteURL,
    parseSmokeConfiguration,
    sanitizeReport,
    validateActivePlaybackSnapshot,
    validatePauseSnapshot,
    validateResumeSnapshot,
    validateSeekSnapshot,
    validateStopSnapshot
} from './browser-smoke-helpers.mjs';

function createActiveSnapshot(overrides = {}) {
    return {
        captured: true,
        customPlayback: {
            currentTimeMicroseconds: 2_000_000,
            fallbackReason: null,
            hasLastError: false,
            state: 'playing',
            videoDecode: {
                failureKind: null,
                receivedFrameCount: 12
            }
        },
        dom: {
            canvasCount: 1,
            sourceLessVideoCount: 1,
            sourcedVideoCount: 0,
            visibleCanvasCount: 1
        },
        hasCurrentSource: false,
        isFetching: false,
        playerID: 'webgpuvideoplayer',
        presentation: {
            decodedFrameCount: 10,
            fallbackReason: null,
            presentationSource: 'decoded',
            presentedFrameCount: 10,
            state: 'presenting'
        },
        stoppedEventCount: 0,
        terminalErrorCount: 0,
        ...overrides
    };
}

test('parses CLI values before environment values', () => {
    const configuration = parseSmokeConfiguration([
        '--debug-url', 'http://localhost:9333',
        '--frontend-url', 'http://localhost:8181/',
        '--server-url', 'http://localhost:9096/',
        '--item-id', 'cli-item',
        '--username', 'cli-user',
        '--password', 'cli-password',
        '--timeout-ms', '45000'
    ], {
        WEBGPU_SMOKE_ITEM_ID: 'environment-item',
        WEBGPU_SMOKE_PASSWORD: 'environment-password',
        WEBGPU_SMOKE_USERNAME: 'environment-user'
    });

    assert.deepEqual(configuration, {
        debugURL: 'http://localhost:9333',
        frontendURL: 'http://localhost:8181',
        itemID: 'cli-item',
        password: 'cli-password',
        serverURL: 'http://localhost:9096',
        timeoutMilliseconds: 45_000,
        username: 'cli-user'
    });
});

test('uses local URL defaults without inventing credentials', () => {
    const configuration = parseSmokeConfiguration([], {
        WEBGPU_SMOKE_ITEM_ID: 'test-item',
        WEBGPU_SMOKE_PASSWORD: 'test-password',
        WEBGPU_SMOKE_USERNAME: 'test-user'
    });

    assert.equal(configuration.debugURL, 'http://localhost:9224');
    assert.equal(configuration.frontendURL, 'http://localhost:8080');
    assert.equal(configuration.serverURL, 'http://localhost:8096');
    assert.equal(configuration.timeoutMilliseconds, 30_000);
    assert.throws(
        () => parseSmokeConfiguration([], {}),
        /--item-id/u
    );
});

test('builds a hash route on the configured frontend', () => {
    assert.equal(
        createFrontendRouteURL('http://localhost:8080/web/', '/details?id=abc'),
        'http://localhost:8080/web/#/details?id=abc'
    );
});

test('accepts advancing source-less custom playback', () => {
    const initialSnapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            currentTimeMicroseconds: 1_000_000
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            presentedFrameCount: 5
        }
    });
    const laterSnapshot = createActiveSnapshot();

    assert.deepEqual(
        validateActivePlaybackSnapshot(initialSnapshot, laterSnapshot),
        []
    );
    assert.ok(validateActivePlaybackSnapshot(initialSnapshot, {
        ...laterSnapshot,
        dom: {
            ...laterSnapshot.dom,
            sourcedVideoCount: 1
        }
    }).includes('native-video-source-active'));
});

test('validates pause, resume, seek, and stop observations', () => {
    const pausedInitial = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            state: 'paused'
        }
    });
    const pausedLater = createActiveSnapshot({
        customPlayback: {
            ...pausedInitial.customPlayback,
            currentTimeMicroseconds: 2_050_000
        },
        presentation: {
            ...pausedInitial.presentation,
            presentedFrameCount: 11
        }
    });
    const resumedLater = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            currentTimeMicroseconds: 2_500_000
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            presentedFrameCount: 12
        }
    });
    const stoppedSnapshot = createActiveSnapshot({
        dom: {
            ...createActiveSnapshot().dom,
            canvasCount: 0,
            visibleCanvasCount: 0
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            state: 'idle'
        },
        stoppedEventCount: 1
    });

    assert.deepEqual(validatePauseSnapshot(pausedInitial, pausedLater), []);
    assert.deepEqual(validateResumeSnapshot(pausedLater, resumedLater), []);
    assert.deepEqual(validateSeekSnapshot(resumedLater, 2_500_000), []);
    assert.deepEqual(validateStopSnapshot(stoppedSnapshot), []);
});

test('sanitizes URLs and authentication material recursively', () => {
    const report = {
        message: 'Request http://localhost:8096/Videos/x?api_key=abc failed for sample-user',
        nested: {
            authorization: 'MediaBrowser Token=abc',
            frontendURL: 'http://localhost:8080',
            note: 'password=sample-secret and wss://localhost:9224/devtools/page/1'
        },
        username: 'sample-user'
    };
    const serialized = JSON.stringify(sanitizeReport(report, [
        'sample-secret',
        'sample-user'
    ]));

    assert.doesNotMatch(
        serialized,
        /sample-(?:secret|user)|localhost|https?:|wss?:|api_key=abc/iu
    );
    assert.match(serialized, /\[redacted\]/u);
    assert.match(serialized, /\[redacted-url\]/u);
});

/* eslint-enable sonarjs/no-hardcoded-passwords */
