function normalizePosition(positionSeconds: number): number | null {
    if (!Number.isFinite(positionSeconds) || positionSeconds < 0) {
        return null;
    }

    return positionSeconds;
}

const MILLISECONDS_PER_SECOND = 1_000;

function getMonotonicTimeSeconds(): number {
    if (typeof performance !== 'undefined') {
        return performance.now() / MILLISECONDS_PER_SECOND;
    }

    return Date.now() / MILLISECONDS_PER_SECOND;
}

// Match hls.js fragment lookup tolerance while allowing reduced-precision currentTime reads
export const HLS_SEEK_CORRELATION_TOLERANCE_SECONDS = 0.25;
const POST_SEEK_PROBATION_TIMEUPDATE_COUNT = 2;

export type HLSSeekRange = {
    endPositionSeconds: number
    startPositionSeconds: number
};

export type HLSSeekBounds = {
    maximumPositionSeconds: number | null
    minimumPositionSeconds: number | null
    ranges?: HLSSeekRange[]
};

export type HLSPlaybackObservation = {
    monotonicTimeSeconds: number
    playbackRate: number
    playing: boolean
};

type PostSeekAuthority = {
    allowedAdvanceSeconds: number
    lastObservation: HLSPlaybackObservation
    positionSeconds: number
    remainingTimeupdateCount: number
};

function normalizeObservation(
    observation?: HLSPlaybackObservation
): HLSPlaybackObservation {
    const observedMonotonicTimeSeconds = observation?.monotonicTimeSeconds;
    const monotonicTimeSeconds = observedMonotonicTimeSeconds !== undefined
        && Number.isFinite(observedMonotonicTimeSeconds) ?
        observedMonotonicTimeSeconds :
        getMonotonicTimeSeconds();
    const observedPlaybackRate = observation?.playbackRate;
    const playbackRate = observedPlaybackRate !== undefined
        && Number.isFinite(observedPlaybackRate) ?
        Math.abs(observedPlaybackRate) :
        1;
    return {
        monotonicTimeSeconds,
        playbackRate,
        playing: observation?.playing ?? false
    };
}

/** Preserves the latest explicit or monotonic HLS playback position. */
export class HLSRecoveryPosition {
    private postSeekAuthority: PostSeekAuthority | null = null;
    private requestedPositionSeconds: number | null = null;
    private stablePositionSeconds: number | null = null;

    /** Records a user-requested seek before the media element processes it. */
    public recordSeekRequest(positionSeconds: number): void {
        const normalizedPosition = normalizePosition(positionSeconds);
        if (normalizedPosition === null) {
            return;
        }

        this.requestedPositionSeconds = normalizedPosition;
        this.stablePositionSeconds = normalizedPosition;
        this.postSeekAuthority = null;
    }

    /** Records completion of the latest explicit seek. */
    public recordSeekCompletion(
        positionSeconds: number,
        seekBounds?: HLSSeekBounds,
        observation?: HLSPlaybackObservation
    ): void {
        const normalizedPosition = normalizePosition(positionSeconds);
        if (normalizedPosition === null) {
            return;
        }

        if (this.requestedPositionSeconds !== null) {
            const positionDifference = Math.abs(
                normalizedPosition - this.requestedPositionSeconds
            );
            const completionWasClamped = this.isBoundaryClamp(
                normalizedPosition,
                seekBounds
            );
            if (
                positionDifference > HLS_SEEK_CORRELATION_TOLERANCE_SECONDS
                && !completionWasClamped
            ) {
                return;
            }

            this.stablePositionSeconds = completionWasClamped ?
                normalizedPosition :
                this.requestedPositionSeconds;
            this.requestedPositionSeconds = null;
            this.postSeekAuthority = this.createPostSeekAuthority(
                this.stablePositionSeconds,
                observation,
                POST_SEEK_PROBATION_TIMEUPDATE_COUNT
            );
            return;
        }

        this.recordObservedPosition(
            normalizedPosition,
            observation,
            seekBounds,
            false
        );
    }

    /** Records forward playback without accepting an unexplained rollback. */
    public recordPlaybackPosition(
        positionSeconds: number,
        observation?: HLSPlaybackObservation,
        seekBounds?: HLSSeekBounds
    ): void {
        const normalizedPosition = normalizePosition(positionSeconds);
        if (normalizedPosition === null) {
            return;
        }

        this.recordObservedPosition(
            normalizedPosition,
            observation,
            seekBounds,
            true
        );
    }

