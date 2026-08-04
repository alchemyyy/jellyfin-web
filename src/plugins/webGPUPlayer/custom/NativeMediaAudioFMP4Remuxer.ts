import {
    EncodedAudioPacketSource,
    EncodedPacket,
    Mp4OutputFormat,
    NullTarget,
    Output,
    type AudioCodec,
    type PacketType
} from 'mediabunny';

import {
    microsecondsToSeconds,
    millisecondsToMicroseconds,
    secondsToMicroseconds,
    type Microseconds
} from '../MediaTime';
import {
    type OwnedNativeMediaAudioSegment
} from './OwnedNativeMediaAudioBackend';
import {
    MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH,
    MAXIMUM_NATIVE_AUDIO_SEGMENT_DURATION_MICROSECONDS
} from './NativeMediaAudioLimits';
import { addMicroseconds, requireMicroseconds } from './TimeMath';

export const DEFAULT_NATIVE_AUDIO_FRAGMENT_DURATION_MICROSECONDS =
    millisecondsToMicroseconds(500);
export const MAXIMUM_NATIVE_AUDIO_ENCODED_PACKET_BYTE_LENGTH = 1_024 * 1_024;
export const MAXIMUM_PENDING_NATIVE_AUDIO_REMUX_SEGMENTS = 2;

export type NativeMediaAudioFMP4Codec = 'ac3' | 'eac3';

export type NativeMediaAudioFMP4RemuxerConfiguration = {
    channelCount: 2 | 6
    codec: NativeMediaAudioFMP4Codec
    decoderConfig: AudioDecoderConfig
    fragmentDurationMicroseconds?: Microseconds
    sampleRate: 48_000
};

export type NativeMediaAudioEncodedPacket = {
    data: Uint8Array
    durationMicroseconds: Microseconds
    sequenceNumber: number
    timestampMicroseconds: Microseconds
    type: PacketType
};

export type NativeMediaAudioFMP4RemuxOutput = {
    initializationSegment: Uint8Array | null
    mediaSegments: readonly OwnedNativeMediaAudioSegment[]
};

export type NativeMediaAudioFMP4RemuxerTelemetry = {
    encodedPacketByteLength: number
    encodedPacketCount: number
    finalized: boolean
    initializationSegmentByteLength: number
    mediaSegmentByteLength: number
    mediaSegmentCount: number
    pendingMediaSegmentCount: number
};

type PendingMovieFragment = {
    data: Uint8Array
    endTimeMicroseconds: Microseconds
    startTimeMicroseconds: Microseconds
};

function requirePositiveMicroseconds(value: Microseconds, label: string): Microseconds {
    requireMicroseconds(value, label);
    if (value <= 0) {
        throw new RangeError(`${label} must be positive`);
    }
    return value;
}

function copyBufferSource(data: AllowSharedBufferSource | undefined): ArrayBuffer | undefined {
    if (data === undefined) {
        return undefined;
    }
    const sourceBytes = ArrayBuffer.isView(data) ?
        new Uint8Array(data.buffer, data.byteOffset, data.byteLength) :
        new Uint8Array(data);
    return sourceBytes.slice().buffer;
}

function concatenateBoxes(first: Uint8Array, second: Uint8Array): Uint8Array {
    const byteLength = first.byteLength + second.byteLength;
    if (byteLength <= 0 || byteLength > MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH) {
        throw new RangeError('Native audio fMP4 segment byte length is outside bounds');
    }
    const data = new Uint8Array(byteLength);
    data.set(first, 0);
    data.set(second, first.byteLength);
    return data;
}

function requireConfiguration(
    configuration: NativeMediaAudioFMP4RemuxerConfiguration
): NativeMediaAudioFMP4RemuxerConfiguration & { fragmentDurationMicroseconds: Microseconds } {
    const expectedCodecString = configuration.codec === 'ac3' ? 'ac-3' : 'ec-3';
    if (configuration.decoderConfig.codec !== expectedCodecString) {
        throw new TypeError('Native audio decoder configuration codec does not match the remux route');
    }
    if (configuration.decoderConfig.numberOfChannels !== configuration.channelCount
        || configuration.decoderConfig.sampleRate !== configuration.sampleRate) {
        throw new TypeError('Native audio decoder configuration layout does not match the remux route');
    }
    const fragmentDurationMicroseconds = requirePositiveMicroseconds(
        configuration.fragmentDurationMicroseconds
            ?? DEFAULT_NATIVE_AUDIO_FRAGMENT_DURATION_MICROSECONDS,
        'Native audio fragment duration'
    );
    if (fragmentDurationMicroseconds > MAXIMUM_NATIVE_AUDIO_SEGMENT_DURATION_MICROSECONDS) {
        throw new RangeError('Native audio fragment duration exceeds the backend bound');
    }
    return { ...configuration, fragmentDurationMicroseconds };
}

