/**
 * Cancels sibling decode streams on the first failure and drains every stream
 * before the worker may report that its generation stopped.
 */
export async function settleConcurrentDecodeStreams(
    streamPromises: readonly Promise<void>[],
    cancelStreams: () => void
): Promise<void> {
    let firstFailure: unknown;
    let hasFailure = false;
    const drainingPromises: Array<Promise<void>> = [];

    for (const streamPromise of streamPromises) {
        const drainingPromise = streamPromise.catch((error: unknown): void => {
            if (hasFailure) {
                return;
            }

            hasFailure = true;
            firstFailure = error;
            cancelStreams();
        });
        drainingPromises.push(drainingPromise);
    }

    await Promise.all(drainingPromises);
    if (hasFailure) {
        throw firstFailure;
    }
}
