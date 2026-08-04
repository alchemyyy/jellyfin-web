import { type Microseconds } from '../MediaTime';

export const RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT = 256;

export const RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT = 1;
export const RAW_VIDEO_DOLBY_VISION_FRAME_LAYER_COUNT = 2;
export const MAXIMUM_OUTSTANDING_RAW_FRAME_TRANSFER_COUNT = 2;

// One transferable may contain a frame or an atomic Dolby Vision frame pair
export const MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH = 128 * 1_024 * 1_024;
export const MAXIMUM_COMPOUND_RAW_FRAME_COPY_BYTE_LENGTH =
    MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH;

// This bounds in-flight transferable buffers, not decoder or GPU allocations
export const MAXIMUM_RAW_FRAME_TRANSFER_WINDOW_BYTE_LENGTH =
    MAXIMUM_COMPOUND_RAW_FRAME_COPY_BYTE_LENGTH
    * MAXIMUM_OUTSTANDING_RAW_FRAME_TRANSFER_COUNT;

export type SupportedRawVideoFrameFormat =
    | 'I420'
    | 'I420P10'
    | 'I420P12'
    | 'NV12';

export type RawVideoFrameCopyOptions = {
    expectedGeometry?: RawVideoFrameGeometry
    format?: SupportedRawVideoFrameFormat
    requireReusableBuffer?: boolean
    reusableBuffer?: ArrayBuffer
};

export type RawVideoFramePairCopyOptions = {
    baseExpectedGeometry?: RawVideoFrameGeometry
    enhancementExpectedGeometry: RawVideoFrameGeometry
    format: SupportedRawVideoFrameFormat
    requireReusableBuffer?: boolean
    reusableBuffer?: ArrayBuffer
};

export type RawVideoFrameGeometry = {
    codedHeight: number
    codedWidth: number
    displayHeight: number
    displayWidth: number
};

export type RawVideoPlaneKind = 'u' | 'uv' | 'v' | 'y';

export type RawVideoFrameRectangle = {
    height: number
    width: number
    x: number
    y: number
};

export type RawVideoFrameColorSpace = {
    fullRange: boolean | null
    matrix: string | null
    primaries: string | null
    transfer: string | null
};

export type RawVideoPlaneDescriptor = {
    byteLength: number
    byteOffset: number
    bytesPerComponent: 1 | 2
    bytesPerRow: number
    componentsPerTexel: 1 | 2
    height: number
    kind: RawVideoPlaneKind
    rowByteLength: number
    width: number
};

export type TransferableRawVideoFrame = {
    bitDepth: 8 | 10 | 12
    codedHeight: number
    codedWidth: number
    colorSpace: RawVideoFrameColorSpace
    data: ArrayBuffer
    displayHeight: number
    displayWidth: number
    durationMicroseconds: Microseconds | null
    format: SupportedRawVideoFrameFormat
    planes: readonly RawVideoPlaneDescriptor[]
    timestampMicroseconds: Microseconds
    visibleRectangle: RawVideoFrameRectangle
};

export type TransferableRawVideoFramePair = {
    baseFrame: TransferableRawVideoFrame
    enhancementFrame: TransferableRawVideoFrame | null
};

export type RawVideoFrameCopyFailureCode =
    | 'allocation-failed'
    | 'copy-failed'
    | 'invalid-dimensions'
    | 'invalid-layout'
    | 'unsupported-format'
    | 'unsupported-transform';

type RawVideoPlaneDefinition = {
    bytesPerComponent: 1 | 2
    componentsPerTexel: 1 | 2
    heightDivisor: 1 | 2
    kind: RawVideoPlaneKind
    widthDivisor: 1 | 2
};

type RawVideoFormatDefinition = {
    bitDepth: 8 | 10 | 12
    format: SupportedRawVideoFrameFormat
    planes: readonly RawVideoPlaneDefinition[]
};

type PreparedRawVideoFrame = {
    copyByteLength: number
    copyByteOffset: number
    copyLayouts: PlaneLayout[]
    format: RawVideoFormatDefinition
    planes: readonly RawVideoPlaneDescriptor[]
    visibleRectangle: RawVideoFrameRectangle
};

type TransformAwareVideoFrame = VideoFrame & {
    flip?: unknown
    rotation?: unknown
};

