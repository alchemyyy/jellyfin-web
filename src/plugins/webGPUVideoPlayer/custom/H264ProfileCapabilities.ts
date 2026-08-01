export const H264_PROFILE_PROBE_TIMEOUT_MILLISECONDS = 2_000;
export const H264_PROFILE_PROBE_CODED_WIDTH = 1_920;
export const H264_PROFILE_PROBE_CODED_HEIGHT = 1_080;

export const H264_PROFILES = Object.freeze([
    'constrained-baseline',
    'baseline',
    'main',
    'high'
] as const);

export type H264Profile = typeof H264_PROFILES[number];
export type H264JellyfinProfileName =
    | 'constrained baseline'
    | 'baseline'
    | 'main'
    | 'high';

export const H264_JELLYFIN_PROFILE_NAMES: Readonly<Record<
    H264Profile,
    H264JellyfinProfileName
>> = Object.freeze({
    'constrained-baseline': 'constrained baseline',
    baseline: 'baseline',
    main: 'main',
    high: 'high'
});

export type H264ProfileCapabilityStatus = 'supported' | 'unsupported' | 'unknown';
export type H264ProfileCapabilityReason =
    | 'api-unavailable'
    | 'config-supported-only'
    | 'config-unsupported'
    | 'decode-output-verified'
    | 'output-mismatch'
    | 'probe-exception'
    | 'probe-timeout';
export type H264ProfileCapabilityEvidence =
    | 'none'
    | 'configuration'
    | 'decoded-output';

export type H264ProfileCapability = Readonly<{
    codecString: string
    codedHeight: typeof H264_PROFILE_PROBE_CODED_HEIGHT
    codedWidth: typeof H264_PROFILE_PROBE_CODED_WIDTH
    evidence: H264ProfileCapabilityEvidence
    jellyfinProfileName: H264JellyfinProfileName
    profile: H264Profile
    reason: H264ProfileCapabilityReason
    status: H264ProfileCapabilityStatus
}>;

export type H264ProfileCapabilities = Readonly<Record<
    H264Profile,
    H264ProfileCapability
>>;

/** Maps a Jellyfin stream profile to one independently probed H264 profile. */
export function getH264ProfileFromJellyfinValue(value: unknown): H264Profile | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalizedProfile = value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    switch (normalizedProfile) {
        case 'CONSTRAINEDBASELINE':
            return 'constrained-baseline';
        case 'BASELINE':
            return 'baseline';
        case 'MAIN':
            return 'main';
        case 'HIGH':
            return 'high';
        default:
            return null;
    }
}

/** Returns only Jellyfin profile names backed by verified decoder output. */
export function getSupportedH264JellyfinProfileNames(
    capabilities: H264ProfileCapabilities
): H264JellyfinProfileName[] {
    const profileNames: H264JellyfinProfileName[] = [];
    for (const profile of H264_PROFILES) {
        const capability = capabilities[profile];
        if (capability.status === 'supported' && capability.evidence === 'decoded-output') {
            profileNames.push(capability.jellyfinProfileName);
        }
    }
    return profileNames;
}

/** Requires verified output for the exact H264 profile named by Jellyfin. */
export function supportsH264JellyfinProfile(
    capabilities: H264ProfileCapabilities,
    profileValue: unknown
): boolean {
    const profile = getH264ProfileFromJellyfinValue(profileValue);
    if (!profile) {
        return false;
    }
    const capability = capabilities[profile];
    return capability.status === 'supported'
        && capability.evidence === 'decoded-output';
}

export type H264ProfileOutputProbeRequest = Readonly<{
    configuration: Readonly<VideoDecoderConfig>
    encodedKeyFrame: Uint8Array
    expectedCodedHeight: number
    expectedCodedWidth: number
    expectedDisplayHeight: number
    expectedDisplayWidth: number
    expectedTimestamp: number
    profile: H264Profile
}>;

export type H264ProfileOutputProbe = (
    probeRequest: H264ProfileOutputProbeRequest,
    cancellationSignal: H264ProbeCancellationSignal
) => Promise<boolean>;

export type H264ProbeCancellationSignal = Readonly<{
    isCancelled: () => boolean
    onCancel: (listener: () => void) => () => void
}>;

