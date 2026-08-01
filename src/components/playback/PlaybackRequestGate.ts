/** Tracks which asynchronous playback request is still allowed to commit. */
export class PlaybackRequestGate {
    private generation = 0;

    /** Starts a request and invalidates every older request. */
    beginRequest(): number {
        if (this.generation === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Playback request generation exhausted');
        }

        this.generation += 1;
        return this.generation;
    }

    /** Invalidates pending work without starting another request. */
    invalidate(): void {
        this.beginRequest();
    }

    /** Captures the generation for guarding a deferred continuation. */
    capture(): number {
        return this.generation;
    }

    /** Returns whether the request can still mutate playback state. */
    isCurrent(generation: number): boolean {
        return generation === this.generation;
    }
}
