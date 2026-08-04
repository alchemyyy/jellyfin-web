import { describe, expect, it } from 'vitest';

import { HLSRecoveryPosition } from './HLSRecoveryPosition';

function createObservation(monotonicTimeSeconds: number) {
    return {
        monotonicTimeSeconds,
        playbackRate: 1,
        playing: true
    };
}

describe('HLSRecoveryPosition', () => {
    it('keeps the latest explicit target through stale observations', () => {
        const position = new HLSRecoveryPosition();

        position.recordPlaybackPosition(600);
        position.recordSeekRequest(3_600);
        position.recordPlaybackPosition(600);
        position.recordSeekCompletion(600);
        position.recordPlaybackPosition(0);

        expect(position.getRecoveryPosition(0)).toBe(3_600);
    });

    it('allows explicit backward and exact-zero seeks', () => {
        const position = new HLSRecoveryPosition();

        position.recordPlaybackPosition(3_600);
        position.recordSeekRequest(900);
        position.recordSeekCompletion(900);
        expect(position.getRecoveryPosition(900)).toBe(900);

        position.recordSeekRequest(0);
        position.recordSeekCompletion(0);
        expect(position.getRecoveryPosition(0)).toBe(0);
    });

    it('rejects unexplained group and zero rollbacks after stable playback', () => {
        const position = new HLSRecoveryPosition();

        position.recordPlaybackPosition(3_600);
        position.recordPlaybackPosition(3_660);
        position.recordSeekCompletion(3_000);
        position.recordPlaybackPosition(0);

        expect(position.getRecoveryPosition(3_000)).toBe(3_660);
        expect(position.getRecoveryPosition(0)).toBe(3_660);
    });

    it('keeps a completed backward target authoritative over a stale higher group', () => {
        const position = new HLSRecoveryPosition();

        position.recordPlaybackPosition(3_600);
        position.recordSeekRequest(900);
        position.recordSeekCompletion(900, undefined, createObservation(10));
        position.recordPlaybackPosition(3_600, createObservation(10.1));

        expect(position.getRecoveryPosition(3_600, createObservation(10.1))).toBe(900);
    });

    it('keeps a completed exact-zero target authoritative over a stale higher group', () => {
        const position = new HLSRecoveryPosition();

        position.recordPlaybackPosition(3_600);
        position.recordSeekRequest(0);
        position.recordSeekCompletion(0, undefined, createObservation(10));
        position.recordPlaybackPosition(3_600, createObservation(10.1));

        expect(position.getRecoveryPosition(3_600, createObservation(10.1))).toBe(0);
    });

    it('accepts legitimate post-seek progression inside the elapsed media envelope', () => {
        const position = new HLSRecoveryPosition();

        position.recordSeekRequest(900);
        position.recordSeekCompletion(900, undefined, createObservation(10));
        position.recordPlaybackPosition(901, createObservation(11));

        expect(position.getRecoveryPosition(901, createObservation(11))).toBe(901);
    });

    it('retains post-seek authority after plausible progress rejects a later stale group', () => {
        const position = new HLSRecoveryPosition();

        position.recordSeekRequest(900);
        position.recordSeekCompletion(900, undefined, createObservation(10));
        position.recordPlaybackPosition(901, createObservation(11));
        position.recordPlaybackPosition(3_600, createObservation(11.1));

        expect(position.getRecoveryPosition(3_600, createObservation(11.1))).toBe(901);
    });

    it('releases probation after two plausible playback observations', () => {
        const position = new HLSRecoveryPosition();

        position.recordSeekRequest(900);
        position.recordSeekCompletion(900, undefined, createObservation(10));
        position.recordPlaybackPosition(900.5, createObservation(10.5));
        position.recordPlaybackPosition(901, createObservation(11));

        expect(position.getRecoveryPosition(1_200, createObservation(11.1)))
            .toBe(1_200);
    });

    it('accepts a structured hls.js gap movement during probation', () => {
        const position = new HLSRecoveryPosition();

        position.recordSeekRequest(900);
        position.recordSeekCompletion(900, undefined, createObservation(10));

        expect(position.recordHLSTrustedPosition(902, createObservation(10.1)))
            .toBe(true);
        expect(position.getRecoveryPosition(902, createObservation(10.1))).toBe(902);
    });

    it('does not let an hls.js movement supersede a pending explicit seek', () => {
        const position = new HLSRecoveryPosition();

        position.recordSeekRequest(2_000);

        expect(position.recordHLSTrustedPosition(0, createObservation(10)))
            .toBe(false);
        expect(position.getRecoveryPosition(0, createObservation(10))).toBe(2_000);
    });

    it('does not accumulate a progression budget while waiting or paused', () => {
        const position = new HLSRecoveryPosition();

        position.recordSeekRequest(900);
        position.recordSeekCompletion(900, undefined, createObservation(10));
        position.recordPlaybackState({
            monotonicTimeSeconds: 11,
            playbackRate: 1,
            playing: false
        });

        expect(position.getRecoveryPosition(3_600, {
            monotonicTimeSeconds: 100,
            playbackRate: 1,
            playing: false
        })).toBe(900);
    });

    it('rebases an expired live DVR target inside the measured seekable window', () => {
        const position = new HLSRecoveryPosition();
        const observation = {
            monotonicTimeSeconds: 10,
            playbackRate: 1,
            playing: false
        };

        position.recordSeekRequest(900);
        position.recordSeekCompletion(900, undefined, observation);

        expect(position.getRecoveryPosition(1_700, observation, {
            maximumPositionSeconds: 1_800,
            minimumPositionSeconds: 1_200,
            ranges: [{
                endPositionSeconds: 1_800,
                startPositionSeconds: 1_200
            }]
        })).toBe(1_700);
    });

    it('uses the last target in a non-monotonic seek burst', () => {
        const position = new HLSRecoveryPosition();

        position.recordSeekRequest(1_000);
        position.recordSeekRequest(5_000);
        position.recordSeekRequest(2_000);
        position.recordSeekCompletion(1_000);
        position.recordPlaybackPosition(5_000);

        expect(position.getRecoveryPosition(1_000)).toBe(2_000);

        position.recordSeekCompletion(
            2_000.25,
            undefined,
            createObservation(10)
        );
        position.recordPlaybackPosition(2_001, createObservation(11));
        expect(position.getRecoveryPosition(2_001, createObservation(11))).toBe(2_001);
    });

    it('keeps a request pending when completion exceeds the correlation tolerance', () => {
        const position = new HLSRecoveryPosition();

        position.recordSeekRequest(2_000);
        position.recordSeekCompletion(2_000.251);
        position.recordPlaybackPosition(3_000);

        expect(position.getRecoveryPosition(3_000)).toBe(2_000);
    });

    it('accepts an actual media-boundary clamp without retaining an impossible target', () => {
        const position = new HLSRecoveryPosition();

        position.recordSeekRequest(3_600);
        position.recordSeekCompletion(3_598.5, {
            maximumPositionSeconds: 3_598.5,
            minimumPositionSeconds: 0
        });

        expect(position.getRecoveryPosition(3_598.5)).toBe(3_598.5);
    });

    it('accepts an expired DVR request landing inside the current window', () => {
        const position = new HLSRecoveryPosition();
        const seekBounds = {
            maximumPositionSeconds: 1_800,
            minimumPositionSeconds: 1_200,
            ranges: [{
                endPositionSeconds: 1_800,
                startPositionSeconds: 1_200
            }]
        };

        position.recordSeekRequest(900);
        position.recordSeekCompletion(
            1_700,
            seekBounds,
            createObservation(10)
        );

        expect(position.getRecoveryPosition(
            1_700,
            createObservation(10),
            seekBounds
        )).toBe(1_700);
    });

    it('does not treat an arbitrary in-range result as an above-end clamp', () => {
        const position = new HLSRecoveryPosition();
        const seekBounds = {
            maximumPositionSeconds: 1_800,
            minimumPositionSeconds: 1_200,
            ranges: [{
                endPositionSeconds: 1_800,
                startPositionSeconds: 1_200
            }]
        };

        position.recordSeekRequest(2_000);
        position.recordSeekCompletion(
            1_700,
            seekBounds,
            createObservation(10)
        );

        expect(position.getRecoveryPosition(
            1_700,
            createObservation(10),
            seekBounds
        )).toBe(2_000);
    });

    it('does not mistake a stale group or zero for a boundary clamp', () => {
        const position = new HLSRecoveryPosition();

        position.recordSeekRequest(2_000);
        position.recordSeekCompletion(1_000, {
            maximumPositionSeconds: 5_000,
            minimumPositionSeconds: 0
        });
        position.recordPlaybackPosition(0);

        expect(position.getRecoveryPosition(0)).toBe(2_000);
    });

    it('ignores invalid positions', () => {
        const position = new HLSRecoveryPosition();

        position.recordSeekRequest(Number.NaN);
        position.recordPlaybackPosition(Number.POSITIVE_INFINITY);

        expect(position.getRecoveryPosition(-1)).toBeNull();
    });
});
