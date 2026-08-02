import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    DEFAULT_RETENTION_CONSTRUCTOR_EXPRESSIONS,
    collectCDPRetentionSnapshot,
    countCustomDecodeWorkerTargets,
    normalizeCDPPerformanceMetrics
} from './cdp-retention-snapshot.mjs';

const EXPECTED_DEFAULT_CONSTRUCTORS = [
    'AudioContext',
    'AudioWorkletNode',
    'GPUBuffer',
    'GPUBindGroup',
    'GPUDevice',
    'GPUExternalTexture',
    'GPURenderPipeline',
    'GPUSampler',
    'GPUTexture',
    'HTMLCanvasElement',
    'VideoFrame',
    'WebAssembly.Memory',
    'Worker'
];

function createCommandMock(handlers) {
    const calls = [];
    const send = async (method, parameters = {}) => {
        calls.push({ method, parameters });
        const handler = handlers.shift();
        assert.ok(handler, `Unexpected CDP command: ${method}`);
        assert.equal(method, handler.method);
        if (handler.error) {
            throw handler.error;
        }
        return handler.result;
    };
    return { calls, send };
}

test('defines the complete default retention constructor set', () => {
    assert.deepEqual(
        Object.keys(DEFAULT_RETENTION_CONSTRUCTOR_EXPRESSIONS).sort(),
        EXPECTED_DEFAULT_CONSTRUCTORS.sort()
    );
});

test('collects normalized values in stable command order without forcing garbage collection', async () => {
    const commandMock = createCommandMock([
        {
            method: 'Runtime.getHeapUsage',
            result: {
                backingStorageSize: 1_024.4,
                embedderHeapUsedSize: 2_048.4,
                totalSize: 8_192,
                usedSize: 4_096
            }
        },
        {
            method: 'Memory.getDOMCounters',
            result: { documents: 2, jsEventListeners: 9, nodes: 125 }
        },
        {
            method: 'Performance.getMetrics',
            result: {
                metrics: [
                    { name: 'Documents', value: 2 },
                    { name: 'TaskDuration', value: 0.125 },
                    { name: 'JSHeapUsedSize', value: 4_096 }
                ]
            }
        },
        {
            method: 'Runtime.evaluate',
            result: { result: { objectId: 'video-frame-prototype', type: 'object' } }
        },
        {
            method: 'Runtime.queryObjects',
            result: { objects: { objectId: 'video-frame-objects', type: 'object' } }
        },
        {
            method: 'Runtime.callFunctionOn',
            result: { result: { type: 'number', value: 3 } }
        },
        {
            method: 'Runtime.evaluate',
            result: { result: { subtype: 'null', type: 'object', value: null } }
        },
        { method: 'Runtime.releaseObjectGroup', result: {} }
    ]);
    const CDPSession = {
        prefix: 'bound-session',
        send(method, parameters) {
            assert.equal(this.prefix, 'bound-session');
            return commandMock.send(method, parameters);
        }
    };

    const snapshot = await collectCDPRetentionSnapshot(CDPSession, 7, {
        constructorExpressions: {
            VideoFrame: 'globalThis.VideoFrame',
            GPUTexture: 'globalThis.GPUTexture'
        },
        workerTargets: {
            targetInfos: [
                {
                    targetId: 'decode-worker',
                    type: 'worker',
                    url: 'http://localhost:8080/CustomDecode.worker.bundle.js'
                },
                {
                    targetId: 'capability-worker',
                    type: 'worker',
                    url: 'http://localhost:8080/HEVCExactCapabilityProbe.worker.bundle.js'
                },
                {
                    targetId: 'service-worker',
                    type: 'service_worker',
                    url: 'http://localhost:8080/serviceworker.js'
                }
            ]
        }
    });

    assert.deepEqual(
        commandMock.calls.map(call => call.method),
        [
            'Runtime.getHeapUsage',
            'Memory.getDOMCounters',
            'Performance.getMetrics',
            'Runtime.evaluate',
            'Runtime.queryObjects',
            'Runtime.callFunctionOn',
            'Runtime.evaluate',
            'Runtime.releaseObjectGroup'
        ]
    );
    assert.deepEqual(snapshot.heapUsage, {
        backingStorageSizeBytes: 1_024,
        embedderHeapUsedSizeBytes: 2_048,
        totalSizeBytes: 8_192,
        usedSizeBytes: 4_096
    });
    assert.deepEqual(snapshot.DOMCounters, {
        documents: 2,
        eventListeners: 9,
        nodes: 125
    });
    assert.deepEqual(snapshot.liveObjects, {
        GPUTexture: { available: false, count: null },
        VideoFrame: { available: true, count: 3 }
    });
    assert.deepEqual(snapshot.performanceMetrics, {
        bytes: { JSHeapUsedSize: 4_096 },
        counts: { Documents: 2 },
        durationsMicroseconds: { TaskDuration: 125_000 },
        timestampsMicroseconds: {}
    });
    assert.deepEqual(snapshot.workerTargets, {
        customDecodeWorkerTargetCount: 1,
        workerTargetCount: 2
    });
    assert.equal(snapshot.forcedGarbageCollection, false);
    assert.equal(Number.isSafeInteger(snapshot.capturedAtMicroseconds), true);
    assert.equal(Number.isSafeInteger(snapshot.collectionDurationMicroseconds), true);
    assert.doesNotThrow(() => JSON.stringify(snapshot));
    assert.deepEqual(commandMock.calls.at(-1).parameters, {
        objectGroup: 'jellyfin-webgpu-retention-7'
    });
});

