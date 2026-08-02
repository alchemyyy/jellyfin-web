/* eslint-disable compat/compat -- This local harness targets Node 24 and a current Chromium browser */

const DEFAULT_DEBUG_URL = 'http://localhost:9224';
const DEFAULT_FRONTEND_URL = 'http://localhost:8080';
const DEFAULT_SERVER_URL = 'http://localhost:8096';
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;
const MAXIMUM_AUDIO_UNDERFLOW_RATIO = 0.02;
const MAXIMUM_RAW_OUTSTANDING_FRAMES = 2;
const MAXIMUM_VIDEO_FRAME_PENDING_FRAMES = 4;
const MINIMUM_AUDIO_OUTPUT_FRAMES_FOR_UNDERFLOW_RATIO = 4_800;
const MAXIMUM_REPEAT_SESSION_COUNT = 5;
const MINIMUM_SOAK_SESSION_COUNT = 10;
const MAXIMUM_SOAK_SESSION_COUNT = 100;
const MINIMUM_STARTUP_SAMPLE_COUNT = 10;
const MAXIMUM_STARTUP_SAMPLE_COUNT = 30;
const DEFAULT_SEEK_STORM_COUNT = 3;
const MAXIMUM_SEEK_STORM_COUNT = 5;
const MICROSECONDS_PER_SECOND = 1_000_000;
const NATURAL_END_CLOCK_TOLERANCE_MICROSECONDS = 20_000;
const SEEK_END_GUARD_MICROSECONDS = 2 * MICROSECONDS_PER_SECOND;
const SEEK_START_GUARD_MICROSECONDS = MICROSECONDS_PER_SECOND;
const SEEK_STORM_FRACTIONS = Object.freeze([ 0.2, 0.7, 0.35, 0.8, 0.5 ]);
const LOOPBACK_HOSTNAMES = new Set([ '127.0.0.1', '[::1]', 'localhost' ]);

const OPTION_DEFINITIONS = Object.freeze({
    '--audio-stream-index': {
        environmentName: 'WEBGPU_SMOKE_AUDIO_STREAM_INDEX',
        name: 'audioStreamIndex'
    },
    '--completion-mode': {
        environmentName: 'WEBGPU_SMOKE_COMPLETION_MODE',
        name: 'completionMode'
    },
    '--debug-url': {
        environmentName: 'WEBGPU_SMOKE_DEBUG_URL',
        name: 'debugURL'
    },
    '--expected-audio': {
        environmentName: 'WEBGPU_SMOKE_EXPECTED_AUDIO',
        name: 'expectedAudioPath'
    },
    '--expected-audio-codec': {
        environmentName: 'WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC',
        name: 'expectedAudioCodec'
    },
    '--expected-frame-evidence': {
        environmentName: 'WEBGPU_SMOKE_EXPECTED_FRAME_EVIDENCE',
        name: 'expectedFrameEvidence'
    },
    '--expected-video-output': {
        environmentName: 'WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT',
        name: 'expectedVideoOutputMode'
    },
    '--expected-video-decoder': {
        environmentName: 'WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER',
        name: 'expectedVideoDecoderBackend'
    },
    '--frontend-url': {
        environmentName: 'WEBGPU_SMOKE_FRONTEND_URL',
        name: 'frontendURL'
    },
    '--inject-failure': {
        environmentName: 'WEBGPU_SMOKE_INJECT_FAILURE',
        name: 'failureInjection'
    },
    '--item-id': {
        environmentName: 'WEBGPU_SMOKE_ITEM_ID',
        name: 'itemID'
    },
    '--password': {
        environmentName: 'WEBGPU_SMOKE_PASSWORD',
        name: 'password'
    },
    '--repeat-sessions': {
        environmentName: 'WEBGPU_SMOKE_REPEAT_SESSIONS',
        name: 'repeatSessionCount'
    },
    '--seek-storm-count': {
        environmentName: 'WEBGPU_SMOKE_SEEK_STORM_COUNT',
        name: 'seekStormCount'
    },
    '--server-url': {
        environmentName: 'WEBGPU_SMOKE_SERVER_URL',
        name: 'serverURL'
    },
    '--soak-sessions': {
        environmentName: 'WEBGPU_SMOKE_SOAK_SESSIONS',
        name: 'soakSessionCount'
    },
    '--startup-samples': {
        environmentName: 'WEBGPU_SMOKE_STARTUP_SAMPLES',
        name: 'startupSampleCount'
    },
    '--timeout-ms': {
        environmentName: 'WEBGPU_SMOKE_TIMEOUT_MS',
        name: 'timeoutMilliseconds'
    },
    '--username': {
        environmentName: 'WEBGPU_SMOKE_USERNAME',
        name: 'username'
    }
});

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s"'<>]+/giu;
const SENSITIVE_ASSIGNMENT_PATTERN = new RegExp(
    String.raw`(?<![\p{L}\p{N}_-])["']?(?:(?:x[-_ ]?(?:emby|media[_ -]?browser)[-_ ]?)?(?:authorization|token)|access[_ -]?token|api[_ -]?key|cookie|password|username)["']?\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,;]+)`,
    'giu'
);
const QUERY_SECRET_PATTERN = /([?&](?:api_key|token|access_token)=)[^&#\s]+/giu;
const VIDEO_SAMPLE_OWNERSHIP_WARNING_PATTERN = /\bVideoSample\b.*\bgarbage collected\b.*\bclosed\b/iu;

export const SMOKE_USAGE = `Usage:
  node scripts/webgpu/run-browser-playback-smoke.mjs [options]

Options:
  --debug-url <url>      Chromium remote-debugging HTTP endpoint
  --frontend-url <url>   Built Jellyfin Web frontend URL
  --server-url <url>     Jellyfin server URL entered in the UI
  --item-id <id>         Video item ID to play
  --expected-video-output <video-frame|raw-planes>
                         Required decoded video output mode
  --expected-video-decoder <native|bundled-hevc>
                         Optional negotiated video decoder backend
  --expected-audio <disabled|ready|native-media>
                         Required custom audio route
  --audio-stream-index <number>
                         Optional Jellyfin stream index to select during playback
  --expected-audio-codec <codec>
                         Decoder codec expected after selecting the audio stream
  --expected-frame-evidence <none|testsrc2-motion>
                         Optional canvas evidence for generated smoke media
  --completion-mode <controlled-stop|natural-end>
                         Lifecycle exercise; defaults to controlled-stop
  --repeat-sessions <1-5>
                         Playback sessions to run; defaults to 1
  --inject-failure <none|presentation|device-loss|paused-device-loss>
                         Optional presentation fault exercise; defaults to none
                         Device loss validates route-specific recovery
  --seek-storm-count <0-5>
                         Rapid in-session seeks to issue; defaults to 3
  --soak-sessions <0|10-100>
                          Lean post-stop retention soak; 0 disables it
  --startup-samples <0|10-30>
                         Paired HTML, presentation, and custom startup gate
  --username <name>      Jellyfin username
  --password <password>  Jellyfin password
  --timeout-ms <number>  Per-phase timeout in milliseconds
  --help                  Show this text

Environment equivalents:
  WEBGPU_SMOKE_DEBUG_URL, WEBGPU_SMOKE_FRONTEND_URL,
  WEBGPU_SMOKE_SERVER_URL, WEBGPU_SMOKE_ITEM_ID,
  WEBGPU_SMOKE_EXPECTED_VIDEO_OUTPUT, WEBGPU_SMOKE_EXPECTED_VIDEO_DECODER,
  WEBGPU_SMOKE_EXPECTED_AUDIO, WEBGPU_SMOKE_EXPECTED_FRAME_EVIDENCE,
  WEBGPU_SMOKE_AUDIO_STREAM_INDEX, WEBGPU_SMOKE_EXPECTED_AUDIO_CODEC,
  WEBGPU_SMOKE_COMPLETION_MODE,
  WEBGPU_SMOKE_REPEAT_SESSIONS, WEBGPU_SMOKE_INJECT_FAILURE,
  WEBGPU_SMOKE_SEEK_STORM_COUNT, WEBGPU_SMOKE_SOAK_SESSIONS,
  WEBGPU_SMOKE_STARTUP_SAMPLES,
  WEBGPU_SMOKE_USERNAME, WEBGPU_SMOKE_PASSWORD,
  WEBGPU_SMOKE_TIMEOUT_MS`;

function readOptionValues(argumentList) {
    const values = {};
    for (let argumentIndex = 0; argumentIndex < argumentList.length; argumentIndex += 1) {
        const argument = argumentList[argumentIndex];
        if (argument === '--help') {
            values.help = true;
            continue;
        }

        const definition = OPTION_DEFINITIONS[argument];
        if (!definition) {
            throw new TypeError(`Unknown browser smoke option: ${argument}`);
        }
        if (Object.hasOwn(values, definition.name)) {
            throw new TypeError(`Duplicate browser smoke option: ${argument}`);
        }

        argumentIndex += 1;
        const value = argumentList[argumentIndex];
        if (!value || value.startsWith('--')) {
            throw new TypeError(`Missing value for browser smoke option: ${argument}`);
        }
        values[definition.name] = value;
    }
    return values;
}

function requireNonEmptyString(value, optionName) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`Missing required browser smoke option: ${optionName}`);
    }
    return value;
}

function parseHTTPURL(value, optionName) {
    let parsedURL;
    try {
        parsedURL = new URL(value);
    } catch {
        throw new TypeError(`Invalid URL for browser smoke option: ${optionName}`);
    }
    if (parsedURL.protocol !== 'http:' && parsedURL.protocol !== 'https:') {
        throw new TypeError(`Browser smoke option requires HTTP or HTTPS: ${optionName}`);
    }
    if (parsedURL.username || parsedURL.password) {
        throw new TypeError(`Browser smoke option must not contain URL credentials: ${optionName}`);
    }
    return parsedURL.toString().replace(/\/$/u, '');
}

function parseTimeoutMilliseconds(value) {
    const parsedValue = Number(value);
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 1_000 || parsedValue > 300_000) {
        throw new RangeError('Browser smoke timeout must be an integer from 1000 through 300000');
    }
    return parsedValue;
}

