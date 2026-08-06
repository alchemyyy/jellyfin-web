// @vitest-environment node

import type { HEVCFrame, HEVCStreamInfo } from '@hevcjs/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
    createHEVCExactCapabilityWorkerQualificationRequests
} from './HEVCExactCapabilityFixtures';
import {
    HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS,
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    type HEVCExactCapabilityFixture,
    type HEVCExactCapabilityWorkerRequest
} from './HEVCExactCapabilityProtocol';
import type { HEVCDecoderBackend } from './HEVCDecoderBackend';
import {
    runHEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerRuntimeDependencies
} from './HEVCExactCapabilityWorkerRuntime';

const MAIN10_4K_QUALIFICATION_BITSTREAM = Uint8Array.from(readFileSync(resolve(
    process.cwd(),
    'scripts/webgpu/hevc-capability-fixtures/main10-4k-complex.hevc'
))).buffer;

function createRequest(): HEVCExactCapabilityWorkerRequest {
    return {
        decoderGlueURL: 'https://example.test/hevc-decode.js',
        decoderWASMURL: 'https://example.test/hevc-decode.wasm',
        requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
        qualifications: createHEVCExactCapabilityWorkerQualificationRequests(
            MAIN10_4K_QUALIFICATION_BITSTREAM
        ),
        type: 'probe'
    };
}

function createFrame(fixture: HEVCExactCapabilityFixture, poc = 0): HEVCFrame {
    const definition = HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS[fixture];
    const chromaWidth = Math.ceil(definition.codedWidth / 2);
    const chromaHeight = Math.ceil(definition.codedHeight / 2);
    return {
        bitDepth: definition.bitDepth,
        cb: new Uint16Array(chromaWidth * chromaHeight),
        chromaHeight,
        chromaWidth,
        cr: new Uint16Array(chromaWidth * chromaHeight),
        height: definition.codedHeight,
        poc,
        width: definition.codedWidth,
        y: new Uint16Array(definition.codedWidth * definition.codedHeight)
    };
}

function createStreamInfo(fixture: HEVCExactCapabilityFixture): HEVCStreamInfo {
    const definition = HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS[fixture];
    return {
        bitDepth: definition.bitDepth,
        chromaFormat: 1,
        height: definition.codedHeight,
        level: definition.levelIDC,
        profile: definition.profileIDC,
        width: definition.codedWidth
    };
}

function createBackend(
    fixture: HEVCExactCapabilityFixture,
    destroy: () => void,
    options: {
        feedError?: Error
        info?: HEVCStreamInfo
    } = {}
): HEVCDecoderBackend {
    let pendingFrame = false;
    let nextPOC = 0;
    return {
        get info(): HEVCStreamInfo {
            return options.info ?? createStreamInfo(fixture);
        },
        destroy,
        drain: (frameHandler): number => {
            if (!pendingFrame) {
                return 0;
            }
            pendingFrame = false;
            frameHandler(createFrame(fixture, nextPOC));
            nextPOC += 1;
            return 1;
        },
        feed: (): void => {
            if (options.feedError) {
                throw options.feedError;
            }
            pendingFrame = true;
        },
        flush: (): number => 0
    };
}

function fingerprintFrame(frame: HEVCFrame): number {
    if (frame.width === 3_840) {
        return HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS['main10-4k']
            .decodedFrameFingerprints[frame.poc];
    }
    const fixture = frame.bitDepth === 10 ? 'main10-1080p' : 'main-1080p';
    return HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS[fixture]
        .decodedFrameFingerprints[frame.poc];
}

