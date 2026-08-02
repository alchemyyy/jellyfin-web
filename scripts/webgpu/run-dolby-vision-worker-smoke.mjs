/* eslint-disable compat/compat -- This validation harness requires Node 24 */

const DEFAULT_DEBUG_URL = 'http://127.0.0.1:9226';
const DEFAULT_FRONTEND_URL = 'http://localhost:8096/web/';
const DEFAULT_TIMEOUT_MILLISECONDS = 120_000;
const EXPECTED_BASE_HEIGHT = 2_160;
const EXPECTED_BASE_WIDTH = 3_840;
const EXPECTED_ENHANCEMENT_HEIGHT = 1_080;
const EXPECTED_ENHANCEMENT_WIDTH = 1_920;
const EXPECTED_METADATA_SCHEMA_VERSION = 4;
const WEBSOCKET_OPEN_STATE = 1;

const USAGE = `Usage:
  node scripts/webgpu/run-dolby-vision-worker-smoke.mjs [options]

Options:
  --debug-url <url>      Chromium remote-debugging HTTP endpoint
  --frontend-url <url>   Built Jellyfin Web frontend URL
  --media-url <url>      Same-origin Profile 7 FEL Matroska fixture URL
  --timeout-ms <number>  Worker validation timeout
  --help                 Show this text`;

class ValidationError extends Error {
    constructor(code, message, diagnostics = null) {
        super(message);
        this.code = code;
        this.diagnostics = diagnostics;
        this.name = 'ValidationError';
    }
}

class CDPClient {
    constructor(socket, commandTimeoutMilliseconds) {
        this.commandTimeoutMilliseconds = commandTimeoutMilliseconds;
        this.nextCommandIdentifier = 1;
        this.pendingCommands = new Map();
        this.socket = socket;
        this.socket.addEventListener('message', event => this.handleMessage(event));
        this.socket.addEventListener('close', () => this.handleClose());
    }

    static async connect(webSocketDebuggerURL, timeoutMilliseconds) {
        const socket = new WebSocket(webSocketDebuggerURL);
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new ValidationError(
                    'debug-connection-timeout',
                    'Timed out while connecting to Chromium'
                ));
            }, timeoutMilliseconds);
            socket.addEventListener('open', () => {
                clearTimeout(timeout);
                resolve();
            }, { once: true });
            socket.addEventListener('error', () => {
                clearTimeout(timeout);
                reject(new ValidationError(
                    'debug-connection-failed',
                    'Unable to connect to Chromium'
                ));
            }, { once: true });
        });
        return new CDPClient(socket, timeoutMilliseconds + 5_000);
    }

    close() {
        if (this.socket.readyState === WEBSOCKET_OPEN_STATE) {
            this.socket.close();
        }
    }

    send(method, parameters = {}) {
        const identifier = this.nextCommandIdentifier;
        this.nextCommandIdentifier += 1;
        const commandPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingCommands.delete(identifier);
                reject(new ValidationError(
                    'debug-command-timeout',
                    `Chromium command timed out: ${method}`
                ));
            }, this.commandTimeoutMilliseconds);
            this.pendingCommands.set(identifier, { method, reject, resolve, timeout });
        });
        this.socket.send(JSON.stringify({ id: identifier, method, params: parameters }));
        return commandPromise;
    }

    handleClose() {
        for (const pendingCommand of this.pendingCommands.values()) {
            clearTimeout(pendingCommand.timeout);
            pendingCommand.reject(new ValidationError(
                'debug-connection-closed',
                `Chromium connection closed during: ${pendingCommand.method}`
            ));
        }
        this.pendingCommands.clear();
    }

    handleMessage(event) {
        let message;
        try {
            message = JSON.parse(String(event.data));
        } catch {
            return;
        }
        if (!message.id) {
            return;
        }
        const pendingCommand = this.pendingCommands.get(message.id);
        if (!pendingCommand) {
            return;
        }
        this.pendingCommands.delete(message.id);
        clearTimeout(pendingCommand.timeout);
        if (message.error) {
            pendingCommand.reject(new ValidationError(
                'debug-command-failed',
                `Chromium command failed: ${pendingCommand.method}`,
                message.error
            ));
            return;
        }
        pendingCommand.resolve(message.result);
    }
}

