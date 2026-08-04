import type { Microseconds } from '../MediaTime';
import {
    addMicroseconds,
    audioFramesToMicroseconds,
    requireMicroseconds
} from './TimeMath';
import { requireSupportedCustomAudioSampleRate } from './CustomAudioSampleRate';

const FILTER_CUTOFF_HEADROOM = 0.94;
const FILTER_PHASE_COUNT = 2_048;
const FILTER_RADIUS = 32;
const FILTER_TAP_COUNT = FILTER_RADIUS * 2;
const MICROSECONDS_PER_SECOND = 1_000_000;

export type StreamingAudioResamplerOptions = {
    channelCount: number
    maximumOutputFrameCount: number
    maximumTimestampQuantizationMicroseconds: number
    minimumOutputFrameCount: number
    sourceSampleRate: number
    targetSampleRate: number
};

export type StreamingAudioResamplerInput = {
    channelData: readonly Float32Array[]
    mediaTimeMicroseconds: Microseconds
};

export type StreamingAudioResamplerOutput = {
    channelData: Float32Array[]
    durationMicroseconds: Microseconds
    frameCount: number
    mediaTimeMicroseconds: Microseconds
    sampleRate: number
};

export type StreamingAudioResamplerTelemetry = {
    bufferedSourceFrameCount: number
    correctedInputTimestampCount: number
    filterLatencySourceFrames: number
    finalized: boolean
    maximumInputTimestampDeviationMicroseconds: number
    outputFrameCount: number
    sourceFrameCount: number
};

function requirePositiveSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
    }
    return value;
}

function requireNonNegativeSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
    }
    return value;
}

function sinc(value: number): number {
    if (Math.abs(value) < Number.EPSILON) {
        return 1;
    }
    const angle = Math.PI * value;
    return Math.sin(angle) / angle;
}

function blackmanWindow(normalizedDistance: number): number {
    if (Math.abs(normalizedDistance) >= 1) {
        return 0;
    }
    return 0.42
        + 0.5 * Math.cos(Math.PI * normalizedDistance)
        + 0.08 * Math.cos(2 * Math.PI * normalizedDistance);
}

function createFilterTable(sourceSampleRate: number, targetSampleRate: number): Float64Array {
    const cutoff = Math.min(1, targetSampleRate / sourceSampleRate)
        * FILTER_CUTOFF_HEADROOM;
    const table = new Float64Array((FILTER_PHASE_COUNT + 1) * FILTER_TAP_COUNT);
    for (let phaseIndex = 0; phaseIndex <= FILTER_PHASE_COUNT; phaseIndex += 1) {
        const fraction = phaseIndex / FILTER_PHASE_COUNT;
        const phaseOffset = phaseIndex * FILTER_TAP_COUNT;
        let coefficientSum = 0;
        for (let tapIndex = 0; tapIndex < FILTER_TAP_COUNT; tapIndex += 1) {
            const distance = tapIndex - FILTER_RADIUS + 1 - fraction;
            const coefficient = cutoff
                * sinc(cutoff * distance)
                * blackmanWindow(distance / FILTER_RADIUS);
            table[phaseOffset + tapIndex] = coefficient;
            coefficientSum += coefficient;
        }
        if (!Number.isFinite(coefficientSum) || Math.abs(coefficientSum) < Number.EPSILON) {
            throw new Error('Unable to construct the audio resampling filter');
        }
        for (let tapIndex = 0; tapIndex < FILTER_TAP_COUNT; tapIndex += 1) {
            table[phaseOffset + tapIndex] /= coefficientSum;
        }
    }
    return table;
}

/**
 * Converts contiguous planar PCM with one bounded, windowed-sinc streaming
 * stage. Symmetric lookahead preserves media timestamps instead of adding A/V
 * delay, while finalization edge-extends only the terminal filter tail.
 */
export default class StreamingAudioResampler {
    public readonly channelCount: number;
    public readonly maximumOutputFrameCount: number;
    public readonly maximumTimestampQuantizationMicroseconds: number;
    public readonly minimumOutputFrameCount: number;
    public readonly sourceSampleRate: number;
    public readonly targetSampleRate: number;

    private anchorMediaTimeMicroseconds: Microseconds | null = null;
    private bufferStartSourceFrame = 0;
    private readonly channelBuffers: Float32Array[] = [];
    private correctedInputTimestampCount = 0;
    private readonly filterTable: Float64Array | null;
    private finalized = false;
    private readonly firstSourceValues: number[] = [];
    private readonly lastSourceValues: number[] = [];
    private maximumInputTimestampDeviationMicroseconds = 0;
    private nextOutputFrame = 0;
    private totalSourceFrames = 0;

