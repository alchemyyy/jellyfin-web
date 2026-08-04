import { afterEach, describe, expect, it, vi } from 'vitest';

import { secondsToMicroseconds } from '../MediaTime';
import AudioWorkletController, {
    type AudioTelemetryListener,
    type AudioWorkletControllerConfiguration,
    type AudioWorkletControllerOptions
} from './AudioWorkletController';
import {
    acquireSharedBrowserAudioWorklet,
    type SharedBrowserAudioWorkletLease
} from './BrowserAudioWorkletPool';

type Deferred = {
    promise: Promise<void>
    resolve: () => void
};

type ControllerHarness = {
    controller: AudioWorkletController
    deactivate: ReturnType<typeof vi.fn>
    destroy: ReturnType<typeof vi.fn>
    enqueue: ReturnType<typeof vi.fn>
    flush: ReturnType<typeof vi.fn>
    getTelemetry: ReturnType<typeof vi.fn>
    onTelemetry: ReturnType<typeof vi.fn>
    seek: ReturnType<typeof vi.fn>
    setMuted: ReturnType<typeof vi.fn>
    setPlaying: ReturnType<typeof vi.fn>
    setVolume: ReturnType<typeof vi.fn>
    telemetryListeners: Set<AudioTelemetryListener>
};

type ControllerDeferred = {
    promise: Promise<AudioWorkletController>
    resolve: (controller: AudioWorkletController) => void
};

const defaultOptions: AudioWorkletControllerOptions = {
    channelCount: 2,
    maxBufferedFrames: 96_000
};

const defaultConfiguration: AudioWorkletControllerConfiguration = {
    channelCount: 2,
    maxBufferedFrames: 96_000,
    maxChunks: 1_024,
    sampleRate: 48_000,
    telemetryIntervalFrames: 4_096
};

function createAudioContext(): AudioContext {
    return {
        sampleRate: 48_000,
        state: 'running'
    } as unknown as AudioContext;
}

function createControllerHarness(
    configuration: AudioWorkletControllerConfiguration = defaultConfiguration
): ControllerHarness {
    const telemetryListeners = new Set<AudioTelemetryListener>();
    const deactivate = vi.fn((): Promise<void> => Promise.resolve());
    const destroy = vi.fn((): Promise<void> => Promise.resolve());
    const enqueue = vi.fn(() => ({ frameCount: 1, sequence: 1, status: 'submitted' as const }));
    const flush = vi.fn((): number => 2);
    const getTelemetry = vi.fn(() => null);
    const onTelemetry = vi.fn((listener: AudioTelemetryListener): (() => void) => {
        telemetryListeners.add(listener);
        return (): void => {
            telemetryListeners.delete(listener);
        };
    });
    const seek = vi.fn((): number => 3);
    const setMuted = vi.fn();
    const setPlaying = vi.fn();
    const setVolume = vi.fn();
    const controller = {
        configuration: { ...configuration },
        deactivate,
        destroy,
        enqueue,
        flush,
        generation: 1,
        getTelemetry,
        isPlaying: false,
        onTelemetry,
        seek,
        setMuted,
        setPlaying,
        setVolume
    } as unknown as AudioWorkletController;
    return {
        controller,
        deactivate,
        destroy,
        enqueue,
        flush,
        getTelemetry,
        onTelemetry,
        seek,
        setMuted,
        setPlaying,
        setVolume,
        telemetryListeners
    };
}

function createDeferred(): Deferred {
    let resolver: (() => void) | null = null;
    const promise = new Promise<void>((resolve): void => {
        resolver = resolve;
    });
    return {
        promise,
        resolve: (): void => {
            if (!resolver) {
                throw new Error('Deferred resolver is unavailable');
            }
            resolver();
        }
    };
}

function createControllerDeferred(): ControllerDeferred {
    let resolver: ((controller: AudioWorkletController) => void) | null = null;
    const promise = new Promise<AudioWorkletController>((resolve): void => {
        resolver = resolve;
    });
    return {
        promise,
        resolve: (controller: AudioWorkletController): void => {
            if (!resolver) {
                throw new Error('Controller creation resolver is unavailable');
            }
            resolver(controller);
        }
    };
}