function parsePositiveInteger(value, optionName) {
    const parsedValue = Number(value);
    if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
        throw new ValidationError('configuration-invalid', `${optionName} is invalid`);
    }
    return parsedValue;
}

function parseConfiguration(argumentsList) {
    const configuration = {
        debugURL: DEFAULT_DEBUG_URL,
        frontendURL: DEFAULT_FRONTEND_URL,
        mediaURL: null,
        timeoutMilliseconds: DEFAULT_TIMEOUT_MILLISECONDS
    };
    for (let argumentIndex = 0; argumentIndex < argumentsList.length; argumentIndex += 1) {
        const option = argumentsList[argumentIndex];
        if (option === '--help') {
            return { help: true };
        }
        const value = argumentsList[argumentIndex + 1];
        if (typeof value !== 'string') {
            throw new ValidationError('configuration-invalid', `${option} requires a value`);
        }
        argumentIndex += 1;
        switch (option) {
            case '--debug-url':
                configuration.debugURL = value;
                break;
            case '--frontend-url':
                configuration.frontendURL = value;
                break;
            case '--media-url':
                configuration.mediaURL = value;
                break;
            case '--timeout-ms':
                configuration.timeoutMilliseconds = parsePositiveInteger(value, option);
                break;
            default:
                throw new ValidationError('configuration-invalid', `Unknown option: ${option}`);
        }
    }
    if (!configuration.mediaURL) {
        throw new ValidationError('configuration-invalid', '--media-url is required');
    }
    const frontendURL = new URL(configuration.frontendURL);
    const mediaURL = new URL(configuration.mediaURL);
    if (frontendURL.origin !== mediaURL.origin) {
        throw new ValidationError(
            'configuration-invalid',
            'The fixture must share the frontend origin'
        );
    }
    return {
        ...configuration,
        debugURL: new URL(configuration.debugURL).href.replace(/\/$/u, ''),
        frontendURL: frontendURL.href,
        mediaURL: mediaURL.href
    };
}

async function getPageTarget(configuration) {
    const targetListURL = new URL('/json/list', `${configuration.debugURL}/`);
    const response = await fetch(targetListURL, {
        signal: AbortSignal.timeout(configuration.timeoutMilliseconds)
    });
    if (!response.ok) {
        throw new ValidationError(
            'debug-target-list-failed',
            'Chromium target discovery failed'
        );
    }
    const targets = await response.json();
    const frontendOrigin = new URL(configuration.frontendURL).origin;
    const pageTarget = Array.isArray(targets) ? targets.find(target => {
        if (target?.type !== 'page' || typeof target.url !== 'string') {
            return false;
        }
        try {
            return new URL(target.url).origin === frontendOrigin;
        } catch {
            return false;
        }
    }) : null;
    if (!pageTarget || typeof pageTarget.webSocketDebuggerUrl !== 'string') {
        throw new ValidationError(
            'debug-page-missing',
            'No frontend Chromium page target is available'
        );
    }
    return pageTarget;
}

