const MICROSECONDS_PER_MILLISECOND = 1_000;
const MINIMUM_PACING_DURATION_MILLISECONDS = 1_000;
const MAXIMUM_PACING_DURATION_MILLISECONDS = 12_000;
const MINIMUM_VIEWPORT_DIMENSION = 240;
const MAXIMUM_VIEWPORT_DIMENSION = 7_680;

export const REFERENCE_CAPTURE_USAGE = `Usage:
  node scripts/webgpu/run-browser-reference-capture.mjs [options]

Options:
  --plan <path>               Normalized A/B capture plan JSON
  --output-directory <path>   Artifact destination
  --debug-url <url>           Chromium remote-debugging endpoint
  --frontend-url <url>        Jellyfin Web frontend URL
  --server-url <url>          Jellyfin server URL entered in the UI
  --username <name>           Jellyfin username
  --password <password>       Jellyfin password
  --timeout-ms <number>       Per-phase timeout; defaults to 90000
  --help                      Show this text

Environment equivalents:
  WEBGPU_AB_DEBUG_URL, WEBGPU_AB_FRONTEND_URL, WEBGPU_AB_SERVER_URL,
  WEBGPU_AB_USERNAME, WEBGPU_AB_PASSWORD, WEBGPU_AB_TIMEOUT_MS`;

function requireObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function requireNonEmptyString(value, label) {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new TypeError(`${label} must be a non-empty string`);
    }
    return value;
}

