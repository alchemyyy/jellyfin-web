import type { InputVideoTrack } from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { getMatroskaVC1DecoderDescription } from './MatroskaVFWVideoConfiguration';

function createTrack(codecPrivate: Uint8Array): InputVideoTrack {
    return {
        _backing: {
            internalTrack: { codecPrivate }
        }
    } as unknown as InputVideoTrack;
}

function createCodecPrivate(
    description: Uint8Array,
    FOURCC = 'WVC1',
    declaredByteLength = 40 + description.byteLength
): Uint8Array {
    const codecPrivate = new Uint8Array(40 + description.byteLength);
    const header = new DataView(codecPrivate.buffer);
    header.setUint32(0, declaredByteLength, true);
    header.setInt32(4, 1_920, true);
    header.setInt32(8, 1_080, true);
    header.setUint16(12, 1, true);
    header.setUint16(14, 24, true);
    for (let index = 0; index < FOURCC.length; index += 1) {
        codecPrivate[16 + index] = FOURCC.charCodeAt(index);
    }
    codecPrivate.set(description, 40);
    return codecPrivate;
}

describe('getMatroskaVC1DecoderDescription', () => {
    it('extracts an owned WVC1 description from a valid VFW header', () => {
        const codecPrivate = createCodecPrivate(new Uint8Array([ 1, 2, 3, 4 ]));

        const description = getMatroskaVC1DecoderDescription(
            createTrack(codecPrivate),
            1_920,
            1_080
        );

        expect(description).toEqual(new Uint8Array([ 1, 2, 3, 4 ]));
        codecPrivate[40] = 9;
        expect(description).toEqual(new Uint8Array([ 1, 2, 3, 4 ]));
    });

    it('accepts a conventional 40-byte BITMAPINFOHEADER size', () => {
        const codecPrivate = createCodecPrivate(new Uint8Array([ 1, 2, 3 ]), 'WVC1', 40);

        expect(getMatroskaVC1DecoderDescription(
            createTrack(codecPrivate),
            1_920,
            1_080
        )).toEqual(new Uint8Array([ 1, 2, 3 ]));
    });

    it.each([
        [ 'wrong FourCC', createCodecPrivate(new Uint8Array([ 1 ]), 'WMV3') ],
        [ 'wrong width', createCodecPrivate(new Uint8Array([ 1 ])) ],
        [ 'missing description', createCodecPrivate(new Uint8Array()) ]
    ])('rejects %s', (description, codecPrivate) => {
        const codedWidth = description === 'wrong width' ? 1_280 : 1_920;
        expect(getMatroskaVC1DecoderDescription(
            createTrack(codecPrivate),
            codedWidth,
            1_080
        )).toBeNull();
    });
});
