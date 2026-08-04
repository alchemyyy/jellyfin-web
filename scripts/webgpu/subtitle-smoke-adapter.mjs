/* eslint-disable compat/compat -- This local harness targets Node 24 and a current Chromium browser */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;
const CODEC_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MICROSECONDS_PER_SECOND = 1_000_000;
const MAXIMUM_SUBTITLE_STREAM_INDEX = 10_000;
const MAXIMUM_SUBTITLE_WORKER_COUNT = 2;
const SUBTITLE_SCHEMA_NAME = 'subtitle-live-spec-schema.json';
const REQUIRED_OFFSETS_MICROSECONDS = Object.freeze([ -1_500_000, 0, 1_500_000 ]);
const SUBTITLE_WORKER_PATTERNS = Object.freeze({
    libass: /(?:subtitles-octopus|libass)(?:[^/\\]*)\.(?:m?js|wasm)(?:[?#]|$)/iu,
    libpgs: /(?:^|[/\\])libpgs(?:[^/\\]*)\.(?:m?js|wasm)(?:[?#]|$)/iu
});
const SOURCE_KEYS = new Set([
    'id',
    'title',
    'itemEnvironment',
    'mediaEnvironment',
    'licenseEnvironment',
    'licenseExpression',
    'media',
    'provenance',
    'expectedPlayMethod',
    'playerModes',
    'exerciseIds',
    'tracks',
    'failureModes'
]);
const TRACK_KEYS = new Set([
    'streamIndex',
    'role',
    'routeId',
    'sourceFormat',
    'sourceKind',
    'expectedDeliveryMethod',
    'expectedDeliveredFormat',
    'assetEnvironment',
    'assetMedia',
    'assetProvenance',
    'cueAssertions',
    'offsetsMicroseconds'
]);
const CUE_KEYS = new Set([
    'id',
    'startMicroseconds',
    'endMicroseconds',
    'beforeProbeMicroseconds',
    'activeProbeMicroseconds',
    'afterProbeMicroseconds',
    'normalizedTextSHA256',
    'imageSHA256',
    'expectedBounds',
    'styleAssertions'
]);
const BOUNDS_KEYS = new Set([ 'x', 'y', 'width', 'height', 'tolerance' ]);
const EXPECTED_PLAY_METHODS = new Set([ 'DirectPlay', 'DirectStream', 'Transcode' ]);
const EXPECTED_DELIVERY_METHODS = new Set([ 'External', 'Encode', 'Drop' ]);
const SOURCE_KINDS = new Set([ 'embedded', 'external' ]);
const TRACK_ROLES = new Set([ 'primary', 'secondary' ]);
const STYLE_ASSERTIONS = new Set([
    'alignment',
    'animation',
    'attached-font',
    'background',
    'color',
    'italic',
    'multiline',
    'outline',
    'position',
    'safe-area'
]);
const FAILURE_MODES = new Set([
    'malformed-subtitle',
    'renderer-initialization',
    'subtitle-fetch',
    'subtitle-worker',
    'unsupported-format',
    'webgpu-presentation'
]);

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requirePlainObject(value, label) {
    if (!isPlainObject(value)) {
        throw new TypeError(`${label} must be an object`);
    }
    return value;
}

function requireExactKeys(value, keys, label) {
    for (const key of Object.keys(value)) {
        if (!keys.has(key)) {
            throw new TypeError(`${label} contains unsupported property ${key}`);
        }
    }
}

function requireString(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a nonempty string`);
    }
    return value;
}

function requirePattern(value, pattern, label) {
    const stringValue = requireString(value, label);
    if (!pattern.test(stringValue)) {
        throw new TypeError(`${label} has an invalid value`);
    }
    return stringValue;
}

function requireSafeInteger(value, label, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(`${label} must be an integer from ${minimum} through ${maximum}`);
    }
    return value;
}

function requireFiniteNumber(value, label, minimum, maximum, exclusiveMinimum = false) {
    const belowMinimum = exclusiveMinimum ? value <= minimum : value < minimum;
    if (typeof value !== 'number'
        || !Number.isFinite(value)
        || belowMinimum
        || value > maximum) {
        throw new RangeError(`${label} is outside its supported range`);
    }
    return value;
}

function requireArray(value, label, minimumLength = 0) {
    if (!Array.isArray(value) || value.length < minimumLength) {
        throw new TypeError(`${label} must contain at least ${minimumLength} entries`);
    }
    return value;
}

function requireEnvironmentValue(environment, environmentName, label) {
    const environmentValue = environment[environmentName];
    if (typeof environmentValue !== 'string' || environmentValue.length === 0) {
        throw new TypeError(`${label} requires environment input ${environmentName}`);
    }
    return environmentValue;
}

function normalizeSubtitleCodec(codec) {
    const normalizedCodec = String(codec ?? '').trim().toLowerCase();
    switch (normalizedCodec) {
        case 'webvtt':
            return 'vtt';
        case 'sup':
        case 'pgs':
            return 'pgssub';
        case 'subrip':
            return 'srt';
        default:
            return normalizedCodec;
    }
}

function getExpectedRenderer(deliveredFormat) {
    switch (normalizeSubtitleCodec(deliveredFormat)) {
        case 'ass':
        case 'ssa':
            return 'libass-canvas';
        case 'pgssub':
            return 'libpgs-canvas';
        case 'vtt':
            return 'forced-dom-text';
        case '':
            return 'none';
        default:
            return 'unsupported';
    }
}

function validateNormalizedBounds(value, label) {
    const bounds = requirePlainObject(value, label);
    requireExactKeys(bounds, BOUNDS_KEYS, label);
    return {
        height: requireFiniteNumber(bounds.height, `${label}.height`, 0, 1, true),
        tolerance: requireFiniteNumber(bounds.tolerance, `${label}.tolerance`, 0, 0.25),
        width: requireFiniteNumber(bounds.width, `${label}.width`, 0, 1, true),
        x: requireFiniteNumber(bounds.x, `${label}.x`, 0, 1),
        y: requireFiniteNumber(bounds.y, `${label}.y`, 0, 1)
    };
}

function validateCue(value, label) {
    const cue = requirePlainObject(value, label);
    requireExactKeys(cue, CUE_KEYS, label);
    const startMicroseconds = requireSafeInteger(
        cue.startMicroseconds,
        `${label}.startMicroseconds`
    );
    const endMicroseconds = requireSafeInteger(
        cue.endMicroseconds,
        `${label}.endMicroseconds`,
        1
    );
    const beforeProbeMicroseconds = requireSafeInteger(
        cue.beforeProbeMicroseconds,
        `${label}.beforeProbeMicroseconds`
    );
    const activeProbeMicroseconds = requireSafeInteger(
        cue.activeProbeMicroseconds,
        `${label}.activeProbeMicroseconds`
    );
    const afterProbeMicroseconds = requireSafeInteger(
        cue.afterProbeMicroseconds,
        `${label}.afterProbeMicroseconds`
    );
    if (beforeProbeMicroseconds >= startMicroseconds
        || activeProbeMicroseconds < startMicroseconds
        || activeProbeMicroseconds >= endMicroseconds
        || afterProbeMicroseconds < endMicroseconds) {
        throw new RangeError(`${label} probe times do not bracket the cue`);
    }
    const normalizedTextSHA256 = cue.normalizedTextSHA256 === undefined ?
        null :
        requirePattern(
            cue.normalizedTextSHA256,
            SHA256_PATTERN,
            `${label}.normalizedTextSHA256`
        );
    const imageSHA256 = cue.imageSHA256 === undefined ?
        null :
        requirePattern(cue.imageSHA256, SHA256_PATTERN, `${label}.imageSHA256`);
    if (normalizedTextSHA256 === null && imageSHA256 === null) {
        throw new TypeError(`${label} requires a normalized text or image hash`);
    }
    const styleAssertions = cue.styleAssertions === undefined ? [] :
        requireArray(cue.styleAssertions, `${label}.styleAssertions`);
    for (const [ assertionIndex, assertion ] of styleAssertions.entries()) {
        const assertionName = requirePattern(
            assertion,
            IDENTIFIER_PATTERN,
            `${label}.styleAssertions[${assertionIndex}]`
        );
        if (!STYLE_ASSERTIONS.has(assertionName)) {
            throw new TypeError(`${label}.styleAssertions contains an unsupported value`);
        }
    }
    return {
        activeProbeMicroseconds,
        afterProbeMicroseconds,
        beforeProbeMicroseconds,
        endMicroseconds,
        expectedBounds: validateNormalizedBounds(cue.expectedBounds, `${label}.expectedBounds`),
        id: requirePattern(cue.id, IDENTIFIER_PATTERN, `${label}.id`),
        imageSHA256,
        normalizedTextSHA256,
        startMicroseconds,
        styleAssertions: [ ...new Set(styleAssertions) ]
    };
}

function validateTrack(value, label) {
    const track = requirePlainObject(value, label);
    requireExactKeys(track, TRACK_KEYS, label);
    const role = requireString(track.role, `${label}.role`);
    if (!TRACK_ROLES.has(role)) {
        throw new TypeError(`${label}.role is unsupported`);
    }
    const sourceKind = requireString(track.sourceKind, `${label}.sourceKind`);
    if (!SOURCE_KINDS.has(sourceKind)) {
        throw new TypeError(`${label}.sourceKind is unsupported`);
    }
    const expectedDeliveryMethod = requireString(
        track.expectedDeliveryMethod,
        `${label}.expectedDeliveryMethod`
    );
    if (!EXPECTED_DELIVERY_METHODS.has(expectedDeliveryMethod)) {
        throw new TypeError(`${label}.expectedDeliveryMethod is unsupported`);
    }
    const expectedDeliveredFormat = track.expectedDeliveredFormat === null ?
        null :
        requirePattern(
            track.expectedDeliveredFormat,
            CODEC_PATTERN,
            `${label}.expectedDeliveredFormat`
        ).toLowerCase();
    const expectedRenderer = getExpectedRenderer(expectedDeliveredFormat);
    if (expectedDeliveryMethod === 'External' && expectedRenderer === 'unsupported') {
        throw new TypeError(`${label} declares an unsupported external delivered format`);
    }
    if (expectedDeliveryMethod !== 'External' && expectedDeliveredFormat !== null) {
        throw new TypeError(`${label} fallback delivery must not claim a delivered format`);
    }
    const offsetsMicroseconds = requireArray(
        track.offsetsMicroseconds,
        `${label}.offsetsMicroseconds`
    );
    if (offsetsMicroseconds.length !== REQUIRED_OFFSETS_MICROSECONDS.length
        || offsetsMicroseconds.some((offset, offsetIndex) => (
            offset !== REQUIRED_OFFSETS_MICROSECONDS[offsetIndex]
        ))) {
        throw new TypeError(`${label}.offsetsMicroseconds does not match the fixed exercise`);
    }
    const cueAssertions = requireArray(track.cueAssertions, `${label}.cueAssertions`, 3)
        .map((cue, cueIndex) => validateCue(cue, `${label}.cueAssertions[${cueIndex}]`));
    const cueIdentifiers = new Set(cueAssertions.map(cue => cue.id));
    if (cueIdentifiers.size !== cueAssertions.length) {
        throw new TypeError(`${label} contains duplicate cue identifiers`);
    }
    const assetEnvironment = track.assetEnvironment === undefined ?
        null :
        requirePattern(
            track.assetEnvironment,
            ENVIRONMENT_NAME_PATTERN,
            `${label}.assetEnvironment`
        );
    if ((track.assetMedia === undefined) !== (track.assetProvenance === undefined)) {
        throw new TypeError(`${label} asset metadata and provenance must be supplied together`);
    }
    if (track.assetMedia !== undefined) {
        requirePlainObject(track.assetMedia, `${label}.assetMedia`);
        requirePlainObject(track.assetProvenance, `${label}.assetProvenance`);
    }
    return {
        assetEnvironment,
        cueAssertions,
        expectedDeliveredFormat: expectedDeliveredFormat === null ?
            null :
            normalizeSubtitleCodec(expectedDeliveredFormat),
        expectedDeliveryMethod,
        expectedRenderer,
        offsetsMicroseconds: [ ...offsetsMicroseconds ],
        role,
        routeID: requirePattern(track.routeId, IDENTIFIER_PATTERN, `${label}.routeId`),
        sourceFormat: normalizeSubtitleCodec(
            requirePattern(track.sourceFormat, CODEC_PATTERN, `${label}.sourceFormat`)
        ),
        sourceKind,
        streamIndex: requireSafeInteger(
            track.streamIndex,
            `${label}.streamIndex`,
            0,
            MAXIMUM_SUBTITLE_STREAM_INDEX
        )
    };
}

function validateSource(value, label) {
    const source = requirePlainObject(value, label);
    requireExactKeys(source, SOURCE_KEYS, label);
    requireString(source.title, `${label}.title`);
    const expectedPlayMethod = requireString(
        source.expectedPlayMethod,
        `${label}.expectedPlayMethod`
    );
    if (!EXPECTED_PLAY_METHODS.has(expectedPlayMethod)) {
        throw new TypeError(`${label}.expectedPlayMethod is unsupported`);
    }
    const playerModes = requireArray(source.playerModes, `${label}.playerModes`);
    if (playerModes.length !== 2
        || playerModes[0] !== 'html'
        || playerModes[1] !== 'custom') {
        throw new TypeError(`${label}.playerModes must contain html then custom`);
    }
    requirePlainObject(source.media, `${label}.media`);
    requirePlainObject(source.provenance, `${label}.provenance`);
    const tracks = requireArray(source.tracks, `${label}.tracks`, 1)
        .map((track, trackIndex) => validateTrack(track, `${label}.tracks[${trackIndex}]`));
    const streamIndices = new Set(tracks.map(track => track.streamIndex));
    if (streamIndices.size !== tracks.length) {
        throw new TypeError(`${label} contains duplicate subtitle stream indices`);
    }
    if (!tracks.some(track => track.role === 'primary')) {
        throw new TypeError(`${label} requires at least one primary subtitle track`);
    }
    const exerciseIDs = requireArray(source.exerciseIds, `${label}.exerciseIds`, 1)
        .map((exerciseID, exerciseIndex) => requirePattern(
            exerciseID,
            IDENTIFIER_PATTERN,
            `${label}.exerciseIds[${exerciseIndex}]`
        ));
    const failureModes = requireArray(source.failureModes, `${label}.failureModes`)
        .map((failureMode, failureIndex) => requirePattern(
            failureMode,
            IDENTIFIER_PATTERN,
            `${label}.failureModes[${failureIndex}]`
        ));
    if (failureModes.some(failureMode => !FAILURE_MODES.has(failureMode))) {
        throw new TypeError(`${label}.failureModes contains an unsupported value`);
    }
    const frameRate = source.media?.video?.frameRate;
    const frameDurationMicroseconds = typeof frameRate === 'number'
        && Number.isFinite(frameRate)
        && frameRate > 0 ?
        Math.round(MICROSECONDS_PER_SECOND / frameRate) :
        null;
    return {
        expectedPlayMethod,
        exerciseIDs: [ ...new Set(exerciseIDs) ],
        failureModes: [ ...new Set(failureModes) ],
        frameDurationMicroseconds,
        id: requirePattern(source.id, IDENTIFIER_PATTERN, `${label}.id`),
        itemEnvironment: requirePattern(
            source.itemEnvironment,
            ENVIRONMENT_NAME_PATTERN,
            `${label}.itemEnvironment`
        ),
        licenseEnvironment: requirePattern(
            source.licenseEnvironment,
            ENVIRONMENT_NAME_PATTERN,
            `${label}.licenseEnvironment`
        ),
        licenseExpression: requireString(
            source.licenseExpression,
            `${label}.licenseExpression`
        ),
        mediaEnvironment: requirePattern(
            source.mediaEnvironment,
            ENVIRONMENT_NAME_PATTERN,
            `${label}.mediaEnvironment`
        ),
        tracks
    };
}

async function calculateFileEvidence(filePath, label) {
    let fileStatus;
    try {
        fileStatus = await stat(filePath);
    } catch {
        throw new TypeError(`${label} does not resolve to a readable file`);
    }
    if (!fileStatus.isFile()) {
        throw new TypeError(`${label} does not resolve to a file`);
    }
    const hash = createHash('sha256');
    try {
        await new Promise((resolve, reject) => {
            const stream = createReadStream(filePath);
            stream.on('data', chunk => hash.update(chunk));
            stream.on('error', reject);
            stream.on('end', resolve);
        });
    } catch {
        throw new TypeError(`${label} could not be read`);
    }
    return {
        byteLength: fileStatus.size,
        sha256: hash.digest('hex')
    };
}

/** Loads one private subtitle case and returns no private path or title in evidence. */
export async function loadSubtitleValidationCase(specificationPath, environment, itemID) {
    const rawSpecification = await readFile(specificationPath, 'utf8');
    let specification;
    try {
        specification = JSON.parse(rawSpecification);
    } catch {
        throw new TypeError('Subtitle live specification is not valid JSON');
    }
    const specificationObject = requirePlainObject(
        specification,
        'Subtitle live specification'
    );
    requireExactKeys(
        specificationObject,
        new Set([ '$schema', 'schemaVersion', 'sources' ]),
        'Subtitle live specification'
    );
    if (specificationObject.$schema !== SUBTITLE_SCHEMA_NAME
        || specificationObject.schemaVersion !== 1) {
        throw new TypeError('Subtitle live specification schema is unsupported');
    }
    const sources = requireArray(specificationObject.sources, 'Subtitle sources', 1)
        .map((source, sourceIndex) => validateSource(source, `Subtitle sources[${sourceIndex}]`));
    const sourceIdentifiers = new Set(sources.map(source => source.id));
    if (sourceIdentifiers.size !== sources.length) {
        throw new TypeError('Subtitle live specification contains duplicate source identifiers');
    }
    const matchedSources = sources.filter(source => (
        environment[source.itemEnvironment] === itemID
    ));
    if (matchedSources.length !== 1) {
        throw new TypeError('Subtitle live specification must match exactly one configured item');
    }
    const source = matchedSources[0];
    const mediaPath = requireEnvironmentValue(
        environment,
        source.mediaEnvironment,
        'Subtitle media'
    );
    const licensePath = requireEnvironmentValue(
        environment,
        source.licenseEnvironment,
        'Subtitle license evidence'
    );
    const assetPaths = [];
    for (const track of source.tracks) {
        if (track.assetEnvironment !== null) {
            assetPaths.push({
                path: requireEnvironmentValue(
                    environment,
                    track.assetEnvironment,
                    `Subtitle track ${track.streamIndex} asset`
                ),
                streamIndex: track.streamIndex
            });
        }
    }
    const [ mediaEvidence, licenseEvidence, ...assetEvidence ] = await Promise.all([
        calculateFileEvidence(mediaPath, 'Subtitle media'),
        calculateFileEvidence(licensePath, 'Subtitle license evidence'),
        ...assetPaths.map(asset => calculateFileEvidence(
            asset.path,
            `Subtitle track ${asset.streamIndex} asset`
        ))
    ]);
    return {
        case: {
            expectedPlayMethod: source.expectedPlayMethod,
            exerciseIDs: source.exerciseIDs,
            failureModes: source.failureModes,
            frameDurationMicroseconds: source.frameDurationMicroseconds,
            sourceID: source.id,
            tracks: source.tracks
        },
        preflightEvidence: {
            assets: assetEvidence.map((evidence, assetIndex) => ({
                ...evidence,
                streamIndex: assetPaths[assetIndex].streamIndex
            })),
            license: {
                ...licenseEvidence,
                expression: source.licenseExpression
            },
            media: mediaEvidence,
            sourceID: source.id
        },
        privateValues: [ specificationPath, mediaPath, licensePath, ...assetPaths.map(asset => asset.path) ]
    };
}

function normalizeTarget(target) {
    const targetInformation = isPlainObject(target?.targetInfo) ? target.targetInfo : target;
    return {
        browserContextID: String(targetInformation?.browserContextId ?? ''),
        openerID: String(targetInformation?.openerId ?? ''),
        title: String(targetInformation?.title ?? ''),
        type: String(targetInformation?.type ?? ''),
        url: String(targetInformation?.url ?? '')
    };
}

/** Counts only libass/libpgs workers belonging to the controlled player page. */
export function countSubtitleWorkerTargets(targetData, targetScope = null) {
    let targets = [];
    if (Array.isArray(targetData)) {
        targets = targetData;
    } else if (Array.isArray(targetData?.targetInfos)) {
        targets = targetData.targetInfos;
    }
    const counts = {
        libassWorkerCount: 0,
        libpgsWorkerCount: 0,
        subtitleWorkerCount: 0
    };
    for (const target of targets) {
        const normalizedTarget = normalizeTarget(target);
        const inScope = targetScope === null
            || (normalizedTarget.openerID === targetScope.pageTargetID
                && (targetScope.browserContextID === undefined
                    || normalizedTarget.browserContextID === targetScope.browserContextID));
        if (!inScope || normalizedTarget.type !== 'worker') {
            continue;
        }
        const descriptor = `${normalizedTarget.url}\n${normalizedTarget.title}`;
        if (SUBTITLE_WORKER_PATTERNS.libass.test(descriptor)) {
            counts.libassWorkerCount += 1;
            counts.subtitleWorkerCount += 1;
        } else if (SUBTITLE_WORKER_PATTERNS.libpgs.test(descriptor)) {
            counts.libpgsWorkerCount += 1;
            counts.subtitleWorkerCount += 1;
        }
    }
    return counts;
}

/** Matches Jellyfin subtitle resources without retaining their private URL. */
export function isSubtitleResourceURL(resourceURL) {
    if (typeof resourceURL !== 'string' || resourceURL.length === 0) {
        return false;
    }
    let parsedURL;
    try {
        parsedURL = new URL(resourceURL);
    } catch {
        return false;
    }
    return /\/subtitles(?:\/|$)/iu.test(parsedURL.pathname)
        || /\.(?:ass|ssa|sup|vtt)(?:$|\/)/iu.test(parsedURL.pathname);
}

function addFailure(failures, condition, code) {
    if (!condition) {
        failures.push(code);
    }
}

function boundsMatch(actualBounds, expectedBounds) {
    if (!actualBounds || !expectedBounds) {
        return false;
    }
    return [ 'x', 'y', 'width', 'height' ].every(property => (
        Number.isFinite(actualBounds[property])
        && Math.abs(actualBounds[property] - expectedBounds[property])
            <= expectedBounds.tolerance
    ));
}

/** Validates selected index, codec, source kind, delivery, renderer, and bounded counts. */
export function validateSubtitleRouteSnapshot(subtitleSnapshot, expectedTrack) {
    const failures = [];
    const selectedTrack = expectedTrack.role === 'secondary' ?
        subtitleSnapshot?.secondary :
        subtitleSnapshot?.primary;
    addFailure(
        failures,
        selectedTrack?.streamIndex === expectedTrack.streamIndex,
        'selected-stream-index-mismatch'
    );
    addFailure(
        failures,
        normalizeSubtitleCodec(selectedTrack?.codec) === expectedTrack.sourceFormat,
        'selected-codec-mismatch'
    );
    addFailure(
        failures,
        selectedTrack?.deliveryMethod === expectedTrack.expectedDeliveryMethod,
        'selected-delivery-method-mismatch'
    );
    addFailure(
        failures,
        normalizeSubtitleCodec(selectedTrack?.deliveredFormat)
            === normalizeSubtitleCodec(expectedTrack.expectedDeliveredFormat),
        'selected-delivered-format-mismatch'
    );
    addFailure(
        failures,
        selectedTrack?.sourceKind === expectedTrack.sourceKind,
        'selected-source-kind-mismatch'
    );
    addFailure(
        failures,
        Number.isSafeInteger(subtitleSnapshot?.surfaceCounts?.primaryTextSurfaceCount)
            && subtitleSnapshot.surfaceCounts.primaryTextSurfaceCount <= 1,
        'primary-text-surface-count-unbounded'
    );
    addFailure(
        failures,
        Number.isSafeInteger(subtitleSnapshot?.surfaceCounts?.secondaryTextSurfaceCount)
            && subtitleSnapshot.surfaceCounts.secondaryTextSurfaceCount <= 1,
        'secondary-text-surface-count-unbounded'
    );
    addFailure(
        failures,
        Number.isSafeInteger(subtitleSnapshot?.surfaceCounts?.specializedCanvasCount)
            && subtitleSnapshot.surfaceCounts.specializedCanvasCount <= 1,
        'specialized-canvas-count-unbounded'
    );
    addFailure(
        failures,
        Number.isSafeInteger(subtitleSnapshot?.workerCounts?.subtitleWorkerCount)
            && subtitleSnapshot.workerCounts.subtitleWorkerCount
                <= MAXIMUM_SUBTITLE_WORKER_COUNT,
        'subtitle-worker-count-unbounded'
    );
    switch (expectedTrack.expectedRenderer) {
        case 'forced-dom-text':
            addFailure(
                failures,
                subtitleSnapshot?.surfaceCounts?.specializedCanvasCount === 0,
                'unexpected-specialized-canvas'
            );
            addFailure(
                failures,
                subtitleSnapshot?.workerCounts?.subtitleWorkerCount === 0,
                'unexpected-subtitle-worker'
            );
            break;
        case 'libass-canvas':
            addFailure(
                failures,
                subtitleSnapshot?.surfaceCounts?.specializedCanvasCount === 1,
                'libass-canvas-missing'
            );
            addFailure(
                failures,
                subtitleSnapshot?.workerCounts?.libassWorkerCount === 1,
                'libass-worker-count-mismatch'
            );
            break;
        case 'libpgs-canvas':
            addFailure(
                failures,
                subtitleSnapshot?.surfaceCounts?.specializedCanvasCount === 1,
                'libpgs-canvas-missing'
            );
            addFailure(
                failures,
                subtitleSnapshot?.workerCounts?.libpgsWorkerCount === 1,
                'libpgs-worker-count-mismatch'
            );
            break;
        case 'none':
            addFailure(
                failures,
                subtitleSnapshot?.surfaceCounts?.specializedCanvasCount === 0,
                'fallback-specialized-canvas-present'
            );
            break;
        default:
            failures.push('unsupported-renderer-expectation');
            break;
    }
    return failures;
}

function getProbeContentSurfaces(probe) {
    return [
        ...(Array.isArray(probe?.textSurfaces) ? probe.textSurfaces : []),
        ...(Array.isArray(probe?.nativeCueSurfaces) ? probe.nativeCueSurfaces : []),
        ...(Array.isArray(probe?.canvasSurfaces) ? probe.canvasSurfaces : [])
    ].filter(surface => surface?.contentPresent === true);
}

/** Validates one before/active/after media-time-directed cue probe. */
export function validateSubtitleCueProbe(
    probe,
    cue,
    phase,
    expectedRenderer,
    timingToleranceMicroseconds
) {
    const failures = [];
    const expectedMediaTimeMicroseconds = cue[`${phase}ProbeMicroseconds`];
    addFailure(
        failures,
        Number.isSafeInteger(probe?.mediaTimeMicroseconds)
            && Math.abs(probe.mediaTimeMicroseconds - expectedMediaTimeMicroseconds)
                <= timingToleranceMicroseconds,
        'media-time-mismatch'
    );
    addFailure(failures, probe?.screenshot?.status === 'captured', 'screenshot-capture-failed');
    const contentSurfaces = getProbeContentSurfaces(probe);
    if (phase !== 'active') {
        addFailure(failures, contentSurfaces.length === 0, 'cue-visible-outside-active-window');
        return failures;
    }
    if (expectedRenderer === 'none') {
        addFailure(failures, contentSurfaces.length === 0, 'fallback-route-rendered-custom-cue');
        return failures;
    }
    const expectedHash = cue.normalizedTextSHA256 ?? cue.imageSHA256;
    const matchingSurfaces = contentSurfaces.filter(surface => surface.sha256 === expectedHash);
    addFailure(failures, matchingSurfaces.length === 1, 'active-cue-hash-mismatch');
    const matchingSurface = matchingSurfaces[0];
    addFailure(
        failures,
        boundsMatch(matchingSurface?.bounds, cue.expectedBounds),
        'active-cue-bounds-mismatch'
    );
    addFailure(
        failures,
        matchingSurface?.pointerEventsNone === true,
        'subtitle-surface-receives-pointer-input'
    );
    switch (expectedRenderer) {
        case 'forced-dom-text':
            addFailure(
                failures,
                matchingSurface?.kind === 'dom-text' || matchingSurface?.kind === 'native-cue',
                'unexpected-text-renderer'
            );
            break;
        case 'libass-canvas':
        case 'libpgs-canvas':
            addFailure(failures, matchingSurface?.kind === 'canvas', 'unexpected-canvas-renderer');
            break;
        default:
            failures.push('unsupported-renderer-expectation');
            break;
    }
    return failures;
}

/** Validates that pause freezes media time and the hashed subtitle surface. */
export function validateSubtitlePauseProbes(initialProbe, laterProbe, toleranceMicroseconds) {
    const failures = [];
    addFailure(
        failures,
        Number.isSafeInteger(initialProbe?.mediaTimeMicroseconds)
            && Number.isSafeInteger(laterProbe?.mediaTimeMicroseconds)
            && Math.abs(
                laterProbe.mediaTimeMicroseconds - initialProbe.mediaTimeMicroseconds
            ) <= toleranceMicroseconds,
        'paused-subtitle-clock-moved'
    );
    addFailure(
        failures,
        JSON.stringify(getProbeContentSurfaces(initialProbe))
            === JSON.stringify(getProbeContentSurfaces(laterProbe)),
        'paused-subtitle-surface-changed'
    );
    addFailure(
        failures,
        typeof initialProbe?.screenshot?.sha256 === 'string'
            && initialProbe.screenshot.sha256 === laterProbe?.screenshot?.sha256,
        'paused-subtitle-screenshot-changed'
    );
    return failures;
}

/** Creates an async in-page probe that returns hashes and bounds, never subtitle text. */
export function createSubtitleCueEvidenceExpression(accessKey) {
    return `(async () => {
        const capture = window[${JSON.stringify(accessKey)}]?.();
        const player = capture?.player;
        if (!player) {
            return { available: false };
        }
        const normalizeText = value => String(value ?? '')
            .normalize('NFC')
            .replace(/[\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069]/gu, '')
            .replace(/\\s+/gu, ' ')
            .trim();
        const digestBytes = async bytes => {
            const digest = await crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest))
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join('');
        };
        const digestText = value => digestBytes(new TextEncoder().encode(normalizeText(value)));
        const isVisible = element => {
            const rectangle = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rectangle.width > 0
                && rectangle.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && !element.classList.contains('hide');
        };
        const container = document.querySelector('.videoPlayerContainer');
        const containerRectangle = container?.getBoundingClientRect() ?? null;
        const normalizeBounds = rectangle => {
            if (!containerRectangle
                || containerRectangle.width <= 0
                || containerRectangle.height <= 0) {
                return null;
            }
            return {
                height: rectangle.height / containerRectangle.height,
                width: rectangle.width / containerRectangle.width,
                x: (rectangle.left - containerRectangle.left) / containerRectangle.width,
                y: (rectangle.top - containerRectangle.top) / containerRectangle.height
            };
        };
        const createTextSurface = async (element, role) => {
            const normalizedText = normalizeText(element.innerText ?? element.textContent);
            const parentStyle = getComputedStyle(element.parentElement ?? element);
            return {
                bounds: normalizeBounds(element.getBoundingClientRect()),
                contentPresent: normalizedText.length > 0 && isVisible(element),
                kind: 'dom-text',
                pointerEventsNone: getComputedStyle(element).pointerEvents === 'none'
                    || parentStyle.pointerEvents === 'none',
                role,
                sha256: normalizedText.length > 0 ? await digestText(normalizedText) : null
            };
        };
        const textSurfaces = [];
        for (const element of document.querySelectorAll(
            '.videoSubtitlesInner, .videoSecondarySubtitlesInner'
        )) {
            textSurfaces.push(await createTextSurface(
                element,
                element.classList.contains('videoSecondarySubtitlesInner')
                    ? 'secondary'
                    : 'primary'
            ));
        }
        const nativeCueSurfaces = [];
        for (const video of document.querySelectorAll('.videoPlayerContainer video')) {
            for (const track of Array.from(video.textTracks ?? [])) {
                if (track.mode !== 'showing') {
                    continue;
                }
                const cueText = Array.from(track.activeCues ?? [])
                    .map(cue => cue.text ?? '')
                    .join('\\n');
                const normalizedText = normalizeText(cueText);
                nativeCueSurfaces.push({
                    bounds: null,
                    contentPresent: normalizedText.length > 0,
                    kind: 'native-cue',
                    pointerEventsNone: true,
                    role: 'primary',
                    sha256: normalizedText.length > 0 ? await digestText(normalizedText) : null
                });
            }
        }
        const canvasSurfaces = [];
        for (const canvas of document.querySelectorAll(
            '.videoPlayerContainer canvas.htmlVideoPlayerCustomSubtitleCanvas, '
                + '.videoPlayerContainer .libassjs-canvas'
        )) {
            let contentBounds = null;
            let contentPresent = false;
            let sha256 = null;
            let status = 'captured';
            try {
                const context = canvas.getContext('2d', { willReadFrequently: true });
                if (!context || canvas.width <= 0 || canvas.height <= 0) {
                    status = 'unavailable';
                } else {
                    const image = context.getImageData(0, 0, canvas.width, canvas.height);
                    let minimumX = canvas.width;
                    let minimumY = canvas.height;
                    let maximumX = -1;
                    let maximumY = -1;
                    for (let pixelIndex = 0; pixelIndex < image.data.length; pixelIndex += 4) {
                        if (image.data[pixelIndex + 3] === 0) {
                            continue;
                        }
                        const linearPixelIndex = pixelIndex / 4;
                        const pixelX = linearPixelIndex % canvas.width;
                        const pixelY = Math.floor(linearPixelIndex / canvas.width);
                        minimumX = Math.min(minimumX, pixelX);
                        minimumY = Math.min(minimumY, pixelY);
                        maximumX = Math.max(maximumX, pixelX);
                        maximumY = Math.max(maximumY, pixelY);
                    }
                    contentPresent = maximumX >= minimumX && maximumY >= minimumY;
                    if (contentPresent) {
                        const contentWidth = maximumX - minimumX + 1;
                        const contentHeight = maximumY - minimumY + 1;
                        const contentImage = context.getImageData(
                            minimumX,
                            minimumY,
                            contentWidth,
                            contentHeight
                        );
                        const header = new Uint8Array(8);
                        const headerView = new DataView(header.buffer);
                        headerView.setUint32(0, contentWidth, true);
                        headerView.setUint32(4, contentHeight, true);
                        const hashInput = new Uint8Array(
                            header.byteLength + contentImage.data.byteLength
                        );
                        hashInput.set(header, 0);
                        hashInput.set(
                            new Uint8Array(
                                contentImage.data.buffer,
                                contentImage.data.byteOffset,
                                contentImage.data.byteLength
                            ),
                            header.byteLength
                        );
                        sha256 = await digestBytes(hashInput);
                        const canvasRectangle = canvas.getBoundingClientRect();
                        contentBounds = normalizeBounds({
                            height: canvasRectangle.height * contentHeight / canvas.height,
                            left: canvasRectangle.left
                                + canvasRectangle.width * minimumX / canvas.width,
                            top: canvasRectangle.top
                                + canvasRectangle.height * minimumY / canvas.height,
                            width: canvasRectangle.width * contentWidth / canvas.width
                        });
                    }
                }
            } catch {
                status = 'unavailable';
            }
            canvasSurfaces.push({
                bounds: contentBounds,
                contentPresent,
                kind: 'canvas',
                pointerEventsNone: getComputedStyle(canvas).pointerEvents === 'none',
                role: 'primary',
                sha256,
                status
            });
        }
        const customPlayback = typeof player.getCustomPlaybackTelemetry === 'function'
            ? player.getCustomPlaybackTelemetry()
            : null;
        const playerTimeMilliseconds = typeof player.currentTime === 'function'
            ? player.currentTime()
            : null;
        return {
            available: true,
            canvasSurfaces,
            mediaTimeMicroseconds: Number.isSafeInteger(customPlayback?.currentTimeMicroseconds)
                ? customPlayback.currentTimeMicroseconds
                : Number.isFinite(playerTimeMilliseconds)
                    ? Math.round(playerTimeMilliseconds * 1000)
                    : null,
            nativeCueSurfaces,
            textSurfaces
        };
    })()`;
}

/* eslint-enable compat/compat */
