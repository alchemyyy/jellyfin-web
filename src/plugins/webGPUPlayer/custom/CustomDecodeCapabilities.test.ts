import { afterEach, describe, expect, it, vi } from 'vitest';

import CustomDecodeCapabilityProbe, {
    createNativeAudioOutputProbe,
    createNativeDolbyVisionVideoOutputProbe,
    createNativeHDRVideoOutputProbe,
    createNativeVideoOutputProbe,
    createRawHDRVideoOutputProbe,
    CUSTOM_BUNDLED_AUDIO_CODECS,
    CUSTOM_NATIVE_SURROUND_AUDIO_CODECS,
    CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS,
    CUSTOM_RAW_HDR_VIDEO_CODECS,
    CUSTOM_VIDEO_CODECS,
    CUSTOM_WEB_CODECS_AUDIO_CODECS,
    getQualifiedHDRMaximumFramesPerSecond,
    type NativeDolbyVisionVideoOutputProbeRequest,
    type NativeDolbyVisionVideoOutputProbeResult,
    type RawHDRVideoOutputProbeResult,
    type WebCodecsCapabilityEnvironment
} from './CustomDecodeCapabilities';
import type {
    BundledHEVCExactCapabilities,
    BundledHEVCExactTierCapability
} from './HEVCExactCapabilityProbe';
import type { HEVCExactCapabilityTier } from './HEVCExactCapabilityProtocol';

type CapabilityEnvironmentHarness = {
    audioProbe: ReturnType<typeof vi.fn>
    environment: WebCodecsCapabilityEnvironment
    nativeAudioOutputProbe: ReturnType<typeof vi.fn>
    nativeDolbyVisionVideoOutputProbe: ReturnType<typeof vi.fn>
    nativeHDRVideoOutputProbe: ReturnType<typeof vi.fn>
    nativeVideoOutputProbe: ReturnType<typeof vi.fn>
    rawHDRVideoOutputProbe: ReturnType<typeof vi.fn>
    videoProbe: ReturnType<typeof vi.fn>
};

type NativeSurroundAudioSupport = Readonly<{
    configuration: ReadonlySet<string>
    output?: ReadonlySet<string>
}>;

const CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 2_000;

describe('raw HDR frame-rate qualification', () => {
    it.each([
        { expected: 60, measuredFramesPerSecond: 75 },
        { expected: 30, measuredFramesPerSecond: 74.999 },
        { expected: 30, measuredFramesPerSecond: 37.5 },
        { expected: 24, measuredFramesPerSecond: 37.499 },
        { expected: 24, measuredFramesPerSecond: 30 },
        { expected: null, measuredFramesPerSecond: 29.999 },
        { expected: null, measuredFramesPerSecond: 0 },
        { expected: null, measuredFramesPerSecond: Number.NaN },
        { expected: null, measuredFramesPerSecond: Number.POSITIVE_INFINITY }
    ])(
        'maps $measuredFramesPerSecond measured fps to $expected',
        ({ expected, measuredFramesPerSecond }) => {
            expect(getQualifiedHDRMaximumFramesPerSecond(
                measuredFramesPerSecond
            )).toBe(expected);
        }
    );
});

function getBundledHEVCCodecString(
    tier: HEVCExactCapabilityTier
): BundledHEVCExactTierCapability['codecString'] {
    switch (tier) {
        case 'main-1080p':
            return 'hvc1.1.6.L120.B0';
        case 'main10-1080p':
            return 'hvc1.2.4.L120.B0';
        case 'main10-4k':
            return 'hvc1.2.4.L153.B0';
    }
}

function createBundledHEVCTier(
    tier: HEVCExactCapabilityTier,
    supported: boolean
): BundledHEVCExactTierCapability {
    const main10 = tier !== 'main-1080p';
    const ultraHD = tier === 'main10-4k';
    return Object.freeze({
        bitDepth: main10 ? 10 : 8,
        codecString: getBundledHEVCCodecString(tier),
        decodeMilliseconds: supported ? 100 : null,
        format: main10 ? 'I420P10' : 'I420',
        framesPerSecond: supported ? 40 : null,
        maximumCodedHeight: ultraHD ? 2_160 : 1_080,
        maximumCodedWidth: ultraHD ? 3_840 : 1_920,
        maximumLevel: ultraHD ? 153 : 120,
        minimumFramesPerSecond: 30,
        profile: main10 ? 'main10' : 'main',
        reason: supported ? 'decode-output-verified' : 'decode-error',
        status: supported ? 'supported' : 'unsupported',
        tier
    });
}

function createBundledHEVCCapabilities(
    mainSupported = true,
    main10FullHDSupported = true,
    main10UltraHDSupported = true
): BundledHEVCExactCapabilities {
    const supportedCount = Number(mainSupported)
        + Number(main10FullHDSupported)
        + Number(main10UltraHDSupported);
    let reason: BundledHEVCExactCapabilities['reason'] = 'failed';
    if (supportedCount === 3) {
        reason = 'complete';
    } else if (supportedCount > 0) {
        reason = 'partial';
    }
    return Object.freeze({
        reason,
        tiers: Object.freeze({
            'main-1080p': createBundledHEVCTier('main-1080p', mainSupported),
            'main10-1080p': createBundledHEVCTier(
                'main10-1080p',
                main10FullHDSupported
            ),
            'main10-4k': createBundledHEVCTier('main10-4k', main10UltraHDSupported)
        })
    });
}

const BUNDLED_HEVC_EXACT_CAPABILITIES = createBundledHEVCCapabilities();
const SUPPORTED_DTS_EXACT_CAPABILITY = Object.freeze({
    channelBedOnly: true as const,
    codec: 'dts' as const,
    codecString: 'dts' as const,
    decodeMilliseconds: 8,
    libraryVersion: 131_073,
    maximumChannelCount: 8 as const,
    measuredRealTimeFactor: 32,
    objectAudioRendered: false as const,
    profiles: Object.freeze([
        'core',
        'core-96-24',
        'es',
        'hd-hra',
        'hd-ma'
    ] as const),
    reason: 'decode-output-verified' as const,
    sampleRates: Object.freeze([ 48_000, 96_000, 192_000 ] as const),
    status: 'supported' as const,
    verifiedFixtureCount: 7,
    verifiedProfileMask: 0x1f
});
const SUPPORTED_TRUEHD_EXACT_CAPABILITY = Object.freeze({
    channelBedOnly: true as const,
    channelCounts: Object.freeze([ 2, 6 ] as const),
    codecs: Object.freeze([ 'truehd', 'mlp' ] as const),
    decodeMilliseconds: 12,
    library: 'ffmpeg-libavcodec' as const,
    libraryVersion: 4_079_728,
    majorSyncRecoveryVerified: true,
    measuredRealTimeFactor: 12,
    objectAudioRendered: false as const,
    passthrough: false as const,
    reason: 'decode-output-verified' as const,
    sampleRates: Object.freeze([ 48_000, 96_000, 192_000 ] as const),
    status: 'supported' as const,
    verifiedChannelCountMask: (1 << 2) | (1 << 6),
    verifiedCodecMask: 0x03,
    verifiedFixtureCount: 4,
    verifiedSampleRateMask: 0x07
});
const UNSUPPORTED_JPEG2000_EXACT_CAPABILITY = Object.freeze({
    bitDepth: 8 as const,
    codec: 'jpeg2000' as const,
    codecString: 'mjp2' as const,
    decodeMilliseconds: 400,
    decodedRGBAByteLength: 2_073_600,
    decodedRGBAFingerprint: 1_076_220_778,
    maximumCodedHeight: 540,
    maximumCodedWidth: 960,
    maximumFramesPerSecond: 0 as const,
    measuredFramesPerSecond: 20,
    reason: 'throughput-insufficient' as const,
    status: 'unsupported' as const
});
const SUPPORTED_LEGACY_VIDEO_EXACT_CAPABILITY = Object.freeze({
    codec: 'mpeg2video' as const,
    decodeMilliseconds: 400,
    decodedFrameByteLength: 3_110_400,
    decodedFrameCount: 12,
    decodedI420Fingerprint: 544_635_241,
    decodedTotalByteLength: 37_324_800,
    maximumCodedHeight: 1_080,
    maximumCodedWidth: 1_920,
    maximumFramesPerSecond: 24 as const,
    measuredFramesPerSecond: 35,
    reason: 'decode-output-verified' as const,
    status: 'supported' as const
});
const UNSUPPORTED_LEGACY_VIDEO_EXACT_CAPABILITY = Object.freeze({
    ...SUPPORTED_LEGACY_VIDEO_EXACT_CAPABILITY,
    maximumFramesPerSecond: 0 as const,
    reason: 'output-mismatch' as const,
    status: 'unsupported' as const
});

function createEnvironment(
    videoSupport: ReadonlySet<string>,
    audioSupport: ReadonlySet<string>,
    rawHDRVideoOutputSupport: ReadonlySet<string> = new Set<string>(),
    nativeDolbyVisionVideoOutputSupported = false,
    nativeVideoOutputSupport: ReadonlySet<string> = videoSupport,
    nativeAudioOutputSupport: ReadonlySet<string> = audioSupport,
    nativeSurroundAudioSupport: NativeSurroundAudioSupport = {
        configuration: new Set<string>()
    }
): CapabilityEnvironmentHarness {
    const nativeSurroundAudioOutputSupport = nativeSurroundAudioSupport.output
        ?? nativeSurroundAudioSupport.configuration;
    const videoProbe = vi.fn(async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
        config,
        supported: videoSupport.has(config.codec)
    }));
    const audioProbe = vi.fn(async (config: AudioDecoderConfig): Promise<AudioDecoderSupport> => ({
        config,
        supported: config.numberOfChannels === 6 ?
            nativeSurroundAudioSupport.configuration.has(config.codec) :
            audioSupport.has(config.codec)
    }));
    const rawHDRVideoOutputProbe = vi.fn(async (probeRequest: {
        codec: string
    }): Promise<RawHDRVideoOutputProbeResult> => {
        const outputCopySupported = rawHDRVideoOutputSupport.has(probeRequest.codec);
        return {
            maximumFramesPerSecond: outputCopySupported ? 60 : null,
            measuredFramesPerSecond: outputCopySupported ? 80 : null,
            outputCopySupported
        };
    });
    const nativeDolbyVisionVideoOutputProbe = vi.fn(
        async (): Promise<NativeDolbyVisionVideoOutputProbeResult> => ({
            maximumFramesPerSecond: nativeDolbyVisionVideoOutputSupported ? 60 : null,
            measuredFramesPerSecond: nativeDolbyVisionVideoOutputSupported ? 80 : null,
            outputSupported: nativeDolbyVisionVideoOutputSupported
        })
    );
    const nativeHDRVideoOutputProbe = vi.fn(
        async (): Promise<NativeDolbyVisionVideoOutputProbeResult> => ({
            maximumFramesPerSecond: null,
            measuredFramesPerSecond: null,
            outputSupported: false
        })
    );
    const nativeVideoOutputProbe = vi.fn(async (probeRequest: {
        configuration: VideoDecoderConfig
    }): Promise<boolean> => nativeVideoOutputSupport.has(probeRequest.configuration.codec));
    const nativeAudioOutputProbe = vi.fn(async (probeRequest: {
        configuration: AudioDecoderConfig
    }): Promise<boolean> => (
        probeRequest.configuration.numberOfChannels === 6 ?
            nativeSurroundAudioOutputSupport :
            nativeAudioOutputSupport
    ).has(probeRequest.configuration.codec));
    return {
        audioProbe,
        environment: {
            audioDecoder: { isConfigSupported: audioProbe },
            bundledDTSExactProbe: {
                probe: vi.fn(async () => SUPPORTED_DTS_EXACT_CAPABILITY)
            },
            bundledHEVCExactProbe: {
                probe: vi.fn(async () => BUNDLED_HEVC_EXACT_CAPABILITIES)
            },
            bundledJPEG2000ExactProbe: {
                probe: vi.fn(async () => UNSUPPORTED_JPEG2000_EXACT_CAPABILITY)
            },
            bundledLegacyVideoExactProbe: {
                probe: vi.fn(async () => UNSUPPORTED_LEGACY_VIDEO_EXACT_CAPABILITY)
            },
            bundledTrueHDExactProbe: {
                probe: vi.fn(async () => SUPPORTED_TRUEHD_EXACT_CAPABILITY)
            },
            nativeAudioOutputProbe,
            nativeDolbyVisionVideoOutputProbe,
            nativeHDRVideoOutputProbe,
            nativeVideoOutputProbe,
            rawHDRVideoOutputProbe,
            videoDecoder: { isConfigSupported: videoProbe }
        },
        nativeAudioOutputProbe,
        nativeDolbyVisionVideoOutputProbe,
        nativeHDRVideoOutputProbe,
        nativeVideoOutputProbe,
        rawHDRVideoOutputProbe,
        videoProbe
    };
}

