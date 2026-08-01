import { describe, expect, it } from 'vitest';

import { isKnownSDRPresentationInput } from './PresentationInput';

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
