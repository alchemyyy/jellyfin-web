import { describe, expect, it } from 'vitest';

import type { FFmpegTrueHDModule } from '../../../lib/ffmpeg-truehd/ffmpeg-truehd.mjs';
import {
    CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE,
    CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    CUSTOM_WAVE_CHANNEL_MASK_STEREO
} from './CustomWaveChannelLayout';
import { requireMicroseconds } from './TimeMath';
import TrueHDSoftwareAudioDecoder, {
    TRUEHD_CODEC_MLP,
    TRUEHD_CODEC_TRUEHD,
    type TrueHDDecoderModuleFactory
} from './TrueHDSoftwareAudioDecoder';

const DECODER_POINTER = 64;
const PACKET_POINTER = 128;
const OUTPUT_POINTER = 512;
const LIBAVCODEC_VERSION = 4_064_612;
const TRUEHD_ATMOS_PROFILE = 30;

type FakeDecoderOptions = Readonly<{
    bitsPerSample?: number
    channelCount?: number
    channelMask?: number
    receiveStatuses?: readonly number[]
    sampleFormat?: number
    sampleRate?: number
    sendStatus?: number
}>;

type FakeTrueHDDecoder = Readonly<{
    clearCalls: number[]
    createCodecIDs: number[]
    destroyCalls: number[]
    moduleFactory: TrueHDDecoderModuleFactory
}>;

function createFakeTrueHDDecoder(
    options: FakeDecoderOptions = {}
): FakeTrueHDDecoder {
    const memory = new ArrayBuffer(16_384);
    const heap16 = new Int16Array(memory);
    const heap32 = new Int32Array(memory);
    const heapU8 = new Uint8Array(memory);
    const clearCalls: number[] = [];
    const createCodecIDs: number[] = [];
    const destroyCalls: number[] = [];
    const receiveStatuses = [ ...(options.receiveStatuses ?? [ 1, 0 ]) ];
    const functions = new Map<string, (...arguments_: number[]) => number | void>([
        [ 'jellyfin_truehd_clear', (decoder: number): void => {
            clearCalls.push(decoder);
        } ],
        [ 'jellyfin_truehd_configure_packet', (): number => PACKET_POINTER ],
        [ 'jellyfin_truehd_create', (codec: number): number => {
            createCodecIDs.push(codec);
            return DECODER_POINTER;
        } ],
        [ 'jellyfin_truehd_destroy', (decoder: number): void => {
            destroyCalls.push(decoder);
        } ],
        [ 'jellyfin_truehd_get_bits_per_raw_sample', (): number =>
            options.bitsPerSample ?? 24 ],
        [ 'jellyfin_truehd_get_bytes_per_sample', (): number =>
            (options.sampleFormat ?? 2) === 1 ? 2 : 4 ],
        [ 'jellyfin_truehd_get_channel_count', (): number =>
            options.channelCount ?? 2 ],
        [ 'jellyfin_truehd_get_channel_mask', (): number =>
            options.channelMask ?? CUSTOM_WAVE_CHANNEL_MASK_STEREO ],
        [ 'jellyfin_truehd_get_interleaved_data', (): number => OUTPUT_POINTER ],
        [ 'jellyfin_truehd_get_profile', (): number => TRUEHD_ATMOS_PROFILE ],
        [ 'jellyfin_truehd_get_pts', (): number => 1_250_000 ],
        [ 'jellyfin_truehd_get_sample_count', (): number => 2 ],
        [ 'jellyfin_truehd_get_sample_format', (): number => options.sampleFormat ?? 2 ],
        [ 'jellyfin_truehd_get_sample_rate', (): number => options.sampleRate ?? 48_000 ],
        [ 'jellyfin_truehd_library_version', (): number => LIBAVCODEC_VERSION ],
        [ 'jellyfin_truehd_receive_frame', (): number => receiveStatuses.shift() ?? 0 ],
        [ 'jellyfin_truehd_send_packet', (): number => options.sendStatus ?? 1 ]
    ]);
    if ((options.sampleFormat ?? 2) === 1) {
        heap16.set([ 0, 16_384, -16_384, 8_192 ], OUTPUT_POINTER / 2);
    } else {
        heap32.set(
            [ 0, 1_073_741_824, -1_073_741_824, 536_870_912 ],
            OUTPUT_POINTER / 4
        );
    }
    const module: FFmpegTrueHDModule = {
        HEAP16: heap16,
        HEAP32: heap32,
        HEAPU8: heapU8,
        cwrap: (name: string) => {
            const functionValue = functions.get(name);
            if (!functionValue) {
                throw new Error(`Unexpected export ${name}`);
            }
            return functionValue;
        }
    };
    return {
        clearCalls,
        createCodecIDs,
        destroyCalls,
        moduleFactory: async (): Promise<FFmpegTrueHDModule> => module
    };
}

