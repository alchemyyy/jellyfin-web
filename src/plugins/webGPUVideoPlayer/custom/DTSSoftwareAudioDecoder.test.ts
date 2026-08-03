/* eslint-disable @typescript-eslint/naming-convention -- libdcadec exposes fixed C ABI symbols */
import { describe, expect, it } from 'vitest';

import { millisecondsToMicroseconds, type Microseconds } from '../MediaTime';
import DTSSoftwareAudioDecoder, {
    DTS_PROFILE_HD_HIGH_RESOLUTION,
    DTS_PROFILE_HD_MASTER_AUDIO,
    type DTSDecoderModuleFactory,
    getDTSDecodedAudioFingerprint
} from './DTSSoftwareAudioDecoder';
import {
    DTS_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE,
    DTS_WAVE_CHANNEL_MASK_STEREO
} from './DTSChannelLayout';
import type { LibDCADECModule } from '../../../lib/libdcadec/libdcadec.mjs';

const DECODER_POINTER = 64;
const PACKET_POINTER = 128;
const LEFT_PLANE_POINTER = 1_024;
const RIGHT_PLANE_POINTER = 1_088;
const FRAME_COUNT = 4;
const LIBDCADEC_VERSION = 0x0002_0001;

type FakeDTSDecoder = Readonly<{
    clearCalls: number[]
    destroyCalls: number[]
    module: LibDCADECModule
    moduleFactory: DTSDecoderModuleFactory
}>;

function createFakeDTSDecoder(
    overrides: Readonly<Record<string, (...arguments_: number[]) => number>> = {}
): FakeDTSDecoder {
    const memory = new ArrayBuffer(8_192);
    const heapBytes = new Uint8Array(memory);
    const heapIntegers = new Int32Array(memory);
    const clearCalls: number[] = [];
    const destroyCalls: number[] = [];
    const functions: Record<string, (...arguments_: number[]) => number> = {
        jellyfin_dts_clear: decoder => {
            clearCalls.push(decoder);
            return 0;
        },
        jellyfin_dts_configure_packet: () => PACKET_POINTER,
        jellyfin_dts_create: () => DECODER_POINTER,
        jellyfin_dts_decode_packet: () => 0,
        jellyfin_dts_destroy: decoder => {
            destroyCalls.push(decoder);
            return 0;
        },
        jellyfin_dts_get_bits_per_sample: () => 24,
        jellyfin_dts_get_channel_mask: () => DTS_WAVE_CHANNEL_MASK_STEREO,
        jellyfin_dts_get_filter_status: () => 0,
        jellyfin_dts_get_parse_status: () => 0,
        jellyfin_dts_get_plane: (_decoder, channelIndex) => (
            channelIndex === 0 ? LEFT_PLANE_POINTER : RIGHT_PLANE_POINTER
        ),
        jellyfin_dts_get_profile: () => DTS_PROFILE_HD_MASTER_AUDIO,
        jellyfin_dts_get_sample_count: () => FRAME_COUNT,
        jellyfin_dts_get_sample_rate: () => 48_000,
        jellyfin_dts_library_version: () => LIBDCADEC_VERSION,
        ...overrides
    };
    heapIntegers.set(
        [ -8_388_608, -4_194_304, 0, 8_388_607 ],
        LEFT_PLANE_POINTER / Int32Array.BYTES_PER_ELEMENT
    );
    heapIntegers.set(
        [ 8_388_607, 0, -4_194_304, -8_388_608 ],
        RIGHT_PLANE_POINTER / Int32Array.BYTES_PER_ELEMENT
    );

    const module: LibDCADECModule = {
        HEAP32: heapIntegers,
        HEAPU8: heapBytes,
        cwrap: name => {
            const functionValue = functions[name];
            if (!functionValue) {
                throw new Error(`Unexpected libdcadec export ${name}`);
            }
            return functionValue;
        }
    };
    return {
        clearCalls,
        destroyCalls,
        module,
        moduleFactory: async () => module
    };
}