function parseRepeatSessionCount(value) {
    const parsedValue = Number(value);
    if (!Number.isSafeInteger(parsedValue)
        || parsedValue < 1
        || parsedValue > MAXIMUM_REPEAT_SESSION_COUNT) {
        throw new RangeError('Browser smoke repeat sessions must be an integer from 1 through 5');
    }
    return parsedValue;
}

function parseSoakSessionCount(value) {
    const parsedValue = Number(value);
    if (!Number.isSafeInteger(parsedValue)
        || (parsedValue !== 0
            && (parsedValue < MINIMUM_SOAK_SESSION_COUNT
                || parsedValue > MAXIMUM_SOAK_SESSION_COUNT))) {
        throw new RangeError(
            'Browser smoke soak sessions must be 0 or an integer from 10 through 100'
        );
    }
    return parsedValue;
}

function parseStartupSampleCount(value) {
    const parsedValue = Number(value);
    if (!Number.isSafeInteger(parsedValue)
        || (parsedValue !== 0
            && (parsedValue < MINIMUM_STARTUP_SAMPLE_COUNT
                || parsedValue > MAXIMUM_STARTUP_SAMPLE_COUNT))) {
        throw new RangeError(
            'Browser smoke startup samples must be 0 or an integer from 10 through 30'
        );
    }
    return parsedValue;
}

function parseSeekStormCount(value) {
    const parsedValue = Number(value);
    if (!Number.isSafeInteger(parsedValue)
        || parsedValue < 0
        || parsedValue > MAXIMUM_SEEK_STORM_COUNT) {
        throw new RangeError('Browser smoke seek storm count must be an integer from 0 through 5');
    }
    return parsedValue;
}

function parseAudioStreamIndex(value) {
    const parsedValue = Number(value);
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 0 || parsedValue > 10_000) {
        throw new RangeError('Browser smoke audio stream index must be an integer from 0 through 10000');
    }
    return parsedValue;
}

function parseExpectedAudioCodec(value) {
    const expectedCodec = requireNonEmptyString(value, '--expected-audio-codec');
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(expectedCodec)) {
        throw new TypeError('Invalid browser smoke expectation for --expected-audio-codec');
    }
    return expectedCodec;
}

function parseExpectedValue(value, optionName, acceptedValues) {
    const expectedValue = requireNonEmptyString(value, optionName);
    if (!acceptedValues.includes(expectedValue)) {
        throw new TypeError(
            `Invalid browser smoke expectation for ${optionName}`
        );
    }
    return expectedValue;
}

function resolveSeekStormCount(
    configuredValue,
    completionMode,
    soakSessionCount,
    startupSampleCount
) {
    if (configuredValue !== undefined) {
        return parseSeekStormCount(configuredValue);
    }
    return completionMode === 'natural-end'
        || soakSessionCount > 0
        || startupSampleCount > 0 ?
        0 :
        DEFAULT_SEEK_STORM_COUNT;
}

function validateNaturalEndConfiguration(options) {
    if (options.completionMode !== 'natural-end') {
        return;
    }
    if (options.audioStreamIndex !== null) {
        throw new TypeError(
            'Browser smoke natural-end mode does not support an in-session audio stream change'
        );
    }
    if (options.repeatSessionCount !== 1) {
        throw new TypeError(
            'Browser smoke natural-end mode requires --repeat-sessions 1'
        );
    }
    if (options.failureInjection !== 'none') {
        throw new TypeError(
            'Browser smoke natural-end mode requires --inject-failure none'
        );
    }
    if (options.seekStormCount !== 0) {
        throw new TypeError(
            'Browser smoke natural-end mode requires --seek-storm-count 0'
        );
    }
}

function validateSoakConfiguration(options) {
    if (options.soakSessionCount === 0) {
        return;
    }
    if (options.completionMode !== 'controlled-stop') {
        throw new TypeError(
            'Browser smoke soak mode requires --completion-mode controlled-stop'
        );
    }
    if (options.audioStreamIndex !== null) {
        throw new TypeError(
            'Browser smoke soak mode does not support an in-session audio stream change'
        );
    }
    if (options.repeatSessionCount !== 1) {
        throw new TypeError(
            'Browser smoke soak mode requires --repeat-sessions 1'
        );
    }
    if (options.failureInjection !== 'none') {
        throw new TypeError(
            'Browser smoke soak mode requires --inject-failure none'
        );
    }
    if (options.seekStormCount !== 0) {
        throw new TypeError(
            'Browser smoke soak mode requires --seek-storm-count 0'
        );
    }
    if (options.expectedFrameEvidence !== 'none') {
        throw new TypeError(
            'Browser smoke soak mode requires --expected-frame-evidence none'
        );
    }
}

function validateStartupConfiguration(options) {
    if (options.startupSampleCount === 0) {
        return;
    }
    if (options.soakSessionCount !== 0) {
        throw new TypeError(
            'Browser smoke startup mode requires --soak-sessions 0'
        );
    }
    if (options.completionMode !== 'controlled-stop') {
        throw new TypeError(
            'Browser smoke startup mode requires --completion-mode controlled-stop'
        );
    }
    if (options.audioStreamIndex !== null) {
        throw new TypeError(
            'Browser smoke startup mode does not support an in-session audio stream change'
        );
    }
    if (options.repeatSessionCount !== 1) {
        throw new TypeError(
            'Browser smoke startup mode requires --repeat-sessions 1'
        );
    }
    if (options.failureInjection !== 'none') {
        throw new TypeError(
            'Browser smoke startup mode requires --inject-failure none'
        );
    }
    if (options.seekStormCount !== 0) {
        throw new TypeError(
            'Browser smoke startup mode requires --seek-storm-count 0'
        );
    }
    if (options.expectedFrameEvidence !== 'none') {
        throw new TypeError(
            'Browser smoke startup mode requires --expected-frame-evidence none'
        );
    }
}

/** Parses CLI flags first, then environment variables, without supplying credentials. */
export function parseSmokeConfiguration(argumentList, environment) {
    const optionValues = readOptionValues(argumentList);
    if (optionValues.help === true) {
        return { help: true };
    }

    const configuredValue = name => {
        if (Object.hasOwn(optionValues, name)) {
            return optionValues[name];
        }
        const definition = Object.values(OPTION_DEFINITIONS).find(candidate => (
            candidate.name === name
        ));
        return definition ? environment[definition.environmentName] : undefined;
    };

    const timeoutValue = configuredValue('timeoutMilliseconds');
    const repeatSessionValue = configuredValue('repeatSessionCount');
    const soakSessionValue = configuredValue('soakSessionCount');
    const startupSampleValue = configuredValue('startupSampleCount');
    const seekStormValue = configuredValue('seekStormCount');
    const audioStreamIndexValue = configuredValue('audioStreamIndex');
    const expectedAudioCodecValue = configuredValue('expectedAudioCodec');
    const audioStreamIndex = audioStreamIndexValue === undefined ?
        null :
        parseAudioStreamIndex(audioStreamIndexValue);
    const expectedAudioCodec = expectedAudioCodecValue === undefined ?
        null :
        parseExpectedAudioCodec(expectedAudioCodecValue);
    const completionMode = parseExpectedValue(
        configuredValue('completionMode') || 'controlled-stop',
        '--completion-mode',
        [ 'controlled-stop', 'natural-end' ]
    );
    if ((audioStreamIndex === null) !== (expectedAudioCodec === null)) {
        throw new TypeError(
            'Browser smoke audio stream selection requires both --audio-stream-index and --expected-audio-codec'
        );
    }
    const expectedAudioPath = parseExpectedValue(
        configuredValue('expectedAudioPath'),
        '--expected-audio',
        [ 'disabled', 'ready', 'native-media' ]
    );
    if (audioStreamIndex !== null && expectedAudioPath === 'disabled') {
        throw new TypeError(
            'Browser smoke audio stream selection requires an enabled --expected-audio route'
        );
    }
    if (audioStreamIndex !== null && repeatSessionValue && parseRepeatSessionCount(repeatSessionValue) !== 1) {
        throw new TypeError(
            'Browser smoke audio stream selection requires --repeat-sessions 1'
        );
    }
    const failureInjection = parseExpectedValue(
        configuredValue('failureInjection') || 'none',
        '--inject-failure',
        [ 'none', 'presentation', 'device-loss', 'paused-device-loss' ]
    );
    const expectedVideoOutputMode = parseExpectedValue(
        configuredValue('expectedVideoOutputMode'),
        '--expected-video-output',
        [ 'video-frame', 'raw-planes' ]
    );
    const expectedFrameEvidence = parseExpectedValue(
        configuredValue('expectedFrameEvidence') || 'none',
        '--expected-frame-evidence',
        [ 'none', 'testsrc2-motion' ]
    );
    const configuredVideoDecoderBackend = configuredValue('expectedVideoDecoderBackend');
    const expectedVideoDecoderBackend = configuredVideoDecoderBackend === undefined ?
        null :
        parseExpectedValue(
            configuredVideoDecoderBackend,
            '--expected-video-decoder',
            [ 'native', 'bundled-hevc' ]
        );
    const repeatSessionCount = repeatSessionValue ?
        parseRepeatSessionCount(repeatSessionValue) :
        1;
    const soakSessionCount = soakSessionValue === undefined ?
        0 :
        parseSoakSessionCount(soakSessionValue);
    const startupSampleCount = startupSampleValue === undefined ?
        0 :
        parseStartupSampleCount(startupSampleValue);
    const seekStormCount = resolveSeekStormCount(
        seekStormValue,
        completionMode,
        soakSessionCount,
        startupSampleCount
    );
    validateNaturalEndConfiguration({
        audioStreamIndex,
        completionMode,
        failureInjection,
        repeatSessionCount,
        seekStormCount
    });
    validateSoakConfiguration({
        audioStreamIndex,
        completionMode,
        expectedFrameEvidence,
        failureInjection,
        repeatSessionCount,
        seekStormCount,
        soakSessionCount
    });
    validateStartupConfiguration({
        audioStreamIndex,
        completionMode,
        expectedFrameEvidence,
        failureInjection,
        repeatSessionCount,
        seekStormCount,
        soakSessionCount,
        startupSampleCount
    });
    return {
        audioStreamIndex,
        completionMode,
        debugURL: parseHTTPURL(
            configuredValue('debugURL') || DEFAULT_DEBUG_URL,
            '--debug-url'
        ),
        frontendURL: parseHTTPURL(
            configuredValue('frontendURL') || DEFAULT_FRONTEND_URL,
            '--frontend-url'
        ),
        failureInjection,
        expectedAudioCodec,
        expectedAudioPath,
        expectedFrameEvidence,
        expectedVideoDecoderBackend,
        expectedVideoOutputMode,
        itemID: requireNonEmptyString(configuredValue('itemID'), '--item-id'),
        password: requireNonEmptyString(configuredValue('password'), '--password'),
        repeatSessionCount,
        seekStormCount,
        serverURL: parseHTTPURL(
            configuredValue('serverURL') || DEFAULT_SERVER_URL,
            '--server-url'
        ),
        soakSessionCount,
        startupSampleCount,
        timeoutMilliseconds: timeoutValue ?
            parseTimeoutMilliseconds(timeoutValue) :
            DEFAULT_TIMEOUT_MILLISECONDS,
        username: requireNonEmptyString(configuredValue('username'), '--username')
    };
}

