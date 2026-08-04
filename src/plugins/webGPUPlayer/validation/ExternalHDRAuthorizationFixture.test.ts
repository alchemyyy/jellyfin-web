import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { parseHEVCSPS } from '../custom/HEVCSPSParser';
import {
    createExternalHDRAuthorizationAccessUnit,
    EXTERNAL_HDR_AUTHORIZATION_CODED_HEIGHT,
    EXTERNAL_HDR_AUTHORIZATION_CODED_WIDTH,
    EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SAMPLES,
    EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SHA256
} from './ExternalHDRAuthorizationFixture';

function findAnnexBNALUnit(data: Uint8Array, nalUnitType: number): Uint8Array {
    const startOffsets: number[] = [];
    for (let offset = 0; offset + 4 <= data.byteLength; offset += 1) {
        if (
            data[offset] === 0
            && data[offset + 1] === 0
            && data[offset + 2] === 0
            && data[offset + 3] === 1
        ) {
            startOffsets.push(offset);
        }
    }
    for (let startIndex = 0; startIndex < startOffsets.length; startIndex += 1) {
        const nalUnitStart = startOffsets[startIndex] + 4;
        const nalUnitEnd = startOffsets[startIndex + 1] ?? data.byteLength;
        const nalUnit = data.subarray(nalUnitStart, nalUnitEnd);
        if (((nalUnit[0] >> 1) & 0x3F) === nalUnitType) {
            return nalUnit;
        }
    }
    throw new TypeError(`Fixture has no HEVC NAL unit type ${nalUnitType}`);
}

describe('ExternalHDRAuthorizationFixture', () => {
    it('contains the exact bounded Main10 PQ transport fixture', () => {
        const accessUnit = createExternalHDRAuthorizationAccessUnit();
        const configuration = parseHEVCSPS(findAnnexBNALUnit(accessUnit, 33));

        expect(accessUnit).toHaveLength(4_471);
        expect(createHash('sha256').update(accessUnit).digest('hex')).toBe(
            '9d887b9cf249f44a283b92c466791cbad357bea11f3eb9b246b01338304cd098'
        );
        expect(EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SHA256).toBe(
            createHash('sha256').update(accessUnit).digest('hex')
        );
        expect(configuration).toMatchObject({
            bitDepth: 10,
            codedHeight: EXTERNAL_HDR_AUTHORIZATION_CODED_HEIGHT,
            codedWidth: EXTERNAL_HDR_AUTHORIZATION_CODED_WIDTH,
            colorSpace: {
                fullRange: false,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: 'pq'
            },
            levelIDC: 120,
            profileIDC: 2
        });
    });

    it('returns fresh bytes and bounded exact YUV sample codes', () => {
        const firstAccessUnit = createExternalHDRAuthorizationAccessUnit();
        const secondAccessUnit = createExternalHDRAuthorizationAccessUnit();

        expect(firstAccessUnit).not.toBe(secondAccessUnit);
        expect(firstAccessUnit).toEqual(secondAccessUnit);
        expect(EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SAMPLES).toHaveLength(8);
        expect(EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SAMPLES[0]).toEqual({
            rawYUVCode: [ 64, 512, 512 ],
            sampleX: 0,
            sampleY: 135
        });
        expect(EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SAMPLES[6]).toEqual({
            rawYUVCode: [ 705, 412, 612 ],
            sampleX: 1_200,
            sampleY: 810
        });
        expect(EXTERNAL_HDR_AUTHORIZATION_FIXTURE_SAMPLES.at(-1)).toEqual({
            rawYUVCode: [ 795, 412, 612 ],
            sampleX: 1_680,
            sampleY: 810
        });
    });
});
