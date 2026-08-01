/* eslint-disable compat/compat -- This local harness targets Node 24 and a current Chromium browser */

const DEFAULT_DEBUG_URL = 'http://localhost:9224';
const DEFAULT_FRONTEND_URL = 'http://localhost:8080';
const DEFAULT_SERVER_URL = 'http://localhost:8096';
const DEFAULT_TIMEOUT_MILLISECONDS = 30_000;

const OPTION_DEFINITIONS = Object.freeze({
    '--debug-url': {
        environmentName: 'WEBGPU_SMOKE_DEBUG_URL',
        name: 'debugURL'
    },
    '--frontend-url': {
        environmentName: 'WEBGPU_SMOKE_FRONTEND_URL',
        name: 'frontendURL'
    },
    '--item-id': {
        environmentName: 'WEBGPU_SMOKE_ITEM_ID',
        name: 'itemID'
    },
    '--password': {
        environmentName: 'WEBGPU_SMOKE_PASSWORD',
        name: 'password'
    },
    '--server-url': {
        environmentName: 'WEBGPU_SMOKE_SERVER_URL',
        name: 'serverURL'
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
const SENSITIVE_ASSIGNMENT_PATTERN = /\b(?:access[_ -]?token|api[_ -]?key|authorization|cookie|password|username)\s*[:=]\s*[^\s,;]+/giu;
const QUERY_SECRET_PATTERN = /([?&](?:api_key|token|access_token)=)[^&#\s]+/giu;

export const SMOKE_USAGE = `Usage:
  node scripts/webgpu/run-browser-playback-smoke.mjs [options]

Options:
  --debug-url <url>      Chromium remote-debugging HTTP endpoint
  --frontend-url <url>   Built Jellyfin Web frontend URL
  --server-url <url>     Jellyfin server URL entered in the UI
  --item-id <id>         Video item ID to play
  --username <name>      Jellyfin username
  --password <password>  Jellyfin password
  --timeout-ms <number>  Per-phase timeout in milliseconds
  --help                  Show this text

Environment equivalents:
  WEBGPU_SMOKE_DEBUG_URL, WEBGPU_SMOKE_FRONTEND_URL,
  WEBGPU_SMOKE_SERVER_URL, WEBGPU_SMOKE_ITEM_ID,
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
    return {
        debugURL: parseHTTPURL(
            configuredValue('debugURL') || DEFAULT_DEBUG_URL,
            '--debug-url'
        ),
        frontendURL: parseHTTPURL(
            configuredValue('frontendURL') || DEFAULT_FRONTEND_URL,
            '--frontend-url'
        ),
        itemID: requireNonEmptyString(configuredValue('itemID'), '--item-id'),
        password: requireNonEmptyString(configuredValue('password'), '--password'),
        serverURL: parseHTTPURL(
            configuredValue('serverURL') || DEFAULT_SERVER_URL,
            '--server-url'
        ),
        timeoutMilliseconds: timeoutValue ?
            parseTimeoutMilliseconds(timeoutValue) :
            DEFAULT_TIMEOUT_MILLISECONDS,
        username: requireNonEmptyString(configuredValue('username'), '--username')
    };
}

/** Builds a same-frontend hash route without carrying an existing fragment. */
export function createFrontendRouteURL(frontendURL, route) {
    const routeURL = new URL(frontendURL);
    routeURL.hash = route.startsWith('/') ? route : `/${route}`;
    return routeURL.toString();
}

function addFailure(failures, condition, code) {
    if (!condition) {
        failures.push(code);
    }
}

/** Returns stable failure codes for an active custom-decoded playback sample pair. */
export function validateActivePlaybackSnapshot(initialSnapshot, laterSnapshot) {
    const failures = [];
    const customTelemetry = laterSnapshot.customPlayback;
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
    addFailure(failures, decodeTelemetry?.failureKind === null, 'decode-failure');
    addFailure(failures, (decodeTelemetry?.receivedFrameCount ?? 0) > 0, 'no-decoded-frames');
    addFailure(failures, presentationTelemetry?.state === 'presenting', 'presenter-not-active');
    addFailure(failures, presentationTelemetry?.fallbackReason === null, 'presentation-fallback');
    addFailure(failures, presentationTelemetry?.presentationSource === 'decoded', 'native-frame-source');
    addFailure(failures, (presentationTelemetry?.decodedFrameCount ?? 0) > 0, 'no-decoded-presentation');
    addFailure(failures, (presentationTelemetry?.presentedFrameCount ?? 0) > 0, 'no-presented-frames');
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
    addFailure(failures, laterSnapshot.dom.sourceLessVideoCount > 0, 'source-less-video-missing');
    addFailure(failures, laterSnapshot.dom.sourcedVideoCount === 0, 'native-video-source-active');
    addFailure(failures, laterSnapshot.dom.visibleCanvasCount > 0, 'webgpu-canvas-not-visible');
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

/** Returns stable failure codes for stop cleanup without requiring backend destruction. */
export function validateStopSnapshot(snapshot) {
    const failures = [];
    addFailure(failures, snapshot.presentation?.state === 'idle', 'presenter-not-idle');
    addFailure(failures, snapshot.dom.canvasCount === 0, 'webgpu-canvas-retained');
    addFailure(failures, snapshot.hasCurrentSource === false, 'player-source-retained');
    addFailure(failures, snapshot.isFetching === false, 'player-still-fetching');
    addFailure(failures, snapshot.stoppedEventCount === 1, 'stopped-event-count');
    addFailure(failures, snapshot.terminalErrorCount === 0, 'player-error-event');
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
