/* eslint-disable compat/compat -- This local harness targets Node 24 */

import {
    open,
    readdir,
    stat
} from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_CAPTURE_WAIT_MILLISECONDS = 5_000;
const DEFAULT_POLL_INTERVAL_MILLISECONDS = 100;
const MAXIMUM_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_PRIMARY_LOG_FILES = 64;
const MAXIMUM_TRANSCODE_LOG_FILES = 4_096;
const PRIMARY_LOG_PATTERN = /^log_\d{8}(?:_\d+)?\.log$/iu;
const TRANSCODE_LOG_PATTERN = /^ffmpeg\.transcode-.*\.log$/iu;
const LOG_LINE_PATTERN = /^\[[^\]]+\] \[(?<level>[A-Z]+)\] \[\d+\] (?<source>[^:]+): (?<message>.*)$/u;
const PLAYBACK_POLICY_PATTERN = /EnablePlaybackRemuxing: (?<remuxing>True|False) EnableVideoPlaybackTranscoding: (?<video>True|False) EnableAudioPlaybackTranscoding: (?<audio>True|False)/u;

export class ServerLogEvidenceError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'ServerLogEvidenceError';
    }
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function classifyLogName(name) {
    if (PRIMARY_LOG_PATTERN.test(name)) {
        return 'primary';
    }
    if (TRANSCODE_LOG_PATTERN.test(name)) {
        return 'transcode';
    }
    return null;
}

async function readLogFileRecords(logDirectory) {
    let directoryEntries;
    try {
        directoryEntries = await readdir(logDirectory, { withFileTypes: true });
    } catch {
        throw new ServerLogEvidenceError(
            'server-log-directory-unavailable',
            'The configured Jellyfin server log directory is unavailable'
        );
    }
    const logEntries = directoryEntries.filter(entry => (
        entry.isFile() && classifyLogName(entry.name) !== null
    ));
    const primaryLogCount = logEntries.filter(
        entry => classifyLogName(entry.name) === 'primary'
    ).length;
    const transcodeLogCount = logEntries.filter(
        entry => classifyLogName(entry.name) === 'transcode'
    ).length;
    if (primaryLogCount > MAXIMUM_PRIMARY_LOG_FILES
        || transcodeLogCount > MAXIMUM_TRANSCODE_LOG_FILES) {
        throw new ServerLogEvidenceError(
            'server-log-file-bound-exceeded',
            'The Jellyfin server log directory contains too many capture candidates'
        );
    }

    const records = new Map();
    for (const entry of logEntries) {
        let fileStatistics;
        try {
            fileStatistics = await stat(path.join(logDirectory, entry.name));
        } catch {
            continue;
        }
        if (!fileStatistics.isFile()) {
            continue;
        }
        records.set(entry.name, {
            kind: classifyLogName(entry.name),
            size: fileStatistics.size
        });
    }
    return records;
}

async function readFileSlice(filePath, start, length) {
    if (length === 0) {
        return '';
    }
    const fileHandle = await open(filePath, 'r');
    try {
        const bytes = Buffer.alloc(length);
        let totalBytesRead = 0;
        while (totalBytesRead < length) {
            const readResult = await fileHandle.read(
                bytes,
                totalBytesRead,
                length - totalBytesRead,
                start + totalBytesRead
            );
            if (readResult.bytesRead === 0) {
                break;
            }
            totalBytesRead += readResult.bytesRead;
        }
        return bytes.subarray(0, totalBytesRead).toString('utf8');
    } finally {
        await fileHandle.close();
    }
}

function normalizePrivateMatchValue(value, label) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new TypeError(`${label} must be a nonempty string`);
    }
    return value;
}

function parseBooleanName(value) {
    return value === 'True';
}

function hasExactPlaybackMessage(message, userName, itemName, action) {
    const playbackToken = `'"${itemName}"'`;
    return message.startsWith(`User "${userName}" ${action} playback of ${playbackToken}`);
}

