// @vitest-environment node

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    createNativeSurroundAudioCapabilityFixture,
    NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT,
    NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE,
    NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_VERSION,
    type NativeSurroundAudioCapabilityFixtureCodec
} from './NativeSurroundAudioCapabilityFixtures';

type ExpectedBytes = Readonly<{
    byteLength: number
    sha256: string
}>;

type ExpectedFixture = Readonly<{
    chunks: readonly ExpectedBytes[]
    codecString: string
    description: ExpectedBytes
    expectedOutputFrameCount: number
}>;

const EXPECTED_FIXTURES: Readonly<Record<
    NativeSurroundAudioCapabilityFixtureCodec,
    ExpectedFixture
>> = Object.freeze({
    aac: Object.freeze({
        chunks: [ Object.freeze({
            byteLength: 36,
            sha256: 'f801c0edc793ec39235f4a94a5193ca1c9162b4ad5b97d35828f9bac729ce0db'
        }) ],
        codecString: 'mp4a.40.2',
        description: Object.freeze({
            byteLength: 5,
            sha256: '095b1ebec9252227728830de8b7d454f7a63695ebb5736aab4e7cc830b7b9466'
        }),
        expectedOutputFrameCount: 1_024
    }),
    flac: Object.freeze({
        chunks: [ Object.freeze({
            byteLength: 26,
            sha256: 'f8dd62c8dd89624d36bb8882bb621bcfbbbd1a3a5972e50ccfb2e8b89ddcd0df'
        }) ],
        codecString: 'flac',
        description: Object.freeze({
            byteLength: 42,
            sha256: '51ed4ba80b1acf6c174a58bf4c868b8d9b8c666c3abfedb2439a9fe293f9244a'
        }),
        expectedOutputFrameCount: 4_608
    }),
    opus: Object.freeze({
        chunks: [ Object.freeze({
            byteLength: 640,
            sha256: '97a531072bfe3122e9feb8fce17a04e2e7276fdd3cc8b87579feb870d9710b24'
        }) ],
        codecString: 'opus',
        description: Object.freeze({
            byteLength: 27,
            sha256: 'abfdad27f1038d32ec058f2f3d64dfb8d83bde84e6bf1a8d72e4b2a8c7c0b23f'
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
                byteLength: 2,
                sha256: '102b51b9765a56a3e899f7cf0ee38e5251f9c503b357b330a49183eb7b155604'
            })
        ],
        codecString: 'vorbis',
        description: Object.freeze({
            byteLength: 6_513,
            sha256: '78689c9026123b634c59084b652bff3996f38a213dc947b8466b48c1008356bc'
        }),
        expectedOutputFrameCount: 576
    })
});

function getSHA256(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

describe('native surround audio capability fixtures', () => {
    it.each(Object.entries(EXPECTED_FIXTURES))(
        'pins the exact %s 5.1 decoder fixture',
        (codecValue, expectedFixture) => {
            const codec = codecValue as NativeSurroundAudioCapabilityFixtureCodec;
            const fixture = createNativeSurroundAudioCapabilityFixture(codec);

            expect(NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_VERSION).toBe(1);
            expect(fixture).toMatchObject({
                codec,
                codecString: expectedFixture.codecString,
                expectedOutputFrameCount: expectedFixture.expectedOutputFrameCount,
                expectedOutputTimestamp: 0,
                numberOfChannels: NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT,
                sampleRate: NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE
            });
            expect(fixture.description).toHaveLength(expectedFixture.description.byteLength);
            expect(getSHA256(fixture.description)).toBe(expectedFixture.description.sha256);
            expect(fixture.encodedChunks).toHaveLength(expectedFixture.chunks.length);
            for (
                let chunkIndex = 0;
                chunkIndex < expectedFixture.chunks.length;
                chunkIndex += 1
            ) {
                const expectedChunk = expectedFixture.chunks[chunkIndex];
                const chunk = fixture.encodedChunks[chunkIndex];
                expect(chunk.data).toHaveLength(expectedChunk.byteLength);
                expect(getSHA256(chunk.data)).toBe(expectedChunk.sha256);
            }
        }
    );

    it('returns independent mutable descriptions and packet arrays', () => {
        const firstFixture = createNativeSurroundAudioCapabilityFixture('vorbis');
        const secondFixture = createNativeSurroundAudioCapabilityFixture('vorbis');
        const descriptionFirstByte = secondFixture.description[0];
        const packetFirstByte = secondFixture.encodedChunks[0].data[0];

        firstFixture.description[0] ^= 0xFF;
        firstFixture.encodedChunks[0].data[0] ^= 0xFF;

        expect(secondFixture.description[0]).toBe(descriptionFirstByte);
        expect(secondFixture.encodedChunks[0].data[0]).toBe(packetFirstByte);
    });
});
