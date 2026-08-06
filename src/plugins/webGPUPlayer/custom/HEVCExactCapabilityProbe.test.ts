import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    BundledHEVCExactCapabilityProbe,
    type HEVCExactCapabilityProbeEnvironment,
    type HEVCExactCapabilityProbeWorker
} from './HEVCExactCapabilityProbe';
import {
    HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS,
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    type HEVCExactCapabilityFixture,
    type HEVCExactCapabilityWorkerQualificationResult,
    type HEVCExactCapabilityWorkerResponse
} from './HEVCExactCapabilityProtocol';

type WorkerEventType = 'error' | 'message' | 'messageerror';
type WorkerEventListener = (event: Event) => void;

class MockCapabilityWorker implements HEVCExactCapabilityProbeWorker {
    public readonly listeners = new Map<WorkerEventType, Set<WorkerEventListener>>();
    public readonly postedMessages: unknown[] = [];
    public readonly postedTransfers: Transferable[][] = [];
    public postMessageError: Error | null = null;
    public terminateCount = 0;

    public addEventListener(type: WorkerEventType, listener: WorkerEventListener): void {
        let listeners = this.listeners.get(type);
        if (!listeners) {
            listeners = new Set<WorkerEventListener>();
            this.listeners.set(type, listeners);
        }
        listeners.add(listener);
    }

    public postMessage(message: unknown, transfer: Transferable[]): void {
        if (this.postMessageError) {
            throw this.postMessageError;
        }
        this.postedMessages.push(message);
        this.postedTransfers.push(transfer);
    }

