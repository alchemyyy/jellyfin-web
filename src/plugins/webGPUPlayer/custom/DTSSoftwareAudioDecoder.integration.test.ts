// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Microseconds } from '../MediaTime';
import {
    getStereoChannelDataFingerprint,
    type StereoChannelData
} from './CustomAudioDownmix';
import { mixCustomAudioToStereo } from './CustomAudioChannelLayout';
import { createDTSExactCapabilityFixtures } from './DTSExactCapabilityFixtures';
import { runDTSExactCapabilityQualification } from './DTSExactCapabilityRunner';
import DTSSoftwareAudioDecoder, {
    DTS_PROFILE_HD_MASTER_AUDIO,
    type DTSDecodedAudioOutput,
    getDTSDecodedAudioFingerprint
} from './DTSSoftwareAudioDecoder';
import StreamingAudioResampler, {
    type StreamingAudioResamplerOutput
} from './StreamingAudioResampler';
import { requireMicroseconds } from './TimeMath';

type DTSFixtureDefinition = {
    expectedBitsPerSample: number
    expectedChannelMask: number
    expectedProfile: number
    expectedSampleRate: number
    packets: Array<[number, number]>
    qualificationFingerprint: number
    qualificationFrameCount: number
    qualificationPacketIndex: number
    qualificationStereoFingerprint?: number
    referenceDelayFrames?: number
    referenceFrameCount?: number
};

const FIXTURE_DIRECTORY = resolve(
    process.cwd(),
    'scripts/webgpu/dts/fixtures'
);
const FIXTURE_DEFINITIONS = JSON.parse(readFileSync(
    resolve(FIXTURE_DIRECTORY, 'packets.json'),
    'utf8'
)) as Record<string, DTSFixtureDefinition>;
const WAVE_DATA_OFFSET = 44;
const DTS_24_BIT_SAMPLE_SCALE = 2 ** 23;

function decodeSigned24BitWave(path: string): Float32Array {
    const waveData = new Uint8Array(readFileSync(path)).subarray(WAVE_DATA_OFFSET);
    if (waveData.byteLength % 3 !== 0) {
        throw new Error('DTS reference WAVE data is not signed 24-bit PCM');
    }
    const output = new Float32Array(waveData.byteLength / 3);
    for (let frameIndex = 0; frameIndex < output.length; frameIndex += 1) {
        const byteOffset = frameIndex * 3;
        let sample = waveData[byteOffset]
            | (waveData[byteOffset + 1] << 8)
            | (waveData[byteOffset + 2] << 16);
        if ((sample & 0x80_0000) !== 0) {
            sample -= 0x100_0000;
        }
        output[frameIndex] = sample / DTS_24_BIT_SAMPLE_SCALE;
    }
    return output;
}

async function decodeFixture(fileName: string): Promise<DTSDecodedAudioOutput[]> {
    const definition = FIXTURE_DEFINITIONS[fileName];
    const fixture = new Uint8Array(readFileSync(resolve(FIXTURE_DIRECTORY, fileName)));
    const decoder = await DTSSoftwareAudioDecoder.create();
    const outputs: DTSDecodedAudioOutput[] = [];
    try {
        let mediaTimeMicroseconds = requireMicroseconds(0);
        for (const [ byteOffset, byteLength ] of definition.packets) {
            outputs.push(decoder.decode(
                fixture.subarray(byteOffset, byteOffset + byteLength),
                mediaTimeMicroseconds
            ));
            mediaTimeMicroseconds = requireMicroseconds(mediaTimeMicroseconds + 10_667);
        }
    } finally {
        decoder.close();
    }
    return outputs;
}

function concatenateProfilePlane(
    outputs: readonly DTSDecodedAudioOutput[],
    profile: number,
    channelIndex: number
): Float32Array {
    const selectedOutputs = outputs.filter(output => output.profile === profile);
    const totalFrameCount = selectedOutputs.reduce(
        (frameCount, output) => frameCount + output.frameCount,
        0
    );
    const result = new Float32Array(totalFrameCount);
    let frameOffset = 0;
    for (const output of selectedOutputs) {
        const plane = output.channelData[channelIndex];
        result.set(plane, frameOffset);
        frameOffset += plane.length;
    }
    return result;
}

