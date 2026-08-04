import { describe, expect, it, vi } from 'vitest';

import TrueHDExactCapabilityProbe, {
    type TrueHDExactCapabilityProbeEnvironment,
    type TrueHDExactCapabilityProbeWorker
} from './TrueHDExactCapabilityProbe';
import {
    TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
    TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK,
    TRUEHD_QUALIFICATION_CODEC_MASK,
    TRUEHD_QUALIFICATION_FIXTURE_COUNT,
    TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK,
    isTrueHDExactCapabilityWorkerRequest,
    isTrueHDExactCapabilityWorkerResponse,
    type TrueHDExactCapabilityWorkerResponse
} from './TrueHDExactCapabilityProtocol';

type WorkerEventType = 'error' | 'message' | 'messageerror';
type WorkerListener = (event: Event) => void;

class FakeTrueHDProbeWorker implements TrueHDExactCapabilityProbeWorker {
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

    private emit(type: WorkerEventType, event: Event): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

function createSupportedResponse(): TrueHDExactCapabilityWorkerResponse {
    return {
        decodeMilliseconds: 8,
        libraryVersion: 4_064_612,
        majorSyncRecoveryVerified: true,
        measuredRealTimeFactor: 32,
        reason: 'decode-output-verified',
        requestID: TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
        supported: true,
        type: 'result',
        verifiedChannelCountMask: TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK,
        verifiedCodecMask: TRUEHD_QUALIFICATION_CODEC_MASK,
        verifiedFixtureCount: TRUEHD_QUALIFICATION_FIXTURE_COUNT,
        verifiedSampleRateMask: TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK
    };
}

function createEnvironment(
    worker: FakeTrueHDProbeWorker,
    timeoutCallback: { value: (() => void) | null }
): TrueHDExactCapabilityProbeEnvironment {
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

describe('TrueHD exact capability protocol', () => {
    it('accepts only the bounded request shape', () => {
        expect(isTrueHDExactCapabilityWorkerRequest({
            requestID: TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
            type: 'probe'
        })).toBe(true);
        expect(isTrueHDExactCapabilityWorkerRequest({
            requestID: 'wrong',
            type: 'probe'
        })).toBe(false);
    });

    it('rejects malformed measurements, masks, and recovery evidence', () => {
        const response = createSupportedResponse();
        expect(isTrueHDExactCapabilityWorkerResponse(response)).toBe(true);
        expect(isTrueHDExactCapabilityWorkerResponse({
            ...response,
            measuredRealTimeFactor: Number.POSITIVE_INFINITY
        })).toBe(false);
        expect(isTrueHDExactCapabilityWorkerResponse({
            ...response,
            verifiedChannelCountMask: 1 << 8
        })).toBe(false);
        expect(isTrueHDExactCapabilityWorkerResponse({
            ...response,
            majorSyncRecoveryVerified: 'yes'
        })).toBe(false);
    });
});

describe('TrueHDExactCapabilityProbe', () => {
    it('caches a fully verified channel-bed capability', async () => {
        const worker = new FakeTrueHDProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new TrueHDExactCapabilityProbe(
            createEnvironment(worker, timeoutCallback)
        );

        const firstProbe = probe.probe();
        expect(probe.probe()).toBe(firstProbe);
        expect(worker.postedMessages).toEqual([ {
            requestID: TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
            type: 'probe'
        } ]);
        worker.emitMessage(createSupportedResponse());

        await expect(firstProbe).resolves.toMatchObject({
            channelBedOnly: true,
            channelCounts: [ 2, 6 ],
            codecs: [ 'truehd', 'mlp' ],
            majorSyncRecoveryVerified: true,
            objectAudioRendered: false,
            passthrough: false,
            reason: 'decode-output-verified',
            sampleRates: [ 48_000, 96_000, 192_000 ],
            status: 'supported'
        });
        expect(worker.terminateCallCount).toBe(1);
    });

    it('fails closed when nominal success omits exact recovery evidence', async () => {
        const worker = new FakeTrueHDProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new TrueHDExactCapabilityProbe(
            createEnvironment(worker, timeoutCallback)
        );

        const resultPromise = probe.probe();
        worker.emitMessage({
            ...createSupportedResponse(),
            majorSyncRecoveryVerified: false
        });

        await expect(resultPromise).resolves.toMatchObject({
            reason: 'output-mismatch',
            status: 'unsupported'
        });
    });

    it('reports an unavailable runtime without constructing a worker', async () => {
        const createWorker = vi.fn();
        const environment: TrueHDExactCapabilityProbeEnvironment = {
            clearTimeout: vi.fn(),
            createWorker,
            runtimeAvailable: false,
            setTimeout: vi.fn()
        };

        const capability = await new TrueHDExactCapabilityProbe(environment).probe();

        expect(capability).toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
        expect(createWorker).not.toHaveBeenCalled();
    });

    it('terminates a timed-out worker and ignores later output', async () => {
        const worker = new FakeTrueHDProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new TrueHDExactCapabilityProbe(
            createEnvironment(worker, timeoutCallback)
        );

        const resultPromise = probe.probe();
        timeoutCallback.value?.();
        worker.emitMessage(createSupportedResponse());

        await expect(resultPromise).resolves.toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(worker.terminateCallCount).toBe(1);
    });

    it('rejects malformed worker messages', async () => {
        const worker = new FakeTrueHDProbeWorker();
        const timeoutCallback = { value: null as (() => void) | null };
        const probe = new TrueHDExactCapabilityProbe(
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
