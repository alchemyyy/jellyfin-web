import { describe, expect, it } from 'vitest';

import {
    HLSAppendFailurePolicy,
    HLS_CODED_FRAME_APPEND_FAILURE_LIMIT
} from './HLSAppendFailurePolicy';

const SOURCE_BUFFER_NAME = 'audiovideo';
const NO_PROGRESS = Object.freeze({ bufferedEnd: 0, currentTime: 0 });

function recordPairedFailure(
    policy: HLSAppendFailurePolicy,
    error: Error
): ReturnType<HLSAppendFailurePolicy['recordFailure']> {
    const appendingAction = policy.recordFailure({
        details: 'bufferAppendingError',
        error,
        sourceBufferName: SOURCE_BUFFER_NAME
    }, NO_PROGRESS);
    const appendAction = policy.recordFailure({
        details: 'bufferAppendError',
        error,
        sourceBufferName: SOURCE_BUFFER_NAME
    }, NO_PROGRESS);

    expect(appendAction).toBe('continue');
    return appendingAction;
}

describe('HLSAppendFailurePolicy', () => {
    it('counts a paired SourceBuffer error once, recovers once, and then terminates', () => {
        const policy = new HLSAppendFailurePolicy(NO_PROGRESS);

        for (
            let failureIndex = 1;
            failureIndex < HLS_CODED_FRAME_APPEND_FAILURE_LIMIT;
            failureIndex++
        ) {
            expect(recordPairedFailure(policy, new Error(`failure-${failureIndex}`)))
                .toBe('continue');
        }

        expect(recordPairedFailure(policy, new Error('recovery-failure')))
            .toBe('recover');

        for (
            let failureIndex = 1;
            failureIndex < HLS_CODED_FRAME_APPEND_FAILURE_LIMIT;
            failureIndex++
        ) {
            expect(recordPairedFailure(policy, new Error(`post-recovery-${failureIndex}`)))
                .toBe('continue');
        }

        expect(recordPairedFailure(policy, new Error('terminal-failure')))
            .toBe('terminate');
    });

    it('does not reset for interleaved append events without media progress', () => {
        const policy = new HLSAppendFailurePolicy(NO_PROGRESS);

        expect(recordPairedFailure(policy, new Error('video-1'))).toBe('continue');
        expect(recordPairedFailure(policy, new Error('video-2'))).toBe('continue');
        expect(recordPairedFailure(policy, new Error('video-3'))).toBe('recover');
    });

    it('resets the active budget after buffered or playback progress', () => {
        const policy = new HLSAppendFailurePolicy(NO_PROGRESS);

        expect(recordPairedFailure(policy, new Error('failure-1'))).toBe('continue');
        expect(recordPairedFailure(policy, new Error('failure-2'))).toBe('continue');
        expect(policy.recordFailure({
            details: 'bufferAppendingError',
            error: new Error('buffer-progress'),
            sourceBufferName: SOURCE_BUFFER_NAME
        }, { bufferedEnd: 6, currentTime: 0 })).toBe('continue');

        expect(policy.recordFailure({
            details: 'bufferAppendingError',
            error: new Error('playback-progress'),
            sourceBufferName: SOURCE_BUFFER_NAME
        }, { bufferedEnd: 6, currentTime: 1 })).toBe('continue');
        expect(recordPairedFailure(policy, new Error('post-progress-1'))).toBe('continue');
        expect(recordPairedFailure(policy, new Error('post-progress-2'))).toBe('recover');
    });

    it('does not replenish the one recovery after later progress', () => {
        const policy = new HLSAppendFailurePolicy(NO_PROGRESS, 1);

        expect(recordPairedFailure(policy, new Error('recovery'))).toBe('recover');
        expect(policy.recordFailure({
            details: 'bufferAppendingError',
            error: new Error('progress-then-failure'),
            sourceBufferName: SOURCE_BUFFER_NAME
        }, { bufferedEnd: 10, currentTime: 2 })).toBe('terminate');
    });

    it('does not count both aliases when hls.js uses err instead of error', () => {
        const policy = new HLSAppendFailurePolicy(NO_PROGRESS, 2);
        const sharedError = new Error('shared');

        expect(policy.recordFailure({
            details: 'bufferAppendingError',
            err: sharedError,
            sourceBufferName: SOURCE_BUFFER_NAME
        }, NO_PROGRESS)).toBe('continue');
        expect(policy.recordFailure({
            details: 'bufferAppendError',
            error: sharedError,
            sourceBufferName: SOURCE_BUFFER_NAME
        }, NO_PROGRESS)).toBe('continue');

        expect(recordPairedFailure(policy, new Error('second-logical-failure')))
            .toBe('recover');
    });

    it('ignores unrelated HLS errors', () => {
        const policy = new HLSAppendFailurePolicy(NO_PROGRESS, 1);

        expect(policy.recordFailure({
            details: 'bufferFullError',
            error: new Error('quota'),
            sourceBufferName: SOURCE_BUFFER_NAME
        }, NO_PROGRESS)).toBe('continue');
    });

    it('rejects invalid failure limits', () => {
        expect(() => new HLSAppendFailurePolicy(NO_PROGRESS, 0)).toThrow(RangeError);
        expect(() => new HLSAppendFailurePolicy(NO_PROGRESS, 1.5)).toThrow(RangeError);
    });
});