describe('CustomDecodeCapabilityProbe', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('serializes decoder-backed output and exact capability probes', async () => {
        const harness = createEnvironment(new Set<string>(), new Set<string>());
        let activeHeavyProbeCount = 0;
        let heavyProbeInvocationCount = 0;
        let maximumActiveHeavyProbeCount = 0;
        const observeHeavyProbe = async <Value>(value: Value): Promise<Value> => {
            activeHeavyProbeCount += 1;
            heavyProbeInvocationCount += 1;
            maximumActiveHeavyProbeCount = Math.max(
                maximumActiveHeavyProbeCount,
                activeHeavyProbeCount
            );
            try {
                await Promise.resolve();
                return value;
            } finally {
                activeHeavyProbeCount -= 1;
            }
        };
        harness.environment.audioDecoder = {
            isConfigSupported: vi.fn(async (config: AudioDecoderConfig) => ({
                config,
                supported: true
            }))
        };
        harness.environment.videoDecoder = {
            isConfigSupported: vi.fn(async (config: VideoDecoderConfig) => ({
                config,
                supported: true
            }))
        };
        harness.environment.bundledDTSExactProbe = {
            probe: vi.fn(() => observeHeavyProbe(SUPPORTED_DTS_EXACT_CAPABILITY))
        };
        harness.environment.bundledHEVCExactProbe = {
            probe: vi.fn(() => observeHeavyProbe(BUNDLED_HEVC_EXACT_CAPABILITIES))
        };
        harness.environment.bundledJPEG2000ExactProbe = {
            probe: vi.fn(() => observeHeavyProbe(UNSUPPORTED_JPEG2000_EXACT_CAPABILITY))
        };
        harness.environment.bundledLegacyVideoExactProbe = {
            probe: vi.fn(() => observeHeavyProbe(UNSUPPORTED_LEGACY_VIDEO_EXACT_CAPABILITY))
        };
        harness.environment.bundledTrueHDExactProbe = {
            probe: vi.fn(() => observeHeavyProbe(SUPPORTED_TRUEHD_EXACT_CAPABILITY))
        };
        harness.environment.nativeAudioOutputProbe = vi.fn(
            () => observeHeavyProbe(true)
        );
        harness.environment.nativeDolbyVisionVideoOutputProbe = vi.fn(
            () => observeHeavyProbe({
                maximumFramesPerSecond: 60 as const,
                measuredFramesPerSecond: 80,
                outputSupported: true
            })
        );
        harness.environment.nativeHDRVideoOutputProbe = vi.fn(
            () => observeHeavyProbe({
                maximumFramesPerSecond: 60 as const,
                measuredFramesPerSecond: 80,
                outputSupported: true
            })
        );
        harness.environment.nativeVideoOutputProbe = vi.fn(
            () => observeHeavyProbe(true)
        );
        harness.environment.rawHDRVideoOutputProbe = vi.fn(
            () => observeHeavyProbe({
                maximumFramesPerSecond: 60 as const,
                measuredFramesPerSecond: 80,
                outputCopySupported: true
            })
        );

        await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(heavyProbeInvocationCount).toBeGreaterThan(20);
        expect(maximumActiveHeavyProbeCount).toBe(1);
    });

    it('does not start queued heavy probes after the active probe times out', async () => {
        vi.useFakeTimers();
        const supportedAudioCodecs = new Set([
            'mp4a.40.2',
            'opus',
            'flac',
            'mp3',
            'vorbis'
        ]);
        const harness = createEnvironment(new Set<string>(), supportedAudioCodecs);
        const nativeAudioOutputProbe = vi.fn((probeRequest: {
            configuration: AudioDecoderConfig
        }): Promise<boolean> => {
            if (probeRequest.configuration.codec === 'mp4a.40.2') {
                return new Promise<boolean>(() => undefined);
            }
            return Promise.resolve(true);
        });
        harness.environment.bundledDTSExactProbe = null;
        harness.environment.bundledHEVCExactProbe = null;
        harness.environment.bundledJPEG2000ExactProbe = null;
        harness.environment.bundledLegacyVideoExactProbe = null;
        harness.environment.bundledTrueHDExactProbe = null;
        harness.environment.h264ProfileProbe = null;
        harness.environment.nativeAudioOutputProbe = nativeAudioOutputProbe;
        const probePromise = new CustomDecodeCapabilityProbe(harness.environment).probe();

        await vi.advanceTimersByTimeAsync(0);
        expect(nativeAudioOutputProbe).toHaveBeenCalledOnce();
        expect(nativeAudioOutputProbe.mock.calls[0][0].configuration.codec)
            .toBe('mp4a.40.2');

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);
        const capabilities = await probePromise;

        expect(nativeAudioOutputProbe).toHaveBeenCalledOnce();
        expect(capabilities.audio.aac.reason).toBe('probe-timeout');
        expect(capabilities.audio.opus.reason).toBe('probe-timeout');
        expect(capabilities.audio.flac.reason).toBe('probe-timeout');
    });

    it('does not create a native audio output probe without both WebCodecs APIs', () => {
        vi.stubGlobal('AudioDecoder', undefined);
        vi.stubGlobal('EncodedAudioChunk', class FakeEncodedAudioChunk {});
        expect(createNativeAudioOutputProbe()).toBeNull();

        vi.stubGlobal('AudioDecoder', class FakeAudioDecoder {});
        vi.stubGlobal('EncodedAudioChunk', undefined);
        expect(createNativeAudioOutputProbe()).toBeNull();
    });

    it('does not create a native HDR output probe without both WebCodecs APIs', () => {
        vi.stubGlobal('VideoDecoder', undefined);
        vi.stubGlobal('EncodedVideoChunk', class FakeEncodedVideoChunk {});
        expect(createNativeHDRVideoOutputProbe()).toBeNull();

        vi.stubGlobal('VideoDecoder', class FakeVideoDecoder {});
        vi.stubGlobal('EncodedVideoChunk', undefined);
        expect(createNativeHDRVideoOutputProbe()).toBeNull();
    });

    it('probes every representative WebCodecs configuration and records support', async () => {
        const harness = createEnvironment(
            new Set([
                'avc1.640028',
                'vp09.00.51.08',
                'vp09.02.10.10'
            ]),
            new Set([ 'mp4a.40.2', 'flac' ]),
            new Set([ 'vp9' ])
        );
        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(harness.videoProbe.mock.calls.map(call => call[0].codec)).toEqual([
            'avc1.640028',
            'hvc1.1.6.L120.B0',
            'vp8',
            'vp09.00.10.08',
            'av01.0.08M.08',
            'hvc1.1.6.L153.B0',
            'vp09.00.51.08',
            'av01.0.12M.08',
            'hvc1.2.4.L153.B0',
            'vp09.02.10.10',
            'av01.0.08M.10',
            'hev1.2.4.H150.B0',
            'hvc1.2.4.L153.B0'
        ]);
        expect(harness.audioProbe.mock.calls.map(call => call[0].codec)).toEqual([
            'mp4a.40.2',
            'opus',
            'flac',
            'mp3',
            'vorbis',
            'mp4a.40.2',
            'opus',
            'flac',
            'vorbis'
        ]);
        expect(harness.videoProbe.mock.calls[0][0]).toMatchObject({
            codedHeight: 1_080,
            codedWidth: 1_920,
            hardwareAcceleration: 'no-preference',
            optimizeForLatency: true
        });
        expect(harness.audioProbe.mock.calls[0][0]).toMatchObject({
            numberOfChannels: 2,
            sampleRate: 48_000
        });
        expect(harness.audioProbe.mock.calls[2][0].description).toBeInstanceOf(Uint8Array);
        expect(harness.audioProbe.mock.calls[4][0].description).toBeInstanceOf(Uint8Array);
        expect(capabilities.video.h264).toMatchObject({
            reason: 'config-supported',
            status: 'supported'
        });
        expect(capabilities.video.hevc).toMatchObject({
            reason: 'config-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.video.vp9).toMatchObject({
            reason: 'config-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.nativeDolbyVisionHEVC).toMatchObject({
            bitDepth: 10,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            maximumFramesPerSecond: 0,
            maximumLevel: 153,
            measuredFramesPerSecond: null,
            profile: 5,
            reason: 'config-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.nativeHDRHEVC).toMatchObject({
            bitDepth: 10,
            codecString: 'hvc1.2.4.L153.B0',
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            maximumFramesPerSecond: 0,
            maximumLevel: 153,
            measuredFramesPerSecond: null,
            reason: 'config-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.h264Profiles).toBeDefined();
        expect(Object.values(capabilities.h264Profiles ?? {})).toHaveLength(4);
        for (const profileCapability of Object.values(capabilities.h264Profiles ?? {})) {
            expect(profileCapability).toMatchObject({
                reason: 'api-unavailable',
                status: 'unknown'
            });
        }
        expect(capabilities.audio.flac.status).toBe('supported');
        expect(capabilities.audio.ac3).toMatchObject({
            codecString: 'ac-3',
            reason: 'bundled-software-decoder',
            status: 'supported'
        });
        expect(capabilities.audio.eac3).toMatchObject({
            codecString: 'ec-3',
            reason: 'bundled-software-decoder',
            status: 'supported'
        });
        expect(capabilities.rawHDRVideo).toMatchObject({
            av1: { reason: 'config-unsupported', status: 'unsupported' },
            hevc: {
                maximumFramesPerSecond: 30,
                measuredFramesPerSecond: 40,
                reason: 'bundled-software-decoder',
                status: 'supported'
            },
            vp9: {
                maximumFramesPerSecond: 60,
                measuredFramesPerSecond: 80,
                reason: 'output-copy-supported',
                status: 'supported'
            }
        });
        expect(harness.rawHDRVideoOutputProbe).toHaveBeenCalledOnce();
        expect(harness.rawHDRVideoOutputProbe.mock.calls[0][0]).toMatchObject({
            codec: 'vp9',
            configuration: {
                hardwareAcceleration: 'no-preference'
            },
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840,
            expectedFormat: 'I420P10'
        });
        expect(
            harness.rawHDRVideoOutputProbe.mock.calls[0][0].encodedKeyFrame
        ).toHaveLength(2_957);
        expect(capabilities.telemetry).toEqual({
            audioProbeCount: 5,
            bundledAudioCodecCount: CUSTOM_BUNDLED_AUDIO_CODECS.length,
            nativeHDRVideoProbeCount: 1,
            nativeSurroundAudioProbeCount: 4,
            nativeUltraHDVideoProbeCount: 3,
            rawHDRVideoProbeCount: 3,
            reason: 'complete',
            supportedAudioCodecCount: CUSTOM_BUNDLED_AUDIO_CODECS.length + 2,
            supportedNativeHDRVideoCodecCount: 0,
            supportedNativeSurroundAudioCodecCount: 0,
            supportedNativeUltraHDVideoCodecCount: 1,
            supportedRawHDRVideoCodecCount: 2,
            supportedVideoCodecCount: 2,
            unknownAudioCodecCount: 0,
            unknownNativeHDRVideoCodecCount: 0,
            unknownNativeSurroundAudioCodecCount: 0,
            unknownNativeUltraHDVideoCodecCount: 0,
            unknownVideoCodecCount: 0,
            videoProbeCount: 12
        });
        expect(capabilities.nativeUltraHDVideo).toMatchObject({
            av1: {
                reason: 'config-unsupported',
                status: 'unsupported'
            },
            hevc: {
                reason: 'config-unsupported',
                status: 'unsupported'
            },
            vp9: {
                bitDepth: 8,
                codecString: 'vp09.00.51.08',
                maximumCodedHeight: 2_160,
                maximumCodedWidth: 3_840,
                reason: 'decode-output-verified',
                status: 'supported'
            }
        });
    });

    it('caches concurrent and subsequent probe requests', async () => {
        const harness = createEnvironment(new Set(), new Set());
        const probe = new CustomDecodeCapabilityProbe(harness.environment);

        const [ first, second ] = await Promise.all([ probe.probe(), probe.probe() ]);
        const third = await probe.probe();

        expect(first).toBe(second);
        expect(second).toBe(third);
        expect(harness.videoProbe).toHaveBeenCalledTimes(
            CUSTOM_VIDEO_CODECS.length - 2
                + CUSTOM_NATIVE_ULTRA_HD_VIDEO_CODECS.length
                + CUSTOM_RAW_HDR_VIDEO_CODECS.length
                + 2
        );
        expect(harness.audioProbe).toHaveBeenCalledTimes(
            CUSTOM_WEB_CODECS_AUDIO_CODECS.length
                + CUSTOM_NATIVE_SURROUND_AUDIO_CODECS.length
        );
    });

    it.each([
        {
            chunkByteLengths: [ 23 ],
            codec: 'aac',
            codecString: 'mp4a.40.2',
            descriptionByteLength: 5,
            expectedNumberOfFrames: 1_024
        },
        {
            chunkByteLengths: [ 240 ],
            codec: 'opus',
            codecString: 'opus',
            descriptionByteLength: 19,
            expectedNumberOfFrames: 648
        },
        {
            chunkByteLengths: [ 14 ],
            codec: 'flac',
            codecString: 'flac',
            descriptionByteLength: 42,
            expectedNumberOfFrames: 4_608
        },
        {
            chunkByteLengths: [ 384 ],
            codec: 'mp3',
            codecString: 'mp3',
            descriptionByteLength: null,
            expectedNumberOfFrames: 1_152
        },
        {
            chunkByteLengths: [ 1, 1 ],
            codec: 'vorbis',
            codecString: 'vorbis',
            descriptionByteLength: 3_929,
            expectedNumberOfFrames: 576
        }
    ] as const)(
        'requires exact decoded native $codec audio output',
        async ({
            chunkByteLengths,
            codec,
            codecString,
            descriptionByteLength,
            expectedNumberOfFrames
        }) => {
            const harness = createEnvironment(
                new Set(),
                new Set([ codecString ])
            );

            const capabilities = await new CustomDecodeCapabilityProbe(
                harness.environment
            ).probe();

            expect(capabilities.audio[codec]).toMatchObject({
                reason: 'decode-output-verified',
                status: 'supported'
            });
            expect(harness.nativeAudioOutputProbe).toHaveBeenCalledOnce();
            const request = harness.nativeAudioOutputProbe.mock.calls[0][0];
            expect(request).toMatchObject({
                codec,
                configuration: {
                    codec: codecString,
                    numberOfChannels: 2,
                    sampleRate: 48_000
                },
                expectedNumberOfChannels: 2,
                expectedNumberOfFrames,
                expectedSampleRate: 48_000,
                expectedTimestamp: 0
            });
            if (descriptionByteLength === null) {
                expect(request.configuration.description).toBeUndefined();
            } else {
                expect(request.configuration.description).toHaveLength(descriptionByteLength);
            }
            expect(request.encodedChunks.map((chunk: { data: Uint8Array }) => (
                chunk.data.byteLength
            ))).toEqual(chunkByteLengths);
        }
    );

    it.each([
        {
            chunkByteLengths: [ 36 ],
            codec: 'aac',
            codecString: 'mp4a.40.2',
            descriptionByteLength: 5,
            expectedNumberOfFrames: 1_024
        },
        {
            chunkByteLengths: [ 640 ],
            codec: 'opus',
            codecString: 'opus',
            descriptionByteLength: 27,
            expectedNumberOfFrames: 648
        },
        {
            chunkByteLengths: [ 26 ],
            codec: 'flac',
            codecString: 'flac',
            descriptionByteLength: 42,
            expectedNumberOfFrames: 4_608
        },
        {
            chunkByteLengths: [ 1, 2 ],
            codec: 'vorbis',
            codecString: 'vorbis',
            descriptionByteLength: 6_513,
            expectedNumberOfFrames: 576
        }
    ] as const)(
        'requires exact decoded native 5.1 $codec audio output',
        async ({
            chunkByteLengths,
            codec,
            codecString,
            descriptionByteLength,
            expectedNumberOfFrames
        }) => {
            const codecSupport = new Set([ codecString ]);
            const harness = createEnvironment(
                new Set(),
                codecSupport,
                new Set(),
                false,
                new Set(),
                codecSupport,
                { configuration: codecSupport, output: codecSupport }
            );

            const capabilities = await new CustomDecodeCapabilityProbe(
                harness.environment
            ).probe();

            expect(capabilities.nativeSurroundAudio?.[codec]).toMatchObject({
                inputChannelCount: 6,
                reason: 'decode-output-verified',
                sampleRate: 48_000,
                status: 'supported'
            });
            const surroundRequests = harness.nativeAudioOutputProbe.mock.calls.filter(
                call => call[0].configuration.numberOfChannels === 6
            );
            expect(surroundRequests).toHaveLength(1);
            const request = surroundRequests[0][0];
            expect(request).toMatchObject({
                codec,
                configuration: {
                    codec: codecString,
                    numberOfChannels: 6,
                    sampleRate: 48_000
                },
                expectedNumberOfChannels: 6,
                expectedNumberOfFrames,
                expectedSampleRate: 48_000,
                expectedTimestamp: 0
            });
            expect(request.configuration.description).toHaveLength(descriptionByteLength);
            expect(request.encodedChunks.map((chunk: { data: Uint8Array }) => (
                chunk.data.byteLength
            ))).toEqual(chunkByteLengths);
        }
    );

    it('rejects audio config support without matching decoded output', async () => {
        const harness = createEnvironment(
            new Set(),
            new Set([ 'opus' ]),
            new Set(),
            false,
            new Set(),
            new Set()
        );

        const capabilities = await new CustomDecodeCapabilityProbe(
            harness.environment
        ).probe();

        expect(capabilities.audio.opus).toMatchObject({
            reason: 'decode-output-missing',
            status: 'unsupported'
        });
    });

    it('does not claim native audio when the decoded-output probe is unavailable', async () => {
        const harness = createEnvironment(new Set(), new Set([ 'opus' ]));
        harness.environment.nativeAudioOutputProbe = null;

        const capabilities = await new CustomDecodeCapabilityProbe(
            harness.environment
        ).probe();

        expect(capabilities.audio.opus).toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
    });

    it('bounds a native audio decoded-output probe that never settles', async () => {
        vi.useFakeTimers();
        const harness = createEnvironment(new Set(), new Set([ 'opus' ]));
        harness.environment.nativeAudioOutputProbe = vi.fn(
            () => new Promise<boolean>(() => undefined)
        );
        const probePromise = new CustomDecodeCapabilityProbe(
            harness.environment
        ).probe();

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);
        const capabilities = await probePromise;

        expect(capabilities.audio.opus).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
    });

    it.each([
        {
            codec: 'hevc',
            codecString: 'hvc1.1.6.L120.B0',
            expectedCodedHeight: 1_080,
            expectedCodedWidth: 1_920
        },
        {
            codec: 'vp8',
            codecString: 'vp8',
            expectedCodedHeight: 64,
            expectedCodedWidth: 64
        },
        {
            codec: 'vp9',
            codecString: 'vp09.00.10.08',
            expectedCodedHeight: 64,
            expectedCodedWidth: 64
        },
        {
            codec: 'av1',
            codecString: 'av01.0.08M.08',
            expectedCodedHeight: 64,
            expectedCodedWidth: 64
        }
    ] as const)(
        'requires exact decoded native $codec output',
        async ({ codec, codecString, expectedCodedHeight, expectedCodedWidth }) => {
            const harness = createEnvironment(
                new Set([ codecString ]),
                new Set()
            );

            const capabilities = await new CustomDecodeCapabilityProbe(
                harness.environment
            ).probe();

            expect(capabilities.video[codec]).toMatchObject({
                reason: 'decode-output-verified',
                status: 'supported'
            });
            expect(harness.nativeVideoOutputProbe).toHaveBeenCalledOnce();
            const request = harness.nativeVideoOutputProbe.mock.calls[0][0];
            expect(request).toMatchObject({
                codec,
                configuration: {
                    codec: codecString,
                    codedHeight: expectedCodedHeight,
                    codedWidth: expectedCodedWidth
                },
                expectedCodedHeight,
                expectedCodedWidth,
                expectedDisplayHeight: expectedCodedHeight,
                expectedDisplayWidth: expectedCodedWidth,
                expectedTimestamp: 0
            });
            expect(request.encodedKeyFrame).toBeInstanceOf(Uint8Array);
            expect(request.encodedKeyFrame.byteLength).toBeGreaterThan(0);
        }
    );

    it.each([
        {
            codec: 'hevc',
            codecString: 'hvc1.1.6.L153.B0',
            encodedByteLength: 2_086
        },
        {
            codec: 'vp9',
            codecString: 'vp09.00.51.08',
            encodedByteLength: 731
        },
        {
            codec: 'av1',
            codecString: 'av01.0.12M.08',
            encodedByteLength: 49
        }
    ] as const)(
        'requires exact decoded native Ultra HD $codec output',
        async ({ codec, codecString, encodedByteLength }) => {
            const harness = createEnvironment(
                new Set([ codecString ]),
                new Set()
            );

            const capabilities = await new CustomDecodeCapabilityProbe(
                harness.environment
            ).probe();

            expect(capabilities.nativeUltraHDVideo?.[codec]).toMatchObject({
                bitDepth: 8,
                codec,
                codecString,
                maximumCodedHeight: 2_160,
                maximumCodedWidth: 3_840,
                reason: 'decode-output-verified',
                status: 'supported'
            });
            expect(harness.nativeVideoOutputProbe).toHaveBeenCalledOnce();
            const request = harness.nativeVideoOutputProbe.mock.calls[0][0];
            expect(request).toMatchObject({
                codec,
                configuration: {
                    codec: codecString,
                    codedHeight: 2_160,
                    codedWidth: 3_840,
                    hardwareAcceleration: 'prefer-hardware'
                },
                expectedCodedHeight: 2_160,
                expectedCodedWidth: 3_840,
                expectedDisplayHeight: 2_160,
                expectedDisplayWidth: 3_840,
                expectedTimestamp: 0
            });
            expect(request.encodedKeyFrame).toHaveLength(encodedByteLength);
        }
    );

    it('rejects config support without matching decoded native output', async () => {
        const harness = createEnvironment(
            new Set([ 'vp8' ]),
            new Set(),
            new Set(),
            false,
            new Set()
        );

        const capabilities = await new CustomDecodeCapabilityProbe(
            harness.environment
        ).probe();

        expect(capabilities.video.vp8).toMatchObject({
            reason: 'decode-output-missing',
            status: 'unsupported'
        });
    });

    it('does not claim native output when the decoded-frame probe is unavailable', async () => {
        const harness = createEnvironment(new Set([ 'vp8' ]), new Set());
        harness.environment.nativeVideoOutputProbe = null;

        const capabilities = await new CustomDecodeCapabilityProbe(
            harness.environment
        ).probe();

        expect(capabilities.video.vp8).toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
    });

    it('bounds an ordinary native decoded-output probe that never settles', async () => {
        vi.useFakeTimers();
        const harness = createEnvironment(new Set([ 'vp8' ]), new Set());
        harness.environment.nativeVideoOutputProbe = vi.fn(
            () => new Promise<boolean>(() => undefined)
        );
        const probePromise = new CustomDecodeCapabilityProbe(
            harness.environment
        ).probe();

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);
        const capabilities = await probePromise;

        expect(capabilities.video.vp8).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
    });

    it('records probe exceptions as unknown rather than unsupported', async () => {
        const videoProbe = vi.fn(async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => {
            if (config.codec.startsWith('hvc1')) {
                throw new DOMException('Driver rejected the probe', 'OperationError');
            }
            return { config, supported: false };
        });
        const audioProbe = vi.fn(async (config: AudioDecoderConfig): Promise<AudioDecoderSupport> => {
            if (config.codec === 'opus') {
                throw new TypeError('Audio decoder crashed');
            }
            return { config, supported: false };
        });
        const capabilities = await new CustomDecodeCapabilityProbe({
            audioDecoder: { isConfigSupported: audioProbe },
            bundledDTSExactProbe: {
                probe: vi.fn(async () => SUPPORTED_DTS_EXACT_CAPABILITY)
            },
            bundledHEVCExactProbe: {
                probe: vi.fn(async () => BUNDLED_HEVC_EXACT_CAPABILITIES)
            },
            bundledJPEG2000ExactProbe: {
                probe: vi.fn(async () => UNSUPPORTED_JPEG2000_EXACT_CAPABILITY)
            },
            bundledTrueHDExactProbe: {
                probe: vi.fn(async () => SUPPORTED_TRUEHD_EXACT_CAPABILITY)
            },
            videoDecoder: { isConfigSupported: videoProbe }
        }).probe();

        expect(capabilities.video.hevc).toMatchObject({
            reason: 'probe-exception',
            status: 'unknown'
        });
        expect(capabilities.audio.opus).toMatchObject({
            reason: 'probe-exception',
            status: 'unknown'
        });
        expect(capabilities.video.h264.status).toBe('unsupported');
        expect(capabilities.telemetry.reason).toBe('probe-exceptions');
        expect(capabilities.telemetry.unknownAudioCodecCount).toBe(1);
        expect(capabilities.telemetry.unknownVideoCodecCount).toBe(2);
    });

    it('bounds decoder capability APIs that never settle', async () => {
        vi.useFakeTimers();
        const videoProbe = vi.fn(() => new Promise<VideoDecoderSupport>(() => undefined));
        const audioProbe = vi.fn(() => new Promise<AudioDecoderSupport>(() => undefined));
        const rawHDRVideoOutputProbe = vi.fn(() => (
            new Promise<RawHDRVideoOutputProbeResult>(() => undefined)
        ));
        const probePromise = new CustomDecodeCapabilityProbe({
            audioDecoder: { isConfigSupported: audioProbe },
            bundledHEVCExactProbe: {
                probe: vi.fn(async () => BUNDLED_HEVC_EXACT_CAPABILITIES)
            },
            bundledTrueHDExactProbe: {
                probe: vi.fn(async () => SUPPORTED_TRUEHD_EXACT_CAPABILITY)
            },
            rawHDRVideoOutputProbe,
            videoDecoder: { isConfigSupported: videoProbe }
        }).probe();

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);
        const capabilities = await probePromise;

        expect(capabilities.video.h264).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(capabilities.audio.aac).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(capabilities.rawHDRVideo.vp9).toMatchObject({
            reason: 'probe-timeout',
            status: 'unknown'
        });
        expect(capabilities.rawHDRVideo.hevc).toMatchObject({
            reason: 'bundled-software-decoder',
            status: 'supported'
        });
        expect(capabilities.telemetry.reason).toBe('probe-exceptions');
        expect(rawHDRVideoOutputProbe).not.toHaveBeenCalled();
    });

    it('uses unknown API-unavailable results without making support claims', async () => {
        const capabilities = await new CustomDecodeCapabilityProbe({
            audioDecoder: null,
            bundledDTSExactProbe: {
                probe: vi.fn(async () => SUPPORTED_DTS_EXACT_CAPABILITY)
            },
            bundledHEVCExactProbe: {
                probe: vi.fn(async () => BUNDLED_HEVC_EXACT_CAPABILITIES)
            },
            bundledTrueHDExactProbe: {
                probe: vi.fn(async () => SUPPORTED_TRUEHD_EXACT_CAPABILITY)
            },
            videoDecoder: null
        }).probe();

        for (const codec of CUSTOM_VIDEO_CODECS) {
            expect(capabilities.video[codec]).toMatchObject({
                reason: 'api-unavailable',
                status: 'unknown'
            });
        }
        for (const codec of CUSTOM_WEB_CODECS_AUDIO_CODECS) {
            expect(capabilities.audio[codec]).toMatchObject({
                reason: 'api-unavailable',
                status: 'unknown'
            });
        }
        for (const codec of CUSTOM_BUNDLED_AUDIO_CODECS) {
            expect(capabilities.audio[codec]).toMatchObject({
                reason: 'bundled-software-decoder',
                status: 'supported'
            });
        }
        expect(capabilities.telemetry).toMatchObject({
            audioProbeCount: 0,
            bundledAudioCodecCount: CUSTOM_BUNDLED_AUDIO_CODECS.length,
            rawHDRVideoProbeCount: 0,
            reason: 'api-unavailable',
            supportedAudioCodecCount: CUSTOM_BUNDLED_AUDIO_CODECS.length,
            supportedRawHDRVideoCodecCount: 1,
            videoProbeCount: 0
        });
    });

    it('reports a partial runtime when only one decoder API exists', async () => {
        const harness = createEnvironment(new Set([ 'vp8' ]), new Set());
        const capabilities = await new CustomDecodeCapabilityProbe({
            audioDecoder: null,
            bundledDTSExactProbe: {
                probe: vi.fn(async () => SUPPORTED_DTS_EXACT_CAPABILITY)
            },
            bundledHEVCExactProbe: {
                probe: vi.fn(async () => BUNDLED_HEVC_EXACT_CAPABILITIES)
            },
            bundledTrueHDExactProbe: {
                probe: vi.fn(async () => SUPPORTED_TRUEHD_EXACT_CAPABILITY)
            },
            nativeVideoOutputProbe: harness.nativeVideoOutputProbe,
            videoDecoder: harness.environment.videoDecoder
        }).probe();

        expect(capabilities.telemetry.reason).toBe('partial-api');
        expect(capabilities.telemetry.unknownAudioCodecCount).toBe(CUSTOM_WEB_CODECS_AUDIO_CODECS.length);
        expect(capabilities.video.vp8.status).toBe('supported');
    });

    it('gates bundled DTS on exact decoded-output qualification', async () => {
        const unavailable = await new CustomDecodeCapabilityProbe({
            bundledDTSExactProbe: null
        }).probe();
        const outputMismatch = await new CustomDecodeCapabilityProbe({
            bundledDTSExactProbe: {
                probe: vi.fn(async () => Object.freeze({
                    ...SUPPORTED_DTS_EXACT_CAPABILITY,
                    decodeMilliseconds: null,
                    measuredRealTimeFactor: null,
                    reason: 'output-mismatch' as const,
                    status: 'unsupported' as const,
                    verifiedFixtureCount: 5,
                    verifiedProfileMask: 0x0f
                }))
            }
        }).probe();
        const supported = await new CustomDecodeCapabilityProbe({
            bundledDTSExactProbe: {
                probe: vi.fn(async () => SUPPORTED_DTS_EXACT_CAPABILITY)
            }
        }).probe();

        expect(unavailable.audio.dts).toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
        expect(unavailable.bundledDTS).toBeUndefined();
        expect(outputMismatch.audio.dts).toMatchObject({
            reason: 'decode-output-missing',
            status: 'unsupported'
        });
        expect(supported.audio.dts).toMatchObject({
            codecString: 'dts',
            reason: 'bundled-software-decoder',
            status: 'supported'
        });
        expect(supported.bundledDTS).toBe(SUPPORTED_DTS_EXACT_CAPABILITY);
    });

    it('gates bundled TrueHD on exact decoded-output qualification', async () => {
        const unavailable = await new CustomDecodeCapabilityProbe({
            bundledTrueHDExactProbe: null
        }).probe();
        const outputMismatch = await new CustomDecodeCapabilityProbe({
            bundledTrueHDExactProbe: {
                probe: vi.fn(async () => Object.freeze({
                    ...SUPPORTED_TRUEHD_EXACT_CAPABILITY,
                    decodeMilliseconds: null,
                    majorSyncRecoveryVerified: false,
                    measuredRealTimeFactor: null,
                    reason: 'major-sync-recovery-failed' as const,
                    status: 'unsupported' as const
                }))
            }
        }).probe();
        const supported = await new CustomDecodeCapabilityProbe({
            bundledTrueHDExactProbe: {
                probe: vi.fn(async () => SUPPORTED_TRUEHD_EXACT_CAPABILITY)
            }
        }).probe();

        expect(unavailable.audio.truehd).toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
        expect(unavailable.bundledTrueHD).toBeUndefined();
        expect(outputMismatch.audio.truehd).toMatchObject({
            reason: 'decode-output-missing',
            status: 'unsupported'
        });
        expect(supported.audio.truehd).toMatchObject({
            codecString: 'truehd',
            reason: 'bundled-software-decoder',
            status: 'supported'
        });
        expect(supported.bundledTrueHD).toBe(SUPPORTED_TRUEHD_EXACT_CAPABILITY);
    });

    it('gates bundled MPEG-2 on exact decoded-output qualification', async () => {
        const unavailable = await new CustomDecodeCapabilityProbe({
            bundledLegacyVideoExactProbe: null
        }).probe();
        const outputMismatch = await new CustomDecodeCapabilityProbe({
            bundledLegacyVideoExactProbe: {
                probe: vi.fn(async () => UNSUPPORTED_LEGACY_VIDEO_EXACT_CAPABILITY)
            }
        }).probe();
        const supported = await new CustomDecodeCapabilityProbe({
            bundledLegacyVideoExactProbe: {
                probe: vi.fn(async () => SUPPORTED_LEGACY_VIDEO_EXACT_CAPABILITY)
            }
        }).probe();

        expect(unavailable.video.mpeg2video).toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
        expect(unavailable.bundledLegacyVideo).toBeUndefined();
        expect(outputMismatch.video.mpeg2video).toMatchObject({
            reason: 'decode-output-missing',
            status: 'unsupported'
        });
        expect(supported.video.mpeg2video).toMatchObject({
            codecString: 'mpeg2video',
            reason: 'bundled-software-decoder',
            status: 'supported'
        });
        expect(supported.bundledLegacyVideo)
            .toBe(SUPPORTED_LEGACY_VIDEO_EXACT_CAPABILITY);
    });

    it('gates bundled HEVC on exact decoded-output qualification', async () => {
        const unavailable = await new CustomDecodeCapabilityProbe({
            bundledHEVCExactProbe: null
        }).probe();
        const mainOnly = await new CustomDecodeCapabilityProbe({
            bundledHEVCExactProbe: {
                probe: vi.fn(async () => createBundledHEVCCapabilities(
                    true,
                    false,
                    false
                ))
            }
        }).probe();
        const main10FullHDOnly = await new CustomDecodeCapabilityProbe({
            bundledHEVCExactProbe: {
                probe: vi.fn(async () => createBundledHEVCCapabilities(
                    false,
                    true,
                    false
                ))
            }
        }).probe();
        const bothTiers = await new CustomDecodeCapabilityProbe({
            bundledHEVCExactProbe: {
                probe: vi.fn(async () => BUNDLED_HEVC_EXACT_CAPABILITIES)
            }
        }).probe();

        expect(unavailable.rawHDRVideo.hevc).toMatchObject({
            maximumCodedHeight: 0,
            maximumCodedWidth: 0,
            reason: 'runtime-unavailable',
            status: 'unknown'
        });
        expect(mainOnly.bundledHEVC?.tiers['main-1080p']).toMatchObject({
            reason: 'decode-output-verified',
            status: 'supported'
        });
        expect(mainOnly.rawHDRVideo.hevc).toMatchObject({
            maximumCodedHeight: 0,
            maximumCodedWidth: 0,
            reason: 'runtime-insufficient',
            status: 'unsupported'
        });
        expect(main10FullHDOnly.rawHDRVideo.hevc).toMatchObject({
            codecString: 'hvc1.2.4.L120.B0',
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            maximumFramesPerSecond: 30,
            measuredFramesPerSecond: 40,
            reason: 'bundled-software-decoder',
            status: 'supported'
        });
        expect(bothTiers.rawHDRVideo.hevc).toMatchObject({
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            maximumFramesPerSecond: 30,
            measuredFramesPerSecond: 40,
            reason: 'bundled-software-decoder',
            status: 'supported'
        });
    });

    it('prefers qualified native HEVC raw output over the bundled decoder', async () => {
        const harness = createEnvironment(
            new Set([ 'hvc1.2.4.L153.B0' ]),
            new Set(),
            new Set([ 'hevc' ])
        );

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(capabilities.rawHDRVideo.hevc).toMatchObject({
            codecString: 'hvc1.2.4.L153.B0',
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            maximumFramesPerSecond: 60,
            measuredFramesPerSecond: 80,
            reason: 'output-copy-supported',
            status: 'supported'
        });
        expect(harness.rawHDRVideoOutputProbe).toHaveBeenCalledOnce();
        expect(harness.rawHDRVideoOutputProbe.mock.calls[0][0]).toMatchObject({
            codec: 'hevc',
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840,
            expectedFormat: 'I420P10'
        });
    });

    it('records copyable raw HDR output below the minimum throughput as unsupported', async () => {
        const harness = createEnvironment(
            new Set([ 'vp09.02.10.10' ]),
            new Set()
        );
        harness.environment.rawHDRVideoOutputProbe = vi.fn(async () => ({
            maximumFramesPerSecond: null,
            measuredFramesPerSecond: 29,
            outputCopySupported: true
        }));

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(capabilities.rawHDRVideo.vp9).toMatchObject({
            maximumFramesPerSecond: 0,
            measuredFramesPerSecond: 29,
            reason: 'throughput-insufficient',
            status: 'unsupported'
        });
    });

    it.each([
        {
            maximumFramesPerSecond: 60,
            measuredFramesPerSecond: 80,
            outputSupported: true,
            reason: 'decode-output-verified',
            status: 'supported'
        },
        {
            maximumFramesPerSecond: 0,
            measuredFramesPerSecond: null,
            outputSupported: false,
            reason: 'decode-output-missing',
            status: 'unsupported'
        }
    ] as const)(
        'requires decoded native Profile 5 output: $status',
        async ({
            maximumFramesPerSecond,
            measuredFramesPerSecond,
            outputSupported,
            reason,
            status
        }) => {
            const harness = createEnvironment(
                new Set([ 'hev1.2.4.H150.B0' ]),
                new Set(),
                new Set(),
                outputSupported
            );

            const capabilities = await new CustomDecodeCapabilityProbe(
                harness.environment
            ).probe();

            expect(capabilities.nativeDolbyVisionHEVC).toMatchObject({
                maximumFramesPerSecond,
                measuredFramesPerSecond,
                reason,
                status
            });
            expect(harness.nativeDolbyVisionVideoOutputProbe).toHaveBeenCalledOnce();
            const request = harness.nativeDolbyVisionVideoOutputProbe.mock.calls[0][0];
            expect(request).toMatchObject({
                configuration: {
                    codec: 'hev1.2.4.H150.B0',
                    codedHeight: 2_160,
                    codedWidth: 3_840,
                    hardwareAcceleration: 'prefer-hardware',
                    optimizeForLatency: true
                },
                expectedCodedHeight: 2_160,
                expectedCodedWidth: 3_840
            });
            expect(request.encodedKeyFrame).toBeInstanceOf(Uint8Array);
            expect(request.encodedKeyFrame.byteLength).toBeGreaterThan(0);
        }
    );

    it('requires exact decoded native Main10 HDR output and throughput', async () => {
        const harness = createEnvironment(
            new Set([ 'hvc1.2.4.L153.B0' ]),
            new Set()
        );
        const nativeHDRVideoOutputProbe = vi.fn(async (
            probeRequest: NativeDolbyVisionVideoOutputProbeRequest
        ) => ({
            maximumFramesPerSecond: 60 as const,
            measuredFramesPerSecond: 80,
            outputSupported: probeRequest.expectedCodedWidth === 3_840
        }));
        harness.environment.nativeHDRVideoOutputProbe = nativeHDRVideoOutputProbe;

        const capabilities = await new CustomDecodeCapabilityProbe(
            harness.environment
        ).probe();

        expect(capabilities.nativeHDRHEVC).toMatchObject({
            bitDepth: 10,
            codecString: 'hvc1.2.4.L153.B0',
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            maximumFramesPerSecond: 60,
            maximumLevel: 153,
            measuredFramesPerSecond: 80,
            reason: 'decode-output-verified',
            status: 'supported'
        });
        expect(nativeHDRVideoOutputProbe).toHaveBeenCalledOnce();
        expect(nativeHDRVideoOutputProbe.mock.calls[0][0]).toMatchObject({
            configuration: {
                codec: 'hvc1.2.4.L153.B0',
                codedHeight: 2_160,
                codedWidth: 3_840,
                hardwareAcceleration: 'prefer-hardware',
                optimizeForLatency: true
            },
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840
        });
        expect(nativeHDRVideoOutputProbe.mock.calls[0][0].encodedKeyFrame)
            .toBeInstanceOf(Uint8Array);
    });

    it('rejects native Profile 5 output without qualified throughput', async () => {
        const harness = createEnvironment(
            new Set([ 'hev1.2.4.H150.B0' ]),
            new Set()
        );
        harness.environment.nativeDolbyVisionVideoOutputProbe = vi.fn(async () => ({
            maximumFramesPerSecond: null,
            measuredFramesPerSecond: 29,
            outputSupported: true
        }));

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(capabilities.nativeDolbyVisionHEVC).toMatchObject({
            maximumFramesPerSecond: 0,
            measuredFramesPerSecond: 29,
            reason: 'throughput-insufficient',
            status: 'unsupported'
        });
    });

    it.each([
        {
            outputs: [ {
                duration: 21_333,
                numberOfChannels: 2,
                numberOfFrames: 1_024,
                sampleRate: 48_000,
                sampleValue: 0,
                timestamp: 0
            } ],
            supported: true
        },
        {
            outputs: [ {
                duration: 21_333,
                numberOfChannels: 1,
                numberOfFrames: 1_024,
                sampleRate: 48_000,
                sampleValue: 0,
                timestamp: 0
            } ],
            supported: false
        },
        {
            outputs: [ {
                duration: 21_333,
                numberOfChannels: 2,
                numberOfFrames: 1_023,
                sampleRate: 48_000,
                sampleValue: 0,
                timestamp: 0
            } ],
            supported: false
        },
        {
            outputs: [ {
                duration: 20_000,
                numberOfChannels: 2,
                numberOfFrames: 1_024,
                sampleRate: 48_000,
                sampleValue: 0,
                timestamp: 0
            } ],
            supported: false
        },
        {
            outputs: [ {
                duration: 21_333,
                numberOfChannels: 2,
                numberOfFrames: 1_024,
                sampleRate: 48_000,
                sampleValue: 0.001,
                timestamp: 0
            } ],
            supported: false
        },
        {
            outputs: [
                {
                    duration: 21_333,
                    numberOfChannels: 2,
                    numberOfFrames: 1_024,
                    sampleRate: 48_000,
                    sampleValue: 0,
                    timestamp: 0
                },
                {
                    duration: 21_333,
                    numberOfChannels: 2,
                    numberOfFrames: 1_024,
                    sampleRate: 48_000,
                    sampleValue: 0,
                    timestamp: 0
                }
            ],
            supported: false
        }
    ] as const)(
        'requires one exact silent native audio output: $supported',
        async ({ outputs, supported }) => {
            const closeAudioData = vi.fn();
            const closeDecoder = vi.fn();
            const encodedChunkInitializations: EncodedAudioChunkInit[] = [];
            class FakeAudioDecoder {
                public state: CodecState = 'unconfigured';

                public constructor(private readonly callbacks: AudioDecoderInit) {}

                public close(): void {
                    this.state = 'closed';
                    closeDecoder();
                }

                public configure(): void {
                    this.state = 'configured';
                }

                public decode(): void {
                    for (const output of outputs) {
                        const audioData = {
                            close: closeAudioData,
                            copyTo: (destination: AllowSharedBufferSource): void => {
                                (destination as Float32Array).fill(output.sampleValue);
                            },
                            duration: output.duration,
                            numberOfChannels: output.numberOfChannels,
                            numberOfFrames: output.numberOfFrames,
                            sampleRate: output.sampleRate,
                            timestamp: output.timestamp
                        } as unknown as AudioData;
                        this.callbacks.output(audioData);
                    }
                }

                public flush(): Promise<void> {
                    return Promise.resolve();
                }
            }
            class FakeEncodedAudioChunk {
                public constructor(initialization: EncodedAudioChunkInit) {
                    encodedChunkInitializations.push(initialization);
                }
            }
            vi.stubGlobal('AudioDecoder', FakeAudioDecoder);
            vi.stubGlobal('EncodedAudioChunk', FakeEncodedAudioChunk);
            const outputProbe = createNativeAudioOutputProbe();

            await expect(outputProbe?.({
                codec: 'aac',
                configuration: {
                    codec: 'mp4a.40.2',
                    numberOfChannels: 2,
                    sampleRate: 48_000
                },
                encodedChunks: [ {
                    data: new Uint8Array([ 1, 2, 3 ]),
                    duration: 21_333,
                    timestamp: 0
                } ],
                expectedNumberOfChannels: 2,
                expectedNumberOfFrames: 1_024,
                expectedSampleRate: 48_000,
                expectedTimestamp: 0
            })).resolves.toBe(supported);
            expect(encodedChunkInitializations).toEqual([ {
                data: new Uint8Array([ 1, 2, 3 ]),
                duration: 21_333,
                timestamp: 0,
                type: 'key'
            } ]);
            expect(closeAudioData).toHaveBeenCalledTimes(outputs.length);
            expect(closeDecoder).toHaveBeenCalledOnce();
        }
    );

    it('rejects and closes native audio whose planar copy fails', async () => {
        const closeAudioData = vi.fn();
        class FakeAudioDecoder {
            public state: CodecState = 'unconfigured';

            public constructor(private readonly callbacks: AudioDecoderInit) {}

            public close(): void {
                this.state = 'closed';
            }

            public configure(): void {
                this.state = 'configured';
            }

            public decode(): void {
                this.callbacks.output({
                    close: closeAudioData,
                    copyTo: (): void => {
                        throw new DOMException('Copy failed', 'OperationError');
                    },
                    duration: 21_333,
                    numberOfChannels: 2,
                    numberOfFrames: 1_024,
                    sampleRate: 48_000,
                    timestamp: 0
                } as unknown as AudioData);
            }

            public flush(): Promise<void> {
                return Promise.resolve();
            }
        }
        class FakeEncodedAudioChunk {}
        vi.stubGlobal('AudioDecoder', FakeAudioDecoder);
        vi.stubGlobal('EncodedAudioChunk', FakeEncodedAudioChunk);
        const outputProbe = createNativeAudioOutputProbe();

        await expect(outputProbe?.({
            codec: 'aac',
            configuration: {
                codec: 'mp4a.40.2',
                numberOfChannels: 2,
                sampleRate: 48_000
            },
            encodedChunks: [ {
                data: new Uint8Array([ 1 ]),
                duration: 21_333,
                timestamp: 0
            } ],
            expectedNumberOfChannels: 2,
            expectedNumberOfFrames: 1_024,
            expectedSampleRate: 48_000,
            expectedTimestamp: 0
        })).resolves.toBe(false);
        expect(closeAudioData).toHaveBeenCalledOnce();
    });

    it('closes a native audio decoder whose flush never settles', async () => {
        vi.useFakeTimers();
        const closeDecoder = vi.fn();
        class FakeAudioDecoder {
            public state: CodecState = 'unconfigured';

            public close(): void {
                this.state = 'closed';
                closeDecoder();
            }

            public configure(): void {
                this.state = 'configured';
            }

            public decode(): void {
                return;
            }

            public flush(): Promise<void> {
                return new Promise<void>(() => undefined);
            }
        }
        class FakeEncodedAudioChunk {}
        vi.stubGlobal('AudioDecoder', FakeAudioDecoder);
        vi.stubGlobal('EncodedAudioChunk', FakeEncodedAudioChunk);
        const outputProbe = createNativeAudioOutputProbe();
        const probePromise = outputProbe?.({
            codec: 'aac',
            configuration: {
                codec: 'mp4a.40.2',
                numberOfChannels: 2,
                sampleRate: 48_000
            },
            encodedChunks: [ {
                data: new Uint8Array([ 1 ]),
                duration: 21_333,
                timestamp: 0
            } ],
            expectedNumberOfChannels: 2,
            expectedNumberOfFrames: 1_024,
            expectedSampleRate: 48_000,
            expectedTimestamp: 0
        });

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);

        await expect(probePromise).resolves.toBe(false);
        expect(closeDecoder).toHaveBeenCalledOnce();
    });

    it.each([
        {
            codedHeight: 2_160,
            codedWidth: 3_840,
            elapsedMilliseconds: 90,
            expectedFrameCount: 8,
            expectedMaximumFramesPerSecond: 60,
            outputSupported: true
        },
        {
            codedHeight: 2_160,
            codedWidth: 3_840,
            elapsedMilliseconds: 140,
            expectedFrameCount: 8,
            expectedMaximumFramesPerSecond: 30,
            outputSupported: true
        },
        {
            codedHeight: 2_160,
            codedWidth: 3_840,
            elapsedMilliseconds: 210,
            expectedFrameCount: 8,
            expectedMaximumFramesPerSecond: 24,
            outputSupported: true
        },
        {
            codedHeight: 2_160,
            codedWidth: 3_840,
            elapsedMilliseconds: 240,
            expectedFrameCount: 8,
            expectedMaximumFramesPerSecond: null,
            outputSupported: true
        },
        {
            codedHeight: 1_080,
            codedWidth: 1_920,
            elapsedMilliseconds: 90,
            expectedFrameCount: 1,
            expectedMaximumFramesPerSecond: null,
            outputSupported: false
        },
        {
            codedHeight: 2_160,
            codedWidth: 3_840,
            elapsedMilliseconds: 90,
            expectedFrameCount: 1,
            expectedMaximumFramesPerSecond: null,
            outputSupported: false,
            timestampOffset: 1
        }
    ])(
        'qualifies native Profile 5 output at $elapsedMilliseconds ms',
        async ({
            codedHeight,
            codedWidth,
            elapsedMilliseconds,
            expectedFrameCount,
            expectedMaximumFramesPerSecond,
            outputSupported,
            timestampOffset = 0
        }) => {
            const closeFrame = vi.fn();
            class FakeVideoFrame {
                public readonly codedHeight = codedHeight;
                public readonly codedWidth = codedWidth;
                public readonly displayHeight = codedHeight;
                public readonly displayWidth = codedWidth;

                public constructor(public readonly timestamp: number) {}

                public close(): void {
                    closeFrame();
                }
            }
            class FakeVideoDecoder {
                public constructor(private readonly callbacks: VideoDecoderInit) {}

                public close(): void {
                    return;
                }

                public configure(): void {
                    return;
                }

                public decode(chunk: { timestamp: number }): void {
                    this.callbacks.output(
                        new FakeVideoFrame(
                            chunk.timestamp + timestampOffset
                        ) as unknown as VideoFrame
                    );
                }

                public flush(): Promise<void> {
                    return Promise.resolve();
                }
            }
            class FakeEncodedVideoChunk {
                public readonly timestamp: number;

                public constructor(init: { timestamp: number }) {
                    this.timestamp = Number(init.timestamp);
                }
            }
            const now = vi.fn()
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(elapsedMilliseconds);
            vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
            vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
            vi.stubGlobal('performance', { now });
            const outputProbe = createNativeDolbyVisionVideoOutputProbe();

            const result = await outputProbe?.({
                configuration: {
                    codec: 'hev1.2.4.H150.B0',
                    codedHeight: 2_160,
                    codedWidth: 3_840
                },
                encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
                expectedCodedHeight: 2_160,
                expectedCodedWidth: 3_840
            });
            expect(result).toMatchObject({
                maximumFramesPerSecond: expectedMaximumFramesPerSecond,
                outputSupported
            });
            if (outputSupported) {
                expect(result?.measuredFramesPerSecond).toBeCloseTo(
                    7_000 / elapsedMilliseconds
                );
            } else {
                expect(result?.measuredFramesPerSecond).toBeNull();
            }
            expect(closeFrame).toHaveBeenCalledTimes(expectedFrameCount);
        }
    );

    it('measures native Main10 output before one final decoder flush', async () => {
        const closeFrame = vi.fn();
        let clockMilliseconds = 0;
        let flushCount = 0;
        let maximumQueuedFrameCount = 0;
        let queuedFrameCount = 0;
        class FakeVideoFrame {
            public readonly codedHeight = 2_160;
            public readonly codedWidth = 3_840;
            public readonly displayHeight = 2_160;
            public readonly displayWidth = 3_840;

            public constructor(public readonly timestamp: number) {}

            public close(): void {
                closeFrame();
            }
        }
        class FakeVideoDecoder {
            public constructor(private readonly callbacks: VideoDecoderInit) {}

            public close(): void {
                return;
            }

            public configure(): void {
                return;
            }

            public decode(chunk: { timestamp: number }): void {
                queuedFrameCount += 1;
                maximumQueuedFrameCount = Math.max(
                    maximumQueuedFrameCount,
                    queuedFrameCount
                );
                void Promise.resolve().then((): void => {
                    queuedFrameCount -= 1;
                    if (chunk.timestamp > 0) {
                        clockMilliseconds += 80 / 7;
                    }
                    this.callbacks.output(
                        new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame
                    );
                });
            }

            public flush(): Promise<void> {
                flushCount += 1;
                clockMilliseconds += 10_000;
                return Promise.resolve();
            }
        }
        class FakeEncodedVideoChunk {
            public readonly timestamp: number;

            public constructor(init: { timestamp: number }) {
                this.timestamp = init.timestamp;
            }
        }
        const now = vi.fn((): number => clockMilliseconds);
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        vi.stubGlobal('performance', { now });
        const outputProbe = createNativeDolbyVisionVideoOutputProbe();

        await expect(outputProbe?.({
            configuration: {
                codec: 'hvc1.2.4.L153.B0',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840
        })).resolves.toMatchObject({
            maximumFramesPerSecond: 60,
            outputSupported: true
        });
        expect(flushCount).toBe(1);
        expect(maximumQueuedFrameCount).toBe(4);
        expect(closeFrame).toHaveBeenCalledTimes(8);
    });

    it('keeps qualified native throughput when the final flush stalls', async () => {
        vi.useFakeTimers();
        const closeDecoder = vi.fn();
        const closeFrame = vi.fn();
        let clockMilliseconds = 0;
        let flushCount = 0;
        class FakeVideoFrame {
            public readonly codedHeight = 2_160;
            public readonly codedWidth = 3_840;
            public readonly displayHeight = 2_160;
            public readonly displayWidth = 3_840;

            public constructor(public readonly timestamp: number) {}

            public close(): void {
                closeFrame();
            }
        }
        class FakeVideoDecoder {
            public constructor(private readonly callbacks: VideoDecoderInit) {}

            public close(): void {
                closeDecoder();
            }

            public configure(): void {
                return;
            }

            public decode(chunk: { timestamp: number }): void {
                if (chunk.timestamp > 0) {
                    clockMilliseconds += 80 / 7;
                }
                this.callbacks.output(
                    new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame
                );
            }

            public flush(): Promise<void> {
                flushCount += 1;
                return new Promise<void>(() => undefined);
            }
        }
        class FakeEncodedVideoChunk {
            public readonly timestamp: number;

            public constructor(init: { timestamp: number }) {
                this.timestamp = init.timestamp;
            }
        }
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        vi.stubGlobal('performance', { now: (): number => clockMilliseconds });
        const outputProbe = createNativeDolbyVisionVideoOutputProbe();
        const probePromise = outputProbe?.({
            configuration: {
                codec: 'hvc1.2.4.L153.B0',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(flushCount).toBe(1);
        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);

        await expect(probePromise).resolves.toMatchObject({
            maximumFramesPerSecond: 60,
            outputSupported: true
        });
        expect(closeFrame).toHaveBeenCalledTimes(8);
        expect(closeDecoder).toHaveBeenCalledOnce();
    });

    it('fails cleanly when a scheduled native decode throws synchronously', async () => {
        const closeFrame = vi.fn();
        let decodeCount = 0;
        class FakeVideoFrame {
            public readonly codedHeight = 2_160;
            public readonly codedWidth = 3_840;
            public readonly displayHeight = 2_160;
            public readonly displayWidth = 3_840;

            public constructor(public readonly timestamp: number) {}

            public close(): void {
                closeFrame();
            }
        }
        class FakeVideoDecoder {
            public constructor(private readonly callbacks: VideoDecoderInit) {}

            public close(): void {
                return;
            }

            public configure(): void {
                return;
            }

            public decode(chunk: { timestamp: number }): void {
                decodeCount += 1;
                if (decodeCount > 1) {
                    throw new DOMException('Decoder queue rejected input', 'OperationError');
                }
                this.callbacks.output(
                    new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame
                );
            }

            public flush(): Promise<void> {
                return Promise.resolve();
            }
        }
        class FakeEncodedVideoChunk {
            public readonly timestamp: number;

            public constructor(init: { timestamp: number }) {
                this.timestamp = init.timestamp;
            }
        }
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        const outputProbe = createNativeDolbyVisionVideoOutputProbe();

        await expect(outputProbe?.({
            configuration: {
                codec: 'hvc1.2.4.L153.B0',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840
        })).resolves.toEqual({
            maximumFramesPerSecond: null,
            measuredFramesPerSecond: null,
            outputSupported: false
        });
        expect(closeFrame).toHaveBeenCalledOnce();
    });

    it('rejects and closes duplicate native Profile 5 output', async () => {
        const closeFrame = vi.fn();
        class FakeVideoFrame {
            public readonly codedHeight = 2_160;
            public readonly codedWidth = 3_840;
            public readonly displayHeight = 2_160;
            public readonly displayWidth = 3_840;

            public constructor(public readonly timestamp: number) {}

            public close(): void {
                closeFrame();
            }
        }
        class FakeVideoDecoder {
            public constructor(private readonly callbacks: VideoDecoderInit) {}

            public close(): void {
                return;
            }

            public configure(): void {
                return;
            }

            public decode(chunk: { timestamp: number }): void {
                this.callbacks.output(
                    new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame
                );
                this.callbacks.output(
                    new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame
                );
            }

            public flush(): Promise<void> {
                return Promise.resolve();
            }
        }
        class FakeEncodedVideoChunk {
            public readonly timestamp: number;

            public constructor(init: { timestamp: number }) {
                this.timestamp = init.timestamp;
            }
        }
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        const outputProbe = createNativeDolbyVisionVideoOutputProbe();

        await expect(outputProbe?.({
            configuration: {
                codec: 'hev1.2.4.H150.B0',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840
        })).resolves.toEqual({
            maximumFramesPerSecond: null,
            measuredFramesPerSecond: null,
            outputSupported: false
        });
        expect(closeFrame).toHaveBeenCalledTimes(2);
    });

    it('times out and closes a stalled native Profile 5 decoder', async () => {
        vi.useFakeTimers();
        const closeDecoder = vi.fn();
        class FakeVideoDecoder {
            public close(): void {
                closeDecoder();
            }

            public configure(): void {
                return;
            }

            public decode(): void {
                return;
            }

            public flush(): Promise<void> {
                return new Promise<void>(() => undefined);
            }
        }
        class FakeEncodedVideoChunk {}
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        const outputProbe = createNativeDolbyVisionVideoOutputProbe();
        const probePromise = outputProbe?.({
            configuration: {
                codec: 'hev1.2.4.H150.B0',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840
        });

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);

        await expect(probePromise).resolves.toEqual({
            maximumFramesPerSecond: null,
            measuredFramesPerSecond: null,
            outputSupported: false
        });
        expect(closeDecoder).toHaveBeenCalledOnce();
    });

    it.each([
        {
            frames: [ {
                codedHeight: 64,
                codedWidth: 64,
                displayHeight: 64,
                displayWidth: 64,
                timestamp: 0,
                visibleHeight: 64,
                visibleWidth: 64
            } ],
            supported: true
        },
        {
            frames: [ {
                codedHeight: 64,
                codedWidth: 128,
                displayHeight: 64,
                displayWidth: 64,
                timestamp: 0,
                visibleHeight: 64,
                visibleWidth: 64
            } ],
            supported: true
        },
        {
            frames: [ {
                codedHeight: 64,
                codedWidth: 512,
                displayHeight: 64,
                displayWidth: 64,
                timestamp: 0,
                visibleHeight: 64,
                visibleWidth: 64
            } ],
            supported: false
        },
        {
            frames: [ {
                codedHeight: 64,
                codedWidth: 64,
                displayHeight: 32,
                displayWidth: 64,
                timestamp: 0,
                visibleHeight: 32,
                visibleWidth: 64
            } ],
            supported: false
        },
        {
            frames: [
                {
                    codedHeight: 64,
                    codedWidth: 64,
                    displayHeight: 64,
                    displayWidth: 64,
                    timestamp: 0,
                    visibleHeight: 64,
                    visibleWidth: 64
                },
                {
                    codedHeight: 64,
                    codedWidth: 64,
                    displayHeight: 64,
                    displayWidth: 64,
                    timestamp: 0,
                    visibleHeight: 64,
                    visibleWidth: 64
                }
            ],
            supported: false
        }
    ] as const)(
        'requires one exact ordinary native output: $supported',
        async ({ frames, supported }) => {
            const closeDecoder = vi.fn();
            const closeFrame = vi.fn();
            class FakeVideoDecoder {
                public state: CodecState = 'unconfigured';

                public constructor(private readonly callbacks: VideoDecoderInit) {}

                public close(): void {
                    this.state = 'closed';
                    closeDecoder();
                }

                public configure(): void {
                    this.state = 'configured';
                }

                public decode(): void {
                    for (const frameDefinition of frames) {
                        const frame = {
                            close: closeFrame,
                            codedHeight: frameDefinition.codedHeight,
                            codedWidth: frameDefinition.codedWidth,
                            displayHeight: frameDefinition.displayHeight,
                            displayWidth: frameDefinition.displayWidth,
                            timestamp: frameDefinition.timestamp,
                            visibleRect: {
                                height: frameDefinition.visibleHeight,
                                width: frameDefinition.visibleWidth,
                                x: 0,
                                y: 0
                            }
                        } as unknown as VideoFrame;
                        this.callbacks.output(frame);
                    }
                }

                public flush(): Promise<void> {
                    return Promise.resolve();
                }
            }
            class FakeEncodedVideoChunk {}
            vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
            vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
            const outputProbe = createNativeVideoOutputProbe();

            await expect(outputProbe?.({
                codec: 'vp8',
                configuration: {
                    codec: 'vp8',
                    codedHeight: 64,
                    codedWidth: 64
                },
                encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
                expectedCodedHeight: 64,
                expectedCodedWidth: 64,
                expectedDisplayHeight: 64,
                expectedDisplayWidth: 64,
                expectedTimestamp: 0
            })).resolves.toBe(supported);
            expect(closeFrame).toHaveBeenCalledTimes(frames.length);
            expect(closeDecoder).toHaveBeenCalledOnce();
        }
    );

    it('closes an ordinary native decoder whose flush never settles', async () => {
        vi.useFakeTimers();
        const closeDecoder = vi.fn();
        class FakeVideoDecoder {
            public state: CodecState = 'unconfigured';

            public close(): void {
                this.state = 'closed';
                closeDecoder();
            }

            public configure(): void {
                this.state = 'configured';
            }

            public decode(): void {
                return;
            }

            public flush(): Promise<void> {
                return new Promise<void>(() => undefined);
            }
        }
        class FakeEncodedVideoChunk {}
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        const outputProbe = createNativeVideoOutputProbe();
        const probePromise = outputProbe?.({
            codec: 'vp8',
            configuration: {
                codec: 'vp8',
                codedHeight: 64,
                codedWidth: 64
            },
            encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
            expectedCodedHeight: 64,
            expectedCodedWidth: 64,
            expectedDisplayHeight: 64,
            expectedDisplayWidth: 64,
            expectedTimestamp: 0
        });

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);

        await expect(probePromise).resolves.toBe(false);
        expect(closeDecoder).toHaveBeenCalledOnce();
    });

    it.each([
        {
            elapsedMilliseconds: 90,
            expectedMaximumFramesPerSecond: 60,
            expectedDecodedFrameFingerprint: 667_501_752,
            expectedFrameCopyCount: 8,
            outputCopySupported: true
        },
        {
            elapsedMilliseconds: 140,
            expectedMaximumFramesPerSecond: 30,
            expectedDecodedFrameFingerprint: 667_501_752,
            expectedFrameCopyCount: 8,
            outputCopySupported: true
        },
        {
            elapsedMilliseconds: 210,
            expectedMaximumFramesPerSecond: 24,
            expectedDecodedFrameFingerprint: 667_501_752,
            expectedFrameCopyCount: 8,
            outputCopySupported: true
        },
        {
            elapsedMilliseconds: 240,
            expectedMaximumFramesPerSecond: null,
            expectedDecodedFrameFingerprint: 667_501_752,
            expectedFrameCopyCount: 8,
            outputCopySupported: true
        },
        {
            elapsedMilliseconds: 90,
            expectedMaximumFramesPerSecond: null,
            expectedDecodedFrameFingerprint: 667_501_753,
            expectedFrameCopyCount: 1,
            outputCopySupported: false
        }
    ])(
        'requires multi-frame raw HDR decode and copy throughput: $elapsedMilliseconds ms',
        async ({
            elapsedMilliseconds,
            expectedMaximumFramesPerSecond,
            expectedDecodedFrameFingerprint,
            expectedFrameCopyCount,
            outputCopySupported
        }) => {
            let clockMilliseconds = 0;
            let copiedFrameCount = 0;
            let flushCount = 0;
            let openFrameCount = 0;
            let maximumOpenFrameCount = 0;
            const closeFrame = vi.fn();
            const copyFrame = vi.fn(async (): Promise<readonly PlaneLayout[]> => {
                if (copiedFrameCount > 0) {
                    clockMilliseconds += elapsedMilliseconds / 7;
                }
                copiedFrameCount += 1;
                return [
                    { offset: 0, stride: 7_680 },
                    { offset: 16_588_800, stride: 3_840 },
                    { offset: 20_736_000, stride: 3_840 }
                ];
            });
            class FakeVideoFrame {
                public readonly codedHeight = 2_160;
                public readonly codedWidth = 3_840;
                // Hardware-backed frames may expose no native CPU-readable format
                public readonly format = null;

                public constructor(public readonly timestamp: number) {
                    openFrameCount += 1;
                    maximumOpenFrameCount = Math.max(
                        maximumOpenFrameCount,
                        openFrameCount
                    );
                }

                public allocationSize(): number {
                    return 24_883_200;
                }

                public close(): void {
                    openFrameCount -= 1;
                    closeFrame();
                }

                public copyTo(): Promise<readonly PlaneLayout[]> {
                    return copyFrame();
                }
            }
            class FakeVideoDecoder {
                public constructor(private readonly callbacks: VideoDecoderInit) {}

                public close(): void {
                    return;
                }

                public configure(): void {
                    return;
                }

                public decode(chunk: { timestamp: number }): void {
                    this.callbacks.output(
                        new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame
                    );
                }

                public flush(): Promise<void> {
                    flushCount += 1;
                    clockMilliseconds += 10_000;
                    return Promise.resolve(undefined);
                }
            }
            class FakeEncodedVideoChunk {
                public readonly timestamp: number;

                public constructor(init: { timestamp: number }) {
                    this.timestamp = init.timestamp;
                }
            }
            const now = vi.fn((): number => clockMilliseconds);
            vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
            vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
            vi.stubGlobal('performance', { now });
            const outputProbe = createRawHDRVideoOutputProbe();

            const result = await outputProbe?.({
                codec: 'vp9',
                configuration: {
                    codec: 'vp09.02.10.10',
                    codedHeight: 2_160,
                    codedWidth: 3_840
                },
                encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
                expectedCodedHeight: 2_160,
                expectedCodedWidth: 3_840,
                expectedDecodedFrameFingerprint,
                expectedFormat: 'I420P10'
            });
            expect(result).toMatchObject({
                maximumFramesPerSecond: expectedMaximumFramesPerSecond,
                outputCopySupported
            });
            if (outputCopySupported) {
                expect(result?.measuredFramesPerSecond).toBeCloseTo(
                    7_000 / elapsedMilliseconds
                );
            } else {
                expect(result?.measuredFramesPerSecond).toBeNull();
            }
            expect(copyFrame).toHaveBeenCalledTimes(expectedFrameCopyCount);
            expect(closeFrame).toHaveBeenCalledTimes(expectedFrameCopyCount);
            expect(flushCount).toBe(outputCopySupported ? 1 : 0);
            expect(maximumOpenFrameCount).toBe(outputCopySupported ? 2 : 1);
        }
    );

    it('closes an owned raw frame when copyTo never settles', async () => {
        vi.useFakeTimers();
        const closeDecoder = vi.fn();
        const closeFrame = vi.fn();
        const copyFrame = vi.fn(() => new Promise<readonly PlaneLayout[]>(() => undefined));
        class FakeVideoFrame {
            public readonly codedHeight = 2_160;
            public readonly codedWidth = 3_840;
            public readonly format = 'I420P10';
            public readonly timestamp = 0;

            public allocationSize(): number {
                return 24_883_200;
            }

            public close(): void {
                closeFrame();
            }

            public copyTo(): Promise<readonly PlaneLayout[]> {
                return copyFrame();
            }
        }
        class FakeVideoDecoder {
            public constructor(private readonly callbacks: VideoDecoderInit) {}

            public close(): void {
                closeDecoder();
            }

            public configure(): void {
                return;
            }

            public decode(): void {
                this.callbacks.output(new FakeVideoFrame() as unknown as VideoFrame);
            }

            public flush(): Promise<void> {
                return Promise.resolve();
            }
        }
        class FakeEncodedVideoChunk {}
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        const outputProbe = createRawHDRVideoOutputProbe();
        const probePromise = outputProbe?.({
            codec: 'vp9',
            configuration: {
                codec: 'vp09.02.10.10',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840,
            expectedDecodedFrameFingerprint: 667_501_752,
            expectedFormat: 'I420P10'
        });

        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);

        await expect(probePromise).resolves.toEqual({
            maximumFramesPerSecond: null,
            measuredFramesPerSecond: null,
            outputCopySupported: false
        });
        expect(copyFrame).toHaveBeenCalledOnce();
        expect(closeFrame).toHaveBeenCalledOnce();
        expect(closeDecoder).toHaveBeenCalledOnce();
    });

    it('keeps qualified raw throughput when the final flush stalls', async () => {
        vi.useFakeTimers();
        const closeDecoder = vi.fn();
        const closeFrame = vi.fn();
        let clockMilliseconds = 0;
        let copiedFrameCount = 0;
        let flushCount = 0;
        class FakeVideoFrame {
            public readonly codedHeight = 2_160;
            public readonly codedWidth = 3_840;
            public readonly format = 'I420P10';

            public constructor(public readonly timestamp: number) {}

            public allocationSize(): number {
                return 24_883_200;
            }

            public close(): void {
                closeFrame();
            }

            public async copyTo(): Promise<readonly PlaneLayout[]> {
                if (copiedFrameCount > 0) {
                    clockMilliseconds += 80 / 7;
                }
                copiedFrameCount += 1;
                return [
                    { offset: 0, stride: 7_680 },
                    { offset: 16_588_800, stride: 3_840 },
                    { offset: 20_736_000, stride: 3_840 }
                ];
            }
        }
        class FakeVideoDecoder {
            public constructor(private readonly callbacks: VideoDecoderInit) {}

            public close(): void {
                closeDecoder();
            }

            public configure(): void {
                return;
            }

            public decode(chunk: { timestamp: number }): void {
                const frame = new FakeVideoFrame(chunk.timestamp) as unknown as VideoFrame;
                this.callbacks.output(frame);
            }

            public flush(): Promise<void> {
                flushCount += 1;
                return new Promise<void>(() => undefined);
            }
        }
        class FakeEncodedVideoChunk {
            public readonly timestamp: number;

            public constructor(init: { timestamp: number }) {
                this.timestamp = init.timestamp;
            }
        }
        vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
        vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
        vi.stubGlobal('performance', { now: (): number => clockMilliseconds });
        const outputProbe = createRawHDRVideoOutputProbe();
        const probePromise = outputProbe?.({
            codec: 'vp9',
            configuration: {
                codec: 'vp09.02.10.10',
                codedHeight: 2_160,
                codedWidth: 3_840
            },
            encodedKeyFrame: new Uint8Array([ 1, 2, 3 ]),
            expectedCodedHeight: 2_160,
            expectedCodedWidth: 3_840,
            expectedDecodedFrameFingerprint: 667_501_752,
            expectedFormat: 'I420P10'
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(flushCount).toBe(1);
        await vi.advanceTimersByTimeAsync(CAPABILITY_PROBE_TIMEOUT_MILLISECONDS);

        await expect(probePromise).resolves.toMatchObject({
            maximumFramesPerSecond: 60,
            outputCopySupported: true
        });
        expect(closeFrame).toHaveBeenCalledTimes(8);
        expect(closeDecoder).toHaveBeenCalledOnce();
    });
});
