/* eslint-disable compat/compat -- This Node.js diagnostic targets Node 24 and a current browser */

const DEFAULT_DEBUGGING_URL = 'http://localhost:9224';
const DEFAULT_TARGET_URL = 'http://localhost:8080';

const debuggingURL = process.argv[2] || DEFAULT_DEBUGGING_URL;
const targetURL = process.argv[3] || DEFAULT_TARGET_URL;
const targets = await fetch(`${debuggingURL}/json/list`).then(response => response.json());
const pageTarget = targets.find(target => target.type === 'page');
if (!pageTarget?.webSocketDebuggerUrl) {
    throw new Error('No debuggable browser page is available');
}

const socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
const pendingCommands = new Map();
let nextCommandIdentifier = 1;

socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) {
        return;
    }
    const pendingCommand = pendingCommands.get(message.id);
    if (!pendingCommand) {
        return;
    }
    pendingCommands.delete(message.id);
    if (message.error) {
        pendingCommand.reject(new Error(message.error.message));
    } else {
        pendingCommand.resolve(message.result);
    }
});

await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
});

function sendCommand(method, params = {}) {
    const identifier = nextCommandIdentifier;
    nextCommandIdentifier += 1;
    const promise = new Promise((resolve, reject) => {
        pendingCommands.set(identifier, { reject, resolve });
    });
    socket.send(JSON.stringify({ id: identifier, method, params }));
    return promise;
}

await sendCommand('Page.enable');
await sendCommand('Page.navigate', { url: targetURL });
await new Promise(resolve => setTimeout(resolve, 1_000));

const expression = String.raw`(async () => {
    const videoConfigurations = {
        av1: { codec: 'av01.0.08M.08', codedHeight: 1080, codedWidth: 1920 },
        av1Main4K8: {
            codec: 'av01.0.12M.08',
            codedHeight: 2160,
            codedWidth: 3840,
            hardwareAcceleration: 'no-preference'
        },
        av1Main10: {
            codec: 'av01.0.08M.10',
            codedHeight: 2160,
            codedWidth: 3840,
            hardwareAcceleration: 'no-preference'
        },
        av1Main10Software: {
            codec: 'av01.0.08M.10',
            codedHeight: 2160,
            codedWidth: 3840,
            hardwareAcceleration: 'prefer-software'
        },
        h264Baseline: { codec: 'avc1.420028', codedHeight: 1080, codedWidth: 1920 },
        h264ConstrainedBaseline: {
            codec: 'avc1.42e028',
            codedHeight: 1080,
            codedWidth: 1920
        },
        h264High: { codec: 'avc1.640028', codedHeight: 1080, codedWidth: 1920 },
        h264Main: { codec: 'avc1.4d0028', codedHeight: 1080, codedWidth: 1920 },
        hev1Main10: { codec: 'hev1.2.4.H153.90', codedHeight: 2160, codedWidth: 3840 },
        hevcMain: { codec: 'hvc1.1.6.L120.B0', codedHeight: 1080, codedWidth: 1920 },
        hevcMain4K: {
            codec: 'hvc1.1.6.L153.B0',
            codedHeight: 2160,
            codedWidth: 3840,
            hardwareAcceleration: 'no-preference'
        },
        hevcMain10: { codec: 'hvc1.2.4.L153.B0', codedHeight: 2160, codedWidth: 3840 },
        hevcMain10Software: {
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 2160,
            codedWidth: 3840,
            hardwareAcceleration: 'prefer-software'
        },
        prores422HQ: { codec: 'apch', codedHeight: 1080, codedWidth: 1920 },
        vp8: { codec: 'vp8', codedHeight: 1080, codedWidth: 1920 },
        vp9: { codec: 'vp09.00.10.08', codedHeight: 1080, codedWidth: 1920 },
        vp9Profile0UltraHD: {
            codec: 'vp09.00.51.08',
            codedHeight: 2160,
            codedWidth: 3840,
            hardwareAcceleration: 'no-preference'
        },
        vp9Profile2: { codec: 'vp09.02.10.10', codedHeight: 2160, codedWidth: 3840 },
        vp9Profile2Software: {
            codec: 'vp09.02.10.10',
            codedHeight: 2160,
            codedWidth: 3840,
            hardwareAcceleration: 'prefer-software'
        }
    };
    const audioConfigurations = {
        aac: { codec: 'mp4a.40.2', numberOfChannels: 2, sampleRate: 48000 },
        ac3Stereo: { codec: 'ac-3', numberOfChannels: 2, sampleRate: 48000 },
        ac3Surround: { codec: 'ac-3', numberOfChannels: 6, sampleRate: 48000 },
        eac3Stereo: { codec: 'ec-3', numberOfChannels: 2, sampleRate: 48000 },
        eac3Surround: { codec: 'ec-3', numberOfChannels: 6, sampleRate: 48000 },
        flac: {
            codec: 'flac',
            description: new Uint8Array(34),
            numberOfChannels: 2,
            sampleRate: 48000
        },
        mp3: { codec: 'mp3', numberOfChannels: 2, sampleRate: 48000 },
        opus: { codec: 'opus', numberOfChannels: 2, sampleRate: 48000 },
        vorbis: {
            codec: 'vorbis',
            description: new Uint8Array([0]),
            numberOfChannels: 2,
            sampleRate: 48000
        }
    };
    const probe = async (decoder, configurations) => {
        const results = {};
        for (const [name, configuration] of Object.entries(configurations)) {
            try {
                const support = await decoder.isConfigSupported(configuration);
                results[name] = { codec: support.config.codec, supported: support.supported === true };
            } catch (error) {
                results[name] = { error: String(error), supported: false };
            }
        }
        return results;
    };
    let gpu = null;
    if (navigator.gpu) {
        const adapter = await navigator.gpu.requestAdapter();
        if (adapter) {
            gpu = {
                architecture: adapter.info?.architecture || '',
                description: adapter.info?.description || '',
                device: adapter.info?.device || '',
                features: Array.from(adapter.features).sort(),
                vendor: adapter.info?.vendor || ''
            };
        }
    }
    return {
        audio: typeof AudioDecoder === 'function' ?
            await probe(AudioDecoder, audioConfigurations) : null,
        gpu,
        runtime: {
            audioData: typeof AudioData === 'function',
            audioDecoder: typeof AudioDecoder === 'function',
            audioWorkletNode: typeof AudioWorkletNode === 'function',
            secureContext: isSecureContext,
            videoDecoder: typeof VideoDecoder === 'function',
            videoFrame: typeof VideoFrame === 'function',
            webGPU: Boolean(navigator.gpu)
        },
        diagnosticScope: {
            decodedOutputQualified: false,
            note: 'Configuration support only; use production capability telemetry and playback smoke for exact decoded-output qualification'
        },
        userAgent: navigator.userAgent,
        video: typeof VideoDecoder === 'function' ?
            await probe(VideoDecoder, videoConfigurations) : null
    };
})()`;

const evaluation = await sendCommand('Runtime.evaluate', {
    awaitPromise: true,
    expression,
    returnByValue: true
});
socket.close();
if (evaluation.exceptionDetails) {
    throw new Error(evaluation.exceptionDetails.text);
}
process.stdout.write(`${JSON.stringify(evaluation.result.value, null, 2)}\n`);

/* eslint-enable compat/compat */
