export const NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_VERSION = 1;
export const NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT = 6;
export const NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE = 48_000;

export const NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CODECS = [
    'aac',
    'opus',
    'flac',
    'vorbis'
] as const;

export type NativeSurroundAudioCapabilityFixtureCodec =
    typeof NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CODECS[number];

export type NativeSurroundAudioCapabilityFixtureChunk = Readonly<{
    data: Uint8Array
    duration: number
    timestamp: number
}>;

export type NativeSurroundAudioCapabilityFixture = Readonly<{
    codec: NativeSurroundAudioCapabilityFixtureCodec
    codecString: string
    description: Uint8Array
    encodedChunks: readonly NativeSurroundAudioCapabilityFixtureChunk[]
    expectedOutputFrameCount: number
    expectedOutputTimestamp: number
    numberOfChannels: typeof NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT
    sampleRate: typeof NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE
}>;

// Generated with FFmpeg git-862338fe31 from 48 kHz 5.1 digital silence.
// Container metadata and packets were extracted through Mediabunny 1.52.2.
// Chromium 151 decoded each fixture into one exact six-channel AudioData.
const AAC_DESCRIPTION_BASE64 = 'EbBW5QA=';

const AAC_PACKET_BASE64 = '3gIATGF2YzYyLjI0LjEwMAACMEACEQBGCMBGIAjBGBhGAAHA';

const OPUS_DESCRIPTION_BASE64 = 'T3B1c0hlYWQBBjgBgLsAAAAAAQQCAAQBAgMF';

const OPUS_PACKET_BASE64 = [
    '/MT//gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/MT//gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAA+Hr//gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPj//gAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=='
].join('');

const FLAC_DESCRIPTION_BASE64 = 'ZkxhQ4AAACISABIAAAAaAAAaC7gK8AAAFoC0X0BbzHapOAdHES1hleSD';

const FLAC_PACKET_BASE64 = '//haWACNAAAAAAAAAAAAAAAAAAAAAAAABAc=';

