export const SYSTEM_DEFAULT_AUDIO_OUTPUT_DEVICE_ID = '';
const ENUMERATED_DEFAULT_AUDIO_OUTPUT_DEVICE_ID = 'default';
const MAXIMUM_AUDIO_OUTPUT_DEVICE_ID_LENGTH = 1_024;

type AudioContextWithSink = AudioContext & {
    readonly sinkId?: string
    setSinkId?: (sinkId: string) => Promise<void>
};

type MediaDevicesWithAudioOutputSelection = MediaDevices & {
    selectAudioOutput?: (
        options?: Readonly<{ deviceId?: string }>
    ) => Promise<MediaDeviceInfo>
};

type RoutingTargetKind = 'audio-context' | 'media-element';

type RoutingLeaseState = {
    intendedRunning: boolean
    readyResolved: boolean
    resolveReady: () => void
};

type RoutingTarget = {
    readonly failedSinkIds: Set<string>
    hasAppliedSink: boolean
    readonly identity: object
    readonly kind: RoutingTargetKind
    lastDeviceChangeGeneration: number
    readonly leases: Map<number, RoutingLeaseState>
    lastAppliedSinkId: string
    lastProcessedRevision: number
    readonly resume?: () => Promise<void>
    routeRecoveryRequired: boolean
    readonly setSinkId?: (sinkId: string) => Promise<void>
    removeErrorListener?: () => void
};

type RoutingDecision = {
    deviceChangeGeneration: number | null
    fallbackDeviceId: string | null
    preserveExistingRoutes: boolean
    requestedSinkId: string
    selectedDeviceAvailability: 'available' | 'unavailable' | 'unknown'
};

type RoutingSummary = {
    appliedSinkId: string | null
    routeFailure: unknown
    targetCount: number
    usedFallback: boolean
};

type TargetRoutingResult = {
    error?: unknown
    success: boolean
    usedFallback: boolean
};

type CandidateRoutingResult =
    | { status: 'stale' }
    | { error: unknown, status: 'failed' }
    | { status: 'success' };

export type WebGPUAudioOutputDevice = Readonly<{
    deviceId: string
    label: string
}>;

export type WebGPUAudioOutputDeviceAvailability =
    | 'active'
    | 'available'
    | 'unavailable'
    | 'unknown';

export type WebGPUAudioOutputMessageCode =
    | 'applying'
    | 'default-active'
    | 'default-enumeration-failed'
    | 'default-fallback'
    | 'default-saved'
    | 'picker-cancelled'
    | 'picker-failed'
    | 'picker-invalid-device'
    | 'picker-not-allowed'
    | 'picker-not-found'
    | 'picker-unavailable'
    | 'picker-user-action-required'
    | 'route-failed'
    | 'selected-active'
    | 'selected-enumeration-failed'
    | 'selected-fallback'
    | 'selected-saved'
    | 'selected-unavailable-default'
    | 'selected-unavailable-fallback';

export type WebGPUAudioOutputStatus =
    | 'applying'
    | 'default'
    | 'error'
    | 'fallback'
    | 'inactive'
    | 'selected'
    | 'unsupported';

export type WebGPUAudioOutputSnapshot = Readonly<{
    activeDeviceId: string | null
    devices: readonly WebGPUAudioOutputDevice[]
    messageCode: WebGPUAudioOutputMessageCode
    pickerAvailable: boolean
    selectedDeviceAvailability: WebGPUAudioOutputDeviceAvailability
    selectedDeviceId: string | null
    status: WebGPUAudioOutputStatus
}>;

export type WebGPUAudioOutputTargetLease = {
    readonly ready: Promise<void>
    release: () => Promise<void>
    setIntendedRunning: (intendedRunning: boolean) => Promise<void>
};

export type WebGPUAudioOutputManagerOptions = Readonly<{
    getMediaDevices?: () => MediaDevicesWithAudioOutputSelection | null
    initialSelectedDeviceId?: string | null
}>;

function getDefaultMediaDevices(): MediaDevicesWithAudioOutputSelection | null {
    // eslint-disable-next-line compat/compat -- Feature-detected secure-context API
    return globalThis.navigator?.mediaDevices as MediaDevicesWithAudioOutputSelection | undefined
        ?? null;
}

