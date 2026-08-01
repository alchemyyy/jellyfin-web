import { beforeEach, describe, expect, it, vi } from 'vitest';

const mediabunnyMock = vi.hoisted(() => ({
    allFormats: { name: 'all-formats' },
    createInput: vi.fn(),
    createSampleSink: vi.fn(),
    createUrlSource: vi.fn(),
    inputOptions: [] as unknown[],
    sampleSinkOptions: [] as unknown[],
    urlSourceOptions: [] as unknown[]
}));

vi.mock('mediabunny', () => {
    class MockInputVideoTrack {}
    class MockInput {
        public constructor(options: unknown) {
            mediabunnyMock.inputOptions.push(options);
            return mediabunnyMock.createInput(options);
        }
    }
    class MockUrlSource {
        public constructor(url: string, options: unknown) {
            mediabunnyMock.urlSourceOptions.push({ options, url });
            return mediabunnyMock.createUrlSource(url, options);
        }
    }
    class MockVideoSampleSink {
        public constructor(track: unknown, options: unknown) {
            mediabunnyMock.sampleSinkOptions.push({ options, track });
            return mediabunnyMock.createSampleSink(track, options);
        }
    }

    return {
        // eslint-disable-next-line @typescript-eslint/naming-convention
        ALL_FORMATS: mediabunnyMock.allFormats,
        Input: MockInput,
        InputVideoTrack: MockInputVideoTrack,
        UrlSource: MockUrlSource,
        VideoSampleSink: MockVideoSampleSink
    };
});

import { ALL_FORMATS, InputVideoTrack } from 'mediabunny';

import { createPQColorMetadata } from '../color/ColorMetadata';
import {
    millisecondsToMicroseconds,
    type Microseconds
} from '../MediaTime';
import {
    createMediabunnyReferenceFrameProvider,
    MediabunnyReferenceFrameProviderError,
    validateMediabunnyExternalTextureReferenceFrames
} from './MediabunnyReferenceFrameProvider';
import { type ExternalTextureReferenceFrameRequest } from './WebGPUExternalTextureValidationRunner';

type MockFunction = ReturnType<typeof vi.fn>;

type Deferred<Value> = {
    promise: Promise<Value>
    resolve: (value: Value) => void
};

type MockFrame = VideoFrame & {
    close: MockFunction
};

type MockSample = {
    close: MockFunction
    microsecondTimestamp: number
    toVideoFrame: MockFunction
};

type ProviderHarness = {
    canDecode: MockFunction
    disposeInput: MockFunction
    getTracks: MockFunction
    input: {
        dispose: MockFunction
        getTracks: MockFunction
    }
    iteratorNext: MockFunction
    iteratorReturn: MockFunction
    samples: MockFunction
    sink: {
        samples: MockFunction
    }
    videoTrack: InstanceType<typeof InputVideoTrack> & {
        canDecode: MockFunction
    }
};

const SECRET_URL = 'https://media.invalid/ramp.mp4?api_key=secret-token';
const TIMESTAMPS: readonly Microseconds[] = [
    millisecondsToMicroseconds(0),
    millisecondsToMicroseconds(1_000),
    millisecondsToMicroseconds(2_000)
];