test('releases the object group when a live-object query fails', async () => {
    const queryFailure = new Error('query failed');
    const commandMock = createCommandMock([
        { method: 'Runtime.getHeapUsage', result: {} },
        { method: 'Memory.getDOMCounters', result: {} },
        { method: 'Performance.getMetrics', result: { metrics: [] } },
        {
            method: 'Runtime.evaluate',
            result: { result: { objectId: 'prototype', type: 'object' } }
        },
        { error: queryFailure, method: 'Runtime.queryObjects' },
        { method: 'Runtime.releaseObjectGroup', result: {} }
    ]);

    await assert.rejects(
        collectCDPRetentionSnapshot(commandMock.send, 12, {
            constructorExpressions: { VideoFrame: 'globalThis.VideoFrame' }
        }),
        queryFailure
    );
    assert.deepEqual(
        commandMock.calls.map(call => call.method),
        [
            'Runtime.getHeapUsage',
            'Memory.getDOMCounters',
            'Performance.getMetrics',
            'Runtime.evaluate',
            'Runtime.queryObjects',
            'Runtime.releaseObjectGroup'
        ]
    );
});

test('normalizes duration, timestamp, byte, count, and invalid metrics', () => {
    const metrics = normalizeCDPPerformanceMetrics([
        { name: 'TaskDuration', value: 0.0000015 },
        { name: 'ThreadTime', value: 1.25 },
        { name: 'Timestamp', value: 51.0000004 },
        { name: 'NavigationStart', value: Number.NaN },
        { name: 'JSHeapTotalSize', value: 12_345.6 },
        { name: 'Documents', value: 4 },
        { name: 'Frames', value: Number.POSITIVE_INFINITY },
        { name: '', value: 100 },
        null
    ]);

    assert.deepEqual(metrics, {
        bytes: { JSHeapTotalSize: 12_346 },
        counts: { Documents: 4, Frames: null },
        durationsMicroseconds: { TaskDuration: 2, ThreadTime: 1_250_000 },
        timestampsMicroseconds: { NavigationStart: null, Timestamp: 51_000_000 }
    });
});

test('reports missing and throwing constructor expressions without querying objects', async () => {
    const commandMock = createCommandMock([
        { method: 'Runtime.getHeapUsage', result: {} },
        { method: 'Memory.getDOMCounters', result: {} },
        { method: 'Performance.getMetrics', result: { metrics: [] } },
        {
            method: 'Runtime.evaluate',
            result: { result: { subtype: 'null', type: 'object', value: null } }
        },
        {
            method: 'Runtime.evaluate',
            result: {
                exceptionDetails: { text: 'ReferenceError' },
                result: { type: 'undefined' }
            }
        },
        { method: 'Runtime.releaseObjectGroup', result: {} }
    ]);

    const snapshot = await collectCDPRetentionSnapshot(commandMock.send, 9, {
        constructorExpressions: {
            GPUExternalTexture: 'globalThis.GPUExternalTexture',
            GPUTexture: 'throwingConstructorExpression'
        }
    });

    assert.deepEqual(snapshot.liveObjects, {
        GPUExternalTexture: { available: false, count: null },
        GPUTexture: { available: false, count: null }
    });
    assert.equal(
        commandMock.calls.some(call => call.method === 'Runtime.queryObjects'),
        false
    );
});

