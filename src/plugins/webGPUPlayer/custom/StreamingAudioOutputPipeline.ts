import StreamingAudioLookaheadLimiter from './StreamingAudioLookaheadLimiter';
import StreamingAudioResampler, {
    type StreamingAudioResamplerInput,
    type StreamingAudioResamplerOptions,
    type StreamingAudioResamplerOutput,
    type StreamingAudioResamplerTelemetry
} from './StreamingAudioResampler';

export type StreamingAudioOutputPipelineOptions = StreamingAudioResamplerOptions & Readonly<{
    peakLimiterEnabled: boolean
}>;

export type StreamingAudioOutputPipelineTelemetry = Readonly<{
    peakLimiterEnabled: boolean
    resampler: StreamingAudioResamplerTelemetry
}>;

/** Runs resampling before the optional final-rate linked peak limiter. */
export default class StreamingAudioOutputPipeline {
    private finalized = false;
    private readonly limiter: StreamingAudioLookaheadLimiter | null;
    private readonly resampler: StreamingAudioResampler;

    public constructor(options: StreamingAudioOutputPipelineOptions) {
        this.resampler = new StreamingAudioResampler(options);
        this.limiter = options.peakLimiterEnabled ?
            new StreamingAudioLookaheadLimiter({
                channelCount: options.channelCount,
                maximumOutputFrameCount: options.maximumOutputFrameCount,
                minimumOutputFrameCount: options.minimumOutputFrameCount,
                sampleRate: options.targetSampleRate
            }) :
            null;
    }

    /** Processes one contiguous decoded PCM input. */
    public push(input: StreamingAudioResamplerInput): StreamingAudioResamplerOutput[] {
        if (this.finalized) {
            throw new Error('Cannot add audio after output pipeline finalization');
        }
        const resampledOutputs = this.resampler.push(input);
        return this.limiter?.push(resampledOutputs) ?? resampledOutputs;
    }

    /** Drains the resampler and limiter tails in dependency order exactly once. */
    public finalize(): StreamingAudioResamplerOutput[] {
        if (this.finalized) {
            return [];
        }
        this.finalized = true;
        const resampledOutputs = this.resampler.finalize();
        if (!this.limiter) {
            return resampledOutputs;
        }
        const output = this.limiter.push(resampledOutputs);
        output.push(...this.limiter.finalize());
        return output;
    }

    /** Returns pipeline configuration and resampler accounting for diagnostics. */
    public getTelemetry(): StreamingAudioOutputPipelineTelemetry {
        return {
            peakLimiterEnabled: this.limiter !== null,
            resampler: this.resampler.getTelemetry()
        };
    }
}

export type {
    StreamingAudioResamplerInput,
    StreamingAudioResamplerOutput
};
