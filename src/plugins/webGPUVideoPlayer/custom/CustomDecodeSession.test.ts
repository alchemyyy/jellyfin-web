import { describe, expect, it, vi } from 'vitest';

import {
    millisecondsToMicroseconds,
    secondsToMicroseconds,
    type Microseconds
} from '../MediaTime';
import type CustomDecodeAudioBridge from './CustomDecodeAudioBridge';
import CustomDecodeNativeAudioBridge, {
    type OwnedNativeMediaAudioBackendPort
} from './CustomDecodeNativeAudioBridge';
import CustomDecodeSession, {
    type CustomDecodeSessionEvent
} from './CustomDecodeSession';
import {
    MAX_DECODED_FRAME_CREDITS,
    MAX_DECODED_RAW_FRAME_CREDITS
} from './DecodeWorkerProtocol';
import {
    DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
} from './DolbyVisionEncodedMetadataProtocol';
import {
    DOLBY_VISION_RPU_PARSER_REVISION_PREFIX,
    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
    DOLBY_VISION_RPU_SCHEMA_MAGIC,
    DOLBY_VISION_RPU_SCHEMA_VERSION,
    resolveDolbyVisionRPUParserWASMURL
} from './DolbyVisionRPUParser';
import type {
    OwnedNativeMediaAudioEventHandler,
    OwnedNativeMediaAudioTelemetry
} from './OwnedNativeMediaAudioBackend';
import type {
    RawVideoFrameGeometry,
    TransferableRawVideoFrame
} from './RawVideoFrameCopy';

vi.mock('./CustomDecode.worker', () => ({
    default: class MockBundledWorker {}
}));

type MessageHandler = (event: MessageEvent<unknown>) => void;
type ErrorHandler = (event: ErrorEvent) => void;

function createPackedRPUData(): ArrayBuffer {
    const data = new ArrayBuffer(DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH);
    const view = new DataView(data);
    view.setUint32(0, DOLBY_VISION_RPU_SCHEMA_MAGIC, true);
    view.setUint32(4, DOLBY_VISION_RPU_SCHEMA_VERSION, true);
    view.setUint32(8, DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH, true);
    view.setUint32(16, DOLBY_VISION_RPU_PARSER_REVISION_PREFIX, true);
    return data;
}

class MockWorker {
    readonly postedMessages: unknown[] = [];
    readonly postedTransfers: Transferable[][] = [];
    readonly terminate = vi.fn();

    private readonly errorHandlers = new Set<ErrorHandler>();
    private readonly messageHandlers = new Set<MessageHandler>();

