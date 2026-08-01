/* eslint-disable no-restricted-globals */
import {
    ALL_FORMATS,
    AudioSampleSink,
    Input,
    UrlSource,
    VideoSampleSink,
    type AudioSample,
    type InputAudioTrack,
    type InputVideoTrack,
    type VideoSample
} from 'mediabunny';

import { microsecondsToSeconds, type Microseconds } from '../MediaTime';
import { getAudioSampleWindow } from './AudioSampleWindow';
import {
    isDecodeWorkerRequest,
    MAX_DECODED_AUDIO_CHANNELS,
    MAX_DECODED_AUDIO_FRAMES_PER_SAMPLE,
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
    MAX_DECODED_FRAME_CREDITS,
    type CustomDecodeFailureKind,
    type DecodeWorkerAudioConfiguration,
    type DecodeWorkerRequest,
    type DecodeWorkerResponse
} from './DecodeWorkerProtocol';
import { requireMicroseconds } from './TimeMath';

const URL_SOURCE_CACHE_BYTES = 32 * 1024 * 1024;
const URL_SOURCE_PARALLELISM = 2;
const MAX_NETWORK_RETRY_ATTEMPTS = 2;
const NETWORK_RETRY_BASE_SECONDS = 0.25;

type MediaSampleIterator<Sample> = {
    next: () => Promise<IteratorResult<Sample>>
    return?: () => Promise<IteratorResult<Sample>>
};

type DecodeRun = {
    audioIterator: MediaSampleIterator<AudioSample> | null
    audioSampleCredits: number
    cancelled: boolean
    frameCredits: number
    generation: number
    input: Input | null
    videoIterator: MediaSampleIterator<VideoSample> | null
    wakeAudioCreditWaiters: Array<() => void>
    wakeFrameCreditWaiters: Array<() => void>
};

type PreparedVideoTrack = {
    decoderConfig: VideoDecoderConfig
    videoTrack: InputVideoTrack
};

type PreparedAudioTrack = {
    audioConfiguration: DecodeWorkerAudioConfiguration
    audioTrack: InputAudioTrack
};

type WorkerScope = {
    addEventListener: (
        type: 'message',
        listener: (event: MessageEvent<unknown>) => void
    ) => void
    postMessage: (message: DecodeWorkerResponse, transfer?: Transferable[]) => void
};

class UnsupportedRangeResponseError extends Error {
    public constructor() {
        super('The media endpoint did not honor a byte-range request');
        this.name = 'UnsupportedRangeResponseError';
    }
}

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

function getRetryDelay(previousAttempts: number, error: unknown): number | null {
    if (error instanceof UnsupportedRangeResponseError) {
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
    const response = await fetch(input, requestInit);
    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
    const requestHeaders = new Headers(requestInit?.headers);
    if (!requestHeaders.has('Range') || response.status === 206) {
        return response;
    }

    if (response.body) {
        void response.body.cancel().catch(() => undefined);
    }
    throw new UnsupportedRangeResponseError();
};

function wakeWaiters(waiters: Array<() => void>): void {
    const activeWaiters = waiters.splice(0);
    for (const waiter of activeWaiters) {
        waiter();
    }
}

function addFrameCredits(run: DecodeRun, frameCredits: number): void {
    run.frameCredits = Math.min(
        MAX_DECODED_FRAME_CREDITS,
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

function retireIterator<Sample>(iterator: MediaSampleIterator<Sample> | null): void {
    const iteratorReturn = iterator?.return?.();
    if (iteratorReturn) {
        void iteratorReturn.catch(() => undefined);
    }
}

function stopRun(run: DecodeRun): void {
    if (run.cancelled) {
        return;
    }

    run.cancelled = true;
    wakeWaiters(run.wakeAudioCreditWaiters);
    wakeWaiters(run.wakeFrameCreditWaiters);
    run.input?.dispose();
    retireIterator(run.audioIterator);
    retireIterator(run.videoIterator);
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
    if (error instanceof TypeError) {
        return 'network-failed';
    }

    return 'decode-failed';
}

async function prepareVideoTrack(
    input: Input,
    run: DecodeRun,
    videoTrackIndex: number
): Promise<PreparedVideoTrack> {
    const tracks = await input.getTracks();
    if (run.cancelled) {
        throw new UnsupportedCustomDecodeSourceError('Custom decode was cancelled');
    }

    const selectedTrack = tracks[videoTrackIndex];
    if (!selectedTrack?.isVideoTrack()) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected stream index does not identify a video track'
        );
    }
    const videoTrack = selectedTrack;

    const [ codec, decoderConfig, canDecode ] = await Promise.all([
        videoTrack.getCodec(),
        videoTrack.getDecoderConfig(),
        videoTrack.canDecode()
    ]);
    if (!codec || !decoderConfig) {
        throw new UnsupportedCustomDecodeSourceError('The selected video codec configuration is unavailable');
    }
    if (!canDecode) {
        throw new UnsupportedCustomDecodeSourceError(
            `The browser cannot decode the selected ${codec} video configuration`
        );
    }

    return { decoderConfig, videoTrack };
}

async function prepareAudioTrack(
    input: Input,
    run: DecodeRun,
    audioTrackIndex: number
): Promise<PreparedAudioTrack> {
    const tracks = await input.getTracks();
    if (run.cancelled) {
        throw new UnsupportedCustomDecodeSourceError('Custom decode was cancelled');
    }

    const selectedTrack = tracks[audioTrackIndex];
    if (!selectedTrack?.isAudioTrack()) {
        throw new UnsupportedCustomDecodeSourceError(
            'The selected stream index does not identify an audio track'
        );
    }
    const audioTrack = selectedTrack;

    const [ codec, decoderConfig, canDecode, channelCount, sampleRate ] = await Promise.all([
        audioTrack.getCodec(),
        audioTrack.getDecoderConfig(),
        audioTrack.canDecode(),
        audioTrack.getNumberOfChannels(),
        audioTrack.getSampleRate()
    ]);
    if (!codec || !decoderConfig) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio codec configuration is unavailable');
    }
    if (!canDecode) {
        throw new UnsupportedCustomDecodeSourceError(
            `The browser cannot decode the selected ${codec} audio configuration`
        );
    }
    if (!Number.isSafeInteger(channelCount) || channelCount <= 0 || channelCount > MAX_DECODED_AUDIO_CHANNELS) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio channel count is unsupported');
    }
    if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
        throw new UnsupportedCustomDecodeSourceError('The selected audio sample rate is invalid');
    }

    return {
        audioConfiguration: {
            channelCount,
            codec: decoderConfig.codec,
            sampleRate
        },
        audioTrack
    };
}

