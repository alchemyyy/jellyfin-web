import assert from 'node:assert/strict';
import {
    appendFile,
    mkdtemp,
    rm,
    writeFile
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    beginServerLogCapture,
    finishServerLogCapture,
    parseServerLogText,
    validateServerLogEvidence
} from './server-log-evidence.mjs';

const PRIVATE_ITEM_NAME = 'Private Validation Movie';
const PRIVATE_USER_NAME = 'private-validation-user';
const MATCH = Object.freeze({
    itemName: PRIVATE_ITEM_NAME,
    userName: PRIVATE_USER_NAME
});

function createLogLine(level, source, message, second = 0) {
    return `[2026-08-03 05:00:${String(second).padStart(2, '0')}.000 -07:00] [${level}] [42] ${source}: ${message}`;
}

function createPolicyLine(second = 0) {
    return createLogLine(
        'INF',
        'Jellyfin.Api.Helpers.MediaInfoHelper',
        `User policy for "${PRIVATE_USER_NAME}". EnablePlaybackRemuxing: True EnableVideoPlaybackTranscoding: True EnableAudioPlaybackTranscoding: False`,
        second
    );
}

function createStartLine(second = 1) {
    return createLogLine(
        'INF',
        'Emby.Server.Implementations.Session.SessionManager',
        `User "${PRIVATE_USER_NAME}" started playback of '"${PRIVATE_ITEM_NAME}"' ("Jellyfin Web" "12.0.0")`,
        second
    );
}

function createStopLine(second = 2) {
    return createLogLine(
        'INF',
        'Emby.Server.Implementations.Session.SessionManager',
        `User "${PRIVATE_USER_NAME}" stopped playback of '"${PRIVATE_ITEM_NAME}"' at "5000"ms ("Jellyfin Web" "12.0.0")`,
        second
    );
}

test('parses exact playback and policy events without retaining private values', () => {
    const evidence = parseServerLogText([
        createPolicyLine(),
        createStartLine(),
        createStopLine(),
        createLogLine('WRN', 'Unrelated.Component', 'Bounded warning')
    ].join('\n'), MATCH);

    assert.deepEqual(evidence.playbackSequence, [ 'start', 'stop' ]);
    assert.equal(evidence.startedPlaybackCount, 1);
    assert.equal(evidence.stoppedPlaybackCount, 1);
    assert.equal(evidence.warningCount, 1);
    assert.deepEqual(evidence.policyRecords, [ {
        audioTranscodingEnabled: false,
        remuxingEnabled: true,
        videoTranscodingEnabled: true
    } ]);
    const serializedEvidence = JSON.stringify(evidence);
    assert.ok(!serializedEvidence.includes(PRIVATE_ITEM_NAME));
    assert.ok(!serializedEvidence.includes(PRIVATE_USER_NAME));
});

test('ignores playback events for another item or user', () => {
    const evidence = parseServerLogText([
        createStartLine(),
        createStopLine()
    ].join('\n'), {
        itemName: 'Another Movie',
        userName: PRIVATE_USER_NAME
    });

    assert.deepEqual(evidence.playbackSequence, []);
    assert.equal(evidence.startedPlaybackCount, 0);
    assert.equal(evidence.stoppedPlaybackCount, 0);
});

test('captures only appended primary log bytes and transcode file activity', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'webgpu-server-log-'));
    try {
        const primaryLogPath = path.join(temporaryDirectory, 'log_20260803.log');
        await writeFile(primaryLogPath, `${createLogLine(
            'INF',
            'Server.Startup',
            'Existing line outside the capture window'
        )}\n`, 'utf8');
        for (let transcodeIndex = 0; transcodeIndex < 65; transcodeIndex += 1) {
            await writeFile(
                path.join(
                    temporaryDirectory,
                    `FFmpeg.Transcode-historical-${transcodeIndex}.log`
                ),
                'historical transcode output',
                'utf8'
            );
        }
        const capture = await beginServerLogCapture(temporaryDirectory);
        await appendFile(primaryLogPath, `${[
            createPolicyLine(),
            createStartLine(),
            createStopLine()
        ].join('\n')}\n`, 'utf8');
        await writeFile(
            path.join(temporaryDirectory, 'FFmpeg.Transcode-private.log'),
            'private raw ffmpeg command',
            'utf8'
        );

        const evidence = await finishServerLogCapture(capture, MATCH, 1, {
            pollIntervalMilliseconds: 1,
            timeoutMilliseconds: 100
        });

        assert.equal(evidence.status, 'captured');
        assert.equal(evidence.changedPrimaryLogCount, 1);
        assert.equal(evidence.transcodeLogActivityCount, 1);
        assert.deepEqual(evidence.playbackSequence, [ 'start', 'stop' ]);
        assert.ok(evidence.appendedByteCount > 0);
        assert.ok(!JSON.stringify(evidence).includes('private raw ffmpeg command'));
        assert.ok(!JSON.stringify(evidence).includes('FFmpeg.Transcode-private.log'));
    } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
    }
});

test('validates exact lifecycle counts and rejects DirectPlay transcode activity', () => {
    const evidence = {
        appendedByteCount: 512,
        changedPrimaryLogCount: 1,
        errorCount: 0,
        parsedLineCount: 3,
        playbackSequence: [ 'start', 'stop' ],
        policyRecords: [ {
            audioTranscodingEnabled: true,
            remuxingEnabled: true,
            videoTranscodingEnabled: true
        } ],
        startedPlaybackCount: 1,
        status: 'captured',
        stoppedPlaybackCount: 1,
        transcodeLogActivityCount: 0,
        warningCount: 0
    };

    assert.deepEqual(validateServerLogEvidence(evidence, {
        expectedPlayMethod: 'DirectPlay',
        expectedSessionCount: 1
    }), []);
    const failures = validateServerLogEvidence({
        ...evidence,
        errorCount: 1,
        playbackSequence: [ 'start' ],
        stoppedPlaybackCount: 0,
        transcodeLogActivityCount: 1
    }, {
        expectedPlayMethod: 'DirectPlay',
        expectedSessionCount: 1
    });
    assert.ok(failures.includes('server-log-stop-count-mismatch'));
    assert.ok(failures.includes('server-log-playback-sequence-mismatch'));
    assert.ok(failures.includes('server-log-error'));
    assert.ok(failures.includes('server-log-unexpected-transcode'));
});
