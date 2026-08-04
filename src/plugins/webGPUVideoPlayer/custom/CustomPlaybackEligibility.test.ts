import { describe, expect, it } from 'vitest';

import {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_NATIVE_SURROUND_AUDIO_CODECS,
    CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS,
    type CustomNativeSurroundAudioCodec,
    type CustomNativeSurroundAudioCodecCapability,
    type CustomNativeUltraHDVideoCodec,
    type CustomNativeUltraHDVideoCodecCapability,
    type CustomAudioCodec,
    type CustomDecodeCapabilities,
    type CustomDecodeCodecCapability,
    type CustomRawHDRVideoCodec,
    type CustomRawHDRVideoCodecCapability,
    type CustomVideoCodec
} from './CustomDecodeCapabilities';
import {
    getCustomPlaybackEligibility,
    hasPotentialCustomPlaybackVideoRoute
} from './CustomPlaybackEligibility';
import type { CustomPlaybackRuntimeAvailability } from './CustomPlaybackRuntime';
import type {
    NativeMediaAudioCapabilities,
    NativeMediaAudioChannelCount,
    NativeMediaAudioCodec,
    NativeMediaAudioCodecCapability,
    NativeMediaAudioLayoutCapability
} from './NativeMediaAudioCapabilities';
import {
    H264_JELLYFIN_PROFILE_NAMES,
    H264_PROFILE_PROBE_CODED_HEIGHT,
    H264_PROFILE_PROBE_CODED_WIDTH,
    H264_PROFILES,
    type H264ProfileCapabilities
} from './H264ProfileCapabilities';

const AVAILABLE_RUNTIME: CustomPlaybackRuntimeAvailability = {
    available: true,
    environment: {
        animationFrame: true,
        audioContext: true,
        audioData: true,
        audioDecoder: true,
        audioWorklet: true,
        secureContext: true,
        videoDecoder: true,
        videoFrame: true,
        webGPU: true,
        worker: true
    },
    reason: null
};

const PQ_AUTHORIZATION = {
    allowRawHDR: true,
    authorizedRawHDRRouteKeys: [
        'I420P10:bt2020-ncl:bt2020:limited:pq'
    ] as const,
    runtimeAvailability: AVAILABLE_RUNTIME
};

function createCapability<Codec extends CustomAudioCodec | CustomVideoCodec>(
    codec: Codec,
    supported: boolean
): CustomDecodeCodecCapability<Codec> {
    return {
        codec,
        codecString: codec,
        reason: supported ? 'config-supported' : 'config-unsupported',
        status: supported ? 'supported' : 'unsupported'
    };
}

function createH264ProfileCapabilities(): H264ProfileCapabilities {
    const capabilities = {} as Record<
        typeof H264_PROFILES[number],
        H264ProfileCapabilities[typeof H264_PROFILES[number]]
    >;
    for (const profile of H264_PROFILES) {
        capabilities[profile] = Object.freeze({
            codecString: profile,
            codedHeight: H264_PROFILE_PROBE_CODED_HEIGHT,
            codedWidth: H264_PROFILE_PROBE_CODED_WIDTH,
            evidence: 'decoded-output',
            jellyfinProfileName: H264_JELLYFIN_PROFILE_NAMES[profile],
            profile,
            reason: 'decode-output-verified',
            status: 'supported'
        });
    }
    return Object.freeze(capabilities);
}

function createBundledHEVCCapabilities(): NonNullable<CustomDecodeCapabilities['bundledHEVC']> {
    return {
        reason: 'complete',
        tiers: {
            'main-1080p': {
                bitDepth: 8,
                codecString: 'hvc1.1.6.L120.B0',
                decodeMilliseconds: 20,
                format: 'I420',
                framesPerSecond: 40,
                maximumCodedHeight: 1_080,
                maximumCodedWidth: 1_920,
                maximumLevel: 120,
                minimumFramesPerSecond: 30,
                profile: 'main',
                reason: 'decode-output-verified',
                status: 'supported',
                tier: 'main-1080p'
            },
            'main10-1080p': {
                bitDepth: 10,
                codecString: 'hvc1.2.4.L120.B0',
                decodeMilliseconds: 25,
                format: 'I420P10',
                framesPerSecond: 40,
                maximumCodedHeight: 1_080,
                maximumCodedWidth: 1_920,
                maximumLevel: 120,
                minimumFramesPerSecond: 30,
                profile: 'main10',
                reason: 'decode-output-verified',
                status: 'supported',
                tier: 'main10-1080p'
            },
            'main10-4k': {
                bitDepth: 10,
                codecString: 'hvc1.2.4.L153.B0',
                decodeMilliseconds: 30,
                format: 'I420P10',
                framesPerSecond: 40,
                maximumCodedHeight: 2_160,
                maximumCodedWidth: 3_840,
                maximumLevel: 153,
                minimumFramesPerSecond: 30,
                profile: 'main10',
                reason: 'decode-output-verified',
                status: 'supported',
                tier: 'main10-4k'
            }
        }
    };
}

function createBundledDTSCapability(): NonNullable<
    CustomDecodeCapabilities['bundledDTS']
> {
    return Object.freeze({
        channelBedOnly: true,
        codec: 'dts',
        codecString: 'dts',
        decodeMilliseconds: 8,
        libraryVersion: 131_073,
        maximumChannelCount: 8,
        measuredRealTimeFactor: 32,
        objectAudioRendered: false,
        profiles: Object.freeze([
            'core',
            'core-96-24',
            'es',
            'hd-hra',
            'hd-ma'
        ] as const),
        reason: 'decode-output-verified',
        sampleRates: Object.freeze([ 48_000, 96_000, 192_000 ] as const),
        status: 'supported',
        verifiedFixtureCount: 7,
        verifiedProfileMask: 0x1f
    });
}

function createBundledTrueHDCapability(): NonNullable<
    CustomDecodeCapabilities['bundledTrueHD']
> {
    return Object.freeze({
        channelBedOnly: true,
        channelCounts: Object.freeze([ 2, 6 ] as const),
        codecs: Object.freeze([ 'truehd', 'mlp' ] as const),
        decodeMilliseconds: 12,
        library: 'ffmpeg-libavcodec',
        libraryVersion: 4_079_728,
        majorSyncRecoveryVerified: true,
        measuredRealTimeFactor: 12,
        objectAudioRendered: false,
        passthrough: false,
        reason: 'decode-output-verified',
        sampleRates: Object.freeze([ 48_000, 96_000, 192_000 ] as const),
        status: 'supported',
        verifiedChannelCountMask: (1 << 2) | (1 << 6),
        verifiedCodecMask: 0x03,
        verifiedFixtureCount: 4,
        verifiedSampleRateMask: 0x07
    });
}

function createBundledJPEG2000Capability(): NonNullable<
    CustomDecodeCapabilities['bundledJPEG2000']
> {
    return Object.freeze({
        bitDepth: 8,
        codec: 'jpeg2000',
        codecString: 'mjp2',
        decodeMilliseconds: 200,
        decodedRGBAByteLength: 2_073_600,
        decodedRGBAFingerprint: 1_076_220_778,
        maximumCodedHeight: 540,
        maximumCodedWidth: 960,
        maximumFramesPerSecond: 24,
        measuredFramesPerSecond: 40,
        reason: 'decode-output-verified',
        status: 'supported'
    });
}

function createBundledLegacyVideoCapability(): NonNullable<
    CustomDecodeCapabilities['bundledLegacyVideo']
> {
    return Object.freeze({
        codec: 'mpeg2video',
        decodeMilliseconds: 400,
        decodedFrameByteLength: 3_110_400,
        decodedFrameCount: 12,
        decodedI420Fingerprint: 544_635_241,
        decodedTotalByteLength: 37_324_800,
        maximumCodedHeight: 1_080,
        maximumCodedWidth: 1_920,
        maximumFramesPerSecond: 24,
        measuredFramesPerSecond: 35,
        reason: 'decode-output-verified',
        status: 'supported'
    });
}