export type H264ProfileCapabilityEnvironment = Readonly<{
    outputProbe?: H264ProfileOutputProbe | null
    videoDecoder?: Pick<typeof VideoDecoder, 'isConfigSupported'> | null
}>;

export type H264ProbeDecodedFrame = Readonly<{
    codedHeight: number
    codedWidth: number
    displayHeight: number
    displayWidth: number
    timestamp: number
    close: () => void
}>;

export type H264ProbeDecoderCallbacks = Readonly<{
    error: (error: DOMException) => void
    output: (frame: H264ProbeDecodedFrame) => void
}>;

export type H264ProbeDecoder = {
    close: () => void
    configure: (configuration: VideoDecoderConfig) => void
    decode: (chunk: unknown) => void
    flush: () => Promise<void>
};

export type H264ProbeDecodeRuntime = Readonly<{
    createDecoder: (callbacks: H264ProbeDecoderCallbacks) => H264ProbeDecoder
    createEncodedKeyFrame: (data: Uint8Array) => unknown
}>;

type H264ProbeDefinition = Readonly<{
    configuration: Readonly<VideoDecoderConfig>
    encodedKeyFrame: Uint8Array
    profile: H264Profile
}>;

const H264_PROBE_FRAME_WIDTH = 64;
const H264_PROBE_FRAME_HEIGHT = 64;
const H264_PROBE_FRAME_TIMESTAMP = 0;
const H264_PROBE_TIMEOUT = Symbol('h264-profile-probe-timeout');

// Single black Annex B keyframes generated with libx264 at level 4.0
const H264_CONSTRAINED_BASELINE_KEY_FRAME = new Uint8Array([
    0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0xC0, 0x28,
    0xDC, 0x42, 0x6C, 0x04, 0x40, 0x00, 0x00, 0x03,
    0x00, 0x40, 0x00, 0x00, 0x03, 0x00, 0xA3, 0xC6,
    0x0C, 0xE0, 0x00, 0x00, 0x00, 0x01, 0x68, 0xCE,
    0x0F, 0x2C, 0x80, 0x00, 0x00, 0x01, 0x65, 0x88,
    0x84, 0x04, 0xBC, 0x98, 0xA0, 0x00, 0x38, 0xA3,
    0x27, 0x27, 0x27, 0x5D, 0x75, 0xD7, 0x5D, 0x75,
    0xD7, 0x5D, 0x75, 0xD7, 0x5D, 0x75, 0xD7, 0x80
]);
const H264_BASELINE_KEY_FRAME = new Uint8Array([
    0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x28,
    0xDC, 0x42, 0x6C, 0x04, 0x40, 0x00, 0x00, 0x03,
    0x00, 0x40, 0x00, 0x00, 0x03, 0x00, 0xA3, 0xC6,
    0x0C, 0xE0, 0x00, 0x00, 0x00, 0x01, 0x68, 0xCE,
    0x0F, 0x2C, 0x80, 0x00, 0x00, 0x01, 0x65, 0x88,
    0x84, 0x04, 0xBC, 0x98, 0xA0, 0x00, 0x38, 0xA3,
    0x27, 0x27, 0x27, 0x5D, 0x75, 0xD7, 0x5D, 0x75,
    0xD7, 0x5D, 0x75, 0xD7, 0x5D, 0x75, 0xD7, 0x80
]);
const H264_MAIN_KEY_FRAME = new Uint8Array([
    0x00, 0x00, 0x00, 0x01, 0x67, 0x4D, 0x00, 0x28,
    0xDC, 0x42, 0x6C, 0x04, 0x40, 0x00, 0x00, 0x03,
    0x00, 0x40, 0x00, 0x00, 0x03, 0x00, 0xA3, 0xC6,
    0x0C, 0xE0, 0x00, 0x00, 0x00, 0x01, 0x68, 0xEE,
    0x0F, 0x2C, 0x80, 0x00, 0x00, 0x01, 0x65, 0x88,
    0x84, 0x04, 0xBF, 0xFE, 0xF7, 0xAD, 0xDF, 0x81,
    0x4D, 0xC3, 0x2B, 0x35, 0x6B, 0xBA, 0x57, 0x38,
    0xB4, 0x95, 0xAD, 0xE4, 0x03, 0x93, 0x2D, 0xB0,
    0x44, 0xD4, 0x56, 0x9E, 0x2E, 0xF7
]);
const H264_HIGH_KEY_FRAME = new Uint8Array([
    0x00, 0x00, 0x00, 0x01, 0x67, 0x64, 0x00, 0x28,
    0xAC, 0xB8, 0x84, 0xD8, 0x08, 0x80, 0x00, 0x00,
    0x03, 0x00, 0x80, 0x00, 0x00, 0x03, 0x01, 0x42,
    0x00, 0x00, 0x00, 0x01, 0x68, 0xEE, 0x0F, 0x2C,
    0x8B, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x04,
    0xBF, 0xFE, 0xF7, 0xAD, 0xDF, 0x81, 0x4D, 0xC3,
    0x2B, 0x35, 0x6B, 0xBA, 0x57, 0x38, 0xB4, 0x95,
    0xAD, 0xE4, 0x03, 0x93, 0x2D, 0xB0, 0x44, 0xD4,
    0x56, 0x9E, 0x2E, 0xF7
]);

