import assert from 'node:assert/strict';
import test from 'node:test';

/* eslint-disable sonarjs/no-hardcoded-passwords -- Test-only sentinel values */

import {
    areEquivalentServerURLs,
    createFrontendAssetURL,
    createPrimarySeekTargetMicroseconds,
    createSeekStormTargetsMicroseconds,
    createStartupSampleModeOrder,
    createFrontendRouteURL,
    deriveRawHDRPlaybackRouteKey,
    getStartupModeFeatureFlags,
    getExpectedServerLogSessionCount,
    hasAuthorizedHDRPlaybackRoute,
    hasAuthorizedProfile7FELPlaybackRoute,
    hasAuthorizedRawHDRPlaybackRoute,
    hasConsumedCustomAudio,
    hasExpectedPresentationRoute,
    hasReadyNativeMediaAudio,
    isFrontendInitializationReady,
    isVideoSampleOwnershipWarning,
    parseSmokeConfiguration,
    resolveServerConnectionLandingAction,
    sanitizeReport,
    SMOKE_USAGE,
    validateActivePlaybackSnapshot,
    validateAudioStreamSwitchSnapshot,
    validateControlEventTransitions,
    validateFullscreenTransitionSnapshots,
    validateInjectedDeviceRecoverySnapshot,
    validateInjectedPresentationFallbackSnapshot,
    validateNaturalEndSnapshots,
    validatePausedDeviceRecoverySnapshots,
    validatePauseSnapshot,
    validatePlaybackDecisionEvidence,
    validatePresentedFrameEvidence,
    validateResizedPresentationSnapshot,
    validateResumeSnapshot,
    validateSeekStormSnapshot,
    validateSeekSnapshot,
    validateStopSnapshot
} from './browser-smoke-helpers.mjs';

const SDR_EXPECTATIONS = Object.freeze({
    expectedAudioPath: 'disabled',
    expectedPlayMethod: 'DirectPlay',
    expectedVideoDecoderBackend: 'native',
    expectedVideoOutputMode: 'video-frame'
});
const HDR_AUDIO_EXPECTATIONS = Object.freeze({
    expectedAudioPath: 'ready',
    expectedPlayMethod: 'DirectPlay',
    expectedVideoDecoderBackend: 'bundled-hevc',
    expectedVideoOutputMode: 'raw-planes'
});

function createActiveSnapshot(overrides = {}) {
    return {
        captured: true,
        customPlayback: {
            activeGeneration: 1,
            audioBridge: null,
            audioOutput: null,
            audioPath: 'disabled',
            currentTimeMicroseconds: 2_000_000,
            durationMicroseconds: 120_000_000,
            fallbackReason: null,
            hasLastError: false,
            staleEventCount: 0,
            state: 'playing',
            videoDecode: {
                activeGeneration: 1,
                audioCodec: null,
                failureKind: null,
                nativeAudioClockReady: false,
                peakFrameCount: 2,
                pendingFrameCount: 0,
                queuedFrameCount: 2,
                receivedFrameCount: 12,
                receivedNativeAudioSegmentCount: 0,
                staleAudioSampleCount: 0,
                staleFrameCount: 0
            }
        },
        customPlaybackEligibility: {
            audioOutputMode: null,
            eligible: true,
            hdr: false,
            reason: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        },
        dom: {
            canvasBackingHeight: 1080,
            canvasBackingWidth: 1920,
            canvasCount: 1,
            canvasCSSHeight: 1080,
            canvasCSSWidth: 1920,
            devicePixelRatio: 1,
            fullscreenActive: false,
            fullscreenContainsCanvas: false,
            nativeVideoPlaying: false,
            nativeVideoTimeMicroseconds: null,
            ownedNativeAudioCount: 0,
            ownedNativeAudioPlaying: false,
            ownedNativeAudioSourcedCount: 0,
            ownedNativeAudioTimeMicroseconds: null,
            sourceLessVideoCount: 1,
            sourcedVideoCount: 0,
            viewportHeight: 1080,
            viewportWidth: 1920,
            visibleCanvasCount: 1
        },
        eventCounts: {
            ended: 0,
            error: 0,
            fullscreenchange: 0,
            pause: 0,
            playbackstart: 1,
            playing: 1,
            stopped: 0,
            timeupdate: 10,
            unpause: 0,
            volumechange: 0,
            waiting: 1
        },
        eventSequence: [ 'waiting', 'playing', 'playbackstart' ],
        hasCurrentSource: false,
        isFetching: false,
        playbackDecision: {
            hasMediaSourceIdentifier: true,
            hasTranscodingURL: true,
            playMethod: 'DirectPlay',
            supportsDirectPlay: true,
            supportsDirectStream: true,
            supportsTranscoding: true
        },
        playerID: 'webgpuvideoplayer',
        presentation: {
            decodedFrameCount: 10,
            deviceRecoveryCount: 0,
            fallbackReason: null,
            presentationSource: 'decoded',
            presentedFrameCount: 10,
            mode: 'identity-sdr',
            state: 'presenting'
        },
        rawHDRValidation: null,
        rawHDRPlaybackRouteKey: null,
        sessionGeneration: 1,
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
        '--server-log-directory', 'C:\\validation-logs',
        '--item-id', 'cli-item',
        '--completion-mode', 'controlled-stop',
        '--expected-video-decoder', 'bundled-hevc',
        '--expected-video-output', 'raw-planes',
        '--expected-audio', 'ready',
        '--expected-frame-evidence', 'testsrc2-motion',
        '--expected-presentation-route', 'raw-hdr-pq',
        '--expected-play-method', 'DirectPlay',
        '--username', 'cli-user',
        '--password', 'cli-password',
        '--repeat-sessions', '3',
        '--inject-failure', 'presentation',
        '--seek-storm-count', '4',
        '--timeout-ms', '45000'
    ], {
        WEBGPU_SMOKE_EXPECTED_AUDIO: 'disabled',
        WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER: 'native',
        WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'video-frame',
        WEBGPU_SMOKE_ITEM_ID: 'environment-item',
        WEBGPU_SMOKE_PASSWORD: 'environment-password',
        WEBGPU_SMOKE_USERNAME: 'environment-user'
    });

    assert.deepEqual(configuration, {
        audioStreamIndex: null,
        completionMode: 'controlled-stop',
        debugURL: 'http://localhost:9333',
        expectedAudioCodec: null,
        expectedAudioConfiguration: null,
        frontendURL: 'http://localhost:8181',
        expectedAudioPath: 'ready',
        expectedFrameEvidence: 'testsrc2-motion',
        expectedPlayMethod: 'DirectPlay',
        expectedPresentationRoute: 'raw-hdr-pq',
        expectedVideoDecoderBackend: 'bundled-hevc',
        expectedVideoOutputMode: 'raw-planes',
        failureInjection: 'presentation',
        itemID: 'cli-item',
        password: 'cli-password',
        repeatSessionCount: 3,
        seekStormCount: 4,
        serverURL: 'http://localhost:9096',
        serverLogDirectory: 'C:\\validation-logs',
        soakSessionCount: 0,
        startupSampleCount: 0,
        timeoutMilliseconds: 45_000,
        username: 'cli-user'
    });
});

test('documents the required output expectations in CLI and environment usage', () => {
    assert.match(SMOKE_USAGE, /--expected-video-output <video-frame\|raw-planes>/u);
    assert.match(SMOKE_USAGE, /--server-log-directory <path>/u);
    assert.match(SMOKE_USAGE, /--expected-video-decoder <native\|bundled-hevc>/u);
    assert.match(SMOKE_USAGE, /--expected-audio <disabled\|ready\|native-media>/u);
    assert.match(SMOKE_USAGE, /--audio-stream-index <number>/u);
    assert.match(SMOKE_USAGE, /--expected-audio-codec <codec>/u);
    assert.match(SMOKE_USAGE, /--expected-audio-source-channels <number>/u);
    assert.match(SMOKE_USAGE, /--expected-audio-source-rate <number>/u);
    assert.match(SMOKE_USAGE, /--expected-audio-output-channels <number>/u);
    assert.match(SMOKE_USAGE, /--expected-audio-output-rate <number>/u);
    assert.match(SMOKE_USAGE, /--expected-frame-evidence <none\|testsrc2-motion>/u);
    assert.match(SMOKE_USAGE, /--expected-presentation-route <route>/u);
    assert.match(
        SMOKE_USAGE,
        /--expected-play-method <DirectPlay\|DirectStream\|Transcode>/u
    );
    assert.match(SMOKE_USAGE, /--completion-mode <controlled-stop\|natural-end>/u);
    assert.match(SMOKE_USAGE, /--repeat-sessions <1-5>/u);
    assert.match(
        SMOKE_USAGE,
        /--inject-failure <none\|presentation\|device-loss\|paused-device-loss>/u
    );
    assert.match(SMOKE_USAGE, /--seek-storm-count <0-5>/u);
    assert.match(SMOKE_USAGE, /--soak-sessions <0\|10-100>/u);
    assert.match(SMOKE_USAGE, /--startup-samples <0\|10-30>/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_SERVER_LOG_DIRECTORY/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_EXPECTED_AUDIO/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_EXPECTED_PRESENTATION_ROUTE/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_EXPECTED_PLAY_METHOD/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_AUDIO_STREAM_INDEX/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_EXPECTED_AUDIO_SOURCE_CHANNELS/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_EXPECTED_AUDIO_SOURCE_RATE/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_EXPECTED_AUDIO_OUTPUT_CHANNELS/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_EXPECTED_AUDIO_OUTPUT_RATE/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_EXPECTED_FRAME_EVIDENCE/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_COMPLETION_MODE/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_SEEK_STORM_COUNT/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_SOAK_SESSIONS/u);
    assert.match(SMOKE_USAGE, /WEBGPU_SMOKE_STARTUP_SAMPLES/u);
});

