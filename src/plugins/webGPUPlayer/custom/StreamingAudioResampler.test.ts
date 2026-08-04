import { describe, expect, it } from 'vitest';

import { requireMicroseconds } from './TimeMath';
import StreamingAudioResampler, {
    type StreamingAudioResamplerOutput
} from './StreamingAudioResampler';

const TARGET_SAMPLE_RATE = 48_000;
const DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS = 1_000;
const DTS_TIMESTAMP_QUANTIZATION_MICROSECONDS = 2_000;

function concatenateOutput(
    output: readonly StreamingAudioResamplerOutput[],
    channelIndex = 0
): Float32Array {
    const frameCount = output.reduce((sum, chunk) => sum + chunk.frameCount, 0);
    const combined = new Float32Array(frameCount);
    let frameOffset = 0;
    for (const chunk of output) {
        combined.set(chunk.channelData[channelIndex], frameOffset);
        frameOffset += chunk.frameCount;
    }
    return combined;
}

function createSine(sampleRate: number, frequency: number, frameCount: number): Float32Array {
    const output = new Float32Array(frameCount);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        output[frameIndex] = Math.sin(
            2 * Math.PI * frequency * frameIndex / sampleRate
        );
    }
    return output;
}

function calculateRootMeanSquare(samples: Float32Array, startFrame: number): number {
    let squareSum = 0;
    for (let frameIndex = startFrame; frameIndex < samples.length; frameIndex += 1) {
        squareSum += samples[frameIndex] * samples[frameIndex];
    }
    return Math.sqrt(squareSum / (samples.length - startFrame));
}

