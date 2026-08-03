/* eslint-disable no-restricted-globals */
import {
    ALL_FORMATS,
    AudioSampleSink,
    EncodedPacketSink,
    Input,
    UrlSource,
    VideoSampleSink,
    type AudioSample,
    type AudioCodec,
    type EncodedPacket,
    type InputAudioTrack,
    type InputVideoTrack,
    type VideoCodec,
    type VideoSample
} from 'mediabunny';

import { microsecondsToSeconds, type Microseconds } from '../MediaTime';
import { getDolbyVisionEnhancementDimensions } from '../DolbyVisionGeometry';
import { getAudioSampleWindow } from './AudioSampleWindow';
import { settleConcurrentDecodeStreams } from './ConcurrentDecodeStreams';
import { registerRequiredCustomAudioDecoder } from './CustomAudioDecoderRegistration';
import {
    assertCustomAudioOutputChannelLayout,
    getCustomAudioChannelLayout,
    prepareCustomAudioOutputChannelData,
    type CustomAudioChannelLayout,
    type CustomAudioOutputChannelCount
} from './CustomAudioChannelLayout';
import {
    CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT,
    CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
    isSupportedCustomAudioInputLayout
} from './CustomAudioOutputPolicy';
import { isSupportedCustomAudioSampleRate } from './CustomAudioSampleRate';
import StreamingAudioResampler, {
    type StreamingAudioResamplerOutput
} from './StreamingAudioResampler';
import {
    getCustomDecodeHardwareAcceleration,
    isDecodeWorkerRequest,
    MAX_DECODED_AUDIO_CHANNELS,
    MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE,
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
    MAX_DECODED_FRAME_CREDITS,
    MAX_DECODED_RAW_FRAME_CREDITS,
    MAXIMUM_VIDEO_STARTUP_PROGRESS_PACKET_COUNT,
    type CustomDecodeAudioOutputMode,
    type CustomDecodeFailureKind,
    type CustomDecodeNativeHDRTransfer,
    type CustomDecodeRawVideoFrameFormat,
    type CustomDecodeVideoDecoderBackend,
    type CustomDecodeVideoOutputMode,
    type CustomDecodeWorkerProgressPhase,
    type DecodeWorkerNativeMediaAudioConfiguration,
    type DecodeWorkerReadyAudioConfiguration,
    type DecodeWorkerRequest,
    type DecodeWorkerResponse
} from './DecodeWorkerProtocol';
import { getTrackByOrdinal } from './CustomDecodeTrackSelection';
import {
    DecodedVideoGeometryError,
    requireConsistentDecodedVideoGeometry
} from './DecodedVideoGeometry';
import DolbyVisionEncodedMetadataQueue, {
    getHEVCNALFormat,
    type ProcessedDolbyVisionHEVCPacket
} from './DolbyVisionEncodedMetadata';
import DolbyVisionFramePairQueue, {
    type DolbyVisionFramePair
} from './DolbyVisionFramePairQueue';
import DolbyVisionEncodedPacketPairer from './DolbyVisionEncodedPacketPairer';
import {
    splitDolbyVisionHEVCAccessUnit,
    type HEVCNALFormat
} from './DolbyVisionHEVCSplitter';
import {
    getDolbyVisionEncodedMetadataTransferList,
    takeTransferableDolbyVisionEncodedFrameMetadata,
    type DolbyVisionEncodedFrameMetadata
} from './DolbyVisionEncodedMetadataProtocol';
import { DolbyVisionRPUParseError } from './DolbyVisionRPUParser';
import DolbyVisionRPUParserSession from './DolbyVisionRPUParserSession';
import {
    createOwnedHEVCSoftwareVideoDecoder,
    hasRequiredHEVCParameterSets,
    parseHEVCDecoderConfiguration,
    registerHEVCSoftwareVideoDecoder,
    waitForHEVCSoftwareVideoDecoderShutdown
} from './HEVCSoftwareVideoDecoder';
import { parseHEVCSPS } from './HEVCSPSParser';
import { scanHEVCStaticHDRMetadata } from './HEVCStaticHDRMetadata';
import HEVCDynamicHDRMetadataQueue from './HEVCDynamicHDRMetadataQueue';
import type { HDR10PlusFrameMetadata } from './HDR10PlusMetadata';
import {
    requireValidByteRangeResponse,
    UnsupportedRangeResponseError
} from './HTTPRangeResponse';
import {
    isRetryableMediaFetchError,
    MediaNetworkError,
    requireSuccessfulMediaHTTPResponse
} from './MediaFetchPolicy';
import RawFrameBufferPool from './RawFrameBufferPool';
import {
    copyVideoFramePairToRawPlanes,
    copyVideoFrameToRawPlanes,
    getRawVideoFramePairTransferList,
    getRawVideoFrameTransferList,
    type RawVideoFrameGeometry
} from './RawVideoFrameCopy';
import { requireMicroseconds } from './TimeMath';
import NativeMediaAudioFMP4Remuxer, {
    type NativeMediaAudioFMP4Codec,
    type NativeMediaAudioFMP4RemuxOutput
} from './NativeMediaAudioFMP4Remuxer';
import OwnedNativeHEVCVideoDecoder from './OwnedNativeHEVCVideoDecoder';
import { readISOBaseMediaDolbyVisionTrackConfiguration } from './ISOBaseMediaDolbyVisionConfiguration';
import {
    readMatroskaDolbyVisionTrackConfiguration
} from './MatroskaDolbyVisionHVCE';
import {
    readMPEGTransportStreamDolbyVisionTrackConfiguration
} from './MPEGTransportStreamDolbyVisionConfiguration';
import JPEG2000SoftwareVideoDecoder from './JPEG2000SoftwareVideoDecoder';
import DTSSoftwareAudioDecoder, {
    type DTSDecodedAudioOutput
} from './DTSSoftwareAudioDecoder';
import TrueHDSoftwareAudioDecoder, {
    type TrueHDDecodedAudioOutput,
    type TrueHDDecoderCodec
} from './TrueHDSoftwareAudioDecoder';
import LegacySoftwareVideoDecoder from './LegacySoftwareVideoDecoder';
import {
    MAXIMUM_STATIC_HDR_METADATA_SCAN_ACCESS_UNIT_COUNT,
    type StaticHDRMetadataScanResult
} from './StaticHDRMetadata';

const URL_SOURCE_CACHE_BYTES = 32 * 1024 * 1024;
const URL_SOURCE_PARALLELISM = 2;
const MAX_NETWORK_RETRY_ATTEMPTS = 2;
const NETWORK_RETRY_BASE_SECONDS = 0.25;
const OWNED_VIDEO_DECODER_QUEUE_HIGH_WATER_MARK = 16;
const DOLBY_VISION_ENHANCEMENT_CODEC = 'hev1.2.4.L153.B0';
const ANNEX_B_HEVC_NAL_FORMAT: HEVCNALFormat = { kind: 'annex-b' };
const OWNED_HEVC_PACKET_OPTIONS = {
    metadataOnly: false,
    verifyKeyPackets: true
} as const;
const STATIC_HDR_METADATA_PACKET_OPTIONS = { metadataOnly: false } as const;
const OPENJPEG_PACKET_OPTIONS = { metadataOnly: false } as const;
const LEGACY_VIDEO_PACKET_OPTIONS = {
    metadataOnly: false,
    verifyKeyPackets: true
} as const;
const STATIC_HDR_METADATA_SCAN_MAXIMUM_BYTE_LENGTH = 8 * 1024 * 1024;
const TRUEHD_MAJOR_SYNC_PREROLL_MICROSECONDS = 1_000_000;

type MediaSampleIterator<Sample> = {
    next: () => Promise<IteratorResult<Sample>>
    return?: () => Promise<IteratorResult<Sample>>
};

type DecodeRun = {
    audioIterator: MediaSampleIterator<AudioSample> | MediaSampleIterator<EncodedPacket> | null
    audioSampleCredits: number
    cancelled: boolean
    decodedVideoGeometry: RawVideoFrameGeometry | null
    enhancementPacketPairer: DolbyVisionEncodedPacketPairer | null
    frameCredits: number
    generation: number
    input: Input | null
    iteratorRetirementPromise: Promise<void> | null
    maximumCodedHeight: number
    maximumCodedWidth: number
    metadataAbortController: AbortController | null
    nativeHDRTransfer: CustomDecodeNativeHDRTransfer
    neutralizeHDRColorMetadata: boolean
    outstandingRawFrameBufferCount: number
    rawFrameBufferPool: RawFrameBufferPool | null
    rawVideoFrameFormat: CustomDecodeRawVideoFrameFormat | null
    videoDecoderBackend: CustomDecodeVideoDecoderBackend
    videoOutputMode: CustomDecodeVideoOutputMode
    videoIterator: MediaSampleIterator<EncodedPacket> | MediaSampleIterator<VideoSample> | null
    wakeAudioCreditWaiters: Array<() => void>
    wakeFrameCreditWaiters: Array<() => void>
    wakeVideoDecodeWaiters: Array<() => void>
};

type PreparedVideoTrack = {
    availableVideoTracks: readonly InputVideoTrack[]
    codec: VideoCodec | 'jpeg2000' | 'mpeg2video'
    containerTrackNumber: number
    decoderConfig: VideoDecoderConfig
    geometry: RawVideoFrameGeometry
    staticHDRMetadataScan?: StaticHDRMetadataScanResult
    videoTrack: InputVideoTrack
};

type DolbyVisionEnhancementDecoderConfiguration = {
    decoderConfig: VideoDecoderConfig
    geometry: RawVideoFrameGeometry
    packetFormat: HEVCNALFormat
    source: {
        kind: 'interleaved'
    } | {
        kind: 'separate-track'
        videoTrack: InputVideoTrack
    }
};

type SeparateDolbyVisionEnhancementPacketStream = {
    inputFormat: HEVCNALFormat
    pairer: DolbyVisionEncodedPacketPairer
};

type ContainerDolbyVisionTrackConfiguration = {
    enhancementConfiguration: Uint8Array | null
    separateEnhancement: {
        decoderDescription: Uint8Array | null
        trackNumber: number
    } | null
};

type PreparedAudioTrack = {
    audioConfiguration: DecodeWorkerReadyAudioConfiguration
    audioTrack: InputAudioTrack
    decoderBackend: 'dts' | 'mediabunny' | TrueHDDecoderCodec
    decoderConfig: AudioDecoderConfig | null
    inputChannelCount: number
    inputChannelLayout: CustomAudioChannelLayout
    outputMode: CustomDecodeAudioOutputMode
    outputChannelCount: CustomAudioOutputChannelCount
    sourceSampleRate: number
};

type SelectedAudioTrackMetadata = {
    audioTrack: InputAudioTrack
    channelCount: number
    codec: AudioCodec | null
    decoderConfig: AudioDecoderConfig | null
    inputChannelLayout: CustomAudioChannelLayout
    isDTS: boolean
    sampleRate: number
    trueHDDecoderCodec: TrueHDDecoderCodec | null
};

type WorkerScope = {
    addEventListener: (
        type: 'message',
        listener: (event: MessageEvent<unknown>) => void
    ) => void
    postMessage: (message: DecodeWorkerResponse, transfer?: Transferable[]) => void
};

class UnsupportedCustomDecodeSourceError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = 'UnsupportedCustomDecodeSourceError';
    }
}

const workerScope = self as unknown as WorkerScope;
let currentRun: DecodeRun | null = null;

function postResponse(response: DecodeWorkerResponse, transfer?: Transferable[]): void {
    workerScope.postMessage(response, transfer);
}

function postVideoStartupProgress(
    run: DecodeRun,
    phase: CustomDecodeWorkerProgressPhase,
    packetCount: number,
    mediaTimeMicroseconds: Microseconds | null
): void {
    if (run.cancelled || packetCount > MAXIMUM_VIDEO_STARTUP_PROGRESS_PACKET_COUNT) {
        return;
    }
    postResponse({
        generation: run.generation,
        mediaTimeMicroseconds,
        packetCount,
        phase,
        type: 'progress'
    });
}

function createRawFrameBufferPool(
    videoOutputMode: CustomDecodeVideoOutputMode
): RawFrameBufferPool | null {
    switch (videoOutputMode) {
        case 'raw-planes':
            return new RawFrameBufferPool(MAX_DECODED_RAW_FRAME_CREDITS);
        case 'video-frame':
            return null;
    }
}

function getRetryDelay(previousAttempts: number, error: unknown): number | null {
    if (
        error instanceof UnsupportedRangeResponseError
        || !isRetryableMediaFetchError(error)
    ) {
        return null;
    }
    if (previousAttempts > MAX_NETWORK_RETRY_ATTEMPTS) {
        return null;
    }

    return NETWORK_RETRY_BASE_SECONDS * (2 ** (previousAttempts - 1));
}

const validatedRangeFetch: typeof fetch = async (
    input: RequestInfo | URL,
    requestInit?: RequestInit
): Promise<Response> => {
    const requestHeaders = requestInit?.headers === undefined && input instanceof Request ?
        input.headers :
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        new Headers(requestInit?.headers);
    let response: Response;
    try {
        response = await fetch(input, requestInit);
    } catch (error) {
        const requestURL = input instanceof Request ? input.url : String(input);
        let requestPath = '[media path]';
        try {
            requestPath = new URL(requestURL).pathname;
        } catch {
            // Preserve a token-safe placeholder for malformed request URLs
        }
        const requestMethod = requestInit?.method
            ?? (input instanceof Request ? input.method : 'GET');
        const rangeHeader = requestHeaders.get('Range');
        const requestDescription = rangeHeader ?
            `${requestMethod} ${requestPath} (${rangeHeader})` :
            `${requestMethod} ${requestPath}`;
        throw new MediaNetworkError(
            `${requestDescription}: ${getSafeErrorMessage(error)}`
        );
    }
    requireSuccessfulMediaHTTPResponse(response);
    requireValidByteRangeResponse(requestHeaders.get('Range'), response);
    return response;
};

function wakeWaiters(waiters: Array<() => void>): void {
    const activeWaiters = waiters.splice(0);
    for (const waiter of activeWaiters) {
        waiter();
    }
}