test('filters custom decode workers from direct data and a target-query callback', async () => {
    const PuppeteerWorkerTarget = {
        type: () => 'worker',
        url: () => 'https://frontend.test/CustomDecode.worker.0123456789abcdef.bundle.js'
    };
    const targetData = [
        PuppeteerWorkerTarget,
        {
            title: 'CustomDecode.worker.fedcba9876543210.bundle.js',
            type: 'worker',
            url: 'blob:opaque'
        },
        { type: 'worker', url: 'https://frontend.test/other.worker.js' },
        { type: 'page', url: 'https://frontend.test/CustomDecode.worker.bundle.js' }
    ];
    assert.deepEqual(countCustomDecodeWorkerTargets(targetData), {
        customDecodeWorkerTargetCount: 2,
        workerTargetCount: 3
    });

    const commandMock = createCommandMock([
        { method: 'Runtime.getHeapUsage', result: {} },
        { method: 'Memory.getDOMCounters', result: {} },
        { method: 'Performance.getMetrics', result: { metrics: [] } },
        { method: 'Runtime.releaseObjectGroup', result: {} }
    ]);
    let targetQueryCount = 0;
    const snapshot = await collectCDPRetentionSnapshot(commandMock.send, 3, {
        constructorExpressions: {},
        queryWorkerTargets: async () => {
            targetQueryCount += 1;
            return targetData;
        }
    });
    assert.equal(targetQueryCount, 1);
    assert.deepEqual(snapshot.workerTargets, {
        customDecodeWorkerTargetCount: 2,
        workerTargetCount: 3
    });
});

test('counts only workers opened by the controlled page and browser context', () => {
    const targetData = {
        targetInfos: [
            {
                browserContextId: 'controlled-context',
                openerId: 'controlled-page',
                targetId: 'controlled-custom-worker',
                type: 'worker',
                url: 'https://frontend.test/CustomDecode.worker.bundle.js'
            },
            {
                browserContextId: 'controlled-context',
                openerId: 'controlled-page',
                targetId: 'controlled-other-worker',
                type: 'worker',
                url: 'https://frontend.test/other.worker.js'
            },
            {
                browserContextId: 'controlled-context',
                openerId: 'unrelated-page',
                targetId: 'unrelated-same-context-worker',
                type: 'worker',
                url: 'https://frontend.test/CustomDecode.worker.bundle.js'
            },
            {
                browserContextId: 'unrelated-context',
                openerId: 'controlled-page',
                targetId: 'unrelated-context-worker',
                type: 'worker',
                url: 'https://frontend.test/CustomDecode.worker.bundle.js'
            }
        ]
    };

    assert.deepEqual(countCustomDecodeWorkerTargets(targetData, null, {
        browserContextID: 'controlled-context',
        pageTargetID: 'controlled-page'
    }), {
        customDecodeWorkerTargetCount: 1,
        workerTargetCount: 2
    });
    assert.throws(
        () => countCustomDecodeWorkerTargets(targetData, null, {}),
        /page target ID/u
    );
});

test('forces garbage collection only through the explicit option', async () => {
    const commandMock = createCommandMock([
        { method: 'HeapProfiler.collectGarbage', result: {} },
        { method: 'Runtime.getHeapUsage', result: {} },
        { method: 'Memory.getDOMCounters', result: {} },
        { method: 'Performance.getMetrics', result: { metrics: [] } },
        { method: 'Runtime.releaseObjectGroup', result: {} }
    ]);

    const snapshot = await collectCDPRetentionSnapshot(commandMock.send, 1, {
        constructorExpressions: {},
        forceGarbageCollection: true
    });

    assert.equal(snapshot.forcedGarbageCollection, true);
    assert.equal(commandMock.calls[0].method, 'HeapProfiler.collectGarbage');
});