describe('StreamingAudioResampler', () => {
    it('passes 48 kHz PCM through exactly and splits bounded output chunks', () => {
        const resampler = new StreamingAudioResampler({
            channelCount: 2,
            maximumOutputFrameCount: 3,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: TARGET_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const left = new Float32Array([ 1, 2, 3, 4, 5 ]);
        const right = new Float32Array([ -1, -2, -3, -4, -5 ]);
        const output = resampler.push({
            channelData: [ left, right ],
            mediaTimeMicroseconds: requireMicroseconds(2_000_000)
        });

        expect(output.map(chunk => chunk.frameCount)).toEqual([ 3, 2 ]);
        expect(concatenateOutput(output)).toEqual(left);
        expect(concatenateOutput(output, 1)).toEqual(right);
        expect(output[0].mediaTimeMicroseconds).toBe(2_000_000);
        expect(output[1].mediaTimeMicroseconds).toBe(2_000_063);
        expect(resampler.finalize()).toEqual([]);
        expect(resampler.getTelemetry()).toEqual({
            bufferedSourceFrameCount: 0,
            correctedInputTimestampCount: 0,
            filterLatencySourceFrames: 0,
            finalized: true,
            maximumInputTimestampDeviationMicroseconds: 0,
            outputFrameCount: 5,
            sourceFrameCount: 5
        });
    });

    it('batches tiny passthrough packets into scheduler-safe output chunks', () => {
        const minimumOutputFrameCount = 1_920;
        const packetFrameCount = 240;
        const resampler = new StreamingAudioResampler({
            channelCount: 2,
            maximumOutputFrameCount: 65_536,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount,
            sourceSampleRate: TARGET_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const output: StreamingAudioResamplerOutput[] = [];

        for (let packetIndex = 0; packetIndex < 10; packetIndex += 1) {
            const packetOutput = resampler.push({
                channelData: [
                    new Float32Array(packetFrameCount).fill(packetIndex),
                    new Float32Array(packetFrameCount).fill(-packetIndex)
                ],
                mediaTimeMicroseconds: requireMicroseconds(packetIndex * 5_000)
            });
            if (packetIndex < 7) {
                expect(packetOutput).toEqual([]);
            }
            output.push(...packetOutput);
        }

        expect(output).toHaveLength(1);
        expect(output[0]).toMatchObject({
            durationMicroseconds: 40_000,
            frameCount: minimumOutputFrameCount,
            mediaTimeMicroseconds: 0
        });
        const terminalOutput = resampler.finalize();
        expect(terminalOutput).toHaveLength(1);
        expect(terminalOutput[0]).toMatchObject({
            durationMicroseconds: 10_000,
            frameCount: 480,
            mediaTimeMicroseconds: 40_000
        });
        expect(resampler.getTelemetry()).toMatchObject({
            bufferedSourceFrameCount: 0,
            outputFrameCount: 2_400,
            sourceFrameCount: 2_400
        });
    });

    it('produces identical 44.1 kHz output across arbitrary input boundaries', () => {
        const sourceSampleRate = 44_100;
        const source = createSine(sourceSampleRate, 1_000, sourceSampleRate / 5);
        const createResampler = (): StreamingAudioResampler => new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 65_536,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE
        });

        const contiguousResampler = createResampler();
        const contiguousOutput = contiguousResampler.push({
            channelData: [ source ],
            mediaTimeMicroseconds: requireMicroseconds(1_000_000)
        });
        contiguousOutput.push(...contiguousResampler.finalize());

        const splitResampler = createResampler();
        const splitOutput: StreamingAudioResamplerOutput[] = [];
        const splitFrames = [ 137, 2_048, 17, 4_096, source.length - 6_298 ];
        let sourceOffset = 0;
        for (const frameCount of splitFrames) {
            splitOutput.push(...splitResampler.push({
                channelData: [ source.slice(sourceOffset, sourceOffset + frameCount) ],
                mediaTimeMicroseconds: requireMicroseconds(
                    1_000_000 + Math.round(sourceOffset * 1_000_000 / sourceSampleRate)
                )
            }));
            sourceOffset += frameCount;
        }
        splitOutput.push(...splitResampler.finalize());

        const contiguousSamples = concatenateOutput(contiguousOutput);
        const splitSamples = concatenateOutput(splitOutput);
        expect(splitSamples.length).toBe(9_600);
        expect(splitSamples).toEqual(contiguousSamples);
        expect(splitOutput[0].mediaTimeMicroseconds).toBe(1_000_000);
        expect(splitOutput.at(-1)?.sampleRate).toBe(TARGET_SAMPLE_RATE);
        expect(calculateRootMeanSquare(splitSamples, 128)).toBeCloseTo(Math.SQRT1_2, 3);
        expect(splitResampler.getTelemetry().bufferedSourceFrameCount).toBe(0);
    });

    it('suppresses frequencies above the target Nyquist limit while downsampling', () => {
        const sourceSampleRate = 96_000;
        const frameCount = sourceSampleRate / 4;
        const passbandResampler = new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 65_536,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const stopbandResampler = new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 65_536,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE
        });

        const passbandOutput = passbandResampler.push({
            channelData: [ createSine(sourceSampleRate, 10_000, frameCount) ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });
        passbandOutput.push(...passbandResampler.finalize());
        const stopbandOutput = stopbandResampler.push({
            channelData: [ createSine(sourceSampleRate, 30_000, frameCount) ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });
        stopbandOutput.push(...stopbandResampler.finalize());

        const passbandRootMeanSquare = calculateRootMeanSquare(
            concatenateOutput(passbandOutput),
            128
        );
        const stopbandRootMeanSquare = calculateRootMeanSquare(
            concatenateOutput(stopbandOutput),
            128
        );
        expect(passbandRootMeanSquare).toBeGreaterThan(0.65);
        expect(stopbandRootMeanSquare).toBeLessThan(0.002);
    });

    it('resamples a bounded integer source rate not represented by a fixture', () => {
        const sourceSampleRate = 12_345;
        const source = createSine(sourceSampleRate, 1_000, sourceSampleRate / 5);
        const resampler = new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 65_536,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE
        });

        const output = resampler.push({
            channelData: [ source ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });
        output.push(...resampler.finalize());

        const samples = concatenateOutput(output);
        expect(samples).toHaveLength(9_600);
        expect(calculateRootMeanSquare(samples, 128)).toBeCloseTo(Math.SQRT1_2, 2);
    });

    it.each([ 2_999, 192_001 ])('rejects out-of-range source rate %d', sampleRate => {
        expect(() => new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 1_024,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: sampleRate,
            targetSampleRate: TARGET_SAMPLE_RATE
        })).toThrow('Source sample rate must be between 3000 and 192000 Hz');
    });

    it('canonicalizes bounded Matroska DTS timestamp quantization', () => {
        const resampler = new StreamingAudioResampler({
            channelCount: 2,
            maximumOutputFrameCount: 1_024,
            maximumTimestampQuantizationMicroseconds:
                DTS_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: TARGET_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const DTSFrame = new Float32Array(512);
        const packetTimestamps = [ 0, 10_000, 21_000, 31_000, 42_000, 53_000 ];
        const output: StreamingAudioResamplerOutput[] = [];
        for (const packetTimestamp of packetTimestamps) {
            output.push(...resampler.push({
                channelData: [ DTSFrame, DTSFrame ],
                mediaTimeMicroseconds: requireMicroseconds(packetTimestamp)
            }));
        }

        expect(output.map(chunk => chunk.mediaTimeMicroseconds)).toEqual([
            0,
            10_667,
            21_333,
            32_000,
            42_667,
            53_333
        ]);
        expect(resampler.getTelemetry()).toMatchObject({
            correctedInputTimestampCount: 5,
            maximumInputTimestampDeviationMicroseconds: 1_000
        });
    });

    it('accounts for independent Matroska anchor and packet quantization', () => {
        const resampler = new StreamingAudioResampler({
            channelCount: 2,
            maximumOutputFrameCount: 1_024,
            maximumTimestampQuantizationMicroseconds:
                DTS_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: TARGET_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const DTSFrame = new Float32Array(512);
        const packetTimestamps = [
            0, 10_000, 21_000, 31_000, 42_000, 53_000, 63_000, 74_000,
            86_000, 96_000, 107_000, 117_000, 128_000, 139_000, 149_000,
            160_000, 171_000, 181_000, 192_000, 202_000, 213_000, 224_000,
            234_000, 245_000, 256_000, 266_000, 277_000, 287_000, 298_000,
            308_000
        ];
        const output: StreamingAudioResamplerOutput[] = [];
        for (const packetTimestamp of packetTimestamps) {
            output.push(...resampler.push({
                channelData: [ DTSFrame, DTSFrame ],
                mediaTimeMicroseconds: requireMicroseconds(packetTimestamp)
            }));
        }

        expect(output).toHaveLength(packetTimestamps.length);
        expect(output.at(-1)?.mediaTimeMicroseconds).toBe(309_333);
        expect(resampler.getTelemetry()).toMatchObject({
            correctedInputTimestampCount: 23,
            maximumInputTimestampDeviationMicroseconds: 1_333
        });
    });

    it('does not apply the wider DTS tolerance to ordinary audio routes', () => {
        const resampler = new StreamingAudioResampler({
            channelCount: 2,
            maximumOutputFrameCount: 1_024,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: TARGET_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const frame = new Float32Array(512);
        resampler.push({
            channelData: [ frame, frame ],
            mediaTimeMicroseconds: requireMicroseconds(0)
        });

        expect(() => resampler.push({
            channelData: [ frame, frame ],
            mediaTimeMicroseconds: requireMicroseconds(12_000)
        })).toThrow('Resampler input timestamps contain a gap or overlap');
    });

    it('still rejects a missing DTS packet beyond timestamp quantization', () => {
        const resampler = new StreamingAudioResampler({
            channelCount: 2,
            maximumOutputFrameCount: 1_024,
            maximumTimestampQuantizationMicroseconds:
                DTS_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: TARGET_SAMPLE_RATE,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const DTSFrame = new Float32Array(512);
        for (const packetTimestamp of [ 0, 10_000 ]) {
            resampler.push({
                channelData: [ DTSFrame, DTSFrame ],
                mediaTimeMicroseconds: requireMicroseconds(packetTimestamp)
            });
        }

        expect(() => resampler.push({
            channelData: [ DTSFrame, DTSFrame ],
            mediaTimeMicroseconds: requireMicroseconds(32_000)
        })).toThrow('Resampler input timestamps contain a gap or overlap');
    });

    it('bounds retained history and rejects discontinuous input timestamps', () => {
        const resampler = new StreamingAudioResampler({
            channelCount: 1,
            maximumOutputFrameCount: 4_096,
            maximumTimestampQuantizationMicroseconds:
                DEFAULT_TIMESTAMP_QUANTIZATION_MICROSECONDS,
            minimumOutputFrameCount: 1,
            sourceSampleRate: 192_000,
            targetSampleRate: TARGET_SAMPLE_RATE
        });
        const input = new Float32Array(2_048);
        let sourceFrameOffset = 0;
        for (let chunkIndex = 0; chunkIndex < 40; chunkIndex += 1) {
            resampler.push({
                channelData: [ input ],
                mediaTimeMicroseconds: requireMicroseconds(
                    Math.round(sourceFrameOffset * 1_000_000 / 192_000)
                )
            });
            sourceFrameOffset += input.length;
            expect(resampler.getTelemetry().bufferedSourceFrameCount).toBeLessThanOrEqual(160);
        }

        expect(() => resampler.push({
            channelData: [ input ],
            mediaTimeMicroseconds: requireMicroseconds(999_000)
        })).toThrow('Resampler input timestamps contain a gap or overlap');
    });
});
