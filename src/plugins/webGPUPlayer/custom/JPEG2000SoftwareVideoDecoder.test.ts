import { EncodedPacket } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import JPEG2000SoftwareVideoDecoder, {
    getJPEG2000RGBAFingerprint,
    type JPEG2000SoftwareVideoDecoderDependencies,
    type OpenJPEGDecoder,
    type OpenJPEGFrameInfo,
    type OpenJPEGModule
} from './JPEG2000SoftwareVideoDecoder';
import { type RawVideoFrameGeometry } from './RawVideoFrameCopy';

const GEOMETRY: RawVideoFrameGeometry = {
    codedHeight: 1,
    codedWidth: 2,
    displayHeight: 9,
    displayWidth: 16
};

type FakeDecoderOptions = {
    colorSpace?: number
    decodedBuffer?: Uint8ClampedArray
    frameInfo?: OpenJPEGFrameInfo
    imageOffset?: { x: number, y: number }
};

class FakeOpenJPEGDecoder implements OpenJPEGDecoder {
    public readonly decode = vi.fn<() => void>();
    public readonly delete = vi.fn<() => void>();
    public readonly encodedBuffer = new Uint8Array(64);
    public readonly getColorSpace: () => number;
    public readonly getDecodedBuffer: () => Uint8ClampedArray;
    public readonly getFrameInfo: () => OpenJPEGFrameInfo;
    public readonly getImageOffset: () => { x: number, y: number };
    public readonly getEncodedBuffer = vi.fn<(byteLength: number) => Uint8Array>(
        (byteLength: number): Uint8Array => this.encodedBuffer.subarray(0, byteLength)
    );

    public constructor(options: FakeDecoderOptions = {}) {
        const frameInfo: OpenJPEGFrameInfo = options.frameInfo ?? {
            bitsPerSample: 8,
            componentCount: 3,
            height: 1,
            isSigned: false,
            width: 2
        };
        const decodedBuffer = options.decodedBuffer
            ?? new Uint8ClampedArray([ 1, 2, 3, 4, 5, 6 ]);
        const imageOffset = options.imageOffset ?? { x: 0, y: 0 };
        this.getColorSpace = (): number => options.colorSpace ?? 1;
        this.getDecodedBuffer = (): Uint8ClampedArray => decodedBuffer;
        this.getFrameInfo = (): OpenJPEGFrameInfo => frameInfo;
        this.getImageOffset = (): { x: number, y: number } => imageOffset;
    }
}

type DecoderHarness = {
    createModule: ReturnType<typeof vi.fn<() => Promise<OpenJPEGModule>>>
    createVideoFrame: ReturnType<typeof vi.fn>
    decoder: FakeOpenJPEGDecoder
    dependencies: JPEG2000SoftwareVideoDecoderDependencies
    loadDecoderGlue: ReturnType<typeof vi.fn<(url: string) => void>>
    resolveAssetURL: ReturnType<typeof vi.fn<(path: string) => string>>
};

function createHarness(options: FakeDecoderOptions = {}): DecoderHarness {
    const decoder = new FakeOpenJPEGDecoder(options);
    const module: OpenJPEGModule = {
        J2KDecoder: class {
            public constructor() {
                return decoder;
            }
        } as unknown as new() => OpenJPEGDecoder
    };
    const createModule = vi.fn<() => Promise<OpenJPEGModule>>(
        (): Promise<OpenJPEGModule> => Promise.resolve(module)
    );
    const createVideoFrame = vi.fn(
        (data: AllowSharedBufferSource, init: VideoFrameBufferInit): VideoFrame => (
            { close: vi.fn(), data, ...init } as unknown as VideoFrame
        )
    );
    const loadDecoderGlue = vi.fn<(url: string) => void>();
    const resolveAssetURL = vi.fn<(path: string) => string>(
        (path: string): string => `https://example.test/${path}`
    );
    return {
        createModule,
        createVideoFrame,
        decoder,
        dependencies: {
            createModule,
            createVideoFrame,
            loadDecoderGlue,
            resolveAssetURL
        },
        loadDecoderGlue,
        resolveAssetURL
    };
}

