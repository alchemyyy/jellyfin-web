import type {
    FragmentLoaderContext,
    HlsConfig,
    Loader,
    LoaderCallbacks,
    LoaderConfiguration,
    LoaderStats
} from 'hls.js';

import { FMP4AGTMTransformer } from './fmp4AGTMTransformer';

export interface FMP4SegmentTransformer {
    transformInitializationSegment(payload: Uint8Array): Uint8Array;
    transformMediaSegment(payload: Uint8Array): Uint8Array;
}

export interface HlsConstructorWithDefaultConfig {
    readonly DefaultConfig: HlsConfig;
}

/**
 * Reports initialization success and later media failures that invalidate it.
 */
export type InitializationSegmentTransformStateCallback = (
    transformed: boolean
) => void;

type DefaultLoaderConstructor = HlsConfig['loader'];
type FragmentLoaderConstructor = NonNullable<HlsConfig['fLoader']>;

interface FragmentTransformationResult {
    initializationSegmentTransformed: boolean | null;
    mediaSegmentTransformed: boolean | null;
    responseData: ArrayBuffer;
}

/**
 * Creates an hls.js fragment loader whose transformer state is shared across
 * every loader instance created by one Hls player.
 */
export function createClientHDRToneMappingFragmentLoader(
    hlsConstructor: HlsConstructorWithDefaultConfig,
    agtmPayload: Uint8Array,
    onInitializationSegmentTransformState?:
    InitializationSegmentTransformStateCallback
): FragmentLoaderConstructor {
    const transformer = new FMP4AGTMTransformer(agtmPayload);

    return createTransformingFragmentLoader(
        hlsConstructor.DefaultConfig.loader,
        transformer,
        onInitializationSegmentTransformState
    );
}

/**
 * Wraps an hls.js loader and transforms successful fragment responses.
 * Exported separately to keep loader behavior independently testable.
 */
export function createTransformingFragmentLoader(
    DefaultLoader: DefaultLoaderConstructor,
    transformer: FMP4SegmentTransformer,
    onInitializationSegmentTransformState?:
    InitializationSegmentTransformStateCallback
): FragmentLoaderConstructor {
    let initializationSegmentTransformActive = false;

    return class ClientHDRToneMappingFragmentLoader implements Loader<FragmentLoaderContext> {
        public context: FragmentLoaderContext | null = null;
        public readonly stats: LoaderStats;

        private readonly loader: Loader<FragmentLoaderContext>;

        public constructor(config: HlsConfig) {
            this.loader = new DefaultLoader(config) as Loader<FragmentLoaderContext>;
            this.stats = this.loader.stats;
        }

        public load(
            context: FragmentLoaderContext,
            config: LoaderConfiguration,
            callbacks: LoaderCallbacks<FragmentLoaderContext>
        ): void {
            this.context = context;

            const transformingCallbacks: LoaderCallbacks<FragmentLoaderContext> = {
                ...callbacks,
                onSuccess: (response, responseStats, responseContext, networkDetails) => {
                    const responseData = response.data;
                    let initializationSegmentTransformed: boolean | null =
                        isMainInitializationSegment(responseContext) ? false : null;
                    let mediaSegmentTransformed: boolean | null =
                        isMainMediaSegment(responseContext) ? false : null;

                    if (responseData instanceof ArrayBuffer) {
                        const transformationResult = transformResponseData(
                            transformer,
                            responseContext,
                            responseData
                        );
                        initializationSegmentTransformed =
                            transformationResult.initializationSegmentTransformed;
                        mediaSegmentTransformed =
                            transformationResult.mediaSegmentTransformed;

                        if (transformationResult.responseData !== responseData) {
                            response.data = transformationResult.responseData;
                        }
                    }

                    if (initializationSegmentTransformed !== null) {
                        initializationSegmentTransformActive =
                            initializationSegmentTransformed;
                    } else if (
                        initializationSegmentTransformActive
                        && mediaSegmentTransformed === false
                    ) {
                        initializationSegmentTransformActive = false;
                        initializationSegmentTransformed = false;
                    }

                    notifyInitializationSegmentTransformState(
                        onInitializationSegmentTransformState,
                        initializationSegmentTransformed
                    );

                    callbacks.onSuccess(
                        response,
                        responseStats,
                        responseContext,
                        networkDetails
                    );
                }
            };

            this.loader.load(context, config, transformingCallbacks);
        }

        public abort(): void {
            this.loader.abort();
        }

        public destroy(): void {
            this.loader.destroy();
            this.context = null;
        }

        public getCacheAge(): number | null {
            return this.loader.getCacheAge?.() ?? null;
        }

        public getResponseHeader(name: string): string | null {
            return this.loader.getResponseHeader?.(name) ?? null;
        }
    };
}

function transformResponseData(
    transformer: FMP4SegmentTransformer,
    context: FragmentLoaderContext,
    responseData: ArrayBuffer
): FragmentTransformationResult {
    if (context.frag.type !== 'main') {
        return {
            initializationSegmentTransformed: null,
            mediaSegmentTransformed: null,
            responseData
        };
    }

    const sourcePayload = new Uint8Array(responseData);
    const isInitializationSegment = context.frag.sn === 'initSegment';

    try {
        const transformedPayload = isInitializationSegment ?
            transformer.transformInitializationSegment(sourcePayload) :
            transformer.transformMediaSegment(sourcePayload);

        return {
            initializationSegmentTransformed: isInitializationSegment ?
                transformedPayload !== sourcePayload : null,
            mediaSegmentTransformed: isInitializationSegment ? null :
                transformedPayload !== sourcePayload,
            responseData: getArrayBuffer(transformedPayload, responseData)
        };
    } catch (error) {
        console.warn('Client-side HDR tone mapping skipped an unsupported fragment', error);
        return {
            initializationSegmentTransformed: isInitializationSegment ? false : null,
            mediaSegmentTransformed: isInitializationSegment ? null : false,
            responseData
        };
    }
}

function isMainInitializationSegment(
    context: FragmentLoaderContext
): boolean {
    return context.frag.type === 'main'
        && context.frag.sn === 'initSegment';
}

function isMainMediaSegment(context: FragmentLoaderContext): boolean {
    return context.frag.type === 'main'
        && context.frag.sn !== 'initSegment';
}

function notifyInitializationSegmentTransformState(
    callback: InitializationSegmentTransformStateCallback | undefined,
    transformed: boolean | null
): void {
    if (!callback || transformed === null) {
        return;
    }

    try {
        callback(transformed);
    } catch (error) {
        console.warn(
            'Client-side HDR tone-mapping state callback failed',
            error
        );
    }
}

function getArrayBuffer(
    payload: Uint8Array,
    originalBuffer: ArrayBuffer
): ArrayBuffer {
    if (
        payload.buffer === originalBuffer
        && payload.byteOffset === 0
        && payload.byteLength === originalBuffer.byteLength
    ) {
        return originalBuffer;
    }

    const result = new Uint8Array(payload.byteLength);
    result.set(payload);
    return result.buffer;
}
