import { describe, expect, it, vi } from 'vitest';

import DTSExactCapabilityProbe, {
    type DTSExactCapabilityProbeEnvironment,
    type DTSExactCapabilityProbeWorker
} from './DTSExactCapabilityProbe';
import {
    DTS_EXACT_CAPABILITY_REQUEST_ID,
    DTS_QUALIFICATION_FIXTURE_COUNT,
    DTS_QUALIFICATION_PROFILE_MASK,
    isDTSExactCapabilityWorkerRequest,
    isDTSExactCapabilityWorkerResponse,
    type DTSExactCapabilityWorkerResponse
} from './DTSExactCapabilityProtocol';

type WorkerEventType = 'error' | 'message' | 'messageerror';
type WorkerListener = (event: Event) => void;

class FakeDTSProbeWorker implements DTSExactCapabilityProbeWorker {
    public readonly postedMessages: unknown[] = [];
    public terminateCallCount = 0;

    private readonly listeners = new Map<WorkerEventType, Set<WorkerListener>>();

    public addEventListener(type: WorkerEventType, listener: WorkerListener): void {
        let typeListeners = this.listeners.get(type);
        if (!typeListeners) {
            typeListeners = new Set<WorkerListener>();
            this.listeners.set(type, typeListeners);
        }
        typeListeners.add(listener);
    }

    public postMessage(message: unknown): void {
        this.postedMessages.push(message);
    }

    public removeEventListener(type: WorkerEventType, listener: WorkerListener): void {
        this.listeners.get(type)?.delete(listener);
    }

    public terminate(): void {
        this.terminateCallCount += 1;
    }

    public emitMessage(data: unknown): void {
        this.emit('message', new MessageEvent('message', { data }));
    }

    public emitError(): void {
        this.emit('error', new Event('error'));
    }

    private emit(type: WorkerEventType, event: Event): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

function createSupportedResponse(): DTSExactCapabilityWorkerResponse {
    return {
        decodeMilliseconds: 8,
        libraryVersion: 131_073,
        measuredRealTimeFactor: 32,
        reason: 'decode-output-verified',
        requestID: DTS_EXACT_CAPABILITY_REQUEST_ID,
        supported: true,
        type: 'result',
        verifiedFixtureCount: DTS_QUALIFICATION_FIXTURE_COUNT,
        verifiedProfileMask: DTS_QUALIFICATION_PROFILE_MASK
    };
}

function createEnvironment(
    worker: FakeDTSProbeWorker,
    timeoutCallback: { value: (() => void) | null }
): DTSExactCapabilityProbeEnvironment {
    return {
        clearTimeout: vi.fn(),
        createWorker: () => worker,
        runtimeAvailable: true,
        setTimeout: callback => {
            timeoutCallback.value = callback;
            return 1 as unknown as ReturnType<typeof globalThis.setTimeout>;
        }
    };
}

describe('DTS exact capability protocol', () => {
    it('accepts only the bounded request shape', () => {
        expect(isDTSExactCapabilityWorkerRequest({
            requestID: DTS_EXACT_CAPABILITY_REQUEST_ID,
            type: 'probe'
        })).toBe(true);
        expect(isDTSExactCapabilityWorkerRequest({
            requestID: 'wrong',
            type: 'probe'
        })).toBe(false);
    });

    it('rejects malformed response measurements and profile masks', () => {
        const response = createSupportedResponse();
        expect(isDTSExactCapabilityWorkerResponse(response)).toBe(true);
        expect(isDTSExactCapabilityWorkerResponse({
            ...response,
            measuredRealTimeFactor: Number.POSITIVE_INFINITY
        })).toBe(false);
        expect(isDTSExactCapabilityWorkerResponse({
            ...response,
            verifiedProfileMask: 0x20
        })).toBe(false);
    });
});

describe('DTSExactCapabilityProbe', () => {
    it('caches and returns a fully verified channel-bed capability', async () => {
        const worker = new FakeDTSProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new DTSExactCapabilityProbe(
            createEnvironment(worker, timeoutCallback)
        );

        const firstProbe = probe.probe();
        const secondProbe = probe.probe();
        expect(secondProbe).toBe(firstProbe);
        expect(worker.postedMessages).toEqual([ {
            requestID: DTS_EXACT_CAPABILITY_REQUEST_ID,
            type: 'probe'
        } ]);

        worker.emitMessage(createSupportedResponse());
        const capability = await firstProbe;

        expect(capability).toMatchObject({
            channelBedOnly: true,
            maximumChannelCount: 8,
            objectAudioRendered: false,
            reason: 'decode-output-verified',
            sampleRates: [ 48_000, 96_000, 192_000 ],
            status: 'supported',
            verifiedFixtureCount: DTS_QUALIFICATION_FIXTURE_COUNT,
            verifiedProfileMask: DTS_QUALIFICATION_PROFILE_MASK
        });
        expect(worker.terminateCallCount).toBe(1);
    });

    it('fails closed when a nominal success omits exact family evidence', async () => {
        const worker = new FakeDTSProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new DTSExactCapabilityProbe(
            createEnvironment(worker, timeoutCallback)
        );

        const resultPromise = probe.probe();
        worker.emitMessage({
            ...createSupportedResponse(),
            verifiedFixtureCount: DTS_QUALIFICATION_FIXTURE_COUNT - 1
        });

        await expect(resultPromise).resolves.toMatchObject({
            reason: 'output-mismatch',
            status: 'unsupported'
        });
    });

    it('reports unavailable runtimes without constructing a worker', async () => {
        const createWorker = vi.fn();
        const environment: DTSExactCapabilityProbeEnvironment = {
            clearTimeout: vi.fn(),
            createWorker,
            runtimeAvailable: false,
            setTimeout: vi.fn()
        };

        const capability = await new DTSExactCapabilityProbe(environment).probe();

        expect(capability).toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
        expect(createWorker).not.toHaveBeenCalled();
    });

    it('terminates a timed-out worker and ignores later output', async () => {
        const worker = new FakeDTSProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new DTSExactCapabilityProbe(
            createEnvironment(worker, timeoutCallback)
        );

        const resultPromise = probe.probe();
        timeoutCallback.value?.();
        worker.emitMessage(createSupportedResponse());
        const capability = await resultPromise;

        expect(capability).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(worker.terminateCallCount).toBe(1);
    });

    it('rejects malformed worker messages', async () => {
        const worker = new FakeDTSProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new DTSExactCapabilityProbe(
            createEnvironment(worker, timeoutCallback)
        );

        const resultPromise = probe.probe();
        worker.emitMessage({ supported: true });

        await expect(resultPromise).resolves.toMatchObject({
            reason: 'worker-message-invalid',
            status: 'unsupported'
        });
        expect(worker.terminateCallCount).toBe(1);
    });
});