const I420_8_BIT_PLANES: readonly RawVideoPlaneDefinition[] = [
    {
        bytesPerComponent: 1,
        componentsPerTexel: 1,
        heightDivisor: 1,
        kind: 'y',
        widthDivisor: 1
    },
    {
        bytesPerComponent: 1,
        componentsPerTexel: 1,
        heightDivisor: 2,
        kind: 'u',
        widthDivisor: 2
    },
    {
        bytesPerComponent: 1,
        componentsPerTexel: 1,
        heightDivisor: 2,
        kind: 'v',
        widthDivisor: 2
    }
];

const I420_16_BIT_PLANES: readonly RawVideoPlaneDefinition[] = [
    {
        bytesPerComponent: 2,
        componentsPerTexel: 1,
        heightDivisor: 1,
        kind: 'y',
        widthDivisor: 1
    },
    {
        bytesPerComponent: 2,
        componentsPerTexel: 1,
        heightDivisor: 2,
        kind: 'u',
        widthDivisor: 2
    },
    {
        bytesPerComponent: 2,
        componentsPerTexel: 1,
        heightDivisor: 2,
        kind: 'v',
        widthDivisor: 2
    }
];

const NV12_PLANES: readonly RawVideoPlaneDefinition[] = [
    {
        bytesPerComponent: 1,
        componentsPerTexel: 1,
        heightDivisor: 1,
        kind: 'y',
        widthDivisor: 1
    },
    {
        bytesPerComponent: 1,
        componentsPerTexel: 2,
        heightDivisor: 2,
        kind: 'uv',
        widthDivisor: 2
    }
];

/** Describes a deterministic failure while extracting raw VideoFrame planes. */
export class RawVideoFrameCopyError extends Error {
    public readonly code: RawVideoFrameCopyFailureCode;

