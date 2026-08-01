import { describe, expect, it, vi } from 'vitest';

import {
    getSupportedNativeMediaAudioRoute,
    probeNativeMediaAudioCapabilities,
    type NativeMediaAudioExactProbeRequest
} from './NativeMediaAudioCapabilities';
import { createNativeMediaAudioProbeFixture } from './NativeMediaAudioCapabilityFixtures';

describe('NativeMediaAudioCapabilities', () => {
    it('ships fresh exact fMP4 fixtures for every qualified layout', () => {
        for (const codec of [ 'ac3', 'eac3' ] as const) {
            for (const channelCount of [ 2, 6 ] as const) {
                const firstFixture = createNativeMediaAudioProbeFixture(codec, channelCount);
                const secondFixture = createNativeMediaAudioProbeFixture(codec, channelCount);
                expect(firstFixture).not.toBe(secondFixture);
                expect(firstFixture.byteLength).toBeGreaterThan(1_000);
                expect(Array.from(firstFixture.slice(4, 8))).toEqual([
                    'f'.charCodeAt(0),
                    't'.charCodeAt(0),
                    'y'.charCodeAt(0),
                    'p'.charCodeAt(0)
                ]);
                firstFixture[0] = 0xFF;
                expect(secondFixture[0]).not.toBe(0xFF);
            }
        }
    });

    it('reports unknown routes when MSE capability discovery is unavailable', async () => {
        const exactPlaybackProbe = vi.fn();
        const capabilities = await probeNativeMediaAudioCapabilities({
            exactPlaybackProbe,
            isTypeSupported: null
        });

        expect(exactPlaybackProbe).not.toHaveBeenCalled();
        expect(capabilities.audio.ac3.status).toBe('unknown');
        expect(capabilities.audio.eac3.layouts[6]).toMatchObject({
            reason: 'api-unavailable',
            status: 'unknown'
        });
        expect(capabilities.telemetry).toEqual({
            probeCount: 0,
            supportedLayoutCount: 0,
            unknownLayoutCount: 4
        });
    });

    it('does not run fixtures for MIME types rejected by MediaSource', async () => {
        const exactPlaybackProbe = vi.fn();
        const capabilities = await probeNativeMediaAudioCapabilities({
            exactPlaybackProbe,
            isTypeSupported: () => false
        });

        expect(exactPlaybackProbe).not.toHaveBeenCalled();
        expect(capabilities.audio.ac3.layouts[2]).toMatchObject({
            reason: 'mime-unsupported',
            status: 'unsupported'
        });
        expect(capabilities.audio.eac3.status).toBe('unsupported');
    });

    it('supports only exact layouts whose fixture playback advances', async () => {
        const probeInputs: NativeMediaAudioExactProbeRequest[] = [];
        const capabilities = await probeNativeMediaAudioCapabilities({
            exactPlaybackProbe: async probeInput => {
                probeInputs.push(probeInput);
                const supported = probeInput.codec === 'eac3'
                    && probeInput.channelCount === 6;
                return {
                    reason: supported ?
                        'decoded-playback-advanced' :
                        'playback-not-advanced',
                    supported
                };
            },
            isTypeSupported: () => true
        });

        expect(probeInputs).toHaveLength(4);
        expect(probeInputs.every(probeInput => probeInput.fixture.byteLength > 1_000))
            .toBe(true);
        expect(capabilities.audio.ac3.status).toBe('unsupported');
        expect(capabilities.audio.eac3.status).toBe('supported');
        expect(capabilities.audio.eac3.layouts[6]).toMatchObject({
            codecString: 'ec-3',
            mimeType: 'audio/mp4; codecs="ec-3"',
            reason: 'decoded-playback-advanced',
            status: 'supported'
        });
        expect(capabilities.telemetry).toEqual({
            probeCount: 4,
            supportedLayoutCount: 1,
            unknownLayoutCount: 0
        });

        expect(getSupportedNativeMediaAudioRoute(capabilities, 'eac3', 6, 48_000))
            .toEqual({
                channelCount: 6,
                codec: 'eac3',
                codecString: 'ec-3',
                mimeType: 'audio/mp4; codecs="ec-3"',
                sampleRate: 48_000
            });
        expect(getSupportedNativeMediaAudioRoute(capabilities, 'eac3', 2, 48_000))
            .toBeNull();
        expect(getSupportedNativeMediaAudioRoute(capabilities, 'eac3', 6, 44_100))
            .toBeNull();
        expect(getSupportedNativeMediaAudioRoute(capabilities, 'eac3', 8, 48_000))
            .toBeNull();
    });

    it('keeps probe exceptions unknown instead of advertising the route', async () => {
        const capabilities = await probeNativeMediaAudioCapabilities({
            exactPlaybackProbe: () => Promise.reject(new Error('probe failed')),
            isTypeSupported: () => true
        });

        expect(capabilities.audio.ac3.status).toBe('unknown');
        expect(capabilities.audio.eac3.status).toBe('unknown');
        expect(capabilities.telemetry.unknownLayoutCount).toBe(4);
    });
});
