import type { MediaSourceInfo } from '@jellyfin/sdk/lib/generated-client';
import { describe, expect, it } from 'vitest';

import {
    hasClientHDRToneMappingVideoStream,
    isClientHDRToneMappingMediaSource,
    isClientHDRToneMappingRuntimeSupported,
    isClientHDRToneMappingVideoRangeType
} from './compatibility';

describe('client HDR tone-mapping compatibility', () => {
    it.each([
        'HDR10',
        'HDR10Plus',
        'DOVIWithHDR10',
        'DOVIWithHDR10Plus',
        'DOVIWithEL',
        'DOVIWithELHDR10Plus'
    ])('supports the %s video range', videoRangeType => {
        expect(isClientHDRToneMappingVideoRangeType(videoRangeType)).toBe(true);
    });

    it.each([
        undefined,
        null,
        'Unknown',
        'SDR',
        'HLG',
        'DOVI',
        'DOVIWithSDR',
        'DOVIWithHLG'
    ])('rejects the %s video range', videoRangeType => {
        expect(isClientHDRToneMappingVideoRangeType(videoRangeType)).toBe(false);
    });

    it('finds a supported video stream without accepting audio metadata', () => {
        const supportedMediaSource: MediaSourceInfo = {
            MediaStreams: [
                {
                    Type: 'Audio',
                    VideoRangeType: 'HDR10'
                },
                {
                    Type: 'Video',
                    VideoRangeType: 'HDR10Plus'
                }
            ]
        };
        const audioOnlyMediaSource: MediaSourceInfo = {
            MediaStreams: [
                {
                    Type: 'Audio',
                    VideoRangeType: 'HDR10'
                }
            ]
        };

        expect(isClientHDRToneMappingMediaSource(supportedMediaSource)).toBe(true);
        expect(hasClientHDRToneMappingVideoStream(supportedMediaSource.MediaStreams))
            .toBe(true);
        expect(isClientHDRToneMappingMediaSource(audioOnlyMediaSource)).toBe(false);
        expect(isClientHDRToneMappingMediaSource(undefined)).toBe(false);
    });

    it('rejects live HDR media sources', () => {
        const liveMediaSource: MediaSourceInfo = {
            IsInfiniteStream: true,
            MediaStreams: [
                {
                    Type: 'Video',
                    VideoRangeType: 'HDR10'
                }
            ]
        };

        expect(isClientHDRToneMappingMediaSource(liveMediaSource)).toBe(false);
    });

    it('requires Chrome 151+ on Windows desktop with an SDR output', () => {
        const supportedRuntime = {
            chromeVersion: 151,
            dynamicRangeHigh: false,
            isChrome: true,
            isDesktop: true,
            isEdgeChromium: false,
            isWindows: true
        };

        expect(isClientHDRToneMappingRuntimeSupported(supportedRuntime)).toBe(true);
        expect(isClientHDRToneMappingRuntimeSupported({
            ...supportedRuntime,
            chromeVersion: 150
        })).toBe(false);
        expect(isClientHDRToneMappingRuntimeSupported({
            ...supportedRuntime,
            dynamicRangeHigh: true
        })).toBe(false);
        expect(isClientHDRToneMappingRuntimeSupported({
            ...supportedRuntime,
            isDesktop: false
        })).toBe(false);
        expect(isClientHDRToneMappingRuntimeSupported({
            ...supportedRuntime,
            isEdgeChromium: true
        })).toBe(false);
    });
});
