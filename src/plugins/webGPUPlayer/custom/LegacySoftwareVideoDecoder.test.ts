import { EncodedPacket, type VideoSample } from 'mediabunny';
import { describe, expect, it, vi } from 'vitest';

import LegacySoftwareVideoDecoder, {
    LegacyVideoInterlacedFrameError,
    type LegacySoftwareVideoDecoderDependencies,
    type LegacyVideoDecoderModule
} from './LegacySoftwareVideoDecoder';

const DECODER_POINTER = 1;
const PACKET_POINTER = 48;
const EXTRADATA_POINTER = 256;
const AGAIN_ERROR = -11;
const EOF_ERROR = -541_478_725;

type FakeLegacyFrame = {
    bottomCrop?: number
    colorMatrix?: number
    colorPrimaries?: number
    colorRange?: number
    colorTransfer?: number
    duration?: bigint
    height?: number
    interlaced?: boolean
    leftCrop?: number
    repeatPicture?: number
    rightCrop?: number
    timestamp?: bigint
    topCrop?: number
    topFieldFirst?: boolean
    width?: number
};

/* eslint-disable @typescript-eslint/naming-convention -- Mirrors the external WASM ABI */
class FakeLegacyVideoDecoderModule implements LegacyVideoDecoderModule {
    public readonly HEAPU8 = new Uint8Array(512);
    public readonly _legacy_video_decoder_close = vi.fn<(decoder: number) => void>();
    public readonly _legacy_video_decoder_configure_packet = vi.fn<
        (decoder: number, packetByteLength: number) => number
    >();
    public readonly _legacy_video_decoder_create = vi.fn<
        (
            codec: number,
            codedWidth: number,
            codedHeight: number,
            extradataByteLength: number
        ) => number
    >();
    public readonly _legacy_video_decoder_error_again = (): number => AGAIN_ERROR;
    public readonly _legacy_video_decoder_error_eof = (): number => EOF_ERROR;
    public readonly _legacy_video_decoder_frame_is_i420 = (): number => 1;
    public readonly _legacy_video_decoder_get_color_matrix = (): number => (
        this.currentFrame.colorMatrix ?? 1
    );
    public readonly _legacy_video_decoder_get_color_primaries = (): number => (
        this.currentFrame.colorPrimaries ?? 1
    );
    public readonly _legacy_video_decoder_get_color_range = (): number => (
        this.currentFrame.colorRange ?? 1
    );
    public readonly _legacy_video_decoder_get_color_transfer = (): number => (
        this.currentFrame.colorTransfer ?? 1
    );
    public readonly _legacy_video_decoder_get_crop_bottom = (): number => (
        this.currentFrame.bottomCrop ?? 0
    );
    public readonly _legacy_video_decoder_get_crop_left = (): number => (
        this.currentFrame.leftCrop ?? 0
    );
    public readonly _legacy_video_decoder_get_crop_right = (): number => (
        this.currentFrame.rightCrop ?? 0
    );
    public readonly _legacy_video_decoder_get_crop_top = (): number => (
        this.currentFrame.topCrop ?? 0
    );
    public readonly _legacy_video_decoder_get_duration = (): bigint => (
        this.currentFrame.duration ?? BigInt(0)
    );
    public readonly _legacy_video_decoder_get_extradata = (): number => (
        EXTRADATA_POINTER
    );
    public readonly _legacy_video_decoder_get_height = (): number => (
        this.currentFrame.height ?? 2
    );
    public readonly _legacy_video_decoder_get_interlaced = (): number => (
        this.currentFrame.interlaced ? 1 : 0
    );
    public readonly _legacy_video_decoder_get_plane = (
        ...parameters: [ decoder: number, plane: number ]
    ): number => [ 128, 160, 176 ][parameters[1]] ?? 0;
    public readonly _legacy_video_decoder_get_repeat_picture = (): number => (
        this.currentFrame.repeatPicture ?? 0
    );
    public readonly _legacy_video_decoder_get_stride = (
        ...parameters: [ decoder: number, plane: number ]
    ): number => parameters[1] === 0 ? 6 : 3;
    public readonly _legacy_video_decoder_get_timestamp = (): bigint => (
        this.currentFrame.timestamp ?? BigInt(1_250_000)
    );
    public readonly _legacy_video_decoder_get_top_field_first = (): number => (
        this.currentFrame.topFieldFirst ? 1 : 0
    );
    public readonly _legacy_video_decoder_get_width = (): number => (
        this.currentFrame.width ?? 4
    );
    public readonly _legacy_video_decoder_open = vi.fn<(decoder: number) => number>();
    public readonly _legacy_video_decoder_receive_frame = vi.fn<
        (decoder: number) => number
    >();
    public readonly _legacy_video_decoder_send_packet = vi.fn<
        (
            decoder: number,
            presentationTimestamp: bigint,
            decodeTimestamp: bigint,
            duration: bigint,
            keyFrame: number
        ) => number
    >();
    public readonly _legacy_video_decoder_start_drain = vi.fn<
        (decoder: number) => number
    >();

