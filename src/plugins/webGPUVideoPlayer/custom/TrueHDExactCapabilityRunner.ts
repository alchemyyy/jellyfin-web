import { MICROSECONDS_PER_SECOND } from '../MediaTime';
import {
    createTrueHDExactCapabilityFixtures,
    type TrueHDExactCapabilityFixture
} from './TrueHDExactCapabilityFixtures';
import {
    TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
    TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK,
    TRUEHD_QUALIFICATION_CODEC_MASK,
    TRUEHD_QUALIFICATION_FIXTURE_COUNT,
    TRUEHD_QUALIFICATION_MEASURED_CYCLE_COUNT,
    TRUEHD_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR,
    TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK,
    TRUEHD_QUALIFICATION_WARMUP_CYCLE_COUNT,
    type TrueHDExactCapabilityWorkerResponse
} from './TrueHDExactCapabilityProtocol';
import TrueHDSoftwareAudioDecoder, {
    type TrueHDDecodedAudioOutput,
    type TrueHDDecoderCodec
} from './TrueHDSoftwareAudioDecoder';

const TRUEHD_CODEC_MASK = 0x01;
const MLP_CODEC_MASK = 0x02;
const SAMPLE_RATE_48_KHZ_MASK = 0x01;
const SAMPLE_RATE_96_KHZ_MASK = 0x02;
const SAMPLE_RATE_192_KHZ_MASK = 0x04;

export type TrueHDExactCapabilityRunnerEnvironment = Readonly<{
    createDecoder: (codec: TrueHDDecoderCodec) => Promise<TrueHDSoftwareAudioDecoder>
    now: () => number
}>;

type TrueHDQualificationEvidence = {
    decodeMilliseconds: number | null
    libraryVersion: number | null
    majorSyncRecoveryVerified: boolean
    measuredRealTimeFactor: number | null
    verifiedChannelCountMask: number
    verifiedCodecMask: number
    verifiedFixtureCount: number
    verifiedSampleRateMask: number
};

function createFailureResponse(
    reason: TrueHDExactCapabilityWorkerResponse['reason'],
    evidence: Readonly<TrueHDQualificationEvidence>
): TrueHDExactCapabilityWorkerResponse {
    return {
        ...evidence,
        reason,
        requestID: TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
        supported: false,
        type: 'result'
    };
}

function getCodecMask(codec: TrueHDDecoderCodec): number {
    switch (codec) {
        case 'truehd':
            return TRUEHD_CODEC_MASK;
        case 'mlp':
            return MLP_CODEC_MASK;
    }
}

function getSampleRateMask(sampleRate: number): number {
    switch (sampleRate) {
        case 48_000:
            return SAMPLE_RATE_48_KHZ_MASK;
        case 96_000:
            return SAMPLE_RATE_96_KHZ_MASK;
        case 192_000:
            return SAMPLE_RATE_192_KHZ_MASK;
        default:
            return 0;
    }
}

function outputMatchesExpected(
    output: TrueHDDecodedAudioOutput,
    fixture: TrueHDExactCapabilityFixture,
    expectedOutput: TrueHDExactCapabilityFixture['expectedOutputs'][number]
): boolean {
    return output.bitsPerSample === fixture.bitsPerSample
        && output.channelData.length === fixture.channelCount
        && output.channelMask === fixture.channelMask
        && output.codec === fixture.codec
        && output.frameCount === expectedOutput.frameCount
        && output.losslessChannelBed
        && output.mediaTimeMicroseconds === expectedOutput.mediaTimeMicroseconds
        && !output.objectAudioRendered
        && output.pcmFingerprint === expectedOutput.pcmFingerprint
        && output.sampleRate === fixture.sampleRate;
}

function decodeFixture(
    decoder: TrueHDSoftwareAudioDecoder,
    fixture: TrueHDExactCapabilityFixture
): number {
    decoder.clear();
    let decodedFrameCount = 0;
    let decodedOutputCount = 0;
    for (let accessUnitIndex = 0;
        accessUnitIndex < fixture.accessUnits.length;
        accessUnitIndex += 1) {
        const expectedOutput = fixture.expectedOutputs[accessUnitIndex];
        const outputs = decoder.decode(
            fixture.accessUnits[accessUnitIndex],
            expectedOutput.mediaTimeMicroseconds
        );
        if (outputs.length !== 1
            || !outputMatchesExpected(outputs[0], fixture, expectedOutput)) {
            throw new Error('TrueHD exact qualification output mismatch');
        }
        decodedFrameCount += outputs[0].frameCount;
        decodedOutputCount += 1;
    }
    if (decodedOutputCount !== fixture.expectedOutputs.length) {
        throw new Error('TrueHD exact qualification output count mismatch');
    }
    return decodedFrameCount;
}

function verifyMajorSyncRecovery(
    decoder: TrueHDSoftwareAudioDecoder,
    fixture: TrueHDExactCapabilityFixture
): boolean {
    decoder.clear();
    let firstOutput: TrueHDDecodedAudioOutput | null = null;
    for (let accessUnitIndex = fixture.majorSyncRecoveryStartIndex;
        accessUnitIndex < fixture.accessUnits.length;
        accessUnitIndex += 1) {
        const expectedOutput = fixture.expectedOutputs[accessUnitIndex];
        const outputs = decoder.decode(
            fixture.accessUnits[accessUnitIndex],
            expectedOutput.mediaTimeMicroseconds
        );
        for (const output of outputs) {
            if (!outputMatchesExpected(output, fixture, expectedOutput)) {
                return false;
            }
            firstOutput ??= output;
        }
    }
    return firstOutput !== null
        && firstOutput.mediaTimeMicroseconds
            > fixture.expectedOutputs[fixture.majorSyncRecoveryStartIndex].mediaTimeMicroseconds;
}