describe('JPEG2000SoftwareVideoDecoder', () => {
    it('loads the pinned artifacts once and releases the decoder exactly once', async () => {
        const harness = createHarness();
        const decoder = new JPEG2000SoftwareVideoDecoder(harness.dependencies);

        await decoder.init();
        decoder.close();
        decoder.close();

        expect(harness.resolveAssetURL).toHaveBeenNthCalledWith(
            1,
            'libraries/openjpeg/openjpeg-decode.js'
        );
        expect(harness.resolveAssetURL).toHaveBeenNthCalledWith(
            2,
            'libraries/openjpeg/openjpeg-decode.wasm'
        );
        expect(harness.loadDecoderGlue).toHaveBeenCalledOnce();
        expect(harness.createModule).toHaveBeenCalledWith(
            'https://example.test/libraries/openjpeg/openjpeg-decode.wasm'
        );
        expect(harness.decoder.delete).toHaveBeenCalledOnce();
    });

    it('copies exact sRGB bytes to owned RGBA and creates a timestamped frame', async () => {
        const harness = createHarness();
        const decoder = new JPEG2000SoftwareVideoDecoder(harness.dependencies);
        await decoder.init();
        const packet = new EncodedPacket(new Uint8Array([ 9, 8, 7 ]), 'key', 1.25, 0.5);

        decoder.decode(packet, GEOMETRY);

        expect(harness.decoder.getEncodedBuffer).toHaveBeenCalledWith(3);
        expect(harness.decoder.encodedBuffer.slice(0, 3)).toEqual(new Uint8Array([ 9, 8, 7 ]));
        expect(harness.decoder.decode).toHaveBeenCalledOnce();
        expect(harness.createVideoFrame).toHaveBeenCalledWith(
            new Uint8Array([ 1, 2, 3, 255, 4, 5, 6, 255 ]),
            {
                codedHeight: 1,
                codedWidth: 2,
                colorSpace: {
                    fullRange: true,
                    matrix: 'rgb',
                    primaries: 'bt709',
                    transfer: 'iec61966-2-1'
                },
                displayHeight: 9,
                displayWidth: 16,
                duration: 500_000,
                format: 'RGBA',
                timestamp: 1_250_000
            }
        );
    });

    it('expands qualified grayscale without changing full-range samples', async () => {
        const harness = createHarness({
            colorSpace: 2,
            decodedBuffer: new Uint8ClampedArray([ 12, 250 ]),
            frameInfo: {
                bitsPerSample: 8,
                componentCount: 1,
                height: 1,
                isSigned: false,
                width: 2
            }
        });
        const decoder = new JPEG2000SoftwareVideoDecoder(harness.dependencies);
        await decoder.init();

        const image = decoder.decodeToRGBA(new Uint8Array([ 1 ]), GEOMETRY);

        expect(image.rgba).toEqual(new Uint8Array([
            12, 12, 12, 255,
            250, 250, 250, 255
        ]));
    });

    it.each([
        {
            label: 'higher bit depth',
            options: { frameInfo: { bitsPerSample: 10, componentCount: 3, height: 1, isSigned: false, width: 2 } }
        },
        {
            label: 'signed components',
            options: { frameInfo: { bitsPerSample: 8, componentCount: 3, height: 1, isSigned: true, width: 2 } }
        },
        {
            label: 'ambiguous color',
            options: { colorSpace: 0 }
        },
        {
            label: 'alpha components',
            options: { frameInfo: { bitsPerSample: 8, componentCount: 4, height: 1, isSigned: false, width: 2 } }
        },
        {
            label: 'non-zero image origin',
            options: { imageOffset: { x: 1, y: 0 } }
        },
        {
            label: 'changed geometry',
            options: { frameInfo: { bitsPerSample: 8, componentCount: 3, height: 2, isSigned: false, width: 2 } }
        }
    ])('rejects $label output instead of presenting an ambiguous frame', async ({ options }) => {
        const harness = createHarness(options);
        const decoder = new JPEG2000SoftwareVideoDecoder(harness.dependencies);
        await decoder.init();

        expect(() => decoder.decodeToRGBA(new Uint8Array([ 1 ]), GEOMETRY)).toThrow();
        expect(harness.createVideoFrame).not.toHaveBeenCalled();
    });

    it('rejects metadata-only packets and use after close', async () => {
        const harness = createHarness();
        const decoder = new JPEG2000SoftwareVideoDecoder(harness.dependencies);
        await decoder.init();
        const metadataPacket = {
            data: new Uint8Array(0),
            isMetadataOnly: true
        } as EncodedPacket;

        expect(() => decoder.decode(metadataPacket, GEOMETRY)).toThrow('metadata-only');
        decoder.close();
        expect(() => decoder.decodeToRGBA(new Uint8Array([ 1 ]), GEOMETRY)).toThrow('closed');
    });

    it('uses a stable unsigned FNV-1a fingerprint', () => {
        expect(getJPEG2000RGBAFingerprint(new Uint8Array([ 1, 2, 3, 255 ])))
            .toBe(4_231_272_764);
    });
});
