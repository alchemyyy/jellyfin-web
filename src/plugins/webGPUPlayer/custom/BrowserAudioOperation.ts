import {
    microsecondsToMilliseconds,
    millisecondsToMicroseconds,
    type Microseconds
} from '../MediaTime';
import { requireMicroseconds } from './TimeMath';

export const DEFAULT_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS =
    millisecondsToMicroseconds(5_000);
export const AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS =
    millisecondsToMicroseconds(500);
export const SHARED_AUDIO_CONTEXT_RELEASE_TIMEOUT_MICROSECONDS =
    millisecondsToMicroseconds(250);

const MAXIMUM_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS =
    millisecondsToMicroseconds(60_000);

function requireAudioOperationTimeout(timeoutMicroseconds: Microseconds): Microseconds {
    requireMicroseconds(timeoutMicroseconds, 'Browser audio operation timeout');
    if (
        timeoutMicroseconds <= 0
        || timeoutMicroseconds > MAXIMUM_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS
    ) {
        throw new RangeError(
            'Browser audio operation timeout must be from 1 through 60000000 microseconds'
        );
    }
    return timeoutMicroseconds;
}

/** Settles a browser audio operation even if the underlying browser promise stalls. */
export function waitForBrowserAudioOperation<Result>(
    operation: PromiseLike<Result>,
    operationName: string,
    timeoutMicroseconds: Microseconds = DEFAULT_BROWSER_AUDIO_OPERATION_TIMEOUT_MICROSECONDS
): Promise<Result> {
    const boundedTimeoutMicroseconds = requireAudioOperationTimeout(timeoutMicroseconds);
    return new Promise<Result>((resolve, reject) => {
        let settled = false;
        const timer = globalThis.setTimeout((): void => {
            if (settled) {
                return;
            }
            settled = true;
            reject(new Error(`${operationName} exceeded its bounded timeout`));
        }, microsecondsToMilliseconds(boundedTimeoutMicroseconds));

        Promise.resolve(operation).then(
            (result: Result): void => {
                if (settled) {
                    return;
                }
                settled = true;
                globalThis.clearTimeout(timer);
                resolve(result);
            },
            (error: unknown): void => {
                if (settled) {
                    return;
                }
                settled = true;
                globalThis.clearTimeout(timer);
                reject(error);
            }
        );
    });
}
