export const RAW_HDR_CAPABILITY_FIXTURE_CODED_HEIGHT = 2_160;
export const RAW_HDR_CAPABILITY_FIXTURE_CODED_WIDTH = 3_840;
export const RAW_HDR_CAPABILITY_FIXTURE_VERSION = 1;

export type RawHDRCapabilityFixtureCodec = 'av1' | 'vp9';

export type RawHDRCapabilityFixture = {
    codec: RawHDRCapabilityFixtureCodec
    codecString: 'av01.0.08M.10' | 'vp09.02.10.10'
    codedHeight: number
    codedWidth: number
    decodedFrameFingerprint: number
    encodedKeyFrame: Uint8Array
};

// Single-frame 4K 10-bit limited-range gray keyframes generated with FFmpeg.
// AV1 uses libaom-av1 with -cpu-used 8 -crf 0 -still-picture 1.
// VP9 uses libvpx-vp9 with -deadline realtime -cpu-used 8 -lossless 1 -row-mt 1.
// Both inputs are color=c=gray:size=3840x2160:rate=30,format=yuv420p10le.
// The IVF container header and per-frame header are intentionally excluded.
const AV1_MAIN_10_KEY_FRAME_BASE64 = [
    'EgAKCBsu+/4b+oCAMpcGEAAASzTNQxF2g12I+iXq7fz80xEFAabpe283IPJz8va+',
    'mkdeoG4m+wsYqJN0LNZq00lX5Kj8D9XWItvFr1OF6lWZ9WtoaFTIcTyP0hx5DOU',
    'xuHAh/CpwHpzcsinBRZjZp3ta523tSVVsmGbYsWoPO637djKtH2KgvX3oxGQonF0',
    'rpxH96duilJCyqpWtzq51IHl8n4050kKfJ5UyUiSNqDg8+5xSxU0DRlRezfwMv13',
    '8qhwlgkOUNBqrwekHK4os9Ut1J7zNx8vUzUCTYmCTPjmnnW3+Eaix0CrAMamCs45',
    'uIRxEtXEw8ebLi4ejL9u0LrjJ1Mjqu/o1v9mXK/25aD0lSuEaFtY3FxQhLIxoZC',
    'uYEo/YKDoNM2r9PSnHZLHOoRbzn1gPO8m5vSnvf4MctzM7mI76PpgQtG4hjQr0z',
    'NY9epS6moqH9LPpZuLrFKemn5RBF2CkLNf0YZw0DKXh90GDaT7f4rs2E9lEusey',
    'mXYbdfFC7GN41rgN0flBFyoMRdk2i/lIXBDJvKeO9jabzoRAqs8lQdfVs75WHYRe',
    'a4ltv22T9iC4HkL8QHTrZ88y/fhzECGKosKRr+NuvdgjxpDUENE91t2YHQn0AWRP',
    'ZpqEScayDGDar6oLcaEoE0xBtSldRq5zV7eHMOAUaaUgcl6tk3A60+DBbEzJsMpP',
    'UR2VqXmZjbYdNe9gljQkkm3pBqBrDr/s5tsuivWwGw2xgyrTvVLloWBWam03MnkH',
    '4YNYiY0pZpop3qGqU6na+TJrWLhjssCkYMgEnkvc2M89DtKdPtVVa9jltpyZ3d7y',
    'G+KqOOR6baeahakanapusOuuxOzu2O5rCBD5FbHFItKRL7QdRxS/UHVLWTXXYfZj',
    'arbbcTdLgFg5jvmWm6neoCompKpuqMqorGrksCsgs+tct0uMuku8vUw3xKxbxrx8',
    'yMydytzV1L1YVk1xV82J2V2i2u273F3P3Z3j3t334B4L4U5HZO5U5caJaP6Vab6',
    'g6m6qxfW2O7MiSdEV7vjKe0c79ECgej8Kk6iOqsX1tjuzIknRIVDVIIY='
].join('');

