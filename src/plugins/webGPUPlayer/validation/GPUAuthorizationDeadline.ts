import {
    microsecondsToMilliseconds,
    millisecondsToMicroseconds,
    type Microseconds
} from '../MediaTime';

export const GPU_AUTHORIZATION_TIMEOUT_MICROSECONDS = millisecondsToMicroseconds(5_000);

export type GPUAuthorizationCancellationReason = 'device-lost' | 'timeout';
type GPUAuthorizationCancellationListener = (
    reason: GPUAuthorizationCancellationReason
) => void;

function getMonotonicTimeMicroseconds(): Microseconds {
    const timeMilliseconds = typeof globalThis.performance?.now === 'function' ?
        globalThis.performance.now() :
        Date.now();
    return millisecondsToMicroseconds(timeMilliseconds);
}

/** Applies one monotonic timeout and device-loss boundary to a GPU probe. */
export default class GPUAuthorizationDeadline {
    private readonly cancellationListeners = new Set<
        GPUAuthorizationCancellationListener
    >();
    private readonly expirationTimeMicroseconds: Microseconds;
    private readonly timeout: ReturnType<typeof globalThis.setTimeout>;
    private cancellationReason: GPUAuthorizationCancellationReason | null = null;
    private destroyed = false;

    public constructor(
        device: GPUDevice,
        timeoutMicroseconds = GPU_AUTHORIZATION_TIMEOUT_MICROSECONDS
    ) {
        this.expirationTimeMicroseconds = (
            Number(getMonotonicTimeMicroseconds())
            + Number(timeoutMicroseconds)
        ) as Microseconds;
        this.timeout = globalThis.setTimeout((): void => {
            this.cancel('timeout');
        }, microsecondsToMilliseconds(timeoutMicroseconds));
        this.scheduleDeviceLossObservation(device);
    }

    /** Waits one operation without extending the original deadline. */
    public wait<Value>(
        operation: Promise<Value>,
        cancelOperation: () => void = (): void => undefined
    ): Promise<Value> {
        this.expireIfNeeded();
        return new Promise<Value>((resolve, reject) => {
            let settled = false;
            const settle = (callback: () => void): void => {
                if (settled) {
                    return;
                }
                settled = true;
                this.cancellationListeners.delete(cancelListener);
                callback();
            };
            const cancelListener = (
                reason: GPUAuthorizationCancellationReason
            ): void => {
                settle((): void => {
                    try {
                        cancelOperation();
                    } catch {
                        // Cancellation must preserve the original deadline failure
                    }
                    reject(new Error(reason));
                });
            };

            this.cancellationListeners.add(cancelListener);
            operation.then(
                (value: Value): void => settle((): void => resolve(value)),
                (error: unknown): void => settle((): void => reject(error))
            );
            if (this.cancellationReason) {
                cancelListener(this.cancellationReason);
            }
        });
    }

    /** Releases the timer and listeners retained by this probe. */
    public destroy(): void {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        globalThis.clearTimeout(this.timeout);
        this.cancellationListeners.clear();
    }

    private expireIfNeeded(): void {
        if (
            !this.cancellationReason
            && Number(getMonotonicTimeMicroseconds())
                >= Number(this.expirationTimeMicroseconds)
        ) {
            this.cancel('timeout');
        }
    }

    private scheduleDeviceLossObservation(device: GPUDevice): void {
        void Promise.resolve().then((): void => {
            void device.lost.then((): void => {
                this.cancel('device-lost');
            });
        });
    }

    private cancel(reason: GPUAuthorizationCancellationReason): void {
        if (this.destroyed || this.cancellationReason) {
            return;
        }
        this.cancellationReason = reason;
        globalThis.clearTimeout(this.timeout);
        for (const listener of [ ...this.cancellationListeners ]) {
            listener(reason);
        }
    }
}
