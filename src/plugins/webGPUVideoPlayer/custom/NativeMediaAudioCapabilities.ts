import {
    microsecondsToMilliseconds,
    secondsToMicroseconds,
    type Microseconds
} from '../MediaTime';
import {
    createNativeMediaAudioProbeFixture,
    type NativeMediaAudioProbeFixtureChannelCount
} from './NativeMediaAudioCapabilityFixtures';

export const NATIVE_MEDIA_AUDIO_CODECS = [ 'ac3', 'eac3' ] as const;
export const NATIVE_MEDIA_AUDIO_SAMPLE_RATE = 48_000;
export const NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS = [ 2, 6 ] as const;

export type NativeMediaAudioCodec = typeof NATIVE_MEDIA_AUDIO_CODECS[number];
export type NativeMediaAudioChannelCount =
    typeof NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS[number];
export type NativeMediaAudioCapabilityStatus = 'supported' | 'unsupported' | 'unknown';
export type NativeMediaAudioCapabilityReason =
    | 'api-unavailable'
    | 'decoded-playback-advanced'
    | 'fixture-append-failed'
    | 'mime-unsupported'
    | 'playback-failed'
    | 'playback-not-advanced'
    | 'probe-exception'
    | 'probe-timeout';

export type NativeMediaAudioRoute = {
    channelCount: NativeMediaAudioChannelCount
    codec: NativeMediaAudioCodec
    codecString: 'ac-3' | 'ec-3'
    mimeType: string
    sampleRate: typeof NATIVE_MEDIA_AUDIO_SAMPLE_RATE
};

export type NativeMediaAudioLayoutCapability = NativeMediaAudioRoute & {
    reason: NativeMediaAudioCapabilityReason
    status: NativeMediaAudioCapabilityStatus
};

export type NativeMediaAudioCodecCapability = {
    codec: NativeMediaAudioCodec
    codecString: NativeMediaAudioRoute['codecString']
    layouts: Readonly<Record<NativeMediaAudioChannelCount, NativeMediaAudioLayoutCapability>>
    mimeType: string
    status: NativeMediaAudioCapabilityStatus
};

export type NativeMediaAudioCapabilities = {
    audio: Readonly<Record<NativeMediaAudioCodec, NativeMediaAudioCodecCapability>>
    telemetry: Readonly<{
        probeCount: number
        supportedLayoutCount: number
        unknownLayoutCount: number
    }>
};

export type NativeMediaAudioExactProbeRequest = NativeMediaAudioRoute & {
    fixture: Uint8Array
};

export type NativeMediaAudioExactProbeResult = {
    reason: NativeMediaAudioCapabilityReason
    supported: boolean
};

export type NativeMediaAudioCapabilityEnvironment = {
    exactPlaybackProbe?: (
        request: Readonly<NativeMediaAudioExactProbeRequest>
    ) => Promise<NativeMediaAudioExactProbeResult>
    isTypeSupported?: ((mimeType: string) => boolean) | null
};

type NativeMediaAudioDefinition = {
    codec: NativeMediaAudioCodec
    codecString: NativeMediaAudioRoute['codecString']
    mimeType: string
};

const PROBE_TIMEOUT_MICROSECONDS = secondsToMicroseconds(3);
const REQUIRED_PLAYBACK_ADVANCE_MICROSECONDS = secondsToMicroseconds(0.05);
const MP4_AUDIO_MIME_TYPE = 'audio/mp4';
const DEFINITIONS: readonly NativeMediaAudioDefinition[] = [
    { codec: 'ac3', codecString: 'ac-3', mimeType: `${MP4_AUDIO_MIME_TYPE}; codecs="ac-3"` },
    { codec: 'eac3', codecString: 'ec-3', mimeType: `${MP4_AUDIO_MIME_TYPE}; codecs="ec-3"` }
];