function createDeferred<Value>(): Deferred<Value> {
    let resolvePromise: (value: Value) => void = () => {
        throw new Error('Deferred promise was not initialized');
    };
    const promise = new Promise<Value>(resolve => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

function createFrame(timestamp: number): MockFrame {
    return {
        close: vi.fn(),
        timestamp
    } as unknown as MockFrame;
}

function createSample(timestamp: number, frame: MockFrame = createFrame(timestamp)): MockSample {
    return {
        close: vi.fn(),
        microsecondTimestamp: timestamp,
        toVideoFrame: vi.fn(() => frame)
    };
}

function createFrameRequest(
    timestampMicroseconds: Microseconds,
    sampleIndex: number
): ExternalTextureReferenceFrameRequest {
    return {
        encodedInputRGB: [ 0.5, 0.5, 0.5 ],
        generation: 1,
        inputColorMetadata: createPQColorMetadata(),
        sampleIndex,
        timestampMicroseconds
    };
}

function createProviderHarness(
    tracks?: unknown[]
): ProviderHarness {
    const canDecode = vi.fn(async () => true);
    const videoTrack = Object.create(InputVideoTrack.prototype) as
        ProviderHarness['videoTrack'];
    videoTrack.canDecode = canDecode;
    const getTracks = vi.fn(async () => tracks ?? [ videoTrack ]);
    const disposeInput = vi.fn();
    const input = {
        dispose: disposeInput,
        getTracks
    };
    const iteratorNext = vi.fn();
    const iteratorReturn = vi.fn(async () => ({ done: true, value: undefined }));
    const iterator = {
        next: iteratorNext,
        return: iteratorReturn
    };
    const samples = vi.fn(() => iterator);
    const sink = { samples };
    mediabunnyMock.createInput.mockReturnValue(input);
    mediabunnyMock.createSampleSink.mockReturnValue(sink);
    mediabunnyMock.createUrlSource.mockImplementation((url: string) => ({ url }));
    return {
        canDecode,
        disposeInput,
        getTracks,
        input,
        iteratorNext,
        iteratorReturn,
        samples,
        sink,
        videoTrack
    };
}

function expectSafeError(error: unknown, expectedCode: string): void {
    expect(error).toBeInstanceOf(MediabunnyReferenceFrameProviderError);
    const providerError = error as MediabunnyReferenceFrameProviderError;
    expect(providerError.code).toBe(expectedCode);
    expect(providerError.message).not.toContain('media.invalid');
    expect(providerError.message).not.toContain('secret-token');
}

beforeEach(() => {
    mediabunnyMock.createInput.mockReset();
    mediabunnyMock.createSampleSink.mockReset();
    mediabunnyMock.createUrlSource.mockReset();
    mediabunnyMock.inputOptions.length = 0;
    mediabunnyMock.sampleSinkOptions.length = 0;
    mediabunnyMock.urlSourceOptions.length = 0;
});

describe('MediabunnyReferenceFrameProvider', () => {
    it('uses the exact global video track and produces the bounded manifest sequence', async () => {
        const eventOrder: string[] = [];
        const audioTrack = { type: 'audio' };
        const harness = createProviderHarness();
        harness.getTracks.mockResolvedValue([ audioTrack, harness.videoTrack ]);
        harness.canDecode.mockImplementation(async () => {
            eventOrder.push('can-decode');
            return true;
        });
        mediabunnyMock.createSampleSink.mockImplementation(() => {
            eventOrder.push('create-sink');
            return harness.sink;
        });
        const samples = TIMESTAMPS.map(timestamp => createSample(timestamp));
        for (const sample of samples) {
            harness.iteratorNext.mockResolvedValueOnce({ done: false, value: sample });
        }

        const provider = await createMediabunnyReferenceFrameProvider({
            globalTrackIndex: 1,
            timestampsMicroseconds: TIMESTAMPS,
            url: SECRET_URL
        });
        const frames: VideoFrame[] = [];
        for (let sampleIndex = 0; sampleIndex < TIMESTAMPS.length; sampleIndex += 1) {
            frames.push(await provider.getFrame(createFrameRequest(
                TIMESTAMPS[sampleIndex],
                sampleIndex
            )));
        }

        expect(eventOrder).toEqual([ 'can-decode', 'create-sink' ]);
        expect(harness.canDecode).toHaveBeenCalledOnce();
        expect(mediabunnyMock.sampleSinkOptions[0]).toEqual({
            options: {
                hardwareAcceleration: 'prefer-hardware',
                optimizeForLatency: true
            },
            track: harness.videoTrack
        });
        expect(mediabunnyMock.inputOptions[0]).toMatchObject({
            formats: ALL_FORMATS
        });
        expect(harness.samples).toHaveBeenCalledOnce();
        expect(harness.samples).toHaveBeenCalledWith(0);
        expect(samples.every(sample => sample.close.mock.calls.length === 1)).toBe(true);
        expect(new Set(frames).size).toBe(TIMESTAMPS.length);
        expect(harness.iteratorReturn).toHaveBeenCalledOnce();
        expect(harness.disposeInput).toHaveBeenCalledOnce();
        for (const frame of frames) {
            frame.close();
        }
        await provider.destroy();
        expect(harness.iteratorReturn).toHaveBeenCalledOnce();
        expect(harness.disposeInput).toHaveBeenCalledOnce();
    });

    it('rejects a selected global track that is not video and disposes the input', async () => {
        const audioTrack = { canDecode: vi.fn(), type: 'audio' };
        const harness = createProviderHarness([ audioTrack ]);

        const creation = createMediabunnyReferenceFrameProvider({
            globalTrackIndex: 0,
            timestampsMicroseconds: TIMESTAMPS,
            url: SECRET_URL
        });

        await expect(creation).rejects.toSatisfy((error: unknown) => {
            expectSafeError(error, 'track-not-video');
            return true;
        });
        expect(audioTrack.canDecode).not.toHaveBeenCalled();
        expect(mediabunnyMock.createSampleSink).not.toHaveBeenCalled();
        expect(harness.disposeInput).toHaveBeenCalledOnce();
    });

    it('rejects an out-of-range global track index', async () => {
        const harness = createProviderHarness([]);

        await expect(createMediabunnyReferenceFrameProvider({
            globalTrackIndex: 2,
            timestampsMicroseconds: TIMESTAMPS,
            url: SECRET_URL
        })).rejects.toSatisfy((error: unknown) => {
            expectSafeError(error, 'track-out-of-range');
            return true;
        });
        expect(harness.disposeInput).toHaveBeenCalledOnce();
    });

    it('checks exact track decodability before constructing the sample sink', async () => {
        const harness = createProviderHarness();
        harness.canDecode.mockResolvedValue(false);

        await expect(createMediabunnyReferenceFrameProvider({
            globalTrackIndex: 0,
            timestampsMicroseconds: TIMESTAMPS,
            url: SECRET_URL
        })).rejects.toSatisfy((error: unknown) => {
            expectSafeError(error, 'track-not-decodable');
            return true;
        });
        expect(harness.canDecode).toHaveBeenCalledOnce();
        expect(mediabunnyMock.createSampleSink).not.toHaveBeenCalled();
        expect(harness.disposeInput).toHaveBeenCalledOnce();
    });

    it('redacts source details from Mediabunny initialization errors', async () => {
        const harness = createProviderHarness();
        harness.getTracks.mockRejectedValue(new Error(`Failed to fetch ${SECRET_URL}`));

        await expect(createMediabunnyReferenceFrameProvider({
            globalTrackIndex: 0,
            timestampsMicroseconds: TIMESTAMPS,
            url: SECRET_URL
        })).rejects.toSatisfy((error: unknown) => {
            expectSafeError(error, 'decode-failed');
            return true;
        });
        expect(harness.disposeInput).toHaveBeenCalledOnce();
    });

    it('rejects a decoded sample timestamp mismatch and closes all resources', async () => {
        const harness = createProviderHarness();
        const sample = createSample(1);
        harness.iteratorNext.mockResolvedValue({ done: false, value: sample });
        const provider = await createMediabunnyReferenceFrameProvider({
            globalTrackIndex: 0,
            timestampsMicroseconds: TIMESTAMPS,
            url: SECRET_URL
        });

        await expect(provider.getFrame(createFrameRequest(TIMESTAMPS[0], 0))).rejects.toSatisfy(
            (error: unknown) => {
                expectSafeError(error, 'sample-mismatch');
                return true;
            }
        );
        expect(sample.close).toHaveBeenCalledOnce();
        expect(sample.toVideoFrame).not.toHaveBeenCalled();
        expect(harness.iteratorReturn).toHaveBeenCalledOnce();
        expect(harness.disposeInput).toHaveBeenCalledOnce();
    });

    it('closes a mismatched VideoFrame and its VideoSample', async () => {
        const harness = createProviderHarness();
        const frame = createFrame(1);
        const sample = createSample(0, frame);
        harness.iteratorNext.mockResolvedValue({ done: false, value: sample });
        const provider = await createMediabunnyReferenceFrameProvider({
            globalTrackIndex: 0,
            timestampsMicroseconds: TIMESTAMPS,
            url: SECRET_URL
        });

        await expect(provider.getFrame(createFrameRequest(TIMESTAMPS[0], 0))).rejects.toSatisfy(
            (error: unknown) => {
                expectSafeError(error, 'sample-mismatch');
                return true;
            }
        );
        expect(frame.close).toHaveBeenCalledOnce();
        expect(sample.close).toHaveBeenCalledOnce();
        expect(harness.iteratorReturn).toHaveBeenCalledOnce();
        expect(harness.disposeInput).toHaveBeenCalledOnce();
    });

    it('rejects a reused VideoFrame and closes both samples', async () => {
        const harness = createProviderHarness();
        const frame = createFrame(0);
        const firstSample = createSample(0, frame);
        const secondSample = createSample(1_000_000, frame);
        harness.iteratorNext
            .mockResolvedValueOnce({ done: false, value: firstSample })
            .mockImplementationOnce(async () => {
                Object.defineProperty(frame, 'timestamp', {
                    configurable: true,
                    value: 1_000_000
                });
                return { done: false, value: secondSample };
            });
        const provider = await createMediabunnyReferenceFrameProvider({
            globalTrackIndex: 0,
            timestampsMicroseconds: TIMESTAMPS,
            url: SECRET_URL
        });

        const firstFrame = await provider.getFrame(createFrameRequest(TIMESTAMPS[0], 0));
        firstFrame.close();
        await expect(
            provider.getFrame(createFrameRequest(TIMESTAMPS[1], 1))
        ).rejects.toSatisfy((error: unknown) => {
            expectSafeError(error, 'sample-mismatch');
            return true;
        });
        expect(firstSample.close).toHaveBeenCalledOnce();
        expect(secondSample.close).toHaveBeenCalledOnce();
        expect(frame.close).toHaveBeenCalledTimes(2);
        expect(harness.iteratorReturn).toHaveBeenCalledOnce();
        expect(harness.disposeInput).toHaveBeenCalledOnce();
    });

    it('rejects out-of-order requests without silently substituting a sample', async () => {
        const harness = createProviderHarness();
        const provider = await createMediabunnyReferenceFrameProvider({
            globalTrackIndex: 0,
            timestampsMicroseconds: TIMESTAMPS,
            url: SECRET_URL
        });

        await expect(
            provider.getFrame(createFrameRequest(TIMESTAMPS[1], 1))
        ).rejects.toSatisfy((error: unknown) => {
            expectSafeError(error, 'non-sequential-request');
            return true;
        });
        expect(harness.iteratorNext).not.toHaveBeenCalled();
        expect(harness.disposeInput).toHaveBeenCalledOnce();
    });

    it('rejects concurrent reads while allowing the active sequential read to finish', async () => {
        const harness = createProviderHarness();
        const sampleDeferred = createDeferred<IteratorResult<MockSample>>();
        const frame = createFrame(0);
        harness.iteratorNext.mockReturnValue(sampleDeferred.promise);
        const provider = await createMediabunnyReferenceFrameProvider({
            globalTrackIndex: 0,
            timestampsMicroseconds: TIMESTAMPS,
            url: SECRET_URL
        });

        const firstFramePromise = provider.getFrame(createFrameRequest(TIMESTAMPS[0], 0));
        await expect(
            provider.getFrame(createFrameRequest(TIMESTAMPS[1], 1))
        ).rejects.toSatisfy((error: unknown) => {
            expectSafeError(error, 'non-sequential-request');
            return true;
        });
        sampleDeferred.resolve({ done: false, value: createSample(0, frame) });
        await expect(firstFramePromise).resolves.toBe(frame);
        frame.close();
        await provider.destroy();
        expect(harness.iteratorReturn).toHaveBeenCalledOnce();
        expect(harness.disposeInput).toHaveBeenCalledOnce();
    });

    it('cancels an active iterator and closes its yielded sample during destruction', async () => {
        const harness = createProviderHarness();
        const sampleDeferred = createDeferred<IteratorResult<MockSample>>();
        const sample = createSample(0);
        harness.iteratorNext.mockReturnValue(sampleDeferred.promise);
        const provider = await createMediabunnyReferenceFrameProvider({
            globalTrackIndex: 0,
            timestampsMicroseconds: TIMESTAMPS,
            url: SECRET_URL
        });

        const framePromise = provider.getFrame(createFrameRequest(TIMESTAMPS[0], 0));
        await Promise.resolve();
        const destruction = provider.destroy();
        expect(harness.disposeInput).toHaveBeenCalledOnce();
        sampleDeferred.resolve({ done: false, value: sample });

        await expect(framePromise).rejects.toSatisfy((error: unknown) => {
            expectSafeError(error, 'destroyed');
            return true;
        });
        await expect(destruction).resolves.toBeUndefined();
        expect(sample.close).toHaveBeenCalledOnce();
        expect(harness.iteratorReturn).toHaveBeenCalledOnce();
    });

    it('redacts iterator failures and releases the input', async () => {
        const harness = createProviderHarness();
        harness.iteratorNext.mockRejectedValue(new Error(`Decode failed for ${SECRET_URL}`));
        const provider = await createMediabunnyReferenceFrameProvider({
            globalTrackIndex: 0,
            timestampsMicroseconds: TIMESTAMPS,
            url: SECRET_URL
        });

        await expect(provider.getFrame(createFrameRequest(TIMESTAMPS[0], 0))).rejects.toSatisfy(
            (error: unknown) => {
                expectSafeError(error, 'decode-failed');
                return true;
            }
        );
        expect(harness.iteratorReturn).toHaveBeenCalledOnce();
        expect(harness.disposeInput).toHaveBeenCalledOnce();
    });

    it('destroys an opened provider when the validation runner fails', async () => {
        const harness = createProviderHarness();
        const encodedRGBTriplets = [
            [ 0.25, 0.25, 0.25 ],
            [ 0.75, 0.25, 0.25 ],
            [ 0.25, 0.75, 0.25 ]
        ] as const;
        const runner = {
            validate: vi.fn(async () => {
                throw new Error('GPU validation failed');
            })
        };

        await expect(validateMediabunnyExternalTextureReferenceFrames(runner, {
            device: {} as GPUDevice,
            globalTrackIndex: 0,
            metadata: createPQColorMetadata(),
            rampOptions: { encodedRGBTriplets },
            timestampsMicroseconds: TIMESTAMPS,
            url: SECRET_URL
        })).rejects.toThrow('GPU validation failed');
        expect(runner.validate).toHaveBeenCalledWith(expect.objectContaining({
            rampOptions: { encodedRGBTriplets }
        }));
        expect(harness.disposeInput).toHaveBeenCalledOnce();
        expect(harness.iteratorReturn).not.toHaveBeenCalled();
    });
});