test('uses local URL defaults without inventing credentials', () => {
    const configuration = parseSmokeConfiguration([], {
        WEBGPU_SMOKE_ITEM_ID: 'test-item',
        WEBGPU_SMOKE_EXPECTED_AUDIO: 'disabled',
        WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'video-frame',
        WEBGPU_SMOKE_PASSWORD: 'test-password',
        WEBGPU_SMOKE_USERNAME: 'test-user'
    });

    assert.equal(configuration.debugURL, 'http://localhost:9224');
    assert.equal(configuration.frontendURL, 'http://localhost:8096/web');
    assert.equal(configuration.serverURL, 'http://localhost:8096');
    assert.equal(configuration.serverLogDirectory, null);
    assert.equal(configuration.timeoutMilliseconds, 30_000);
    assert.equal(configuration.completionMode, 'controlled-stop');
    assert.equal(configuration.repeatSessionCount, 1);
    assert.equal(configuration.seekStormCount, 3);
    assert.equal(configuration.failureInjection, 'none');
    assert.equal(configuration.soakSessionCount, 0);
    assert.equal(configuration.startupSampleCount, 0);
    assert.equal(configuration.audioStreamIndex, null);
    assert.equal(configuration.expectedAudioCodec, null);
    assert.equal(configuration.expectedAudioConfiguration, null);
    assert.equal(configuration.expectedAudioPath, 'disabled');
    assert.equal(configuration.expectedFrameEvidence, 'none');
    assert.equal(configuration.expectedPlayMethod, null);
    assert.equal(configuration.expectedVideoDecoderBackend, null);
    assert.equal(configuration.expectedVideoOutputMode, 'video-frame');
    assert.throws(
        () => parseSmokeConfiguration([], {
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'disabled',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'video-frame'
        }),
        /--item-id/u
    );
});

test('requires submitted and consumed decoded PCM for custom audio startup', () => {
    const snapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            audioBridge: {
                submittedFrameCount: 1_024,
                submittedSampleCount: 1
            },
            audioOutput: {
                consumedFrames: 1,
                outputFrames: 128,
                playing: true
            }
        }
    });
    const silentUnderflow = {
        ...snapshot,
        customPlayback: {
            ...snapshot.customPlayback,
            audioOutput: {
                consumedFrames: 0,
                outputFrames: 4_096,
                playing: true
            }
        }
    };

    assert.equal(hasConsumedCustomAudio(snapshot), true);
    assert.equal(hasConsumedCustomAudio(silentUnderflow), false);
    assert.equal(hasConsumedCustomAudio({
        ...snapshot,
        customPlayback: {
            ...snapshot.customPlayback,
            audioBridge: {
                submittedFrameCount: 0,
                submittedSampleCount: 0
            }
        }
    }), false);
});

test('requires an advancing qualified owned native audio element', () => {
    const snapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            audioPath: 'ready',
            videoDecode: {
                ...createActiveSnapshot().customPlayback.videoDecode,
                audioCodec: 'ec-3',
                nativeAudioClockReady: true,
                receivedNativeAudioSegmentCount: 4
            }
        },
        customPlaybackEligibility: {
            ...createActiveSnapshot().customPlaybackEligibility,
            audioOutputMode: 'native-media'
        },
        dom: {
            ...createActiveSnapshot().dom,
            ownedNativeAudioCount: 1,
            ownedNativeAudioPlaying: true,
            ownedNativeAudioSourcedCount: 1,
            ownedNativeAudioTimeMicroseconds: 2_000_000
        }
    });

    assert.equal(hasReadyNativeMediaAudio(snapshot), true);
    assert.equal(hasReadyNativeMediaAudio({
        ...snapshot,
        customPlayback: {
            ...snapshot.customPlayback,
            videoDecode: {
                ...snapshot.customPlayback.videoDecode,
                nativeAudioClockReady: false
            }
        }
    }), false);
    assert.equal(hasReadyNativeMediaAudio({
        ...snapshot,
        dom: {
            ...snapshot.dom,
            ownedNativeAudioPlaying: false
        }
    }), false);
});

test('recognizes each initialized frontend landing state', () => {
    assert.equal(isFrontendInitializationReady({
        apiClientAvailable: true,
        apiClientLandingAvailable: true,
        serverHostInputAvailable: false,
        serverSelectionPageAvailable: false
    }), true);
    assert.equal(isFrontendInitializationReady({
        apiClientAvailable: false,
        serverHostInputAvailable: true,
        serverSelectionPageAvailable: false
    }), true);
    assert.equal(isFrontendInitializationReady({
        apiClientAvailable: false,
        serverHostInputAvailable: false,
        serverSelectionPageAvailable: true
    }), true);
    assert.equal(isFrontendInitializationReady({
        apiClientAvailable: false,
        serverHostInputAvailable: false,
        serverSelectionPageAvailable: false
    }), false);
    assert.equal(isFrontendInitializationReady({
        apiClientAvailable: true,
        apiClientLandingAvailable: false,
        serverHostInputAvailable: false,
        serverSelectionPageAvailable: false
    }), false);
    assert.equal(isFrontendInitializationReady(null), false);
});

test('opens or uses the add-server form after isolated startup', () => {
    assert.equal(resolveServerConnectionLandingAction({
        addServerButtonAvailable: false,
        serverHostInputAvailable: true
    }), 'enter-server');
    assert.equal(resolveServerConnectionLandingAction({
        addServerButtonAvailable: true,
        serverHostInputAvailable: false
    }), 'open-add-server');
    assert.equal(resolveServerConnectionLandingAction({
        addServerButtonAvailable: false,
        serverHostInputAvailable: false
    }), null);
    assert.equal(resolveServerConnectionLandingAction({
        addServerButtonAvailable: false,
        loginPageAvailable: true,
        serverHostInputAvailable: false
    }), 'use-selected-server');
    assert.equal(resolveServerConnectionLandingAction({
        addServerButtonAvailable: false,
        loginPageAvailable: false,
        serverHostInputAvailable: false
    }), null);
    assert.equal(resolveServerConnectionLandingAction(null), null);
});

test('configures an isolated paired startup comparison', () => {
    const environment = {
        WEBGPU_SMOKE_EXPECTED_AUDIO: 'ready',
        WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'raw-planes',
        WEBGPU_SMOKE_ITEM_ID: 'startup-item',
        WEBGPU_SMOKE_PASSWORD: 'test-password',
        WEBGPU_SMOKE_USERNAME: 'test-user'
    };
    const configuration = parseSmokeConfiguration([
        '--startup-samples', '10'
    ], environment);

    assert.equal(configuration.startupSampleCount, 10);
    assert.equal(configuration.seekStormCount, 0);
    assert.throws(
        () => parseSmokeConfiguration([ '--startup-samples', '9' ], environment),
        /startup samples/u
    );
    assert.throws(
        () => parseSmokeConfiguration([
            '--startup-samples', '10',
            '--soak-sessions', '10'
        ], environment),
        /startup mode requires --soak-sessions 0/u
    );
    assert.throws(
        () => parseSmokeConfiguration([
            '--startup-samples', '10',
            '--repeat-sessions', '2'
        ], environment),
        /startup mode requires --repeat-sessions 1/u
    );
    assert.throws(
        () => parseSmokeConfiguration([
            '--startup-samples', '10',
            '--seek-storm-count', '1'
        ], environment),
        /startup mode requires --seek-storm-count 0/u
    );
});

test('alternates native and custom startup order around presentation', () => {
    assert.deepEqual(
        createStartupSampleModeOrder(1),
        [ 'html', 'presentation', 'custom' ]
    );
    assert.deepEqual(
        createStartupSampleModeOrder(2),
        [ 'custom', 'presentation', 'html' ]
    );
    assert.throws(() => createStartupSampleModeOrder(0), /positive safe integer/u);
});

test('counts exact server playback sessions for every exercise shape', () => {
    assert.equal(getExpectedServerLogSessionCount({
        failureInjection: 'none',
        repeatSessionCount: 3,
        soakSessionCount: 0,
        startupSampleCount: 0
    }), 3);
    assert.equal(getExpectedServerLogSessionCount({
        failureInjection: 'device-loss',
        repeatSessionCount: 3,
        soakSessionCount: 0,
        startupSampleCount: 0
    }), 4);
    assert.equal(getExpectedServerLogSessionCount({
        failureInjection: 'none',
        repeatSessionCount: 1,
        soakSessionCount: 30,
        startupSampleCount: 0
    }), 30);
    assert.equal(getExpectedServerLogSessionCount({
        failureInjection: 'none',
        repeatSessionCount: 1,
        soakSessionCount: 0,
        startupSampleCount: 10
    }), 33);
});

test('defines isolated feature overlays for every startup mode', () => {
    assert.deepEqual(getStartupModeFeatureFlags('html'), {
        enableWebGPUCustomDecode: false,
        enableWebGPUHDRToneMapping: false,
        enableWebGPUValidationHarness: false,
        enableWebGPUVideoPlayer: false
    });
    assert.deepEqual(getStartupModeFeatureFlags('presentation'), {
        enableWebGPUCustomDecode: false,
        enableWebGPUHDRToneMapping: false,
        enableWebGPUValidationHarness: false,
        enableWebGPUVideoPlayer: true
    });
    assert.deepEqual(getStartupModeFeatureFlags('custom'), {
        enableWebGPUCustomDecode: true,
        enableWebGPUHDRToneMapping: true,
        enableWebGPUValidationHarness: true,
        enableWebGPUVideoPlayer: true
    });
    assert.throws(() => getStartupModeFeatureFlags('invalid'), /Unknown startup/u);
});

