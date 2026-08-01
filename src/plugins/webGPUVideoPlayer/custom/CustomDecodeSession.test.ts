import { describe, expect, it, vi } from 'vitest';

import { secondsToMicroseconds } from '../MediaTime';
import type CustomDecodeAudioBridge from './CustomDecodeAudioBridge';
import CustomDecodeSession, {
    type CustomDecodeSessionEvent
} from './CustomDecodeSession';
import { MAX_DECODED_FRAME_CREDITS } from './DecodeWorkerProtocol';

vi.mock('./CustomDecode.worker', () => ({
    default: class MockBundledWorker {}
}));

type MessageHandler = (event: MessageEvent<unknown>) => void;
type ErrorHandler = (event: ErrorEvent) => void;

class MockWorker {
    readonly postedMessages: unknown[] = [];
    readonly terminate = vi.fn();

    private readonly errorHandlers = new Set<ErrorHandler>();
    private readonly messageHandlers = new Set<MessageHandler>();

    postMessage(message: unknown): void {
        this.postedMessages.push(message);
    }

    addEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
        if (type === 'message') {
            this.messageHandlers.add(handler as MessageHandler);
        } else if (type === 'error') {
            this.errorHandlers.add(handler as ErrorHandler);
        }
    }

    removeEventListener(type: string, handler: EventListenerOrEventListenerObject): void {
        if (type === 'message') {
            this.messageHandlers.delete(handler as MessageHandler);
        } else if (type === 'error') {
            this.errorHandlers.delete(handler as ErrorHandler);
        }
    }

    emitMessage(data: unknown): void {
        for (const handler of this.messageHandlers) {
            handler({ data } as MessageEvent<unknown>);
        }
    }

    emitError(): void {
        const event = { preventDefault: vi.fn() } as unknown as ErrorEvent;
        for (const handler of this.errorHandlers) {
            handler(event);
        }
    }
}

function createFrame(): VideoFrame & { close: ReturnType<typeof vi.fn> } {
    return { close: vi.fn() } as unknown as VideoFrame & { close: ReturnType<typeof vi.fn> };
}

function createDeferred<Value>(): {
    promise: Promise<Value>
    resolve: (value: Value) => void
} {
    let promiseResolver: ((value: Value) => void) | undefined;
    const promise = new Promise<Value>(resolve => {
        promiseResolver = resolve;
    });
    return {
        promise,
        resolve: (value: Value): void => {
            if (!promiseResolver) {
                throw new Error('Deferred promise was not initialized');
            }
            promiseResolver(value);
        }
    };
}

function startSession(
    session: CustomDecodeSession,
    generation: number,
    audioTrackIndex?: number
): void {
    session.start({
        audioTrackIndex,
        generation,
        startTimeMicroseconds: secondsToMicroseconds(1),
        url: 'http://localhost/video.mp4?ApiKey=secret',
        videoTrackIndex: 0
    });
}

function emitFrame(
    worker: MockWorker,
    generation: number,
    mediaTimeMicroseconds: number
): ReturnType<typeof createFrame> {
    const frame = createFrame();
    worker.emitMessage({
        durationMicroseconds: 100_000,
        frame,
        generation,
        mediaTimeMicroseconds,
        type: 'frame'
    });
    return frame;
}

