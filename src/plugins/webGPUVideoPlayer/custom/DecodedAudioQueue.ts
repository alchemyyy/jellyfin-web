import type { Microseconds } from '../MediaTime';
import { addMicroseconds, audioFramesToMicroseconds, requireMicroseconds } from './TimeMath';

export const AUDIO_QUEUE_OVERFLOW_POLICY = 'reject-new';
export const DEFAULT_MAX_AUDIO_QUEUE_CHUNKS = 1_024;
export const MAX_AUDIO_QUEUE_CHUNKS = 65_536;
export const MAX_DECODED_AUDIO_CHANNEL_COUNT = 32;

export type DecodedAudioChunk = {
    channelData: readonly Float32Array[]
    timestampMicroseconds: Microseconds
};

export type AudioQueueEnqueueResult = {
    accepted: boolean
    frameCount: number
    reason: 'accepted' | 'frame-capacity' | 'chunk-capacity' | 'stale-generation'
};

export type AudioQueueReadResult = {
    endMediaTimeMicroseconds: Microseconds
    framesRead: number
    startMediaTimeMicroseconds: Microseconds
    underflowFrames: number
};

export type DecodedAudioQueueTelemetry = {
    dequeuedFrames: number
    droppedFrames: number
    enqueuedFrames: number
    generation: number
    highWatermarkFrames: number
    overflowEvents: number
    queuedFrames: number
    staleChunks: number
    underflowEvents: number
    underflowFrames: number
};

export type DecodedAudioQueueOptions = {
    channelCount: number
    initialMediaTimeMicroseconds?: Microseconds
    maxBufferedFrames: number
    maxChunks?: number
    sampleRate: number
};

type QueuedAudioChunk = {
    channelData: readonly Float32Array[]
    frameOffset: number
    timestampMicroseconds: Microseconds
};

const INITIAL_GENERATION = 1;

/** A bounded FIFO for decoded planar PCM with silence-on-underflow reads. */
export default class DecodedAudioQueue {
    public readonly channelCount: number;
    public readonly maxBufferedFrames: number;
    public readonly maxChunks: number;
    public readonly overflowPolicy = AUDIO_QUEUE_OVERFLOW_POLICY;
    public readonly sampleRate: number;

    private chunkCount = 0;
    private currentGeneration = INITIAL_GENERATION;
    private cursorMediaTimeMicroseconds: Microseconds;
    private headChunkIndex = 0;
    private queuedFrameCount = 0;
    private readonly queuedChunks: Array<QueuedAudioChunk | undefined>;
    private tailChunkIndex = 0;
    private readonly telemetryCounters = {
        dequeuedFrames: 0,
        droppedFrames: 0,
        enqueuedFrames: 0,
        highWatermarkFrames: 0,
        overflowEvents: 0,
        staleChunks: 0,
        underflowEvents: 0,
        underflowFrames: 0
    };

    public constructor(options: DecodedAudioQueueOptions) {
        this.channelCount = this.requirePositiveInteger(options.channelCount, 'Channel count');
        if (this.channelCount > MAX_DECODED_AUDIO_CHANNEL_COUNT) {
            throw new RangeError(`Channel count cannot exceed ${MAX_DECODED_AUDIO_CHANNEL_COUNT}`);
        }
        this.maxBufferedFrames = this.requirePositiveInteger(options.maxBufferedFrames, 'Maximum buffered frames');
        this.maxChunks = this.requirePositiveInteger(
            options.maxChunks ?? DEFAULT_MAX_AUDIO_QUEUE_CHUNKS,
            'Maximum audio chunks'
        );
        if (this.maxChunks > MAX_AUDIO_QUEUE_CHUNKS) {
            throw new RangeError(`Maximum audio chunks cannot exceed ${MAX_AUDIO_QUEUE_CHUNKS}`);
        }
        this.sampleRate = this.requirePositiveInteger(options.sampleRate, 'Sample rate');
        this.cursorMediaTimeMicroseconds = requireMicroseconds(
            options.initialMediaTimeMicroseconds ?? 0
        );
        this.queuedChunks = new Array<QueuedAudioChunk | undefined>(this.maxChunks);
    }

    public get generation(): number {
        return this.currentGeneration;
    }

    public get queuedFrames(): number {
        return this.queuedFrameCount;
    }

    /** Enqueues one complete chunk or rejects it without consuming ownership. */
    public enqueue(chunk: DecodedAudioChunk, generation: number): AudioQueueEnqueueResult {
        const frameCount = this.validateChunk(chunk);
        if (generation !== this.currentGeneration) {
            this.telemetryCounters.staleChunks += 1;
            this.telemetryCounters.droppedFrames += frameCount;
            return { accepted: false, frameCount, reason: 'stale-generation' };
        }

        if (frameCount > this.maxBufferedFrames - this.queuedFrameCount) {
            this.telemetryCounters.overflowEvents += 1;
            this.telemetryCounters.droppedFrames += frameCount;
            return { accepted: false, frameCount, reason: 'frame-capacity' };
        }

        if (this.chunkCount === this.maxChunks) {
            this.telemetryCounters.overflowEvents += 1;
            this.telemetryCounters.droppedFrames += frameCount;
            return { accepted: false, frameCount, reason: 'chunk-capacity' };
        }

        this.queuedChunks[this.tailChunkIndex] = {
            channelData: chunk.channelData,
            frameOffset: 0,
            timestampMicroseconds: requireMicroseconds(chunk.timestampMicroseconds)
        };
        this.tailChunkIndex = (this.tailChunkIndex + 1) % this.maxChunks;
        this.chunkCount += 1;
        this.queuedFrameCount += frameCount;
        this.telemetryCounters.enqueuedFrames += frameCount;
        this.telemetryCounters.highWatermarkFrames = Math.max(
            this.telemetryCounters.highWatermarkFrames,
            this.queuedFrameCount
        );
        return { accepted: true, frameCount, reason: 'accepted' };
    }

