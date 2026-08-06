import { describe, expect, it } from 'vitest';

import {
    isSupportedEAC3InputRoute,
    isSupportedTrueHDInputRoute,
    isSupportedTrueHDMetadataRoute
} from './CustomCompressedAudioRoute';

describe('CustomCompressedAudioRoute', () => {
    it.each([
        [ 2, 48_000, undefined ],
        [ 6, 44_100, undefined ],
        [ 8, 48_000, '7.1' ],
        [ 8, 48_000, ' 7.1 ' ]
    ] as const)(
        'accepts qualified %i-channel E-AC-3 route',
        (channelCount, sampleRate, channelLayout) => {
            expect(isSupportedEAC3InputRoute(
                channelCount,
                sampleRate,
                channelLayout
            )).toBe(true);
        }
    );

    it.each([
        [ 8, 48_000, undefined ],
        [ 8, 48_000, '7.1(wide)' ],
        [ 8, 48_000, '7.1(wide-side)' ],
        [ 8, 48_000, '5.1' ],
        [ 7, 48_000, '7.1' ],
        [ 8, 192_001, '7.1' ]
    ] as const)(
        'rejects unqualified %i-channel E-AC-3 route',
        (channelCount, sampleRate, channelLayout) => {
            expect(isSupportedEAC3InputRoute(
                channelCount,
                sampleRate,
                channelLayout
            )).toBe(false);
        }
    );

    it('accepts only the composed 48 kHz standard 7.1 TrueHD route', () => {
        expect(isSupportedTrueHDInputRoute('truehd', 8, 48_000)).toBe(true);
        expect(isSupportedTrueHDMetadataRoute(
            'truehd',
            8,
            48_000,
            '7.1'
        )).toBe(true);
        expect(isSupportedTrueHDMetadataRoute(
            'truehd',
            8,
            48_000,
            ' 7.1 '
        )).toBe(true);

        expect(isSupportedTrueHDInputRoute('truehd', 8, 96_000)).toBe(false);
        expect(isSupportedTrueHDMetadataRoute(
            'truehd',
            8,
            48_000,
            undefined
        )).toBe(false);
        expect(isSupportedTrueHDMetadataRoute(
            'truehd',
            8,
            48_000,
            '7.1(wide)'
        )).toBe(false);
        expect(isSupportedTrueHDMetadataRoute('mlp', 8, 48_000, '7.1')).toBe(false);
    });
});
