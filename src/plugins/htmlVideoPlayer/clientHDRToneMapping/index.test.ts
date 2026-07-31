import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client';
import type {
    FragmentLoaderContext,
    HlsConfig,
    Loader,
    LoaderStats
} from 'hls.js';
import { describe, expect, it } from 'vitest';

import {
    createClientHDRToneMappingHlsConfig,
    resolveClientHDRToneMappingPreset
} from './index';

class ConfigurationTestLoader implements Loader<FragmentLoaderContext> {
    public context: FragmentLoaderContext | null = null;
    public readonly stats = {} as LoaderStats;

    public load(context: FragmentLoaderContext): void {
        this.context = context;
    }

    public abort(): void {
        // Nothing to abort in the configuration test loader
    }

    public destroy(): void {
        this.context = null;
    }
}

const HLS_CONSTRUCTOR = {
    DefaultConfig: {
        loader: ConfigurationTestLoader
    } as unknown as HlsConfig
};

describe('client HDR tone-mapping hls.js configuration', () => {
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

    it('falls back invalid browser-local values to balanced', () => {
        expect(resolveClientHDRToneMappingPreset('control')).toBe('control');
        expect(resolveClientHDRToneMappingPreset('bright')).toBe('bright');
        expect(resolveClientHDRToneMappingPreset('bt2390')).toBe('bt2390');
        expect(resolveClientHDRToneMappingPreset('invalid')).toBe('balanced');
        expect(resolveClientHDRToneMappingPreset(undefined)).toBe('balanced');
    });
});

function createMediaSource(videoRangeType: string): MediaSourceInfo {
    return {
        MediaStreams: [
            {
                Type: 'Video',
                VideoRangeType: videoRangeType
            }
        ]
    } as MediaSourceInfo;
}
