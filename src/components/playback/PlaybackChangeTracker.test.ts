import { describe, expect, it } from 'vitest';

import { PlaybackChangeTracker } from './PlaybackChangeTracker';

type Deferred = {
    promise: Promise<void>
    resolve: () => void
};

function createDeferred(): Deferred {
    let resolvePromise: () => void = () => undefined;
    const promise = new Promise<void>(resolve => {
        resolvePromise = resolve;
    });
    return { promise, resolve: resolvePromise };
}

describe('PlaybackChangeTracker', () => {
    it('allows only the newest overlapping stop to own cleanup', () => {
        const tracker = new PlaybackChangeTracker();
        const firstOperation = tracker.begin(Promise.resolve());
        const secondOperation = tracker.begin(Promise.resolve());

        expect(tracker.isLatest(firstOperation.generation)).toBe(false);
        expect(tracker.isLatest(secondOperation.generation)).toBe(true);
    });

    it('holds a newer operation behind every older stop regardless of resolution order', async () => {
        const tracker = new PlaybackChangeTracker();
        const firstStop = createDeferred();
        const secondStop = createDeferred();
        tracker.begin(firstStop.promise);
        const secondOperation = tracker.begin(secondStop.promise);
        let barrierResolved = false;
        void secondOperation.stopBarrier.then(() => {
            barrierResolved = true;
        });

        secondStop.resolve();
        await secondStop.promise;
        await Promise.resolve();
        expect(barrierResolved).toBe(false);

        firstStop.resolve();
        await secondOperation.stopBarrier;
        expect(barrierResolved).toBe(true);
    });

    it('tracks pending operations until each continuation retires itself', () => {
        const tracker = new PlaybackChangeTracker();
        const firstOperation = tracker.begin(Promise.resolve());
        const secondOperation = tracker.begin(Promise.resolve());

        tracker.complete(secondOperation.generation);
        expect(tracker.hasPending()).toBe(true);
        tracker.complete(firstOperation.generation);
        expect(tracker.hasPending()).toBe(false);
    });
});
