import type { Microseconds } from '../MediaTime';
import { requireSupportedCustomAudioSampleRate } from './CustomAudioSampleRate';
import type { StreamingAudioResamplerOutput } from './StreamingAudioResampler';
import {
    addMicroseconds,
    audioFramesToMicroseconds,
    requireMicroseconds
} from './TimeMath';

const MICROSECONDS_PER_SECOND = 1_000_000;
const MILLISECONDS_PER_SECOND = 1_000;
const MAXIMUM_ATTACK_ATTENUATION_DB = 12;
const UNITY_GAIN = 1;
const LIMITED_GAIN_EPSILON = 1e-7;

export const CUSTOM_AUDIO_LIMITER_ANALYSIS_MILLISECONDS = 100;
export const CUSTOM_AUDIO_LIMITER_MINIMUM_ATTACK_MILLISECONDS = 3;
export const CUSTOM_AUDIO_LIMITER_MAXIMUM_ATTACK_MILLISECONDS = 10;
export const CUSTOM_AUDIO_LIMITER_RELEASE_MILLISECONDS = 100;
export const CUSTOM_AUDIO_LIMITER_CEILING_DBFS = -1;
export const CUSTOM_AUDIO_LIMITER_CEILING_GAIN =
    10 ** (CUSTOM_AUDIO_LIMITER_CEILING_DBFS / 20);
export const CUSTOM_AUDIO_LIMITER_ATTACK_CURVE = 'quintic-smoothstep' as const;

export type StreamingAudioLookaheadLimiterOptions = Readonly<{
    channelCount: number
    maximumOutputFrameCount: number
    minimumOutputFrameCount: number
    sampleRate: number
}>;

export type StreamingAudioLookaheadLimiterTelemetry = Readonly<{
    analysisFrameCount: number
    bufferedFrameCount: number
    finalized: boolean
    limitedFrameCount: number
    maximumInputPeak: number
    maximumOutputPeak: number
    minimumAppliedGain: number
    outputFrameCount: number
    sourceFrameCount: number
}>;

function requirePositiveSafeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive safe integer`);
    }
    return value;
}

function millisecondsToFrames(milliseconds: number, sampleRate: number): number {
    return Math.max(1, Math.ceil(milliseconds * sampleRate / MILLISECONDS_PER_SECOND));
}

/** Maps a unit interval with zero first and second derivatives at both ends. */
export function quinticSmoothstep(value: number): number {
    const boundedValue = Math.max(0, Math.min(1, value));
    return boundedValue * boundedValue * boundedValue
        * (boundedValue * (boundedValue * 6 - 15) + 10);
}

/**
 * Applies one linked gain envelope to buffered planar PCM. The 100 ms horizon
 * preserves original media timestamps while quintic attacks anticipate peaks.
 */
export default class StreamingAudioLookaheadLimiter {
    public readonly analysisFrameCount: number;
    public readonly channelCount: number;
    public readonly maximumAttackFrameCount: number;
    public readonly maximumOutputFrameCount: number;
    public readonly minimumAttackFrameCount: number;
    public readonly minimumOutputFrameCount: number;
    public readonly sampleRate: number;

    private anchorMediaTimeMicroseconds: Microseconds | null = null;
    private bufferStartFrame = 0;
    private readonly channelBuffers: Float32Array[] = [];
    private currentGain = UNITY_GAIN;
    private finalized = false;
    private limitedFrameCount = 0;
    private maximumInputPeak = 0;
    private maximumOutputPeak = 0;
    private minimumAppliedGain = UNITY_GAIN;
    private outputFrameCount = 0;
    private readonly releaseCoefficient: number;
    private sourceFrameCount = 0;

    public constructor(options: StreamingAudioLookaheadLimiterOptions) {
        this.channelCount = requirePositiveSafeInteger(
            options.channelCount,
            'Limiter channel count'
        );
        this.maximumOutputFrameCount = requirePositiveSafeInteger(
            options.maximumOutputFrameCount,
            'Limiter maximum output frame count'
        );
        this.minimumOutputFrameCount = requirePositiveSafeInteger(
            options.minimumOutputFrameCount,
            'Limiter minimum output frame count'
        );
        if (this.minimumOutputFrameCount > this.maximumOutputFrameCount) {
            throw new RangeError(
                'Limiter minimum output frame count cannot exceed its maximum'
            );
        }
        this.sampleRate = requireSupportedCustomAudioSampleRate(
            options.sampleRate,
            'Limiter sample rate'
        );
        this.analysisFrameCount = millisecondsToFrames(
            CUSTOM_AUDIO_LIMITER_ANALYSIS_MILLISECONDS,
            this.sampleRate
        );
        this.minimumAttackFrameCount = millisecondsToFrames(
            CUSTOM_AUDIO_LIMITER_MINIMUM_ATTACK_MILLISECONDS,
            this.sampleRate
        );
        this.maximumAttackFrameCount = millisecondsToFrames(
            CUSTOM_AUDIO_LIMITER_MAXIMUM_ATTACK_MILLISECONDS,
            this.sampleRate
        );
        const releaseFrameCount = millisecondsToFrames(
            CUSTOM_AUDIO_LIMITER_RELEASE_MILLISECONDS,
            this.sampleRate
        );
        this.releaseCoefficient = Math.exp(-1 / releaseFrameCount);

        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            this.channelBuffers.push(new Float32Array(0));
        }
    }

    /** Buffers contiguous PCM and emits frames with a complete future horizon. */
    public push(
        inputs: readonly StreamingAudioResamplerOutput[]
    ): StreamingAudioResamplerOutput[] {
        if (this.finalized) {
            throw new Error('Cannot add audio after limiter finalization');
        }
        for (const input of inputs) {
            this.appendInput(input);
        }
        return this.renderAvailable(false);
    }

    /** Emits the complete retained tail exactly once without synthetic samples. */
    public finalize(): StreamingAudioResamplerOutput[] {
        if (this.finalized) {
            return [];
        }
        this.finalized = true;
        const output = this.renderAvailable(true);
        for (let channelIndex = 0; channelIndex < this.channelBuffers.length; channelIndex += 1) {
            this.channelBuffers[channelIndex] = new Float32Array(0);
        }
        this.bufferStartFrame = this.sourceFrameCount;
        return output;
    }

    /** Returns exact frame accounting and peak-envelope measurements. */
    public getTelemetry(): StreamingAudioLookaheadLimiterTelemetry {
        return {
            analysisFrameCount: this.analysisFrameCount,
            bufferedFrameCount: this.channelBuffers[0]?.length ?? 0,
            finalized: this.finalized,
            limitedFrameCount: this.limitedFrameCount,
            maximumInputPeak: this.maximumInputPeak,
            maximumOutputPeak: this.maximumOutputPeak,
            minimumAppliedGain: this.minimumAppliedGain,
            outputFrameCount: this.outputFrameCount,
            sourceFrameCount: this.sourceFrameCount
        };
    }

    private appendInput(input: StreamingAudioResamplerOutput): void {
        requireMicroseconds(input.mediaTimeMicroseconds, 'Limiter input media time');
        requireMicroseconds(input.durationMicroseconds, 'Limiter input duration');
        if (input.sampleRate !== this.sampleRate) {
            throw new RangeError('Limiter input sample rate changed');
        }
        if (!Number.isSafeInteger(input.frameCount) || input.frameCount <= 0) {
            throw new RangeError('Limiter input must contain at least one frame');
        }
        if (input.channelData.length !== this.channelCount) {
            throw new RangeError(`Expected ${this.channelCount} limiter input channels`);
        }
        const expectedDurationMicroseconds = audioFramesToMicroseconds(
            input.frameCount,
            this.sampleRate
        );
        if (input.durationMicroseconds !== expectedDurationMicroseconds) {
            throw new RangeError('Limiter input duration does not match its frame count');
        }
        this.validateAndSetTimestamp(input.mediaTimeMicroseconds);

        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            const inputChannel = input.channelData[channelIndex];
            if (!(inputChannel instanceof Float32Array)
                || inputChannel.length !== input.frameCount) {
                throw new RangeError(
                    'Limiter input channels must be equal-length Float32Array values'
                );
            }
            for (const sample of inputChannel) {
                if (!Number.isFinite(sample)) {
                    throw new RangeError('Limiter input samples must be finite');
                }
                this.maximumInputPeak = Math.max(this.maximumInputPeak, Math.abs(sample));
            }
            const previousBuffer = this.channelBuffers[channelIndex];
            const combinedBuffer = new Float32Array(
                previousBuffer.length + input.frameCount
            );
            combinedBuffer.set(previousBuffer);
            combinedBuffer.set(inputChannel, previousBuffer.length);
            this.channelBuffers[channelIndex] = combinedBuffer;
        }
        this.sourceFrameCount += input.frameCount;
    }

    private validateAndSetTimestamp(mediaTimeMicroseconds: Microseconds): void {
        if (this.anchorMediaTimeMicroseconds === null) {
            this.anchorMediaTimeMicroseconds = mediaTimeMicroseconds;
            return;
        }
        const expectedMediaTimeMicroseconds = addMicroseconds(
            this.anchorMediaTimeMicroseconds,
            audioFramesToMicroseconds(this.sourceFrameCount, this.sampleRate)
        );
        const timestampToleranceMicroseconds = Math.ceil(
            MICROSECONDS_PER_SECOND / this.sampleRate
        );
        if (Math.abs(mediaTimeMicroseconds - expectedMediaTimeMicroseconds)
            > timestampToleranceMicroseconds) {
            throw new RangeError('Limiter input timestamps contain a gap or overlap');
        }
    }

    private renderAvailable(finalizing: boolean): StreamingAudioResamplerOutput[] {
        const availableFrameCount = this.sourceFrameCount - this.outputFrameCount;
        const horizonSafeFrameCount = finalizing ?
            availableFrameCount :
            Math.max(0, availableFrameCount - this.analysisFrameCount);
        const emittableFrameCount = this.getEmittableFrameCount(
            horizonSafeFrameCount,
            finalizing
        );
        if (emittableFrameCount === 0) {
            return [];
        }

        const outputs: StreamingAudioResamplerOutput[] = [];
        let remainingFrameCount = emittableFrameCount;
        while (remainingFrameCount > 0) {
            const chunkFrameCount = Math.min(
                remainingFrameCount,
                this.maximumOutputFrameCount
            );
            outputs.push(this.renderChunk(chunkFrameCount));
            remainingFrameCount -= chunkFrameCount;
        }
        this.trimConsumedInput();
        return outputs;
    }

    private getEmittableFrameCount(
        availableFrameCount: number,
        finalizing: boolean
    ): number {
        if (finalizing || availableFrameCount < this.minimumOutputFrameCount) {
            return finalizing ? availableFrameCount : 0;
        }
        const trailingFrameCount = availableFrameCount % this.maximumOutputFrameCount;
        if (trailingFrameCount === 0
            || trailingFrameCount >= this.minimumOutputFrameCount
            || availableFrameCount <= this.maximumOutputFrameCount) {
            return availableFrameCount;
        }
        return availableFrameCount - trailingFrameCount;
    }

    private renderChunk(frameCount: number): StreamingAudioResamplerOutput {
        const outputStartFrame = this.outputFrameCount;
        const localStartFrame = outputStartFrame - this.bufferStartFrame;
        const attackConstraints = this.createAttackConstraints(
            localStartFrame,
            frameCount
        );
        const channelData: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            channelData.push(new Float32Array(frameCount));
        }

        for (let frameOffset = 0; frameOffset < frameCount; frameOffset += 1) {
            const localFrameIndex = localStartFrame + frameOffset;
            const inputPeak = this.getLinkedPeak(localFrameIndex);
            const safeGain = inputPeak > CUSTOM_AUDIO_LIMITER_CEILING_GAIN ?
                CUSTOM_AUDIO_LIMITER_CEILING_GAIN / inputPeak :
                UNITY_GAIN;
            const releasedGain = UNITY_GAIN
                - (UNITY_GAIN - this.currentGain) * this.releaseCoefficient;
            const appliedGain = Math.min(
                UNITY_GAIN,
                safeGain,
                attackConstraints[frameOffset],
                releasedGain
            );
            this.currentGain = appliedGain;
            this.minimumAppliedGain = Math.min(this.minimumAppliedGain, appliedGain);
            if (appliedGain < UNITY_GAIN - LIMITED_GAIN_EPSILON) {
                this.limitedFrameCount += 1;
            }

            for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
                const outputSample = this.channelBuffers[channelIndex][localFrameIndex]
                    * appliedGain;
                channelData[channelIndex][frameOffset] = outputSample;
                this.maximumOutputPeak = Math.max(
                    this.maximumOutputPeak,
                    Math.abs(outputSample)
                );
            }
        }

        this.outputFrameCount += frameCount;
        const anchorMediaTimeMicroseconds = this.anchorMediaTimeMicroseconds;
        if (anchorMediaTimeMicroseconds === null) {
            throw new Error('Limiter output has no media-time anchor');
        }
        return {
            channelData,
            durationMicroseconds: audioFramesToMicroseconds(frameCount, this.sampleRate),
            frameCount,
            mediaTimeMicroseconds: addMicroseconds(
                anchorMediaTimeMicroseconds,
                audioFramesToMicroseconds(outputStartFrame, this.sampleRate)
            ),
            sampleRate: this.sampleRate
        };
    }

    private createAttackConstraints(
        localStartFrame: number,
        frameCount: number
    ): Float32Array {
        const constraints = new Float32Array(frameCount);
        constraints.fill(UNITY_GAIN);
        const analysisEndFrame = Math.min(
            this.channelBuffers[0].length,
            localStartFrame + frameCount + this.analysisFrameCount
        );
        const localEndFrame = localStartFrame + frameCount;
        for (let peakFrame = localStartFrame;
            peakFrame < analysisEndFrame;
            peakFrame += 1) {
            const peak = this.getLinkedPeak(peakFrame);
            if (peak <= CUSTOM_AUDIO_LIMITER_CEILING_GAIN) {
                continue;
            }
            const requiredGain = CUSTOM_AUDIO_LIMITER_CEILING_GAIN / peak;
            const attackFrameCount = this.getAttackFrameCount(requiredGain);
            const firstAttackFrame = Math.max(
                localStartFrame,
                peakFrame - attackFrameCount
            );
            const lastAttackFrame = Math.min(localEndFrame - 1, peakFrame);
            if (firstAttackFrame > lastAttackFrame) {
                continue;
            }
            for (let attackFrame = firstAttackFrame;
                attackFrame <= lastAttackFrame;
                attackFrame += 1) {
                const attackProgress = 1
                    - (peakFrame - attackFrame) / attackFrameCount;
                const attackGain = UNITY_GAIN
                    - (UNITY_GAIN - requiredGain) * quinticSmoothstep(attackProgress);
                const constraintIndex = attackFrame - localStartFrame;
                constraints[constraintIndex] = Math.min(
                    constraints[constraintIndex],
                    attackGain
                );
            }
        }
        return constraints;
    }

    private getAttackFrameCount(requiredGain: number): number {
        const attenuationDB = -20 * Math.log10(requiredGain);
        const severity = Math.min(1, attenuationDB / MAXIMUM_ATTACK_ATTENUATION_DB);
        return Math.round(
            this.minimumAttackFrameCount
            + (this.maximumAttackFrameCount - this.minimumAttackFrameCount) * severity
        );
    }

    private getLinkedPeak(localFrameIndex: number): number {
        let peak = 0;
        for (const channelBuffer of this.channelBuffers) {
            peak = Math.max(peak, Math.abs(channelBuffer[localFrameIndex]));
        }
        return peak;
    }

    private trimConsumedInput(): void {
        const consumedFrameCount = this.outputFrameCount - this.bufferStartFrame;
        if (consumedFrameCount <= 0) {
            return;
        }
        for (let channelIndex = 0; channelIndex < this.channelCount; channelIndex += 1) {
            this.channelBuffers[channelIndex] = this.channelBuffers[channelIndex].slice(
                consumedFrameCount
            );
        }
        this.bufferStartFrame = this.outputFrameCount;
    }
}
