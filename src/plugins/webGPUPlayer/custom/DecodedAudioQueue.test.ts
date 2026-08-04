import { describe, expect, it } from 'vitest';

import { secondsToMicroseconds } from '../MediaTime';
import DecodedAudioQueue, { AUDIO_QUEUE_OVERFLOW_POLICY } from './DecodedAudioQueue';

function createStereoChunk(
    left: readonly number[],
    right: readonly number[],
    timestampSeconds: number
): { channelData: Float32Array[]; timestampMicroseconds: ReturnType<typeof secondsToMicroseconds> } {
    return {
        channelData: [ new Float32Array(left), new Float32Array(right) ],
        timestampMicroseconds: secondsToMicroseconds(timestampSeconds)
    };
}

describe('DecodedAudioQueue', () => {
    it('reads planar PCM in order and fills an explicit underflow with silence', () => {
        const queue = new DecodedAudioQueue({
            channelCount: 2,
            maxBufferedFrames: 8,
            sampleRate: 1_000
        });
        const generation = queue.generation;
        queue.enqueue(createStereoChunk([ 1, 2, 3 ], [ 4, 5, 6 ], 2), generation);
        const destinations = [ new Float32Array(5), new Float32Array(5) ];

        const result = queue.read(destinations, 5);

        expect(Array.from(destinations[0])).toEqual([ 1, 2, 3, 0, 0 ]);
        expect(Array.from(destinations[1])).toEqual([ 4, 5, 6, 0, 0 ]);
        expect(result).toEqual({
            endMediaTimeMicroseconds: 2_005_000,
            framesRead: 3,
            startMediaTimeMicroseconds: 2_000_000,
            underflowFrames: 2
        });
        expect(queue.getTelemetry()).toMatchObject({
            dequeuedFrames: 3,
            queuedFrames: 0,
            underflowEvents: 1,
            underflowFrames: 2
        });
    });

    it('rejects new chunks on frame overflow without evicting queued audio', () => {
        const queue = new DecodedAudioQueue({
            channelCount: 2,
            maxBufferedFrames: 4,
            sampleRate: 48_000
        });
        expect(queue.overflowPolicy).toBe(AUDIO_QUEUE_OVERFLOW_POLICY);
        expect(queue.enqueue(createStereoChunk([ 1, 2, 3 ], [ 4, 5, 6 ], 0), queue.generation)).toEqual({
            accepted: true,
            frameCount: 3,
            reason: 'accepted'
        });
        expect(queue.enqueue(createStereoChunk([ 7, 8 ], [ 9, 10 ], 1), queue.generation)).toEqual({
            accepted: false,
            frameCount: 2,
            reason: 'frame-capacity'
        });
        expect(queue.queuedFrames).toBe(3);
        expect(queue.getTelemetry()).toMatchObject({
            droppedFrames: 2,
            highWatermarkFrames: 3,
            overflowEvents: 1
        });
    });

    it('bounds chunk references independently of frame capacity', () => {
        const queue = new DecodedAudioQueue({
            channelCount: 2,
            maxBufferedFrames: 10,
            maxChunks: 1,
            sampleRate: 48_000
        });
        queue.enqueue(createStereoChunk([ 1 ], [ 2 ], 0), queue.generation);

        expect(queue.enqueue(createStereoChunk([ 3 ], [ 4 ], 1), queue.generation).reason)
            .toBe('chunk-capacity');

        queue.read([ new Float32Array(1), new Float32Array(1) ], 1);
        expect(queue.enqueue(createStereoChunk([ 5 ], [ 6 ], 2), queue.generation).accepted).toBe(true);
    });

    it('flushes the ring and rejects stale decoder generations', () => {
        const queue = new DecodedAudioQueue({
            channelCount: 2,
            initialMediaTimeMicroseconds: secondsToMicroseconds(-2),
            maxBufferedFrames: 8,
            maxChunks: 2,
            sampleRate: 1_000
        });
        const staleGeneration = queue.generation;
        queue.enqueue(createStereoChunk([ 1, 2 ], [ 3, 4 ], -2), staleGeneration);

        const currentGeneration = queue.flush(secondsToMicroseconds(10));
        expect(queue.queuedFrames).toBe(0);
        expect(queue.enqueue(createStereoChunk([ 5 ], [ 6 ], 10), staleGeneration)).toEqual({
            accepted: false,
            frameCount: 1,
            reason: 'stale-generation'
        });
        expect(queue.enqueue(createStereoChunk([ 7 ], [ 8 ], 10), currentGeneration).accepted).toBe(true);
        expect(queue.getTelemetry()).toMatchObject({ droppedFrames: 1, staleChunks: 1 });
    });

    it('validates channel shapes and destination capacity', () => {
        const queue = new DecodedAudioQueue({
            channelCount: 2,
            maxBufferedFrames: 8,
            sampleRate: 48_000
        });

        expect(() => queue.enqueue({
            channelData: [ new Float32Array(2) ],
            timestampMicroseconds: secondsToMicroseconds(0)
        }, queue.generation)).toThrow('Expected 2 planar audio channels');
        expect(() => queue.enqueue(createStereoChunk([ 1 ], [ 2, 3 ], 0), queue.generation))
            .toThrow('same frame count');
        expect(() => queue.read([ new Float32Array(1), new Float32Array(1) ], 2))
            .toThrow('fit the requested frame count');
    });
});
