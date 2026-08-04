import type { Microseconds } from '../MediaTime';
import {
    type AudioWorkletDeactivatedMessage,
    type AudioWorkletTelemetryReason,
    type AudioWorkletTelemetry,
    type AudioWorkletRetiredMessage,
    type CustomAudioWorkletMessage,
    type TransferablePlanarPCM
} from './AudioWorkletProtocol';
import {
    createCustomAudioWorkletModuleURL,
    CUSTOM_AUDIO_WORKLET_PROCESSOR_NAME
} from './AudioWorkletProcessorSource';
import {
    AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS,
    waitForBrowserAudioOperation
} from './BrowserAudioOperation';
import { CUSTOM_AUDIO_OUTPUT_CHANNEL_INTERPRETATION } from './CustomAudioOutputPolicy';
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

/** Structural session-facing contract for decoded PCM output control. */
export interface AudioWorkletOutputController {
    readonly configuration: AudioWorkletControllerConfiguration
    readonly generation: number
    readonly isPlaying: boolean
    enqueue: (chunk: TransferablePlanarPCM, generation: number) => AudioEnqueueSubmission
    flush: (mediaTimeMicroseconds: Microseconds) => number
    getTelemetry: () => AudioWorkletTelemetry | null
    onTelemetry: (listener: AudioTelemetryListener) => () => void
    seek: (mediaTimeMicroseconds: Microseconds) => number
    setMuted: (muted: boolean) => void
    setPlaying: (playing: boolean) => void
    setVolume: (volume: number) => void
}

const INITIAL_GENERATION = 1;
const moduleLoadPromises = new WeakMap<AudioContext, Promise<void>>();

function requirePositiveInteger(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
        throw new RangeError(`${label} must be a positive safe integer`);
    }
    return value;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isTelemetryReason(value: unknown): value is AudioWorkletTelemetryReason {
    switch (value) {
        case 'enqueue':
        case 'flush':
        case 'overflow':
        case 'periodic':
        case 'stale-generation':
        case 'underflow':
        case 'underflow-recovered':
            return true;
        default:
            return false;
    }
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
        await waitForBrowserAudioOperation(loadPromise, 'AudioWorklet module load');
    } catch (error) {
        moduleLoadPromises.delete(audioContext);
        throw error;
    }
}

/** Owns a message-based AudioWorklet output without requiring SharedArrayBuffer. */
export default class AudioWorkletController implements AudioWorkletOutputController {
    public readonly configuration: AudioWorkletControllerConfiguration;