    /** Accepts a position change explicitly performed by hls.js. */
    public recordHLSTrustedPosition(
        positionSeconds: number,
        observation?: HLSPlaybackObservation
    ): boolean {
        const normalizedPosition = normalizePosition(positionSeconds);
        if (
            normalizedPosition === null
            || this.requestedPositionSeconds !== null
        ) {
            return false;
        }

        this.stablePositionSeconds = normalizedPosition;
        if (this.postSeekAuthority) {
            this.postSeekAuthority = this.createPostSeekAuthority(
                normalizedPosition,
                observation,
                this.postSeekAuthority.remainingTimeupdateCount
            );
        }
        return true;
    }

    private recordObservedPosition(
        normalizedPosition: number,
        observation: HLSPlaybackObservation | undefined,
        seekBounds: HLSSeekBounds | undefined,
        countsAsTimeupdate: boolean
    ): void {
        if (this.requestedPositionSeconds !== null) {
            return;
        }

        this.updatePostSeekAuthority(observation);
        if (this.postSeekAuthority) {
            if (
                !this.isWithinPostSeekEnvelope(normalizedPosition)
                && !this.rebaseAtExpiredDVRBoundary(
                    normalizedPosition,
                    seekBounds
                )
            ) {
                return;
            }
        }

        if (normalizedPosition === 0 && this.stablePositionSeconds === null) {
            return;
        }

        if (
            this.stablePositionSeconds === null
            || normalizedPosition > this.stablePositionSeconds
        ) {
            this.stablePositionSeconds = normalizedPosition;
        }

        if (this.postSeekAuthority && countsAsTimeupdate) {
            const remainingTimeupdateCount =
                this.postSeekAuthority.remainingTimeupdateCount - 1;
            if (remainingTimeupdateCount <= 0) {
                this.postSeekAuthority = null;
            } else {
                this.postSeekAuthority = this.createPostSeekAuthority(
                    this.stablePositionSeconds ?? normalizedPosition,
                    observation,
                    remainingTimeupdateCount
                );
            }
        }
    }

    /** Updates the progression budget across play, pause, and rate changes. */
    public recordPlaybackState(observation: HLSPlaybackObservation): void {
        this.updatePostSeekAuthority(observation);
    }

    /** Selects the latest valid position for MediaSource recovery. */
    public getRecoveryPosition(
        currentPositionSeconds: number,
        observation?: HLSPlaybackObservation,
        seekBounds?: HLSSeekBounds
    ): number | null {
        if (this.requestedPositionSeconds !== null) {
            return this.requestedPositionSeconds;
        }

        const normalizedCurrentPosition = normalizePosition(currentPositionSeconds);
        if (normalizedCurrentPosition === null) {
            return this.stablePositionSeconds;
        }

        if (this.stablePositionSeconds === null) {
            return normalizedCurrentPosition > 0 ? normalizedCurrentPosition : null;
        }

        this.updatePostSeekAuthority(observation);
        if (
            this.postSeekAuthority
            && !this.isWithinPostSeekEnvelope(normalizedCurrentPosition)
            && !this.rebaseAtExpiredDVRBoundary(
                normalizedCurrentPosition,
                seekBounds
            )
        ) {
            return this.stablePositionSeconds;
        }

        return Math.max(normalizedCurrentPosition, this.stablePositionSeconds);
    }

    private isWithinPostSeekEnvelope(positionSeconds: number): boolean {
        const authority = this.postSeekAuthority;
        if (!authority) {
            return true;
        }

        return positionSeconds >= authority.positionSeconds
                - HLS_SEEK_CORRELATION_TOLERANCE_SECONDS
            && positionSeconds <= authority.positionSeconds
                + authority.allowedAdvanceSeconds;
    }