/** Repackages one exact compressed audio track into bounded fragmented MP4. */
export default class NativeMediaAudioFMP4Remuxer {
    private readonly audioSource: EncodedAudioPacketSource;
    private canceled = false;
    private encodedPacketByteLength = 0;
    private encodedPacketCount = 0;
    private finalized = false;
    private fileTypeBox: Uint8Array | null = null;
    private initializationSegment: Uint8Array | null = null;
    private initializationSegmentByteLength = 0;
    private lastPacketEndTimeMicroseconds: Microseconds | null = null;
    private lastPacketTimeMicroseconds: Microseconds | null = null;
    private mediaSegmentByteLength = 0;
    private mediaSegmentCount = 0;
    private movieBox: Uint8Array | null = null;
    private pendingMediaDataBox: Uint8Array | null = null;
    private pendingMediaSegments: OwnedNativeMediaAudioSegment[] = [];
    private pendingMovieFragment: PendingMovieFragment | null = null;
    private readonly output: Output<Mp4OutputFormat, NullTarget>;
    private started = false;

    public constructor(configurationValue: NativeMediaAudioFMP4RemuxerConfiguration) {
        const configuration = requireConfiguration(configurationValue);
        const format = new Mp4OutputFormat({
            fastStart: 'fragmented',
            minimumFragmentDuration: microsecondsToSeconds(
                configuration.fragmentDurationMicroseconds
            ),
            onFtyp: (data: Uint8Array): void => {
                this.fileTypeBox = data.slice();
                this.tryCreateInitializationSegment();
            },
            onMdat: (data: Uint8Array): void => {
                this.pendingMediaDataBox = data.slice();
                this.tryCreateMediaSegment();
            },
            onMoof: (data: Uint8Array, _position: number, timestamp: number): void => {
                if (this.lastPacketEndTimeMicroseconds === null) {
                    throw new Error('Native audio fragment was emitted before a packet end time');
                }
                this.pendingMovieFragment = {
                    data: data.slice(),
                    endTimeMicroseconds: this.lastPacketEndTimeMicroseconds,
                    startTimeMicroseconds: secondsToMicroseconds(timestamp)
                };
                this.tryCreateMediaSegment();
            },
            onMoov: (data: Uint8Array): void => {
                this.movieBox = data.slice();
                this.tryCreateInitializationSegment();
            }
        });
        this.output = new Output({ format, target: new NullTarget() });
        this.audioSource = new EncodedAudioPacketSource(configuration.codec as AudioCodec);
        this.output.addAudioTrack(this.audioSource);
        this.decoderConfig = {
            ...configuration.decoderConfig,
            description: copyBufferSource(configuration.decoderConfig.description)
        };
    }

    private readonly decoderConfig: AudioDecoderConfig;

    /** Starts the muxer before packets are added. */
    public async start(): Promise<void> {
        this.requireActive();
        if (this.started) {
            return;
        }
        this.started = true;
        await this.output.start();
    }

    /** Adds one packet after its floating-point demux timestamps were normalized to microseconds. */
    public async addPacket(packet: Readonly<NativeMediaAudioEncodedPacket>): Promise<void> {
        this.requireActive();
        if (!this.started) {
            throw new Error('Native audio remuxer has not started');
        }
        requireMicroseconds(packet.timestampMicroseconds, 'Native audio packet timestamp');
        requireMicroseconds(packet.durationMicroseconds, 'Native audio packet duration');
        if (packet.durationMicroseconds <= 0) {
            throw new RangeError('Native audio packet duration must be positive');
        }
        if (!Number.isSafeInteger(packet.sequenceNumber)) {
            throw new RangeError('Native audio packet sequence number must be a safe integer');
        }
        if (packet.type !== 'key' && packet.type !== 'delta') {
            throw new TypeError('Native audio packet type is invalid');
        }
        if (packet.data.byteLength <= 0
            || packet.data.byteLength > MAXIMUM_NATIVE_AUDIO_ENCODED_PACKET_BYTE_LENGTH) {
            throw new RangeError('Native audio encoded packet byte length is outside bounds');
        }
        if (this.pendingMediaSegments.length >= MAXIMUM_PENDING_NATIVE_AUDIO_REMUX_SEGMENTS) {
            throw new Error('Native audio remux output was not drained');
        }

        const validatedPacketEndTimeMicroseconds = addMicroseconds(
            packet.timestampMicroseconds,
            packet.durationMicroseconds
        );
        if (this.lastPacketTimeMicroseconds !== null
            && packet.timestampMicroseconds < this.lastPacketTimeMicroseconds) {
            throw new RangeError('Native audio packet timestamps must not move backward');
        }

        const encodedPacket = new EncodedPacket(
            packet.data,
            packet.type,
            microsecondsToSeconds(packet.timestampMicroseconds),
            microsecondsToSeconds(packet.durationMicroseconds),
            packet.sequenceNumber
        );
        await this.audioSource.add(
            encodedPacket,
            this.encodedPacketCount === 0 ? { decoderConfig: this.decoderConfig } : undefined
        );
        this.lastPacketEndTimeMicroseconds = validatedPacketEndTimeMicroseconds;
        this.lastPacketTimeMicroseconds = packet.timestampMicroseconds;
        this.encodedPacketCount += 1;
        this.encodedPacketByteLength += packet.data.byteLength;
    }

