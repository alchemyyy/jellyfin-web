import type { Microseconds } from '../MediaTime';
import type AudioWorkletController from './AudioWorkletController';
import type { AudioWorkletTelemetry } from './AudioWorkletProtocol';
import {
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
    type DecodeWorkerAudioConfiguration,
    type DecodeWorkerAudioResponse
} from './DecodeWorkerProtocol';
import {
    addMicroseconds,
    audioFramesToMicroseconds,
    requireMicroseconds
} from './TimeMath';

export type CustomDecodeAudioBridgeCallbacks = {
    onCreditsReleased: (audioSampleCredits: number) => void
    onFailure: (message: string) => void
};

export type CustomDecodeAudioBridgeStartOptions = {
    audioConfiguration: DecodeWorkerAudioConfiguration
    callbacks: CustomDecodeAudioBridgeCallbacks
    decodeGeneration: number
    startTimeMicroseconds: Microseconds
};

export type CustomDecodeAudioBridgeEnqueueResult = {
    frameCount: number
    status:
        | 'controller-rejected'
        | 'output-capacity'
        | 'stale-generation'
        | 'submitted'
        | 'timestamp-discontinuity'
};

export type CustomDecodeAudioBridgeTelemetry = {
    activeDecodeGeneration: number | null
    failed: boolean
    pendingFrameCount: number
    pendingSampleCount: number
    releasedSampleCredits: number
    staleSampleCount: number
    submittedEndMediaTimeMicroseconds: Microseconds | null
    submittedFrameCount: number
    submittedSampleCount: number
    workletGeneration: number | null
};

type PendingAudioSample = {
    frameCount: number
    remainingFrameCount: number
    sequence: number
};

function requireGeneration(generation: number): number {
    if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw new RangeError('Decode generation must be a positive safe integer');
    }
    return generation;
}

/**
 * Bridges worker-decoded planar PCM into one AudioWorkletController while
 * releasing worker credits only after complete samples leave the worklet queue.
 */
export default class CustomDecodeAudioBridge {
    private activeDecodeGeneration: number | null = null;
    private callbacks: CustomDecodeAudioBridgeCallbacks | null = null;
    private consumptionBaselineReady = false;
    private failed = false;
    private expectedNextMediaTimeMicroseconds: Microseconds | null = null;
    private lastConsumedFrameCount = 0;
    private lastMediaTimeMicroseconds: Microseconds = requireMicroseconds(0);
    private readonly maximumPendingSampleCount: number;
    private readonly pendingSamples: PendingAudioSample[] = [];
    private pendingFrameCount = 0;
    private releasedSampleCredits = 0;
    private staleSampleCount = 0;
    private submittedFrameCount = 0;
    private submittedSampleCount = 0;
    private unsubscribeTelemetry: (() => void) | null = null;
    private workletGeneration: number | null = null;

    public constructor(private readonly controller: AudioWorkletController) {
        this.maximumPendingSampleCount = Math.min(
            MAX_DECODED_AUDIO_SAMPLE_CREDITS,
            controller.configuration.maxChunks
        );
    }

    /** Returns the fixed credit window used to bound worker audio output. */
    public get initialAudioSampleCredits(): number {
        return this.maximumPendingSampleCount;
    }

    /** Flushes old PCM and binds a new decoder generation to the worklet. */
    public start(options: CustomDecodeAudioBridgeStartOptions): void {
        const decodeGeneration = requireGeneration(options.decodeGeneration);
        const startTimeMicroseconds = requireMicroseconds(
            options.startTimeMicroseconds,
            'Audio bridge start time'
        );
        this.validateAudioConfiguration(options.audioConfiguration);

        this.unsubscribeTelemetry?.();
        this.unsubscribeTelemetry = null;
        this.pendingSamples.length = 0;
        this.pendingFrameCount = 0;
        this.activeDecodeGeneration = decodeGeneration;
        this.callbacks = options.callbacks;
        this.consumptionBaselineReady = false;
        this.failed = false;
        this.expectedNextMediaTimeMicroseconds = null;
        this.lastConsumedFrameCount = 0;
        this.lastMediaTimeMicroseconds = startTimeMicroseconds;
        this.releasedSampleCredits = 0;
        this.staleSampleCount = 0;
        this.submittedFrameCount = 0;
        this.submittedSampleCount = 0;
        this.unsubscribeTelemetry = this.controller.onTelemetry(this.handleTelemetry);
        this.workletGeneration = this.controller.flush(startTimeMicroseconds);
    }