    public removeEventListener(type: WorkerEventType, listener: WorkerEventListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    public terminate(): void {
        this.terminateCount += 1;
    }

    public emit(type: WorkerEventType, data?: unknown): void {
        const event = type === 'message' ?
            new MessageEvent<unknown>('message', { data }) :
            new Event(type);
        for (const listener of [ ...(this.listeners.get(type) ?? []) ]) {
            listener(event);
        }
    }

    public listenerCount(): number {
        let count = 0;
        for (const listeners of this.listeners.values()) {
            count += listeners.size;
        }
        return count;
    }
}

function getExpectedDecodedByteLength(fixture: HEVCExactCapabilityFixture): number {
    const definition = HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS[fixture];
    return (
        (definition.codedWidth * definition.codedHeight)
        + (2 * Math.ceil(definition.codedWidth / 2) * Math.ceil(definition.codedHeight / 2))
    ) * Uint16Array.BYTES_PER_ELEMENT;
}

function createSuccessfulQualificationResult(
    fixture: HEVCExactCapabilityFixture,
    overrides: Partial<HEVCExactCapabilityWorkerQualificationResult> = {}
): HEVCExactCapabilityWorkerQualificationResult {
    const definition = HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS[fixture];
    const decodedFrameFingerprints = overrides.decodedFrameFingerprints === undefined ?
        definition.decodedFrameFingerprints :
        overrides.decodedFrameFingerprints;
    return {
        bitDepth: definition.bitDepth,
        chromaHeight: Math.ceil(definition.codedHeight / 2),
        chromaWidth: Math.ceil(definition.codedWidth / 2),
        codedHeight: definition.codedHeight,
        codedWidth: definition.codedWidth,
        decodedFrameCount: definition.qualificationFrameCount,
        decodedByteLength: getExpectedDecodedByteLength(fixture),
        fixture,
        levelIDC: definition.levelIDC,
        profileIDC: definition.profileIDC,
        reason: 'decode-output-verified',
        supported: true,
        totalDecodedByteLength: getExpectedDecodedByteLength(fixture)
            * definition.qualificationFrameCount,
        ...overrides,
        decodedFrameFingerprints
    };
}

function createSuccessfulResponse(): HEVCExactCapabilityWorkerResponse {
    return {
        requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
        results: [
            createSuccessfulQualificationResult('main-1080p'),
            createSuccessfulQualificationResult('main10-1080p'),
            createSuccessfulQualificationResult('main10-4k')
        ],
        type: 'result'
    };
}

function createEnvironment(
    worker: MockCapabilityWorker,
    overrides: Partial<HEVCExactCapabilityProbeEnvironment> = {}
): HEVCExactCapabilityProbeEnvironment {
    const qualificationByteLength = HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS[
        'main10-4k'
    ].qualificationAccessUnitByteLengths.reduce(
        (totalByteLength, byteLength) => totalByteLength + byteLength,
        0
    );
    return {
        clearTimeout: (timeout): void => globalThis.clearTimeout(timeout),
        createWorker: (): MockCapabilityWorker => worker,
        loadQualificationBitstream: async (): Promise<ArrayBuffer> => (
            new ArrayBuffer(qualificationByteLength)
        ),
        resolveAssetURL: (path: string): string => `https://example.test/web/${path}`,
        runtimeAvailable: true,
        setTimeout: (callback, milliseconds): ReturnType<typeof globalThis.setTimeout> => (
            globalThis.setTimeout(callback, milliseconds)
        ),
        ...overrides
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('BundledHEVCExactCapabilityProbe', () => {
    it('qualifies exact output, transfers fixtures, freezes, and caches the result', async () => {
        const worker = new MockCapabilityWorker();
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker));

        const firstPromise = probe.probe();
        const secondPromise = probe.probe();
        expect(secondPromise).toBe(firstPromise);
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        expect(worker.postedMessages).toHaveLength(1);
        expect(worker.postedTransfers[0]).toHaveLength(27);
        expect(worker.postedMessages[0]).toMatchObject({
            decoderGlueURL: 'https://example.test/web/libraries/hevcjs/hevc-decode.js',
            decoderWASMURL: 'https://example.test/web/libraries/hevcjs/hevc-decode.wasm',
            requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
            type: 'probe'
        });

        worker.emit('message', createSuccessfulResponse());
        const capabilities = await firstPromise;

        expect(capabilities).toMatchObject({
            qualifications: {
                'main-1080p': {
                    format: 'I420',
                    reason: 'decode-output-verified',
                    status: 'supported'
                },
                'main10-4k': {
                    format: 'I420P10',
                    reason: 'decode-output-verified',
                    status: 'supported'
                },
                'main10-1080p': {
                    format: 'I420P10',
                    reason: 'decode-output-verified',
                    status: 'supported'
                }
            },
            reason: 'complete'
        });
        expect(Object.isFrozen(capabilities)).toBe(true);
        expect(Object.isFrozen(capabilities.qualifications)).toBe(true);
        expect(Object.isFrozen(capabilities.qualifications['main10-4k'])).toBe(true);
        expect(worker.terminateCount).toBe(1);
        expect(worker.listenerCount()).toBe(0);
        expect(await probe.probe()).toBe(capabilities);
    });

    it('preserves an independently failed qualification as a partial result', async () => {
        const worker = new MockCapabilityWorker();
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker));
        const resultPromise = probe.probe();
        const response = createSuccessfulResponse();
        worker.emit('message', {
            ...response,
            results: [
                response.results[0],
                response.results[1],
                {
                    bitDepth: null,
                    chromaHeight: null,
                    chromaWidth: null,
                    codedHeight: null,
                    codedWidth: null,
                    decodedFrameFingerprints: null,
                    decodedFrameCount: null,
                    decodedByteLength: null,
                    levelIDC: null,
                    profileIDC: null,
                    reason: 'decode-error',
                    supported: false,
                    fixture: 'main10-4k',
                    totalDecodedByteLength: null
                }
            ]
        });

        const capabilities = await resultPromise;
        expect(capabilities.reason).toBe('partial');
        expect(capabilities.qualifications['main-1080p'].status).toBe('supported');
        expect(capabilities.qualifications['main10-4k']).toMatchObject({
            reason: 'decode-error',
            status: 'unsupported'
        });
    });

    it('rejects a worker success summary that contradicts its fixture', async () => {
        const worker = new MockCapabilityWorker();
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker));
        const resultPromise = probe.probe();
        const response = createSuccessfulResponse();
        worker.emit('message', {
            ...response,
            results: [
                response.results[0],
                response.results[1],
                createSuccessfulQualificationResult('main10-4k', { codedWidth: 1_920 })
            ]
        });

