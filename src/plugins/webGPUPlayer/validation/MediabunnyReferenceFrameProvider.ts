import {
    ALL_FORMATS,
    Input,
    InputVideoTrack,
    UrlSource,
    VideoSampleSink,
    type VideoSample
} from 'mediabunny';

import {
    microsecondsToSeconds,
    type Microseconds
} from '../MediaTime';
import { type InputColorMetadata } from '../color/ColorMetadata';
import {
    type ColorValidationCapabilityDecision,
    type BrowserColorMetadata
} from './ColorValidationHarness';
import {
    type ExternalTextureReferenceFrameRequest,
    type WebGPUExternalTextureValidationRequest,
    type WebGPUExternalTextureValidationRunner
} from './WebGPUExternalTextureValidationRunner';

export type MediabunnyReferenceFrameProviderErrorCode =
    | 'decode-failed'
    | 'destroyed'
    | 'invalid-options'
    | 'non-sequential-request'
    | 'sample-mismatch'
    | 'track-not-decodable'
    | 'track-not-video'
    | 'track-out-of-range';

export class MediabunnyReferenceFrameProviderError extends Error {
    public readonly code: MediabunnyReferenceFrameProviderErrorCode;

    public constructor(
        code: MediabunnyReferenceFrameProviderErrorCode,
        message: string
    ) {
        super(message);
        this.code = code;
        this.name = 'MediabunnyReferenceFrameProviderError';
    }
}

export type MediabunnyReferenceFrameProviderOptions = {
    globalTrackIndex: number
    timestampsMicroseconds: readonly Microseconds[]
    url: string
};

export type MediabunnyExternalTextureValidationRequest = {
    adapterInfo?: WebGPUExternalTextureValidationRequest['adapterInfo']
    browserMetadata?: BrowserColorMetadata
    device: GPUDevice
    globalTrackIndex: number
    metadata: InputColorMetadata
    rampOptions?: WebGPUExternalTextureValidationRequest['rampOptions']
    timestampsMicroseconds: readonly Microseconds[]
    url: string
};

type VideoSampleIterator = {
    next: () => Promise<IteratorResult<VideoSample>>
    return: () => Promise<IteratorResult<VideoSample>>
};

type ValidationRunner = Pick<WebGPUExternalTextureValidationRunner, 'validate'>;

const MAXIMUM_REFERENCE_FRAME_COUNT = 64;
const URL_SOURCE_CACHE_BYTES = 4 * 1024 * 1024;
const URL_SOURCE_PARALLELISM = 1;

function createProviderError(
    code: MediabunnyReferenceFrameProviderErrorCode,
    message: string
): MediabunnyReferenceFrameProviderError {
    return new MediabunnyReferenceFrameProviderError(code, message);
}

function createSafeDecodeError(): MediabunnyReferenceFrameProviderError {
    return createProviderError(
        'decode-failed',
        'The validation reference frame could not be decoded'
    );
}

function toSafeProviderError(error: unknown): MediabunnyReferenceFrameProviderError {
    if (error instanceof MediabunnyReferenceFrameProviderError) {
        return error;
    }

    return createSafeDecodeError();
}

function validateOptions(
    options: MediabunnyReferenceFrameProviderOptions
): Microseconds[] {
    if (typeof options.url !== 'string' || options.url.trim() === '') {
        throw createProviderError('invalid-options', 'A validation media URL is required');
    }
    if (!Number.isSafeInteger(options.globalTrackIndex) || options.globalTrackIndex < 0) {
        throw createProviderError(
            'invalid-options',
            'The global validation track index must be a non-negative integer'
        );
    }
    if (
        options.timestampsMicroseconds.length === 0
        || options.timestampsMicroseconds.length > MAXIMUM_REFERENCE_FRAME_COUNT
    ) {
        throw createProviderError(
            'invalid-options',
            'Validation requires from 1 through 64 bounded frame timestamps'
        );
    }

    const timestamps: Microseconds[] = [];
    let previousTimestamp: Microseconds | null = null;
    for (const timestamp of options.timestampsMicroseconds) {
        if (
            !Number.isSafeInteger(timestamp)
            || timestamp < 0
            || (previousTimestamp !== null && timestamp <= previousTimestamp)
        ) {
            throw createProviderError(
                'invalid-options',
                'Validation frame timestamps must be increasing non-negative integer microseconds'
            );
        }
        timestamps.push(timestamp);
        previousTimestamp = timestamp;
    }
    return timestamps;
}

function safelyDisposeInput(input: Input | null): boolean {
    if (!input) {
        return true;
    }

    try {
        input.dispose();
        return true;
    } catch {
        return false;
    }
}

