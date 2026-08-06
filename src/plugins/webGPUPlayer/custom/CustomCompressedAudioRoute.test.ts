import { describe, expect, it } from 'vitest';

import { isSupportedEAC3InputRoute } from './CustomCompressedAudioRoute';

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
});