test('configures an isolated post-stop retention soak', () => {
    const environment = {
        WEBGPU_SMOKE_EXPECTED_AUDIO: 'ready',
        WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'raw-planes',
        WEBGPU_SMOKE_ITEM_ID: 'soak-item',
        WEBGPU_SMOKE_PASSWORD: 'test-password',
        WEBGPU_SMOKE_USERNAME: 'test-user'
    };
    const configuration = parseSmokeConfiguration([
        '--soak-sessions', '30'
    ], environment);

    assert.equal(configuration.soakSessionCount, 30);
    assert.equal(configuration.seekStormCount, 0);
    assert.throws(
        () => parseSmokeConfiguration([ '--soak-sessions', '9' ], environment),
        /soak sessions/u
    );
    assert.throws(
        () => parseSmokeConfiguration([
            '--soak-sessions', '30',
            '--repeat-sessions', '2'
        ], environment),
        /soak mode requires --repeat-sessions 1/u
    );
    assert.throws(
        () => parseSmokeConfiguration([
            '--soak-sessions', '30',
            '--inject-failure', 'device-loss'
        ], environment),
        /soak mode requires --inject-failure none/u
    );
    assert.throws(
        () => parseSmokeConfiguration([
            '--soak-sessions', '30',
            '--seek-storm-count', '1'
        ], environment),
        /soak mode requires --seek-storm-count 0/u
    );
    assert.throws(
        () => parseSmokeConfiguration([
            '--soak-sessions', '30',
            '--expected-frame-evidence', 'testsrc2-motion'
        ], environment),
        /soak mode requires --expected-frame-evidence none/u
    );
});

test('identifies only the VideoSample ownership finalizer warning', () => {
    assert.equal(isVideoSampleOwnershipWarning(
        'A VideoSample was garbage collected without being closed.'
    ), true);
    assert.equal(isVideoSampleOwnershipWarning(
        'VideoSample decode completed and the sample was closed'
    ), false);
    assert.equal(isVideoSampleOwnershipWarning('Unrelated browser warning'), false);
    assert.equal(isVideoSampleOwnershipWarning(null), false);
});

test('configures an isolated natural-end lifecycle exercise', () => {
    const configuration = parseSmokeConfiguration([
        '--completion-mode', 'natural-end'
    ], {
        WEBGPU_SMOKE_EXPECTED_AUDIO: 'ready',
        WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER: 'bundled-hevc',
        WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'raw-planes',
        WEBGPU_SMOKE_ITEM_ID: 'natural-end-item',
        WEBGPU_SMOKE_PASSWORD: 'test-password',
        WEBGPU_SMOKE_USERNAME: 'test-user'
    });

    assert.equal(configuration.completionMode, 'natural-end');
    assert.equal(configuration.repeatSessionCount, 1);
    assert.equal(configuration.seekStormCount, 0);
    assert.equal(configuration.failureInjection, 'none');
    assert.throws(
        () => parseSmokeConfiguration([ '--completion-mode', 'natural-end' ], {
            WEBGPU_SMOKE_AUDIO_STREAM_INDEX: '2',
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'ready',
            WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC: 'ac-3',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'raw-planes',
            WEBGPU_SMOKE_ITEM_ID: 'natural-end-item',
            WEBGPU_SMOKE_PASSWORD: 'test-password',
            WEBGPU_SMOKE_USERNAME: 'test-user'
        }),
        /does not support an in-session audio stream change/u
    );
    assert.throws(
        () => parseSmokeConfiguration([
            '--completion-mode', 'natural-end',
            '--seek-storm-count', '1'
        ], {
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'ready',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'raw-planes',
            WEBGPU_SMOKE_ITEM_ID: 'natural-end-item',
            WEBGPU_SMOKE_PASSWORD: 'test-password',
            WEBGPU_SMOKE_USERNAME: 'test-user'
        }),
        /requires --seek-storm-count 0/u
    );
});

test('requires valid independent video and audio expectations', () => {
    const baseEnvironment = {
        WEBGPU_SMOKE_ITEM_ID: 'test-item',
        WEBGPU_SMOKE_PASSWORD: 'test-password',
        WEBGPU_SMOKE_USERNAME: 'test-user'
    };

    assert.throws(
        () => parseSmokeConfiguration([], baseEnvironment),
        /--expected-audio/u
    );
    assert.throws(
        () => parseSmokeConfiguration([], {
            ...baseEnvironment,
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'automatic',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'video-frame'
        }),
        /--expected-audio/u
    );
    assert.throws(
        () => parseSmokeConfiguration([], {
            ...baseEnvironment,
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'disabled',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'external-texture'
        }),
        /--expected-video-output/u
    );
    assert.throws(
        () => parseSmokeConfiguration([ '--expected-play-method', 'direct' ], {
            ...baseEnvironment,
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'disabled',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'video-frame'
        }),
        /--expected-play-method/u
    );
    assert.throws(
        () => parseSmokeConfiguration([ '--repeat-sessions', '0' ], {
            ...baseEnvironment,
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'disabled',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'video-frame'
        }),
        /repeat sessions/u
    );
    assert.throws(
        () => parseSmokeConfiguration([ '--inject-failure', 'adapter-loss' ], {
            ...baseEnvironment,
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'disabled',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'video-frame'
        }),
        /--inject-failure/u
    );
    assert.equal(parseSmokeConfiguration([ '--inject-failure', 'device-loss' ], {
        ...baseEnvironment,
        WEBGPU_SMOKE_EXPECTED_AUDIO: 'disabled',
        WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'video-frame'
    }).failureInjection, 'device-loss');
    assert.equal(parseSmokeConfiguration([ '--inject-failure', 'paused-device-loss' ], {
        WEBGPU_SMOKE_EXPECTED_AUDIO: 'ready',
        WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'raw-planes',
        WEBGPU_SMOKE_ITEM_ID: 'test-item',
        WEBGPU_SMOKE_PASSWORD: 'test-password',
        WEBGPU_SMOKE_USERNAME: 'test-user'
    }).failureInjection, 'paused-device-loss');
    assert.equal(
        parseSmokeConfiguration([ '--inject-failure', 'device-loss' ], {
            ...baseEnvironment,
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'ready',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'raw-planes'
        }).failureInjection,
        'device-loss'
    );
    assert.throws(
        () => parseSmokeConfiguration([ '--seek-storm-count', '6' ], {
            ...baseEnvironment,
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'disabled',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'video-frame'
        }),
        /seek storm count/u
    );
    assert.throws(
        () => parseSmokeConfiguration([ '--audio-stream-index', '3' ], {
            ...baseEnvironment,
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'ready',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'raw-planes'
        }),
        /requires both/u
    );
    assert.throws(
        () => parseSmokeConfiguration([
            '--audio-stream-index', '3',
            '--expected-audio-codec', 'ac-3'
        ], {
            ...baseEnvironment,
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'disabled',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'video-frame'
        }),
        /requires an enabled --expected-audio route/u
    );
    assert.throws(
        () => parseSmokeConfiguration([
            '--audio-stream-index', '-1',
            '--expected-audio-codec', 'ac-3'
        ], {
            ...baseEnvironment,
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'ready',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'raw-planes'
        }),
        /audio stream index/u
    );
    assert.throws(
        () => parseSmokeConfiguration([
            '--audio-stream-index', '3',
            '--expected-audio-codec', 'ac-3',
            '--repeat-sessions', '2'
        ], {
            ...baseEnvironment,
            WEBGPU_SMOKE_EXPECTED_AUDIO: 'ready',
            WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'raw-planes'
        }),
        /requires --repeat-sessions 1/u
    );
});

test('validates an in-session audio decoder generation and codec change', () => {
    const configuration = parseSmokeConfiguration([
        '--audio-stream-index', '3',
        '--expected-audio-codec', 'pcm-s24',
        '--expected-audio-source-channels', '1',
        '--expected-audio-source-rate', '44100',
        '--expected-audio-output-channels', '2',
        '--expected-audio-output-rate', '48000'
    ], {
        WEBGPU_SMOKE_EXPECTED_AUDIO: 'ready',
        WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'raw-planes',
        WEBGPU_SMOKE_ITEM_ID: 'test-item',
        WEBGPU_SMOKE_PASSWORD: 'test-password',
        WEBGPU_SMOKE_USERNAME: 'test-user'
    });
    assert.equal(configuration.audioStreamIndex, 3);
    assert.equal(configuration.expectedAudioCodec, 'pcm-s24');
    assert.deepEqual(configuration.expectedAudioConfiguration, {
        outputChannelCount: 2,
        outputSampleRate: 48_000,
        sourceChannelCount: 1,
        sourceSampleRate: 44_100
    });

    const initialSnapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            activeGeneration: 4,
            audioPath: 'ready'
        }
    });
    const switchedSnapshot = createActiveSnapshot({
        customPlayback: {
            ...initialSnapshot.customPlayback,
            activeGeneration: 5,
            audioPath: 'ready',
            videoDecode: {
                ...initialSnapshot.customPlayback.videoDecode,
                audioChannelCount: 2,
                audioCodec: 'pcm-s24',
                audioSampleRate: 48_000,
                audioSourceChannelCount: 1,
                audioSourceSampleRate: 44_100,
                receivedAudioFrameCount: 8
            }
        },
        customPlaybackEligibility: {
            ...createActiveSnapshot().customPlaybackEligibility,
            audioOutputMode: 'decoded-pcm'
        }
    });

    assert.deepEqual(
        validateAudioStreamSwitchSnapshot(
            initialSnapshot,
            switchedSnapshot,
            'pcm-s24',
            'ready',
            configuration.expectedAudioConfiguration
        ),
        []
    );
    assert.ok(validateAudioStreamSwitchSnapshot(initialSnapshot, {
        ...switchedSnapshot,
        customPlayback: {
            ...switchedSnapshot.customPlayback,
            activeGeneration: 4
        }
    }, 'pcm-s24').includes('audio-generation-not-advanced'));
    assert.ok(validateAudioStreamSwitchSnapshot(initialSnapshot, switchedSnapshot, 'ec-3')
        .includes('unexpected-selected-audio-codec'));
    assert.ok(validateAudioStreamSwitchSnapshot(
        initialSnapshot,
        switchedSnapshot,
        'pcm-s24',
        'ready',
        {
            ...configuration.expectedAudioConfiguration,
            sourceSampleRate: 48_000
        }
    ).includes('unexpected-selected-audio-source-sample-rate'));
});

