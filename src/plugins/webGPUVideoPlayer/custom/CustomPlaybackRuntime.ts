export type CustomPlaybackRuntimeFailureReason =
    | 'animation-frame-unavailable'
    | 'audio-context-unavailable'
    | 'audio-data-unavailable'
    | 'audio-decoder-unavailable'
    | 'audio-worklet-unavailable'
    | 'insecure-context'
    | 'video-decoder-unavailable'
    | 'video-frame-unavailable'
    | 'webgpu-unavailable'
    | 'worker-unavailable';

export type CustomPlaybackRuntimeEnvironment = {
    animationFrame: boolean
    audioContext: boolean
    audioData: boolean
    audioDecoder: boolean
    audioWorklet: boolean
    secureContext: boolean
    videoDecoder: boolean
    videoFrame: boolean
    webGPU: boolean
    worker: boolean
};

export type CustomPlaybackRuntimeAvailability = {
    available: boolean
    environment: Readonly<CustomPlaybackRuntimeEnvironment>
    reason: CustomPlaybackRuntimeFailureReason | null
};

type WebkitAudioContextGlobal = typeof globalThis & {
    webkitAudioContext?: typeof AudioContext
};

function getDefaultEnvironment(): CustomPlaybackRuntimeEnvironment {
    const runtimeGlobal = globalThis as WebkitAudioContextGlobal;
    return {
        animationFrame: typeof runtimeGlobal.requestAnimationFrame === 'function'
            && typeof runtimeGlobal.cancelAnimationFrame === 'function',
        audioContext: typeof runtimeGlobal.AudioContext === 'function'
            || typeof runtimeGlobal.webkitAudioContext === 'function',
        audioData: typeof runtimeGlobal.AudioData === 'function',
        audioDecoder: typeof runtimeGlobal.AudioDecoder === 'function',
        audioWorklet: typeof runtimeGlobal.AudioWorkletNode === 'function',
        secureContext: runtimeGlobal.isSecureContext === true,
        videoDecoder: typeof runtimeGlobal.VideoDecoder === 'function',
        videoFrame: typeof runtimeGlobal.VideoFrame === 'function',
        webGPU: Boolean(runtimeGlobal.navigator?.gpu),
        worker: typeof runtimeGlobal.Worker === 'function'
    };
}

function getFailureReason(
    environment: CustomPlaybackRuntimeEnvironment
): CustomPlaybackRuntimeFailureReason | null {
    if (!environment.secureContext) return 'insecure-context';
    if (!environment.animationFrame) return 'animation-frame-unavailable';
    if (!environment.worker) return 'worker-unavailable';
    if (!environment.webGPU) return 'webgpu-unavailable';
    if (!environment.videoDecoder) return 'video-decoder-unavailable';
    if (!environment.videoFrame) return 'video-frame-unavailable';
    if (!environment.audioDecoder) return 'audio-decoder-unavailable';
    if (!environment.audioData) return 'audio-data-unavailable';
    if (!environment.audioContext) return 'audio-context-unavailable';
    if (!environment.audioWorklet) return 'audio-worklet-unavailable';
    return null;
}

/** Reports whether every mandatory custom A/V playback primitive is present. */
export function getCustomPlaybackRuntimeAvailability(
    environment: CustomPlaybackRuntimeEnvironment = getDefaultEnvironment()
): CustomPlaybackRuntimeAvailability {
    const environmentSnapshot = Object.freeze({ ...environment });
    const reason = getFailureReason(environmentSnapshot);
    return Object.freeze({
        available: reason === null,
        environment: environmentSnapshot,
        reason
    });
}