function normalizeSelectedDeviceId(deviceId: string | null | undefined): string | null {
    if (!deviceId
        || deviceId === ENUMERATED_DEFAULT_AUDIO_OUTPUT_DEVICE_ID
        || deviceId.length > MAXIMUM_AUDIO_OUTPUT_DEVICE_ID_LENGTH
        || deviceId.includes('\0')) {
        return null;
    }
    return deviceId;
}

function getErrorName(error: unknown): string {
    return error instanceof DOMException || error instanceof Error ? error.name : '';
}

function getPickerFailureMessageCode(error: unknown): WebGPUAudioOutputMessageCode {
    switch (getErrorName(error)) {
        case 'AbortError':
            return 'picker-cancelled';
        case 'InvalidStateError':
            return 'picker-user-action-required';
        case 'NotAllowedError':
            return 'picker-not-allowed';
        case 'NotFoundError':
            return 'picker-not-found';
        default:
            return 'picker-failed';
    }
}

/** Coordinates one document-wide output preference across every WebGPU audio sink. */
export class WebGPUAudioOutputManager {
    private activeDeviceId: string | null = null;
    private devices: readonly WebGPUAudioOutputDevice[] = [];
    private destroyed = false;
    private deviceChangeGeneration = 0;
    private deviceChangeListening = false;
    private deviceEnumerationPending = false;
    private hasSuccessfulDeviceEnumeration = false;
    private lastClearedDeviceChangeGeneration = 0;
    private nextLeaseIdentifier = 1;
    private operationTail: Promise<void> = Promise.resolve();
    private pendingDeviceChangeGeneration: number | null = null;
    private pickerRequestRevision = 0;
    private readonly getMediaDevices: () => MediaDevicesWithAudioOutputSelection | null;
    private readonly listeners = new Set<(snapshot: WebGPUAudioOutputSnapshot) => void>();
    private readonly routingTargets = new Map<object, RoutingTarget>();
    private revision = 0;
    private selectedDeviceAvailability: WebGPUAudioOutputDeviceAvailability = 'unknown';
    private selectedDeviceId: string | null;
    private snapshotMessageCode: WebGPUAudioOutputMessageCode = 'default-saved';
    private snapshotStatus: WebGPUAudioOutputStatus = 'inactive';

    public constructor(options: WebGPUAudioOutputManagerOptions = {}) {
        this.getMediaDevices = options.getMediaDevices ?? getDefaultMediaDevices;
        this.selectedDeviceId = normalizeSelectedDeviceId(options.initialSelectedDeviceId);
        if (this.selectedDeviceId) {
            this.snapshotMessageCode = 'selected-saved';
        }
    }

    public getSnapshot(): WebGPUAudioOutputSnapshot {
        const mediaDevices = this.getMediaDevices();
        return {
            activeDeviceId: this.activeDeviceId,
            devices: this.devices.map(device => ({ ...device })),
            messageCode: this.snapshotMessageCode,
            pickerAvailable: typeof mediaDevices?.selectAudioOutput === 'function',
            selectedDeviceAvailability: this.selectedDeviceAvailability,
            selectedDeviceId: this.selectedDeviceId,
            status: this.snapshotStatus
        };
    }

    /** Starts device observation and returns an idempotent snapshot subscription. */
    public subscribe(listener: (snapshot: WebGPUAudioOutputSnapshot) => void): () => void {
        this.requireUsable();
        this.listeners.add(listener);
        this.ensureDeviceChangeListener();
        this.notifyListener(listener, this.getSnapshot());
        void this.refresh();
        return (): void => {
            this.listeners.delete(listener);
        };
    }

    /** Re-enumerates permitted outputs and reconciles every current sink. */
    public refresh(): Promise<void> {
        this.requireUsable();
        this.ensureDeviceChangeListener();
        return this.scheduleReconciliation(true);
    }

    /** Changes the desired opaque device ID without persisting presentation labels. */
    public setSelectedDeviceId(deviceId: string | null): Promise<void> {
        this.requireUsable();
        this.cancelAudioOutputSelectionRequest();
        this.selectedDeviceId = normalizeSelectedDeviceId(deviceId);
        this.selectedDeviceAvailability = 'unknown';
        this.clearFailedSinkIds();
        this.ensureDeviceChangeListener();
        return this.scheduleReconciliation(true);
    }