    public constructor(code: RawVideoFrameCopyFailureCode, message: string) {
        super(message);
        this.code = code;
        this.name = 'RawVideoFrameCopyError';
    }
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function alignTo(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment;
}

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

function getFormatDefinition(format: string | null): RawVideoFormatDefinition {
    switch (format) {
        case 'I420':
            return {
                bitDepth: 8,
                format,
                planes: I420_8_BIT_PLANES
            };
        case 'I420P10':
            return {
                bitDepth: 10,
                format,
                planes: I420_16_BIT_PLANES
            };
        case 'I420P12':
            return {
                bitDepth: 12,
                format,
                planes: I420_16_BIT_PLANES
            };
        case 'NV12':
            return {
                bitDepth: 8,
                format,
                planes: NV12_PLANES
            };
        default:
            throw new RawVideoFrameCopyError(
                'unsupported-format',
                `Raw VideoFrame format ${String(format)} is not supported`
            );
    }
}

function assertNoTransform(frame: TransformAwareVideoFrame): void {
    if (frame.flip !== undefined && frame.flip !== false) {
        throw new RawVideoFrameCopyError(
            'unsupported-transform',
            'Flipped VideoFrames require a transform pass before raw presentation'
        );
    }
    if (frame.rotation !== undefined && frame.rotation !== 0) {
        throw new RawVideoFrameCopyError(
            'unsupported-transform',
            'Rotated VideoFrames require a transform pass before raw presentation'
        );
    }
}

function getVisibleRectangle(frame: VideoFrame): RawVideoFrameRectangle {
    const rectangle = frame.visibleRect;
    if (!rectangle) {
        throw new RawVideoFrameCopyError(
            'invalid-dimensions',
            'The VideoFrame does not have a visible rectangle'
        );
    }

    const values = [ rectangle.x, rectangle.y, rectangle.width, rectangle.height ];
    if (!values.every((value: number): boolean => Number.isSafeInteger(value))) {
        throw new RawVideoFrameCopyError(
            'invalid-dimensions',
            'The VideoFrame visible rectangle must contain integer coordinates'
        );
    }
    if (
        rectangle.x < 0
        || rectangle.y < 0
        || rectangle.width <= 0
        || rectangle.height <= 0
        || rectangle.x % 2 !== 0
        || rectangle.y % 2 !== 0
        || rectangle.x + rectangle.width > frame.codedWidth
        || rectangle.y + rectangle.height > frame.codedHeight
    ) {
        throw new RawVideoFrameCopyError(
            'invalid-dimensions',
            'The VideoFrame visible rectangle exceeds its coded dimensions'
        );
    }

    return {
        height: rectangle.height,
        width: rectangle.width,
        x: rectangle.x,
        y: rectangle.y
    };
}

function getColorSpace(frame: VideoFrame): RawVideoFrameColorSpace {
    return {
        fullRange: frame.colorSpace.fullRange,
        matrix: frame.colorSpace.matrix === null ? null : String(frame.colorSpace.matrix),
        primaries: frame.colorSpace.primaries === null ? null : String(frame.colorSpace.primaries),
        transfer: frame.colorSpace.transfer === null ? null : String(frame.colorSpace.transfer)
    };
}

function assertValidFrameMetadata(
    frame: VideoFrame,
    expectedGeometry: RawVideoFrameGeometry | undefined
): void {
    if (
        !isPositiveSafeInteger(frame.codedWidth)
        || !isPositiveSafeInteger(frame.codedHeight)
        || !isPositiveSafeInteger(frame.displayWidth)
        || !isPositiveSafeInteger(frame.displayHeight)
        || !Number.isSafeInteger(frame.timestamp)
        || (frame.duration !== null && !isNonNegativeSafeInteger(frame.duration))
    ) {
        throw new RawVideoFrameCopyError(
            'invalid-dimensions',
            'The VideoFrame geometry or timestamp metadata is invalid'
        );
    }
    if (expectedGeometry && (
        frame.codedWidth !== expectedGeometry.codedWidth
        || frame.codedHeight !== expectedGeometry.codedHeight
        || frame.displayWidth !== expectedGeometry.displayWidth
        || frame.displayHeight !== expectedGeometry.displayHeight
    )) {
        throw new RawVideoFrameCopyError(
            'invalid-dimensions',
            'The VideoFrame geometry changed from its negotiated track configuration'
        );
    }
}

function prepareFrame(
    frame: VideoFrame,
    format: RawVideoFormatDefinition,
    expectedGeometry: RawVideoFrameGeometry | undefined
): PreparedRawVideoFrame {
    assertValidFrameMetadata(frame, expectedGeometry);
    const visibleRectangle = getVisibleRectangle(frame);
    const planes: RawVideoPlaneDescriptor[] = [];
    const copyLayouts: PlaneLayout[] = [];
    let copyByteLength = 0;

    for (const planeDefinition of format.planes) {
        const width = Math.ceil(frame.codedWidth / planeDefinition.widthDivisor);
        const height = Math.ceil(frame.codedHeight / planeDefinition.heightDivisor);
        const rowByteLength = width
            * planeDefinition.componentsPerTexel
            * planeDefinition.bytesPerComponent;
        const bytesPerRow = alignTo(
            rowByteLength,
            RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT
        );
        const byteLength = bytesPerRow * height;
        if (
            !isPositiveSafeInteger(width)
            || !isPositiveSafeInteger(height)
            || !isPositiveSafeInteger(rowByteLength)
            || !isPositiveSafeInteger(bytesPerRow)
            || !isPositiveSafeInteger(byteLength)
            || !isNonNegativeSafeInteger(copyByteLength)
            || copyByteLength + byteLength > MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH
        ) {
            throw new RawVideoFrameCopyError(
                'invalid-dimensions',
                'The raw VideoFrame copy layout exceeds the bounded buffer size'
            );
        }

        planes.push({
            byteLength,
            byteOffset: copyByteLength,
            bytesPerComponent: planeDefinition.bytesPerComponent,
            bytesPerRow,
            componentsPerTexel: planeDefinition.componentsPerTexel,
            height,
            kind: planeDefinition.kind,
            rowByteLength,
            width
        });
        copyLayouts.push({
            offset: copyByteLength,
            stride: bytesPerRow
        });
        copyByteLength += byteLength;
    }

    return {
        copyByteLength,
        copyByteOffset: 0,
        copyLayouts,
        format,
        planes,
        visibleRectangle
    };
}

function returnedLayoutsMatch(
    returnedLayouts: readonly PlaneLayout[],
    preparedFrame: PreparedRawVideoFrame
): boolean {
    if (returnedLayouts.length !== preparedFrame.planes.length) {
        return false;
    }

    return returnedLayouts.every((returnedLayout: PlaneLayout, index: number): boolean => {
        const plane = preparedFrame.planes[index];
        const finalRowEnd = returnedLayout.offset
            + (returnedLayout.stride * (plane.height - 1))
            + plane.rowByteLength;
        return Number.isSafeInteger(returnedLayout.offset)
            && Number.isSafeInteger(returnedLayout.stride)
            && returnedLayout.offset === plane.byteOffset
            && returnedLayout.stride === plane.bytesPerRow
            && finalRowEnd <= preparedFrame.copyByteOffset
                + preparedFrame.copyByteLength;
    });
}

function shiftPreparedFrame(
    preparedFrame: PreparedRawVideoFrame,
    copyByteOffset: number
): PreparedRawVideoFrame {
    if (!isNonNegativeSafeInteger(copyByteOffset)) {
        throw new RawVideoFrameCopyError(
            'invalid-layout',
            'The raw VideoFrame copy offset is invalid'
        );
    }
    return {
        ...preparedFrame,
        copyByteOffset,
        copyLayouts: preparedFrame.copyLayouts.map((layout: PlaneLayout): PlaneLayout => ({
            offset: layout.offset + copyByteOffset,
            stride: layout.stride
        })),
        planes: preparedFrame.planes.map((plane: RawVideoPlaneDescriptor): RawVideoPlaneDescriptor => ({
            ...plane,
            byteOffset: plane.byteOffset + copyByteOffset
        }))
    };
}

type RawVideoFrameCopyToOptions = Omit<VideoFrameCopyToOptions, 'format'> & {
    format: SupportedRawVideoFrameFormat
};

async function copyFrameData(
    frame: VideoFrame,
    data: ArrayBuffer,
    preparedFrame: PreparedRawVideoFrame,
    requestedFormat: SupportedRawVideoFrameFormat | undefined
): Promise<PlaneLayout[]> {
    const baseOptions: VideoFrameCopyToOptions = {
        layout: preparedFrame.copyLayouts,
        rect: {
            height: frame.codedHeight,
            width: frame.codedWidth,
            x: 0,
            y: 0
        }
    };
    if (!requestedFormat) {
        return frame.copyTo(data, baseOptions);
    }

    const requestedOptions: RawVideoFrameCopyToOptions = {
        ...baseOptions,
        format: requestedFormat
    };
    try {
        return await frame.copyTo(
            data,
            requestedOptions as unknown as VideoFrameCopyToOptions
        );
    } catch (error) {
        if (frame.format !== requestedFormat) {
            throw error;
        }

        // Older Chromium versions reject explicit non-RGB formats even when
        // the decoded frame already exposes that exact copyable format
        return frame.copyTo(data, baseOptions);
    }
}

async function copyPreparedFrameData(
    frame: VideoFrame,
    data: ArrayBuffer,
    preparedFrame: PreparedRawVideoFrame,
    requestedFormat: SupportedRawVideoFrameFormat | undefined,
    layoutMismatchMessage: string
): Promise<void> {
    let returnedLayouts: PlaneLayout[];
    try {
        returnedLayouts = await copyFrameData(
            frame,
            data,
            preparedFrame,
            requestedFormat
        );
    } catch (error) {
        throw new RawVideoFrameCopyError('copy-failed', getErrorMessage(error));
    }
    if (!returnedLayoutsMatch(returnedLayouts, preparedFrame)) {
        throw new RawVideoFrameCopyError(
            'invalid-layout',
            layoutMismatchMessage
        );
    }
}

function closeFrame(frame: VideoFrame): void {
    try {
        frame.close();
    } catch {
        // Ownership ends even if a platform implementation throws while closing
    }
}

function allocateRawFrameBuffer(
    copyByteLength: number,
    reusableBuffer: ArrayBuffer | undefined,
    requireReusableBuffer: boolean | undefined
): ArrayBuffer {
    if (reusableBuffer?.byteLength === copyByteLength) {
        return reusableBuffer;
    }
    if (requireReusableBuffer) {
        throw new RawVideoFrameCopyError(
            'allocation-failed',
            'The recycled raw frame buffer size did not match the copy layout'
        );
    }
    try {
        return new ArrayBuffer(copyByteLength);
    } catch (error) {
        throw new RawVideoFrameCopyError(
            'allocation-failed',
            getErrorMessage(error)
        );
    }
}

function createTransferableRawVideoFrame(
    frame: VideoFrame,
    data: ArrayBuffer,
    preparedFrame: PreparedRawVideoFrame
): TransferableRawVideoFrame {
    return {
        bitDepth: preparedFrame.format.bitDepth,
        codedHeight: frame.codedHeight,
        codedWidth: frame.codedWidth,
        colorSpace: getColorSpace(frame),
        data,
        displayHeight: frame.displayHeight,
        displayWidth: frame.displayWidth,
        durationMicroseconds: frame.duration as Microseconds | null,
        format: preparedFrame.format.format,
        planes: preparedFrame.planes,
        timestampMicroseconds: frame.timestamp as Microseconds,
        visibleRectangle: preparedFrame.visibleRectangle
    };
}

function getRawFrameCopyByteLength(
    geometry: RawVideoFrameGeometry,
    format: RawVideoFormatDefinition
): number {
    const dimensions = [
        geometry.codedHeight,
        geometry.codedWidth,
        geometry.displayHeight,
        geometry.displayWidth
    ];
    if (dimensions.some((dimension: number): boolean => !isPositiveSafeInteger(dimension))) {
        throw new RawVideoFrameCopyError(
            'invalid-dimensions',
            'The reserved raw VideoFrame geometry is invalid'
        );
    }

    let copyByteLength = 0;
    for (const plane of format.planes) {
        const width = Math.ceil(geometry.codedWidth / plane.widthDivisor);
        const height = Math.ceil(geometry.codedHeight / plane.heightDivisor);
        const rowByteLength = width * plane.componentsPerTexel * plane.bytesPerComponent;
        const bytesPerRow = alignTo(rowByteLength, RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT);
        copyByteLength += bytesPerRow * height;
    }
    if (
        !isPositiveSafeInteger(copyByteLength)
        || copyByteLength > MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH
    ) {
        throw new RawVideoFrameCopyError(
            'invalid-dimensions',
            'The reserved raw VideoFrame copy layout exceeds its bounded buffer size'
        );
    }
    return copyByteLength;
}

/** Returns whether aligned frame copies fit the bounded in-flight raw transfer window. */
export function hasRawVideoFrameResourceBudget(
    geometry: RawVideoFrameGeometry,
    format: SupportedRawVideoFrameFormat,
    frameLayerCount = RAW_VIDEO_SINGLE_LAYER_FRAME_COUNT
): boolean {
    if (!isPositiveSafeInteger(frameLayerCount)) {
        return false;
    }
    try {
        const copyByteLength = getRawFrameCopyByteLength(
            geometry,
            getFormatDefinition(format)
        );
        const transferByteLength = copyByteLength * frameLayerCount;
        const transferWindowByteLength = transferByteLength
            * MAXIMUM_OUTSTANDING_RAW_FRAME_TRANSFER_COUNT;
        return isPositiveSafeInteger(transferByteLength)
            && transferByteLength <= MAXIMUM_COMPOUND_RAW_FRAME_COPY_BYTE_LENGTH
            && isPositiveSafeInteger(transferWindowByteLength)
            && transferWindowByteLength <= MAXIMUM_RAW_FRAME_TRANSFER_WINDOW_BYTE_LENGTH;
    } catch {
        return false;
    }
}

/**
 * Takes ownership of one VideoFrame, copies its complete coded 4:2:0 planes in
 * the exposed or requested format, and closes the frame exactly once.
 * An exact-size live buffer is reused to keep the raw presentation cycle bounded.
 */
export async function copyVideoFrameToRawPlanes(
    frame: VideoFrame,
    options: RawVideoFrameCopyOptions = {}
): Promise<TransferableRawVideoFrame> {
    try {
        const transformAwareFrame = frame as TransformAwareVideoFrame;
        assertNoTransform(transformAwareFrame);
        const frameFormat = options.format ?? (frame.format as string | null);
        const format = getFormatDefinition(frameFormat);
        const preparedFrame = prepareFrame(frame, format, options.expectedGeometry);
        const data = allocateRawFrameBuffer(
            preparedFrame.copyByteLength,
            options.reusableBuffer,
            options.requireReusableBuffer
        );

        let returnedLayouts: PlaneLayout[];
        try {
            returnedLayouts = await copyFrameData(
                frame,
                data,
                preparedFrame,
                options.format
            );
        } catch (error) {
            throw new RawVideoFrameCopyError('copy-failed', getErrorMessage(error));
        }
        if (!returnedLayoutsMatch(returnedLayouts, preparedFrame)) {
            throw new RawVideoFrameCopyError(
                'invalid-layout',
                'VideoFrame.copyTo returned a layout that differs from the requested layout'
            );
        }

        return createTransferableRawVideoFrame(frame, data, preparedFrame);
    } finally {
        closeFrame(frame);
    }
}

/**
 * Takes ownership of a decoded BL and optional EL frame and copies both into
 * one fixed-size transferable buffer. The reserved EL region keeps recycling
 * exact even when the EL decoder degrades and a BL-only frame is emitted.
 */
export async function copyVideoFramePairToRawPlanes(
    baseFrame: VideoFrame,
    enhancementFrame: VideoFrame | null,
    options: RawVideoFramePairCopyOptions
): Promise<TransferableRawVideoFramePair> {
    try {
        assertNoTransform(baseFrame as TransformAwareVideoFrame);
        if (enhancementFrame) {
            assertNoTransform(enhancementFrame as TransformAwareVideoFrame);
        }
        const format = getFormatDefinition(options.format);
        const preparedBaseFrame = prepareFrame(
            baseFrame,
            format,
            options.baseExpectedGeometry
        );
        const enhancementByteOffset = alignTo(
            preparedBaseFrame.copyByteLength,
            RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT
        );
        const reservedEnhancementByteLength = getRawFrameCopyByteLength(
            options.enhancementExpectedGeometry,
            format
        );
        let preparedEnhancementFrame: PreparedRawVideoFrame | null = null;
        if (enhancementFrame) {
            preparedEnhancementFrame = shiftPreparedFrame(
                prepareFrame(
                    enhancementFrame,
                    format,
                    options.enhancementExpectedGeometry
                ),
                enhancementByteOffset
            );
            if (preparedEnhancementFrame.copyByteLength !== reservedEnhancementByteLength) {
                throw new RawVideoFrameCopyError(
                    'invalid-layout',
                    'The decoded enhancement frame differs from its reserved copy layout'
                );
            }
        }
        const compoundByteLength = enhancementByteOffset + reservedEnhancementByteLength;
        if (
            !isPositiveSafeInteger(compoundByteLength)
            || compoundByteLength > MAXIMUM_COMPOUND_RAW_FRAME_COPY_BYTE_LENGTH
        ) {
            throw new RawVideoFrameCopyError(
                'invalid-dimensions',
                'The compound raw VideoFrame copy exceeds its bounded buffer size'
            );
        }
        const data = allocateRawFrameBuffer(
            compoundByteLength,
            options.reusableBuffer,
            options.requireReusableBuffer
        );

        await copyPreparedFrameData(
            baseFrame,
            data,
            preparedBaseFrame,
            options.format,
            'Base VideoFrame.copyTo returned a layout that differs from the requested layout'
        );

        if (enhancementFrame && preparedEnhancementFrame) {
            await copyPreparedFrameData(
                enhancementFrame,
                data,
                preparedEnhancementFrame,
                options.format,
                'Enhancement VideoFrame.copyTo returned a layout that differs from the requested layout'
            );
        }

        return {
            baseFrame: createTransferableRawVideoFrame(
                baseFrame,
                data,
                preparedBaseFrame
            ),
            enhancementFrame: enhancementFrame && preparedEnhancementFrame ?
                createTransferableRawVideoFrame(
                    enhancementFrame,
                    data,
                    preparedEnhancementFrame
                ) :
                null
        };
    } finally {
        closeFrame(baseFrame);
        if (enhancementFrame && enhancementFrame !== baseFrame) {
            closeFrame(enhancementFrame);
        }
    }
}

/** Returns the single-use transfer list for a copied raw frame descriptor. */
export function getRawVideoFrameTransferList(
    frame: TransferableRawVideoFrame
): Transferable[] {
    const transferList: Transferable[] = [];
    transferList.push(frame.data);
    return transferList;
}

/** Returns the one-buffer transfer list for an atomic BL/EL frame pair. */
export function getRawVideoFramePairTransferList(
    framePair: TransferableRawVideoFramePair
): Transferable[] {
    if (
        framePair.enhancementFrame
        && framePair.enhancementFrame.data !== framePair.baseFrame.data
    ) {
        throw new TypeError('A compound raw frame pair must share one ArrayBuffer');
    }
    const transferList: Transferable[] = [];
    transferList.push(framePair.baseFrame.data);
    return transferList;
}
