export const COLOR_METADATA_VERSION = 1;

export type ColorPrimaries = 'bt2020' | 'bt709';
export type ColorRange = 'full' | 'limited';
export type ColorTransfer = 'hlg' | 'pq' | 'sdr';
export type YUVMatrix = 'bt2020-ncl' | 'bt709';

export type InputColorMetadata = {
    bitDepth: number
    matrix: YUVMatrix
    nominalPeakNits: number
    primaries: ColorPrimaries
    range: ColorRange
    sdrReferenceWhiteNits: number
    transfer: ColorTransfer
    version: typeof COLOR_METADATA_VERSION
};

export type InputColorMetadataOverrides = Partial<Omit<InputColorMetadata, 'version'>>;

/** Throws when input metadata cannot drive the reference color pipeline. */
export function assertValidInputColorMetadata(metadata: InputColorMetadata): void {
    if (metadata.version !== COLOR_METADATA_VERSION) {
        throw new RangeError('Unsupported input color metadata version');
    }
    switch (metadata.matrix) {
        case 'bt2020-ncl':
        case 'bt709':
            break;
        default:
            throw new RangeError('Unsupported YUV matrix');
    }
    switch (metadata.primaries) {
        case 'bt2020':
        case 'bt709':
            break;
        default:
            throw new RangeError('Unsupported color primaries');
    }
    switch (metadata.range) {
        case 'full':
        case 'limited':
            break;
        default:
            throw new RangeError('Unsupported color range');
    }
    switch (metadata.transfer) {
        case 'hlg':
        case 'pq':
        case 'sdr':
            break;
        default:
            throw new RangeError('Unsupported color transfer');
    }
    if (!Number.isInteger(metadata.bitDepth)
        || metadata.bitDepth < 8
        || metadata.bitDepth > 16) {
        throw new RangeError('Input bit depth must be an integer from 8 through 16');
    }
    if (!Number.isFinite(metadata.nominalPeakNits) || metadata.nominalPeakNits <= 0) {
        throw new RangeError('Nominal peak luminance must be positive and finite');
    }
    if (!Number.isFinite(metadata.sdrReferenceWhiteNits)
        || metadata.sdrReferenceWhiteNits <= 0) {
        throw new RangeError('SDR reference white must be positive and finite');
    }
}

/** Creates explicit BT.709 SDR metadata for reference processing and tests. */
export function createSDRColorMetadata(
    overrides: InputColorMetadataOverrides = {}
): InputColorMetadata {
    const metadata: InputColorMetadata = {
        bitDepth: 8,
        matrix: 'bt709',
        nominalPeakNits: 100,
        primaries: 'bt709',
        range: 'limited',
        sdrReferenceWhiteNits: 100,
        transfer: 'sdr',
        version: COLOR_METADATA_VERSION,
        ...overrides
    };
    assertValidInputColorMetadata(metadata);
    return metadata;
}

/** Creates explicit BT.2020 PQ metadata for reference processing and tests. */
export function createPQColorMetadata(
    overrides: InputColorMetadataOverrides = {}
): InputColorMetadata {
    const metadata: InputColorMetadata = {
        bitDepth: 10,
        matrix: 'bt2020-ncl',
        nominalPeakNits: 1_000,
        primaries: 'bt2020',
        range: 'limited',
        sdrReferenceWhiteNits: 100,
        transfer: 'pq',
        version: COLOR_METADATA_VERSION,
        ...overrides
    };
    assertValidInputColorMetadata(metadata);
    return metadata;
}

/** Creates explicit BT.2020 HLG metadata for reference processing and tests. */
export function createHLGColorMetadata(
    overrides: InputColorMetadataOverrides = {}
): InputColorMetadata {
    const metadata: InputColorMetadata = {
        bitDepth: 10,
        matrix: 'bt2020-ncl',
        nominalPeakNits: 1_000,
        primaries: 'bt2020',
        range: 'limited',
        sdrReferenceWhiteNits: 100,
        transfer: 'hlg',
        version: COLOR_METADATA_VERSION,
        ...overrides
    };
    assertValidInputColorMetadata(metadata);
    return metadata;
}
