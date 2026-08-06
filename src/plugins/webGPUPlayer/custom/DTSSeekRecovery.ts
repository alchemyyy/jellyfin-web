import type { Microseconds } from '../MediaTime';
import { DTSDecoderSynchronizationError } from './DTSSoftwareAudioDecoder';
import { requireMicroseconds } from './TimeMath';

export const DTS_SEEK_PREROLL_MICROSECONDS = 1_000_000;
export const MAXIMUM_DTS_SEEK_RECOVERY_PACKET_COUNT = 512;

/** Bounds the libdcadec XLL synchronization wait after a nonzero seek. */
export default class DTSSeekRecovery {
    public readonly prerollTimeMicroseconds: Microseconds;

    private decodeSucceeded = false;
    private ignoredPacketCount = 0;
    private synchronizationWaitObserved = false;

    public constructor(private readonly targetTimeMicroseconds: Microseconds) {
        requireMicroseconds(targetTimeMicroseconds, 'DTS seek target');
        if (targetTimeMicroseconds < 0) {
            throw new RangeError('DTS seek target must not be negative');
        }
        this.prerollTimeMicroseconds = requireMicroseconds(
            Math.max(0, targetTimeMicroseconds - DTS_SEEK_PREROLL_MICROSECONDS),
            'DTS seek preroll time'
        );
    }

    /** Records the first packet that produced validated DTS output. */
    public markDecodeSucceeded(): void {
        this.decodeSucceeded = true;
    }

    /** Returns true only for a bounded pre-target XLL synchronization wait. */
    public shouldIgnore(
        error: unknown,
        packetTimeMicroseconds: Microseconds
    ): boolean {
        requireMicroseconds(packetTimeMicroseconds, 'DTS recovery packet timestamp');
        if (!(error instanceof DTSDecoderSynchronizationError)
            || this.targetTimeMicroseconds === 0
            || this.decodeSucceeded
            || packetTimeMicroseconds >= this.targetTimeMicroseconds
            || this.ignoredPacketCount >= MAXIMUM_DTS_SEEK_RECOVERY_PACKET_COUNT) {
            return false;
        }

        this.ignoredPacketCount += 1;
        this.synchronizationWaitObserved = true;
        return true;
    }

    /** Fails before decoding a target packet when recovery is already late. */
    public requireSynchronizationRecoveredBefore(
        packetTimeMicroseconds: Microseconds
    ): void {
        requireMicroseconds(packetTimeMicroseconds, 'DTS recovery packet timestamp');
        if (this.synchronizationWaitObserved
            && !this.decodeSucceeded
            && packetTimeMicroseconds >= this.targetTimeMicroseconds) {
            throw new Error('Bundled DTS synchronization was not recovered by the seek target');
        }
    }

    /** Fails if a synchronization wait reached end-of-stream without output. */
    public requireSynchronizationRecovered(): void {
        if (this.synchronizationWaitObserved && !this.decodeSucceeded) {
            throw new Error('Bundled DTS synchronization was not recovered before the seek target');
        }
    }
}