function measureThroughput(
    decoder: TrueHDSoftwareAudioDecoder,
    fixture: TrueHDExactCapabilityFixture,
    now: () => number
): Pick<TrueHDQualificationEvidence, 'decodeMilliseconds' | 'measuredRealTimeFactor'> {
    for (let cycleIndex = 0;
        cycleIndex < TRUEHD_QUALIFICATION_WARMUP_CYCLE_COUNT;
        cycleIndex += 1) {
        decodeFixture(decoder, fixture);
    }

    let decodedFrameCount = 0;
    const startMilliseconds = now();
    for (let cycleIndex = 0;
        cycleIndex < TRUEHD_QUALIFICATION_MEASURED_CYCLE_COUNT;
        cycleIndex += 1) {
        decodedFrameCount += decodeFixture(decoder, fixture);
    }
    const decodeMilliseconds = now() - startMilliseconds;
    if (!Number.isFinite(decodeMilliseconds) || decodeMilliseconds <= 0) {
        return { decodeMilliseconds: null, measuredRealTimeFactor: null };
    }
    const decodedDurationMilliseconds = decodedFrameCount
        * (MICROSECONDS_PER_SECOND / 1_000)
        / fixture.sampleRate;
    const measuredRealTimeFactor = decodedDurationMilliseconds / decodeMilliseconds;
    return {
        decodeMilliseconds,
        measuredRealTimeFactor: Number.isFinite(measuredRealTimeFactor) ?
            measuredRealTimeFactor :
            null
    };
}

function createDefaultEnvironment(): TrueHDExactCapabilityRunnerEnvironment {
    return {
        createDecoder: codec => TrueHDSoftwareAudioDecoder.create(codec),
        now: () => performance.now()
    };
}

/** Qualifies exact PCM, post-seek major-sync recovery, and real-time throughput. */
export async function runTrueHDExactCapabilityQualification(
    environment: TrueHDExactCapabilityRunnerEnvironment = createDefaultEnvironment()
): Promise<TrueHDExactCapabilityWorkerResponse> {
    const evidence: TrueHDQualificationEvidence = {
        decodeMilliseconds: null,
        libraryVersion: null,
        majorSyncRecoveryVerified: false,
        measuredRealTimeFactor: null,
        verifiedChannelCountMask: 0,
        verifiedCodecMask: 0,
        verifiedFixtureCount: 0,
        verifiedSampleRateMask: 0
    };
    const decoders = new Map<TrueHDDecoderCodec, TrueHDSoftwareAudioDecoder>();
    try {
        const fixtures = createTrueHDExactCapabilityFixtures();
        for (const fixture of fixtures) {
            let decoder = decoders.get(fixture.codec);
            if (!decoder) {
                decoder = await environment.createDecoder(fixture.codec);
                decoders.set(fixture.codec, decoder);
            }
            evidence.libraryVersion ??= decoder.libraryVersion;
            if (decoder.libraryVersion !== evidence.libraryVersion) {
                throw new Error('TrueHD decoders reported inconsistent library versions');
            }
            decodeFixture(decoder, fixture);
            evidence.verifiedFixtureCount += 1;
            evidence.verifiedCodecMask |= getCodecMask(fixture.codec);
            evidence.verifiedChannelCountMask |= 1 << fixture.channelCount;
            evidence.verifiedSampleRateMask |= getSampleRateMask(fixture.sampleRate);
        }
        if (evidence.verifiedFixtureCount !== TRUEHD_QUALIFICATION_FIXTURE_COUNT
            || evidence.verifiedCodecMask !== TRUEHD_QUALIFICATION_CODEC_MASK
            || evidence.verifiedChannelCountMask !== TRUEHD_QUALIFICATION_CHANNEL_COUNT_MASK
            || evidence.verifiedSampleRateMask !== TRUEHD_QUALIFICATION_SAMPLE_RATE_MASK) {
            return createFailureResponse('output-mismatch', evidence);
        }

        const recoveryFixture = fixtures.find(fixture => (
            fixture.codec === 'truehd' && fixture.sampleRate === 48_000
        ));
        const trueHDDecoder = decoders.get('truehd');
        if (!recoveryFixture
            || !trueHDDecoder
            || !verifyMajorSyncRecovery(trueHDDecoder, recoveryFixture)) {
            return createFailureResponse('major-sync-recovery-failed', evidence);
        }
        evidence.majorSyncRecoveryVerified = true;

        const throughputFixture = fixtures.find(fixture => (
            fixture.codec === 'truehd'
            && fixture.channelCount === 6
            && fixture.sampleRate === 192_000
        ));
        if (!throughputFixture) {
            throw new Error('TrueHD throughput fixture is unavailable');
        }
        const throughput = measureThroughput(
            trueHDDecoder,
            throughputFixture,
            environment.now
        );
        evidence.decodeMilliseconds = throughput.decodeMilliseconds;
        evidence.measuredRealTimeFactor = throughput.measuredRealTimeFactor;
        if (evidence.measuredRealTimeFactor === null
            || evidence.measuredRealTimeFactor
                < TRUEHD_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR) {
            return createFailureResponse('throughput-insufficient', evidence);
        }
        return {
            ...evidence,
            reason: 'decode-output-verified',
            requestID: TRUEHD_EXACT_CAPABILITY_REQUEST_ID,
            supported: true,
            type: 'result'
        };
    } catch {
        return createFailureResponse('decode-error', evidence);
    } finally {
        for (const decoder of decoders.values()) {
            decoder.close();
        }
    }
}