/** Sequential, bounded decoded-frame source for generated validation clips. */
export class MediabunnyReferenceFrameProvider {
    private activeOperation: Promise<VideoFrame> | null = null;
    private completed = false;
    private destroyed = false;
    private readonly expectedTimestampsMicroseconds: readonly Microseconds[];
    private input: Input | null;
    private iterator: VideoSampleIterator | null = null;
    private nextSampleIndex = 0;
    private readonly producedFrames = new WeakSet<VideoFrame>();
    private readonly sampleSink: VideoSampleSink;

    private constructor(
        input: Input,
        sampleSink: VideoSampleSink,
        expectedTimestampsMicroseconds: readonly Microseconds[]
    ) {
        this.expectedTimestampsMicroseconds = expectedTimestampsMicroseconds;
        this.input = input;
        this.sampleSink = sampleSink;
    }

    /** Opens a bounded media input and validates the exact global video track. */
    public static async create(
        options: MediabunnyReferenceFrameProviderOptions
    ): Promise<MediabunnyReferenceFrameProvider> {
        const expectedTimestampsMicroseconds = validateOptions(options);
        let input: Input | null = null;
        try {
            input = new Input({
                formats: ALL_FORMATS,
                source: new UrlSource(options.url, {
                    maxCacheSize: URL_SOURCE_CACHE_BYTES,
                    parallelism: URL_SOURCE_PARALLELISM
                })
            });
            const tracks = await input.getTracks();
            if (options.globalTrackIndex >= tracks.length) {
                throw createProviderError(
                    'track-out-of-range',
                    'The global validation track index is outside the media track list'
                );
            }

            const selectedTrack = tracks[options.globalTrackIndex];
            if (!(selectedTrack instanceof InputVideoTrack)) {
                throw createProviderError(
                    'track-not-video',
                    'The selected global validation track is not a video track'
                );
            }
            if (!await selectedTrack.canDecode()) {
                throw createProviderError(
                    'track-not-decodable',
                    'The selected validation video track cannot be decoded by this browser'
                );
            }

            const sampleSink = new VideoSampleSink(selectedTrack, {
                hardwareAcceleration: 'prefer-hardware',
                optimizeForLatency: true
            });
            return new MediabunnyReferenceFrameProvider(
                input,
                sampleSink,
                expectedTimestampsMicroseconds
            );
        } catch (error) {
            safelyDisposeInput(input);
            throw toSafeProviderError(error);
        }
    }

    /**
     * Returns one fresh VideoFrame for the next exact manifest timestamp.
     * Ownership of a successful frame transfers to the caller.
     */
    public getFrame(
        frameRequest: Readonly<ExternalTextureReferenceFrameRequest>
    ): Promise<VideoFrame> {
        if (this.destroyed) {
            return Promise.reject(createProviderError(
                'destroyed',
                'The validation reference frame provider has been destroyed'
            ));
        }
        if (this.completed || this.nextSampleIndex >= this.expectedTimestampsMicroseconds.length) {
            return Promise.reject(createProviderError(
                'non-sequential-request',
                'The bounded validation frame sequence is complete'
            ));
        }
        if (this.activeOperation) {
            return Promise.reject(createProviderError(
                'non-sequential-request',
                'Validation reference frames must be requested sequentially'
            ));
        }

        const operation = this.produceFrame(frameRequest);
        this.activeOperation = operation;
        return operation.finally((): void => {
            if (this.activeOperation === operation) {
                this.activeOperation = null;
            }
        });
    }

    /** Cancels active reads, closes the iterator, and disposes the media input. */
    public async destroy(): Promise<void> {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        const input = this.input;
        if (safelyDisposeInput(input)) {
            this.input = null;
        }
        const activeOperation = this.activeOperation;
        if (activeOperation) {
            try {
                await activeOperation;
            } catch {
                // Destruction intentionally waits for cancellation to settle
            }
        }

        const iteratorClosed = await this.closeIterator();
        if (!iteratorClosed) {
            throw createProviderError(
                'decode-failed',
                'The validation media iterator could not be released'
            );
        }
    }

