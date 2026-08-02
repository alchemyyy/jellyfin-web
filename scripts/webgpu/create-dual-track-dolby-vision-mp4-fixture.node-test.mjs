import assert from 'node:assert/strict';
import test from 'node:test';

import {
    FixtureError,
    patchDualTrackDolbyVisionMP4
} from './create-dual-track-dolby-vision-mp4-fixture.mjs';

const VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH = 78;

function concatenate(parts) {
    return Buffer.concat(parts.map(part => Buffer.from(part)));
}

function unsigned32(value) {
    const output = Buffer.alloc(4);
    output.writeUInt32BE(value);
    return output;
}

function box(type, payload = Buffer.alloc(0)) {
    const output = Buffer.alloc(payload.byteLength + 8);
    output.writeUInt32BE(output.byteLength, 0);
    output.write(type, 4, 4, 'ascii');
    Buffer.from(payload).copy(output, 8);
    return output;
}

function fullBox(type, payload, version = 0) {
    return box(type, concatenate([
        Buffer.from([ version, 0, 0, 0 ]),
        payload
    ]));
}

function createHEVCConfiguration(seed = 0x20) {
    const configuration = Buffer.alloc(23);
    configuration[0] = 1;
    for (let byteIndex = 1; byteIndex < configuration.byteLength; byteIndex += 1) {
        configuration[byteIndex] = (seed + byteIndex) & 0xFF;
    }
    return configuration;
}

function createDolbyVisionConfiguration(options = {}) {
    const configuration = Buffer.alloc(24);
    configuration[0] = 1;
    const bits = ((options.profile ?? 7) << 9)
        | (6 << 3)
        | ((options.rpuPresent ?? true) ? 4 : 0)
        | ((options.enhancementLayerPresent ?? true) ? 2 : 0)
        | ((options.baseLayerPresent ?? true) ? 1 : 0);
    configuration.writeUInt16BE(bits, 2);
    return configuration;
}

function createTrack(options) {
    const trackHeader = fullBox('tkhd', concatenate([
        Buffer.alloc(8),
        unsigned32(options.id)
    ]));
    const handler = fullBox('hdlr', concatenate([
        Buffer.alloc(4),
        Buffer.from('vide')
    ]));
    const sampleChildren = [ box('hvcC', createHEVCConfiguration(options.id * 16)) ];
    if (options.dolbyVisionConfiguration) {
        sampleChildren.push(box('dvcC', options.dolbyVisionConfiguration));
    }
    const sampleEntry = box(options.sampleEntryType ?? 'hvc1', concatenate([
        Buffer.alloc(VISUAL_SAMPLE_ENTRY_FIELD_BYTE_LENGTH),
        ...sampleChildren
    ]));
    const sampleDescription = fullBox('stsd', concatenate([
        unsigned32(1),
        sampleEntry
    ]));
    return box('trak', concatenate([
        trackHeader,
        ...(options.trackReference ? [ options.trackReference ] : []),
        box('mdia', concatenate([
            handler,
            box('minf', box('stbl', sampleDescription))
        ]))
    ]));
}

function createMP4(options = {}) {
    const baseTrack = createTrack({
        id: options.baseTrackID ?? 1,
        sampleEntryType: options.sampleEntryType
    });
    const enhancementTrack = createTrack({
        dolbyVisionConfiguration: options.dolbyVisionConfiguration
            ?? createDolbyVisionConfiguration(),
        id: options.enhancementTrackID ?? 2,
        sampleEntryType: options.sampleEntryType,
        trackReference: options.trackReference
    });
    const movie = box('moov', concatenate([ baseTrack, enhancementTrack ]));
    return options.movieBeforeMediaData ?
        concatenate([ box('ftyp'), movie, box('mdat', Buffer.from([ 1 ])) ]) :
        concatenate([ box('ftyp'), box('mdat', Buffer.from([ 1 ])), movie ]);
}

function findMarker(data, marker) {
    return data.indexOf(Buffer.from(marker, 'ascii'));
}

test('patches hvc1 into a dependent dvh1 Profile 7 enhancement track', () => {
    const source = createMP4();
    const result = patchDualTrackDolbyVisionMP4(source);

    assert.equal(result.baseTrackID, 1);
    assert.equal(result.enhancementTrackID, 2);
    assert.equal(result.enhancementSampleEntryType, 'dvh1');
    assert.equal(result.data.byteLength, source.byteLength + 20);
    assert.equal(findMarker(result.data, 'dvh1') > 0, true);
    const configurationMarkerOffset = findMarker(result.data, 'dvcC');
    assert.equal(result.data[configurationMarkerOffset + 7] & 1, 0);
    const dependencyMarkerOffset = findMarker(result.data, 'vdep');
    assert.equal(result.data.readUInt32BE(dependencyMarkerOffset + 4), 1);
});

test('maps hev1 enhancement samples to dvhe', () => {
    const result = patchDualTrackDolbyVisionMP4(createMP4({
        sampleEntryType: 'hev1'
    }));

    assert.equal(result.enhancementSampleEntryType, 'dvhe');
    assert.equal(findMarker(result.data, 'dvhe') > 0, true);
});

test('rejects media data after the movie box', () => {
    assert.throws(
        () => patchDualTrackDolbyVisionMP4(createMP4({ movieBeforeMediaData: true })),
        new FixtureError('All fixture media data must precede the movie box')
    );
});

test('rejects a preexisting track reference', () => {
    assert.throws(
        () => patchDualTrackDolbyVisionMP4(createMP4({
            trackReference: box('tref', box('vdep', unsigned32(1)))
        })),
        new FixtureError('The enhancement source already contains a track reference')
    );
});

test('rejects duplicate track IDs', () => {
    assert.throws(
        () => patchDualTrackDolbyVisionMP4(createMP4({ enhancementTrackID: 1 })),
        new FixtureError('The fixture track IDs are duplicated')
    );
});

test('rejects invalid Dolby Vision enhancement configurations', () => {
    for (const dolbyVisionConfiguration of [
        createDolbyVisionConfiguration({ profile: 8 }),
        createDolbyVisionConfiguration({ rpuPresent: false }),
        createDolbyVisionConfiguration({ enhancementLayerPresent: false })
    ]) {
        assert.throws(
            () => patchDualTrackDolbyVisionMP4(createMP4({ dolbyVisionConfiguration })),
            new FixtureError('The enhancement track is not an RPU-bearing Profile 7 EL')
        );
    }
});

test('rejects malformed and non-ISO input', () => {
    assert.throws(
        () => patchDualTrackDolbyVisionMP4(Buffer.from('not an mp4')),
        FixtureError
    );
    assert.throws(
        () => patchDualTrackDolbyVisionMP4(Buffer.alloc(0)),
        new FixtureError('The MP4 fixture size is unsupported')
    );
});