    /** Invalidates an outstanding browser picker request without changing the preference. */
    public cancelAudioOutputSelectionRequest(): void {
        if (!this.destroyed) {
            this.pickerRequestRevision += 1;
        }
    }

    /** Opens the browser picker synchronously from its caller's user activation. */
    public requestAudioOutputSelection(): Promise<string | null> {
        this.requireUsable();
        const requestRevision = this.pickerRequestRevision + 1;
        this.pickerRequestRevision = requestRevision;
        const mediaDevices = this.getMediaDevices();
        const selectAudioOutput = mediaDevices?.selectAudioOutput;
        if (!mediaDevices || typeof selectAudioOutput !== 'function') {
            if (this.isPickerRequestCurrent(requestRevision)) {
                this.setSnapshot('unsupported', 'picker-unavailable');
            }
            return Promise.resolve(null);
        }

        let selectionPromise: Promise<MediaDeviceInfo>;
        // eslint-disable-next-line sonarjs/no-try-promise -- Picker can throw before returning
        try {
            const options = this.selectedDeviceId ?
                { deviceId: this.selectedDeviceId } :
                undefined;
            selectionPromise = selectAudioOutput.call(mediaDevices, options);
        } catch (error) {
            if (this.isPickerRequestCurrent(requestRevision)) {
                this.setSnapshot('error', getPickerFailureMessageCode(error));
            }
            return Promise.resolve(null);
        }

        return selectionPromise.then(selectedDevice => {
            if (!this.isPickerRequestCurrent(requestRevision)
                || selectedDevice.kind !== 'audiooutput') {
                return null;
            }
            const selectedDeviceId = normalizeSelectedDeviceId(selectedDevice.deviceId);
            if (!selectedDeviceId) {
                this.setSnapshot('error', 'picker-invalid-device');
                return null;
            }
            return selectedDeviceId;
        }).catch((error: unknown): null => {
            if (this.isPickerRequestCurrent(requestRevision)) {
                this.setSnapshot('error', getPickerFailureMessageCode(error));
            }
            return null;
        });
    }

    /** Registers an exact AudioContext generation before its worklet becomes active. */
    public registerAudioContext(audioContext: AudioContext): WebGPUAudioOutputTargetLease {
        const audioContextWithSink = audioContext as AudioContextWithSink;
        return this.registerTarget({
            failedSinkIds: new Set<string>(),
            hasAppliedSink: false,
            identity: audioContext,
            kind: 'audio-context',
            lastDeviceChangeGeneration: 0,
            lastAppliedSinkId: SYSTEM_DEFAULT_AUDIO_OUTPUT_DEVICE_ID,
            lastProcessedRevision: 0,
            leases: new Map<number, RoutingLeaseState>(),
            resume: (): Promise<void> => audioContext.resume(),
            routeRecoveryRequired: false,
            setSinkId: typeof audioContextWithSink.setSinkId === 'function' ?
                (sinkId: string): Promise<void> => audioContextWithSink.setSinkId?.call(
                    audioContext,
                    sinkId
                ) ?? Promise.resolve() :
                undefined
        });
    }

    /** Registers an owned media element before a source can autoplay. */
    public registerMediaElement(
        mediaElement: HTMLMediaElement
    ): WebGPUAudioOutputTargetLease {
        return this.registerTarget({
            failedSinkIds: new Set<string>(),
            hasAppliedSink: false,
            identity: mediaElement,
            kind: 'media-element',
            lastDeviceChangeGeneration: 0,
            lastAppliedSinkId: SYSTEM_DEFAULT_AUDIO_OUTPUT_DEVICE_ID,
            lastProcessedRevision: 0,
            leases: new Map<number, RoutingLeaseState>(),
            routeRecoveryRequired: false,
            setSinkId: typeof mediaElement.setSinkId === 'function' ?
                (sinkId: string): Promise<void> => mediaElement.setSinkId(sinkId) :
                undefined
        });
    }