function createProbeConfiguration(codec: string): Readonly<VideoDecoderConfig> {
    return Object.freeze({
        codec,
        codedHeight: H264_PROFILE_PROBE_CODED_HEIGHT,
        codedWidth: H264_PROFILE_PROBE_CODED_WIDTH,
        hardwareAcceleration: 'no-preference',
        optimizeForLatency: true
    });
}

const H264_PROBE_DEFINITIONS: Readonly<Record<H264Profile, H264ProbeDefinition>> =
    Object.freeze({
        'constrained-baseline': Object.freeze({
            configuration: createProbeConfiguration('avc1.42C028'),
            encodedKeyFrame: H264_CONSTRAINED_BASELINE_KEY_FRAME,
            profile: 'constrained-baseline'
        }),
        baseline: Object.freeze({
            configuration: createProbeConfiguration('avc1.420028'),
            encodedKeyFrame: H264_BASELINE_KEY_FRAME,
            profile: 'baseline'
        }),
        main: Object.freeze({
            configuration: createProbeConfiguration('avc1.4D0028'),
            encodedKeyFrame: H264_MAIN_KEY_FRAME,
            profile: 'main'
        }),
        high: Object.freeze({
            configuration: createProbeConfiguration('avc1.640028'),
            encodedKeyFrame: H264_HIGH_KEY_FRAME,
            profile: 'high'
        })
    });

function frameMatchesRequest(
    frame: H264ProbeDecodedFrame,
    probeRequest: H264ProfileOutputProbeRequest
): boolean {
    return frame.codedHeight === probeRequest.expectedCodedHeight
        && frame.codedWidth === probeRequest.expectedCodedWidth
        && frame.displayHeight === probeRequest.expectedDisplayHeight
        && frame.displayWidth === probeRequest.expectedDisplayWidth
        && frame.timestamp === probeRequest.expectedTimestamp;
}

/** Creates the bounded probe's real decoder-output verification operation. */
export function createH264ProfileOutputProbe(
    runtime: H264ProbeDecodeRuntime
): H264ProfileOutputProbe {
    return async (
        probeRequest: H264ProfileOutputProbeRequest,
        cancellationSignal: H264ProbeCancellationSignal
    ): Promise<boolean> => {
        if (cancellationSignal.isCancelled()) {
            throw new Error('H264 output probe was aborted');
        }

        let acceptingOutput = true;
        let decoder: H264ProbeDecoder | null = null;
        let outputCount = 0;
        let outputMatches = false;
        let rejectOutput: ((error: unknown) => void) | null = null;
        let resolveOutput: (() => void) | null = null;
        const outputPromise = new Promise<void>((resolve, reject) => {
            rejectOutput = reject;
            resolveOutput = resolve;
        });
        let rejectAbort: ((error: Error) => void) | null = null;
        const abortPromise = new Promise<never>((_resolve, reject) => {
            rejectAbort = reject;
        });
        const abort = (): void => {
            rejectAbort?.(new Error('H264 output probe was aborted'));
        };
        const removeCancellationListener = cancellationSignal.onCancel(abort);

        try {
            decoder = runtime.createDecoder({
                error: (error: DOMException): void => rejectOutput?.(error),
                output: (frame: H264ProbeDecodedFrame): void => {
                    try {
                        if (!acceptingOutput) {
                            return;
                        }
                        outputCount += 1;
                        if (outputCount === 1) {
                            outputMatches = frameMatchesRequest(frame, probeRequest);
                            resolveOutput?.();
                        }
                    } finally {
                        frame.close();
                    }
                }
            });
            decoder.configure({ ...probeRequest.configuration });
            decoder.decode(runtime.createEncodedKeyFrame(probeRequest.encodedKeyFrame));
            await Promise.race([
                Promise.all([ decoder.flush(), outputPromise ]),
                abortPromise
            ]);
            return outputCount === 1 && outputMatches;
        } finally {
            acceptingOutput = false;
            removeCancellationListener();
            decoder?.close();
        }
    };
}

