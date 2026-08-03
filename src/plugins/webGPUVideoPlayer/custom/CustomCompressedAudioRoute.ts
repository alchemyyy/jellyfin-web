import { isSupportedCustomAudioSampleRate } from './CustomAudioSampleRate';

export type DTSProfileToken =
    | 'DTS'
    | 'DTS9624'
    | 'DTSES'
    | 'DTSHDHRA'
    | 'DTSHDMA'
    | 'DTSHDMADTSX';

export type DTSCapabilityFixtureRoute = Readonly<{
    channelCount: 6 | 7 | 8
    profileTokens: readonly DTSProfileToken[]
    sampleRate: 48_000 | 96_000 | 192_000
}>;

export type TrueHDCapabilityFixtureRoute = Readonly<{
    channelCount: 2 | 6
    codec: 'mlp' | 'truehd'
    sampleRate: 48_000 | 96_000 | 192_000
}>;

export const DTS_PROFILE_VALUE_BY_TOKEN: Readonly<Record<DTSProfileToken, string>> =
    Object.freeze({
        DTS: 'DTS',
        DTS9624: 'DTS 96/24',
        DTSES: 'DTS-ES',
        DTSHDHRA: 'DTS-HD HRA',
        DTSHDMA: 'DTS-HD MA',
        DTSHDMADTSX: 'DTS-HD MA + DTS:X'
    });

export const DTS_CAPABILITY_FIXTURE_ROUTES = Object.freeze([
    Object.freeze({
        channelCount: 6,
        profileTokens: Object.freeze([ 'DTS' ] as const),
        sampleRate: 48_000
    }),
    Object.freeze({
        channelCount: 6,
        profileTokens: Object.freeze([ 'DTS9624' ] as const),
        sampleRate: 96_000
    }),
    Object.freeze({
        channelCount: 7,
        profileTokens: Object.freeze([ 'DTSES' ] as const),
        sampleRate: 48_000
    }),
    Object.freeze({
        channelCount: 8,
        profileTokens: Object.freeze([ 'DTSHDHRA' ] as const),
        sampleRate: 48_000
    }),
    Object.freeze({
        channelCount: 8,
        profileTokens: Object.freeze([ 'DTSHDMA', 'DTSHDMADTSX' ] as const),
        sampleRate: 48_000
    }),
    Object.freeze({
        channelCount: 8,
        profileTokens: Object.freeze([ 'DTSHDMA', 'DTSHDMADTSX' ] as const),
        sampleRate: 96_000
    }),
    Object.freeze({
        channelCount: 6,
        profileTokens: Object.freeze([ 'DTSHDMA', 'DTSHDMADTSX' ] as const),
        sampleRate: 192_000
    })
] as const) satisfies readonly DTSCapabilityFixtureRoute[];

export const TRUEHD_CAPABILITY_FIXTURE_ROUTES = Object.freeze([
    Object.freeze({ channelCount: 2, codec: 'truehd', sampleRate: 48_000 }),
    Object.freeze({ channelCount: 6, codec: 'truehd', sampleRate: 96_000 }),
    Object.freeze({ channelCount: 6, codec: 'truehd', sampleRate: 192_000 }),
    Object.freeze({ channelCount: 2, codec: 'mlp', sampleRate: 48_000 })
] as const) satisfies readonly TrueHDCapabilityFixtureRoute[];

/** Accepts measured DTS profile/layout pairs at any bounded source sample rate. */
export function isSupportedDTSInputRoute(
    channelCount: unknown,
    sampleRate: unknown,
    profileToken: string | null
): boolean {
    if (profileToken === null || !isSupportedCustomAudioSampleRate(sampleRate)) {
        return false;
    }
    if (sampleRate > 96_000
        && (channelCount !== 6
            || (profileToken !== 'DTSHDMA' && profileToken !== 'DTSHDMADTSX'))) {
        return false;
    }
    for (const route of DTS_CAPABILITY_FIXTURE_ROUTES) {
        const routeProfileTokens: readonly DTSProfileToken[] = route.profileTokens;
        if (route.channelCount === channelCount
            && routeProfileTokens.includes(profileToken as DTSProfileToken)) {
            return true;
        }
    }
    return false;
}

/** Accepts measured TrueHD/MLP codec/layout pairs at any bounded source rate. */
export function isSupportedTrueHDInputRoute(
    codec: string,
    channelCount: unknown,
    sampleRate: unknown
): boolean {
    if (!isSupportedCustomAudioSampleRate(sampleRate)) {
        return false;
    }
    for (const route of TRUEHD_CAPABILITY_FIXTURE_ROUTES) {
        if (route.codec === codec
            && route.channelCount === channelCount) {
            return true;
        }
    }
    return false;
}
