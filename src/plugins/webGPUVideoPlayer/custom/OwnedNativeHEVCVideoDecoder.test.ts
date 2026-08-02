import { EncodedPacket, type VideoSample } from 'mediabunny';
import {
    afterEach,
    describe,
    expect,
    it,
    vi
} from 'vitest';

import OwnedNativeHEVCVideoDecoder, {
    type NativeVideoDecoderPort,
    type OwnedNativeHEVCVideoDecoderDependencies
} from './OwnedNativeHEVCVideoDecoder';

function createNALUnit(type: number, payload: readonly number[]): Uint8Array {
    return new Uint8Array([ (type & 0x3F) << 1, 1, ...payload ]);
}

function encodeAnnexBNALUnits(nalUnits: readonly Uint8Array[]): Uint8Array {
    const startCode = new Uint8Array([ 0, 0, 0, 1 ]);
    const byteLength = nalUnits.reduce(
        (totalByteLength: number, nalUnit: Uint8Array): number => (
            totalByteLength + startCode.byteLength + nalUnit.byteLength
        ),
        0
    );
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const nalUnit of nalUnits) {
        output.set(startCode, offset);
        offset += startCode.byteLength;
        output.set(nalUnit, offset);
        offset += nalUnit.byteLength;
    }
    return output;
}

function createPacket(data: Uint8Array, sequenceNumber: number): EncodedPacket {
    return new EncodedPacket(data, 'key', sequenceNumber / 24, 1 / 24, sequenceNumber);
}

class FakeVideoFrame {
    public readonly codedHeight = 1_080;
    public readonly codedWidth = 1_920;
    public readonly colorSpace = {
        fullRange: false,
        matrix: 'bt2020-ncl',
        primaries: 'bt2020',
        transfer: 'pq'
    };
    public readonly displayHeight = 1_080;
    public readonly displayWidth = 1_920;
    public readonly duration = 41_667;
    public readonly format = 'I420P10';
    public readonly timestamp = 1_000_000;
    public readonly visibleRect = { height: 1_080, width: 1_920, x: 0, y: 0 };
    public readonly close = vi.fn();
}

class FakeNativeVideoDecoder implements NativeVideoDecoderPort {
    public readonly close = vi.fn();
    public readonly configure = vi.fn();
    public readonly decode = vi.fn();
    public decodeQueueSize = 0;
    public readonly flush = vi.fn(async (): Promise<void> => undefined);
    public ondequeue: ((event: Event) => unknown) | null = null;
}

type DecoderHarness = {
    decoder: FakeNativeVideoDecoder
    dependencies: OwnedNativeHEVCVideoDecoderDependencies
    init: VideoDecoderInit | null
    packets: EncodedPacket[]
};