describe('BrowserAudioWorkletPool', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('waits for acknowledged release before issuing a new guarded facade', async () => {
        const audioContext = createAudioContext();
        const deactivation = createDeferred();
        const harness = createControllerHarness();
        harness.deactivate.mockReturnValueOnce(deactivation.promise);
        const create = vi.spyOn(AudioWorkletController, 'create')
            .mockResolvedValue(harness.controller);
        const firstLease = await acquireSharedBrowserAudioWorklet(audioContext, defaultOptions);
        const staleOutput = firstLease.output;
        const unsubscribe = staleOutput.onTelemetry(vi.fn());

        expect(staleOutput).not.toBe(harness.controller);
        const release = firstLease.release();
        expect(firstLease.release()).toBe(release);
        expect(firstLease.invalidate()).toBe(release);
        expect(harness.deactivate).toHaveBeenCalledWith(firstLease.leaseId);
        expect(harness.telemetryListeners).toHaveLength(0);
        unsubscribe();

        const PCMChunk = {
            channelData: [ new Float32Array(1), new Float32Array(1) ],
            timestampMicroseconds: secondsToMicroseconds(0)
        };
        expect(() => staleOutput.enqueue(PCMChunk, 1)).toThrow('no longer active');
        expect(() => staleOutput.flush(secondsToMicroseconds(0))).toThrow('no longer active');
        expect(() => staleOutput.getTelemetry()).toThrow('no longer active');
        expect(() => staleOutput.generation).toThrow('no longer active');
        expect(() => staleOutput.onTelemetry(vi.fn())).toThrow('no longer active');
        expect(() => staleOutput.seek(secondsToMicroseconds(0))).toThrow('no longer active');
        expect(() => staleOutput.setMuted(true)).toThrow('no longer active');
        expect(() => staleOutput.setPlaying(true)).toThrow('no longer active');
        expect(() => staleOutput.setVolume(0.5)).toThrow('no longer active');

        let reacquired = false;
        const secondAcquisition = acquireSharedBrowserAudioWorklet(
            audioContext,
            defaultOptions
        ).then((lease: SharedBrowserAudioWorkletLease): SharedBrowserAudioWorkletLease => {
            reacquired = true;
            return lease;
        });
        await Promise.resolve();
        expect(reacquired).toBe(false);
        expect(create).toHaveBeenCalledOnce();

        deactivation.resolve();
        await release;
        const secondLease = await secondAcquisition;
        expect(secondLease.output).not.toBe(staleOutput);
        expect(secondLease.leaseId).toBeGreaterThan(firstLease.leaseId);
        expect(create).toHaveBeenCalledOnce();
        expect(harness.destroy).not.toHaveBeenCalled();
        await secondLease.invalidate();
    });

    it('issues exactly one lease to two acquisitions waiting on one release', async () => {
        const audioContext = createAudioContext();
        const deactivation = createDeferred();
        const harness = createControllerHarness();
        harness.deactivate.mockReturnValueOnce(deactivation.promise);
        vi.spyOn(AudioWorkletController, 'create').mockResolvedValue(harness.controller);
        const activeLease = await acquireSharedBrowserAudioWorklet(audioContext, defaultOptions);
        const release = activeLease.release();

        const waitingAcquisitions = [
            acquireSharedBrowserAudioWorklet(audioContext, defaultOptions),
            acquireSharedBrowserAudioWorklet(audioContext, defaultOptions)
        ];
        deactivation.resolve();
        await release;
        const acquisitionResults = await Promise.allSettled(waitingAcquisitions);
        const fulfilledResults = acquisitionResults.filter(
            (result): result is PromiseFulfilledResult<SharedBrowserAudioWorkletLease> =>
                result.status === 'fulfilled'
        );
        const rejectedResults = acquisitionResults.filter(
            (result): result is PromiseRejectedResult => result.status === 'rejected'
        );

        expect(fulfilledResults).toHaveLength(1);
        expect(rejectedResults).toHaveLength(1);
        expect(rejectedResults[0].reason).toEqual(
            new Error('The shared audio worklet output is already leased')
        );
        await fulfilledResults[0].value.invalidate();
    });

    it('rejects a concurrent active lease for the same AudioContext', async () => {
        const audioContext = createAudioContext();
        const harness = createControllerHarness();
        vi.spyOn(AudioWorkletController, 'create').mockResolvedValue(harness.controller);

        const activeLease = await acquireSharedBrowserAudioWorklet(audioContext, defaultOptions);

        await expect(acquireSharedBrowserAudioWorklet(audioContext, defaultOptions))
            .rejects.toThrow('already leased');
        await activeLease.invalidate();
    });

    it('reserves the exclusive lease while controller creation is pending', async () => {
        const audioContext = createAudioContext();
        const harness = createControllerHarness();
        const deferredCreation = createControllerDeferred();
        const create = vi.spyOn(AudioWorkletController, 'create')
            .mockReturnValue(deferredCreation.promise);

        const firstAcquisition = acquireSharedBrowserAudioWorklet(audioContext, defaultOptions);
        await expect(acquireSharedBrowserAudioWorklet(audioContext, defaultOptions))
            .rejects.toThrow('already leased');
        expect(create).toHaveBeenCalledOnce();
        deferredCreation.resolve(harness.controller);

        const firstLease = await firstAcquisition;
        await firstLease.invalidate();
    });

    it('retires an idle configuration mismatch before creating an exact replacement', async () => {
        const audioContext = createAudioContext();
        const deactivation = createDeferred();
        const firstHarness = createControllerHarness();
        firstHarness.deactivate.mockReturnValueOnce(deactivation.promise);
        const replacementConfiguration = {
            ...defaultConfiguration,
            channelCount: 6
        };
        const replacementHarness = createControllerHarness(replacementConfiguration);
        const create = vi.spyOn(AudioWorkletController, 'create')
            .mockResolvedValueOnce(firstHarness.controller)
            .mockResolvedValueOnce(replacementHarness.controller);
        const firstLease = await acquireSharedBrowserAudioWorklet(audioContext, defaultOptions);
        const release = firstLease.release();

        const replacementPromise = acquireSharedBrowserAudioWorklet(audioContext, {
            channelCount: 6,
            maxBufferedFrames: 96_000
        });
        expect(create).toHaveBeenCalledOnce();
        expect(firstHarness.destroy).not.toHaveBeenCalled();
        deactivation.resolve();
        await release;
        const replacementLease = await replacementPromise;

        expect(firstHarness.destroy).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledTimes(2);
        expect(replacementLease.output.configuration.channelCount).toBe(6);
        await replacementLease.invalidate();
    });

    it('removes and retires an invalidated controller before creating its replacement', async () => {
        const audioContext = createAudioContext();
        const deferredRetirement = createDeferred();
        const firstHarness = createControllerHarness();
        firstHarness.destroy.mockReturnValueOnce(deferredRetirement.promise);
        const secondHarness = createControllerHarness();
        const create = vi.spyOn(AudioWorkletController, 'create')
            .mockResolvedValueOnce(firstHarness.controller)
            .mockResolvedValueOnce(secondHarness.controller);
        const firstLease = await acquireSharedBrowserAudioWorklet(audioContext, defaultOptions);

        const invalidation = firstLease.invalidate();
        expect(firstLease.invalidate()).toBe(invalidation);
        const replacementPromise = acquireSharedBrowserAudioWorklet(audioContext, defaultOptions);

        expect(firstHarness.destroy).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledOnce();
        deferredRetirement.resolve();
        await invalidation;

        const replacementLease = await replacementPromise;
        expect(create).toHaveBeenCalledTimes(2);
        expect(replacementLease.output).not.toBe(firstLease.output);
        await replacementLease.invalidate();
    });

    it('does not cache controller creation failures', async () => {
        const audioContext = createAudioContext();
        const replacementHarness = createControllerHarness();
        const create = vi.spyOn(AudioWorkletController, 'create')
            .mockRejectedValueOnce(new Error('creation failed'))
            .mockResolvedValueOnce(replacementHarness.controller);

        await expect(acquireSharedBrowserAudioWorklet(audioContext, defaultOptions))
            .rejects.toThrow('creation failed');

        const replacementLease = await acquireSharedBrowserAudioWorklet(
            audioContext,
            defaultOptions
        );
        expect(create).toHaveBeenCalledTimes(2);
        await replacementLease.invalidate();
    });

    it('poisons and replaces a controller after deactivation failure', async () => {
        const audioContext = createAudioContext();
        const deferredRetirement = createDeferred();
        const failedHarness = createControllerHarness();
        failedHarness.deactivate.mockRejectedValueOnce(
            new Error('AudioWorklet lease deactivation exceeded its bounded timeout')
        );
        failedHarness.destroy.mockReturnValueOnce(deferredRetirement.promise);
        const replacementHarness = createControllerHarness();
        const create = vi.spyOn(AudioWorkletController, 'create')
            .mockResolvedValueOnce(failedHarness.controller)
            .mockResolvedValueOnce(replacementHarness.controller);
        const failedLease = await acquireSharedBrowserAudioWorklet(audioContext, defaultOptions);

        await expect(failedLease.release()).rejects.toThrow('exceeded its bounded timeout');
        expect(failedHarness.destroy).toHaveBeenCalledOnce();

        const replacementPromise = acquireSharedBrowserAudioWorklet(
            audioContext,
            defaultOptions
        );
        expect(create).toHaveBeenCalledOnce();
        deferredRetirement.resolve();
        const replacementLease = await replacementPromise;
        expect(create).toHaveBeenCalledTimes(2);
        await replacementLease.invalidate();
    });

    it('makes invalidation the terminal first action for a lease', async () => {
        const audioContext = createAudioContext();
        const deferredRetirement = createDeferred();
        const harness = createControllerHarness();
        harness.destroy.mockReturnValueOnce(deferredRetirement.promise);
        vi.spyOn(AudioWorkletController, 'create').mockResolvedValue(harness.controller);
        const lease = await acquireSharedBrowserAudioWorklet(audioContext, defaultOptions);

        const invalidation = lease.invalidate();
        expect(lease.invalidate()).toBe(invalidation);
        expect(lease.release()).toBe(invalidation);
        expect(harness.deactivate).not.toHaveBeenCalled();
        expect(harness.destroy).toHaveBeenCalledOnce();
        deferredRetirement.resolve();
        await invalidation;
    });
});
