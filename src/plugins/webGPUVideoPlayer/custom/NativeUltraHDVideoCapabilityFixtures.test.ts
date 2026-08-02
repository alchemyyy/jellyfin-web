// @vitest-environment node

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    createNativeUltraHDVideoCapabilityFixture,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODECS,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_HEIGHT,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_WIDTH,
    NATIVE_ULTRA_HD_VIDEO_CAPABILITY_FIXTURE_VERSION,
    type NativeUltraHDVideoCapabilityFixtureCodec
} from './NativeUltraHDVideoCapabilityFixtures';

type ExpectedFixture = Readonly<{
    byteLength: number
    codecString: string
    sha256: string
}>;

const EXPECTED_FIXTURES: Readonly<Record<
    NativeUltraHDVideoCapabilityFixtureCodec,
    ExpectedFixture
>> = Object.freeze({
    av1: Object.freeze({
        byteLength: 49,
        codecString: 'av01.0.12M.08',
        sha256: '9a02955ff704a04c6fb6c3d74461274825d376be5890ecf5a9af98a64d2cb6de'
    }),
    hevc: Object.freeze({
        byteLength: 2_086,
        codecString: 'hvc1.1.6.L153.B0',
        sha256: 'b2d3cbcbc02c6df49edf835fab1812bb11136423f41bbea3f0361744de81e1b8'
    }),
    vp9: Object.freeze({
        byteLength: 731,
        codecString: 'vp09.00.51.08',
        sha256: '31a64e51dc3665c469d2bd8071b34cf8fa9fba5b096f0fcc923503535062ed70'
    })
});

function getSHA256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

describe('native Ultra HD video capability fixtures', () => {
    it.each(NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODECS)(
        'pins the exact %s 3840x2160 keyframe',
        codec => {
            const expectedFixture: ExpectedFixture = EXPECTED_FIXTURES[codec];
            const fixture = createNativeUltraHDVideoCapabilityFixture(codec);

            expect(NATIVE_ULTRA_HD_VIDEO_CAPABILITY_FIXTURE_VERSION).toBe(1);
            expect(fixture).toMatchObject({
                codec,
                codecString: expectedFixture.codecString,
                codedHeight: NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_HEIGHT,
                codedWidth: NATIVE_ULTRA_HD_VIDEO_CAPABILITY_CODED_WIDTH
            });
            expect(fixture.encodedKeyFrame).toHaveLength(expectedFixture.byteLength);
            expect(getSHA256(fixture.encodedKeyFrame)).toBe(expectedFixture.sha256);
        }
    );

    it('returns independent mutable keyframe arrays', () => {
        const firstFixture = createNativeUltraHDVideoCapabilityFixture('hevc');
        const secondFixture = createNativeUltraHDVideoCapabilityFixture('hevc');
        const originalFirstByte: number = secondFixture.encodedKeyFrame[0];

        firstFixture.encodedKeyFrame[0] ^= 0xFF;

        expect(secondFixture.encodedKeyFrame[0]).toBe(originalFirstByte);
    });
});
