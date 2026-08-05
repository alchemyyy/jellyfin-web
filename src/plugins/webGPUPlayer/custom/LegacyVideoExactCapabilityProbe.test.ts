import { afterEach, describe, expect, it, vi } from 'vitest';

import LegacyVideoExactCapabilityProbe, {
    type LegacyVideoExactCapabilityProbeEnvironment,
    type LegacyVideoExactCapabilityProbeWorker
} from './LegacyVideoExactCapabilityProbe';
import {
    isLegacyVideoExactCapabilityWorkerRequest,
    LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID,
    LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT,
    LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH,
    LEGACY_VIDEO_QUALIFICATION_FINGERPRINT,
    LEGACY_VIDEO_QUALIFICATION_FRAME_BYTE_LENGTH,
    LEGACY_VIDEO_QUALIFICATION_FRAME_COUNT,
    LEGACY_VIDEO_QUALIFICATION_TOTAL_BYTE_LENGTH,
    VC1_EXACT_CAPABILITY_REQUEST_ID,
    VC1_VIDEO_QUALIFICATION_FINGERPRINT,
    type LegacyVideoExactCapabilityWorkerResponse
} from './LegacyVideoExactCapabilityProtocol';

type WorkerEventType = 'error' | 'message' | 'messageerror';
type WorkerEventListener = (event: Event) => void;

class MockLegacyVideoCapabilityWorker implements LegacyVideoExactCapabilityProbeWorker {
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
    worker: MockLegacyVideoCapabilityWorker,
    overrides: Partial<LegacyVideoExactCapabilityProbeEnvironment> = {}
): LegacyVideoExactCapabilityProbeEnvironment {
    return {
        clearTimeout: (timeout): void => globalThis.clearTimeout(timeout),
        createWorker: (): MockLegacyVideoCapabilityWorker => worker,
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
    overrides: Partial<LegacyVideoExactCapabilityWorkerResponse> = {}
): LegacyVideoExactCapabilityWorkerResponse {
    return {
        codedHeight: LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT,
        codedWidth: LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH,
        decodeMilliseconds: 200,
        decodedFrameByteLength: LEGACY_VIDEO_QUALIFICATION_FRAME_BYTE_LENGTH,
        decodedFrameCount: LEGACY_VIDEO_QUALIFICATION_FRAME_COUNT,
        decodedI420Fingerprint: LEGACY_VIDEO_QUALIFICATION_FINGERPRINT,
        decodedTotalByteLength: LEGACY_VIDEO_QUALIFICATION_TOTAL_BYTE_LENGTH,
        measuredFramesPerSecond: 50,
        reason: 'decode-output-verified',
        requestID: LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID,
        supported: true,
        type: 'result',
        ...overrides
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('LegacyVideoExactCapabilityProbe', () => {
    it('qualifies exact output, transfers the fixture, freezes, and caches', async () => {
        const worker = new MockLegacyVideoCapabilityWorker();
        const probe = new LegacyVideoExactCapabilityProbe(createEnvironment(worker));

        const firstPromise = probe.probe();
        expect(probe.probe()).toBe(firstPromise);
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));
        expect(isLegacyVideoExactCapabilityWorkerRequest(worker.postedMessages[0])).toBe(true);
        expect(worker.postedTransfers[0]).toHaveLength(1);

        worker.emit('message', createSuccessfulResponse());
        const capability = await firstPromise;

        expect(capability).toMatchObject({
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            maximumFramesPerSecond: 24,
            reason: 'decode-output-verified',
            status: 'supported'
        });
        expect(Object.isFrozen(capability)).toBe(true);
        expect(worker.terminateCount).toBe(1);
    });

    it('fails closed when the worker fingerprint differs', async () => {
        const worker = new MockLegacyVideoCapabilityWorker();
        const probe = new LegacyVideoExactCapabilityProbe(createEnvironment(worker));
        const capabilityPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));

        worker.emit('message', createSuccessfulResponse({
            decodedI420Fingerprint: LEGACY_VIDEO_QUALIFICATION_FINGERPRINT + 1
        }));

        await expect(capabilityPromise).resolves.toMatchObject({
            maximumFramesPerSecond: 0,
            reason: 'output-mismatch',
            status: 'unsupported'
        });
    });

    it('selects and independently qualifies the Advanced VC-1 fixture', async () => {
        const worker = new MockLegacyVideoCapabilityWorker();
        const loadFixture = vi.fn<
            (url: string) => Promise<ArrayBuffer>
        >(async (): Promise<ArrayBuffer> => new ArrayBuffer(128));
        const probe = new LegacyVideoExactCapabilityProbe(
            createEnvironment(worker, { loadFixture }),
            5_000,
            'vc1'
        );
        const capabilityPromise = probe.probe();
        await vi.waitFor(() => expect(worker.postedMessages).toHaveLength(1));

        expect(loadFixture).toHaveBeenCalledWith(
            'https://example.test/web/libraries/legacy-video/'
                + 'vc1-advanced-progressive-1920x1080-qualification.bin'
        );
        expect(worker.postedMessages[0]).toMatchObject({
            requestID: VC1_EXACT_CAPABILITY_REQUEST_ID
        });
        worker.emit('message', createSuccessfulResponse({
            decodedI420Fingerprint: VC1_VIDEO_QUALIFICATION_FINGERPRINT,
            measuredFramesPerSecond: 24,
            requestID: VC1_EXACT_CAPABILITY_REQUEST_ID
        }));

        await expect(capabilityPromise).resolves.toMatchObject({
            codec: 'vc1',
            maximumFramesPerSecond: 24,
            reason: 'decode-output-verified',
            status: 'supported'
        });
    });

    it('returns unknown without creating a worker when the runtime is unavailable', async () => {
        const worker = new MockLegacyVideoCapabilityWorker();
        const environment = createEnvironment(worker, {
            createWorker: null,
            runtimeAvailable: false
        });

        await expect(new LegacyVideoExactCapabilityProbe(environment).probe())
            .resolves.toMatchObject({
                reason: 'api-unavailable',
                status: 'unknown'
            });
        expect(worker.terminateCount).toBe(0);
    });

    it('bounds a worker that never responds', async () => {
        vi.useFakeTimers();
        const worker = new MockLegacyVideoCapabilityWorker();
        const probe = new LegacyVideoExactCapabilityProbe(createEnvironment(worker), 20);
        const capabilityPromise = probe.probe();

        await vi.advanceTimersByTimeAsync(20);

        await expect(capabilityPromise).resolves.toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(worker.terminateCount).toBe(1);
    });
});
