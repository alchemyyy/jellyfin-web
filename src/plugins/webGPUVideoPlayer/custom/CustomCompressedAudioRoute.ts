export type DTSProfileToken =
    | 'DTS'
    | 'DTS9624'
    | 'DTSES'
    | 'DTSHDHRA'
    | 'DTSHDMA'
    | 'DTSHDMADTSX';

export type DTSExactInputRoute = Readonly<{
    channelCount: 6 | 7 | 8
    profileTokens: readonly DTSProfileToken[]
    sampleRate: 48_000 | 96_000 | 192_000
}>;

export type TrueHDExactInputRoute = Readonly<{
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

export const DTS_EXACT_INPUT_ROUTES = Object.freeze([
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
] as const) satisfies readonly DTSExactInputRoute[];

export const TRUEHD_EXACT_INPUT_ROUTES = Object.freeze([
    Object.freeze({ channelCount: 2, codec: 'truehd', sampleRate: 48_000 }),
    Object.freeze({ channelCount: 6, codec: 'truehd', sampleRate: 96_000 }),
    Object.freeze({ channelCount: 6, codec: 'truehd', sampleRate: 192_000 }),
    Object.freeze({ channelCount: 2, codec: 'mlp', sampleRate: 48_000 })
] as const) satisfies readonly TrueHDExactInputRoute[];

/** Accepts only DTS profile, layout, and rate tuples covered by exact fixtures. */
export function isQualifiedDTSInputRoute(
    channelCount: unknown,
    sampleRate: unknown,
    profileToken: string | null
): boolean {
    if (profileToken === null) {
        return false;
    }
    for (const route of DTS_EXACT_INPUT_ROUTES) {
        const routeProfileTokens: readonly DTSProfileToken[] = route.profileTokens;
        if (route.channelCount === channelCount
            && route.sampleRate === sampleRate
            && routeProfileTokens.includes(profileToken as DTSProfileToken)) {
            return true;
        }
    }
    return false;
}

/** Accepts only TrueHD/MLP codec, layout, and rate tuples covered by exact fixtures. */
export function isQualifiedTrueHDInputRoute(
    codec: string,
    channelCount: unknown,
    sampleRate: unknown
): boolean {
    for (const route of TRUEHD_EXACT_INPUT_ROUTES) {
        if (route.codec === codec
            && route.channelCount === channelCount
            && route.sampleRate === sampleRate) {
            return true;
        }
    }
    return false;
}