function addFrameCredits(run: DecodeRun, frameCredits: number): void {
    const maximumFrameCredits = run.videoOutputMode === 'raw-planes' ?
        MAX_DECODED_RAW_FRAME_CREDITS :
        MAX_DECODED_FRAME_CREDITS;
    run.frameCredits = Math.min(
        maximumFrameCredits,
        run.frameCredits + frameCredits
    );
    wakeWaiters(run.wakeFrameCreditWaiters);
}

function addAudioSampleCredits(run: DecodeRun, audioSampleCredits: number): void {
    run.audioSampleCredits = Math.min(
        MAX_DECODED_AUDIO_SAMPLE_CREDITS,
        run.audioSampleCredits + audioSampleCredits
    );
    wakeWaiters(run.wakeAudioCreditWaiters);
}

async function waitForFrameCredit(run: DecodeRun): Promise<boolean> {
    while (!run.cancelled && run.frameCredits === 0) {
        await new Promise<void>(resolve => {
            run.wakeFrameCreditWaiters.push(resolve);
        });
    }

    if (run.cancelled) {
        return false;
    }

    run.frameCredits -= 1;
    return true;
}

async function waitForAudioSampleCredit(run: DecodeRun): Promise<boolean> {
    while (!run.cancelled && run.audioSampleCredits === 0) {
        await new Promise<void>(resolve => {
            run.wakeAudioCreditWaiters.push(resolve);
        });
    }

    if (run.cancelled) {
        return false;
    }

    run.audioSampleCredits -= 1;
    return true;
}

async function retireIterator(
    iterator: { return?: () => Promise<unknown> } | null
): Promise<void> {
    try {
        await iterator?.return?.();
    } catch {
        return;
    }
}

function stopRun(run: DecodeRun): void {
    if (run.cancelled) {
        return;
    }

    run.cancelled = true;
    run.metadataAbortController?.abort();
    run.metadataAbortController = null;
    wakeWaiters(run.wakeAudioCreditWaiters);
    wakeWaiters(run.wakeFrameCreditWaiters);
    wakeWaiters(run.wakeVideoDecodeWaiters);
    run.input?.dispose();
    const iteratorRetirementPromises: Array<Promise<void>> = [];
    iteratorRetirementPromises.push(retireIterator(run.audioIterator));
    iteratorRetirementPromises.push(
        run.enhancementPacketPairer?.retire() ?? Promise.resolve()
    );
    iteratorRetirementPromises.push(retireIterator(run.videoIterator));
    run.iteratorRetirementPromise = Promise.all(iteratorRetirementPromises).then(
        (): void => undefined
    );
}

function getSafeErrorMessage(error: unknown): string {
    if (!(error instanceof Error)) {
        return 'Custom media decode failed';
    }

    return error.message
        .replace(/https?:\/\/[^\s]+/gi, '[media URL]')
        .replace(/([?&](?:api_?key|token)=)[^&\s]+/gi, '$1[redacted]')
        .slice(0, 512);
}

function classifyFailure(error: unknown): CustomDecodeFailureKind {
    if (error instanceof UnsupportedRangeResponseError) {
        return 'range-unsupported';
    }
    if (error instanceof UnsupportedCustomDecodeSourceError) {
        return 'source-unsupported';
    }
    if (error instanceof DolbyVisionRPUParseError) {
        return 'source-unsupported';
    }
    if (error instanceof MediaNetworkError) {
        return 'network-failed';
    }

    return 'decode-failed';
}

type FocusedSoftwareVideoRoute = Readonly<{
    codec: 'jpeg2000' | 'mpeg2video'
    decoderCodec: string
    errorName: string
    expectedInternalCodecID: string
    includeColorSpace: boolean
}>;

type FocusedSoftwareVideoTrackInput = Readonly<{
    availableVideoTracks: readonly InputVideoTrack[]
    codedHeight: number
    codedWidth: number
    containerCodec: VideoCodec | null
    displayHeight: number
    displayWidth: number
    internalCodecID: unknown
    request: Extract<DecodeWorkerRequest, { type: 'start' }>
    videoTrack: InputVideoTrack
}>;

function getFocusedSoftwareVideoRoute(
    backend: CustomDecodeVideoDecoderBackend
): FocusedSoftwareVideoRoute | null {
    switch (backend) {
        case 'openjpeg':
            return {
                codec: 'jpeg2000',
                decoderCodec: 'mjp2',
                errorName: 'OpenJPEG MJ2',
                expectedInternalCodecID: 'mjp2',
                includeColorSpace: false
            };
        case 'legacy-software':
            return {
                codec: 'mpeg2video',
                decoderCodec: 'mpeg2video',
                errorName: 'MPEG-2 software',
                expectedInternalCodecID: 'V_MPEG2',
                includeColorSpace: true
            };
        case 'bundled-hevc':
        case 'native':
            return null;
    }
}

async function prepareFocusedSoftwareVideoTrack(
    input: FocusedSoftwareVideoTrackInput
): Promise<PreparedVideoTrack | null> {
    const route = getFocusedSoftwareVideoRoute(input.request.videoDecoderBackend);
    if (!route) {
        return null;
    }
    if (
        input.containerCodec !== null
        || input.internalCodecID !== route.expectedInternalCodecID
        || input.request.videoOutputMode !== 'video-frame'
        || input.request.dolbyVisionProfile !== null
        || input.request.neutralizeHDRColorMetadata
        || input.request.nativeHDRTransfer !== null
    ) {
        throw new UnsupportedCustomDecodeSourceError(
            `The selected video track does not match the negotiated ${route.errorName} route`
        );
    }

    const colorSpace = route.includeColorSpace ? await input.videoTrack.getColorSpace() : null;
    return {
        availableVideoTracks: input.availableVideoTracks,
        codec: route.codec,
        containerTrackNumber: input.videoTrack.id,
        decoderConfig: {
            codec: route.decoderCodec,
            codedHeight: input.codedHeight,
            codedWidth: input.codedWidth,
            ...(colorSpace ? { colorSpace } : {}),
            displayAspectHeight: input.displayHeight,
            displayAspectWidth: input.displayWidth,
            hardwareAcceleration: 'prefer-software',
            optimizeForLatency: true
        },
        geometry: {
            codedHeight: input.codedHeight,
            codedWidth: input.codedWidth,
            displayHeight: input.displayHeight,
            displayWidth: input.displayWidth
        },
        videoTrack: input.videoTrack
    };
}

async function readHEVCStaticHDRMetadata(
    videoTrack: InputVideoTrack,
    decoderConfig: VideoDecoderConfig,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    run: DecodeRun
): Promise<StaticHDRMetadataScanResult | null> {
    if (request.nativeHDRTransfer !== 'pq') {
        return null;
    }

    const packetSink = new EncodedPacketSink(videoTrack);
    const accessUnits: Uint8Array[] = [];
    let scannedByteLength = 0;
    let packet = await packetSink.getFirstPacket(STATIC_HDR_METADATA_PACKET_OPTIONS);
    while (packet
        && !run.cancelled
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
        packet = await packetSink.getNextPacket(packet, STATIC_HDR_METADATA_PACKET_OPTIONS);
    }
    return scanHEVCStaticHDRMetadata(accessUnits, getHEVCNALFormat(decoderConfig));
}

async function prepareVideoTrack(
    input: Input,
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>
): Promise<PreparedVideoTrack> {
    const videoTracks = await input.getVideoTracks();
    if (run.cancelled) {
        throw new UnsupportedCustomDecodeSourceError('Custom decode was cancelled');
    }

    const videoTrack = getTrackByOrdinal(videoTracks, request.videoTrackIndex);
    if (!videoTrack) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected video track ordinal is unavailable'
        );
    }

    const [
        codec,
        internalCodecID,
        codedHeight,
        codedWidth,
        displayHeight,
        displayWidth
    ] = await Promise.all([
        videoTrack.getCodec(),
        videoTrack.getInternalCodecId(),
        videoTrack.getCodedHeight(),
        videoTrack.getCodedWidth(),
        videoTrack.getDisplayHeight(),
        videoTrack.getDisplayWidth()
    ]);
    const dimensions = [ codedHeight, codedWidth, displayHeight, displayWidth ];
    if (dimensions.some(dimension => !Number.isSafeInteger(dimension) || dimension <= 0)) {
        throw new UnsupportedCustomDecodeSourceError('The selected video dimensions are invalid');
    }
    if (
        codedWidth > request.maximumCodedWidth
        || codedHeight > request.maximumCodedHeight
    ) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected video track exceeds its negotiated decode route'
        );
    }
    if (!Number.isSafeInteger(videoTrack.id) || videoTrack.id <= 0) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected video container track number is invalid'
        );
    }

    const softwareTrack = await prepareFocusedSoftwareVideoTrack({
        availableVideoTracks: videoTracks,
        codedHeight,
        codedWidth,
        containerCodec: codec,
        displayHeight,
        displayWidth,
        internalCodecID,
        request,
        videoTrack
    });
    if (softwareTrack) {
        return softwareTrack;
    }

    const [ decoderConfig, canDecode ] = await Promise.all([
        videoTrack.getDecoderConfig(),
        videoTrack.canDecode()
    ]);
    if (!codec || !decoderConfig) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected video codec configuration is unavailable'
        );
    }
    if (request.videoDecoderBackend === 'bundled-hevc' && codec !== 'hevc') {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected video track does not match the negotiated bundled HEVC decoder'
        );
    }
    if (request.neutralizeHDRColorMetadata && codec !== 'hevc') {
        throw new UnsupportedCustomDecodeSourceError(
            'HDR color neutralization requires an HEVC video track'
        );
    }
    if (!canDecode) {
        throw new UnsupportedCustomDecodeSourceError(
            `The browser cannot decode the selected ${codec} video configuration`
        );
    }

    const staticHDRMetadataScan = codec === 'hevc' ?
        await readHEVCStaticHDRMetadata(videoTrack, decoderConfig, request, run) :
        null;
    if (run.cancelled) {
        throw new UnsupportedCustomDecodeSourceError('Custom decode was cancelled');
    }

    return {
        availableVideoTracks: videoTracks,
        codec,
        containerTrackNumber: videoTrack.id,
        decoderConfig,
        geometry: { codedHeight, codedWidth, displayHeight, displayWidth },
        ...(staticHDRMetadataScan ? { staticHDRMetadataScan } : {}),
        videoTrack
    };
}

function getDefaultDolbyVisionEnhancementGeometry(
    preparedVideoTrack: PreparedVideoTrack
): RawVideoFrameGeometry {
    const baseGeometry = preparedVideoTrack.geometry;
    const enhancementDimensions = getDolbyVisionEnhancementDimensions(
        baseGeometry.codedWidth,
        baseGeometry.codedHeight
    );
    const codedWidth = enhancementDimensions.width;
    const codedHeight = enhancementDimensions.height;
    return {
        codedHeight,
        codedWidth,
        displayHeight: codedHeight,
        displayWidth: codedWidth
    };
}

function getContainerDolbyVisionEnhancementConfiguration(
    preparedVideoTrack: PreparedVideoTrack,
    description: Uint8Array
): DolbyVisionEnhancementDecoderConfiguration | null {
    try {
        const decoderConfiguration = parseHEVCDecoderConfiguration(description);
        if (
            decoderConfiguration.profileIDC !== 2
            || decoderConfiguration.bitDepth !== 10
            || decoderConfiguration.chromaFormat !== 1
            || decoderConfiguration.sequenceParameterSets.length === 0
            || !hasRequiredHEVCParameterSets(description)
        ) {
            return null;
        }
        const spsConfiguration = parseHEVCSPS(
            decoderConfiguration.sequenceParameterSets[0]
        );
        const expectedGeometry = getDefaultDolbyVisionEnhancementGeometry(preparedVideoTrack);
        if (
            spsConfiguration.codedHeight !== expectedGeometry.codedHeight
            || spsConfiguration.codedWidth !== expectedGeometry.codedWidth
            || spsConfiguration.displayHeight > spsConfiguration.codedHeight
            || spsConfiguration.displayWidth > spsConfiguration.codedWidth
        ) {
            return null;
        }
        const geometry: RawVideoFrameGeometry = {
            codedHeight: spsConfiguration.codedHeight,
            codedWidth: spsConfiguration.codedWidth,
            displayHeight: spsConfiguration.displayHeight,
            displayWidth: spsConfiguration.displayWidth
        };
        return {
            decoderConfig: {
                codec: DOLBY_VISION_ENHANCEMENT_CODEC,
                codedHeight: geometry.codedHeight,
                codedWidth: geometry.codedWidth,
                description: description.slice(),
                displayAspectHeight: geometry.displayHeight,
                displayAspectWidth: geometry.displayWidth,
                hardwareAcceleration: 'prefer-software',
                optimizeForLatency: true
            },
            geometry,
            packetFormat: {
                kind: 'length-prefixed',
                lengthSize: decoderConfiguration.lengthSize
            },
            source: { kind: 'interleaved' }
        };
    } catch {
        return null;
    }
}

function createDolbyVisionEnhancementDecoderConfiguration(
    preparedVideoTrack: PreparedVideoTrack,
    description: Uint8Array | null = null
): DolbyVisionEnhancementDecoderConfiguration | null {
    if (description) {
        return getContainerDolbyVisionEnhancementConfiguration(
            preparedVideoTrack,
            description
        );
    }
    const geometry = getDefaultDolbyVisionEnhancementGeometry(preparedVideoTrack);
    return {
        decoderConfig: {
            codec: DOLBY_VISION_ENHANCEMENT_CODEC,
            codedHeight: geometry.codedHeight,
            codedWidth: geometry.codedWidth,
            displayAspectHeight: geometry.displayHeight,
            displayAspectWidth: geometry.displayWidth,
            hardwareAcceleration: 'prefer-software',
            optimizeForLatency: true
        },
        geometry,
        packetFormat: ANNEX_B_HEVC_NAL_FORMAT,
        source: { kind: 'interleaved' }
    };
}

