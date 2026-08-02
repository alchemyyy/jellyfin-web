// @vitest-environment node

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    createNativeAudioCapabilityFixture,
    NATIVE_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT,
    NATIVE_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE,
    NATIVE_AUDIO_CAPABILITY_FIXTURE_VERSION,
    type NativeAudioCapabilityFixtureCodec
} from './NativeAudioCapabilityFixtures';

type ExpectedBytes = Readonly<{
    byteLength: number
    sha256: string
}>;

type ExpectedFixture = Readonly<{
    chunks: readonly ExpectedBytes[]
    codecString: string
    description: ExpectedBytes | null
    expectedOutputFrameCount: number
}>;

const EXPECTED_FIXTURES: Readonly<Record<
    NativeAudioCapabilityFixtureCodec,
    ExpectedFixture
>> = Object.freeze({
    aac: Object.freeze({
        chunks: [ Object.freeze({
            byteLength: 23,
            sha256: 'e4f7e7f3c1ee004ad8c554212461102747e87c1bba4e1b9e5d658dcd01854efb'
        }) ],
        codecString: 'mp4a.40.2',
        description: Object.freeze({
            byteLength: 5,
            sha256: 'b3108813350006ef07740046fab14af9c374938867d16db02fe1a8baa5e72f10'
        }),
        expectedOutputFrameCount: 1_024
    }),
    flac: Object.freeze({
        chunks: [ Object.freeze({
            byteLength: 14,
            sha256: '2c8bb708c036bc3956b8b3956b0b97d1fb040336df4ed23eb791f6fa672f2f87'
        }) ],
        codecString: 'flac',
        description: Object.freeze({
            byteLength: 42,
            sha256: '11faccc3256068b1fcfd1b3a971afb7e5f496a3c634904c63d2a825e64202b30'
        }),
        expectedOutputFrameCount: 4_608
    }),
    mp3: Object.freeze({
        chunks: [ Object.freeze({
            byteLength: 384,
            sha256: '0950c4059c3fc3bc9b5d156803acae33163112c6c6c79197a1b792383bfd6680'
        }) ],
        codecString: 'mp3',
        description: null,
        expectedOutputFrameCount: 1_152
    }),
    opus: Object.freeze({
        chunks: [ Object.freeze({
            byteLength: 240,
            sha256: '02a47e4ec1700c960beefc7967f13e0e83aa87b78d738597c422e0fa8a351f62'
        }) ],
        codecString: 'opus',
        description: Object.freeze({
            byteLength: 19,
            sha256: 'e1ca6670203e4713d51d3768e199ca5bf1f8e3740a28a2d378feafdf8b6429c6'
        }),
        expectedOutputFrameCount: 648
    }),
    vorbis: Object.freeze({
        chunks: [
            Object.freeze({
                byteLength: 1,
                sha256: '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d'
            }),
            Object.freeze({
                byteLength: 1,
                sha256: '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b'
            })
        ],
        codecString: 'vorbis',
        description: Object.freeze({
            byteLength: 3_929,
            sha256: 'ea507c1129d31d522ba70466f1bdfd61cd592308498d6aea6c1d91f3ef4c601f'
        }),
        expectedOutputFrameCount: 576
    })
});

function getSHA256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

describe('native audio capability fixtures', () => {
    it.each(Object.entries(EXPECTED_FIXTURES))(
        'pins the exact %s decoder fixture',
        (codecValue, expectedFixture) => {
            const codec = codecValue as NativeAudioCapabilityFixtureCodec;
            const fixture = createNativeAudioCapabilityFixture(codec);

            expect(NATIVE_AUDIO_CAPABILITY_FIXTURE_VERSION).toBe(1);
            expect(fixture).toMatchObject({
                codec,
                codecString: expectedFixture.codecString,
                expectedOutputFrameCount: expectedFixture.expectedOutputFrameCount,
                expectedOutputTimestamp: 0,
                numberOfChannels: NATIVE_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT,
                sampleRate: NATIVE_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE
            });
            if (expectedFixture.description === null) {
                expect(fixture.description).toBeNull();
            } else {
                expect(fixture.description).toHaveLength(expectedFixture.description.byteLength);
                expect(getSHA256(fixture.description ?? new Uint8Array())).toBe(
                    expectedFixture.description.sha256
                );
            }
            expect(fixture.encodedChunks).toHaveLength(expectedFixture.chunks.length);
            for (let chunkIndex = 0; chunkIndex < expectedFixture.chunks.length; chunkIndex += 1) {
                const expectedChunk = expectedFixture.chunks[chunkIndex];
                const chunk = fixture.encodedChunks[chunkIndex];
                expect(chunk.data).toHaveLength(expectedChunk.byteLength);
                expect(getSHA256(chunk.data)).toBe(expectedChunk.sha256);
            }
        }
    );

    it('returns independent mutable descriptions and packet arrays', () => {
        const firstFixture = createNativeAudioCapabilityFixture('vorbis');
        const secondFixture = createNativeAudioCapabilityFixture('vorbis');
        const descriptionFirstByte = secondFixture.description?.[0];
        const packetFirstByte = secondFixture.encodedChunks[0].data[0];

        if (firstFixture.description) {
            firstFixture.description[0] ^= 0xFF;
        }
        firstFixture.encodedChunks[0].data[0] ^= 0xFF;

        expect(secondFixture.description?.[0]).toBe(descriptionFirstByte);
        expect(secondFixture.encodedChunks[0].data[0]).toBe(packetFirstByte);
    });
});