function getDefaultIsTypeSupported(): ((mimeType: string) => boolean) | null {
    if (typeof globalThis.MediaSource !== 'function'
        || typeof globalThis.MediaSource.isTypeSupported !== 'function') {
        return null;
    }
    // eslint-disable-next-line compat/compat -- Native MSE audio is capability-gated
    return (mimeType: string): boolean => globalThis.MediaSource.isTypeSupported(mimeType);
}

function waitForSourceOpen(
    mediaSource: MediaSource,
    timeoutMicroseconds: Microseconds
): Promise<boolean> {
    if (mediaSource.readyState === 'open') {
        return Promise.resolve(true);
    }

    return new Promise<boolean>(resolve => {
        const timeout = globalThis.setTimeout((): void => {
            cleanup();
            resolve(false);
        }, microsecondsToMilliseconds(timeoutMicroseconds));
        const onSourceOpen = (): void => {
            cleanup();
            resolve(true);
        };
        const onSourceClose = (): void => {
            cleanup();
            resolve(false);
        };
        const cleanup = (): void => {
            globalThis.clearTimeout(timeout);
            mediaSource.removeEventListener('sourceopen', onSourceOpen);
            mediaSource.removeEventListener('sourceclose', onSourceClose);
        };
        mediaSource.addEventListener('sourceopen', onSourceOpen);
        mediaSource.addEventListener('sourceclose', onSourceClose);
    });
}

function appendFixture(
    sourceBuffer: SourceBuffer,
    fixture: Uint8Array,
    timeoutMicroseconds: Microseconds
): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        const timeout = globalThis.setTimeout((): void => {
            cleanup();
            resolve(false);
        }, microsecondsToMilliseconds(timeoutMicroseconds));
        const onUpdateEnd = (): void => {
            cleanup();
            resolve(true);
        };
        const onError = (): void => {
            cleanup();
            resolve(false);
        };
        const cleanup = (): void => {
            globalThis.clearTimeout(timeout);
            sourceBuffer.removeEventListener('updateend', onUpdateEnd);
            sourceBuffer.removeEventListener('error', onError);
        };
        sourceBuffer.addEventListener('updateend', onUpdateEnd);
        sourceBuffer.addEventListener('error', onError);
        try {
            const fixtureCopy = fixture.slice();
            sourceBuffer.appendBuffer(fixtureCopy.buffer);
        } catch {
            cleanup();
            resolve(false);
        }
    });
}

function waitForPlaybackAdvance(
    audioElement: HTMLAudioElement,
    timeoutMicroseconds: Microseconds
): Promise<boolean> {
    const startingTimeMicroseconds = secondsToMicroseconds(audioElement.currentTime);
    return new Promise<boolean>(resolve => {
        const timeout = globalThis.setTimeout((): void => {
            cleanup();
            resolve(false);
        }, microsecondsToMilliseconds(timeoutMicroseconds));
        const checkProgress = (): void => {
            const currentTimeMicroseconds = secondsToMicroseconds(audioElement.currentTime);
            if (currentTimeMicroseconds - startingTimeMicroseconds
                < REQUIRED_PLAYBACK_ADVANCE_MICROSECONDS) {
                return;
            }
            cleanup();
            resolve(true);
        };
        const onError = (): void => {
            cleanup();
            resolve(false);
        };
        const interval = globalThis.setInterval(checkProgress, 20);
        const cleanup = (): void => {
            globalThis.clearTimeout(timeout);
            globalThis.clearInterval(interval);
            audioElement.removeEventListener('timeupdate', checkProgress);
            audioElement.removeEventListener('ended', checkProgress);
            audioElement.removeEventListener('error', onError);
        };
        audioElement.addEventListener('timeupdate', checkProgress);
        audioElement.addEventListener('ended', checkProgress);
        audioElement.addEventListener('error', onError);
        checkProgress();
    });
}

