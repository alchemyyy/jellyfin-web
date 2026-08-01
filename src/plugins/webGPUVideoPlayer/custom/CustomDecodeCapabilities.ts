export const CUSTOM_VIDEO_CODECS = [ 'h264', 'hevc', 'vp8', 'vp9', 'av1' ] as const;
export const CUSTOM_AUDIO_CODECS = [ 'aac', 'opus', 'flac', 'mp3', 'vorbis' ] as const;

export type CustomVideoCodec = typeof CUSTOM_VIDEO_CODECS[number];
export type CustomAudioCodec = typeof CUSTOM_AUDIO_CODECS[number];
export type CustomDecodeCodec = CustomAudioCodec | CustomVideoCodec;
export type CustomDecodeCapabilityStatus = 'supported' | 'unsupported' | 'unknown';
export type CustomDecodeCapabilityReason =
    | 'api-unavailable'
    | 'config-supported'
    | 'config-unsupported'
    | 'probe-exception';

export type CustomDecodeCodecCapability<Codec extends CustomDecodeCodec> = {
    codec: Codec
    codecString: string
    reason: CustomDecodeCapabilityReason
    status: CustomDecodeCapabilityStatus
};

export type CustomDecodeProbeReason =
    | 'api-unavailable'
    | 'complete'
    | 'partial-api'
    | 'probe-exceptions';

export type CustomDecodeProbeTelemetry = {
    audioProbeCount: number
    reason: CustomDecodeProbeReason
    supportedAudioCodecCount: number
    supportedVideoCodecCount: number
    unknownAudioCodecCount: number
    unknownVideoCodecCount: number
    videoProbeCount: number
};

export type CustomDecodeCapabilities = {
    audio: Readonly<Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>>
    telemetry: Readonly<CustomDecodeProbeTelemetry>
    video: Readonly<Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>>
};

export type WebCodecsCapabilityEnvironment = {
    audioDecoder?: Pick<typeof AudioDecoder, 'isConfigSupported'> | null
    videoDecoder?: Pick<typeof VideoDecoder, 'isConfigSupported'> | null
};

type VideoProbeDefinition = {
    codec: CustomVideoCodec
    config: VideoDecoderConfig
};

type AudioProbeDefinition = {
    codec: CustomAudioCodec
    config: AudioDecoderConfig
};

type DecoderCapabilityAPI<Config> = {
    isConfigSupported: (config: Config) => Promise<{ supported?: boolean }>
};

type CodecProbeDefinition<Codec extends CustomDecodeCodec, Config extends { codec: string }> = {
    codec: Codec
    config: Config
};

const REPRESENTATIVE_VIDEO_WIDTH = 1_920;
const REPRESENTATIVE_VIDEO_HEIGHT = 1_080;
const REPRESENTATIVE_AUDIO_SAMPLE_RATE = 48_000;
const REPRESENTATIVE_AUDIO_CHANNEL_COUNT = 2;
const REPRESENTATIVE_FLAC_STREAM_INFO_BYTES = 34;

const VIDEO_PROBE_DEFINITIONS: readonly VideoProbeDefinition[] = [
    {
        codec: 'h264',
        config: {
            codec: 'avc1.640028',
            codedHeight: REPRESENTATIVE_VIDEO_HEIGHT,
            codedWidth: REPRESENTATIVE_VIDEO_WIDTH,
            hardwareAcceleration: 'no-preference',
            optimizeForLatency: true
        }
    },
    {
        codec: 'hevc',
        config: {
            codec: 'hvc1.1.6.L120.B0',
            codedHeight: REPRESENTATIVE_VIDEO_HEIGHT,
            codedWidth: REPRESENTATIVE_VIDEO_WIDTH,
            hardwareAcceleration: 'no-preference',
            optimizeForLatency: true
        }
    },
    {
        codec: 'vp8',
        config: {
            codec: 'vp8',
            codedHeight: REPRESENTATIVE_VIDEO_HEIGHT,
            codedWidth: REPRESENTATIVE_VIDEO_WIDTH,
            hardwareAcceleration: 'no-preference',
            optimizeForLatency: true
        }
    },
    {
        codec: 'vp9',
        config: {
            codec: 'vp09.00.10.08',
            codedHeight: REPRESENTATIVE_VIDEO_HEIGHT,
            codedWidth: REPRESENTATIVE_VIDEO_WIDTH,
            hardwareAcceleration: 'no-preference',
            optimizeForLatency: true
        }
    },
    {
        codec: 'av1',
        config: {
            codec: 'av01.0.08M.08',
            codedHeight: REPRESENTATIVE_VIDEO_HEIGHT,
            codedWidth: REPRESENTATIVE_VIDEO_WIDTH,
            hardwareAcceleration: 'no-preference',
            optimizeForLatency: true
        }
    }
];