    /** Transfers a decoded audio sample to the worklet if the generation is current. */
    public enqueue(
        message: DecodeWorkerAudioResponse,
        decodeGeneration: number
    ): CustomDecodeAudioBridgeEnqueueResult {
        if (decodeGeneration !== this.activeDecodeGeneration || this.failed) {
            this.staleSampleCount += 1;
            return { frameCount: message.frameCount, status: 'stale-generation' };
        }
        if (
            this.pendingSamples.length >= this.maximumPendingSampleCount
            || message.frameCount > this.controller.configuration.maxBufferedFrames - this.pendingFrameCount
        ) {
            this.notifyFailure('Decoded audio exceeded the bounded worklet queue');
            return { frameCount: message.frameCount, status: 'output-capacity' };
        }
        const nextMediaTimeMicroseconds = this.getNextContinuousMediaTime(message);
        if (nextMediaTimeMicroseconds === null) {
            this.notifyFailure('Decoded audio timestamps contain a gap or overlap');
            return { frameCount: message.frameCount, status: 'timestamp-discontinuity' };
        }

        const workletGeneration = this.workletGeneration;
        if (workletGeneration === null) {
            this.notifyFailure('Decoded audio output is not initialized');
            return { frameCount: message.frameCount, status: 'controller-rejected' };
        }

        let submission: ReturnType<AudioWorkletController['enqueue']>;
        try {
            submission = this.controller.enqueue({
                channelData: message.channelData,
                timestampMicroseconds: message.mediaTimeMicroseconds
            }, workletGeneration);
        } catch {
            this.notifyFailure('Unable to transfer decoded audio to the worklet');
            return { frameCount: message.frameCount, status: 'controller-rejected' };
        }
        if (submission.status !== 'submitted' || submission.sequence === null) {
            this.notifyFailure('The audio worklet rejected a decoded sample');
            return { frameCount: message.frameCount, status: 'controller-rejected' };
        }

        this.pendingSamples.push({
            frameCount: message.frameCount,
            remainingFrameCount: message.frameCount,
            sequence: submission.sequence
        });
        this.pendingFrameCount += message.frameCount;
        this.expectedNextMediaTimeMicroseconds = nextMediaTimeMicroseconds;
        this.submittedFrameCount += message.frameCount;
        this.submittedSampleCount += 1;
        return { frameCount: message.frameCount, status: 'submitted' };
    }

    /** Stops one active generation and synchronously invalidates queued PCM. */
    public stop(decodeGeneration: number | null = this.activeDecodeGeneration): void {
        if (this.activeDecodeGeneration === null) {
            return;
        }
        if (
            decodeGeneration !== null
            && decodeGeneration !== this.activeDecodeGeneration
        ) {
            return;
        }

        this.unsubscribeTelemetry?.();
        this.unsubscribeTelemetry = null;
        this.pendingSamples.length = 0;
        this.pendingFrameCount = 0;
        this.activeDecodeGeneration = null;
        this.callbacks = null;
        this.consumptionBaselineReady = false;
        this.expectedNextMediaTimeMicroseconds = null;
        this.workletGeneration = null;
        try {
            this.controller.setPlaying(false);
            this.controller.flush(this.lastMediaTimeMicroseconds);
        } catch {
            // The output may already have been destroyed by its owner
        }
    }

    /** Returns bounded-queue accounting for diagnostics. */
    public getTelemetry(): CustomDecodeAudioBridgeTelemetry {
        return {
            activeDecodeGeneration: this.activeDecodeGeneration,
            failed: this.failed,
            pendingFrameCount: this.pendingFrameCount,
            pendingSampleCount: this.pendingSamples.length,
            releasedSampleCredits: this.releasedSampleCredits,
            staleSampleCount: this.staleSampleCount,
            submittedEndMediaTimeMicroseconds: this.expectedNextMediaTimeMicroseconds,
            submittedFrameCount: this.submittedFrameCount,
            submittedSampleCount: this.submittedSampleCount,
            workletGeneration: this.workletGeneration
        };
    }

