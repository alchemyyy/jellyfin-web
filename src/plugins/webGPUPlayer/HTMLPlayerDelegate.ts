import { HtmlVideoPlayer } from 'plugins/htmlVideoPlayer/plugin';
import Events from 'utils/events';

import {
    getWebGPUAudioOutputManager,
    type WebGPUAudioOutputManager,
    type WebGPUAudioOutputTargetLease
} from './WebGPUAudioOutputManager';

export const HTML_PLAYER_EVENTS = [
    'beginFetch',
    'endFetch',
    'timeupdate',
    'volumechange',
    'playing',
    'unpause',
    'click',
    'dblclick',
    'pause',
    'waiting',
    'brightnesschange',
    'error',
    'stopped'
] as const;

type HTMLPlayerEventName = typeof HTML_PLAYER_EVENTS[number];
type PlayerEvent = { type: string };
type PlayerEventHandler = (event: PlayerEvent, ...eventArguments: unknown[]) => void;
type BackendStoppedHandler = (generation: number) => void;
type BackendErrorHandler = (generation: number) => void;

type DeferredStop = {
    promise: Promise<unknown>
    reject: (reason?: unknown) => void
    resolve: (value: unknown) => void
};

/** Owns one HTML player backend and bridges its session events to a stable owner. */
export class HTMLPlayerDelegate {
    readonly player: HtmlVideoPlayer;

    private readonly eventTarget: object;
    private readonly backendStoppedHandler: BackendStoppedHandler;
    private readonly backendErrorHandler: BackendErrorHandler;
    private readonly eventHandlers = new Map<HTMLPlayerEventName, PlayerEventHandler>();
    private readonly audioOutputManager: WebGPUAudioOutputManager;

    private audioOutputElement: HTMLMediaElement | null = null;
    private audioOutputRevision = 0;
    private audioOutputTargetLease: WebGPUAudioOutputTargetLease | null = null;
    private forwardingGeneration: number | null = null;
    private sessionGeneration: number | null = null;
    private stopGeneration: number | null = null;
    private reusableStop: DeferredStop | null = null;
    private destructiveStopPromise: Promise<unknown> | null = null;
    private destructiveStopInvocationGeneration: number | null = null;
    private destroyClaimedGeneration: number | null = null;

    constructor(
        eventTarget: object,
        backendStoppedHandler: BackendStoppedHandler,
        backendErrorHandler: BackendErrorHandler,
        audioOutputManager: WebGPUAudioOutputManager = getWebGPUAudioOutputManager()
    ) {
        this.eventTarget = eventTarget;
        this.backendStoppedHandler = backendStoppedHandler;
        this.backendErrorHandler = backendErrorHandler;
        this.audioOutputManager = audioOutputManager;
        this.player = new HtmlVideoPlayer(eventTarget, true, true, this.prepareAudioOutput);
    }

    /** Starts event forwarding for a new backend playback session. */
    beginSession(generation: number): void {
        this.detachEventHandlers();
        this.releaseAudioOutputTarget();
        this.forwardingGeneration = generation;
        this.sessionGeneration = generation;
        this.stopGeneration = null;
        this.reusableStop = null;
        this.destructiveStopPromise = null;
        this.destructiveStopInvocationGeneration = null;
        this.destroyClaimedGeneration = null;

        for (const eventName of HTML_PLAYER_EVENTS) {
            const eventHandler: PlayerEventHandler = (_event, ...eventArguments) => {
                if (this.forwardingGeneration !== generation) {
                    return;
                }

                if (eventName === 'error') {
                    this.forwardingGeneration = null;
                    this.detachEventHandlers();
                    this.releaseAudioOutputTarget();
                    this.backendErrorHandler(generation);
                    Events.trigger(this.eventTarget, eventName, eventArguments);
                    return;
                }

                if (eventName !== 'stopped') {
                    Events.trigger(this.eventTarget, eventName, eventArguments);
                    return;
                }

                // Retire this session before notifying listeners so nested stop
                // or play calls cannot forward the same backend stop again.
                this.forwardingGeneration = null;
                this.detachEventHandlers();
                this.releaseAudioOutputTarget();
                this.backendStoppedHandler(generation);
                Events.trigger(this.eventTarget, eventName, eventArguments);
            };

            this.eventHandlers.set(eventName, eventHandler);
            Events.on(this.player, eventName, eventHandler);
        }
    }

    /** Cancels asynchronous source setup without replacing the owned backend. */
    cancelPendingPlay(): void {
        this.player.cancelPendingPlay();
    }

    /** Stops each reusable or destructive phase of the backend session once. */
    stop(generation: number, destroyPlayer: boolean): Promise<unknown> {
        if (this.stopGeneration !== generation) {
            this.stopGeneration = generation;
            this.reusableStop = null;
            this.destructiveStopPromise = null;
        }

        if (destroyPlayer) {
            return this.stopDestructively(generation);
        }

        if (this.destructiveStopPromise) {
            return this.destructiveStopPromise;
        }

        if (this.reusableStop) {
            return this.reusableStop.promise;
        }

        const deferredStop = this.createDeferredStop();
        this.reusableStop = deferredStop;
        this.startBackendStop(generation, false, deferredStop);
        return deferredStop.promise;
    }

