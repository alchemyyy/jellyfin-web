export const CUSTOM_AUDIO_WORKLET_PROCESSOR_NAME = 'jellyfin-custom-audio-output-v1';

// This self-contained module is loaded through AudioWorklet.addModule(). It uses
// transferable ArrayBuffers today and leaves the message protocol open for SAB.
const CUSTOM_AUDIO_WORKLET_SOURCE = `'use strict';

const MICROSECONDS_PER_SECOND = 1000000;

class JellyfinCustomAudioOutputProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const processorOptions = options.processorOptions || {};
        this.channelCount = processorOptions.channelCount;
        this.maxBufferedFrames = processorOptions.maxBufferedFrames;
        this.maxChunks = processorOptions.maxChunks;
        this.telemetryIntervalFrames = processorOptions.telemetryIntervalFrames;
        this.chunks = new Array(this.maxChunks);
        this.headChunkIndex = 0;
        this.tailChunkIndex = 0;
        this.chunkCount = 0;
        this.queuedFrames = 0;
        this.generation = 1;
        this.playing = false;
        this.volume = 1;
        this.muted = false;
        this.destroyed = false;
        this.consumedFrames = 0;
        this.outputFrames = 0;
        this.droppedFrames = 0;
        this.overflowEvents = 0;
        this.overflowFrames = 0;
        this.staleChunks = 0;
        this.underflowEvents = 0;
        this.underflowFrames = 0;
        this.framesSinceTelemetry = 0;
        this.mediaTimeContextTimeMicroseconds = null;
        this.mediaTimeMicroseconds = 0;
        this.underflowActive = false;
        this.port.onmessage = messageEvent => this.handleMessage(messageEvent.data);
    }

    handleMessage(message) {
        if (!message || typeof message.type !== 'string') {
            return;
        }

        switch (message.type) {
            case 'enqueue':
                this.enqueue(message);
                break;
            case 'flush':
                this.flush(message.generation, message.mediaTimeMicroseconds);
                break;
            case 'gain':
                this.setGain(message.volume, message.muted);
                break;
            case 'playback':
                this.playing = message.playing === true;
                break;
            case 'destroy':
                this.clearQueue();
                this.destroyed = true;
                break;
            default:
                break;
        }
    }

    enqueue(message) {
        if (message.generation !== this.generation) {
            const staleFrameCount = this.getFrameCount(message.channelData);
            this.staleChunks += 1;
            this.droppedFrames += staleFrameCount;
            this.postTelemetry('stale-generation', message.sequence);
            return;
        }

        const frameCount = this.getFrameCount(message.channelData);
        if (frameCount <= 0 || message.channelData.length !== this.channelCount) {
            this.droppedFrames += Math.max(0, frameCount);
            this.postTelemetry('overflow', message.sequence);
            return;
        }

        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            const channel = message.channelData[channelIndex];
            if (!(channel instanceof Float32Array) || channel.length !== frameCount) {
                this.droppedFrames += frameCount;
                this.postTelemetry('overflow', message.sequence);
                return;
            }
        }

        if (this.chunkCount === this.maxChunks || frameCount > this.maxBufferedFrames - this.queuedFrames) {
            this.droppedFrames += frameCount;
            this.overflowFrames += frameCount;
            this.overflowEvents += 1;
            this.postTelemetry('overflow', message.sequence);
            return;
        }

        this.chunks[this.tailChunkIndex] = {
            channelData: message.channelData,
            frameOffset: 0,
            timestampMicroseconds: message.timestampMicroseconds
        };
        this.tailChunkIndex = (this.tailChunkIndex + 1) % this.maxChunks;
        this.chunkCount += 1;
        this.queuedFrames += frameCount;
        this.postTelemetry('enqueue', message.sequence);
    }

    getFrameCount(channelData) {
        if (!Array.isArray(channelData) || channelData.length === 0) {
            return 0;
        }
        const firstChannel = channelData[0];
        return firstChannel instanceof Float32Array ? firstChannel.length : 0;
    }

    setGain(volume, muted) {
        if (Number.isFinite(volume) && volume >= 0 && volume <= 1) {
            this.volume = volume;
        }
        this.muted = muted === true;
    }

    flush(generation, mediaTimeMicroseconds) {
        this.clearQueue();
        this.generation = generation;
        this.mediaTimeContextTimeMicroseconds = null;
        this.mediaTimeMicroseconds = mediaTimeMicroseconds;
        this.underflowActive = false;
        this.postTelemetry('flush', null);
    }

    clearQueue() {
        while (this.chunkCount > 0) {
            this.chunks[this.headChunkIndex] = undefined;
            this.headChunkIndex = (this.headChunkIndex + 1) % this.maxChunks;
            this.chunkCount -= 1;
        }
        this.headChunkIndex = 0;
        this.tailChunkIndex = 0;
        this.queuedFrames = 0;
    }

    process(inputs, outputs) {
        if (this.destroyed) {
            return false;
        }

        const outputChannels = outputs[0];
        if (!outputChannels || outputChannels.length === 0) {
            return true;
        }

        const renderFrameCount = outputChannels[0].length;
        for (let channelIndex = 0; channelIndex < outputChannels.length; channelIndex += 1) {
            outputChannels[channelIndex].fill(0);
        }

        if (!this.playing) {
            return true;
        }

        let outputOffset = 0;
        const gain = this.muted ? 0 : this.volume;
        while (outputOffset < renderFrameCount && this.chunkCount > 0) {
            const chunk = this.chunks[this.headChunkIndex];
            const chunkFrameCount = chunk.channelData[0].length;
            const availableFrames = chunkFrameCount - chunk.frameOffset;
            const copiedFrames = Math.min(availableFrames, renderFrameCount - outputOffset);
            const outputChannelCount = Math.min(outputChannels.length, this.channelCount);
            for (let channelIndex = 0; channelIndex < outputChannelCount; channelIndex += 1) {
                const sourceChannel = chunk.channelData[channelIndex];
                const outputChannel = outputChannels[channelIndex];
                if (gain === 1) {
                    outputChannel.set(
                        sourceChannel.subarray(chunk.frameOffset, chunk.frameOffset + copiedFrames),
                        outputOffset
                    );
                } else if (gain !== 0) {
                    for (let frameIndex = 0; frameIndex < copiedFrames; frameIndex += 1) {
                        outputChannel[outputOffset + frameIndex] = sourceChannel[chunk.frameOffset + frameIndex] * gain;
                    }
                }
            }

            chunk.frameOffset += copiedFrames;
            outputOffset += copiedFrames;
            this.queuedFrames -= copiedFrames;
            this.consumedFrames += copiedFrames;
            this.mediaTimeMicroseconds = chunk.timestampMicroseconds
                + Math.round((chunk.frameOffset * MICROSECONDS_PER_SECOND) / sampleRate);
            this.mediaTimeContextTimeMicroseconds = this.framesToMicroseconds(
                currentFrame + outputOffset
            );

            if (chunk.frameOffset === chunkFrameCount) {
                this.chunks[this.headChunkIndex] = undefined;
                this.headChunkIndex = (this.headChunkIndex + 1) % this.maxChunks;
                this.chunkCount -= 1;
            }
        }

        const underflowFrameCount = renderFrameCount - outputOffset;
        if (underflowFrameCount > 0) {
            this.underflowFrames += underflowFrameCount;
            if (!this.underflowActive) {
                this.underflowActive = true;
                this.underflowEvents += 1;
                this.postTelemetry('underflow', null);
            }
        } else if (this.underflowActive) {
            this.underflowActive = false;
            this.postTelemetry('underflow-recovered', null);
        }

        this.outputFrames += renderFrameCount;
        this.framesSinceTelemetry += renderFrameCount;
        if (this.framesSinceTelemetry >= this.telemetryIntervalFrames) {
            this.framesSinceTelemetry %= this.telemetryIntervalFrames;
            this.postTelemetry('periodic', null);
        }
        return true;
    }

    framesToMicroseconds(frameCount) {
        const wholeSeconds = Math.floor(frameCount / sampleRate);
        const remainingFrames = frameCount - wholeSeconds * sampleRate;
        return wholeSeconds * MICROSECONDS_PER_SECOND
            + Math.round((remainingFrames * MICROSECONDS_PER_SECOND) / sampleRate);
    }

    postTelemetry(reason, sequence) {
        this.port.postMessage({
            consumedFrames: this.consumedFrames,
            droppedFrames: this.droppedFrames,
            generation: this.generation,
            hasPhysicalOutputTimeCorrelation: false,
            mediaTimeContextTimeMicroseconds: this.mediaTimeContextTimeMicroseconds,
            mediaTimeMicroseconds: this.mediaTimeMicroseconds,
            muted: this.muted,
            outputFrames: this.outputFrames,
            overflowEvents: this.overflowEvents,
            overflowFrames: this.overflowFrames,
            playing: this.playing,
            queuedFrames: this.queuedFrames,
            reason,
            sequence,
            staleChunks: this.staleChunks,
            type: 'telemetry',
            underflowEvents: this.underflowEvents,
            underflowFrames: this.underflowFrames,
            volume: this.volume
        });
    }
}

registerProcessor('jellyfin-custom-audio-output-v1', JellyfinCustomAudioOutputProcessor);
`;

/** Creates an object URL for the self-contained transferable-PCM worklet. */
export function createCustomAudioWorkletModuleURL(): string {
    const sourceBlob = new Blob([ CUSTOM_AUDIO_WORKLET_SOURCE ], { type: 'text/javascript' });
    return URL.createObjectURL(sourceBlob);
}

/** Exposes the source for deterministic validation without evaluating it. */
export function getCustomAudioWorkletSource(): string {
    return CUSTOM_AUDIO_WORKLET_SOURCE;
}
