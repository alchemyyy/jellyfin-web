import assert from 'node:assert/strict';
import test from 'node:test';

import { createContainerOnlyHVCEFixture } from './create-container-only-hvce-fixture.mjs';

const HVCE_BLOCK_ADD_ID_TYPE_BYTES = Buffer.from([ 0x68, 0x76, 0x63, 0x45 ]);

function createWrappedNALUnit(nalUnitType, byteLength = 8) {
    const wrapperByteLength = byteLength + 2;
    const output = Buffer.alloc(4 + wrapperByteLength, 0x55);
    output.writeUInt32BE(wrapperByteLength, 0);
    output[4] = 63 << 1;
    output[5] = 1;
    output[6] = nalUnitType << 1;
    output[7] = 1;
    return output;
}

function createSource(parameterSetTypes = [ 32, 33, 34 ]) {
    return Buffer.concat([
        Buffer.from([ 0x1A, 0x45, 0xDF, 0xA3 ]),
        HVCE_BLOCK_ADD_ID_TYPE_BYTES,
        ...parameterSetTypes.map(nalUnitType => createWrappedNALUnit(nalUnitType))
    ]);
}

test('neutralizes one wrapped EL parameter set of each type without changing size', () => {
    const source = createSource();
    const original = Buffer.from(source);

    const fixture = createContainerOnlyHVCEFixture(source);

    assert.deepEqual(fixture.replacedNALUnitTypes, [ 32, 33, 34 ]);
    assert.equal(fixture.data.byteLength, source.byteLength);
    assert.deepEqual(source, original);
    for (let wrapperIndex = 0; wrapperIndex < 3; wrapperIndex += 1) {
        const innerHeaderOffset = 8
            + (wrapperIndex * createWrappedNALUnit(32).byteLength)
            + 6;
        assert.equal((fixture.data[innerHeaderOffset] >> 1) & 0x3F, 38);
        assert.equal(fixture.data[innerHeaderOffset + 7], 0x80);
    }
});

test('rejects a source without an hvcE mapping', () => {
    assert.throws(
        () => createContainerOnlyHVCEFixture(Buffer.concat([
            createWrappedNALUnit(32),
            createWrappedNALUnit(33),
            createWrappedNALUnit(34)
        ])),
        /no Matroska hvcE mapping/u
    );
});

test('rejects missing and duplicate wrapped EL parameter sets', () => {
    assert.throws(
        () => createContainerOnlyHVCEFixture(createSource([ 32, 34 ])),
        /NAL type 33, found 0/u
    );
    assert.throws(
        () => createContainerOnlyHVCEFixture(createSource([ 32, 33, 33, 34 ])),
        /NAL type 33, found 2/u
    );
});
