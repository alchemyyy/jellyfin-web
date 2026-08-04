// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInThisContext } from 'node:vm';

import { EncodedPacket, type VideoCodec, type VideoSample } from 'mediabunny';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createHEVCDecoderBackend,
    type HEVCDecoderBackend
} from './HEVCDecoderBackend';
import HEVCSoftwareVideoDecoder, {
    type HEVCSoftwareVideoDecoderDependencies
} from './HEVCSoftwareVideoDecoder';

const HEVC_GLUE_PATH = resolve(
    process.cwd(),
    'node_modules/@hevcjs/core/dist/wasm/hevc-decode.js'
);
const HEVC_WASM_PATH = resolve(
    process.cwd(),
    'node_modules/@hevcjs/core/dist/wasm/hevc-decode.wasm'
);
const EXPECTED_PLANAR_FRAME_SHA256 = 'fa0c4d9ba5b220ecfc31556f485c6b6a82c2f9ba961efd9b294c141d9a93c217';

// One x265 Main10 640x360 IDR access unit with VPS, SPS, and PPS NAL units
const MAIN10_ANNEX_B_KEY_FRAME = Buffer.from(
    'AAAAAUABDAH//wIgAAADAJAAAAMAAAMA/5WYCQAAAAFCAQECIAAAAwCQAAADAAADAP+gBQIBaTZZWaSTK8BahIgEggAAAwACAAADAAIQAAAAAUQBwXGrEgAAAAEoAa8Fsx6qI8cNQBAMf4Gb///war4LzYFpPyp8FnwWfBZ8FnxHvEe8R7xHvEe8R7xHvEf0y1HI1qA11VWyKo0KPjI013cAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAACWgLcAAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAJ6AAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAABJQAAADAAADAAADAAADAAADAAADAAADAAADAAADAgYAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAAMAAWsA1me8AgAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAAAwAABBw=',
    'base64'
);

type EmscriptenModuleFactory = (options: {
    locateFile?: (path: string, scriptDirectory: string) => string
}) => Promise<unknown>;

type GlueLoader = (
    requireFunction: ReturnType<typeof createRequire>,
    filename: string,
    directory: string
) => EmscriptenModuleFactory;

type MutableDecoderContract = {
    codec: VideoCodec
    config: VideoDecoderConfig
    onError: (error: unknown) => undefined
    onSample: (sample: VideoSample) => unknown
};

function loadActualModuleFactory(): EmscriptenModuleFactory {
    const glueSource = readFileSync(HEVC_GLUE_PATH, 'utf8');
    const wrappedSource = [
        '(function(require, __filename, __dirname) {',
        glueSource,
        'return HEVCDecoderModule;',
        '})'
    ].join('\n');
    // eslint-disable-next-line sonarjs/code-eval -- Executes pinned local package glue in this Node-only test
    const loadGlue = runInThisContext(wrappedSource, {
        filename: HEVC_GLUE_PATH
    }) as GlueLoader;
    return loadGlue(createRequire(import.meta.url), HEVC_GLUE_PATH, dirname(HEVC_GLUE_PATH));
}

function configureDecoder(
    decoder: HEVCSoftwareVideoDecoder,
    onSample: (sample: VideoSample) => unknown
): void {
    const mutableDecoder = decoder as unknown as MutableDecoderContract;
    mutableDecoder.codec = 'hevc';
    mutableDecoder.config = {
        codec: 'hev1.2.4.L120.B0',
        codedHeight: 360,
        codedWidth: 640,
        colorSpace: {
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'pq'
        } as unknown as VideoColorSpaceInit,
        hardwareAcceleration: 'prefer-software'
    };
    mutableDecoder.onError = (): undefined => undefined;
    mutableDecoder.onSample = onSample;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('HEVC software decoder integration', () => {
    it('decodes a real Main10 access unit through the copied JS/WASM ABI', async () => {
        vi.stubGlobal('HEVCDecoderModule', loadActualModuleFactory());
        const dependencies: HEVCSoftwareVideoDecoderDependencies = {
            createDecoder: async (options): Promise<HEVCDecoderBackend> => (
                createHEVCDecoderBackend(options)
            ),
            loadDecoderGlue: (): void => undefined,
            resolveAssetURL: (path: string): string => (
                path.endsWith('.wasm') ? HEVC_WASM_PATH : HEVC_GLUE_PATH
            )
        };
        const samples: VideoSample[] = [];
        const decoder = new HEVCSoftwareVideoDecoder(dependencies);
        configureDecoder(decoder, (sample: VideoSample): void => {
            samples.push(sample);
        });

        try {
            await decoder.init();
            decoder.decode(new EncodedPacket(
                new Uint8Array(MAIN10_ANNEX_B_KEY_FRAME),
                'key',
                0,
                1,
                0
            ));
            decoder.flush();

            expect(samples).toHaveLength(1);
            const sample = samples[0];
            expect(sample).toMatchObject({
                codedHeight: 360,
                codedWidth: 640,
                duration: 1,
                format: 'I420P10',
                timestamp: 0
            });
            const planarFrame = new Uint8Array(sample.allocationSize());
            await sample.copyTo(planarFrame);
            expect(createHash('sha256').update(planarFrame).digest('hex')).toBe(
                EXPECTED_PLANAR_FRAME_SHA256
            );
        } finally {
            for (const sample of samples) {
                sample.close();
            }
            decoder.close();
        }
    });
});
