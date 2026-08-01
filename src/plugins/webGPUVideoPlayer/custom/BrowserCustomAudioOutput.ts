import {
    secondsToMicroseconds,
    type Microseconds
} from '../MediaTime';
import type {
    AudioTelemetryListener,
    AudioWorkletOutputController
} from './AudioWorkletController';
import type { AudioWorkletTelemetry } from './AudioWorkletProtocol';
import {
    type BrowserAudioContextPrewarmLease,
    takePrewarmedBrowserAudioContext
} from './BrowserAudioContextPrewarm';
import {
    acquireSharedBrowserAudioContext,
    type SharedBrowserAudioContextReference
} from './BrowserAudioContextPool';
import {
    acquireSharedBrowserAudioWorklet,
    type SharedBrowserAudioWorkletLease
} from './BrowserAudioWorkletPool';
import { waitForBrowserAudioOperation } from './BrowserAudioOperation';
import { assertSupportedCustomAudioOutputLayout } from './CustomAudioOutputPolicy';
import CustomDecodeAudioBridge from './CustomDecodeAudioBridge';
import type {
    CustomAudioOutput,
    CustomAudioOutputBinding,
    CustomAudioOutputFactory
} from './CustomPlaybackControllerTypes';
import type { DecodeWorkerAudioConfiguration } from './DecodeWorkerProtocol';
import { requireMicroseconds } from './TimeMath';

const MAX_BUFFERED_AUDIO_SECONDS = 2;
const MAX_OUTPUT_TIMESTAMP_CORRECTION_MICROSECONDS = secondsToMicroseconds(
    MAX_BUFFERED_AUDIO_SECONDS
);

/** Couples one session worklet output with a reference to the shared exact-rate context. */
class BrowserCustomAudioOutput implements CustomAudioOutput {
    private readonly audioContext: AudioContext;
    private destroyed = false;
    private destroyPromise: Promise<void> | null = null;
    private mediaFloorGeneration: number | null = null;
    private mediaFloorMicroseconds: Microseconds | null = null;
    private readonly outputTelemetryUnsubscribe: () => void;
    private physicalCorrelationGeneration: number | null = null;
    private resumePromise: Promise<void> | null = null;
    private readonly telemetryListeners = new Set<AudioTelemetryListener>();

    public constructor(
        private readonly audioContextReference: SharedBrowserAudioContextReference,
        private readonly workletLease: SharedBrowserAudioWorkletLease
    ) {
        this.audioContext = audioContextReference.audioContext;
        this.output = workletLease.output;
        this.outputTelemetryUnsubscribe = this.output.onTelemetry(this.handleOutputTelemetry);
    }

    private readonly output: AudioWorkletOutputController;

    public get generation(): number {
        return this.output.generation;
    }

    /** Returns the browser's current conservative physical-output latency estimate. */
    public getEstimatedOutputLatencyMicroseconds(): Microseconds | null {
        const latencySeconds = [
            this.audioContext.baseLatency,
            this.audioContext.outputLatency
        ];
        let estimatedLatencySeconds = 0;
        let hasLatencyEstimate = false;
        for (const candidateLatencySeconds of latencySeconds) {
            if (typeof candidateLatencySeconds !== 'number'
                || !Number.isFinite(candidateLatencySeconds)
                || candidateLatencySeconds < 0) {
                continue;
            }
            estimatedLatencySeconds += candidateLatencySeconds;
            hasLatencyEstimate = true;
        }
        if (!hasLatencyEstimate) {
            return null;
        }

        try {
            return secondsToMicroseconds(estimatedLatencySeconds);
        } catch {
            return null;
        }
    }

    public destroy(): Promise<void> {
        if (this.destroyPromise) {
            return this.destroyPromise;
        }

        this.destroyed = true;
        this.outputTelemetryUnsubscribe();
        this.telemetryListeners.clear();
        this.destroyPromise = this.destroyResources();
        return this.destroyPromise;
    }

    public getTelemetry(): AudioWorkletTelemetry | null {
        const telemetry = this.output.getTelemetry();
        return telemetry ? this.mapOutputTelemetry(telemetry) : null;
    }

    public onTelemetry(listener: AudioTelemetryListener): () => void {
        if (this.destroyed) {
            throw new Error('Browser audio output is destroyed');
        }

        this.telemetryListeners.add(listener);
        return (): void => {
            this.telemetryListeners.delete(listener);
        };
    }

    public setMuted(muted: boolean): void {
        this.output.setMuted(muted);
    }

    public setPlaying(playing: boolean): Promise<void> {
        this.output.setPlaying(playing);
        if (!playing || this.audioContext.state === 'running') {
            return Promise.resolve();
        }

        if (this.resumePromise) {
            return this.resumePromise;
        }

        const resumePromise = waitForBrowserAudioOperation(
            this.audioContext.resume(),
            'AudioContext resume'
        ).finally((): void => {
            if (this.resumePromise === resumePromise) {
                this.resumePromise = null;
            }
        });
        this.resumePromise = resumePromise;
        return resumePromise;
    }

