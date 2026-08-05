import {
    rewriteHEVCSPSColorDescriptionToBT709,
    type HEVCHDRTransfer
} from './HEVCSPSParser';

const HEVC_CONFIGURATION_ARRAY_HEADER_BYTE_LENGTH = 3;
const HEVC_CONFIGURATION_HEADER_BYTE_LENGTH = 23;
const HEVC_NAL_UNIT_LENGTH_BYTE_LENGTH = 2;
const HEVC_SPS_NAL_UNIT_TYPE = 33;
const MAXIMUM_HEVC_CONFIGURATION_BYTE_LENGTH = 1024 * 1024;
const MAXIMUM_HEVC_NAL_UNIT_BYTE_LENGTH = 0xFFFF;

function toUint8Array(data: AllowSharedBufferSource): Uint8Array {
    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }
    if (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer) {
        return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    throw new TypeError('The HEVC decoder description is not a buffer source');
}

function appendBytes(destination: number[], source: Uint8Array): void {
    for (const byteValue of source) {
        destination.push(byteValue);
    }
}

function readUnsigned16(data: Uint8Array, offset: number): number {
    return (data[offset] * 256) + data[offset + 1];
}

function appendUnsigned16(destination: number[], value: number): void {
    destination.push(Math.floor(value / 256), value % 256);
}

type RewrittenNALUnitArray = {
    nextOffset: number
    rewrittenSPSCount: number
};

type RewrittenHEVCDecoderDescription = {
    description: Uint8Array
    rewrittenSPSCount: number
};

export type NeutralizedNativeHDRHEVCDecoderConfig = {
    configuration: VideoDecoderConfig
    decoderDescriptionValidated: boolean
};

function rewriteHEVCConfigurationNALUnitArray(
    description: Uint8Array,
    arrayOffset: number,
    outputBytes: number[],
    expectedHDRTransfer?: HEVCHDRTransfer
): RewrittenNALUnitArray {
    if (arrayOffset + HEVC_CONFIGURATION_ARRAY_HEADER_BYTE_LENGTH > description.byteLength) {
        throw new TypeError('The HEVC decoder description ends inside a NAL array header');
    }
    const arrayHeader = description.subarray(
        arrayOffset,
        arrayOffset + HEVC_CONFIGURATION_ARRAY_HEADER_BYTE_LENGTH
    );
    const declaredNALUnitType = arrayHeader[0] & 0x3F;
    const nalUnitCount = readUnsigned16(arrayHeader, 1);
    appendBytes(outputBytes, arrayHeader);
    let offset = arrayOffset + HEVC_CONFIGURATION_ARRAY_HEADER_BYTE_LENGTH;
    let rewrittenSPSCount = 0;

    for (let nalUnitIndex = 0; nalUnitIndex < nalUnitCount; nalUnitIndex += 1) {
        if (offset + HEVC_NAL_UNIT_LENGTH_BYTE_LENGTH > description.byteLength) {
            throw new TypeError('The HEVC decoder description ends before a NAL unit length');
        }
        const nalUnitByteLength = readUnsigned16(description, offset);
        offset += HEVC_NAL_UNIT_LENGTH_BYTE_LENGTH;
        if (
            nalUnitByteLength < HEVC_NAL_UNIT_LENGTH_BYTE_LENGTH
            || offset + nalUnitByteLength > description.byteLength
        ) {
            throw new TypeError('The HEVC decoder description contains an invalid NAL unit');
        }
        const nalUnit = description.subarray(offset, offset + nalUnitByteLength);
        const actualNALUnitType = (nalUnit[0] >> 1) & 0x3F;
        if (actualNALUnitType !== declaredNALUnitType) {
            throw new TypeError('The HEVC decoder description NAL unit type does not match its array');
        }
        const rewrittenNALUnit = actualNALUnitType === HEVC_SPS_NAL_UNIT_TYPE ?
            rewriteHEVCSPSColorDescriptionToBT709(nalUnit, expectedHDRTransfer) :
            nalUnit;
        if (rewrittenNALUnit.byteLength > MAXIMUM_HEVC_NAL_UNIT_BYTE_LENGTH) {
            throw new TypeError('The rewritten HEVC NAL unit exceeds its HVCC length field');
        }
        appendUnsigned16(outputBytes, rewrittenNALUnit.byteLength);
        appendBytes(outputBytes, rewrittenNALUnit);
        rewrittenSPSCount += actualNALUnitType === HEVC_SPS_NAL_UNIT_TYPE ? 1 : 0;
        offset += nalUnitByteLength;
    }
    return { nextOffset: offset, rewrittenSPSCount };
}