/** Returns a balanced native/custom order for one one-based measured startup round. */
export function createStartupSampleModeOrder(sampleNumber) {
    if (!Number.isSafeInteger(sampleNumber) || sampleNumber <= 0) {
        throw new TypeError('Startup sample number must be a positive safe integer');
    }
    return sampleNumber % 2 === 1 ?
        [ 'html', 'presentation', 'custom' ] :
        [ 'custom', 'presentation', 'html' ];
}

/** Returns the runtime config overlay for one startup comparison mode. */
export function getStartupModeFeatureFlags(mode) {
    switch (mode) {
        case 'html':
            return {
                enableWebGPUCustomDecode: false,
                enableWebGPUHDRToneMapping: false,
                enableWebGPUValidationHarness: false,
                enableWebGPUVideoPlayer: false
            };
        case 'presentation':
            return {
                enableWebGPUCustomDecode: false,
                enableWebGPUHDRToneMapping: false,
                enableWebGPUValidationHarness: false,
                enableWebGPUVideoPlayer: true
            };
        case 'custom':
            return {
                enableWebGPUCustomDecode: true,
                enableWebGPUHDRToneMapping: true,
                enableWebGPUValidationHarness: true,
                enableWebGPUVideoPlayer: true
            };
        default:
            throw new TypeError('Unknown startup comparison mode');
    }
}

/** Accepts the authenticated shell, add-server form, or server-selection page. */
export function isFrontendInitializationReady(state) {
    return state?.apiClientLandingAvailable === true
        || state?.serverHostInputAvailable === true
        || state?.serverSelectionPageAvailable === true;
}

/** Selects the next connection step after the unauthenticated shell settles. */
export function resolveServerConnectionLandingAction(state) {
    if (state?.serverHostInputAvailable === true) {
        return 'enter-server';
    }
    if (state?.addServerButtonAvailable === true) {
        return 'open-add-server';
    }
    if (state?.loginPageAvailable === true) {
        return 'use-selected-server';
    }
    return null;
}

/** Requires decoded PCM submission and render-thread consumption, not output silence. */
export function hasConsumedCustomAudio(snapshot) {
    const audioBridge = snapshot?.customPlayback?.audioBridge;
    const audioOutput = snapshot?.customPlayback?.audioOutput;
    return audioOutput?.playing === true
        && Number.isSafeInteger(audioOutput.consumedFrames)
        && audioOutput.consumedFrames > 0
        && Number.isSafeInteger(audioBridge?.submittedFrameCount)
        && audioBridge.submittedFrameCount > 0
        && Number.isSafeInteger(audioBridge?.submittedSampleCount)
        && audioBridge.submittedSampleCount > 0;
}

/** Requires an owned native audio element, qualified clock, and appended media. */
export function hasReadyNativeMediaAudio(snapshot) {
    const customPlayback = snapshot?.customPlayback;
    const decodeTelemetry = customPlayback?.videoDecode;
    return snapshot?.customPlaybackEligibility?.audioOutputMode === 'native-media'
        && customPlayback?.audioPath === 'ready'
        && customPlayback.audioBridge === null
        && customPlayback.audioOutput === null
        && decodeTelemetry?.nativeAudioClockReady === true
        && Number.isSafeInteger(decodeTelemetry.receivedNativeAudioSegmentCount)
        && decodeTelemetry.receivedNativeAudioSegmentCount > 0
        && Number.isSafeInteger(customPlayback.currentTimeMicroseconds)
        && customPlayback.currentTimeMicroseconds >= 0
        && snapshot?.dom?.ownedNativeAudioCount === 1
        && snapshot.dom.ownedNativeAudioPlaying === true
        && snapshot.dom.ownedNativeAudioSourcedCount === 1;
}

/** Identifies the Mediabunny finalizer warning that invalidates a retention soak. */
export function isVideoSampleOwnershipWarning(value) {
    return typeof value === 'string'
        && VIDEO_SAMPLE_OWNERSHIP_WARNING_PATTERN.test(value);
}

/** Builds a same-frontend hash route without carrying an existing fragment. */
export function createFrontendRouteURL(frontendURL, route) {
    const routeURL = new URL(frontendURL);
    routeURL.hash = route.startsWith('/') ? route : `/${route}`;
    return routeURL.toString();
}

/** Treats equivalent loopback spellings as the same local test server. */
export function areEquivalentServerURLs(firstURL, secondURL) {
    let firstServerURL;
    let secondServerURL;
    try {
        firstServerURL = new URL(firstURL);
        secondServerURL = new URL(secondURL);
    } catch {
        return false;
    }
    const firstPort = firstServerURL.port || (
        firstServerURL.protocol === 'https:' ? '443' : '80'
    );
    const secondPort = secondServerURL.port || (
        secondServerURL.protocol === 'https:' ? '443' : '80'
    );
    const firstPath = firstServerURL.pathname.replace(/\/$/u, '');
    const secondPath = secondServerURL.pathname.replace(/\/$/u, '');
    const hostnamesMatch = firstServerURL.hostname === secondServerURL.hostname
        || (LOOPBACK_HOSTNAMES.has(firstServerURL.hostname)
            && LOOPBACK_HOSTNAMES.has(secondServerURL.hostname));
    return hostnamesMatch
        && firstServerURL.protocol === secondServerURL.protocol
        && firstPort === secondPort
        && firstPath === secondPath;
}

/** Derives the bounded authorization key for an active raw presentation route. */
export function deriveRawHDRPlaybackRouteKey(rawFrameFormat, colorMetadata) {
    if (rawFrameFormat !== 'I420P10'
        || colorMetadata?.bitDepth !== 10
        || colorMetadata.matrix !== 'bt2020-ncl'
        || colorMetadata.primaries !== 'bt2020'
        || colorMetadata.range !== 'limited') {
        return null;
    }
    switch (colorMetadata.transfer) {
        case 'hlg':
            return 'I420P10:bt2020-ncl:bt2020:limited:hlg';
        case 'pq':
            return 'I420P10:bt2020-ncl:bt2020:limited:pq';
        default:
            return null;
    }
}

/** Creates deterministic, non-monotonic seek targets with fixed endpoint guards. */
export function createSeekStormTargetsMicroseconds(durationMicroseconds, seekCount) {
    if (!Number.isSafeInteger(seekCount)
        || seekCount < 0
        || seekCount > MAXIMUM_SEEK_STORM_COUNT) {
        throw new RangeError('Seek storm count must be an integer from 0 through 5');
    }
    if (seekCount === 0) {
        return [];
    }
    if (!Number.isSafeInteger(durationMicroseconds)
        || durationMicroseconds < 8 * MICROSECONDS_PER_SECOND) {
        return [];
    }

    const seekableSpanMicroseconds = durationMicroseconds
        - SEEK_START_GUARD_MICROSECONDS
        - SEEK_END_GUARD_MICROSECONDS;
    const targets = [];
    for (let targetIndex = 0; targetIndex < seekCount; targetIndex += 1) {
        targets.push(
            SEEK_START_GUARD_MICROSECONDS
                + Math.round(seekableSpanMicroseconds * SEEK_STORM_FRACTIONS[targetIndex])
        );
    }
    return targets;
}

/** Chooses one bounded seek target, including for short generated fixtures. */
export function createPrimarySeekTargetMicroseconds(
    currentTimeMicroseconds,
    durationMicroseconds
) {
    const desiredForwardTarget = currentTimeMicroseconds + (5 * MICROSECONDS_PER_SECOND);
    if (!Number.isSafeInteger(durationMicroseconds) || durationMicroseconds <= 0) {
        return desiredForwardTarget;
    }

    const endpointGuardMicroseconds = Math.min(
        SEEK_END_GUARD_MICROSECONDS,
        Math.max(250_000, Math.floor(durationMicroseconds * 0.25))
    );
    const maximumTargetMicroseconds = Math.max(
        0,
        durationMicroseconds - endpointGuardMicroseconds
    );
    if (desiredForwardTarget <= maximumTargetMicroseconds) {
        return desiredForwardTarget;
    }

    const proportionalTargetMicroseconds = Math.floor(durationMicroseconds * 0.35);
    const minimumUsefulTargetMicroseconds = Math.min(
        SEEK_START_GUARD_MICROSECONDS,
        maximumTargetMicroseconds
    );
    return Math.min(
        maximumTargetMicroseconds,
        Math.max(minimumUsefulTargetMicroseconds, proportionalTargetMicroseconds)
    );
}

function addFailure(failures, condition, code) {
    if (!condition) {
        failures.push(code);
    }
}

function hasRedDominance(sample, threshold) {
    const [ red, green, blue ] = sample ?? [];
    return Number.isInteger(red)
        && Number.isInteger(green)
        && Number.isInteger(blue)
        && red >= green + threshold
        && red >= blue + threshold;
}

function hasBlueDominance(sample, threshold) {
    const [ red, green, blue ] = sample ?? [];
    return Number.isInteger(red)
        && Number.isInteger(green)
        && Number.isInteger(blue)
        && blue >= red + threshold
        && blue >= green + threshold;
}

