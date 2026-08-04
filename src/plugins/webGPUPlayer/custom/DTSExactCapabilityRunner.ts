import { MICROSECONDS_PER_SECOND, type Microseconds } from '../MediaTime';
import { getStereoChannelDataFingerprint } from './CustomAudioDownmix';
import { mixCustomAudioToStereo } from './CustomAudioChannelLayout';
import { createDTSExactCapabilityFixtures } from './DTSExactCapabilityFixtures';
import {
    DTS_EXACT_CAPABILITY_REQUEST_ID,
    DTS_QUALIFICATION_FIXTURE_COUNT,
    DTS_QUALIFICATION_MEASURED_CYCLE_COUNT,
    DTS_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR,
    DTS_QUALIFICATION_PROFILE_MASK,
    DTS_QUALIFICATION_WARMUP_CYCLE_COUNT,
    type DTSExactCapabilityWorkerResponse
} from './DTSExactCapabilityProtocol';
import DTSSoftwareAudioDecoder, {
    DTS_PROFILE_HD_MASTER_AUDIO,
    type DTSDecodedAudioOutput,
    getDTSDecodedAudioFingerprint
} from './DTSSoftwareAudioDecoder';

export type DTSExactCapabilityRunnerEnvironment = Readonly<{
    createDecoder: () => Promise<DTSSoftwareAudioDecoder>
    now: () => number
}>;

function createFailureResponse(
    reason: DTSExactCapabilityWorkerResponse['reason'],
    libraryVersion: number | null,
    verifiedFixtureCount: number,
    verifiedProfileMask: number,
    decodeMilliseconds: number | null = null,
    measuredRealTimeFactor: number | null = null
): DTSExactCapabilityWorkerResponse {
    return {
        decodeMilliseconds,
        libraryVersion,
        measuredRealTimeFactor,
        reason,
        requestID: DTS_EXACT_CAPABILITY_REQUEST_ID,
        supported: false,
        type: 'result',
        verifiedFixtureCount,
        verifiedProfileMask
    };
}

function outputMatchesFixture(
    output: DTSDecodedAudioOutput,
    fixture: ReturnType<typeof createDTSExactCapabilityFixtures>[number]
): boolean {
    const outputMatches = output.bitsPerSample === fixture.bitsPerSample
        && output.channelMask === fixture.channelMask
        && output.frameCount === fixture.frameCount
        && output.profile === fixture.profile
        && output.sampleRate === fixture.sampleRate
        && output.parseStatus === 0
        && output.filterStatus === 0
        && (output.profile !== DTS_PROFILE_HD_MASTER_AUDIO || output.lossless)
        && getDTSDecodedAudioFingerprint(output) === fixture.expectedFingerprint;
    if (!outputMatches || fixture.expectedStereoFingerprint === null) {
        return outputMatches;
    }
    const stereo = mixCustomAudioToStereo(output.channelData, output.channelLayout);
    return getStereoChannelDataFingerprint(stereo)
        === fixture.expectedStereoFingerprint;
}

function decodeFixture(
    decoder: DTSSoftwareAudioDecoder,
    accessUnits: readonly Uint8Array[]
): Readonly<{ frameCount: number, output: DTSDecodedAudioOutput }> {
    decoder.clear();
    let frameCount = 0;
    let output: DTSDecodedAudioOutput | null = null;
    for (const accessUnit of accessUnits) {
        output = decoder.decode(accessUnit, 0 as Microseconds);
        frameCount += output.frameCount;
    }
    if (!output) {
        throw new Error('DTS qualification fixture has no access units');
    }
    return { frameCount, output };
}

function createDefaultEnvironment(): DTSExactCapabilityRunnerEnvironment {
    return {
        createDecoder: () => DTSSoftwareAudioDecoder.create(),
        now: () => performance.now()
    };
}