    public currentFrame: FakeLegacyFrame = {};
    public readonly drainFrames: FakeLegacyFrame[] = [];
    public readonly sendFrameBatches: FakeLegacyFrame[][] = [];
    private draining = false;
    private readonly readyFrames: FakeLegacyFrame[] = [];

    public constructor() {
        this.HEAPU8.set([ 1, 2, 3, 4, 90, 91, 5, 6, 7, 8 ], 128);
        this.HEAPU8.set([ 9, 10, 92 ], 160);
        this.HEAPU8.set([ 11, 12, 93 ], 176);
        this._legacy_video_decoder_configure_packet.mockReturnValue(PACKET_POINTER);
        this._legacy_video_decoder_create.mockReturnValue(DECODER_POINTER);
        this._legacy_video_decoder_open.mockReturnValue(0);
        this._legacy_video_decoder_receive_frame.mockImplementation((): number => {
            const frame = this.readyFrames.shift();
            if (frame) {
                this.currentFrame = frame;
                return 0;
            }
            return this.draining ? EOF_ERROR : AGAIN_ERROR;
        });
        this._legacy_video_decoder_send_packet.mockImplementation((): number => {
            this.readyFrames.push(...(this.sendFrameBatches.shift() ?? []));
            return 0;
        });
        this._legacy_video_decoder_start_drain.mockImplementation((): number => {
            this.draining = true;
            this.readyFrames.push(...this.drainFrames);
            this.drainFrames.length = 0;
            return 0;
        });
    }
}
/* eslint-enable @typescript-eslint/naming-convention */

type DecoderHarness = {
    createModule: ReturnType<typeof vi.fn<() => Promise<LegacyVideoDecoderModule>>>
    dependencies: LegacySoftwareVideoDecoderDependencies
    loadDecoderGlue: ReturnType<typeof vi.fn<(url: string) => void>>
    module: FakeLegacyVideoDecoderModule
    resolveAssetURL: ReturnType<typeof vi.fn<(path: string) => string>>
};

function createHarness(): DecoderHarness {
    const module = new FakeLegacyVideoDecoderModule();
    const createModule = vi.fn<() => Promise<LegacyVideoDecoderModule>>(
        (): Promise<LegacyVideoDecoderModule> => Promise.resolve(module)
    );
    const loadDecoderGlue = vi.fn<(url: string) => void>();
    const resolveAssetURL = vi.fn<(path: string) => string>(
        (path: string): string => `https://example.test/web/${path}`
    );
    return {
        createModule,
        dependencies: {
            createModule,
            loadDecoderGlue,
            resolveAssetURL
        },
        loadDecoderGlue,
        module,
        resolveAssetURL
    };
}

function createDecoder(
    harness: DecoderHarness,
    samples: VideoSample[],
    onSample: (sample: VideoSample) => unknown = (sample: VideoSample): void => {
        samples.push(sample);
    }
): LegacySoftwareVideoDecoder {
    return new LegacySoftwareVideoDecoder({
        codec: 'mpeg2video',
        codedHeight: 2,
        codedWidth: 4,
        colorSpace: {
            fullRange: true,
            matrix: 'rgb',
            primaries: 'bt709',
            transfer: 'iec61966-2-1'
        },
        displayHeight: 9,
        displayWidth: 16
    }, {
        onError: vi.fn(),
        onSample
    }, harness.dependencies);
}