    /** Releases listeners and drains routing work. Intended for deterministic tests. */
    public async destroy(): Promise<void> {
        if (this.destroyed) {
            return;
        }
        this.destroyed = true;
        this.revision += 1;
        this.pickerRequestRevision += 1;
        const mediaDevices = this.getMediaDevices();
        if (this.deviceChangeListening && mediaDevices) {
            mediaDevices.removeEventListener('devicechange', this.handleDeviceChange);
        }
        this.deviceChangeListening = false;
        for (const target of this.routingTargets.values()) {
            target.removeErrorListener?.();
            for (const leaseState of target.leases.values()) {
                this.resolveLeaseReady(leaseState);
            }
        }
        this.routingTargets.clear();
        this.listeners.clear();
        await this.operationTail.catch((): void => undefined);
    }

    private registerTarget(newTarget: RoutingTarget): WebGPUAudioOutputTargetLease {
        this.requireUsable();
        this.ensureDeviceChangeListener();
        let target = this.routingTargets.get(newTarget.identity);
        if (!target) {
            target = newTarget;
            this.routingTargets.set(target.identity, target);
            if (target.kind === 'audio-context') {
                const eventTarget = target.identity as EventTarget;
                const handleError = (): void => {
                    this.handleAudioContextError(target as RoutingTarget);
                };
                eventTarget.addEventListener('error', handleError);
                target.removeErrorListener = (): void => {
                    eventTarget.removeEventListener('error', handleError);
                };
            }
        }
        const registeredTarget = target;
        const leaseIdentifier = this.nextLeaseIdentifier;
        this.nextLeaseIdentifier += 1;
        let resolveReadyPromise: (() => void) | null = null;
        const ready = new Promise<void>((resolve): void => {
            resolveReadyPromise = resolve;
        });
        if (!resolveReadyPromise) {
            throw new Error('Audio output route readiness resolver was not initialized');
        }
        const leaseState: RoutingLeaseState = {
            intendedRunning: false,
            readyResolved: false,
            resolveReady: resolveReadyPromise
        };
        registeredTarget.leases.set(leaseIdentifier, leaseState);
        void this.scheduleReconciliation(this.devices.length === 0);
        let releasePromise: Promise<void> | null = null;
        return {
            ready,
            release: (): Promise<void> => {
                if (!releasePromise) {
                    releasePromise = this.releaseTargetLease(
                        registeredTarget,
                        leaseIdentifier,
                        leaseState
                    );
                }
                return releasePromise;
            },
            setIntendedRunning: (intendedRunning: boolean): Promise<void> => {
                if (releasePromise) {
                    return Promise.resolve();
                }
                const currentLeaseState = registeredTarget.leases.get(leaseIdentifier);
                if (!currentLeaseState
                    || currentLeaseState.intendedRunning === intendedRunning) {
                    return Promise.resolve();
                }
                currentLeaseState.intendedRunning = intendedRunning;
                return Promise.resolve();
            }
        };
    }

    private async releaseTargetLease(
        target: RoutingTarget,
        leaseIdentifier: number,
        leaseState: RoutingLeaseState
    ): Promise<void> {
        target.leases.delete(leaseIdentifier);
        if (target.leases.size === 0
            && this.routingTargets.get(target.identity) === target) {
            target.removeErrorListener?.();
            this.routingTargets.delete(target.identity);
        }
        if (!this.destroyed) {
            await this.scheduleReconciliation(false);
        } else {
            await this.operationTail.catch((): void => undefined);
        }
        this.resolveLeaseReady(leaseState);
    }

    private scheduleReconciliation(enumerateDevices: boolean): Promise<void> {
        this.deviceEnumerationPending ||= enumerateDevices;
        const requestedRevision = this.revision + 1;
        this.revision = requestedRevision;
        const operation = this.operationTail.then((): Promise<void> => (
            this.reconcile(requestedRevision, enumerateDevices)
        ));
        this.operationTail = operation.catch((): void => undefined);
        return operation.catch((): void => undefined);
    }

