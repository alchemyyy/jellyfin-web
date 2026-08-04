// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    CUSTOM_SEVEN_POINT_ONE_DOWNMIX_POLICY,
    SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN,
    SEVEN_POINT_ONE_MAXIMUM_CORRELATED_PEAK,
    SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN,
    downmixSevenPointOneToStereo,
    type StereoChannelData
} from './CustomAudioDownmix';

type StereoMetrics = {
    clippedSampleCount: number
    crestFactor: number
    crestFactorDB: number
    nonFiniteSampleCount: number
    peak: number
    rms: number
    rmsDBFS: number
};

type DownmixPolicyReference = {
    absoluteRowSum: number
    centerBackSideGain: number
    directGain: number
    externalPCMReferenceSHA256: string
    lfeGain: number
    matrix: readonly [ readonly number[], readonly number[] ]
    maximumCorrelatedPeak: number
};

type DownmixReference = {
    channelOrder: readonly string[]
    corpus: {
        frameCount: number
        inputFloat32SHA256: string
        sampleRates: readonly number[]
    }
    measurements: Readonly<Record<string, {
        mpvDefault: StereoMetrics
        mpvNormalized: StereoMetrics
    }>>
    policies: {
        mpvDefault: DownmixPolicyReference
        mpvNormalized: DownmixPolicyReference
    }
    schemaVersion: number
    waveChannelMask: number
};

const REFERENCE_PATH = resolve(
    process.cwd(),
    'scripts/webgpu/downmix-reference/seven-point-one.json'
);
const REFERENCE = JSON.parse(
    readFileSync(REFERENCE_PATH, 'utf8')
) as DownmixReference;
const CHANNEL_COUNT = 8;
const LFE_CHANNEL_INDEX = 3;
const CORRELATED_FULL_SCALE_FRAME = 3_584;
const CORRELATED_NEGATIVE_FULL_SCALE_FRAME = 3_585;
const LFE_ONLY_FRAME = 3_840;

function nextLCGValue(state: number): number {
    return (Math.imul(1_664_525, state) + 1_013_904_223) >>> 0;
}

function createEmptyChannels(frameCount: number): Float32Array[] {
    const channelData: Float32Array[] = [];
    for (let channelIndex = 0; channelIndex < CHANNEL_COUNT; channelIndex += 1) {
        channelData.push(new Float32Array(frameCount));
    }
    return channelData;
}

function writeIsolatedImpulses(channelData: readonly Float32Array[]): void {
    for (let channelIndex = 0; channelIndex < CHANNEL_COUNT; channelIndex += 1) {
        channelData[channelIndex][32 + channelIndex * 64] = 0.5;
    }
}

function writeCorrelatedNoise(channelData: readonly Float32Array[]): void {
    let correlatedState = 0x71c0ffee;
    for (let frameIndex = 1_024; frameIndex < 3_072; frameIndex += 1) {
        correlatedState = nextLCGValue(correlatedState);
        const signedValue = ((correlatedState >>> 16) & 0xffff) - 0x8000;
        const sample = Math.fround(signedValue / 131_072);
        for (let channelIndex = 0; channelIndex < CHANNEL_COUNT; channelIndex += 1) {
            channelData[channelIndex][frameIndex] = channelIndex === LFE_CHANNEL_INDEX ?
                Math.fround(sample * 3) :
                sample;
        }
    }
}

function writeBoundaryFrames(channelData: readonly Float32Array[]): void {
    for (let channelIndex = 0; channelIndex < CHANNEL_COUNT; channelIndex += 1) {
        channelData[channelIndex][CORRELATED_FULL_SCALE_FRAME] =
            channelIndex === LFE_CHANNEL_INDEX ? 100 : 1;
        channelData[channelIndex][CORRELATED_NEGATIVE_FULL_SCALE_FRAME] =
            channelIndex === LFE_CHANNEL_INDEX ? -100 : -1;
    }
    channelData[LFE_CHANNEL_INDEX][LFE_ONLY_FRAME] = 100;
}

function writeIndependentNoise(
    channelData: readonly Float32Array[],
    frameCount: number
): void {
    const channelStates: number[] = [];
    for (let channelIndex = 0; channelIndex < CHANNEL_COUNT; channelIndex += 1) {
        channelStates.push(0xd75a0001 + channelIndex);
    }
    for (let frameIndex = 4_096; frameIndex < frameCount; frameIndex += 1) {
        for (let channelIndex = 0; channelIndex < CHANNEL_COUNT; channelIndex += 1) {
            const state = nextLCGValue(channelStates[channelIndex]);
            channelStates[channelIndex] = state;
            const signedValue = ((state >>> 16) & 0xffff) - 0x8000;
            const scale = channelIndex === LFE_CHANNEL_INDEX ? 3 : 1;
            channelData[channelIndex][frameIndex] = Math.fround(
                signedValue * scale / 131_072
            );
        }
    }
}

function createCorpus(frameCount: number): Float32Array[] {
    const channelData = createEmptyChannels(frameCount);
    writeIsolatedImpulses(channelData);
    writeCorrelatedNoise(channelData);
    writeBoundaryFrames(channelData);
    writeIndependentNoise(channelData, frameCount);
    return channelData;
}

