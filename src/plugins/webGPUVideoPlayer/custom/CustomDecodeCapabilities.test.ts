import { afterEach, describe, expect, it, vi } from 'vitest';

import CustomDecodeCapabilityProbe, {
    createRawHDRVideoOutputProbe,
    CUSTOM_BUNDLED_AUDIO_CODECS,
    CUSTOM_RAW_HDR_VIDEO_CODECS,
    CUSTOM_VIDEO_CODECS,
    CUSTOM_WEB_CODECS_AUDIO_CODECS,
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
    rawHDRVideoOutputProbe: ReturnType<typeof vi.fn>
    videoProbe: ReturnType<typeof vi.fn>
};

const CAPABILITY_PROBE_TIMEOUT_MILLISECONDS = 2_000;

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
        maximumBitrate: ultraHD ? 40_000_000 : 12_000_000,
        maximumCodedHeight: ultraHD ? 2_160 : 1_080,
        maximumCodedWidth: ultraHD ? 3_840 : 1_920,
        maximumLevel: ultraHD ? 153 : 120,
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

function createEnvironment(
    videoSupport: ReadonlySet<string>,
    audioSupport: ReadonlySet<string>,
    rawHDRVideoOutputSupport: ReadonlySet<string> = new Set<string>()
): CapabilityEnvironmentHarness {
    const videoProbe = vi.fn(async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
        config,
        supported: videoSupport.has(config.codec)
    }));
    const audioProbe = vi.fn(async (config: AudioDecoderConfig): Promise<AudioDecoderSupport> => ({
        config,
        supported: audioSupport.has(config.codec)
    }));
    const rawHDRVideoOutputProbe = vi.fn(async (probeRequest: {
        codec: string
    }): Promise<boolean> => rawHDRVideoOutputSupport.has(probeRequest.codec));
    return {
        audioProbe,
        environment: {
            audioDecoder: { isConfigSupported: audioProbe },
            bundledAC3SoftwareDecoder: true,
            bundledHEVCExactProbe: {
                probe: vi.fn(async () => BUNDLED_HEVC_EXACT_CAPABILITIES)
            },
            rawHDRVideoOutputProbe,
            videoDecoder: { isConfigSupported: videoProbe }
        },
        rawHDRVideoOutputProbe,
        videoProbe
    };
}

