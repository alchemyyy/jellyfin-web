import { type Microseconds } from '../MediaTime';

export const RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT = 256;

const MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH = 1_073_741_824;

export type SupportedRawVideoFrameFormat =
    | 'I420'
    | 'I420P10'
    | 'I420P12'
    | 'NV12';

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

function assertValidFrameMetadata(frame: VideoFrame): void {
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
}

function prepareFrame(
    frame: VideoFrame,
    format: RawVideoFormatDefinition
): PreparedRawVideoFrame {
    assertValidFrameMetadata(frame);
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
            && finalRowEnd <= preparedFrame.copyByteLength;
    });
}

function closeFrame(frame: VideoFrame): void {
    try {
        frame.close();
    } catch {
        // Ownership ends even if a platform implementation throws while closing
    }
}

/**
 * Takes ownership of one software-visible VideoFrame, copies its complete coded
 * 4:2:0 planes into an aligned transferable buffer, and closes it exactly once.
 */
export async function copyVideoFrameToRawPlanes(
    frame: VideoFrame
): Promise<TransferableRawVideoFrame> {
    try {
        const transformAwareFrame = frame as TransformAwareVideoFrame;
        assertNoTransform(transformAwareFrame);
        const format = getFormatDefinition(frame.format as string | null);
        const preparedFrame = prepareFrame(frame, format);
        let data: ArrayBuffer;
        try {
            data = new ArrayBuffer(preparedFrame.copyByteLength);
        } catch (error) {
            throw new RawVideoFrameCopyError(
                'allocation-failed',
                getErrorMessage(error)
            );
        }

        let returnedLayouts: PlaneLayout[];
        try {
            returnedLayouts = await frame.copyTo(data, {
                layout: preparedFrame.copyLayouts,
                rect: {
                    height: frame.codedHeight,
                    width: frame.codedWidth,
                    x: 0,
                    y: 0
                }
            });
        } catch (error) {
            throw new RawVideoFrameCopyError('copy-failed', getErrorMessage(error));
        }
        if (!returnedLayoutsMatch(returnedLayouts, preparedFrame)) {
            throw new RawVideoFrameCopyError(
                'invalid-layout',
                'VideoFrame.copyTo returned a layout that differs from the requested layout'
            );
        }

        return {
            bitDepth: format.bitDepth,
            codedHeight: frame.codedHeight,
            codedWidth: frame.codedWidth,
            colorSpace: getColorSpace(frame),
            data,
            displayHeight: frame.displayHeight,
            displayWidth: frame.displayWidth,
            durationMicroseconds: frame.duration as Microseconds | null,
            format: format.format,
            planes: preparedFrame.planes,
            timestampMicroseconds: frame.timestamp as Microseconds,
            visibleRectangle: preparedFrame.visibleRectangle
        };
    } finally {
        closeFrame(frame);
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
