import type {
    FragmentLoaderContext,
    HlsConfig,
    Loader,
    LoaderCallbacks,
    LoaderConfiguration,
    LoaderResponse,
    LoaderStats
} from 'hls.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    createTransformingFragmentLoader,
    type FMP4SegmentTransformer
} from './hlsFragmentLoader';

const TEST_HLS_CONFIG = {} as HlsConfig;
const TEST_LOADER_CONFIGURATION = {} as LoaderConfiguration;

class FakeDefaultLoader implements Loader<FragmentLoaderContext> {
    public static readonly instances: FakeDefaultLoader[] = [];

    public context: FragmentLoaderContext | null = null;
    public readonly stats: LoaderStats = createLoaderStats();
    public callbacks: LoaderCallbacks<FragmentLoaderContext> | null = null;
    public aborted = false;
    public destroyed = false;

    public constructor() {
        FakeDefaultLoader.instances.push(this);
    }

    public load(
        context: FragmentLoaderContext,
        _config: LoaderConfiguration,
        callbacks: LoaderCallbacks<FragmentLoaderContext>
    ): void {
        this.context = context;
        this.callbacks = callbacks;
    }

    public abort(): void {
        this.aborted = true;
    }

    public destroy(): void {
        this.destroyed = true;
    }

    public getCacheAge(): number {
        return 42;
    }

    public getResponseHeader(name: string): string | null {
        return name === 'x-test' ? 'header value' : null;
    }

    public succeed(response: LoaderResponse, networkDetails: object): void {
        if (this.callbacks === null || this.context === null) {
            throw new Error('Fake loader has not started');
        }

        this.callbacks.onSuccess(
            response,
            this.stats,
            this.context,
            networkDetails
        );
    }
}

class RecordingTransformer implements FMP4SegmentTransformer {
    public readonly initializationPayloads: Uint8Array[] = [];
    public readonly mediaPayloads: Uint8Array[] = [];

    public transformInitializationSegment(payload: Uint8Array): Uint8Array {
        this.initializationPayloads.push(payload);
        return appendByte(payload, 0xA1);
    }

    public transformMediaSegment(payload: Uint8Array): Uint8Array {
        this.mediaPayloads.push(payload);
        return appendByte(payload, 0xB2);
    }
}

