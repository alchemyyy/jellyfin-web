import {
    HEVC_EXACT_CAPABILITY_REQUEST_ID,
    isHEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerRequest,
    type HEVCExactCapabilityWorkerQualificationResult,
    type HEVCExactCapabilityWorkerResponse
} from './HEVCExactCapabilityProtocol';
import { runHEVCExactCapabilityWorkerRequest } from './HEVCExactCapabilityWorkerRuntime';

type HEVCDecoderWorkerScope = typeof globalThis & {
    HEVCDecoderModule?: unknown
    importScripts?: (...urls: string[]) => void
};

const workerScope = globalThis as HEVCDecoderWorkerScope;
let probeStarted = false;

function createDecodeErrorResponse(
    request: HEVCExactCapabilityWorkerRequest
): HEVCExactCapabilityWorkerResponse {
    const results: HEVCExactCapabilityWorkerQualificationResult[] = [];
    for (const qualificationRequest of request.qualifications) {
        results.push({
            bitDepth: null,
            chromaHeight: null,
            chromaWidth: null,
            codedHeight: null,
            codedWidth: null,
            decodedFrameFingerprints: null,
            decodedFrameCount: null,
            decodedByteLength: null,
            levelIDC: null,
            profileIDC: null,
            reason: 'decode-error',
            supported: false,
            fixture: qualificationRequest.fixture,
            totalDecodedByteLength: null
        });
    }
    return {
        requestID: HEVC_EXACT_CAPABILITY_REQUEST_ID,
        results,
        type: 'result'
    };
}

function loadDecoderGlue(decoderGlueURL: string): void {
    if (typeof workerScope.HEVCDecoderModule === 'function') {
        return;
    }
    if (typeof workerScope.importScripts !== 'function') {
        throw new Error('The exact HEVC probe requires a classic Web Worker');
    }
    workerScope.importScripts(decoderGlueURL);
    if (typeof workerScope.HEVCDecoderModule !== 'function') {
        throw new Error('The exact HEVC probe decoder glue is unavailable');
    }
}

async function handleRequest(value: unknown): Promise<void> {
    if (probeStarted || !isHEVCExactCapabilityWorkerRequest(value)) {
        return;
    }
    probeStarted = true;
    const request = value;
    let response: HEVCExactCapabilityWorkerResponse;
    try {
        loadDecoderGlue(request.decoderGlueURL);
        response = await runHEVCExactCapabilityWorkerRequest(request);
    } catch {
        response = createDecodeErrorResponse(request);
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
