import { describe, expect, it, vi } from 'vitest';

import {
    copyVideoFrameToRawPlanes,
    getRawVideoFrameTransferList,
    RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT,
    type RawVideoFrameCopyError,
    type SupportedRawVideoFrameFormat
} from './RawVideoFrameCopy';

type MockFunction = ReturnType<typeof vi.fn>;

type FrameHarness = {
    close: MockFunction
    copyTo: MockFunction
    frame: VideoFrame
};

type FrameOptions = {
    codedHeight?: number
    codedWidth?: number
    colorSpace?: {
        fullRange: boolean | null
        matrix: string | null
        primaries: string | null
        transfer: string | null
    }
    copyTo?: MockFunction
    displayHeight?: number
    displayWidth?: number
    duration?: number | null
    flip?: unknown
    format?: string | null
    rotation?: unknown
    timestamp?: number
    visibleRectangle?: {
        height: number
        width: number
        x: number
        y: number
    } | null
};

function createRectangle(
    x: number,
    y: number,
    width: number,
    height: number
): DOMRectReadOnly {
    return {
        bottom: y + height,
        height,
        left: x,
        right: x + width,
        toJSON: () => ({}),
        top: y,
        width,
        x,
        y
    };
}

function createFrameHarness(options: FrameOptions = {}): FrameHarness {
    const codedHeight = options.codedHeight ?? 2;
    const codedWidth = options.codedWidth ?? 4;
    const close = vi.fn();
    const copyTo = options.copyTo ?? vi.fn(
        async (
            _destination: AllowSharedBufferSource,
            copyOptions?: VideoFrameCopyToOptions
        ): Promise<PlaneLayout[]> => copyOptions?.layout ?? []
    );
    const visibleRectangle = options.visibleRectangle === null ?
        null :
        createRectangle(
            options.visibleRectangle?.x ?? 0,
            options.visibleRectangle?.y ?? 0,
            options.visibleRectangle?.width ?? codedWidth,
            options.visibleRectangle?.height ?? codedHeight
        );
    const frame = {
        close,
        codedHeight,
        codedWidth,
        colorSpace: options.colorSpace ?? {
            fullRange: false,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            transfer: 'smpte2084'
        },
        copyTo,
        displayHeight: options.displayHeight ?? codedHeight,
        displayWidth: options.displayWidth ?? codedWidth,
        duration: options.duration === undefined ? 41_667 : options.duration,
        flip: options.flip,
        format: options.format === undefined ? 'I420' : options.format,
        rotation: options.rotation,
        timestamp: options.timestamp ?? 1_000_000,
        visibleRect: visibleRectangle
    } as unknown as VideoFrame;
    return { close, copyTo, frame };
}

async function expectCopyFailure(
    promise: Promise<unknown>,
    code: RawVideoFrameCopyError['code']
): Promise<void> {
    await expect(promise).rejects.toMatchObject({
        code,
        name: 'RawVideoFrameCopyError'
    });
}

