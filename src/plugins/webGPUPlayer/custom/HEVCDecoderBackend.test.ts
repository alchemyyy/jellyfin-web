import type { HEVCFrame } from '@hevcjs/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createHEVCDecoderBackend,
    MAXIMUM_HEVC_DRAINED_FRAME_COUNT,
    type HEVCDecodedFrameHandler
} from './HEVCDecoderBackend';

type NativeFunction = (...arguments_: number[]) => number;

type FakeModuleHarness = {
    drainedFrameIndexes: number[]
    destroyCount: { value: number }
    factory: ReturnType<typeof vi.fn>
    feedBytes: Uint8Array[]
    flushResult: { value: number }
    locatedWASMURL: { value: string | null }
};

type FakeFrameLayout = {
    bitDepth: number
    chromaHeight: number
    chromaWidth: number
    height: number
    width: number
};

function writeInt32(dataView: DataView, byteOffset: number, value: number): void {
    dataView.setInt32(byteOffset, value, true);
}

function writePointer(dataView: DataView, byteOffset: number, value: number): void {
    dataView.setUint32(byteOffset, value, true);
}

function createFakeModule(
    frameOverrides: Partial<FakeFrameLayout> = {},
    drainedFrameCount = 1
): FakeModuleHarness {
    const frameLayout: FakeFrameLayout = {
        bitDepth: 10,
        chromaHeight: 1,
        chromaWidth: 2,
        height: 2,
        width: 4,
        ...frameOverrides
    };
    const hasBoundedDimensions = frameLayout.width <= 3_840 && frameLayout.height <= 2_160;
    const storedLumaSampleCount = hasBoundedDimensions ?
        frameLayout.width * frameLayout.height :
        8;
    const storedChromaSampleCount = hasBoundedDimensions ?
        frameLayout.chromaWidth * frameLayout.chromaHeight :
        2;
    const lumaPointer = 256;
    const chromaBluePointer = lumaPointer
        + (storedLumaSampleCount * Uint16Array.BYTES_PER_ELEMENT);
    const chromaRedPointer = chromaBluePointer
        + (storedChromaSampleCount * Uint16Array.BYTES_PER_ELEMENT);
    const firstAllocationPointer = chromaRedPointer
        + (storedChromaSampleCount * Uint16Array.BYTES_PER_ELEMENT)
        + 256;
    const memory = new ArrayBuffer(Math.max(1024 * 1024, firstAllocationPointer + 1024 * 1024));
    const dataView = new DataView(memory);
    const heapU16 = new Uint16Array(memory);
    const feedBytes: Uint8Array[] = [];
    const drainedFrameIndexes: number[] = [];
    const destroyCount = { value: 0 };
    const flushResult = { value: 0 };
    const locatedWASMURL = { value: null as string | null };
    let nextAllocationPointer = firstAllocationPointer;
    heapU16.set([ 1, 2, 3, 4, 5, 6, 7, 8 ], lumaPointer >> 1);
    heapU16.set([ 9, 10 ], chromaBluePointer >> 1);
    heapU16.set([ 11, 12 ], chromaRedPointer >> 1);

    function writeFrame(framePointer: number, frameIndex: number): void {
        writePointer(dataView, framePointer, lumaPointer);
        writePointer(dataView, framePointer + 4, chromaBluePointer);
        writePointer(dataView, framePointer + 8, chromaRedPointer);
        writeInt32(dataView, framePointer + 12, frameLayout.width);
        writeInt32(dataView, framePointer + 16, frameLayout.height);
        writeInt32(dataView, framePointer + 20, frameLayout.width);
        writeInt32(dataView, framePointer + 24, frameLayout.chromaWidth);
        writeInt32(dataView, framePointer + 28, frameLayout.chromaWidth);
        writeInt32(dataView, framePointer + 32, frameLayout.chromaHeight);
        writeInt32(dataView, framePointer + 36, frameLayout.bitDepth);
        writeInt32(dataView, framePointer + 40, frameIndex);
    }

    const nativeFunctions: Record<string, NativeFunction> = {};
    nativeFunctions['hevc_decoder_create'] = (): number => 1;
    nativeFunctions['hevc_decoder_destroy'] = (): number => {
        destroyCount.value += 1;
        return 0;
    };
    nativeFunctions['hevc_decoder_drain'] = (...nativeArguments: number[]): number => {
        writeInt32(dataView, nativeArguments[1], drainedFrameCount);
        return 0;
    };
    nativeFunctions['hevc_decoder_feed'] = (...nativeArguments: number[]): number => {
        const dataPointer = nativeArguments[1];
        const byteLength = nativeArguments[2];
        feedBytes.push(new Uint8Array(memory.slice(dataPointer, dataPointer + byteLength)));
        return 0;
    };
    nativeFunctions['hevc_decoder_flush'] = (): number => flushResult.value;
    nativeFunctions['hevc_decoder_get_drained_frame'] = (...nativeArguments: number[]): number => {
        const frameIndex = nativeArguments[1];
        const framePointer = nativeArguments[2];
        if (frameIndex >= drainedFrameCount) {
            return 1;
        }
        drainedFrameIndexes.push(frameIndex);
        writeFrame(framePointer, frameIndex);
        return 0;
    };
    nativeFunctions['hevc_decoder_get_info'] = (): number => 1;
    const moduleValue = {
        HEAPU16: heapU16,
        _free: vi.fn((): void => undefined),
        _malloc: vi.fn((byteLength: number): number => {
            const pointer = nextAllocationPointer;
            nextAllocationPointer += Math.ceil(byteLength / 8) * 8;
            return pointer;
        }),
        cwrap: vi.fn((name: string): NativeFunction => nativeFunctions[name]),
        getValue: (pointer: number, type: '*' | 'i32'): number => (
            type === '*' ? dataView.getUint32(pointer, true) : dataView.getInt32(pointer, true)
        )
    };
    const factory = vi.fn(async (options: {
        locateFile?: (path: string, scriptDirectory: string) => string
    }): Promise<unknown> => {
        locatedWASMURL.value = options.locateFile?.('hevc-decode.wasm', '/ignored/') ?? null;
        return moduleValue;
    });
    return {
        drainedFrameIndexes,
        destroyCount,
        factory,
        feedBytes,
        flushResult,
        locatedWASMURL
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('createHEVCDecoderBackend', () => {
    it('uses the package module ABI for feed, display-order drain, flush, and destroy', async () => {
        const harness = createFakeModule();
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({
            wasmBinaryUrl: 'https://example.test/hevc-decode.wasm'
        });
        expect(harness.locatedWASMURL.value).toBe('https://example.test/hevc-decode.wasm');

        backend.feed(new Uint8Array([ 0, 0, 0, 1, 38, 1 ]));
        const drainedFrames: HEVCFrame[] = [];
        const flushedFrames: HEVCFrame[] = [];
        const drainedFrameCount = backend.drain((frame: HEVCFrame): void => {
            drainedFrames.push(frame);
        });
        const flushedFrameCount = backend.flush((frame: HEVCFrame): void => {
            flushedFrames.push(frame);
        });

        expect(harness.feedBytes.map((data: Uint8Array): number[] => Array.from(data))).toEqual([
            [ 0, 0, 0, 1, 38, 1 ]
        ]);
        expect(drainedFrames).toEqual([ {
            bitDepth: 10,
            cb: new Uint16Array([ 9, 10 ]),
            chromaHeight: 1,
            chromaWidth: 2,
            cr: new Uint16Array([ 11, 12 ]),
            height: 2,
            poc: 0,
            width: 4,
            y: new Uint16Array([ 1, 2, 3, 4, 5, 6, 7, 8 ])
        } ]);
        expect(drainedFrameCount).toBe(1);
        expect(flushedFrames).toEqual(drainedFrames);
        expect(flushedFrameCount).toBe(1);
        expect(backend.info).toBeNull();
        backend.destroy();
        backend.destroy();
        expect(harness.destroyCount.value).toBe(1);
    });

    it('rejects a native flush failure and use after destroy', async () => {
        const harness = createFakeModule();
        harness.flushResult.value = 7;
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});

        expect(() => backend.flush((): void => undefined)).toThrow('code 7');
        backend.destroy();
        expect(() => backend.drain((): void => undefined)).toThrow('destroyed');
    });

    it('rejects invalid chroma geometry before exposing decoded planes', async () => {
        const harness = createFakeModule({ chromaWidth: 3 });
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});

        expect(() => backend.drain((): void => undefined)).toThrow('invalid 4:2:0 dimensions');
        backend.destroy();
    });

    it('rejects route-oversized frames before allocating decoded planes', async () => {
        const width = 16_384;
        const height = 6_144;
        const harness = createFakeModule({
            chromaHeight: height / 2,
            chromaWidth: width / 2,
            height,
            width
        });
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});

        expect(() => backend.drain((): void => undefined)).toThrow('invalid 4:2:0 dimensions');
        backend.destroy();
    });

    it('rejects an oversized reported drain before exposing any frame', async () => {
        const harness = createFakeModule({}, MAXIMUM_HEVC_DRAINED_FRAME_COUNT + 1);
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});

        expect(() => backend.drain((): void => undefined)).toThrow('invalid frame count');
        expect(harness.drainedFrameIndexes).toEqual([]);
        backend.destroy();
    });

    it('streams each borrowed frame before extracting the next frame', async () => {
        const harness = createFakeModule({}, 3);
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});
        const observations: Array<{ extractedFrameCount: number; poc: number }> = [];

        const frameCount = backend.drain((frame: HEVCFrame): void => {
            observations.push({
                extractedFrameCount: harness.drainedFrameIndexes.length,
                poc: frame.poc
            });
        });

        expect(frameCount).toBe(3);
        expect(observations).toEqual([
            { extractedFrameCount: 1, poc: 0 },
            { extractedFrameCount: 2, poc: 1 },
            { extractedFrameCount: 3, poc: 2 }
        ]);
        backend.destroy();
    });

    it('streams flushed frames without retaining a borrowed batch', async () => {
        const harness = createFakeModule({}, 3);
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});
        const observations: Array<{ extractedFrameCount: number; poc: number }> = [];

        const frameCount = backend.flush((frame: HEVCFrame): void => {
            observations.push({
                extractedFrameCount: harness.drainedFrameIndexes.length,
                poc: frame.poc
            });
        });

        expect(frameCount).toBe(3);
        expect(observations).toEqual([
            { extractedFrameCount: 1, poc: 0 },
            { extractedFrameCount: 2, poc: 1 },
            { extractedFrameCount: 3, poc: 2 }
        ]);
        backend.destroy();
    });

    it('stops extraction immediately when the frame handler fails', async () => {
        const harness = createFakeModule({}, 3);
        vi.stubGlobal('HEVCDecoderModule', harness.factory);
        const backend = await createHEVCDecoderBackend({});
        const frameHandler: HEVCDecodedFrameHandler = (): never => {
            throw new Error('consumer failed');
        };

        expect(() => backend.drain(frameHandler)).toThrow('consumer failed');
        expect(harness.drainedFrameIndexes).toEqual([ 0 ]);
        backend.destroy();
    });

    it('requires the glue module factory', async () => {
        vi.stubGlobal('HEVCDecoderModule', undefined);

        await expect(createHEVCDecoderBackend({})).rejects.toThrow('factory is unavailable');
    });
});