    private async reconcile(requestedRevision: number, enumerateDevices: boolean): Promise<void> {
        if (!this.isRevisionCurrent(requestedRevision)) {
            return;
        }

        const deviceChangeGeneration = this.pendingDeviceChangeGeneration;
        const enumerationFailed = enumerateDevices || this.deviceEnumerationPending ?
            await this.refreshDevicesForRevision(
                requestedRevision,
                deviceChangeGeneration
            ) :
            false;
        if (enumerationFailed === null) {
            return;
        }
        const decision = this.createRoutingDecision(
            enumerationFailed,
            deviceChangeGeneration
        );
        const routingSummary = await this.routeTargets(decision, requestedRevision);
        if (!routingSummary || !this.isRevisionCurrent(requestedRevision)) {
            return;
        }
        try {
            this.publishRoutingStatus(decision, routingSummary, enumerationFailed);
        } finally {
            if (this.isRevisionCurrent(requestedRevision)) {
                if (this.pendingDeviceChangeGeneration === deviceChangeGeneration) {
                    this.pendingDeviceChangeGeneration = null;
                }
                this.resolveReadyLeases(requestedRevision);
            }
        }
    }

    private async refreshDevicesForRevision(
        requestedRevision: number,
        deviceChangeGeneration: number | null
    ): Promise<boolean | null> {
        const mediaDevices = this.getMediaDevices();
        if (!mediaDevices?.enumerateDevices) {
            return true;
        }
        this.setSnapshot('applying', 'applying');
        try {
            const devices = await mediaDevices.enumerateDevices();
            if (!this.isRevisionCurrent(requestedRevision)) {
                return null;
            }
            this.devices = this.normalizeDevices(devices);
            this.deviceEnumerationPending = false;
            this.hasSuccessfulDeviceEnumeration = true;
            if (deviceChangeGeneration === null
                || this.lastClearedDeviceChangeGeneration < deviceChangeGeneration) {
                this.clearFailedSinkIds();
                if (deviceChangeGeneration !== null) {
                    this.lastClearedDeviceChangeGeneration = deviceChangeGeneration;
                }
            }
            return false;
        } catch {
            if (!this.isRevisionCurrent(requestedRevision)) {
                return null;
            }
            return true;
        }
    }

    private createRoutingDecision(
        enumerationFailed: boolean,
        deviceChangeGeneration: number | null
    ): RoutingDecision {
        let selectedDeviceAvailability: RoutingDecision['selectedDeviceAvailability'] =
            'unavailable';
        if (this.selectedDeviceId) {
            if (enumerationFailed || !this.hasSuccessfulDeviceEnumeration) {
                selectedDeviceAvailability = 'unknown';
            } else if (this.devices.some(device => (
                device.deviceId === this.selectedDeviceId
            ))) {
                selectedDeviceAvailability = 'available';
            }
        }
        const requestSelectedDevice = this.selectedDeviceId !== null
            && selectedDeviceAvailability !== 'unavailable';
        return {
            deviceChangeGeneration,
            fallbackDeviceId: this.devices.find(device => (
                device.deviceId !== this.selectedDeviceId
            ))?.deviceId ?? null,
            preserveExistingRoutes: enumerationFailed,
            requestedSinkId: requestSelectedDevice ?
                this.selectedDeviceId as string :
                SYSTEM_DEFAULT_AUDIO_OUTPUT_DEVICE_ID,
            selectedDeviceAvailability
        };
    }

    private async routeTargets(
        decision: RoutingDecision,
        requestedRevision: number
    ): Promise<RoutingSummary | null> {
        let appliedSinkId: string | null = null;
        let routeFailure: unknown = null;
        let targetCount = 0;
        let usedFallback = false;
        for (const target of this.routingTargets.values()) {
            if (!this.isTargetCurrent(target, requestedRevision)) {
                return null;
            }
            const result = await this.applyTargetSink(
                target,
                decision,
                requestedRevision
            );
            if (!result) {
                return null;
            }
            target.lastProcessedRevision = requestedRevision;
            targetCount += 1;
            if (!result.success) {
                routeFailure = result.error;
            }
            if (target.hasAppliedSink) {
                appliedSinkId = target.lastAppliedSinkId || null;
            }
            usedFallback ||= result.usedFallback;
        }
        return { appliedSinkId, routeFailure, targetCount, usedFallback };
    }