function rewriteHEVCDecoderDescription(
    descriptionSource: AllowSharedBufferSource,
    expectedHDRTransfer?: HEVCHDRTransfer
): RewrittenHEVCDecoderDescription {
    const description = toUint8Array(descriptionSource);
    if (
        description.byteLength < HEVC_CONFIGURATION_HEADER_BYTE_LENGTH
        || description.byteLength > MAXIMUM_HEVC_CONFIGURATION_BYTE_LENGTH
        || description[0] !== 1
    ) {
        throw new TypeError('The HEVC decoder description is not a supported HVCC record');
    }

    const outputBytes: number[] = [];
    appendBytes(
        outputBytes,
        description.subarray(0, HEVC_CONFIGURATION_HEADER_BYTE_LENGTH)
    );
    const arrayCount = description[22];
    let offset = HEVC_CONFIGURATION_HEADER_BYTE_LENGTH;
    let rewrittenSPSCount = 0;
    for (let arrayIndex = 0; arrayIndex < arrayCount; arrayIndex += 1) {
        const rewrittenArray = rewriteHEVCConfigurationNALUnitArray(
            description,
            offset,
            outputBytes,
            expectedHDRTransfer
        );
        offset = rewrittenArray.nextOffset;
        rewrittenSPSCount += rewrittenArray.rewrittenSPSCount;
    }
    if (offset !== description.byteLength) {
        throw new TypeError('The HEVC decoder description has trailing data');
    }
    if (outputBytes.length > MAXIMUM_HEVC_CONFIGURATION_BYTE_LENGTH) {
        throw new TypeError('The rewritten HEVC decoder description exceeds its size bound');
    }
    return {
        description: new Uint8Array(outputBytes),
        rewrittenSPSCount
    };
}

/** Rebuilds one HVCC record after neutralizing every SPS color description. */
export function rewriteHEVCDecoderDescriptionColorDescriptionToBT709(
    descriptionSource: AllowSharedBufferSource,
    expectedHDRTransfer?: HEVCHDRTransfer
): Uint8Array {
    const rewrittenDescription = rewriteHEVCDecoderDescription(
        descriptionSource,
        expectedHDRTransfer
    );
    if (rewrittenDescription.rewrittenSPSCount === 0) {
        throw new TypeError('The HEVC decoder description has no SPS to rewrite');
    }
    return rewrittenDescription.description;
}

/**
 * Neutralizes decoder metadata while reporting whether HVCC proved and rewrote
 * the source SPS. An SPS-free HVCC remains usable when the first key packet
 * carries the required in-band SPS.
 */
export function neutralizeNativeHDRHEVCDecoderConfigWithValidation(
    configuration: VideoDecoderConfig,
    expectedHDRTransfer: HEVCHDRTransfer
): NeutralizedNativeHDRHEVCDecoderConfig {
    const rewrittenDescription = configuration.description === undefined ?
        null :
        rewriteHEVCDecoderDescription(configuration.description, expectedHDRTransfer);
    return {
        configuration: {
            ...configuration,
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            },
            ...(rewrittenDescription === null ? {} : {
                description: rewrittenDescription.description
            })
        },
        decoderDescriptionValidated: (rewrittenDescription?.rewrittenSPSCount ?? 0) > 0
    };
}

/** Applies the exact neutral metadata contract required by external HDR presentation. */
export function neutralizeNativeHDRHEVCDecoderConfig(
    configuration: VideoDecoderConfig,
    expectedHDRTransfer: HEVCHDRTransfer
): VideoDecoderConfig {
    const neutralizedConfiguration = neutralizeNativeHDRHEVCDecoderConfigWithValidation(
        configuration,
        expectedHDRTransfer
    );
    if (
        configuration.description !== undefined
        && !neutralizedConfiguration.decoderDescriptionValidated
    ) {
        throw new TypeError('The HEVC decoder description has no SPS to rewrite');
    }
    return neutralizedConfiguration.configuration;
}