function hasYellowDominance(sample, threshold) {
    const [ red, green, blue ] = sample ?? [];
    return Number.isInteger(red)
        && Number.isInteger(green)
        && Number.isInteger(blue)
        && red >= blue + threshold
        && green >= blue + threshold;
}

function hasCyanDominance(sample, threshold) {
    const [ red, green, blue ] = sample ?? [];
    return Number.isInteger(red)
        && Number.isInteger(green)
        && Number.isInteger(blue)
        && green >= red + threshold
        && blue >= red + threshold;
}

function validateTestSourceFrame(failures, evidence, label) {
    const expectedSampleWidth = 64;
    const expectedSampleHeight = 36;
    const expectedPixelCount = expectedSampleWidth * expectedSampleHeight;
    const minimumChannelRange = 32;
    const dominanceThreshold = 12;
    const horizontalSamples = evidence?.horizontalSamples;

    addFailure(failures, evidence?.status === 'captured', `${label}-capture-failed`);
    addFailure(
        failures,
        evidence?.sampleWidth === expectedSampleWidth
            && evidence?.sampleHeight === expectedSampleHeight
            && evidence?.pixelCount === expectedPixelCount,
        `${label}-sample-geometry-invalid`
    );
    addFailure(
        failures,
        evidence?.opaquePixelCount === expectedPixelCount,
        `${label}-alpha-invalid`
    );
    addFailure(
        failures,
        Number.isInteger(evidence?.nonBlackPixelCount)
            && evidence.nonBlackPixelCount >= expectedPixelCount / 2,
        `${label}-mostly-black`
    );
    addFailure(
        failures,
        Number.isInteger(evidence?.chromaticPixelCount)
            && evidence.chromaticPixelCount >= expectedPixelCount / 4,
        `${label}-color-diversity-missing`
    );
    addFailure(
        failures,
        Array.isArray(evidence?.channelMinimums)
            && evidence.channelMinimums.length === 3
            && Array.isArray(evidence?.channelMaximums)
            && evidence.channelMaximums.length === 3
            && evidence.channelMaximums.every((maximum, channelIndex) => (
                maximum - evidence.channelMinimums[channelIndex] >= minimumChannelRange
            )),
        `${label}-channel-range-insufficient`
    );
    addFailure(
        failures,
        Array.isArray(horizontalSamples)
            && horizontalSamples.length === 8
            && hasRedDominance(horizontalSamples[0], dominanceThreshold)
            && hasYellowDominance(horizontalSamples[3], dominanceThreshold)
            && hasBlueDominance(horizontalSamples[4], dominanceThreshold)
            && hasCyanDominance(horizontalSamples[7], dominanceThreshold),
        `${label}-testsrc2-signature-mismatch`
    );
}

/** Validates sampled pixels from the actual presentation canvas for generated media. */
export function validatePresentedFrameEvidence(initialEvidence, laterEvidence, expectation) {
    if (expectation === 'none') {
        return [];
    }
    if (expectation !== 'testsrc2-motion') {
        throw new TypeError('The presented-frame evidence expectation is invalid');
    }

    const failures = [];
    validateTestSourceFrame(failures, initialEvidence, 'initial-frame');
    validateTestSourceFrame(failures, laterEvidence, 'later-frame');
    addFailure(
        failures,
        Number.isSafeInteger(initialEvidence?.hash)
            && initialEvidence.hash >= 0
            && Number.isSafeInteger(laterEvidence?.hash)
            && laterEvidence.hash >= 0
            && initialEvidence.hash !== laterEvidence.hash,
        'presented-frame-motion-missing'
    );
    return failures;
}

function validateRawHDRAuthorizationSnapshot(failures, snapshot) {
    if (snapshot.customPlaybackEligibility?.videoOutputMode !== 'raw-planes') {
        return;
    }

    const authorization = snapshot.rawHDRValidation;
    const routeKey = snapshot.rawHDRPlaybackRouteKey;
    addFailure(
        failures,
        authorization?.status === 'authorized',
        'raw-hdr-authorization-not-authorized'
    );
    addFailure(
        failures,
        authorization?.targetFormat === 'bgra8unorm'
            || authorization?.targetFormat === 'rgba8unorm',
        'raw-hdr-authorization-target-invalid'
    );
    addFailure(
        failures,
        Number.isSafeInteger(authorization?.fixtureVersion)
            && authorization.fixtureVersion > 0
            && Number.isSafeInteger(authorization?.renderSettingsVersion)
            && authorization.renderSettingsVersion > 0,
        'raw-hdr-authorization-version-invalid'
    );
    addFailure(
        failures,
        routeKey === 'I420P10:bt2020-ncl:bt2020:limited:hlg'
            || routeKey === 'I420P10:bt2020-ncl:bt2020:limited:pq',
        'raw-hdr-playback-route-missing'
    );
    addFailure(
        failures,
        Array.isArray(authorization?.authorizedRouteKeys)
            && authorization.authorizedRouteKeys.includes(routeKey),
        'raw-hdr-playback-route-unauthorized'
    );
}

function getExpectedAudioOutputMode(expectedAudioPath) {
    switch (expectedAudioPath) {
        case 'ready':
            return 'decoded-pcm';
        case 'native-media':
            return 'native-media';
        case 'disabled':
            return null;
        default:
            return undefined;
    }
}

function validateDecodedAudioSnapshot(failures, initialSnapshot, laterSnapshot) {
    const audioBridge = laterSnapshot.customPlayback?.audioBridge;
    const audioOutput = laterSnapshot.customPlayback?.audioOutput;
    addFailure(failures, audioBridge !== null, 'audio-bridge-telemetry-missing');
    addFailure(failures, audioOutput !== null, 'audio-output-telemetry-missing');
    addFailure(failures, audioBridge?.failed === false, 'audio-bridge-failed');
    addFailure(failures, (audioOutput?.consumedFrames ?? 0) > 0, 'audio-not-consumed');
    addFailure(failures, audioOutput?.playing === true, 'audio-output-not-playing');
    addFailure(failures, audioOutput?.droppedFrames === 0, 'audio-frames-dropped');
    addFailure(failures, audioOutput?.overflowEvents === 0, 'audio-overflow');
    addFailure(failures, audioOutput?.staleChunks === 0, 'stale-audio-chunks');
    const initialOutputFrames = initialSnapshot.customPlayback?.audioOutput?.outputFrames ?? 0;
    const laterOutputFrames = audioOutput?.outputFrames;
    const initialUnderflowFrames =
        initialSnapshot.customPlayback?.audioOutput?.underflowFrames ?? 0;
    const laterUnderflowFrames = audioOutput?.underflowFrames;
    const outputFrameDelta = laterOutputFrames - initialOutputFrames;
    const underflowFrameDelta = laterUnderflowFrames - initialUnderflowFrames;
    addFailure(
        failures,
        Number.isSafeInteger(initialOutputFrames)
            && initialOutputFrames >= 0
            && Number.isSafeInteger(laterOutputFrames)
            && laterOutputFrames >= 0
            && Number.isSafeInteger(initialUnderflowFrames)
            && initialUnderflowFrames >= 0
            && Number.isSafeInteger(laterUnderflowFrames)
            && laterUnderflowFrames >= 0
            && outputFrameDelta >= 0
            && underflowFrameDelta >= 0
            && (
                outputFrameDelta < MINIMUM_AUDIO_OUTPUT_FRAMES_FOR_UNDERFLOW_RATIO
                || underflowFrameDelta / outputFrameDelta <= MAXIMUM_AUDIO_UNDERFLOW_RATIO
            ),
        'audio-underflow-ratio-exceeded'
    );
}

function validateNativeAudioSnapshot(failures, laterSnapshot) {
    const customPlayback = laterSnapshot.customPlayback;
    addFailure(failures, customPlayback?.audioBridge === null, 'native-audio-bridge-active');
    addFailure(failures, customPlayback?.audioOutput === null, 'native-audio-output-active');
    addFailure(
        failures,
        customPlayback?.videoDecode?.nativeAudioClockReady === true,
        'native-audio-clock-not-ready'
    );
    addFailure(
        failures,
        (customPlayback?.videoDecode?.receivedNativeAudioSegmentCount ?? 0) > 0,
        'native-audio-segments-missing'
    );
    addFailure(
        failures,
        laterSnapshot.dom?.ownedNativeAudioCount === 1,
        'native-audio-element-count'
    );
    addFailure(
        failures,
        laterSnapshot.dom?.ownedNativeAudioPlaying === true,
        'native-audio-not-playing'
    );
    addFailure(
        failures,
        laterSnapshot.dom?.ownedNativeAudioSourcedCount === 1,
        'native-audio-source-missing'
    );
}

function validateExpectedAudioSnapshot(
    failures,
    initialSnapshot,
    laterSnapshot,
    expectedAudioPath
) {
    switch (expectedAudioPath) {
        case 'ready':
            validateDecodedAudioSnapshot(failures, initialSnapshot, laterSnapshot);
            break;
        case 'native-media':
            validateNativeAudioSnapshot(failures, laterSnapshot);
            break;
        case 'disabled':
            addFailure(
                failures,
                laterSnapshot.customPlayback?.audioBridge === null,
                'disabled-audio-bridge-active'
            );
            addFailure(
                failures,
                laterSnapshot.customPlayback?.audioOutput === null,
                'disabled-audio-output-active'
            );
            addFailure(
                failures,
                laterSnapshot.dom?.ownedNativeAudioCount === 0,
                'disabled-native-audio-active'
            );
            break;
    }
}

