const PROGRESS_EPSILON_SECONDS = 0.001;

export const HLS_CODED_FRAME_APPEND_FAILURE_LIMIT = 3;

export const HLS_CODED_FRAME_APPEND_ERROR_DETAILS = Object.freeze([
    'bufferAppendError',
    'bufferAppendingError'
]);

export type HLSAppendFailureAction = 'continue' | 'recover' | 'terminate';

export type HLSProgress = {
    bufferedEnd: number
    currentTime: number
};

export type HLSAppendFailure = {
    details: string | null | undefined
    error?: unknown
    err?: unknown
    sourceBufferName: string | null | undefined
};

/** Bounds consecutive coded-frame append failures for one HLS session. */
export class HLSAppendFailurePolicy {
    private readonly countedErrors = new WeakSet<object>();
    private failureCount = 0;
    private readonly failureLimit: number;
    private furthestBufferedEnd: number;
    private furthestCurrentTime: number;
    private recoveryUsed = false;

    constructor(
        initialProgress: HLSProgress,
        failureLimit: number = HLS_CODED_FRAME_APPEND_FAILURE_LIMIT
    ) {
        if (!Number.isInteger(failureLimit) || failureLimit < 1) {
            throw new RangeError('HLS append failure limit must be a positive integer');
        }

        this.failureLimit = failureLimit;
        this.furthestBufferedEnd = normalizeProgressValue(initialProgress.bufferedEnd);
        this.furthestCurrentTime = normalizeProgressValue(initialProgress.currentTime);
    }

    /** Records one hls.js error event and returns whether the session must end. */
    recordFailure(
        failure: HLSAppendFailure,
        progress: HLSProgress
    ): HLSAppendFailureAction {
        if (!HLS_CODED_FRAME_APPEND_ERROR_DETAILS.includes(failure.details ?? '')) {
            return 'continue';
        }

        const errorIdentity = failure.error ?? failure.err;
        if (isObject(errorIdentity)) {
            if (this.countedErrors.has(errorIdentity)) {
                return 'continue';
            }

            this.countedErrors.add(errorIdentity);
        }

        this.resetFailureCountAfterProgress(progress);
        this.failureCount += 1;
        if (this.failureCount < this.failureLimit) {
            return 'continue';
        }

        this.failureCount = 0;
        if (!this.recoveryUsed) {
            this.recoveryUsed = true;
            return 'recover';
        }

        return 'terminate';
    }

    private resetFailureCountAfterProgress(progress: HLSProgress): void {
        const bufferedEnd = normalizeProgressValue(progress.bufferedEnd);
        const currentTime = normalizeProgressValue(progress.currentTime);
        const bufferedProgressed = bufferedEnd > this.furthestBufferedEnd + PROGRESS_EPSILON_SECONDS;
        const playbackProgressed = currentTime > this.furthestCurrentTime + PROGRESS_EPSILON_SECONDS;

        this.furthestBufferedEnd = Math.max(this.furthestBufferedEnd, bufferedEnd);
        this.furthestCurrentTime = Math.max(this.furthestCurrentTime, currentTime);
        if (bufferedProgressed || playbackProgressed) {
            this.failureCount = 0;
        }
    }
}

function isObject(value: unknown): value is object {
    return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function normalizeProgressValue(value: number): number {
    return Number.isFinite(value) && value >= 0 ? value : 0;
}