    /** Completes the final fragment. */
    public async finalize(): Promise<void> {
        this.requireActive();
        if (!this.started) {
            throw new Error('Native audio remuxer has not started');
        }
        if (this.encodedPacketCount === 0) {
            throw new Error('Native audio remuxer cannot finalize without packets');
        }
        await this.output.finalize();
        this.finalized = true;
        if (this.initializationSegmentByteLength === 0
            || this.pendingMovieFragment
            || this.pendingMediaDataBox) {
            throw new Error('Native audio remuxer emitted an incomplete fragmented MP4 stream');
        }
    }

    /** Cancels muxing and releases Mediabunny resources. */
    public async cancel(): Promise<void> {
        if (this.canceled || this.finalized) {
            return;
        }
        this.canceled = true;
        await this.output.cancel();
        this.pendingMediaSegments = [];
        this.pendingMovieFragment = null;
        this.pendingMediaDataBox = null;
        this.initializationSegment = null;
    }

    /** Transfers all currently completed boxes to the caller. */
    public takeOutput(): NativeMediaAudioFMP4RemuxOutput {
        const initializationSegment = this.initializationSegment;
        const mediaSegments = this.pendingMediaSegments;
        this.initializationSegment = null;
        this.pendingMediaSegments = [];
        return { initializationSegment, mediaSegments };
    }

    /** Returns bounded remux diagnostics. */
    public getTelemetry(): NativeMediaAudioFMP4RemuxerTelemetry {
        return {
            encodedPacketByteLength: this.encodedPacketByteLength,
            encodedPacketCount: this.encodedPacketCount,
            finalized: this.finalized,
            initializationSegmentByteLength: this.initializationSegmentByteLength,
            mediaSegmentByteLength: this.mediaSegmentByteLength,
            mediaSegmentCount: this.mediaSegmentCount,
            pendingMediaSegmentCount: this.pendingMediaSegments.length
        };
    }

    private requireActive(): void {
        if (this.canceled) {
            throw new Error('Native audio remuxer is canceled');
        }
        if (this.finalized) {
            throw new Error('Native audio remuxer is finalized');
        }
    }

    private tryCreateInitializationSegment(): void {
        if (!this.fileTypeBox || !this.movieBox || this.initializationSegment) {
            return;
        }
        this.initializationSegment = concatenateBoxes(this.fileTypeBox, this.movieBox);
        this.initializationSegmentByteLength = this.initializationSegment.byteLength;
        this.fileTypeBox = null;
        this.movieBox = null;
    }

    private tryCreateMediaSegment(): void {
        if (!this.pendingMovieFragment || !this.pendingMediaDataBox) {
            return;
        }
        const pendingMovieFragment = this.pendingMovieFragment;
        const data = concatenateBoxes(
            pendingMovieFragment.data,
            this.pendingMediaDataBox
        );
        if (pendingMovieFragment.endTimeMicroseconds
            <= pendingMovieFragment.startTimeMicroseconds) {
            throw new RangeError('Native audio fMP4 fragment has an invalid time range');
        }
        if (pendingMovieFragment.endTimeMicroseconds
            - pendingMovieFragment.startTimeMicroseconds
            > MAXIMUM_NATIVE_AUDIO_SEGMENT_DURATION_MICROSECONDS) {
            throw new RangeError('Native audio fMP4 fragment duration exceeds the backend bound');
        }
        if (this.pendingMediaSegments.length >= MAXIMUM_PENDING_NATIVE_AUDIO_REMUX_SEGMENTS) {
            throw new Error('Native audio remux output exceeded its queue bound');
        }
        this.pendingMediaSegments.push({
            data,
            endTimeMicroseconds: pendingMovieFragment.endTimeMicroseconds,
            startTimeMicroseconds: pendingMovieFragment.startTimeMicroseconds
        });
        this.mediaSegmentByteLength += data.byteLength;
        this.mediaSegmentCount += 1;
        this.pendingMovieFragment = null;
        this.pendingMediaDataBox = null;
    }
}