describe('CustomDecodeSession', () => {
    it('starts with four credits and replenishes only consumed queue entries', () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker
        );

        startSession(session, 7);
        expect(worker.postedMessages).toEqual([ {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 7,
            startTimeMicroseconds: 1_000_000,
            type: 'start',
            url: 'http://localhost/video.mp4?ApiKey=secret',
            videoTrackIndex: 0
        } ]);

        worker.emitMessage({
            audio: null,
            codec: 'avc1.640028',
            codedHeight: 1080,
            codedWidth: 1920,
            displayHeight: 1080,
            displayWidth: 1920,
            generation: 7,
            type: 'ready'
        });
        const firstFrame = emitFrame(worker, 7, 1_100_000);
        const selectedFrame = emitFrame(worker, 7, 1_200_000);
        emitFrame(worker, 7, 1_300_000);
        emitFrame(worker, 7, 1_400_000);

        const presentationFrame = session.takeFrame(secondsToMicroseconds(1.25));
        expect(presentationFrame?.frame).toBe(selectedFrame);
        expect(firstFrame.close).toHaveBeenCalledOnce();
        expect(selectedFrame.close).not.toHaveBeenCalled();
        expect(worker.postedMessages.at(-1)).toEqual({
            frameCredits: 2,
            generation: 7,
            type: 'pull'
        });
        expect(session.getTelemetry()).toMatchObject({
            queuedFrameCount: 2,
            receivedFrameCount: 4,
            state: 'ready',
            takenFrameCount: 1
        });
        expect(events).toContainEqual({
            audio: null,
            codec: 'avc1.640028',
            generation: 7,
            type: 'ready'
        });

        presentationFrame?.frame.close();
    });

    it('closes stale frames and retires superseded workers by generation', async () => {
        const workers = [ new MockWorker(), new MockWorker() ];
        let workerIndex = 0;
        const session = new CustomDecodeSession(
            () => undefined,
            () => workers[workerIndex++] as unknown as Worker
        );

        startSession(session, 1);
        const queuedOldFrame = emitFrame(workers[0], 1, 1_000_000);
        startSession(session, 2);

        expect(queuedOldFrame.close).toHaveBeenCalledOnce();
        expect(workers[0].postedMessages.at(-1)).toEqual({ generation: 1, type: 'stop' });

        const staleFrame = emitFrame(workers[0], 1, 1_100_000);
        expect(staleFrame.close).toHaveBeenCalledOnce();
        expect(session.getTelemetry().staleFrameCount).toBe(1);

        workers[0].emitMessage({ generation: 1, type: 'stopped' });
        expect(workers[0].terminate).toHaveBeenCalledOnce();

        const currentFrame = emitFrame(workers[1], 2, 1_000_000);
        const stopPromise = session.stop();
        expect(currentFrame.close).toHaveBeenCalledOnce();
        expect(workers[1].postedMessages.at(-1)).toEqual({ generation: 2, type: 'stop' });
        workers[1].emitMessage({ generation: 2, type: 'stopped' });
        await stopPromise;
        expect(workers[1].terminate).toHaveBeenCalledOnce();
    });

    it('latches worker failures, closes queued frames, and reports an event', () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker
        );
        startSession(session, 3);
        const frame = emitFrame(worker, 3, 1_000_000);

        worker.emitMessage({
            failureKind: 'range-unsupported',
            generation: 3,
            message: 'Range requests are required',
            type: 'error'
        });

        expect(frame.close).toHaveBeenCalledOnce();
        expect(session.getTelemetry()).toMatchObject({
            failureKind: 'range-unsupported',
            queuedFrameCount: 0,
            state: 'error'
        });
        expect(events.at(-1)).toEqual({
            failureKind: 'range-unsupported',
            generation: 3,
            message: 'Range requests are required',
            type: 'error'
        });
    });

    it('fails closed if the worker exceeds the four-frame queue bound', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 4);
        const acceptedFrames = Array.from(
            { length: MAX_DECODED_FRAME_CREDITS },
            (_value, frameIndex) => emitFrame(worker, 4, frameIndex * 100_000)
        );
        const overflowFrame = emitFrame(worker, 4, 500_000);

        for (const frame of acceptedFrames) {
            expect(frame.close).toHaveBeenCalledOnce();
        }
        expect(overflowFrame.close).toHaveBeenCalledOnce();
        expect(session.getTelemetry().state).toBe('error');
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 4, type: 'stop' });
    });

    it('closes frames from invalid or crashed worker messages', () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker
        );
        startSession(session, 5);

        const invalidFrame = createFrame();
        worker.emitMessage({
            durationMicroseconds: 10_000,
            frame: invalidFrame,
            generation: 5,
            mediaTimeMicroseconds: 0.5,
            type: 'frame'
        });
        expect(invalidFrame.close).toHaveBeenCalledOnce();
        expect(session.getTelemetry().state).toBe('error');

        const crashingWorker = new MockWorker();
        const crashingSession = new CustomDecodeSession(
            event => events.push(event),
            () => crashingWorker as unknown as Worker
        );
        startSession(crashingSession, 6);
        const queuedFrame = emitFrame(crashingWorker, 6, 1_000_000);
        crashingWorker.emitError();
        expect(queuedFrame.close).toHaveBeenCalledOnce();
        expect(crashingWorker.terminate).toHaveBeenCalledOnce();
        expect(crashingSession.getTelemetry().state).toBe('error');
    });

    it('forcibly terminates a worker that does not acknowledge stop', async () => {
        vi.useFakeTimers();
        try {
            const worker = new MockWorker();
            const session = new CustomDecodeSession(
                () => undefined,
                () => worker as unknown as Worker
            );
            startSession(session, 8);

            const stopPromise = session.stop();
            expect(worker.terminate).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1_000);
            await stopPromise;

            expect(worker.terminate).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps fallback and destroy stops pending until a failed worker retires', async () => {
        const worker = new MockWorker();
        const fallbackStopPromises: Promise<void>[] = [];
        const session = new CustomDecodeSession(
            event => {
                if (event.type === 'error') {
                    fallbackStopPromises.push(session.stop());
                }
            },
            () => worker as unknown as Worker
        );
        startSession(session, 11);

        worker.emitMessage({
            failureKind: 'decode-failed',
            generation: 11,
            message: 'Decoder failed',
            type: 'error'
        });
        const fallbackStopPromise = fallbackStopPromises[0];
        if (!fallbackStopPromise) {
            throw new Error('The fallback stop was not requested');
        }
        const destroyStopPromise = session.stop();
        let fallbackStopSettled = false;
        let destroyStopSettled = false;
        const observedFallbackStopPromise = fallbackStopPromise.then((): void => {
            fallbackStopSettled = true;
        });
        const observedDestroyStopPromise = destroyStopPromise.then((): void => {
            destroyStopSettled = true;
        });
        await Promise.resolve();

        expect(fallbackStopPromises).toHaveLength(1);
        expect(destroyStopPromise).toBe(fallbackStopPromise);
        expect(fallbackStopSettled).toBe(false);
        expect(destroyStopSettled).toBe(false);
        expect(worker.postedMessages.filter(message => (
            message as { type?: string }
        ).type === 'stop')).toHaveLength(1);
        expect(worker.terminate).not.toHaveBeenCalled();

        worker.emitMessage({ generation: 11, type: 'stopped' });
        await fallbackStopPromise;
        await destroyStopPromise;
        await observedFallbackStopPromise;
        await observedDestroyStopPromise;

        expect(worker.terminate).toHaveBeenCalledOnce();
    });

    it('feeds decoded PCM through the audio bridge and replenishes consumed samples', () => {
        const worker = new MockWorker();
        const audioBridge = {
            enqueue: vi.fn(() => ({ frameCount: 1_024, status: 'submitted' as const })),
            initialAudioSampleCredits: 3,
            start: vi.fn(),
            stop: vi.fn()
        } as unknown as CustomDecodeAudioBridge;
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker,
            audioBridge
        );

        startSession(session, 9, 1);
        expect(worker.postedMessages[0]).toMatchObject({
            audioSampleCredits: 0,
            audioTrackIndex: 1,
            generation: 9,
            type: 'start'
        });

        const audioConfiguration = {
            channelCount: 2,
            codec: 'mp4a.40.2',
            sampleRate: 48_000
        };
        worker.emitMessage({
            audio: audioConfiguration,
            codec: 'hev1.2.4.L153.B0',
            codedHeight: 2_160,
            codedWidth: 3_840,
            displayHeight: 2_160,
            displayWidth: 3_840,
            generation: 9,
            type: 'ready'
        });
        expect(audioBridge.start).toHaveBeenCalledOnce();
        expect(worker.postedMessages.at(-1)).toEqual({
            audioSampleCredits: 3,
            generation: 9,
            type: 'pull-audio'
        });
        expect(events).toEqual([]);

        worker.emitMessage({
            channelCount: 2,
            channelData: [ new Float32Array(1_024), new Float32Array(1_024) ],
            durationMicroseconds: 21_333,
            frameCount: 1_024,
            generation: 9,
            mediaTimeMicroseconds: 1_000_000,
            sampleRate: 48_000,
            type: 'audio'
        });
        expect(audioBridge.enqueue).toHaveBeenCalledOnce();
        expect(events.at(-1)).toEqual({
            audio: audioConfiguration,
            codec: 'hev1.2.4.L153.B0',
            generation: 9,
            type: 'ready'
        });
        expect(session.getTelemetry()).toMatchObject({
            audioCodec: 'mp4a.40.2',
            receivedAudioFrameCount: 1_024,
            receivedAudioSampleCount: 1,
            submittedAudioFrameCount: 1_024,
            submittedAudioSampleCount: 1
        });

        const bridgeStartOptions = vi.mocked(audioBridge.start).mock.calls[0][0];
        bridgeStartOptions.callbacks.onCreditsReleased(2);
        expect(worker.postedMessages.at(-1)).toEqual({
            audioSampleCredits: 2,
            generation: 9,
            type: 'pull-audio'
        });

        bridgeStartOptions.callbacks.onFailure('The audio worklet overflowed');
        expect(session.getTelemetry()).toMatchObject({
            failureKind: 'audio-output-failed',
            state: 'error'
        });
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 9, type: 'stop' });
        expect(audioBridge.stop).toHaveBeenCalledWith(9);
        worker.emitMessage({ generation: 9, type: 'stopped' });
    });

    it('discards a bridge factory result after its decode generation stops', async () => {
        const worker = new MockWorker();
        const audioBridge = {
            enqueue: vi.fn(),
            initialAudioSampleCredits: 2,
            start: vi.fn(),
            stop: vi.fn()
        } as unknown as CustomDecodeAudioBridge;
        const deferredAudioBridge = createDeferred<CustomDecodeAudioBridge>();
        const audioBridgeFactory = vi.fn(() => deferredAudioBridge.promise);
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker,
            null,
            audioBridgeFactory
        );

        startSession(session, 10, 0);
        worker.emitMessage({
            audio: { channelCount: 2, codec: 'opus', sampleRate: 48_000 },
            codec: 'vp09.00.10.08',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 10,
            type: 'ready'
        });
        expect(audioBridgeFactory).toHaveBeenCalledOnce();

        const stopPromise = session.stop();
        worker.emitMessage({ generation: 10, type: 'stopped' });
        await stopPromise;
        deferredAudioBridge.resolve(audioBridge);
        await deferredAudioBridge.promise;
        await Promise.resolve();

        expect(audioBridge.start).not.toHaveBeenCalled();
        expect(session.getTelemetry().state).toBe('idle');
    });
});
