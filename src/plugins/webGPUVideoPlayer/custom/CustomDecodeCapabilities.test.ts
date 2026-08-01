import { describe, expect, it, vi } from 'vitest';

import CustomDecodeCapabilityProbe, {
    CUSTOM_AUDIO_CODECS,
    CUSTOM_VIDEO_CODECS,
    type WebCodecsCapabilityEnvironment
} from './CustomDecodeCapabilities';

type CapabilityEnvironmentHarness = {
    audioProbe: ReturnType<typeof vi.fn>
    environment: WebCodecsCapabilityEnvironment
    videoProbe: ReturnType<typeof vi.fn>
};

function createEnvironment(
    videoSupport: ReadonlySet<string>,
    audioSupport: ReadonlySet<string>
): CapabilityEnvironmentHarness {
    const videoProbe = vi.fn(async (config: VideoDecoderConfig): Promise<VideoDecoderSupport> => ({
        config,
        supported: videoSupport.has(config.codec)
    }));
    const audioProbe = vi.fn(async (config: AudioDecoderConfig): Promise<AudioDecoderSupport> => ({
        config,
        supported: audioSupport.has(config.codec)
    }));
    return {
        audioProbe,
        environment: {
            audioDecoder: { isConfigSupported: audioProbe },
            videoDecoder: { isConfigSupported: videoProbe }
        },
        videoProbe
    };
}

describe('CustomDecodeCapabilityProbe', () => {
    it('probes every representative WebCodecs configuration and records support', async () => {
        const harness = createEnvironment(
            new Set([ 'avc1.640028', 'vp09.00.10.08' ]),
            new Set([ 'mp4a.40.2', 'flac' ])
        );
        const capabilities = await new CustomDecodeCapabilityProbe(harness.environment).probe();

        expect(harness.videoProbe.mock.calls.map(call => call[0].codec)).toEqual([
            'avc1.640028',
            'hvc1.1.6.L120.B0',
            'vp8',
            'vp09.00.10.08',
            'av01.0.08M.08'
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
        expect(capabilities.audio.flac.status).toBe('supported');
        expect(capabilities.telemetry).toEqual({
            audioProbeCount: 5,
            reason: 'complete',
            supportedAudioCodecCount: 2,
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
        expect(harness.videoProbe).toHaveBeenCalledTimes(CUSTOM_VIDEO_CODECS.length);
        expect(harness.audioProbe).toHaveBeenCalledTimes(CUSTOM_AUDIO_CODECS.length);
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

    it('uses unknown API-unavailable results without making support claims', async () => {
        const capabilities = await new CustomDecodeCapabilityProbe({
            audioDecoder: null,
            videoDecoder: null
        }).probe();

        for (const codec of CUSTOM_VIDEO_CODECS) {
            expect(capabilities.video[codec]).toMatchObject({
                reason: 'api-unavailable',
                status: 'unknown'
            });
        }
        for (const codec of CUSTOM_AUDIO_CODECS) {
            expect(capabilities.audio[codec]).toMatchObject({
                reason: 'api-unavailable',
                status: 'unknown'
            });
        }
        expect(capabilities.telemetry).toMatchObject({
            audioProbeCount: 0,
            reason: 'api-unavailable',
            videoProbeCount: 0
        });
    });

    it('reports a partial runtime when only one decoder API exists', async () => {
        const harness = createEnvironment(new Set([ 'vp8' ]), new Set());
        const capabilities = await new CustomDecodeCapabilityProbe({
            audioDecoder: null,
            videoDecoder: harness.environment.videoDecoder
        }).probe();

        expect(capabilities.telemetry.reason).toBe('partial-api');
        expect(capabilities.telemetry.unknownAudioCodecCount).toBe(CUSTOM_AUDIO_CODECS.length);
        expect(capabilities.video.vp8.status).toBe('supported');
    });
});
