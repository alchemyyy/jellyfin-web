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
    it('requires the complete client-side A/V pipeline before profile widening', () => {
        expect(getCustomPlaybackRuntimeAvailability(createEnvironment())).toMatchObject({
            available: true,
            reason: null
        });

        expect(getCustomPlaybackRuntimeAvailability(createEnvironment({ webGPU: false }))).toMatchObject({
            available: false,
            reason: 'webgpu-unavailable'
        });
        expect(getCustomPlaybackRuntimeAvailability(createEnvironment({ audioWorklet: false }))).toMatchObject({
            available: false,
            reason: 'audio-worklet-unavailable'
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