function createDefaultOutputProbe(): H264ProfileOutputProbe | null {
    if (typeof globalThis.VideoDecoder !== 'function'
        || typeof globalThis.EncodedVideoChunk !== 'function') {
        return null;
    }

    return createH264ProfileOutputProbe({
        createDecoder: (callbacks: H264ProbeDecoderCallbacks): H264ProbeDecoder => {
            // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
            const decoder = new VideoDecoder({
                error: callbacks.error,
                output: callbacks.output
            });
            return {
                close: (): void => {
                    if (decoder.state !== 'closed') {
                        decoder.close();
                    }
                },
                configure: (configuration: VideoDecoderConfig): void => {
                    decoder.configure(configuration);
                },
                decode: (chunk: unknown): void => {
                    decoder.decode(chunk as EncodedVideoChunk);
                },
                flush: (): Promise<void> => decoder.flush()
            };
        },
        createEncodedKeyFrame: (data: Uint8Array): EncodedVideoChunk => {
            // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
            return new EncodedVideoChunk({
                data,
                timestamp: H264_PROBE_FRAME_TIMESTAMP,
                type: 'key'
            });
        }
    });
}

function createDefaultEnvironment(): H264ProfileCapabilityEnvironment {
    return {
        outputProbe: createDefaultOutputProbe(),
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        videoDecoder: typeof globalThis.VideoDecoder === 'function' ? globalThis.VideoDecoder : null
    };
}

function waitForProbe<Value>(
    operation: (cancellationSignal: H264ProbeCancellationSignal) => Promise<Value>
): Promise<Value | typeof H264_PROBE_TIMEOUT> {
    return new Promise<Value | typeof H264_PROBE_TIMEOUT>((resolve, reject) => {
        let cancelled = false;
        const cancellationListeners: Array<() => void> = [];
        const cancellationSignal: H264ProbeCancellationSignal = Object.freeze({
            isCancelled: (): boolean => cancelled,
            onCancel: (listener: () => void): (() => void) => {
                if (cancelled) {
                    listener();
                    return (): void => undefined;
                }
                cancellationListeners.push(listener);
                return (): void => {
                    const listenerIndex = cancellationListeners.indexOf(listener);
                    if (listenerIndex >= 0) {
                        cancellationListeners.splice(listenerIndex, 1);
                    }
                };
            }
        });
        let settled = false;
        const timeout = globalThis.setTimeout((): void => {
            if (settled) {
                return;
            }
            settled = true;
            cancelled = true;
            const listeners = cancellationListeners.splice(0, cancellationListeners.length);
            for (const listener of listeners) {
                listener();
            }
            resolve(H264_PROBE_TIMEOUT);
        }, H264_PROFILE_PROBE_TIMEOUT_MILLISECONDS);

        const operationPromise = Promise.resolve().then(() => operation(cancellationSignal));
        operationPromise.then((value: Value): void => {
            if (settled) {
                return;
            }
            settled = true;
            globalThis.clearTimeout(timeout);
            resolve(value);
        }, (error: unknown): void => {
            if (settled) {
                return;
            }
            settled = true;
            globalThis.clearTimeout(timeout);
            reject(error);
        });
    });
}

