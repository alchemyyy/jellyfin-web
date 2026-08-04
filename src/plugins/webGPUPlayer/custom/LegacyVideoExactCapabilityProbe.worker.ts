import {
    ALL_FORMATS,
    BufferSource,
    EncodedPacketSink,
    Input,
    type InputVideoTrack,
    type VideoSample
} from 'mediabunny';

import LegacySoftwareVideoDecoder, {
    type LegacySoftwareVideoDecoderDependencies,
    type LegacyVideoDecoderModule
} from './LegacySoftwareVideoDecoder';
import {
    isLegacyVideoExactCapabilityWorkerRequest,
    LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID,
    LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT,
    LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH,
    LEGACY_VIDEO_QUALIFICATION_FINGERPRINT,
    LEGACY_VIDEO_QUALIFICATION_FRAME_BYTE_LENGTH,
    LEGACY_VIDEO_QUALIFICATION_FRAME_COUNT,
    LEGACY_VIDEO_QUALIFICATION_MINIMUM_FRAMES_PER_SECOND,
    LEGACY_VIDEO_QUALIFICATION_TOTAL_BYTE_LENGTH,
    LEGACY_VIDEO_QUALIFICATION_WARMUP_FRAME_COUNT,
    type LegacyVideoExactCapabilityWorkerRequest,
    type LegacyVideoExactCapabilityWorkerResponse
} from './LegacyVideoExactCapabilityProtocol';

type LegacyVideoDecoderModuleFactory = (options: {
    locateFile: (path: string) => string
}) => Promise<LegacyVideoDecoderModule>;

type LegacyVideoProbeWorkerScope = typeof globalThis & {
    LegacyVideoDecoderModule?: unknown
    importScripts?: (...urls: string[]) => void
};

const FNV_OFFSET_BASIS = 2_166_136_261;
const FNV_PRIME = 16_777_619;
const workerScope = globalThis as LegacyVideoProbeWorkerScope;
let probeStarted = false;

function createFailureResponse(
    reason: LegacyVideoExactCapabilityWorkerResponse['reason'] = 'decode-error'
): LegacyVideoExactCapabilityWorkerResponse {
    return {
        codedHeight: null,
        codedWidth: null,
        decodeMilliseconds: null,
        decodedFrameByteLength: null,
        decodedFrameCount: null,
        decodedI420Fingerprint: null,
        decodedTotalByteLength: null,
        measuredFramesPerSecond: null,
        reason,
        requestID: LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID,
        supported: false,
        type: 'result'
    };
}

function createDependencies(
    request: LegacyVideoExactCapabilityWorkerRequest
): LegacySoftwareVideoDecoderDependencies {
    return {
        createModule: async (wasmURL: string): Promise<LegacyVideoDecoderModule> => {
            const factory = workerScope.LegacyVideoDecoderModule as
                LegacyVideoDecoderModuleFactory | undefined;
            if (typeof factory !== 'function') {
                throw new Error('The legacy video probe module factory is unavailable');
            }
            return factory({ locateFile: (): string => wasmURL });
        },
        loadDecoderGlue: (url: string): void => {
            if (typeof workerScope.LegacyVideoDecoderModule === 'function') {
                return;
            }
            if (typeof workerScope.importScripts !== 'function') {
                throw new Error('The legacy video probe requires a classic Web Worker');
            }
            workerScope.importScripts(url);
        },
        resolveAssetURL: (path: string): string => (
            path.endsWith('.wasm') ? request.decoderWASMURL : request.decoderGlueURL
        )
    };
}

async function getQualifiedTrack(input: Input): Promise<InputVideoTrack> {
    const tracks = await input.getVideoTracks();
    if (tracks.length !== 1) {
        throw new TypeError('The legacy video fixture track count is invalid');
    }
    const track = tracks[0];
    const [ codec, internalCodecID, codedHeight, codedWidth ] = await Promise.all([
        track.getCodec(),
        track.getInternalCodecId(),
        track.getCodedHeight(),
        track.getCodedWidth()
    ]);
    if (
        codec !== null
        || internalCodecID !== 'V_MPEG2'
        || codedHeight !== LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT
        || codedWidth !== LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH
    ) {
        throw new TypeError('The legacy video fixture route is invalid');
    }
    return track;
}

async function fingerprintSamples(samples: readonly VideoSample[]): Promise<{
    decodedFrameByteLength: number
    decodedI420Fingerprint: number
    decodedTotalByteLength: number
}> {
    let decodedFrameByteLength = 0;
    let decodedI420Fingerprint = FNV_OFFSET_BASIS;
    let decodedTotalByteLength = 0;
    for (const sample of samples) {
        if (sample.format !== 'I420') {
            throw new TypeError('The legacy video qualification output is not I420');
        }
        const output = new Uint8Array(sample.allocationSize());
        await sample.copyTo(output);
        if (decodedFrameByteLength === 0) {
            decodedFrameByteLength = output.byteLength;
        } else if (output.byteLength !== decodedFrameByteLength) {
            throw new TypeError('The legacy video qualification frame size changed');
        }
        decodedTotalByteLength += output.byteLength;
        for (const byte of output) {
            decodedI420Fingerprint ^= byte;
            decodedI420Fingerprint = Math.imul(
                decodedI420Fingerprint,
                FNV_PRIME
            ) >>> 0;
        }
    }
    return {
        decodedFrameByteLength,
        decodedI420Fingerprint,
        decodedTotalByteLength
    };
}

