// @vitest-environment node

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacketSink,
    Input,
    type VideoSample
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import LegacySoftwareVideoDecoder, {
    type LegacySoftwareVideoDecoderDependencies,
    type LegacyVideoDecoderModule
} from './LegacySoftwareVideoDecoder';
import {
    LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT,
    LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH,
    LEGACY_VIDEO_QUALIFICATION_FINGERPRINT,
    LEGACY_VIDEO_QUALIFICATION_FRAME_COUNT,
    LEGACY_VIDEO_QUALIFICATION_TOTAL_BYTE_LENGTH
} from './LegacyVideoExactCapabilityProtocol';

const DECODER_DIRECTORY = resolve(
    process.cwd(),
    'scripts/webgpu/legacy-video-decoder/artifacts'
);
const DECODER_GLUE_PATH = resolve(DECODER_DIRECTORY, 'legacy-video-decode.js');
const DECODER_MANIFEST_PATH = resolve(DECODER_DIRECTORY, 'manifest.json');
const DECODER_WASM_PATH = resolve(DECODER_DIRECTORY, 'legacy-video-decode.wasm');
const FIXTURE_PATH = resolve(
    process.cwd(),
    'scripts/webgpu/legacy-video-capability-fixtures/mpeg2-progressive-1920x1080.mkv'
);
const FNV_OFFSET_BASIS = 2_166_136_261;
const FNV_PRIME = 16_777_619;

type ActualLegacyVideoDecoderModuleFactory = (options: {
    wasmBinary: Uint8Array
}) => Promise<LegacyVideoDecoderModule>;

async function fingerprintSamples(samples: readonly VideoSample[]): Promise<{
    byteLength: number
    fingerprint: number
}> {
    let byteLength = 0;
    let fingerprint = FNV_OFFSET_BASIS;
    for (const sample of samples) {
        const output = new Uint8Array(sample.allocationSize());
        await sample.copyTo(output);
        byteLength += output.byteLength;
        for (const byte of output) {
            fingerprint ^= byte;
            fingerprint = Math.imul(fingerprint, FNV_PRIME) >>> 0;
        }
    }
    return { byteLength, fingerprint };
}

describe('legacy video decoder integration', () => {
    it('demuxes and exactly decodes reordered progressive MPEG-2 through WASM', async () => {
        const manifest: unknown = JSON.parse(
            readFileSync(DECODER_MANIFEST_PATH, 'utf8')
        );
        expect(manifest).toMatchObject({
            configuredComponents: expect.arrayContaining([
                '--disable-everything',
                '--enable-decoder=mpeg2video'
            ]),
            decoders: [ 'mpeg2video' ]
        });
        const requireFunction = createRequire(import.meta.url);
        const createModule = requireFunction(
            DECODER_GLUE_PATH
        ) as ActualLegacyVideoDecoderModuleFactory;
        const wasmBinary = new Uint8Array(readFileSync(DECODER_WASM_PATH));
        const dependencies: LegacySoftwareVideoDecoderDependencies = {
            createModule: async (): Promise<LegacyVideoDecoderModule> => (
                createModule({ wasmBinary })
            ),
            loadDecoderGlue: (): void => undefined,
            resolveAssetURL: (path: string): string => path
        };
        const input = new Input({
            formats: ALL_FORMATS,
            source: new BufferSource(new Uint8Array(readFileSync(FIXTURE_PATH)))
        });
        const samples: VideoSample[] = [];
        const decoder = new LegacySoftwareVideoDecoder({
            codec: 'mpeg2video',
            codedHeight: LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT,
            codedWidth: LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH,
            displayHeight: LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT,
            displayWidth: LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH
        }, {
            onError: (error: unknown): never => {
                throw error;
            },
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
            }
        }, dependencies);

        try {
            const tracks = await input.getVideoTracks();
            expect(tracks).toHaveLength(1);
            expect(await tracks[0].getCodec()).toBeNull();
            expect(await tracks[0].getInternalCodecId()).toBe('V_MPEG2');
            await decoder.init();
            const packetSink = new EncodedPacketSink(tracks[0]);
            const firstKeyPacket = await packetSink.getFirstKeyPacket({
                verifyKeyPackets: true
            });
            const seekKeyPacket = await packetSink.getKeyPacket(0.25, {
                verifyKeyPackets: true
            });
            expect(firstKeyPacket?.type).toBe('key');
            expect(seekKeyPacket?.type).toBe('key');
            expect(seekKeyPacket?.timestamp).toBeLessThanOrEqual(0.25);
            for await (const packet of packetSink.packets()) {
                decoder.decode(packet);
            }
            decoder.flush();

            expect(samples).toHaveLength(LEGACY_VIDEO_QUALIFICATION_FRAME_COUNT);
            expect(samples.every((sample: VideoSample): boolean => (
                sample.format === 'I420'
                    && sample.codedWidth === LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH
                    && sample.codedHeight === LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT
            ))).toBe(true);
            const output = await fingerprintSamples(samples);
            expect(output.byteLength).toBe(LEGACY_VIDEO_QUALIFICATION_TOTAL_BYTE_LENGTH);
            expect(output.fingerprint).toBe(LEGACY_VIDEO_QUALIFICATION_FINGERPRINT);
        } finally {
            for (const sample of samples) {
                sample.close();
            }
            decoder.close();
            input.dispose();
        }
    });
});
