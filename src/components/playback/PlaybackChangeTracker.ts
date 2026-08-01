export type PlaybackChangeOperation = {
    generation: number
    stopPromise: Promise<unknown>
    stopBarrier: Promise<void>
};

/** Orders overlapping player stops and identifies the only request allowed to commit. */
export class PlaybackChangeTracker {
    private generation = 0;
    private readonly pendingSettlements = new Map<number, Promise<void>>();

    /** Registers a stop and returns a barrier that includes every older stop. */
    begin(stopResult: unknown): PlaybackChangeOperation {
        if (this.generation === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Playback change generation exhausted');
        }

        this.generation += 1;
        const generation = this.generation;
        const stopPromise = Promise.resolve(stopResult);
        const settlementPromise = stopPromise.then(
            () => undefined,
            () => undefined
        );
        this.pendingSettlements.set(generation, settlementPromise);

        const pendingSettlements = Array.from(this.pendingSettlements.values());
        const stopBarrier = Promise.all(pendingSettlements).then(() => undefined);
        return { generation, stopPromise, stopBarrier };
    }

    /** Returns whether this operation still owns terminal playback cleanup. */
    isLatest(generation: number): boolean {
        return generation === this.generation;
    }

    /** Retires a settled operation. */
    complete(generation: number): void {
        this.pendingSettlements.delete(generation);
    }

    /** Returns whether any registered stop still has a continuation to finish. */
    hasPending(): boolean {
        return this.pendingSettlements.size > 0;
    }
}