    private async produceFrame(
        frameRequest: Readonly<ExternalTextureReferenceFrameRequest>
    ): Promise<VideoFrame> {
        let sample: VideoSample | null = null;
        let frame: VideoFrame | null = null;
        try {
            const expectedTimestamp = this.expectedTimestampsMicroseconds[this.nextSampleIndex];
            if (
                !Number.isSafeInteger(frameRequest.timestampMicroseconds)
                || frameRequest.timestampMicroseconds !== expectedTimestamp
                || !Number.isSafeInteger(frameRequest.generation)
                || frameRequest.sampleIndex !== this.nextSampleIndex
            ) {
                throw createProviderError(
                    'non-sequential-request',
                    'The validation frame request does not match the manifest sequence'
                );
            }

            if (!this.iterator) {
                this.iterator = this.sampleSink.samples(
                    microsecondsToSeconds(expectedTimestamp)
                ) as unknown as VideoSampleIterator;
            }
            const iteratorResult = await this.iterator.next();
            sample = iteratorResult.value ?? null;
            if (this.destroyed) {
                throw createProviderError(
                    'destroyed',
                    'The validation reference frame provider was destroyed during decoding'
                );
            }
            if (iteratorResult.done || !sample) {
                throw createProviderError(
                    'sample-mismatch',
                    'The validation clip ended before the requested manifest frame'
                );
            }
            if (
                !Number.isSafeInteger(sample.microsecondTimestamp)
                || sample.microsecondTimestamp !== expectedTimestamp
            ) {
                throw createProviderError(
                    'sample-mismatch',
                    'The decoded validation sample timestamp does not match the manifest'
                );
            }

            frame = sample.toVideoFrame();
            if (this.producedFrames.has(frame)) {
                throw createProviderError(
                    'sample-mismatch',
                    'The decoder reused a VideoFrame instead of producing a fresh frame'
                );
            }
            this.producedFrames.add(frame);
            if (
                !Number.isSafeInteger(frame.timestamp)
                || frame.timestamp !== expectedTimestamp
            ) {
                throw createProviderError(
                    'sample-mismatch',
                    'The decoded validation VideoFrame timestamp does not match the manifest'
                );
            }
            if (!this.closeSample(sample)) {
                throw createSafeDecodeError();
            }
            sample = null;

            this.nextSampleIndex += 1;
            if (this.nextSampleIndex === this.expectedTimestampsMicroseconds.length) {
                this.completed = true;
                if (!await this.closeResources()) {
                    throw createProviderError(
                        'decode-failed',
                        'The validation media resources could not be released'
                    );
                }
            }

            const producedFrame = frame;
            frame = null;
            return producedFrame;
        } catch (error) {
            this.closeFrame(frame);
            if (sample) {
                this.closeSample(sample);
            }
            await this.closeResources();
            this.completed = true;
            throw toSafeProviderError(error);
        }
    }

    private closeSample(sample: VideoSample): boolean {
        try {
            sample.close();
            return true;
        } catch {
            return false;
        }
    }

    private closeFrame(frame: VideoFrame | null): boolean {
        if (!frame) {
            return true;
        }

        try {
            frame.close();
            return true;
        } catch {
            return false;
        }
    }

    private async closeIterator(): Promise<boolean> {
        const iterator = this.iterator;
        this.iterator = null;
        if (!iterator) {
            return true;
        }

        try {
            await iterator.return();
            return true;
        } catch {
            return false;
        }
    }

    private async closeResources(): Promise<boolean> {
        const iteratorClosed = await this.closeIterator();
        const input = this.input;
        const inputDisposed = safelyDisposeInput(input);
        if (inputDisposed) {
            this.input = null;
        }
        return iteratorClosed && inputDisposed;
    }
}

/** Creates an exact-track Mediabunny provider for a generated validation clip. */
export function createMediabunnyReferenceFrameProvider(
    options: MediabunnyReferenceFrameProviderOptions
): Promise<MediabunnyReferenceFrameProvider> {
    return MediabunnyReferenceFrameProvider.create(options);
}

/** Opens, validates, consumes, and destroys a generated reference clip. */
export async function validateMediabunnyExternalTextureReferenceFrames(
    runner: ValidationRunner,
    validationRequest: MediabunnyExternalTextureValidationRequest
): Promise<ColorValidationCapabilityDecision | null> {
    const provider = await MediabunnyReferenceFrameProvider.create({
        globalTrackIndex: validationRequest.globalTrackIndex,
        timestampsMicroseconds: validationRequest.timestampsMicroseconds,
        url: validationRequest.url
    });
    try {
        return await runner.validate({
            adapterInfo: validationRequest.adapterInfo,
            browserMetadata: validationRequest.browserMetadata,
            device: validationRequest.device,
            getFrame: (
                frameRequest: Readonly<ExternalTextureReferenceFrameRequest>
            ): Promise<VideoFrame> => provider.getFrame(frameRequest),
            metadata: validationRequest.metadata,
            rampOptions: validationRequest.rampOptions
        });
    } finally {
        await provider.destroy();
    }
}
