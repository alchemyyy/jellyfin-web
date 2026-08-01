import { describe, expect, it, vi } from 'vitest';

import { millisecondsToMicroseconds, type Microseconds } from '../MediaTime';
import CustomDecodeNativeAudioBridge, {
    INITIAL_NATIVE_AUDIO_SEGMENT_CREDITS,
    type OwnedNativeMediaAudioBackendPort
} from './CustomDecodeNativeAudioBridge';
import type {
    DecodeWorkerNativeAudioInitializationResponse,
    DecodeWorkerNativeAudioMediaResponse,
    DecodeWorkerNativeMediaAudioConfiguration
} from './DecodeWorkerProtocol';
import type {
    OwnedNativeMediaAudioEventHandler,
    OwnedNativeMediaAudioSegment,
    OwnedNativeMediaAudioStartOptions,
    OwnedNativeMediaAudioTelemetry
} from './OwnedNativeMediaAudioBackend';

const CONFIGURATION: DecodeWorkerNativeMediaAudioConfiguration = {
    channelCount: 6,
    codec: 'ec-3',
    mimeType: 'audio/mp4; codecs="ec-3"',
    outputMode: 'native-media',
    sampleRate: 48_000
};

function createInitializationMessage(
    generation: number
): DecodeWorkerNativeAudioInitializationResponse {
    return {
        data: new Uint8Array([ 1, 2, 3 ]).buffer,
        generation,
        type: 'native-audio-init'
    };
}

function createMediaMessage(
    generation: number,
    startTimeMicroseconds: Microseconds = millisecondsToMicroseconds(0)
): DecodeWorkerNativeAudioMediaResponse {
    return {
        data: new Uint8Array([ 4, 5, 6 ]).buffer,
        endTimeMicroseconds: millisecondsToMicroseconds(
            startTimeMicroseconds / 1_000 + 500
        ),
        generation,
        startTimeMicroseconds,
        type: 'native-audio-media'
    };
}

class FakeOwnedNativeMediaAudioBackend implements OwnedNativeMediaAudioBackendPort {
    public activeGeneration: number | null = null;
    public readonly appendedOperations: string[] = [];
    public authoritativeTimeMicroseconds: Microseconds | null = null;
    public destroyed = false;
    public muted = false;
    public playbackRate = 1;
    public playing = false;
    public volume = 1;

    public constructor(public readonly eventHandler: OwnedNativeMediaAudioEventHandler) {}

    public async start(options: OwnedNativeMediaAudioStartOptions): Promise<void> {
        this.activeGeneration = options.generation;
        this.appendedOperations.push(`start:${options.generation}`);
    }

    public async appendInitializationSegment(
        generation: number,
        data: Uint8Array
    ): Promise<boolean> {
        if (generation !== this.activeGeneration) {
            return false;
        }
        if (data.byteLength === 0) {
            return false;
        }
        this.appendedOperations.push('initialization');
        return true;
    }

    public async appendMediaSegment(
        generation: number,
        segment: OwnedNativeMediaAudioSegment
    ): Promise<boolean> {
        if (generation !== this.activeGeneration) {
            return false;
        }
        this.appendedOperations.push(`media:${segment.startTimeMicroseconds}`);
        return true;
    }

    public async endOfStream(generation: number): Promise<boolean> {
        if (generation !== this.activeGeneration) {
            return false;
        }
        this.appendedOperations.push('end');
        return true;
    }

    public async setPlaying(generation: number, playing: boolean): Promise<boolean> {
        if (generation !== this.activeGeneration) {
            return false;
        }
        this.playing = playing;
        return true;
    }

    public seek(generation: number, mediaTimeMicroseconds: Microseconds): boolean {
        if (generation !== this.activeGeneration) {
            return false;
        }
        this.authoritativeTimeMicroseconds = mediaTimeMicroseconds;
        return true;
    }

    public setVolume(volume: number): void {
        this.volume = volume;
    }

    public setMuted(muted: boolean): void {
        this.muted = muted;
    }

    public setPlaybackRate(playbackRate: number): void {
        this.playbackRate = playbackRate;
    }

    public getAuthoritativeTimeMicroseconds(): Microseconds | null {
        return this.authoritativeTimeMicroseconds;
    }

    public getTelemetry(): OwnedNativeMediaAudioTelemetry {
        return {
            activeGeneration: this.activeGeneration,
            appendedByteLength: 0,
            appendedSegmentCount: 0,
            clockQualified: this.authoritativeTimeMicroseconds !== null,
            currentTimeMicroseconds: this.authoritativeTimeMicroseconds,
            pendingAppendByteLength: 0,
            pendingAppendCount: 0,
            removedRangeCount: 0,
            staleOperationCount: 0,
            state: this.destroyed ? 'destroyed' : 'open'
        };
    }

    public async stop(generation: number): Promise<boolean> {
        if (generation !== this.activeGeneration) {
            return false;
        }
        this.appendedOperations.push(`stop:${generation}`);
        this.activeGeneration = null;
        return true;
    }

    public async destroy(): Promise<void> {
        this.destroyed = true;
        this.activeGeneration = null;
    }
}

type BridgeHarness = {
    backend: FakeOwnedNativeMediaAudioBackend
    bridge: CustomDecodeNativeAudioBridge
};

function createBridgeHarness(): BridgeHarness {
    let backend: FakeOwnedNativeMediaAudioBackend | null = null;
    const bridge = new CustomDecodeNativeAudioBridge(eventHandler => {
        backend = new FakeOwnedNativeMediaAudioBackend(eventHandler);
        return backend;
    });
    if (!backend) {
        throw new Error('Native audio backend factory was not called');
    }
    return { backend, bridge };
}

