import { describe, expect, it, vi } from 'vitest';

import { millisecondsToMicroseconds } from '../MediaTime';
import OwnedNativeMediaAudioBackend, {
    MAXIMUM_NATIVE_AUDIO_PENDING_SEGMENT_COUNT,
    type OwnedNativeMediaAudioEvent,
    type OwnedNativeMediaAudioSegment
} from './OwnedNativeMediaAudioBackend';

class FakeTimeRanges {
    public ranges: Array<{ end: number, start: number }> = [];

    public get length(): number {
        return this.ranges.length;
    }

    public end(index: number): number {
        const range = this.ranges[index];
        if (!range) {
            throw new RangeError('Missing fake buffered range');
        }
        return range.end;
    }

    public start(index: number): number {
        const range = this.ranges[index];
        if (!range) {
            throw new RangeError('Missing fake buffered range');
        }
        return range.start;
    }
}

class FakeSourceBuffer extends EventTarget {
    public readonly appendCalls: Uint8Array[] = [];
    public readonly buffered = new FakeTimeRanges();
    public mode: AppendMode = 'segments';
    public readonly removeCalls: Array<{ end: number, start: number }> = [];
    public updating = false;

    public appendBuffer(data: ArrayBuffer): void {
        this.updating = true;
        this.appendCalls.push(new Uint8Array(data.slice(0)));
        void Promise.resolve().then((): void => {
            this.updating = false;
            this.dispatchEvent(new Event('updateend'));
        });
    }

    public remove(start: number, end: number): void {
        this.updating = true;
        this.removeCalls.push({ end, start });
        void Promise.resolve().then((): void => {
            this.updating = false;
            this.buffered.ranges = this.buffered.ranges
                .filter(range => range.end > end)
                .map(range => ({ end: range.end, start: Math.max(range.start, end) }));
            this.dispatchEvent(new Event('updateend'));
        });
    }
}

class FakeMediaSource extends EventTarget {
    public duration = Number.NaN;
    public endOfStreamCalls = 0;
    public readyState: ReadyState = 'open';
    public readonly requestedMimeTypes: string[] = [];
    public readonly sourceBuffer = new FakeSourceBuffer();

    public addSourceBuffer(mimeType: string): SourceBuffer {
        this.requestedMimeTypes.push(mimeType);
        return this.sourceBuffer as unknown as SourceBuffer;
    }

    public endOfStream(): void {
        this.endOfStreamCalls += 1;
        this.readyState = 'ended';
    }
}

class FakeAudioElement extends EventTarget {
    public autoplay = false;
    public readonly classList = { add: vi.fn() };
    public controls = false;
    public currentTime = 0;
    public error: MediaError | null = null;
    public loadCalls = 0;
    public muted = false;
    public pauseCalls = 0;
    public paused = true;
    public playbackRate = 1;
    public playCalls = 0;
    public preload = '';
    public removeCalls = 0;
    public readonly removeAttribute = vi.fn();
    public readonly setAttribute = vi.fn();
    public src = '';
    public volume = 1;

    public load(): void {
        this.loadCalls += 1;
    }

    public pause(): void {
        this.pauseCalls += 1;
        this.paused = true;
        this.dispatchEvent(new Event('pause'));
    }

    public play(): Promise<void> {
        this.playCalls += 1;
        this.paused = false;
        this.dispatchEvent(new Event('playing'));
        return Promise.resolve();
    }

    public remove(): void {
        this.removeCalls += 1;
    }

    public advanceTo(seconds: number): void {
        this.currentTime = seconds;
        this.dispatchEvent(new Event('timeupdate'));
    }
}

type BackendHarness = {
    audioElement: FakeAudioElement
    backend: OwnedNativeMediaAudioBackend
    events: OwnedNativeMediaAudioEvent[]
    mediaSource: FakeMediaSource
    revokeObjectURL: ReturnType<typeof vi.fn>
};

