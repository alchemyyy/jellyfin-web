export const NATIVE_VIDEO_CAPABILITY_FIXTURE_VERSION = 1;
export const NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_HEIGHT = 64;
export const NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_WIDTH = 64;

export type NativeVideoCapabilityFixtureCodec = 'av1' | 'vp8' | 'vp9';

export type NativeVideoCapabilityFixture = Readonly<{
    codec: NativeVideoCapabilityFixtureCodec
    codecString: string
    codedHeight: number
    codedWidth: number
    encodedKeyFrame: Uint8Array
}>;

// Generated with FFmpeg git-862338fe31. Each IVF frame payload is retained
// without the 32-byte IVF header or 12-byte per-frame header
// ffmpeg -f lavfi -i "color=c=black:s=64x64:r=1" -frames:v 1 -pix_fmt yuv420p \
// -c:v libvpx -deadline best -cpu-used 0 -g 1 -f ivf vp8.ivf
// ffmpeg -f lavfi -i "color=c=black:s=64x64:r=1" -frames:v 1 -pix_fmt yuv420p \
// -c:v libvpx-vp9 -deadline best -cpu-used 0 -g 1 -lossless 1 -f ivf vp9.ivf
// ffmpeg -f lavfi -i "color=c=black:s=64x64:r=1" -frames:v 1 -pix_fmt yuv420p \
// -c:v libaom-av1 -cpu-used 0 -crf 0 -g 1 -still-picture 1 -f ivf av1.ivf
const AV1_MAIN_KEY_FRAME_BASE64 = 'EgAKBhgVf/+wCDIMEAAAAEsXxj38v/+g';
const VP8_KEY_FRAME_BASE64 =
    '8AIAnQEqQABAAABHCIWFiIWEiAICAAZwPEJgCrIg9zAA/v+rUIA=';
const VP9_PROFILE_0_KEY_FRAME_BASE64 =
    'gkmDQgAD8AP2ADgkHBgAAAAgAAB4uf///tk/AAVicz2A';

function decodeBase64(base64: string): Uint8Array {
    const decoded = globalThis.atob(base64);
    const bytes = new Uint8Array(decoded.length);
    for (let byteIndex = 0; byteIndex < decoded.length; byteIndex += 1) {
        bytes[byteIndex] = decoded.charCodeAt(byteIndex);
    }
    return bytes;
}

/** Returns a new exact native SDR codec keyframe for output qualification. */
export function createNativeVideoCapabilityFixture(
    codec: NativeVideoCapabilityFixtureCodec
): NativeVideoCapabilityFixture {
    switch (codec) {
        case 'av1':
            return {
                codec,
                codecString: 'av01.0.08M.08',
                codedHeight: NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_HEIGHT,
                codedWidth: NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_WIDTH,
                encodedKeyFrame: decodeBase64(AV1_MAIN_KEY_FRAME_BASE64)
            };
        case 'vp8':
            return {
                codec,
                codecString: 'vp8',
                codedHeight: NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_HEIGHT,
                codedWidth: NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_WIDTH,
                encodedKeyFrame: decodeBase64(VP8_KEY_FRAME_BASE64)
            };
        case 'vp9':
            return {
                codec,
                codecString: 'vp09.00.10.08',
                codedHeight: NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_HEIGHT,
                codedWidth: NATIVE_VIDEO_CAPABILITY_FIXTURE_CODED_WIDTH,
                encodedKeyFrame: decodeBase64(VP9_PROFILE_0_KEY_FRAME_BASE64)
            };
    }
}
