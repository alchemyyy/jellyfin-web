import JPEG2000SoftwareVideoDecoder, {
    getJPEG2000RGBAFingerprint,
    type JPEG2000SoftwareVideoDecoderDependencies,
    type OpenJPEGModule
} from './JPEG2000SoftwareVideoDecoder';
import {
    isJPEG2000ExactCapabilityWorkerRequest,
    JPEG2000_EXACT_CAPABILITY_REQUEST_ID,
    JPEG2000_QUALIFICATION_CODED_HEIGHT,
    JPEG2000_QUALIFICATION_CODED_WIDTH,
    JPEG2000_QUALIFICATION_FRAME_COUNT,
    JPEG2000_QUALIFICATION_MINIMUM_FRAMES_PER_SECOND,
    JPEG2000_QUALIFICATION_RGBA_BYTE_LENGTH,
    JPEG2000_QUALIFICATION_RGBA_FINGERPRINT,
    JPEG2000_QUALIFICATION_WARMUP_FRAME_COUNT,
    type JPEG2000ExactCapabilityWorkerRequest,
    type JPEG2000ExactCapabilityWorkerResponse
} from './JPEG2000ExactCapabilityProtocol';
import { type RawVideoFrameGeometry } from './RawVideoFrameCopy';
import { requireMicroseconds } from './TimeMath';

type OpenJPEGModuleFactory = (options: {
    locateFile: (path: string, prefix: string) => string
    print: (...values: unknown[]) => void
    printErr: (...values: unknown[]) => void
}) => Promise<OpenJPEGModule>;

type JPEG2000ProbeWorkerScope = typeof globalThis & {
    OpenJPEGWASM?: unknown
    importScripts?: (...urls: string[]) => void
};

const workerScope = globalThis as JPEG2000ProbeWorkerScope;
const QUALIFICATION_GEOMETRY: RawVideoFrameGeometry = {
    codedHeight: JPEG2000_QUALIFICATION_CODED_HEIGHT,
    codedWidth: JPEG2000_QUALIFICATION_CODED_WIDTH,
    displayHeight: JPEG2000_QUALIFICATION_CODED_HEIGHT,
    displayWidth: JPEG2000_QUALIFICATION_CODED_WIDTH
};
let probeStarted = false;

function createFailureResponse(
    reason: JPEG2000ExactCapabilityWorkerResponse['reason'] = 'decode-error'
): JPEG2000ExactCapabilityWorkerResponse {
    return {
        codedHeight: null,
        codedWidth: null,
        decodeMilliseconds: null,
        decodedRGBAByteLength: null,
        decodedRGBAFingerprint: null,
        measuredFramesPerSecond: null,
        reason,
        requestID: JPEG2000_EXACT_CAPABILITY_REQUEST_ID,
        supported: false,
        type: 'result'
    };
}

function createDependencies(
    request: JPEG2000ExactCapabilityWorkerRequest
): JPEG2000SoftwareVideoDecoderDependencies {
    return {
        createModule: async (wasmURL: string): Promise<OpenJPEGModule> => {
            const factory = workerScope.OpenJPEGWASM as OpenJPEGModuleFactory | undefined;
            if (typeof factory !== 'function') {
                throw new Error('The JPEG 2000 probe module factory is unavailable');
            }
            return factory({
                locateFile: (): string => wasmURL,
                print: (): void => undefined,
                printErr: (): void => undefined
            });
        },
        createVideoFrame: (
            data: AllowSharedBufferSource,
            init: VideoFrameBufferInit
        ): VideoFrame => {
            // eslint-disable-next-line compat/compat -- The exact capability probe gates this route
            return new VideoFrame(data, init);
        },
        loadDecoderGlue: (url: string): void => {
            if (typeof workerScope.OpenJPEGWASM === 'function') {
                return;
            }
            if (typeof workerScope.importScripts !== 'function') {
                throw new Error('The JPEG 2000 probe requires a classic Web Worker');
            }
            workerScope.importScripts(url);
        },
        resolveAssetURL: (path: string): string => (
            path.endsWith('.wasm') ? request.decoderWASMURL : request.decoderGlueURL
        )
    };
}

async function runProbe(
    request: JPEG2000ExactCapabilityWorkerRequest
): Promise<JPEG2000ExactCapabilityWorkerResponse> {
    const decoder = new JPEG2000SoftwareVideoDecoder(createDependencies(request));
    try {
        await decoder.init();
        const frameDecodeMilliseconds: number[] = [];
        let decodedRGBAByteLength: number | null = null;
        let decodedRGBAFingerprint: number | null = null;
        for (
            let frameIndex = 0;
            frameIndex < JPEG2000_QUALIFICATION_FRAME_COUNT;
            frameIndex += 1
        ) {
            const startMilliseconds = performance.now();
            const image = decoder.decodeToRGBA(
                new Uint8Array(request.fixture),
                QUALIFICATION_GEOMETRY
            );
            const frame = decoder.createVideoFrame(
                image,
                requireMicroseconds(frameIndex * 41_667),
                requireMicroseconds(41_667),
                QUALIFICATION_GEOMETRY
            );
            frame.close();
            frameDecodeMilliseconds.push(performance.now() - startMilliseconds);
            if (frameIndex === 0) {
                decodedRGBAByteLength = image.rgba.byteLength;
                decodedRGBAFingerprint = getJPEG2000RGBAFingerprint(image.rgba);
            }
        }
        const measuredDecodeMilliseconds = frameDecodeMilliseconds
            .slice(JPEG2000_QUALIFICATION_WARMUP_FRAME_COUNT)
            .reduce((total: number, value: number): number => total + value, 0);
        const measuredFrameCount = JPEG2000_QUALIFICATION_FRAME_COUNT
            - JPEG2000_QUALIFICATION_WARMUP_FRAME_COUNT;
        const measuredFramesPerSecond = measuredFrameCount * 1_000
            / measuredDecodeMilliseconds;
        const outputMatches = decodedRGBAByteLength
                === JPEG2000_QUALIFICATION_RGBA_BYTE_LENGTH
            && decodedRGBAFingerprint === JPEG2000_QUALIFICATION_RGBA_FINGERPRINT;
        const throughputMatches = measuredFramesPerSecond
            >= JPEG2000_QUALIFICATION_MINIMUM_FRAMES_PER_SECOND;
        let reason: JPEG2000ExactCapabilityWorkerResponse['reason'];
        if (!outputMatches) {
            reason = 'output-mismatch';
        } else if (!throughputMatches) {
            reason = 'throughput-insufficient';
        } else {
            reason = 'decode-output-verified';
        }
        return {
            codedHeight: JPEG2000_QUALIFICATION_CODED_HEIGHT,
            codedWidth: JPEG2000_QUALIFICATION_CODED_WIDTH,
            decodeMilliseconds: measuredDecodeMilliseconds,
            decodedRGBAByteLength,
            decodedRGBAFingerprint,
            measuredFramesPerSecond,
            reason,
            requestID: JPEG2000_EXACT_CAPABILITY_REQUEST_ID,
            supported: reason === 'decode-output-verified',
            type: 'result'
        };
    } finally {
        decoder.close();
    }
}

async function handleRequest(value: unknown): Promise<void> {
    if (probeStarted || !isJPEG2000ExactCapabilityWorkerRequest(value)) {
        return;
    }
    probeStarted = true;
    let response: JPEG2000ExactCapabilityWorkerResponse;
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
