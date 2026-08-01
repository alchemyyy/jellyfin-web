import type {
    MediaSourceInfo,
    MediaStream
} from '@jellyfin/sdk/lib/generated-client';
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
    createClientHDRToneMappingHlsConfig,
    resolveClientHDRToneMappingPreset
} from './index';

class ConfigurationTestLoader implements Loader<FragmentLoaderContext> {
    public static readonly instances: ConfigurationTestLoader[] = [];

    public context: FragmentLoaderContext | null = null;
    public readonly stats = {} as LoaderStats;
    private callbacks: LoaderCallbacks<FragmentLoaderContext> | null = null;

    public constructor() {
        ConfigurationTestLoader.instances.push(this);
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
        // Nothing to abort in the configuration test loader
    }

    public destroy(): void {
        this.context = null;
        this.callbacks = null;
    }

    public succeed(response: LoaderResponse): void {
        if (this.context === null || this.callbacks === null) {
            throw new Error('Configuration test loader has not started');
        }

        this.callbacks.onSuccess(
            response,
            this.stats,
            this.context,
            null
        );
    }
}

const HLS_CONSTRUCTOR = {
    DefaultConfig: {
        loader: ConfigurationTestLoader
    } as unknown as HlsConfig
};

describe('client HDR tone-mapping hls.js configuration', () => {
    beforeEach(() => {
        ConfigurationTestLoader.instances.length = 0;
    });

    it('returns no overrides when disabled or the source is unsupported', () => {
        expect(createClientHDRToneMappingHlsConfig(
            HLS_CONSTRUCTOR,
            createMediaSource('HDR10'),
            false,
            'balanced'
        )).toEqual({});

        expect(createClientHDRToneMappingHlsConfig(
            HLS_CONSTRUCTOR,
            createMediaSource('SDR'),
            true,
            'balanced'
        )).toEqual({});
    });

    it('installs a non-progressive custom fragment loader for HDR10', () => {
        const config = createClientHDRToneMappingHlsConfig(
            HLS_CONSTRUCTOR,
            createMediaSource('HDR10'),
            true,
            'mild'
        );

        expect(config.progressive).toBe(false);
        expect(config.fLoader).toBeTypeOf('function');
    });

    it('forwards initialization transform state from the configured loader', () => {
        const onInitializationSegmentTransformState = vi.fn();
        const config = createClientHDRToneMappingHlsConfig(
            HLS_CONSTRUCTOR,
            createMediaSource('HDR10'),
            true,
            'bt2390',
            undefined,
            onInitializationSegmentTransformState
        );
        const FragmentLoader = config.fLoader;
        if (!FragmentLoader) {
            throw new Error('Expected a client HDR fragment loader');
        }

        const loader = new FragmentLoader(HLS_CONSTRUCTOR.DefaultConfig);
        const fragmentContext = {
            url: 'https://example.test/init.mp4',
            responseType: 'arraybuffer',
            frag: {
                sn: 'initSegment',
                type: 'main'
            },
            part: null
        } as unknown as FragmentLoaderContext;
        const onSuccess = vi.fn();
        loader.load(
            fragmentContext,
            {} as LoaderConfiguration,
            {
                onSuccess,
                onError: vi.fn(),
                onTimeout: vi.fn()
            }
        );
        ConfigurationTestLoader.instances[0].succeed({
            url: fragmentContext.url,
            data: Uint8Array.from([ 0x01 ]).buffer,
            code: 200,
            text: 'OK'
        });

        expect(onInitializationSegmentTransformState.mock.calls)
            .toEqual([[ false ]]);
        expect(onSuccess).toHaveBeenCalledTimes(1);
    });

    it('returns no overrides when the selected subtitle is encoded', () => {
        const config = createClientHDRToneMappingHlsConfig(
            HLS_CONSTRUCTOR,
            createMediaSource('HDR10', 13, [
                {
                    Type: 'Subtitle',
                    Index: 13,
                    DeliveryMethod: 'Encode'
                }
            ]),
            true,
            'bt2390'
        );

        expect(config).toEqual({});
    });

    it('installs the loader when the selected subtitle is external', () => {
        const config = createClientHDRToneMappingHlsConfig(
            HLS_CONSTRUCTOR,
            createMediaSource('HDR10', 13, [
                {
                    Type: 'Subtitle',
                    Index: 13,
                    DeliveryMethod: 'External'
                }
            ]),
            true,
            'bt2390'
        );

        expect(config.progressive).toBe(false);
        expect(config.fLoader).toBeTypeOf('function');
    });

    it('installs the loader when only an unselected subtitle is encoded', () => {
        const config = createClientHDRToneMappingHlsConfig(
            HLS_CONSTRUCTOR,
            createMediaSource('HDR10', 14, [
                {
                    Type: 'Subtitle',
                    Index: 13,
                    DeliveryMethod: 'Encode'
                },
                {
                    Type: 'Subtitle',
                    Index: 14,
                    DeliveryMethod: 'External'
                }
            ]),
            true,
            'bt2390'
        );

        expect(config.progressive).toBe(false);
        expect(config.fLoader).toBeTypeOf('function');
    });

    it.each([null, -1])(
        'installs the loader when the selected subtitle index is %s',
        (defaultSubtitleStreamIndex) => {
            const config = createClientHDRToneMappingHlsConfig(
                HLS_CONSTRUCTOR,
                createMediaSource('HDR10', defaultSubtitleStreamIndex, [
                    {
                        Type: 'Subtitle',
                        Index: 13,
                        DeliveryMethod: 'Encode'
                    }
                ]),
                true,
                'bt2390'
            );

            expect(config.progressive).toBe(false);
            expect(config.fLoader).toBeTypeOf('function');
        }
    );

    it('installs the loader for an adjustable BT.2390 preset', () => {
        const config = createClientHDRToneMappingHlsConfig(
            HLS_CONSTRUCTOR,
            createMediaSource('HDR10'),
            true,
            'bt2390',
            {
                kneeOffset: 0.5,
                sourcePeakNits: 4000,
                targetPeakNits: 203
            }
        );

        expect(config.progressive).toBe(false);
        expect(config.fLoader).toBeTypeOf('function');
    });

    it('falls back invalid browser-local values to BT.2390', () => {
        expect(resolveClientHDRToneMappingPreset('control')).toBe('control');
        expect(resolveClientHDRToneMappingPreset('bright')).toBe('bright');
        expect(resolveClientHDRToneMappingPreset('bt2390')).toBe('bt2390');
        expect(resolveClientHDRToneMappingPreset('invalid')).toBe('bt2390');
        expect(resolveClientHDRToneMappingPreset(undefined)).toBe('bt2390');
    });
});

function createMediaSource(
    videoRangeType: string,
    defaultSubtitleStreamIndex?: number | null,
    subtitleStreams: MediaStream[] = []
): MediaSourceInfo {
    return {
        DefaultSubtitleStreamIndex: defaultSubtitleStreamIndex,
        MediaStreams: [
            {
                Type: 'Video',
                VideoRangeType: videoRangeType
            },
            ...subtitleStreams
        ]
    } as MediaSourceInfo;
}