async function runDefaultExactPlaybackProbe(
    request: Readonly<NativeMediaAudioExactProbeRequest>
): Promise<NativeMediaAudioExactProbeResult> {
    if (typeof globalThis.MediaSource !== 'function'
        || typeof globalThis.URL?.createObjectURL !== 'function'
        || typeof globalThis.URL?.revokeObjectURL !== 'function'
        || !globalThis.document?.body) {
        return { reason: 'api-unavailable', supported: false };
    }

    const audioElement = globalThis.document.createElement('audio');
    // eslint-disable-next-line compat/compat -- Native MSE audio is capability-gated
    const mediaSource = new MediaSource();
    const objectURL = globalThis.URL.createObjectURL(mediaSource);
    audioElement.autoplay = false;
    audioElement.controls = false;
    audioElement.muted = true;
    audioElement.preload = 'auto';
    audioElement.setAttribute('aria-hidden', 'true');
    audioElement.style.position = 'fixed';
    audioElement.style.width = '1px';
    audioElement.style.height = '1px';
    audioElement.style.opacity = '0';
    audioElement.style.pointerEvents = 'none';
    globalThis.document.body.appendChild(audioElement);
    audioElement.src = objectURL;

    try {
        const sourceOpened = await waitForSourceOpen(
            mediaSource,
            PROBE_TIMEOUT_MICROSECONDS
        );
        if (!sourceOpened || mediaSource.readyState !== 'open') {
            return { reason: 'probe-timeout', supported: false };
        }

        const sourceBuffer = mediaSource.addSourceBuffer(request.mimeType);
        const fixtureAppended = await appendFixture(
            sourceBuffer,
            request.fixture,
            PROBE_TIMEOUT_MICROSECONDS
        );
        if (!fixtureAppended) {
            return { reason: 'fixture-append-failed', supported: false };
        }
        if (mediaSource.readyState === 'open') {
            mediaSource.endOfStream();
        }

        try {
            await audioElement.play();
        } catch {
            return { reason: 'playback-failed', supported: false };
        }
        const advanced = await waitForPlaybackAdvance(
            audioElement,
            PROBE_TIMEOUT_MICROSECONDS
        );
        return advanced ?
            { reason: 'decoded-playback-advanced', supported: true } :
            { reason: 'playback-not-advanced', supported: false };
    } catch {
        return { reason: 'fixture-append-failed', supported: false };
    } finally {
        audioElement.pause();
        audioElement.removeAttribute('src');
        audioElement.load();
        audioElement.remove();
        globalThis.URL.revokeObjectURL(objectURL);
    }
}

function createUnavailableLayout(
    definition: NativeMediaAudioDefinition,
    channelCount: NativeMediaAudioChannelCount,
    reason: NativeMediaAudioCapabilityReason,
    status: NativeMediaAudioCapabilityStatus
): NativeMediaAudioLayoutCapability {
    return {
        ...definition,
        channelCount,
        reason,
        sampleRate: NATIVE_MEDIA_AUDIO_SAMPLE_RATE,
        status
    };
}

function getCodecStatus(
    layouts: Readonly<Record<NativeMediaAudioChannelCount, NativeMediaAudioLayoutCapability>>
): NativeMediaAudioCapabilityStatus {
    if (Object.values(layouts).some(layout => layout.status === 'supported')) {
        return 'supported';
    }
    if (Object.values(layouts).some(layout => layout.status === 'unknown')) {
        return 'unknown';
    }
    return 'unsupported';
}

type NativeMediaAudioLayoutProbeOutcome = {
    capability: NativeMediaAudioLayoutCapability
    probed: boolean
};

