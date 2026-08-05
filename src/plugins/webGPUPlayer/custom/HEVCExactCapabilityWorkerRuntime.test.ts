// @vitest-environment node

import type { HEVCFrame, HEVCStreamInfo } from '@hevcjs/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { createHEVCExactCapabilityWorkerTierRequests } from './HEVCExactCapabilityFixtures';
import {
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS,
    type HEVCExactCapabilityTier,
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
        tiers: createHEVCExactCapabilityWorkerTierRequests(
            MAIN10_4K_QUALIFICATION_BITSTREAM
        ),
        type: 'probe'
    };
}

function createFrame(tier: HEVCExactCapabilityTier, poc = 0): HEVCFrame {
    const definition = HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS[tier];
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

function createStreamInfo(tier: HEVCExactCapabilityTier): HEVCStreamInfo {
    const definition = HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS[tier];
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
    tier: HEVCExactCapabilityTier,
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
            return options.info ?? createStreamInfo(tier);
        },
        destroy,
        drain: (frameHandler): number => {
            if (!pendingFrame) {
                return 0;
            }
            pendingFrame = false;
            frameHandler(createFrame(tier, nextPOC));
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
        return HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS['main10-4k']
            .decodedFrameFingerprints[frame.poc];
    }
    const tier = frame.bitDepth === 10 ? 'main10-1080p' : 'main-1080p';
    return HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS[tier]
        .decodedFrameFingerprints[frame.poc];
}

