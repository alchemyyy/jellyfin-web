/* eslint-disable no-restricted-globals */
import {
    ALL_FORMATS,
    AudioSampleSink,
    EncodedPacketSink,
    Input,
    UrlSource,
    VideoSampleSink,
    type AudioSample,
    type EncodedPacket,
    type InputAudioTrack,
    type InputVideoTrack,
    type VideoCodec,
    type VideoSample
} from 'mediabunny';

import { microsecondsToSeconds, type Microseconds } from '../MediaTime';
import { getAudioSampleWindow } from './AudioSampleWindow';
import { settleConcurrentDecodeStreams } from './ConcurrentDecodeStreams';
import { registerRequiredCustomAudioDecoder } from './CustomAudioDecoderRegistration';
import {
    getCustomDecodeHardwareAcceleration,
    isDecodeWorkerRequest,
    MAX_DECODED_AUDIO_CHANNELS,
    MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE,
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
    MAX_DECODED_FRAME_CREDITS,
    MAX_DECODED_RAW_FRAME_CREDITS,
    type CustomDecodeAudioOutputMode,
    type CustomDecodeFailureKind,
    type CustomDecodeRawVideoFrameFormat,
    type CustomDecodeVideoDecoderBackend,
    type CustomDecodeVideoOutputMode,
    type DecodeWorkerAudioConfiguration,
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
    getHEVCNALFormat
} from './DolbyVisionEncodedMetadata';
import {
    getDolbyVisionEncodedMetadataTransferList,
    takeTransferableDolbyVisionEncodedFrameMetadata,
    type DolbyVisionEncodedFrameMetadata
} from './DolbyVisionEncodedMetadataProtocol';
import { DolbyVisionRPUParseError } from './DolbyVisionRPUParser';
import DolbyVisionRPUParserSession from './DolbyVisionRPUParserSession';
import {
    createOwnedHEVCSoftwareVideoDecoder,
    registerHEVCSoftwareVideoDecoder,
    waitForHEVCSoftwareVideoDecoderShutdown
} from './HEVCSoftwareVideoDecoder';
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
    copyVideoFrameToRawPlanes,
    getRawVideoFrameTransferList,
    type RawVideoFrameGeometry
} from './RawVideoFrameCopy';
import { requireMicroseconds } from './TimeMath';
import NativeMediaAudioFMP4Remuxer, {
    type NativeMediaAudioFMP4Codec,
    type NativeMediaAudioFMP4RemuxOutput
} from './NativeMediaAudioFMP4Remuxer';
import OwnedNativeHEVCVideoDecoder from './OwnedNativeHEVCVideoDecoder';

const URL_SOURCE_CACHE_BYTES = 32 * 1024 * 1024;
const URL_SOURCE_PARALLELISM = 2;
const MAX_NETWORK_RETRY_ATTEMPTS = 2;
const NETWORK_RETRY_BASE_SECONDS = 0.25;
const MAXIMUM_OWNED_DECODED_VIDEO_SAMPLE_COUNT = 8;
const MAXIMUM_OWNED_VIDEO_DECODER_QUEUE_SIZE = 8;

type MediaSampleIterator<Sample> = {
    next: () => Promise<IteratorResult<Sample>>
    return?: () => Promise<IteratorResult<Sample>>
};

type DecodeRun = {
    audioIterator: MediaSampleIterator<AudioSample> | MediaSampleIterator<EncodedPacket> | null
    audioSampleCredits: number
    cancelled: boolean
    decodedVideoGeometry: RawVideoFrameGeometry | null
    frameCredits: number
    generation: number
    input: Input | null
    iteratorRetirementPromise: Promise<void> | null
    maximumCodedHeight: number
    maximumCodedWidth: number
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
    codec: VideoCodec
    decoderConfig: VideoDecoderConfig
    geometry: RawVideoFrameGeometry
    videoTrack: InputVideoTrack
};