    /** Destroys backend resources at most once for the current session. */
    destroy(generation: number): void {
        if (this.sessionGeneration !== generation) {
            return;
        }

        if (
            this.destroyClaimedGeneration === generation
            || this.destructiveStopInvocationGeneration === generation
        ) {
            this.forwardingGeneration = null;
            this.detachEventHandlers();
            return;
        }

        this.destroyClaimedGeneration = generation;
        this.releaseAudioOutputTarget();
        try {
            this.player.destroy();
            this.resolveReusableStop(undefined);
        } catch (error) {
            this.destroyClaimedGeneration = null;
            throw error;
        } finally {
            this.forwardingGeneration = null;
            this.detachEventHandlers();
        }
    }

    /** Invalidates event forwarding for a playback attempt that did not start. */
    endSession(generation: number): void {
        if (this.forwardingGeneration !== generation) {
            return;
        }

        this.forwardingGeneration = null;
        this.detachEventHandlers();
        this.releaseAudioOutputTarget();
    }

    private stopDestructively(generation: number): Promise<unknown> {
        if (this.destructiveStopPromise) {
            return this.destructiveStopPromise;
        }

        const deferredStop = this.createDeferredStop();
        this.destructiveStopPromise = deferredStop.promise;
        this.startBackendStop(generation, true, deferredStop);
        return deferredStop.promise;
    }

    private startBackendStop(
        generation: number,
        destroyPlayer: boolean,
        deferredStop: DeferredStop
    ): void {
        if (this.sessionGeneration !== generation) {
            deferredStop.resolve(undefined);
            return;
        }

        let stopResult: unknown;
        if (destroyPlayer) {
            // HtmlVideoPlayer emits `stopped` before its synchronous destroy.
            // Suppress wrapper teardown only while that call is on the stack.
            this.destructiveStopInvocationGeneration = generation;
        }

        // Backend stop must run synchronously so `stopped` ordering is preserved
        // eslint-disable-next-line sonarjs/no-try-promise
        try {
            stopResult = this.player.stop(destroyPlayer);
            if (destroyPlayer) {
                this.destroyClaimedGeneration = generation;
            }
        } catch (error) {
            if (this.destructiveStopInvocationGeneration === generation) {
                this.destructiveStopInvocationGeneration = null;
            }
            if (destroyPlayer) {
                this.destroyAfterFailedStop(generation);
                this.rejectReusableStop(error);
            }
            this.endSession(generation);
            deferredStop.reject(error);
            return;
        } finally {
            if (this.destructiveStopInvocationGeneration === generation) {
                this.destructiveStopInvocationGeneration = null;
            }
        }

        void Promise.resolve(stopResult).then(
            value => {
                this.endSession(generation);
                if (destroyPlayer) {
                    this.resolveReusableStop(value);
                }
                deferredStop.resolve(value);
            },
            error => {
                if (destroyPlayer) {
                    if (this.destroyClaimedGeneration === generation) {
                        this.destroyClaimedGeneration = null;
                    }
                    this.destroyAfterFailedStop(generation);
                    this.rejectReusableStop(error);
                }
                this.endSession(generation);
                deferredStop.reject(error);
            }
        );
    }

    private destroyAfterFailedStop(generation: number): void {
        if (this.sessionGeneration !== generation) {
            return;
        }

        try {
            this.destroy(generation);
        } catch (error) {
            console.warn('HTML player cleanup after a failed stop also failed', error);
        }
    }

    private resolveReusableStop(value: unknown): void {
        this.reusableStop?.resolve(value);
    }

    private rejectReusableStop(error: unknown): void {
        this.reusableStop?.reject(error);
    }

    private createDeferredStop(): DeferredStop {
        let rejectStop: (reason?: unknown) => void = () => undefined;
        let resolveStop: (value: unknown) => void = () => undefined;
        const promise = new Promise<unknown>((resolve, reject) => {
            rejectStop = reject;
            resolveStop = resolve;
        });

        return {
            promise,
            reject: rejectStop,
            resolve: resolveStop
        };
    }

    private detachEventHandlers(): void {
        for (const [eventName, eventHandler] of this.eventHandlers) {
            Events.off(this.player, eventName, eventHandler);
        }

        this.eventHandlers.clear();
    }

    private readonly prepareAudioOutput = async (
        mediaElement: HTMLMediaElement
    ): Promise<void> => {
        if (this.audioOutputElement === mediaElement && this.audioOutputTargetLease) {
            await this.audioOutputTargetLease.ready;
            return;
        }

        const revision = this.audioOutputRevision + 1;
        this.audioOutputRevision = revision;
        const previousTargetLease = this.audioOutputTargetLease;
        this.audioOutputElement = null;
        this.audioOutputTargetLease = null;
        await previousTargetLease?.release();
        if (this.audioOutputRevision !== revision) {
            return;
        }

        const targetLease = this.audioOutputManager.registerMediaElement(mediaElement);
        this.audioOutputElement = mediaElement;
        this.audioOutputTargetLease = targetLease;
        await targetLease.ready;
        if (this.audioOutputRevision !== revision
            || this.audioOutputElement !== mediaElement
            || this.audioOutputTargetLease !== targetLease) {
            await targetLease.release();
        }
    };

    private releaseAudioOutputTarget(): void {
        this.audioOutputRevision += 1;
        this.audioOutputElement = null;
        const targetLease = this.audioOutputTargetLease;
        this.audioOutputTargetLease = null;
        void targetLease?.release();
    }
}