/** Returns stable failure codes for an active custom-decoded playback sample pair. */
export function validateActivePlaybackSnapshot(
    initialSnapshot,
    laterSnapshot,
    expectations
) {
    const failures = [];
    const customTelemetry = laterSnapshot.customPlayback;
    const eligibility = laterSnapshot.customPlaybackEligibility;
    const decodeTelemetry = customTelemetry?.videoDecode;
    const presentationTelemetry = laterSnapshot.presentation;

    addFailure(failures, laterSnapshot.captured === true, 'player-not-captured');
    addFailure(failures, laterSnapshot.playerID === 'webgpuvideoplayer', 'wrong-player');
    addFailure(failures, laterSnapshot.terminalErrorCount === 0, 'player-error-event');
    addFailure(failures, customTelemetry !== null, 'custom-telemetry-missing');
    addFailure(
        failures,
        customTelemetry?.state !== 'error' && customTelemetry?.state !== 'fallback',
        'custom-pipeline-terminal-state'
    );
    addFailure(failures, customTelemetry?.fallbackReason === null, 'custom-fallback');
    addFailure(failures, customTelemetry?.hasLastError === false, 'custom-error-message');
    addFailure(failures, eligibility?.eligible === true, 'custom-eligibility-missing');
    addFailure(failures, decodeTelemetry?.failureKind === null, 'decode-failure');
    addFailure(failures, (decodeTelemetry?.receivedFrameCount ?? 0) > 0, 'no-decoded-frames');
    addFailure(failures, presentationTelemetry?.state === 'presenting', 'presenter-not-active');
    addFailure(failures, presentationTelemetry?.fallbackReason === null, 'presentation-fallback');
    addFailure(failures, presentationTelemetry?.presentationSource === 'decoded', 'native-frame-source');
    addFailure(failures, (presentationTelemetry?.decodedFrameCount ?? 0) > 0, 'no-decoded-presentation');
    addFailure(failures, (presentationTelemetry?.presentedFrameCount ?? 0) > 0, 'no-presented-frames');
    const expectedOutputMode = expectations.expectedVideoOutputMode;
    const expectedVideoDecoderBackend = expectations.expectedVideoDecoderBackend;
    const expectedAudioPath = expectations.expectedAudioPath;
    addFailure(
        failures,
        eligibility?.videoOutputMode === expectedOutputMode,
        'unexpected-video-output-mode'
    );
    if (
        expectedVideoDecoderBackend !== null
        && expectedVideoDecoderBackend !== undefined
    ) {
        addFailure(
            failures,
            eligibility?.videoDecoderBackend === expectedVideoDecoderBackend,
            'unexpected-video-decoder-backend'
        );
    }
    const expectedControllerAudioPath = expectedAudioPath === 'native-media' ?
        'ready' :
        expectedAudioPath;
    const expectedAudioOutputMode = getExpectedAudioOutputMode(expectedAudioPath);
    addFailure(
        failures,
        customTelemetry?.audioPath === expectedControllerAudioPath,
        'unexpected-audio-path'
    );
    addFailure(
        failures,
        eligibility?.audioOutputMode === expectedAudioOutputMode,
        'unexpected-audio-output-mode'
    );
    addFailure(
        failures,
        presentationTelemetry?.mode === (
            expectedOutputMode === 'raw-planes' ? 'hdr-to-sdr' : 'identity-sdr'
        ),
        'unexpected-presentation-mode'
    );
    addFailure(
        failures,
        eligibility?.hdr === (expectedOutputMode === 'raw-planes'),
        'hdr-eligibility-mismatch'
    );
    const maximumPendingFrames = expectedOutputMode === 'raw-planes' ?
        MAXIMUM_RAW_OUTSTANDING_FRAMES :
        MAXIMUM_VIDEO_FRAME_PENDING_FRAMES;
    addFailure(
        failures,
        Number.isSafeInteger(decodeTelemetry?.pendingFrameCount)
            && decodeTelemetry.pendingFrameCount >= 0
            && decodeTelemetry.pendingFrameCount <= maximumPendingFrames,
        'pending-frame-bound-exceeded'
    );
    if (expectedOutputMode === 'raw-planes') {
        const pendingFrameCount = decodeTelemetry?.pendingFrameCount;
        const peakFrameCount = decodeTelemetry?.peakFrameCount;
        const queuedFrameCount = decodeTelemetry?.queuedFrameCount;
        addFailure(
            failures,
            Number.isSafeInteger(pendingFrameCount)
                && pendingFrameCount >= 0
                && Number.isSafeInteger(queuedFrameCount)
                && queuedFrameCount >= 0
                && pendingFrameCount + queuedFrameCount <= MAXIMUM_RAW_OUTSTANDING_FRAMES
                && Number.isSafeInteger(peakFrameCount)
                && peakFrameCount >= 0
                && peakFrameCount <= MAXIMUM_RAW_OUTSTANDING_FRAMES,
            'raw-frame-credit-window-exceeded'
        );
    }
    validateRawHDRAuthorizationSnapshot(failures, laterSnapshot);
    validateExpectedAudioSnapshot(
        failures,
        initialSnapshot,
        laterSnapshot,
        expectedAudioPath
    );
    addFailure(
        failures,
        (presentationTelemetry?.presentedFrameCount ?? 0)
            > (initialSnapshot.presentation?.presentedFrameCount ?? -1),
        'presented-frame-count-not-advancing'
    );
    addFailure(
        failures,
        (customTelemetry?.currentTimeMicroseconds ?? 0)
            > (initialSnapshot.customPlayback?.currentTimeMicroseconds ?? -1),
        'media-clock-not-advancing'
    );
    const waitingEventDelta = (laterSnapshot.eventCounts?.waiting ?? 0)
        - (initialSnapshot.eventCounts?.waiting ?? 0);
    const playingEventDelta = (laterSnapshot.eventCounts?.playing ?? 0)
        - (initialSnapshot.eventCounts?.playing ?? 0);
    addFailure(
        failures,
        waitingEventDelta >= 0 && waitingEventDelta <= 1,
        'waiting-event-churn'
    );
    addFailure(
        failures,
        playingEventDelta >= 0 && playingEventDelta <= 1,
        'playing-event-churn'
    );
    addFailure(failures, laterSnapshot.dom.sourceLessVideoCount > 0, 'source-less-video-missing');
    addFailure(failures, laterSnapshot.dom.sourcedVideoCount === 0, 'native-video-source-active');
    addFailure(failures, laterSnapshot.dom.visibleCanvasCount > 0, 'webgpu-canvas-not-visible');
    return failures;
}

/** Returns stable failure codes for an in-session custom audio decoder restart. */
export function validateAudioStreamSwitchSnapshot(
    initialSnapshot,
    laterSnapshot,
    expectedAudioCodec,
    expectedAudioPath = 'ready'
) {
    const failures = [];
    const initialTelemetry = initialSnapshot.customPlayback;
    const laterTelemetry = laterSnapshot.customPlayback;
    const initialGeneration = initialTelemetry?.activeGeneration;
    const laterGeneration = laterTelemetry?.activeGeneration;

    addFailure(
        failures,
        Number.isSafeInteger(initialGeneration)
            && Number.isSafeInteger(laterGeneration)
            && laterGeneration > initialGeneration,
        'audio-generation-not-advanced'
    );
    addFailure(failures, laterTelemetry?.state === 'playing', 'audio-switch-not-playing');
    addFailure(failures, laterTelemetry?.audioPath === 'ready', 'audio-switch-path-not-ready');
    addFailure(failures, laterTelemetry?.fallbackReason === null, 'audio-switch-fallback');
    addFailure(failures, laterTelemetry?.videoDecode?.failureKind === null, 'audio-switch-decode-failure');
    addFailure(
        failures,
        laterSnapshot.customPlaybackEligibility?.audioOutputMode === (
            expectedAudioPath === 'native-media' ? 'native-media' : 'decoded-pcm'
        ),
        'unexpected-selected-audio-output-mode'
    );
    addFailure(
        failures,
        laterTelemetry?.videoDecode?.audioCodec === expectedAudioCodec,
        'unexpected-selected-audio-codec'
    );
    if (expectedAudioPath === 'native-media') {
        addFailure(
            failures,
            laterTelemetry?.videoDecode?.nativeAudioClockReady === true,
            'selected-native-audio-clock-not-ready'
        );
        addFailure(
            failures,
            (laterTelemetry?.videoDecode?.receivedNativeAudioSegmentCount ?? 0) > 0,
            'selected-native-audio-segments-missing'
        );
        addFailure(failures, laterTelemetry?.audioBridge === null, 'selected-native-audio-bridge-active');
        addFailure(failures, laterTelemetry?.audioOutput === null, 'selected-native-audio-output-active');
    } else {
        addFailure(
            failures,
            (laterTelemetry?.videoDecode?.receivedAudioFrameCount ?? 0) > 0,
            'selected-audio-not-decoded'
        );
    }
    addFailure(failures, laterSnapshot.presentation?.state === 'presenting', 'audio-switch-presenter-not-active');
    addFailure(failures, laterSnapshot.terminalErrorCount === 0, 'player-error-event');
    validateRawHDRAuthorizationSnapshot(failures, laterSnapshot);
    return failures;
}

/** Returns stable failure codes when a paused clock or renderer continues moving. */
export function validatePauseSnapshot(
    initialSnapshot,
    laterSnapshot,
    maximumClockDeltaMicroseconds = 100_000,
    maximumPresentedFrameDelta = 1
) {
    const failures = [];
    const initialTime = initialSnapshot.customPlayback?.currentTimeMicroseconds ?? 0;
    const laterTime = laterSnapshot.customPlayback?.currentTimeMicroseconds ?? 0;
    const initialFrames = initialSnapshot.presentation?.presentedFrameCount ?? 0;
    const laterFrames = laterSnapshot.presentation?.presentedFrameCount ?? 0;

    addFailure(failures, initialSnapshot.customPlayback?.state === 'paused', 'pause-not-entered');
    addFailure(failures, laterSnapshot.customPlayback?.state === 'paused', 'pause-not-held');
    addFailure(
        failures,
        Math.abs(laterTime - initialTime) <= maximumClockDeltaMicroseconds,
        'paused-clock-advanced'
    );
    addFailure(
        failures,
        laterFrames - initialFrames <= maximumPresentedFrameDelta,
        'paused-frames-advanced'
    );
    addFailure(failures, laterSnapshot.terminalErrorCount === 0, 'player-error-event');
    return failures;
}