type PreparedAudioTrack = {
    audioConfiguration: DecodeWorkerReadyAudioConfiguration
    audioTrack: InputAudioTrack
    decoderConfig: AudioDecoderConfig
    outputMode: CustomDecodeAudioOutputMode
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
    let response: Response;
    try {
        response = await fetch(input, requestInit);
    } catch (error) {
        throw new MediaNetworkError(error);
    }
    const requestHeaders = requestInit?.headers === undefined && input instanceof Request ?
        input.headers :
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        new Headers(requestInit?.headers);
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
    wakeWaiters(run.wakeAudioCreditWaiters);
    wakeWaiters(run.wakeFrameCreditWaiters);
    wakeWaiters(run.wakeVideoDecodeWaiters);
    run.input?.dispose();
    const iteratorRetirementPromises: Array<Promise<void>> = [];
    iteratorRetirementPromises.push(retireIterator(run.audioIterator));
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
        decoderConfig,
        canDecode,
        codedHeight,
        codedWidth,
        displayHeight,
        displayWidth
    ] = await Promise.all([
        videoTrack.getCodec(),
        videoTrack.getDecoderConfig(),
        videoTrack.canDecode(),
        videoTrack.getCodedHeight(),
        videoTrack.getCodedWidth(),
        videoTrack.getDisplayHeight(),
        videoTrack.getDisplayWidth()
    ]);
    if (!codec || !decoderConfig) {
        throw new UnsupportedCustomDecodeSourceError('The selected video codec configuration is unavailable');
    }
    if (request.videoDecoderBackend === 'bundled-hevc' && codec !== 'hevc') {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected video track does not match the negotiated bundled HEVC decoder'
        );
    }
    if (!canDecode) {
        throw new UnsupportedCustomDecodeSourceError(
            `The browser cannot decode the selected ${codec} video configuration`
        );
    }
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

    return {
        codec,
        decoderConfig,
        geometry: { codedHeight, codedWidth, displayHeight, displayWidth },
        videoTrack
    };
}

async function prepareAudioTrack(
    input: Input,
    run: DecodeRun,
    audioTrackOrdinal: number,
    outputMode: CustomDecodeAudioOutputMode
): Promise<PreparedAudioTrack> {
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

    const [ codec, decoderConfig, channelCount, sampleRate ] = await Promise.all([
        audioTrack.getCodec(),
        audioTrack.getDecoderConfig(),
        audioTrack.getNumberOfChannels(),
        audioTrack.getSampleRate()
    ]);
    if (!codec || !decoderConfig) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio codec configuration is unavailable');
    }
    if (!Number.isSafeInteger(channelCount) || channelCount <= 0 || channelCount > MAX_DECODED_AUDIO_CHANNELS) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio channel count is unsupported');
    }
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio sample rate is invalid');
    }

    if (outputMode === 'native-media') {
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
            sampleRate
        };
        return { audioConfiguration, audioTrack, decoderConfig, outputMode };
    }

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
            channelCount,
            codec: decoderConfig.codec,
            sampleRate
        },
        audioTrack,
        decoderConfig,
        outputMode
    };
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
        type: 'ready'
    });
}