function createWorkerValidationExpression(configuration) {
    const frontendURL = new URL(configuration.frontendURL);
    const workerURL = new URL('CustomDecode.worker.bundle.js', frontendURL).href;
    const parserURL = new URL(
        'libraries/libdovi/dovi-rpu-parser.wasm',
        frontendURL
    ).href;
    return `(async () => {
        const generation = 1;
        const worker = new Worker(${JSON.stringify(workerURL)});
        const result = {
            ended: false,
            error: null,
            frame: null,
            progressPacketCount: 0,
            ready: null,
            stopped: false
        };
        let settled = false;
        let stopSent = false;
        return await new Promise(resolve => {
            const finish = () => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                worker.terminate();
                resolve(result);
            };
            const timeout = setTimeout(() => {
                result.error ??= {
                    failureKind: 'timeout',
                    message: 'The Dolby Vision worker smoke timed out'
                };
                finish();
            }, ${JSON.stringify(configuration.timeoutMilliseconds)});
            worker.addEventListener('error', event => {
                result.error = {
                    failureKind: 'worker-error',
                    message: String(event.message || 'Unknown worker error')
                };
                finish();
            });
            worker.addEventListener('message', event => {
                const message = event.data;
                if (!message || message.generation !== generation) {
                    return;
                }
                switch (message.type) {
                    case 'ready':
                        result.ready = {
                            audio: message.audio,
                            codec: message.codec,
                            codedHeight: message.codedHeight,
                            codedWidth: message.codedWidth,
                            displayHeight: message.displayHeight,
                            displayWidth: message.displayWidth
                        };
                        break;
                    case 'progress':
                        result.progressPacketCount = Math.max(
                            result.progressPacketCount,
                            Number(message.packetCount) || 0
                        );
                        break;
                    case 'frame': {
                        if (result.frame) {
                            break;
                        }
                        const baseFrame = message.frame;
                        const enhancementFrame = message.enhancementFrame;
                        const metadata = message.encodedDolbyVisionMetadata;
                        const baseEndOffset = Math.max(
                            ...baseFrame.planes.map(plane => (
                                plane.byteOffset + plane.byteLength
                            ))
                        );
                        const enhancementStartOffset = enhancementFrame ? Math.min(
                            ...enhancementFrame.planes.map(plane => plane.byteOffset)
                        ) : null;
                        result.frame = {
                            baseBitDepth: baseFrame.bitDepth,
                            baseCodedHeight: baseFrame.codedHeight,
                            baseCodedWidth: baseFrame.codedWidth,
                            baseEndOffset,
                            baseFormat: baseFrame.format,
                            bufferByteLength: baseFrame.data.byteLength,
                            durationMicroseconds: message.durationMicroseconds,
                            enhancementBitDepth: enhancementFrame?.bitDepth ?? null,
                            enhancementCodedHeight: enhancementFrame?.codedHeight ?? null,
                            enhancementCodedWidth: enhancementFrame?.codedWidth ?? null,
                            enhancementDisposition:
                                metadata?.enhancementLayerDisposition ?? null,
                            enhancementFormat: enhancementFrame?.format ?? null,
                            enhancementStartOffset,
                            hasEnhancementLayerVCL:
                                metadata?.hasEnhancementLayerVCL ?? null,
                            mediaTimeMicroseconds: message.mediaTimeMicroseconds,
                            parsedRPUByteLengths: Array.isArray(metadata?.parsedRPUData)
                                ? metadata.parsedRPUData.map(data => data.byteLength)
                                : [],
                            sameBuffer: enhancementFrame?.data === baseFrame.data,
                            schemaVersion: metadata?.schemaVersion ?? null,
                            timestampDeltaMicroseconds: enhancementFrame
                                ? enhancementFrame.timestampMicroseconds
                                    - baseFrame.timestampMicroseconds
                                : null
                        };
                        worker.postMessage({
                            buffer: baseFrame.data,
                            generation,
                            type: 'recycle-frame'
                        }, [ baseFrame.data ]);
                        if (!stopSent) {
                            stopSent = true;
                            worker.postMessage({ generation, type: 'stop' });
                        }
                        break;
                    }
                    case 'ended':
                        result.ended = true;
                        break;
                    case 'error':
                        result.error = {
                            failureKind: message.failureKind,
                            message: message.message
                        };
                        break;
                    case 'stopped':
                        result.stopped = true;
                        finish();
                        break;
                }
            });
            worker.postMessage({
                audioSampleCredits: 0,
                audioTrackIndex: null,
                dolbyVisionRPUParserWASMURL: ${JSON.stringify(parserURL)},
                frameCredits: 2,
                generation,
                maximumCodedHeight: ${EXPECTED_BASE_HEIGHT},
                maximumCodedWidth: ${EXPECTED_BASE_WIDTH},
                rawVideoFrameFormat: 'I420P10',
                startTimeMicroseconds: 0,
                type: 'start',
                url: ${JSON.stringify(configuration.mediaURL)},
                videoDecoderBackend: 'bundled-hevc',
                videoOutputMode: 'raw-planes',
                videoTrackIndex: 0
            });
        });
    })()`;
}