const AUDIO_PROBE_DEFINITIONS: readonly AudioProbeDefinition[] = [
    {
        codec: 'aac',
        config: {
            codec: 'mp4a.40.2',
            numberOfChannels: REPRESENTATIVE_AUDIO_CHANNEL_COUNT,
            sampleRate: REPRESENTATIVE_AUDIO_SAMPLE_RATE
        }
    },
    {
        codec: 'opus',
        config: {
            codec: 'opus',
            numberOfChannels: REPRESENTATIVE_AUDIO_CHANNEL_COUNT,
            sampleRate: REPRESENTATIVE_AUDIO_SAMPLE_RATE
        }
    },
    {
        codec: 'flac',
        config: {
            codec: 'flac',
            // WebCodecs requires a STREAMINFO description to probe FLAC
            description: new Uint8Array(REPRESENTATIVE_FLAC_STREAM_INFO_BYTES),
            numberOfChannels: REPRESENTATIVE_AUDIO_CHANNEL_COUNT,
            sampleRate: REPRESENTATIVE_AUDIO_SAMPLE_RATE
        }
    },
    {
        codec: 'mp3',
        config: {
            codec: 'mp3',
            numberOfChannels: REPRESENTATIVE_AUDIO_CHANNEL_COUNT,
            sampleRate: REPRESENTATIVE_AUDIO_SAMPLE_RATE
        }
    },
    {
        codec: 'vorbis',
        config: {
            codec: 'vorbis',
            // Decoder availability can be probed with a non-empty description;
            // the selected track supplies its exact private data before decode
            description: new Uint8Array([0]),
            numberOfChannels: REPRESENTATIVE_AUDIO_CHANNEL_COUNT,
            sampleRate: REPRESENTATIVE_AUDIO_SAMPLE_RATE
        }
    }
];

function getDefaultEnvironment(): WebCodecsCapabilityEnvironment {
    return {
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        audioDecoder: typeof globalThis.AudioDecoder === 'function' ? globalThis.AudioDecoder : null,
        // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
        videoDecoder: typeof globalThis.VideoDecoder === 'function' ? globalThis.VideoDecoder : null
    };
}

function createUnavailableCapability<Codec extends CustomDecodeCodec>(
    codec: Codec,
    codecString: string
): CustomDecodeCodecCapability<Codec> {
    return Object.freeze({
        codec,
        codecString,
        reason: 'api-unavailable',
        status: 'unknown'
    });
}

async function probeConfig<Codec extends CustomDecodeCodec, Config extends { codec: string }>(
    definition: CodecProbeDefinition<Codec, Config>,
    decoder: DecoderCapabilityAPI<Config> | null | undefined
): Promise<CustomDecodeCodecCapability<Codec>> {
    if (!decoder) {
        return createUnavailableCapability(definition.codec, definition.config.codec);
    }

    try {
        const support = await decoder.isConfigSupported({ ...definition.config });
        return Object.freeze({
            codec: definition.codec,
            codecString: definition.config.codec,
            reason: support.supported ? 'config-supported' : 'config-unsupported',
            status: support.supported ? 'supported' : 'unsupported'
        });
    } catch {
        return Object.freeze({
            codec: definition.codec,
            codecString: definition.config.codec,
            reason: 'probe-exception',
            status: 'unknown'
        });
    }
}