function createCapability(
    definition: H264ProbeDefinition,
    status: H264ProfileCapabilityStatus,
    reason: H264ProfileCapabilityReason,
    evidence: H264ProfileCapabilityEvidence
): H264ProfileCapability {
    return Object.freeze({
        codecString: definition.configuration.codec,
        codedHeight: H264_PROFILE_PROBE_CODED_HEIGHT,
        codedWidth: H264_PROFILE_PROBE_CODED_WIDTH,
        evidence,
        jellyfinProfileName: H264_JELLYFIN_PROFILE_NAMES[definition.profile],
        profile: definition.profile,
        reason,
        status
    });
}

async function probeProfile(
    definition: H264ProbeDefinition,
    environment: H264ProfileCapabilityEnvironment
): Promise<H264ProfileCapability> {
    if (!environment.videoDecoder) {
        return createCapability(definition, 'unknown', 'api-unavailable', 'none');
    }

    let configurationSupport: VideoDecoderSupport | typeof H264_PROBE_TIMEOUT;
    try {
        configurationSupport = await waitForProbe(() => (
            environment.videoDecoder!.isConfigSupported({ ...definition.configuration })
        ));
    } catch {
        return createCapability(definition, 'unknown', 'probe-exception', 'none');
    }
    if (configurationSupport === H264_PROBE_TIMEOUT) {
        return createCapability(definition, 'unknown', 'probe-timeout', 'none');
    }
    if (configurationSupport.supported !== true) {
        return createCapability(definition, 'unsupported', 'config-unsupported', 'configuration');
    }
    if (!environment.outputProbe) {
        return createCapability(definition, 'unknown', 'config-supported-only', 'configuration');
    }

    const probeRequest: H264ProfileOutputProbeRequest = Object.freeze({
        configuration: definition.configuration,
        encodedKeyFrame: definition.encodedKeyFrame.slice(),
        expectedCodedHeight: H264_PROBE_FRAME_HEIGHT,
        expectedCodedWidth: H264_PROBE_FRAME_WIDTH,
        expectedDisplayHeight: H264_PROBE_FRAME_HEIGHT,
        expectedDisplayWidth: H264_PROBE_FRAME_WIDTH,
        expectedTimestamp: H264_PROBE_FRAME_TIMESTAMP,
        profile: definition.profile
    });
    let outputMatches: boolean | typeof H264_PROBE_TIMEOUT;
    try {
        outputMatches = await waitForProbe((cancellationSignal: H264ProbeCancellationSignal) => (
            environment.outputProbe!(probeRequest, cancellationSignal)
        ));
    } catch {
        return createCapability(definition, 'unknown', 'probe-exception', 'configuration');
    }
    if (outputMatches === H264_PROBE_TIMEOUT) {
        return createCapability(definition, 'unknown', 'probe-timeout', 'configuration');
    }
    if (!outputMatches) {
        return createCapability(definition, 'unknown', 'output-mismatch', 'configuration');
    }
    return createCapability(definition, 'supported', 'decode-output-verified', 'decoded-output');
}

/** Measures H264 profile support once and returns immutable fail-closed results. */
export default class H264ProfileCapabilityProbe {
    private readonly environment: H264ProfileCapabilityEnvironment;
    private resultPromise: Promise<H264ProfileCapabilities> | null = null;

    public constructor(
        environment: H264ProfileCapabilityEnvironment = createDefaultEnvironment()
    ) {
        this.environment = environment;
    }

    public probe(): Promise<H264ProfileCapabilities> {
        this.resultPromise ??= this.runProbe();
        return this.resultPromise;
    }

    private async runProbe(): Promise<H264ProfileCapabilities> {
        const probes: Promise<H264ProfileCapability>[] = [];
        for (const profile of H264_PROFILES) {
            probes.push(probeProfile(H264_PROBE_DEFINITIONS[profile], this.environment));
        }
        const results = await Promise.all(probes);
        const capabilities = {} as Record<H264Profile, H264ProfileCapability>;
        for (let profileIndex = 0; profileIndex < H264_PROFILES.length; profileIndex += 1) {
            capabilities[H264_PROFILES[profileIndex]] = results[profileIndex];
        }
        return Object.freeze(capabilities);
    }
}
