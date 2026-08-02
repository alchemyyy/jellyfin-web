import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createStructuralFFmpegArguments,
    createStructuralMKVMergeArguments
} from './create-profile7-playback-fixture.mjs';

test('builds a bounded 1080p dual-track structural encode command', () => {
    const argumentsList = createStructuralFFmpegArguments('input.mkv', 'encoded.mkv');

    assert.deepEqual(argumentsList.slice(0, 7), [
        '-hide_banner',
        '-loglevel', 'error',
        '-nostdin',
        '-y',
        '-stream_loop', '9'
    ]);
    assert.equal(argumentsList.includes('scale=1920:1080:flags=lanczos'), true);
    assert.equal(argumentsList.filter(argument => argument === '0:v:0').length, 1);
    assert.equal(argumentsList.filter(argument => argument === '0:v:1').length, 1);
    assert.equal(argumentsList.filter(argument => argument.startsWith('setts=')).length, 2);
    assert.equal(argumentsList.at(-1), 'encoded.mkv');
});

test('normalizes both video tracks to the same deterministic default duration', () => {
    const argumentsList = createStructuralMKVMergeArguments(
        'encoded.mkv',
        'normalized.mkv'
    );

    assert.deepEqual(argumentsList, [
        '--quiet',
        '--output', 'normalized.mkv',
        '--deterministic', 'webgpu-profile7-playback',
        '--no-date',
        '--disable-track-statistics-tags',
        '--default-duration', '0:6000/1001p',
        '--default-duration', '1:6000/1001p',
        'encoded.mkv'
    ]);
});