async function runProbe(
    request: LegacyVideoExactCapabilityWorkerRequest
): Promise<LegacyVideoExactCapabilityWorkerResponse> {
    const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(new Uint8Array(request.fixture))
    });
    const samples: VideoSample[] = [];
    let decodeError: unknown = null;
    let measurementStartMilliseconds: number | null = null;
    const decoder = new LegacySoftwareVideoDecoder({
        codec: 'mpeg2video',
        codedHeight: LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT,
        codedWidth: LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH,
        displayHeight: LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT,
        displayWidth: LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH
    }, {
        onError: (error: unknown): void => {
            decodeError = error;
        },
        onSample: (sample: VideoSample): void => {
            samples.push(sample);
            if (samples.length === LEGACY_VIDEO_QUALIFICATION_WARMUP_FRAME_COUNT) {
                measurementStartMilliseconds = performance.now();
            }
        }
    }, createDependencies(request));
    try {
        const track = await getQualifiedTrack(input);
        await decoder.init();
        const packetSink = new EncodedPacketSink(track);
        for await (const packet of packetSink.packets()) {
            decoder.decode(packet);
        }
        decoder.flush();
        const measurementEndMilliseconds = performance.now();
        if (decodeError !== null) {
            throw decodeError;
        }
        if (
            samples.length !== LEGACY_VIDEO_QUALIFICATION_FRAME_COUNT
            || measurementStartMilliseconds === null
        ) {
            throw new TypeError('The legacy video qualification frame count is invalid');
        }
        const decodeMilliseconds = measurementEndMilliseconds
            - measurementStartMilliseconds;
        const measuredFrameCount = LEGACY_VIDEO_QUALIFICATION_FRAME_COUNT
            - LEGACY_VIDEO_QUALIFICATION_WARMUP_FRAME_COUNT;
        const measuredFramesPerSecond = measuredFrameCount * 1_000 / decodeMilliseconds;
        const fingerprints = await fingerprintSamples(samples);
        const outputMatches = fingerprints.decodedFrameByteLength
                === LEGACY_VIDEO_QUALIFICATION_FRAME_BYTE_LENGTH
            && fingerprints.decodedTotalByteLength
                === LEGACY_VIDEO_QUALIFICATION_TOTAL_BYTE_LENGTH
            && fingerprints.decodedI420Fingerprint
                === LEGACY_VIDEO_QUALIFICATION_FINGERPRINT;
        const throughputMatches = measuredFramesPerSecond
            >= LEGACY_VIDEO_QUALIFICATION_MINIMUM_FRAMES_PER_SECOND;
        let reason: LegacyVideoExactCapabilityWorkerResponse['reason'];
        if (!outputMatches) {
            reason = 'output-mismatch';
        } else if (!throughputMatches) {
            reason = 'throughput-insufficient';
        } else {
            reason = 'decode-output-verified';
        }
        return {
            codedHeight: LEGACY_VIDEO_QUALIFICATION_CODED_HEIGHT,
            codedWidth: LEGACY_VIDEO_QUALIFICATION_CODED_WIDTH,
            decodeMilliseconds,
            decodedFrameByteLength: fingerprints.decodedFrameByteLength,
            decodedFrameCount: samples.length,
            decodedI420Fingerprint: fingerprints.decodedI420Fingerprint,
            decodedTotalByteLength: fingerprints.decodedTotalByteLength,
            measuredFramesPerSecond,
            reason,
            requestID: LEGACY_VIDEO_EXACT_CAPABILITY_REQUEST_ID,
            supported: reason === 'decode-output-verified',
            type: 'result'
        };
    } finally {
        for (const sample of samples) {
            sample.close();
        }
        decoder.close();
        input.dispose();
    }
}

async function handleRequest(value: unknown): Promise<void> {
    if (probeStarted || !isLegacyVideoExactCapabilityWorkerRequest(value)) {
        return;
    }
    probeStarted = true;
    let response: LegacyVideoExactCapabilityWorkerResponse;
    try {
        response = await runProbe(value);
    } catch {
        response = createFailureResponse();
    }
    workerScope.postMessage(response);
}

// eslint-disable-next-line sonarjs/post-message -- Dedicated workers do not receive window origins
workerScope.addEventListener('message', (event: MessageEvent<unknown>): void => {
    void handleRequest(event.data);
});

// worker-loader replaces this module export with its Worker constructor.
const WorkerConstructor = null as unknown as { new(): Worker };
export default WorkerConstructor;