/** Returns stable failure codes when resume does not restart clock and frame progress. */
export function validateResumeSnapshot(
    initialSnapshot,
    laterSnapshot,
    minimumClockAdvanceMicroseconds = 250_000
) {
    const failures = [];
    addFailure(failures, laterSnapshot.customPlayback?.state === 'playing', 'resume-not-playing');
    addFailure(
        failures,
        (laterSnapshot.customPlayback?.currentTimeMicroseconds ?? 0)
            - (initialSnapshot.customPlayback?.currentTimeMicroseconds ?? 0)
            >= minimumClockAdvanceMicroseconds,
        'resumed-clock-not-advancing'
    );
    addFailure(
        failures,
        (laterSnapshot.presentation?.presentedFrameCount ?? 0)
            > (initialSnapshot.presentation?.presentedFrameCount ?? 0),
        'resumed-frames-not-advancing'
    );
    addFailure(failures, laterSnapshot.terminalErrorCount === 0, 'player-error-event');
    return failures;
}

/** Returns stable failure codes when a seek does not land or preserve custom presentation. */
export function validateSeekSnapshot(snapshot, targetMicroseconds, toleranceMicroseconds = 2_000_000) {
    const failures = [];
    const currentTimeMicroseconds = snapshot.customPlayback?.currentTimeMicroseconds ?? 0;
    addFailure(
        failures,
        Math.abs(currentTimeMicroseconds - targetMicroseconds) <= toleranceMicroseconds,
        'seek-target-not-reached'
    );
    addFailure(
        failures,
        snapshot.customPlayback?.state === 'playing'
            || snapshot.customPlayback?.state === 'paused',
        'seek-terminal-state'
    );
    addFailure(failures, snapshot.customPlayback?.fallbackReason === null, 'custom-fallback');
    addFailure(failures, snapshot.presentation?.state === 'presenting', 'presenter-not-active');
    addFailure(failures, snapshot.presentation?.fallbackReason === null, 'presentation-fallback');
    addFailure(failures, snapshot.terminalErrorCount === 0, 'player-error-event');
    return failures;
}

/** Returns stable failure codes for a rapid seek burst and its final generation. */
export function validateSeekStormSnapshot(
    initialSnapshot,
    laterSnapshot,
    targetMicrosecondsList,
    toleranceMicroseconds = 2_000_000
) {
    const failures = [];
    const finalTargetMicroseconds = targetMicrosecondsList.at(-1);
    const initialGeneration = initialSnapshot.customPlayback?.activeGeneration;
    const laterGeneration = laterSnapshot.customPlayback?.activeGeneration;
    const decodeTelemetry = laterSnapshot.customPlayback?.videoDecode;

    addFailure(
        failures,
        targetMicrosecondsList.length > 0
            && Number.isSafeInteger(finalTargetMicroseconds),
        'seek-storm-targets-missing'
    );
    addFailure(
        failures,
        Number.isSafeInteger(initialGeneration)
            && Number.isSafeInteger(laterGeneration)
            && laterGeneration === initialGeneration + targetMicrosecondsList.length,
        'seek-storm-generation-mismatch'
    );
    addFailure(
        failures,
        laterSnapshot.sessionGeneration === initialSnapshot.sessionGeneration,
        'seek-storm-backend-session-restarted'
    );
    addFailure(
        failures,
        Number.isSafeInteger(finalTargetMicroseconds)
            && Math.abs(
                (laterSnapshot.customPlayback?.currentTimeMicroseconds ?? 0)
                    - finalTargetMicroseconds
            ) <= toleranceMicroseconds,
        'seek-storm-final-target-not-reached'
    );
    addFailure(failures, laterSnapshot.customPlayback?.state === 'playing', 'seek-storm-not-playing');
    addFailure(failures, laterSnapshot.customPlayback?.fallbackReason === null, 'custom-fallback');
    addFailure(failures, laterSnapshot.customPlayback?.hasLastError === false, 'custom-error-message');
    addFailure(failures, decodeTelemetry?.activeGeneration === laterGeneration, 'decode-generation-mismatch');
    addFailure(failures, decodeTelemetry?.failureKind === null, 'decode-failure');
    addFailure(failures, (decodeTelemetry?.receivedFrameCount ?? 0) > 0, 'no-decoded-frames');
    addFailure(
        failures,
        Number.isSafeInteger(decodeTelemetry?.staleFrameCount)
            && decodeTelemetry.staleFrameCount >= 0
            && Number.isSafeInteger(decodeTelemetry?.staleAudioSampleCount)
            && decodeTelemetry.staleAudioSampleCount >= 0,
        'stale-decode-accounting-invalid'
    );
    addFailure(
        failures,
        Number.isSafeInteger(initialSnapshot.customPlayback?.staleEventCount)
            && Number.isSafeInteger(laterSnapshot.customPlayback?.staleEventCount)
            && laterSnapshot.customPlayback.staleEventCount
                >= initialSnapshot.customPlayback.staleEventCount,
        'stale-controller-accounting-invalid'
    );
    const outputMode = laterSnapshot.customPlaybackEligibility?.videoOutputMode;
    const pendingFrameCount = decodeTelemetry?.pendingFrameCount;
    const queuedFrameCount = decodeTelemetry?.queuedFrameCount;
    const peakFrameCount = decodeTelemetry?.peakFrameCount;
    addFailure(
        failures,
        outputMode === 'raw-planes' ?
            Number.isSafeInteger(pendingFrameCount)
                && pendingFrameCount >= 0
                && Number.isSafeInteger(queuedFrameCount)
                && queuedFrameCount >= 0
                && pendingFrameCount + queuedFrameCount
                    <= MAXIMUM_RAW_OUTSTANDING_FRAMES
                && Number.isSafeInteger(peakFrameCount)
                && peakFrameCount >= 0
                && peakFrameCount <= MAXIMUM_RAW_OUTSTANDING_FRAMES :
            Number.isSafeInteger(pendingFrameCount)
                && pendingFrameCount >= 0
                && pendingFrameCount <= MAXIMUM_VIDEO_FRAME_PENDING_FRAMES,
        'seek-storm-frame-window-exceeded'
    );
    addFailure(failures, laterSnapshot.presentation?.state === 'presenting', 'presenter-not-active');
    addFailure(failures, laterSnapshot.presentation?.fallbackReason === null, 'presentation-fallback');
    addFailure(
        failures,
        (laterSnapshot.presentation?.presentedFrameCount ?? 0)
            > (initialSnapshot.presentation?.presentedFrameCount ?? 0),
        'presented-frame-count-not-advancing'
    );
    addFailure(failures, laterSnapshot.dom?.sourceLessVideoCount > 0, 'source-less-video-missing');
    addFailure(failures, laterSnapshot.dom?.sourcedVideoCount === 0, 'native-video-source-active');
    addFailure(failures, laterSnapshot.terminalErrorCount === 0, 'player-error-event');
    validateRawHDRAuthorizationSnapshot(failures, laterSnapshot);
    return failures;
}

