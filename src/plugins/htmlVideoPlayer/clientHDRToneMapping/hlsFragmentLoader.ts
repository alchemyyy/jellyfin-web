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

type DefaultLoaderConstructor = HlsConfig['loader'];
type FragmentLoaderConstructor = NonNullable<HlsConfig['fLoader']>;

/**
 * Creates an hls.js fragment loader whose transformer state is shared across
 * every loader instance created by one Hls player.
 */
export function createClientHDRToneMappingFragmentLoader(
    hlsConstructor: HlsConstructorWithDefaultConfig,
    agtmPayload: Uint8Array
): FragmentLoaderConstructor {
    const transformer = new FMP4AGTMTransformer(agtmPayload);

    return createTransformingFragmentLoader(
        hlsConstructor.DefaultConfig.loader,
        transformer
    );
}

/**
 * Wraps an hls.js loader and transforms successful fragment responses.
 * Exported separately to keep loader behavior independently testable.
 */
export function createTransformingFragmentLoader(
    DefaultLoader: DefaultLoaderConstructor,
    transformer: FMP4SegmentTransformer
): FragmentLoaderConstructor {
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

                    if (responseData instanceof ArrayBuffer) {
                        const transformedData = transformResponseData(
                            transformer,
                            responseContext,
                            responseData
                        );

                        if (transformedData !== responseData) {
                            response.data = transformedData;
                        }
                    }

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
): ArrayBuffer {
    if (context.frag.type !== 'main') {
        return responseData;
    }

    const sourcePayload = new Uint8Array(responseData);

    try {
        const transformedPayload = context.frag.sn === 'initSegment' ?
            transformer.transformInitializationSegment(sourcePayload) :
            transformer.transformMediaSegment(sourcePayload);

        return getArrayBuffer(transformedPayload, responseData);
    } catch (error) {
        console.warn('Client-side HDR tone mapping skipped an unsupported fragment', error);
        return responseData;
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
