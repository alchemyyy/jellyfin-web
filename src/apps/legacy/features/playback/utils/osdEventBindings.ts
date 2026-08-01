import Events from 'utils/events';

type EventHandler = Parameters<typeof Events.on>[2];

export type OSDEventBinding = readonly [eventName: string, eventHandler: EventHandler];

/** Binds one OSD controller's events and returns an idempotent release callback. */
export function bindOSDEventHandlers(
    eventTarget: object,
    eventBindings: readonly OSDEventBinding[]
): () => void {
    const ownedEventBindings: OSDEventBinding[] = [ ...eventBindings ];
    let bindingsActive = true;

    for (const [ eventName, eventHandler ] of ownedEventBindings) {
        Events.on(eventTarget, eventName, eventHandler);
    }

    return (): void => {
        if (!bindingsActive) {
            return;
        }
        bindingsActive = false;

        for (const [ eventName, eventHandler ] of ownedEventBindings) {
            Events.off(eventTarget, eventName, eventHandler);
        }
    };
}
