const MICROSECONDS_PER_SECOND = 1_000_000;
const RETENTION_SNAPSHOT_SCHEMA_VERSION = 1;
const CUSTOM_DECODE_WORKER_URL_PATTERN =
    /(?:^|[/\\])CustomDecode\.worker(?:\.[a-f0-9]{8,64})?(?:\.bundle)?\.js(?:[?#]|$)/iu;
const PERFORMANCE_BYTE_METRICS = new Set([
    'JSHeapTotalSize',
    'JSHeapUsedSize'
]);
const PERFORMANCE_TIMESTAMP_METRICS = new Set([
    'DomContentLoaded',
    'FirstMeaningfulPaint',
    'NavigationStart',
    'Timestamp'
]);

export const DEFAULT_RETENTION_CONSTRUCTOR_EXPRESSIONS = Object.freeze({
    AudioContext: 'globalThis.AudioContext',
    AudioWorkletNode: 'globalThis.AudioWorkletNode',
    GPUBuffer: 'globalThis.GPUBuffer',
    GPUBindGroup: 'globalThis.GPUBindGroup',
    GPUDevice: 'globalThis.GPUDevice',
    GPUExternalTexture: 'globalThis.GPUExternalTexture',
    GPURenderPipeline: 'globalThis.GPURenderPipeline',
    GPUSampler: 'globalThis.GPUSampler',
    GPUTexture: 'globalThis.GPUTexture',
    HTMLCanvasElement: 'globalThis.HTMLCanvasElement',
    VideoFrame: 'globalThis.VideoFrame',
    'WebAssembly.Memory': 'globalThis.WebAssembly.Memory',
    Worker: 'globalThis.Worker'
});

function normalizeFiniteInteger(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return null;
    }
    const integerValue = Math.round(value);
    return Number.isSafeInteger(integerValue) ? integerValue : null;
}

function normalizeNonNegativeInteger(value) {
    const integerValue = normalizeFiniteInteger(value);
    return integerValue !== null && integerValue >= 0 ? integerValue : null;
}

function secondsToMicroseconds(seconds) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
        return null;
    }
    return normalizeFiniteInteger(seconds * MICROSECONDS_PER_SECOND);
}

function isPerformanceDurationMetric(name) {
    return name.endsWith('Duration') || name === 'ProcessTime' || name === 'ThreadTime';
}

/** Normalizes CDP performance metrics into integer values with explicit units */
export function normalizeCDPPerformanceMetrics(metrics) {
    const byteEntries = [];
    const countEntries = [];
    const durationEntries = [];
    const timestampEntries = [];
    const metricList = Array.isArray(metrics) ? metrics : [];
    for (const metric of metricList) {
        if (!metric || typeof metric.name !== 'string' || metric.name.length === 0) {
            continue;
        }
        if (PERFORMANCE_BYTE_METRICS.has(metric.name)) {
            byteEntries.push([ metric.name, normalizeNonNegativeInteger(metric.value) ]);
            continue;
        }
        if (PERFORMANCE_TIMESTAMP_METRICS.has(metric.name)) {
            timestampEntries.push([ metric.name, secondsToMicroseconds(metric.value) ]);
            continue;
        }
        if (isPerformanceDurationMetric(metric.name)) {
            durationEntries.push([ metric.name, secondsToMicroseconds(metric.value) ]);
            continue;
        }
        countEntries.push([ metric.name, normalizeNonNegativeInteger(metric.value) ]);
    }
    return {
        bytes: Object.fromEntries(byteEntries),
        counts: Object.fromEntries(countEntries),
        durationsMicroseconds: Object.fromEntries(durationEntries),
        timestampsMicroseconds: Object.fromEntries(timestampEntries)
    };
}

function getCDPSender(CDPClient) {
    if (typeof CDPClient === 'function') {
        return CDPClient;
    }
    if (CDPClient && typeof CDPClient.send === 'function') {
        return CDPClient.send.bind(CDPClient);
    }
    throw new TypeError('Provide a CDP send callback or session with a send method');
}

function requireSessionNumber(sessionNumber) {
    if (!Number.isSafeInteger(sessionNumber) || sessionNumber < 0) {
        throw new RangeError('Retention snapshot session number must be a non-negative safe integer');
    }
}

function normalizeConstructorExpressions(constructorExpressions) {
    if (!constructorExpressions || typeof constructorExpressions !== 'object') {
        throw new TypeError('Retention constructor expressions must be an object');
    }
    const entries = Object.entries(constructorExpressions);
    for (const [ name, expression ] of entries) {
        if (!name || typeof expression !== 'string' || !expression.trim()) {
            throw new TypeError('Each retention constructor must have a name and expression');
        }
    }
    return entries;
}

