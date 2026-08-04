import { describe, expect, it } from 'vitest';

import {
    TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK,
    TRUEHD_QUALIFICATION_CODEC_MASK,
    TRUEHD_QUALIFICATION_FIXTURE_COUNT,
    TRUEHD_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR,
    TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK
} from './TrueHDExactCapabilityProtocol';
import { runTrueHDExactCapabilityQualification } from './TrueHDExactCapabilityRunner';

describe('runTrueHDExactCapabilityQualification integration', () => {
    it('verifies exact PCM, major-sync recovery, and real-time throughput', async () => {
        const result = await runTrueHDExactCapabilityQualification();

        expect(result).toMatchObject({
            majorSyncRecoveryVerified: true,
            reason: 'decode-output-verified',
            supported: true,
            verifiedChannelCountMask: TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK,
            verifiedCodecMask: TRUEHD_QUALIFICATION_CODEC_MASK,
            verifiedFixtureCount: TRUEHD_QUALIFICATION_FIXTURE_COUNT,
            verifiedSampleRateMask: TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK
        });
        expect(result.libraryVersion).toBeGreaterThan(0);
        expect(result.decodeMilliseconds).toBeGreaterThan(0);
        expect(result.measuredRealTimeFactor).toBeGreaterThanOrEqual(
            TRUEHD_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR
        );
    }, 30_000);
});