describe('TrueHDSoftwareAudioDecoder', () => {
    it('copies exact packed S32 channel-bed PCM into owned planar floats', async () => {
        const fakeDecoder = createFakeTrueHDDecoder();
        const decoder = await TrueHDSoftwareAudioDecoder.create(
            'truehd',
            fakeDecoder.moduleFactory
        );
        const packet = new Uint8Array([ 1, 2, 3, 4 ]);

        const outputs = decoder.decode(
            packet,
            requireMicroseconds(1_000_000, 'Test packet timestamp')
        );

        expect(fakeDecoder.createCodecIDs).toEqual([ TRUEHD_CODEC_TRUEHD ]);
        expect(outputs).toHaveLength(1);
        expect(outputs[0]).toMatchObject({
            bitsPerSample: 24,
            channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO,
            codec: 'truehd',
            containsAtmosMetadata: true,
            frameCount: 2,
            losslessChannelBed: true,
            mediaTimeMicroseconds: 1_250_000,
            objectAudioRendered: false,
            sampleRate: 48_000
        });
        expect(Array.from(outputs[0].channelData[0])).toEqual([ 0, -0.5 ]);
        expect(Array.from(outputs[0].channelData[1])).toEqual([ 0.5, 0.25 ]);
        expect(outputs[0].pcmFingerprint).toBe(3_726_882_277);
        packet.fill(0);
        expect(Array.from(outputs[0].channelData[1])).toEqual([ 0.5, 0.25 ]);
    });

    it('supports packed S16 output without changing its PCM scale', async () => {
        const fakeDecoder = createFakeTrueHDDecoder({
            bitsPerSample: 16,
            sampleFormat: 1
        });
        const decoder = await TrueHDSoftwareAudioDecoder.create(
            'truehd',
            fakeDecoder.moduleFactory
        );

        const outputs = decoder.decode(
            new Uint8Array([ 1 ]),
            requireMicroseconds(0, 'Test packet timestamp')
        );

        expect(Array.from(outputs[0].channelData[0])).toEqual([ 0, -0.5 ]);
        expect(Array.from(outputs[0].channelData[1])).toEqual([ 0.5, 0.25 ]);
    });

    it.each([
        [ 2, CUSTOM_WAVE_CHANNEL_MASK_STEREO, 48_000 ],
        [ 2, CUSTOM_WAVE_CHANNEL_MASK_STEREO, 44_100 ],
        [ 6, CUSTOM_WAVE_CHANNEL_MASK_FIVE_POINT_ONE_SIDE, 96_000 ],
        [ 8, CUSTOM_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE, 192_000 ]
    ] as const)(
        'accepts qualified %i-channel %i Hz output',
        async (channelCount, channelMask, sampleRate) => {
            const fakeDecoder = createFakeTrueHDDecoder({
                channelCount,
                channelMask,
                sampleRate
            });
            const decoder = await TrueHDSoftwareAudioDecoder.create(
                'truehd',
                fakeDecoder.moduleFactory
            );

            const outputs = decoder.decode(
                new Uint8Array([ 1 ]),
                requireMicroseconds(0, 'Test packet timestamp')
            );

            expect(outputs[0].channelData).toHaveLength(channelCount);
            expect(outputs[0].sampleRate).toBe(sampleRate);
        }
    );

    it('returns no output while FFmpeg searches for the next major sync', async () => {
        const fakeDecoder = createFakeTrueHDDecoder({ sendStatus: 0 });
        const decoder = await TrueHDSoftwareAudioDecoder.create(
            'truehd',
            fakeDecoder.moduleFactory
        );

        expect(decoder.decode(
            new Uint8Array([ 1 ]),
            requireMicroseconds(0, 'Test packet timestamp')
        )).toEqual([]);
    });

    it('selects the separate MLP decoder without relabeling output as TrueHD', async () => {
        const fakeDecoder = createFakeTrueHDDecoder();
        const decoder = await TrueHDSoftwareAudioDecoder.create(
            'mlp',
            fakeDecoder.moduleFactory
        );

        const outputs = decoder.decode(
            new Uint8Array([ 1 ]),
            requireMicroseconds(0, 'Test packet timestamp')
        );

        expect(fakeDecoder.createCodecIDs).toEqual([ TRUEHD_CODEC_MLP ]);
        expect(outputs[0].codec).toBe('mlp');
    });

    it.each([
        [ { sampleRate: 192_001 }, 'sample rate 192001 Hz is outside the supported range' ],
        [ { bitsPerSample: 32 }, 'output depth 32 is unsupported' ],
        [ { channelCount: 6, channelMask: CUSTOM_WAVE_CHANNEL_MASK_STEREO },
            'channel mask 0x3 is unqualified' ],
        [ { sampleFormat: 3 }, 'sample format 3 is unsupported' ]
    ] as const)('rejects output outside the qualified envelope', async (options, message) => {
        const fakeDecoder = createFakeTrueHDDecoder(options);
        const decoder = await TrueHDSoftwareAudioDecoder.create(
            'truehd',
            fakeDecoder.moduleFactory
        );

        expect(() => decoder.decode(
            new Uint8Array([ 1 ]),
            requireMicroseconds(0, 'Test packet timestamp')
        )).toThrow(message);
    });

    it('clears prediction state and destroys exactly once', async () => {
        const fakeDecoder = createFakeTrueHDDecoder();
        const decoder = await TrueHDSoftwareAudioDecoder.create(
            'truehd',
            fakeDecoder.moduleFactory
        );

        decoder.clear();
        decoder.close();
        decoder.close();

        expect(fakeDecoder.clearCalls).toEqual([ DECODER_POINTER ]);
        expect(fakeDecoder.destroyCalls).toEqual([ DECODER_POINTER ]);
        expect(() => decoder.clear()).toThrow('Bundled TrueHD decoder is closed');
        expect(() => decoder.decode(
            new Uint8Array([ 1 ]),
            requireMicroseconds(0, 'Test packet timestamp')
        )).toThrow(
            'Bundled TrueHD decoder is closed'
        );
    });
});