const VP9_PROFILE_2_KEY_FRAME_BASE64 = [
    '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',
    'r0hLoty1qSoblvkJdlyWtSVHcv8hTsuS3KSo7sQ86gl2XJa1JeUOnUNQS6Lctb5C',
    'lKhqCXZclrf4czUlQ1BLot0T0makqGoJdlyjCq2UlR1DUEukhW2y1qSo6gl2lDS8',
    'W5a1JUNQU69IS6LctakqG5b5CXZclrUlR3L/IU7LktykqO7EPOoJdlyWtSXlDp1D',
    'UEui3LW+QpSoagl2XJa3+HM1JUNQS6LdE9JmpKhqCXZcowqtlJUdQ1BLpIVtstak',
    'qOoJdpRRHdEeE41XJ7LASibQXIAAAAF/ZzuiaYFIkNb2MsRdLeKXD+npZc7rGHPX',
    '6/w5mpKhqCXRblrfIUpUNQS7LktakvKHTqGoJdFuWtSXeB51BLsuS1qSo7l/kKdl',
    'yW5SVHUNw3aEuy3LWpKhqCnXpCXRblrUlQ1BTr0hLoty1qSoagp16Ql0W5a1JUNQ',
    'U69IS6LctakqGoKdekJdFuWtSVDUFOvSEui3LWpKhqCnXpCXRblrUlQ1BTr0hLot',
    'y1qSoagp16Ql0W5a1JUNQU69IS6LctakqGoKdekJdFuWtSVDUFOvSEui3LWpKhqC',
    'nXpCXRblrUlQ1BTr0hLoty1qSoagp16Ql0W5a1JUNQU69IS6LctakqGoKdekJdFu',
    'WtSVDUFOvSEui3LWpKhqCnXpCXRblrUlQ1BTr0hLoty1qSoagp16Ql0W5a1JUNQU',
    '69IS6LctakqGoKdekJdFuWtSVDUFOvSEui3LWpKhqCnXpCXRblrUlQ1BTr0hLoty',
    '1qSoagp2a9uIERZNor8UMjC8DcEwtAAAAAFTZzuiaYFIkNb2MsRdLeKXD+npZc7r',
    'GHPbx2hLsty1qSoblvkJdlyWtSVHcv8hTsuS3KSo7sQ86gl2XJa1JeUOnUNQS6Lc',
    'tb5ClKhqCXZclrf4czUlQ1BLot0T0makqGoJdlyjCq2UlR1DUEukhW2y1qSo6gl2',
    'lDS8W5a1JUNQU69IS6LctakqG5b5CXZclrUlR3L/IU7LktykqO7EPOoJdlyWtSXl',
    'Dp1DUEui3LW+QpSoagl2XJa3+HM1JUNQS6LdE9JmpKhqCXZcowqtlJUdQ1BLpIVt',
    'stakqOoJdpQ0vFuWtSVDUFOvSEui3LWpKhuW+Ql2XJa1JUdy/yFOy5LcpKjuxDzq',
    'CXZclrUl5Q6dQ1BLoty1vkKUqGoJdlyWt/hzNSVDUEui3RPSZqSoagl2XKMKrZSV',
    'HUNQS6SFbbLWpKjqCXaUUR3RHhONVyeywEom0FyAZzuiaYFIkNb2MsRdLeKXD+np',
    'Zc7rGHPX6/w5mpKhqCXRblrfIUpUNQS7LktakvKHTqGoJdFuWtSXeB51BLsuS1qS',
    'o7l/kKdlyW5SVHUNw3aEuy3LWpKhqCnXpCXRblrUlQ1BTr0hLoty1qSoagp16Ql0',
    'W5a1JUNQU69IS6LctakqGoKdekJdFuWtSVDUFOvSEui3LWpKhqCnXpCXRblrUlQ1',
    'BTr0hLoty1qSoagp16Ql0W5a1JUNQU69IS6LctakqGoKdekJdFuWtSVDUFOvSEui',
    '3LWpKhqCnXpCXRblrUlQ1BTr0hLoty1qSoagp16Ql0W5a1JUNQU69IS6LctakqGo',
    'KdekJdFuWtSVDUFOvSEui3LWpKhqCnXpCXRblrUlQ1BTr0hLoty1qSoagp16Ql0W',
    '5a1JUNQU69IS6LctakqGoKdekJdFuWtSVDUFOvSEui3LWpKhqCnXpCXRblrUlQ1B',
    'Tr0hLoty1qSoagp2a9uIERZNor8UMjC8DcEwtAA='
].join('');

// Sparse 64x36 FNV-1a samples from the decoded 10-bit Y, U, and V planes
const GRAY_10_BIT_DECODED_FRAME_FINGERPRINT = 4_080_076_472;

function decodeBase64(base64: string): Uint8Array {
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let byteIndex = 0; byteIndex < binary.length; byteIndex += 1) {
        bytes[byteIndex] = binary.charCodeAt(byteIndex);
    }
    return bytes;
}

/** Returns a new exact-resolution encoded keyframe for a raw HDR capability probe. */
export function createRawHDRCapabilityFixture(
    codec: RawHDRCapabilityFixtureCodec
): RawHDRCapabilityFixture {
    switch (codec) {
        case 'av1':
            return {
                codec,
                codecString: 'av01.0.08M.10',
                codedHeight: RAW_HDR_CAPABILITY_FIXTURE_CODED_HEIGHT,
                codedWidth: RAW_HDR_CAPABILITY_FIXTURE_CODED_WIDTH,
                decodedFrameFingerprint: GRAY_10_BIT_DECODED_FRAME_FINGERPRINT,
                encodedKeyFrame: decodeBase64(AV1_MAIN_10_KEY_FRAME_BASE64)
            };
        case 'vp9':
            return {
                codec,
                codecString: 'vp09.02.10.10',
                codedHeight: RAW_HDR_CAPABILITY_FIXTURE_CODED_HEIGHT,
                codedWidth: RAW_HDR_CAPABILITY_FIXTURE_CODED_WIDTH,
                decodedFrameFingerprint: GRAY_10_BIT_DECODED_FRAME_FINGERPRINT,
                encodedKeyFrame: decodeBase64(VP9_PROFILE_2_KEY_FRAME_BASE64)
            };
    }
}
