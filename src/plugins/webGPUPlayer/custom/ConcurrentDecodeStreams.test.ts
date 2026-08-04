import { describe, expect, it, vi } from 'vitest';

import { settleConcurrentDecodeStreams } from './ConcurrentDecodeStreams';

type Deferred = {
    promise: Promise<void>
    reject: (reason: unknown) => void
    resolve: () => void
};

function createDeferred(): Deferred {
    let rejectPromise: (reason: unknown) => void = () => {
        throw new Error('Deferred rejection was not initialized');
    };
    let resolvePromise: () => void = () => {
        throw new Error('Deferred resolution was not initialized');
    };
    const promise = new Promise<void>((resolve, reject) => {
        rejectPromise = reject;
        resolvePromise = resolve;
    });
    return {
        promise,
        reject: rejectPromise,
        resolve: resolvePromise
    };
}

describe('settleConcurrentDecodeStreams', () => {
    it('completes without cancellation after every stream settles normally', async () => {
        const cancelStreams = vi.fn();

        await settleConcurrentDecodeStreams([
            Promise.resolve(),
            Promise.resolve()
        ], cancelStreams);

        expect(cancelStreams).not.toHaveBeenCalled();
    });

    it('cancels on the first failure but waits for a sibling-held sample to close', async () => {
        const expectedFailure = new Error('video stream failed');
        const failedStream = createDeferred();
        const siblingStream = createDeferred();
        const cancelStreams = vi.fn();
        let siblingSampleClosed = false;
        let settlementFinished = false;
        const siblingWithSample = siblingStream.promise.finally(() => {
            siblingSampleClosed = true;
        });
        const settlement = settleConcurrentDecodeStreams([
            failedStream.promise,
            siblingWithSample
        ], cancelStreams).finally(() => {
            settlementFinished = true;
        });

        failedStream.reject(expectedFailure);
        await Promise.resolve();
        await Promise.resolve();
        expect(cancelStreams).toHaveBeenCalledOnce();
        expect(settlementFinished).toBe(false);
        expect(siblingSampleClosed).toBe(false);

        siblingStream.resolve();
        await expect(settlement).rejects.toBe(expectedFailure);
        expect(siblingSampleClosed).toBe(true);
        expect(settlementFinished).toBe(true);
    });

    it('preserves the first failure while draining later failures', async () => {
        const firstFailure = new Error('first');
        const secondFailure = new Error('second');
        const firstStream = createDeferred();
        const secondStream = createDeferred();
        const cancelStreams = vi.fn();
        const settlement = settleConcurrentDecodeStreams([
            firstStream.promise,
            secondStream.promise
        ], cancelStreams);

        firstStream.reject(firstFailure);
        await Promise.resolve();
        secondStream.reject(secondFailure);

        await expect(settlement).rejects.toBe(firstFailure);
        expect(cancelStreams).toHaveBeenCalledOnce();
    });
});