function copyDecoderDescription(
    description: AllowSharedBufferSource | undefined
): Uint8Array | null {
    if (description === undefined) {
        return null;
    }
    if (description instanceof ArrayBuffer) {
        return new Uint8Array(description.slice(0));
    }
    if (typeof SharedArrayBuffer !== 'undefined' && description instanceof SharedArrayBuffer) {
        return new Uint8Array(description).slice();
    }
    if (ArrayBuffer.isView(description)) {
        return new Uint8Array(
            description.buffer,
            description.byteOffset,
            description.byteLength
        ).slice();
    }
    return null;
}

async function createSeparateDolbyVisionEnhancementDecoderConfiguration(
    preparedVideoTrack: PreparedVideoTrack,
    enhancementTrackNumber: number,
    containerDecoderDescription: Uint8Array | null
): Promise<DolbyVisionEnhancementDecoderConfiguration | null> {
    const videoTrack = preparedVideoTrack.availableVideoTracks.find(
        (candidate: InputVideoTrack): boolean => candidate.id === enhancementTrackNumber
    );
    if (!videoTrack || videoTrack === preparedVideoTrack.videoTrack) {
        return null;
    }
    const [
        codec,
        decoderConfig,
        codedHeight,
        codedWidth,
        displayHeight,
        displayWidth
    ] = await Promise.all([
        videoTrack.getCodec(),
        videoTrack.getDecoderConfig(),
        videoTrack.getCodedHeight(),
        videoTrack.getCodedWidth(),
        videoTrack.getDisplayHeight(),
        videoTrack.getDisplayWidth()
    ]);
    if (codec !== null && codec !== 'hevc') {
        return null;
    }
    let description: Uint8Array | null = containerDecoderDescription?.slice() ?? null;
    let decoderPacketFormat: HEVCNALFormat | null = null;
    try {
        if (!description && codec === 'hevc' && decoderConfig) {
            description = copyDecoderDescription(decoderConfig.description);
            decoderPacketFormat = getHEVCNALFormat(decoderConfig);
        }
    } catch {
        return null;
    }
    let configuration: DolbyVisionEnhancementDecoderConfiguration | null = null;
    if (description) {
        configuration = getContainerDolbyVisionEnhancementConfiguration(
            preparedVideoTrack,
            description
        );
    } else if (decoderPacketFormat?.kind === 'annex-b') {
        configuration = createDolbyVisionEnhancementDecoderConfiguration(
            preparedVideoTrack
        );
    }
    if (!configuration) {
        return null;
    }
    if (
        configuration.geometry.codedHeight !== codedHeight
        || configuration.geometry.codedWidth !== codedWidth
        || configuration.geometry.displayHeight !== displayHeight
        || configuration.geometry.displayWidth !== displayWidth
    ) {
        return null;
    }
    return {
        ...configuration,
        packetFormat: decoderPacketFormat ?? configuration.packetFormat,
        source: {
            kind: 'separate-track',
            videoTrack
        }
    };
}

async function getSelectedAudioTrackMetadata(
    input: Input,
    run: DecodeRun,
    audioTrackOrdinal: number
): Promise<SelectedAudioTrackMetadata> {
    const audioTracks = await input.getAudioTracks();
    if (run.cancelled) {
        throw new UnsupportedCustomDecodeSourceError('Custom decode was cancelled');
    }

    const audioTrack = getTrackByOrdinal(audioTracks, audioTrackOrdinal);
    if (!audioTrack) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected audio track ordinal is unavailable'
        );
    }

    const [ codec, decoderConfig, internalCodecID, channelCount, sampleRate ] = await Promise.all([
        audioTrack.getCodec(),
        audioTrack.getDecoderConfig(),
        audioTrack.getInternalCodecId(),
        audioTrack.getNumberOfChannels(),
        audioTrack.getSampleRate()
    ]);
    const isDTS = codec === null && internalCodecID === 'A_DTS';
    let trueHDDecoderCodec: TrueHDDecoderCodec | null = null;
    switch (internalCodecID) {
        case 'A_MLP':
            trueHDDecoderCodec = 'mlp';
            break;
        case 'A_TRUEHD':
            trueHDDecoderCodec = 'truehd';
            break;
    }
    if ((!codec || !decoderConfig) && !isDTS && trueHDDecoderCodec === null) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio codec configuration is unavailable');
    }
    if (!Number.isSafeInteger(channelCount) || channelCount <= 0 || channelCount > MAX_DECODED_AUDIO_CHANNELS) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio channel count is unsupported');
    }
    if (!isSupportedCustomAudioSampleRate(sampleRate)) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected audio sample rate is outside the supported range'
        );
    }
    const inputChannelLayout = getCustomAudioChannelLayout(channelCount);
    if (!inputChannelLayout) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected audio channel layout is unavailable'
        );
    }

    return {
        audioTrack,
        channelCount,
        codec,
        decoderConfig,
        inputChannelLayout,
        isDTS,
        sampleRate,
        trueHDDecoderCodec
    };
}

function prepareNativeMediaAudioTrack(
    metadata: SelectedAudioTrackMetadata
): PreparedAudioTrack {
    const {
        audioTrack,
        channelCount,
        codec,
        decoderConfig,
        inputChannelLayout,
        sampleRate
    } = metadata;
    if (!codec || !decoderConfig) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected native audio codec configuration is unavailable'
        );
    }
    const codecMatchesDecoderConfiguration =
        (codec === 'ac3' && decoderConfig.codec === 'ac-3')
        || (codec === 'eac3' && decoderConfig.codec === 'ec-3');
    if (!codecMatchesDecoderConfiguration
        || (channelCount !== 2 && channelCount !== 6)
        || sampleRate !== 48_000) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected audio track does not match the qualified native media route'
        );
    }
    const audioConfiguration: DecodeWorkerNativeMediaAudioConfiguration = {
        channelCount,
        codec: decoderConfig.codec,
        mimeType: `audio/mp4; codecs="${decoderConfig.codec}"`,
        outputMode: 'native-media',
        sampleRate,
        sourceChannelCount: channelCount,
        sourceSampleRate: sampleRate
    };
    return {
        audioConfiguration,
        audioTrack,
        decoderBackend: 'mediabunny',
        decoderConfig,
        inputChannelCount: channelCount,
        inputChannelLayout,
        outputMode: 'native-media',
        outputChannelCount: channelCount as 2 | 6,
        sourceSampleRate: sampleRate
    };
}

function prepareDTSAudioTrack(
    metadata: SelectedAudioTrackMetadata,
    outputChannelCount: CustomAudioOutputChannelCount
): PreparedAudioTrack {
    const { audioTrack, channelCount, inputChannelLayout, sampleRate } = metadata;
    if (!isSupportedCustomAudioInputLayout('dts', channelCount, sampleRate)) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected audio track does not match a qualified decoded PCM route'
        );
    }
    assertCustomAudioOutputChannelLayout(inputChannelLayout, outputChannelCount);

    return {
        audioConfiguration: {
            channelCount: outputChannelCount,
            codec: 'dts',
            sampleRate: CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
            sourceChannelCount: channelCount,
            sourceSampleRate: sampleRate
        },
        audioTrack,
        decoderBackend: 'dts',
        decoderConfig: null,
        inputChannelCount: channelCount,
        inputChannelLayout,
        outputMode: 'decoded-pcm',
        outputChannelCount,
        sourceSampleRate: sampleRate
    };
}

function prepareTrueHDAudioTrack(
    metadata: SelectedAudioTrackMetadata,
    outputChannelCount: CustomAudioOutputChannelCount
): PreparedAudioTrack {
    const {
        audioTrack,
        channelCount,
        inputChannelLayout,
        sampleRate,
        trueHDDecoderCodec
    } = metadata;
    if (!trueHDDecoderCodec
        || !isSupportedCustomAudioInputLayout(trueHDDecoderCodec, channelCount, sampleRate)) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected TrueHD track does not match a qualified decoded PCM route'
        );
    }
    assertCustomAudioOutputChannelLayout(inputChannelLayout, outputChannelCount);

    return {
        audioConfiguration: {
            channelCount: outputChannelCount,
            codec: trueHDDecoderCodec,
            sampleRate: CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
            sourceChannelCount: channelCount,
            sourceSampleRate: sampleRate
        },
        audioTrack,
        decoderBackend: trueHDDecoderCodec,
        decoderConfig: null,
        inputChannelCount: channelCount,
        inputChannelLayout,
        outputMode: 'decoded-pcm',
        outputChannelCount,
        sourceSampleRate: sampleRate
    };
}

async function prepareMediabunnyDecodedAudioTrack(
    metadata: SelectedAudioTrackMetadata,
    run: DecodeRun,
    outputChannelCount: CustomAudioOutputChannelCount
): Promise<PreparedAudioTrack> {
    const {
        audioTrack,
        channelCount,
        codec,
        decoderConfig,
        inputChannelLayout,
        sampleRate
    } = metadata;
    if (!codec || !decoderConfig) {
        throw new UnsupportedCustomDecodeSourceError(
            'The decoded PCM audio configuration is unavailable'
        );
    }
    if (!isSupportedCustomAudioInputLayout(codec, channelCount, sampleRate)) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected audio track does not match a qualified decoded PCM route'
        );
    }
    assertCustomAudioOutputChannelLayout(inputChannelLayout, outputChannelCount);
    await registerRequiredCustomAudioDecoder(codec);
    if (run.cancelled) {
        throw new UnsupportedCustomDecodeSourceError('Custom decode was cancelled');
    }
    const canDecode = await audioTrack.canDecode();
    if (!canDecode) {
        throw new UnsupportedCustomDecodeSourceError(
            `The browser cannot decode the selected ${codec} audio configuration`
        );
    }

    return {
        audioConfiguration: {
            channelCount: outputChannelCount,
            codec: decoderConfig.codec,
            sampleRate: CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE,
            sourceChannelCount: channelCount,
            sourceSampleRate: sampleRate
        },
        audioTrack,
        decoderBackend: 'mediabunny',
        decoderConfig,
        inputChannelCount: channelCount,
        inputChannelLayout,
        outputMode: 'decoded-pcm',
        outputChannelCount,
        sourceSampleRate: sampleRate
    };
}

async function prepareAudioTrack(
    input: Input,
    run: DecodeRun,
    audioTrackOrdinal: number,
    outputMode: CustomDecodeAudioOutputMode,
    decodedAudioOutputChannelCount: CustomAudioOutputChannelCount
): Promise<PreparedAudioTrack> {
    const metadata = await getSelectedAudioTrackMetadata(input, run, audioTrackOrdinal);
    switch (outputMode) {
        case 'native-media':
            return prepareNativeMediaAudioTrack(metadata);
        case 'decoded-pcm':
            if (metadata.isDTS) {
                return prepareDTSAudioTrack(metadata, decodedAudioOutputChannelCount);
            }
            return metadata.trueHDDecoderCodec ?
                prepareTrueHDAudioTrack(metadata, decodedAudioOutputChannelCount) :
                prepareMediabunnyDecodedAudioTrack(
                    metadata,
                    run,
                    decodedAudioOutputChannelCount
                );
    }
}

function postReadyResponse(
    run: DecodeRun,
    preparedVideoTrack: PreparedVideoTrack,
    preparedAudioTrack: PreparedAudioTrack | null
): void {
    const geometry = preparedVideoTrack.geometry;
    postResponse({
        audio: preparedAudioTrack?.audioConfiguration ?? null,
        codec: preparedVideoTrack.decoderConfig.codec,
        codedHeight: geometry.codedHeight,
        codedWidth: geometry.codedWidth,
        displayHeight: geometry.displayHeight,
        displayWidth: geometry.displayWidth,
        generation: run.generation,
        ...(preparedVideoTrack.staticHDRMetadataScan ? {
            staticHDRMetadataScan: preparedVideoTrack.staticHDRMetadataScan
        } : {}),
        type: 'ready'
    });
}

function lockDecodedFrameGeometry(
    run: DecodeRun,
    candidateGeometry: RawVideoFrameGeometry,
    selectedTrackGeometry: RawVideoFrameGeometry
): RawVideoFrameGeometry {
    try {
        const decodedVideoGeometry = requireConsistentDecodedVideoGeometry(
            candidateGeometry,
            selectedTrackGeometry,
            run.maximumCodedWidth,
            run.maximumCodedHeight,
            run.decodedVideoGeometry
        );
        run.decodedVideoGeometry = decodedVideoGeometry;
        return decodedVideoGeometry;
    } catch (error) {
        if (error instanceof DecodedVideoGeometryError) {
            throw new UnsupportedCustomDecodeSourceError(error.message);
        }
        throw error;
    }
}

function takeVideoFrame(sample: VideoSample): {
    durationMicroseconds: Microseconds
    frame: VideoFrame
    mediaTimeMicroseconds: Microseconds
} {
    try {
        const mediaTimeMicroseconds = requireMicroseconds(
            sample.microsecondTimestamp,
            'Decoded frame timestamp'
        );
        const durationMicroseconds = requireMicroseconds(
            sample.microsecondDuration,
            'Decoded frame duration'
        );
        if (durationMicroseconds < 0) {
            throw new RangeError('Decoded frame duration must not be negative');
        }

        return {
            durationMicroseconds,
            frame: sample.toVideoFrame(),
            mediaTimeMicroseconds
        };
    } finally {
        // VideoFrame ownership is independent, so do not retain the sample across copies
        sample.close();
    }
}

function takeOwnedVideoFrame(output: OwnedDecodedVideoOutput): {
    durationMicroseconds: Microseconds
    frame: VideoFrame
    mediaTimeMicroseconds: Microseconds
} {
    switch (output.source.kind) {
        case 'native-frame':
            return {
                durationMicroseconds: output.durationMicroseconds,
                frame: output.source.frame,
                mediaTimeMicroseconds: output.mediaTimeMicroseconds
            };
        case 'video-sample':
            return takeVideoFrame(output.source.sample);
    }
}

type MutableDecodeWorkerFrameResponse = Extract<DecodeWorkerResponse, { type: 'frame' }>;