function createCapabilities(): CustomDecodeCapabilities {
    const createRawHDRCapability = (
        codec: CustomRawHDRVideoCodec
    ): CustomRawHDRVideoCodecCapability => ({
        bitDepth: 10,
        codec,
        codecString: codec === 'hevc' ? 'hvc1.2.4.L153.B0' : codec,
        format: 'I420P10',
        maximumCodedHeight: 2_160,
        maximumCodedWidth: 3_840,
        maximumFramesPerSecond: 30,
        measuredFramesPerSecond: 40,
        reason: codec === 'hevc' ? 'bundled-software-decoder' : 'output-copy-supported',
        status: 'supported'
    });
    const audio = {} as Record<
        CustomAudioCodec,
        CustomDecodeCodecCapability<CustomAudioCodec>
    >;
    for (const codec of CUSTOM_AUDIO_CODECS) {
        audio[codec] = createCapability(codec, true);
    }
    return {
        audio,
        bundledDTS: createBundledDTSCapability(),
        bundledHEVC: createBundledHEVCCapabilities(),
        bundledTrueHD: createBundledTrueHDCapability(),
        h264Profiles: createH264ProfileCapabilities(),
        nativeDolbyVisionHEVC: {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hev1.2.4.H150.B0',
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            maximumFramesPerSecond: 24,
            maximumLevel: 153,
            measuredFramesPerSecond: 30,
            profile: 5,
            reason: 'decode-output-verified',
            status: 'supported'
        },
        nativeHDRHEVC: {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hvc1.2.4.L153.B0',
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            maximumFramesPerSecond: 60,
            maximumLevel: 153,
            measuredFramesPerSecond: 80,
            reason: 'decode-output-verified',
            status: 'supported'
        },
        rawHDRVideo: {
            av1: createRawHDRCapability('av1'),
            hevc: createRawHDRCapability('hevc'),
            vp9: createRawHDRCapability('vp9')
        },
        telemetry: {
            audioProbeCount: 5,
            bundledAudioCodecCount: 2,
            nativeSurroundAudioProbeCount: 0,
            nativeHDRVideoProbeCount: 1,
            nativeUltraHDVideoProbeCount: 0,
            rawHDRVideoProbeCount: 2,
            reason: 'complete',
            supportedAudioCodecCount: 7,
            supportedNativeSurroundAudioCodecCount: 0,
            supportedNativeHDRVideoCodecCount: 1,
            supportedNativeUltraHDVideoCodecCount: 0,
            supportedRawHDRVideoCodecCount: 3,
            supportedVideoCodecCount: 5,
            unknownAudioCodecCount: 0,
            unknownNativeSurroundAudioCodecCount: 0,
            unknownNativeHDRVideoCodecCount: 0,
            unknownNativeUltraHDVideoCodecCount: 0,
            unknownVideoCodecCount: 0,
            videoProbeCount: 5
        },
        video: {
            av1: createCapability('av1', true),
            h264: createCapability('h264', true),
            hevc: createCapability('hevc', true),
            jpeg2000: createCapability('jpeg2000', false),
            mpeg2video: createCapability('mpeg2video', false),
            vp8: createCapability('vp8', true),
            vp9: createCapability('vp9', true)
        }
    };
}

function createNativeSurroundAudioCapabilities(
    supportedCodecs: ReadonlySet<CustomNativeSurroundAudioCodec>
): NonNullable<CustomDecodeCapabilities['nativeSurroundAudio']> {
    const codecStrings: Readonly<Record<CustomNativeSurroundAudioCodec, string>> = {
        aac: 'mp4a.40.2',
        flac: 'flac',
        opus: 'opus',
        vorbis: 'vorbis'
    };
    const capabilities = {} as Record<
        CustomNativeSurroundAudioCodec,
        CustomNativeSurroundAudioCodecCapability
    >;
    for (const codec of CUSTOM_NATIVE_SURROUND_AUDIO_CODECS) {
        const supported: boolean = supportedCodecs.has(codec);
        capabilities[codec] = {
            codec,
            codecString: codecStrings[codec],
            inputChannelCount: 6,
            reason: supported ? 'decode-output-verified' : 'decode-output-missing',
            sampleRate: 48_000,
            status: supported ? 'supported' : 'unsupported'
        };
    }
    return capabilities;
}

function createNativeUltraHDVideoCapabilities(
    supportedCodecs: ReadonlySet<CustomNativeUltraHDVideoCodec>
): NonNullable<CustomDecodeCapabilities['nativeUltraHDVideo']> {
    const codecStrings: Readonly<Record<CustomNativeUltraHDVideoCodec, string>> = {
        av1: 'av01.0.12M.08',
        hevc: 'hvc1.1.6.L153.B0',
        vp9: 'vp09.00.51.08'
    };
    const capabilities = {} as Record<
        CustomNativeUltraHDVideoCodec,
        CustomNativeUltraHDVideoCodecCapability
    >;
    for (const codec of CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS) {
        const supported: boolean = supportedCodecs.has(codec);
        capabilities[codec] = {
            bitDepth: 8,
            codec,
            codecString: codecStrings[codec],
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            reason: supported ? 'decode-output-verified' : 'decode-output-missing',
            status: supported ? 'supported' : 'unsupported'
        };
    }
    return capabilities;
}

function createNativeMediaAudioCapabilities(
    supportedRoutes: ReadonlySet<string>
): NativeMediaAudioCapabilities {
    const audio = {} as Record<NativeMediaAudioCodec, NativeMediaAudioCodecCapability>;
    for (const codec of [ 'ac3', 'eac3' ] as const) {
        const codecString = codec === 'ac3' ? 'ac-3' : 'ec-3';
        const mimeType = `audio/mp4; codecs="${codecString}"`;
        const layouts = {} as Record<
            NativeMediaAudioChannelCount,
            NativeMediaAudioLayoutCapability
        >;
        let codecSupported = false;
        for (const channelCount of [ 2, 6 ] as const) {
            const supported = supportedRoutes.has(`${codec}:${channelCount}:48000`);
            codecSupported ||= supported;
            layouts[channelCount] = {
                channelCount,
                codec,
                codecString,
                mimeType,
                reason: supported ? 'decoded-playback-advanced' : 'playback-not-advanced',
                sampleRate: 48_000,
                status: supported ? 'supported' : 'unsupported'
            };
        }
        audio[codec] = {
            codec,
            codecString,
            layouts,
            mimeType,
            status: codecSupported ? 'supported' : 'unsupported'
        };
    }
    return {
        audio,
        telemetry: {
            probeCount: 4,
            supportedLayoutCount: supportedRoutes.size,
            unknownLayoutCount: 0
        }
    };
}

function createOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        mediaSource: {
            Container: 'mov,mp4,m4a,3gp,3g2,mj2',
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
                {
                    BitDepth: 8,
                    Codec: 'h264',
                    Height: 1_080,
                    Index: 0,
                    IsInterlaced: false,
                    Profile: 'High',
                    Type: 'Video',
                    VideoRangeType: 'SDR',
                    Width: 1_920
                },
                {
                    Channels: 2,
                    Codec: 'aac',
                    Index: 1,
                    SampleRate: 48_000,
                    Type: 'Audio'
                }
            ],
            RunTimeTicks: 60_000_000
        },
        playMethod: 'DirectPlay',
        playerStartPositionTicks: 10_000_000,
        url: '/Videos/item/stream.mp4?api_key=secret',
        ...overrides
    };
}

function createPlaybackSelectionItem(
    videoStream: Record<string, unknown>,
    container = 'mkv',
    sourceId = 'source'
): Record<string, unknown> {
    return {
        MediaSources: [{
            Container: container,
            Id: sourceId,
            MediaStreams: [{
                Height: 1_080,
                Index: 0,
                IsInterlaced: false,
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 1_920,
                ...videoStream
            }]
        }]
    };
}