function validateResult(result) {
    const failures = [];
    const addFailure = (condition, code) => {
        if (!condition) {
            failures.push(code);
        }
    };
    addFailure(result?.error === null, 'worker-error');
    addFailure(result?.stopped === true, 'worker-stop-missing');
    addFailure(result?.ready?.audio === null, 'unexpected-audio-route');
    addFailure(result?.ready?.codedWidth === EXPECTED_BASE_WIDTH, 'base-ready-width-invalid');
    addFailure(result?.ready?.codedHeight === EXPECTED_BASE_HEIGHT, 'base-ready-height-invalid');
    const frame = result?.frame;
    addFailure(frame !== null && typeof frame === 'object', 'decoded-frame-missing');
    addFailure(frame?.baseFormat === 'I420P10', 'base-format-invalid');
    addFailure(frame?.baseBitDepth === 10, 'base-bit-depth-invalid');
    addFailure(frame?.baseCodedWidth === EXPECTED_BASE_WIDTH, 'base-width-invalid');
    addFailure(frame?.baseCodedHeight === EXPECTED_BASE_HEIGHT, 'base-height-invalid');
    addFailure(frame?.enhancementFormat === 'I420P10', 'enhancement-format-invalid');
    addFailure(frame?.enhancementBitDepth === 10, 'enhancement-bit-depth-invalid');
    addFailure(
        frame?.enhancementCodedWidth === EXPECTED_ENHANCEMENT_WIDTH,
        'enhancement-width-invalid'
    );
    addFailure(
        frame?.enhancementCodedHeight === EXPECTED_ENHANCEMENT_HEIGHT,
        'enhancement-height-invalid'
    );
    addFailure(frame?.sameBuffer === true, 'compound-buffer-not-shared');
    addFailure(
        Number.isSafeInteger(frame?.enhancementStartOffset)
            && frame.enhancementStartOffset >= frame.baseEndOffset,
        'compound-buffer-overlap'
    );
    addFailure(
        Number.isSafeInteger(frame?.bufferByteLength)
            && frame.bufferByteLength > frame.enhancementStartOffset,
        'compound-buffer-length-invalid'
    );
    addFailure(
        Number.isSafeInteger(frame?.timestampDeltaMicroseconds)
            && Math.abs(frame.timestampDeltaMicroseconds) <= 1,
        'compound-timestamp-mismatch'
    );
    addFailure(frame?.enhancementDisposition === 'decoded-fel', 'fel-disposition-invalid');
    addFailure(frame?.hasEnhancementLayerVCL === true, 'enhancement-vcl-missing');
    addFailure(
        frame?.schemaVersion === EXPECTED_METADATA_SCHEMA_VERSION,
        'metadata-schema-invalid'
    );
    addFailure(
        Array.isArray(frame?.parsedRPUByteLengths)
            && frame.parsedRPUByteLengths.length === 1
            && Number.isSafeInteger(frame.parsedRPUByteLengths[0])
            && frame.parsedRPUByteLengths[0] > 0,
        'rpu-metadata-invalid'
    );
    return failures;
}

async function main() {
    const configuration = parseConfiguration(process.argv.slice(2));
    if (configuration.help) {
        process.stdout.write(`${USAGE}\n`);
        return;
    }
    const pageTarget = await getPageTarget(configuration);
    const client = await CDPClient.connect(
        pageTarget.webSocketDebuggerUrl,
        configuration.timeoutMilliseconds
    );
    try {
        const evaluation = await client.send('Runtime.evaluate', {
            awaitPromise: true,
            expression: createWorkerValidationExpression(configuration),
            returnByValue: true
        });
        if (evaluation.exceptionDetails) {
            throw new ValidationError(
                'page-evaluation-failed',
                'The browser worker validation threw',
                evaluation.exceptionDetails
            );
        }
        const result = evaluation.result?.value;
        const failures = validateResult(result);
        const report = {
            failures,
            result,
            schemaVersion: 1,
            status: failures.length === 0 ? 'passed' : 'failed'
        };
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        if (failures.length > 0) {
            process.exitCode = 1;
        }
    } finally {
        client.close();
    }
}

try {
    await main();
} catch (error) {
    const report = {
        error: {
            code: error instanceof ValidationError ? error.code : 'unexpected-error',
            diagnostics: error instanceof ValidationError ? error.diagnostics : null,
            message: error instanceof Error ? error.message : String(error)
        },
        schemaVersion: 1,
        status: 'failed'
    };
    process.stderr.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = 1;
}

/* eslint-enable compat/compat */
