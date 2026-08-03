/* eslint-disable compat/compat -- This local probe targets Node 24 and current Chromium */

import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const COMMAND_TIMEOUT_MILLISECONDS = 30_000;
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const SCRIPT_PATH = fileURLToPath(new URL('emit_dynamic_HDR_shader.ts', import.meta.url));
const VITE_NODE_PATH = fileURLToPath(new URL(
    '../../node_modules/vite-node/vite-node.mjs',
    import.meta.url
));
const debugURL = process.argv[2] || 'http://localhost:9224';

class CDPClient {
    constructor(socket) {
        this.nextIdentifier = 1;
        this.pendingCommands = new Map();
        this.socket = socket;
        socket.addEventListener('message', event => this.handleMessage(event));
        socket.addEventListener('close', () => this.handleClose());
    }

    static async connect(webSocketURL) {
        const socket = new WebSocket(webSocketURL);
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(
                () => reject(new Error('CDP connection timed out')),
                COMMAND_TIMEOUT_MILLISECONDS
            );
            socket.addEventListener('open', () => {
                clearTimeout(timeout);
                resolve();
            }, { once: true });
            socket.addEventListener('error', () => {
                clearTimeout(timeout);
                reject(new Error('CDP connection failed'));
            }, { once: true });
        });
        return new CDPClient(socket);
    }

    close() {
        this.socket.close();
    }

    send(method, parameters = {}) {
        const identifier = this.nextIdentifier;
        this.nextIdentifier += 1;
        const result = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingCommands.delete(identifier);
                reject(new Error(`CDP command timed out: ${method}`));
            }, COMMAND_TIMEOUT_MILLISECONDS);
            this.pendingCommands.set(identifier, { method, reject, resolve, timeout });
        });
        this.socket.send(JSON.stringify({ id: identifier, method, params: parameters }));
        return result;
    }

    handleClose() {
        for (const pendingCommand of this.pendingCommands.values()) {
            clearTimeout(pendingCommand.timeout);
            pendingCommand.reject(new Error(
                `CDP connection closed during: ${pendingCommand.method}`
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
            pendingCommand.reject(new Error(
                `CDP command failed: ${pendingCommand.method}: ${message.error.message}`
            ));
            return;
        }
        pendingCommand.resolve(message.result);
    }
}

async function readJSON(path) {
    const endpoint = new URL(path, `${debugURL.replace(/\/$/u, '')}/`);
    const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(COMMAND_TIMEOUT_MILLISECONDS)
    });
    if (!response.ok) {
        throw new Error(`Browser debugging endpoint returned ${response.status}`);
    }
    return response.json();
}

function emitProductionShader() {
    return JSON.parse(execFileSync(
        process.execPath,
        [ VITE_NODE_PATH, SCRIPT_PATH ],
        {
            cwd: REPOSITORY_ROOT,
            encoding: 'utf8',
            timeout: COMMAND_TIMEOUT_MILLISECONDS
        }
    ));
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
}

function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
    });
}

const shaderRecord = emitProductionShader();
const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>WebGPU dynamic HDR shader probe</title>');
});
await listen(server);
const address = server.address();
if (!address || typeof address === 'string') {
    throw new Error('The local probe server did not expose a TCP port');
}

let client = null;
try {
    const targets = await readJSON('/json/list');
    const pageTarget = targets.find(target => target.type === 'page');
    if (!pageTarget?.webSocketDebuggerUrl) {
        throw new Error('No debuggable browser page is available');
    }
    client = await CDPClient.connect(pageTarget.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Page.navigate', {
        url: `http://localhost:${address.port}/`
    });
    await new Promise(resolve => setTimeout(resolve, 250));

    const expression = `(async () => {
        const withTimeout = (promise, operation) => Promise.race([
            promise,
            new Promise((_, reject) => setTimeout(
                () => reject(new Error(operation + ' timed out')),
                10000
            ))
        ]);
        const report = {
            route: ${JSON.stringify(shaderRecord.route)},
            schemaVersion: 1,
            status: 'rejected'
        };
        let device = null;
        try {
            if (!isSecureContext || !navigator.gpu) {
                throw new Error('WebGPU is unavailable in a secure context');
            }
            const adapter = await withTimeout(
                navigator.gpu.requestAdapter(),
                'WebGPU adapter request'
            );
            if (!adapter) {
                throw new Error('A WebGPU adapter is unavailable');
            }
            device = await withTimeout(
                adapter.requestDevice(),
                'WebGPU device request'
            );
            const shaderModule = device.createShaderModule({
                code: ${JSON.stringify(shaderRecord.shaderCode)}
            });
            const compilationInfo = await withTimeout(
                shaderModule.getCompilationInfo(),
                'WGSL compilation'
            );
            report.compilationMessages = compilationInfo.messages.map(message => ({
                lineNumber: message.lineNum,
                message: message.message,
                type: message.type
            }));
            const compilationErrors = report.compilationMessages.filter(
                message => message.type === 'error'
            );
            device.pushErrorScope('validation');
            let pipelineError = null;
            try {
                await withTimeout(device.createRenderPipelineAsync({
                    fragment: {
                        entryPoint: 'fragmentMain',
                        module: shaderModule,
                        targets: [ { format: navigator.gpu.getPreferredCanvasFormat() } ]
                    },
                    layout: 'auto',
                    primitive: { topology: 'triangle-list' },
                    vertex: { entryPoint: 'vertexMain', module: shaderModule }
                }), 'WebGPU pipeline creation');
            } catch (error) {
                pipelineError = error instanceof Error ? error.message : String(error);
            }
            const validationError = await device.popErrorScope();
            report.adapter = {
                architecture: adapter.info?.architecture || 'not-exposed',
                device: adapter.info?.device || 'not-exposed',
                vendor: adapter.info?.vendor || 'not-exposed'
            };
            report.error = pipelineError || validationError?.message || null;
            report.status = compilationErrors.length === 0 && !report.error
                ? 'compiled'
                : 'rejected';
        } catch (error) {
            report.error = error instanceof Error ? error.message : String(error);
        } finally {
            device?.destroy();
        }
        return report;
    })()`;
    const evaluation = await client.send('Runtime.evaluate', {
        awaitPromise: true,
        expression,
        returnByValue: true
    });
    if (evaluation.exceptionDetails || !evaluation.result?.value) {
        throw new Error('The browser failed to evaluate the dynamic HDR shader probe');
    }
    process.stdout.write(`${JSON.stringify(evaluation.result.value, null, 2)}\n`);
    if (evaluation.result.value.status !== 'compiled') {
        process.exitCode = 1;
    }
} finally {
    client?.close();
    server.closeAllConnections();
    await closeServer(server);
}

/* eslint-enable compat/compat */
