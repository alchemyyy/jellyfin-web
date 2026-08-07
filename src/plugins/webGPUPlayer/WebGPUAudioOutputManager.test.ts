import { describe, expect, it, vi } from 'vitest';

import {
    WebGPUAudioOutputManager,
    type WebGPUAudioOutputManagerOptions
} from './WebGPUAudioOutputManager';

type Deferred = {
    promise: Promise<void>
    resolve: () => void
};

class FakeMediaDevices extends EventTarget {
    public devices: MediaDeviceInfo[] = [];
    public readonly enumerateDevices = vi.fn(
        (): Promise<MediaDeviceInfo[]> => Promise.resolve(this.devices)
    );
    public selectAudioOutput?: (
        options?: Readonly<{ deviceId?: string }>
    ) => Promise<MediaDeviceInfo>;
}

class FakeAudioContext extends EventTarget {
    public readonly setSinkId = vi.fn(async (sinkId: string): Promise<void> => {
        this.sinkId = sinkId;
    });
    public readonly resume = vi.fn(async (): Promise<void> => {
        this.state = 'running';
    });
    public sinkId = '';
    public state: AudioContextState = 'suspended';
}

function createDevice(
    deviceId: string,
    label = '',
    kind: MediaDeviceKind = 'audiooutput'
): MediaDeviceInfo {
    return {
        deviceId,
        groupId: '',
        kind,
        label,
        toJSON: (): object => ({ deviceId, kind, label })
    } as MediaDeviceInfo;
}

function createDeferred(): Deferred {
    let resolvePromise: (() => void) | null = null;
    const promise = new Promise<void>((resolve): void => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: (): void => {
            if (!resolvePromise) {
                throw new Error('Missing deferred resolver');
            }
            resolvePromise();
        }
    };
}

function createManager(
    mediaDevices: FakeMediaDevices,
    initialSelectedDeviceId: string | null = null
): WebGPUAudioOutputManager {
    const options: WebGPUAudioOutputManagerOptions = {
        getMediaDevices: () => mediaDevices as unknown as MediaDevices,
        initialSelectedDeviceId
    };
    return new WebGPUAudioOutputManager(options);
}