    private publishRoutingStatus(
        decision: RoutingDecision,
        summary: RoutingSummary,
        enumerationFailed: boolean
    ): void {
        this.activeDeviceId = summary.appliedSinkId;
        this.selectedDeviceAvailability = this.resolveSelectedDeviceAvailability(
            decision,
            summary
        );
        if (summary.targetCount === 0) {
            this.publishInactiveStatus();
            return;
        }
        if (summary.routeFailure) {
            this.publishRouteFailureStatus();
            return;
        }
        if (this.isSelectedDeviceUnavailable(decision)) {
            this.publishUnavailableStatus(summary.usedFallback);
            return;
        }
        if (summary.usedFallback) {
            this.publishFallbackStatus();
            return;
        }
        if (enumerationFailed) {
            this.publishEnumerationFailureStatus();
            return;
        }
        if (this.selectedDeviceId) {
            this.setSnapshot('selected', 'selected-active');
            return;
        }
        this.setSnapshot('default', 'default-active');
    }

    private resolveSelectedDeviceAvailability(
        decision: RoutingDecision,
        summary: RoutingSummary
    ): WebGPUAudioOutputDeviceAvailability {
        if (!this.selectedDeviceId) {
            return 'unknown';
        }
        if (!summary.routeFailure
            && summary.targetCount > 0
            && !summary.usedFallback
            && summary.appliedSinkId === this.selectedDeviceId) {
            return 'active';
        }
        return decision.selectedDeviceAvailability;
    }

    private publishInactiveStatus(): void {
        this.activeDeviceId = null;
        this.setSnapshot(
            'inactive',
            this.selectedDeviceId ? 'selected-saved' : 'default-saved'
        );
    }

    private publishRouteFailureStatus(): void {
        this.setSnapshot('error', 'route-failed');
    }

    private isSelectedDeviceUnavailable(decision: RoutingDecision): boolean {
        return this.selectedDeviceId !== null
            && decision.selectedDeviceAvailability === 'unavailable';
    }

    private publishUnavailableStatus(usedFallback: boolean): void {
        this.setSnapshot(
            'fallback',
            usedFallback ?
                'selected-unavailable-fallback' :
                'selected-unavailable-default'
        );
    }

    private publishFallbackStatus(): void {
        this.setSnapshot(
            'fallback',
            this.selectedDeviceId ? 'selected-fallback' : 'default-fallback'
        );
    }

    private publishEnumerationFailureStatus(): void {
        if (this.selectedDeviceId) {
            this.setSnapshot('selected', 'selected-enumeration-failed');
            return;
        }
        this.setSnapshot('default', 'default-enumeration-failed');
    }

    private isTargetCurrent(target: RoutingTarget, requestedRevision: number): boolean {
        return this.isRevisionCurrent(requestedRevision)
            && this.routingTargets.get(target.identity) === target;
    }

    private async applyTargetSink(
        target: RoutingTarget,
        decision: RoutingDecision,
        requestedRevision: number
    ): Promise<TargetRoutingResult | null> {
        const requestedSinkId = decision.requestedSinkId;
        if (this.shouldPreserveTargetRoute(target, decision)) {
            return {
                success: true,
                usedFallback: target.lastAppliedSinkId !== requestedSinkId
            };
        }

        const setSinkId = target.setSinkId;
        let result: TargetRoutingResult | null;
        if (!setSinkId) {
            result = this.applyTargetWithoutRouting(target, requestedSinkId);
        } else {
            const candidateSinkIds = this.createCandidateSinkIds(target, decision);
            result = await this.applyCandidateSinks(
                target,
                setSinkId,
                requestedSinkId,
                candidateSinkIds,
                decision.deviceChangeGeneration,
                requestedRevision
            );
        }
        if (result?.success
            && !setSinkId
            && decision.deviceChangeGeneration !== null) {
            target.lastDeviceChangeGeneration = decision.deviceChangeGeneration;
        }
        return result;
    }

    private shouldPreserveTargetRoute(
        target: RoutingTarget,
        decision: RoutingDecision
    ): boolean {
        if (!target.hasAppliedSink
            || target.routeRecoveryRequired
            || target.failedSinkIds.has(target.lastAppliedSinkId)) {
            return false;
        }
        if (target.lastAppliedSinkId === decision.requestedSinkId) {
            return decision.deviceChangeGeneration === null
                || target.lastDeviceChangeGeneration >= decision.deviceChangeGeneration;
        }
        return decision.preserveExistingRoutes
            && target.failedSinkIds.has(decision.requestedSinkId);
    }

