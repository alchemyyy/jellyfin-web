import { isSupportedCustomAudioSampleRate } from './CustomAudioSampleRate';

export type DTSProfileToken =
    | 'DTS'
    | 'DTS9624'
    | 'DTSES'
    | 'DTSHDHRA'
    | 'DTSHDMA'
    | 'DTSHDMADTSX';

export type DTSDirectPlayProfileToken = Exclude<DTSProfileToken, 'DTSES'>;

export type EAC3InputRoute = Readonly<{
    channelCount: 2 | 6 | 8
    metadataLayouts: readonly string[] | null
}>;

export type DTSInputRoute = Readonly<{
    channelCount: 6 | 7 | 8
    profileTokens: readonly DTSProfileToken[]
    sampleRate: 48_000 | 96_000 | 192_000
}>;

export type TrueHDCapabilityFixtureRoute = Readonly<{
    channelCount: 2 | 6
    codec: 'mlp' | 'truehd'
    sampleRate: 48_000 | 96_000 | 192_000
}>;

export const EAC3_SUPPORTED_INPUT_ROUTES = Object.freeze([
    Object.freeze({ channelCount: 2, metadataLayouts: null }),
    Object.freeze({ channelCount: 6, metadataLayouts: null }),
    Object.freeze({
        channelCount: 8,
        metadataLayouts: Object.freeze([ '7.1' ] as const)
    })
] as const) satisfies readonly EAC3InputRoute[];

export const DTS_PROFILE_VALUE_BY_TOKEN: Readonly<Record<DTSProfileToken, string>> =
    Object.freeze({
        DTS: 'DTS',
        DTS9624: 'DTS 96/24',
        DTSES: 'DTS-ES',
        DTSHDHRA: 'DTS-HD HRA',
        DTSHDMA: 'DTS-HD MA',
        DTSHDMADTSX: 'DTS-HD MA + DTS:X'
    });

/** DTS profiles retained for production direct play. */
export const DTS_DIRECT_PLAY_PROFILE_TOKENS: readonly DTSDirectPlayProfileToken[] =
    Object.freeze([
        'DTS',
        'DTS9624',
        'DTSHDHRA',
        'DTSHDMA',
        'DTSHDMADTSX'
    ]);

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
] as const) satisfies readonly DTSInputRoute[];

const DTS_COMPOSED_INPUT_ROUTES = Object.freeze([
    Object.freeze({
        channelCount: 6,
        profileTokens: Object.freeze([ 'DTSHDHRA' ] as const),
        sampleRate: 48_000
    })
] as const) satisfies readonly DTSInputRoute[];

/** Production routes backed by exact profile, channel-layout, and output evidence. */
export const DTS_SUPPORTED_INPUT_ROUTES = Object.freeze([
    ...DTS_CAPABILITY_FIXTURE_ROUTES,
    ...DTS_COMPOSED_INPUT_ROUTES
] as const) satisfies readonly DTSInputRoute[];

export const TRUEHD_CAPABILITY_FIXTURE_ROUTES = Object.freeze([
    Object.freeze({ channelCount: 2, codec: 'truehd', sampleRate: 48_000 }),
    Object.freeze({ channelCount: 6, codec: 'truehd', sampleRate: 96_000 }),
    Object.freeze({ channelCount: 6, codec: 'truehd', sampleRate: 192_000 }),
    Object.freeze({ channelCount: 2, codec: 'mlp', sampleRate: 48_000 })
] as const) satisfies readonly TrueHDCapabilityFixtureRoute[];

/** Returns whether a DTS profile is stable enough for production direct play. */
export function isDTSDirectPlayProfileToken(
    profileToken: string
): profileToken is DTSDirectPlayProfileToken {
    return DTS_DIRECT_PLAY_PROFILE_TOKENS.includes(
        profileToken as DTSDirectPlayProfileToken
    );
}

/** Accepts production-qualified DTS profile/layout pairs at any bounded source rate. */
export function isSupportedDTSInputRoute(
    channelCount: unknown,
    sampleRate: unknown,
    profileToken: string | null
): boolean {
    if (profileToken === null || !isSupportedCustomAudioSampleRate(sampleRate)) {
        return false;
    }
    // DTS-ES stays in the decoder fixture, but its reported 6.1 route failed geometry validation
    if (!isDTSDirectPlayProfileToken(profileToken)) {
        return false;
    }
    if (sampleRate > 96_000
        && (channelCount !== 6
            || (profileToken !== 'DTSHDMA' && profileToken !== 'DTSHDMADTSX'))) {
        return false;
    }
    for (const route of DTS_SUPPORTED_INPUT_ROUTES) {
        const routeProfileTokens: readonly DTSProfileToken[] = route.profileTokens;
        if (route.channelCount === channelCount
            && routeProfileTokens.includes(profileToken as DTSProfileToken)) {
            return true;
        }
    }
    return false;
}

/** Accepts only E-AC-3 routes whose eight-channel metadata identifies standard 7.1. */
export function isSupportedEAC3InputRoute(
    channelCount: unknown,
    sampleRate: unknown,
    channelLayout: unknown
): boolean {
    if (!isSupportedCustomAudioSampleRate(sampleRate)) {
        return false;
    }
    for (const route of EAC3_SUPPORTED_INPUT_ROUTES) {
        if (route.channelCount !== channelCount) {
            continue;
        }
        if (route.metadataLayouts === null) {
            return true;
        }
        if (typeof channelLayout !== 'string') {
            return false;
        }
        const normalizedLayout = channelLayout.trim().toLowerCase();
        const metadataLayouts: readonly string[] = route.metadataLayouts;
        return metadataLayouts.includes(normalizedLayout);
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