describe('DTSSoftwareAudioDecoder', () => {
    it('copies a bounded packet and returns owned normalized planar PCM', async () => {
        const fakeDecoder = createFakeDTSDecoder();
        const decoder = await DTSSoftwareAudioDecoder.create(fakeDecoder.moduleFactory);
        const timestamp = millisecondsToMicroseconds(250);
        const packet = new Uint8Array([ 0x7f, 0xfe, 0x80, 0x01 ]);

        const output = decoder.decode(packet, timestamp);

        expect(fakeDecoder.module.HEAPU8.slice(
            PACKET_POINTER,
            PACKET_POINTER + packet.length
        )).toEqual(packet);
        expect(output).toMatchObject({
            bitsPerSample: 24,
            channelMask: DTS_WAVE_CHANNEL_MASK_STEREO,
            filterStatus: 0,
            frameCount: FRAME_COUNT,
            lossless: true,
            mediaTimeMicroseconds: timestamp,
            parseStatus: 0,
            profile: DTS_PROFILE_HD_MASTER_AUDIO,
            sampleRate: 48_000
        });
        expect(output.channelData[0]).toEqual(new Float32Array([
            -1,
            -0.5,
            0,
            8_388_607 / 8_388_608
        ]));
        expect(output.channelData[1]).toEqual(new Float32Array([
            8_388_607 / 8_388_608,
            0,
            -0.5,
            -1
        ]));
        expect(getDTSDecodedAudioFingerprint(output)).toBe(1_290_773_909);

        fakeDecoder.module.HEAP32[LEFT_PLANE_POINTER / Int32Array.BYTES_PER_ELEMENT] = 0;
        expect(output.channelData[0][0]).toBe(-1);
        decoder.close();
    });

    it('clears history and destroys its context exactly once', async () => {
        const fakeDecoder = createFakeDTSDecoder();
        const decoder = await DTSSoftwareAudioDecoder.create(fakeDecoder.moduleFactory);

        decoder.clear();
        decoder.close();
        decoder.close();

        expect(fakeDecoder.clearCalls).toEqual([ DECODER_POINTER ]);
        expect(fakeDecoder.destroyCalls).toEqual([ DECODER_POINTER ]);
        expect(() => decoder.clear()).toThrow('Bundled DTS decoder is closed');
        expect(() => decoder.decode(
            new Uint8Array([ 1 ]),
            millisecondsToMicroseconds(0)
        )).toThrow('Bundled DTS decoder is closed');
    });

    it('accepts a bounded decoder sample rate not represented by a fixture', async () => {
        const fakeDecoder = createFakeDTSDecoder({
            jellyfin_dts_get_sample_rate: () => 44_100
        });
        const decoder = await DTSSoftwareAudioDecoder.create(fakeDecoder.moduleFactory);

        const output = decoder.decode(
            new Uint8Array([ 1 ]),
            millisecondsToMicroseconds(0)
        );

        expect(output.sampleRate).toBe(44_100);
        decoder.close();
    });

    it.each([
        [ new Uint8Array(), millisecondsToMicroseconds(0), 'packet size' ],
        [ new Uint8Array(2 * 1024 * 1024 + 1), millisecondsToMicroseconds(0), 'packet size' ],
        [ new Uint8Array([ 1 ]), 0.5 as Microseconds, 'safe integer' ]
    ])('rejects data outside the bounded input envelope', async (packet, timestamp, message) => {
        const fakeDecoder = createFakeDTSDecoder();
        const decoder = await DTSSoftwareAudioDecoder.create(fakeDecoder.moduleFactory);

        expect(() => decoder.decode(packet, timestamp)).toThrow(message);
        decoder.close();
    });

    it.each([
        [ 'jellyfin_dts_decode_packet', () => -5, 'decode failed' ],
        [ 'jellyfin_dts_get_sample_count', () => 16_385, 'frame count' ],
        [ 'jellyfin_dts_get_sample_rate', () => 192_001, 'outside the supported range' ],
        [ 'jellyfin_dts_get_bits_per_sample', () => 20, 'unsupported' ],
        [ 'jellyfin_dts_get_profile', () => 0, 'profile' ],
        [ 'jellyfin_dts_get_channel_mask', () => 1, 'channel mask' ],
        [ 'jellyfin_dts_get_plane', () => 3, 'outside decoder memory' ]
    ])('rejects invalid decoder output from %s', async (name, functionValue, message) => {
        const fakeDecoder = createFakeDTSDecoder({ [name]: functionValue });
        const decoder = await DTSSoftwareAudioDecoder.create(fakeDecoder.moduleFactory);

        expect(() => decoder.decode(
            new Uint8Array([ 1 ]),
            millisecondsToMicroseconds(0)
        )).toThrow(message);
        decoder.close();
    });

    it('does not label lossy DTS profiles as lossless', async () => {
        const fakeDecoder = createFakeDTSDecoder({
            jellyfin_dts_get_profile: () => 0x01
        });
        const decoder = await DTSSoftwareAudioDecoder.create(fakeDecoder.moduleFactory);

        const output = decoder.decode(
            new Uint8Array([ 1 ]),
            millisecondsToMicroseconds(0)
        );

        expect(output.lossless).toBe(false);
        decoder.close();
    });

    it.each([
        [ DTS_PROFILE_HD_HIGH_RESOLUTION, DTS_WAVE_CHANNEL_MASK_STEREO ],
        [ DTS_PROFILE_HD_MASTER_AUDIO, DTS_WAVE_CHANNEL_MASK_SEVEN_POINT_ONE ]
    ])(
        'rejects an unqualified 192 kHz profile/channel combination',
        async (profile, channelMask) => {
            const fakeDecoder = createFakeDTSDecoder({
                jellyfin_dts_get_channel_mask: () => channelMask,
                jellyfin_dts_get_profile: () => profile,
                jellyfin_dts_get_sample_rate: () => 192_000
            });
            const decoder = await DTSSoftwareAudioDecoder.create(fakeDecoder.moduleFactory);

            expect(() => decoder.decode(
                new Uint8Array([ 1 ]),
                millisecondsToMicroseconds(0)
            )).toThrow('supported Master Audio envelope');
            decoder.close();
        }
    );
});
/* eslint-enable @typescript-eslint/naming-convention */