function attachDolbyVisionEncodedMetadata(
    response: MutableDecodeWorkerFrameResponse,
    metadata: DolbyVisionEncodedFrameMetadata | null
): Transferable[] {
    const transferableMetadata = takeTransferableDolbyVisionEncodedFrameMetadata(metadata);
    if (transferableMetadata) {
        response.encodedDolbyVisionMetadata = transferableMetadata;
    }
    return getDolbyVisionEncodedMetadataTransferList(transferableMetadata);
}

function attachHDR10PlusMetadata(
    response: MutableDecodeWorkerFrameResponse,
    metadata: HDR10PlusFrameMetadata | null | undefined
): void {
    if (metadata) {
        response.HDR10PlusMetadata = metadata;
    }
}

async function postRawVideoFrame(
    run: DecodeRun,
    frame: VideoFrame,
    decodedVideoGeometry: RawVideoFrameGeometry,
    durationMicroseconds: Microseconds,
    mediaTimeMicroseconds: Microseconds,
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null,
    HDR10PlusMetadata: HDR10PlusFrameMetadata | null | undefined
): Promise<void> {
    const rawVideoFrameFormat = run.rawVideoFrameFormat;
    if (rawVideoFrameFormat === null) {
        frame.close();
        throw new UnsupportedCustomDecodeSourceError(
            'The raw video frame output format is unavailable'
        );
    }
    const bufferLease = run.rawFrameBufferPool?.acquire() ?? null;
    if (!bufferLease) {
        frame.close();
        throw new UnsupportedCustomDecodeSourceError(
            'The raw video frame buffer pool was exhausted'
        );
    }
    const rawFrame = await copyVideoFrameToRawPlanes(frame, {
        expectedGeometry: decodedVideoGeometry,
        format: rawVideoFrameFormat,
        requireReusableBuffer: bufferLease.kind === 'reuse',
        reusableBuffer: bufferLease.kind === 'reuse' ?
            bufferLease.buffer :
            undefined
    });
    if (run.cancelled || currentRun !== run) {
        return;
    }
    if (rawFrame.timestampMicroseconds !== mediaTimeMicroseconds) {
        throw new UnsupportedCustomDecodeSourceError(
            'The decoded raw frame timestamp did not match its media sample'
        );
    }
    if (run.outstandingRawFrameBufferCount >= MAX_DECODED_RAW_FRAME_CREDITS) {
        throw new UnsupportedCustomDecodeSourceError(
            'The raw video frame buffer window exceeded its bound'
        );
    }

    run.outstandingRawFrameBufferCount += 1;
    const response: MutableDecodeWorkerFrameResponse = {
        durationMicroseconds: rawFrame.durationMicroseconds ?? durationMicroseconds,
        frame: rawFrame,
        generation: run.generation,
        mediaTimeMicroseconds,
        outputMode: 'raw-planes',
        type: 'frame'
    };
    const transferables = getRawVideoFrameTransferList(rawFrame);
    attachHDR10PlusMetadata(response, HDR10PlusMetadata);
    transferables.push(...attachDolbyVisionEncodedMetadata(
        response,
        encodedDolbyVisionMetadata
    ));
    postResponse(response, transferables);
}

type RawVideoFramePairPostRequest = {
    baseFrame: VideoFrame
    baseGeometry: RawVideoFrameGeometry
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null
    HDR10PlusMetadata: HDR10PlusFrameMetadata | null | undefined
    enhancementFrame: VideoFrame | null
    enhancementGeometry: RawVideoFrameGeometry
    mediaTimeMicroseconds: Microseconds
};

async function postRawVideoFramePair(
    run: DecodeRun,
    request: RawVideoFramePairPostRequest
): Promise<void> {
    const {
        baseFrame,
        baseGeometry,
        durationMicroseconds,
        encodedDolbyVisionMetadata,
        HDR10PlusMetadata,
        enhancementFrame,
        enhancementGeometry,
        mediaTimeMicroseconds
    } = request;
    const rawVideoFrameFormat = run.rawVideoFrameFormat;
    if (rawVideoFrameFormat === null) {
        baseFrame.close();
        enhancementFrame?.close();
        throw new UnsupportedCustomDecodeSourceError(
            'The compound raw video frame output format is unavailable'
        );
    }
    const bufferLease = run.rawFrameBufferPool?.acquire() ?? null;
    if (!bufferLease) {
        baseFrame.close();
        enhancementFrame?.close();
        throw new UnsupportedCustomDecodeSourceError(
            'The compound raw video frame buffer pool was exhausted'
        );
    }
    const rawFramePair = await copyVideoFramePairToRawPlanes(
        baseFrame,
        enhancementFrame,
        {
            baseExpectedGeometry: baseGeometry,
            enhancementExpectedGeometry: enhancementGeometry,
            format: rawVideoFrameFormat,
            requireReusableBuffer: bufferLease.kind === 'reuse',
            reusableBuffer: bufferLease.kind === 'reuse' ?
                bufferLease.buffer :
                undefined
        }
    );
    if (run.cancelled || currentRun !== run) {
        return;
    }
    if (rawFramePair.baseFrame.timestampMicroseconds !== mediaTimeMicroseconds) {
        throw new UnsupportedCustomDecodeSourceError(
            'The decoded compound raw frame timestamp did not match its media sample'
        );
    }
    if (run.outstandingRawFrameBufferCount >= MAX_DECODED_RAW_FRAME_CREDITS) {
        throw new UnsupportedCustomDecodeSourceError(
            'The compound raw video frame buffer window exceeded its bound'
        );
    }

    run.outstandingRawFrameBufferCount += 1;
    if (rawFramePair.enhancementFrame && encodedDolbyVisionMetadata) {
        switch (encodedDolbyVisionMetadata.enhancementLayerDisposition) {
            case 'discarded-fel':
                encodedDolbyVisionMetadata.enhancementLayerDisposition = 'decoded-fel';
                break;
            case 'discarded-mel':
                encodedDolbyVisionMetadata.enhancementLayerDisposition = 'decoded-mel';
                break;
            case 'absent':
            case 'decoded-fel':
            case 'decoded-mel':
                break;
        }
    }
    const response: MutableDecodeWorkerFrameResponse = {
        durationMicroseconds: rawFramePair.baseFrame.durationMicroseconds
            ?? durationMicroseconds,
        enhancementFrame: rawFramePair.enhancementFrame,
        frame: rawFramePair.baseFrame,
        generation: run.generation,
        mediaTimeMicroseconds,
        outputMode: 'raw-planes',
        type: 'frame'
    };
    const transferables = getRawVideoFramePairTransferList(rawFramePair);
    attachHDR10PlusMetadata(response, HDR10PlusMetadata);
    transferables.push(...attachDolbyVisionEncodedMetadata(
        response,
        encodedDolbyVisionMetadata
    ));
    postResponse(response, transferables);
}

function postTransferredVideoFrame(
    run: DecodeRun,
    frame: VideoFrame,
    durationMicroseconds: Microseconds,
    mediaTimeMicroseconds: Microseconds,
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null,
    HDR10PlusMetadata: HDR10PlusFrameMetadata | null | undefined
): void {
    const response: MutableDecodeWorkerFrameResponse = {
        durationMicroseconds,
        frame,
        generation: run.generation,
        mediaTimeMicroseconds,
        outputMode: 'video-frame',
        type: 'frame'
    };
    attachHDR10PlusMetadata(response, HDR10PlusMetadata);
    const transferables: Transferable[] = [ frame as unknown as Transferable ];
    transferables.push(...attachDolbyVisionEncodedMetadata(
        response,
        encodedDolbyVisionMetadata
    ));
    postResponse(response, transferables);
}

async function postVideoFrame(
    run: DecodeRun,
    output: OwnedDecodedVideoOutput,
    expectedGeometry: RawVideoFrameGeometry,
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null = null,
    enhancementOutput: OwnedDecodedVideoOutput | null = null,
    enhancementExpectedGeometry: RawVideoFrameGeometry | null = null
): Promise<void> {
    let frame: VideoFrame | null = null;
    let enhancementFrame: VideoFrame | null = null;
    try {
        const decodedFrame = takeOwnedVideoFrame(output);
        const durationMicroseconds = decodedFrame.durationMicroseconds;
        const mediaTimeMicroseconds = decodedFrame.mediaTimeMicroseconds;
        frame = decodedFrame.frame;
        const candidateGeometry = output.source.kind === 'native-frame' ?
            output.source.geometry :
            {
                codedHeight: frame.codedHeight,
                codedWidth: frame.codedWidth,
                displayHeight: frame.displayHeight,
                displayWidth: frame.displayWidth
            };
        const decodedVideoGeometry = lockDecodedFrameGeometry(
            run,
            candidateGeometry,
            expectedGeometry
        );
        if (run.cancelled || currentRun !== run) {
            return;
        }
        if (enhancementOutput) {
            const decodedEnhancementFrame = takeOwnedVideoFrame(enhancementOutput);
            enhancementFrame = decodedEnhancementFrame.frame;
            if (
                Math.abs(
                    decodedEnhancementFrame.mediaTimeMicroseconds
                    - mediaTimeMicroseconds
                ) > 1
            ) {
                throw new UnsupportedCustomDecodeSourceError(
                    'The decoded Dolby Vision layers have mismatched timestamps'
                );
            }
        }

        switch (run.videoOutputMode) {
            case 'raw-planes': {
                const ownedFrame = frame;
                frame = null;
                if (enhancementExpectedGeometry) {
                    const ownedEnhancementFrame = enhancementFrame;
                    enhancementFrame = null;
                    await postRawVideoFramePair(run, {
                        baseFrame: ownedFrame,
                        baseGeometry: decodedVideoGeometry,
                        durationMicroseconds,
                        encodedDolbyVisionMetadata,
                        HDR10PlusMetadata: output.HDR10PlusMetadata,
                        enhancementFrame: ownedEnhancementFrame,
                        enhancementGeometry: enhancementExpectedGeometry,
                        mediaTimeMicroseconds
                    });
                    return;
                }
                await postRawVideoFrame(
                    run,
                    ownedFrame,
                    decodedVideoGeometry,
                    durationMicroseconds,
                    mediaTimeMicroseconds,
                    encodedDolbyVisionMetadata,
                    output.HDR10PlusMetadata
                );
                return;
            }
            case 'video-frame':
                postTransferredVideoFrame(
                    run,
                    frame,
                    durationMicroseconds,
                    mediaTimeMicroseconds,
                    encodedDolbyVisionMetadata,
                    output.HDR10PlusMetadata
                );
                frame = null;
                return;
        }
    } finally {
        frame?.close();
        enhancementFrame?.close();
    }
}

function normalizeAudioSample(
    sample: AudioSample,
    preparedAudioTrack: PreparedAudioTrack,
    startTimeMicroseconds: Microseconds,
    resampler: StreamingAudioResampler
): StreamingAudioResamplerOutput[] {
    try {
        const sampleTimeMicroseconds = requireMicroseconds(
            sample.microsecondTimestamp,
            'Decoded audio timestamp'
        );
        if (
            sample.numberOfChannels !== preparedAudioTrack.inputChannelCount
            || sample.sampleRate !== preparedAudioTrack.sourceSampleRate
        ) {
            throw new UnsupportedCustomDecodeSourceError('Decoded audio format changed during playback');
        }
        if (
            !Number.isSafeInteger(sample.numberOfFrames)
            || sample.numberOfFrames <= 0
            || sample.numberOfFrames > MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE
        ) {
            throw new UnsupportedCustomDecodeSourceError('A decoded audio sample exceeded the supported size');
        }
        const sampleWindow = getAudioSampleWindow(
            sampleTimeMicroseconds,
            sample.numberOfFrames,
            sample.sampleRate,
            startTimeMicroseconds
        );
        if (!sampleWindow) {
            return [];
        }

        const inputChannelData: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < sample.numberOfChannels; channelIndex += 1) {
            const channel = new Float32Array(sampleWindow.frameCount);
            sample.copyTo(channel, {
                frameCount: sampleWindow.frameCount,
                frameOffset: sampleWindow.frameOffset,
                format: 'f32-planar',
                planeIndex: channelIndex
            });
            inputChannelData.push(channel);
        }

        const channelData = prepareCustomAudioOutputChannelData(
            inputChannelData,
            preparedAudioTrack.inputChannelLayout,
            preparedAudioTrack.outputChannelCount
        );
        return resampler.push({
            channelData,
            mediaTimeMicroseconds: sampleWindow.mediaTimeMicroseconds
        });
    } finally {
        sample.close();
    }
}

function normalizeDTSAudioOutput(
    output: DTSDecodedAudioOutput,
    preparedAudioTrack: PreparedAudioTrack,
    startTimeMicroseconds: Microseconds,
    resampler: StreamingAudioResampler
): StreamingAudioResamplerOutput[] {
    if (output.channelData.length !== preparedAudioTrack.inputChannelCount
        || output.sampleRate !== preparedAudioTrack.sourceSampleRate
        || !isSupportedCustomAudioInputLayout(
            'dts',
            output.channelData.length,
            output.sampleRate
        )) {
        throw new UnsupportedCustomDecodeSourceError(
            'Decoded DTS audio format changed during playback'
        );
    }
    const sampleWindow = getAudioSampleWindow(
        output.mediaTimeMicroseconds,
        output.frameCount,
        output.sampleRate,
        startTimeMicroseconds
    );
    if (!sampleWindow) {
        return [];
    }

    const inputChannelData: Float32Array[] = [];
    const endFrame = sampleWindow.frameOffset + sampleWindow.frameCount;
    for (const channel of output.channelData) {
        inputChannelData.push(channel.slice(sampleWindow.frameOffset, endFrame));
    }
    const channelData = prepareCustomAudioOutputChannelData(
        inputChannelData,
        output.channelLayout,
        preparedAudioTrack.outputChannelCount
    );
    return resampler.push({
        channelData,
        mediaTimeMicroseconds: sampleWindow.mediaTimeMicroseconds
    });
}

