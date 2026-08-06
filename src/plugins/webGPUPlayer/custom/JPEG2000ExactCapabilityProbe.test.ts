import { afterEach, describe, expect, it, vi } from 'vitest';

import JPEG2000ExactCapabilityProbe, {
    type JPEG2000ExactCapabilityProbeEnvironment,
    type JPEG2000ExactCapabilityProbeWorker
} from './JPEG2000ExactCapabilityProbe';
import {
    isJPEG2000ExactCapabilityWorkerRequest,
    JPEG2000_EXACT_CAPABILITY_REQUEST_ID,
    JPEG2000_QUALIFICATION_CODED_HEIGHT,
    JPEG2000_QUALIFICATION_CODED_WIDTH,
    JPEG2000_QUALIFICATION_RGBA_BYTE_LENGTH,
    JPEG2000_QUALIFICATION_RGBA_FINGERPRINT,
    type JPEG2000ExactCapabilityWorkerResponse
} from './JPEG2000ExactCapabilityProtocol';

type WorkerEventType = 'error' | 'message' | 'messageerror';
type WorkerEventListener = (event: Event) => void;

class MockJPEG2000CapabilityWorker implements JPEG2000ExactCapabilityProbeWorker {
    private readonly listeners = new Map<WorkerEventType, Set<WorkerEventListener>>();
    public readonly postedMessages: unknown[] = [];
    public readonly postedTransfers: Transferable[][] = [];
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
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

function createEnvironment(
    worker: MockJPEG2000CapabilityWorker,
    overrides: Partial<JPEG2000ExactCapabilityProbeEnvironment> = {}
): JPEG2000ExactCapabilityProbeEnvironment {
    return {
        clearTimeout: (timeout): void => globalThis.clearTimeout(timeout),
        createWorker: (): MockJPEG2000CapabilityWorker => worker,
        loadFixture: async (): Promise<ArrayBuffer> => new ArrayBuffer(128),
        resolveAssetURL: (path: string): string => `https://example.test/web/${path}`,
        runtimeAvailable: true,
        setTimeout: (callback, milliseconds): ReturnType<typeof globalThis.setTimeout> => (
            globalThis.setTimeout(callback, milliseconds)
        ),
        ...overrides
    };
}

function createSuccessfulResponse(
    overrides: Partial<JPEG2000ExactCapabilityWorkerResponse> = {}
): JPEG2000ExactCapabilityWorkerResponse {
    return {
        codedHeight: JPEG2000_QUALIFICATION_CODED_HEIGHT,
        codedWidth: JPEG2000_QUALIFICATION_CODED_WIDTH,
        decodedRGBAByteLength: JPEG2000_QUALIFICATION_RGBA_BYTE_LENGTH,
        decodedRGBAFingerprint: JPEG2000_QUALIFICATION_RGBA_FINGERPRINT,
        reason: 'decode-output-verified',
        requestID: JPEG2000_EXACT_CAPABILITY_REQUEST_ID,
        supported: true,
        type: 'result',
        ...overrides
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('JPEG2000ExactCapabilityProbe', () => {
    it('qualifies exact output, transfers the fixture, freezes, and caches', async () => {
        const worker = new MockJPEG2000CapabilityWorker();
        const probe = new JPEG2000ExactCapabilityProbe(createEnvironment(worker));

        const firstPromise = probe.probe();
        expect(probe.probe()).toBe(firstPromise);
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        expect(isJPEG2000ExactCapabilityWorkerRequest(worker.postedMessages[0])).toBe(true);
        expect(worker.postedTransfers[0]).toHaveLength(1);

        worker.emit('message', createSuccessfulResponse());
        const capability = await firstPromise;

        expect(capability).toMatchObject({
            reason: 'decode-output-verified',
            status: 'supported'
        });
        expect(capability).not.toHaveProperty('maximumCodedHeight');
        expect(capability).not.toHaveProperty('maximumCodedWidth');
        expect(capability).not.toHaveProperty('maximumFramesPerSecond');
        expect(Object.isFrozen(capability)).toBe(true);
        expect(worker.terminateCount).toBe(1);
    });

    it('fails closed when the worker output fingerprint differs', async () => {
        const worker = new MockJPEG2000CapabilityWorker();
        const probe = new JPEG2000ExactCapabilityProbe(createEnvironment(worker));
        const capabilityPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));

        worker.emit('message', createSuccessfulResponse({
            decodedRGBAFingerprint: JPEG2000_QUALIFICATION_RGBA_FINGERPRINT + 1
        }));

        await expect(capabilityPromise).resolves.toMatchObject({
            reason: 'output-mismatch',
            status: 'unsupported'
        });
    });

    it('returns unknown without creating a worker when the runtime is unavailable', async () => {
        const worker = new MockJPEG2000CapabilityWorker();
        const environment = createEnvironment(worker, {
            createWorker: null,
            runtimeAvailable: false
        });

        await expect(new JPEG2000ExactCapabilityProbe(environment).probe()).resolves.toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
        expect(worker.terminateCount).toBe(0);
    });

    it('bounds a worker that never responds', async () => {
        vi.useFakeTimers();
        const worker = new MockJPEG2000CapabilityWorker();
        const probe = new JPEG2000ExactCapabilityProbe(createEnvironment(worker), 20);
        const capabilityPromise = probe.probe();

        await vi.advanceTimersByTimeAsync(20);

        await expect(capabilityPromise).resolves.toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(worker.terminateCount).toBe(1);
    });
});
