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

import DTSSoftwareAudioDecoder, {
    DTS_PROFILE_DIGITAL_SURROUND
} from './DTSSoftwareAudioDecoder';
import { requireMicroseconds } from './TimeMath';

const MATROSKA_FIXTURE_PATH = resolve(
    process.cwd(),
    'scripts/webgpu/dts/fixtures/core_51_24_48_768_0.mka'
);

describe('Mediabunny DTS demux integration', () => {
    it('surfaces Matroska A_DTS packets for the owned decoder', async () => {
        const input = new Input({
            formats: ALL_FORMATS,
            source: new BufferSource(new Uint8Array(readFileSync(MATROSKA_FIXTURE_PATH)))
        });
        const decoder = await DTSSoftwareAudioDecoder.create();

        try {
            const tracks = await input.getAudioTracks();
            expect(tracks).toHaveLength(1);
            const track = tracks[0];
            expect(await track.getCodec()).toBeNull();
            expect(await track.getDecoderConfig()).toBeNull();
            expect(await track.getInternalCodecId()).toBe('A_DTS');
            expect(await track.getNumberOfChannels()).toBe(6);
            expect(await track.getSampleRate()).toBe(48_000);

            const packetSink = new EncodedPacketSink(track);
            let decodedPacketCount = 0;
            let positiveDurationPacketCount = 0;
            for await (const packet of packetSink.packets()) {
                const output = decoder.decode(
                    packet.data,
                    requireMicroseconds(packet.microsecondTimestamp)
                );
                expect(output).toMatchObject({
                    channelMask: 0x060f,
                    profile: DTS_PROFILE_DIGITAL_SURROUND,
                    sampleRate: 48_000
                });
                expect(packet.microsecondDuration).toBeGreaterThanOrEqual(0);
                if (packet.microsecondDuration > 0) {
                    positiveDurationPacketCount += 1;
                }
                decodedPacketCount += 1;
            }
            expect(decodedPacketCount).toBeGreaterThan(0);
            expect(positiveDurationPacketCount).toBeGreaterThan(0);
        } finally {
            decoder.close();
            await input.dispose();
        }
    });
});