function countLogLevel(level, counts) {
    switch (level) {
        case 'ERR':
        case 'FTL':
            counts.errorCount += 1;
            break;
        case 'WRN':
            counts.warningCount += 1;
            break;
    }
}

function getPlaybackEvent(source, message, userName, itemName) {
    if (!source.endsWith('.SessionManager')) {
        return null;
    }
    if (hasExactPlaybackMessage(message, userName, itemName, 'started')) {
        return 'start';
    }
    if (hasExactPlaybackMessage(message, userName, itemName, 'stopped')) {
        return 'stop';
    }
    return null;
}

function getPolicyRecord(source, message, userName) {
    if (!source.endsWith('.MediaInfoHelper')
        || !message.startsWith(`User policy for "${userName}".`)) {
        return null;
    }
    const policyMatch = PLAYBACK_POLICY_PATTERN.exec(message);
    if (!policyMatch?.groups) {
        return null;
    }
    return {
        audioTranscodingEnabled: parseBooleanName(policyMatch.groups.audio),
        remuxingEnabled: parseBooleanName(policyMatch.groups.remuxing),
        videoTranscodingEnabled: parseBooleanName(policyMatch.groups.video)
    };
}

/** Parses appended Jellyfin log text into bounded, identifier-free evidence. */
export function parseServerLogText(logText, match) {
    const itemName = normalizePrivateMatchValue(match.itemName, 'Item name');
    const userName = normalizePrivateMatchValue(match.userName, 'User name');
    const playbackSequence = [];
    const policyRecords = [];
    const levelCounts = {
        errorCount: 0,
        warningCount: 0
    };
    let parsedLineCount = 0;

    for (const line of logText.split(/\r?\n/u)) {
        if (line.length === 0) {
            continue;
        }
        const lineMatch = LOG_LINE_PATTERN.exec(line);
        if (!lineMatch?.groups) {
            continue;
        }
        parsedLineCount += 1;
        countLogLevel(lineMatch.groups.level, levelCounts);
        const message = lineMatch.groups.message;
        const playbackEvent = getPlaybackEvent(
            lineMatch.groups.source,
            message,
            userName,
            itemName
        );
        if (playbackEvent !== null) {
            playbackSequence.push(playbackEvent);
        }
        const policyRecord = getPolicyRecord(
            lineMatch.groups.source,
            message,
            userName
        );
        if (policyRecord !== null) {
            policyRecords.push(policyRecord);
        }
    }

    return {
        errorCount: levelCounts.errorCount,
        parsedLineCount,
        playbackSequence,
        policyRecords,
        startedPlaybackCount: playbackSequence.filter(value => value === 'start').length,
        stoppedPlaybackCount: playbackSequence.filter(value => value === 'stop').length,
        warningCount: levelCounts.warningCount
    };
}

/** Records file sizes without reading or retaining raw Jellyfin log text. */
export async function beginServerLogCapture(logDirectory) {
    if (typeof logDirectory !== 'string' || logDirectory.length === 0) {
        throw new TypeError('Server log directory must be a nonempty string');
    }
    const initialFiles = await readLogFileRecords(logDirectory);
    return {
        initialFiles,
        logDirectory
    };
}

function hasTranscodeLogActivity(initialRecord, currentRecord) {
    return !initialRecord || initialRecord.size !== currentRecord.size;
}

async function readPrimaryLogAppend(capture, name, currentRecord, remainingByteCount) {
    const initialRecord = capture.initialFiles.get(name);
    const initialSize = initialRecord?.kind === 'primary' ? initialRecord.size : 0;
    const start = currentRecord.size >= initialSize ? initialSize : 0;
    const length = currentRecord.size - start;
    if (length <= 0) {
        return null;
    }
    if (length > remainingByteCount) {
        throw new ServerLogEvidenceError(
            'server-log-byte-bound-exceeded',
            'The bounded Jellyfin server log capture exceeded its byte limit'
        );
    }
    try {
        return {
            length,
            text: await readFileSlice(
                path.join(capture.logDirectory, name),
                start,
                length
            )
        };
    } catch {
        throw new ServerLogEvidenceError(
            'server-log-read-failed',
            'The bounded Jellyfin server log capture could not read appended data'
        );
    }
}

