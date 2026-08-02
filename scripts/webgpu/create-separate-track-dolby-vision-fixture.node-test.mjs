import assert from 'node:assert/strict';
import test from 'node:test';

import {
    splitInterleavedDolbyVisionAnnexB
} from './create-separate-track-dolby-vision-fixture.mjs';

const START_CODE = Buffer.from([ 0, 0, 0, 1 ]);

function createNALUnit(nalUnitType, payload = [ 1, 2 ]) {
    return Buffer.from([ nalUnitType << 1, 1, ...payload ]);
}

function encodeAnnexB(nalUnits) {
    return Buffer.concat(nalUnits.flatMap(nalUnit => [ START_CODE, nalUnit ]));
}

function createInterleavedAccessUnit(options = {}) {
    const enhancementTypes = options.enhancementTypes ?? [ 32, 33, 34, 19 ];
    const baseNALUnits = [ 32, 33, 34, 19 ].map(type => createNALUnit(type));
    const enhancementWrappers = enhancementTypes.map(type => createNALUnit(
        63,
        Array.from(createNALUnit(type))
    ));
    const rpuNALUnits = Array.from(
        { length: options.rpuCount ?? 1 },
        () => createNALUnit(62)
    );
    return encodeAnnexB([ ...baseNALUnits, ...rpuNALUnits, ...enhancementWrappers ]);
}

function getNALUnitTypes(data) {
    const types = [];
    for (let offset = 0; offset < data.byteLength;) {
        assert.deepEqual(data.subarray(offset, offset + 4), START_CODE);
        types.push((data[offset + 4] >> 1) & 0x3F);
        let nextOffset = offset + 6;
        while (
            nextOffset + 4 <= data.byteLength
            && !data.subarray(nextOffset, nextOffset + 4).equals(START_CODE)
        ) {
            nextOffset += 1;
        }
        offset = nextOffset + 4 <= data.byteLength ? nextOffset : data.byteLength;
    }
    return types;
}

test('splits interleaved Profile 7 into independently decodable BL and EL/RPU streams', () => {
    const split = splitInterleavedDolbyVisionAnnexB(createInterleavedAccessUnit());

    assert.deepEqual(getNALUnitTypes(split.baseLayerData), [ 32, 33, 34, 19 ]);
    assert.deepEqual(getNALUnitTypes(split.enhancementLayerData), [ 62, 32, 33, 34, 19 ]);
    assert.equal(split.enhancementWrapperCount, 4);
    assert.equal(split.rpuCount, 1);
});

test('rejects missing EL parameter sets and ambiguous RPU counts', () => {
    assert.throws(
        () => splitInterleavedDolbyVisionAnnexB(createInterleavedAccessUnit({
            enhancementTypes: [ 32, 34, 19 ]
        })),
        /Enhancement-layer stream has no HEVC NAL type 33/u
    );
    assert.throws(
        () => splitInterleavedDolbyVisionAnnexB(createInterleavedAccessUnit({ rpuCount: 2 })),
        /one RPU/u
    );
});

test('rejects non-Annex-B input', () => {
    assert.throws(
        () => splitInterleavedDolbyVisionAnnexB(Buffer.from([ 1, 2, 3, 4 ])),
        /not Annex B/u
    );
});