function lockDecodedFrameGeometry(
    run: DecodeRun,
    frame: VideoFrame,
    selectedTrackGeometry: RawVideoFrameGeometry
): RawVideoFrameGeometry {
    try {
        const decodedVideoGeometry = requireConsistentDecodedVideoGeometry(
            {
                codedHeight: frame.codedHeight,
                codedWidth: frame.codedWidth,
                displayHeight: frame.displayHeight,
                displayWidth: frame.displayWidth
            },
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

async function postRawVideoFrame(
    run: DecodeRun,
    frame: VideoFrame,
    decodedVideoGeometry: RawVideoFrameGeometry,
    durationMicroseconds: Microseconds,
    mediaTimeMicroseconds: Microseconds,
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null
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
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null
): void {
    const response: MutableDecodeWorkerFrameResponse = {
        durationMicroseconds,
        frame,
        generation: run.generation,
        mediaTimeMicroseconds,
        outputMode: 'video-frame',
        type: 'frame'
    };
    const transferables: Transferable[] = [ frame as unknown as Transferable ];
    transferables.push(...attachDolbyVisionEncodedMetadata(
        response,
        encodedDolbyVisionMetadata
    ));
    postResponse(response, transferables);
}

async function postVideoFrame(
    run: DecodeRun,
    sample: VideoSample,
    expectedGeometry: RawVideoFrameGeometry,
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null = null
): Promise<void> {
    let frame: VideoFrame | null = null;
    try {
        const decodedSample = takeVideoFrame(sample);
        const durationMicroseconds = decodedSample.durationMicroseconds;
        const mediaTimeMicroseconds = decodedSample.mediaTimeMicroseconds;
        frame = decodedSample.frame;
        const decodedVideoGeometry = lockDecodedFrameGeometry(
            run,
            frame,
            expectedGeometry
        );
        if (run.cancelled || currentRun !== run) {
            return;
        }

        switch (run.videoOutputMode) {
            case 'raw-planes': {
                const ownedFrame = frame;
                frame = null;
                await postRawVideoFrame(
                    run,
                    ownedFrame,
                    decodedVideoGeometry,
                    durationMicroseconds,
                    mediaTimeMicroseconds,
                    encodedDolbyVisionMetadata
                );
                return;
            }
            case 'video-frame':
                postTransferredVideoFrame(
                    run,
                    frame,
                    durationMicroseconds,
                    mediaTimeMicroseconds,
                    encodedDolbyVisionMetadata
                );
                frame = null;
                return;
        }
    } finally {
        frame?.close();
    }
}

function postAudioSample(
    run: DecodeRun,
    sample: AudioSample,
    audioConfiguration: DecodeWorkerAudioConfiguration,
    startTimeMicroseconds: Microseconds
): boolean {
    try {
        const sampleTimeMicroseconds = requireMicroseconds(
            sample.microsecondTimestamp,
            'Decoded audio timestamp'
        );
        if (
            sample.numberOfChannels !== audioConfiguration.channelCount
            || sample.sampleRate !== audioConfiguration.sampleRate
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
            return false;
        }

        const channelData: Float32Array[] = [];
        const transferables: Transferable[] = [];
        for (let channelIndex = 0; channelIndex < sample.numberOfChannels; channelIndex += 1) {
            const channel = new Float32Array(sampleWindow.frameCount);
            sample.copyTo(channel, {
                frameCount: sampleWindow.frameCount,
                frameOffset: sampleWindow.frameOffset,
                format: 'f32-planar',
                planeIndex: channelIndex
            });
            channelData.push(channel);
            transferables.push(channel.buffer);
        }

        if (run.cancelled) {
            return false;
        }
        postResponse({
            channelCount: sample.numberOfChannels,
            channelData,
            durationMicroseconds: sampleWindow.durationMicroseconds,
            frameCount: sampleWindow.frameCount,
            generation: run.generation,
            mediaTimeMicroseconds: sampleWindow.mediaTimeMicroseconds,
            sampleRate: sample.sampleRate,
            type: 'audio'
        }, transferables);
        return true;
    } finally {
        sample.close();
    }
}

type OwnedDecodedVideoSample = {
    encodedDolbyVisionMetadata: DolbyVisionEncodedFrameMetadata | null
    sample: VideoSample
};

type OwnedHEVCVideoDecoderCallbacks = {
    onError: (error: unknown) => void
    onProgress: () => void
    onSample: (sample: VideoSample) => void
};

type OwnedHEVCVideoDecoderPort = {
    close: () => void
    decode: (packet: EncodedPacket) => boolean
    flush: () => Promise<void>
    getDecodeQueueSize: () => number
    init: () => Promise<void>
};

type OwnedSamplePostResult = 'none' | 'posted' | 'stopped';

function closeOwnedDecodedVideoSample(decodedSample: OwnedDecodedVideoSample | null): void {
    try {
        decodedSample?.sample.close();
    } catch {
        // Ownership ends even when a decoder implementation throws while closing
    }
}

function createOwnedBundledHEVCVideoDecoderPort(
    config: VideoDecoderConfig,
    callbacks: OwnedHEVCVideoDecoderCallbacks
): OwnedHEVCVideoDecoderPort {
    const decoder = createOwnedHEVCSoftwareVideoDecoder(config, callbacks);
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
                callbacks
            );
    }
}

class OwnedHEVCStreamState {
    private readonly decodedSamples: OwnedDecodedVideoSample[] = [];
    private decoderFailure: unknown = null;
    private firstPresentationSampleQueued = false;
    private frameCreditHeld = false;
    private preStartSample: OwnedDecodedVideoSample | null = null;
    public packetsEnded = false;

    public constructor(
        private readonly metadataQueue: DolbyVisionEncodedMetadataQueue,
        private readonly startTimeMicroseconds: Microseconds
    ) {}

    public recordDecoderFailure(error: unknown): void {
        this.decoderFailure ??= error;
    }

    public enqueueDecodedSample(sample: VideoSample): void {
        let decodedSample: OwnedDecodedVideoSample | null = null;
        try {
            const mediaTimeMicroseconds = requireMicroseconds(
                sample.microsecondTimestamp,
                'Owned decoded HEVC frame timestamp'
            );
            decodedSample = {
                encodedDolbyVisionMetadata: this.metadataQueue.takeFrameMetadata(
                    mediaTimeMicroseconds
                ),
                sample
            };
            if (
                mediaTimeMicroseconds < this.startTimeMicroseconds
                && !this.firstPresentationSampleQueued
            ) {
                closeOwnedDecodedVideoSample(this.preStartSample);
                this.preStartSample = decodedSample;
                decodedSample = null;
                return;
            }

            this.queueFirstPresentationSample();
            this.queueDecodedSample(decodedSample);
            decodedSample = null;
        } finally {
            closeOwnedDecodedVideoSample(decodedSample);
        }
    }

    public async decodePacket(
        packet: EncodedPacket,
        decoder: OwnedHEVCVideoDecoderPort
    ): Promise<void> {
        const processedPacket = await this.metadataQueue.processPacket(packet);
        if (processedPacket.baseLayerPacket) {
            const packetAccepted = decoder.decode(processedPacket.baseLayerPacket);
            if (!packetAccepted && processedPacket.hasBaseLayerVCL) {
                this.metadataQueue.takeFrameMetadata(packet.microsecondTimestamp);
            }
        }
        this.throwDecoderFailure();
    }

    public async finishPackets(decoder: OwnedHEVCVideoDecoderPort): Promise<void> {
        await decoder.flush();
        this.throwDecoderFailure();
        this.metadataQueue.requireDrained();
        this.queueFirstPresentationSample();
        this.packetsEnded = true;
    }

    public async postNextSample(
        run: DecodeRun,
        expectedGeometry: RawVideoFrameGeometry
    ): Promise<OwnedSamplePostResult> {
        if (this.decodedSamples.length === 0) {
            return 'none';
        }
        if (!await this.acquireFrameCredit(run)) {
            return 'stopped';
        }

        const decodedSample = this.decodedSamples.shift() as OwnedDecodedVideoSample;
        await postVideoFrame(
            run,
            decodedSample.sample,
            expectedGeometry,
            decodedSample.encodedDolbyVisionMetadata
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
        if (this.decodedSamples.length > 0 || run.cancelled) {
            return;
        }
        await new Promise<void>(resolve => {
            run.wakeVideoDecodeWaiters.push(resolve);
        });
        this.throwDecoderFailure();
    }

    public close(): void {
        closeOwnedDecodedVideoSample(this.preStartSample);
        this.preStartSample = null;
        for (const decodedSample of this.decodedSamples) {
            closeOwnedDecodedVideoSample(decodedSample);
        }
        this.decodedSamples.length = 0;
        this.metadataQueue.clear();
    }

    private queueDecodedSample(decodedSample: OwnedDecodedVideoSample): void {
        if (this.decodedSamples.length >= MAXIMUM_OWNED_DECODED_VIDEO_SAMPLE_COUNT) {
            throw new Error('The owned decoded video sample queue exceeded its bound');
        }
        this.decodedSamples.push(decodedSample);
    }

    private queueFirstPresentationSample(): void {
        if (this.firstPresentationSampleQueued) {
            return;
        }
        this.firstPresentationSampleQueued = true;
        if (this.preStartSample) {
            this.queueDecodedSample(this.preStartSample);
            this.preStartSample = null;
        }
    }

    private throwDecoderFailure(): void {
        if (this.decoderFailure) {
            throw this.decoderFailure;
        }
    }
}

async function pumpOwnedHEVCFrames(
    run: DecodeRun,
    packetIterator: MediaSampleIterator<EncodedPacket>,
    decoder: OwnedHEVCVideoDecoderPort,
    state: OwnedHEVCStreamState,
    expectedGeometry: RawVideoFrameGeometry
): Promise<void> {
    while (!run.cancelled) {
        const postResult = await state.postNextSample(run, expectedGeometry);
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
        if (decoder.getDecodeQueueSize() >= MAXIMUM_OWNED_VIDEO_DECODER_QUEUE_SIZE) {
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
            await state.finishPackets(decoder);
            continue;
        }
        await state.decodePacket(packetResult.value, decoder);
    }
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
    const packetOptions = {
        metadataOnly: false,
        verifyKeyPackets: true
    } as const;
    const startTimeSeconds = microsecondsToSeconds(request.startTimeMicroseconds);
    const keyPacket = await packetSink.getKeyPacket(startTimeSeconds, packetOptions)
        ?? await packetSink.getFirstKeyPacket(packetOptions);
    if (!keyPacket || run.cancelled) {
        return;
    }

    const packetIterator = packetSink.packets(keyPacket, undefined, packetOptions);
    run.videoIterator = packetIterator;
    const inputFormat = getHEVCNALFormat(preparedVideoTrack.decoderConfig);
    const rpuParser = DolbyVisionRPUParserSession.create(
        request.dolbyVisionRPUParserWASMURL
    );
    const state = new OwnedHEVCStreamState(
        new DolbyVisionEncodedMetadataQueue(inputFormat, rpuParser),
        request.startTimeMicroseconds
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
            onProgress: notifyDecoderProgress,
            onSample: (sample: VideoSample): void => {
                state.enqueueDecodedSample(sample);
            }
        }
    );
    try {
        await decoder.init();
        await pumpOwnedHEVCFrames(
            run,
            packetIterator,
            decoder,
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
        decoder.close();
    }
}

async function streamVideoFrames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedVideoTrack: PreparedVideoTrack
): Promise<void> {
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

        await postVideoFrame(run, iteratorResult.value, preparedVideoTrack.geometry);
    }
}

