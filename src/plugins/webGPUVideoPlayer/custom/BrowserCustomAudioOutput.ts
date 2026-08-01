import AudioWorkletController, {
    type AudioTelemetryListener
} from './AudioWorkletController';
import type { AudioWorkletTelemetry } from './AudioWorkletProtocol';
import {
    type BrowserAudioContextPrewarmLease,
    takePrewarmedBrowserAudioContext
} from './BrowserAudioContextPrewarm';
import CustomDecodeAudioBridge from './CustomDecodeAudioBridge';
import type {
    CustomAudioOutput,
    CustomAudioOutputBinding,
    CustomAudioOutputFactory
} from './CustomPlaybackControllerTypes';
import type { DecodeWorkerAudioConfiguration } from './DecodeWorkerProtocol';

const MAX_BUFFERED_AUDIO_SECONDS = 2;

type AudioContextConstructor = new (options?: AudioContextOptions) => AudioContext;

type AudioContextRuntime = typeof globalThis & {
    webkitAudioContext?: AudioContextConstructor
};

/** Couples one worklet output with the exact-rate AudioContext that owns it. */
class BrowserCustomAudioOutput implements CustomAudioOutput {
    private destroyed = false;
    private destroyPromise: Promise<void> | null = null;
    private resumePromise: Promise<void> | null = null;

    public constructor(
        private readonly audioContext: AudioContext,
        private readonly output: AudioWorkletController
    ) {}

    public get generation(): number {
        return this.output.generation;
    }

    public destroy(): Promise<void> {
        if (this.destroyPromise) {
            return this.destroyPromise;
        }

        this.destroyed = true;
        this.destroyPromise = this.destroyResources();
        return this.destroyPromise;
    }

    public getTelemetry(): AudioWorkletTelemetry | null {
        return this.output.getTelemetry();
    }

    public onTelemetry(listener: AudioTelemetryListener): () => void {
        return this.output.onTelemetry(listener);
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

        const resumePromise = this.audioContext.resume().finally((): void => {
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

    private async destroyResources(): Promise<void> {
        let outputDestroyError: unknown;
        let outputDestroyFailed = false;
        try {
            this.output.destroy();
        } catch (error) {
            outputDestroyError = error;
            outputDestroyFailed = true;
        }

        try {
            if (this.audioContext.state !== 'closed') {
                await this.audioContext.close();
            }
        } catch (error) {
            if (!outputDestroyFailed) {
                throw error;
            }
        }

        if (outputDestroyFailed) {
            throw outputDestroyError;
        }
    }
}

function getAudioContextConstructor(): AudioContextConstructor {
    const runtime = globalThis as AudioContextRuntime;
    const constructor = runtime.AudioContext ?? runtime.webkitAudioContext;
    if (!constructor) {
        throw new Error('AudioContext is unavailable');
    }
    return constructor;
}

async function createOutput(
    configuration: DecodeWorkerAudioConfiguration,
    prewarmedAudioContext: BrowserAudioContextPrewarmLease | null
): Promise<CustomAudioOutputBinding> {
    const consumedPrewarm = prewarmedAudioContext ?
        takePrewarmedBrowserAudioContext(prewarmedAudioContext, configuration.sampleRate) :
        null;
    if (prewarmedAudioContext && !consumedPrewarm) {
        await prewarmedAudioContext.close();
    }
    let audioContext: AudioContext;
    if (consumedPrewarm) {
        audioContext = consumedPrewarm.audioContext;
    } else {
        const AudioContextClass = getAudioContextConstructor();
        audioContext = new AudioContextClass({
            latencyHint: 'playback',
            sampleRate: configuration.sampleRate
        });
    }
    let output: AudioWorkletController | null = null;
    try {
        if (audioContext.sampleRate !== configuration.sampleRate) {
            throw new RangeError('The browser did not create the requested audio sample rate');
        }
        if (consumedPrewarm) {
            await consumedPrewarm.resumePromise;
        } else {
            await audioContext.resume();
        }
        output = await AudioWorkletController.create(audioContext, {
            channelCount: configuration.channelCount,
            maxBufferedFrames: configuration.sampleRate * MAX_BUFFERED_AUDIO_SECONDS
        });
        const managedOutput = new BrowserCustomAudioOutput(audioContext, output);
        return {
            bridge: new CustomDecodeAudioBridge(output),
            configuration: { ...configuration },
            output: managedOutput
        };
    } catch (error) {
        output?.destroy();
        await audioContext.close().catch(() => undefined);
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
