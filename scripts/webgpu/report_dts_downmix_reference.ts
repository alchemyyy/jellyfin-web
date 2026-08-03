import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { Microseconds } from '../../src/plugins/webGPUVideoPlayer/MediaTime';
import {
    CUSTOM_SEVEN_POINT_ONE_DOWNMIX_POLICY,
    getStereoChannelDataFingerprint,
    type StereoChannelData
} from '../../src/plugins/webGPUVideoPlayer/custom/CustomAudioDownmix';
import { mixCustomAudioToStereo } from '../../src/plugins/webGPUVideoPlayer/custom/CustomAudioChannelLayout';
import DTSSoftwareAudioDecoder, {
    type DTSDecodedAudioOutput
} from '../../src/plugins/webGPUVideoPlayer/custom/DTSSoftwareAudioDecoder';

type DTSFixtureDefinition = {
    expectedChannelMask: number
    expectedProfile: number
    expectedSampleRate: number
    packets: Array<[number, number]>
    qualificationPacketIndex: number
    qualificationStereoFingerprint?: number
};

type StereoMetrics = {
    clippedSampleCount: number
    crestFactor: number
    peak: number
    rms: number
    rmsDBFS: number
};

const FIXTURE_DIRECTORY = resolve(
    process.cwd(),
    'scripts/webgpu/dts/fixtures'
);
const FIXTURE_DEFINITIONS = JSON.parse(readFileSync(
    resolve(FIXTURE_DIRECTORY, 'packets.json'),
    'utf8'
)) as Record<string, DTSFixtureDefinition>;
const DTS_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE = 0x63f;

function computeStereoMetrics(channelData: StereoChannelData): StereoMetrics {
    let clippedSampleCount = 0;
    let peak = 0;
    let squaredSum = 0;
    let sampleCount = 0;
    for (const channel of channelData) {
        for (const sample of channel) {
            if (!Number.isFinite(sample)) {
                throw new Error('DTS downmix reference contains a non-finite sample');
            }
            const absoluteSample = Math.abs(sample);
            peak = Math.max(peak, absoluteSample);
            squaredSum += sample * sample;
            sampleCount += 1;
            if (absoluteSample > 1) {
                clippedSampleCount += 1;
            }
        }
    }
    const rms = Math.sqrt(squaredSum / sampleCount);
    return {
        clippedSampleCount,
        crestFactor: peak / rms,
        peak,
        rms,
        rmsDBFS: 20 * Math.log10(rms)
    };
}

function applyMpvDefaultSevenPointOneMatrix(
    channelData: readonly Float32Array[]
): StereoChannelData {
    const frameCount = channelData[0].length;
    const left = new Float32Array(frameCount);
    const right = new Float32Array(frameCount);
    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
        left[frameIndex] = channelData[0][frameIndex]
            + channelData[2][frameIndex] * Math.SQRT1_2
            + channelData[4][frameIndex] * Math.SQRT1_2
            + channelData[6][frameIndex] * Math.SQRT1_2;
        right[frameIndex] = channelData[1][frameIndex]
            + channelData[2][frameIndex] * Math.SQRT1_2
            + channelData[5][frameIndex] * Math.SQRT1_2
            + channelData[7][frameIndex] * Math.SQRT1_2;
    }
    return [ left, right ];
}

async function decodeQualificationOutput(
    fileName: string,
    definition: DTSFixtureDefinition
): Promise<DTSDecodedAudioOutput> {
    const fixture = new Uint8Array(readFileSync(resolve(FIXTURE_DIRECTORY, fileName)));
    const decoder = await DTSSoftwareAudioDecoder.create();
    try {
        let output: DTSDecodedAudioOutput | null = null;
        for (let packetIndex = 0;
            packetIndex <= definition.qualificationPacketIndex;
            packetIndex += 1) {
            const [ byteOffset, byteLength ] = definition.packets[packetIndex];
            output = decoder.decode(
                fixture.subarray(byteOffset, byteOffset + byteLength),
                0 as Microseconds
            );
        }
        if (!output) {
            throw new Error(`DTS fixture has no qualification output: ${fileName}`);
        }
        return output;
    } finally {
        decoder.close();
    }
}

async function main(): Promise<void> {
    const check = process.argv.includes('--check');
    const report: Record<string, object> = {};
    for (const [ fileName, definition ] of Object.entries(FIXTURE_DEFINITIONS)) {
        if (definition.expectedChannelMask !== DTS_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE
            || (definition.expectedSampleRate !== 48_000
                && definition.expectedSampleRate !== 96_000)) {
            continue;
        }
        const output = await decodeQualificationOutput(fileName, definition);
        const stereo = mixCustomAudioToStereo(output.channelData, output.channelLayout);
        const mpvDefaultStereo = applyMpvDefaultSevenPointOneMatrix(
            output.channelData
        );
        const fingerprint = getStereoChannelDataFingerprint(stereo);
        if (check && fingerprint !== definition.qualificationStereoFingerprint) {
            throw new Error(
                `DTS stereo fingerprint mismatch for ${fileName}: ${fingerprint}`
            );
        }
        report[fileName] = {
            channelMask: output.channelMask,
            frameCount: output.frameCount,
            mpvDefaultCounterfactual: {
                fingerprint: getStereoChannelDataFingerprint(mpvDefaultStereo),
                metrics: computeStereoMetrics(mpvDefaultStereo)
            },
            profile: output.profile,
            sampleRate: output.sampleRate,
            selected: {
                fingerprint,
                metrics: computeStereoMetrics(stereo),
                policy: CUSTOM_SEVEN_POINT_ONE_DOWNMIX_POLICY
            }
        };
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

await main();