    public setVolume(volume: number): void {
        this.output.setVolume(volume);
    }

    private readonly handleOutputTelemetry = (telemetry: AudioWorkletTelemetry): void => {
        if (this.destroyed) {
            return;
        }

        this.observeTelemetryState(telemetry);
        const mappedTelemetry = this.mapOutputTelemetry(telemetry);
        for (const listener of this.telemetryListeners) {
            listener({ ...mappedTelemetry });
        }
    };

    private mapOutputTelemetry(telemetry: AudioWorkletTelemetry): AudioWorkletTelemetry {
        const fallbackTelemetry = this.createFallbackTelemetry(telemetry);
        const mediaContextTimeMicroseconds = telemetry.mediaTimeContextTimeMicroseconds;
        if (mediaContextTimeMicroseconds === null
            || !Number.isSafeInteger(mediaContextTimeMicroseconds)
            || mediaContextTimeMicroseconds < 0
            || !Number.isSafeInteger(telemetry.mediaTimeMicroseconds)) {
            return fallbackTelemetry;
        }

        const getOutputTimestamp = this.audioContext.getOutputTimestamp;
        if (typeof getOutputTimestamp !== 'function') {
            return fallbackTelemetry;
        }

        let outputTimestamp: AudioTimestamp;
        try {
            outputTimestamp = getOutputTimestamp.call(this.audioContext);
        } catch {
            return fallbackTelemetry;
        }
        const outputContextTimeSeconds = outputTimestamp.contextTime;
        const outputPerformanceTimeMilliseconds = outputTimestamp.performanceTime;
        if (typeof outputContextTimeSeconds !== 'number'
            || !Number.isFinite(outputContextTimeSeconds)
            || outputContextTimeSeconds <= 0
            || typeof outputPerformanceTimeMilliseconds !== 'number'
            || !Number.isFinite(outputPerformanceTimeMilliseconds)
            || outputPerformanceTimeMilliseconds <= 0
            || !Number.isFinite(this.audioContext.currentTime)
            || this.audioContext.currentTime <= 0) {
            return fallbackTelemetry;
        }

        let outputContextTimeMicroseconds: number;
        let currentContextTimeMicroseconds: number;
        try {
            outputContextTimeMicroseconds = secondsToMicroseconds(outputContextTimeSeconds);
            currentContextTimeMicroseconds = secondsToMicroseconds(this.audioContext.currentTime);
        } catch {
            return fallbackTelemetry;
        }
        if (outputContextTimeMicroseconds > currentContextTimeMicroseconds) {
            return fallbackTelemetry;
        }

        const correctionMicroseconds = mediaContextTimeMicroseconds
            - outputContextTimeMicroseconds;
        if (correctionMicroseconds <= 0) {
            // The latest rendered media point is the safe forward bound
            this.physicalCorrelationGeneration = telemetry.generation;
            return this.clampTelemetryToMediaFloor({
                ...telemetry,
                hasPhysicalOutputTimeCorrelation: true
            });
        }
        if (!Number.isSafeInteger(correctionMicroseconds)
            || correctionMicroseconds > MAX_OUTPUT_TIMESTAMP_CORRECTION_MICROSECONDS) {
            return fallbackTelemetry;
        }

        let physicalMediaTimeMicroseconds: Microseconds;
        try {
            physicalMediaTimeMicroseconds = requireMicroseconds(
                telemetry.mediaTimeMicroseconds - correctionMicroseconds,
                'Physical audio output media time'
            );
        } catch {
            return fallbackTelemetry;
        }
        this.physicalCorrelationGeneration = telemetry.generation;
        return this.clampTelemetryToMediaFloor({
            ...telemetry,
            hasPhysicalOutputTimeCorrelation: true,
            mediaTimeMicroseconds: physicalMediaTimeMicroseconds
        });
    }

    private clampTelemetryToMediaFloor(
        telemetry: AudioWorkletTelemetry
    ): AudioWorkletTelemetry {
        const mediaFloorMicroseconds = this.getMediaFloor(telemetry.generation);
        return {
            ...telemetry,
            mediaTimeMicroseconds: mediaFloorMicroseconds !== null
                && telemetry.mediaTimeMicroseconds < mediaFloorMicroseconds ?
                mediaFloorMicroseconds :
                telemetry.mediaTimeMicroseconds
        };
    }