function normalizeTrueHDAudioOutput(
    output: TrueHDDecodedAudioOutput,
    preparedAudioTrack: PreparedAudioTrack,
    startTimeMicroseconds: Microseconds,
    resampler: StreamingAudioResampler
): StreamingAudioResamplerOutput[] {
    if (output.codec !== preparedAudioTrack.decoderBackend
        || output.channelData.length !== preparedAudioTrack.inputChannelCount
        || output.sampleRate !== preparedAudioTrack.sourceSampleRate
        || !isSupportedCustomAudioInputLayout(
            output.codec,
            output.channelData.length,
            output.sampleRate
        )) {
        throw new UnsupportedCustomDecodeSourceError(
            'Decoded TrueHD audio format changed during playback'
        );
    }
    const sampleWindow = getAudioSampleWindow(
        output.mediaTimeMicroseconds,
        output.frameCount,
        output.sampleRate,
        startTimeMicroseconds
    );
    if (!sampleWindow) {
        return [];
    }

    const inputChannelData: Float32Array[] = [];
    const endFrame = sampleWindow.frameOffset + sampleWindow.frameCount;
    for (const channel of output.channelData) {
        inputChannelData.push(channel.slice(sampleWindow.frameOffset, endFrame));
    }
    const channelData = prepareCustomAudioOutputChannelData(
        inputChannelData,
        output.channelLayout,
        preparedAudioTrack.outputChannelCount
    );
    return resampler.push({
        channelData,
        mediaTimeMicroseconds: sampleWindow.mediaTimeMicroseconds
    });
}

async function postNormalizedAudioOutput(
    run: DecodeRun,
    outputs: readonly StreamingAudioResamplerOutput[],
    reservedCredit: boolean
): Promise<boolean> {
    let creditAvailable = reservedCredit;
    for (const output of outputs) {
        if (!creditAvailable && !await waitForAudioSampleCredit(run)) {
            return false;
        }
        creditAvailable = false;
        if (run.cancelled) {
            return false;
        }
        const channelData = output.channelData;
        const transferables = channelData.map(channel => channel.buffer);
        postResponse({
            channelCount: channelData.length,
            channelData,
            durationMicroseconds: output.durationMicroseconds,
            frameCount: output.frameCount,
            generation: run.generation,
            mediaTimeMicroseconds: output.mediaTimeMicroseconds,
            sampleRate: output.sampleRate,
            type: 'audio'
        }, transferables);
    }
    if (creditAvailable && !run.cancelled) {
        addAudioSampleCredits(run, 1);
    }
    return !run.cancelled;
}

type OwnedDecodedVideoSource =
    | {
        frame: VideoFrame
        geometry: RawVideoFrameGeometry
        kind: 'native-frame'
    }
    | {
        kind: 'video-sample'
        sample: VideoSample
    };

type OwnedDecodedVideoOutput = {
    durationMicroseconds: Microseconds
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null
    HDR10PlusMetadata?: HDR10PlusFrameMetadata | null
    mediaTimeMicroseconds: Microseconds
    source: OwnedDecodedVideoSource
};

type OwnedHEVCVideoDecoderCallbacks = {
    onError: (error: unknown) => void
    onOutput: (output: OwnedDecodedVideoSource) => void
    onProgress: () => void
};

type OwnedHEVCVideoDecoderPort = {
    close: () => void
    decode: (packet: EncodedPacket) => boolean
    flush: () => Promise<void>
    getDecodeQueueSize: () => number
    init: () => Promise<void>
};

type OwnedOutputPostResult = 'none' | 'posted' | 'stopped';

function getOwnedDecodedVideoTiming(source: OwnedDecodedVideoSource): {
    durationMicroseconds: Microseconds
    mediaTimeMicroseconds: Microseconds
} {
    const durationMicrosecondsValue = source.kind === 'native-frame' ?
        source.frame.duration ?? 0 :
        source.sample.microsecondDuration;
    const mediaTimeMicrosecondsValue = source.kind === 'native-frame' ?
        source.frame.timestamp :
        source.sample.microsecondTimestamp;
    const durationMicroseconds = requireMicroseconds(
        durationMicrosecondsValue,
        'Owned decoded HEVC frame duration'
    );
    if (durationMicroseconds < 0) {
        throw new RangeError('Owned decoded HEVC frame duration must not be negative');
    }
    return {
        durationMicroseconds,
        mediaTimeMicroseconds: requireMicroseconds(
            mediaTimeMicrosecondsValue,
            'Owned decoded HEVC frame timestamp'
        )
    };
}

function closeOwnedDecodedVideoSource(source: OwnedDecodedVideoSource | null): void {
    try {
        switch (source?.kind) {
            case 'native-frame':
                source.frame.close();
                break;
            case 'video-sample':
                source.sample.close();
                break;
        }
    } catch {
        // Ownership ends even when a decoder implementation throws while closing
    }
}

function closeOwnedDecodedVideoOutput(output: OwnedDecodedVideoOutput | null): void {
    closeOwnedDecodedVideoSource(output?.source ?? null);
}

function createOwnedBundledHEVCVideoDecoderPort(
    config: VideoDecoderConfig,
    callbacks: OwnedHEVCVideoDecoderCallbacks
): OwnedHEVCVideoDecoderPort {
    const decoder = createOwnedHEVCSoftwareVideoDecoder(config, {
        onError: callbacks.onError,
        onSample: (sample: VideoSample): void => {
            try {
                callbacks.onOutput({
                    kind: 'video-sample',
                    sample
                });
            } finally {
                callbacks.onProgress();
            }
        }
    });
    return {
        close: (): void => decoder.close(),
        decode: (packet: EncodedPacket): boolean => {
            decoder.decode(packet);
            return true;
        },
        flush: (): Promise<void> => {
            decoder.flush();
            return Promise.resolve();
        },
        getDecodeQueueSize: (): number => 0,
        init: (): Promise<void> => decoder.init()
    };
}

function createOwnedHEVCVideoDecoderPort(
    run: DecodeRun,
    decoderConfig: VideoDecoderConfig,
    inputFormat: ReturnType<typeof getHEVCNALFormat>,
    callbacks: OwnedHEVCVideoDecoderCallbacks
): OwnedHEVCVideoDecoderPort {
    switch (run.videoDecoderBackend) {
        case 'bundled-hevc':
            return createOwnedBundledHEVCVideoDecoderPort(decoderConfig, callbacks);
        case 'native':
            return new OwnedNativeHEVCVideoDecoder(
                {
                    ...decoderConfig,
                    hardwareAcceleration: getCustomDecodeHardwareAcceleration(
                        run.videoOutputMode,
                        run.videoDecoderBackend
                    ),
                    optimizeForLatency: true
                },
                inputFormat,
                {
                    onError: callbacks.onError,
                    onFrame: (frame: VideoFrame): void => callbacks.onOutput({
                        frame,
                        geometry: {
                            codedHeight: frame.codedHeight,
                            codedWidth: frame.codedWidth,
                            displayHeight: frame.displayHeight,
                            displayWidth: frame.displayWidth
                        },
                        kind: 'native-frame'
                    }),
                    onProgress: callbacks.onProgress
                },
                undefined,
                {
                    nativeHDRTransfer: run.nativeHDRTransfer ?? undefined,
                    neutralizeHDRColorMetadata: run.neutralizeHDRColorMetadata
                }
            );
        case 'openjpeg':
            throw new Error('The OpenJPEG route does not use an HEVC decoder port');
        case 'legacy-software':
            throw new Error('The legacy software route does not use an HEVC decoder port');
    }
}

class OwnedHEVCStreamState {
    private decoderFailure: unknown = null;
    private enhancementDecoderFailed = false;
    private readonly framePairs = new DolbyVisionFramePairQueue<
        OwnedDecodedVideoOutput,
        OwnedDecodedVideoOutput
    >(closeOwnedDecodedVideoOutput, closeOwnedDecodedVideoOutput);
    private firstPresentationOutputQueued = false;
    private frameCreditHeld = false;
    private preStartOutput: OwnedDecodedVideoOutput | null = null;
    public packetsEnded = false;

    public constructor(
        private readonly metadataQueue: DolbyVisionEncodedMetadataQueue,
        private readonly dynamicHDRMetadataQueue: HEVCDynamicHDRMetadataQueue,
        private readonly startTimeMicroseconds: Microseconds,
        private readonly enhancementExpectedGeometry: RawVideoFrameGeometry | null
    ) {
        if (!enhancementExpectedGeometry) {
            this.framePairs.finishEnhancement();
        }
    }

    public recordDecoderFailure(error: unknown): void {
        this.decoderFailure ??= error;
    }

    public recordEnhancementDecoderFailure(): void {
        if (this.enhancementDecoderFailed) {
            return;
        }
        this.enhancementDecoderFailed = true;
        this.framePairs.finishEnhancement();
    }

    public canDecodeEnhancement(): boolean {
        return this.enhancementExpectedGeometry !== null
            && !this.enhancementDecoderFailed;
    }

    public enqueueDecodedOutput(source: OwnedDecodedVideoSource): void {
        let decodedOutput: OwnedDecodedVideoOutput | null = null;
        let sourceOwned = true;
        try {
            const timing = getOwnedDecodedVideoTiming(source);
            decodedOutput = {
                durationMicroseconds: timing.durationMicroseconds,
                encodedDolbyVisionMetadata: this.metadataQueue.takeFrameMetadata(
                    timing.mediaTimeMicroseconds
                ),
                HDR10PlusMetadata: this.dynamicHDRMetadataQueue.takeFrameMetadata(
                    timing.mediaTimeMicroseconds
                ),
                mediaTimeMicroseconds: timing.mediaTimeMicroseconds,
                source
            };
            sourceOwned = false;
            if (
                timing.mediaTimeMicroseconds < this.startTimeMicroseconds
                && !this.firstPresentationOutputQueued
            ) {
                closeOwnedDecodedVideoOutput(this.preStartOutput);
                this.preStartOutput = decodedOutput;
                decodedOutput = null;
                return;
            }

            this.queueFirstPresentationOutput();
            this.queueBaseOutput(decodedOutput);
            decodedOutput = null;
        } finally {
            closeOwnedDecodedVideoOutput(decodedOutput);
            if (sourceOwned) {
                closeOwnedDecodedVideoSource(source);
            }
        }
    }

    public enqueueEnhancementDecodedOutput(source: OwnedDecodedVideoSource): void {
        let decodedOutput: OwnedDecodedVideoOutput | null = null;
        let sourceOwned = true;
        try {
            if (!this.canDecodeEnhancement()) {
                return;
            }
            const timing = getOwnedDecodedVideoTiming(source);
            decodedOutput = {
                durationMicroseconds: timing.durationMicroseconds,
                encodedDolbyVisionMetadata: null,
                mediaTimeMicroseconds: timing.mediaTimeMicroseconds,
                source
            };
            sourceOwned = false;
            this.framePairs.enqueueEnhancementFrame({
                frame: decodedOutput,
                mediaTimeMicroseconds: decodedOutput.mediaTimeMicroseconds
            });
            decodedOutput = null;
        } finally {
            closeOwnedDecodedVideoOutput(decodedOutput);
            if (sourceOwned) {
                closeOwnedDecodedVideoSource(source);
            }
        }
    }

    public async decodePacket(
        packet: EncodedPacket,
        decoder: OwnedHEVCVideoDecoderPort,
        enhancementDecoder: OwnedHEVCVideoDecoderPort | null,
        separateEnhancementPacket: EncodedPacket | null = null,
        separateEnhancementInputFormat: HEVCNALFormat | null = null
    ): Promise<void> {
        this.dynamicHDRMetadataQueue.processPacket(packet);
        const processedPacket = await this.processEncodedPacket(
            packet,
            separateEnhancementPacket,
            separateEnhancementInputFormat
        );
        this.decodeEnhancementPacket(processedPacket, enhancementDecoder);
        this.decodeBasePacket(packet, processedPacket, decoder);
        this.throwDecoderFailure();
    }

    private async processEncodedPacket(
        packet: EncodedPacket,
        separateEnhancementPacket: EncodedPacket | null,
        separateEnhancementInputFormat: HEVCNALFormat | null
    ): Promise<ProcessedDolbyVisionHEVCPacket> {
        if (separateEnhancementPacket && separateEnhancementInputFormat) {
            try {
                return await this.metadataQueue.processSeparatePackets(
                    packet,
                    separateEnhancementPacket,
                    separateEnhancementInputFormat
                );
            } catch {
                this.recordEnhancementDecoderFailure();
            }
        }
        return this.metadataQueue.processPacket(packet);
    }

    private decodeEnhancementPacket(
        processedPacket: ProcessedDolbyVisionHEVCPacket,
        enhancementDecoder: OwnedHEVCVideoDecoderPort | null
    ): void {
        const enhancementDecoderPacket = processedPacket.enhancementLayerPacket;
        if (!enhancementDecoderPacket || !enhancementDecoder || !this.canDecodeEnhancement()) {
            return;
        }
        try {
            const packetAccepted = enhancementDecoder.decode(enhancementDecoderPacket);
            if (!packetAccepted && processedPacket.hasEnhancementLayerVCL) {
                this.recordEnhancementDecoderFailure();
            }
        } catch {
            this.recordEnhancementDecoderFailure();
        }
    }

    private decodeBasePacket(
        sourcePacket: EncodedPacket,
        processedPacket: ProcessedDolbyVisionHEVCPacket,
        decoder: OwnedHEVCVideoDecoderPort
    ): void {
        const decoderPacket = processedPacket.baseLayerPacket;
        if (!decoderPacket) {
            return;
        }
        const packetAccepted = decoder.decode(decoderPacket);
        if (!packetAccepted && processedPacket.hasBaseLayerVCL) {
            this.metadataQueue.takeFrameMetadata(sourcePacket.microsecondTimestamp);
            this.dynamicHDRMetadataQueue.takeFrameMetadata(
                sourcePacket.microsecondTimestamp
            );
        }
    }

