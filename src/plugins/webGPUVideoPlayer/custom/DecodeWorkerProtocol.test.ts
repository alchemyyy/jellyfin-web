import { describe, expect, it, vi } from 'vitest';

import {
    isDecodeWorkerRequest,
    isDecodeWorkerResponse,
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
    MAX_DECODED_FRAME_CREDITS
} from './DecodeWorkerProtocol';

describe('DecodeWorkerProtocol', () => {
    it('accepts integer-microsecond start and frame messages', () => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 1,
            startTimeMicroseconds: -1_000_000,
            type: 'start',
            url: 'http://localhost/video.mp4',
            videoTrackIndex: 0
        })).toBe(true);

        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            frame: { close: vi.fn() },
            generation: 1,
            mediaTimeMicroseconds: -500_000,
            type: 'frame'
        })).toBe(true);
    });

    it('rejects floating-point timestamps and invalid frame credits', () => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            frameCredits: MAX_DECODED_FRAME_CREDITS + 1,
            generation: 1,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mp4',
            videoTrackIndex: 0
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            frameCredits: 1,
            generation: 1,
            startTimeMicroseconds: 0.5,
            type: 'start',
            url: 'http://localhost/video.mp4',
            videoTrackIndex: 0
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            frame: { close: vi.fn() },
            generation: 1,
            mediaTimeMicroseconds: 0.25,
            type: 'frame'
        })).toBe(false);
    });

    it('rejects malformed generations, dimensions, and failures', () => {
        expect(isDecodeWorkerRequest({ generation: 0, type: 'stop' })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: null,
            codec: 'avc1.640028',
            codedHeight: 1080,
            codedWidth: 0,
            displayHeight: 1080,
            displayWidth: 1920,
            generation: 1,
            type: 'ready'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            failureKind: 'unknown',
            generation: 1,
            message: 'failed',
            type: 'error'
        })).toBe(false);
    });

    it('validates bounded planar PCM and independent audio credits', () => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: MAX_DECODED_AUDIO_SAMPLE_CREDITS,
            audioTrackIndex: 1,
            frameCredits: 1,
            generation: 2,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoTrackIndex: 0
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 2,
            generation: 2,
            type: 'pull-audio'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            channelCount: 2,
            channelData: [ new Float32Array(1_024), new Float32Array(1_024) ],
            durationMicroseconds: 21_333,
            frameCount: 1_024,
            generation: 2,
            mediaTimeMicroseconds: -21_333,
            sampleRate: 48_000,
            type: 'audio'
        })).toBe(true);

        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: 1,
            frameCredits: 1,
            generation: 2,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoTrackIndex: 0
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 1,
            audioTrackIndex: null,
            frameCredits: 1,
            generation: 2,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoTrackIndex: 0
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            channelCount: 2,
            channelData: [ new Float32Array(1_024), new Float32Array(512) ],
            durationMicroseconds: 21_333,
            frameCount: 1_024,
            generation: 2,
            mediaTimeMicroseconds: 0,
            sampleRate: 48_000,
            type: 'audio'
        })).toBe(false);
    });
});
