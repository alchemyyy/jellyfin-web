import assert from 'node:assert/strict';
import test from 'node:test';

import { selectCustomDecodeWorkerAssetName } from './worker-artifact-name.mjs';

test('selects one content-addressed custom decode worker', () => {
    assert.equal(selectCustomDecodeWorkerAssetName([
        'main.jellyfin.bundle.js',
        'CustomDecode.worker.0123456789abcdef.bundle.js'
    ]), 'CustomDecode.worker.0123456789abcdef.bundle.js');
});

test('prefers a content-addressed worker over the legacy artifact', () => {
    assert.equal(selectCustomDecodeWorkerAssetName([
        'CustomDecode.worker.bundle.js',
        'CustomDecode.worker.fedcba9876543210.bundle.js'
    ]), 'CustomDecode.worker.fedcba9876543210.bundle.js');
});

test('fails closed for ambiguous content-addressed workers', () => {
    assert.equal(selectCustomDecodeWorkerAssetName([
        'CustomDecode.worker.0123456789abcdef.bundle.js',
        'CustomDecode.worker.fedcba9876543210.bundle.js'
    ]), null);
});

test('supports a legacy build and rejects unrelated artifacts', () => {
    assert.equal(selectCustomDecodeWorkerAssetName([
        'CustomDecode.worker.bundle.js'
    ]), 'CustomDecode.worker.bundle.js');
    assert.equal(selectCustomDecodeWorkerAssetName([
        'CustomDecode.worker.short.bundle.js',
        'HEVCExactCapabilityProbe.worker.0123456789abcdef.bundle.js'
    ]), null);
});

test('rejects malformed artifact lists', () => {
    assert.throws(
        () => selectCustomDecodeWorkerAssetName([ 'worker.js', 1 ]),
        /string array/u
    );
});