describe('copyVideoFrameToRawPlanes', () => {
    it('copies I420 into three exact 256-byte-aligned plane layouts', async () => {
        const frameHarness = createFrameHarness();

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

        expect(frameHarness.copyTo).toHaveBeenCalledOnce();
        const [ destination, copyOptions ] = frameHarness.copyTo.mock.calls[0] as [
            ArrayBuffer,
            VideoFrameCopyToOptions
        ];
        expect(destination).toBe(result.data);
        expect(destination.byteLength).toBe(1_024);
        expect(copyOptions).toEqual({
            layout: [
                { offset: 0, stride: RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT },
                { offset: 512, stride: RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT },
                { offset: 768, stride: RAW_VIDEO_PLANE_BYTES_PER_ROW_ALIGNMENT }
            ],
            rect: { height: 2, width: 4, x: 0, y: 0 }
        });
        expect(result).toMatchObject({
            bitDepth: 8,
            codedHeight: 2,
            codedWidth: 4,
            colorSpace: {
                fullRange: false,
                matrix: 'bt2020-ncl',
                primaries: 'bt2020',
                transfer: 'smpte2084'
            },
            displayHeight: 2,
            displayWidth: 4,
            durationMicroseconds: 41_667,
            format: 'I420',
            timestampMicroseconds: 1_000_000,
            visibleRectangle: { height: 2, width: 4, x: 0, y: 0 }
        });
        expect(result.planes).toEqual([
            {
                byteLength: 512,
                byteOffset: 0,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 2,
                kind: 'y',
                rowByteLength: 4,
                width: 4
            },
            {
                byteLength: 256,
                byteOffset: 512,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 1,
                kind: 'u',
                rowByteLength: 2,
                width: 2
            },
            {
                byteLength: 256,
                byteOffset: 768,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 1,
                kind: 'v',
                rowByteLength: 2,
                width: 2
            }
        ]);
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('copies odd-sized NV12 into luma and interleaved chroma planes', async () => {
        const frameHarness = createFrameHarness({
            codedHeight: 3,
            codedWidth: 5,
            format: 'NV12'
        });

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

        expect(result.data.byteLength).toBe(1_280);
        expect(result.planes).toEqual([
            expect.objectContaining({
                byteLength: 768,
                byteOffset: 0,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 3,
                kind: 'y',
                rowByteLength: 5,
                width: 5
            }),
            expect.objectContaining({
                byteLength: 512,
                byteOffset: 768,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 2,
                height: 2,
                kind: 'uv',
                rowByteLength: 6,
                width: 3
            })
        ]);
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it.each([
        [ 'I420P10', 10 ],
        [ 'I420P12', 12 ]
    ] as const)(
        'copies %s through little-endian 16-bit component storage',
        async (format: SupportedRawVideoFrameFormat, bitDepth: number) => {
            const frameHarness = createFrameHarness({ format });

            const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

            expect(result.bitDepth).toBe(bitDepth);
            expect(result.planes.map(plane => plane.bytesPerComponent)).toEqual([ 2, 2, 2 ]);
            expect(result.planes.map(plane => plane.rowByteLength)).toEqual([ 8, 4, 4 ]);
            expect(frameHarness.close).toHaveBeenCalledOnce();
        }
    );

    it('preserves display, crop, timing, and nullable color metadata', async () => {
        const frameHarness = createFrameHarness({
            codedHeight: 1_088,
            codedWidth: 1_920,
            colorSpace: {
                fullRange: null,
                matrix: null,
                primaries: null,
                transfer: null
            },
            displayHeight: 720,
            displayWidth: 1_280,
            duration: null,
            timestamp: -50_000,
            visibleRectangle: { height: 1_080, width: 1_920, x: 0, y: 4 }
        });

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

        expect(result).toMatchObject({
            colorSpace: {
                fullRange: null,
                matrix: null,
                primaries: null,
                transfer: null
            },
            displayHeight: 720,
            displayWidth: 1_280,
            durationMicroseconds: null,
            timestampMicroseconds: -50_000,
            visibleRectangle: { height: 1_080, width: 1_920, x: 0, y: 4 }
        });
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it.each([ null, 'RGBA', 'RGBX', 'BGRA', 'I420A', 'I422', 'I444' ])(
        'rejects unsupported or alpha format %s and closes the frame',
        async (format: string | null) => {
            const frameHarness = createFrameHarness({ format });

            await expectCopyFailure(
                copyVideoFrameToRawPlanes(frameHarness.frame),
                'unsupported-format'
            );

            expect(frameHarness.copyTo).not.toHaveBeenCalled();
            expect(frameHarness.close).toHaveBeenCalledOnce();
        }
    );

    it.each([
        { flip: true },
        { flip: 'invalid' },
        { rotation: 90 },
        { rotation: 180 },
        { rotation: 'invalid' }
    ])('rejects unsupported frame transform %#', async (frameOptions: FrameOptions) => {
        const frameHarness = createFrameHarness(frameOptions);

        await expectCopyFailure(
            copyVideoFrameToRawPlanes(frameHarness.frame),
            'unsupported-transform'
        );

        expect(frameHarness.copyTo).not.toHaveBeenCalled();
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('accepts explicit identity transform metadata', async () => {
        const frameHarness = createFrameHarness({ flip: false, rotation: 0 });

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

        expect(result.format).toBe('I420');
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it.each([
        { codedWidth: 0 },
        { codedHeight: Number.NaN },
        { displayWidth: Number.POSITIVE_INFINITY },
        { displayHeight: 0 },
        { duration: -1 },
        { timestamp: Number.MAX_SAFE_INTEGER + 1 },
        { visibleRectangle: null },
        { visibleRectangle: { height: 2, width: 4, x: 1, y: 0 } },
        {
            codedWidth: 6,
            visibleRectangle: { height: 2, width: 4, x: 1, y: 0 }
        },
        {
            codedHeight: 4,
            visibleRectangle: { height: 2, width: 4, x: 0, y: 1 }
        },
        { visibleRectangle: { height: 1.5, width: 4, x: 0, y: 0 } }
    ])('rejects invalid frame metadata %#', async (frameOptions: FrameOptions) => {
        const frameHarness = createFrameHarness(frameOptions);

        await expectCopyFailure(
            copyVideoFrameToRawPlanes(frameHarness.frame),
            'invalid-dimensions'
        );

        expect(frameHarness.copyTo).not.toHaveBeenCalled();
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('rejects a returned layout that differs from the requested layout', async () => {
        const copyTo = vi.fn(async () => [ { offset: 0, stride: 4 } ]);
        const frameHarness = createFrameHarness({ copyTo });

        await expectCopyFailure(
            copyVideoFrameToRawPlanes(frameHarness.frame),
            'invalid-layout'
        );

        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('wraps copy failure and closes the frame exactly once', async () => {
        const copyTo = vi.fn(async () => {
            throw new Error('copy rejected');
        });
        const frameHarness = createFrameHarness({ copyTo });

        const resultPromise = copyVideoFrameToRawPlanes(frameHarness.frame);
        await expect(resultPromise).rejects.toMatchObject({
            code: 'copy-failed',
            message: 'copy rejected'
        });

        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('does not let a throwing close hide a successful copy', async () => {
        const frameHarness = createFrameHarness();
        frameHarness.close.mockImplementation(() => {
            throw new Error('close rejected');
        });

        const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

        expect(result.format).toBe('I420');
        expect(frameHarness.close).toHaveBeenCalledOnce();
    });

    it('returns the raw ArrayBuffer as the only transferable', async () => {
        const frameHarness = createFrameHarness();
        const result = await copyVideoFrameToRawPlanes(frameHarness.frame);

        const transferList = getRawVideoFrameTransferList(result);

        expect(transferList).toEqual([ result.data ]);
        expect(transferList).not.toBe(getRawVideoFrameTransferList(result));
    });
});