describe('WebGPUAudioOutputManager', () => {
    it('uses the canonical default sink and exposes only concrete audio outputs', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [
            createDevice('default', 'Default pseudo-device'),
            createDevice('speaker-a', 'Speakers'),
            createDevice('microphone-a', 'Microphone', 'audioinput'),
            createDevice('speaker-a', 'Duplicate')
        ];
        const manager = createManager(mediaDevices);
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);

        await lease.ready;

        expect(audioContext.setSinkId).toHaveBeenCalledWith('');
        expect(manager.getSnapshot()).toMatchObject({
            devices: [ { deviceId: 'speaker-a', label: 'Speakers' } ],
            selectedDeviceId: null,
            status: 'default'
        });
        mediaDevices.dispatchEvent(new Event('devicechange'));
        await manager.refresh();
        expect(audioContext.setSinkId).toHaveBeenCalledTimes(2);
        expect(audioContext.setSinkId).toHaveBeenLastCalledWith('');
        await lease.release();
        await manager.destroy();
    });

    it('does not reroute active default targets for refresh, subscription, or same selection', async () => {
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(mediaDevices);
        const audioContext = new FakeAudioContext();
        const audioLease = manager.registerAudioContext(
            audioContext as unknown as AudioContext
        );
        const setMediaElementSinkId = vi.fn(
            (): Promise<void> => Promise.resolve()
        );
        const mediaElement = Object.assign(new EventTarget(), {
            setSinkId: setMediaElementSinkId
        }) as unknown as HTMLMediaElement;
        const mediaLease = manager.registerMediaElement(mediaElement);
        await Promise.all([ audioLease.ready, mediaLease.ready ]);
        expect(audioContext.setSinkId).toHaveBeenCalledTimes(1);
        expect(setMediaElementSinkId).toHaveBeenCalledTimes(1);

        await audioLease.setIntendedRunning(true);
        audioContext.state = 'suspended';
        for (let subscriptionNumber: number = 0;
            subscriptionNumber < 3;
            subscriptionNumber += 1) {
            const unsubscribe = manager.subscribe((): void => undefined);
            await manager.refresh();
            unsubscribe();
        }
        await manager.setSelectedDeviceId(null);

        expect(audioContext.setSinkId).toHaveBeenCalledTimes(1);
        expect(setMediaElementSinkId).toHaveBeenCalledTimes(1);
        expect(audioContext.resume).not.toHaveBeenCalled();
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            selectedDeviceId: null,
            status: 'default'
        });
        await mediaLease.release();
        await audioLease.release();
        await manager.destroy();
    });

    it('reapplies each physical default target once for a device change', async () => {
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(mediaDevices);
        const audioContext = new FakeAudioContext();
        audioContext.state = 'running';
        audioContext.setSinkId.mockImplementation(async (sinkId: string): Promise<void> => {
            audioContext.sinkId = sinkId;
            audioContext.state = 'suspended';
        });
        const audioLease = manager.registerAudioContext(
            audioContext as unknown as AudioContext
        );
        const setMediaElementSinkId = vi.fn(
            (): Promise<void> => Promise.resolve()
        );
        const mediaElement = Object.assign(new EventTarget(), {
            setSinkId: setMediaElementSinkId
        }) as unknown as HTMLMediaElement;
        const mediaLease = manager.registerMediaElement(mediaElement);
        await Promise.all([ audioLease.ready, mediaLease.ready ]);
        await audioLease.setIntendedRunning(true);
        audioContext.setSinkId.mockClear();
        audioContext.resume.mockClear();
        setMediaElementSinkId.mockClear();

        mediaDevices.dispatchEvent(new Event('devicechange'));
        await manager.refresh();

        expect(audioContext.setSinkId).toHaveBeenCalledExactlyOnceWith('');
        expect(setMediaElementSinkId).toHaveBeenCalledExactlyOnceWith('');
        expect(audioContext.resume).toHaveBeenCalledOnce();
        await mediaLease.release();
        await audioLease.release();
        await manager.destroy();
    });

    it('deduplicates a fulfilled device-change route after refresh supersession', async () => {
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(mediaDevices);
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        await lease.setIntendedRunning(true);
        audioContext.state = 'running';
        audioContext.resume.mockClear();
        const forcedRoute = createDeferred();
        audioContext.setSinkId.mockImplementationOnce(async (sinkId: string): Promise<void> => {
            await forcedRoute.promise;
            audioContext.sinkId = sinkId;
            audioContext.state = 'suspended';
        });

        mediaDevices.dispatchEvent(new Event('devicechange'));
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenCalledTimes(2));
        const supersedingRefresh = manager.refresh();
        forcedRoute.resolve();
        await supersedingRefresh;

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            '',
            ''
        ]);
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(audioContext.state).toBe('running');
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            selectedDeviceId: null,
            status: 'default'
        });
        await lease.release();
        await manager.destroy();
    });

    it('does not retry a rejected forced candidate in its superseding refresh', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-b') ];
        const manager = createManager(mediaDevices);
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        let rejectForcedRoute = (error: unknown): void => {
            throw new Error(`Missing forced route rejecter for ${String(error)}`);
        };
        const forcedRoute = new Promise<void>((_resolve, reject): void => {
            rejectForcedRoute = reject;
        });
        audioContext.setSinkId.mockImplementationOnce((): Promise<void> => forcedRoute);

        mediaDevices.dispatchEvent(new Event('devicechange'));
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenCalledTimes(2));
        const supersedingRefresh = manager.refresh();
        rejectForcedRoute(new DOMException('Default changed', 'AbortError'));
        await supersedingRefresh;

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            '',
            '',
            'speaker-b'
        ]);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: 'speaker-b',
            selectedDeviceId: null,
            status: 'fallback'
        });
        await lease.release();
        await manager.destroy();
    });

    it('retries a failed current default on same selection and later refresh', async () => {
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(mediaDevices);
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        await lease.setIntendedRunning(true);
        audioContext.setSinkId.mockImplementation(async (sinkId: string): Promise<void> => {
            audioContext.sinkId = sinkId;
            audioContext.state = 'suspended';
        });
        audioContext.setSinkId.mockClear();
        audioContext.resume.mockClear();
        audioContext.state = 'running';

        audioContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(manager.getSnapshot().status).toBe('error'));
        expect(audioContext.setSinkId).not.toHaveBeenCalled();
        await manager.setSelectedDeviceId(null);
        expect(audioContext.setSinkId).toHaveBeenCalledExactlyOnceWith('');
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(manager.getSnapshot().status).toBe('default');

        audioContext.setSinkId.mockClear();
        audioContext.resume.mockClear();
        audioContext.state = 'running';
        audioContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(manager.getSnapshot().status).toBe('error'));
        await manager.refresh();
        expect(audioContext.setSinkId).toHaveBeenCalledExactlyOnceWith('');
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(manager.getSnapshot().status).toBe('default');

        await lease.release();
        await manager.destroy();
    });

    it('uses one permitted fallback when the canonical default route fails', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-b', 'Fallback') ];
        const manager = createManager(mediaDevices, 'missing-speaker');
        const audioContext = new FakeAudioContext();
        audioContext.setSinkId.mockImplementation((sinkId: string): Promise<void> => {
            if (!sinkId) {
                return Promise.reject(new DOMException('Default failed', 'AbortError'));
            }
            audioContext.sinkId = sinkId;
            return Promise.resolve();
        });
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);

        await lease.ready;

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            '',
            'speaker-b'
        ]);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: 'speaker-b',
            selectedDeviceId: 'missing-speaker',
            status: 'fallback'
        });
        await lease.release();
        await manager.destroy();
    });

    it('reports fallback when an available selected sink rejects routing', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        audioContext.setSinkId.mockImplementation((sinkId: string): Promise<void> => (
            sinkId === 'speaker-a' ?
                Promise.reject(new DOMException('Blocked', 'NotAllowedError')) :
                Promise.resolve()
        ));
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);

        await lease.ready;

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a',
            ''
        ]);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            selectedDeviceId: 'speaker-a',
            status: 'fallback'
        });
        await lease.release();
        await manager.destroy();
    });

    it('falls back on disconnect while retaining and restoring the selected ID', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a', 'Speakers') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        expect(audioContext.setSinkId).toHaveBeenLastCalledWith('speaker-a');

        mediaDevices.devices = [ createDevice('speaker-b', 'Fallback') ];
        await manager.refresh();
        expect(audioContext.setSinkId).toHaveBeenLastCalledWith('');
        expect(manager.getSnapshot()).toMatchObject({
            selectedDeviceId: 'speaker-a',
            status: 'fallback'
        });

        mediaDevices.devices = [
            createDevice('speaker-a', 'Speakers'),
            createDevice('speaker-b', 'Fallback')
        ];
        await manager.refresh();
        expect(audioContext.setSinkId).toHaveBeenLastCalledWith('speaker-a');
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a',
            '',
            'speaker-a'
        ]);
        expect(manager.getSnapshot().status).toBe('selected');

        await lease.release();
        await manager.destroy();
    });

    it('serializes sink changes so a stale completion cannot win', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [
            createDevice('speaker-a'),
            createDevice('speaker-b')
        ];
        const firstSetSink = createDeferred();
        const sinkCalls: string[] = [];
        const audioContext = new FakeAudioContext();
        audioContext.setSinkId.mockImplementation((sinkId: string): Promise<void> => {
            sinkCalls.push(sinkId);
            return sinkCalls.length === 1 ? firstSetSink.promise : Promise.resolve();
        });
        const manager = createManager(mediaDevices, 'speaker-a');
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await vi.waitFor(() => expect(sinkCalls).toEqual([ 'speaker-a' ]));

        const newestSelection = manager.setSelectedDeviceId('speaker-b');
        firstSetSink.resolve();
        await lease.ready;
        await newestSelection;

        expect(sinkCalls).toEqual([ 'speaker-a', 'speaker-b' ]);
        await lease.release();
        await manager.destroy();
    });

    it('ignores stale enumeration results and publishes the newest device list', async () => {
        const mediaDevices = new FakeMediaDevices();
        let resolveFirstEnumeration: (devices: MediaDeviceInfo[]) => void = (
            devices: MediaDeviceInfo[]
        ): void => {
            throw new Error(`Missing first enumeration resolver for ${devices.length} devices`);
        };
        const firstEnumeration = new Promise<MediaDeviceInfo[]>((resolve): void => {
            resolveFirstEnumeration = resolve;
        });
        mediaDevices.enumerateDevices
            .mockImplementationOnce((): Promise<MediaDeviceInfo[]> => firstEnumeration)
            .mockImplementation((): Promise<MediaDeviceInfo[]> => Promise.resolve([
                createDevice('new-speaker')
            ]));
        const manager = createManager(mediaDevices);
        const staleRefresh = manager.refresh();
        await vi.waitFor(() => expect(mediaDevices.enumerateDevices).toHaveBeenCalledOnce());
        const newestRefresh = manager.refresh();
        resolveFirstEnumeration([ createDevice('stale-speaker') ]);

        await Promise.all([ staleRefresh, newestRefresh ]);

        expect(manager.getSnapshot().devices).toEqual([
            { deviceId: 'new-speaker', label: '' }
        ]);
        await manager.destroy();
    });

    it('carries pending enumeration into a target registration that supersedes selection', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('old-speaker') ];
        const manager = createManager(mediaDevices, 'old-speaker');
        await manager.refresh();
        expect(manager.getSnapshot().devices).toEqual([
            { deviceId: 'old-speaker', label: '' }
        ]);

        let resolveEnumeration: (devices: MediaDeviceInfo[]) => void = (
            devices: MediaDeviceInfo[]
        ): void => {
            throw new Error(`Missing enumeration resolver for ${devices.length} devices`);
        };
        const pendingEnumeration = new Promise<MediaDeviceInfo[]>((resolve): void => {
            resolveEnumeration = resolve;
        });
        mediaDevices.enumerateDevices.mockImplementation(
            (): Promise<MediaDeviceInfo[]> => pendingEnumeration
        );
        const selection = manager.setSelectedDeviceId('rotated-speaker');
        await vi.waitFor(() => expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(2));

        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        let readyResolved = false;
        void lease.ready.then((): void => {
            readyResolved = true;
        });
        expect(readyResolved).toBe(false);

        resolveEnumeration([ createDevice('rotated-speaker') ]);
        await Promise.all([ selection, lease.ready ]);

        expect(mediaDevices.enumerateDevices).toHaveBeenCalledTimes(3);
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'rotated-speaker'
        ]);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: 'rotated-speaker',
            devices: [ { deviceId: 'rotated-speaker', label: '' } ],
            selectedDeviceId: 'rotated-speaker',
            status: 'selected'
        });
        expect(readyResolved).toBe(true);
        await lease.release();
        await manager.destroy();
    });

    it('drains an in-flight route before releasing its final target lease', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const pendingRoute = createDeferred();
        const audioContext = new FakeAudioContext();
        audioContext.setSinkId.mockImplementation((): Promise<void> => pendingRoute.promise);
        const manager = createManager(mediaDevices, 'speaker-a');
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenCalledOnce());
        let released = false;
        const firstReleasePromise = lease.release();
        const secondReleasePromise = lease.release();
        expect(secondReleasePromise).toBe(firstReleasePromise);
        const releasePromise = firstReleasePromise.then((): void => {
            released = true;
        });
        await Promise.resolve();
        expect(released).toBe(false);

        pendingRoute.resolve();
        await releasePromise;
        expect(released).toBe(true);
        await manager.destroy();
    });

    it('keeps target readiness pending until the latest superseding route is applied', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a'), createDevice('speaker-b') ];
        const firstRoute = createDeferred();
        const latestRoute = createDeferred();
        const audioContext = new FakeAudioContext();
        audioContext.setSinkId.mockImplementation((sinkId: string): Promise<void> => {
            switch (sinkId) {
                case 'speaker-a':
                    return firstRoute.promise;
                case 'speaker-b':
                    return latestRoute.promise;
                default:
                    return Promise.resolve();
            }
        });
        const manager = createManager(mediaDevices, 'speaker-a');
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenCalledWith('speaker-a'));
        let readyResolved = false;
        void lease.ready.then((): void => {
            readyResolved = true;
        });

        const transientElement = Object.assign(new EventTarget(), {
            setSinkId: vi.fn((): Promise<void> => Promise.resolve())
        }) as unknown as HTMLMediaElement;
        const transientLease = manager.registerMediaElement(transientElement);
        const transientRelease = transientLease.release();
        const latestSelection = manager.setSelectedDeviceId('speaker-b');
        firstRoute.resolve();
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenCalledWith('speaker-b'));
        expect(readyResolved).toBe(false);

        latestRoute.resolve();
        await Promise.all([ lease.ready, latestSelection, transientRelease ]);
        expect(readyResolved).toBe(true);
        expect(audioContext.setSinkId).toHaveBeenLastCalledWith('speaker-b');
        await lease.release();
        await manager.destroy();
    });

    it('isolates throwing subscribers so routing and target readiness still complete', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const throwingSubscriber = vi.fn((): void => {
            throw new Error('Subscriber failed');
        });
        const healthySubscriber = vi.fn();

        expect(() => manager.subscribe(throwingSubscriber)).not.toThrow();
        manager.subscribe(healthySubscriber);
        const setSinkId = vi.fn((): Promise<void> => Promise.resolve());
        const mediaElement = Object.assign(new EventTarget(), {
            setSinkId
        }) as unknown as HTMLMediaElement;
        const lease = manager.registerMediaElement(mediaElement);

        await expect(lease.ready).resolves.toBeUndefined();
        expect(setSinkId).toHaveBeenCalledWith('speaker-a');
        expect(throwingSubscriber).toHaveBeenCalled();
        expect(healthySubscriber).toHaveBeenCalled();
        await lease.release();
        await manager.destroy();
    });

    it('resumes only a context whose active lease intends to be running', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [
            createDevice('speaker-a'),
            createDevice('speaker-b')
        ];
        const audioContext = new FakeAudioContext();
        audioContext.state = 'running';
        audioContext.setSinkId.mockImplementation(async (sinkId: string): Promise<void> => {
            audioContext.sinkId = sinkId;
            audioContext.state = 'suspended';
        });
        const manager = createManager(mediaDevices, 'speaker-a');
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        expect(audioContext.resume).not.toHaveBeenCalled();
        await lease.setIntendedRunning(true);
        audioContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(audioContext.resume).toHaveBeenCalledTimes(1));
        expect(audioContext.resume).toHaveBeenCalledTimes(1);

        await lease.setIntendedRunning(false);
        audioContext.state = 'suspended';
        await manager.setSelectedDeviceId('speaker-b');
        expect(audioContext.resume).toHaveBeenCalledTimes(1);

        await lease.release();
        await manager.destroy();
    });

    it('reports unsupported specific routing without failing playback setup', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const mediaElementWithoutSink = new EventTarget() as unknown as HTMLMediaElement;
        const lease = manager.registerMediaElement(mediaElementWithoutSink);

        await expect(lease.ready).resolves.toBeUndefined();
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            selectedDeviceId: 'speaker-a',
            status: 'error'
        });
        await lease.release();
        await manager.destroy();
    });

    it('applies live routing to an owned media element', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const setSinkId = vi.fn((sinkId: string): Promise<void> => {
            if (typeof sinkId !== 'string') {
                throw new TypeError('Sink ID must be a string');
            }
            return Promise.resolve();
        });
        const mediaElement = Object.assign(new EventTarget(), {
            setSinkId
        }) as unknown as HTMLMediaElement;
        const lease = manager.registerMediaElement(mediaElement);

        await lease.ready;
        await manager.setSelectedDeviceId(null);

        expect(setSinkId.mock.calls.map(call => call[0])).toEqual([ 'speaker-a', '' ]);
        await lease.release();
        await manager.destroy();
    });

    it('preserves a working selected route and device list when enumeration fails', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [
            createDevice('speaker-a', 'Speakers'),
            createDevice('speaker-b', 'Headphones')
        ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        expect(audioContext.setSinkId).toHaveBeenCalledTimes(1);

        mediaDevices.enumerateDevices.mockRejectedValue(
            new DOMException('Permission changed', 'NotAllowedError')
        );
        await manager.refresh();

        expect(audioContext.setSinkId).toHaveBeenCalledTimes(1);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: 'speaker-a',
            devices: [
                { deviceId: 'speaker-a', label: 'Speakers' },
                { deviceId: 'speaker-b', label: 'Headphones' }
            ],
            selectedDeviceId: 'speaker-a',
            status: 'selected'
        });

        const newSetSinkId = vi.fn((sinkId: string): Promise<void> => (
            sinkId === 'speaker-a' ?
                Promise.reject(new DOMException('Device route failed', 'AbortError')) :
                Promise.resolve()
        ));
        const mediaElement = Object.assign(new EventTarget(), {
            setSinkId: newSetSinkId
        }) as unknown as HTMLMediaElement;
        const mediaLease = manager.registerMediaElement(mediaElement);
        await mediaLease.ready;
        expect(newSetSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a',
            ''
        ]);
        expect(manager.getSnapshot().selectedDeviceId).toBe('speaker-a');

        await mediaLease.release();
        await lease.release();
        await manager.destroy();
    });

    it('reports a selected route as active when its first device enumeration fails', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.enumerateDevices.mockRejectedValue(
            new DOMException('Enumeration denied', 'NotAllowedError')
        );
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);

        await lease.ready;

        expect(audioContext.setSinkId).toHaveBeenCalledWith('speaker-a');
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: 'speaker-a',
            devices: [],
            messageCode: 'selected-enumeration-failed',
            selectedDeviceAvailability: 'active',
            selectedDeviceId: 'speaker-a',
            status: 'selected'
        });
        await lease.release();
        await manager.destroy();
    });

    it('advances only the errored context through selected, default, and permitted fallback', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [
            createDevice('speaker-a'),
            createDevice('speaker-b')
        ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const firstContext = new FakeAudioContext();
        const secondContext = new FakeAudioContext();
        const firstLease = manager.registerAudioContext(firstContext as unknown as AudioContext);
        const secondLease = manager.registerAudioContext(secondContext as unknown as AudioContext);
        await Promise.all([ firstLease.ready, secondLease.ready ]);
        firstContext.setSinkId.mockClear();
        secondContext.setSinkId.mockClear();

        firstContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(firstContext.setSinkId).toHaveBeenCalledWith(''));
        expect(firstContext.setSinkId).not.toHaveBeenCalledWith('speaker-a');
        expect(secondContext.setSinkId).not.toHaveBeenCalled();
        expect(manager.getSnapshot()).toMatchObject({
            selectedDeviceId: 'speaker-a',
            status: 'fallback'
        });

        firstContext.setSinkId.mockClear();
        firstContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(firstContext.setSinkId).toHaveBeenCalledWith('speaker-b'));
        expect(firstContext.setSinkId).not.toHaveBeenCalledWith('speaker-a');
        expect(firstContext.setSinkId).not.toHaveBeenCalledWith('');

        firstContext.setSinkId.mockClear();
        firstContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(manager.getSnapshot().status).toBe('error'));
        expect(firstContext.setSinkId).not.toHaveBeenCalled();
        expect(secondContext.setSinkId).not.toHaveBeenCalled();
        expect(manager.getSnapshot().status).toBe('error');

        mediaDevices.dispatchEvent(new Event('devicechange'));
        await vi.waitFor(() => expect(firstContext.setSinkId).toHaveBeenCalledWith('speaker-a'));

        await firstLease.release();
        await secondLease.release();
        await manager.destroy();
    });

    it('keeps a demoted safe fallback when device-change enumeration fails', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a'), createDevice('speaker-b') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;

        audioContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenLastCalledWith(''));
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a',
            ''
        ]);
        mediaDevices.enumerateDevices.mockRejectedValue(
            new DOMException('Enumeration failed', 'NotAllowedError')
        );

        mediaDevices.dispatchEvent(new Event('devicechange'));
        await manager.refresh();

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a',
            ''
        ]);
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            messageCode: 'selected-fallback',
            selectedDeviceAvailability: 'unknown',
            selectedDeviceId: 'speaker-a',
            status: 'fallback'
        });
        await lease.release();
        await manager.destroy();
    });

    it('deduplicates same-ID selection but still recovers an errored intended context', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [
            createDevice('speaker-a'),
            createDevice('speaker-b')
        ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        await lease.setIntendedRunning(true);
        audioContext.state = 'suspended';
        audioContext.resume.mockImplementation((): Promise<void> => {
            if (audioContext.sinkId === 'speaker-a') {
                return Promise.reject(new DOMException('Selected output stopped', 'AbortError'));
            }
            audioContext.state = 'running';
            return Promise.resolve();
        });

        await manager.setSelectedDeviceId('speaker-a');

        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a'
        ]);
        expect(audioContext.resume).not.toHaveBeenCalled();
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: 'speaker-a',
            selectedDeviceId: 'speaker-a',
            status: 'selected'
        });

        audioContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenLastCalledWith(''));
        expect(audioContext.setSinkId.mock.calls.map(call => call[0])).toEqual([
            'speaker-a',
            ''
        ]);
        expect(audioContext.resume).toHaveBeenCalledOnce();
        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            selectedDeviceId: 'speaker-a',
            status: 'fallback'
        });
        await lease.release();
        await manager.destroy();
    });

    it('does not resume an idle context while recovering from an output error', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        audioContext.state = 'suspended';

        audioContext.dispatchEvent(new Event('error'));
        await vi.waitFor(() => expect(audioContext.setSinkId).toHaveBeenLastCalledWith(''));
        expect(audioContext.resume).not.toHaveBeenCalled();

        await lease.release();
        await manager.destroy();
    });

    it('clears the active route and reports a saved next route after the last release', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const lease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await lease.ready;
        expect(manager.getSnapshot().activeDeviceId).toBe('speaker-a');

        await lease.release();

        expect(manager.getSnapshot()).toMatchObject({
            activeDeviceId: null,
            messageCode: 'selected-saved',
            selectedDeviceId: 'speaker-a',
            status: 'inactive'
        });
        await manager.destroy();
    });

    it('uses a rotated picker ID and keeps picker failures non-terminal', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('rotated-output', 'Headphones') ];
        const selectAudioOutput = vi.fn(async (): Promise<MediaDeviceInfo> => (
            createDevice('rotated-output', 'Headphones')
        ));
        mediaDevices.selectAudioOutput = selectAudioOutput;
        const manager = createManager(mediaDevices, 'old-output');

        expect(await manager.requestAudioOutputSelection()).toBe('rotated-output');
        expect(selectAudioOutput).toHaveBeenCalledWith({ deviceId: 'old-output' });
        expect(manager.getSnapshot().selectedDeviceId).toBe('old-output');
        await manager.setSelectedDeviceId('rotated-output');
        expect(manager.getSnapshot()).toMatchObject({
            selectedDeviceId: 'rotated-output',
            status: 'inactive'
        });

        mediaDevices.selectAudioOutput = vi.fn(() => Promise.reject(
            new DOMException('Blocked', 'NotAllowedError')
        ));
        expect(await manager.requestAudioOutputSelection()).toBeNull();
        expect(manager.getSnapshot()).toMatchObject({
            selectedDeviceId: 'rotated-output',
            status: 'error'
        });
        await manager.destroy();
    });

    it('does not publish an older picker rejection after a newer picker succeeds', async () => {
        const mediaDevices = new FakeMediaDevices();
        let rejectFirstPicker: (error: unknown) => void = (error: unknown): void => {
            throw new Error(`Missing first picker rejecter for ${String(error)}`);
        };
        let resolveSecondPicker: (device: MediaDeviceInfo) => void = (
            device: MediaDeviceInfo
        ): void => {
            throw new Error(`Missing second picker resolver for ${device.deviceId}`);
        };
        const firstPicker = new Promise<MediaDeviceInfo>((_resolve, reject): void => {
            rejectFirstPicker = reject;
        });
        const secondPicker = new Promise<MediaDeviceInfo>((resolve): void => {
            resolveSecondPicker = resolve;
        });
        mediaDevices.selectAudioOutput = vi.fn()
            .mockImplementationOnce((): Promise<MediaDeviceInfo> => firstPicker)
            .mockImplementationOnce((): Promise<MediaDeviceInfo> => secondPicker);
        const manager = createManager(mediaDevices);
        const olderRequest = manager.requestAudioOutputSelection();
        const newerRequest = manager.requestAudioOutputSelection();
        resolveSecondPicker(createDevice('speaker-b'));
        await expect(newerRequest).resolves.toBe('speaker-b');
        const snapshotAfterSuccess = manager.getSnapshot();

        rejectFirstPicker(new DOMException('Late denial', 'NotAllowedError'));
        await expect(olderRequest).resolves.toBeNull();
        expect(manager.getSnapshot()).toEqual(snapshotAfterSuccess);
        await manager.destroy();
    });

    it('ignores an old rejection after picker cancellation and a reopened request', async () => {
        const mediaDevices = new FakeMediaDevices();
        let rejectFirstPicker: (error: unknown) => void = (error: unknown): void => {
            throw new Error(`Missing first picker rejecter for ${String(error)}`);
        };
        mediaDevices.selectAudioOutput = vi.fn()
            .mockImplementationOnce((): Promise<MediaDeviceInfo> => (
                new Promise<MediaDeviceInfo>((_resolve, reject): void => {
                    rejectFirstPicker = reject;
                })
            ))
            .mockImplementationOnce((): Promise<MediaDeviceInfo> => Promise.resolve(
                createDevice('reopened-speaker')
            ));
        const manager = createManager(mediaDevices);
        const oldRequest = manager.requestAudioOutputSelection();
        manager.cancelAudioOutputSelectionRequest();
        const reopenedRequest = manager.requestAudioOutputSelection();
        await expect(reopenedRequest).resolves.toBe('reopened-speaker');
        const snapshotAfterReopen = manager.getSnapshot();

        rejectFirstPicker(new DOMException('Late denial', 'NotAllowedError'));
        await expect(oldRequest).resolves.toBeNull();
        expect(manager.getSnapshot()).toEqual(snapshotAfterReopen);
        await manager.destroy();
    });

    it('invalidates pending picker outcomes on explicit preference changes', async () => {
        const mediaDevices = new FakeMediaDevices();
        let resolveFirstPicker: (device: MediaDeviceInfo) => void = (
            device: MediaDeviceInfo
        ): void => {
            throw new Error(`Missing first picker resolver for ${device.deviceId}`);
        };
        let rejectSecondPicker: (error: unknown) => void = (error: unknown): void => {
            throw new Error(`Missing second picker rejecter for ${String(error)}`);
        };
        const firstPicker = new Promise<MediaDeviceInfo>((resolve): void => {
            resolveFirstPicker = resolve;
        });
        const secondPicker = new Promise<MediaDeviceInfo>((_resolve, reject): void => {
            rejectSecondPicker = reject;
        });
        mediaDevices.selectAudioOutput = vi.fn()
            .mockImplementationOnce((): Promise<MediaDeviceInfo> => firstPicker)
            .mockImplementationOnce((): Promise<MediaDeviceInfo> => secondPicker);
        const manager = createManager(mediaDevices, 'initial-speaker');

        const pickerBeforeDropdown = manager.requestAudioOutputSelection();
        await manager.setSelectedDeviceId('dropdown-speaker');
        const snapshotAfterDropdown = manager.getSnapshot();
        resolveFirstPicker(createDevice('late-picker-speaker'));
        await expect(pickerBeforeDropdown).resolves.toBeNull();
        expect(manager.getSnapshot()).toEqual(snapshotAfterDropdown);

        const pickerBeforeReset = manager.requestAudioOutputSelection();
        await manager.setSelectedDeviceId(null);
        const snapshotAfterReset = manager.getSnapshot();
        rejectSecondPicker(new DOMException('Late denial', 'NotAllowedError'));
        await expect(pickerBeforeReset).resolves.toBeNull();
        expect(manager.getSnapshot()).toEqual(snapshotAfterReset);
        await manager.destroy();
    });

    it('surfaces synchronous picker and enumeration failures while retaining preference', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.enumerateDevices.mockRejectedValue(
            new DOMException('Blocked', 'NotAllowedError')
        );
        mediaDevices.selectAudioOutput = vi.fn((): Promise<MediaDeviceInfo> => {
            throw new DOMException('No activation', 'InvalidStateError');
        });
        const manager = createManager(mediaDevices, 'speaker-a');

        await manager.refresh();
        expect(manager.getSnapshot()).toMatchObject({
            devices: [],
            selectedDeviceId: 'speaker-a',
            status: 'inactive'
        });
        expect(await manager.requestAudioOutputSelection()).toBeNull();
        expect(manager.getSnapshot()).toMatchObject({
            messageCode: 'picker-user-action-required',
            selectedDeviceId: 'speaker-a',
            status: 'error'
        });
        await manager.destroy();
    });

    it.each([
        [ 'AbortError', 'picker-cancelled' ],
        [ 'NotFoundError', 'picker-not-found' ]
    ])('surfaces %s picker rejection without clearing preference', async (
        errorName,
        expectedMessageCode
    ) => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.selectAudioOutput = vi.fn(() => Promise.reject(
            new DOMException('Picker failed', errorName)
        ));
        const manager = createManager(mediaDevices, 'speaker-a');

        expect(await manager.requestAudioOutputSelection()).toBeNull();
        expect(manager.getSnapshot()).toMatchObject({
            messageCode: expectedMessageCode,
            selectedDeviceId: 'speaker-a',
            status: 'error'
        });
        await manager.destroy();
    });

    it('reports when the browser picker API is unavailable', async () => {
        const mediaDevices = new FakeMediaDevices();
        const manager = createManager(mediaDevices);

        expect(await manager.requestAudioOutputSelection()).toBeNull();
        expect(manager.getSnapshot()).toMatchObject({
            messageCode: 'picker-unavailable',
            pickerAvailable: false,
            status: 'unsupported'
        });
        await manager.destroy();
    });

    it('deduplicates physical targets and removes device listeners on destroy', async () => {
        const mediaDevices = new FakeMediaDevices();
        mediaDevices.devices = [ createDevice('speaker-a') ];
        const removeEventListener = vi.spyOn(mediaDevices, 'removeEventListener');
        const manager = createManager(mediaDevices, 'speaker-a');
        const audioContext = new FakeAudioContext();
        const firstLease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        const secondLease = manager.registerAudioContext(audioContext as unknown as AudioContext);
        await Promise.all([ firstLease.ready, secondLease.ready ]);

        expect(audioContext.setSinkId).toHaveBeenCalledTimes(1);
        await firstLease.release();
        await manager.setSelectedDeviceId(null);
        expect(audioContext.setSinkId).toHaveBeenLastCalledWith('');
        await secondLease.release();
        await manager.destroy();
        expect(removeEventListener).toHaveBeenCalledWith(
            'devicechange',
            expect.any(Function)
        );
    });
});