function concatenateStereoOutput(
    outputs: readonly StreamingAudioResamplerOutput[]
): StereoChannelData {
    const frameCount = outputs.reduce(
        (totalFrameCount, output) => totalFrameCount + output.frameCount,
        0
    );
    const left = new Float32Array(frameCount);
    const right = new Float32Array(frameCount);
    let frameOffset = 0;
    for (const output of outputs) {
        left.set(output.channelData[0], frameOffset);
        right.set(output.channelData[1], frameOffset);
        frameOffset += output.frameCount;
    }
    return [ left, right ];
}

function resampleStereo(
    channelData: StereoChannelData,
    sourceSampleRate: number,
    splitFrameCounts: readonly number[]
): StereoChannelData {
    const resampler = new StreamingAudioResampler({
        channelCount: 2,
        maximumOutputFrameCount: 4_096,
        maximumTimestampQuantizationMicroseconds: 2_000,
        minimumOutputFrameCount: 1,
        sourceSampleRate,
        targetSampleRate: 48_000
    });
    const outputs: StreamingAudioResamplerOutput[] = [];
    let frameOffset = 0;
    for (const frameCount of splitFrameCounts) {
        outputs.push(...resampler.push({
            channelData: [
                channelData[0].slice(frameOffset, frameOffset + frameCount),
                channelData[1].slice(frameOffset, frameOffset + frameCount)
            ],
            mediaTimeMicroseconds: requireMicroseconds(
                Math.round(frameOffset * 1_000_000 / sourceSampleRate)
            )
        }));
        frameOffset += frameCount;
    }
    if (frameOffset !== channelData[0].length) {
        throw new Error('DTS downmix resampler split does not cover the input');
    }
    outputs.push(...resampler.finalize());
    return concatenateStereoOutput(outputs);
}