    public async finishPackets(
        decoder: OwnedHEVCVideoDecoderPort,
        enhancementDecoder: OwnedHEVCVideoDecoderPort | null
    ): Promise<void> {
        await decoder.flush();
        this.throwDecoderFailure();
        if (enhancementDecoder && this.canDecodeEnhancement()) {
            try {
                await enhancementDecoder.flush();
            } catch {
                this.recordEnhancementDecoderFailure();
            }
        }
        if (this.enhancementExpectedGeometry) {
            this.framePairs.finishEnhancement();
        }
        this.metadataQueue.requireDrained();
        this.dynamicHDRMetadataQueue.requireDrained();
        this.queueFirstPresentationOutput();
        this.packetsEnded = true;
    }

    public async postNextOutput(
        run: DecodeRun,
        expectedGeometry: RawVideoFrameGeometry
    ): Promise<OwnedOutputPostResult> {
        if (!this.framePairs.hasReadyPair()) {
            return 'none';
        }
        if (!await this.acquireFrameCredit(run)) {
            return 'stopped';
        }

        const framePair = this.framePairs.takeReadyPair() as DolbyVisionFramePair<
            OwnedDecodedVideoOutput,
            OwnedDecodedVideoOutput
        >;
        await postVideoFrame(
            run,
            framePair.baseFrame,
            expectedGeometry,
            framePair.baseFrame.encodedDolbyVisionMetadata,
            framePair.enhancementFrame,
            this.enhancementExpectedGeometry
        );
        this.frameCreditHeld = false;
        return 'posted';
    }

    public async acquireFrameCredit(run: DecodeRun): Promise<boolean> {
        if (!this.frameCreditHeld) {
            this.frameCreditHeld = await waitForFrameCredit(run);
        }
        return this.frameCreditHeld;
    }

    public async waitForDecoderProgress(run: DecodeRun): Promise<void> {
        this.throwDecoderFailure();
        if (this.framePairs.hasReadyPair() || run.cancelled) {
            return;
        }
        await new Promise<void>(resolve => {
            run.wakeVideoDecodeWaiters.push(resolve);
        });
        this.throwDecoderFailure();
    }

    public close(): void {
        closeOwnedDecodedVideoOutput(this.preStartOutput);
        this.preStartOutput = null;
        this.framePairs.close();
        this.metadataQueue.clear();
        this.dynamicHDRMetadataQueue.clear();
    }

    private queueBaseOutput(decodedOutput: OwnedDecodedVideoOutput): void {
        this.framePairs.enqueueBaseFrame({
            frame: decodedOutput,
            mediaTimeMicroseconds: decodedOutput.mediaTimeMicroseconds
        });
    }

    private queueFirstPresentationOutput(): void {
        if (this.firstPresentationOutputQueued) {
            return;
        }
        this.firstPresentationOutputQueued = true;
        if (this.preStartOutput) {
            this.queueBaseOutput(this.preStartOutput);
            this.preStartOutput = null;
        }
    }

    private throwDecoderFailure(): void {
        if (this.decoderFailure) {
            throw this.decoderFailure;
        }
    }
}

async function createSeparateDolbyVisionEnhancementPacketStream(
    run: DecodeRun,
    configuration: DolbyVisionEnhancementDecoderConfiguration,
    startTimeMicroseconds: Microseconds
): Promise<SeparateDolbyVisionEnhancementPacketStream | null> {
    if (configuration.source.kind !== 'separate-track' || run.cancelled) {
        return null;
    }
    try {
        const packetSink = new EncodedPacketSink(configuration.source.videoTrack);
        const startTimeSeconds = microsecondsToSeconds(startTimeMicroseconds);
        const keyPacket = await packetSink.getKeyPacket(
            startTimeSeconds,
            OWNED_HEVC_PACKET_OPTIONS
        ) ?? await packetSink.getFirstKeyPacket(OWNED_HEVC_PACKET_OPTIONS);
        if (!keyPacket || run.cancelled) {
            return null;
        }
        const iterator = packetSink.packets(
            keyPacket,
            undefined,
            OWNED_HEVC_PACKET_OPTIONS
        );
        const pairer = new DolbyVisionEncodedPacketPairer(iterator);
        run.enhancementPacketPairer = pairer;
        return {
            inputFormat: configuration.packetFormat,
            pairer
        };
    } catch {
        return null;
    }
}

async function decodeOwnedHEVCPacket(
    run: DecodeRun,
    packet: EncodedPacket,
    packetMediaTimeMicroseconds: Microseconds,
    decoder: OwnedHEVCVideoDecoderPort,
    enhancementDecoder: OwnedHEVCVideoDecoderPort | null,
    separateEnhancementStream: SeparateDolbyVisionEnhancementPacketStream | null,
    state: OwnedHEVCStreamState
): Promise<boolean> {
    let separateEnhancementPacket: EncodedPacket | null = null;
    if (separateEnhancementStream && state.canDecodeEnhancement()) {
        try {
            separateEnhancementPacket = await separateEnhancementStream.pairer.takeMatchingPacket(
                packetMediaTimeMicroseconds
            );
            if (!separateEnhancementPacket) {
                state.recordEnhancementDecoderFailure();
                await separateEnhancementStream.pairer.retire();
            }
        } catch {
            state.recordEnhancementDecoderFailure();
            await separateEnhancementStream.pairer.retire();
        }
    }
    if (run.cancelled) {
        return false;
    }
    await state.decodePacket(
        packet,
        decoder,
        enhancementDecoder,
        separateEnhancementPacket,
        separateEnhancementStream?.inputFormat ?? null
    );
    if (
        separateEnhancementStream
        && !separateEnhancementStream.pairer.retired
        && !state.canDecodeEnhancement()
    ) {
        await separateEnhancementStream.pairer.retire();
    }
    return true;
}

function isOwnedHEVCDecoderBackpressured(
    decoder: OwnedHEVCVideoDecoderPort,
    enhancementDecoder: OwnedHEVCVideoDecoderPort | null,
    state: OwnedHEVCStreamState
): boolean {
    if (decoder.getDecodeQueueSize() > OWNED_VIDEO_DECODER_QUEUE_HIGH_WATER_MARK) {
        return true;
    }
    return state.canDecodeEnhancement()
        && enhancementDecoder !== null
        && enhancementDecoder.getDecodeQueueSize() > OWNED_VIDEO_DECODER_QUEUE_HIGH_WATER_MARK;
}

async function pumpOwnedHEVCFrames(
    run: DecodeRun,
    packetIterator: MediaSampleIterator<EncodedPacket>,
    decoder: OwnedHEVCVideoDecoderPort,
    enhancementDecoder: OwnedHEVCVideoDecoderPort | null,
    separateEnhancementStream: SeparateDolbyVisionEnhancementPacketStream | null,
    state: OwnedHEVCStreamState,
    expectedGeometry: RawVideoFrameGeometry
): Promise<void> {
    let packetCount = 0;
    while (!run.cancelled) {
        const postResult = await state.postNextOutput(run, expectedGeometry);
        switch (postResult) {
            case 'posted':
                continue;
            case 'stopped':
                return;
            case 'none':
                break;
        }

        if (state.packetsEnded) {
            return;
        }
        if (isOwnedHEVCDecoderBackpressured(decoder, enhancementDecoder, state)) {
            await state.waitForDecoderProgress(run);
            continue;
        }
        if (!await state.acquireFrameCredit(run)) {
            return;
        }

        const packetResult = await packetIterator.next();
        if (run.cancelled) {
            return;
        }
        if (packetResult.done) {
            await state.finishPackets(decoder, enhancementDecoder);
            continue;
        }
        packetCount += 1;
        const packetMediaTimeMicroseconds = requireMicroseconds(
            packetResult.value.microsecondTimestamp,
            'Owned HEVC packet timestamp'
        );
        postVideoStartupProgress(
            run,
            'video-packet-started',
            packetCount,
            packetMediaTimeMicroseconds
        );
        if (!await decodeOwnedHEVCPacket(
            run,
            packetResult.value,
            packetMediaTimeMicroseconds,
            decoder,
            enhancementDecoder,
            separateEnhancementStream,
            state
        )) {
            return;
        }
        postVideoStartupProgress(
            run,
            'video-packet-decoded',
            packetCount,
            packetMediaTimeMicroseconds
        );
    }
}

async function readDolbyVisionMetadataByteRange(
    run: DecodeRun,
    url: string,
    abortController: AbortController,
    offset: number,
    byteLength: number
): Promise<Uint8Array | null> {
    if (
        run.cancelled
        || !Number.isSafeInteger(offset)
        || offset < 0
        || !Number.isSafeInteger(byteLength)
        || byteLength <= 0
    ) {
        return null;
    }
    const lastByte = offset + byteLength - 1;
    if (!Number.isSafeInteger(lastByte)) {
        return null;
    }
    const response = await validatedRangeFetch(url, {
        headers: {
            Range: `bytes=${offset}-${lastByte}`
        },
        signal: abortController.signal
    });
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > byteLength) {
        return null;
    }
    return data;
}

async function readContainerDolbyVisionTrackConfiguration(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    containerTrackNumber: number
): Promise<ContainerDolbyVisionTrackConfiguration | null> {
    if (run.cancelled) {
        return null;
    }
    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
    const abortController = new AbortController();
    run.metadataAbortController = abortController;
    try {
        const reader = (
            offset: number,
            byteLength: number
        ): Promise<Uint8Array | null> => readDolbyVisionMetadataByteRange(
            run,
            request.url,
            abortController,
            offset,
            byteLength
        );
        const matroskaConfiguration = await readMatroskaDolbyVisionTrackConfiguration(
            reader,
            containerTrackNumber
        );
        if (matroskaConfiguration && (
            matroskaConfiguration.enhancementConfiguration
            || matroskaConfiguration.separateEnhancementTrackNumber !== null
        )) {
            return {
                enhancementConfiguration: matroskaConfiguration.enhancementConfiguration,
                separateEnhancement: matroskaConfiguration.separateEnhancementTrackNumber === null ?
                    null :
                    {
                        decoderDescription: null,
                        trackNumber: matroskaConfiguration.separateEnhancementTrackNumber
                    }
            };
        }
        const isoBaseMediaConfiguration = await readISOBaseMediaDolbyVisionTrackConfiguration(
            reader,
            containerTrackNumber
        );
        if (isoBaseMediaConfiguration) {
            return {
                enhancementConfiguration: null,
                separateEnhancement: {
                    decoderDescription: isoBaseMediaConfiguration.enhancementConfiguration,
                    trackNumber: isoBaseMediaConfiguration.separateEnhancementTrackNumber
                }
            };
        }
        const transportStreamConfiguration =
            await readMPEGTransportStreamDolbyVisionTrackConfiguration(
                reader,
                containerTrackNumber
            );
        if (!transportStreamConfiguration) {
            return null;
        }
        return {
            enhancementConfiguration: null,
            separateEnhancement: {
                decoderDescription: null,
                trackNumber: transportStreamConfiguration.separateEnhancementTrackNumber
            }
        };
    } finally {
        if (run.metadataAbortController === abortController) {
            run.metadataAbortController = null;
        }
    }
}

async function resolveDolbyVisionEnhancementDecoderConfiguration(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack,
    keyPacketSplit: ReturnType<typeof splitDolbyVisionHEVCAccessUnit>
): Promise<DolbyVisionEnhancementDecoderConfiguration | null> {
    if (keyPacketSplit.hasRequiredEnhancementLayerParameterSets) {
        return createDolbyVisionEnhancementDecoderConfiguration(preparedVideoTrack);
    }
    if (!keyPacketSplit.hasEnhancementLayerVCL && request.dolbyVisionProfile !== 7) {
        return null;
    }
    const containerConfiguration = await readContainerDolbyVisionTrackConfiguration(
        run,
        request,
        preparedVideoTrack.containerTrackNumber
    );
    if (!containerConfiguration || run.cancelled) {
        return null;
    }
    if (keyPacketSplit.hasEnhancementLayerVCL) {
        if (!containerConfiguration.enhancementConfiguration) {
            return null;
        }
        return createDolbyVisionEnhancementDecoderConfiguration(
            preparedVideoTrack,
            containerConfiguration.enhancementConfiguration
        );
    }
    if (!containerConfiguration.separateEnhancement) {
        return null;
    }
    return createSeparateDolbyVisionEnhancementDecoderConfiguration(
        preparedVideoTrack,
        containerConfiguration.separateEnhancement.trackNumber,
        containerConfiguration.separateEnhancement.decoderDescription
    );
}