    private applyTargetWithoutRouting(
        target: RoutingTarget,
        requestedSinkId: string
    ): TargetRoutingResult {
        if (!requestedSinkId) {
            target.hasAppliedSink = true;
            target.lastAppliedSinkId = requestedSinkId;
            target.routeRecoveryRequired = false;
            return { success: true, usedFallback: false };
        }
        return {
            error: new DOMException('Audio output routing is unsupported', 'NotSupportedError'),
            success: false,
            usedFallback: false
        };
    }

    private createCandidateSinkIds(
        target: RoutingTarget,
        decision: RoutingDecision
    ): string[] {
        const requestedSinkId = decision.requestedSinkId;
        const candidateSinkIds: string[] = [];
        if (!target.failedSinkIds.has(requestedSinkId)) {
            candidateSinkIds.push(requestedSinkId);
        }
        if (requestedSinkId
            && !target.failedSinkIds.has(SYSTEM_DEFAULT_AUDIO_OUTPUT_DEVICE_ID)) {
            candidateSinkIds.push(SYSTEM_DEFAULT_AUDIO_OUTPUT_DEVICE_ID);
        }
        if (decision.fallbackDeviceId
            && decision.fallbackDeviceId !== requestedSinkId
            && decision.fallbackDeviceId !== ENUMERATED_DEFAULT_AUDIO_OUTPUT_DEVICE_ID
            && !target.failedSinkIds.has(decision.fallbackDeviceId)) {
            candidateSinkIds.push(decision.fallbackDeviceId);
        }
        return candidateSinkIds;
    }

    private async applyCandidateSinks(
        target: RoutingTarget,
        setSinkId: (sinkId: string) => Promise<void>,
        requestedSinkId: string,
        candidateSinkIds: readonly string[],
        deviceChangeGeneration: number | null,
        requestedRevision: number
    ): Promise<TargetRoutingResult | null> {
        let lastError: unknown = null;
        for (const candidateSinkId of candidateSinkIds) {
            const result = await this.applyCandidateSink(
                target,
                setSinkId,
                candidateSinkId,
                deviceChangeGeneration,
                requestedRevision
            );
            switch (result.status) {
                case 'stale':
                    return null;
                case 'failed':
                    lastError = result.error;
                    break;
                case 'success':
                    return {
                        success: true,
                        usedFallback: candidateSinkId !== requestedSinkId
                    };
            }
        }
        return {
            error: lastError ?? new DOMException(
                'Every available audio output route has failed',
                'NotFoundError'
            ),
            success: false,
            usedFallback: false
        };
    }

    private async applyCandidateSink(
        target: RoutingTarget,
        setSinkId: (sinkId: string) => Promise<void>,
        candidateSinkId: string,
        deviceChangeGeneration: number | null,
        requestedRevision: number
    ): Promise<CandidateRoutingResult> {
        if (!this.isTargetCurrent(target, requestedRevision)) {
            return { status: 'stale' };
        }
        if (deviceChangeGeneration !== null) {
            target.lastDeviceChangeGeneration = Math.max(
                target.lastDeviceChangeGeneration,
                deviceChangeGeneration
            );
        }
        try {
            await setSinkId(candidateSinkId);
        } catch (error) {
            this.markSinkFailed(target, candidateSinkId);
            const recoveredError = await this.resumeAfterFailedSinkChange(target, error);
            return { error: recoveredError, status: 'failed' };
        }
        target.failedSinkIds.delete(candidateSinkId);
        target.hasAppliedSink = true;
        target.lastAppliedSinkId = candidateSinkId;
        if (!this.isTargetRegistered(target)) {
            return { status: 'stale' };
        }
        try {
            await this.resumeTargetIfIntended(target);
        } catch (error) {
            this.markSinkFailed(target, candidateSinkId);
            return { error, status: 'failed' };
        }
        target.routeRecoveryRequired = false;
        if (!this.isTargetCurrent(target, requestedRevision)) {
            return { status: 'stale' };
        }
        return { status: 'success' };
    }

    private markSinkFailed(
        target: RoutingTarget,
        candidateSinkId: string
    ): void {
        target.failedSinkIds.add(candidateSinkId);
        target.routeRecoveryRequired = true;
    }

    private async resumeAfterFailedSinkChange(
        target: RoutingTarget,
        sinkFailure: unknown
    ): Promise<unknown> {
        try {
            await this.resumeTargetIfIntended(target);
            return sinkFailure;
        } catch (resumeError) {
            return resumeError;
        }
    }