describe('client HDR tone-mapping fragment loader', () => {
    beforeEach(() => {
        FakeDefaultLoader.instances.length = 0;
    });

    it('shares one transformer and selects the transformation from the fragment SN', () => {
        const transformer = new RecordingTransformer();
        const onInitializationSegmentTransformState = vi.fn();
        const LoaderClass = createTransformingFragmentLoader(
            FakeDefaultLoader,
            transformer,
            onInitializationSegmentTransformState
        );
        const initializationLoader = new LoaderClass(TEST_HLS_CONFIG);
        const mediaLoader = new LoaderClass(TEST_HLS_CONFIG);
        const initializationContext = createFragmentContext('initSegment');
        const mediaContext = createFragmentContext(1);
        const initializationSuccess = vi.fn();
        const mediaSuccess = vi.fn();

        initializationLoader.load(
            initializationContext,
            TEST_LOADER_CONFIGURATION,
            createCallbacks(initializationSuccess)
        );
        mediaLoader.load(
            mediaContext,
            TEST_LOADER_CONFIGURATION,
            createCallbacks(mediaSuccess)
        );

        FakeDefaultLoader.instances[0].succeed(
            createResponse([ 0x01, 0x02 ]),
            { request: 'initialization' }
        );
        FakeDefaultLoader.instances[1].succeed(
            createResponse([ 0x03, 0x04 ]),
            { request: 'media' }
        );

        expect(transformer.initializationPayloads).toHaveLength(1);
        expect(transformer.mediaPayloads).toHaveLength(1);
        expect(getSuccessfulResponseBytes(initializationSuccess))
            .toEqual([ 0x01, 0x02, 0xA1 ]);
        expect(getSuccessfulResponseBytes(mediaSuccess))
            .toEqual([ 0x03, 0x04, 0xB2 ]);
        expect(onInitializationSegmentTransformState.mock.calls)
            .toEqual([[ true ]]);
    });

    it('preserves the response, stats, context, network details, and other callbacks', () => {
        const transformer = new RecordingTransformer();
        const LoaderClass = createTransformingFragmentLoader(
            FakeDefaultLoader,
            transformer
        );
        const loader = new LoaderClass(TEST_HLS_CONFIG);
        const context = createFragmentContext(7);
        const networkDetails = { request: 'network details' };
        const response = createResponse([ 0x11 ]);
        const onSuccess = vi.fn();
        const callbacks = createCallbacks(onSuccess);

        loader.load(context, TEST_LOADER_CONFIGURATION, callbacks);

        const defaultLoader = FakeDefaultLoader.instances[0];
        expect(loader.stats).toBe(defaultLoader.stats);
        expect(loader.context).toBe(context);
        expect(defaultLoader.callbacks?.onProgress).toBe(callbacks.onProgress);
        expect(defaultLoader.callbacks?.onError).toBe(callbacks.onError);
        expect(defaultLoader.callbacks?.onTimeout).toBe(callbacks.onTimeout);

        defaultLoader.succeed(response, networkDetails);

        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(onSuccess.mock.calls[0][0]).toBe(response);
        expect(onSuccess.mock.calls[0][1]).toBe(defaultLoader.stats);
        expect(onSuccess.mock.calls[0][2]).toBe(context);
        expect(onSuccess.mock.calls[0][3]).toBe(networkDetails);
        expect(response.code).toBe(200);
        expect(response.text).toBe('OK');
    });

    it('does not let audio initialization or media overwrite main-track state', () => {
        const onInitializationSegmentTransformState = vi.fn();
        const unchangedTransformer: FMP4SegmentTransformer = {
            transformInitializationSegment: vi.fn(payload => payload),
            transformMediaSegment: vi.fn(payload => payload)
        };
        const LoaderClass = createTransformingFragmentLoader(
            FakeDefaultLoader,
            unchangedTransformer,
            onInitializationSegmentTransformState
        );
        const mainInitializationLoader = new LoaderClass(TEST_HLS_CONFIG);
        const audioInitializationLoader = new LoaderClass(TEST_HLS_CONFIG);
        const audioMediaLoader = new LoaderClass(TEST_HLS_CONFIG);
        const mainMediaLoader = new LoaderClass(TEST_HLS_CONFIG);
        const mainInitializationResponse = createResponse([ 0x00, 0x00, 0x00, 0x20 ]);
        const audioInitializationResponse = createResponse([ 0x00, 0x00, 0x00, 0x18 ]);
        const audioMediaResponse = createResponse([ 0x47, 0x00, 0x10 ]);
        const mainMediaResponse = createResponse([ 0x00, 0x00, 0x00, 0x08 ]);
        const audioInitializationBuffer = audioInitializationResponse.data;
        const audioMediaBuffer = audioMediaResponse.data;
        const audioInitializationSuccess = vi.fn();
        const audioMediaSuccess = vi.fn();

        mainInitializationLoader.load(
            createFragmentContext('initSegment'),
            TEST_LOADER_CONFIGURATION,
            createCallbacks(vi.fn())
        );
        audioInitializationLoader.load(
            createFragmentContext('initSegment', 'audio'),
            TEST_LOADER_CONFIGURATION,
            createCallbacks(audioInitializationSuccess)
        );
        audioMediaLoader.load(
            createFragmentContext(2, 'audio'),
            TEST_LOADER_CONFIGURATION,
            createCallbacks(audioMediaSuccess)
        );
        mainMediaLoader.load(
            createFragmentContext(2),
            TEST_LOADER_CONFIGURATION,
            createCallbacks(vi.fn())
        );

        FakeDefaultLoader.instances[0].succeed(mainInitializationResponse, {});
        FakeDefaultLoader.instances[1].succeed(audioInitializationResponse, {});
        FakeDefaultLoader.instances[2].succeed(audioMediaResponse, {});
        FakeDefaultLoader.instances[3].succeed(mainMediaResponse, {});

        expect(unchangedTransformer.transformInitializationSegment)
            .toHaveBeenCalledTimes(1);
        expect(unchangedTransformer.transformMediaSegment).toHaveBeenCalledTimes(1);
        expect(audioInitializationResponse.data).toBe(audioInitializationBuffer);
        expect(audioMediaResponse.data).toBe(audioMediaBuffer);
        expect(getSuccessfulResponseBytes(audioMediaSuccess))
            .toEqual([ 0x47, 0x00, 0x10 ]);
        expect(unchangedTransformer.transformInitializationSegment)
            .toHaveBeenCalledWith(expect.any(Uint8Array));
        expect(onInitializationSegmentTransformState.mock.calls)
            .toEqual([[ false ]]);
    });

    it('fails open when transformation rejects a fragment', () => {
        const error = new Error('Unsupported layout');
        const transformer: FMP4SegmentTransformer = {
            transformInitializationSegment: vi.fn(() => {
                throw error;
            }),
            transformMediaSegment: vi.fn(() => {
                throw error;
            })
        };
        const onInitializationSegmentTransformState = vi.fn();
        const LoaderClass = createTransformingFragmentLoader(
            FakeDefaultLoader,
            transformer,
            onInitializationSegmentTransformState
        );
        const loader = new LoaderClass(TEST_HLS_CONFIG);
        const response = createResponse([ 0x99 ]);
        const originalBuffer = response.data;
        const onSuccess = vi.fn();
        const consoleWarning = vi.spyOn(console, 'warn').mockImplementation(() => {
            // Expected fail-open warning
        });

        loader.load(
            createFragmentContext('initSegment'),
            TEST_LOADER_CONFIGURATION,
            createCallbacks(onSuccess)
        );
        FakeDefaultLoader.instances[0].succeed(response, {});

        expect(response.data).toBe(originalBuffer);
        expect(onSuccess).toHaveBeenCalledTimes(1);
        expect(consoleWarning).toHaveBeenCalledWith(
            'Client-side HDR tone mapping skipped an unsupported fragment',
            error
        );
        expect(onInitializationSegmentTransformState.mock.calls)
            .toEqual([[ false ]]);
    });

    it('fails open when the transform-state callback throws', () => {
        const callbackError = new Error('State listener failed');
        const onInitializationSegmentTransformState = vi.fn(() => {
            throw callbackError;
        });
        const LoaderClass = createTransformingFragmentLoader(
            FakeDefaultLoader,
            new RecordingTransformer(),
            onInitializationSegmentTransformState
        );
        const loader = new LoaderClass(TEST_HLS_CONFIG);
        const onSuccess = vi.fn();
        const consoleWarning = vi.spyOn(console, 'warn').mockImplementation(() => {
            // Expected fail-open warning
        });

        loader.load(
            createFragmentContext('initSegment'),
            TEST_LOADER_CONFIGURATION,
            createCallbacks(onSuccess)
        );
        FakeDefaultLoader.instances[0].succeed(
            createResponse([ 0x41 ]),
            {}
        );

        expect(onInitializationSegmentTransformState).toHaveBeenCalledWith(true);
        expect(getSuccessfulResponseBytes(onSuccess)).toEqual([ 0x41, 0xA1 ]);
        expect(consoleWarning).toHaveBeenCalledWith(
            'Client-side HDR tone-mapping state callback failed',
            callbackError
        );
    });

    it('reports every main initialization state change in load order', () => {
        let initializationCount = 0;
        const transformer: FMP4SegmentTransformer = {
            transformInitializationSegment: vi.fn(payload => {
                initializationCount++;
                return initializationCount === 2 ?
                    payload : appendByte(payload, initializationCount);
            }),
            transformMediaSegment: vi.fn(payload => payload)
        };
        const onInitializationSegmentTransformState = vi.fn();
        const LoaderClass = createTransformingFragmentLoader(
            FakeDefaultLoader,
            transformer,
            onInitializationSegmentTransformState
        );

        for (let initializationIndex = 0; initializationIndex < 3;
            initializationIndex++
        ) {
            const loader = new LoaderClass(TEST_HLS_CONFIG);
            loader.load(
                createFragmentContext('initSegment'),
                TEST_LOADER_CONFIGURATION,
                createCallbacks(vi.fn())
            );
            FakeDefaultLoader.instances[initializationIndex].succeed(
                createResponse([ initializationIndex ]),
                {}
            );
        }

        expect(onInitializationSegmentTransformState.mock.calls)
            .toEqual([[ true ], [ false ], [ true ]]);
    });

    it('deactivates after a main media segment fails open', () => {
        let mediaSegmentCount = 0;
        const transformer: FMP4SegmentTransformer = {
            transformInitializationSegment: vi.fn(payload =>
                appendByte(payload, 0xA1)
            ),
            transformMediaSegment: vi.fn(payload => {
                mediaSegmentCount++;
                return mediaSegmentCount === 1 ?
                    payload : appendByte(payload, 0xB2);
            })
        };
        const onInitializationSegmentTransformState = vi.fn();
        const LoaderClass = createTransformingFragmentLoader(
            FakeDefaultLoader,
            transformer,
            onInitializationSegmentTransformState
        );
        const initializationLoader = new LoaderClass(TEST_HLS_CONFIG);
        const failedMediaLoader = new LoaderClass(TEST_HLS_CONFIG);
        const recoveredMediaLoader = new LoaderClass(TEST_HLS_CONFIG);
        const replacementInitializationLoader = new LoaderClass(TEST_HLS_CONFIG);

        initializationLoader.load(
            createFragmentContext('initSegment'),
            TEST_LOADER_CONFIGURATION,
            createCallbacks(vi.fn())
        );
        failedMediaLoader.load(
            createFragmentContext(1),
            TEST_LOADER_CONFIGURATION,
            createCallbacks(vi.fn())
        );
        recoveredMediaLoader.load(
            createFragmentContext(2),
            TEST_LOADER_CONFIGURATION,
            createCallbacks(vi.fn())
        );
        replacementInitializationLoader.load(
            createFragmentContext('initSegment'),
            TEST_LOADER_CONFIGURATION,
            createCallbacks(vi.fn())
        );

        FakeDefaultLoader.instances[0].succeed(createResponse([ 0x01 ]), {});
        FakeDefaultLoader.instances[1].succeed(createResponse([ 0x02 ]), {});
        FakeDefaultLoader.instances[2].succeed(createResponse([ 0x03 ]), {});
        FakeDefaultLoader.instances[3].succeed(createResponse([ 0x04 ]), {});

        expect(onInitializationSegmentTransformState.mock.calls)
            .toEqual([[ true ], [ false ], [ true ]]);
    });

    it('reports an unusable main initialization response as unchanged', () => {
        const onInitializationSegmentTransformState = vi.fn();
        const LoaderClass = createTransformingFragmentLoader(
            FakeDefaultLoader,
            new RecordingTransformer(),
            onInitializationSegmentTransformState
        );
        const loader = new LoaderClass(TEST_HLS_CONFIG);
        const response: LoaderResponse = {
            url: 'https://example.test/fragment.m4s',
            data: 'not an array buffer',
            code: 200,
            text: 'OK'
        };

        loader.load(
            createFragmentContext('initSegment'),
            TEST_LOADER_CONFIGURATION,
            createCallbacks(vi.fn())
        );
        FakeDefaultLoader.instances[0].succeed(response, {});

        expect(onInitializationSegmentTransformState.mock.calls)
            .toEqual([[ false ]]);
    });

    it('delegates loader lifecycle and response metadata methods', () => {
        const LoaderClass = createTransformingFragmentLoader(
            FakeDefaultLoader,
            new RecordingTransformer()
        );
        const loader = new LoaderClass(TEST_HLS_CONFIG);
        const defaultLoader = FakeDefaultLoader.instances[0];

        expect(loader.getCacheAge?.()).toBe(42);
        expect(loader.getResponseHeader?.('x-test')).toBe('header value');

        loader.abort();
        loader.destroy();

        expect(defaultLoader.aborted).toBe(true);
        expect(defaultLoader.destroyed).toBe(true);
        expect(loader.context).toBeNull();
    });
});

