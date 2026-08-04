import { EncodedPacket } from 'mediabunny';
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
import { parseHEVCSPS } from './HEVCSPSParser';

function createBytesFromHex(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
        bytes[byteIndex] = Number.parseInt(hex.slice(byteIndex * 2, (byteIndex * 2) + 2), 16);
    }
    return bytes;
}

const MAIN10_PQ_SPS = createBytesFromHex(
    '4201010220000003009000000300000300ffa005020169365959a4932bc05a848804820000030002000003000210'
);

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

function encodeLengthPrefixedNALUnits(nalUnits: readonly Uint8Array[]): Uint8Array {
    const lengthByteLength = 4;
    const byteLength = nalUnits.reduce(
        (totalByteLength: number, nalUnit: Uint8Array): number => (
            totalByteLength + lengthByteLength + nalUnit.byteLength
        ),
        0
    );
    const output = new Uint8Array(byteLength);
    let offset = 0;
    for (const nalUnit of nalUnits) {
        let remainingLength = nalUnit.byteLength;
        for (let byteIndex = lengthByteLength - 1; byteIndex >= 0; byteIndex -= 1) {
            output[offset + byteIndex] = remainingLength % 256;
            remainingLength = Math.floor(remainingLength / 256);
        }
        offset += lengthByteLength;
        output.set(nalUnit, offset);
        offset += nalUnit.byteLength;
    }
    return output;
}

function getFirstAnnexBNALUnit(accessUnit: Uint8Array): Uint8Array {
    for (let offset = 4; offset + 4 <= accessUnit.byteLength; offset += 1) {
        if (
            accessUnit[offset] === 0
            && accessUnit[offset + 1] === 0
            && accessUnit[offset + 2] === 0
            && accessUnit[offset + 3] === 1
        ) {
            return accessUnit.subarray(4, offset);
        }
    }
    throw new TypeError('The test access unit has no second Annex B start code');
}