async function streamAudioSamples(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    preparedAudioTrack: PreparedAudioTrack
): Promise<void> {
    const sampleSink = new AudioSampleSink(preparedAudioTrack.audioTrack);
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
            return;
        }

        const posted = postAudioSample(
            run,
            iteratorResult.value,
            preparedAudioTrack.audioConfiguration,
            request.startTimeMicroseconds
        );
        if (!posted && !run.cancelled) {
            addAudioSampleCredits(run, 1);
        }
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
        decoderConfig: preparedAudioTrack.decoderConfig,
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
            return streamAudioSamples(run, request, preparedAudioTrack);
        case 'native-media':
            return streamNativeAudioPackets(run, request, preparedAudioTrack);
    }
}

async function decodeMedia(run: DecodeRun, request: Extract<DecodeWorkerRequest, { type: 'start' }>): Promise<void> {
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
                    request.audioOutputMode ?? 'decoded-pcm'
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
        await settleConcurrentDecodeStreams(streamPromises, (): void => stopRun(run));
        if (!run.cancelled) {
            postResponse({ generation: run.generation, type: 'ended' });
        }
    } catch (error) {
        if (!run.cancelled) {
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
        if (run.videoDecoderBackend === 'bundled-hevc') {
            await waitForHEVCSoftwareVideoDecoderShutdown();
        }
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
                frameCredits: requestValue.frameCredits,
                generation: requestValue.generation,
                input: null,
                iteratorRetirementPromise: null,
                maximumCodedHeight: requestValue.maximumCodedHeight,
                maximumCodedWidth: requestValue.maximumCodedWidth,
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