    postMessage(message: unknown, transfer: Transferable[] = []): void {
        this.postedMessages.push(message);
        this.postedTransfers.push(transfer);
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

function createRawFrame(
    mediaTimeMicroseconds: Microseconds,
    geometry: RawVideoFrameGeometry = {
        codedHeight: 2,
        codedWidth: 4,
        displayHeight: 2,
        displayWidth: 4
    }
): TransferableRawVideoFrame {
    const yPlaneHeight = geometry.codedHeight;
    const chromaPlaneHeight = Math.ceil(geometry.codedHeight / 2);
    const yPlaneWidth = geometry.codedWidth;
    const chromaPlaneWidth = Math.ceil(geometry.codedWidth / 2);
    const yPlaneByteLength = 256 * yPlaneHeight;
    const chromaPlaneByteLength = 256 * chromaPlaneHeight;
    return {
        bitDepth: 10,
        codedHeight: geometry.codedHeight,
        codedWidth: geometry.codedWidth,
        colorSpace: {
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'smpte2084'
        },
        data: new ArrayBuffer(yPlaneByteLength + (2 * chromaPlaneByteLength)),
        displayHeight: geometry.displayHeight,
        displayWidth: geometry.displayWidth,
        durationMicroseconds: millisecondsToMicroseconds(100),
        format: 'I420P10',
        planes: [
            {
                byteLength: yPlaneByteLength,
                byteOffset: 0,
                bytesPerComponent: 2,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: yPlaneHeight,
                kind: 'y',
                rowByteLength: yPlaneWidth * 2,
                width: yPlaneWidth
            },
            {
                byteLength: chromaPlaneByteLength,
                byteOffset: yPlaneByteLength,
                bytesPerComponent: 2,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: chromaPlaneHeight,
                kind: 'u',
                rowByteLength: chromaPlaneWidth * 2,
                width: chromaPlaneWidth
            },
            {
                byteLength: chromaPlaneByteLength,
                byteOffset: yPlaneByteLength + chromaPlaneByteLength,
                bytesPerComponent: 2,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: chromaPlaneHeight,
                kind: 'v',
                rowByteLength: chromaPlaneWidth * 2,
                width: chromaPlaneWidth
            }
        ],
        timestampMicroseconds: mediaTimeMicroseconds,
        visibleRectangle: {
            height: geometry.displayHeight,
            width: geometry.displayWidth,
            x: 0,
            y: 0
        }
    };
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
    audioTrackIndex?: number,
    videoOutputMode: 'raw-planes' | 'video-frame' = 'video-frame'
): void {
    session.start({
        audioTrackIndex,
        generation,
        maximumCodedHeight: videoOutputMode === 'raw-planes' ? 2_160 : 1_080,
        maximumCodedWidth: videoOutputMode === 'raw-planes' ? 3_840 : 1_920,
        rawVideoFrameFormat: videoOutputMode === 'raw-planes' ? 'I420P10' : null,
        startTimeMicroseconds: secondsToMicroseconds(1),
        url: 'http://localhost/video.mp4?ApiKey=secret',
        videoDecoderBackend: videoOutputMode === 'raw-planes' ? 'bundled-hevc' : 'native',
        videoOutputMode,
        videoTrackIndex: 0
    });
}

function emitRawReady(
    worker: MockWorker,
    generation: number,
    geometry: RawVideoFrameGeometry = {
        codedHeight: 2,
        codedWidth: 4,
        displayHeight: 2,
        displayWidth: 4
    }
): void {
    worker.emitMessage({
        audio: null,
        codec: 'hvc1.2.4.L153.B0',
        codedHeight: geometry.codedHeight,
        codedWidth: geometry.codedWidth,
        displayHeight: geometry.displayHeight,
        displayWidth: geometry.displayWidth,
        generation,
        type: 'ready'
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
        outputMode: 'video-frame',
        type: 'frame'
    });
    return frame;
}

function emitRawFrame(
    worker: MockWorker,
    generation: number,
    mediaTimeMicroseconds: Microseconds
): TransferableRawVideoFrame {
    const frame = createRawFrame(mediaTimeMicroseconds);
    worker.emitMessage({
        durationMicroseconds: 100_000,
        frame,
        generation,
        mediaTimeMicroseconds,
        outputMode: 'raw-planes',
        type: 'frame'
    });
    return frame;
}

describe('CustomDecodeSession', () => {
    it('forwards encoded Dolby Vision ownership and records extraction telemetry', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            (): void => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 31);
        emitRawReady(worker, 31);
        const frame = createFrame();
        const encodedDolbyVisionMetadata = {
            enhancementLayerData: new ArrayBuffer(32),
            hasEnhancementLayerVCL: true,
            parsedRPUData: [ createPackedRPUData(), createPackedRPUData() ],
            schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
        } as const;
        worker.emitMessage({
            durationMicroseconds: 100_000,
            encodedDolbyVisionMetadata,
            frame,
            generation: 31,
            mediaTimeMicroseconds: 1_100_000,
            outputMode: 'video-frame',
            type: 'frame'
        });

        const presentationFrame = session.takeFrame(secondsToMicroseconds(1.1));
        expect(presentationFrame?.encodedDolbyVisionMetadata)
            .toBe(encodedDolbyVisionMetadata);
        expect(session.getTelemetry()).toMatchObject({
            receivedDolbyVisionEnhancementFrameCount: 1,
            receivedDolbyVisionFrameCount: 1,
            receivedDolbyVisionRPUCount: 2
        });
        if (!presentationFrame || presentationFrame.outputMode !== 'video-frame') {
            throw new Error('Expected a transferred decoded video frame');
        }
        expect(session.acknowledgeFrame(presentationFrame)).toBe(true);
        presentationFrame.frame.close();
    });

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
            dolbyVisionRPUParserWASMURL: resolveDolbyVisionRPUParserWASMURL(),
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 7,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 1_000_000,
            type: 'start',
            url: 'http://localhost/video.mp4?ApiKey=secret',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
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
        expect(session.getTelemetry().state).toBe('configured');
        expect(events).toEqual([ {
            audio: null,
            codec: 'avc1.640028',
            generation: 7,
            type: 'configured'
        } ]);

        const firstFrame = emitFrame(worker, 7, 1_100_000);
        expect(session.getTelemetry().state).toBe('ready');
        expect(events.at(-1)).toEqual({
            audio: null,
            codec: 'avc1.640028',
            generation: 7,
            type: 'ready'
        });
        const selectedFrame = emitFrame(worker, 7, 1_200_000);
        emitFrame(worker, 7, 1_300_000);
        emitFrame(worker, 7, 1_400_000);

        const presentationFrame = session.takeFrame(secondsToMicroseconds(1.25));
        expect(presentationFrame?.frame).toBe(selectedFrame);
        expect(firstFrame.close).toHaveBeenCalledOnce();
        expect(selectedFrame.close).not.toHaveBeenCalled();
        expect(worker.postedMessages.at(-1)).toEqual({
            frameCredits: 1,
            generation: 7,
            type: 'pull'
        });
        expect(session.getTelemetry()).toMatchObject({
            queuedFrameCount: 2,
            pendingFrameCount: 1,
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

        if (!presentationFrame || presentationFrame.outputMode !== 'video-frame') {
            throw new Error('Expected a decoded VideoFrame');
        }
        expect(session.acknowledgeFrame(presentationFrame)).toBe(true);
        expect(worker.postedMessages.at(-1)).toEqual({
            frameCredits: 1,
            generation: 7,
            type: 'pull'
        });
        expect(session.acknowledgeFrame(presentationFrame)).toBe(false);
        presentationFrame.frame.close();
    });

    it('keeps two raw frames outstanding while acknowledgement is delayed', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );

        startSession(session, 12, undefined, 'raw-planes');
        emitRawReady(worker, 12);
        expect(worker.postedMessages[0]).toMatchObject({
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 12,
            rawVideoFrameFormat: 'I420P10',
            type: 'start',
            videoOutputMode: 'raw-planes'
        });

        const firstRawFrame = emitRawFrame(worker, 12, secondsToMicroseconds(1.1));
        const secondRawFrame = emitRawFrame(worker, 12, secondsToMicroseconds(1.2));
        expect(session.getTelemetry()).toMatchObject({
            peakFrameCount: 2,
            pendingFrameCount: 0,
            queuedFrameCount: 2,
            receivedFrameCount: 2
        });

        const firstPresentationFrame = session.takeFrame(secondsToMicroseconds(1.1));
        const secondPresentationFrame = session.takeFrame(secondsToMicroseconds(1.2));
        expect(worker.postedMessages).toHaveLength(1);
        expect(session.getTelemetry()).toMatchObject({
            pendingFrameCount: 2,
            queuedFrameCount: 0,
            takenFrameCount: 2
        });

        if (
            !firstPresentationFrame
            || firstPresentationFrame.outputMode !== 'raw-planes'
            || !secondPresentationFrame
            || secondPresentationFrame.outputMode !== 'raw-planes'
        ) {
            throw new Error('Expected two decoded raw frames');
        }
        expect(session.acknowledgeFrame(firstPresentationFrame)).toBe(true);
        expect(worker.postedMessages.at(-1)).toEqual({
            buffer: firstRawFrame.data,
            generation: 12,
            type: 'recycle-frame'
        });
        expect(worker.postedTransfers.at(-1)).toEqual([ firstRawFrame.data ]);
        expect(session.getTelemetry().recycledRawFrameCount).toBe(1);

        emitRawFrame(worker, 12, secondsToMicroseconds(1.3));
        expect(session.getTelemetry()).toMatchObject({
            pendingFrameCount: 1,
            queuedFrameCount: 1,
            receivedFrameCount: 3
        });
        expect(session.acknowledgeFrame(secondPresentationFrame)).toBe(true);
        expect(worker.postedMessages.at(-1)).toEqual({
            buffer: secondRawFrame.data,
            generation: 12,
            type: 'recycle-frame'
        });
    });

    it('recycles dropped raw buffers instead of issuing allocation credits', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );

        startSession(session, 13, undefined, 'raw-planes');
        emitRawReady(worker, 13);
        const droppedRawFrame = emitRawFrame(worker, 13, secondsToMicroseconds(1.1));
        const selectedRawFrame = emitRawFrame(worker, 13, secondsToMicroseconds(1.2));
        const presentationFrame = session.takeFrame(secondsToMicroseconds(1.2));

        expect(worker.postedMessages.at(-1)).toEqual({
            buffer: droppedRawFrame.data,
            generation: 13,
            type: 'recycle-frame'
        });
        expect(worker.postedTransfers.at(-1)).toEqual([ droppedRawFrame.data ]);
        expect(session.getTelemetry()).toMatchObject({
            droppedFrameCount: 1,
            pendingFrameCount: 1,
            queuedFrameCount: 0,
            recycledRawFrameCount: 1
        });

        if (!presentationFrame || presentationFrame.outputMode !== 'raw-planes') {
            throw new Error('Expected the selected decoded raw frame');
        }
        expect(session.discardFrame(presentationFrame)).toBe(true);
        expect(worker.postedMessages.at(-1)).toEqual({
            buffer: selectedRawFrame.data,
            generation: 13,
            type: 'recycle-frame'
        });
    });

    it('fails cleanly if recycling a skipped raw frame throws synchronously', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );

        startSession(session, 17, undefined, 'raw-planes');
        emitRawReady(worker, 17);
        emitRawFrame(worker, 17, secondsToMicroseconds(1.1));
        emitRawFrame(worker, 17, secondsToMicroseconds(1.2));
        vi.spyOn(worker, 'postMessage').mockImplementation(() => {
            throw new DOMException('Transfer failed', 'DataCloneError');
        });

        expect(session.takeFrame(secondsToMicroseconds(1.2))).toBeNull();
        expect(session.getTelemetry()).toMatchObject({
            abandonedRawFrameCount: 2,
            pendingFrameCount: 0,
            queuedFrameCount: 0,
            state: 'error'
        });
    });

    it('rejects a configured track above the negotiated route before accepting frames', () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker
        );
        session.start({
            generation: 18,
            maximumCodedHeight: 720,
            maximumCodedWidth: 1_280,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: secondsToMicroseconds(1),
            url: 'http://localhost/video.mp4',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });

        worker.emitMessage({
            audio: null,
            codec: 'avc1.640028',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 18,
            type: 'ready'
        });

        expect(session.getTelemetry().state).toBe('error');
        expect(events.at(-1)).toMatchObject({
            failureKind: 'decode-failed',
            generation: 18,
            type: 'error'
        });
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 18, type: 'stop' });
    });

    it('accepts first-frame coded padding and locks the actual raw geometry', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 19, undefined, 'raw-planes');
        emitRawReady(worker, 19, {
            codedHeight: 1,
            codedWidth: 4,
            displayHeight: 2,
            displayWidth: 4
        });

        emitRawFrame(worker, 19, secondsToMicroseconds(1.1));
        emitRawFrame(worker, 19, secondsToMicroseconds(1.2));

        expect(session.getTelemetry()).toMatchObject({
            abandonedRawFrameCount: 0,
            receivedFrameCount: 2,
            state: 'ready'
        });
    });

    it('rejects raw display geometry that differs from the selected track', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 19, undefined, 'raw-planes');
        emitRawReady(worker, 19);
        const rawFrame = createRawFrame(secondsToMicroseconds(1.1));
        rawFrame.displayWidth = 8;

        worker.emitMessage({
            durationMicroseconds: 100_000,
            frame: rawFrame,
            generation: 19,
            mediaTimeMicroseconds: secondsToMicroseconds(1.1),
            outputMode: 'raw-planes',
            type: 'frame'
        });

        expect(session.getTelemetry()).toMatchObject({
            abandonedRawFrameCount: 1,
            receivedFrameCount: 0,
            state: 'error'
        });
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 19, type: 'stop' });
    });

    it('rejects raw coded geometry changes after the first decoded frame', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 20, undefined, 'raw-planes');
        emitRawReady(worker, 20);
        emitRawFrame(worker, 20, secondsToMicroseconds(1.1));
        const changedFrame = createRawFrame(secondsToMicroseconds(1.2), {
            codedHeight: 4,
            codedWidth: 4,
            displayHeight: 2,
            displayWidth: 4
        });

        worker.emitMessage({
            durationMicroseconds: 100_000,
            frame: changedFrame,
            generation: 20,
            mediaTimeMicroseconds: secondsToMicroseconds(1.2),
            outputMode: 'raw-planes',
            type: 'frame'
        });

        expect(session.getTelemetry()).toMatchObject({
            receivedFrameCount: 1,
            state: 'error'
        });
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 20, type: 'stop' });
    });

    it('rejects first-frame coded padding above the negotiated maximum', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        session.start({
            generation: 21,
            maximumCodedHeight: 2,
            maximumCodedWidth: 4,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: secondsToMicroseconds(1),
            url: 'http://localhost/video.mp4',
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        });
        emitRawReady(worker, 21);
        const oversizedFrame = createRawFrame(secondsToMicroseconds(1.1), {
            codedHeight: 68,
            codedWidth: 4,
            displayHeight: 2,
            displayWidth: 4
        });

        worker.emitMessage({
            durationMicroseconds: 100_000,
            frame: oversizedFrame,
            generation: 21,
            mediaTimeMicroseconds: secondsToMicroseconds(1.1),
            outputMode: 'raw-planes',
            type: 'frame'
        });

        expect(session.getTelemetry()).toMatchObject({
            abandonedRawFrameCount: 1,
            receivedFrameCount: 0,
            state: 'error'
        });
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 21, type: 'stop' });
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

    it('does not recycle a pending raw buffer into a superseding generation', () => {
        const workers = [ new MockWorker(), new MockWorker() ];
        let workerIndex = 0;
        const session = new CustomDecodeSession(
            () => undefined,
            () => workers[workerIndex++] as unknown as Worker
        );

        startSession(session, 14, undefined, 'raw-planes');
        emitRawReady(workers[0], 14);
        emitRawFrame(workers[0], 14, secondsToMicroseconds(1.1));
        const stalePresentationFrame = session.takeFrame(secondsToMicroseconds(1.1));
        startSession(session, 15, undefined, 'raw-planes');
        emitRawReady(workers[1], 15);

        if (!stalePresentationFrame || stalePresentationFrame.outputMode !== 'raw-planes') {
            throw new Error('Expected a pending decoded raw frame');
        }
        const oldWorkerMessageCount = workers[0].postedMessages.length;
        expect(session.acknowledgeFrame(stalePresentationFrame)).toBe(false);
        expect(workers[0].postedMessages).toHaveLength(oldWorkerMessageCount);
        expect(workers[1].postedMessages).toHaveLength(1);
        expect(session.getTelemetry().staleFrameCount).toBe(0);
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

    it('fails closed if queued and pending raw frames exceed the two-buffer pool', () => {
        const worker = new MockWorker();
        const session = new CustomDecodeSession(
            () => undefined,
            () => worker as unknown as Worker
        );
        startSession(session, 16, undefined, 'raw-planes');
        emitRawReady(worker, 16);
        emitRawFrame(worker, 16, secondsToMicroseconds(1.1));
        emitRawFrame(worker, 16, secondsToMicroseconds(1.2));
        const pendingFrame = session.takeFrame(secondsToMicroseconds(1.1));

        expect(session.getTelemetry()).toMatchObject({
            pendingFrameCount: 1,
            queuedFrameCount: 1
        });
        emitRawFrame(worker, 16, secondsToMicroseconds(1.3));

        expect(session.getTelemetry()).toMatchObject({
            abandonedRawFrameCount: 3,
            peakFrameCount: 2,
            pendingFrameCount: 0,
            queuedFrameCount: 0,
            state: 'error'
        });
        expect(worker.postedMessages.at(-1)).toEqual({ generation: 16, type: 'stop' });
        expect(pendingFrame).not.toBeNull();
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

    it('waits for decoded video and accepted PCM before reporting audio media ready', () => {
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
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 9,
            type: 'ready'
        });
        expect(audioBridge.start).toHaveBeenCalledOnce();
        expect(worker.postedMessages.at(-1)).toEqual({
            audioSampleCredits: 3,
            generation: 9,
            type: 'pull-audio'
        });
        expect(events).toEqual([ {
            audio: audioConfiguration,
            codec: 'hev1.2.4.L153.B0',
            generation: 9,
            type: 'configured'
        } ]);

        emitFrame(worker, 9, 1_000_000);
        expect(session.getTelemetry().state).toBe('configured');
        expect(events).toHaveLength(1);

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

    it('feeds native fMP4 audio through one owned backend before clock handoff', async () => {
        const worker = new MockWorker();
        const events: CustomDecodeSessionEvent[] = [];
        let activeBackendGeneration: number | null = null;
        let backendEventHandler: OwnedNativeMediaAudioEventHandler = event => {
            if (event.type === 'error') {
                throw new Error(event.message);
            }
        };
        const appendInitializationSegment = vi.fn(async (): Promise<boolean> => true);
        const appendMediaSegment = vi.fn(async (): Promise<boolean> => true);
        const endOfStream = vi.fn(async (): Promise<boolean> => true);
        const stopBackend = vi.fn(async (generation: number): Promise<boolean> => {
            if (activeBackendGeneration !== generation) {
                return false;
            }
            activeBackendGeneration = null;
            return true;
        });
        const backend: OwnedNativeMediaAudioBackendPort = {
            appendInitializationSegment,
            appendMediaSegment,
            destroy: vi.fn(async (): Promise<void> => undefined),
            endOfStream,
            getAuthoritativeTimeMicroseconds: (): Microseconds | null => null,
            getTelemetry: (): OwnedNativeMediaAudioTelemetry => ({
                activeGeneration: activeBackendGeneration,
                appendedByteLength: 0,
                appendedSegmentCount: 0,
                clockQualified: false,
                currentTimeMicroseconds: null,
                pendingAppendByteLength: 0,
                pendingAppendCount: 0,
                removedRangeCount: 0,
                staleOperationCount: 0,
                state: activeBackendGeneration === null ? 'idle' : 'open'
            }),
            seek: (): boolean => true,
            setMuted: (): void => undefined,
            setPlaybackRate: (): void => undefined,
            setPlaying: async (): Promise<boolean> => true,
            setVolume: (): void => undefined,
            start: async options => {
                activeBackendGeneration = options.generation;
            },
            stop: stopBackend
        };
        const nativeAudioBridge = new CustomDecodeNativeAudioBridge(eventHandler => {
            backendEventHandler = eventHandler;
            return backend;
        });
        const session = new CustomDecodeSession(
            event => events.push(event),
            () => worker as unknown as Worker,
            null,
            null,
            () => nativeAudioBridge
        );
        session.start({
            audioOutputMode: 'native-media',
            audioTrackIndex: 0,
            durationMicroseconds: secondsToMicroseconds(10),
            generation: 30,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: secondsToMicroseconds(1),
            url: 'http://localhost/video.mp4?ApiKey=secret',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });
        expect(worker.postedMessages[0]).toMatchObject({
            audioOutputMode: 'native-media',
            audioSampleCredits: 0,
            audioTrackIndex: 0,
            generation: 30,
            type: 'start'
        });

        const audioConfiguration = {
            channelCount: 6,
            codec: 'ec-3',
            mimeType: 'audio/mp4; codecs="ec-3"',
            outputMode: 'native-media' as const,
            sampleRate: 48_000
        };
        worker.emitMessage({
            audio: audioConfiguration,
            codec: 'hev1.2.4.L153.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 30,
            type: 'ready'
        });
        await vi.waitFor(() => expect(worker.postedMessages.at(-1)).toEqual({
            audioSampleCredits: 2,
            generation: 30,
            type: 'pull-audio'
        }));
        emitFrame(worker, 30, 1_000_000);
        expect(session.getTelemetry().state).toBe('configured');

        worker.emitMessage({
            data: new Uint8Array([ 1, 2 ]).buffer,
            generation: 30,
            type: 'native-audio-init'
        });
        worker.emitMessage({
            data: new Uint8Array([ 3, 4 ]).buffer,
            endTimeMicroseconds: 1_500_000,
            generation: 30,
            startTimeMicroseconds: 1_000_000,
            type: 'native-audio-media'
        });
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        expect(appendInitializationSegment).toHaveBeenCalledOnce();
        expect(appendMediaSegment).toHaveBeenCalledOnce();
        expect(worker.postedMessages.at(-1)).toEqual({
            audioSampleCredits: 1,
            generation: 30,
            type: 'pull-audio'
        });
        expect(session.getTelemetry().state).toBe('ready');
        expect(events.at(-1)).toEqual({
            audio: audioConfiguration,
            codec: 'hev1.2.4.L153.B0',
            generation: 30,
            type: 'ready'
        });
        const readyEventCount = events.filter(event => event.type === 'ready').length;

        backendEventHandler({ generation: 30, type: 'clock-ready' });
        expect(session.getTelemetry()).toMatchObject({
            nativeAudioClockReady: true,
            state: 'ready'
        });
        expect(events.filter(event => event.type === 'ready')).toHaveLength(readyEventCount);

        worker.emitMessage({ generation: 30, type: 'ended' });
        await Promise.resolve();
        await Promise.resolve();
        expect(endOfStream).toHaveBeenCalledWith(30);
        expect(session.getTelemetry().state).toBe('ready');

        backendEventHandler({ generation: 30, type: 'ended' });
        expect(events.at(-1)).toEqual({ generation: 30, type: 'ended' });
        expect(session.getTelemetry().state).toBe('ended');

        const stopPromise = session.stop();
        worker.emitMessage({ generation: 30, type: 'stopped' });
        await stopPromise;
        expect(stopBackend).toHaveBeenCalledWith(30);
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