function getFirstLengthPrefixedNALUnit(accessUnit: Uint8Array): Uint8Array {
    const lengthByteLength = 4;
    let nalUnitByteLength = 0;
    for (let byteIndex = 0; byteIndex < lengthByteLength; byteIndex += 1) {
        nalUnitByteLength = (nalUnitByteLength * 256) + accessUnit[byteIndex];
    }
    return accessUnit.subarray(
        lengthByteLength,
        lengthByteLength + nalUnitByteLength
    );
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
            { onError: vi.fn(), onFrame: vi.fn(), onProgress },
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
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
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

    it('neutralizes decoder and in-band HDR color metadata when requested', async () => {
        const harness = createHarness();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L120.B0', codedHeight: 1_080, codedWidth: 1_920 },
            { kind: 'annex-b' },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            harness.dependencies,
            { nativeHDRTransfer: 'pq', neutralizeHDRColorMetadata: true }
        );
        await decoder.init();

        expect(harness.decoder.configure).toHaveBeenCalledWith(expect.objectContaining({
            colorSpace: {
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            }
        }));

        const originalData = encodeAnnexBNALUnits([
            MAIN10_PQ_SPS,
            createNALUnit(19, [ 1 ])
        ]);
        expect(decoder.decode(createPacket(originalData, 0))).toBe(true);
        expect(harness.packets).toHaveLength(1);
        expect(harness.packets[0].data).not.toBe(originalData);
        expect(parseHEVCSPS(getFirstAnnexBNALUnit(harness.packets[0].data)).colorSpace)
            .toEqual({
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            });
        decoder.close();
    });

    it('neutralizes length-prefixed key SPS and preserves a key packet without SPS', async () => {
        const harness = createHarness();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L120.B0', codedHeight: 1_080, codedWidth: 1_920 },
            { kind: 'length-prefixed', lengthSize: 4 },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            harness.dependencies,
            { nativeHDRTransfer: 'pq', neutralizeHDRColorMetadata: true }
        );
        await decoder.init();

        const packetWithSPS = createPacket(encodeLengthPrefixedNALUnits([
            MAIN10_PQ_SPS,
            createNALUnit(19, [ 1 ])
        ]), 0);
        const packetWithoutSPS = createPacket(
            encodeLengthPrefixedNALUnits([ createNALUnit(19, [ 2 ]) ]),
            1
        );
        expect(decoder.decode(packetWithSPS)).toBe(true);
        expect(decoder.decode(packetWithoutSPS)).toBe(true);

        expect(parseHEVCSPS(getFirstLengthPrefixedNALUnit(harness.packets[0].data)).colorSpace)
            .toEqual({
                fullRange: false,
                matrix: 'bt709',
                primaries: 'bt709',
                transfer: 'bt709'
            });
        expect(harness.packets[1]).toBe(packetWithoutSPS);
        decoder.close();
    });

    it('rejects native HDR packets before an exact SPS proves the route', async () => {
        const missingSPSHarness = createHarness();
        const missingSPSDecoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L120.B0', codedHeight: 1_080, codedWidth: 1_920 },
            { kind: 'annex-b' },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            missingSPSHarness.dependencies,
            { nativeHDRTransfer: 'pq', neutralizeHDRColorMetadata: true }
        );
        await missingSPSDecoder.init();
        expect(() => missingSPSDecoder.decode(createPacket(
            encodeAnnexBNALUnits([ createNALUnit(19, [ 1 ]) ]),
            0
        ))).toThrow('validated HEVC SPS');
        expect(missingSPSHarness.packets).toHaveLength(0);
        missingSPSDecoder.close();

        const mismatchedTransferHarness = createHarness();
        const mismatchedTransferDecoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L120.B0', codedHeight: 1_080, codedWidth: 1_920 },
            { kind: 'annex-b' },
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
            mismatchedTransferHarness.dependencies,
            { nativeHDRTransfer: 'hlg', neutralizeHDRColorMetadata: true }
        );
        await mismatchedTransferDecoder.init();
        expect(() => mismatchedTransferDecoder.decode(createPacket(
            encodeAnnexBNALUnits([ MAIN10_PQ_SPS, createNALUnit(19, [ 1 ]) ]),
            0
        ))).toThrow('expected limited-range BT.2020 HDR route');
        expect(mismatchedTransferHarness.packets).toHaveLength(0);
        mismatchedTransferDecoder.close();
    });

    it('transfers native frame ownership directly and closes stale callbacks', async () => {
        vi.stubGlobal('VideoFrame', FakeVideoFrame);
        const harness = createHarness();
        const frames: VideoFrame[] = [];
        const onProgress = vi.fn();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            {
                onError: vi.fn(),
                onFrame: (frame: VideoFrame): void => {
                    frames.push(frame);
                },
                onProgress
            },
            harness.dependencies
        );
        await decoder.init();
        const firstFrame = new FakeVideoFrame();

        harness.init?.output(firstFrame as unknown as VideoFrame);
        expect(frames).toEqual([ firstFrame ]);
        frames[0].close();
        expect(firstFrame.close).toHaveBeenCalledOnce();
        expect(onProgress).toHaveBeenCalledOnce();

        decoder.close();
        const staleFrame = new FakeVideoFrame();
        harness.init?.output(staleFrame as unknown as VideoFrame);
        expect(staleFrame.close).toHaveBeenCalledOnce();
        expect(frames).toHaveLength(1);
    });

    it('closes failed output ownership when the frame callback rejects it', async () => {
        vi.stubGlobal('VideoFrame', FakeVideoFrame);
        const harness = createHarness();
        const outputError = new Error('frame rejected');
        const onError = vi.fn();
        const decoder = new OwnedNativeHEVCVideoDecoder(
            { codec: 'hvc1.2.4.L153.B0' },
            { kind: 'annex-b' },
            {
                onError,
                onFrame: (): never => {
                    throw outputError;
                },
                onProgress: vi.fn()
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
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
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
            { onError: vi.fn(), onFrame: vi.fn(), onProgress: vi.fn() },
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