function createPacket(): EncodedPacket {
    return new EncodedPacket(new Uint8Array([ 31, 32, 33 ]), 'key', 1.25, 0.5);
}

describe('LegacySoftwareVideoDecoder', () => {
    it('loads bounded artifacts, opens MPEG-2, and closes exactly once', async () => {
        const harness = createHarness();
        const decoder = createDecoder(harness, []);

        await decoder.init();
        decoder.close();
        decoder.close();

        expect(harness.resolveAssetURL).toHaveBeenNthCalledWith(
            1,
            'libraries/legacy-video/legacy-video-decode.js'
        );
        expect(harness.resolveAssetURL).toHaveBeenNthCalledWith(
            2,
            'libraries/legacy-video/legacy-video-decode.wasm'
        );
        expect(harness.loadDecoderGlue).toHaveBeenCalledWith(
            'https://example.test/web/libraries/legacy-video/legacy-video-decode.js'
        );
        expect(harness.createModule).toHaveBeenCalledWith(
            'https://example.test/web/libraries/legacy-video/legacy-video-decode.wasm'
        );
        expect(harness.module._legacy_video_decoder_create).toHaveBeenCalledWith(
            1,
            4,
            2,
            0
        );
        expect(harness.module._legacy_video_decoder_close).toHaveBeenCalledOnce();
    });

    it('opens VC-1 with an owned decoder description', async () => {
        const harness = createHarness();
        const description = new Uint8Array([ 15, 219, 126, 59 ]);
        const decoder = new LegacySoftwareVideoDecoder({
            codec: 'vc1',
            codedHeight: 2,
            codedWidth: 4,
            description
        }, {
            onError: vi.fn(),
            onSample: vi.fn()
        }, harness.dependencies);

        await decoder.init();

        expect(harness.module._legacy_video_decoder_create).toHaveBeenCalledWith(
            2,
            4,
            2,
            description.byteLength
        );
        expect(harness.module.HEAPU8.slice(
            EXTRADATA_POINTER,
            EXTRADATA_POINTER + description.byteLength
        )).toEqual(description);
        decoder.close();
    });

    it('emits an owned progressive I420 sample with exact timing and metadata', async () => {
        const harness = createHarness();
        harness.module.sendFrameBatches.push([ {
            bottomCrop: 0,
            colorMatrix: 6,
            colorPrimaries: 6,
            colorRange: 1,
            colorTransfer: 6,
            duration: BigInt(0),
            timestamp: BigInt(1_250_000)
        } ]);
        const samples: VideoSample[] = [];
        const decoder = createDecoder(harness, samples);
        await decoder.init();

        decoder.decode(createPacket());

        expect(harness.module.HEAPU8.slice(PACKET_POINTER, PACKET_POINTER + 3))
            .toEqual(new Uint8Array([ 31, 32, 33 ]));
        expect(harness.module._legacy_video_decoder_send_packet).toHaveBeenCalledWith(
            DECODER_POINTER,
            BigInt(1_250_000),
            BigInt(1_250_000),
            BigInt(500_000),
            1
        );
        expect(samples).toHaveLength(1);
        expect(samples[0]).toMatchObject({
            displayHeight: 9,
            displayWidth: 16,
            duration: 0.5,
            format: 'I420',
            timestamp: 1.25,
            visibleRect: { height: 2, left: 0, top: 0, width: 4 }
        });
        expect(samples[0].colorSpace.toJSON()).toEqual({
            fullRange: false,
            matrix: 'smpte170m',
            primaries: 'smpte170m',
            transfer: 'smpte170m'
        });
        const output = new Uint8Array(samples[0].allocationSize());
        const layouts = await samples[0].copyTo(output);
        expect(layouts).toEqual([
            { offset: 0, stride: 4 },
            { offset: 8, stride: 2 },
            { offset: 10, stride: 2 }
        ]);
        expect(output).toEqual(new Uint8Array([
            1, 2, 3, 4,
            5, 6, 7, 8,
            9, 10,
            11, 12
        ]));
        samples[0].close();
        decoder.close();
    });

    it('drains delayed reordered pictures at end of stream', async () => {
        const harness = createHarness();
        harness.module.sendFrameBatches.push([]);
        harness.module.drainFrames.push({ timestamp: BigInt(1_250_000) });
        const samples: VideoSample[] = [];
        const decoder = createDecoder(harness, samples);
        await decoder.init();

        decoder.decode(createPacket());
        expect(samples).toHaveLength(0);
        decoder.flush();

        expect(samples).toHaveLength(1);
        samples[0].close();
        decoder.close();
    });

    it('replaces a zero-duration VFW timing placeholder at the same timestamp', async () => {
        const harness = createHarness();
        harness.module.sendFrameBatches.push([], [ {
            duration: BigInt(0),
            timestamp: BigInt(0)
        } ]);
        const samples: VideoSample[] = [];
        const decoder = createDecoder(harness, samples);
        await decoder.init();

        decoder.decode(new EncodedPacket(
            new Uint8Array([ 31, 32, 33 ]),
            'key',
            0,
            0
        ));
        decoder.decode(new EncodedPacket(
            new Uint8Array([ 34, 35, 36 ]),
            'delta',
            0,
            0.042
        ));

        expect(samples).toHaveLength(1);
        expect(samples[0]).toMatchObject({ duration: 0.042, timestamp: 0 });
        samples[0].close();
        decoder.close();
    });

    it('rejects interlaced output with its field metadata', async () => {
        const harness = createHarness();
        harness.module.sendFrameBatches.push([ {
            interlaced: true,
            repeatPicture: 1,
            topFieldFirst: true
        } ]);
        const decoder = createDecoder(harness, []);
        await decoder.init();

        let thrownError: unknown;
        try {
            decoder.decode(createPacket());
        } catch (error) {
            thrownError = error;
        }

        expect(thrownError).toBeInstanceOf(LegacyVideoInterlacedFrameError);
        expect(thrownError).toMatchObject({ repeatPicture: 1, topFieldFirst: true });
        decoder.close();
    });

    it('closes a sample rejected by its consumer', async () => {
        const harness = createHarness();
        harness.module.sendFrameBatches.push([ {} ]);
        let rejectedSample: VideoSample | null = null;
        const decoder = createDecoder(
            harness,
            [],
            (sample: VideoSample): never => {
                rejectedSample = sample;
                throw new Error('consumer failed');
            }
        );
        await decoder.init();

        expect(() => decoder.decode(createPacket())).toThrow('consumer failed');
        expect(rejectedSample).not.toBeNull();
        expect(() => rejectedSample?.allocationSize()).toThrow('closed');
        decoder.close();
    });

    it('fails closed on oversized configuration and contradictory output', async () => {
        const harness = createHarness();
        const oversizedDecoder = new LegacySoftwareVideoDecoder({
            codec: 'mpeg2video',
            codedHeight: 1_080,
            codedWidth: 1_921
        }, {
            onError: vi.fn(),
            onSample: vi.fn()
        }, harness.dependencies);
        await expect(oversizedDecoder.init()).rejects.toThrow('unsupported');
        expect(harness.module._legacy_video_decoder_create).not.toHaveBeenCalled();

        const missingDescriptionDecoder = new LegacySoftwareVideoDecoder({
            codec: 'vc1',
            codedHeight: 2,
            codedWidth: 4
        }, {
            onError: vi.fn(),
            onSample: vi.fn()
        }, harness.dependencies);
        await expect(missingDescriptionDecoder.init()).rejects.toThrow('description');

        const secondHarness = createHarness();
        secondHarness.module.sendFrameBatches.push([ { width: 5 } ]);
        const decoder = createDecoder(secondHarness, []);
        await decoder.init();
        expect(() => decoder.decode(createPacket())).toThrow(
            'dimensions exceed the configuration'
        );
        decoder.close();
    });
});
