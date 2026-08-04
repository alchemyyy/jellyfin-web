// @vitest-environment node

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    createRawHDRCapabilityFixture,
    RAW_HDR_CAPABILITY_FIXTURE_CODED_HEIGHT,
    RAW_HDR_CAPABILITY_FIXTURE_CODED_WIDTH,
    RAW_HDR_CAPABILITY_FIXTURE_VERSION
} from './RawHDRCapabilityFixtures';

const AV1_EXPECTED_BYTE_LENGTH = 806;
const AV1_EXPECTED_SHA256 = 'e4dcf97cc55f903d786c9a6a4ac4c5e2e1e802a84dfa24c74dedc533dbead3bd';
const EXPECTED_DECODED_FRAME_FINGERPRINT = 4_080_076_472;
const VP9_EXPECTED_BYTE_LENGTH = 2_957;
const VP9_EXPECTED_SHA256 = 'ed98a1b3ef22251309aeeed15c88c92ad8e63c4840d38a9ff50cf482e3a7d3a9';

function getSHA256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

describe('raw HDR capability fixtures', () => {
    it('pins exact 4K AV1 Main10 encoded bytes', () => {
        const fixture = createRawHDRCapabilityFixture('av1');

        expect(RAW_HDR_CAPABILITY_FIXTURE_VERSION).toBe(1);
        expect(fixture).toMatchObject({
            codec: 'av1',
            codecString: 'av01.0.08M.10',
            codedHeight: RAW_HDR_CAPABILITY_FIXTURE_CODED_HEIGHT,
            codedWidth: RAW_HDR_CAPABILITY_FIXTURE_CODED_WIDTH,
            decodedFrameFingerprint: EXPECTED_DECODED_FRAME_FINGERPRINT
        });
        expect(fixture.encodedKeyFrame).toHaveLength(AV1_EXPECTED_BYTE_LENGTH);
        expect(getSHA256(fixture.encodedKeyFrame)).toBe(AV1_EXPECTED_SHA256);
    });

    it('pins exact 4K VP9 Profile 2 encoded bytes', () => {
        const fixture = createRawHDRCapabilityFixture('vp9');

        expect(fixture).toMatchObject({
            codec: 'vp9',
            codecString: 'vp09.02.10.10',
            codedHeight: RAW_HDR_CAPABILITY_FIXTURE_CODED_HEIGHT,
            codedWidth: RAW_HDR_CAPABILITY_FIXTURE_CODED_WIDTH,
            decodedFrameFingerprint: EXPECTED_DECODED_FRAME_FINGERPRINT
        });
        expect(fixture.encodedKeyFrame).toHaveLength(VP9_EXPECTED_BYTE_LENGTH);
        expect(getSHA256(fixture.encodedKeyFrame)).toBe(VP9_EXPECTED_SHA256);
    });

    it('returns independent mutable byte arrays', () => {
        const firstFixture = createRawHDRCapabilityFixture('av1');
        const secondFixture = createRawHDRCapabilityFixture('av1');
        const originalFirstByte = secondFixture.encodedKeyFrame[0];

        firstFixture.encodedKeyFrame[0] ^= 0xFF;

        expect(secondFixture.encodedKeyFrame[0]).toBe(originalFirstByte);
    });
});
