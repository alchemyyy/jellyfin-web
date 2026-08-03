/* eslint-disable compat/compat -- This local diagnostic targets Node 24 and current Chromium browsers */

const COMMAND_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_DEBUG_URL = 'http://localhost:9224';
const DEFAULT_FRONTEND_URL = 'http://localhost:8096/web/';
const PAGE_SETTLE_MILLISECONDS = 1_000;

const debugURL = process.argv[2] || DEFAULT_DEBUG_URL;
const frontendURL = process.argv[3] || DEFAULT_FRONTEND_URL;

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
                `CDP command failed: ${pendingCommand.method}`
            ));
            return;
        }
        pendingCommand.resolve(message.result);
    }
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
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

const browserVersionEndpoint = await readJSON('/json/version');
const targets = await readJSON('/json/list');
const pageTarget = targets.find(target => target.type === 'page');
if (!pageTarget?.webSocketDebuggerUrl
    || typeof browserVersionEndpoint.webSocketDebuggerUrl !== 'string') {
    throw new Error('No debuggable browser page is available');
}

const browserClient = await CDPClient.connect(browserVersionEndpoint.webSocketDebuggerUrl);
const pageClient = await CDPClient.connect(pageTarget.webSocketDebuggerUrl);

let report;
try {
    const [ browserVersion, systemInformation ] = await Promise.all([
        browserClient.send('Browser.getVersion'),
        browserClient.send('SystemInfo.getInfo')
    ]);
    await pageClient.send('Page.enable');
    await pageClient.send('Page.navigate', { url: frontendURL });
    await sleep(PAGE_SETTLE_MILLISECONDS);

    const expression = String.raw`(async () => {
        const copyLimits = limits => {
            const names = new Set();
            let current = limits;
            while (current && current !== Object.prototype) {
                for (const name of Object.getOwnPropertyNames(current)) {
                    names.add(name);
                }
                current = Object.getPrototypeOf(current);
            }
            const result = {};
            for (const name of Array.from(names).sort()) {
                if (name === 'constructor') {
                    continue;
                }
                try {
                    const value = limits[name];
                    if (typeof value === 'number' && Number.isFinite(value)) {
                        result[name] = value;
                    }
                } catch {
                    // Ignore implementation-specific throwing accessors
                }
            }
            return result;
        };
        const videoConfigurations = {
            av1Main1080p8: { codec: 'av01.0.08M.08', codedHeight: 1080, codedWidth: 1920 },
            av1Main4K10: { codec: 'av01.0.12M.10', codedHeight: 2160, codedWidth: 3840 },
            h264Baseline1080p: { codec: 'avc1.420028', codedHeight: 1080, codedWidth: 1920 },
            h264High1080p: { codec: 'avc1.640028', codedHeight: 1080, codedWidth: 1920 },
            h264Main1080p: { codec: 'avc1.4d0028', codedHeight: 1080, codedWidth: 1920 },
            hevcMain1080p: { codec: 'hvc1.1.6.L120.B0', codedHeight: 1080, codedWidth: 1920 },
            hevcMain10HighTier4K: {
                codec: 'hvc1.2.4.H153.B0',
                codedHeight: 2160,
                codedWidth: 3840
            },
            vp8_1080p: { codec: 'vp8', codedHeight: 1080, codedWidth: 1920 },
            vp9Profile0_4K: { codec: 'vp09.00.51.08', codedHeight: 2160, codedWidth: 3840 },
            vp9Profile2_4K: { codec: 'vp09.02.51.10', codedHeight: 2160, codedWidth: 3840 }
        };
        const audioConfigurations = {
            aacStereo: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000 },
            aac5_1: { codec: 'mp4a.40.2', numberOfChannels: 6, sampleRate: 48000 },
            aac7_1: { codec: 'mp4a.40.2', numberOfChannels: 8, sampleRate: 48000 },
            ac3Stereo: { codec: 'ac-3', numberOfChannels: 2, sampleRate: 48000 },
            ac3_5_1: { codec: 'ac-3', numberOfChannels: 6, sampleRate: 48000 },
            eac3Stereo: { codec: 'ec-3', numberOfChannels: 2, sampleRate: 48000 },
            eac3_5_1: { codec: 'ec-3', numberOfChannels: 6, sampleRate: 48000 },
            eac3_7_1: { codec: 'ec-3', numberOfChannels: 8, sampleRate: 48000 },
            flacStereo: { codec: 'flac', numberOfChannels: 2, sampleRate: 48000 },
            flac5_1: { codec: 'flac', numberOfChannels: 6, sampleRate: 48000 },
            flac7_1: { codec: 'flac', numberOfChannels: 8, sampleRate: 48000 },
            mp3Stereo: { codec: 'mp3', numberOfChannels: 2, sampleRate: 48000 },
            opusStereo: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 },
            opus5_1: { codec: 'opus', numberOfChannels: 6, sampleRate: 48000 },
            opus7_1: { codec: 'opus', numberOfChannels: 8, sampleRate: 48000 },
            vorbisStereo: { codec: 'vorbis', numberOfChannels: 2, sampleRate: 48000 }
        };
        const probeConfigurations = async (decoder, configurations) => {
            const results = {};
            for (const [name, configuration] of Object.entries(configurations)) {
                try {
                    const support = await decoder.isConfigSupported(configuration);
                    results[name] = {
                        codec: support.config.codec,
                        supported: support.supported === true
                    };
                } catch (error) {
                    results[name] = {
                        errorName: error instanceof Error ? error.name : 'Error',
                        supported: false
                    };
                }
            }
            return results;
        };

        let adapterRecord = null;
        let deviceRecord = null;
        if (navigator.gpu) {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
                const adapterInfo = adapter.info ?? {};
                adapterRecord = {
                    architecture: adapterInfo.architecture || 'not-exposed',
                    description: adapterInfo.description || 'not-exposed',
                    device: adapterInfo.device || 'not-exposed',
                    features: Array.from(adapter.features).sort(),
                    isFallbackAdapter: adapterInfo.isFallbackAdapter === true,
                    limits: copyLimits(adapter.limits),
                    vendor: adapterInfo.vendor || 'not-exposed'
                };
                try {
                    const device = await adapter.requestDevice();
                    deviceRecord = {
                        features: Array.from(device.features).sort(),
                        limits: copyLimits(device.limits)
                    };
                    device.destroy();
                } catch (error) {
                    deviceRecord = {
                        errorName: error instanceof Error ? error.name : 'Error',
                        features: [],
                        limits: {}
                    };
                }
            }
        }
        return {
            codecs: {
                audio: typeof AudioDecoder === 'function'
                    ? await probeConfigurations(AudioDecoder, audioConfigurations)
                    : null,
                scope: 'configuration-support-only',
                video: typeof VideoDecoder === 'function'
                    ? await probeConfigurations(VideoDecoder, videoConfigurations)
                    : null
            },
            gpu: {
                adapter: adapterRecord,
                canvasFormat: navigator.gpu?.getPreferredCanvasFormat?.() ?? 'unavailable',
                device: deviceRecord
            },
            runtime: {
                audioData: typeof AudioData === 'function',
                audioDecoder: typeof AudioDecoder === 'function',
                audioWorkletNode: typeof AudioWorkletNode === 'function',
                secureContext: isSecureContext,
                videoDecoder: typeof VideoDecoder === 'function',
                videoFrame: typeof VideoFrame === 'function',
                webGPU: Boolean(navigator.gpu)
            },
            userAgent: navigator.userAgent || 'unknown'
        };
    })()`;
    const evaluation = await pageClient.send('Runtime.evaluate', {
        awaitPromise: true,
        expression,
        returnByValue: true
    });
    if (evaluation.exceptionDetails || !evaluation.result?.value) {
        throw new Error('Browser runtime probe evaluation failed');
    }
    const pageEvidence = evaluation.result.value;
    const GPUInformation = systemInformation?.gpu ?? {};
    const adapterAvailable = pageEvidence.gpu?.adapter !== null;
    report = {
        browser: {
            product: browserVersion.product || browserVersionEndpoint.Browser || 'unknown',
            protocolVersion: browserVersion.protocolVersion || 'unknown',
            revision: browserVersion.revision || 'unknown',
            userAgent: pageEvidence.userAgent
        },
        codecs: pageEvidence.codecs,
        gpu: {
            ...pageEvidence.gpu,
            CDP: {
                auxiliaryAttributes: GPUInformation.auxAttributes ?? {},
                devices: Array.isArray(GPUInformation.devices) ? GPUInformation.devices : [],
                driverBugWorkarounds: Array.isArray(GPUInformation.driverBugWorkarounds) ?
                    [ ...GPUInformation.driverBugWorkarounds ].sort() :
                    [],
                featureStatus: GPUInformation.featureStatus ?? {}
            }
        },
        runtime: pageEvidence.runtime,
        schemaVersion: 1,
        status: adapterAvailable ? 'ready' : 'unsupported'
    };
} finally {
    pageClient.close();
    browserClient.close();
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

/* eslint-enable compat/compat */
