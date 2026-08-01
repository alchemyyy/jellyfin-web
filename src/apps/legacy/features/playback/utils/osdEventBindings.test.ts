import { describe, expect, it, vi } from 'vitest';

import Events, { type Event } from 'utils/events';

import { bindOSDEventHandlers } from './osdEventBindings';

type EventTargetWithCallbacks = {
    _callbacks?: Record<string, unknown[]>
};

const REPEATED_SESSION_COUNT = 10;

describe('bindOSDEventHandlers', () => {
    it('releases every callback after repeated OSD sessions', () => {
        const eventTarget: EventTargetWithCallbacks = {};
        const enabledHandlers: Array<ReturnType<typeof vi.fn>> = [];
        const playbackStartHandlers: Array<ReturnType<typeof vi.fn>> = [];

        for (let sessionNumber = 1; sessionNumber <= REPEATED_SESSION_COUNT; sessionNumber += 1) {
            const enabledHandler = vi.fn((event: Event, enabled: boolean): number => {
                expect(event.type).toBe('enabled');
                return enabled ? sessionNumber : 0;
            });
            const playbackStartHandler = vi.fn((): number => sessionNumber);
            enabledHandlers.push(enabledHandler);
            playbackStartHandlers.push(playbackStartHandler);

            const release = bindOSDEventHandlers(eventTarget, [
                [ 'enabled', enabledHandler ],
                [ 'playbackstart', playbackStartHandler ]
            ]);
            Events.trigger(eventTarget, 'enabled', [ true ]);
            Events.trigger(eventTarget, 'playbackstart');
            release();
            release();
        }

        Events.trigger(eventTarget, 'enabled', [ true ]);
        Events.trigger(eventTarget, 'playbackstart');

        for (const enabledHandler of enabledHandlers) {
            expect(enabledHandler).toHaveBeenCalledTimes(1);
        }
        for (const playbackStartHandler of playbackStartHandlers) {
            expect(playbackStartHandler).toHaveBeenCalledTimes(1);
        }
        expect(eventTarget._callbacks?.enabled).toHaveLength(0);
        expect(eventTarget._callbacks?.playbackstart).toHaveLength(0);
    });

    it('preserves callbacks owned by another controller', () => {
        const eventTarget: EventTargetWithCallbacks = {};
        const persistentHandler = vi.fn();
        const ownedHandler = vi.fn();
        Events.on(eventTarget, 'playing', persistentHandler);

        const release = bindOSDEventHandlers(eventTarget, [
            [ 'playing', ownedHandler ]
        ]);
        release();
        Events.trigger(eventTarget, 'playing');

        expect(persistentHandler).toHaveBeenCalledOnce();
        expect(ownedHandler).not.toHaveBeenCalled();
        expect(eventTarget._callbacks?.playing).toEqual([ persistentHandler ]);
    });
});
