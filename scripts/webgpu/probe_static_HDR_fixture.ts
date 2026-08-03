import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacketSink,
    Input
} from 'mediabunny';

import { getHEVCNALFormat } from '../../src/plugins/webGPUVideoPlayer/custom/DolbyVisionEncodedMetadata';
import { scanHEVCStaticHDRMetadata } from '../../src/plugins/webGPUVideoPlayer/custom/HEVCStaticHDRMetadata';
import { MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT } from '../../src/plugins/webGPUVideoPlayer/custom/StaticHDRMetadata';

const STATIC_HDR_METADATA_SCAN_MAXIMUM_BYTE_LENGTH = 8 * 1024 * 1024;
const fixtureArgument = process.argv[2];
if (!fixtureArgument) {
    throw new TypeError('Pass a local fixture path');
}

const input = new Input({
    formats: ALL_FORMATS,
    source: new BufferSource(new Uint8Array(readFileSync(resolve(fixtureArgument))))
});

try {
    const videoTracks = await input.getVideoTracks();
    if (videoTracks.length !== 1) {
        throw new TypeError('The static HDR fixture must contain exactly one video track');
    }
    const decoderConfig = await videoTracks[0].getDecoderConfig();
    if (!decoderConfig) {
        throw new TypeError('The static HDR fixture has no decoder configuration');
    }
    const packetSink = new EncodedPacketSink(videoTracks[0]);
    const accessUnits: Uint8Array[] = [];
    let scannedByteLength = 0;
    let packet = await packetSink.getFirstPacket({ metadataOnly: false });
    while (packet
        && accessUnits.length < MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT) {
        const nextByteLength = scannedByteLength + packet.data.byteLength;
        if (accessUnits.length > 0
            && nextByteLength > STATIC_HDR_METADATA_SCAN_MAXIMUM_BYTE_LENGTH) {
            break;
        }
        accessUnits.push(packet.data);
        scannedByteLength = nextByteLength;
        if (scannedByteLength >= STATIC_HDR_METADATA_SCAN_MAXIMUM_BYTE_LENGTH) {
            break;
        }
        packet = await packetSink.getNextPacket(packet, { metadataOnly: false });
    }
    const result = scanHEVCStaticHDRMetadata(
        accessUnits,
        getHEVCNALFormat(decoderConfig)
    );
    process.stdout.write(`${JSON.stringify({ result, scannedByteLength }, null, 2)}\n`);
} finally {
    await input.dispose();
}