    private readonly handleTelemetry = (telemetry: AudioWorkletTelemetry): void => {
        if (
            this.activeDecodeGeneration === null
            || telemetry.generation !== this.workletGeneration
            || this.failed
        ) {
            return;
        }

        if (
            !Number.isSafeInteger(telemetry.mediaTimeMicroseconds)
            || !Number.isSafeInteger(telemetry.consumedFrames)
            || telemetry.consumedFrames < 0
            || !Number.isSafeInteger(telemetry.queuedFrames)
            || telemetry.queuedFrames < 0
        ) {
            this.notifyFailure('Audio worklet returned invalid queue telemetry');
            return;
        }

        this.lastMediaTimeMicroseconds = requireMicroseconds(
            telemetry.mediaTimeMicroseconds,
            'Audio worklet media time'
        );
        if (!this.consumptionBaselineReady) {
            this.lastConsumedFrameCount = telemetry.consumedFrames;
            this.consumptionBaselineReady = true;
        } else if (telemetry.consumedFrames < this.lastConsumedFrameCount) {
            this.notifyFailure('Audio worklet consumption telemetry moved backwards');
            return;
        } else {
            const consumedFrameCount = telemetry.consumedFrames - this.lastConsumedFrameCount;
            this.lastConsumedFrameCount = telemetry.consumedFrames;
            this.releaseConsumedSamples(consumedFrameCount);
        }

        if (
            telemetry.sequence !== null
            && (telemetry.reason === 'overflow' || telemetry.reason === 'stale-generation')
            && this.pendingSamples.some(sample => sample.sequence === telemetry.sequence)
        ) {
            this.notifyFailure('The audio worklet dropped a decoded sample');
        }
    };

    private releaseConsumedSamples(consumedFrameCount: number): void {
        let remainingConsumedFrames = consumedFrameCount;
        let releasedSampleCount = 0;
        while (remainingConsumedFrames > 0 && this.pendingSamples.length > 0) {
            const pendingSample = this.pendingSamples[0];
            const releasedFrameCount = Math.min(
                remainingConsumedFrames,
                pendingSample.remainingFrameCount
            );
            pendingSample.remainingFrameCount -= releasedFrameCount;
            remainingConsumedFrames -= releasedFrameCount;
            this.pendingFrameCount -= releasedFrameCount;
            if (pendingSample.remainingFrameCount === 0) {
                this.pendingSamples.shift();
                releasedSampleCount += 1;
            }
        }

        if (remainingConsumedFrames > 0) {
            this.notifyFailure('Audio worklet consumed more decoded frames than were submitted');
            return;
        }
        if (releasedSampleCount === 0) {
            return;
        }

        this.releasedSampleCredits += releasedSampleCount;
        try {
            this.callbacks?.onCreditsReleased(releasedSampleCount);
        } catch {
            this.notifyFailure('Unable to replenish decoded audio credits');
        }
    }

    private notifyFailure(message: string): void {
        if (this.failed) {
            return;
        }

        this.failed = true;
        try {
            this.callbacks?.onFailure(message);
        } catch {
            // Session callbacks must not escape the audio telemetry task
        }
    }

    private getNextContinuousMediaTime(
        message: DecodeWorkerAudioResponse
    ): Microseconds | null {
        const expectedMediaTimeMicroseconds = this.expectedNextMediaTimeMicroseconds;
        if (message.sampleRate !== this.controller.configuration.sampleRate) {
            return null;
        }
        const timestampToleranceMicroseconds = Math.ceil(
            1_000_000 / message.sampleRate
        );
        if (expectedMediaTimeMicroseconds !== null && Math.abs(
            message.mediaTimeMicroseconds - expectedMediaTimeMicroseconds
        ) > timestampToleranceMicroseconds) {
            return null;
        }

        try {
            const calculatedDurationMicroseconds = audioFramesToMicroseconds(
                message.frameCount,
                message.sampleRate
            );
            if (Math.abs(
                message.durationMicroseconds - calculatedDurationMicroseconds
            ) > timestampToleranceMicroseconds) {
                return null;
            }
            return addMicroseconds(
                message.mediaTimeMicroseconds,
                calculatedDurationMicroseconds
            );
        } catch {
            return null;
        }
    }

    private validateAudioConfiguration(audioConfiguration: DecodeWorkerAudioConfiguration): void {
        if (audioConfiguration.channelCount !== this.controller.configuration.channelCount) {
            throw new RangeError('Decoded audio channel count does not match the AudioWorklet output');
        }
        if (audioConfiguration.sampleRate !== this.controller.configuration.sampleRate) {
            throw new RangeError('Decoded audio sample rate does not match the AudioWorklet output');
        }
        if (typeof audioConfiguration.codec !== 'string' || !audioConfiguration.codec) {
            throw new TypeError('Decoded audio codec must be a non-empty string');
        }
    }
}