describe('bundled libdcadec integration', () => {
    it('passes exact family output and real-time throughput qualification', async () => {
        const result = await runDTSExactCapabilityQualification();

        expect(result).toMatchObject({
            reason: 'decode-output-verified',
            supported: true,
            verifiedFixtureCount: 7,
            verifiedProfileMask: 0x1f
        });
        expect(result.measuredRealTimeFactor).toBeGreaterThanOrEqual(2);
    });

    it.each(createDTSExactCapabilityFixtures())(
        'decodes isolated qualification access unit $source exactly',
        async fixture => {
            const decoder = await DTSSoftwareAudioDecoder.create();
            try {
                let output: DTSDecodedAudioOutput | null = null;
                for (const accessUnit of fixture.accessUnits) {
                    output = decoder.decode(accessUnit, 0 as Microseconds);
                }
                if (!output) {
                    throw new Error('DTS qualification fixture has no access units');
                }
                expect(output).toMatchObject({
                    bitsPerSample: fixture.bitsPerSample,
                    channelMask: fixture.channelMask,
                    frameCount: fixture.frameCount,
                    profile: fixture.profile,
                    sampleRate: fixture.sampleRate
                });
                expect(getDTSDecodedAudioFingerprint(output)).toBe(
                    fixture.expectedFingerprint
                );
            } finally {
                decoder.close();
            }
        }
    );

    it.each(Object.entries(FIXTURE_DEFINITIONS))(
        'decodes exact profile fixture %s through the generated WebAssembly ABI',
        async (fileName, definition) => {
            const outputs = await decodeFixture(fileName);
            const matchingOutputs = outputs.filter(output => (
                output.profile === definition.expectedProfile
            ));

            expect(matchingOutputs.length).toBeGreaterThan(0);
            for (const output of matchingOutputs) {
                expect(output.channelMask).toBe(definition.expectedChannelMask);
                expect(output.bitsPerSample).toBe(definition.expectedBitsPerSample);
                expect(output.sampleRate).toBe(definition.expectedSampleRate);
                expect(output.channelData.length).toBe(output.channelLayout.channels.length);
                expect(output.parseStatus).toBe(0);
                expect(output.filterStatus).toBe(0);
                for (const channel of output.channelData) {
                    expect(channel.every(Number.isFinite)).toBe(true);
                }
            }
            const qualificationOutput = outputs[definition.qualificationPacketIndex];
            expect(qualificationOutput.frameCount).toBe(definition.qualificationFrameCount);
            expect(getDTSDecodedAudioFingerprint(qualificationOutput)).toBe(
                definition.qualificationFingerprint
            );
            if (definition.qualificationStereoFingerprint !== undefined) {
                const stereo: StereoChannelData = mixCustomAudioToStereo(
                    qualificationOutput.channelData,
                    qualificationOutput.channelLayout
                );
                expect(qualificationOutput.channelLayout.id).toBe('7.1');
                expect(getStereoChannelDataFingerprint(stereo)).toBe(
                    definition.qualificationStereoFingerprint
                );
                for (const channel of stereo) {
                    for (const sample of channel) {
                        expect(Number.isFinite(sample)).toBe(true);
                        expect(Math.abs(sample)).toBeLessThanOrEqual(1);
                    }
                }
            }
        }
    );

    it.each(Object.entries(FIXTURE_DEFINITIONS).filter(([, definition ]) => (
        definition.qualificationStereoFingerprint !== undefined
    )))(
        'keeps exact 7.1 normalization for %s across decode/resampler boundaries',
        async (fileName, definition) => {
            const outputs = await decodeFixture(fileName);
            const qualificationOutput = outputs[definition.qualificationPacketIndex];
            const stereo = mixCustomAudioToStereo(
                qualificationOutput.channelData,
                qualificationOutput.channelLayout
            );
            const contiguous = resampleStereo(
                stereo,
                qualificationOutput.sampleRate,
                [ stereo[0].length ]
            );
            const splitFrameCounts = [
                17,
                101,
                stereo[0].length - 118
            ];
            const split = resampleStereo(
                stereo,
                qualificationOutput.sampleRate,
                splitFrameCounts
            );

            expect(split).toEqual(contiguous);
            for (const channel of split) {
                for (const sample of channel) {
                    expect(Number.isFinite(sample)).toBe(true);
                    expect(Math.abs(sample)).toBeLessThanOrEqual(1);
                }
            }
        }
    );

    it('matches the public-domain DTS-HD MA reference PCM sample for sample', async () => {
        const fixtureDefinition = FIXTURE_DEFINITIONS['xll_71_24_48_768_0.dtshd'];
        const outputs = await decodeFixture('xll_71_24_48_768_0.dtshd');
        const referenceNames = [ 'L', 'R', 'C', 'LFE', 'Lsr', 'Rsr', 'Lss', 'Rss' ];
        const referenceDelayFrames = fixtureDefinition.referenceDelayFrames ?? 0;
        const referenceFrameCount = fixtureDefinition.referenceFrameCount ?? 0;

        for (let channelIndex = 0; channelIndex < referenceNames.length; channelIndex += 1) {
            const decoded = concatenateProfilePlane(
                outputs,
                DTS_PROFILE_HD_MASTER_AUDIO,
                channelIndex
            );
            const actual = decoded.slice(
                referenceDelayFrames,
                referenceDelayFrames + referenceFrameCount
            );
            const expected = decodeSigned24BitWave(resolve(
                FIXTURE_DIRECTORY,
                'reference',
                `xll_71_24_48_768_0_${referenceNames[channelIndex]}.wav`
            ));
            expect(actual).toEqual(expected);
        }
        expect(outputs
            .filter(output => output.profile === DTS_PROFILE_HD_MASTER_AUDIO)
            .every(output => output.lossless))
            .toBe(true);
    });
});