    private currentGeneration = INITIAL_GENERATION;
    private deactivationFailed = false;
    private deactivationLeaseId: number | null = null;
    private deactivationPromise: Promise<void> | null = null;
    private deactivationRejecter: ((error: Error) => void) | null = null;
    private deactivationResolver: (() => void) | null = null;
    private destroyPromise: Promise<void> | null = null;
    private destroyed = false;
    private muted = false;
    private nextSequence = 1;
    private playing = false;
    private readonly node: AudioWorkletNode;
    private retirementResolver: (() => void) | null = null;
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
            channelInterpretation: CUSTOM_AUDIO_OUTPUT_CHANNEL_INTERPRETATION,
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
        if (!Number.isFinite(volume) || volume < 0) {
            throw new RangeError('Audio output gain must be finite and non-negative');
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

    /** Resets one completed lease without retiring the reusable processor. */
    public deactivate(leaseId: number): Promise<void> {
        const validatedLeaseId = requirePositiveInteger(leaseId, 'Audio worklet lease ID');
        if (this.deactivationPromise) {
            if (this.deactivationLeaseId === validatedLeaseId) {
                return this.deactivationPromise;
            }
            return Promise.reject(new Error('Audio worklet deactivation is already pending'));
        }
        this.requireActive();

        this.playing = false;
        this.currentGeneration = this.advanceGeneration();
        this.deactivationLeaseId = validatedLeaseId;
        const acknowledgmentPromise = new Promise<void>((resolve, reject): void => {
            this.deactivationResolver = resolve;
            this.deactivationRejecter = reject;
        });
        const message: CustomAudioWorkletMessage = {
            generation: this.currentGeneration,
            leaseId: validatedLeaseId,
            type: 'deactivate'
        };
        try {
            this.node.port.postMessage(message);
        } catch (error) {
            this.deactivationFailed = true;
            this.deactivationLeaseId = null;
            this.deactivationRejecter = null;
            this.deactivationResolver = null;
            return Promise.reject(error);
        }

        const deactivationPromise = waitForBrowserAudioOperation(
            acknowledgmentPromise,
            'AudioWorklet lease deactivation',
            AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS
        ).then(
            (): void => {
                this.lastTelemetry = null;
                this.muted = false;
                this.nextSequence = 1;
                this.volume = 1;
            },
            (error: unknown): never => {
                this.deactivationFailed = true;
                throw error;
            }
        ).finally((): void => {
            if (this.deactivationPromise === deactivationPromise) {
                this.deactivationLeaseId = null;
                this.deactivationPromise = null;
                this.deactivationRejecter = null;
                this.deactivationResolver = null;
            }
        });
        this.deactivationPromise = deactivationPromise;
        return deactivationPromise;
    }

    /** Retires the processor on its render thread before releasing the node. */
    public destroy(): Promise<void> {
        if (this.destroyPromise) {
            return this.destroyPromise;
        }
        this.deactivationRejecter?.(
            new Error('Audio worklet controller was destroyed during deactivation')
        );
        this.deactivationRejecter = null;
        const message: CustomAudioWorkletMessage = { type: 'destroy' };
        this.destroyed = true;
        this.playing = false;
        this.currentGeneration = this.advanceGeneration();
        this.telemetryListeners.clear();

        const retirementPromise = new Promise<void>((resolve): void => {
            this.retirementResolver = resolve;
        });
        try {
            this.node.port.postMessage(message);
        } catch (error) {
            try {
                this.finishDestroy();
            } catch {
                // Preserve the message-delivery failure
            }
            this.destroyPromise = Promise.reject(error);
            return this.destroyPromise;
        }

        const destroyPromise = waitForBrowserAudioOperation(
            retirementPromise,
            'AudioWorklet processor retirement',
            AUDIO_WORKLET_RETIREMENT_TIMEOUT_MICROSECONDS
        ).then((): void => {
            this.finishDestroy();
        }, (error: unknown): never => {
            try {
                this.finishDestroy();
            } catch {
                // Preserve the processor retirement failure
            }
            throw error;
        });
        this.destroyPromise = destroyPromise;
        return destroyPromise;
    }

    private readonly handleMessage = (event: MessageEvent<unknown>): void => {
        if (this.isDeactivatedMessage(event.data)) {
            if (event.data.leaseId === this.deactivationLeaseId) {
                this.deactivationResolver?.();
                this.deactivationResolver = null;
            }
            return;
        }
        if (this.isRetiredMessage(event.data)) {
            this.retirementResolver?.();
            this.retirementResolver = null;
            return;
        }
        if (this.destroyed || !this.isTelemetry(event.data)) {
            return;
        }

        this.lastTelemetry = { ...event.data };
        for (const listener of this.telemetryListeners) {
            listener(this.lastTelemetry);
        }
    };

    private finishDestroy(): void {
        let cleanupError: unknown;
        let cleanupFailed = false;
        this.deactivationLeaseId = null;
        this.deactivationRejecter = null;
        this.deactivationResolver = null;
        this.retirementResolver = null;
        try {
            this.node.port.removeEventListener('message', this.handleMessage);
        } catch (error) {
            cleanupError = error;
            cleanupFailed = true;
        }
        try {
            this.node.port.close();
        } catch (error) {
            if (!cleanupFailed) {
                cleanupError = error;
                cleanupFailed = true;
            }
        }
        try {
            this.node.disconnect();
        } catch (error) {
            if (!cleanupFailed) {
                cleanupError = error;
                cleanupFailed = true;
            }
        }
        if (cleanupFailed) {
            throw cleanupError;
        }
    }

    private isDeactivatedMessage(value: unknown): value is AudioWorkletDeactivatedMessage {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const message = value as Partial<AudioWorkletDeactivatedMessage>;
        return message.type === 'deactivated'
            && typeof message.leaseId === 'number'
            && Number.isSafeInteger(message.leaseId)
            && message.leaseId > 0;
    }

    private isRetiredMessage(value: unknown): value is AudioWorkletRetiredMessage {
        return Boolean(value)
            && typeof value === 'object'
            && (value as Partial<AudioWorkletRetiredMessage>).type === 'retired';
    }

    private isTelemetry(value: unknown): value is AudioWorkletTelemetry {
        if (!value || typeof value !== 'object') {
            return false;
        }
        const candidate = value as Partial<AudioWorkletTelemetry>;
        return candidate.type === 'telemetry'
            && typeof candidate.generation === 'number'
            && Number.isSafeInteger(candidate.generation)
            && candidate.generation > 0
            && candidate.hasPhysicalOutputTimeCorrelation === false
            && (candidate.mediaTimeContextTimeMicroseconds === null
                || isNonNegativeSafeInteger(candidate.mediaTimeContextTimeMicroseconds))
            && typeof candidate.mediaTimeMicroseconds === 'number'
            && Number.isSafeInteger(candidate.mediaTimeMicroseconds)
            && isNonNegativeSafeInteger(candidate.consumedFrames)
            && isNonNegativeSafeInteger(candidate.droppedFrames)
            && isNonNegativeSafeInteger(candidate.outputFrames)
            && isNonNegativeSafeInteger(candidate.overflowEvents)
            && isNonNegativeSafeInteger(candidate.overflowFrames)
            && typeof candidate.muted === 'boolean'
            && typeof candidate.playing === 'boolean'
            && isNonNegativeSafeInteger(candidate.queuedFrames)
            && isTelemetryReason(candidate.reason)
            && (candidate.sequence === null
                || (typeof candidate.sequence === 'number'
                    && Number.isSafeInteger(candidate.sequence)
                    && candidate.sequence > 0))
            && this.isSignalTelemetry(candidate.signal)
            && isNonNegativeSafeInteger(candidate.staleChunks)
            && isNonNegativeSafeInteger(candidate.underflowEvents)
            && isNonNegativeSafeInteger(candidate.underflowFrames)
            && typeof candidate.volume === 'number'
            && Number.isFinite(candidate.volume)
            && candidate.volume >= 0;
    }

    private isSignalTelemetry(
        value: AudioWorkletTelemetry['signal'] | undefined
    ): boolean {
        if (value === undefined) {
            return true;
        }
        return isNonNegativeSafeInteger(value.analyzedFrameCount)
            && isNonNegativeSafeInteger(value.analyzedSampleCount)
            && isNonNegativeSafeInteger(value.clippedSampleCount)
            && isNonNegativeSafeInteger(value.nonFiniteSampleCount)
            && Number.isFinite(value.samplePeak)
            && value.samplePeak >= 0
            && Number.isFinite(value.sampleSquareSum)
            && value.sampleSquareSum >= 0;
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
        if (this.deactivationFailed) {
            throw new Error('Audio worklet controller deactivation failed');
        }
        if (this.deactivationPromise) {
            throw new Error('Audio worklet controller is deactivating');
        }
    }

    private advanceGeneration(): number {
        if (this.currentGeneration === Number.MAX_SAFE_INTEGER) {
            throw new RangeError('Audio worklet generation exhausted');
        }
        return this.currentGeneration + 1;
    }
}