async function postReadyResponse(
    run: DecodeRun,
    preparedVideoTrack: PreparedVideoTrack,
    preparedAudioTrack: PreparedAudioTrack | null
): Promise<void> {
    const [ codedHeight, codedWidth, displayHeight, displayWidth ] = await Promise.all([
        preparedVideoTrack.videoTrack.getCodedHeight(),
        preparedVideoTrack.videoTrack.getCodedWidth(),
        preparedVideoTrack.videoTrack.getDisplayHeight(),
        preparedVideoTrack.videoTrack.getDisplayWidth()
    ]);
    const dimensions = [ codedHeight, codedWidth, displayHeight, displayWidth ];
    if (dimensions.some(dimension => !Number.isSafeInteger(dimension) || dimension <= 0)) {
        throw new UnsupportedCustomDecodeSourceError('The selected video dimensions are invalid');
    }

    postResponse({
        audio: preparedAudioTrack?.audioConfiguration ?? null,
        codec: preparedVideoTrack.decoderConfig.codec,
        codedHeight,
        codedWidth,
        displayHeight,
        displayWidth,
        generation: run.generation,
        type: 'ready'
    });
}

function postVideoFrame(run: DecodeRun, sample: VideoSample): void {
    let frame: VideoFrame | null = null;
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

        frame = sample.toVideoFrame();
        if (run.cancelled) {
            return;
        }

        postResponse({
            durationMicroseconds,
            frame,
            generation: run.generation,
            mediaTimeMicroseconds,
            type: 'frame'
        }, [ frame as unknown as Transferable ]);
        frame = null;
    } finally {
        frame?.close();
        sample.close();
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

async function streamVideoFrames(
    run: DecodeRun,
    request: Extract<DecodeWorkerRequest, { type: 'start' }>,
    videoTrack: InputVideoTrack
): Promise<void> {
    const sampleSink = new VideoSampleSink(videoTrack, {
        hardwareAcceleration: 'prefer-hardware',
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

        postVideoFrame(run, iteratorResult.value);
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

async function decodeMedia(run: DecodeRun, request: Extract<DecodeWorkerRequest, { type: 'start' }>): Promise<void> {
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

    try {
        const preparedTrackPromises: [
            Promise<PreparedVideoTrack>,
            Promise<PreparedAudioTrack | null>
        ] = [
            prepareVideoTrack(input, run, request.videoTrackIndex),
            request.audioTrackIndex === null ?
                Promise.resolve(null) :
                prepareAudioTrack(input, run, request.audioTrackIndex)
        ];
        const [ preparedVideoTrack, preparedAudioTrack ] = await Promise.all(preparedTrackPromises);
        if (run.cancelled) {
            return;
        }

        await postReadyResponse(run, preparedVideoTrack, preparedAudioTrack);
        const streamPromises: Array<Promise<void>> = [];
        streamPromises.push(streamVideoFrames(run, request, preparedVideoTrack.videoTrack));
        if (preparedAudioTrack) {
            streamPromises.push(streamAudioSamples(run, request, preparedAudioTrack));
        }
        await Promise.all(streamPromises);
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
        if (currentRun === run) {
            currentRun = null;
        }
        postResponse({ generation: run.generation, type: 'stopped' });
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

            const run: DecodeRun = {
                audioIterator: null,
                audioSampleCredits: requestValue.audioSampleCredits,
                cancelled: false,
                frameCredits: requestValue.frameCredits,
                generation: requestValue.generation,
                input: null,
                videoIterator: null,
                wakeAudioCreditWaiters: [],
                wakeFrameCreditWaiters: []
            };
            currentRun = run;
            void decodeMedia(run, requestValue);
            break;
        }
        case 'pull':
            if (currentRun?.generation === requestValue.generation) {
                addFrameCredits(currentRun, requestValue.frameCredits);
            }
            break;
        case 'pull-audio':
            if (currentRun?.generation === requestValue.generation) {
                addAudioSampleCredits(currentRun, requestValue.audioSampleCredits);
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