function createHarness(options: {
    maximumAppendedAheadMilliseconds?: number
    retainedBehindMilliseconds?: number
} = {}): BackendHarness {
    const audioElement = new FakeAudioElement();
    const mediaSource = new FakeMediaSource();
    const events: OwnedNativeMediaAudioEvent[] = [];
    const revokeObjectURL = vi.fn();
    const backend = new OwnedNativeMediaAudioBackend({
        appendElement: vi.fn(),
        createAudioElement: () => audioElement as unknown as HTMLAudioElement,
        createMediaSource: () => mediaSource as unknown as MediaSource,
        createObjectURL: () => 'blob:native-audio',
        eventHandler: event => events.push(event),
        maximumAppendedAheadMicroseconds: millisecondsToMicroseconds(
            options.maximumAppendedAheadMilliseconds ?? 6_000
        ),
        operationTimeoutMicroseconds: millisecondsToMicroseconds(1_000),
        retainedBehindMicroseconds: millisecondsToMicroseconds(
            options.retainedBehindMilliseconds ?? 5_000
        ),
        revokeObjectURL
    });
    return { audioElement, backend, events, mediaSource, revokeObjectURL };
}

function createSegment(
    startMilliseconds: number,
    endMilliseconds: number,
    byte = 2
): OwnedNativeMediaAudioSegment {
    return {
        data: new Uint8Array([ byte ]),
        endTimeMicroseconds: millisecondsToMicroseconds(endMilliseconds),
        startTimeMicroseconds: millisecondsToMicroseconds(startMilliseconds)
    };
}

async function startBackend(harness: BackendHarness, generation = 1): Promise<void> {
    await harness.backend.start({
        durationMicroseconds: millisecondsToMicroseconds(60_000),
        generation,
        mimeType: 'audio/mp4; codecs="ec-3"',
        startTimeMicroseconds: millisecondsToMicroseconds(0)
    });
}

