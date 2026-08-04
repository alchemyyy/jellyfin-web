// @vitest-environment node

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { runInThisContext } from 'node:vm';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHEVCExactCapabilityWorkerTierRequests } from './HEVCExactCapabilityFixtures';
import {
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    type HEVCExactCapabilityWorkerRequest
} from './HEVCExactCapabilityProtocol';
import { runHEVCExactCapabilityWorkerRequest } from './HEVCExactCapabilityWorkerRuntime';

const HEVC_GLUE_PATH = resolve(
    process.cwd(),
    'node_modules/@hevcjs/core/dist/wasm/hevc-decode.js'
);
const HEVC_WASM_PATH = resolve(
    process.cwd(),
    'node_modules/@hevcjs/core/dist/wasm/hevc-decode.wasm'
);
const MAIN10_4K_QUALIFICATION_PATH = resolve(
    process.cwd(),
    'scripts/webgpu/hevc-capability-fixtures/main10-4k-complex.hevc'
);

type EmscriptenModuleFactory = (options: {
    locateFile?: (path: string, scriptDirectory: string) => string
}) => Promise<unknown>;

type GlueLoader = (
    requireFunction: ReturnType<typeof createRequire>,
    filename: string,
    directory: string
) => EmscriptenModuleFactory;

function loadActualModuleFactory(): EmscriptenModuleFactory {
    const glueSource = readFileSync(HEVC_GLUE_PATH, 'utf8');
    const wrappedSource = [
        '(function(require, __filename, __dirname) {',
        glueSource,
        'return HEVCDecoderModule;',
        '})'
    ].join('\n');
    // eslint-disable-next-line sonarjs/code-eval -- Executes pinned local package glue in Node
    const loadGlue = runInThisContext(wrappedSource, {
        filename: HEVC_GLUE_PATH
    }) as GlueLoader;
    return loadGlue(createRequire(import.meta.url), HEVC_GLUE_PATH, dirname(HEVC_GLUE_PATH));
}

function getExpectedQualificationReason(
    decodeMilliseconds: number,
    framesPerSecond: number,
    maximumDecodeMilliseconds: number
): 'decode-output-verified' | 'throughput-insufficient' | 'time-budget-exceeded' {
    if (decodeMilliseconds > maximumDecodeMilliseconds) {
        return 'time-budget-exceeded';
    }
    if (framesPerSecond < 30) {
        return 'throughput-insufficient';
    }
    return 'decode-output-verified';
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('exact HEVC capability probe integration', () => {
    it('decodes all exact moving Main and Main10 fixtures through pinned JS/WASM', async () => {
        vi.stubGlobal('HEVCDecoderModule', loadActualModuleFactory());
        const request: HEVCExactCapabilityWorkerRequest = {
            decoderGlueURL: HEVC_GLUE_PATH,
            decoderWASMURL: HEVC_WASM_PATH,
            requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
            tiers: createHEVCExactCapabilityWorkerTierRequests(
                Uint8Array.from(readFileSync(MAIN10_4K_QUALIFICATION_PATH)).buffer
            ),
            type: 'probe'
        };

        const response = await runHEVCExactCapabilityWorkerRequest(request);

        expect(response.results).toHaveLength(3);
        expect(response.results[0]).toMatchObject({
            bitDepth: 8,
            chromaHeight: 540,
            chromaWidth: 960,
            codedHeight: 1_080,
            codedWidth: 1_920,
            decodedFrameFingerprints: [
                1_409_144_559,
                2_325_269_144,
                1_479_088_652,
                3_424_562_773,
                1_522_044_181,
                3_126_439_635,
                2_013_041_680,
                1_744_647_904
            ],
            decodedFrameCount: 8,
            decodedByteLength: 6_220_800,
            levelIDC: 120,
            measuredFrameCount: 7,
            minimumFramesPerSecond: 30,
            profileIDC: 1,
            tier: 'main-1080p',
            totalDecodedByteLength: 49_766_400
        });
        expect(response.results[1]).toMatchObject({
            bitDepth: 10,
            chromaHeight: 540,
            chromaWidth: 960,
            codedHeight: 1_080,
            codedWidth: 1_920,
            decodedFrameFingerprints: [
                918_370,
                3_550_082_707,
                3_383_640_766,
                728_543_190,
                3_369_665_670,
                2_797_437_209,
                3_596_637_169,
                36_311_845
            ],
            decodedFrameCount: 8,
            decodedByteLength: 6_220_800,
            levelIDC: 120,
            measuredFrameCount: 7,
            minimumFramesPerSecond: 30,
            profileIDC: 2,
            tier: 'main10-1080p',
            totalDecodedByteLength: 49_766_400
        });
        expect(response.results[2]).toMatchObject({
            bitDepth: 10,
            chromaHeight: 1_080,
            chromaWidth: 1_920,
            codedHeight: 2_160,
            codedWidth: 3_840,
            decodedFrameFingerprints: [
                2_669_261_473,
                2_891_374_311,
                3_294_996_003,
                3_899_934_279,
                3_645_638_150,
                3_163_731_443,
                1_028_093_413,
                2_922_080_851
            ],
            decodedFrameCount: 8,
            decodedByteLength: 24_883_200,
            levelIDC: 153,
            measuredFrameCount: 7,
            minimumFramesPerSecond: 30,
            profileIDC: 2,
            tier: 'main10-4k',
            totalDecodedByteLength: 199_065_600
        });
        const qualificationResults = [
            { maximumDecodeMilliseconds: 1_750, result: response.results[0] },
            { maximumDecodeMilliseconds: 1_750, result: response.results[1] },
            { maximumDecodeMilliseconds: 2_750, result: response.results[2] }
        ] as const;
        for (const qualification of qualificationResults) {
            const decodeMilliseconds = qualification.result.decodeMilliseconds;
            const framesPerSecond = qualification.result.framesPerSecond;
            expect(decodeMilliseconds).not.toBeNull();
            expect(framesPerSecond).not.toBeNull();
            const expectedReason = getExpectedQualificationReason(
                decodeMilliseconds as number,
                framesPerSecond as number,
                qualification.maximumDecodeMilliseconds
            );
            expect(qualification.result.reason).toBe(expectedReason);
            expect(qualification.result.supported).toBe(
                expectedReason === 'decode-output-verified'
            );
        }
    }, 15_000);
});