function createLoaderStats(): LoaderStats {
    return {
        aborted: false,
        loaded: 0,
        retry: 0,
        total: 0,
        chunkCount: 0,
        bwEstimate: 0,
        loading: {
            start: 0,
            first: 0,
            end: 0
        },
        parsing: {
            start: 0,
            end: 0
        },
        buffering: {
            start: 0,
            first: 0,
            end: 0
        }
    };
}

function createFragmentContext(
    sequenceNumber: number | 'initSegment',
    fragmentType = 'main'
): FragmentLoaderContext {
    const fragment = {
        sn: sequenceNumber,
        type: fragmentType
    } as unknown as FragmentLoaderContext['frag'];

    return {
        url: 'https://example.test/fragment.m4s',
        responseType: 'arraybuffer',
        frag: fragment,
        part: null
    };
}

function createCallbacks(
    onSuccess: LoaderCallbacks<FragmentLoaderContext>['onSuccess']
): LoaderCallbacks<FragmentLoaderContext> {
    return {
        onSuccess,
        onError: vi.fn(),
        onTimeout: vi.fn(),
        onAbort: vi.fn(),
        onProgress: vi.fn()
    };
}

function createResponse(bytes: number[]): LoaderResponse {
    return {
        url: 'https://example.test/fragment.m4s',
        data: Uint8Array.from(bytes).buffer,
        code: 200,
        text: 'OK'
    };
}

function appendByte(payload: Uint8Array, value: number): Uint8Array {
    const result = new Uint8Array(payload.byteLength + 1);
    result.set(payload);
    result[payload.byteLength] = value;
    return result;
}

function getSuccessfulResponseBytes(onSuccess: ReturnType<typeof vi.fn>): number[] {
    const response = onSuccess.mock.calls[0][0] as LoaderResponse;
    return Array.from(new Uint8Array(response.data as ArrayBuffer));
}
