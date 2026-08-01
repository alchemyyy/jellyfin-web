import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacketSink,
    Input,
    type InputAudioTrack
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import { millisecondsToMicroseconds, type Microseconds } from '../MediaTime';
import NativeMediaAudioFMP4Remuxer, {
    type NativeMediaAudioFMP4Codec,
    type NativeMediaAudioFMP4RemuxOutput
} from './NativeMediaAudioFMP4Remuxer';
import { createNativeMediaAudioProbeFixture } from './NativeMediaAudioCapabilityFixtures';
import { requireMicroseconds } from './TimeMath';

function getTopLevelBoxTypes(data: Uint8Array): string[] {
    const boxTypes: string[] = [];
    let byteOffset = 0;
    while (byteOffset + 8 <= data.byteLength) {
        const dataView = new DataView(data.buffer, data.byteOffset + byteOffset);
        const byteLength = dataView.getUint32(0);
        if (byteLength < 8 || byteOffset + byteLength > data.byteLength) {
            throw new RangeError('Invalid fragmented MP4 box boundary');
        }
        boxTypes.push(String.fromCharCode(
            dataView.getUint8(4),
            dataView.getUint8(5),
            dataView.getUint8(6),
            dataView.getUint8(7)
        ));
        byteOffset += byteLength;
    }
    if (byteOffset !== data.byteLength) {
        throw new RangeError('Fragmented MP4 data ended inside a box');
    }
    return boxTypes;
}

async function remuxFixture(codec: NativeMediaAudioFMP4Codec): Promise<{
    outputs: NativeMediaAudioFMP4RemuxOutput[]
    remuxer: NativeMediaAudioFMP4Remuxer
}> {
    const fixture = createNativeMediaAudioProbeFixture(codec, 2);
    const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(fixture)
    });
    try {
        const audioTracks = await input.getAudioTracks();
        const audioTrack = audioTracks[0] as InputAudioTrack | undefined;
        if (!audioTrack) {
            throw new Error('Fixture audio track is unavailable');
        }
        const decoderConfig = await audioTrack.getDecoderConfig();
        if (!decoderConfig) {
            throw new Error('Fixture decoder configuration is unavailable');
        }
        const remuxer = new NativeMediaAudioFMP4Remuxer({
            channelCount: 2,
            codec,
            decoderConfig,
            fragmentDurationMicroseconds: millisecondsToMicroseconds(64),
            sampleRate: 48_000
        });
        const outputs: NativeMediaAudioFMP4RemuxOutput[] = [];
        const packetSink = new EncodedPacketSink(audioTrack);
        await remuxer.start();
        for await (const packet of packetSink.packets()) {
            await remuxer.addPacket({
                data: packet.data,
                durationMicroseconds: requireMicroseconds(packet.microsecondDuration),
                sequenceNumber: packet.sequenceNumber,
                timestampMicroseconds: requireMicroseconds(packet.microsecondTimestamp),
                type: packet.type
            });
            outputs.push(remuxer.takeOutput());
        }
        await remuxer.finalize();
        outputs.push(remuxer.takeOutput());
        return { outputs, remuxer };
    } finally {
        input.dispose();
    }
}

describe.each<NativeMediaAudioFMP4Codec>([ 'ac3', 'eac3' ])(
    'NativeMediaAudioFMP4Remuxer %s',
    codec => {
        it('produces one initialization segment and bounded media fragments', async () => {
            const { outputs, remuxer } = await remuxFixture(codec);
            const initializationSegments = outputs
                .map(output => output.initializationSegment)
                .filter((segment): segment is Uint8Array => segment !== null);
            const mediaSegments = outputs.flatMap(output => output.mediaSegments);

            expect(initializationSegments).toHaveLength(1);
            expect(getTopLevelBoxTypes(initializationSegments[0])).toEqual([ 'ftyp', 'moov' ]);
            expect(mediaSegments.length).toBeGreaterThan(1);

            let previousEndTimeMicroseconds: Microseconds | null = null;
            for (const segment of mediaSegments) {
                expect(getTopLevelBoxTypes(segment.data)).toEqual([ 'moof', 'mdat' ]);
                expect(segment.endTimeMicroseconds).toBeGreaterThan(segment.startTimeMicroseconds);
                expect(segment.endTimeMicroseconds - segment.startTimeMicroseconds)
                    .toBeLessThanOrEqual(millisecondsToMicroseconds(2_000));
                if (previousEndTimeMicroseconds !== null) {
                    expect(segment.startTimeMicroseconds).toBeGreaterThanOrEqual(
                        previousEndTimeMicroseconds
                    );
                }
                previousEndTimeMicroseconds = segment.endTimeMicroseconds;
            }

            const telemetry = remuxer.getTelemetry();
            expect(telemetry.finalized).toBe(true);
            expect(telemetry.encodedPacketCount).toBeGreaterThan(1);
            expect(telemetry.initializationSegmentByteLength).toBeGreaterThan(0);
            expect(telemetry.mediaSegmentCount).toBe(mediaSegments.length);
            expect(telemetry.pendingMediaSegmentCount).toBe(0);
        });
    }
);

describe('NativeMediaAudioFMP4Remuxer validation', () => {
    it('rejects mismatched routes and invalid packet ordering', async () => {
        expect(() => new NativeMediaAudioFMP4Remuxer({
            channelCount: 2,
            codec: 'ac3',
            decoderConfig: {
                codec: 'ec-3',
                numberOfChannels: 2,
                sampleRate: 48_000
            },
            sampleRate: 48_000
        })).toThrow('codec does not match');

        const remuxer = new NativeMediaAudioFMP4Remuxer({
            channelCount: 2,
            codec: 'ac3',
            decoderConfig: {
                codec: 'ac-3',
                numberOfChannels: 2,
                sampleRate: 48_000
            },
            sampleRate: 48_000
        });
        await expect(remuxer.addPacket({
            data: new Uint8Array([ 1 ]),
            durationMicroseconds: millisecondsToMicroseconds(32),
            sequenceNumber: 0,
            timestampMicroseconds: millisecondsToMicroseconds(0),
            type: 'key'
        })).rejects.toThrow('has not started');
        await remuxer.cancel();
    });
});
