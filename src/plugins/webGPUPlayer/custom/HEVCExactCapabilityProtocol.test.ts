// @vitest-environment node

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    createHEVCExactCapabilityWorkerTierRequests,
    HEVC_EXACT_CAPABILITY_ACCESS_UNIT_SHA256,
    HEVC_EXACT_CAPABILITY_QUALIFICATION_BITSTREAM_SHA256
} from './HEVCExactCapabilityFixtures';
import {
    HEVC_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS,
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS,
    isHEVCExactCapabilityWorkerRequest,
    isHEVCExactCapabilityWorkerResponse,
    type HEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerResponse
} from './HEVCExactCapabilityProtocol';

const MAIN10_4K_QUALIFICATION_PATH = resolve(
    process.cwd(),
    'scripts/webgpu/hevc-capability-fixtures/main10-4k-complex.hevc'
);

function loadMain10UltraHDQualificationBitstream(): ArrayBuffer {
    return Uint8Array.from(readFileSync(MAIN10_4K_QUALIFICATION_PATH)).buffer;
}

function createRequest(): HEVCExactCapabilityWorkerRequest {
    return {
        decoderGlueURL: 'https://example.test/hevc-decode.js',
        decoderWASMURL: 'https://example.test/hevc-decode.wasm',
        requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
        tiers: createHEVCExactCapabilityWorkerTierRequests(
            loadMain10UltraHDQualificationBitstream()
        ),
        type: 'probe'
    };
}

describe('exact HEVC capability fixtures and protocol', () => {
    it('allows every sequential tier budget plus worker startup overhead', () => {
        const totalTierBudgetMilliseconds = Object.values(
            HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS
        ).reduce((totalMilliseconds, definition) => (
            totalMilliseconds + definition.maximumDecodeMilliseconds
        ), 0);

        expect(HEVC_EXACT_CAPABILITY_PROBE_TIMEOUT_MILLISECONDS).toBeGreaterThanOrEqual(
            totalTierBudgetMilliseconds + 500
        );
    });

    it('recreates all pinned Main and Main10 access units with exact hashes', () => {
        const firstRequests = createHEVCExactCapabilityWorkerTierRequests(
            loadMain10UltraHDQualificationBitstream()
        );
        const secondRequests = createHEVCExactCapabilityWorkerTierRequests(
            loadMain10UltraHDQualificationBitstream()
        );

        expect(firstRequests).toHaveLength(3);
        for (let requestIndex = 0; requestIndex < firstRequests.length; requestIndex += 1) {
            const request = firstRequests[requestIndex];
            const definition = HEVC_EXACT_CAPABILITY_TIER_DEFINITIONS[request.tier];
            expect(request).toMatchObject({
                bitDepth: definition.bitDepth,
                codedHeight: definition.codedHeight,
                codedWidth: definition.codedWidth,
                levelIDC: definition.levelIDC,
                profileIDC: definition.profileIDC
            });
            expect(createHash('sha256').update(new Uint8Array(request.accessUnit)).digest('hex')).toBe(
                HEVC_EXACT_CAPABILITY_ACCESS_UNIT_SHA256[request.tier]
            );
            const qualificationHash = createHash('sha256');
            for (const accessUnit of request.qualificationAccessUnits) {
                qualificationHash.update(new Uint8Array(accessUnit));
            }
            expect(qualificationHash.digest('hex')).toBe(
                HEVC_EXACT_CAPABILITY_QUALIFICATION_BITSTREAM_SHA256[request.tier]
            );
            expect(request.qualificationAccessUnits).toHaveLength(
                definition.qualificationFrameCount
            );
            expect(request.accessUnit).not.toBe(secondRequests[requestIndex].accessUnit);
            expect(request.qualificationAccessUnits[0]).not.toBe(
                secondRequests[requestIndex].qualificationAccessUnits[0]
            );
        }
    });

    it('accepts only the complete exact bounded worker request', () => {
        const request = createRequest();
        expect(isHEVCExactCapabilityWorkerRequest(request)).toBe(true);
        expect(isHEVCExactCapabilityWorkerRequest({
            ...request,
            tiers: [ request.tiers[0], request.tiers[0], request.tiers[2] ]
        })).toBe(false);
        expect(isHEVCExactCapabilityWorkerRequest({
            ...request,
            tiers: [
                { ...request.tiers[0], codedWidth: 1_280 },
                request.tiers[1],
                request.tiers[2]
            ]
        })).toBe(false);
        expect(isHEVCExactCapabilityWorkerRequest({
            ...request,
            tiers: [
                {
                    ...request.tiers[0],
                    qualificationAccessUnits: [
                        new ArrayBuffer(1),
                        ...request.tiers[0].qualificationAccessUnits.slice(1)
                    ]
                },
                request.tiers[1],
                request.tiers[2]
            ]
        })).toBe(false);
        expect(isHEVCExactCapabilityWorkerRequest({
            ...request,
            tiers: [
                { ...request.tiers[0], accessUnit: new ArrayBuffer(0) },
                request.tiers[1],
                request.tiers[2]
            ]
        })).toBe(false);
    });

    it('rejects inconsistent or incomplete worker summaries', () => {
        const validResponse: HEVCExactCapabilityWorkerResponse = {
            requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
            results: [
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
                    bitDepth: null,
                    chromaHeight: null,
                    chromaWidth: null,
                    codedHeight: null,
                    codedWidth: null,
                    decodeMilliseconds: null,
                    decodedFrameFingerprints: null,
                    decodedFrameCount: null,
                    decodedByteLength: null,
                    framesPerSecond: null,
                    levelIDC: null,
                    measuredFrameCount: null,
                    minimumFramesPerSecond: null,
                    profileIDC: null,
                    reason: 'decode-error',
                    steadyStateDecodeMilliseconds: null,
                    supported: false,
                    tier: 'main10-1080p',
                    totalDecodedByteLength: null
                },
                {
                    bitDepth: null,
                    chromaHeight: null,
                    chromaWidth: null,
                    codedHeight: null,
                    codedWidth: null,
                    decodeMilliseconds: null,
                    decodedFrameFingerprints: null,
                    decodedFrameCount: null,
                    decodedByteLength: null,
                    framesPerSecond: null,
                    levelIDC: null,
                    measuredFrameCount: null,
                    minimumFramesPerSecond: null,
                    profileIDC: null,
                    reason: 'decode-error',
                    steadyStateDecodeMilliseconds: null,
                    supported: false,
                    tier: 'main10-4k',
                    totalDecodedByteLength: null
                }
            ],
            type: 'result'
        };
        expect(isHEVCExactCapabilityWorkerResponse(validResponse)).toBe(true);
        expect(isHEVCExactCapabilityWorkerResponse({
            ...validResponse,
            results: [
                validResponse.results[0],
                validResponse.results[0],
                validResponse.results[2]
            ]
        })).toBe(false);
        expect(isHEVCExactCapabilityWorkerResponse({
            ...validResponse,
            results: [
                { ...validResponse.results[0], supported: false },
                validResponse.results[1],
                validResponse.results[2]
            ]
        })).toBe(false);
        expect(isHEVCExactCapabilityWorkerResponse({
            ...validResponse,
            results: [
                { ...validResponse.results[0], decodedByteLength: null },
                validResponse.results[1],
                validResponse.results[2]
            ]
        })).toBe(false);
    });
});