    public constructor(options: StreamingAudioResamplerOptions) {
        this.channelCount = requirePositiveSafeInteger(options.channelCount, 'Channel count');
        this.maximumOutputFrameCount = requirePositiveSafeInteger(
            options.maximumOutputFrameCount,
            'Maximum output frame count'
        );
        this.maximumTimestampQuantizationMicroseconds = requireNonNegativeSafeInteger(
            options.maximumTimestampQuantizationMicroseconds,
            'Maximum timestamp quantization'
        );
        this.minimumOutputFrameCount = requirePositiveSafeInteger(
            options.minimumOutputFrameCount,
            'Minimum output frame count'
        );
        if (this.minimumOutputFrameCount > this.maximumOutputFrameCount) {
            throw new RangeError(
                'Minimum output frame count cannot exceed maximum output frame count'
            );
        }
        this.sourceSampleRate = requireSupportedCustomAudioSampleRate(
            options.sourceSampleRate,
            'Source sample rate'
        );
        this.targetSampleRate = requireSupportedCustomAudioSampleRate(
            options.targetSampleRate,
            'Target sample rate'
        );

        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            this.channelBuffers.push(new Float32Array(0));
            this.firstSourceValues.push(0);
            this.lastSourceValues.push(0);
        }
        this.filterTable = this.sourceSampleRate === this.targetSampleRate ?
            null :
            createFilterTable(this.sourceSampleRate, this.targetSampleRate);
    }

    /** Adds one contiguous source chunk and returns every newly available output chunk. */
    public push(input: StreamingAudioResamplerInput): StreamingAudioResamplerOutput[] {
        if (this.finalized) {
            throw new Error('Cannot add audio after resampler finalization');
        }
        const frameCount = this.validateInput(input);
        this.validateAndSetTimestamp(input.mediaTimeMicroseconds);

        if (this.totalSourceFrames === 0) {
            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                this.firstSourceValues[channelIndex] = input.channelData[channelIndex][0];
            }
        }
        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            this.lastSourceValues[channelIndex] = input.channelData[channelIndex][frameCount - 1];
        }

        this.appendInput(input.channelData, frameCount);
        this.totalSourceFrames += frameCount;
        if (this.filterTable === null) {
            return this.renderPassthroughAvailable(false);
        }
        return this.renderAvailable(false);
    }

    /** Flushes the symmetric filter tail exactly once. */
    public finalize(): StreamingAudioResamplerOutput[] {
        if (this.finalized) {
            return [];
        }
        this.finalized = true;
        if (this.totalSourceFrames === 0) {
            return [];
        }
        const output = this.filterTable === null ?
            this.renderPassthroughAvailable(true) :
            this.renderAvailable(true);
        for (let channelIndex = 0; channelIndex < this.channelBuffers.length; channelIndex += 1) {
            this.channelBuffers[channelIndex] = new Float32Array(0);
        }
        this.bufferStartSourceFrame = this.totalSourceFrames;
        return output;
    }

    /** Returns bounded history and exact frame accounting for diagnostics. */
    public getTelemetry(): StreamingAudioResamplerTelemetry {
        return {
            bufferedSourceFrameCount: this.channelBuffers[0]?.length ?? 0,
            correctedInputTimestampCount: this.correctedInputTimestampCount,
            filterLatencySourceFrames: this.filterTable === null ? 0 : FILTER_RADIUS,
            finalized: this.finalized,
            maximumInputTimestampDeviationMicroseconds:
                this.maximumInputTimestampDeviationMicroseconds,
            outputFrameCount: this.nextOutputFrame,
            sourceFrameCount: this.totalSourceFrames
        };
    }

    private validateInput(input: StreamingAudioResamplerInput): number {
        requireMicroseconds(input.mediaTimeMicroseconds, 'Resampler input media time');
        if (input.channelData.length !== this.channelCount) {
            throw new RangeError(`Expected ${this.channelCount} resampler input channels`);
        }
        const frameCount = input.channelData[0]?.length ?? 0;
        if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
            throw new RangeError('Resampler input must contain at least one frame');
        }
        for (const channel of input.channelData) {
            if (!(channel instanceof Float32Array) || channel.length !== frameCount) {
                throw new RangeError('Resampler input channels must be equal-length Float32Array values');
            }
        }
        return frameCount;
    }

    private validateAndSetTimestamp(mediaTimeMicroseconds: Microseconds): void {
        if (this.anchorMediaTimeMicroseconds === null) {
            this.anchorMediaTimeMicroseconds = mediaTimeMicroseconds;
            return;
        }
        const expectedMediaTimeMicroseconds = addMicroseconds(
            this.anchorMediaTimeMicroseconds,
            audioFramesToMicroseconds(this.totalSourceFrames, this.sourceSampleRate)
        );
        const timestampDeviationMicroseconds = Math.abs(
            mediaTimeMicroseconds - expectedMediaTimeMicroseconds
        );
        const timestampToleranceMicroseconds =
            this.maximumTimestampQuantizationMicroseconds
            + Math.ceil(MICROSECONDS_PER_SECOND / this.sourceSampleRate);
        if (timestampDeviationMicroseconds > timestampToleranceMicroseconds) {
            throw new RangeError('Resampler input timestamps contain a gap or overlap');
        }
        if (timestampDeviationMicroseconds > 0) {
            // The anchor and current Matroska timestamps are independently quantized
            this.correctedInputTimestampCount += 1;
            this.maximumInputTimestampDeviationMicroseconds = Math.max(
                this.maximumInputTimestampDeviationMicroseconds,
                timestampDeviationMicroseconds
            );
        }
    }

    private appendInput(channelData: readonly Float32Array[], frameCount: number): void {
        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            const previousBuffer = this.channelBuffers[channelIndex];
            const combinedBuffer = new Float32Array(previousBuffer.length + frameCount);
            combinedBuffer.set(previousBuffer);
            combinedBuffer.set(channelData[channelIndex], previousBuffer.length);
            this.channelBuffers[channelIndex] = combinedBuffer;
        }
    }

    private renderPassthroughAvailable(
        finalizing: boolean
    ): StreamingAudioResamplerOutput[] {
        const availableFrameCount = this.totalSourceFrames - this.nextOutputFrame;
        const emittableFrameCount = this.getEmittableOutputFrameCount(
            availableFrameCount,
            finalizing
        );
        if (emittableFrameCount === 0) {
            return [];
        }

        const output: StreamingAudioResamplerOutput[] = [];
        let remainingFrameCount = emittableFrameCount;
        while (remainingFrameCount > 0) {
            const chunkFrameCount = Math.min(
                this.maximumOutputFrameCount,
                remainingFrameCount
            );
            const outputStartFrame = this.nextOutputFrame;
            const localFrameOffset = outputStartFrame - this.bufferStartSourceFrame;
            const chunkChannels: Float32Array[] = [];
            for (const channel of this.channelBuffers) {
                chunkChannels.push(channel.slice(
                    localFrameOffset,
                    localFrameOffset + chunkFrameCount
                ));
            }
            output.push(this.createOutput(
                chunkChannels,
                outputStartFrame,
                chunkFrameCount
            ));
            this.nextOutputFrame += chunkFrameCount;
            remainingFrameCount -= chunkFrameCount;
        }

        const consumedFrameCount = this.nextOutputFrame - this.bufferStartSourceFrame;
        if (consumedFrameCount > 0) {
            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                this.channelBuffers[channelIndex] = this.channelBuffers[channelIndex].slice(
                    consumedFrameCount
                );
            }
            this.bufferStartSourceFrame = this.nextOutputFrame;
        }
        return output;
    }

    private renderAvailable(finalizing: boolean): StreamingAudioResamplerOutput[] {
        const availableOutputFrameCount = this.getAvailableOutputFrameCount(finalizing);
        const emittableOutputFrameCount = this.getEmittableOutputFrameCount(
            availableOutputFrameCount,
            finalizing
        );
        if (emittableOutputFrameCount === 0) {
            return [];
        }
        const output: StreamingAudioResamplerOutput[] = [];
        let remainingFrameCount = emittableOutputFrameCount;
        while (remainingFrameCount > 0) {
            const chunkFrameCount = Math.min(
                remainingFrameCount,
                this.maximumOutputFrameCount
            );
            const outputStartFrame = this.nextOutputFrame;
            const channelData: Float32Array[] = [];
            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                channelData.push(new Float32Array(chunkFrameCount));
            }
            for (let outputOffset = 0; outputOffset < chunkFrameCount; outputOffset += 1) {
                this.renderFrame(channelData, outputOffset, finalizing);
                this.nextOutputFrame += 1;
            }
            output.push(this.createOutput(channelData, outputStartFrame, chunkFrameCount));
            remainingFrameCount -= chunkFrameCount;
        }
        this.trimConsumedInput(finalizing);
        return output;
    }

    private getEmittableOutputFrameCount(
        availableFrameCount: number,
        finalizing: boolean
    ): number {
        if (finalizing) {
            return availableFrameCount;
        }
        if (availableFrameCount < this.minimumOutputFrameCount) {
            return 0;
        }

        const trailingFrameCount = availableFrameCount % this.maximumOutputFrameCount;
        if (trailingFrameCount === 0
            || trailingFrameCount >= this.minimumOutputFrameCount
            || availableFrameCount <= this.maximumOutputFrameCount) {
            return availableFrameCount;
        }
        return availableFrameCount - trailingFrameCount;
    }

    private getAvailableOutputFrameCount(finalizing: boolean): number {
        const availableSourceFrameCount = finalizing ?
            this.totalSourceFrames :
            Math.max(0, this.totalSourceFrames - FILTER_RADIUS);
        const exclusiveOutputFrame = Math.ceil(
            (availableSourceFrameCount * this.targetSampleRate) / this.sourceSampleRate
        );
        return Math.max(0, exclusiveOutputFrame - this.nextOutputFrame);
    }

    private renderFrame(
        outputChannels: readonly Float32Array[],
        outputOffset: number,
        finalizing: boolean
    ): void {
        const filterTable = this.filterTable;
        if (!filterTable) {
            throw new Error('Resampling filter is unavailable');
        }
        const sourcePositionNumerator = this.nextOutputFrame * this.sourceSampleRate;
        const sourceFrame = Math.floor(sourcePositionNumerator / this.targetSampleRate);
        const fractionalNumerator = sourcePositionNumerator
            - sourceFrame * this.targetSampleRate;
        const phaseIndex = Math.round(
            (fractionalNumerator * FILTER_PHASE_COUNT) / this.targetSampleRate
        );
        const coefficientOffset = phaseIndex * FILTER_TAP_COUNT;
        const firstFilterSourceFrame = sourceFrame - FILTER_RADIUS + 1;

        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            let value = 0;
            for (let tapIndex = 0; tapIndex < FILTER_TAP_COUNT; tapIndex += 1) {
                const sourceFrameIndex = firstFilterSourceFrame + tapIndex;
                value += this.getSourceValue(channelIndex, sourceFrameIndex, finalizing)
                    * filterTable[coefficientOffset + tapIndex];
            }
            outputChannels[channelIndex][outputOffset] = value;
        }
    }

    private getSourceValue(
        channelIndex: number,
        sourceFrameIndex: number,
        finalizing: boolean
    ): number {
        if (sourceFrameIndex < 0) {
            return this.firstSourceValues[channelIndex];
        }
        if (sourceFrameIndex >= this.totalSourceFrames) {
            if (!finalizing) {
                throw new RangeError('Resampler attempted to read unavailable lookahead');
            }
            return this.lastSourceValues[channelIndex];
        }
        const localFrameIndex = sourceFrameIndex - this.bufferStartSourceFrame;
        const channelBuffer = this.channelBuffers[channelIndex];
        if (localFrameIndex < 0 || localFrameIndex >= channelBuffer.length) {
            throw new RangeError('Resampler history accounting is inconsistent');
        }
        return channelBuffer[localFrameIndex];
    }

    private createOutput(
        channelData: Float32Array[],
        outputStartFrame: number,
        frameCount: number
    ): StreamingAudioResamplerOutput {
        const anchorMediaTimeMicroseconds = this.anchorMediaTimeMicroseconds;
        if (anchorMediaTimeMicroseconds === null) {
            throw new Error('Resampler output has no media-time anchor');
        }
        return {
            channelData,
            durationMicroseconds: audioFramesToMicroseconds(
                frameCount,
                this.targetSampleRate
            ),
            frameCount,
            mediaTimeMicroseconds: addMicroseconds(
                anchorMediaTimeMicroseconds,
                audioFramesToMicroseconds(outputStartFrame, this.targetSampleRate)
            ),
            sampleRate: this.targetSampleRate
        };
    }

    private trimConsumedInput(finalizing: boolean): void {
        if (finalizing) {
            return;
        }
        const nextSourceFrame = Math.floor(
            (this.nextOutputFrame * this.sourceSampleRate) / this.targetSampleRate
        );
        const firstRequiredSourceFrame = Math.max(
            0,
            nextSourceFrame - FILTER_RADIUS + 1
        );
        const trimFrameCount = firstRequiredSourceFrame - this.bufferStartSourceFrame;
        if (trimFrameCount <= 0) {
            return;
        }
        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            this.channelBuffers[channelIndex] = this.channelBuffers[channelIndex].slice(
                trimFrameCount
            );
        }
        this.bufferStartSourceFrame = firstRequiredSourceFrame;
    }
}
