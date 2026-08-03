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
import { getCustomPlaybackEligibility } from './CustomPlaybackEligibility';
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
                maximumBitrate: 12_000_000,
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
                maximumBitrate: 12_000_000,
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
                maximumBitrate: 40_000_000,
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
        bundledHEVC: createBundledHEVCCapabilities(),
        h264Profiles: createH264ProfileCapabilities(),
        nativeDolbyVisionHEVC: {
            bitDepth: 10,
            codec: 'hevc',
            codecString: 'hev1.2.4.H150.B0',
            maximumBitrate: 40_000_000,
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
            maximumBitrate: 40_000_000,
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

describe('CustomPlaybackEligibility', () => {
    it('uses the exact bundled HEVC Main tier when native HEVC is unavailable', () => {
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
        [ 'excessive level', { Level: 121 } ],
        [ 'missing bitrate', { BitRate: undefined } ],
        [ 'excessive bitrate', { BitRate: 12_000_001 } ]
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
        { field: 'BitRate', label: 'bitrate', value: 40_000_001 },
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
            eligible: true,
            hdr: true,
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
                audioTrackIndex: 0,
                eligible: true
            });
        }
    });

    it.each([
        [ 'mkv', 'pcm_s24le', 1, 44_100 ],
        [ 'mkv', 'pcm_f64le', 6, 96_000 ],
        [ 'mov', 'pcm_s8', 2, 192_000 ],
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
        [ 'mov', 'pcm_s24le', 2, 12_345, 'audio-layout-unsupported' ]
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
        [ 2, 44_100 ],
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