function requireSafeInteger(value, label, minimum, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}`);
    }
    return value;
}

function parsePositiveInteger(value, label) {
    const parsedValue = Number.parseInt(value, 10);
    if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
        throw new RangeError(`${label} must be a positive integer`);
    }
    return parsedValue;
}

/** Biases an exact frame PTS forward so at-or-before selection returns that frame. */
export function createFrameBoundarySeekMilliseconds(targetMicroseconds) {
    const normalizedTarget = requireSafeInteger(
        targetMicroseconds,
        'Frame boundary seek target',
        0
    );
    return Math.floor(normalizedTarget / MICROSECONDS_PER_MILLISECOND) + 1;
}

function readNamedArguments(commandArguments) {
    const values = new Map();
    for (let argumentIndex = 0; argumentIndex < commandArguments.length; argumentIndex += 1) {
        const argument = commandArguments[argumentIndex];
        if (argument === '--help') {
            values.set('help', true);
            continue;
        }
        if (!argument.startsWith('--')) {
            throw new TypeError(`Unexpected positional argument: ${argument}`);
        }
        const value = commandArguments[argumentIndex + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new TypeError(`Missing value for ${argument}`);
        }
        values.set(argument.slice(2), value);
        argumentIndex += 1;
    }
    return values;
}

/** Parses secret-bearing browser arguments without writing them into the plan. */
export function parseReferenceCaptureConfiguration(commandArguments, environment) {
    const values = readNamedArguments(commandArguments);
    if (values.get('help') === true) {
        return { help: true };
    }

    const timeoutValue = values.get('timeout-ms')
        ?? environment.WEBGPU_AB_TIMEOUT_MS
        ?? '90000';
    return {
        debugURL: requireNonEmptyString(
            values.get('debug-url') ?? environment.WEBGPU_AB_DEBUG_URL,
            'Debug URL'
        ),
        frontendURL: requireNonEmptyString(
            values.get('frontend-url') ?? environment.WEBGPU_AB_FRONTEND_URL,
            'Frontend URL'
        ),
        help: false,
        outputDirectory: requireNonEmptyString(
            values.get('output-directory'),
            'Output directory'
        ),
        password: requireNonEmptyString(
            values.get('password') ?? environment.WEBGPU_AB_PASSWORD,
            'Password'
        ),
        planPath: requireNonEmptyString(values.get('plan'), 'Plan path'),
        serverURL: requireNonEmptyString(
            values.get('server-url') ?? environment.WEBGPU_AB_SERVER_URL,
            'Server URL'
        ),
        timeoutMilliseconds: parsePositiveInteger(timeoutValue, 'Timeout'),
        username: requireNonEmptyString(
            values.get('username') ?? environment.WEBGPU_AB_USERNAME,
            'Username'
        )
    };
}

/** Validates the browser-owned portion of a normalized A/B capture plan. */
export function validateReferenceCapturePlan(value) {
    const plan = requireObject(value, 'Capture plan');
    if (plan.schemaVersion !== 1) {
        throw new RangeError('Capture plan schemaVersion must be 1');
    }
    const jellyfin = requireObject(plan.jellyfin, 'Capture plan jellyfin');
    const pacing = requireObject(plan.pacing, 'Capture plan pacing');
    const visual = requireObject(plan.visual, 'Capture plan visual');
    const expected = requireObject(jellyfin.expected, 'Capture plan jellyfin.expected');
    const timestamps = visual.timestampsMicroseconds;
    if (!Array.isArray(timestamps) || timestamps.length === 0 || timestamps.length > 32) {
        throw new RangeError('Visual timestamps must contain from 1 through 32 entries');
    }
    const normalizedTimestamps = timestamps.map((timestamp, timestampIndex) => (
        requireSafeInteger(timestamp, `Visual timestamp ${timestampIndex}`, 0)
    ));
    if (new Set(normalizedTimestamps).size !== normalizedTimestamps.length) {
        throw new RangeError('Visual timestamps must be unique');
    }

    const expectedAudioPath = requireNonEmptyString(expected.audioPath, 'Expected audio path');
    if (!new Set([ 'disabled', 'native-media', 'ready' ]).has(expectedAudioPath)) {
        throw new RangeError('Expected audio path is unsupported');
    }
    const expectedVideoDecoder = requireNonEmptyString(
        expected.videoDecoder,
        'Expected video decoder'
    );
    if (!new Set([ 'bundled-hevc', 'native' ]).has(expectedVideoDecoder)) {
        throw new RangeError('Expected video decoder is unsupported');
    }
    const expectedVideoOutput = requireNonEmptyString(
        expected.videoOutput,
        'Expected video output'
    );
    if (!new Set([ 'raw-planes', 'video-frame' ]).has(expectedVideoOutput)) {
        throw new RangeError('Expected video output is unsupported');
    }

    return {
        caseID: requireNonEmptyString(plan.caseId, 'Capture plan caseId'),
        jellyfin: {
            audioStreamIndex: requireSafeInteger(
                jellyfin.audioStreamIndex,
                'Jellyfin audio stream index',
                0
            ),
            expected: {
                audioCodec: requireNonEmptyString(
                    expected.audioCodec,
                    'Expected audio codec'
                ).toLowerCase(),
                audioPath: expectedAudioPath,
                videoDecoder: expectedVideoDecoder,
                videoOutput: expectedVideoOutput
            },
            itemID: requireNonEmptyString(jellyfin.itemId, 'Jellyfin item ID')
        },
        pacing: {
            durationMilliseconds: requireSafeInteger(
                pacing.durationMilliseconds,
                'Pacing duration',
                MINIMUM_PACING_DURATION_MILLISECONDS,
                MAXIMUM_PACING_DURATION_MILLISECONDS
            ),
            startTimeMicroseconds: requireSafeInteger(
                pacing.startTimeMicroseconds,
                'Pacing start time',
                0
            )
        },
        schemaVersion: 1,
        visual: {
            captureToleranceMicroseconds: requireSafeInteger(
                visual.captureToleranceMicroseconds,
                'Visual capture tolerance',
                MICROSECONDS_PER_MILLISECOND,
                2_000_000
            ),
            height: requireSafeInteger(
                visual.height,
                'Visual height',
                MINIMUM_VIEWPORT_DIMENSION,
                MAXIMUM_VIEWPORT_DIMENSION
            ),
            timestampsMicroseconds: normalizedTimestamps,
            width: requireSafeInteger(
                visual.width,
                'Visual width',
                MINIMUM_VIEWPORT_DIMENSION,
                MAXIMUM_VIEWPORT_DIMENSION
            )
        }
    };
}

/** Reports whether playback has reached the requested decoded-audio route. */
export function isExpectedAudioStreamReady(snapshot, plan) {
    const customPlayback = snapshot?.customPlayback;
    const expected = plan?.jellyfin?.expected;
    return customPlayback?.state === 'playing'
        && customPlayback.jellyfinAudioStreamIndex
            === plan?.jellyfin?.audioStreamIndex
        && customPlayback.audioPath === expected?.audioPath
        && customPlayback.videoDecode?.audioCodec === expected?.audioCodec
        && snapshot?.presentation?.state === 'presenting';
}

function percentile(sortedValues, fraction) {
    if (sortedValues.length === 0) {
        return null;
    }
    const rank = Math.max(0, Math.ceil(sortedValues.length * fraction) - 1);
    return sortedValues[rank];
}

/** Summarizes observed presentation changes without assuming the source frame rate. */
export function summarizePacingSamples(samples) {
    if (!Array.isArray(samples) || samples.length < 2) {
        return {
            changedFrameCount: 0,
            mediaIntervalMicroseconds: null,
            wallIntervalMilliseconds: null
        };
    }
    const changedSamples = [];
    for (const sample of samples) {
        if (!sample || typeof sample !== 'object') {
            continue;
        }
        const previousSample = changedSamples.at(-1);
        if (!previousSample || sample.presentedFrameCount !== previousSample.presentedFrameCount) {
            changedSamples.push(sample);
        }
    }
    const wallIntervals = [];
    const mediaIntervals = [];
    for (let sampleIndex = 1; sampleIndex < changedSamples.length; sampleIndex += 1) {
        const previousSample = changedSamples[sampleIndex - 1];
        const sample = changedSamples[sampleIndex];
        const wallInterval = sample.wallTimeMilliseconds - previousSample.wallTimeMilliseconds;
        const mediaInterval = sample.presentedMediaTimeMicroseconds
            - previousSample.presentedMediaTimeMicroseconds;
        if (Number.isFinite(wallInterval) && wallInterval >= 0) {
            wallIntervals.push(wallInterval);
        }
        if (Number.isSafeInteger(mediaInterval) && mediaInterval > 0) {
            mediaIntervals.push(mediaInterval);
        }
    }
    wallIntervals.sort((first, second) => first - second);
    mediaIntervals.sort((first, second) => first - second);
    return {
        changedFrameCount: Math.max(0, changedSamples.length - 1),
        mediaIntervalMicroseconds: mediaIntervals.length > 0 ? {
            maximum: mediaIntervals.at(-1),
            median: percentile(mediaIntervals, 0.5),
            p95: percentile(mediaIntervals, 0.95)
        } : null,
        wallIntervalMilliseconds: wallIntervals.length > 0 ? {
            maximum: wallIntervals.at(-1),
            median: percentile(wallIntervals, 0.5),
            p95: percentile(wallIntervals, 0.95)
        } : null
    };
}

/** Converts cumulative post-gain worklet statistics into interpretable values. */
export function summarizeAudioSignal(signal) {
    if (!signal || typeof signal !== 'object'
        || !Number.isSafeInteger(signal.analyzedSampleCount)
        || signal.analyzedSampleCount <= 0
        || !Number.isFinite(signal.sampleSquareSum)
        || signal.sampleSquareSum < 0
        || !Number.isFinite(signal.samplePeak)
        || signal.samplePeak < 0) {
        return null;
    }
    const rootMeanSquare = Math.sqrt(
        signal.sampleSquareSum / signal.analyzedSampleCount
    );
    const peakDecibelsFullScale = signal.samplePeak > 0 ?
        20 * Math.log10(signal.samplePeak) :
        null;
    const rootMeanSquareDecibelsFullScale = rootMeanSquare > 0 ?
        20 * Math.log10(rootMeanSquare) :
        null;
    return {
        ...signal,
        crestFactorDecibels: signal.samplePeak > 0 && rootMeanSquare > 0 ?
            20 * Math.log10(signal.samplePeak / rootMeanSquare) :
            null,
        peakDecibelsFullScale,
        rootMeanSquare,
        rootMeanSquareDecibelsFullScale
    };
}