function getProbeReason(
    environment: WebCodecsCapabilityEnvironment,
    capabilities: readonly CustomDecodeCodecCapability<CustomDecodeCodec>[]
): CustomDecodeProbeReason {
    if (capabilities.some(capability => capability.reason === 'probe-exception')) {
        return 'probe-exceptions';
    }
    if (!environment.audioDecoder && !environment.videoDecoder) {
        return 'api-unavailable';
    }
    if (!environment.audioDecoder || !environment.videoDecoder) {
        return 'partial-api';
    }
    return 'complete';
}

/** Performs one cached, coarse WebCodecs decoder capability probe. */
export default class CustomDecodeCapabilityProbe {
    private cachedProbe: Promise<CustomDecodeCapabilities> | null = null;
    private readonly environment: WebCodecsCapabilityEnvironment | null;

    public constructor(environment: WebCodecsCapabilityEnvironment | null = null) {
        this.environment = environment;
    }

    /** Returns the same cached capability result for all calls. */
    public probe(): Promise<CustomDecodeCapabilities> {
        if (!this.cachedProbe) {
            this.cachedProbe = this.runProbe(this.environment ?? getDefaultEnvironment());
        }
        return this.cachedProbe;
    }

    private async runProbe(environment: WebCodecsCapabilityEnvironment): Promise<CustomDecodeCapabilities> {
        const videoProbePromises: Array<Promise<CustomDecodeCodecCapability<CustomVideoCodec>>> = [];
        for (const definition of VIDEO_PROBE_DEFINITIONS) {
            videoProbePromises.push(probeConfig(definition, environment.videoDecoder));
        }
        const audioProbePromises: Array<Promise<CustomDecodeCodecCapability<CustomAudioCodec>>> = [];
        for (const definition of AUDIO_PROBE_DEFINITIONS) {
            audioProbePromises.push(probeConfig(definition, environment.audioDecoder));
        }

        const [ videoCapabilities, audioCapabilities ] = await Promise.all([
            Promise.all(videoProbePromises),
            Promise.all(audioProbePromises)
        ]);
        const video = {} as Record<CustomVideoCodec, CustomDecodeCodecCapability<CustomVideoCodec>>;
        for (const capability of videoCapabilities) {
            video[capability.codec] = capability;
        }
        const audio = {} as Record<CustomAudioCodec, CustomDecodeCodecCapability<CustomAudioCodec>>;
        for (const capability of audioCapabilities) {
            audio[capability.codec] = capability;
        }

        const allCapabilities: Array<CustomDecodeCodecCapability<CustomDecodeCodec>> = [];
        allCapabilities.push(...videoCapabilities, ...audioCapabilities);
        const telemetry = Object.freeze({
            audioProbeCount: environment.audioDecoder ? AUDIO_PROBE_DEFINITIONS.length : 0,
            reason: getProbeReason(environment, allCapabilities),
            supportedAudioCodecCount: audioCapabilities.filter(capability => capability.status === 'supported').length,
            supportedVideoCodecCount: videoCapabilities.filter(capability => capability.status === 'supported').length,
            unknownAudioCodecCount: audioCapabilities.filter(capability => capability.status === 'unknown').length,
            unknownVideoCodecCount: videoCapabilities.filter(capability => capability.status === 'unknown').length,
            videoProbeCount: environment.videoDecoder ? VIDEO_PROBE_DEFINITIONS.length : 0
        });

        return Object.freeze({
            audio: Object.freeze(audio),
            telemetry,
            video: Object.freeze(video)
        });
    }
}

const defaultCapabilityProbe = new CustomDecodeCapabilityProbe();

/** Probes the current runtime once and reuses that result for later sessions. */
export function probeCustomDecodeCapabilities(): Promise<CustomDecodeCapabilities> {
    return defaultCapabilityProbe.probe();
}