function createPrototypeExpression(constructorExpression) {
    return `(() => {
        try {
            const Constructor = (${constructorExpression});
            return typeof Constructor === 'function' && Constructor.prototype
                ? Constructor.prototype
                : null;
        } catch {
            return null;
        }
    })()`;
}

function isUnavailableEvaluation(evaluation) {
    return Boolean(
        evaluation?.exceptionDetails
        || evaluation?.result?.subtype === 'null'
        || typeof evaluation?.result?.objectId !== 'string'
    );
}

async function queryLiveObjectCount(sendCommand, name, expression, objectGroup) {
    const prototypeEvaluation = await sendCommand('Runtime.evaluate', {
        expression: createPrototypeExpression(expression),
        objectGroup,
        returnByValue: false,
        silent: true
    });
    if (isUnavailableEvaluation(prototypeEvaluation)) {
        return { available: false, count: null };
    }

    const queryResult = await sendCommand('Runtime.queryObjects', {
        objectGroup,
        prototypeObjectId: prototypeEvaluation.result.objectId
    });
    const queriedObjectsIdentifier = queryResult?.objects?.objectId;
    if (typeof queriedObjectsIdentifier !== 'string') {
        throw new Error(`CDP did not return a queried object array for ${name}`);
    }
    const countEvaluation = await sendCommand('Runtime.callFunctionOn', {
        functionDeclaration: 'function() { return this.length; }',
        objectId: queriedObjectsIdentifier,
        returnByValue: true,
        silent: true
    });
    if (countEvaluation?.exceptionDetails) {
        throw new Error(`CDP could not count queried ${name} objects`);
    }
    return {
        available: true,
        count: normalizeNonNegativeInteger(countEvaluation?.result?.value)
    };
}

function readTargetProperty(target, propertyName) {
    const targetInformation = target?.targetInfo && typeof target.targetInfo === 'object' ?
        target.targetInfo :
        target;
    const value = targetInformation?.[propertyName];
    if (typeof value === 'function') {
        try {
            return value.call(targetInformation);
        } catch {
            return '';
        }
    }
    return typeof value === 'string' ? value : '';
}

function normalizeTarget(target) {
    return {
        browserContextID: readTargetProperty(target, 'browserContextId'),
        openerID: readTargetProperty(target, 'openerId'),
        targetID: readTargetProperty(target, 'targetId'),
        title: readTargetProperty(target, 'title'),
        type: readTargetProperty(target, 'type'),
        url: readTargetProperty(target, 'url')
    };
}

function getTargetList(targetData) {
    if (Array.isArray(targetData)) {
        return targetData;
    }
    return Array.isArray(targetData?.targetInfos) ? targetData.targetInfos : [];
}

function normalizeWorkerTargetScope(targetScope) {
    if (targetScope === null || targetScope === undefined) {
        return null;
    }
    if (!targetScope || typeof targetScope !== 'object' || Array.isArray(targetScope)) {
        throw new TypeError('Worker target scope must be an object');
    }
    const browserContextID = targetScope.browserContextID;
    const pageTargetID = targetScope.pageTargetID;
    if (browserContextID !== undefined
        && (typeof browserContextID !== 'string' || browserContextID.length === 0)) {
        throw new TypeError('Worker browser context ID must be a nonempty string');
    }
    if (typeof pageTargetID !== 'string' || pageTargetID.length === 0) {
        throw new TypeError('Worker page target ID must be a nonempty string');
    }
    return { browserContextID, pageTargetID };
}

function isTargetInScope(target, targetScope) {
    if (!targetScope) {
        return true;
    }
    return target.openerID === targetScope.pageTargetID
        && (targetScope.browserContextID === undefined
            || target.browserContextID === targetScope.browserContextID);
}

/** Counts active dedicated workers running the custom decode bundle */
export function countCustomDecodeWorkerTargets(
    targetData,
    customMatcher = null,
    targetScope = null
) {
    const targets = getTargetList(targetData);
    const normalizedTargetScope = normalizeWorkerTargetScope(targetScope);
    let customDecodeWorkerTargetCount = 0;
    let workerTargetCount = 0;
    for (const target of targets) {
        const normalizedTarget = normalizeTarget(target);
        if (normalizedTarget.type !== 'worker'
            || !isTargetInScope(normalizedTarget, normalizedTargetScope)) {
            continue;
        }
        workerTargetCount += 1;
        let isCustomDecodeWorker = CUSTOM_DECODE_WORKER_URL_PATTERN.test(normalizedTarget.url)
            || CUSTOM_DECODE_WORKER_URL_PATTERN.test(normalizedTarget.title);
        if (customMatcher) {
            isCustomDecodeWorker = Boolean(customMatcher(normalizedTarget));
        }
        if (isCustomDecodeWorker) {
            customDecodeWorkerTargetCount += 1;
        }
    }
    return { customDecodeWorkerTargetCount, workerTargetCount };
}