function eventCount(snapshot, eventType) {
    const count = snapshot.eventCounts?.[eventType];
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function hasExactEventDelta(initialSnapshot, laterSnapshot, eventType, expectedDelta) {
    const initialCount = eventCount(initialSnapshot, eventType);
    const laterCount = eventCount(laterSnapshot, eventType);
    return initialCount !== null
        && laterCount !== null
        && laterCount - initialCount === expectedDelta;
}

/** Validates reliable pause, resume, and stop event cardinality and ordering. */
export function validateControlEventTransitions(
    beforePauseSnapshot,
    pausedSnapshot,
    resumedSnapshot,
    beforeStopSnapshot,
    stoppedSnapshot
) {
    const failures = [];
    addFailure(
        failures,
        hasExactEventDelta(beforePauseSnapshot, pausedSnapshot, 'pause', 1),
        'pause-event-cardinality'
    );
    addFailure(
        failures,
        hasExactEventDelta(pausedSnapshot, resumedSnapshot, 'unpause', 1),
        'unpause-event-cardinality'
    );
    addFailure(
        failures,
        hasExactEventDelta(pausedSnapshot, resumedSnapshot, 'playing', 1),
        'resume-playing-event-cardinality'
    );
    addFailure(
        failures,
        hasExactEventDelta(beforeStopSnapshot, stoppedSnapshot, 'stopped', 1),
        'stop-event-cardinality'
    );
    addFailure(
        failures,
        eventCount(stoppedSnapshot, 'error') === 0,
        'player-error-event'
    );

    const pausedSequenceLength = pausedSnapshot.eventSequence?.length;
    const resumedSequence = resumedSnapshot.eventSequence;
    const resumedEvents = Number.isSafeInteger(pausedSequenceLength)
        && Array.isArray(resumedSequence) ?
        resumedSequence.slice(pausedSequenceLength) :
        [];
    const unpauseIndex = resumedEvents.indexOf('unpause');
    const playingIndex = resumedEvents.indexOf('playing');
    addFailure(
        failures,
        unpauseIndex >= 0 && playingIndex > unpauseIndex,
        'resume-event-order'
    );
    return failures;
}

/** Validates decoder EOF through physical audio drain and Jellyfin stop semantics. */
export function validateNaturalEndSnapshots(
    activeSnapshot,
    endedSnapshot,
    stableEndedSnapshot,
    expectedAudioPath
) {
    const failures = [];
    addFailure(failures, endedSnapshot.customPlayback?.state === 'ended', 'state-not-ended');
    addFailure(
        failures,
        stableEndedSnapshot.customPlayback?.state === 'ended',
        'ended-state-not-stable'
    );
    addFailure(
        failures,
        hasExactEventDelta(activeSnapshot, endedSnapshot, 'stopped', 1),
        'natural-stop-event-cardinality'
    );
    addFailure(
        failures,
        eventCount(stableEndedSnapshot, 'stopped') === eventCount(endedSnapshot, 'stopped'),
        'natural-stop-event-repeated'
    );
    addFailure(
        failures,
        eventCount(endedSnapshot, 'waiting') === eventCount(activeSnapshot, 'waiting'),
        'terminal-waiting-event'
    );
    addFailure(
        failures,
        eventCount(endedSnapshot, 'ended') === eventCount(activeSnapshot, 'ended'),
        'noncontract-ended-event'
    );
    addFailure(failures, endedSnapshot.customPlayback?.fallbackReason === null, 'custom-fallback');
    addFailure(failures, endedSnapshot.presentation?.fallbackReason === null, 'presentation-fallback');
    addFailure(failures, endedSnapshot.terminalErrorCount === 0, 'player-error-event');
    addFailure(
        failures,
        endedSnapshot.customPlayback?.videoDecode?.queuedFrameCount === 0
            && endedSnapshot.customPlayback?.videoDecode?.pendingFrameCount === 0,
        'video-tail-not-drained'
    );
    addFailure(
        failures,
        Math.abs(
            (stableEndedSnapshot.customPlayback?.currentTimeMicroseconds ?? 0)
            - (endedSnapshot.customPlayback?.currentTimeMicroseconds ?? 0)
        ) <= NATURAL_END_CLOCK_TOLERANCE_MICROSECONDS,
        'ended-clock-not-frozen'
    );
    if (expectedAudioPath === 'ready') {
        const audioBridge = stableEndedSnapshot.customPlayback?.audioBridge;
        const audioOutput = stableEndedSnapshot.customPlayback?.audioOutput;
        const submittedEndMediaTimeMicroseconds =
            audioBridge?.submittedEndMediaTimeMicroseconds;
        addFailure(
            failures,
            audioBridge?.pendingFrameCount === 0
                && audioBridge.pendingSampleCount === 0,
            'audio-worklet-tail-not-drained'
        );
        addFailure(
            failures,
            audioOutput?.queuedFrames === 0,
            'audio-output-not-drained'
        );
        addFailure(
            failures,
            Number.isSafeInteger(submittedEndMediaTimeMicroseconds)
                && submittedEndMediaTimeMicroseconds >= 0
                && (stableEndedSnapshot.customPlayback?.currentTimeMicroseconds ?? -1)
                    >= submittedEndMediaTimeMicroseconds
                        - NATURAL_END_CLOCK_TOLERANCE_MICROSECONDS,
            'audio-physical-tail-not-reached'
        );
    } else if (expectedAudioPath === 'native-media') {
        addFailure(
            failures,
            stableEndedSnapshot.customPlayback?.audioBridge === null,
            'native-audio-bridge-active-at-end'
        );
        addFailure(
            failures,
            stableEndedSnapshot.customPlayback?.audioOutput === null,
            'native-audio-output-active-at-end'
        );
        addFailure(
            failures,
            (stableEndedSnapshot.customPlayback?.videoDecode
                ?.receivedNativeAudioSegmentCount ?? 0) > 0,
            'native-audio-segments-missing-at-end'
        );
    }
    return failures;
}

/** Validates canvas geometry after a CDP viewport and device-scale override. */
export function validateResizedPresentationSnapshot(
    initialSnapshot,
    laterSnapshot,
    expectedViewport
) {
    const failures = [];
    const dom = laterSnapshot.dom;
    const expectedBackingWidth = Math.round(
        (dom?.canvasCSSWidth ?? 0) * expectedViewport.devicePixelRatio
    );
    const expectedBackingHeight = Math.round(
        (dom?.canvasCSSHeight ?? 0) * expectedViewport.devicePixelRatio
    );
    addFailure(failures, dom?.viewportWidth === expectedViewport.width, 'viewport-width-mismatch');
    addFailure(failures, dom?.viewportHeight === expectedViewport.height, 'viewport-height-mismatch');
    addFailure(
        failures,
        Math.abs((dom?.devicePixelRatio ?? 0) - expectedViewport.devicePixelRatio) < 0.01,
        'device-pixel-ratio-mismatch'
    );
    addFailure(
        failures,
        Number.isFinite(dom?.canvasCSSWidth)
            && dom.canvasCSSWidth > 0
            && Number.isFinite(dom?.canvasCSSHeight)
            && dom.canvasCSSHeight > 0,
        'canvas-css-geometry-missing'
    );
    addFailure(
        failures,
        Math.abs((dom?.canvasBackingWidth ?? 0) - expectedBackingWidth) <= 1
            && Math.abs((dom?.canvasBackingHeight ?? 0) - expectedBackingHeight) <= 1,
        'canvas-backing-geometry-mismatch'
    );
    addFailure(
        failures,
        dom?.canvasBackingWidth !== initialSnapshot.dom?.canvasBackingWidth
            || dom?.canvasBackingHeight !== initialSnapshot.dom?.canvasBackingHeight,
        'canvas-backing-geometry-unchanged'
    );
    addFailure(
        failures,
        laterSnapshot.sessionGeneration === initialSnapshot.sessionGeneration
            && laterSnapshot.customPlayback?.activeGeneration
                === initialSnapshot.customPlayback?.activeGeneration,
        'resize-session-restarted'
    );
    addFailure(failures, laterSnapshot.customPlayback?.state === 'playing', 'resize-not-playing');
    addFailure(failures, laterSnapshot.customPlayback?.fallbackReason === null, 'custom-fallback');
    addFailure(failures, laterSnapshot.presentation?.state === 'presenting', 'presenter-not-active');
    addFailure(failures, laterSnapshot.presentation?.fallbackReason === null, 'presentation-fallback');
    addFailure(
        failures,
        (laterSnapshot.presentation?.presentedFrameCount ?? 0)
            > (initialSnapshot.presentation?.presentedFrameCount ?? 0),
        'presented-frame-count-not-advancing'
    );
    addFailure(failures, dom?.visibleCanvasCount > 0, 'webgpu-canvas-not-visible');
    addFailure(failures, laterSnapshot.terminalErrorCount === 0, 'player-error-event');
    validateRawHDRAuthorizationSnapshot(failures, laterSnapshot);
    return failures;
}

/** Validates one entered and exited native Fullscreen API transition. */
export function validateFullscreenTransitionSnapshots(
    initialSnapshot,
    fullscreenSnapshot,
    exitedSnapshot
) {
    const failures = [];
    addFailure(failures, fullscreenSnapshot.dom?.fullscreenActive === true, 'fullscreen-not-active');
    addFailure(
        failures,
        fullscreenSnapshot.dom?.fullscreenContainsCanvas === true,
        'fullscreen-canvas-not-contained'
    );
    addFailure(failures, exitedSnapshot.dom?.fullscreenActive === false, 'fullscreen-not-exited');
    addFailure(
        failures,
        hasExactEventDelta(initialSnapshot, fullscreenSnapshot, 'fullscreenchange', 1),
        'fullscreen-enter-event-cardinality'
    );
    addFailure(
        failures,
        hasExactEventDelta(fullscreenSnapshot, exitedSnapshot, 'fullscreenchange', 1),
        'fullscreen-exit-event-cardinality'
    );
    addFailure(
        failures,
        fullscreenSnapshot.sessionGeneration === initialSnapshot.sessionGeneration
            && exitedSnapshot.sessionGeneration === initialSnapshot.sessionGeneration
            && fullscreenSnapshot.customPlayback?.activeGeneration
                === initialSnapshot.customPlayback?.activeGeneration
            && exitedSnapshot.customPlayback?.activeGeneration
                === initialSnapshot.customPlayback?.activeGeneration,
        'fullscreen-session-restarted'
    );
    addFailure(failures, exitedSnapshot.customPlayback?.state === 'playing', 'fullscreen-exit-not-playing');
    addFailure(failures, exitedSnapshot.customPlayback?.fallbackReason === null, 'custom-fallback');
    addFailure(failures, exitedSnapshot.presentation?.state === 'presenting', 'presenter-not-active');
    addFailure(failures, exitedSnapshot.presentation?.fallbackReason === null, 'presentation-fallback');
    addFailure(
        failures,
        (fullscreenSnapshot.presentation?.presentedFrameCount ?? 0)
            > (initialSnapshot.presentation?.presentedFrameCount ?? 0)
            && (exitedSnapshot.presentation?.presentedFrameCount ?? 0)
                > (fullscreenSnapshot.presentation?.presentedFrameCount ?? 0),
        'fullscreen-frames-not-advancing'
    );
    addFailure(failures, exitedSnapshot.terminalErrorCount === 0, 'player-error-event');
    validateRawHDRAuthorizationSnapshot(failures, exitedSnapshot);
    return failures;
}

/** Returns stable failure codes for stop cleanup without requiring backend destruction. */
export function validateStopSnapshot(snapshot, expectedStoppedEventCount = 1) {
    const failures = [];
    addFailure(failures, snapshot.presentation?.state === 'idle', 'presenter-not-idle');
    addFailure(failures, snapshot.dom.canvasCount === 0, 'webgpu-canvas-retained');
    addFailure(failures, snapshot.hasCurrentSource === false, 'player-source-retained');
    addFailure(failures, snapshot.isFetching === false, 'player-still-fetching');
    addFailure(
        failures,
        snapshot.stoppedEventCount === expectedStoppedEventCount,
        'stopped-event-count'
    );
    addFailure(failures, snapshot.terminalErrorCount === 0, 'player-error-event');
    return failures;
}

/** Returns stable failure codes for a deliberately injected presenter fallback. */
export function validateInjectedPresentationFallbackSnapshot(
    initialSnapshot,
    laterSnapshot,
    minimumClockAdvanceMicroseconds = 250_000
) {
    const failures = [];
    const initialNativeTime = initialSnapshot.dom.nativeVideoTimeMicroseconds ?? 0;
    const laterNativeTime = laterSnapshot.dom.nativeVideoTimeMicroseconds ?? 0;
    addFailure(
        failures,
        laterSnapshot.presentation?.fallbackReason === 'frame-render-failed',
        'injected-fallback-reason-missing'
    );
    addFailure(failures, laterSnapshot.presentation?.state === 'idle', 'fallback-presenter-not-idle');
    addFailure(failures, laterSnapshot.dom.canvasCount === 0, 'fallback-canvas-retained');
    addFailure(failures, laterSnapshot.dom.visibleCanvasCount === 0, 'fallback-canvas-visible');
    addFailure(failures, laterSnapshot.dom.sourcedVideoCount > 0, 'native-fallback-source-missing');
    addFailure(failures, laterSnapshot.dom.nativeVideoPlaying === true, 'native-fallback-not-playing');
    addFailure(failures, laterSnapshot.hasCurrentSource === true, 'fallback-player-source-missing');
    addFailure(
        failures,
        Number.isSafeInteger(initialNativeTime)
            && Number.isSafeInteger(laterNativeTime)
            && laterNativeTime - initialNativeTime >= minimumClockAdvanceMicroseconds,
        'native-fallback-clock-not-advancing'
    );
    addFailure(failures, laterSnapshot.terminalErrorCount === 0, 'player-error-event');
    return failures;
}

/** Returns stable failure codes for one deliberately destroyed presentation device. */
export function validateInjectedDeviceRecoverySnapshot(
    initialSnapshot,
    laterSnapshot,
    injectionObservation,
    minimumClockAdvanceMicroseconds = 250_000
) {
    const failures = [];
    const initialRecoveryCount = initialSnapshot.presentation?.deviceRecoveryCount;
    const laterRecoveryCount = laterSnapshot.presentation?.deviceRecoveryCount;
    addFailure(failures, injectionObservation?.available === true, 'device-loss-injection-unavailable');
    addFailure(failures, injectionObservation?.destroyInvoked === true, 'device-destruction-not-invoked');
    addFailure(failures, injectionObservation?.replacementDevice === true, 'replacement-device-missing');
    addFailure(
        failures,
        Number.isSafeInteger(initialRecoveryCount)
            && Number.isSafeInteger(laterRecoveryCount)
            && laterRecoveryCount === initialRecoveryCount + 1
            && injectionObservation?.recoveryCountAfter === laterRecoveryCount,
        'device-recovery-count-mismatch'
    );
    addFailure(
        failures,
        laterSnapshot.sessionGeneration === initialSnapshot.sessionGeneration
            && laterSnapshot.customPlayback?.activeGeneration
                === initialSnapshot.customPlayback?.activeGeneration,
        'device-recovery-session-restarted'
    );
    addFailure(failures, laterSnapshot.customPlayback?.state === 'playing', 'device-recovery-not-playing');
    addFailure(failures, laterSnapshot.customPlayback?.fallbackReason === null, 'custom-fallback');
    addFailure(failures, laterSnapshot.customPlayback?.hasLastError === false, 'custom-error-message');
    addFailure(failures, laterSnapshot.customPlayback?.videoDecode?.failureKind === null, 'decode-failure');
    addFailure(failures, laterSnapshot.presentation?.state === 'presenting', 'presenter-not-active');
    addFailure(failures, laterSnapshot.presentation?.fallbackReason === null, 'presentation-fallback');
    addFailure(
        failures,
        (laterSnapshot.presentation?.presentedFrameCount ?? 0)
            > (initialSnapshot.presentation?.presentedFrameCount ?? 0),
        'presented-frame-count-not-advancing'
    );
    addFailure(
        failures,
        (laterSnapshot.customPlayback?.currentTimeMicroseconds ?? 0)
            - (initialSnapshot.customPlayback?.currentTimeMicroseconds ?? 0)
            >= minimumClockAdvanceMicroseconds,
        'device-recovery-clock-not-advancing'
    );
    for (const eventType of [ 'error', 'pause', 'playbackstart', 'stopped', 'unpause' ]) {
        addFailure(
            failures,
            hasExactEventDelta(initialSnapshot, laterSnapshot, eventType, 0),
            `device-recovery-${eventType}-event`
        );
    }
    addFailure(failures, laterSnapshot.dom?.sourceLessVideoCount > 0, 'source-less-video-missing');
    addFailure(failures, laterSnapshot.dom?.sourcedVideoCount === 0, 'native-video-source-active');
    addFailure(failures, laterSnapshot.dom?.visibleCanvasCount > 0, 'webgpu-canvas-not-visible');
    addFailure(failures, laterSnapshot.terminalErrorCount === 0, 'player-error-event');
    validateRawHDRAuthorizationSnapshot(failures, laterSnapshot);
    return failures;
}

/** Validates paused device recovery through one generation-safe frame re-decode. */
export function validatePausedDeviceRecoverySnapshots(
    activeSnapshot,
    pausedSnapshot,
    recoveredSnapshot,
    resumedSnapshot,
    injectionObservation,
    minimumResumeAdvanceMicroseconds = 250_000
) {
    const failures = [];
    const initialRecoveryCount = pausedSnapshot.presentation?.deviceRecoveryCount;
    const recoveredRecoveryCount = recoveredSnapshot.presentation?.deviceRecoveryCount;
    addFailure(failures, injectionObservation?.available === true, 'device-loss-injection-unavailable');
    addFailure(failures, injectionObservation?.destroyInvoked === true, 'device-destruction-not-invoked');
    addFailure(failures, injectionObservation?.replacementDevice === true, 'replacement-device-missing');
    addFailure(
        failures,
        Number.isSafeInteger(initialRecoveryCount)
            && Number.isSafeInteger(recoveredRecoveryCount)
            && recoveredRecoveryCount === initialRecoveryCount + 1
            && injectionObservation?.recoveryCountAfter === recoveredRecoveryCount,
        'device-recovery-count-mismatch'
    );
    addFailure(
        failures,
        pausedSnapshot.sessionGeneration === activeSnapshot.sessionGeneration
            && recoveredSnapshot.sessionGeneration === activeSnapshot.sessionGeneration
            && resumedSnapshot.sessionGeneration === activeSnapshot.sessionGeneration,
        'paused-recovery-backend-session-restarted'
    );
    addFailure(
        failures,
        Number.isSafeInteger(pausedSnapshot.customPlayback?.activeGeneration)
            && recoveredSnapshot.customPlayback?.activeGeneration
                === pausedSnapshot.customPlayback.activeGeneration + 1
            && resumedSnapshot.customPlayback?.activeGeneration
                === recoveredSnapshot.customPlayback.activeGeneration,
        'paused-recovery-decode-generation-mismatch'
    );
    addFailure(failures, pausedSnapshot.customPlayback?.state === 'paused', 'pause-not-observed');
    addFailure(
        failures,
        recoveredSnapshot.customPlayback?.state === 'paused',
        'device-recovery-not-paused'
    );
    addFailure(
        failures,
        Math.abs(
            (recoveredSnapshot.customPlayback?.currentTimeMicroseconds ?? 0)
            - (pausedSnapshot.customPlayback?.currentTimeMicroseconds ?? 0)
        ) <= NATURAL_END_CLOCK_TOLERANCE_MICROSECONDS,
        'paused-recovery-clock-moved'
    );
    addFailure(failures, resumedSnapshot.customPlayback?.state === 'playing', 'recovery-resume-failed');
    addFailure(
        failures,
        (resumedSnapshot.customPlayback?.currentTimeMicroseconds ?? 0)
            - (recoveredSnapshot.customPlayback?.currentTimeMicroseconds ?? 0)
            >= minimumResumeAdvanceMicroseconds,
        'recovery-resume-clock-not-advancing'
    );
    addFailure(
        failures,
        (recoveredSnapshot.presentation?.presentedFrameCount ?? 0)
            > (pausedSnapshot.presentation?.presentedFrameCount ?? 0),
        'paused-frame-not-repainted'
    );
    addFailure(
        failures,
        (resumedSnapshot.presentation?.presentedFrameCount ?? 0)
            > (recoveredSnapshot.presentation?.presentedFrameCount ?? 0),
        'recovery-resume-frames-not-advancing'
    );
    for (const snapshot of [ recoveredSnapshot, resumedSnapshot ]) {
        addFailure(failures, snapshot.customPlayback?.fallbackReason === null, 'custom-fallback');
        addFailure(failures, snapshot.presentation?.state === 'presenting', 'presenter-not-active');
        addFailure(failures, snapshot.presentation?.fallbackReason === null, 'presentation-fallback');
        addFailure(failures, snapshot.dom?.visibleCanvasCount > 0, 'webgpu-canvas-not-visible');
        addFailure(failures, snapshot.terminalErrorCount === 0, 'player-error-event');
        validateRawHDRAuthorizationSnapshot(failures, snapshot);
    }
    addFailure(
        failures,
        hasExactEventDelta(activeSnapshot, pausedSnapshot, 'pause', 1),
        'pause-event-cardinality'
    );
    for (const eventType of [ 'error', 'pause', 'playing', 'stopped', 'unpause', 'waiting' ]) {
        addFailure(
            failures,
            hasExactEventDelta(pausedSnapshot, recoveredSnapshot, eventType, 0),
            `paused-recovery-${eventType}-event`
        );
    }
    addFailure(
        failures,
        hasExactEventDelta(recoveredSnapshot, resumedSnapshot, 'unpause', 1),
        'recovery-unpause-event-cardinality'
    );
    addFailure(
        failures,
        hasExactEventDelta(recoveredSnapshot, resumedSnapshot, 'playing', 1),
        'recovery-playing-event-cardinality'
    );
    return failures;
}

function sanitizeText(value, secrets) {
    let sanitizedValue = value;
    for (const secret of secrets) {
        if (typeof secret === 'string' && secret.length > 0) {
            sanitizedValue = sanitizedValue.split(secret).join('[redacted]');
        }
    }
    return sanitizedValue
        .replace(QUERY_SECRET_PATTERN, '$1[redacted]')
        .replace(SENSITIVE_ASSIGNMENT_PATTERN, '[redacted]')
        .replace(URL_PATTERN, '[url]');
}

function isSensitiveKey(key) {
    return /(?:authorization|cookie|credential|password|secret|token|username)/iu.test(key);
}

function isURLKey(key) {
    return /(?:^|_)(?:debug|frontend|server)?url$/iu.test(key);
}

/** Recursively strips URLs and authentication material from a JSON report. */
export function sanitizeReport(value, secrets = []) {
    if (typeof value === 'string') {
        return sanitizeText(value, secrets);
    }
    if (Array.isArray(value)) {
        return value.map(item => sanitizeReport(item, secrets));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }

    const sanitizedValue = {};
    for (const [key, childValue] of Object.entries(value)) {
        switch (true) {
            case isSensitiveKey(key):
                sanitizedValue[key] = '[redacted]';
                break;
            case isURLKey(key):
                sanitizedValue[key] = '[redacted-url]';
                break;
            default:
                sanitizedValue[key] = sanitizeReport(childValue, secrets);
                break;
        }
    }
    return sanitizedValue;
}

/* eslint-enable compat/compat */