const VORBIS_DESCRIPTION_BASE64 = [
    'Ah5AAXZvcmJpcwAAAAAGgLsAAAAAAADA1AEAAAAAALgBA3ZvcmJpcw0AAABMYXZmNjIuMTAuMTAxAQAAAB8AAABlbmNvZGVyPUxh',
    'dmM2Mi4yNC4xMDAgbGlidm9yYmlzAQV2b3JiaXMlQkNWAQAAAQAYY1QpRplS0kqJGXOUMUaZYpJKiaWEFkJInXMUU6k515xrrLm1',
    'IIQQGlNQKQWZUo5SaRljkCkFmVIQS0kldBI6J51jEFtJwdaYa4tBthyEDZpSTCnElFKKQggZU4wpxZRSSkIHJXQOOuYcU45KKEG4',
    'nHOrtZaWY4updJJK5yRkTEJIKYWSSgelU05CSDWW1lIpHXNSUmpB6CCEEEK2IIQNgtCQVQAAAQDAQBAasgoAUAAAEIqhGIoChIas',
    'AgAyAAAEoCiO4iiOIzmSY0kWEBqyCgAAAgAQAADAcBRJkRTJsSRL0ixL00RRVX3VNlVV9nVd13Vd13UgNGQVAAABAEBIp5mlGiDC',
    'DGQYCA1ZBQAgAAAARijCEANCQ1YBAAABAABiKDmIJrTmfHOOg2Y5aCrF5nRwItXmSW4q5uacc845J5tzxjjnnHOKcmYxaCa05pxz',
    'EoNmKWgmtOacc57E5kFrqrTmnHPGOaeDcUYY55xzmrTmQWo21uaccxa0pjlqLsXmnHMi5eZJbS7V5pxzzjnnnHPOOeecc6oXp3Nw',
    'TjjnnHOi9uZabkIX55xzPhmne3NCOOecc84555xzzjnnnHOC0JBVAAAQAABBGDaGcacgSJ+jgRhFiGnIpAfdo8MkaAxyCqlHo6OR',
    'UuoglFTGSSmdIDRkFQAACAAAIYQUUkghhRRSSCGFFFKIIYYYYsgpp5yCCiqppKKKMsoss8wyyyyzzDLrsLPOOuwwxBBDDK20EktN',
    'tdVYY62555xrDtJaaa211koppZRSSikIDVkFAIAAABAIGWSQQUYhhRRSiCGmnHLKKaigAkJDVgEAgAAAAgAAADzJc0RHdERHdERH',
    'dERHdETHczxHlERJlERJtEzL1ExPFVXVlV1b1mXd9m1hF3bd93Xf93Xj14VhWZZlWZZlWZZlWZZlWZZlWYLQkFUAAAgAAIAQQggh',
    'hRRSSCGlGGPMMeegk1BCIDRkFQAACAAgAAAAwFEcxXEkR3IkyZIsSZM0S7M8zdM8TfREURRN01RFV3RF3bRF2ZRN13RN2XRVWbVd',
    'WbZt2dZtX5Zt3/d93/d93/d93/d93/d1HQgNWQUASAAA6EiOpEiKpEiO4ziSJAGhIasAABkAAAEAKIqjOI7jSJIkSZakSZ7lWaJm',
    'aqZneqqoAqEhqwAAQAAAAQAAAAAAKJriKabiKaLiOaIjSqJlWqKmaq4om7Lruq7ruq7ruq7ruq7ruq7ruq7ruq7ruq7ruq7ruq7r',
    'uq7rui4QGrIKAJAAANCRHMmRHEmRFEmRHMkBQkNWAQAyAAACAHAMx5AUybEsS9M8zdM8TfRET/RMTxVd0QVCQ1YBAIAAAAIAAAAA',
    'ADAkw1IsR3M0SZRUS7VUTbVUSxVVT1VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVTVN0zRNIDRkJQAQAwCAEOYk9kQg',
    'BrFXxiipOUOISayhgxBSbKmFzFFtpUJMAqEhqwKAeQAAg2EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAIcAAACLAQ',
    'Cg1ZFQDMAwAYJImm8TyiyHV5HlHkujyPZVFVrst16TpV5bp0neuSJJLEsmgaVWVZNI2psiyaRlW5LlWl60yT69J1rsuyuC7X5bp0',
    'napyXbrOdQEAAMDzuC7X5bp0netSXbpPVVkW1eW6XJevc12yS7e5LgAAAAQAAA44AAAOWAiFhqwKAOYBAAyKQhSJItMkikyTaRJF',
    'pknTaBrL4nk0jefxRJ7H82gaUeR5TJMoMk2mSRSZJlGkqlSV61JVrkuWuS7Z5Xlcl+uSZa5LlskyWSbLNA0AAIAoUlWuS5a5Llkm',
    'y1yX6/I8rst1yTJZJttsmSyTZZoGAAAgAAAgwAEAIMBCKDRkVQAwDwBgsCzN8zTP00TRdFXR8zRRVF1XFEVL00xVNVXVVFVZtl3X',
    'VVXVtm3XdS1JEi1JtCxR01zTVC3L1DTZNF1N0zzPNU3XNFXT1GVZFkVXVX1Z1lXV0zTXdV1VdVXVtm3bdV3X9XXddl2myXW5LlVl',
    '21SV69J1qup5nqyqsmnKqqrLsq2qrmn6tm2bpqhpsqrKquqqqm/btuvKrqvbti67VJXrcl2uS9e5Ltll61xXAABQgQMAUIGFUGjI',
    'qgCghgGAMMY5aS2lkFKLqbWUUmutldhiTK3FmFqLMbUYY4oxxhJji6m1WlNsraXWYkwxtpZijDG1FmOKsbXUWowpxtZSjDGm1mpN',
    'MbaWWosxxdhaKqWUVkpKqXOUYimltFJKiSmlFEtJKabUWkwppZhSazGl1mIpKcWUUoqppBRTSimmlFIsJaWYUkqtpJRiSinFlFKK',
    'paQUU0opppRSTCmlVEoprZQQWmspxdZCiK2V0lprLcZYa2wtpRhja7G1lGKLKcUYa42tlRJjTCm2VkqMMaUYY62xtVJijCnFFkuJ',
    'MaYUY6w1tlZKjDGlGFsptbXOaWsh1JRCqK11TlPKmMZYSm6tlBxjKbm1EHKMpeQYS8mtlZJjLKW2FkKNMYQaYwi5tRByjCHU1kKo',
    'MYZQYwwhtxZCjTGE2loINcYQYmudwxg7pzGGEGPMmMbYOa21lFprSrXWEGqtpdRaQ6i1lpBrTanWGkKttZRaawi11hByrSnVWjun',
    'tYZQa+2c1hpCrjWlWmvntNYQaq2ds9Zi7Dmn1HNvLfieUtC5pd57iz3nGHvvrfWeY+y9t9Z7jzH4XmsQvrXge4xB+BZ7D7IF32sM',
    'vrcWfG8t+OBaEELG3nusQfjWeu8xBiFci7WW0mttredca6+1tVxrjEHnGnvPOfeca+051xp0rrXnXGvvOeegc4w951qDzjEGnWvt',
    'Oefca42x51xrrzXGoHOtveecg60x9pxrDbbGGFMqpdcaY641xl5ra73W1nLOtfZaa+251tprrbXnXGPPudZea61B51p7rbX2nGPt',
    'Odfaa6215xxjrzXGnnOMPedae621Bp1j7LnGGHSOsdYaQq01CJtzMbbWomytxeick9E9F6dzLkrnnJTOuTidc1E692Z0zsXonJPS',
    'ORelcy5K55yUzTUpnXNTutZkbM5F6dybs7UWpXNOxtZajG0thFhrMTbGomytxdhai9E5J6VrTcbmnIyutRidczI256R0rcnYnJPR',
    'tSZjc05G5xyNrjUZm3NRNtembM5F2ZyT0rUmZ3MuxtaalM05GddajD3nlHrOrfXeU+o5p9R7jzH4HmMQwrXee4zBB9ly7631nGMM',
    'vrfWe26t995aED623nuMwffWgu+tBeFb68G3FnSOMfjeWu+9td57azHGEHKtMfZca+21xphrjTHoXGvPOeeec60955yDzrX2nGvt',
    'OeccbK6151xr0DnWoHOtPeecg60x9pxrDbbGGHSuteeec7A1xp5zrcXWGGNKKeVaW8u1xthrba3H2lrPOcZea6095xh7rTH2mmPM',
    'OcfYa62x1xpjrzXGnnOMPecYe6219pxb67XG2HNureccY6+11qBra73WGHvOrdVaO6e1BmNzDsbWGoyttRibczG256R0zkXpnpvS',
    'ORdjcy5K996UzjkJm3MzNudibM5F2ZyTs7UWY3MuytZalM05Gd17k7bmpGzOSdlak5GthRBrLcrWWpSttRhbazE256R0rcnonJPS',
    'tSZncy7K5tyMrrUYm3MxttakbM7F2JyT0bUmZXNORteajK25KJtzMrrWomyuydlak7I5J+Vai7H3nlLvvbXge0pB55R67zEG3WPs',
    'vbcWfI8xCN9aED7G4HuMQQjXgu8xBiFc6723FnSOMfieUvC9td57Sj341oLvMQbhWwvCtxZ8TynWGkKvNcZec6291tZ6rTEGnWvt',
    'OeccdK6151xr0LnWnnOtPefcg8219pxrDTrX2nOuteecc7A1xp5zrb3WGIPOtfaecw62xthzrjXYGmNMqZRea2s5xth6rSn1WlPq',
    'Ncfaa42x5xxjrzXGnnOMPecYg621Bp1j7DXH2HOOseccY681xqBza73W1nrOrfWcY+y1xhh0bi3Y2lrPubVYa+ew1mJkzsHYWouy',
    'tSZjc05G5x6Nzjkp23tSNueibM7J2d6T0TkXZXNORudcjM65Gd17UzbXomzuydmck9E5J6N7b0rXWozNOSmbczGytc5hrcnYGJux',
    'tSZjYyzK5tyUrjUpm3MyutbmdM7J2JyT0bUmY3NuytbalM05GZ1zMbrWYmzOSdlak7I5J6VzTkbX2pTOOSlba1M25+ZcazEG31Pq',
    'PbcWfE8p6JxSEELG4HuMQQjXgu8xBuFb7MHHGHyOMfjeWvC9xeCDa0EI14LPMQbfWwu+txZ8T6n33lrQOcbgc0q999aC7ynFWkPo',
    'tcbYa66119parzXGoHPNPeecg8619pxz7TnX2nOuteeec9C11p5zrUHnGHvOtfbecw62xthzrrXYHGPPudbec8691hh7zrUGm2OM',
    'KZWSa20t1xpjr7W1HmtrveYae6219pxj7LXG2HOOMeccY6+11qBzjL3WGHvOMfacY+y1xhh0bq3X2lqvubWec4y91hiDzq31Wlvr',
    'ObdWa+2c1hqEzbkYW2sRttZibM7F6Z6T0Tkno3NPRudcjM25GN17UTrnYnTOyemci9E5F6N7T0rXnJTOOTlbczE656R070npXIvS',
    'OTency1GttY5rLUYW2sxttbibK3F2JyT0bUWpXMuStdalM65GJtrUbrWqHTOydhak7E5J6NzbkrX2ozNuShbazI256J0zkXpWpPS',
    'OSdla03O5lyUAQAAAw4AAAEmlIFCQ1YFADUMAA7Lsm3L82xb0zTbJsu6T5Z1XfM8XRdN0/dFz7N1siwMZdn3Pc/TdVdVfV/0PNsm',
    'y8JQlnWdbfs+jKXr+jrf57Rt32fbwhBl6bq6zhimqW37vqRpriyaom2rpmnbMIbOdByjadq267rC75qmbXOeYyhNw7Capm3rsmwc',
    's6raNqdxdKZjKDWWkErPL0Sa4hydwhFwfiFOGMdlWbLsSZKqipYly0TRdZmmbYuaJsuuKMqyaVmyzDRtm2nKsqhpsiybpiyrliXL',
    'TFPXmaYsc1Vd5yzDTxRlmSw7S1WVZaqq65xlGJqmLLN1UteVZabpulRV16mqrtN15+n7UFVdZ9vCUFV1na47U9+Xpq6r63TdeKqq',
    'r9N1aer7pL4PYNvSVDjiC0++D6DrzlM5So0hpqmqTNM0qarrUlVRJMuuS1Vdlyy7LtN0Xa4ry1zXdamq65Jl12WarkuWZZnrui5b',
    'lmXKtOtc1XX5urKUZVUly7KMtPtc13X5vjKVZdfVNM33VVH0fVcUfZ8s+z7bFn5VFH3fdlVhmD1R18myspRlX3dNUxh211WOWxSF',
    'n20b2bLvs3VjKFWmruv7fB+27fts2ziSnmTZFxpHdFv4PU2zbdU0dV02TV0nPctSKhyraeq+7brGcauqbpOeY0k6jldVfd+3beO5',
    'VdXXOc+y5BxHqbEEzjMccZ4oS5wjIB1HaSpFeVZRtG3ZNG1bVlVdJ8uyzLZ9X1ZVXfddV9dt07Rttu37bFvXZdPUdWG2dV83TV1n',
    '28LPtnWdrgtD0nGUZV3n+9LTtnWbbvtCzrOUZV2nHNF1Xaeqts11fZ/r+j7dl6a+MOW6ws+2jaWq+j5dd6a+L+W6wk/XlaXr+kJf',
    'h+9DGEqBrTsJQ4Qhwg+g6zCOGENU1ba5rq5zXV0ny7bNtoWh6/o+2/Z9qqrrZNkXyrLvc11dZ9vCT1V1nW0LQ1n2fbouHKXnmbqu',
    'rvN9Z2rbus62hSHG0pV1nTFM2bque57n+65p+r4sir7Pto2hbfvCa5rGcLuqcdyi6Ptk2TjKsvC7ougLwywLwy2Kus62naUs+z5d',
    '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'
].join('');

