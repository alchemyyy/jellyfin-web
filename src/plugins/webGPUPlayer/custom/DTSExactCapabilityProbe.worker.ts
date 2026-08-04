import {
    isDTSExactCapabilityWorkerRequest,
    type DTSExactCapabilityWorkerResponse
} from './DTSExactCapabilityProtocol';
import { runDTSExactCapabilityQualification } from './DTSExactCapabilityRunner';

let probeStarted = false;

async function handleRequest(value: unknown): Promise<void> {
    if (probeStarted || !isDTSExactCapabilityWorkerRequest(value)) {
        return;
    }
    probeStarted = true;
    const response: DTSExactCapabilityWorkerResponse =
        await runDTSExactCapabilityQualification();
    globalThis.postMessage(response);
}

// eslint-disable-next-line sonarjs/post-message -- Dedicated workers do not receive window origins
globalThis.addEventListener('message', (event: MessageEvent<unknown>): void => {
    void handleRequest(event.data);
});

// worker-loader replaces this module export with its Worker constructor.
const WorkerConstructor = null as unknown as { new(): Worker };
export default WorkerConstructor;