describe('CustomDecodeNativeAudioBridge', () => {
    it('feeds initialization and bounded media to one backend with exact credits', async () => {
        const { backend, bridge } = createBridgeHarness();
        const onCreditsReleased = vi.fn();
        const onFailure = vi.fn();
        await expect(bridge.start({
            audioConfiguration: CONFIGURATION,
            callbacks: {
                onClockReady: vi.fn(),
                onCreditsReleased,
                onFailure
            },
            durationMicroseconds: millisecondsToMicroseconds(10_000),
            generation: 1,
            startTimeMicroseconds: millisecondsToMicroseconds(0)
        })).resolves.toBe(true);

        expect(bridge.initialAudioSegmentCredits).toBe(INITIAL_NATIVE_AUDIO_SEGMENT_CREDITS);
        await expect(bridge.enqueueInitialization(createInitializationMessage(1)))
            .resolves.toBe(true);
        await expect(bridge.enqueueMedia(createMediaMessage(1))).resolves.toBe(true);
        await expect(bridge.enqueueMedia(createMediaMessage(
            1,
            millisecondsToMicroseconds(500)
        ))).resolves.toBe(true);
        await expect(bridge.endOfStream(1)).resolves.toBe(true);

        expect(backend.appendedOperations).toEqual([
            'start:1',
            'initialization',
            'media:0',
            'media:500000',
            'end'
        ]);
        expect(onCreditsReleased).toHaveBeenCalledTimes(2);
        expect(onCreditsReleased).toHaveBeenNthCalledWith(1, 1);
        expect(onCreditsReleased).toHaveBeenNthCalledWith(2, 1);
        expect(onFailure).not.toHaveBeenCalled();
        expect(bridge.getTelemetry()).toMatchObject({
            activeGeneration: 1,
            initializationSegmentCount: 1,
            mediaSegmentCount: 2,
            releasedCreditCount: 2,
            staleMessageCount: 0,
            state: 'ready'
        });
    });

    it('latches malformed ordering failures and rejects stale generations', async () => {
        const { bridge } = createBridgeHarness();
        const onFailure = vi.fn();
        await bridge.start({
            audioConfiguration: CONFIGURATION,
            callbacks: {
                onClockReady: vi.fn(),
                onCreditsReleased: vi.fn(),
                onFailure
            },
            durationMicroseconds: millisecondsToMicroseconds(10_000),
            generation: 2,
            startTimeMicroseconds: millisecondsToMicroseconds(0)
        });

        await expect(bridge.enqueueMedia(createMediaMessage(2))).resolves.toBe(false);
        await expect(bridge.enqueueMedia(createMediaMessage(2))).resolves.toBe(false);
        await expect(bridge.enqueueInitialization(createInitializationMessage(1)))
            .resolves.toBe(false);

        expect(onFailure).toHaveBeenCalledOnce();
        expect(onFailure).toHaveBeenCalledWith('Native audio media arrived before initialization');
        expect(bridge.getTelemetry().staleMessageCount).toBe(1);
    });

    it('forwards clock and transport controls only for the active generation', async () => {
        const { backend, bridge } = createBridgeHarness();
        const onClockReady = vi.fn();
        const onEvent = vi.fn();
        await bridge.start({
            audioConfiguration: CONFIGURATION,
            callbacks: {
                onClockReady,
                onCreditsReleased: vi.fn(),
                onEvent,
                onFailure: vi.fn()
            },
            durationMicroseconds: millisecondsToMicroseconds(10_000),
            generation: 3,
            startTimeMicroseconds: millisecondsToMicroseconds(1_000)
        });

        const clockTimeMicroseconds = millisecondsToMicroseconds(1_250);
        backend.authoritativeTimeMicroseconds = clockTimeMicroseconds;
        backend.eventHandler({ generation: 3, type: 'clock-ready' });
        backend.eventHandler({ generation: 2, type: 'clock-ready' });
        bridge.setVolume(0.5);
        bridge.setMuted(true);
        bridge.setPlaybackRate(1.25);
        await bridge.setPlaying(true);

        expect(onClockReady).toHaveBeenCalledOnce();
        expect(onClockReady).toHaveBeenCalledWith(3);
        expect(onEvent).toHaveBeenCalledOnce();
        expect(bridge.getAuthoritativeTimeMicroseconds()).toBe(clockTimeMicroseconds);
        expect(backend.volume).toBe(0.5);
        expect(backend.muted).toBe(true);
        expect(backend.playbackRate).toBe(1.25);
        expect(backend.playing).toBe(true);

        await expect(bridge.stop(3)).resolves.toBe(true);
        await expect(bridge.enqueueInitialization(createInitializationMessage(3)))
            .resolves.toBe(false);
        expect(backend.appendedOperations.filter(operation => operation === 'stop:3'))
            .toHaveLength(1);
    });

    it('destroys the owned backend once and rejects later starts', async () => {
        const { backend, bridge } = createBridgeHarness();
        await bridge.destroy();
        await bridge.destroy();

        expect(backend.destroyed).toBe(true);
        expect(() => bridge.start({
            audioConfiguration: CONFIGURATION,
            callbacks: {
                onClockReady: vi.fn(),
                onCreditsReleased: vi.fn(),
                onFailure: vi.fn()
            },
            durationMicroseconds: millisecondsToMicroseconds(10_000),
            generation: 4,
            startTimeMicroseconds: millisecondsToMicroseconds(0)
        })).toThrow('destroyed');
    });
});
