import { describe, expect, it } from 'vitest';

import type { Microseconds } from '../MediaTime';
import StreamingAudioLookaheadLimiter, {
    CUSTOM_AUDIO_LIMITER_ANALYSIS_MILLISECONDS,
    CUSTOM_AUDIO_LIMITER_ATTACK_CURVE,
    CUSTOM_AUDIO_LIMITER_CEILING_GAIN,
    CUSTOM_AUDIO_LIMITER_MAXIMUM_ATTACK_MILLISECONDS,
    CUSTOM_AUDIO_LIMITER_MINIMUM_ATTACK_MILLISECONDS,
    CUSTOM_AUDIO_LIMITER_RELEASE_MILLISECONDS,
    quinticSmoothstep
} from './StreamingAudioLookaheadLimiter';
import type { StreamingAudioResamplerOutput } from './StreamingAudioResampler';
import {
    addMicroseconds,
    audioFramesToMicroseconds,
    requireMicroseconds
} from './TimeMath';

const SAMPLE_RATE = 48_000;
const ANCHOR_MEDIA_TIME_MICROSECONDS = requireMicroseconds(1_000_000);
const MAXIMUM_OUTPUT_FRAME_COUNT = 1_920;

function createConstantChannel(value: number, frameCount: number): Float32Array {
    const channel = new Float32Array(frameCount);
    channel.fill(value);
    return channel;
}

function createInput(
    channelData: Float32Array[],
    startFrame = 0,
    anchorMediaTimeMicroseconds: Microseconds = ANCHOR_MEDIA_TIME_MICROSECONDS
): StreamingAudioResamplerOutput {
    const frameCount = channelData[0]?.length ?? 0;
    return {
        channelData,
        durationMicroseconds: audioFramesToMicroseconds(frameCount, SAMPLE_RATE),
        frameCount,
        mediaTimeMicroseconds: addMicroseconds(
            anchorMediaTimeMicroseconds,
            audioFramesToMicroseconds(startFrame, SAMPLE_RATE)
        ),
        sampleRate: SAMPLE_RATE
    };
}

function createLimiter(): StreamingAudioLookaheadLimiter {
    return new StreamingAudioLookaheadLimiter({
        channelCount: 2,
        maximumOutputFrameCount: MAXIMUM_OUTPUT_FRAME_COUNT,
        minimumOutputFrameCount: 1,
        sampleRate: SAMPLE_RATE
    });
}