test('requires a complete decoded audio source and output expectation', () => {
    const environment = {
        WEBGPU_SMOKE_EXPECTED_AUDIO: 'ready',
        WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT: 'raw-planes',
        WEBGPU_SMOKE_ITEM_ID: 'test-item',
        WEBGPU_SMOKE_PASSWORD: 'test-password',
        WEBGPU_SMOKE_USERNAME: 'test-user'
    };
    assert.throws(
        () => parseSmokeConfiguration([
            '--audio-stream-index', '3',
            '--expected-audio-codec', 'pcm-s24',
            '--expected-audio-source-rate', '44100'
        ], environment),
        /requires all four source\/output audio expectations/u
    );
    assert.throws(
        () => parseSmokeConfiguration([
            '--expected-audio-source-channels', '1',
            '--expected-audio-source-rate', '44100',
            '--expected-audio-output-channels', '2',
            '--expected-audio-output-rate', '48000'
        ], environment),
        /requires an audio stream selection/u
    );
    assert.throws(
        () => parseSmokeConfiguration([
            '--audio-stream-index', '3',
            '--expected-audio-codec', 'pcm-s24',
            '--expected-audio-source-channels', '0',
            '--expected-audio-source-rate', '44100',
            '--expected-audio-output-channels', '2',
            '--expected-audio-output-rate', '48000'
        ], environment),
        /source-channels/u
    );
});

test('validates an in-session switch to owned native media audio', () => {
    const initialSnapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            activeGeneration: 4,
            audioPath: 'ready'
        }
    });
    const switchedSnapshot = createActiveSnapshot({
        customPlayback: {
            ...initialSnapshot.customPlayback,
            activeGeneration: 5,
            audioPath: 'ready',
            videoDecode: {
                ...initialSnapshot.customPlayback.videoDecode,
                audioCodec: 'ec-3',
                nativeAudioClockReady: true,
                receivedNativeAudioSegmentCount: 8
            }
        },
        customPlaybackEligibility: {
            ...createActiveSnapshot().customPlaybackEligibility,
            audioOutputMode: 'native-media'
        },
        dom: {
            ...createActiveSnapshot().dom,
            ownedNativeAudioCount: 1,
            ownedNativeAudioPlaying: true,
            ownedNativeAudioSourcedCount: 1
        }
    });

    assert.deepEqual(validateAudioStreamSwitchSnapshot(
        initialSnapshot,
        switchedSnapshot,
        'ec-3',
        'native-media'
    ), []);
    assert.ok(validateAudioStreamSwitchSnapshot(
        initialSnapshot,
        {
            ...switchedSnapshot,
            customPlayback: {
                ...switchedSnapshot.customPlayback,
                videoDecode: {
                    ...switchedSnapshot.customPlayback.videoDecode,
                    receivedNativeAudioSegmentCount: 0
                }
            }
        },
        'ec-3',
        'native-media'
    ).includes('selected-native-audio-segments-missing'));
});

test('builds a hash route on the configured frontend', () => {
    assert.equal(
        createFrontendRouteURL('http://localhost:8080/web/', '/details?id=abc'),
        'http://localhost:8080/web/#/details?id=abc'
    );
});

test('resolves frontend assets with or without a trailing directory separator', () => {
    assert.equal(
        createFrontendAssetURL('http://localhost:8096/web', 'config.json'),
        'http://localhost:8096/web/config.json'
    );
    assert.equal(
        createFrontendAssetURL('http://localhost:8096/web/', 'config.json'),
        'http://localhost:8096/web/config.json'
    );
    assert.equal(
        createFrontendAssetURL('http://localhost:8080', 'config.json'),
        'http://localhost:8080/config.json'
    );
});

test('matches only equivalent configured server URLs and loopback spellings', () => {
    assert.equal(
        areEquivalentServerURLs('http://localhost:8096/', 'http://127.0.0.1:8096'),
        true
    );
    assert.equal(
        areEquivalentServerURLs('https://[::1]:8096/base/', 'https://localhost:8096/base'),
        true
    );
    assert.equal(
        areEquivalentServerURLs('http://localhost:8096', 'http://localhost:9096'),
        false
    );
    assert.equal(
        areEquivalentServerURLs('http://media.example:8096', 'http://127.0.0.1:8096'),
        false
    );
    assert.equal(areEquivalentServerURLs('not-a-url', 'http://localhost:8096'), false);
});

test('derives only exact measured raw HDR authorization routes', () => {
    const baseMetadata = {
        bitDepth: 10,
        matrix: 'bt2020-ncl',
        primaries: 'bt2020',
        range: 'limited'
    };
    assert.equal(
        deriveRawHDRPlaybackRouteKey('I420P10', {
            ...baseMetadata,
            transfer: 'pq'
        }),
        'I420P10:bt2020-ncl:bt2020:limited:pq'
    );
    assert.equal(
        deriveRawHDRPlaybackRouteKey('I420P10', {
            ...baseMetadata,
            transfer: 'hlg'
        }),
        'I420P10:bt2020-ncl:bt2020:limited:hlg'
    );
    assert.equal(deriveRawHDRPlaybackRouteKey('I420P12', {
        ...baseMetadata,
        bitDepth: 12,
        transfer: 'pq'
    }), null);
    assert.equal(deriveRawHDRPlaybackRouteKey('I420P10', {
        ...baseMetadata,
        range: 'full',
        transfer: 'pq'
    }), null);
});

test('requires the route-specific Dolby Vision authorization fixture', () => {
    const profile7Snapshot = {
        dolbyVisionProfile: 7,
        dolbyVisionValidation: {
            fixtureVersion: 3,
            renderSettingsVersion: 1,
            routeKey: 'I420P10:dovi-profile7-base-v1',
            sampleCount: 18,
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        },
        presentationInputMode: 'raw-dolby-vision'
    };
    assert.equal(hasAuthorizedRawHDRPlaybackRoute(profile7Snapshot), true);
    assert.equal(hasAuthorizedRawHDRPlaybackRoute({
        ...profile7Snapshot,
        dolbyVisionValidation: {
            ...profile7Snapshot.dolbyVisionValidation,
            sampleCount: 17
        }
    }), false);
    assert.equal(hasAuthorizedRawHDRPlaybackRoute({
        ...profile7Snapshot,
        dolbyVisionValidation: {
            ...profile7Snapshot.dolbyVisionValidation,
            routeKey: 'I420P10:dovi-rpu-v1'
        }
    }), false);

    assert.equal(hasAuthorizedRawHDRPlaybackRoute({
        ...profile7Snapshot,
        dolbyVisionProfile: 5,
        dolbyVisionValidation: {
            ...profile7Snapshot.dolbyVisionValidation,
            routeKey: 'I420P10:dovi-rpu-v1',
            sampleCount: 9
        }
    }), true);
});

test('requires the exact Profile 7 FEL authorization fixture', () => {
    const snapshot = {
        dolbyVisionProfile: 7,
        profile7FELDolbyVisionValidation: {
            fixtureVersion: 4,
            renderSettingsVersion: 4,
            routeKey: 'I420P10:dovi-profile7-fel-v1',
            sampleCount: 9,
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        }
    };
    assert.equal(hasAuthorizedProfile7FELPlaybackRoute(snapshot), true);
    assert.equal(hasAuthorizedProfile7FELPlaybackRoute({
        ...snapshot,
        profile7FELDolbyVisionValidation: {
            ...snapshot.profile7FELDolbyVisionValidation,
            sampleCount: 8
        }
    }), false);
    assert.equal(hasAuthorizedProfile7FELPlaybackRoute({
        ...snapshot,
        profile7FELDolbyVisionValidation: {
            ...snapshot.profile7FELDolbyVisionValidation,
            routeKey: 'I420P10:dovi-profile7-base-v1'
        }
    }), false);
});

test('requires exact external Profile 5 authorization', () => {
    const snapshot = {
        dolbyVisionProfile: 5,
        externalDolbyVisionValidation: {
            fixtureVersion: 2,
            maximumChannelError: 0.0027,
            maximumInputChannelError: 0.005,
            renderSettingsVersion: 5,
            routeKey: 'external-I420P10-bt709-limited:dovi-p5-rpu-v1',
            sampleCount: 9,
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        },
        presentationInputMode: 'external-dolby-vision'
    };
    assert.equal(hasAuthorizedHDRPlaybackRoute(snapshot), true);
    assert.equal(hasAuthorizedHDRPlaybackRoute({
        ...snapshot,
        dolbyVisionProfile: 7
    }), false);
    assert.equal(hasAuthorizedHDRPlaybackRoute({
        ...snapshot,
        externalDolbyVisionValidation: {
            ...snapshot.externalDolbyVisionValidation,
            sampleCount: 0
        }
    }), false);
    assert.equal(hasAuthorizedHDRPlaybackRoute({
        ...snapshot,
        externalDolbyVisionValidation: {
            ...snapshot.externalDolbyVisionValidation,
            maximumInputChannelError: null
        }
    }), false);
});

