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
import { getMatroskaVC1DecoderDescription } from './MatroskaVFWVideoConfiguration';
import {
    getLegacyVideoQualification,
    isLegacyVideoExactCapabilityWorkerRequest,
    type LegacyVideoExactCapabilityRequestID,
    type LegacyVideoExactCapabilityWorkerRequest,
    type LegacyVideoExactCapabilityWorkerResponse,
    type LegacyVideoQualification
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
    requestID: LegacyVideoExactCapabilityRequestID,
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
        requestID,
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

async function getQualifiedTrack(
    input: Input,
    qualification: LegacyVideoQualification
): Promise<{
        description?: Uint8Array
        track: InputVideoTrack
    }> {
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
        || internalCodecID !== qualification.internalCodecID
        || codedHeight !== qualification.codedHeight
        || codedWidth !== qualification.codedWidth
    ) {
        throw new TypeError('The legacy video fixture route is invalid');
    }
    if (qualification.codec === 'vc1') {
        const description = getMatroskaVC1DecoderDescription(
            track,
            codedWidth,
            codedHeight
        );
        if (!description) {
            throw new TypeError('The VC-1 qualification description is invalid');
        }
        return { description, track };
    }
    return { track };
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
    const qualification = getLegacyVideoQualification(request.requestID);
    const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(new Uint8Array(request.fixture))
    });
    const samples: VideoSample[] = [];
    let decodeError: unknown = null;
    let measurementStartMilliseconds: number | null = null;
    let decoder: LegacySoftwareVideoDecoder | null = null;
    try {
        const qualifiedTrack = await getQualifiedTrack(input, qualification);
        decoder = new LegacySoftwareVideoDecoder({
            codec: qualification.codec,
            codedHeight: qualification.codedHeight,
            codedWidth: qualification.codedWidth,
            description: qualifiedTrack.description,
            displayHeight: qualification.codedHeight,
            displayWidth: qualification.codedWidth
        }, {
            onError: (error: unknown): void => {
                decodeError = error;
            },
            onSample: (sample: VideoSample): void => {
                samples.push(sample);
                if (samples.length === qualification.warmupFrameCount) {
                    measurementStartMilliseconds = performance.now();
                }
            }
        }, createDependencies(request));
        await decoder.init();
        const packetSink = new EncodedPacketSink(qualifiedTrack.track);
        for await (const packet of packetSink.packets()) {
            decoder.decode(packet);
        }
        decoder.flush();
        const measurementEndMilliseconds = performance.now();
        if (decodeError !== null) {
            throw decodeError;
        }
        if (
            samples.length !== qualification.frameCount
            || measurementStartMilliseconds === null
        ) {
            throw new TypeError('The legacy video qualification frame count is invalid');
        }
        const decodeMilliseconds = measurementEndMilliseconds
            - measurementStartMilliseconds;
        const measuredFrameCount = qualification.frameCount
            - qualification.warmupFrameCount;
        const measuredFramesPerSecond = measuredFrameCount * 1_000 / decodeMilliseconds;
        const fingerprints = await fingerprintSamples(samples);
        const outputMatches = fingerprints.decodedFrameByteLength
                === qualification.frameByteLength
            && fingerprints.decodedTotalByteLength === qualification.totalByteLength
            && fingerprints.decodedI420Fingerprint === qualification.fingerprint;
        const throughputMatches = measuredFramesPerSecond
            >= qualification.minimumFramesPerSecond;
        let reason: LegacyVideoExactCapabilityWorkerResponse['reason'];
        if (!outputMatches) {
            reason = 'output-mismatch';
        } else if (!throughputMatches) {
            reason = 'throughput-insufficient';
        } else {
            reason = 'decode-output-verified';
        }
        return {
            codedHeight: qualification.codedHeight,
            codedWidth: qualification.codedWidth,
            decodeMilliseconds,
            decodedFrameByteLength: fingerprints.decodedFrameByteLength,
            decodedFrameCount: samples.length,
            decodedI420Fingerprint: fingerprints.decodedI420Fingerprint,
            decodedTotalByteLength: fingerprints.decodedTotalByteLength,
            measuredFramesPerSecond,
            reason,
            requestID: qualification.requestID,
            supported: reason === 'decode-output-verified',
            type: 'result'
        };
    } finally {
        for (const sample of samples) {
            sample.close();
        }
        decoder?.close();
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
        response = createFailureResponse(value.requestID);
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
