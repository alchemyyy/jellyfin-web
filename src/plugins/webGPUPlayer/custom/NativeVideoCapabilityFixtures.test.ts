// @vitest-environment node

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    createNativeVideoCapabilityFixture,
    NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_HEIGHT,
    NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_WIDTH,
    NATIVE_VIDEO_CAPABILITY_FIXTURE_VERSION,
    type NativeVideoCapabilityFixtureCodec
} from './NativeVideoCapabilityFixtures';

const EXPECTED_FIXTURES: Readonly<Record<
    NativeVideoCapabilityFixtureCodec,
    Readonly<{ byteLength: number, codecString: string, sha256: string }>
>> = Object.freeze({
    av1: Object.freeze({
        byteLength: 24,
        codecString: 'av01.0.08M.08',
        sha256: '6fed3b00eb7d74bcbeedcaecc1304606b8ccb8fedd5cfff9ed173cd29d39c4b7'
    }),
    vp8: Object.freeze({
        byteLength: 38,
        codecString: 'vp8',
        sha256: '3ac815e94c47b82e6dc1047512b8a5995c3bcd65d1aadd4fa421f45e50abe84b'
    }),
    vp9: Object.freeze({
        byteLength: 33,
        codecString: 'vp09.00.10.08',
        sha256: '3334e846a0f1868e0544e47b090c9a254f0467bb6888dfc65e83c9a5c9996702'
    })
});

function getSHA256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

describe('native video capability fixtures', () => {
    it.each(Object.entries(EXPECTED_FIXTURES))(
        'pins the exact %s keyframe',
        (codecValue, expectedFixture) => {
            const codec = codecValue as NativeVideoCapabilityFixtureCodec;
            const fixture = createNativeVideoCapabilityFixture(codec);

            expect(NATIVE_VIDEO_CAPABILITY_FIXTURE_VERSION).toBe(1);
            expect(fixture).toMatchObject({
                codec,
                codecString: expectedFixture.codecString,
                codedHeight: NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_HEIGHT,
                codedWidth: NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_WIDTH
            });
            expect(fixture.encodedKeyFrame).toHaveLength(expectedFixture.byteLength);
            expect(getSHA256(fixture.encodedKeyFrame)).toBe(expectedFixture.sha256);
        }
    );

    it('returns independent mutable byte arrays', () => {
        const firstFixture = createNativeVideoCapabilityFixture('av1');
        const secondFixture = createNativeVideoCapabilityFixture('av1');
        const originalFirstByte = secondFixture.encodedKeyFrame[0];

        firstFixture.encodedKeyFrame[0] ^= 0xFF;

        expect(secondFixture.encodedKeyFrame[0]).toBe(originalFirstByte);
    });
});