describe('OwnedNativeMediaAudioBackend', () => {
    it('owns one MSE element and qualifies its clock only after playback advances', async () => {
        const harness = createHarness();
        await startBackend(harness);

        expect(harness.audioElement.src).toBe('blob:native-audio');
        expect(harness.mediaSource.duration).toBe(60);
        expect(await harness.backend.appendInitializationSegment(
            1,
            new Uint8Array([ 0, 1 ])
        )).toBe(true);
        expect(await harness.backend.appendMediaSegment(1, createSegment(0, 1_000))).toBe(true);
        expect(harness.mediaSource.sourceBuffer.appendCalls).toEqual([
            new Uint8Array([ 0, 1 ]),
            new Uint8Array([ 2 ])
        ]);

        expect(await harness.backend.setPlaying(1, true)).toBe(true);
        expect(harness.backend.getAuthoritativeTimeMicroseconds()).toBeNull();
        harness.audioElement.advanceTo(0.125);
        expect(harness.backend.getAuthoritativeTimeMicroseconds())
            .toBe(millisecondsToMicroseconds(125));
        expect(harness.events.filter(event => event.type === 'clock-ready')).toHaveLength(1);

        harness.backend.setVolume(0.25);
        harness.backend.setMuted(true);
        harness.backend.setPlaybackRate(1.5);
        expect(harness.audioElement.volume).toBe(0.25);
        expect(harness.audioElement.muted).toBe(true);
        expect(harness.audioElement.playbackRate).toBe(1.5);
        expect(await harness.backend.endOfStream(1)).toBe(true);
        expect(harness.mediaSource.endOfStreamCalls).toBe(1);

        expect(await harness.backend.stop(1)).toBe(true);
        expect(harness.audioElement.pauseCalls).toBeGreaterThan(0);
        expect(harness.audioElement.loadCalls).toBe(1);
        expect(harness.audioElement.removeCalls).toBe(1);
        expect(harness.revokeObjectURL).toHaveBeenCalledWith('blob:native-audio');
    });

    it('backpressures fragments beyond the bounded appended-ahead window', async () => {
        const harness = createHarness({ maximumAppendedAheadMilliseconds: 2_000 });
        await startBackend(harness);
        await harness.backend.appendInitializationSegment(1, new Uint8Array([ 1 ]));
        await harness.backend.appendMediaSegment(1, createSegment(0, 1_000));

        let appendSettled = false;
        const blockedAppend = harness.backend
            .appendMediaSegment(1, createSegment(1_000, 2_900))
            .then(result => {
                appendSettled = true;
                return result;
            });
        await Promise.resolve();
        await Promise.resolve();
        expect(appendSettled).toBe(false);
        expect(harness.backend.getTelemetry().pendingAppendCount).toBe(1);

        harness.audioElement.advanceTo(2);
        expect(await blockedAppend).toBe(true);
        expect(harness.mediaSource.sourceBuffer.appendCalls).toHaveLength(3);
    });

    it('caps concurrent queued fragments and cancels blocked work on stop', async () => {
        const harness = createHarness({ maximumAppendedAheadMilliseconds: 500 });
        await startBackend(harness);
        await harness.backend.appendInitializationSegment(1, new Uint8Array([ 1 ]));

        const queuedAppends: Promise<boolean>[] = [];
        for (
            let segmentIndex = 0;
            segmentIndex < MAXIMUM_NATIVE_AUDIO_PENDING_SEGMENT_COUNT;
            segmentIndex += 1
        ) {
            queuedAppends.push(harness.backend.appendMediaSegment(
                1,
                createSegment(1_000 + segmentIndex, 1_100 + segmentIndex)
            ));
        }
        await expect(harness.backend.appendMediaSegment(
            1,
            createSegment(2_000, 2_100)
        )).rejects.toThrow('append queue is full');

        expect(await harness.backend.stop(1)).toBe(true);
        expect(await Promise.all(queuedAppends)).toEqual(
            new Array(MAXIMUM_NATIVE_AUDIO_PENDING_SEGMENT_COUNT).fill(false)
        );
        expect(harness.backend.getTelemetry().pendingAppendCount).toBe(0);
    });

    it('removes history beyond the retained-behind window', async () => {
        const harness = createHarness({ retainedBehindMilliseconds: 2_000 });
        await startBackend(harness);
        await harness.backend.appendInitializationSegment(1, new Uint8Array([ 1 ]));
        await harness.backend.appendMediaSegment(1, createSegment(0, 1_000));
        harness.mediaSource.sourceBuffer.buffered.ranges = [{ end: 10, start: 0 }];
        harness.audioElement.advanceTo(8);

        await harness.backend.appendMediaSegment(1, createSegment(8_000, 9_000));
        expect(harness.mediaSource.sourceBuffer.removeCalls).toEqual([
            { end: 6, start: 0 }
        ]);
        expect(harness.backend.getTelemetry().removedRangeCount).toBe(1);
    });

    it('rejects stale generations without affecting the active element', async () => {
        const harness = createHarness();
        await startBackend(harness, 2);

        expect(await harness.backend.appendInitializationSegment(
            1,
            new Uint8Array([ 1 ])
        )).toBe(false);
        expect(await harness.backend.setPlaying(1, true)).toBe(false);
        expect(await harness.backend.stop(1)).toBe(false);
        expect(harness.audioElement.pauseCalls).toBe(0);
        expect(harness.backend.getTelemetry().activeGeneration).toBe(2);
        expect(harness.backend.getTelemetry().staleOperationCount).toBe(3);
    });

    it('validates segment timing and refuses use after destroy', async () => {
        const harness = createHarness();
        await startBackend(harness);

        await expect(harness.backend.appendMediaSegment(1, createSegment(2_000, 1_000)))
            .rejects.toThrow('duration is outside bounds');
        expect(() => harness.backend.setVolume(2)).toThrow('between zero and one');
        expect(() => harness.backend.setPlaybackRate(0)).toThrow('finite and positive');

        await harness.backend.destroy();
        await expect(harness.backend.start({
            durationMicroseconds: millisecondsToMicroseconds(1_000),
            generation: 2,
            mimeType: 'audio/mp4; codecs="ec-3"',
            startTimeMicroseconds: millisecondsToMicroseconds(0)
        })).rejects.toThrow('destroyed');
    });
});