test('requires the exact native Main10 external HDR route authorization', () => {
    const snapshot = {
        customPlaybackEligibility: {
            eligible: true,
            hdr: true,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        },
        externalHDRValidation: {
            authorizedRouteKeys: [
                'external-hevc-main10-bt709-limited:pq-v1'
            ],
            fixtureVersion: 1,
            renderSettingsVersion: 4,
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        },
        presentationInputMode: 'external-hdr'
    };
    assert.equal(hasAuthorizedHDRPlaybackRoute(snapshot), true);
    assert.equal(hasAuthorizedHDRPlaybackRoute({
        ...snapshot,
        customPlaybackEligibility: {
            ...snapshot.customPlaybackEligibility,
            nativeHDRTransfer: 'hlg'
        }
    }), false);
    assert.equal(hasAuthorizedHDRPlaybackRoute({
        ...snapshot,
        customPlaybackEligibility: {
            ...snapshot.customPlaybackEligibility,
            neutralizeHDRColorMetadata: false
        }
    }), false);
});

test('matches exact SDR, HDR, and Dolby Vision presentation routes', () => {
    const SDRSnapshot = createActiveSnapshot({
        presentationInputMode: 'external-texture'
    });
    assert.equal(hasExpectedPresentationRoute(SDRSnapshot, 'identity-sdr'), true);
    assert.equal(hasExpectedPresentationRoute(SDRSnapshot, 'external-hdr-pq'), false);

    const externalPQSnapshot = {
        customPlaybackEligibility: {
            eligible: true,
            hdr: true,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        },
        externalHDRValidation: {
            authorizedRouteKeys: [ 'external-hevc-main10-bt709-limited:pq-v1' ],
            fixtureVersion: 2,
            renderSettingsVersion: 5,
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        },
        presentationInputMode: 'external-hdr'
    };
    assert.equal(hasExpectedPresentationRoute(externalPQSnapshot, 'external-hdr-pq'), true);
    assert.equal(hasExpectedPresentationRoute(externalPQSnapshot, 'external-hdr-hlg'), false);

    const rawProfile7Snapshot = {
        dolbyVisionProfile: 7,
        dolbyVisionValidation: {
            fixtureVersion: 3,
            renderSettingsVersion: 5,
            routeKey: 'I420P10:dovi-profile7-base-v1',
            sampleCount: 18,
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        },
        presentation: {
            dolbyVisionProfile7FELBaseFallbackPresentedFrameCount: 0,
            dolbyVisionProfile7FELPresentedFrameCount: 0,
            dolbyVisionProfile7MELPresentedFrameCount: 4
        },
        presentationInputMode: 'raw-dolby-vision'
    };
    assert.equal(
        hasExpectedPresentationRoute(
            rawProfile7Snapshot,
            'raw-dolby-vision-profile7-mel'
        ),
        true
    );
    assert.equal(
        hasExpectedPresentationRoute(
            rawProfile7Snapshot,
            'raw-dolby-vision-profile7-fel'
        ),
        false
    );
});

function createPresentedFrameEvidence(hash, overrides = {}) {
    return {
        channelMaximums: [ 245, 238, 250 ],
        channelMinimums: [ 3, 5, 2 ],
        chromaticPixelCount: 1_800,
        hash,
        horizontalSamples: [
            [ 220, 40, 30 ],
            [ 230, 90, 70 ],
            [ 190, 170, 20 ],
            [ 230, 220, 20 ],
            [ 15, 30, 230 ],
            [ 60, 80, 235 ],
            [ 10, 180, 200 ],
            [ 5, 220, 235 ]
        ],
        nonBlackPixelCount: 2_200,
        opaquePixelCount: 2_304,
        pixelCount: 2_304,
        sampleHeight: 36,
        sampleWidth: 64,
        status: 'captured',
        ...overrides
    };
}

test('validates actual generated-media canvas pixels and motion', () => {
    const initialEvidence = createPresentedFrameEvidence(123);
    const laterEvidence = createPresentedFrameEvidence(456);

    assert.deepEqual(
        validatePresentedFrameEvidence(
            initialEvidence,
            laterEvidence,
            'testsrc2-motion'
        ),
        []
    );
    assert.deepEqual(validatePresentedFrameEvidence(
        createPresentedFrameEvidence(123, {
            horizontalSamples: [
                [ 220, 40, 30 ],
                [ 230, 90, 70 ],
                [ 190, 170, 20 ],
                [ 230, 220, 20 ],
                [ 15, 30, 230 ],
                [ 60, 80, 235 ],
                [ 10, 180, 200 ],
                [ 220, 40, 30 ]
            ]
        }),
        laterEvidence,
        'testsrc2-motion'
    ), []);
    assert.deepEqual(validatePresentedFrameEvidence(null, null, 'none'), []);
    assert.ok(validatePresentedFrameEvidence(
        initialEvidence,
        createPresentedFrameEvidence(123),
        'testsrc2-motion'
    ).includes('presented-frame-motion-missing'));
    assert.ok(validatePresentedFrameEvidence(
        initialEvidence,
        createPresentedFrameEvidence(456, {
            horizontalSamples: Array.from({ length: 8 }, () => [ 20, 20, 20 ])
        }),
        'testsrc2-motion'
    ).includes('later-frame-testsrc2-signature-mismatch'));
    assert.ok(validatePresentedFrameEvidence(
        initialEvidence,
        createPresentedFrameEvidence(456, { nonBlackPixelCount: 0 }),
        'testsrc2-motion'
    ).includes('later-frame-mostly-black'));
    assert.throws(
        () => validatePresentedFrameEvidence(initialEvidence, laterEvidence, 'unknown'),
        /expectation is invalid/u
    );
});

test('creates bounded deterministic non-monotonic seek storm targets', () => {
    assert.deepEqual(
        createSeekStormTargetsMicroseconds(100_000_000, 5),
        [ 20_400_000, 68_900_000, 34_950_000, 78_600_000, 49_500_000 ]
    );
    assert.deepEqual(createSeekStormTargetsMicroseconds(100_000_000, 0), []);
    assert.deepEqual(createSeekStormTargetsMicroseconds(7_999_999, 3), []);
    assert.throws(
        () => createSeekStormTargetsMicroseconds(100_000_000, 6),
        /Seek storm count/u
    );
});

test('bounds the primary seek inside short and long media', () => {
    assert.equal(
        createPrimarySeekTargetMicroseconds(3_000_000, 6_000_000),
        2_100_000
    );
    assert.equal(
        createPrimarySeekTargetMicroseconds(2_000_000, 50_000_000),
        7_000_000
    );
    assert.equal(
        createPrimarySeekTargetMicroseconds(3_000_000, null),
        8_000_000
    );
});

test('validates rapid seeks against decoder and backend generations', () => {
    const initialSnapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            activeGeneration: 4,
            currentTimeMicroseconds: 10_000_000,
            staleEventCount: 2,
            videoDecode: {
                ...createActiveSnapshot().customPlayback.videoDecode,
                activeGeneration: 4
            }
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            presentedFrameCount: 20
        },
        sessionGeneration: 9
    });
    const targetMicrosecondsList = [ 20_000_000, 60_000_000, 35_000_000 ];
    const laterSnapshot = createActiveSnapshot({
        customPlayback: {
            ...initialSnapshot.customPlayback,
            activeGeneration: 7,
            currentTimeMicroseconds: 35_500_000,
            staleEventCount: 5,
            videoDecode: {
                ...initialSnapshot.customPlayback.videoDecode,
                activeGeneration: 7,
                receivedFrameCount: 4,
                staleAudioSampleCount: 1,
                staleFrameCount: 2
            }
        },
        presentation: {
            ...initialSnapshot.presentation,
            presentedFrameCount: 25
        },
        sessionGeneration: 9
    });

    assert.deepEqual(
        validateSeekStormSnapshot(
            initialSnapshot,
            laterSnapshot,
            targetMicrosecondsList
        ),
        []
    );
    assert.ok(validateSeekStormSnapshot(initialSnapshot, {
        ...laterSnapshot,
        sessionGeneration: 10
    }, targetMicrosecondsList).includes('seek-storm-backend-session-restarted'));
    assert.ok(validateSeekStormSnapshot(initialSnapshot, {
        ...laterSnapshot,
        customPlayback: {
            ...laterSnapshot.customPlayback,
            activeGeneration: 6
        }
    }, targetMicrosecondsList).includes('seek-storm-generation-mismatch'));
});

test('validates control event cardinality and resume ordering', () => {
    const beforePause = createActiveSnapshot();
    const paused = createActiveSnapshot({
        eventCounts: {
            ...beforePause.eventCounts,
            pause: 1
        },
        eventSequence: [ ...beforePause.eventSequence, 'pause' ]
    });
    const resumed = createActiveSnapshot({
        eventCounts: {
            ...paused.eventCounts,
            playing: paused.eventCounts.playing + 1,
            unpause: 1
        },
        eventSequence: [ ...paused.eventSequence, 'unpause', 'playing' ]
    });
    const beforeStop = createActiveSnapshot({
        eventCounts: { ...resumed.eventCounts },
        eventSequence: [ ...resumed.eventSequence, 'waiting' ]
    });
    const stopped = createActiveSnapshot({
        eventCounts: {
            ...beforeStop.eventCounts,
            stopped: 1
        },
        eventSequence: [ ...beforeStop.eventSequence, 'stopped' ]
    });

    assert.deepEqual(
        validateControlEventTransitions(
            beforePause,
            paused,
            resumed,
            beforeStop,
            stopped
        ),
        []
    );
    assert.ok(validateControlEventTransitions(
        beforePause,
        paused,
        {
            ...resumed,
            eventSequence: [ ...paused.eventSequence, 'playing', 'unpause' ]
        },
        beforeStop,
        stopped
    ).includes('resume-event-order'));
});