async function probeNativeMediaAudioLayout(
    definition: NativeMediaAudioDefinition,
    channelCount: NativeMediaAudioChannelCount,
    isTypeSupported: ((mimeType: string) => boolean) | null,
    exactPlaybackProbe: (
        probeInput: Readonly<NativeMediaAudioExactProbeRequest>
    ) => Promise<NativeMediaAudioExactProbeResult>
): Promise<NativeMediaAudioLayoutProbeOutcome> {
    if (!isTypeSupported) {
        return {
            capability: createUnavailableLayout(
                definition,
                channelCount,
                'api-unavailable',
                'unknown'
            ),
            probed: false
        };
    }

    let mimeSupported = false;
    try {
        mimeSupported = isTypeSupported(definition.mimeType);
    } catch {
        return {
            capability: createUnavailableLayout(
                definition,
                channelCount,
                'probe-exception',
                'unknown'
            ),
            probed: false
        };
    }
    if (!mimeSupported) {
        return {
            capability: createUnavailableLayout(
                definition,
                channelCount,
                'mime-unsupported',
                'unsupported'
            ),
            probed: false
        };
    }

    const route: NativeMediaAudioRoute = {
        ...definition,
        channelCount,
        sampleRate: NATIVE_MEDIA_AUDIO_SAMPLE_RATE
    };
    try {
        const result = await exactPlaybackProbe({
            ...route,
            fixture: createNativeMediaAudioProbeFixture(
                definition.codec,
                channelCount as NativeMediaAudioProbeFixtureChannelCount
            )
        });
        return {
            capability: {
                ...route,
                reason: result.reason,
                status: result.supported ? 'supported' : 'unsupported'
            },
            probed: true
        };
    } catch {
        return {
            capability: createUnavailableLayout(
                definition,
                channelCount,
                'probe-exception',
                'unknown'
            ),
            probed: true
        };
    }
}

/** Qualifies exact native MSE audio routes with append and clock-advance fixtures. */
export async function probeNativeMediaAudioCapabilities(
    environment: NativeMediaAudioCapabilityEnvironment = {}
): Promise<NativeMediaAudioCapabilities> {
    const isTypeSupported = environment.isTypeSupported === undefined ?
        getDefaultIsTypeSupported() :
        environment.isTypeSupported;
    const exactPlaybackProbe = environment.exactPlaybackProbe ?? runDefaultExactPlaybackProbe;
    const audio = {} as Record<NativeMediaAudioCodec, NativeMediaAudioCodecCapability>;
    let probeCount = 0;
    let supportedLayoutCount = 0;
    let unknownLayoutCount = 0;

    for (const definition of DEFINITIONS) {
        const layouts = {} as Record<
            NativeMediaAudioChannelCount,
            NativeMediaAudioLayoutCapability
        >;
        for (const channelCount of NATIVE_MEDIA_AUDIO_CHANNEL_COUNTS) {
            const outcome = await probeNativeMediaAudioLayout(
                definition,
                channelCount,
                isTypeSupported,
                exactPlaybackProbe
            );
            layouts[channelCount] = outcome.capability;
            if (outcome.probed) {
                probeCount += 1;
            }
            if (outcome.capability.status === 'supported') {
                supportedLayoutCount += 1;
            } else if (outcome.capability.status === 'unknown') {
                unknownLayoutCount += 1;
            }
        }
        audio[definition.codec] = {
            ...definition,
            layouts,
            status: getCodecStatus(layouts)
        };
    }

    return {
        audio,
        telemetry: {
            probeCount,
            supportedLayoutCount,
            unknownLayoutCount
        }
    };
}

/** Returns a route only when its exact codec, channel count, and sample rate passed. */
export function getSupportedNativeMediaAudioRoute(
    capabilities: NativeMediaAudioCapabilities,
    codec: NativeMediaAudioCodec,
    channelCount: number,
    sampleRate: number
): NativeMediaAudioRoute | null {
    if ((channelCount !== 2 && channelCount !== 6)
        || sampleRate !== NATIVE_MEDIA_AUDIO_SAMPLE_RATE) {
        return null;
    }
    const layout = capabilities.audio[codec].layouts[channelCount];
    if (layout.status !== 'supported') {
        return null;
    }
    return {
        channelCount,
        codec,
        codecString: layout.codecString,
        mimeType: layout.mimeType,
        sampleRate: NATIVE_MEDIA_AUDIO_SAMPLE_RATE
    };
}