async function streamOwnedHEVCFrames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
    if (preparedVideoTrack.codec !== 'hevc') {
        throw new UnsupportedCustomDecodeSourceError(
            'The owned HEVC decoder requires an HEVC track'
        );
    }

    const packetSink = new EncodedPacketSink(preparedVideoTrack.videoTrack);
    const startTimeSeconds = microsecondsToSeconds(request.startTimeMicroseconds);
    const keyPacket = await packetSink.getKeyPacket(
        startTimeSeconds,
        OWNED_HEVC_PACKET_OPTIONS
    ) ?? await packetSink.getFirstKeyPacket(OWNED_HEVC_PACKET_OPTIONS);
    if (!keyPacket || run.cancelled) {
        return;
    }
    const keyPacketMediaTimeMicroseconds = requireMicroseconds(
        keyPacket.microsecondTimestamp,
        'Owned HEVC key packet timestamp'
    );
    postVideoStartupProgress(
        run,
        'video-key-packet-ready',
        0,
        keyPacketMediaTimeMicroseconds
    );

    const packetIterator = packetSink.packets(
        keyPacket,
        undefined,
        OWNED_HEVC_PACKET_OPTIONS
    );
    run.videoIterator = packetIterator;
    const inputFormat = getHEVCNALFormat(preparedVideoTrack.decoderConfig);
    const keyPacketSplit = splitDolbyVisionHEVCAccessUnit(
        keyPacket.data,
        inputFormat,
        ANNEX_B_HEVC_NAL_FORMAT
    );
    let enhancementConfiguration = await resolveDolbyVisionEnhancementDecoderConfiguration(
        run,
        request,
        preparedVideoTrack,
        keyPacketSplit
    );
    const separateEnhancementStream = enhancementConfiguration ?
        await createSeparateDolbyVisionEnhancementPacketStream(
            run,
            enhancementConfiguration,
            keyPacketMediaTimeMicroseconds
        ) :
        null;
    if (
        enhancementConfiguration?.source.kind === 'separate-track'
        && !separateEnhancementStream
    ) {
        enhancementConfiguration = null;
    }
    if (run.cancelled) {
        await retireIterator(packetIterator);
        await separateEnhancementStream?.pairer.retire();
        return;
    }
    const rpuParser = DolbyVisionRPUParserSession.create(
        request.dolbyVisionRPUParserWASMURL
    );
    const state = new OwnedHEVCStreamState(
        new DolbyVisionEncodedMetadataQueue(
            inputFormat,
            rpuParser,
            enhancementConfiguration?.packetFormat ?? inputFormat
        ),
        new HEVCDynamicHDRMetadataQueue(inputFormat),
        request.startTimeMicroseconds,
        enhancementConfiguration?.geometry ?? null
    );
    const notifyDecoderProgress = (): void => {
        wakeWaiters(run.wakeVideoDecodeWaiters);
    };
    const decoder = createOwnedHEVCVideoDecoderPort(
        run,
        preparedVideoTrack.decoderConfig,
        inputFormat,
        {
            onError: (error: unknown): void => {
                state.recordDecoderFailure(error);
                notifyDecoderProgress();
            },
            onOutput: (output: OwnedDecodedVideoSource): void => {
                state.enqueueDecodedOutput(output);
            },
            onProgress: notifyDecoderProgress
        }
    );
    const enhancementDecoder = enhancementConfiguration ?
        createOwnedBundledHEVCVideoDecoderPort(
            enhancementConfiguration.decoderConfig,
            {
                onError: (): void => {
                    state.recordEnhancementDecoderFailure();
                    notifyDecoderProgress();
                },
                onOutput: (output: OwnedDecodedVideoSource): void => {
                    state.enqueueEnhancementDecodedOutput(output);
                },
                onProgress: notifyDecoderProgress
            }
        ) :
        null;
    try {
        const decoderInitializationPromise = decoder.init();
        const enhancementInitializationPromise = enhancementDecoder ?
            enhancementDecoder.init() :
            Promise.resolve();
        const initializationResults = await Promise.allSettled([
            decoderInitializationPromise,
            enhancementInitializationPromise
        ]);
        const enhancementInitializationResult = initializationResults[1];
        if (enhancementInitializationResult.status === 'rejected') {
            state.recordEnhancementDecoderFailure();
        }
        const decoderInitializationResult = initializationResults[0];
        if (decoderInitializationResult.status === 'rejected') {
            throw decoderInitializationResult.reason;
        }
        postVideoStartupProgress(
            run,
            'video-decoder-ready',
            0,
            keyPacketMediaTimeMicroseconds
        );
        await pumpOwnedHEVCFrames(
            run,
            packetIterator,
            decoder,
            enhancementDecoder,
            separateEnhancementStream,
            state,
            preparedVideoTrack.geometry
        );
    } finally {
        state.close();
        rpuParser.close();
        try {
            await packetIterator.return?.();
        } catch {
            // Input disposal is the authoritative cancellation signal
        }
        await separateEnhancementStream?.pairer.retire();
        decoder.close();
        enhancementDecoder?.close();
    }
}

async function streamJPEG2000Frames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
    if (
        preparedVideoTrack.codec !== 'jpeg2000'
        || run.videoDecoderBackend !== 'openjpeg'
        || run.videoOutputMode !== 'video-frame'
    ) {
        throw new UnsupportedCustomDecodeSourceError(
            'The OpenJPEG decoder requires a negotiated JPEG 2000 VideoFrame route'
        );
    }

    const packetSink = new EncodedPacketSink(preparedVideoTrack.videoTrack);
    const startPacket = await packetSink.getPacket(
        microsecondsToSeconds(request.startTimeMicroseconds),
        OPENJPEG_PACKET_OPTIONS
    ) ?? await packetSink.getFirstPacket(OPENJPEG_PACKET_OPTIONS);
    if (!startPacket || run.cancelled) {
        return;
    }
    const firstPacketMediaTimeMicroseconds = requireMicroseconds(
        startPacket.microsecondTimestamp,
        'OpenJPEG first packet timestamp'
    );
    postVideoStartupProgress(
        run,
        'video-key-packet-ready',
        0,
        firstPacketMediaTimeMicroseconds
    );

    const decoder = new JPEG2000SoftwareVideoDecoder();
    try {
        await decoder.init();
        if (run.cancelled) {
            return;
        }
        postVideoStartupProgress(
            run,
            'video-decoder-ready',
            0,
            firstPacketMediaTimeMicroseconds
        );

        const packetIterator = packetSink.packets(
            startPacket,
            undefined,
            OPENJPEG_PACKET_OPTIONS
        );
        run.videoIterator = packetIterator;
        let packetCount = 0;
        while (await waitForFrameCredit(run)) {
            const packetResult = await packetIterator.next();
            if (run.cancelled || packetResult.done) {
                return;
            }

            packetCount += 1;
            const packet = packetResult.value;
            const packetMediaTimeMicroseconds = requireMicroseconds(
                packet.microsecondTimestamp,
                'OpenJPEG packet timestamp'
            );
            const packetDurationMicroseconds = requireMicroseconds(
                packet.microsecondDuration,
                'OpenJPEG packet duration'
            );
            if (packetDurationMicroseconds < 0) {
                throw new RangeError('OpenJPEG packet duration must not be negative');
            }
            postVideoStartupProgress(
                run,
                'video-packet-started',
                packetCount,
                packetMediaTimeMicroseconds
            );
            let frame: VideoFrame | null = decoder.decode(
                packet,
                preparedVideoTrack.geometry
            );
            try {
                postVideoStartupProgress(
                    run,
                    'video-packet-decoded',
                    packetCount,
                    packetMediaTimeMicroseconds
                );
                const ownedFrame = frame;
                frame = null;
                await postVideoFrame(
                    run,
                    {
                        durationMicroseconds: packetDurationMicroseconds,
                        encodedDolbyVisionMetadata: null,
                        mediaTimeMicroseconds: packetMediaTimeMicroseconds,
                        source: {
                            frame: ownedFrame,
                            geometry: preparedVideoTrack.geometry,
                            kind: 'native-frame'
                        }
                    },
                    preparedVideoTrack.geometry
                );
            } finally {
                frame?.close();
            }
        }
    } finally {
        decoder.close();
    }
}

function closeLegacyVideoSamples(samples: VideoSample[]): void {
    for (const sample of samples.splice(0)) {
        sample.close();
    }
}

async function postLegacyVideoSamples(
    run: DecodeRun,
    samples: VideoSample[],
    expectedGeometry: RawVideoFrameGeometry,
    startTimeMicroseconds: Microseconds
): Promise<boolean> {
    while (samples.length > 0) {
        const sample = samples.shift();
        if (!sample) {
            continue;
        }
        try {
            const timing = getOwnedDecodedVideoTiming({
                kind: 'video-sample',
                sample
            });
            if (
                timing.mediaTimeMicroseconds + timing.durationMicroseconds
                <= startTimeMicroseconds
            ) {
                continue;
            }
            if (!await waitForFrameCredit(run) || run.cancelled) {
                return false;
            }
            await postVideoFrame(
                run,
                {
                    durationMicroseconds: timing.durationMicroseconds,
                    encodedDolbyVisionMetadata: null,
                    mediaTimeMicroseconds: timing.mediaTimeMicroseconds,
                    source: {
                        kind: 'video-sample',
                        sample
                    }
                },
                expectedGeometry
            );
        } finally {
            sample.close();
        }
    }
    return !run.cancelled;
}

async function streamLegacyVideoFrames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
    if (
        preparedVideoTrack.codec !== 'mpeg2video'
        || run.videoDecoderBackend !== 'legacy-software'
        || run.videoOutputMode !== 'video-frame'
    ) {
        throw new UnsupportedCustomDecodeSourceError(
            'The legacy software decoder requires a negotiated MPEG-2 VideoFrame route'
        );
    }

    const packetSink = new EncodedPacketSink(preparedVideoTrack.videoTrack);
    const startTimeSeconds = microsecondsToSeconds(request.startTimeMicroseconds);
    const keyPacket = await packetSink.getKeyPacket(
        startTimeSeconds,
        LEGACY_VIDEO_PACKET_OPTIONS
    ) ?? await packetSink.getFirstKeyPacket(LEGACY_VIDEO_PACKET_OPTIONS);
    if (!keyPacket || run.cancelled) {
        return;
    }
    const keyPacketMediaTimeMicroseconds = requireMicroseconds(
        keyPacket.microsecondTimestamp,
        'Legacy video key packet timestamp'
    );
    postVideoStartupProgress(
        run,
        'video-key-packet-ready',
        0,
        keyPacketMediaTimeMicroseconds
    );

    const pendingSamples: VideoSample[] = [];
    let decoderError: unknown = null;
    const decoder = new LegacySoftwareVideoDecoder({
        codec: 'mpeg2video',
        codedHeight: preparedVideoTrack.geometry.codedHeight,
        codedWidth: preparedVideoTrack.geometry.codedWidth,
        colorSpace: preparedVideoTrack.decoderConfig.colorSpace,
        displayHeight: preparedVideoTrack.geometry.displayHeight,
        displayWidth: preparedVideoTrack.geometry.displayWidth
    }, {
        onError: (error: unknown): void => {
            decoderError = error;
        },
        onSample: (sample: VideoSample): void => {
            if (pendingSamples.length >= OWNED_VIDEO_DECODER_QUEUE_HIGH_WATER_MARK) {
                throw new RangeError('The legacy decoded frame queue exceeded its bound');
            }
            pendingSamples.push(sample);
        }
    });
    const packetIterator = packetSink.packets(
        keyPacket,
        undefined,
        LEGACY_VIDEO_PACKET_OPTIONS
    );
    run.videoIterator = packetIterator;
    try {
        await decoder.init();
        if (run.cancelled) {
            return;
        }
        postVideoStartupProgress(
            run,
            'video-decoder-ready',
            0,
            keyPacketMediaTimeMicroseconds
        );

        let packetCount = 0;
        while (!run.cancelled) {
            const packetResult = await packetIterator.next();
            if (run.cancelled) {
                return;
            }
            if (packetResult.done) {
                break;
            }
            packetCount += 1;
            const packet = packetResult.value;
            const packetMediaTimeMicroseconds = requireMicroseconds(
                packet.microsecondTimestamp,
                'Legacy video packet timestamp'
            );
            postVideoStartupProgress(
                run,
                'video-packet-started',
                packetCount,
                packetMediaTimeMicroseconds
            );
            decoder.decode(packet);
            if (decoderError !== null) {
                throw decoderError;
            }
            postVideoStartupProgress(
                run,
                'video-packet-decoded',
                packetCount,
                packetMediaTimeMicroseconds
            );
            if (!await postLegacyVideoSamples(
                run,
                pendingSamples,
                preparedVideoTrack.geometry,
                request.startTimeMicroseconds
            )) {
                return;
            }
        }
        if (run.cancelled) {
            return;
        }
        decoder.flush();
        if (decoderError !== null) {
            throw decoderError;
        }
        await postLegacyVideoSamples(
            run,
            pendingSamples,
            preparedVideoTrack.geometry,
            request.startTimeMicroseconds
        );
    } finally {
        closeLegacyVideoSamples(pendingSamples);
        try {
            await packetIterator.return?.();
        } catch {
            // Input disposal is the authoritative cancellation signal
        }
        decoder.close();
    }
}

async function streamVideoFrames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
    if (run.videoDecoderBackend === 'openjpeg') {
        return streamJPEG2000Frames(run, request, preparedVideoTrack);
    }
    if (run.videoDecoderBackend === 'legacy-software') {
        return streamLegacyVideoFrames(run, request, preparedVideoTrack);
    }
    if (preparedVideoTrack.codec === 'hevc') {
        return streamOwnedHEVCFrames(run, request, preparedVideoTrack);
    }

    const sampleSink = new VideoSampleSink(preparedVideoTrack.videoTrack, {
        hardwareAcceleration: getCustomDecodeHardwareAcceleration(
            run.videoOutputMode,
            run.videoDecoderBackend
        ),
        optimizeForLatency: true
    });
    const iterator = sampleSink.samples(
        microsecondsToSeconds(request.startTimeMicroseconds)
    ) as unknown as MediaSampleIterator<VideoSample>;
    run.videoIterator = iterator;

    while (await waitForFrameCredit(run)) {
        const iteratorResult = await iterator.next();
        if (run.cancelled) {
            iteratorResult.value?.close();
            return;
        }
        if (iteratorResult.done) {
            return;
        }

        const sample = iteratorResult.value;
        try {
            const timing = getOwnedDecodedVideoTiming({
                kind: 'video-sample',
                sample
            });
            await postVideoFrame(
                run,
                {
                    durationMicroseconds: timing.durationMicroseconds,
                    encodedDolbyVisionMetadata: null,
                    mediaTimeMicroseconds: timing.mediaTimeMicroseconds,
                    source: {
                        kind: 'video-sample',
                        sample
                    }
                },
                preparedVideoTrack.geometry
            );
        } finally {
            sample.close();
        }
    }
}

async function streamAudioSamples(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedAudioTrack: PreparedAudioTrack
): Promise<void> {
    const sampleSink = new AudioSampleSink(preparedAudioTrack.audioTrack);
    const resampler = new StreamingAudioResampler({
        channelCount: preparedAudioTrack.outputChannelCount,
        maximumOutputFrameCount: MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE,
        sourceSampleRate: preparedAudioTrack.sourceSampleRate,
        targetSampleRate: CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE
    });
    const iterator = sampleSink.samples(
        microsecondsToSeconds(request.startTimeMicroseconds)
    ) as unknown as MediaSampleIterator<AudioSample>;
    run.audioIterator = iterator;

    while (await waitForAudioSampleCredit(run)) {
        const iteratorResult = await iterator.next();
        if (run.cancelled) {
            iteratorResult.value?.close();
            return;
        }
        if (iteratorResult.done) {
            await postNormalizedAudioOutput(run, resampler.finalize(), true);
            return;
        }

        const output = normalizeAudioSample(
            iteratorResult.value,
            preparedAudioTrack,
            request.startTimeMicroseconds,
            resampler
        );
        if (!await postNormalizedAudioOutput(run, output, true)) {
            return;
        }
    }
}

