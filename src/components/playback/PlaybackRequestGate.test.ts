import { describe, expect, it } from 'vitest';

import { PlaybackRequestGate } from './PlaybackRequestGate';

describe('PlaybackRequestGate', () => {
    it('allows only the newest asynchronous request to commit', () => {
        const requestGate = new PlaybackRequestGate();
        const firstGeneration = requestGate.beginRequest();
        const secondGeneration = requestGate.beginRequest();

        expect(requestGate.isCurrent(firstGeneration)).toBe(false);
        expect(requestGate.isCurrent(secondGeneration)).toBe(true);
    });

    it('invalidates pending work without creating a usable request', () => {
        const requestGate = new PlaybackRequestGate();
        const generation = requestGate.beginRequest();

        requestGate.invalidate();

        expect(requestGate.isCurrent(generation)).toBe(false);
    });

    it('guards a captured deferred continuation', () => {
        const requestGate = new PlaybackRequestGate();
        requestGate.beginRequest();
        const capturedGeneration = requestGate.capture();

        expect(requestGate.isCurrent(capturedGeneration)).toBe(true);
        requestGate.invalidate();
        expect(requestGate.isCurrent(capturedGeneration)).toBe(false);
    });
});
