import { describe, expect, it } from 'vitest';

import {
    getCustomPlaybackRuntimeAvailability,
    type CustomPlaybackRuntimeEnvironment
} from './CustomPlaybackRuntime';

function createEnvironment(
    overrides: Partial<CustomPlaybackRuntimeEnvironment> = {}
): CustomPlaybackRuntimeEnvironment {
    return {
        animationFrame: true,
        audioContext: true,
        audioData: true,
        audioDecoder: true,
        audioWorklet: true,
        secureContext: true,
        videoDecoder: true,
        videoFrame: true,
        webGPU: true,
        worker: true,
        ...overrides
    };
}

describe('CustomPlaybackRuntime', () => {
    it('requires common presentation and worker primitives for every path', () => {
        expect(getCustomPlaybackRuntimeAvailability(createEnvironment())).toMatchObject({
            available: true,
            reason: null
        });

        expect(getCustomPlaybackRuntimeAvailability(createEnvironment({ webGPU: false }))).toMatchObject({
            available: false,
            reason: 'webgpu-unavailable'
        });
        expect(getCustomPlaybackRuntimeAvailability(createEnvironment({ videoFrame: false }))).toMatchObject({
            available: false,
            reason: 'video-frame-unavailable'
        });
    });

    it('requires native decoder APIs only for paths which use them', () => {
        const bundledDecoderEnvironment = createEnvironment({
            audioData: false,
            audioDecoder: false,
            videoDecoder: false
        });

        expect(getCustomPlaybackRuntimeAvailability(bundledDecoderEnvironment)).toMatchObject({
            available: true,
            reason: null
        });
        expect(getCustomPlaybackRuntimeAvailability(bundledDecoderEnvironment, {
            nativeVideoDecoder: true
        })).toMatchObject({
            available: false,
            reason: 'video-decoder-unavailable'
        });
        expect(getCustomPlaybackRuntimeAvailability(bundledDecoderEnvironment, {
            nativeAudioDecoder: true
        })).toMatchObject({
            available: false,
            reason: 'audio-decoder-unavailable'
        });
    });

    it('requires browser audio output only when a source selects audio', () => {
        const silentEnvironment = createEnvironment({
            audioContext: false,
            audioWorklet: false
        });

        expect(getCustomPlaybackRuntimeAvailability(silentEnvironment)).toMatchObject({
            available: true,
            reason: null
        });
        expect(getCustomPlaybackRuntimeAvailability(silentEnvironment, {
            audioOutput: true
        })).toMatchObject({
            available: false,
            reason: 'audio-context-unavailable'
        });
    });

    it('snapshots the supplied environment', () => {
        const environment = createEnvironment();
        const result = getCustomPlaybackRuntimeAvailability(environment);
        environment.videoDecoder = false;

        expect(result.available).toBe(true);
        expect(result.environment.videoDecoder).toBe(true);
        expect(Object.isFrozen(result.environment)).toBe(true);
        expect(Object.isFrozen(result)).toBe(true);
    });
});
