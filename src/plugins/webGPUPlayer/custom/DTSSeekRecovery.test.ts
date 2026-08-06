import { describe, expect, it } from 'vitest';

import { millisecondsToMicroseconds } from '../MediaTime';
import { DTSDecoderSynchronizationError } from './DTSSoftwareAudioDecoder';
import DTSSeekRecovery, {
    DTS_SEEK_PREROLL_MICROSECONDS,
    MAXIMUM_DTS_SEEK_RECOVERY_PACKET_COUNT
} from './DTSSeekRecovery';

describe('DTSSeekRecovery', () => {
    it('applies one bounded second of preroll only when the seek target permits it', () => {
        expect(new DTSSeekRecovery(
            millisecondsToMicroseconds(0)
        ).prerollTimeMicroseconds).toBe(0);
        expect(new DTSSeekRecovery(
            millisecondsToMicroseconds(500)
        ).prerollTimeMicroseconds).toBe(0);
        expect(new DTSSeekRecovery(
            millisecondsToMicroseconds(2_500)
        ).prerollTimeMicroseconds).toBe(
            millisecondsToMicroseconds(2_500) - DTS_SEEK_PREROLL_MICROSECONDS
        );
    });

    it('ignores only the typed no-sync status before a nonzero target', () => {
        const recovery = new DTSSeekRecovery(millisecondsToMicroseconds(2_000));
        const packetTimeMicroseconds = millisecondsToMicroseconds(1_500);

        expect(recovery.shouldIgnore(
            new DTSDecoderSynchronizationError(),
            packetTimeMicroseconds
        )).toBe(true);
        expect(recovery.shouldIgnore(
            new Error('Different decoder failure'),
            packetTimeMicroseconds
        )).toBe(false);
    });

    it('never suppresses no-sync at startup or at the requested target', () => {
        const synchronizationError = new DTSDecoderSynchronizationError();
        expect(new DTSSeekRecovery(
            millisecondsToMicroseconds(0)
        ).shouldIgnore(
            synchronizationError,
            millisecondsToMicroseconds(0)
        )).toBe(false);
        expect(new DTSSeekRecovery(
            millisecondsToMicroseconds(2_000)
        ).shouldIgnore(
            synchronizationError,
            millisecondsToMicroseconds(2_000)
        )).toBe(false);
    });

    it('stops suppressing no-sync after the first successful decode', () => {
        const recovery = new DTSSeekRecovery(millisecondsToMicroseconds(2_000));
        recovery.markDecodeSucceeded();

        expect(recovery.shouldIgnore(
            new DTSDecoderSynchronizationError(),
            millisecondsToMicroseconds(1_500)
        )).toBe(false);
    });

    it('does not accept a first successful decode at or after the target', () => {
        const recovery = new DTSSeekRecovery(millisecondsToMicroseconds(2_000));
        expect(recovery.shouldIgnore(
            new DTSDecoderSynchronizationError(),
            millisecondsToMicroseconds(1_500)
        )).toBe(true);

        expect(() => recovery.requireSynchronizationRecoveredBefore(
            millisecondsToMicroseconds(1_999)
        )).not.toThrow();
        expect(() => recovery.requireSynchronizationRecoveredBefore(
            millisecondsToMicroseconds(2_000)
        )).toThrow('not recovered by the seek target');
        expect(() => recovery.requireSynchronizationRecoveredBefore(
            millisecondsToMicroseconds(2_500)
        )).toThrow('not recovered by the seek target');

        const pretargetRecovery = new DTSSeekRecovery(millisecondsToMicroseconds(2_000));
        expect(pretargetRecovery.shouldIgnore(
            new DTSDecoderSynchronizationError(),
            millisecondsToMicroseconds(1_500)
        )).toBe(true);
        pretargetRecovery.markDecodeSucceeded();
        expect(() => pretargetRecovery.requireSynchronizationRecoveredBefore(
            millisecondsToMicroseconds(2_500)
        )).not.toThrow();
    });

    it('caps ignored no-sync packets even when timestamps do not advance', () => {
        const recovery = new DTSSeekRecovery(millisecondsToMicroseconds(2_000));
        const packetTimeMicroseconds = millisecondsToMicroseconds(1_500);

        for (let packetIndex = 0;
            packetIndex < MAXIMUM_DTS_SEEK_RECOVERY_PACKET_COUNT;
            packetIndex += 1) {
            expect(recovery.shouldIgnore(
                new DTSDecoderSynchronizationError(),
                packetTimeMicroseconds
            )).toBe(true);
        }
        expect(recovery.shouldIgnore(
            new DTSDecoderSynchronizationError(),
            packetTimeMicroseconds
        )).toBe(false);
    });

    it('fails closed when end-of-stream arrives during synchronization recovery', () => {
        const recovery = new DTSSeekRecovery(millisecondsToMicroseconds(2_000));
        expect(() => recovery.requireSynchronizationRecovered()).not.toThrow();
        expect(recovery.shouldIgnore(
            new DTSDecoderSynchronizationError(),
            millisecondsToMicroseconds(1_500)
        )).toBe(true);
        expect(() => recovery.requireSynchronizationRecovered()).toThrow(
            'synchronization was not recovered'
        );

        recovery.markDecodeSucceeded();
        expect(() => recovery.requireSynchronizationRecovered()).not.toThrow();
    });

    it('rejects negative targets and non-integer packet timestamps', () => {
        expect(() => new DTSSeekRecovery(
            millisecondsToMicroseconds(-1)
        )).toThrow('must not be negative');

        const recovery = new DTSSeekRecovery(millisecondsToMicroseconds(2_000));
        expect(() => recovery.shouldIgnore(
            new DTSDecoderSynchronizationError(),
            0.5 as ReturnType<typeof millisecondsToMicroseconds>
        )).toThrow('safe integer');
    });
});
