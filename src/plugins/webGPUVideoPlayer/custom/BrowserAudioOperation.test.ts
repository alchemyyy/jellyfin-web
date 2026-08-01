import { afterEach, describe, expect, it, vi } from 'vitest';

import { millisecondsToMicroseconds } from '../MediaTime';
import { waitForBrowserAudioOperation } from './BrowserAudioOperation';

describe('BrowserAudioOperation', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('passes through a completed result and clears its timeout', async () => {
        vi.useFakeTimers();

        await expect(waitForBrowserAudioOperation(
            Promise.resolve('ready'),
            'Audio setup',
            millisecondsToMicroseconds(25)
        )).resolves.toBe('ready');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects a stalled browser promise at the configured bound', async () => {
        vi.useFakeTimers();
        const result = waitForBrowserAudioOperation(
            new Promise<void>(() => undefined),
            'Audio setup',
            millisecondsToMicroseconds(25)
        );
        const observedResult = result.catch((error: unknown): unknown => error);

        await vi.advanceTimersByTimeAsync(25);

        expect(await observedResult).toEqual(
            new Error('Audio setup exceeded its bounded timeout')
        );
    });

    it('ignores a completion that arrives after the timeout', async () => {
        vi.useFakeTimers();
        let resolveOperation: (value: string) => void = (value: string): void => {
            throw new Error(`Deferred operation was not initialized for ${value}`);
        };
        const operation = new Promise<string>(resolve => {
            resolveOperation = resolve;
        });
        const result = waitForBrowserAudioOperation(
            operation,
            'Audio setup',
            millisecondsToMicroseconds(25)
        );
        const observedResult = result.catch((error: unknown): unknown => error);

        await vi.advanceTimersByTimeAsync(25);
        expect(await observedResult).toEqual(
            new Error('Audio setup exceeded its bounded timeout')
        );
        resolveOperation('late');
        await Promise.resolve();

        expect(vi.getTimerCount()).toBe(0);
    });
});
