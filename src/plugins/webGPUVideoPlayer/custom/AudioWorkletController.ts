import type { Microseconds } from '../MediaTime';
import {
    type AudioWorkletTelemetry,
    type CustomAudioWorkletMessage,
    type TransferablePlanarPCM
} from './AudioWorkletProtocol';
import {
    createCustomAudioWorkletModuleURL,
    CUSTOM_AUDIO_WORKLET_PROCESSOR_NAME
} from './AudioWorkletProcessorSource';
import { requireMicroseconds } from './TimeMath';

export const DEFAULT_AUDIO_TELEMETRY_INTERVAL_FRAMES = 4_096;
export const DEFAULT_MAX_WORKLET_CHUNKS = 1_024;
export const MAX_AUDIO_CHANNEL_COUNT = 32;
export const MAX_AUDIO_WORKLET_CHUNKS = 65_536;

export type AudioWorkletControllerOptions = {
    channelCount: number
    maxBufferedFrames: number
    maxChunks?: number
    telemetryIntervalFrames?: number
};

export type AudioWorkletControllerConfiguration = Required<AudioWorkletControllerOptions> & {
    sampleRate: number
};

export type AudioEnqueueSubmission = {
    frameCount: number
    sequence: number | null
    status: 'chunk-too-large' | 'stale-generation' | 'submitted'
};

export type AudioTelemetryListener = (telemetry: AudioWorkletTelemetry) => void;

const INITIAL_GENERATION = 1;
const moduleLoadPromises = new WeakMap<AudioContext, Promise<void>>();

function requirePositiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive safe integer`);
    }
    return value;
}

function createConfiguration(
    audioContext: AudioContext,
    options: AudioWorkletControllerOptions
): AudioWorkletControllerConfiguration {
    const channelCount = requirePositiveInteger(options.channelCount, 'Channel count');
    if (channelCount > MAX_AUDIO_CHANNEL_COUNT) {
        throw new RangeError(`Channel count cannot exceed ${MAX_AUDIO_CHANNEL_COUNT}`);
    }

    const maxChunks = requirePositiveInteger(options.maxChunks ?? DEFAULT_MAX_WORKLET_CHUNKS, 'Maximum audio chunks');
    if (maxChunks > MAX_AUDIO_WORKLET_CHUNKS) {
        throw new RangeError(`Maximum audio chunks cannot exceed ${MAX_AUDIO_WORKLET_CHUNKS}`);
    }

    return {
        channelCount,
        maxBufferedFrames: requirePositiveInteger(options.maxBufferedFrames, 'Maximum buffered frames'),
        maxChunks,
        sampleRate: requirePositiveInteger(audioContext.sampleRate, 'Audio context sample rate'),
        telemetryIntervalFrames: requirePositiveInteger(
            options.telemetryIntervalFrames ?? DEFAULT_AUDIO_TELEMETRY_INTERVAL_FRAMES,
            'Telemetry interval frames'
        )
    };
}

async function loadAudioWorkletModule(audioContext: AudioContext): Promise<void> {
    const existingPromise = moduleLoadPromises.get(audioContext);
    if (existingPromise) {
        await existingPromise;
        return;
    }

    const moduleURL = createCustomAudioWorkletModuleURL();
    const loadPromise = audioContext.audioWorklet.addModule(moduleURL)
        .finally(() => URL.revokeObjectURL(moduleURL));
    moduleLoadPromises.set(audioContext, loadPromise);
    try {
        await loadPromise;
    } catch (error) {
        moduleLoadPromises.delete(audioContext);
        throw error;
    }
}

/** Owns a message-based AudioWorklet output without requiring SharedArrayBuffer. */
export default class AudioWorkletController {
    public readonly configuration: AudioWorkletControllerConfiguration;

    private currentGeneration = INITIAL_GENERATION;
    private destroyed = false;
    private muted = false;
    private nextSequence = 1;
    private playing = false;
    private readonly node: AudioWorkletNode;
    private lastTelemetry: AudioWorkletTelemetry | null = null;
    private readonly telemetryListeners = new Set<AudioTelemetryListener>();
    private volume = 1;

    public constructor(node: AudioWorkletNode, configuration: AudioWorkletControllerConfiguration) {
        this.node = node;
        this.configuration = {
            channelCount: requirePositiveInteger(configuration.channelCount, 'Channel count'),
            maxBufferedFrames: requirePositiveInteger(
                configuration.maxBufferedFrames,
                'Maximum buffered frames'
            ),
            maxChunks: requirePositiveInteger(configuration.maxChunks, 'Maximum audio chunks'),
            sampleRate: requirePositiveInteger(configuration.sampleRate, 'Sample rate'),
            telemetryIntervalFrames: requirePositiveInteger(
                configuration.telemetryIntervalFrames,
                'Telemetry interval frames'
            )
        };
        if (this.configuration.channelCount > MAX_AUDIO_CHANNEL_COUNT) {
            throw new RangeError(`Channel count cannot exceed ${MAX_AUDIO_CHANNEL_COUNT}`);
        }
        if (this.configuration.maxChunks > MAX_AUDIO_WORKLET_CHUNKS) {
            throw new RangeError(`Maximum audio chunks cannot exceed ${MAX_AUDIO_WORKLET_CHUNKS}`);
        }
        this.node.port.addEventListener('message', this.handleMessage);
        this.node.port.start();
    }

    /** Loads the generated worklet module and connects it to the context output. */
    public static async create(
        audioContext: AudioContext,
        options: AudioWorkletControllerOptions
    ): Promise<AudioWorkletController> {
        if (typeof AudioWorkletNode === 'undefined') {
            throw new Error('AudioWorkletNode is unavailable');
        }

        const configuration = createConfiguration(audioContext, options);
        await loadAudioWorkletModule(audioContext);
        // eslint-disable-next-line compat/compat -- Custom playback is capability-gated
        const node = new AudioWorkletNode(audioContext, CUSTOM_AUDIO_WORKLET_PROCESSOR_NAME, {
            channelCount: configuration.channelCount,
            channelCountMode: 'explicit',
            numberOfInputs: 0,
            numberOfOutputs: 1,
            outputChannelCount: [ configuration.channelCount ],
            processorOptions: configuration
        });
        node.connect(audioContext.destination);
        return new AudioWorkletController(node, configuration);
    }

    public get generation(): number {
        return this.currentGeneration;
    }

    public get isPlaying(): boolean {
        return this.playing;
    }

    /** Returns the most recent processor telemetry without waiting for an event. */
    public getTelemetry(): AudioWorkletTelemetry | null {
        return this.lastTelemetry ? { ...this.lastTelemetry } : null;
    }

    /** Transfers one planar PCM chunk if its decoder generation is current. */
    public enqueue(chunk: TransferablePlanarPCM, generation: number): AudioEnqueueSubmission {
        this.requireActive();
        const frameCount = this.validateChunk(chunk);
        if (generation !== this.currentGeneration) {
            return { frameCount, sequence: null, status: 'stale-generation' };
        }

        if (frameCount > this.configuration.maxBufferedFrames) {
            return { frameCount, sequence: null, status: 'chunk-too-large' };
        }

        const sequence = this.nextSequence;
        if (sequence === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Audio enqueue sequence exhausted');
        }
        this.nextSequence += 1;

        const transferables: Transferable[] = [];
        for (const channel of chunk.channelData) {
            if (!(channel.buffer instanceof ArrayBuffer)) {
                throw new TypeError('Transferable PCM requires ArrayBuffer-backed channels');
            }
            if (transferables.indexOf(channel.buffer) < 0) {
                transferables.push(channel.buffer);
            }
        }

        const message: CustomAudioWorkletMessage = {
            channelData: chunk.channelData,
            generation,
            sequence,
            timestampMicroseconds: requireMicroseconds(chunk.timestampMicroseconds),
            type: 'enqueue'
        };
        this.node.port.postMessage(message, transferables);
        return { frameCount, sequence, status: 'submitted' };
    }

    /** Flushes queued audio and invalidates every older decoder generation. */
    public flush(mediaTimeMicroseconds: Microseconds): number {
        this.requireActive();
        this.currentGeneration = this.advanceGeneration();
        const message: CustomAudioWorkletMessage = {
            generation: this.currentGeneration,
            mediaTimeMicroseconds: requireMicroseconds(mediaTimeMicroseconds),
            type: 'flush'
        };
        this.node.port.postMessage(message);
        return this.currentGeneration;
    }

    /** Seeks by flushing audio at a new signed integer timestamp. */
    public seek(mediaTimeMicroseconds: Microseconds): number {
        return this.flush(mediaTimeMicroseconds);
    }

    public setPlaying(playing: boolean): void {
        this.requireActive();
        this.playing = playing;
        const message: CustomAudioWorkletMessage = { playing, type: 'playback' };
        this.node.port.postMessage(message);
    }

    public setVolume(volume: number): void {
        this.requireActive();
        if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
            throw new RangeError('Audio volume must be between zero and one');
        }
        this.volume = volume;
        this.postGain();
    }

    public setMuted(muted: boolean): void {
        this.requireActive();
        this.muted = muted;
        this.postGain();
    }

    /** Subscribes to processor acknowledgements and bounded-queue telemetry. */
    public onTelemetry(listener: AudioTelemetryListener): () => void {
        this.requireActive();
        this.telemetryListeners.add(listener);
        return () => this.telemetryListeners.delete(listener);
    }

    /** Releases the node and makes all subsequent controller operations invalid. */
    public destroy(): void {
        if (this.destroyed) {
            return;
        }
        const message: CustomAudioWorkletMessage = { type: 'destroy' };
        this.node.port.postMessage(message);
        this.node.port.removeEventListener('message', this.handleMessage);
        this.node.port.close();
        this.node.disconnect();
        this.telemetryListeners.clear();
        this.destroyed = true;
        this.currentGeneration = this.advanceGeneration();
    }

    private readonly handleMessage = (event: MessageEvent<unknown>): void => {
        if (this.destroyed || !this.isTelemetry(event.data)) {
            return;
        }

        this.lastTelemetry = { ...event.data };
        for (const listener of this.telemetryListeners) {
            listener(this.lastTelemetry);
        }
    };

    private isTelemetry(value: unknown): value is AudioWorkletTelemetry {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const candidate = value as Partial<AudioWorkletTelemetry>;
        return candidate.type === 'telemetry'
            && typeof candidate.generation === 'number'
            && typeof candidate.mediaTimeMicroseconds === 'number'
            && typeof candidate.queuedFrames === 'number';
    }

    private postGain(): void {
        const message: CustomAudioWorkletMessage = {
            muted: this.muted,
            type: 'gain',
            volume: this.volume
        };
        this.node.port.postMessage(message);
    }

    private validateChunk(chunk: TransferablePlanarPCM): number {
        requireMicroseconds(chunk.timestampMicroseconds);
        if (chunk.channelData.length !== this.configuration.channelCount) {
            throw new RangeError(`Expected ${this.configuration.channelCount} planar audio channels`);
        }

        const firstChannel = chunk.channelData[0];
        if (!(firstChannel instanceof Float32Array) || firstChannel.length === 0) {
            throw new RangeError('PCM chunks must contain at least one Float32 frame');
        }
        const frameCount = firstChannel.length;
        for (let channelIndex = 1; channelIndex < chunk.channelData.length; channelIndex += 1) {
            const channel = chunk.channelData[channelIndex];
            if (!(channel instanceof Float32Array) || channel.length !== frameCount) {
                throw new RangeError('All PCM channels must have the same frame count');
            }
        }
        return frameCount;
    }

    private requireActive(): void {
        if (this.destroyed) {
            throw new Error('Audio worklet controller is destroyed');
        }
    }

    private advanceGeneration(): number {
        if (this.currentGeneration === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Audio worklet generation exhausted');
        }
        return this.currentGeneration + 1;
    }
}