    private createFallbackTelemetry(
        telemetry: AudioWorkletTelemetry
    ): AudioWorkletTelemetry {
        const uncorrelatedTelemetry: AudioWorkletTelemetry = {
            ...telemetry,
            hasPhysicalOutputTimeCorrelation: false
        };
        const mediaFloorMicroseconds = this.getMediaFloor(telemetry.generation);
        if (mediaFloorMicroseconds === null) {
            return uncorrelatedTelemetry;
        }
        if (this.physicalCorrelationGeneration !== telemetry.generation) {
            return {
                ...uncorrelatedTelemetry,
                mediaTimeMicroseconds: mediaFloorMicroseconds
            };
        }
        return this.clampTelemetryToMediaFloor(uncorrelatedTelemetry);
    }

    private getMediaFloor(generation: number): Microseconds | null {
        return this.mediaFloorGeneration === generation ? this.mediaFloorMicroseconds : null;
    }

    private observeTelemetryState(telemetry: AudioWorkletTelemetry): void {
        if (this.mediaFloorGeneration !== telemetry.generation) {
            this.mediaFloorGeneration = telemetry.generation;
            this.mediaFloorMicroseconds = null;
            this.physicalCorrelationGeneration = null;
        }
        if (telemetry.reason !== 'flush') {
            return;
        }

        this.mediaFloorMicroseconds = telemetry.mediaTimeMicroseconds;
        this.physicalCorrelationGeneration = null;
    }

    private async destroyResources(): Promise<void> {
        let outputReleaseError: unknown;
        let outputReleaseFailed = false;
        try {
            await this.workletLease.release();
        } catch (error) {
            outputReleaseError = error;
            outputReleaseFailed = true;
        }

        try {
            if (outputReleaseFailed) {
                await this.audioContextReference.invalidate();
            } else {
                await this.audioContextReference.release();
            }
        } catch (error) {
            if (!outputReleaseFailed) {
                throw error;
            }
        }

        if (outputReleaseFailed) {
            throw outputReleaseError;
        }
    }
}

async function createOutput(
    configuration: DecodeWorkerAudioConfiguration,
    prewarmedAudioContext: BrowserAudioContextPrewarmLease | null
): Promise<CustomAudioOutputBinding> {
    try {
        assertSupportedCustomAudioOutputLayout(
            configuration.channelCount,
            configuration.sampleRate
        );
    } catch (error) {
        await prewarmedAudioContext?.close().catch((): void => undefined);
        throw error;
    }
    const consumedPrewarm = prewarmedAudioContext ?
        takePrewarmedBrowserAudioContext(prewarmedAudioContext, configuration.sampleRate) :
        null;
    if (prewarmedAudioContext && !consumedPrewarm) {
        await prewarmedAudioContext.close();
    }
    const audioContextReference = consumedPrewarm
        ?? acquireSharedBrowserAudioContext(configuration.sampleRate);
    const audioContext = audioContextReference.audioContext;
    let workletLease: SharedBrowserAudioWorkletLease | null = null;
    let workletLeasePromise: Promise<SharedBrowserAudioWorkletLease> | null = null;
    try {
        if (audioContext.sampleRate !== configuration.sampleRate) {
            throw new RangeError('The browser did not create the requested audio sample rate');
        }
        await waitForBrowserAudioOperation(
            audioContextReference.resumePromise,
            consumedPrewarm ? 'Prewarmed AudioContext resume' : 'AudioContext resume'
        );
        if (!audioContextReference.isValid()) {
            throw new Error('AudioContext was invalidated while preparing custom audio output');
        }
        workletLeasePromise = acquireSharedBrowserAudioWorklet(audioContext, {
            channelCount: configuration.channelCount,
            maxBufferedFrames: configuration.sampleRate * MAX_BUFFERED_AUDIO_SECONDS
        });
        workletLease = await waitForBrowserAudioOperation(
            workletLeasePromise,
            'AudioWorklet output creation'
        );
        const managedOutput = new BrowserCustomAudioOutput(audioContextReference, workletLease);
        return {
            bridge: new CustomDecodeAudioBridge(workletLease.output),
            configuration: { ...configuration },
            output: managedOutput
        };
    } catch (error) {
        if (!workletLease && workletLeasePromise) {
            void workletLeasePromise.then(
                (lateWorkletLease): Promise<void> => lateWorkletLease.invalidate()
            ).catch((): void => undefined);
        }
        await workletLease?.invalidate().catch((): void => undefined);
        await audioContextReference.invalidate().catch((): void => undefined);
        throw error;
    }
}

/** Creates exact-rate browser PCM outputs for a combined custom A/V session. */
export function createBrowserCustomAudioOutputFactory(
    prewarmedAudioContext: BrowserAudioContextPrewarmLease | null = null
): CustomAudioOutputFactory {
    let availablePrewarm = prewarmedAudioContext;
    return (configuration: DecodeWorkerAudioConfiguration): Promise<CustomAudioOutputBinding> => {
        const selectedPrewarm = availablePrewarm;
        availablePrewarm = null;
        return createOutput(configuration, selectedPrewarm);
    };
}
