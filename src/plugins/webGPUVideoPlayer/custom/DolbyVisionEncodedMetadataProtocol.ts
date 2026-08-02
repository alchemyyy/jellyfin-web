import {
    hasCompatibleDolbyVisionRPUSnapshotHeader,
    MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH
} from './DolbyVisionRPUParser';

export const DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION = 2;
export const MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_COUNT = 16;
export const MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_BYTE_LENGTH =
    MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH;
export const MAXIMUM_DOLBY_VISION_RPU_FRAME_BYTE_LENGTH =
    MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_COUNT
    * MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_BYTE_LENGTH;
export const MAXIMUM_DOLBY_VISION_ENHANCEMENT_ACCESS_UNIT_BYTE_LENGTH = 32 * 1_024 * 1_024;

export type DolbyVisionEncodedFrameMetadata = {
    enhancementLayerData: Uint8Array | null
    hasEnhancementLayerVCL: boolean
    parsedRPUData: readonly ArrayBuffer[]
    rpuNALUnits: readonly Uint8Array[]
    schemaVersion: typeof DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
};

export type TransferableDolbyVisionEncodedFrameMetadata = {
    enhancementLayerData: ArrayBuffer | null
    hasEnhancementLayerVCL: boolean
    parsedRPUData: readonly ArrayBuffer[]
    schemaVersion: typeof DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
};

function takeOwnedArrayBuffer(data: Uint8Array): ArrayBuffer {
    if (
        data.buffer instanceof ArrayBuffer
        && data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return data.buffer;
    }
    return data.slice().buffer;
}

/** Converts extracted metadata to explicit postMessage ownership. */
export function takeTransferableDolbyVisionEncodedFrameMetadata(
    metadata: DolbyVisionEncodedFrameMetadata | null
): TransferableDolbyVisionEncodedFrameMetadata | null {
    if (!metadata) {
        return null;
    }

    return {
        enhancementLayerData: metadata.enhancementLayerData ?
            takeOwnedArrayBuffer(metadata.enhancementLayerData) :
            null,
        hasEnhancementLayerVCL: metadata.hasEnhancementLayerVCL,
        parsedRPUData: metadata.parsedRPUData,
        schemaVersion: metadata.schemaVersion
    };
}

/** Returns every encoded metadata buffer whose ownership moves with a frame. */
export function getDolbyVisionEncodedMetadataTransferList(
    metadata: TransferableDolbyVisionEncodedFrameMetadata | null
): Transferable[] {
    if (!metadata) {
        return [];
    }

    const transferables: Transferable[] = [];
    transferables.push(...metadata.parsedRPUData);
    if (metadata.enhancementLayerData) {
        transferables.push(metadata.enhancementLayerData);
    }
    return transferables;
}

/** Validates encoded Dolby Vision metadata received across the worker boundary. */
export function isTransferableDolbyVisionEncodedFrameMetadata(
    value: unknown
): value is TransferableDolbyVisionEncodedFrameMetadata {
    if (!value || typeof value !== 'object') {
        return false;
    }
    const metadata = value as Partial<TransferableDolbyVisionEncodedFrameMetadata>;
    if (
        metadata.schemaVersion !== DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
        || typeof metadata.hasEnhancementLayerVCL !== 'boolean'
        || !Array.isArray(metadata.parsedRPUData)
        || metadata.parsedRPUData.length > MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_COUNT
        || !(metadata.enhancementLayerData === null
            || metadata.enhancementLayerData instanceof ArrayBuffer)
    ) {
        return false;
    }

    for (const packedRPUData of metadata.parsedRPUData) {
        if (!hasCompatibleDolbyVisionRPUSnapshotHeader(packedRPUData)) {
            return false;
        }
    }

    const enhancementLayerByteLength = metadata.enhancementLayerData?.byteLength ?? 0;
    return enhancementLayerByteLength <= MAXIMUM_DOLBY_VISION_ENHANCEMENT_ACCESS_UNIT_BYTE_LENGTH
        && (!metadata.hasEnhancementLayerVCL || enhancementLayerByteLength > 0)
        && metadata.parsedRPUData.length + enhancementLayerByteLength > 0;
}