async function streamDTSAudioPackets(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedAudioTrack: PreparedAudioTrack
): Promise<void> {
    const packetSink = new EncodedPacketSink(preparedAudioTrack.audioTrack);
    const startPacket = await packetSink.getPacket(
        microsecondsToSeconds(request.startTimeMicroseconds)
    );
    const iterator = packetSink.packets(startPacket ?? undefined) as unknown as
        MediaSampleIterator<EncodedPacket>;
    run.audioIterator = iterator;
    const decoder = await DTSSoftwareAudioDecoder.create();
    const resampler = new StreamingAudioResampler({
        channelCount: preparedAudioTrack.outputChannelCount,
        maximumOutputFrameCount: MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE,
        sourceSampleRate: preparedAudioTrack.sourceSampleRate,
        targetSampleRate: CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE
    });

    try {
        while (await waitForAudioSampleCredit(run)) {
            const iteratorResult = await iterator.next();
            if (run.cancelled) {
                return;
            }
            if (iteratorResult.done) {
                await postNormalizedAudioOutput(run, resampler.finalize(), true);
                return;
            }
            const packet = iteratorResult.value;
            const output = decoder.decode(
                packet.data,
                requireMicroseconds(
                    packet.microsecondTimestamp,
                    'Encoded DTS packet timestamp'
                )
            );
            const normalizedOutput = normalizeDTSAudioOutput(
                output,
                preparedAudioTrack,
                request.startTimeMicroseconds,
                resampler
            );
            if (!await postNormalizedAudioOutput(run, normalizedOutput, true)) {
                return;
            }
        }
    } finally {
        decoder.close();
    }
}

async function streamTrueHDAudioPackets(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedAudioTrack: PreparedAudioTrack
): Promise<void> {
    const decoderCodec = preparedAudioTrack.decoderBackend;
    if (decoderCodec !== 'truehd' && decoderCodec !== 'mlp') {
        throw new UnsupportedCustomDecodeSourceError('TrueHD decoder selection is unavailable');
    }
    const packetSink = new EncodedPacketSink(preparedAudioTrack.audioTrack);
    const prerollTimeMicroseconds = Math.max(
        0,
        request.startTimeMicroseconds - TRUEHD_MAJOR_SYNC_PREROLL_MICROSECONDS
    ) as Microseconds;
    const startPacket = await packetSink.getPacket(
        microsecondsToSeconds(prerollTimeMicroseconds)
    );
    const iterator = packetSink.packets(startPacket ?? undefined) as unknown as
        MediaSampleIterator<EncodedPacket>;
    run.audioIterator = iterator;
    const decoder = await TrueHDSoftwareAudioDecoder.create(decoderCodec);
    const resampler = new StreamingAudioResampler({
        channelCount: preparedAudioTrack.outputChannelCount,
        maximumOutputFrameCount: MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE,
        sourceSampleRate: preparedAudioTrack.sourceSampleRate,
        targetSampleRate: CUSTOM_AUDIO_OUTPUT_SAMPLE_RATE
    });

    try {
        while (await waitForAudioSampleCredit(run)) {
            const iteratorResult = await iterator.next();
            if (run.cancelled) {
                return;
            }
            if (iteratorResult.done) {
                await postNormalizedAudioOutput(run, resampler.finalize(), true);
                return;
            }
            const packet = iteratorResult.value;
            const decodedOutputs = decoder.decode(
                packet.data,
                requireMicroseconds(
                    packet.microsecondTimestamp,
                    'Encoded TrueHD packet timestamp'
                )
            );
            const normalizedOutputs: StreamingAudioResamplerOutput[] = [];
            for (const output of decodedOutputs) {
                normalizedOutputs.push(...normalizeTrueHDAudioOutput(
                    output,
                    preparedAudioTrack,
                    request.startTimeMicroseconds,
                    resampler
                ));
            }
            if (!await postNormalizedAudioOutput(run, normalizedOutputs, true)) {
                return;
            }
        }
    } finally {
        decoder.close();
    }
}

function takeOwnedArrayBuffer(data: Uint8Array): ArrayBuffer {
    if (data.buffer instanceof ArrayBuffer
        && data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength) {
        return data.buffer;
    }
    return data.slice().buffer;
}

async function postNativeAudioOutput(
    run: DecodeRun,
    output: NativeMediaAudioFMP4RemuxOutput
): Promise<boolean> {
    let initializationSegment = output.initializationSegment;
    for (const segment of output.mediaSegments) {
        if (!await waitForAudioSampleCredit(run)) {
            return false;
        }
        if (initializationSegment) {
            const initializationData = takeOwnedArrayBuffer(initializationSegment);
            postResponse({
                data: initializationData,
                generation: run.generation,
                type: 'native-audio-init'
            }, [ initializationData ]);
            initializationSegment = null;
        }
        const data = takeOwnedArrayBuffer(segment.data);
        postResponse({
            data,
            endTimeMicroseconds: segment.endTimeMicroseconds,
            generation: run.generation,
            startTimeMicroseconds: segment.startTimeMicroseconds,
            type: 'native-audio-media'
        }, [ data ]);
    }
    if (initializationSegment) {
        throw new UnsupportedCustomDecodeSourceError(
            'Native audio initialization was emitted without a media fragment'
        );
    }
    return true;
}

async function streamNativeAudioPackets(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedAudioTrack: PreparedAudioTrack
): Promise<void> {
    const audioConfiguration = preparedAudioTrack.audioConfiguration;
    if (!('outputMode' in audioConfiguration)
        || audioConfiguration.outputMode !== 'native-media') {
        throw new UnsupportedCustomDecodeSourceError('Native audio configuration is unavailable');
    }
    const codec: NativeMediaAudioFMP4Codec = audioConfiguration.codec === 'ac-3' ?
        'ac3' :
        'eac3';
    const decoderConfig = preparedAudioTrack.decoderConfig;
    if (!decoderConfig) {
        throw new UnsupportedCustomDecodeSourceError(
            'Native audio decoder configuration is unavailable'
        );
    }
    const packetSink = new EncodedPacketSink(preparedAudioTrack.audioTrack);
    const startPacket = await packetSink.getPacket(
        microsecondsToSeconds(request.startTimeMicroseconds)
    );
    const iterator = packetSink.packets(startPacket ?? undefined) as unknown as
        MediaSampleIterator<EncodedPacket>;
    run.audioIterator = iterator;
    const remuxer = new NativeMediaAudioFMP4Remuxer({
        channelCount: audioConfiguration.channelCount as 2 | 6,
        codec,
        decoderConfig,
        sampleRate: 48_000
    });

    try {
        await remuxer.start();
        while (!run.cancelled) {
            const iteratorResult = await iterator.next();
            if (run.cancelled) {
                return;
            }
            if (iteratorResult.done) {
                break;
            }
            const packet = iteratorResult.value;
            await remuxer.addPacket({
                data: packet.data,
                durationMicroseconds: requireMicroseconds(
                    packet.microsecondDuration,
                    'Encoded audio packet duration'
                ),
                sequenceNumber: packet.sequenceNumber,
                timestampMicroseconds: requireMicroseconds(
                    packet.microsecondTimestamp,
                    'Encoded audio packet timestamp'
                ),
                type: packet.type
            });
            if (!await postNativeAudioOutput(run, remuxer.takeOutput())) {
                return;
            }
        }
        if (run.cancelled) {
            return;
        }
        await remuxer.finalize();
        await postNativeAudioOutput(run, remuxer.takeOutput());
    } finally {
        await remuxer.cancel();
    }
}

function streamPreparedAudio(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedAudioTrack: PreparedAudioTrack
): Promise<void> {
    switch (preparedAudioTrack.outputMode) {
        case 'decoded-pcm':
            switch (preparedAudioTrack.decoderBackend) {
                case 'dts':
                    return streamDTSAudioPackets(run, request, preparedAudioTrack);
                case 'mlp':
                case 'truehd':
                    return streamTrueHDAudioPackets(run, request, preparedAudioTrack);
                case 'mediabunny':
                    return streamAudioSamples(run, request, preparedAudioTrack);
            }
            throw new UnsupportedCustomDecodeSourceError(
                'The selected audio decoder backend is unsupported'
            );
        case 'native-media':
            return streamNativeAudioPackets(run, request, preparedAudioTrack);
    }
}

async function decodeMedia(run: DecodeRun, request: Extract<DecodeWorkerRequest, { type: 'start' }>): Promise<void> {
    let reportDecodeStreamFailure = false;
    try {
        const input = new Input({
            formats: ALL_FORMATS,
            source: new UrlSource(request.url, {
                fetchFn: validatedRangeFetch,
                getRetryDelay,
                maxCacheSize: URL_SOURCE_CACHE_BYTES,
                parallelism: URL_SOURCE_PARALLELISM
            })
        });
        run.input = input;
        const preparedTrackPromises: [
            Promise<PreparedVideoTrack>,
            Promise<PreparedAudioTrack | null>
        ] = [
            prepareVideoTrack(input, run, request),
            request.audioTrackIndex === null ?
                Promise.resolve(null) :
                prepareAudioTrack(
                    input,
                    run,
                    request.audioTrackIndex,
                    request.audioOutputMode ?? 'decoded-pcm',
                    request.decodedAudioOutputChannelCount
                        ?? CUSTOM_AUDIO_OUTPUT_CHANNEL_COUNT
                )
        ];
        const [ preparedVideoTrack, preparedAudioTrack ] = await Promise.all(preparedTrackPromises);
        if (run.cancelled) {
            return;
        }

        postReadyResponse(run, preparedVideoTrack, preparedAudioTrack);
        const streamPromises: Array<Promise<void>> = [];
        streamPromises.push(streamVideoFrames(run, request, preparedVideoTrack));
        if (preparedAudioTrack) {
            streamPromises.push(streamPreparedAudio(run, request, preparedAudioTrack));
        }
        await settleConcurrentDecodeStreams(streamPromises, (): void => {
            // Preserve the first active-stream failure after cancelling siblings
            reportDecodeStreamFailure = !run.cancelled;
            stopRun(run);
        });
        if (!run.cancelled) {
            postResponse({ generation: run.generation, type: 'ended' });
        }
    } catch (error) {
        if (!run.cancelled || reportDecodeStreamFailure) {
            postResponse({
                failureKind: classifyFailure(error),
                generation: run.generation,
                message: getSafeErrorMessage(error),
                type: 'error'
            });
        }
    } finally {
        stopRun(run);
        if (run.iteratorRetirementPromise) {
            await run.iteratorRetirementPromise;
        }
        await waitForHEVCSoftwareVideoDecoderShutdown();
        if (currentRun === run) {
            currentRun = null;
        }
        postResponse({ generation: run.generation, type: 'stopped' });
    }
}

function registerRequiredVideoDecoder(
    request: Extract<DecodeWorkerRequest, { type: 'start' }>
): void {
    if (request.videoDecoderBackend === 'bundled-hevc') {
        registerHEVCSoftwareVideoDecoder();
    }
}

function handleRequest(requestValue: unknown): void {
    if (!isDecodeWorkerRequest(requestValue)) {
        return;
    }

    switch (requestValue.type) {
        case 'start': {
            if (currentRun) {
                stopRun(currentRun);
            }
            registerRequiredVideoDecoder(requestValue);

            const run: DecodeRun = {
                audioIterator: null,
                audioSampleCredits: requestValue.audioSampleCredits,
                cancelled: false,
                decodedVideoGeometry: null,
                enhancementPacketPairer: null,
                frameCredits: requestValue.frameCredits,
                generation: requestValue.generation,
                input: null,
                iteratorRetirementPromise: null,
                maximumCodedHeight: requestValue.maximumCodedHeight,
                maximumCodedWidth: requestValue.maximumCodedWidth,
                metadataAbortController: null,
                nativeHDRTransfer: requestValue.nativeHDRTransfer,
                neutralizeHDRColorMetadata: requestValue.neutralizeHDRColorMetadata,
                outstandingRawFrameBufferCount: 0,
                rawFrameBufferPool: createRawFrameBufferPool(requestValue.videoOutputMode),
                rawVideoFrameFormat: requestValue.rawVideoFrameFormat,
                videoDecoderBackend: requestValue.videoDecoderBackend,
                videoOutputMode: requestValue.videoOutputMode,
                videoIterator: null,
                wakeAudioCreditWaiters: [],
                wakeFrameCreditWaiters: [],
                wakeVideoDecodeWaiters: []
            };
            currentRun = run;
            void decodeMedia(run, requestValue);
            break;
        }
        case 'pull':
            if (
                currentRun?.generation === requestValue.generation
                && currentRun.videoOutputMode === 'video-frame'
            ) {
                addFrameCredits(currentRun, requestValue.frameCredits);
            }
            break;
        case 'pull-audio':
            if (currentRun?.generation === requestValue.generation) {
                addAudioSampleCredits(currentRun, requestValue.audioSampleCredits);
            }
            break;
        case 'recycle-frame':
            if (
                currentRun?.generation === requestValue.generation
                && currentRun.videoOutputMode === 'raw-planes'
                && !currentRun.cancelled
                && currentRun.outstandingRawFrameBufferCount > 0
                && currentRun.rawFrameBufferPool?.recycle(requestValue.buffer)
            ) {
                currentRun.outstandingRawFrameBufferCount -= 1;
                addFrameCredits(currentRun, 1);
            }
            break;
        case 'stop':
            if (currentRun?.generation === requestValue.generation) {
                stopRun(currentRun);
            }
            break;
    }
}

workerScope.addEventListener('message', event => {
    handleRequest(event.data);
});

// worker-loader replaces this module export with its Worker constructor.
const WorkerConstructor = null as unknown as { new(): Worker };
export default WorkerConstructor;
/* eslint-enable no-restricted-globals */