/** Runs exact decode/downmix checks followed by a bounded DTS-HD MA throughput test. */
export async function runDTSExactCapabilityQualification(
    environment: DTSExactCapabilityRunnerEnvironment = createDefaultEnvironment()
): Promise<DTSExactCapabilityWorkerResponse> {
    let decoder: DTSSoftwareAudioDecoder | null = null;
    let libraryVersion: number | null = null;
    let verifiedFixtureCount = 0;
    let verifiedProfileMask = 0;
    try {
        decoder = await environment.createDecoder();
        libraryVersion = decoder.libraryVersion;
        const fixtures = createDTSExactCapabilityFixtures();
        for (const fixture of fixtures) {
            const { output } = decodeFixture(decoder, fixture.accessUnits);
            if (!outputMatchesFixture(output, fixture)) {
                return createFailureResponse(
                    'output-mismatch',
                    libraryVersion,
                    verifiedFixtureCount,
                    verifiedProfileMask
                );
            }
            verifiedFixtureCount += 1;
            verifiedProfileMask |= output.profile;
        }
        if (verifiedFixtureCount !== DTS_QUALIFICATION_FIXTURE_COUNT
            || verifiedProfileMask !== DTS_QUALIFICATION_PROFILE_MASK) {
            return createFailureResponse(
                'output-mismatch',
                libraryVersion,
                verifiedFixtureCount,
                verifiedProfileMask
            );
        }

        const throughputFixture = fixtures.find(fixture => (
            fixture.profile === DTS_PROFILE_HD_MASTER_AUDIO
            && fixture.sampleRate === 192_000
        ));
        if (!throughputFixture) {
            return createFailureResponse(
                'output-mismatch',
                libraryVersion,
                verifiedFixtureCount,
                verifiedProfileMask
            );
        }
        for (let cycleIndex = 0;
            cycleIndex < DTS_QUALIFICATION_WARMUP_CYCLE_COUNT;
            cycleIndex += 1) {
            decodeFixture(decoder, throughputFixture.accessUnits);
        }

        let decodedFrameCount = 0;
        const startMilliseconds = environment.now();
        for (let cycleIndex = 0;
            cycleIndex < DTS_QUALIFICATION_MEASURED_CYCLE_COUNT;
            cycleIndex += 1) {
            decodedFrameCount += decodeFixture(
                decoder,
                throughputFixture.accessUnits
            ).frameCount;
        }
        const decodeMilliseconds = environment.now() - startMilliseconds;
        if (!Number.isFinite(decodeMilliseconds) || decodeMilliseconds <= 0) {
            return createFailureResponse(
                'throughput-insufficient',
                libraryVersion,
                verifiedFixtureCount,
                verifiedProfileMask
            );
        }
        const decodedDurationMilliseconds = decodedFrameCount
            * (MICROSECONDS_PER_SECOND / 1_000)
            / throughputFixture.sampleRate;
        const measuredRealTimeFactor = decodedDurationMilliseconds / decodeMilliseconds;
        if (!Number.isFinite(measuredRealTimeFactor)
            || measuredRealTimeFactor < DTS_QUALIFICATION_MINIMUM_REAL_TIME_FACTOR) {
            return createFailureResponse(
                'throughput-insufficient',
                libraryVersion,
                verifiedFixtureCount,
                verifiedProfileMask,
                decodeMilliseconds,
                Number.isFinite(measuredRealTimeFactor) ? measuredRealTimeFactor : null
            );
        }
        return {
            decodeMilliseconds,
            libraryVersion,
            measuredRealTimeFactor,
            reason: 'decode-output-verified',
            requestID: DTS_EXACT_CAPABILITY_REQUEST_ID,
            supported: true,
            type: 'result',
            verifiedFixtureCount,
            verifiedProfileMask
        };
    } catch {
        return createFailureResponse(
            'decode-error',
            libraryVersion,
            verifiedFixtureCount,
            verifiedProfileMask
        );
    } finally {
        decoder?.close();
    }
}
