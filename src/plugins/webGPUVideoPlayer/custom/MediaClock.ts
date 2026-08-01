import { millisecondsToMicroseconds, type Microseconds } from '../MediaTime';
import { addMicroseconds, requireMicroseconds } from './TimeMath';

export type MonotonicTimeSource = () => Microseconds;

export type MediaClockSnapshot = {
    generation: number
    mediaTimeMicroseconds: Microseconds
    paused: boolean
    playbackRate: number
};

const INITIAL_GENERATION = 1;

function defaultMonotonicTimeSource(): Microseconds {
    return millisecondsToMicroseconds(performance.now());
}

/**
 * Tracks media time against a monotonic clock while invalidating asynchronous
 * work whenever playback state changes.
 */
export default class MediaClock {
    private anchorMediaTimeMicroseconds: Microseconds;
    private anchorMonotonicTimeMicroseconds: Microseconds;
    private currentGeneration = INITIAL_GENERATION;
    private paused = true;
    private playbackRate = 1;
    private readonly monotonicTimeSource: MonotonicTimeSource;

    public constructor(monotonicTimeSource: MonotonicTimeSource = defaultMonotonicTimeSource) {
        this.monotonicTimeSource = monotonicTimeSource;
        this.anchorMediaTimeMicroseconds = requireMicroseconds(0);
        this.anchorMonotonicTimeMicroseconds = this.readMonotonicTime();
    }

    /** Returns the generation that decoder and renderer work should capture. */
    public get generation(): number {
        return this.currentGeneration;
    }

    /** Returns the current signed integer media timestamp. */
    public get mediaTimeMicroseconds(): Microseconds {
        return this.calculateMediaTime(this.readMonotonicTime());
    }

    public get isPaused(): boolean {
        return this.paused;
    }

    public get rate(): number {
        return this.playbackRate;
    }

    /** Captures all clock state from one monotonic-time sample. */
    public snapshot(): MediaClockSnapshot {
        const monotonicTimeMicroseconds = this.readMonotonicTime();
        return {
            generation: this.currentGeneration,
            mediaTimeMicroseconds: this.calculateMediaTime(monotonicTimeMicroseconds),
            paused: this.paused,
            playbackRate: this.playbackRate
        };
    }

    /** Pauses at the current media timestamp and invalidates outstanding work. */
    public pause(): number {
        const monotonicTimeMicroseconds = this.readMonotonicTime();
        this.anchorMediaTimeMicroseconds = this.calculateMediaTime(monotonicTimeMicroseconds);
        this.anchorMonotonicTimeMicroseconds = monotonicTimeMicroseconds;
        this.paused = true;
        return this.advanceGeneration();
    }

    /** Resumes from the current media timestamp and invalidates outstanding work. */
    public resume(): number {
        const monotonicTimeMicroseconds = this.readMonotonicTime();
        this.anchorMediaTimeMicroseconds = this.calculateMediaTime(monotonicTimeMicroseconds);
        this.anchorMonotonicTimeMicroseconds = monotonicTimeMicroseconds;
        this.paused = false;
        return this.advanceGeneration();
    }

    /** Seeks without changing the paused state. */
    public seek(mediaTimeMicroseconds: Microseconds): number {
        this.anchorMediaTimeMicroseconds = requireMicroseconds(mediaTimeMicroseconds);
        this.anchorMonotonicTimeMicroseconds = this.readMonotonicTime();
        return this.advanceGeneration();
    }

    /** Re-anchors to an external master clock without invalidating decoder work. */
    public synchronize(mediaTimeMicroseconds: Microseconds): void {
        this.anchorMediaTimeMicroseconds = requireMicroseconds(mediaTimeMicroseconds);
        this.anchorMonotonicTimeMicroseconds = this.readMonotonicTime();
    }

    /** Changes playback rate without introducing a timestamp discontinuity. */
    public setPlaybackRate(playbackRate: number): number {
        if (!Number.isFinite(playbackRate) || playbackRate <= 0) {
            throw new RangeError('Playback rate must be finite and greater than zero');
        }

        const monotonicTimeMicroseconds = this.readMonotonicTime();
        this.anchorMediaTimeMicroseconds = this.calculateMediaTime(monotonicTimeMicroseconds);
        this.anchorMonotonicTimeMicroseconds = monotonicTimeMicroseconds;
        this.playbackRate = playbackRate;
        return this.advanceGeneration();
    }

    /** Invalidates outstanding work without changing clock state. */
    public invalidate(): number {
        const monotonicTimeMicroseconds = this.readMonotonicTime();
        this.anchorMediaTimeMicroseconds = this.calculateMediaTime(monotonicTimeMicroseconds);
        this.anchorMonotonicTimeMicroseconds = monotonicTimeMicroseconds;
        return this.advanceGeneration();
    }

    /** Resets to a paused timestamp and restores normal playback rate. */
    public reset(mediaTimeMicroseconds: Microseconds = requireMicroseconds(0)): number {
        this.anchorMediaTimeMicroseconds = requireMicroseconds(mediaTimeMicroseconds);
        this.anchorMonotonicTimeMicroseconds = this.readMonotonicTime();
        this.paused = true;
        this.playbackRate = 1;
        return this.advanceGeneration();
    }

    /** Returns whether a captured generation may still mutate playback state. */
    public isGenerationCurrent(generation: number): boolean {
        return generation === this.currentGeneration;
    }

    private readMonotonicTime(): Microseconds {
        return requireMicroseconds(this.monotonicTimeSource(), 'Monotonic time');
    }

    private calculateMediaTime(monotonicTimeMicroseconds: Microseconds): Microseconds {
        if (this.paused) {
            return this.anchorMediaTimeMicroseconds;
        }

        const elapsedMicroseconds = monotonicTimeMicroseconds - this.anchorMonotonicTimeMicroseconds;
        if (elapsedMicroseconds < 0) {
            throw new RangeError('Monotonic time moved backwards');
        }

        const scaledElapsedMicroseconds = requireMicroseconds(
            Math.round(elapsedMicroseconds * this.playbackRate),
            'Scaled elapsed time'
        );
        return addMicroseconds(this.anchorMediaTimeMicroseconds, scaledElapsedMicroseconds);
    }

    private advanceGeneration(): number {
        if (this.currentGeneration === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Media clock generation exhausted');
        }

        this.currentGeneration += 1;
        return this.currentGeneration;
    }
}
