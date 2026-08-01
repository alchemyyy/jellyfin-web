import type { RawVideoFrameGeometry } from './RawVideoFrameCopy';

const MAXIMUM_DECODER_CODED_PADDING = 64;

/** Describes a decoded frame geometry violation at the worker boundary. */
export class DecodedVideoGeometryError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'DecodedVideoGeometryError';
    }
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function geometriesMatch(
    firstGeometry: RawVideoFrameGeometry,
    secondGeometry: RawVideoFrameGeometry
): boolean {
    return firstGeometry.codedHeight === secondGeometry.codedHeight
        && firstGeometry.codedWidth === secondGeometry.codedWidth
        && firstGeometry.displayHeight === secondGeometry.displayHeight
        && firstGeometry.displayWidth === secondGeometry.displayWidth;
}

/**
 * Accepts decoder padding while locking the first actual decoded geometry for
 * the remainder of a playback generation.
 */
export function requireConsistentDecodedVideoGeometry(
    candidateGeometry: RawVideoFrameGeometry,
    selectedTrackGeometry: RawVideoFrameGeometry,
    maximumCodedWidth: number,
    maximumCodedHeight: number,
    lockedGeometry: RawVideoFrameGeometry | null
): RawVideoFrameGeometry {
    const dimensions = [
        candidateGeometry.codedHeight,
        candidateGeometry.codedWidth,
        candidateGeometry.displayHeight,
        candidateGeometry.displayWidth,
        selectedTrackGeometry.displayHeight,
        selectedTrackGeometry.displayWidth,
        selectedTrackGeometry.codedHeight,
        selectedTrackGeometry.codedWidth,
        maximumCodedHeight,
        maximumCodedWidth
    ];
    if (!dimensions.every(isPositiveSafeInteger)) {
        throw new DecodedVideoGeometryError('Decoded frame geometry is invalid');
    }
    if (
        candidateGeometry.displayWidth !== selectedTrackGeometry.displayWidth
        || candidateGeometry.displayHeight !== selectedTrackGeometry.displayHeight
    ) {
        throw new DecodedVideoGeometryError(
            'Decoded frame display geometry does not match the selected video track'
        );
    }
    if (
        selectedTrackGeometry.codedWidth > maximumCodedWidth
        || selectedTrackGeometry.codedHeight > maximumCodedHeight
        || candidateGeometry.codedWidth - selectedTrackGeometry.codedWidth
            > MAXIMUM_DECODER_CODED_PADDING
        || candidateGeometry.codedHeight - selectedTrackGeometry.codedHeight
            > MAXIMUM_DECODER_CODED_PADDING
    ) {
        throw new DecodedVideoGeometryError(
            'Decoded frame coded geometry exceeds its negotiated decode route'
        );
    }
    if (lockedGeometry !== null) {
        if (!geometriesMatch(candidateGeometry, lockedGeometry)) {
            throw new DecodedVideoGeometryError(
                'Decoded frame geometry changed after the first decoded frame'
            );
        }
        return lockedGeometry;
    }

    return { ...candidateGeometry };
}