    private rebaseAtExpiredDVRBoundary(
        positionSeconds: number,
        seekBounds?: HLSSeekBounds
    ): boolean {
        const authority = this.postSeekAuthority;
        if (!authority || !seekBounds) {
            return false;
        }

        const minimumPositionSeconds = normalizePosition(
            seekBounds.minimumPositionSeconds ?? Number.NaN
        );
        const maximumPositionSeconds = normalizePosition(
            seekBounds.maximumPositionSeconds ?? Number.NaN
        );
        if (
            minimumPositionSeconds === null
            || authority.positionSeconds >= minimumPositionSeconds
                - HLS_SEEK_CORRELATION_TOLERANCE_SECONDS
            || !this.isInsideSeekableBounds(positionSeconds, {
                ...seekBounds,
                maximumPositionSeconds,
                minimumPositionSeconds
            })
        ) {
            return false;
        }

        this.stablePositionSeconds = positionSeconds;
        return true;
    }

    private createPostSeekAuthority(
        positionSeconds: number,
        observation: HLSPlaybackObservation | undefined,
        remainingTimeupdateCount: number
    ): PostSeekAuthority {
        return {
            allowedAdvanceSeconds: HLS_SEEK_CORRELATION_TOLERANCE_SECONDS,
            lastObservation: normalizeObservation(observation),
            positionSeconds,
            remainingTimeupdateCount
        };
    }

    private updatePostSeekAuthority(observation?: HLSPlaybackObservation): void {
        const authority = this.postSeekAuthority;
        if (!authority) {
            return;
        }

        const normalizedObservation = normalizeObservation(observation);
        const elapsedSeconds = Math.max(
            0,
            normalizedObservation.monotonicTimeSeconds
                - authority.lastObservation.monotonicTimeSeconds
        );
        if (authority.lastObservation.playing) {
            authority.allowedAdvanceSeconds += elapsedSeconds
                * authority.lastObservation.playbackRate;
        }
        authority.lastObservation = normalizedObservation;
    }

    private isBoundaryClamp(
        completedPositionSeconds: number,
        seekBounds?: HLSSeekBounds
    ): boolean {
        if (this.requestedPositionSeconds === null || !seekBounds) {
            return false;
        }

        const maximumPositionSeconds = normalizePosition(
            seekBounds.maximumPositionSeconds ?? Number.NaN
        );
        if (
            maximumPositionSeconds !== null
            && this.requestedPositionSeconds >= maximumPositionSeconds
                - HLS_SEEK_CORRELATION_TOLERANCE_SECONDS
            && Math.abs(completedPositionSeconds - maximumPositionSeconds)
                <= HLS_SEEK_CORRELATION_TOLERANCE_SECONDS
        ) {
            return true;
        }

        const minimumPositionSeconds = normalizePosition(
            seekBounds.minimumPositionSeconds ?? Number.NaN
        );
        if (
            minimumPositionSeconds !== null
            && this.requestedPositionSeconds < minimumPositionSeconds
                - HLS_SEEK_CORRELATION_TOLERANCE_SECONDS
        ) {
            return this.isInsideSeekableBounds(
                completedPositionSeconds,
                seekBounds
            );
        }

        return minimumPositionSeconds !== null
            && this.requestedPositionSeconds <= minimumPositionSeconds
                + HLS_SEEK_CORRELATION_TOLERANCE_SECONDS
            && Math.abs(completedPositionSeconds - minimumPositionSeconds)
                <= HLS_SEEK_CORRELATION_TOLERANCE_SECONDS;
    }

    private isInsideSeekableBounds(
        positionSeconds: number,
        seekBounds: HLSSeekBounds
    ): boolean {
        if (seekBounds.ranges?.length) {
            return seekBounds.ranges.some(range =>
                positionSeconds >= range.startPositionSeconds
                    - HLS_SEEK_CORRELATION_TOLERANCE_SECONDS
                && positionSeconds <= range.endPositionSeconds
                    + HLS_SEEK_CORRELATION_TOLERANCE_SECONDS
            );
        }

        const minimumPositionSeconds = normalizePosition(
            seekBounds.minimumPositionSeconds ?? Number.NaN
        );
        const maximumPositionSeconds = normalizePosition(
            seekBounds.maximumPositionSeconds ?? Number.NaN
        );
        return minimumPositionSeconds !== null
            && maximumPositionSeconds !== null
            && positionSeconds >= minimumPositionSeconds
                - HLS_SEEK_CORRELATION_TOLERANCE_SECONDS
            && positionSeconds <= maximumPositionSeconds
                + HLS_SEEK_CORRELATION_TOLERANCE_SECONDS;
    }
}
