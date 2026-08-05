import type { InputVideoTrack } from 'mediabunny';

const BITMAP_INFO_HEADER_BYTE_LENGTH = 40;
const MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH = 1024 * 1024
    + BITMAP_INFO_HEADER_BYTE_LENGTH;
const WVC1_FOURCC = Object.freeze([ 0x57, 0x56, 0x43, 0x31 ]);

type MatroskaVFWInternalTrack = {
    codecPrivate?: unknown
};

type MatroskaVFWTrackBacking = {
    internalTrack?: MatroskaVFWInternalTrack
};

function hasWVC1FourCC(codecPrivate: Uint8Array): boolean {
    return WVC1_FOURCC.every((value: number, index: number): boolean => (
        codecPrivate[16 + index] === value
    ));
}

/** Extracts the FFmpeg VC-1 extradata from a Matroska VFW CodecPrivate value. */
export function getMatroskaVC1DecoderDescription(
    track: InputVideoTrack,
    codedWidth: number,
    codedHeight: number
): Uint8Array | null {
    // Mediabunny preserves unsupported Matroska codecs but does not expose
    // CodecPrivate through getDecoderConfig(), so contain the backing access here
    const backing = (track as unknown as {
        _backing: MatroskaVFWTrackBacking
    })._backing;
    const codecPrivate = backing.internalTrack?.codecPrivate;
    if (
        !(codecPrivate instanceof Uint8Array)
        || codecPrivate.byteLength <= BITMAP_INFO_HEADER_BYTE_LENGTH
        || codecPrivate.byteLength > MAXIMUM_CODEC_PRIVATE_BYTE_LENGTH
    ) {
        return null;
    }

    const header = new DataView(
        codecPrivate.buffer,
        codecPrivate.byteOffset,
        codecPrivate.byteLength
    );
    const declaredHeaderByteLength = header.getUint32(0, true);
    const bitmapWidth = header.getInt32(4, true);
    const bitmapHeight = Math.abs(header.getInt32(8, true));
    const planeCount = header.getUint16(12, true);
    if (
        declaredHeaderByteLength < BITMAP_INFO_HEADER_BYTE_LENGTH
        || declaredHeaderByteLength > codecPrivate.byteLength
        || bitmapWidth !== codedWidth
        || bitmapHeight !== codedHeight
        || planeCount !== 1
        || !hasWVC1FourCC(codecPrivate)
    ) {
        return null;
    }

    let descriptionEnd = codecPrivate.byteLength;
    if (declaredHeaderByteLength > BITMAP_INFO_HEADER_BYTE_LENGTH) {
        const trailingByteCount = codecPrivate.byteLength - declaredHeaderByteLength;
        if (trailingByteCount > 1) {
            return null;
        }
        if (trailingByteCount === 1 && codecPrivate[codecPrivate.byteLength - 1] !== 0) {
            return null;
        }
        descriptionEnd = declaredHeaderByteLength;
    }

    const description = codecPrivate.slice(
        BITMAP_INFO_HEADER_BYTE_LENGTH,
        descriptionEnd
    );
    return description.byteLength > 0 ? description : null;
}