    private async resumeTargetIfIntended(target: RoutingTarget): Promise<void> {
        if (!target.resume) {
            return;
        }
        const intendedRunning = Array.from(target.leases.values())
            .some(lease => lease.intendedRunning);
        if (!intendedRunning) {
            return;
        }
        const audioContext = target.identity as AudioContext;
        if (audioContext.state === 'suspended') {
            await target.resume();
        }
    }

    private normalizeDevices(devices: readonly MediaDeviceInfo[]): WebGPUAudioOutputDevice[] {
        const normalizedDevices: WebGPUAudioOutputDevice[] = [];
        const seenDeviceIds = new Set<string>();
        for (const device of devices) {
            if (device.kind !== 'audiooutput'
                || !device.deviceId
                || device.deviceId === ENUMERATED_DEFAULT_AUDIO_OUTPUT_DEVICE_ID
                || seenDeviceIds.has(device.deviceId)) {
                continue;
            }
            seenDeviceIds.add(device.deviceId);
            normalizedDevices.push({
                deviceId: device.deviceId,
                label: device.label
            });
        }
        return normalizedDevices;
    }

    private ensureDeviceChangeListener(): void {
        if (this.deviceChangeListening) {
            return;
        }
        const mediaDevices = this.getMediaDevices();
        if (!mediaDevices) {
            return;
        }
        mediaDevices.addEventListener('devicechange', this.handleDeviceChange);
        this.deviceChangeListening = true;
    }

    private readonly handleDeviceChange = (): void => {
        if (!this.destroyed) {
            this.deviceChangeGeneration += 1;
            this.pendingDeviceChangeGeneration = this.deviceChangeGeneration;
            void this.scheduleReconciliation(true);
        }
    };

    private handleAudioContextError(target: RoutingTarget): void {
        if (this.destroyed || this.routingTargets.get(target.identity) !== target) {
            return;
        }
        if (target.hasAppliedSink) {
            this.markSinkFailed(target, target.lastAppliedSinkId);
        }
        void this.scheduleReconciliation(false);
    }

    private isTargetRegistered(target: RoutingTarget): boolean {
        return !this.destroyed && this.routingTargets.get(target.identity) === target;
    }

    private clearFailedSinkIds(): void {
        for (const target of this.routingTargets.values()) {
            target.failedSinkIds.clear();
        }
    }

    private resolveReadyLeases(requestedRevision: number): void {
        for (const target of this.routingTargets.values()) {
            if (target.lastProcessedRevision !== requestedRevision) {
                continue;
            }
            for (const leaseState of target.leases.values()) {
                this.resolveLeaseReady(leaseState);
            }
        }
    }

    private resolveLeaseReady(leaseState: RoutingLeaseState): void {
        if (leaseState.readyResolved) {
            return;
        }
        leaseState.readyResolved = true;
        leaseState.resolveReady();
    }

    private setSnapshot(
        status: WebGPUAudioOutputStatus,
        messageCode: WebGPUAudioOutputMessageCode
    ): void {
        this.snapshotStatus = status;
        this.snapshotMessageCode = messageCode;
        const snapshot = this.getSnapshot();
        for (const listener of this.listeners) {
            this.notifyListener(listener, snapshot);
        }
    }

    private notifyListener(
        listener: (snapshot: WebGPUAudioOutputSnapshot) => void,
        snapshot: WebGPUAudioOutputSnapshot
    ): void {
        try {
            listener(snapshot);
        } catch {
            // Subscriber failures must not strand playback routing
        }
    }

    private isRevisionCurrent(revision: number): boolean {
        return !this.destroyed && this.revision === revision;
    }

    private isPickerRequestCurrent(requestRevision: number): boolean {
        return !this.destroyed && this.pickerRequestRevision === requestRevision;
    }

    private requireUsable(): void {
        if (this.destroyed) {
            throw new Error('WebGPU audio output manager is destroyed');
        }
    }
}

let defaultManager: WebGPUAudioOutputManager | null = null;

/** Returns the lazy page-wide WebGPU audio output manager. */
export function getWebGPUAudioOutputManager(): WebGPUAudioOutputManager {
    defaultManager ??= new WebGPUAudioOutputManager();
    return defaultManager;
}
