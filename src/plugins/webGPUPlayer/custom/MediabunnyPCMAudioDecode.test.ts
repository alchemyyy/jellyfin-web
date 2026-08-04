import { describe, expect, it } from 'vitest';
import {
    ALL_FORMATS,
    AudioSample,
    AudioSampleSink,
    AudioSampleSource,
    BufferSource,
    BufferTarget,
    Input,
    MovOutputFormat,
    Output,
    type AudioCodec
} from 'mediabunny';

import { MEDIABUNNY_PCM_DECODER_CODECS } from './CustomAudioOutputPolicy';
import {
    registerMediabunnyPCMBuiltinDecoderAvailability
} from './MediabunnyPCMBuiltinDecoderAvailability';

const EXPECTED_SAMPLES = new Float32Array([ 0, 0.01, -0.02, 0.05, 0.1 ]);
const SAMPLE_RATE = 44_100;

function getCodecTolerance(codec: AudioCodec): number {
    switch (codec) {
        case 'pcm-u8':
            return 0.012;
        case 'pcm-s8':
            return 0.008;
        case 'ulaw':
        case 'alaw':
            return 0.002;
        case 'pcm-s16':
        case 'pcm-s16be':
            return 0.000_04;
        default:
            return 0.000_001;
    }
}

async function createPCMFixture(codec: AudioCodec): Promise<ArrayBuffer> {
    const target = new BufferTarget();
    const output = new Output({
        format: new MovOutputFormat(),
        target
    });
    const source = new AudioSampleSource({ codec });
    output.addAudioTrack(source);
    await output.start();

    const sample = new AudioSample({
        data: EXPECTED_SAMPLES.buffer.slice(0),
        format: 'f32',
        numberOfChannels: 1,
        numberOfFrames: EXPECTED_SAMPLES.length,
        sampleRate: SAMPLE_RATE,
        timestamp: 0
    });
    try {
        await source.add(sample);
    } finally {
        sample.close();
        source.close();
    }
    await output.finalize();
    if (!target.buffer) {
        throw new Error('Mediabunny did not finalize the PCM fixture');
    }
    return target.buffer;
}

describe('Mediabunny PCM audio decode integration', () => {
    it.each(MEDIABUNNY_PCM_DECODER_CODECS)(
        'round-trips %s through the public MOV demux and AudioSampleSink path',
        async codec => {
            registerMediabunnyPCMBuiltinDecoderAvailability();
            const fixture = await createPCMFixture(codec);
            const input = new Input({
                formats: ALL_FORMATS,
                source: new BufferSource(fixture)
            });
            try {
                const track = await input.getPrimaryAudioTrack();
                expect(track).not.toBeNull();
                if (!track) {
                    return;
                }
                expect(await track.getCodec()).toBe(codec);
                expect(await track.getNumberOfChannels()).toBe(1);
                expect(await track.getSampleRate()).toBe(SAMPLE_RATE);
                expect(await track.canDecode()).toBe(true);

                const sink = new AudioSampleSink(track);
                const outputSamples: number[] = [];
                for await (const decodedSample of sink.samples()) {
                    try {
                        const channel = new Float32Array(decodedSample.numberOfFrames);
                        decodedSample.copyTo(channel, {
                            format: 'f32-planar',
                            planeIndex: 0
                        });
                        outputSamples.push(...channel);
                    } finally {
                        decodedSample.close();
                    }
                }

                expect(outputSamples).toHaveLength(EXPECTED_SAMPLES.length);
                const tolerance = getCodecTolerance(codec);
                for (let sampleIndex = 0; sampleIndex < EXPECTED_SAMPLES.length; sampleIndex += 1) {
                    expect(Math.abs(
                        outputSamples[sampleIndex] - EXPECTED_SAMPLES[sampleIndex]
                    )).toBeLessThanOrEqual(tolerance);
                }
            } finally {
                await input.dispose();
            }
        }
    );
});