async function resolveWorkerTargetCounts(options) {
    if (options.workerTargets !== undefined && options.queryWorkerTargets !== undefined) {
        throw new TypeError('Provide worker target data or a target-query callback, not both');
    }
    let targetData = options.workerTargets;
    if (options.queryWorkerTargets !== undefined) {
        if (typeof options.queryWorkerTargets !== 'function') {
            throw new TypeError('Worker target query must be a function');
        }
        targetData = await options.queryWorkerTargets();
    }
    if (targetData === undefined || targetData === null) {
        return {
            customDecodeWorkerTargetCount: null,
            workerTargetCount: null
        };
    }
    return countCustomDecodeWorkerTargets(
        targetData,
        options.customDecodeWorkerMatcher,
        options.workerTargetScope
    );
}

function normalizeHeapUsage(heapUsage) {
    return {
        backingStorageSizeBytes: normalizeNonNegativeInteger(heapUsage?.backingStorageSize),
        embedderHeapUsedSizeBytes: normalizeNonNegativeInteger(heapUsage?.embedderHeapUsedSize),
        totalSizeBytes: normalizeNonNegativeInteger(heapUsage?.totalSize),
        usedSizeBytes: normalizeNonNegativeInteger(heapUsage?.usedSize)
    };
}

function normalizeDOMCounters(DOMCounters) {
    return {
        documents: normalizeNonNegativeInteger(DOMCounters?.documents),
        eventListeners: normalizeNonNegativeInteger(DOMCounters?.jsEventListeners),
        nodes: normalizeNonNegativeInteger(DOMCounters?.nodes)
    };
}

/** Collects one bounded, JSON-serializable CDP retention snapshot */
export async function collectCDPRetentionSnapshot(CDPClient, sessionNumber, options = {}) {
    requireSessionNumber(sessionNumber);
    const sendCommand = getCDPSender(CDPClient);
    const constructorEntries = normalizeConstructorExpressions(
        options.constructorExpressions ?? DEFAULT_RETENTION_CONSTRUCTOR_EXPRESSIONS
    );
    const objectGroup = `jellyfin-webgpu-retention-${sessionNumber}`;
    const capturedAtMicroseconds = Date.now() * 1_000;
    const startedAtNanoseconds = process.hrtime.bigint();
    let collectionFailure = null;
    let snapshot = null;

    try {
        if (options.forceGarbageCollection === true) {
            await sendCommand('HeapProfiler.collectGarbage');
        }
        const heapUsage = await sendCommand('Runtime.getHeapUsage');
        const DOMCounters = await sendCommand('Memory.getDOMCounters');
        const performanceMetrics = await sendCommand('Performance.getMetrics');
        const liveObjectEntries = [];
        for (const [ name, expression ] of constructorEntries) {
            const liveObjectCount = await queryLiveObjectCount(
                sendCommand,
                name,
                expression,
                objectGroup
            );
            liveObjectEntries.push([ name, liveObjectCount ]);
        }
        const workerTargets = await resolveWorkerTargetCounts(options);
        const durationMicroseconds = Number(
            (process.hrtime.bigint() - startedAtNanoseconds) / 1_000n
        );
        snapshot = {
            DOMCounters: normalizeDOMCounters(DOMCounters),
            capturedAtMicroseconds,
            collectionDurationMicroseconds: durationMicroseconds,
            forcedGarbageCollection: options.forceGarbageCollection === true,
            heapUsage: normalizeHeapUsage(heapUsage),
            liveObjects: Object.fromEntries(liveObjectEntries),
            performanceMetrics: normalizeCDPPerformanceMetrics(performanceMetrics?.metrics),
            schemaVersion: RETENTION_SNAPSHOT_SCHEMA_VERSION,
            sessionNumber,
            workerTargets
        };
    } catch (error) {
        collectionFailure = error;
    }

    let releaseFailure = null;
    try {
        await sendCommand('Runtime.releaseObjectGroup', { objectGroup });
    } catch (error) {
        releaseFailure = error;
    }
    if (collectionFailure !== null) {
        throw collectionFailure;
    }
    if (releaseFailure !== null) {
        throw releaseFailure;
    }
    return snapshot;
}