function concatenateChannel(
    outputs: readonly StreamingAudioResamplerOutput[],
    channelIndex: number
): Float32Array {
    const frameCount = outputs.reduce((sum, output) => sum + output.frameCount, 0);
    const channelData = new Float32Array(frameCount);
    let frameOffset = 0;
    for (const output of outputs) {
        channelData.set(output.channelData[channelIndex], frameOffset);
        frameOffset += output.frameCount;
    }
    return channelData;
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

describe('StreamingAudioLookaheadLimiter', () => {
    it('pins the 100 ms linked limiter policy and quintic endpoint behavior', () => {
        expect(CUSTOM_AUDIO_LIMITER_ANALYSIS_MILLISECONDS).toBe(100);
        expect(CUSTOM_AUDIO_LIMITER_MINIMUM_ATTACK_MILLISECONDS).toBe(3);
        expect(CUSTOM_AUDIO_LIMITER_MAXIMUM_ATTACK_MILLISECONDS).toBe(10);
        expect(CUSTOM_AUDIO_LIMITER_RELEASE_MILLISECONDS).toBe(100);
        expect(CUSTOM_AUDIO_LIMITER_ATTACK_CURVE).toBe('quintic-smoothstep');
        expect(CUSTOM_AUDIO_LIMITER_CEILING_GAIN).toBeCloseTo(0.891250938, 9);
        expect(quinticSmoothstep(0)).toBe(0);
        expect(quinticSmoothstep(0.5)).toBe(0.5);
        expect(quinticSmoothstep(1)).toBe(1);
        expect(quinticSmoothstep(-1)).toBe(0);
        expect(quinticSmoothstep(2)).toBe(1);
        const endpointStep = 0.001;
        expect(quinticSmoothstep(endpointStep)).toBeLessThan(1e-7);
        expect(1 - quinticSmoothstep(1 - endpointStep)).toBeLessThan(1e-7);
    });

    it('retains exactly 100 ms and preserves safe program gain and timestamps', () => {
        const limiter = createLimiter();
        const frameCount = 6_000;
        const input = createInput([
            createConstantChannel(0.25, frameCount),
            createConstantChannel(-0.5, frameCount)
        ]);

        const initialOutput = limiter.push([ input ]);
        expect(limiter.analysisFrameCount).toBe(4_800);
        expect(initialOutput.map(output => output.frameCount)).toEqual([ 1_200 ]);
        expect(initialOutput[0].mediaTimeMicroseconds)
            .toBe(ANCHOR_MEDIA_TIME_MICROSECONDS);

        const outputs = [ ...initialOutput, ...limiter.finalize() ];
        expect(outputs.reduce((sum, output) => sum + output.frameCount, 0))
            .toBe(frameCount);
        expect(concatenateChannel(outputs, 0)).toEqual(input.channelData[0]);
        expect(concatenateChannel(outputs, 1)).toEqual(input.channelData[1]);
        expect(outputs.at(-1)?.mediaTimeMicroseconds).toBe(
            addMicroseconds(
                ANCHOR_MEDIA_TIME_MICROSECONDS,
                audioFramesToMicroseconds(5_040, SAMPLE_RATE)
            )
        );
        expect(limiter.getTelemetry()).toMatchObject({
            bufferedFrameCount: 0,
            finalized: true,
            limitedFrameCount: 0,
            maximumInputPeak: 0.5,
            maximumOutputPeak: 0.5,
            minimumAppliedGain: 1,
            outputFrameCount: frameCount,
            sourceFrameCount: frameCount
        });
    });

    it('anticipates a transient with a linked quintic attack and smooth release', () => {
        const limiter = createLimiter();
        const frameCount = 12_000;
        const peakFrame = 6_000;
        const left = createConstantChannel(0.25, frameCount);
        const right = createConstantChannel(0.25, frameCount);
        right[peakFrame] = 2;

        const outputs = limiter.push([ createInput([ left, right ]) ]);
        outputs.push(...limiter.finalize());
        const outputLeft = concatenateChannel(outputs, 0);
        const outputRight = concatenateChannel(outputs, 1);
        const maximumAttackFrameCount = limiter.maximumAttackFrameCount;
        const unityFrame = peakFrame - maximumAttackFrameCount - 1;
        expect(outputLeft[unityFrame]).toBe(0.25);

        let previousGain = outputLeft[peakFrame - maximumAttackFrameCount] / 0.25;
        for (let frameIndex = peakFrame - maximumAttackFrameCount + 1;
            frameIndex <= peakFrame;
            frameIndex += 1) {
            const gain = outputLeft[frameIndex] / 0.25;
            expect(gain).toBeLessThanOrEqual(previousGain + 1e-6);
            previousGain = gain;
        }
        const leftPeakGain = outputLeft[peakFrame] / 0.25;
        const rightPeakGain = outputRight[peakFrame] / 2;
        expect(leftPeakGain).toBeCloseTo(rightPeakGain, 6);
        expect(Math.abs(outputRight[peakFrame]))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
        expect(outputLeft[peakFrame + 1] / 0.25).toBeGreaterThan(leftPeakGain);
        expect(outputLeft[peakFrame + 4_800] / 0.25).toBeGreaterThan(0.75);
        expect(outputLeft[peakFrame + 4_800] / 0.25).toBeLessThan(0.9);
        expect(getMaximumPeak(outputs))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
    });

    it('keeps nearby peaks under one continuous linked gain envelope', () => {
        const limiter = createLimiter();
        const frameCount = 14_000;
        const firstPeakFrame = 5_000;
        const secondPeakFrame = 7_400;
        const left = createConstantChannel(0.25, frameCount);
        const right = createConstantChannel(0.25, frameCount);
        left[firstPeakFrame] = 2.5;
        right[secondPeakFrame] = -2.5;

        const outputs = limiter.push([ createInput([ left, right ]) ]);
        outputs.push(...limiter.finalize());
        const outputLeft = concatenateChannel(outputs, 0);
        const outputRight = concatenateChannel(outputs, 1);
        const midpointFrame = Math.floor((firstPeakFrame + secondPeakFrame) / 2);

        expect(outputLeft[midpointFrame] / 0.25).toBeLessThan(0.8);
        expect(Math.abs(outputLeft[firstPeakFrame]))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
        expect(Math.abs(outputRight[secondPeakFrame]))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
        expect(getMaximumPeak(outputs))
            .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
    });

    it('is sample-exact across arbitrary input chunk boundaries', () => {
        const frameCount = 15_000;
        const left = new Float32Array(frameCount);
        const right = new Float32Array(frameCount);
        for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
            left[frameIndex] = Math.fround(Math.sin(frameIndex / 31) * 0.8);
            right[frameIndex] = Math.fround(Math.cos(frameIndex / 47) * 0.8);
        }
        left[4_500] = 2.25;
        right[10_200] = -2.75;

        const contiguousLimiter = createLimiter();
        const contiguousOutputs = contiguousLimiter.push([
            createInput([ left, right ])
        ]);
        contiguousOutputs.push(...contiguousLimiter.finalize());

        const splitLimiter = createLimiter();
        const splitOutputs: StreamingAudioResamplerOutput[] = [];
        const splitFrameCounts = [ 137, 2_048, 17, 4_096, 3_001, 5_701 ];
        let frameOffset = 0;
        for (const splitFrameCount of splitFrameCounts) {
            splitOutputs.push(...splitLimiter.push([ createInput(
                [
                    left.slice(frameOffset, frameOffset + splitFrameCount),
                    right.slice(frameOffset, frameOffset + splitFrameCount)
                ],
                frameOffset
            ) ]));
            frameOffset += splitFrameCount;
        }
        splitOutputs.push(...splitLimiter.finalize());

        expect(frameOffset).toBe(frameCount);
        expect(concatenateChannel(splitOutputs, 0)).toEqual(
            concatenateChannel(contiguousOutputs, 0)
        );
        expect(concatenateChannel(splitOutputs, 1)).toEqual(
            concatenateChannel(contiguousOutputs, 1)
        );
    });

    it('flushes short and exact-horizon streams without dropping their final peak', () => {
        for (const frameCount of [ 100, 4_800 ]) {
            const limiter = createLimiter();
            const left = createConstantChannel(0.1, frameCount);
            const right = createConstantChannel(0.1, frameCount);
            right[frameCount - 1] = 3;

            expect(limiter.push([ createInput([ left, right ]) ])).toEqual([]);
            const terminalOutput = limiter.finalize();
            expect(terminalOutput.reduce((sum, output) => sum + output.frameCount, 0))
                .toBe(frameCount);
            expect(getMaximumPeak(terminalOutput))
                .toBeLessThanOrEqual(CUSTOM_AUDIO_LIMITER_CEILING_GAIN + 1e-6);
            expect(limiter.finalize()).toEqual([]);
            expect(() => limiter.push([])).toThrow(
                'Cannot add audio after limiter finalization'
            );
        }

        const emptyLimiter = createLimiter();
        expect(emptyLimiter.finalize()).toEqual([]);
        expect(emptyLimiter.finalize()).toEqual([]);
    });

    it('rejects malformed samples and discontinuous timestamps', () => {
        const nonFiniteLimiter = createLimiter();
        expect(() => nonFiniteLimiter.push([ createInput([
            new Float32Array([ Number.NaN ]),
            new Float32Array([ 0 ])
        ]) ])).toThrow('Limiter input samples must be finite');

        const discontinuousLimiter = createLimiter();
        discontinuousLimiter.push([ createInput([
            new Float32Array([ 0 ]),
            new Float32Array([ 0 ])
        ]) ]);
        expect(() => discontinuousLimiter.push([ createInput(
            [ new Float32Array([ 0 ]), new Float32Array([ 0 ]) ],
            100
        ) ])).toThrow('Limiter input timestamps contain a gap or overlap');
    });
});
