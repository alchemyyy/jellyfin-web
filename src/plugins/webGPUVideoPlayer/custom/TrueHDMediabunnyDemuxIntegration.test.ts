// @vitest-environment node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacketSink,
    Input
} from 'mediabunny';
import { describe, expect, it } from 'vitest';

import TrueHDSoftwareAudioDecoder from './TrueHDSoftwareAudioDecoder';
import { requireMicroseconds } from './TimeMath';

const MATROSKA_FIXTURE_PATH = resolve(
    process.cwd(),
    'scripts/webgpu/truehd/fixtures/truehd_51_side_24_96000.mka'
);

describe('Mediabunny TrueHD demux integration', () => {
    it('surfaces Matroska A_TRUEHD packets for the owned decoder', async () => {
        const input = new Input({
            formats: ALL_FORMATS,
            source: new BufferSource(new Uint8Array(readFileSync(MATROSKA_FIXTURE_PATH)))
        });
        const decoder = await TrueHDSoftwareAudioDecoder.create('truehd');

        try {
            const tracks = await input.getAudioTracks();
            expect(tracks).toHaveLength(1);
            const track = tracks[0];
            expect(await track.getCodec()).toBeNull();
            expect(await track.getDecoderConfig()).toBeNull();
            expect(await track.getInternalCodecId()).toBe('A_TRUEHD');
            expect(await track.getNumberOfChannels()).toBe(6);
            expect(await track.getSampleRate()).toBe(96_000);

            const packetSink = new EncodedPacketSink(track);
            let decodedOutputCount = 0;
            let positiveDurationPacketCount = 0;
            for await (const packet of packetSink.packets()) {
                const outputs = decoder.decode(
                    packet.data,
                    requireMicroseconds(packet.microsecondTimestamp)
                );
                for (const output of outputs) {
                    expect(output).toMatchObject({
                        channelMask: 0x060f,
                        codec: 'truehd',
                        losslessChannelBed: true,
                        objectAudioRendered: false,
                        sampleRate: 96_000
                    });
                    decodedOutputCount += 1;
                }
                expect(packet.microsecondDuration).toBeGreaterThanOrEqual(0);
                if (packet.microsecondDuration > 0) {
                    positiveDurationPacketCount += 1;
                }
            }
            expect(decodedOutputCount).toBeGreaterThan(0);
            expect(positiveDurationPacketCount).toBeGreaterThan(0);
        } finally {
            decoder.close();
            await input.dispose();
        }
    });
});