const VORBIS_PACKET_1_BASE64 = 'AA==';

const VORBIS_PACKET_2_BASE64 = 'CgA=';

function decodeBase64(base64: string): Uint8Array {
    const decoded: string = globalThis.atob(base64);
    const bytes: Uint8Array = new Uint8Array(decoded.length);
    for (let byteIndex = 0; byteIndex < decoded.length; byteIndex += 1) {
        bytes[byteIndex] = decoded.charCodeAt(byteIndex);
    }
    return bytes;
}

function createChunk(
    base64: string,
    duration: number
): NativeSurroundAudioCapabilityFixtureChunk {
    return {
        data: decodeBase64(base64),
        duration,
        timestamp: 0
    };
}

/** Returns fresh exact encoded 5.1 packets and decoder initialization bytes. */
export function createNativeSurroundAudioCapabilityFixture(
    codec: NativeSurroundAudioCapabilityFixtureCodec
): NativeSurroundAudioCapabilityFixture {
    const common = {
        codec,
        expectedOutputTimestamp: 0,
        numberOfChannels: NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_CHANNEL_COUNT,
        sampleRate: NATIVE_SURROUND_AUDIO_CAPABILITY_FIXTURE_SAMPLE_RATE
    } as const;
    switch (codec) {
        case 'aac':
            return {
                ...common,
                codecString: 'mp4a.40.2',
                description: decodeBase64(AAC_DESCRIPTION_BASE64),
                encodedChunks: [
                    createChunk(AAC_PACKET_BASE64, 21_333)
                ],
                expectedOutputFrameCount: 1_024
            };
        case 'opus':
            return {
                ...common,
                codecString: 'opus',
                description: decodeBase64(OPUS_DESCRIPTION_BASE64),
                encodedChunks: [
                    createChunk(OPUS_PACKET_BASE64, 20_000)
                ],
                expectedOutputFrameCount: 648
            };
        case 'flac':
            return {
                ...common,
                codecString: 'flac',
                description: decodeBase64(FLAC_DESCRIPTION_BASE64),
                encodedChunks: [
                    createChunk(FLAC_PACKET_BASE64, 96_000)
                ],
                expectedOutputFrameCount: 4_608
            };
        case 'vorbis':
            return {
                ...common,
                codecString: 'vorbis',
                description: decodeBase64(VORBIS_DESCRIPTION_BASE64),
                encodedChunks: [
                    createChunk(VORBIS_PACKET_1_BASE64, 0),
                    createChunk(VORBIS_PACKET_2_BASE64, 12_000)
                ],
                expectedOutputFrameCount: 576
            };
    }
}
