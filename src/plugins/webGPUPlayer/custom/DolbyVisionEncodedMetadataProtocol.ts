import {
    decodeDolbyVisionRPUSnapshot,
    hasCompatibleDolbyVisionRPUSnapshotHeader,
    MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH
} from './DolbyVisionRPUParser';

export const DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION = 4;
export const MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_COUNT = 16;
export const MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_BYTE_LENGTH =
    MAXIMUM_DOLBY_VISION_RPU_PARSER_INPUT_BYTE_LENGTH;
export const MAXIMUM_DOLBY_VISION_RPU_FRAME_BYTE_LENGTH =
    MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_COUNT
    * MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_BYTE_LENGTH;

export type DolbyVisionEnhancementLayerDisposition =
    | 'absent'
    | 'decoded-fel'
    | 'decoded-mel'
    | 'discarded-fel'
    | 'discarded-mel';

export type DolbyVisionEncodedFrameMetadata = {
    enhancementLayerDisposition: DolbyVisionEnhancementLayerDisposition
    hasEnhancementLayerVCL: boolean
    parsedRPUData: readonly ArrayBuffer[]
    rpuNALUnits: readonly Uint8Array[]
    schemaVersion: typeof DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
};

export type TransferableDolbyVisionEncodedFrameMetadata = {
    enhancementLayerDisposition: DolbyVisionEnhancementLayerDisposition
    hasEnhancementLayerVCL: boolean
    parsedRPUData: readonly ArrayBuffer[]
    schemaVersion: typeof DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
};

/** Converts extracted metadata to explicit postMessage ownership. */
export function takeTransferableDolbyVisionEncodedFrameMetadata(
    metadata: DolbyVisionEncodedFrameMetadata | null
): TransferableDolbyVisionEncodedFrameMetadata | null {
    if (!metadata) {
        return null;
    }

    return {
        enhancementLayerDisposition: metadata.enhancementLayerDisposition,
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
    return transferables;
}

function isEnhancementLayerDisposition(
    value: unknown
): value is DolbyVisionEnhancementLayerDisposition {
    switch (value) {
        case 'absent':
        case 'decoded-fel':
        case 'decoded-mel':
        case 'discarded-fel':
        case 'discarded-mel':
            return true;
        default:
            return false;
    }
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
        || !isEnhancementLayerDisposition(metadata.enhancementLayerDisposition)
        || typeof metadata.hasEnhancementLayerVCL !== 'boolean'
        || !Array.isArray(metadata.parsedRPUData)
        || metadata.parsedRPUData.length === 0
        || metadata.parsedRPUData.length > MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_COUNT
        || (metadata.enhancementLayerDisposition === 'absent'
            && metadata.hasEnhancementLayerVCL)
    ) {
        return false;
    }

    const layerModes: string[] = [];
    for (const packedRPUData of metadata.parsedRPUData) {
        if (!hasCompatibleDolbyVisionRPUSnapshotHeader(packedRPUData)) {
            return false;
        }
        try {
            const snapshot = decodeDolbyVisionRPUSnapshot(packedRPUData);
            layerModes.push(snapshot.layerMode);
        } catch {
            return false;
        }
    }

    switch (metadata.enhancementLayerDisposition) {
        case 'absent':
            return true;
        case 'decoded-fel':
        case 'discarded-fel':
            return layerModes.length === 1 && layerModes[0] === 'fel';
        case 'decoded-mel':
        case 'discarded-mel':
            return layerModes.length === 1 && layerModes[0] === 'mel';
    }
}
