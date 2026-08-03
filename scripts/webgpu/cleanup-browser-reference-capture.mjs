import {
    evaluateValue,
    getBrowserPageTarget,
    RawCDPClient
} from './run-browser-playback-smoke.mjs';

const DEFAULT_DEBUG_URL = 'http://localhost:9224';
const DEFAULT_FRONTEND_URL = 'http://localhost:8096/web/';
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;

function readArgument(commandArguments, name, fallback) {
    const argumentIndex = commandArguments.indexOf(name);
    if (argumentIndex < 0) {
        return fallback;
    }
    const value = commandArguments[argumentIndex + 1];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) {
        throw new TypeError(`Missing value for ${name}`);
    }
    return value;
}

const timeoutText = readArgument(
    process.argv.slice(2),
    '--timeout-ms',
    String(DEFAULT_TIMEOUT_MILLISECONDS)
);
const timeoutMilliseconds = Number.parseInt(timeoutText, 10);
if (!Number.isSafeInteger(timeoutMilliseconds) || timeoutMilliseconds <= 0) {
    throw new RangeError('Cleanup timeout must be a positive integer');
}
const configuration = {
    debugURL: readArgument(
        process.argv.slice(2),
        '--debug-url',
        DEFAULT_DEBUG_URL
    ),
    frontendURL: readArgument(
        process.argv.slice(2),
        '--frontend-url',
        DEFAULT_FRONTEND_URL
    ),
    timeoutMilliseconds
};

const pageTarget = await getBrowserPageTarget(configuration);
const client = await RawCDPClient.connect(
    pageTarget.webSocketDebuggerUrl,
    configuration.timeoutMilliseconds
);
try {
    await client.send('Runtime.enable');
    const cleanupResult = await evaluateValue(client, `(async () => {
        const accessPrefix = 'webgpu-reference-access-';
        const restorePrefix = 'webgpu-reference-restore-';
        const accessKeys = Object.keys(window).filter(key => key.startsWith(accessPrefix));
        const restoreKeys = Object.keys(window).filter(key => key.startsWith(restorePrefix));
        const stoppedAccessKeys = [];
        const failedAccessKeys = [];
        for (const accessKey of accessKeys) {
            try {
                const player = window[accessKey]?.()?.player;
                if (player) {
                    await Promise.resolve(player.stop(false));
                    stoppedAccessKeys.push(accessKey);
                }
            } catch {
                failedAccessKeys.push(accessKey);
            }
            delete window[accessKey];
        }
        const failedRestoreKeys = [];
        for (const restoreKey of restoreKeys) {
            try {
                window[restoreKey]?.();
            } catch {
                failedRestoreKeys.push(restoreKey);
            }
            delete window[restoreKey];
        }
        document.querySelector(
            'style[data-webgpu-reference-capture-style]'
        )?.remove();
        return {
            failedAccessKeys,
            failedRestoreKeys,
            removedAccessKeyCount: accessKeys.length,
            removedRestoreKeyCount: restoreKeys.length,
            stoppedAccessKeyCount: stoppedAccessKeys.length
        };
    })()`);
    try {
        await client.send('Emulation.clearDeviceMetricsOverride');
    } catch {
        // The abandoned session may not have installed a metrics override
    }
    process.stdout.write(`${JSON.stringify({
        cleanup: cleanupResult,
        status: 'cleaned'
    }, null, 2)}\n`);
} finally {
    client.close();
}