describe('CustomDecodeCapabilityProbe', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('probes every representative WebCodecs configuration and records support', async () => {
        const harness = createEnvironment(
            new Set([ 'avc1.640028', 'vp09.00.10.08', 'vp09.02.10.10' ]),
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
            'hvc1.2.4.L153.B0',
            'vp09.02.10.10',
            'av01.0.08M.10'
        ]);
        expect(harness.audioProbe.mock.calls.map(call => call[0].codec)).toEqual([
            'mp4a.40.2',
            'opus',
            'flac',
            'mp3',
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
            hevc: { reason: 'bundled-software-decoder', status: 'supported' },
            vp9: { reason: 'output-copy-supported', status: 'supported' }
        });
        expect(harness.rawHDRVideoOutputProbe).toHaveBeenCalledOnce();
        expect(harness.rawHDRVideoOutputProbe.mock.calls[0][0]).toMatchObject({
            codec: 'vp9',
            configuration: {
                hardwareAcceleration: 'prefer-software'
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
            bundledAudioCodecCount: 2,
            rawHDRVideoProbeCount: 3,
            reason: 'complete',
            supportedAudioCodecCount: 4,
            supportedRawHDRVideoCodecCount: 2,
            supportedVideoCodecCount: 2,
            unknownAudioCodecCount: 0,
            unknownVideoCodecCount: 0,
            videoProbeCount: 5
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
            CUSTOM_VIDEO_CODECS.length + CUSTOM_RAW_HDR_VIDEO_CODECS.length
        );
        expect(harness.audioProbe).toHaveBeenCalledTimes(CUSTOM_WEB_CODECS_AUDIO_CODECS.length);
    });

    it('does not advertise bundled AC3 codecs when the build excludes them', async () => {
        const harness = createEnvironment(new Set(), new Set());
        harness.environment.bundledAC3SoftwareDecoder = false;

        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        for (const codec of CUSTOM_BUNDLED_AUDIO_CODECS) {
            expect(capabilities.audio[codec]).toMatchObject({
                reason: 'build-disabled',
                status: 'unsupported'
            });
        }
        expect(capabilities.telemetry).toMatchObject({
            bundledAudioCodecCount: 0,
            supportedAudioCodecCount: 0
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
            bundledHEVCExactProbe: {
                probe: vi.fn(async () => BUNDLED_HEVC_EXACT_CAPABILITIES)
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
        expect(capabilities.telemetry.unknownVideoCodecCount).toBe(1);
    });

    it('bounds decoder capability APIs that never settle', async () => {
        vi.useFakeTimers();
        const videoProbe = vi.fn(() => new Promise<VideoDecoderSupport>(() => undefined));
        const audioProbe = vi.fn(() => new Promise<AudioDecoderSupport>(() => undefined));
        const rawHDRVideoOutputProbe = vi.fn(() => new Promise<boolean>(() => undefined));
        const probePromise = new CustomDecodeCapabilityProbe({
            audioDecoder: { isConfigSupported: audioProbe },
            bundledHEVCExactProbe: {
                probe: vi.fn(async () => BUNDLED_HEVC_EXACT_CAPABILITIES)
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
            bundledAC3SoftwareDecoder: true,
            bundledHEVCExactProbe: {
                probe: vi.fn(async () => BUNDLED_HEVC_EXACT_CAPABILITIES)
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
            bundledAudioCodecCount: 2,
            rawHDRVideoProbeCount: 0,
            reason: 'api-unavailable',
            supportedAudioCodecCount: 2,
            supportedRawHDRVideoCodecCount: 1,
            videoProbeCount: 0
        });
    });

    it('reports a partial runtime when only one decoder API exists', async () => {
        const harness = createEnvironment(new Set([ 'vp8' ]), new Set());
        const capabilities = await new CustomDecodeCapabilityProbe({
            audioDecoder: null,
            bundledHEVCExactProbe: {
                probe: vi.fn(async () => BUNDLED_HEVC_EXACT_CAPABILITIES)
            },
            videoDecoder: harness.environment.videoDecoder
        }).probe();

        expect(capabilities.telemetry.reason).toBe('partial-api');
        expect(capabilities.telemetry.unknownAudioCodecCount).toBe(CUSTOM_WEB_CODECS_AUDIO_CODECS.length);
        expect(capabilities.video.vp8.status).toBe('supported');
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
            reason: 'bundled-software-decoder',
            status: 'supported'
        });
        expect(bothTiers.rawHDRVideo.hevc).toMatchObject({
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
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

    it.each([
        {
            elapsedMilliseconds: 100,
            expectedDecodedFrameFingerprint: 667_501_752,
            expectedFrameCopyCount: 5,
            supported: true
        },
        {
            elapsedMilliseconds: 100,
            expectedDecodedFrameFingerprint: 667_501_753,
            expectedFrameCopyCount: 1,
            supported: false
        },
        {
            elapsedMilliseconds: 200,
            expectedDecodedFrameFingerprint: 667_501_752,
            expectedFrameCopyCount: 5,
            supported: false
        }
    ])(
        'requires multi-frame raw HDR decode and copy throughput: $elapsedMilliseconds ms',
        async ({
            elapsedMilliseconds,
            expectedDecodedFrameFingerprint,
            expectedFrameCopyCount,
            supported
        }) => {
            const closeFrame = vi.fn();
            const copyFrame = vi.fn(async (): Promise<readonly PlaneLayout[]> => ([
                { offset: 0, stride: 7_680 },
                { offset: 16_588_800, stride: 3_840 },
                { offset: 20_736_000, stride: 3_840 }
            ]));
            class FakeVideoFrame {
                public readonly codedHeight = 2_160;
                public readonly codedWidth = 3_840;
                public readonly format = 'I420P10';

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
                    return;
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
            const now = vi.fn()
                .mockReturnValueOnce(0)
                .mockReturnValueOnce(elapsedMilliseconds);
            vi.stubGlobal('VideoDecoder', FakeVideoDecoder);
            vi.stubGlobal('EncodedVideoChunk', FakeEncodedVideoChunk);
            vi.stubGlobal('performance', { now });
            const outputProbe = createRawHDRVideoOutputProbe();

            await expect(outputProbe?.({
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
            })).resolves.toBe(supported);
            expect(copyFrame).toHaveBeenCalledTimes(expectedFrameCopyCount);
            expect(closeFrame).toHaveBeenCalledTimes(expectedFrameCopyCount);
        }
    );
});