describe('runHEVCExactCapabilityWorkerRequest', () => {
    it('verifies exact dimensions, bit depth, 4:2:0 geometry, profile, and level', async () => {
        const mainDestroy = vi.fn();
        const main10FullHDDestroy = vi.fn();
        const main10Destroy = vi.fn();
        let decoderIndex = 0;
        const dependencies: HEVCExactCapabilityWorkerRuntimeDependencies = {
            createDecoder: async (options): Promise<HEVCDecoderBackend> => {
                expect(options.wasmBinaryUrl).toBe('https://example.test/hevc-decode.wasm');
                let backend: HEVCDecoderBackend;
                switch (decoderIndex) {
                    case 0:
                        backend = createBackend('main-1080p', mainDestroy);
                        break;
                    case 1:
                        backend = createBackend('main10-1080p', main10FullHDDestroy);
                        break;
                    default:
                        backend = createBackend('main10-4k', main10Destroy);
                        break;
                }
                decoderIndex += 1;
                return backend;
            },
            fingerprintFrame
        };

        const response = await runHEVCExactCapabilityWorkerRequest(createRequest(), dependencies);

        expect(response.results).toMatchObject([
            {
                bitDepth: 8,
                chromaHeight: 540,
                chromaWidth: 960,
                codedHeight: 1_080,
                codedWidth: 1_920,
                decodedFrameFingerprints:
                    HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS['main-1080p']
                        .decodedFrameFingerprints,
                decodedFrameCount: 8,
                decodedByteLength: 6_220_800,
                levelIDC: 120,
                profileIDC: 1,
                reason: 'decode-output-verified',
                supported: true,
                fixture: 'main-1080p',
                totalDecodedByteLength: 49_766_400
            },
            {
                bitDepth: 10,
                chromaHeight: 540,
                chromaWidth: 960,
                codedHeight: 1_080,
                codedWidth: 1_920,
                decodedFrameFingerprints:
                    HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS['main10-1080p']
                        .decodedFrameFingerprints,
                decodedFrameCount: 8,
                decodedByteLength: 6_220_800,
                levelIDC: 120,
                profileIDC: 2,
                reason: 'decode-output-verified',
                supported: true,
                fixture: 'main10-1080p',
                totalDecodedByteLength: 49_766_400
            },
            {
                bitDepth: 10,
                chromaHeight: 1_080,
                chromaWidth: 1_920,
                codedHeight: 2_160,
                codedWidth: 3_840,
                decodedFrameFingerprints:
                    HEVC_EXACT_CAPABILITY_FIXTURE_DEFINITIONS['main10-4k']
                        .decodedFrameFingerprints,
                decodedFrameCount: 8,
                decodedByteLength: 24_883_200,
                levelIDC: 153,
                profileIDC: 2,
                reason: 'decode-output-verified',
                supported: true,
                fixture: 'main10-4k',
                totalDecodedByteLength: 199_065_600
            }
        ]);
        expect(mainDestroy).toHaveBeenCalledOnce();
        expect(main10FullHDDestroy).toHaveBeenCalledOnce();
        expect(main10Destroy).toHaveBeenCalledOnce();
    });

    it('fails qualifications independently on metadata mismatch and decode failure', async () => {
        const mainDestroy = vi.fn();
        const main10Destroy = vi.fn();
        let decoderIndex = 0;
        const invalidMainInfo = {
            ...createStreamInfo('main-1080p'),
            level: 119
        };
        const dependencies: HEVCExactCapabilityWorkerRuntimeDependencies = {
            createDecoder: async (): Promise<HEVCDecoderBackend> => {
                let backend: HEVCDecoderBackend;
                switch (decoderIndex) {
                    case 0:
                        backend = createBackend(
                            'main-1080p',
                            mainDestroy,
                            { info: invalidMainInfo }
                        );
                        break;
                    case 1:
                        backend = createBackend('main10-1080p', () => undefined, {
                            feedError: new Error('decode failed')
                        });
                        break;
                    default:
                        backend = createBackend('main10-4k', main10Destroy);
                        break;
                }
                decoderIndex += 1;
                return backend;
            },
            fingerprintFrame
        };

        const response = await runHEVCExactCapabilityWorkerRequest(createRequest(), dependencies);

        expect(response.results[0]).toMatchObject({
            reason: 'output-mismatch',
            supported: false,
            fixture: 'main-1080p'
        });
        expect(response.results[1]).toMatchObject({
            reason: 'decode-error',
            supported: false,
            fixture: 'main10-1080p'
        });
        expect(response.results[2]).toMatchObject({
            reason: 'decode-output-verified',
            supported: true,
            fixture: 'main10-4k'
        });
        expect(mainDestroy).toHaveBeenCalledOnce();
        expect(main10Destroy).toHaveBeenCalledOnce();
    });

    it('rejects malformed requests before creating decoder memory', async () => {
        const createDecoder = vi.fn();
        const request = createRequest();
        const malformedRequest = {
            ...request,
            qualifications: [
                { ...request.qualifications[0], codedWidth: 1_280 },
                request.qualifications[1]
            ]
        } as unknown as HEVCExactCapabilityWorkerRequest;

        await expect(runHEVCExactCapabilityWorkerRequest(malformedRequest, {
            createDecoder,
            fingerprintFrame
        })).rejects.toThrow('request is invalid');
        expect(createDecoder).not.toHaveBeenCalled();
    });
});
