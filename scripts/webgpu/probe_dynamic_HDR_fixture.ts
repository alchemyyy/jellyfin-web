import { resolve } from 'node:path';

import {
    ALL_FORMATS,
    EncodedPacketSink,
    FilePathSource,
    Input
} from 'mediabunny';

import { secondsToMicroseconds } from '../../src/plugins/webGPUVideoPlayer/MediaTime';
import { getHEVCNALFormat } from '../../src/plugins/webGPUVideoPlayer/custom/DolbyVisionEncodedMetadata';
import {
    getHDR10PlusSceneLuminance,
    parseHEVCHDR10PlusMetadata,
    type HDR10PlusFrameMetadataStatus,
    type HDR10PlusMetadata
} from '../../src/plugins/webGPUVideoPlayer/custom/HDR10PlusMetadata';

const DEFAULT_MAXIMUM_ACCESS_UNIT_COUNT = 100_000;
const MAXIMUM_RECORDED_STATUS_TRANSITION_COUNT = 256;
const STATUSES: readonly HDR10PlusFrameMetadataStatus[] = [
    'absent',
    'conflicting',
    'malformed',
    'unsupported',
    'valid'
];

type StatusTransition = Readonly<{
    accessUnitIndex: number
    mediaTimeMicroseconds: number
    status: HDR10PlusFrameMetadataStatus
}>;

function parseMaximumAccessUnitCount(value: string | undefined): number {
    if (value === undefined) {
        return DEFAULT_MAXIMUM_ACCESS_UNIT_COUNT;
    }
    const parsedValue = Number(value);
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 1) {
        throw new TypeError('The maximum access-unit count must be a positive integer');
    }
    return parsedValue;
}

function createStatusCounts(): Record<HDR10PlusFrameMetadataStatus, number> {
    const statusCounts = {} as Record<HDR10PlusFrameMetadataStatus, number>;
    for (const status of STATUSES) {
        statusCounts[status] = 0;
    }
    return statusCounts;
}

const fixtureArgument = process.argv[2];
if (!fixtureArgument) {
    throw new TypeError('Pass a local HEVC fixture path');
}
const maximumAccessUnitCount = parseMaximumAccessUnitCount(process.argv[3]);
const input = new Input({
    formats: ALL_FORMATS,
    source: new FilePathSource(resolve(fixtureArgument))
});

try {
    const videoTracks = await input.getVideoTracks();
    if (videoTracks.length !== 1) {
        throw new TypeError('The dynamic HDR fixture must contain exactly one video track');
    }
    const decoderConfig = await videoTracks[0].getDecoderConfig();
    if (!decoderConfig) {
        throw new TypeError('The dynamic HDR fixture has no decoder configuration');
    }
    const inputFormat = getHEVCNALFormat(decoderConfig);
    const packetSink = new EncodedPacketSink(videoTracks[0]);
    const statusCounts = createStatusCounts();
    const statusTransitions: StatusTransition[] = [];
    let firstValidMetadata: HDR10PlusMetadata | null = null;
    let previousStatus: HDR10PlusFrameMetadataStatus | null = null;
    let scannedAccessUnitCount = 0;
    let scannedByteLength = 0;
    let minimumValidPeakNits: number | null = null;
    let maximumValidPeakNits: number | null = null;
    let packet = await packetSink.getFirstPacket({ metadataOnly: false });
    while (packet && scannedAccessUnitCount < maximumAccessUnitCount) {
        const frameMetadata = parseHEVCHDR10PlusMetadata(packet.data, inputFormat);
        statusCounts[frameMetadata.status] += 1;
        if (
            frameMetadata.status !== previousStatus
            && statusTransitions.length < MAXIMUM_RECORDED_STATUS_TRANSITION_COUNT
        ) {
            statusTransitions.push({
                accessUnitIndex: scannedAccessUnitCount,
                mediaTimeMicroseconds: secondsToMicroseconds(packet.timestamp),
                status: frameMetadata.status
            });
        }
        previousStatus = frameMetadata.status;
        if (frameMetadata.status === 'valid' && frameMetadata.metadata) {
            firstValidMetadata ??= frameMetadata.metadata;
            const peakNits = getHDR10PlusSceneLuminance(
                frameMetadata.metadata
            ).peakNits;
            if (peakNits !== null) {
                minimumValidPeakNits = Math.min(minimumValidPeakNits ?? peakNits, peakNits);
                maximumValidPeakNits = Math.max(maximumValidPeakNits ?? peakNits, peakNits);
            }
        }
        scannedAccessUnitCount += 1;
        scannedByteLength += packet.data.byteLength;
        packet = await packetSink.getNextPacket(packet, { metadataOnly: false });
    }

    process.stdout.write(`${JSON.stringify({
        firstValidMetadata,
        inputFormat: inputFormat.kind,
        maximumAccessUnitCount,
        maximumValidPeakNits,
        minimumValidPeakNits,
        reachedAccessUnitLimit: packet !== null,
        scannedAccessUnitCount,
        scannedByteLength,
        schemaVersion: 1,
        statusCounts,
        statusTransitions,
        statusTransitionsTruncated:
            statusTransitions.length === MAXIMUM_RECORDED_STATUS_TRANSITION_COUNT
    }, null, 2)}\n`);
} finally {
    await input.dispose();
}
