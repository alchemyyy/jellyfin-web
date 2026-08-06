import { describe, expect, it } from 'vitest';

import { downmixSevenPointOneToStereo } from './CustomAudioDownmix';
import { CUSTOM_AUDIO_LIMITER_CEILING_GAIN } from './StreamingAudioLookaheadLimiter';
import StreamingAudioOutputPipeline, {
    type StreamingAudioResamplerOutput
} from './StreamingAudioOutputPipeline';
import { requireMicroseconds } from './TimeMath';

const SAMPLE_RATE = 48_000;

function createPipeline(
    peakLimiterEnabled: boolean,
    sourceSampleRate = SAMPLE_RATE
): StreamingAudioOutputPipeline {
    return new StreamingAudioOutputPipeline({
        channelCount: 2,
        maximumOutputFrameCount: 1_920,
        maximumTimestampQuantizationMicroseconds: 1_000,
        minimumOutputFrameCount: 1,
        peakLimiterEnabled,
        sourceSampleRate,
        targetSampleRate: SAMPLE_RATE
    });
}

function getOutputFrameCount(outputs: readonly StreamingAudioResamplerOutput[]): number {
    return outputs.reduce((sum, output) => sum + output.frameCount, 0);
}

function getMaximumPeak(outputs: readonly StreamingAudioResamplerOutput[]): number {
    let maximumPeak = 0;
    for (const output of outputs) {
        for (const channel of output.channelData) {
            for (const sample of channel) {
                maximumPeak = Math.max(maximumPeak, Math.abs(sample));
            }
        }
    }
    return maximumPeak;
}

describe('StreamingAudioOutputPipeline', () => {
    it('leaves ordinary decoded stereo on the direct resampler path', () => {
        const pipeline = createPipeline(false);
        const inputChannel = new Float32Array([ 0.25, 1.5, -0.5 ]);
        const output = pipeline.push({
            channelData: [ inputChannel, inputChannel ],
            mediaTimeMicroseconds: requireMicroseconds(2_000_000)
        });

        expect(getOutputFrameCount(output)).toBe(inputChannel.length);
        expect(getMaximumPeak(output)).toBe(1.5);
        expect(pipeline.finalize()).toEqual([]);
        expect(pipeline.finalize()).toEqual([]);
        expect(pipeline.getTelemetry()).toMatchObject({
            peakLimiterEnabled: false,
            resampler: {
                finalized: true,
                outputFrameCount: inputChannel.length,
                sourceFrameCount: inputChannel.length
            }
        });
    });

    it('drains the resampler before the retained limiter tail at EOS', () => {
        const sourceSampleRate = 96_000;
        const pipeline = createPipeline(true, sourceSampleRate);
        const frameCount = 8_000;
        const left = new Float32Array(frameCount);
        const right = new Float32Array(frameCount);
        left.fill(0.25);
        right.fill(0.25);
        right[frameCount - 1] = 3;

        expect(pipeline.push({
            channelData: [ left, right ],
            mediaTimeMicroseconds: requireMicroseconds(3_000_000)
        })).toEqual([]);
        const terminalOutput = pipeline.finalize();

        expect(getOutputFrameCount(terminalOutput)).toBe(frameCount / 2);
        expect(getMaximumPeak(terminalOutput))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
        expect(terminalOutput[0].mediaTimeMicroseconds).toBe(3_000_000);
        expect(pipeline.finalize()).toEqual([]);
        expect(() => pipeline.push({
            channelData: [ new Float32Array([ 0 ]), new Float32Array([ 0 ]) ],
            mediaTimeMicroseconds: requireMicroseconds(4_000_000)
        })).toThrow('Cannot add audio after output pipeline finalization');
    });

    it('preserves normal 7.1 program gain and limits only an overloaded downmix', () => {
        const pipeline = createPipeline(true);
        const frameCount = 12_000;
        const peakFrame = 6_000;
        const inputChannels: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < 8; channelIndex += 1) {
            inputChannels.push(new Float32Array(frameCount));
        }
        inputChannels[0].fill(0.5);
        inputChannels[1].fill(0.5);
        for (let channelIndex = 0; channelIndex < inputChannels.length; channelIndex += 1) {
            if (channelIndex !== 3) {
                inputChannels[channelIndex][peakFrame] = 1;
            }
        }
        const downmixedChannels = downmixSevenPointOneToStereo(inputChannels);

        const outputs = pipeline.push({
            channelData: downmixedChannels,
            mediaTimeMicroseconds: requireMicroseconds(5_000_000)
        });
        outputs.push(...pipeline.finalize());
        const outputLeft = new Float32Array(frameCount);
        let outputFrameOffset = 0;
        for (const output of outputs) {
            outputLeft.set(output.channelData[0], outputFrameOffset);
            outputFrameOffset += output.frameCount;
        }

        expect(outputFrameOffset).toBe(frameCount);
        expect(downmixedChannels[0][0]).toBe(0.5);
        expect(outputLeft[0]).toBe(0.5);
        expect(outputLeft[peakFrame - 1_000]).toBe(0.5);
        expect(Math.abs(outputLeft[peakFrame]))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
        expect(getMaximumPeak(outputs))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
    });

    it('does not carry limiter gain into a replacement playback generation', () => {
        const retiredPipeline = createPipeline(true);
        const overloaded = new Float32Array(6_000);
        overloaded.fill(2);
        retiredPipeline.push({
            channelData: [ overloaded, overloaded ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });

        const replacementPipeline = createPipeline(true);
        const safe = new Float32Array(6_000);
        safe.fill(0.5);
        const replacementOutput = replacementPipeline.push({
            channelData: [ safe, safe ],
            mediaTimeMicroseconds: requireMicroseconds(10_000_000)
        });

        expect(replacementOutput[0].channelData[0][0]).toBe(0.5);
    });
});