function hashInterleavedFloat32(channelData: readonly Float32Array[]): string {
    const frameCount = channelData[0].length;
    const arrayBuffer = new ArrayBuffer(
        frameCount * channelData.length * Float32Array.BYTES_PER_ELEMENT
    );
    const dataView = new DataView(arrayBuffer);
    let byteOffset = 0;
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        for (const channel of channelData) {
            dataView.setFloat32(byteOffset, channel[frameIndex], true);
            byteOffset += Float32Array.BYTES_PER_ELEMENT;
        }
    }
    return createHash('sha256').update(new Uint8Array(arrayBuffer)).digest('hex');
}

function computeStereoMetrics(channelData: StereoChannelData): StereoMetrics {
    let clippedSampleCount = 0;
    let nonFiniteSampleCount = 0;
    let peak = 0;
    let squaredSum = 0;
    let finiteSampleCount = 0;
    for (const channel of channelData) {
        for (const sample of channel) {
            if (!Number.isFinite(sample)) {
                nonFiniteSampleCount += 1;
                continue;
            }
            finiteSampleCount += 1;
            const absoluteSample = Math.abs(sample);
            peak = Math.max(peak, absoluteSample);
            squaredSum += sample * sample;
            if (absoluteSample > 1) {
                clippedSampleCount += 1;
            }
        }
    }
    const rms = Math.sqrt(squaredSum / finiteSampleCount);
    const crestFactor = peak / rms;
    return {
        clippedSampleCount,
        crestFactor,
        crestFactorDB: 20 * Math.log10(crestFactor),
        nonFiniteSampleCount,
        peak,
        rms,
        rmsDBFS: 20 * Math.log10(rms)
    };
}

describe('7.1 mpv/FFmpeg downmix reference', () => {
    it('pins the exact WAVE order, mask, and selected mpv policy', () => {
        expect(REFERENCE.schemaVersion).toBe(1);
        expect(REFERENCE.waveChannelMask).toBe(0x63f);
        expect(REFERENCE.channelOrder).toEqual([
            'front-left',
            'front-right',
            'front-center',
            'low-frequency-effects',
            'back-left',
            'back-right',
            'side-left',
            'side-right'
        ]);
        expect(CUSTOM_SEVEN_POINT_ONE_DOWNMIX_POLICY).toBe('mpv-normalized');
        expect(SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN).toBe(
            REFERENCE.policies.mpvNormalized.directGain
        );
        expect(SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN).toBe(
            REFERENCE.policies.mpvNormalized.centerBackSideGain
        );
        expect(REFERENCE.policies.mpvNormalized.lfeGain).toBe(0);
        expect(SEVEN_POINT_ONE_MAXIMUM_CORRELATED_PEAK).toBeCloseTo(
            REFERENCE.policies.mpvNormalized.maximumCorrelatedPeak,
            14
        );
    });

    it.each(REFERENCE.corpus.sampleRates)(
        'matches the generated %i Hz corpus metrics without hidden clipping',
        sampleRate => {
            const corpus = createCorpus(REFERENCE.corpus.frameCount);
            expect(hashInterleavedFloat32(corpus)).toBe(
                REFERENCE.corpus.inputFloat32SHA256
            );

            const output = downmixSevenPointOneToStereo(corpus);
            const actual = computeStereoMetrics(output);
            const expected = REFERENCE.measurements[String(sampleRate)].mpvNormalized;

            expect(actual.nonFiniteSampleCount).toBe(expected.nonFiniteSampleCount);
            expect(actual.clippedSampleCount).toBe(expected.clippedSampleCount);
            expect(actual.peak).toBeCloseTo(expected.peak, 7);
            expect(actual.rms).toBeCloseTo(expected.rms, 10);
            expect(actual.rmsDBFS).toBeCloseTo(expected.rmsDBFS, 10);
            expect(actual.crestFactor).toBeCloseTo(expected.crestFactor, 10);
            expect(actual.crestFactorDB).toBeCloseTo(expected.crestFactorDB, 10);
            expect(output[0][LFE_ONLY_FRAME]).toBe(0);
            expect(output[1][LFE_ONLY_FRAME]).toBe(0);
        }
    );

    it('retains normalization because mpv default overloads correlated input', () => {
        const defaultPolicy = REFERENCE.policies.mpvDefault;
        const normalizedPolicy = REFERENCE.policies.mpvNormalized;

        expect(defaultPolicy.directGain).toBe(1);
        expect(normalizedPolicy.directGain).toBeCloseTo(0.3203772410170407, 14);
        expect(defaultPolicy.absoluteRowSum).toBeGreaterThan(3);
        expect(normalizedPolicy.absoluteRowSum).toBeCloseTo(1, 14);
        expect(REFERENCE.measurements['48000'].mpvDefault.clippedSampleCount).toBe(4);
        expect(REFERENCE.measurements['48000'].mpvNormalized.clippedSampleCount).toBe(0);
        expect(
            REFERENCE.measurements['48000'].mpvDefault.rmsDBFS
            - REFERENCE.measurements['48000'].mpvNormalized.rmsDBFS
        ).toBeCloseTo(9.886766849656514, 8);
        expect(defaultPolicy.externalPCMReferenceSHA256).not.toBe(
            normalizedPolicy.externalPCMReferenceSHA256
        );
    });
});