async function collectServerLogEvidence(capture, match) {
    const currentFiles = await readLogFileRecords(capture.logDirectory);
    const primaryText = [];
    let appendedByteCount = 0;
    let changedPrimaryLogCount = 0;
    let transcodeLogActivityCount = 0;

    for (const [ name, currentRecord ] of currentFiles) {
        const initialRecord = capture.initialFiles.get(name);
        if (currentRecord.kind === 'transcode') {
            if (hasTranscodeLogActivity(initialRecord, currentRecord)) {
                transcodeLogActivityCount += 1;
            }
            continue;
        }
        const append = await readPrimaryLogAppend(
            capture,
            name,
            currentRecord,
            MAXIMUM_CAPTURE_BYTES - appendedByteCount
        );
        if (append === null) {
            continue;
        }
        appendedByteCount += append.length;
        changedPrimaryLogCount += 1;
        primaryText.push(append.text);
    }

    const parsedEvidence = parseServerLogText(primaryText.join('\n'), match);
    return {
        appendedByteCount,
        changedPrimaryLogCount,
        ...parsedEvidence,
        status: 'captured',
        transcodeLogActivityCount
    };
}

/** Waits for the expected stop records and returns only bounded parsed evidence. */
export async function finishServerLogCapture(
    capture,
    match,
    expectedSessionCount,
    options = {}
) {
    if (!Number.isSafeInteger(expectedSessionCount) || expectedSessionCount <= 0) {
        throw new TypeError('Expected server-log session count must be a positive integer');
    }
    const timeoutMilliseconds = options.timeoutMilliseconds
        ?? DEFAULT_CAPTURE_WAIT_MILLISECONDS;
    const pollIntervalMilliseconds = options.pollIntervalMilliseconds
        ?? DEFAULT_POLL_INTERVAL_MILLISECONDS;
    const startedAtMilliseconds = Date.now();
    let evidence = null;
    while (Date.now() - startedAtMilliseconds < timeoutMilliseconds) {
        evidence = await collectServerLogEvidence(capture, match);
        if (evidence.startedPlaybackCount >= expectedSessionCount
            && evidence.stoppedPlaybackCount >= expectedSessionCount) {
            return evidence;
        }
        await sleep(pollIntervalMilliseconds);
    }
    return evidence ?? collectServerLogEvidence(capture, match);
}

/** Returns stable failures for one bounded Jellyfin playback-window log capture. */
export function validateServerLogEvidence(evidence, expectations) {
    const failures = [];
    const expectedSessionCount = expectations.expectedSessionCount;
    if (evidence?.status !== 'captured') {
        return [ 'server-log-not-captured' ];
    }
    if (evidence.appendedByteCount <= 0 || evidence.changedPrimaryLogCount <= 0) {
        failures.push('server-log-primary-output-missing');
    }
    if (evidence.startedPlaybackCount !== expectedSessionCount) {
        failures.push('server-log-start-count-mismatch');
    }
    if (evidence.stoppedPlaybackCount !== expectedSessionCount) {
        failures.push('server-log-stop-count-mismatch');
    }
    const expectedSequence = [];
    for (let sessionIndex = 0; sessionIndex < expectedSessionCount; sessionIndex += 1) {
        expectedSequence.push('start', 'stop');
    }
    if (evidence.playbackSequence.length !== expectedSequence.length
        || evidence.playbackSequence.some((value, index) => value !== expectedSequence[index])) {
        failures.push('server-log-playback-sequence-mismatch');
    }
    if (evidence.policyRecords.length < expectedSessionCount) {
        failures.push('server-log-policy-record-missing');
    }
    if (evidence.errorCount !== 0) {
        failures.push('server-log-error');
    }
    if (expectations.expectedPlayMethod === 'DirectPlay'
        && evidence.transcodeLogActivityCount !== 0) {
        failures.push('server-log-unexpected-transcode');
    }
    return failures;
}

/* eslint-enable compat/compat */