    /** Reads a render quantum and zero-fills every unavailable output frame. */
    public read(destinationChannels: readonly Float32Array[], frameCount: number): AudioQueueReadResult {
        this.validateDestination(destinationChannels, frameCount);
        let startMediaTimeMicroseconds = this.cursorMediaTimeMicroseconds;
        let destinationOffset = 0;

        while (destinationOffset < frameCount && this.chunkCount > 0) {
            const queuedChunk = this.queuedChunks[this.headChunkIndex];
            if (!queuedChunk) {
                throw new Error('Audio queue chunk state is inconsistent');
            }

            const chunkFrameCount = queuedChunk.channelData[0].length;
            const availableFrames = chunkFrameCount - queuedChunk.frameOffset;
            const copiedFrames = Math.min(availableFrames, frameCount - destinationOffset);
            if (destinationOffset === 0) {
                startMediaTimeMicroseconds = addMicroseconds(
                    queuedChunk.timestampMicroseconds,
                    audioFramesToMicroseconds(queuedChunk.frameOffset, this.sampleRate)
                );
            }
            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                const sourceChannel = queuedChunk.channelData[channelIndex];
                destinationChannels[channelIndex].set(
                    sourceChannel.subarray(queuedChunk.frameOffset, queuedChunk.frameOffset + copiedFrames),
                    destinationOffset
                );
            }

            queuedChunk.frameOffset += copiedFrames;
            destinationOffset += copiedFrames;
            this.queuedFrameCount -= copiedFrames;
            this.telemetryCounters.dequeuedFrames += copiedFrames;
            this.cursorMediaTimeMicroseconds = addMicroseconds(
                queuedChunk.timestampMicroseconds,
                audioFramesToMicroseconds(queuedChunk.frameOffset, this.sampleRate)
            );

            if (queuedChunk.frameOffset === chunkFrameCount) {
                this.queuedChunks[this.headChunkIndex] = undefined;
                this.headChunkIndex = (this.headChunkIndex + 1) % this.maxChunks;
                this.chunkCount -= 1;
            }
        }

        const underflowFrames = frameCount - destinationOffset;
        if (underflowFrames > 0) {
            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                destinationChannels[channelIndex].fill(0, destinationOffset, frameCount);
            }
            this.telemetryCounters.underflowEvents += 1;
            this.telemetryCounters.underflowFrames += underflowFrames;
            this.cursorMediaTimeMicroseconds = addMicroseconds(
                this.cursorMediaTimeMicroseconds,
                audioFramesToMicroseconds(underflowFrames, this.sampleRate)
            );
        }

        return {
            endMediaTimeMicroseconds: this.cursorMediaTimeMicroseconds,
            framesRead: destinationOffset,
            startMediaTimeMicroseconds,
            underflowFrames
        };
    }

    /** Drops all queued PCM, advances the generation, and resets the cursor. */
    public flush(mediaTimeMicroseconds: Microseconds): number {
        for (let chunkIndex = 0; chunkIndex < this.maxChunks; chunkIndex += 1) {
            this.queuedChunks[chunkIndex] = undefined;
        }
        this.headChunkIndex = 0;
        this.tailChunkIndex = 0;
        this.chunkCount = 0;
        this.queuedFrameCount = 0;
        this.cursorMediaTimeMicroseconds = requireMicroseconds(mediaTimeMicroseconds);
        return this.advanceGeneration();
    }

    /** Returns a stable copy of cumulative queue telemetry. */
    public getTelemetry(): DecodedAudioQueueTelemetry {
        return {
            ...this.telemetryCounters,
            generation: this.currentGeneration,
            queuedFrames: this.queuedFrameCount
        };
    }

    private validateChunk(chunk: DecodedAudioChunk): number {
        requireMicroseconds(chunk.timestampMicroseconds);
        if (chunk.channelData.length !== this.channelCount) {
            throw new RangeError(`Expected ${this.channelCount} planar audio channels`);
        }

        const firstChannel = chunk.channelData[0];
        if (!(firstChannel instanceof Float32Array) || firstChannel.length === 0) {
            throw new RangeError('Decoded audio chunks must contain at least one Float32 frame');
        }

        const frameCount = firstChannel.length;
        for (let channelIndex = 1; channelIndex < this.channelCount; channelIndex += 1) {
            const channel = chunk.channelData[channelIndex];
            if (!(channel instanceof Float32Array) || channel.length !== frameCount) {
                throw new RangeError('All decoded audio channels must have the same frame count');
            }
        }
        return frameCount;
    }

    private validateDestination(destinationChannels: readonly Float32Array[], frameCount: number): void {
        if (!Number.isSafeInteger(frameCount) || frameCount < 0) {
            throw new RangeError('Requested audio frame count must be a non-negative safe integer');
        }

        if (destinationChannels.length !== this.channelCount) {
            throw new RangeError(`Expected ${this.channelCount} destination channels`);
        }

        for (const destinationChannel of destinationChannels) {
            if (!(destinationChannel instanceof Float32Array) || destinationChannel.length < frameCount) {
                throw new RangeError('Each destination channel must fit the requested frame count');
            }
        }
    }

    private requirePositiveInteger(value: number, label: string): number {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new RangeError(`${label} must be a positive safe integer`);
        }
        return value;
    }

    private advanceGeneration(): number {
        if (this.currentGeneration === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Audio queue generation exhausted');
        }
        this.currentGeneration += 1;
        return this.currentGeneration;
    }
}