test('validates fullscreen and device-pixel-ratio presentation changes', () => {
    const initialSnapshot = createActiveSnapshot();
    const fullscreenSnapshot = createActiveSnapshot({
        dom: {
            ...initialSnapshot.dom,
            fullscreenActive: true,
            fullscreenContainsCanvas: true
        },
        eventCounts: {
            ...initialSnapshot.eventCounts,
            fullscreenchange: 1
        },
        presentation: {
            ...initialSnapshot.presentation,
            presentedFrameCount: 12
        }
    });
    const exitedSnapshot = createActiveSnapshot({
        eventCounts: {
            ...fullscreenSnapshot.eventCounts,
            fullscreenchange: 2
        },
        presentation: {
            ...fullscreenSnapshot.presentation,
            presentedFrameCount: 14
        }
    });
    assert.deepEqual(
        validateFullscreenTransitionSnapshots(
            initialSnapshot,
            fullscreenSnapshot,
            exitedSnapshot
        ),
        []
    );

    const resizedSnapshot = createActiveSnapshot({
        dom: {
            ...initialSnapshot.dom,
            canvasBackingHeight: 1050,
            canvasBackingWidth: 1500,
            canvasCSSHeight: 700,
            canvasCSSWidth: 1000,
            devicePixelRatio: 1.5,
            viewportHeight: 700,
            viewportWidth: 1000
        },
        presentation: {
            ...initialSnapshot.presentation,
            presentedFrameCount: 12
        }
    });
    const expectedViewport = {
        devicePixelRatio: 1.5,
        height: 700,
        width: 1000
    };
    assert.deepEqual(
        validateResizedPresentationSnapshot(
            initialSnapshot,
            resizedSnapshot,
            expectedViewport
        ),
        []
    );
    assert.ok(validateResizedPresentationSnapshot(initialSnapshot, {
        ...resizedSnapshot,
        dom: {
            ...resizedSnapshot.dom,
            canvasBackingWidth: 1400
        }
    }, expectedViewport).includes('canvas-backing-geometry-mismatch'));
});

test('validates one replacement device without restarting custom decode', () => {
    const initialSnapshot = createActiveSnapshot();
    const recoveredSnapshot = createActiveSnapshot({
        customPlayback: {
            ...initialSnapshot.customPlayback,
            currentTimeMicroseconds: 2_500_000
        },
        presentation: {
            ...initialSnapshot.presentation,
            deviceRecoveryCount: 1,
            presentedFrameCount: 15
        }
    });
    const injectionObservation = {
        available: true,
        destroyInvoked: true,
        recoveryCountAfter: 1,
        replacementDevice: true
    };
    assert.deepEqual(
        validateInjectedDeviceRecoverySnapshot(
            initialSnapshot,
            recoveredSnapshot,
            injectionObservation
        ),
        []
    );
    assert.ok(validateInjectedDeviceRecoverySnapshot(
        initialSnapshot,
        {
            ...recoveredSnapshot,
            sessionGeneration: 2
        },
        injectionObservation
    ).includes('device-recovery-session-restarted'));
});

test('validates one paused repaint generation after device recovery', () => {
    const activeSnapshot = createActiveSnapshot();
    const pausedSnapshot = createActiveSnapshot({
        customPlayback: {
            ...activeSnapshot.customPlayback,
            state: 'paused'
        },
        eventCounts: {
            ...activeSnapshot.eventCounts,
            pause: 1
        },
        eventSequence: [ ...activeSnapshot.eventSequence, 'pause' ]
    });
    const recoveredSnapshot = createActiveSnapshot({
        customPlayback: {
            ...pausedSnapshot.customPlayback,
            activeGeneration: 2,
            currentTimeMicroseconds: 2_005_000,
            videoDecode: {
                ...pausedSnapshot.customPlayback.videoDecode,
                activeGeneration: 2
            }
        },
        eventCounts: { ...pausedSnapshot.eventCounts },
        eventSequence: [ ...pausedSnapshot.eventSequence ],
        presentation: {
            ...pausedSnapshot.presentation,
            deviceRecoveryCount: 1,
            presentedFrameCount: 11
        }
    });
    const resumedSnapshot = createActiveSnapshot({
        customPlayback: {
            ...recoveredSnapshot.customPlayback,
            currentTimeMicroseconds: 2_505_000,
            state: 'playing'
        },
        eventCounts: {
            ...recoveredSnapshot.eventCounts,
            playing: recoveredSnapshot.eventCounts.playing + 1,
            unpause: 1
        },
        eventSequence: [ ...recoveredSnapshot.eventSequence, 'unpause', 'playing' ],
        presentation: {
            ...recoveredSnapshot.presentation,
            presentedFrameCount: 15
        }
    });
    const injectionObservation = {
        available: true,
        destroyInvoked: true,
        recoveryCountAfter: 1,
        replacementDevice: true
    };

    assert.deepEqual(validatePausedDeviceRecoverySnapshots(
        activeSnapshot,
        pausedSnapshot,
        recoveredSnapshot,
        resumedSnapshot,
        injectionObservation
    ), []);
    assert.ok(validatePausedDeviceRecoverySnapshots(
        activeSnapshot,
        pausedSnapshot,
        {
            ...recoveredSnapshot,
            eventCounts: {
                ...recoveredSnapshot.eventCounts,
                pause: recoveredSnapshot.eventCounts.pause + 1
            }
        },
        resumedSnapshot,
        injectionObservation
    ).includes('paused-recovery-pause-event'));
    assert.ok(validatePausedDeviceRecoverySnapshots(
        activeSnapshot,
        pausedSnapshot,
        {
            ...recoveredSnapshot,
            eventCounts: {
                ...recoveredSnapshot.eventCounts,
                waiting: recoveredSnapshot.eventCounts.waiting + 1
            }
        },
        resumedSnapshot,
        injectionObservation
    ).includes('paused-recovery-waiting-event'));
});

test('accepts matching bounded client and server DirectPlay evidence', () => {
    const evidence = {
        client: {
            hasMediaSourceIdentifier: true,
            hasTranscodingURL: true,
            itemMatched: true,
            playMethod: 'DirectPlay',
            supportsDirectPlay: true,
            supportsDirectStream: true,
            supportsTranscoding: true
        },
        server: {
            isAudioDirect: null,
            isVideoDirect: null,
            itemMatched: true,
            mediaSourceMatched: true,
            playMethod: 'DirectPlay',
            requestSucceeded: true,
            sessionMatched: true,
            transcodeReasons: [],
            transcodingActive: false
        }
    };

    assert.deepEqual(validatePlaybackDecisionEvidence(evidence, 'DirectPlay'), []);
    assert.deepEqual(validatePlaybackDecisionEvidence(null, null), []);
});

test('rejects playback method disagreement and DirectPlay transcoding state', () => {
    const failures = validatePlaybackDecisionEvidence({
        client: {
            itemMatched: true,
            playMethod: 'DirectPlay',
            supportsDirectPlay: true
        },
        server: {
            itemMatched: true,
            mediaSourceMatched: false,
            playMethod: 'Transcode',
            sessionMatched: true,
            transcodeReasons: [ 'VideoCodecNotSupported' ],
            transcodingActive: true
        }
    }, 'DirectPlay');

    assert.ok(failures.includes('playback-decision-server-media-source-mismatch'));
    assert.ok(failures.includes('playback-decision-server-method-mismatch'));
    assert.ok(failures.includes('playback-decision-method-disagreement'));
    assert.ok(failures.includes('playback-decision-direct-play-transcoding-active'));
    assert.ok(failures.includes('playback-decision-direct-play-transcode-reasons-present'));
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
        validateActivePlaybackSnapshot(initialSnapshot, laterSnapshot, SDR_EXPECTATIONS),
        []
    );
    assert.ok(validateActivePlaybackSnapshot(initialSnapshot, {
        ...laterSnapshot,
        dom: {
            ...laterSnapshot.dom,
            sourcedVideoCount: 1
        }
    }, SDR_EXPECTATIONS).includes('native-video-source-active'));
    assert.ok(validateActivePlaybackSnapshot(initialSnapshot, {
        ...laterSnapshot,
        playbackDecision: {
            ...laterSnapshot.playbackDecision,
            playMethod: 'Transcode'
        }
    }, SDR_EXPECTATIONS).includes('unexpected-play-method'));
    const expectationFailures = validateActivePlaybackSnapshot(
        initialSnapshot,
        laterSnapshot,
        HDR_AUDIO_EXPECTATIONS
    );
    assert.ok(expectationFailures.includes('unexpected-video-output-mode'));
    assert.ok(expectationFailures.includes('unexpected-audio-path'));
});

