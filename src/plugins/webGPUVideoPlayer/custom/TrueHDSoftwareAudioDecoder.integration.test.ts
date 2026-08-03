import { describe, expect, it } from 'vitest';

import { createTrueHDExactCapabilityFixtures } from './TrueHDExactCapabilityFixtures';
import TrueHDSoftwareAudioDecoder, {
    type TrueHDDecodedAudioOutput
} from './TrueHDSoftwareAudioDecoder';

describe('TrueHDSoftwareAudioDecoder WebAssembly integration', () => {
    it('matches native FFmpeg PCM for every synthetic qualification frame', async () => {
        const fixtures = createTrueHDExactCapabilityFixtures();

        for (const fixture of fixtures) {
            const decoder = await TrueHDSoftwareAudioDecoder.create(fixture.codec);
            try {
                const outputs: TrueHDDecodedAudioOutput[] = [];
                for (let accessUnitIndex = 0;
                    accessUnitIndex < fixture.accessUnits.length;
                    accessUnitIndex += 1) {
                    outputs.push(...decoder.decode(
                        fixture.accessUnits[accessUnitIndex],
                        fixture.expectedOutputs[accessUnitIndex].mediaTimeMicroseconds
                    ));
                }

                expect(outputs).toHaveLength(fixture.expectedOutputs.length);
                for (let outputIndex = 0;
                    outputIndex < fixture.expectedOutputs.length;
                    outputIndex += 1) {
                    const output = outputs[outputIndex];
                    const expected = fixture.expectedOutputs[outputIndex];
                    expect(output).toMatchObject({
                        bitsPerSample: fixture.bitsPerSample,
                        channelMask: fixture.channelMask,
                        codec: fixture.codec,
                        frameCount: expected.frameCount,
                        losslessChannelBed: true,
                        mediaTimeMicroseconds: expected.mediaTimeMicroseconds,
                        objectAudioRendered: false,
                        pcmFingerprint: expected.pcmFingerprint,
                        sampleRate: fixture.sampleRate
                    });
                }
            } finally {
                decoder.close();
            }
        }
    }, 30_000);

    it('recovers at the next major sync after starting on a dependent frame', async () => {
        const fixture = createTrueHDExactCapabilityFixtures().find(
            candidate => candidate.codec === 'truehd' && candidate.sampleRate === 48_000
        );
        expect(fixture).toBeDefined();
        if (!fixture) {
            return;
        }
        const decoder = await TrueHDSoftwareAudioDecoder.create('truehd');
        try {
            const outputs: TrueHDDecodedAudioOutput[] = [];
            for (let accessUnitIndex = fixture.majorSyncRecoveryStartIndex;
                accessUnitIndex < fixture.accessUnits.length;
                accessUnitIndex += 1) {
                outputs.push(...decoder.decode(
                    fixture.accessUnits[accessUnitIndex],
                    fixture.expectedOutputs[accessUnitIndex].mediaTimeMicroseconds
                ));
            }

            expect(outputs.length).toBeGreaterThan(0);
            const firstExpectedOutput = fixture.expectedOutputs.find(expected => (
                expected.mediaTimeMicroseconds === outputs[0].mediaTimeMicroseconds
            ));
            expect(firstExpectedOutput).toBeDefined();
            expect(outputs[0].pcmFingerprint).toBe(firstExpectedOutput?.pcmFingerprint);
        } finally {
            decoder.close();
        }
    }, 30_000);
});
