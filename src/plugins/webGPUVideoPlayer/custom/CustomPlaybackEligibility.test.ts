import { describe, expect, it } from 'vitest';

import type {
    CustomAudioCodec,
    CustomDecodeCapabilities,
    CustomDecodeCodecCapability,
    CustomVideoCodec
} from './CustomDecodeCapabilities';
import { getCustomPlaybackEligibility } from './CustomPlaybackEligibility';
import type { CustomPlaybackRuntimeAvailability } from './CustomPlaybackRuntime';

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

function createCapabilities(): CustomDecodeCapabilities {
    return {
        audio: {
            aac: createCapability('aac', true),
            flac: createCapability('flac', true),
            mp3: createCapability('mp3', true),
            opus: createCapability('opus', true),
            vorbis: createCapability('vorbis', true)
        },
        telemetry: {
            audioProbeCount: 5,
            reason: 'complete',
            supportedAudioCodecCount: 5,
            supportedVideoCodecCount: 5,
            unknownAudioCodecCount: 0,
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

function createOptions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        mediaSource: {
            Container: 'mov,mp4,m4a,3gp,3g2,mj2',
            DefaultAudioStreamIndex: 1,
            MediaStreams: [
                {
                    Codec: 'h264',
                    Index: 0,
                    Type: 'Video',
                    VideoRangeType: 'SDR'
                },
                { Codec: 'aac', Index: 1, Type: 'Audio' }
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
    it('selects global video and audio indexes with integer-microsecond timing', () => {
        expect(getCustomPlaybackEligibility(
            createOptions(),
            createCapabilities(),
            { allowHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({
            audioTrackIndex: 1,
            durationMicroseconds: 6_000_000,
            eligible: true,
            hdr: false,
            startTimeMicroseconds: 1_000_000,
            videoTrackIndex: 0
        });
    });

    it('accepts measured HEVC/PQ Matroska only when HDR is allowed', () => {
        const hdrOptions = createOptions({
            mediaSource: {
                Container: 'mkv',
                DefaultAudioStreamIndex: 1,
                MediaStreams: [
                    {
                        BitDepth: 10,
                        Codec: 'hevc',
                        ColorPrimaries: 'bt2020',
                        ColorSpace: 'bt2020nc',
                        ColorTransfer: 'smpte2084',
                        Index: 0,
                        Type: 'Video',
                        VideoRange: 'HDR',
                        VideoRangeType: 'HDR10'
                    },
                    { Codec: 'flac', Index: 1, Type: 'Audio' }
                ],
                RunTimeTicks: 60_000_000
            }
        });

        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            { allowHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'hdr-validation-required' });
        expect(getCustomPlaybackEligibility(
            hdrOptions,
            createCapabilities(),
            { allowHDR: true, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toMatchObject({ eligible: true, hdr: true });
    });

    it.each([
        [ { playMethod: 'Transcode' }, 'play-method-unsupported' ],
        [ { mediaSource: { Container: 'avi', MediaStreams: [], RunTimeTicks: 1 } }, 'container-unsupported' ],
        [ { url: 'file:///movie.mkv' }, 'url-unsupported' ]
    ])('rejects unsafe source overrides %#', (overrides, reason) => {
        expect(getCustomPlaybackEligibility(
            createOptions(overrides),
            createCapabilities(),
            { allowHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
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
            { allowHDR: false, runtimeAvailability: AVAILABLE_RUNTIME }
        )).toEqual({ eligible: false, reason: 'audio-codec-unsupported' });

        expect(getCustomPlaybackEligibility(
            createOptions(),
            createCapabilities(),
            {
                allowHDR: false,
                runtimeAvailability: {
                    ...AVAILABLE_RUNTIME,
                    available: false,
                    reason: 'webgpu-unavailable'
                }
            }
        )).toEqual({ eligible: false, reason: 'runtime-unavailable' });
    });
});
