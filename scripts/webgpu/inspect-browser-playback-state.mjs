import {
    createPlayerSnapshotExpression,
    evaluateValue,
    getBrowserPageTarget,
    RawCDPClient
} from './run-browser-playback-smoke.mjs';

const DEFAULT_DEBUG_URL = 'http://localhost:9224';
const DEFAULT_FRONTEND_URL = 'http://localhost:8096/web/';
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;

const configuration = {
    debugURL: process.argv[2] ?? DEFAULT_DEBUG_URL,
    frontendURL: process.argv[3] ?? DEFAULT_FRONTEND_URL,
    timeoutMilliseconds: DEFAULT_TIMEOUT_MILLISECONDS
};
const pageTarget = await getBrowserPageTarget(configuration);
const client = await RawCDPClient.connect(
    pageTarget.webSocketDebuggerUrl,
    configuration.timeoutMilliseconds
);
try {
    await client.send('Runtime.enable');
    const page = await evaluateValue(client, `(() => ({
        captureKeys: Object.keys(window).filter(key => (
            key.startsWith('webgpu-reference-access-')
                || key.startsWith('webgpu-smoke-access-')
        )),
        title: document.title,
        url: location.href
    }))()`);
    const captures = [];
    for (const captureKey of page?.captureKeys ?? []) {
        captures.push({
            captureKey,
            snapshot: await evaluateValue(
                client,
                createPlayerSnapshotExpression(captureKey)
            )
        });
    }
    process.stdout.write(`${JSON.stringify({ captures, page }, null, 2)}\n`);
} finally {
    client.close();
}
