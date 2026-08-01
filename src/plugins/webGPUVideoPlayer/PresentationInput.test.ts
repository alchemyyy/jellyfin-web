import { describe, expect, it } from 'vitest';

import {
    getPresentationInputColorMetadata,
    isKnownSDRPresentationInput,
    parseVideoStreamColorMetadata
} from './PresentationInput';

describe('isKnownSDRPresentationInput', () => {
    it('accepts explicitly identified SDR video input', () => {
        expect(isKnownSDRPresentationInput({
            mediaSource: {
                MediaStreams: [
                    { Type: 'Audio' },
                    { Type: 'Video', VideoRangeType: 'SDR' }
                ]
            }
        })).toBe(true);
    });

    it('accepts the legacy SDR video range field', () => {
        expect(isKnownSDRPresentationInput({
            mediaSource: {
                MediaStreams: [
                    { Type: 'video', VideoRange: 'sdr' }
                ]
            }
        })).toBe(true);
    });

    it('accepts multiple video streams only when every stream is known SDR', () => {
        expect(isKnownSDRPresentationInput({
            mediaSource: {
                MediaStreams: [
                    { Type: 'Video', VideoRangeType: 'SDR' },
                    { Type: 'Video', VideoRange: 'SDR' }
                ]
            }
        })).toBe(true);
    });

    it.each([
        undefined,
        {},
        { mediaSource: {} },
        { mediaSource: { MediaStreams: [] } },
        { mediaSource: { MediaStreams: [{ Type: 'Video' }] } }
    ])('rejects input without positive SDR metadata', options => {
        expect(isKnownSDRPresentationInput(options)).toBe(false);
    });

    it.each([
        { VideoRangeType: 'HDR10' },
        { VideoRangeType: 'DOVIWithSDR' },
        { VideoRange: 'HLG' },
        { VideoRangeType: 'HDR10', VideoRange: 'SDR' },
        { VideoRangeType: 'SDR', ColorTransfer: 'SMPTE2084' },
        { VideoRange: 'SDR', ColorTransfer: 'ARIB-STD-B67' },
        { VideoRangeType: 'SDR', Hdr10PlusPresentFlag: true },
        { VideoRangeType: 'SDR', Hdr10PlusPresentFlag: 1 },
        { VideoRangeType: 'SDR', DvProfile: 8 },
        { VideoRangeType: 'SDR', RpuPresentFlag: '1' }
    ])('rejects non-SDR or contradictory video metadata: %o', videoMetadata => {
        expect(isKnownSDRPresentationInput({
            mediaSource: {
                MediaStreams: [{ Type: 'Video', ...videoMetadata }]
            }
        })).toBe(false);
    });

    it.each([
        [
            { Type: 'Video', VideoRangeType: 'SDR' },
            { Type: 'Video', VideoRangeType: 'HDR10' }
        ],
        [
            { Type: 'Video', VideoRangeType: 'HDR10' },
            { Type: 'Video', VideoRangeType: 'SDR' }
        ]
    ])('rejects ambiguous mixed-range video streams: %o', MediaStreams => {
        expect(isKnownSDRPresentationInput({ mediaSource: { MediaStreams } })).toBe(false);
    });
});

describe('parseVideoStreamColorMetadata', () => {
    it('creates default BT.709 metadata for an explicit SDR stream', () => {
        expect(parseVideoStreamColorMetadata({
            Type: 'Video',
            VideoRangeType: 'SDR'
        })).toMatchObject({
            bitDepth: 8,
            matrix: 'bt709',
            nominalPeakNits: 100,
            primaries: 'bt709',
            range: 'limited',
            transfer: 'sdr'
        });
    });

    it('maps Jellyfin HDR10 metadata into an explicit PQ input description', () => {
        expect(parseVideoStreamColorMetadata({
            BitDepth: 12,
            ColorPrimaries: 'bt2020',
            ColorRange: 'tv',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            Type: 'Video',
            VideoRange: 'HDR',
            VideoRangeType: 'HDR10'
        })).toEqual({
            bitDepth: 12,
            matrix: 'bt2020-ncl',
            nominalPeakNits: 1_000,
            primaries: 'bt2020',
            range: 'limited',
            sdrReferenceWhiteNits: 100,
            transfer: 'pq',
            version: 1
        });
    });

    it('maps HLG aliases and full range without inventing floating timestamps', () => {
        expect(parseVideoStreamColorMetadata({
            ColorRange: 'pc',
            ColorTransfer: 'ARIB-STD-B67',
            Type: 'Video',
            VideoRangeType: 'HLG'
        })).toMatchObject({
            bitDepth: 10,
            matrix: 'bt2020-ncl',
            primaries: 'bt2020',
            range: 'full',
            transfer: 'hlg'
        });
    });

    it.each([
        { Type: 'Video' },
        { Type: 'Video', VideoRange: 'HDR' },
        { Type: 'Video', VideoRangeType: 'Unknown' },
        { Type: 'Video', VideoRangeType: 'DOVIWithHDR10' },
        { DvProfile: 8, Type: 'Video', VideoRangeType: 'HDR10' },
        { RpuPresentFlag: 1, Type: 'Video', VideoRangeType: 'HDR10' },
        { Type: 'Video', VideoRange: 'SDR', VideoRangeType: 'HDR10' },
        { ColorTransfer: 'smpte2084', Type: 'Video', VideoRangeType: 'HLG' },
        { BitDepth: 8, Type: 'Video', VideoRangeType: 'HDR10' },
        { ColorSpace: 'smpte170m', Type: 'Video', VideoRangeType: 'SDR' },
        { ColorPrimaries: 'display-p3', Type: 'Video', VideoRangeType: 'SDR' },
        { ColorRange: 'unknown', Type: 'Video', VideoRangeType: 'SDR' },
        { Hdr10PlusPresentFlag: true, Type: 'Video', VideoRangeType: 'SDR' }
    ])('rejects unknown, Dolby Vision, or contradictory metadata: %o', stream => {
        expect(parseVideoStreamColorMetadata(stream)).toBeNull();
    });

    it('accepts HDR10+ as a PQ base layer', () => {
        expect(parseVideoStreamColorMetadata({
            Hdr10PlusPresentFlag: true,
            Type: 'Video',
            VideoRangeType: 'HDR10Plus'
        })?.transfer).toBe('pq');
    });
});

describe('getPresentationInputColorMetadata', () => {
    it('extracts the only video stream while ignoring audio streams', () => {
        expect(getPresentationInputColorMetadata({
            mediaSource: {
                MediaStreams: [
                    { Type: 'Audio' },
                    { Type: 'Video', VideoRangeType: 'SDR' }
                ]
            }
        })?.transfer).toBe('sdr');
    });

    it('rejects missing and ambiguous multiple video streams', () => {
        expect(getPresentationInputColorMetadata({ mediaSource: { MediaStreams: [] } }))
            .toBeNull();
        expect(getPresentationInputColorMetadata({
            mediaSource: {
                MediaStreams: [
                    { Type: 'Video', VideoRangeType: 'SDR' },
                    { Type: 'Video', VideoRangeType: 'HDR10' }
                ]
            }
        })).toBeNull();
    });
});