test('accepts advancing custom playback with owned native media audio', () => {
    const nativeExpectations = {
        expectedAudioPath: 'native-media',
        expectedVideoDecoderBackend: 'native',
        expectedVideoOutputMode: 'video-frame'
    };
    const initialSnapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            audioPath: 'ready',
            currentTimeMicroseconds: 1_000_000
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            presentedFrameCount: 5
        }
    });
    const laterSnapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            audioPath: 'ready',
            videoDecode: {
                ...createActiveSnapshot().customPlayback.videoDecode,
                audioCodec: 'ec-3',
                nativeAudioClockReady: true,
                receivedNativeAudioSegmentCount: 8
            }
        },
        customPlaybackEligibility: {
            ...createActiveSnapshot().customPlaybackEligibility,
            audioOutputMode: 'native-media'
        },
        dom: {
            ...createActiveSnapshot().dom,
            ownedNativeAudioCount: 1,
            ownedNativeAudioPlaying: true,
            ownedNativeAudioSourcedCount: 1,
            ownedNativeAudioTimeMicroseconds: 2_000_000
        }
    });

    assert.deepEqual(
        validateActivePlaybackSnapshot(initialSnapshot, laterSnapshot, nativeExpectations),
        []
    );
    assert.ok(validateActivePlaybackSnapshot(initialSnapshot, {
        ...laterSnapshot,
        customPlayback: {
            ...laterSnapshot.customPlayback,
            videoDecode: {
                ...laterSnapshot.customPlayback.videoDecode,
                nativeAudioClockReady: false
            }
        }
    }, nativeExpectations).includes('native-audio-clock-not-ready'));
});

test('rejects repeated waiting and playing churn during steady playback', () => {
    const initialSnapshot = createActiveSnapshot();
    const laterSnapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            currentTimeMicroseconds: 6_000_000
        },
        eventCounts: { playing: 8, waiting: 7 },
        presentation: {
            ...createActiveSnapshot().presentation,
            presentedFrameCount: 12
        }
    });
    initialSnapshot.eventCounts = { playing: 1, waiting: 1 };

    const failures = validateActivePlaybackSnapshot(initialSnapshot, laterSnapshot, {
        expectedAudioPath: 'disabled',
        expectedVideoOutputMode: 'video-frame'
    });

    assert.ok(failures.includes('waiting-event-churn'));
    assert.ok(failures.includes('playing-event-churn'));
});

test('accepts bounded raw HDR playback with healthy custom audio', () => {
    const initialSnapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            currentTimeMicroseconds: 1_000_000
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            mode: 'hdr-to-sdr',
            presentedFrameCount: 5
        }
    });
    const laterSnapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            audioBridge: {
                failed: false,
                pendingFrameCount: 8,
                pendingSampleCount: 1
            },
            audioOutput: {
                consumedFrames: 48_000,
                droppedFrames: 0,
                overflowEvents: 0,
                outputFrames: 48_000,
                playing: true,
                staleChunks: 0,
                underflowFrames: 100
            },
            audioPath: 'ready',
            videoDecode: {
                ...createActiveSnapshot().customPlayback.videoDecode,
                pendingFrameCount: 1,
                queuedFrameCount: 1
            }
        },
        customPlaybackEligibility: {
            audioOutputMode: 'decoded-pcm',
            eligible: true,
            hdr: true,
            reason: null,
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes'
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            mode: 'hdr-to-sdr'
        },
        rawHDRValidation: {
            authorizedRouteKeys: [ 'I420P10:bt2020-ncl:bt2020:limited:pq' ],
            failureReasons: {},
            fixtureVersion: 1,
            pendingRouteKeys: [],
            rejectedRouteKeys: [],
            renderSettingsVersion: 1,
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        },
        rawHDRPlaybackRouteKey: 'I420P10:bt2020-ncl:bt2020:limited:pq'
    });

    assert.deepEqual(
        validateActivePlaybackSnapshot(
            initialSnapshot,
            laterSnapshot,
            HDR_AUDIO_EXPECTATIONS
        ),
        []
    );
    assert.ok(validateActivePlaybackSnapshot(initialSnapshot, {
        ...laterSnapshot,
        customPlayback: {
            ...laterSnapshot.customPlayback,
            audioOutput: {
                ...laterSnapshot.customPlayback.audioOutput,
                overflowEvents: 1
            }
        }
    }, HDR_AUDIO_EXPECTATIONS).includes('audio-overflow'));
    assert.ok(validateActivePlaybackSnapshot(initialSnapshot, {
        ...laterSnapshot,
        customPlayback: {
            ...laterSnapshot.customPlayback,
            videoDecode: {
                ...laterSnapshot.customPlayback.videoDecode,
                pendingFrameCount: 1,
                queuedFrameCount: 2
            }
        }
    }, HDR_AUDIO_EXPECTATIONS).includes('raw-frame-credit-window-exceeded'));
    assert.ok(validateActivePlaybackSnapshot(initialSnapshot, {
        ...laterSnapshot,
        rawHDRValidation: {
            ...laterSnapshot.rawHDRValidation,
            authorizedRouteKeys: [ 'I420P10:bt2020-ncl:bt2020:limited:hlg' ]
        }
    }, HDR_AUDIO_EXPECTATIONS).includes('raw-hdr-playback-route-unauthorized'));
    assert.ok(validateActivePlaybackSnapshot(initialSnapshot, {
        ...laterSnapshot,
        rawHDRValidation: {
            ...laterSnapshot.rawHDRValidation,
            status: 'pending'
        }
    }, HDR_AUDIO_EXPECTATIONS).includes('raw-hdr-authorization-not-authorized'));

    for (const [ pendingFrameCount, queuedFrameCount ] of [ [ 0, 2 ], [ 1, 1 ], [ 2, 0 ] ]) {
        const failures = validateActivePlaybackSnapshot(initialSnapshot, {
            ...laterSnapshot,
            customPlayback: {
                ...laterSnapshot.customPlayback,
                videoDecode: {
                    ...laterSnapshot.customPlayback.videoDecode,
                    pendingFrameCount,
                    queuedFrameCount
                }
            }
        }, HDR_AUDIO_EXPECTATIONS);
        assert.ok(!failures.includes('raw-frame-credit-window-exceeded'));
        assert.ok(!failures.includes('pending-frame-bound-exceeded'));
    }
});

test('validates the active Profile 7 authorization independently', () => {
    const rawDolbyVisionExpectations = {
        expectedAudioPath: 'disabled',
        expectedVideoDecoderBackend: 'bundled-hevc',
        expectedVideoOutputMode: 'raw-planes'
    };
    const initialSnapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            currentTimeMicroseconds: 1_000_000
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            mode: 'hdr-to-sdr',
            presentedFrameCount: 5
        }
    });
    const laterSnapshot = createActiveSnapshot({
        customPlaybackEligibility: {
            audioOutputMode: null,
            eligible: true,
            hdr: true,
            reason: null,
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes'
        },
        dolbyVisionProfile: 7,
        dolbyVisionValidation: {
            failureReason: null,
            fixtureVersion: 3,
            maximumChannelError: 0,
            renderSettingsVersion: 1,
            routeKey: 'I420P10:dovi-profile7-base-v1',
            sampleCount: 18,
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            dolbyVisionProfile7FELBaseFallbackPresentedFrameCount: 4,
            dolbyVisionProfile7FELPresentedFrameCount: 0,
            dolbyVisionProfile7MELPresentedFrameCount: 6,
            mode: 'hdr-to-sdr'
        },
        presentationInputMode: 'raw-dolby-vision'
    });

    assert.deepEqual(validateActivePlaybackSnapshot(
        initialSnapshot,
        laterSnapshot,
        rawDolbyVisionExpectations
    ), []);
    assert.ok(validateActivePlaybackSnapshot(initialSnapshot, {
        ...laterSnapshot,
        dolbyVisionValidation: {
            ...laterSnapshot.dolbyVisionValidation,
            routeKey: 'I420P10:dovi-rpu-v1'
        }
    }, rawDolbyVisionExpectations).includes(
        'dolby-vision-playback-route-unauthorized'
    ));

    const fullFELSnapshot = {
        ...laterSnapshot,
        presentation: {
            ...laterSnapshot.presentation,
            dolbyVisionProfile7FELBaseFallbackPresentedFrameCount: 0,
            dolbyVisionProfile7FELPresentedFrameCount: 4
        },
        profile7FELDolbyVisionValidation: {
            failureReason: null,
            fixtureVersion: 4,
            maximumChannelError: 0,
            renderSettingsVersion: 4,
            routeKey: 'I420P10:dovi-profile7-fel-v1',
            sampleCount: 9,
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        }
    };
    assert.deepEqual(validateActivePlaybackSnapshot(
        initialSnapshot,
        fullFELSnapshot,
        rawDolbyVisionExpectations
    ), []);
    assert.ok(validateActivePlaybackSnapshot(initialSnapshot, {
        ...fullFELSnapshot,
        profile7FELDolbyVisionValidation: {
            ...fullFELSnapshot.profile7FELDolbyVisionValidation,
            status: 'rejected'
        }
    }, rawDolbyVisionExpectations).includes(
        'dolby-vision-profile7-fel-route-unauthorized'
    ));
});

test('accepts authorized external Profile 5 HDR presentation', () => {
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
    const laterSnapshot = createActiveSnapshot({
        customPlaybackEligibility: {
            audioOutputMode: null,
            eligible: true,
            hdr: true,
            reason: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        },
        dolbyVisionProfile: 5,
        externalDolbyVisionValidation: {
            failureReason: null,
            fixtureVersion: 2,
            maximumChannelError: 0.02,
            maximumInputChannelError: 0.005,
            renderSettingsVersion: 5,
            routeKey: 'external-I420P10-bt709-limited:dovi-p5-rpu-v1',
            sampleCount: 9,
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            mode: 'hdr-to-sdr'
        },
        presentationInputMode: 'external-dolby-vision'
    });

    assert.deepEqual(validateActivePlaybackSnapshot(
        initialSnapshot,
        laterSnapshot,
        SDR_EXPECTATIONS
    ), []);
    assert.ok(validateActivePlaybackSnapshot(initialSnapshot, {
        ...laterSnapshot,
        externalDolbyVisionValidation: {
            ...laterSnapshot.externalDolbyVisionValidation,
            status: 'rejected'
        }
    }, SDR_EXPECTATIONS).includes(
        'external-dolby-vision-playback-route-unauthorized'
    ));
});