describe('CustomPlaybackEligibility', () => {
    it('keeps an exact supported H264 route eligible for wrapper selection', () => {
        const item = createPlaybackSelectionItem({
            BitDepth: 8,
            Codec: 'H264',
            Profile: 'High'
        });

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(true);
    });

    it.each([
        [ 'interlaced MPEG-2', {
            AverageFrameRate: 29.97003,
            BitDepth: 8,
            Codec: 'MPEG2VIDEO',
            Height: 480,
            IsInterlaced: true,
            Profile: 'Main',
            Width: 720
        } ],
        [ 'high-frame-rate progressive MPEG-2', {
            AverageFrameRate: 29.97003,
            BitDepth: 8,
            Codec: 'MPEG2VIDEO',
            Height: 540,
            Profile: 'Main',
            Width: 720
        } ],
        [ 'VC-1', {
            AverageFrameRate: 23.976,
            BitDepth: 8,
            Codec: 'VC1',
            Profile: 'Advanced'
        } ],
        [ '10-bit SDR AV1', {
            AverageFrameRate: 24,
            BitDepth: 10,
            Codec: 'AV1',
            Height: 1_632,
            Profile: 'Main',
            Width: 3_840
        } ]
    ])('routes exact unsupported %s metadata to the HTML player', (_label, videoStream) => {
        const item = createPlaybackSelectionItem(videoStream);

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(false);
    });

    it('uses the requested media source instead of an unrelated supported alternate', () => {
        const unsupportedSource = (
            createPlaybackSelectionItem({
                BitDepth: 8,
                Codec: 'VC1',
                Profile: 'Advanced'
            }, 'mkv', 'unsupported').MediaSources as unknown[]
        )[0];
        const supportedSource = (
            createPlaybackSelectionItem({
                BitDepth: 8,
                Codec: 'H264',
                Profile: 'High'
            }, 'mkv', 'supported').MediaSources as unknown[]
        )[0];
        const item = { MediaSources: [ supportedSource, unsupportedSource ] };

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(true);
        expect(hasPotentialCustomPlaybackVideoRoute(item, {
            mediaSourceId: 'unsupported'
        })).toBe(false);
    });

    it('does not reject wrapper selection when source metadata is unavailable', () => {
        expect(hasPotentialCustomPlaybackVideoRoute({ Id: 'metadata-pending' })).toBe(true);
    });

    it.each([
        [ 'interlace state', { BitDepth: 8, Codec: 'H264', Profile: 'High' }, {
            IsInterlaced: undefined
        } ],
        [ 'profile', { BitDepth: 8, Codec: 'H264' }, {} ],
        [ 'dimensions', { BitDepth: 8, Codec: 'H264', Profile: 'High' }, {
            Width: undefined
        } ],
        [ 'frame rate', { BitDepth: 8, Codec: 'MPEG2VIDEO', Profile: 'Main' }, {} ]
    ])('keeps the wrapper available when %s metadata is incomplete', (
        _label,
        videoStream,
        sourceOverrides
    ) => {
        const item = createPlaybackSelectionItem({
            ...videoStream,
            ...sourceOverrides
        });

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(true);
    });

    it('rejects a known unsupported codec even when unrelated metadata is incomplete', () => {
        const item = createPlaybackSelectionItem({
            BitDepth: undefined,
            Codec: 'VC1',
            IsInterlaced: undefined,
            Profile: undefined
        });

        expect(hasPotentialCustomPlaybackVideoRoute(item)).toBe(false);
    });

    it.each([ 'MPEG2VIDEO', 'MPEG2', 'MPEG-2' ])(
        'selects the exact progressive MPEG-2 Matroska route for %s metadata',
        (codecName) => {
            const baseCapabilities = createCapabilities();
            const capabilities: CustomDecodeCapabilities = {
                ...baseCapabilities,
                bundledLegacyVideo: createBundledLegacyVideoCapability(),
                video: {
                    ...baseCapabilities.video,
                    mpeg2video: createCapability('mpeg2video', true)
                }
            };
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = 'mkv';
            mediaSource.MediaStreams[0] = {
                AverageFrameRate: 24,
                BitDepth: 8,
                BitRate: 1_500_000_000,
                Codec: codecName,
                Height: 1_080,
                Index: 0,
                IsInterlaced: false,
                Profile: 'Main',
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 1_920
            };

            expect(getCustomPlaybackEligibility(
                options,
                capabilities,
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                eligible: true,
                maximumCodedHeight: 1_080,
                maximumCodedWidth: 1_920,
                videoDecoderBackend: 'legacy-software',
                videoOutputMode: 'video-frame'
            });
        }
    );

    it.each([
        [ 'unqualified runtime', { AverageFrameRate: 24 }, 'mkv', false ],
        [ 'excessive frame rate', { AverageFrameRate: 24.001 }, 'mkv', true ],
        [ 'excessive width', { AverageFrameRate: 24, Width: 1_921 }, 'mkv', true ],
        [ 'high bit depth', { AverageFrameRate: 24, BitDepth: 10 }, 'mkv', true ],
        [ 'non-Main profile', { AverageFrameRate: 24, Profile: 'Simple' }, 'mkv', true ],
        [ 'missing profile', { AverageFrameRate: 24, Profile: null }, 'mkv', true ],
        [ 'interlaced frames', { AverageFrameRate: 24, IsInterlaced: true }, 'mkv', true ],
        [ 'MPEG-TS container', { AverageFrameRate: 24 }, 'ts', true ],
        [ 'MPEG-TS alias container', { AverageFrameRate: 24 }, 'mpegts', true ],
        [ 'MTS container', { AverageFrameRate: 24 }, 'mts', true ],
        [ 'M2TS container', { AverageFrameRate: 24 }, 'm2ts', true ],
        [ 'MPEG-PS container', { AverageFrameRate: 24 }, 'mpegps', true ],
        [ 'MPEG container', { AverageFrameRate: 24 }, 'mpeg', true ],
        [ 'MPG container', { AverageFrameRate: 24 }, 'mpg', true ],
        [ 'VOB container', { AverageFrameRate: 24 }, 'vob', true ],
        [ 'MOV container', { AverageFrameRate: 24 }, 'mov', true ],
        [ 'MP4 container', { AverageFrameRate: 24 }, 'mp4', true ],
        [ 'other container', { AverageFrameRate: 24 }, 'webm', true ]
    ] as const)(
        'rejects MPEG-2 with %s',
        (_label, metadataOverride, container, includeCapability) => {
            const baseCapabilities = createCapabilities();
            const capabilities: CustomDecodeCapabilities = {
                ...baseCapabilities,
                ...(includeCapability ? {
                    bundledLegacyVideo: createBundledLegacyVideoCapability()
                } : {})
            };
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[0] = {
                BitDepth: 8,
                Codec: 'MPEG2VIDEO',
                Height: 1_080,
                Index: 0,
                IsInterlaced: false,
                Profile: 'Main',
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 1_920,
                ...metadataOverride
            };

            expect(getCustomPlaybackEligibility(
                options,
                capabilities,
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            ).eligible).toBe(false);
        }
    );

    it.each([ 'JPEG2000', 'JPEG 2000', 'J2K' ])(
        'selects the exact OpenJPEG MJ2 route for %s metadata',
        (codecName) => {
            const baseCapabilities = createCapabilities();
            const capabilities: CustomDecodeCapabilities = {
                ...baseCapabilities,
                bundledJPEG2000: createBundledJPEG2000Capability(),
                video: {
                    ...baseCapabilities.video,
                    jpeg2000: createCapability('jpeg2000', true)
                }
            };
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = 'mj2';
            mediaSource.MediaStreams[0] = {
                AverageFrameRate: 24,
                BitDepth: 8,
                Codec: codecName,
                Height: 540,
                Index: 0,
                IsInterlaced: false,
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 960
            };

            expect(getCustomPlaybackEligibility(
                options,
                capabilities,
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                eligible: true,
                maximumCodedHeight: 540,
                maximumCodedWidth: 960,
                videoDecoderBackend: 'openjpeg',
                videoOutputMode: 'video-frame'
            });
        }
    );

    it.each([
        [ 'unqualified runtime', { AverageFrameRate: 24 }, 'mj2', false ],
        [ 'excessive frame rate', { AverageFrameRate: 24.001 }, 'mj2', true ],
        [ 'excessive width', { AverageFrameRate: 24, Width: 961 }, 'mj2', true ],
        [ 'high bit depth', { AverageFrameRate: 24, BitDepth: 10 }, 'mj2', true ],
        [ 'unqualified container', { AverageFrameRate: 24 }, 'mp4', true ]
    ] as const)(
        'rejects JPEG 2000 with %s',
        (_label, metadataOverride, container, includeCapability) => {
            const baseCapabilities = createCapabilities();
            const capabilities: CustomDecodeCapabilities = {
                ...baseCapabilities,
                ...(includeCapability ? {
                    bundledJPEG2000: createBundledJPEG2000Capability()
                } : {})
            };
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[0] = {
                BitDepth: 8,
                Codec: 'JPEG2000',
                Height: 540,
                Index: 0,
                IsInterlaced: false,
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 960,
                ...metadataOverride
            };

            expect(getCustomPlaybackEligibility(
                options,
                capabilities,
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            ).eligible).toBe(false);
        }
    );

    it.each([
        [ 'missing', undefined ],
        [ 'arbitrarily high', 1_500_000_000 ]
    ])('uses the exact bundled HEVC Main tier with %s source bitrate', (_label, bitrate) => {
        const baseCapabilities = createCapabilities();
        const capabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            video: {
                ...baseCapabilities.video,
                hevc: createCapability('hevc', false)
            }
        };
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 24,
            BitDepth: 8,
            BitRate: bitrate,
            Codec: 'hevc',
            Height: 1_080,
            Index: 0,
            IsInterlaced: false,
            Level: 120,
            Profile: 'Main',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 1_920
        };

        expect(getCustomPlaybackEligibility(
            options,
            capabilities,
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            eligible: true,
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'video-frame'
        });
    });

    it.each([
        [ 'missing frame rate', { AverageFrameRate: undefined } ],
        [ 'non-finite frame rate', { AverageFrameRate: Number.NaN } ],
        [ 'excessive frame rate', { AverageFrameRate: 25 } ],
        [ 'missing level', { Level: undefined } ],
        [ 'excessive level', { Level: 121 } ]
    ])('rejects bundled HEVC Main with %s', (_label, metadataOverride) => {
        const baseCapabilities = createCapabilities();
        const capabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            video: {
                ...baseCapabilities.video,
                hevc: createCapability('hevc', false)
            }
        };
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 24,
            BitDepth: 8,
            BitRate: 12_000_000,
            Codec: 'hevc',
            Height: 1_080,
            Index: 0,
            IsInterlaced: false,
            Level: 120,
            Profile: 'Main',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 1_920,
            ...metadataOverride
        };

        expect(getCustomPlaybackEligibility(
            options,
            capabilities,
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
    });

    it.each([
        'Constrained Baseline',
        'Baseline',
        'Main',
        'High'
    ])('accepts exact verified H264 profile %s', profile => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0].Profile = profile;

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({ eligible: true, videoOutputMode: 'video-frame' });
    });

    it('rejects H264 when exact profile evidence is absent', () => {
        const capabilities = createCapabilities();
        delete capabilities.h264Profiles;

        expect(getCustomPlaybackEligibility(
            createOptions(),
            capabilities,
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
    });

    it('selects typed video and audio ordinals with integer-microsecond timing', () => {
        expect(getCustomPlaybackEligibility(
            createOptions(),
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            audioTrackIndex: 0,
            durationMicroseconds: 6_000_000,
            eligible: true,
            hdr: false,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 1_000_000,
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        });
    });

    it('translates non-contiguous Jellyfin indexes across interleaved stream types', () => {
        const options = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 41,
                MediaStreams: [
                    { Codec: 'subrip', Index: 3, Type: 'Subtitle' },
                    { Channels: 2, Codec: 'opus', Index: 41, SampleRate: 48_000, Type: 'Audio' },
                    {
                        BitDepth: 8,
                        Codec: 'h264',
                        Height: 1_080,
                        Index: 9,
                        IsInterlaced: false,
                        Profile: 'High',
                        Type: 'Video',
                        VideoRangeType: 'SDR',
                        Width: 1_920
                    },
                    { Codec: 'bin_data', Index: 17, Type: 'Data' },
                    { Channels: 2, Codec: 'aac', Index: 24, SampleRate: 48_000, Type: 'Audio' },
                    { Codec: 'ass', Index: 30, Type: 'Subtitle' }
                ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            audioTrackIndex: 1,
            eligible: true,
            videoTrackIndex: 0
        });
    });

    it.each([ 'ac3', 'AC-3', 'eac3', 'E-AC-3', 'ec-3' ])(
        'accepts bundled Dolby audio alias %s',
        audioCodec => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<{ Codec: string }>
            };
            mediaSource.MediaStreams[1].Codec = audioCodec;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioTrackIndex: 0,
                eligible: true
            });
        }
    );

    it.each([ 8, 16, 20, 24, 32 ])(
        'accepts qualified stereo FLAC independently of its %i-bit source depth',
        bitDepth => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = 'mkv';
            mediaSource.MediaStreams[1] = {
                BitDepth: bitDepth,
                Channels: 2,
                Codec: 'flac',
                Index: 1,
                SampleRate: 48_000,
                Type: 'Audio'
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                audioSourceChannelCount: 2,
                eligible: true
            });
        }
    );

    it.each([
        [ 3_000, undefined ],
        [ 8_000, 1 ],
        [ 12_345, 1_500_000_000 ],
        [ 44_100, 1_000_000 ],
        [ 48_000, 1_300_000 ],
        [ 88_200, 5_000_000 ],
        [ 96_000, 50_000_000 ],
        [ 176_400, 500_000_000 ],
        [ 192_000, 2_000_000_000 ]
    ] as const)(
        'accepts 24-bit stereo FLAC at %i Hz independently of encoded bitrate %s',
        (sampleRate, bitrate) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = 'mkv';
            mediaSource.MediaStreams[1] = {
                BitDepth: 24,
                BitRate: bitrate,
                Channels: 2,
                Codec: 'flac',
                Index: 1,
                SampleRate: sampleRate,
                Type: 'Audio'
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                audioSourceChannelCount: 2,
                eligible: true
            });
        }
    );

    it.each([ 2_999, 192_001 ])(
        'rejects stereo FLAC only outside the decoded-PCM source-rate contract at %i Hz',
        sampleRate => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = 'mkv';
            mediaSource.MediaStreams[1] = {
                BitDepth: 24,
                BitRate: 1_300_000,
                Channels: 2,
                Codec: 'flac',
                Index: 1,
                SampleRate: sampleRate,
                Type: 'Audio'
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });
        }
    );

    it.each([
        [ 'webm', 'h264', 'High', 'opus' ],
        [ 'ts', 'vp9', 'Profile 0', 'aac' ],
        [ 'webm', 'vp9', 'Profile 0', 'ac3' ]
    ])(
        'rejects unsupported %s/%s/%s/%s container combinations',
        (container, videoCodec, videoProfile, audioCodec) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[0].Codec = videoCodec;
            mediaSource.MediaStreams[0].Profile = videoProfile;
            mediaSource.MediaStreams[1].Codec = audioCodec;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'container-unsupported' });
        }
    );

    it('selects raw-plane output for an allowed HEVC/PQ Matroska source', () => {
        const hdrOptions = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        BitDepth: 10,
                        BitRate: 40_000_000,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt2020',
                        ColorRange: 'tv',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        RealFrameRate: 24,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'HDR10',
                        Width: 3_840
                    },
                    { Channels: 2, Codec: 'flac', Index: 1, SampleRate: 48_000, Type: 'Audio' }
                ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            { allowRawHDR: true, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            {
                allowNativeHDR: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            {
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            eligible: true,
            hdr: true,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            rawVideoFrameFormat: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
        const nativeHDRMediaSource = hdrOptions.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        for (const bitrate of [ undefined, 1_500_000_000 ]) {
            nativeHDRMediaSource.MediaStreams[0].BitRate = bitrate;
            expect(getCustomPlaybackEligibility(
                hdrOptions,
                createCapabilities(),
                {
                    allowNativeHDR: true,
                    allowRawHDR: false,
                    authorizedExternalHDRRouteKeys: [
                        'external-hevc-main10-bt709-limited:pq-v1'
                    ],
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            )).toMatchObject({
                eligible: true,
                nativeHDRTransfer: 'pq',
                videoDecoderBackend: 'native'
            });
        }
        nativeHDRMediaSource.MediaStreams[0].BitRate = 40_000_000;
        delete nativeHDRMediaSource.MediaStreams[0].ColorRange;
        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            {
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            eligible: true,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true
        });
        nativeHDRMediaSource.MediaStreams[0].ColorRange = 'tv';
        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            {
                allowRawHDR: true,
                authorizedRawHDRRouteKeys: [
                    'I420P10:bt2020-ncl:bt2020:limited:hlg'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            PQ_AUTHORIZATION
        )).toMatchObject({
            eligible: true,
            hdr: true,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
    });

    it.each([
        { field: 'Profile', label: 'profile', value: 'Main' },
        { field: 'BitDepth', label: 'bit depth', value: 8 },
        { field: 'Level', label: 'level', value: 154 },
        { field: 'Width', label: 'width', value: 3_841 },
        { field: 'Height', label: 'height', value: 2_161 },
        { field: 'RealFrameRate', label: 'frame rate', value: 60.01 },
        { field: 'ColorTransfer', label: 'transfer authorization', value: 'arib-std-b67' }
    ] as const)(
        'rejects native HDR outside its exact $label bound',
        ({ field, value }) => {
            const options = createOptions({
                mediaSource: {
                    Container: 'mkv',
                    DefaultAudioStreamIndex: 1,
                    MediaStreams: [ {
                        BitDepth: 10,
                        BitRate: 40_000_000,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt2020',
                        ColorRange: 'tv',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        RealFrameRate: 60,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'HDR10',
                        Width: 3_840
                    }, {
                        Channels: 2,
                        Codec: 'flac',
                        Index: 1,
                        SampleRate: 48_000,
                        Type: 'Audio'
                    } ],
                    RunTimeTicks: 60_000_000
                }
            });
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[0][field] = value;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                {
                    allowNativeHDR: true,
                    allowRawHDR: false,
                    authorizedExternalHDRRouteKeys: [
                        'external-hevc-main10-bt709-limited:pq-v1'
                    ],
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            ).eligible).toBe(false);
        }
    );

    it('rejects native HDR when required color metadata is missing', () => {
        const options = createOptions({
            mediaSource: {
                Container: 'mkv',
                MediaStreams: [ {
                    BitDepth: 10,
                    BitRate: 24_000_000,
                    Codec: 'hevc',
                    ColorPrimaries: 'bt2020',
                    ColorSpace: 'bt2020nc',
                    Height: 2_160,
                    Index: 0,
                    IsInterlaced: false,
                    Level: 153,
                    Profile: 'Main 10',
                    RealFrameRate: 24,
                    Type: 'Video',
                    VideoRangeType: 'HDR10',
                    Width: 3_840
                } ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            {
                allowNativeHDR: true,
                allowRawHDR: false,
                authorizedExternalHDRRouteKeys: [
                    'external-hevc-main10-bt709-limited:pq-v1'
                ],
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        ).eligible).toBe(false);
    });

    it('keeps native and raw Dolby Vision authorization routes separate', () => {
        const dolbyVisionOptions = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        BitDepth: 10,
                        BitRate: 24_000_000,
                        BlPresentFlag: true,
                        Codec: 'hevc',
                        DvBlSignalCompatibilityId: 0,
                        DvProfile: 5,
                        ElPresentFlag: false,
                        Height: 2_076,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 150,
                        Profile: 'Main 10',
                        RealFrameRate: 24,
                        RpuPresentFlag: true,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'DOVI',
                        Width: 3_840
                    },
                    { Channels: 2, Codec: 'flac', Index: 1, SampleRate: 48_000, Type: 'Audio' }
                ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            dolbyVisionOptions,
            createCapabilities(),
            {
                allowDolbyVision: false,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(
            dolbyVisionOptions,
            createCapabilities(),
            {
                allowDolbyVision: false,
                allowNativeDolbyVision: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            eligible: true,
            hdr: true,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            rawVideoFrameFormat: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });
        expect(getCustomPlaybackEligibility(
            dolbyVisionOptions,
            createCapabilities(),
            {
                allowDolbyVision: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            eligible: true,
            hdr: true,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });

        const dolbyVisionMediaSource = dolbyVisionOptions.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        const profile8Options = {
            ...dolbyVisionOptions,
            mediaSource: {
                ...dolbyVisionMediaSource,
                MediaStreams: dolbyVisionMediaSource.MediaStreams.map(stream => ({ ...stream }))
            }
        };
        const profile8MediaSource = profile8Options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        profile8MediaSource.MediaStreams[0].DvBlSignalCompatibilityId = 1;
        profile8MediaSource.MediaStreams[0].DvProfile = 8;
        expect(getCustomPlaybackEligibility(
            profile8Options,
            createCapabilities(),
            {
                allowDolbyVision: false,
                allowNativeDolbyVision: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
    });

    it.each([
        { expectedEligible: true, maximumFramesPerSecond: 24 as const, streamFrameRate: 24 },
        { expectedEligible: false, maximumFramesPerSecond: 24 as const, streamFrameRate: 24.001 },
        { expectedEligible: true, maximumFramesPerSecond: 30 as const, streamFrameRate: 30 },
        { expectedEligible: true, maximumFramesPerSecond: 60 as const, streamFrameRate: 60 },
        { expectedEligible: false, maximumFramesPerSecond: 60 as const, streamFrameRate: 60.001 },
        { expectedEligible: false, maximumFramesPerSecond: 0 as const, streamFrameRate: 24 }
    ])(
        'enforces the native Profile 5 $maximumFramesPerSecond fps tier at $streamFrameRate fps',
        ({ expectedEligible, maximumFramesPerSecond, streamFrameRate }) => {
            const capabilities = createCapabilities();
            const nativeDolbyVisionHEVC = capabilities.nativeDolbyVisionHEVC;
            if (!nativeDolbyVisionHEVC) {
                throw new Error('The native Dolby Vision capability fixture is missing');
            }
            capabilities.nativeDolbyVisionHEVC = {
                ...nativeDolbyVisionHEVC,
                maximumFramesPerSecond,
                measuredFramesPerSecond: maximumFramesPerSecond > 0 ?
                    maximumFramesPerSecond * 1.25 :
                    null
            };
            const options = createOptions({
                mediaSource: {
                    Container: 'mkv',
                    DefaultAudioStreamIndex: 1,
                    MediaStreams: [
                        {
                            BitDepth: 10,
                            BitRate: 24_000_000,
                            BlPresentFlag: true,
                            Codec: 'hevc',
                            DvBlSignalCompatibilityId: 0,
                            DvProfile: 5,
                            ElPresentFlag: false,
                            Height: 2_076,
                            Index: 0,
                            IsInterlaced: false,
                            Level: 150,
                            Profile: 'Main 10',
                            RealFrameRate: streamFrameRate,
                            RpuPresentFlag: true,
                            Type: 'Video',
                            VideoRange: 'HDR',
                            VideoRangeType: 'DOVI',
                            Width: 3_840
                        },
                        {
                            Channels: 2,
                            Codec: 'flac',
                            Index: 1,
                            SampleRate: 48_000,
                            Type: 'Audio'
                        }
                    ],
                    RunTimeTicks: 60_000_000
                }
            });

            const result = getCustomPlaybackEligibility(
                options,
                capabilities,
                {
                    allowDolbyVision: false,
                    allowNativeDolbyVision: true,
                    allowRawHDR: false,
                    runtimeAvailability: AVAILABLE_RUNTIME
                }
            );

            expect(result.eligible).toBe(expectedEligible);
            if (expectedEligible) {
                expect(result).toMatchObject({
                    videoDecoderBackend: 'native',
                    videoOutputMode: 'video-frame'
                });
            } else {
                expect(result).toEqual({
                    eligible: false,
                    reason: 'hdr-presentation-unavailable'
                });
            }
        }
    );

    it('requires the separately authorized Profile 7 presentation route', () => {
        const profile7Options = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        BitDepth: 10,
                        BitRate: 10_000_000,
                        BlPresentFlag: true,
                        Codec: 'hevc',
                        DvBlSignalCompatibilityId: 6,
                        DvProfile: 7,
                        ElPresentFlag: true,
                        Height: 1_080,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 120,
                        Profile: 'Main 10',
                        RealFrameRate: 24,
                        RpuPresentFlag: true,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'DOVIWithEL',
                        Width: 1_920
                    },
                    { Channels: 2, Codec: 'flac', Index: 1, SampleRate: 48_000, Type: 'Audio' }
                ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            profile7Options,
            createCapabilities(),
            {
                allowDolbyVision: true,
                allowDolbyVisionProfile7: false,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toEqual({ eligible: false, reason: 'hdr-presentation-unavailable' });
        expect(getCustomPlaybackEligibility(
            profile7Options,
            createCapabilities(),
            {
                allowDolbyVision: false,
                allowDolbyVisionProfile7: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            dolbyVisionProfile: 7,
            eligible: true,
            hdr: true,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
    });

    it('falls back from bounded raw Profile 7 to its authorized 4K HDR10 base', () => {
        const profile7Options = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        AverageFrameRate: 23.976025,
                        BitDepth: 10,
                        BitRate: 96_900_000,
                        BlPresentFlag: true,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt2020',
                        ColorRange: 'tv',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        DvBlSignalCompatibilityId: 6,
                        DvProfile: 7,
                        ElPresentFlag: true,
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        RealFrameRate: 23.976025,
                        RpuPresentFlag: true,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'DOVIWithEL',
                        Width: 3_840
                    },
                    {
                        BitDepth: 24,
                        Channels: 2,
                        Codec: 'flac',
                        Index: 1,
                        SampleRate: 48_000,
                        Type: 'Audio'
                    }
                ],
                RunTimeTicks: 60_000_000
            }
        });
        const capabilities = createCapabilities();
        capabilities.rawHDRVideo.hevc.codecString = 'hvc1.2.4.L120.B0';
        capabilities.rawHDRVideo.hevc.maximumCodedHeight = 1_080;
        capabilities.rawHDRVideo.hevc.maximumCodedWidth = 1_920;
        const eligibilityOptions = {
            allowDolbyVisionProfile7: true,
            allowNativeDolbyVisionProfile7HDR10Base: true,
            allowNativeHDR: true,
            allowRawHDR: false,
            authorizedExternalHDRRouteKeys: [
                'external-hevc-main10-bt709-limited:pq-v1'
            ] as const,
            runtimeAvailability: AVAILABLE_RUNTIME
        };

        expect(getCustomPlaybackEligibility(
            profile7Options,
            capabilities,
            eligibilityOptions
        )).toMatchObject({
            dolbyVisionProfile: null,
            eligible: true,
            hdr: true,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            rawVideoFrameFormat: null,
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame'
        });

        const mediaSource = profile7Options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0].Height = 1_080;
        mediaSource.MediaStreams[0].Level = 120;
        mediaSource.MediaStreams[0].Width = 1_920;
        expect(getCustomPlaybackEligibility(
            profile7Options,
            capabilities,
            eligibilityOptions
        )).toMatchObject({
            dolbyVisionProfile: 7,
            eligible: true,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
    });

    it('selects the base track from Jellyfin separate-track Profile 7 metadata', () => {
        const profile7Options = createOptions({
            mediaSource: {
                Container: 'mp4',
                DefaultAudioStreamIndex: 2,
                MediaStreams: [
                    {
                        AverageFrameRate: 24,
                        BitDepth: 10,
                        BitRate: 24_000_000,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt2020',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'HDR10',
                        Width: 3_840
                    },
                    {
                        AverageFrameRate: 24,
                        BitDepth: 10,
                        BlPresentFlag: 0,
                        Codec: 'hevc',
                        DvBlSignalCompatibilityId: 6,
                        DvProfile: 7,
                        ElPresentFlag: 1,
                        Height: 1_080,
                        Index: 1,
                        IsInterlaced: false,
                        Level: 153,
                        Profile: 'Main 10',
                        RpuPresentFlag: 1,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'DOVIWithEL',
                        Width: 1_920
                    },
                    {
                        Channels: 2,
                        Codec: 'aac',
                        Index: 2,
                        SampleRate: 48_000,
                        Type: 'Audio'
                    }
                ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            profile7Options,
            createCapabilities(),
            {
                allowDolbyVisionProfile7: true,
                allowRawHDR: false,
                runtimeAvailability: AVAILABLE_RUNTIME
            }
        )).toMatchObject({
            audioTrackIndex: 0,
            eligible: true,
            hdr: true,
            rawVideoFrameFormat: 'I420P10',
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        });
    });

    it('rejects multiple independent video tracks', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams.splice(1, 0, {
            AverageFrameRate: 24,
            BitDepth: 8,
            Codec: 'h264',
            Height: 720,
            Index: 2,
            IsInterlaced: false,
            Profile: 'High',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 1_280
        });

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'video-track-unavailable' });
    });

    it.each([
        { codec: 'h264', label: 'H264' },
        { codec: 'hevc', label: 'HEVC' }
    ])('rejects interlaced $label video before starting a decoder', ({ codec }) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0].Codec = codec;
        mediaSource.MediaStreams[0].IsInterlaced = true;

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            PQ_AUTHORIZATION
        )).toEqual({
            eligible: false,
            reason: 'interlaced-video-unsupported'
        });
    });

    it.each([
        { label: 'missing', value: undefined },
        { label: 'null', value: null },
        { label: 'string false', value: 'false' },
        { label: 'numeric zero', value: 0 }
    ])('rejects $label interlace metadata before starting a decoder', ({ value }) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        if (value === undefined) {
            delete mediaSource.MediaStreams[0].IsInterlaced;
        } else {
            mediaSource.MediaStreams[0].IsInterlaced = value;
        }

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            PQ_AUTHORIZATION
        )).toEqual({
            eligible: false,
            reason: 'interlaced-video-unsupported'
        });
    });

    it('requires an exact copyable raw HDR codec, format, and resolution capability', () => {
        const hdrOptions = createOptions({
            mediaSource: {
                Container: 'mkv',
                MediaStreams: [ {
                    AverageFrameRate: 24,
                    BitDepth: 10,
                    Codec: 'vp9',
                    ColorPrimaries: 'bt2020',
                    ColorSpace: 'bt2020nc',
                    ColorTransfer: 'smpte2084',
                    Height: 2_160,
                    Index: 0,
                    IsInterlaced: false,
                    Profile: 'Profile 2',
                    Type: 'Video',
                    VideoRangeType: 'HDR10',
                    Width: 3_840
                } ],
                RunTimeTicks: 60_000_000
            }
        });
        const baseCapabilities = createCapabilities();
        const rawHDRVideoCapabilities = baseCapabilities.rawHDRVideo;
        const unsupportedCapabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            rawHDRVideo: {
                ...rawHDRVideoCapabilities,
                vp9: {
                    ...rawHDRVideoCapabilities.vp9,
                    reason: 'output-copy-unsupported',
                    status: 'unsupported'
                }
            }
        };

        expect(getCustomPlaybackEligibility(
            hdrOptions,
            unsupportedCapabilities,
            PQ_AUTHORIZATION
        )).toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });

        const mediaSource = hdrOptions.mediaSource as {
            MediaStreams: Array<{ Width: number }>
        };
        mediaSource.MediaStreams[0].Width = 7_680;
        expect(getCustomPlaybackEligibility(
            hdrOptions,
            baseCapabilities,
            PQ_AUTHORIZATION
        )).toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });
    });

    it('selects the authorized raw HEVC route for HDR10+ input', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0] = {
            AverageFrameRate: 24,
            BitDepth: 10,
            Codec: 'hevc',
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            Hdr10PlusPresentFlag: true,
            Height: 2_160,
            Index: 0,
            IsInterlaced: false,
            Level: 153,
            Profile: 'Main 10',
            Type: 'Video',
            VideoRangeType: 'HDR10Plus',
            Width: 3_840
        };

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            PQ_AUTHORIZATION
        )).toMatchObject({
            eligible: true,
            hdr: true,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        });
    });

    it.each([
        [ 'missing rate', undefined, undefined, false ],
        [ 'non-finite real rate', Number.NaN, 24, false ],
        [ 'excessive real rate', 31, undefined, false ],
        [ 'numeric average fallback', undefined, 30, true ],
        [ 'string average fallback', undefined, '24', false ],
        [ 'real rate preference', 30, 60, true ]
    ])(
        'requires bounded numeric raw HDR frame rate: %s',
        (_label, realFrameRate, averageFrameRate, expectedEligible) => {
            const options = createOptions({
                mediaSource: {
                    Container: 'mkv',
                    MediaStreams: [ {
                        AverageFrameRate: averageFrameRate,
                        BitDepth: 10,
                        Codec: 'vp9',
                        ColorPrimaries: 'bt2020',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Profile: 'Profile 2',
                        RealFrameRate: realFrameRate,
                        Type: 'Video',
                        VideoRangeType: 'HDR10',
                        Width: 3_840
                    } ],
                    RunTimeTicks: 60_000_000
                }
            });

            const result = getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                PQ_AUTHORIZATION
            );
            expect(result.eligible).toBe(expectedEligible);
            if (!expectedEligible) {
                expect(result).toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });
            }
        }
    );

    it.each([
        { expectedEligible: true, maximumFramesPerSecond: 24 as const, streamFrameRate: 24 },
        { expectedEligible: false, maximumFramesPerSecond: 24 as const, streamFrameRate: 24.001 },
        { expectedEligible: true, maximumFramesPerSecond: 30 as const, streamFrameRate: 30 },
        { expectedEligible: true, maximumFramesPerSecond: 60 as const, streamFrameRate: 60 },
        { expectedEligible: false, maximumFramesPerSecond: 60 as const, streamFrameRate: 60.001 },
        { expectedEligible: false, maximumFramesPerSecond: 0 as const, streamFrameRate: 24 }
    ])(
        'enforces the qualified $maximumFramesPerSecond fps raw HDR tier at $streamFrameRate fps',
        ({ expectedEligible, maximumFramesPerSecond, streamFrameRate }) => {
            const capabilities = createCapabilities();
            capabilities.rawHDRVideo = {
                ...capabilities.rawHDRVideo,
                vp9: {
                    ...capabilities.rawHDRVideo.vp9,
                    maximumFramesPerSecond,
                    measuredFramesPerSecond: maximumFramesPerSecond > 0 ?
                        maximumFramesPerSecond * 1.25 :
                        null
                }
            };
            const options = createOptions({
                mediaSource: {
                    Container: 'mkv',
                    MediaStreams: [ {
                        AverageFrameRate: streamFrameRate,
                        BitDepth: 10,
                        Codec: 'vp9',
                        ColorPrimaries: 'bt2020',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        Height: 2_160,
                        Index: 0,
                        IsInterlaced: false,
                        Profile: 'Profile 2',
                        Type: 'Video',
                        VideoRangeType: 'HDR10',
                        Width: 3_840
                    } ],
                    RunTimeTicks: 60_000_000
                }
            });

            const result = getCustomPlaybackEligibility(
                options,
                capabilities,
                PQ_AUTHORIZATION
            );

            expect(result.eligible).toBe(expectedEligible);
            if (!expectedEligible) {
                expect(result).toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });
            }
        }
    );

    it('uses the exact qualified Main10 1080p tier without authorizing 4K', () => {
        const baseCapabilities = createCapabilities();
        const bundledHEVC = createBundledHEVCCapabilities();
        const capabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            bundledHEVC: {
                ...bundledHEVC,
                reason: 'partial',
                tiers: {
                    ...bundledHEVC.tiers,
                    'main10-4k': {
                        ...bundledHEVC.tiers['main10-4k'],
                        reason: 'throughput-insufficient',
                        status: 'unsupported'
                    }
                }
            },
            rawHDRVideo: {
                ...baseCapabilities.rawHDRVideo,
                hevc: {
                    ...baseCapabilities.rawHDRVideo.hevc,
                    codecString: 'hvc1.2.4.L120.B0',
                    maximumCodedHeight: 1_080,
                    maximumCodedWidth: 1_920
                }
            }
        };
        const options = createOptions({
            mediaSource: {
                Container: 'mkv',
                MediaStreams: [ {
                    BitDepth: 10,
                    BitRate: 12_000_000,
                    Codec: 'hevc',
                    ColorPrimaries: 'bt2020',
                    ColorSpace: 'bt2020nc',
                    ColorTransfer: 'smpte2084',
                    Height: 1_080,
                    Index: 0,
                    IsInterlaced: false,
                    Level: 120,
                    Profile: 'Main 10',
                    RealFrameRate: 24,
                    Type: 'Video',
                    VideoRangeType: 'HDR10',
                    Width: 1_920
                } ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            options,
            capabilities,
            PQ_AUTHORIZATION
        )).toMatchObject({
            eligible: true,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            videoDecoderBackend: 'bundled-hevc'
        });

        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0].Height = 2_160;
        mediaSource.MediaStreams[0].Width = 3_840;
        expect(getCustomPlaybackEligibility(
            options,
            capabilities,
            PQ_AUTHORIZATION
        )).toEqual({ eligible: false, reason: 'hdr-codec-unsupported' });
    });

    it('bounds native decode to the probed resolution, bit depth, and codec profile', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        const videoStream = mediaSource.MediaStreams[0];

        videoStream.Width = 3_840;
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });

        videoStream.Width = 1_920;
        videoStream.Profile = 'Main';
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({ eligible: true, videoOutputMode: 'video-frame' });

        const capabilitiesWithoutMain = createCapabilities();
        const h264Profiles = capabilitiesWithoutMain.h264Profiles as H264ProfileCapabilities;
        const mainCapability = h264Profiles.main;
        const exactProfileCapabilities: CustomDecodeCapabilities = {
            ...capabilitiesWithoutMain,
            h264Profiles: {
                ...h264Profiles,
                main: {
                    ...mainCapability,
                    evidence: 'configuration',
                    reason: 'config-supported-only',
                    status: 'unknown'
                }
            }
        };
        expect(getCustomPlaybackEligibility(
            options,
            exactProfileCapabilities,
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });

        videoStream.Profile = 'High';
        videoStream.BitDepth = 10;
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
    });

    it.each([
        { codec: 'hevc', profile: 'Main' },
        { codec: 'vp9', profile: 'Profile 0' },
        { codec: 'av1', profile: 'Main' }
    ] as const)(
        'selects exact native Ultra HD $codec limits',
        ({ codec, profile }) => {
            const baseCapabilities: CustomDecodeCapabilities = createCapabilities();
            const capabilities: CustomDecodeCapabilities = {
                ...baseCapabilities,
                nativeUltraHDVideo: createNativeUltraHDVideoCapabilities(
                    new Set([ codec ])
                )
            };
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[0] = {
                BitDepth: 8,
                Codec: codec,
                Height: 2_160,
                Index: 0,
                IsInterlaced: false,
                Profile: profile,
                Type: 'Video',
                VideoRangeType: 'SDR',
                Width: 3_840
            };

            expect(getCustomPlaybackEligibility(
                options,
                capabilities,
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                eligible: true,
                maximumCodedHeight: 2_160,
                maximumCodedWidth: 3_840,
                videoDecoderBackend: 'native',
                videoOutputMode: 'video-frame'
            });

            mediaSource.MediaStreams[0].Width = 3_841;
            expect(getCustomPlaybackEligibility(
                options,
                capabilities,
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'codec-unsupported' });
        }
    );

    it('does not widen native SDR limits without exact Ultra HD output', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[0] = {
            BitDepth: 8,
            Codec: 'hevc',
            Height: 2_160,
            Index: 0,
            IsInterlaced: false,
            Profile: 'Main',
            Type: 'Video',
            VideoRangeType: 'SDR',
            Width: 3_840
        };
        const baseCapabilities: CustomDecodeCapabilities = createCapabilities();
        const capabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            nativeUltraHDVideo: createNativeUltraHDVideoCapabilities(new Set())
        };

        expect(getCustomPlaybackEligibility(
            options,
            capabilities,
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'codec-unsupported' });
    });

    it('uses only source-path-specific runtime requirements', () => {
        const bundledOptions = createOptions();
        const mediaSource = bundledOptions.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[0] = {
            BitDepth: 10,
            BitRate: 40_000_000,
            Codec: 'hevc',
            ColorPrimaries: 'bt2020',
            ColorSpace: 'bt2020nc',
            ColorTransfer: 'smpte2084',
            Height: 2_160,
            Index: 0,
            IsInterlaced: false,
            Level: 153,
            Profile: 'Main 10',
            RealFrameRate: 24,
            Type: 'Video',
            VideoRangeType: 'HDR10',
            Width: 3_840
        };
        mediaSource.MediaStreams[1].Codec = 'ac3';
        const bundledRuntime: CustomPlaybackRuntimeAvailability = {
            available: true,
            environment: {
                ...AVAILABLE_RUNTIME.environment,
                audioData: false,
                audioDecoder: false,
                videoDecoder: false
            },
            reason: null
        };
        const baseCapabilities = createCapabilities();
        const bundledCapabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            video: {
                ...baseCapabilities.video,
                hevc: createCapability('hevc', false)
            }
        };

        expect(getCustomPlaybackEligibility(
            bundledOptions,
            bundledCapabilities,
            {
                allowRawHDR: true,
                authorizedRawHDRRouteKeys: PQ_AUTHORIZATION.authorizedRawHDRRouteKeys,
                runtimeAvailability: bundledRuntime
            }
        )).toMatchObject({ eligible: true, videoOutputMode: 'raw-planes' });

        mediaSource.MediaStreams[1].Codec = 'aac';
        expect(getCustomPlaybackEligibility(
            bundledOptions,
            bundledCapabilities,
            {
                allowRawHDR: true,
                authorizedRawHDRRouteKeys: PQ_AUTHORIZATION.authorizedRawHDRRouteKeys,
                runtimeAvailability: bundledRuntime
            }
        )).toEqual({ eligible: false, reason: 'runtime-unavailable' });

        mediaSource.MediaStreams.splice(1, 1);
        mediaSource.MediaStreams[0].Codec = 'vp9';
        mediaSource.MediaStreams[0].Profile = 'Profile 2';
        expect(getCustomPlaybackEligibility(
            bundledOptions,
            bundledCapabilities,
            {
                allowRawHDR: true,
                authorizedRawHDRRouteKeys: PQ_AUTHORIZATION.authorizedRawHDRRouteKeys,
                runtimeAvailability: bundledRuntime
            }
        )).toEqual({ eligible: false, reason: 'runtime-unavailable' });
    });

    it('requires browser audio output only when an audio track is selected', () => {
        const options = createOptions();
        const noAudioRuntime: CustomPlaybackRuntimeAvailability = {
            available: true,
            environment: {
                ...AVAILABLE_RUNTIME.environment,
                audioContext: false,
                audioWorklet: false
            },
            reason: null
        };

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: noAudioRuntime }
        )).toEqual({ eligible: false, reason: 'runtime-unavailable' });

        const mediaSource = options.mediaSource as {
            DefaultAudioStreamIndex?: number | null
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.DefaultAudioStreamIndex = null;
        mediaSource.MediaStreams.splice(1, 1);
        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: noAudioRuntime }
        )).toMatchObject({ audioTrackIndex: null, eligible: true });
    });

    it('selects only an exact qualified owned native-media audio route', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1] = {
            Channels: 6,
            Codec: 'eac3',
            Index: 1,
            SampleRate: 48_000,
            Type: 'Audio'
        };
        const baseCapabilities = createCapabilities();
        const capabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            audio: {
                ...baseCapabilities.audio,
                eac3: createCapability('eac3', false)
            }
        };
        const nativeMediaAudioCapabilities = createNativeMediaAudioCapabilities(
            new Set([ 'eac3:6:48000' ])
        );
        const nativeOnlyRuntime: CustomPlaybackRuntimeAvailability = {
            available: true,
            environment: {
                ...AVAILABLE_RUNTIME.environment,
                audioContext: false,
                audioData: false,
                audioDecoder: false,
                audioWorklet: false
            },
            reason: null
        };

        expect(getCustomPlaybackEligibility(options, capabilities, {
            allowRawHDR: false,
            nativeMediaAudioCapabilities,
            runtimeAvailability: nativeOnlyRuntime
        })).toMatchObject({
            audioOutputMode: 'native-media',
            audioTrackIndex: 0,
            eligible: true
        });

        mediaSource.MediaStreams[1].Channels = 2;
        expect(getCustomPlaybackEligibility(options, capabilities, {
            allowRawHDR: false,
            nativeMediaAudioCapabilities,
            runtimeAvailability: nativeOnlyRuntime
        })).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });
    });

    it('prefers qualified native media over bundled PCM for the same layout', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1].Codec = 'ac3';

        expect(getCustomPlaybackEligibility(options, createCapabilities(), {
            allowRawHDR: false,
            nativeMediaAudioCapabilities: createNativeMediaAudioCapabilities(
                new Set([ 'ac3:2:48000' ])
            ),
            runtimeAvailability: AVAILABLE_RUNTIME
        })).toMatchObject({
            audioOutputMode: 'native-media',
            eligible: true
        });
    });

    it('selects decoded PCM for qualified 5.1 AC-3 input', () => {
        for (const codec of [ 'ac3', 'eac3' ] as const) {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[1].Channels = 6;
            mediaSource.MediaStreams[1].Codec = codec;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                audioSourceChannelCount: 6,
                audioTrackIndex: 0,
                eligible: true
            });
        }
    });

    it.each([
        [ 'DTS', 6, 48_000 ],
        [ 'DTS 96/24', 6, 96_000 ],
        [ 'DTS-ES', 7, 48_000 ],
        [ 'DTS-HD HRA', 8, 48_000 ],
        [ 'DTS-HD MA', 8, 48_000 ],
        [ 'DTS-HD MA', 6, 96_001 ],
        [ 'DTS-HD MA', 6, 192_000 ],
        [ 'DTS-HD MA + DTS:X', 8, 48_000 ],
        [ 'DTS', 6, 12_345 ]
    ] as const)(
        'selects the fixture-derived Matroska DTS channel-bed route for %s',
        (profile, channelCount, sampleRate) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = 'mkv';
            mediaSource.MediaStreams[1].Channels = channelCount;
            mediaSource.MediaStreams[1].Codec = 'dts';
            mediaSource.MediaStreams[1].Profile = profile;
            mediaSource.MediaStreams[1].SampleRate = sampleRate;
            const bundledRuntime: CustomPlaybackRuntimeAvailability = {
                available: true,
                environment: {
                    ...AVAILABLE_RUNTIME.environment,
                    audioData: false,
                    audioDecoder: false
                },
                reason: null
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: bundledRuntime }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                audioTrackIndex: 0,
                eligible: true
            });
        }
    );

    it('accepts the Matroska DCA alias through the same DTS route', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'matroska';
        mediaSource.MediaStreams[1].Channels = 6;
        mediaSource.MediaStreams[1].Codec = 'dca';
        mediaSource.MediaStreams[1].Profile = 'DTS';

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            audioOutputMode: 'decoded-pcm',
            eligible: true
        });
    });

    it.each([ 96_001, 192_000 ])(
        'limits %i Hz DTS to the 5.1-channel Master Audio bed',
        sampleRate => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = 'mkv';
            mediaSource.MediaStreams[1].Channels = 8;
            mediaSource.MediaStreams[1].Codec = 'dts';
            mediaSource.MediaStreams[1].Profile = 'DTS-HD MA';
            mediaSource.MediaStreams[1].SampleRate = sampleRate;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });

            mediaSource.MediaStreams[1].Channels = 6;
            mediaSource.MediaStreams[1].Profile = 'DTS-HD HRA';
            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });
        }
    );

    it.each([ 'm2ts', 'mts', 'ts' ] as const)(
        'does not advertise DTS in the unsupported Mediabunny %s demux route',
        container => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[1].Channels = 8;
            mediaSource.MediaStreams[1].Codec = 'dts';
            mediaSource.MediaStreams[1].Profile = 'DTS-HD MA';

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'container-unsupported' });
        }
    );

    it('rejects unqualified DTS profiles and missing exact decoder evidence', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[1].Channels = 8;
        mediaSource.MediaStreams[1].Codec = 'dts';
        mediaSource.MediaStreams[1].Profile = 'DTS-UHD';

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });

        mediaSource.MediaStreams[1].Profile = 'DTS-HD MA';
        const baseCapabilities = createCapabilities();
        const unqualifiedCapabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            audio: {
                ...baseCapabilities.audio,
                dts: createCapability('dts', false)
            },
            bundledDTS: {
                ...createBundledDTSCapability(),
                reason: 'output-mismatch',
                status: 'unsupported',
                verifiedFixtureCount: 5,
                verifiedProfileMask: 0x0f
            }
        };
        expect(getCustomPlaybackEligibility(
            options,
            unqualifiedCapabilities,
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-codec-unsupported' });
    });

    it.each([
        [ 'mkv', 'truehd', 'Dolby TrueHD', 2, 48_000 ],
        [ 'matroska', 'truehd', 'Dolby TrueHD + Dolby Atmos', 6, 96_000 ],
        [ 'mkv', 'mlp', undefined, 2, 48_000 ]
    ] as const)(
        'selects the fixture-derived %s/%s TrueHD channel-bed route',
        (container, codec, profile, channelCount, sampleRate) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[1].Channels = channelCount;
            mediaSource.MediaStreams[1].Codec = codec;
            mediaSource.MediaStreams[1].Profile = profile;
            mediaSource.MediaStreams[1].SampleRate = sampleRate;
            const bundledRuntime: CustomPlaybackRuntimeAvailability = {
                available: true,
                environment: {
                    ...AVAILABLE_RUNTIME.environment,
                    audioData: false,
                    audioDecoder: false
                },
                reason: null
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: bundledRuntime }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                audioTrackIndex: 0,
                eligible: true
            });
        }
    );

    it('rejects unqualified TrueHD layouts and missing exact decoder evidence', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            Container: string
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.Container = 'mkv';
        mediaSource.MediaStreams[1].Channels = 8;
        mediaSource.MediaStreams[1].Codec = 'truehd';
        mediaSource.MediaStreams[1].Profile = 'Dolby TrueHD + Dolby Atmos';
        mediaSource.MediaStreams[1].SampleRate = 48_000;

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });

        mediaSource.MediaStreams[1].Channels = 6;
        const baseCapabilities = createCapabilities();
        const capabilitiesWithoutExactEvidence: CustomDecodeCapabilities = {
            ...baseCapabilities,
            audio: {
                ...baseCapabilities.audio,
                truehd: createCapability('truehd', false)
            },
            bundledTrueHD: {
                ...createBundledTrueHDCapability(),
                majorSyncRecoveryVerified: false,
                reason: 'major-sync-recovery-failed',
                status: 'unsupported',
                verifiedFixtureCount: 3
            }
        };
        expect(getCustomPlaybackEligibility(
            options,
            capabilitiesWithoutExactEvidence,
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-codec-unsupported' });
    });

    it.each([ 'mp4', 'm2ts', 'mts', 'ts' ] as const)(
        'does not advertise TrueHD in the unsupported Mediabunny %s demux route',
        container => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[1].Channels = 6;
            mediaSource.MediaStreams[1].Codec = 'truehd';
            mediaSource.MediaStreams[1].SampleRate = 96_000;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason: 'container-unsupported' });
        }
    );

    it.each([
        [ 'mkv', 'pcm_s24le', 1, 44_100 ],
        [ 'mkv', 'pcm_f64le', 6, 96_000 ],
        [ 'mov', 'pcm_s8', 2, 192_000 ],
        [ 'mov', 'pcm_s24le', 2, 12_345 ],
        [ 'mov', 'pcm_mulaw', 1, 8_000 ],
        [ 'mov', 'pcm_alaw', 1, 8_000 ]
    ] as const)(
        'selects Mediabunny PCM for %s/%s at %i channels and %i Hz',
        (container, codec, channelCount, sampleRate) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[1].Channels = channelCount;
            mediaSource.MediaStreams[1].Codec = codec;
            mediaSource.MediaStreams[1].SampleRate = sampleRate;
            const PCMRuntime: CustomPlaybackRuntimeAvailability = {
                available: true,
                environment: {
                    ...AVAILABLE_RUNTIME.environment,
                    audioData: false,
                    audioDecoder: false
                },
                reason: null
            };

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: PCMRuntime }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                audioTrackIndex: 0,
                eligible: true
            });
        }
    );

    it.each([
        [ 'mkv', 'pcm_s8', 2, 48_000, 'container-unsupported' ],
        [ 'mkv', 'pcm_f32be', 2, 48_000, 'container-unsupported' ],
        [ 'mp4', 'pcm_alaw', 1, 8_000, 'container-unsupported' ],
        [ 'mov', 'pcm_s24le', 8, 48_000, 'audio-layout-unsupported' ],
        [ 'mov', 'pcm_s24le', 2, 2_999, 'audio-layout-unsupported' ],
        [ 'mov', 'pcm_s24le', 2, 192_001, 'audio-layout-unsupported' ]
    ] as const)(
        'rejects unimplemented PCM route %s/%s/%i/%i',
        (container, codec, channelCount, sampleRate, reason) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                Container: string
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.Container = container;
            mediaSource.MediaStreams[1].Channels = channelCount;
            mediaSource.MediaStreams[1].Codec = codec;
            mediaSource.MediaStreams[1].SampleRate = sampleRate;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toEqual({ eligible: false, reason });
        }
    );

    it.each([ 'aac', 'opus', 'flac', 'vorbis' ] as const)(
        'selects decoded PCM for exact qualified native 5.1 %s input',
        codec => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[1].Channels = 6;
            mediaSource.MediaStreams[1].Codec = codec;
            const capabilities: CustomDecodeCapabilities = {
                ...createCapabilities(),
                nativeSurroundAudio: createNativeSurroundAudioCapabilities(
                    new Set([ codec ])
                )
            };

            expect(getCustomPlaybackEligibility(
                options,
                capabilities,
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                audioTrackIndex: 0,
                eligible: true
            });
        }
    );

    it.each([
        [ undefined, 3_000 ],
        [ 1, 12_345 ],
        [ 50_000_000, 96_000 ],
        [ 1_500_000_000, 192_000 ]
    ] as const)(
        'ignores encoded audio bitrate %s at bounded source rate %i',
        (bitrate, sampleRate) => {
            const options = createOptions();
            const mediaSource = options.mediaSource as {
                MediaStreams: Array<Record<string, unknown>>
            };
            mediaSource.MediaStreams[1].BitRate = bitrate;
            mediaSource.MediaStreams[1].SampleRate = sampleRate;

            expect(getCustomPlaybackEligibility(
                options,
                createCapabilities(),
                { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
            )).toMatchObject({
                audioOutputMode: 'decoded-pcm',
                eligible: true
            });
        }
    );

    it('does not apply the surround downmix claim without exact output evidence', () => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1].Channels = 6;
        mediaSource.MediaStreams[1].Codec = 'aac';

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });
    });

    it.each([
        [ 6, 48_000 ],
        [ 2, 2_999 ],
        [ 2, 192_001 ],
        [ undefined, 48_000 ],
        [ 2, undefined ]
    ])('rejects an unmeasured selected audio layout %#', (channelCount, sampleRate) => {
        const options = createOptions();
        const mediaSource = options.mediaSource as {
            MediaStreams: Array<Record<string, unknown>>
        };
        mediaSource.MediaStreams[1].Channels = channelCount;
        mediaSource.MediaStreams[1].SampleRate = sampleRate;

        expect(getCustomPlaybackEligibility(
            options,
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-layout-unsupported' });
    });

    it.each([
        [ { playMethod: 'Transcode' }, 'play-method-unsupported' ],
        [ { mediaSource: { Container: 'avi', MediaStreams: [], RunTimeTicks: 1 } }, 'container-unsupported' ],
        [ { url: 'file:///movie.mkv' }, 'url-unsupported' ],
        [ { url: 'http://user:password@localhost/movie.mkv' }, 'url-unsupported' ]
    ])('rejects unsafe source overrides %#', (overrides, reason) => {
        expect(getCustomPlaybackEligibility(
            createOptions(overrides),
            createCapabilities(),
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason });
    });

    it('requires the full runtime and measured selected codecs', () => {
        const baseCapabilities = createCapabilities();
        const capabilities: CustomDecodeCapabilities = {
            ...baseCapabilities,
            audio: {
                ...baseCapabilities.audio,
                aac: createCapability('aac', false)
            }
        };
        expect(getCustomPlaybackEligibility(
            createOptions(),
            capabilities,
            { allowRawHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-codec-unsupported' });

        expect(getCustomPlaybackEligibility(
            createOptions(),
            createCapabilities(),
            {
                allowRawHDR: false,
                runtimeAvailability: {
                    ...AVAILABLE_RUNTIME,
                    available: false,
                    reason: 'webgpu-unavailable'
                }
            }
        )).toEqual({ eligible: false, reason: 'runtime-unavailable' });
    });
});