        const capabilities = await resultPromise;
        expect(capabilities.reason).toBe('partial');
        expect(capabilities.qualifications['main10-4k']).toMatchObject({
            reason: 'output-mismatch',
            status: 'unsupported'
        });
    });

    it.each([
        [ 'error', 'worker-error' ],
        [ 'messageerror', 'worker-message-invalid' ]
    ] as const)('fails closed on a worker %s event', async (eventType, reason) => {
        const worker = new MockCapabilityWorker();
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker));
        const resultPromise = probe.probe();
        worker.emit(eventType);

        const capabilities = await resultPromise;
        expect(capabilities.reason).toBe('failed');
        expect(capabilities.qualifications['main-1080p'].reason).toBe(reason);
        expect(capabilities.qualifications['main10-4k'].reason).toBe(reason);
        expect(worker.terminateCount).toBe(1);
        expect(worker.listenerCount()).toBe(0);
    });

    it('fails closed and cleans up after the bounded timeout', async () => {
        vi.useFakeTimers();
        const worker = new MockCapabilityWorker();
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker), 50);
        const resultPromise = probe.probe();
        await vi.advanceTimersByTimeAsync(50);

        const capabilities = await resultPromise;
        expect(capabilities.qualifications['main-1080p'].reason).toBe('probe-timeout');
        expect(capabilities.qualifications['main10-4k'].reason).toBe('probe-timeout');
        expect(worker.terminateCount).toBe(1);
        expect(worker.listenerCount()).toBe(0);
    });

    it('fails closed without constructing a worker when runtime APIs are unavailable', async () => {
        const worker = new MockCapabilityWorker();
        const createWorker = vi.fn((): MockCapabilityWorker => worker);
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker, {
            createWorker,
            runtimeAvailable: false
        }));

        const capabilities = await probe.probe();
        expect(capabilities.reason).toBe('unavailable');
        expect(capabilities.qualifications['main-1080p'].reason).toBe('api-unavailable');
        expect(createWorker).not.toHaveBeenCalled();
    });

    it('caches worker creation and postMessage failures', async () => {
        const creationProbe = new BundledHEVCExactCapabilityProbe({
            ...createEnvironment(new MockCapabilityWorker()),
            createWorker: (): never => {
                throw new Error('create failed');
            }
        });
        const creationResult = await creationProbe.probe();
        expect(creationResult.qualifications['main10-4k'].reason).toBe(
            'worker-create-failed'
        );
        expect(await creationProbe.probe()).toBe(creationResult);

        const worker = new MockCapabilityWorker();
        worker.postMessageError = new Error('post failed');
        const postProbe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker));
        const postResult = await postProbe.probe();
        expect(postResult.qualifications['main10-4k'].reason).toBe('worker-error');
        expect(worker.terminateCount).toBe(1);
        expect(worker.listenerCount()).toBe(0);
    });

    it('fails closed when the external qualification fixture cannot load', async () => {
        const worker = new MockCapabilityWorker();
        const loadQualificationBitstream = vi.fn(async (): Promise<ArrayBuffer> => {
            throw new Error('fixture unavailable');
        });
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker, {
            loadQualificationBitstream
        }));

        const capabilities = await probe.probe();

        expect(loadQualificationBitstream).toHaveBeenCalledWith(
            'https://example.test/web/libraries/hevcjs/main10-4k-qualification.bin'
        );
        expect(capabilities.reason).toBe('failed');
        expect(capabilities.qualifications['main10-4k'].reason).toBe('worker-error');
        expect(worker.postedMessages).toHaveLength(0);
        expect(worker.terminateCount).toBe(1);
    });

    it('rejects malformed worker messages and ignores later events', async () => {
        const worker = new MockCapabilityWorker();
        const probe = new BundledHEVCExactCapabilityProbe(createEnvironment(worker));
        const resultPromise = probe.probe();
        worker.emit('message', { type: 'result', results: [] });
        worker.emit('message', createSuccessfulResponse());

        const capabilities = await resultPromise;
        expect(capabilities.qualifications['main10-4k'].reason).toBe(
            'worker-message-invalid'
        );
        expect(worker.terminateCount).toBe(1);
    });
});