function createHarness(): DecoderHarness {
    const harness: DecoderHarness = {
        decoder: new FakeNativeVideoDecoder(),
        dependencies: null as unknown as OwnedNativeHEVCVideoDecoderDependencies,
        init: null,
        packets: []
    };
    harness.dependencies = {
        createDecoder: (init: VideoDecoderInit): NativeVideoDecoderPort => {
            harness.init = init;
            return harness.decoder;
        },
        createEncodedVideoChunk: (packet: EncodedPacket): EncodedVideoChunk => {
            harness.packets.push(packet);
            return { packet } as unknown as EncodedVideoChunk;
        }
    };
    return harness;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('OwnedNativeHEVCVideoDecoder', () => {
    it('configures one owned decoder and reports dequeue progress', async () => {
        const harness = createHarness();
        const onProgress = vi.fn();
        const config: VideoDecoderConfig = { codec: 'hvc1.2.4.L153.B0' };
        const decoder = new OwnedNativeHEVCVideoDecoder(
            config,
            { kind: 'annex-b' },
            { onError: vi.fn(), onProgress, onSample: vi.fn() },
            harness.dependencies
        );

        await decoder.init();
        expect(harness.decoder.configure).toHaveBeenCalledWith(config);
        harness.decoder.decodeQueueSize = 3;
        expect(decoder.getDecodeQueueSize()).toBe(3);
        harness.decoder.ondequeue?.(new Event('dequeue'));
        expect(onProgress).toHaveBeenCalledOnce();
        decoder.close();
        decoder.close();
        expect(harness.decoder.close).toHaveBeenCalledOnce();
    });

    it('sanitizes the first access unit and drops leading RASL pictures', async () => {
        const harness = createHarness();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            { onError: vi.fn(), onProgress: vi.fn(), onSample: vi.fn() },
            harness.dependencies
        );
        await decoder.init();
        const picture = createNALUnit(19, [ 1 ]);
        const lateParameterSet = createNALUnit(32, [ 2 ]);

        expect(decoder.decode(createPacket(
            encodeAnnexBNALUnits([ picture, lateParameterSet ]),
            0
        ))).toBe(true);
        expect(decoder.decode(createPacket(
            encodeAnnexBNALUnits([ createNALUnit(8, [ 3 ]) ]),
            1
        ))).toBe(false);
        expect(decoder.decode(createPacket(
            encodeAnnexBNALUnits([ createNALUnit(1, [ 4 ]) ]),
            2
        ))).toBe(true);

        expect(harness.packets).toHaveLength(2);
        expect(harness.packets[0].data).toEqual(encodeAnnexBNALUnits([ picture ]));
        expect(harness.packets[1].sequenceNumber).toBe(2);
        decoder.close();
    });

    it('wraps native output as an owned VideoSample and closes stale callbacks', async () => {
        vi.stubGlobal('VideoFrame', FakeVideoFrame);
        const harness = createHarness();
        const samples: VideoSample[] = [];
        const onProgress = vi.fn();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            {
                onError: vi.fn(),
                onProgress,
                onSample: (sample: VideoSample): void => {
                    samples.push(sample);
                }
            },
            harness.dependencies
        );
        await decoder.init();
        const firstFrame = new FakeVideoFrame();

        harness.init?.output(firstFrame as unknown as VideoFrame);
        expect(samples).toHaveLength(1);
        expect(samples[0].microsecondTimestamp).toBe(1_000_000);
        samples[0].close();
        expect(firstFrame.close).toHaveBeenCalledOnce();
        expect(onProgress).toHaveBeenCalledOnce();

        decoder.close();
        const staleFrame = new FakeVideoFrame();
        harness.init?.output(staleFrame as unknown as VideoFrame);
        expect(staleFrame.close).toHaveBeenCalledOnce();
        expect(samples).toHaveLength(1);
    });

    it('closes failed output ownership when the sample callback rejects it', async () => {
        vi.stubGlobal('VideoFrame', FakeVideoFrame);
        const harness = createHarness();
        const outputError = new Error('sample rejected');
        const onError = vi.fn();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            {
                onError,
                onProgress: vi.fn(),
                onSample: (): never => {
                    throw outputError;
                }
            },
            harness.dependencies
        );
        await decoder.init();
        const frame = new FakeVideoFrame();

        harness.init?.output(frame as unknown as VideoFrame);

        expect(frame.close).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledOnce();
        expect(onError).toHaveBeenCalledWith(outputError);
        decoder.close();
    });

    it('closes a decoder whose initial configuration fails', async () => {
        const harness = createHarness();
        const configurationError = new Error('configuration failed');
        harness.decoder.configure.mockImplementation((): never => {
            throw configurationError;
        });
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            { onError: vi.fn(), onProgress: vi.fn(), onSample: vi.fn() },
            harness.dependencies
        );

        await expect(decoder.init()).rejects.toBe(configurationError);
        expect(harness.decoder.ondequeue).toBeNull();
        expect(harness.decoder.close).toHaveBeenCalledOnce();
        decoder.close();
        expect(harness.decoder.close).toHaveBeenCalledOnce();
    });

    it('resets packet sanitization and RASL state after flush', async () => {
        const harness = createHarness();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            { onError: vi.fn(), onProgress: vi.fn(), onSample: vi.fn() },
            harness.dependencies
        );
        await decoder.init();
        const picture = createNALUnit(19, [ 1 ]);
        const lateParameterSet = createNALUnit(32, [ 2 ]);
        const firstPacket = createPacket(
            encodeAnnexBNALUnits([ picture, lateParameterSet ]),
            0
        );

        expect(decoder.decode(firstPacket)).toBe(true);
        expect(decoder.decode(createPacket(
            encodeAnnexBNALUnits([ createNALUnit(8, [ 3 ]) ]),
            1
        ))).toBe(false);
        await decoder.flush();
        expect(decoder.decode(firstPacket)).toBe(true);

        expect(harness.decoder.flush).toHaveBeenCalledOnce();
        expect(harness.packets).toHaveLength(2);
        expect(harness.packets[0].data).toEqual(encodeAnnexBNALUnits([ picture ]));
        expect(harness.packets[1].data).toEqual(encodeAnnexBNALUnits([ picture ]));
        decoder.close();
    });
});