function createNow(values: readonly number[]): () => number {
    let valueIndex = 0;
    return (): number => {
        const value = values[valueIndex];
        valueIndex += 1;
        return value;
    };
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
            fingerprintFrame,
            now: createNow([ 0, 10, 80, 100, 110, 180, 200, 210, 280 ])
        };

        const response = await runHEVCExactCapabilityWorkerRequest(createRequest(), dependencies);

        expect(response.results).toMatchObject([
            {
                bitDepth: 8,
                chromaHeight: 540,
                chromaWidth: 960,
                codedHeight: 1_080,
                codedWidth: 1_920,
                decodeMilliseconds: 80,
                decodedFrameFingerprints:
                    HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS['main-1080p']
                        .decodedFrameFingerprints,
                decodedFrameCount: 8,
                decodedByteLength: 6_220_800,
                framesPerSecond: 100,
                levelIDC: 120,
                measuredFrameCount: 7,
                minimumFramesPerSecond: 30,
                profileIDC: 1,
                reason: 'decode-output-verified',
                steadyStateDecodeMilliseconds: 70,
                supported: true,
                tier: 'main-1080p',
                totalDecodedByteLength: 49_766_400
            },
            {
                bitDepth: 10,
                chromaHeight: 540,
                chromaWidth: 960,
                codedHeight: 1_080,
                codedWidth: 1_920,
                decodeMilliseconds: 80,
                decodedFrameFingerprints:
                    HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS['main10-1080p']
                        .decodedFrameFingerprints,
                decodedFrameCount: 8,
                decodedByteLength: 6_220_800,
                framesPerSecond: 100,
                levelIDC: 120,
                measuredFrameCount: 7,
                minimumFramesPerSecond: 30,
                profileIDC: 2,
                reason: 'decode-output-verified',
                steadyStateDecodeMilliseconds: 70,
                supported: true,
                tier: 'main10-1080p',
                totalDecodedByteLength: 49_766_400
            },
            {
                bitDepth: 10,
                chromaHeight: 1_080,
                chromaWidth: 1_920,
                codedHeight: 2_160,
                codedWidth: 3_840,
                decodeMilliseconds: 80,
                decodedFrameFingerprints:
                    HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS['main10-4k']
                        .decodedFrameFingerprints,
                decodedFrameCount: 8,
                decodedByteLength: 24_883_200,
                framesPerSecond: 100,
                levelIDC: 153,
                measuredFrameCount: 7,
                minimumFramesPerSecond: 30,
                profileIDC: 2,
                reason: 'decode-output-verified',
                steadyStateDecodeMilliseconds: 70,
                supported: true,
                tier: 'main10-4k',
                totalDecodedByteLength: 199_065_600
            }
        ]);
        expect(mainDestroy).toHaveBeenCalledOnce();
        expect(main10FullHDDestroy).toHaveBeenCalledOnce();
        expect(main10Destroy).toHaveBeenCalledOnce();
    });

    it('fails tiers independently on metadata mismatch and decode failure', async () => {
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
            fingerprintFrame,
            now: createNow([ 0, 10, 20, 30, 40, 50, 60 ])
        };

        const response = await runHEVCExactCapabilityWorkerRequest(createRequest(), dependencies);

        expect(response.results[0]).toMatchObject({
            reason: 'output-mismatch',
            supported: false,
            tier: 'main-1080p'
        });
        expect(response.results[1]).toMatchObject({
            reason: 'decode-error',
            supported: false,
            tier: 'main10-1080p'
        });
        expect(response.results[2]).toMatchObject({
            reason: 'decode-output-verified',
            supported: true,
            tier: 'main10-4k'
        });
        expect(mainDestroy).toHaveBeenCalledOnce();
        expect(main10Destroy).toHaveBeenCalledOnce();
    });

    it('fails closed when exact decode exceeds a tier time budget', async () => {
        let decoderIndex = 0;
        const dependencies: HEVCExactCapabilityWorkerRuntimeDependencies = {
            createDecoder: async (): Promise<HEVCDecoderBackend> => {
                const tier = [
                    'main-1080p',
                    'main10-1080p',
                    'main10-4k'
                ][decoderIndex] as HEVCExactCapabilityTier;
                decoderIndex += 1;
                return createBackend(tier, () => undefined);
            },
            fingerprintFrame,
            now: createNow([
                0, 10, 4_001,
                5_000, 5_010, 11_001,
                12_000, 12_010, 18_001
            ])
        };

        const response = await runHEVCExactCapabilityWorkerRequest(createRequest(), dependencies);
        expect(response.results[0]).toMatchObject({
            decodeMilliseconds: 4_001,
            reason: 'time-budget-exceeded',
            supported: false
        });
        expect(response.results[1]).toMatchObject({
            decodeMilliseconds: 6_001,
            reason: 'time-budget-exceeded',
            supported: false
        });
        expect(response.results[2]).toMatchObject({
            decodeMilliseconds: 6_001,
            reason: 'time-budget-exceeded',
            supported: false
        });
    });

    it('requires 24 fps plus conservative throughput headroom', async () => {
        let decoderIndex = 0;
        const dependencies: HEVCExactCapabilityWorkerRuntimeDependencies = {
            createDecoder: async (): Promise<HEVCDecoderBackend> => {
                const tier = [
                    'main-1080p',
                    'main10-1080p',
                    'main10-4k'
                ][decoderIndex] as HEVCExactCapabilityTier;
                decoderIndex += 1;
                return createBackend(tier, () => undefined);
            },
            fingerprintFrame,
            now: createNow([ 0, 10, 310, 400, 410, 480, 500, 510, 580 ])
        };

        const response = await runHEVCExactCapabilityWorkerRequest(createRequest(), dependencies);
        expect(response.results[0]).toMatchObject({
            decodedFrameCount: 8,
            framesPerSecond: 70 / 3,
            measuredFrameCount: 7,
            minimumFramesPerSecond: 30,
            reason: 'throughput-insufficient',
            steadyStateDecodeMilliseconds: 300,
            supported: false
        });
        expect(response.results[1]).toMatchObject({
            framesPerSecond: 100,
            reason: 'decode-output-verified',
            supported: true
        });
        expect(response.results[2]).toMatchObject({
            framesPerSecond: 100,
            reason: 'decode-output-verified',
            supported: true
        });
    });

    it('retries a borderline cold 4K throughput result', async () => {
        let decoderIndex = 0;
        const dependencies: HEVCExactCapabilityWorkerRuntimeDependencies = {
            createDecoder: async (): Promise<HEVCDecoderBackend> => {
                let tier: HEVCExactCapabilityTier;
                switch (decoderIndex) {
                    case 0:
                        tier = 'main-1080p';
                        break;
                    case 1:
                        tier = 'main10-1080p';
                        break;
                    default:
                        tier = 'main10-4k';
                        break;
                }
                decoderIndex += 1;
                return createBackend(tier, () => undefined);
            },
            fingerprintFrame,
            now: createNow([
                0, 10, 80,
                100, 110, 180,
                200, 210, 460,
                500, 510, 710
            ])
        };

        const response = await runHEVCExactCapabilityWorkerRequest(
            createRequest(),
            dependencies
        );

        expect(decoderIndex).toBe(4);
        expect(response.results[2]).toMatchObject({
            decodeMilliseconds: 210,
            framesPerSecond: 35,
            reason: 'decode-output-verified',
            steadyStateDecodeMilliseconds: 200,
            supported: true,
            tier: 'main10-4k'
        });
    });

    it('bounds 4K warm retries and retains the fastest insufficient result', async () => {
        let decoderIndex = 0;
        const dependencies: HEVCExactCapabilityWorkerRuntimeDependencies = {
            createDecoder: async (): Promise<HEVCDecoderBackend> => {
                let tier: HEVCExactCapabilityTier;
                switch (decoderIndex) {
                    case 0:
                        tier = 'main-1080p';
                        break;
                    case 1:
                        tier = 'main10-1080p';
                        break;
                    default:
                        tier = 'main10-4k';
                        break;
                }
                decoderIndex += 1;
                return createBackend(tier, () => undefined);
            },
            fingerprintFrame,
            now: createNow([
                0, 10, 80,
                100, 110, 180,
                200, 210, 460,
                500, 510, 750,
                800, 810, 1_055
            ])
        };

        const response = await runHEVCExactCapabilityWorkerRequest(
            createRequest(),
            dependencies
        );

        expect(decoderIndex).toBe(5);
        expect(response.results[2]).toMatchObject({
            decodeMilliseconds: 250,
            framesPerSecond: 175 / 6,
            reason: 'throughput-insufficient',
            steadyStateDecodeMilliseconds: 240,
            supported: false,
            tier: 'main10-4k'
        });
    });

    it('rejects malformed requests before creating decoder memory', async () => {
        const createDecoder = vi.fn();
        const request = createRequest();
        const malformedRequest = {
            ...request,
            tiers: [
                { ...request.tiers[0], codedWidth: 1_280 },
                request.tiers[1]
            ]
        } as unknown as HEVCExactCapabilityWorkerRequest;

        await expect(runHEVCExactCapabilityWorkerRequest(malformedRequest, {
            createDecoder,
            fingerprintFrame,
            now: (): number => 0
        })).rejects.toThrow('request is invalid');
        expect(createDecoder).not.toHaveBeenCalled();
    });
});