test('accepts authorized native Main10 external HDR presentation', () => {
    const initialSnapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            currentTimeMicroseconds: 1_000_000
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            mode: 'hdr-to-sdr',
            presentedFrameCount: 5
        }
    });
    const laterSnapshot = createActiveSnapshot({
        customPlaybackEligibility: {
            audioOutputMode: null,
            eligible: true,
            hdr: true,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            reason: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        },
        externalHDRValidation: {
            authorizedRouteKeys: [
                'external-hevc-main10-bt709-limited:pq-v1',
                'external-hevc-main10-bt709-limited:hlg-v1'
            ],
            fixtureVersion: 2,
            renderSettingsVersion: 4,
            status: 'authorized',
            targetFormat: 'bgra8unorm'
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            mode: 'hdr-to-sdr'
        },
        presentationInputMode: 'external-hdr'
    });

    assert.deepEqual(validateActivePlaybackSnapshot(
        initialSnapshot,
        laterSnapshot,
        SDR_EXPECTATIONS
    ), []);
    assert.ok(validateActivePlaybackSnapshot(initialSnapshot, {
        ...laterSnapshot,
        externalHDRValidation: {
            ...laterSnapshot.externalHDRValidation,
            authorizedRouteKeys: [
                'external-hevc-main10-bt709-limited:hlg-v1'
            ]
        }
    }, SDR_EXPECTATIONS).includes(
        'external-hdr-playback-route-unauthorized'
    ));
});

test('rejects sustained audio underflow while ignoring a short observation window', () => {
    const initialSnapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            audioBridge: { failed: false },
            audioOutput: {
                consumedFrames: 48_000,
                droppedFrames: 0,
                outputFrames: 48_000,
                overflowEvents: 0,
                playing: true,
                staleChunks: 0,
                underflowFrames: 1_000
            },
            audioPath: 'ready'
        },
        customPlaybackEligibility: {
            eligible: true,
            hdr: true,
            reason: null,
            videoOutputMode: 'raw-planes'
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            mode: 'hdr-to-sdr',
            presentedFrameCount: 5
        }
    });
    const laterSnapshot = createActiveSnapshot({
        customPlayback: {
            ...initialSnapshot.customPlayback,
            currentTimeMicroseconds: 3_000_000,
            audioOutput: {
                ...initialSnapshot.customPlayback.audioOutput,
                consumedFrames: 96_000,
                outputFrames: 96_000,
                underflowFrames: 3_000
            },
            videoDecode: {
                ...initialSnapshot.customPlayback.videoDecode,
                pendingFrameCount: 1,
                queuedFrameCount: 1
            }
        },
        customPlaybackEligibility: initialSnapshot.customPlaybackEligibility,
        presentation: {
            ...initialSnapshot.presentation,
            presentedFrameCount: 10
        }
    });

    const failures = validateActivePlaybackSnapshot(
        initialSnapshot,
        laterSnapshot,
        HDR_AUDIO_EXPECTATIONS
    );
    assert.ok(failures.includes('audio-underflow-ratio-exceeded'));

    const shortWindowSnapshot = {
        ...laterSnapshot,
        customPlayback: {
            ...laterSnapshot.customPlayback,
            audioOutput: {
                ...laterSnapshot.customPlayback.audioOutput,
                outputFrames: 52_000,
                underflowFrames: 1_500
            }
        }
    };
    assert.ok(!validateActivePlaybackSnapshot(
        initialSnapshot,
        shortWindowSnapshot,
        HDR_AUDIO_EXPECTATIONS
    ).includes('audio-underflow-ratio-exceeded'));
});

test('validates repeated stop counts and injected native fallback progress', () => {
    const fallbackInitial = createActiveSnapshot({
        dom: {
            ...createActiveSnapshot().dom,
            canvasCount: 0,
            nativeVideoPlaying: true,
            nativeVideoTimeMicroseconds: 2_000_000,
            sourcedVideoCount: 1,
            visibleCanvasCount: 0
        },
        hasCurrentSource: true,
        presentation: {
            ...createActiveSnapshot().presentation,
            fallbackReason: 'frame-render-failed',
            state: 'idle'
        }
    });
    const fallbackLater = {
        ...fallbackInitial,
        dom: {
            ...fallbackInitial.dom,
            nativeVideoTimeMicroseconds: 2_500_000
        }
    };
    const repeatedStop = createActiveSnapshot({
        dom: {
            ...createActiveSnapshot().dom,
            canvasCount: 0,
            visibleCanvasCount: 0
        },
        presentation: {
            ...createActiveSnapshot().presentation,
            state: 'idle'
        },
        stoppedEventCount: 2
    });

    assert.deepEqual(
        validateInjectedPresentationFallbackSnapshot(fallbackInitial, fallbackLater),
        []
    );
    assert.deepEqual(validateStopSnapshot(repeatedStop, 2), []);
    assert.ok(validateStopSnapshot(repeatedStop).includes('stopped-event-count'));
});

test('validates natural EOF only after the submitted physical audio tail', () => {
    const activeSnapshot = createActiveSnapshot({
        customPlayback: {
            ...createActiveSnapshot().customPlayback,
            audioBridge: {
                pendingFrameCount: 2,
                pendingSampleCount: 1_024,
                submittedEndMediaTimeMicroseconds: 6_000_000
            },
            audioOutput: {
                playing: true,
                queuedFrames: 1_024
            },
            audioPath: 'ready',
            currentTimeMicroseconds: 5_000_000,
            durationMicroseconds: 6_000_000
        }
    });
    const endedSnapshot = createActiveSnapshot({
        customPlayback: {
            ...activeSnapshot.customPlayback,
            audioBridge: {
                pendingFrameCount: 0,
                pendingSampleCount: 0,
                submittedEndMediaTimeMicroseconds: 6_000_000
            },
            audioOutput: {
                playing: false,
                queuedFrames: 0
            },
            currentTimeMicroseconds: 6_000_000,
            state: 'ended',
            videoDecode: {
                ...activeSnapshot.customPlayback.videoDecode,
                pendingFrameCount: 0,
                queuedFrameCount: 0
            }
        },
        eventCounts: {
            ...activeSnapshot.eventCounts,
            stopped: 1,
            timeupdate: 18
        },
        eventSequence: [ ...activeSnapshot.eventSequence, 'stopped' ]
    });
    const stableEndedSnapshot = createActiveSnapshot({
        ...endedSnapshot,
        customPlayback: {
            ...endedSnapshot.customPlayback,
            currentTimeMicroseconds: 6_005_000
        }
    });

    assert.deepEqual(validateNaturalEndSnapshots(
        activeSnapshot,
        endedSnapshot,
        stableEndedSnapshot,
        'ready'
    ), []);

    const prematureSnapshot = createActiveSnapshot({
        ...endedSnapshot,
        customPlayback: {
            ...endedSnapshot.customPlayback,
            audioOutput: {
                playing: true,
                queuedFrames: 128
            },
            currentTimeMicroseconds: 5_950_000
        },
        eventCounts: {
            ...endedSnapshot.eventCounts,
            waiting: activeSnapshot.eventCounts.waiting + 1
        }
    });
    const prematureFailures = validateNaturalEndSnapshots(
        activeSnapshot,
        prematureSnapshot,
        prematureSnapshot,
        'ready'
    );
    assert.ok(prematureFailures.includes('terminal-waiting-event'));
    assert.ok(prematureFailures.includes('audio-output-not-drained'));
    assert.ok(prematureFailures.includes('audio-physical-tail-not-reached'));
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
        browserMessages: [
            '{"Authorization":"Bearer quoted-json-token","status":401}',
            'Authorization: Bearer unquoted-header-token',
            'X-Emby-Authorization: MediaBrowser Client=Jellyfin Web, Token=emby-prefixed-secret',
            'X-MediaBrowser-Authorization: MediaBrowser Client=Jellyfin, Token=mediabrowser-prefixed-secret',
            'X-Emby-Token: emby-token-header-secret',
            'Token=bare-token-secret',
            'cookie=session-cookie; request failed'
        ],
        message: 'Request http://localhost:8096/Videos/x?api_key=abc failed for sample-user',
        nested: {
            authorization: 'MediaBrowser Token=abc',
            frontendURL: 'http://localhost:8080',
            note: 'password=sample-secret and wss://localhost:9224/devtools/page/1'
        },
        rawHDRValidation: {
            authorizedRouteKeys: [ 'I420P10:bt2020-ncl:bt2020:limited:pq' ],
            status: 'authorized'
        },
        username: 'sample-user'
    };
    const serialized = JSON.stringify(sanitizeReport(report, [
        'sample-secret',
        'sample-user'
    ]));

    assert.doesNotMatch(
        serialized,
        /sample-(?:secret|user)|localhost|https?:|wss?:|api_key=abc|quoted-json-token|unquoted-header-token|emby-prefixed-secret|mediabrowser-prefixed-secret|emby-token-header-secret|bare-token-secret|session-cookie/iu
    );
    assert.match(serialized, /\[redacted\]/u);
    assert.match(serialized, /\[redacted-url\]/u);
    assert.match(serialized, /I420P10:bt2020-ncl:bt2020:limited:pq/u);
});

/* eslint-enable sonarjs/no-hardcoded-passwords */
