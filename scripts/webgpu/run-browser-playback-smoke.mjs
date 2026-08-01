/* eslint-disable compat/compat -- This local harness targets Node 24 and a current Chromium browser */

import {
    createFrontendRouteURL,
    parseSmokeConfiguration,
    sanitizeReport,
    SMOKE_USAGE,
    validateActivePlaybackSnapshot,
    validatePauseSnapshot,
    validateResumeSnapshot,
    validateSeekSnapshot,
    validateStopSnapshot
} from './browser-smoke-helpers.mjs';

const COMMAND_TIMEOUT_MILLISECONDS = 15_000;
const INPUT_CONTROL_MODIFIER = 2;
const PAGE_POLL_INTERVAL_MILLISECONDS = 100;
const PAUSE_OBSERVATION_MILLISECONDS = 900;
const PLAYBACK_OBSERVATION_MILLISECONDS = 750;
const RESUME_OBSERVATION_MILLISECONDS = 750;
const MICROSECONDS_PER_MILLISECOND = 1_000;
const MICROSECONDS_PER_SECOND = 1_000_000;
const MINIMUM_ACTIVE_PRESENTED_FRAMES = 3;
const WEBSOCKET_OPEN_STATE = 1;

class SmokeHarnessError extends Error {
    constructor(code, message, diagnostics = null) {
        super(message);
        this.code = code;
        this.diagnostics = diagnostics;
        this.name = 'SmokeHarnessError';
    }
}

class RawCDPClient {
    constructor(socket, commandTimeoutMilliseconds = COMMAND_TIMEOUT_MILLISECONDS) {
        this.commandTimeoutMilliseconds = commandTimeoutMilliseconds;
        this.eventListeners = new Map();
        this.nextCommandIdentifier = 1;
        this.pendingCommands = new Map();
        this.socket = socket;
        this.socket.addEventListener('message', event => this.handleMessage(event));
        this.socket.addEventListener('close', () => this.handleClose());
    }

    static async connect(webSocketDebuggerURL, timeoutMilliseconds) {
        const socket = new WebSocket(webSocketDebuggerURL);
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new SmokeHarnessError(
                    'debug-connection-timeout',
                    'Timed out while connecting to the browser debugging target'
                ));
            }, timeoutMilliseconds);
            socket.addEventListener('open', () => {
                clearTimeout(timeout);
                resolve();
            }, { once: true });
            socket.addEventListener('error', () => {
                clearTimeout(timeout);
                reject(new SmokeHarnessError(
                    'debug-connection-failed',
                    'Unable to connect to the browser debugging target'
                ));
            }, { once: true });
        });
        return new RawCDPClient(socket);
    }

    close() {
        if (this.socket.readyState === WEBSOCKET_OPEN_STATE) {
            this.socket.close();
        }
    }

    on(method, listener) {
        let listeners = this.eventListeners.get(method);
        if (!listeners) {
            listeners = new Set();
            this.eventListeners.set(method, listeners);
        }
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    send(method, parameters = {}) {
        if (this.socket.readyState !== WEBSOCKET_OPEN_STATE) {
            return Promise.reject(new SmokeHarnessError(
                'debug-connection-closed',
                'The browser debugging connection is not open'
            ));
        }

        const identifier = this.nextCommandIdentifier;
        this.nextCommandIdentifier += 1;
        const commandPromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingCommands.delete(identifier);
                reject(new SmokeHarnessError(
                    'debug-command-timeout',
                    `Browser debugging command timed out: ${method}`
                ));
            }, this.commandTimeoutMilliseconds);
            this.pendingCommands.set(identifier, {
                method,
                reject,
                resolve,
                timeout
            });
        });
        this.socket.send(JSON.stringify({ id: identifier, method, params: parameters }));
        return commandPromise;
    }

    handleClose() {
        for (const pendingCommand of this.pendingCommands.values()) {
            clearTimeout(pendingCommand.timeout);
            pendingCommand.reject(new SmokeHarnessError(
                'debug-connection-closed',
                `Browser debugging connection closed during: ${pendingCommand.method}`
            ));
        }
        this.pendingCommands.clear();
    }

    handleMessage(event) {
        let message;
        try {
            message = JSON.parse(String(event.data));
        } catch {
            return;
        }

        if (message.id) {
            const pendingCommand = this.pendingCommands.get(message.id);
            if (!pendingCommand) {
                return;
            }
            this.pendingCommands.delete(message.id);
            clearTimeout(pendingCommand.timeout);
            if (message.error) {
                pendingCommand.reject(new SmokeHarnessError(
                    'debug-command-failed',
                    `Browser debugging command failed: ${pendingCommand.method}`
                ));
            } else {
                pendingCommand.resolve(message.result);
            }
            return;
        }

        const listeners = this.eventListeners.get(message.method);
        if (!listeners) {
            return;
        }
        for (const listener of listeners) {
            listener(message.params);
        }
    }
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function getBrowserPageTarget(configuration) {
    let response;
    try {
        const targetListURL = new URL('/json/list', `${configuration.debugURL}/`);
        response = await fetch(targetListURL, {
            signal: AbortSignal.timeout(configuration.timeoutMilliseconds)
        });
    } catch {
        throw new SmokeHarnessError(
            'debug-target-list-failed',
            'Unable to read the browser remote-debugging target list'
        );
    }
    if (!response.ok) {
        throw new SmokeHarnessError(
            'debug-target-list-failed',
            'Browser remote-debugging target list returned an error'
        );
    }

    let targets;
    try {
        targets = await response.json();
    } catch {
        throw new SmokeHarnessError(
            'debug-target-list-invalid',
            'Browser remote-debugging target list was not valid JSON'
        );
    }
    if (!Array.isArray(targets)) {
        throw new SmokeHarnessError(
            'debug-target-list-invalid',
            'Browser remote-debugging target list was not an array'
        );
    }

    const frontendOrigin = new URL(configuration.frontendURL).origin;
    const matchingTarget = targets.find(target => {
        if (target?.type !== 'page' || typeof target.url !== 'string') {
            return false;
        }
        try {
            return new URL(target.url).origin === frontendOrigin;
        } catch {
            return false;
        }
    });
    const pageTarget = matchingTarget || targets.find(target => target?.type === 'page');
    if (!pageTarget || typeof pageTarget.webSocketDebuggerUrl !== 'string') {
        throw new SmokeHarnessError(
            'debug-page-missing',
            'No debuggable Chromium page target is available'
        );
    }
    return pageTarget;
}

async function evaluateValue(
    client,
    expression,
    awaitPromise = true,
    userGesture = false
) {
    const evaluation = await client.send('Runtime.evaluate', {
        awaitPromise,
        expression,
        returnByValue: true,
        userGesture
    });
    if (evaluation.exceptionDetails) {
        throw new SmokeHarnessError(
            'page-evaluation-failed',
            'An injected browser smoke operation failed'
        );
    }
    return evaluation.result?.value;
}

async function waitForValue(options) {
    const startedAtMilliseconds = Date.now();
    let lastValue;
    while (Date.now() - startedAtMilliseconds < options.timeoutMilliseconds) {
        lastValue = await options.read();
        if (options.accept(lastValue)) {
            return lastValue;
        }
        await sleep(PAGE_POLL_INTERVAL_MILLISECONDS);
    }
    throw new SmokeHarnessError(
        options.errorCode,
        `Timed out while waiting for ${options.description}`,
        lastValue
    );
}

function createVisibilityExpression(selectors) {
    return `(() => {
        const selectors = ${JSON.stringify(selectors)};
        const isVisible = element => {
            const rectangle = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rectangle.width > 0
                && rectangle.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && !element.classList.contains('hide');
        };
        for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            for (const element of elements) {
                if (isVisible(element)) {
                    const rectangle = element.getBoundingClientRect();
                    const horizontalCoordinate = rectangle.left + rectangle.width / 2;
                    const verticalCoordinate = rectangle.top + rectangle.height / 2;
                    const hitTarget = document.elementFromPoint(
                        horizontalCoordinate,
                        verticalCoordinate
                    );
                    if (!hitTarget || (hitTarget !== element && !element.contains(hitTarget))) {
                        continue;
                    }
                    return {
                        found: true,
                        x: horizontalCoordinate,
                        y: verticalCoordinate
                    };
                }
            }
        }
        return { found: false, x: 0, y: 0 };
    })()`;
}

async function getVisibleElement(client, selectors) {
    return evaluateValue(client, createVisibilityExpression(selectors));
}

async function waitForVisibleElement(client, selectors, configuration, description) {
    return waitForValue({
        accept: descriptor => descriptor?.found === true,
        description,
        errorCode: 'ui-element-timeout',
        read: () => getVisibleElement(client, selectors),
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
}

async function trustedClick(client, descriptor) {
    const activated = await evaluateValue(client, `(() => {
        const hitTarget = document.elementFromPoint(
            ${JSON.stringify(descriptor.x)},
            ${JSON.stringify(descriptor.y)}
        );
        const interactiveTarget = hitTarget?.closest?.(
            'button, input, select, textarea, a[href], [role="button"]'
        ) ?? hitTarget;
        if (!interactiveTarget) {
            return false;
        }
        interactiveTarget.focus?.({ preventScroll: true });
        interactiveTarget.click?.();
        return true;
    })()`, true, true);
    if (!activated) {
        throw new SmokeHarnessError(
            'ui-activation-failed',
            'Unable to activate the selected UI element'
        );
    }
}

async function trustedClickSelector(client, selectors, configuration, description) {
    const descriptor = await waitForVisibleElement(
        client,
        selectors,
        configuration,
        description
    );
    await trustedClick(client, descriptor);
}

async function dispatchControlKey(client, type, key, code, windowsVirtualKeyCode) {
    await client.send('Input.dispatchKeyEvent', {
        code,
        key,
        modifiers: INPUT_CONTROL_MODIFIER,
        type,
        windowsVirtualKeyCode
    });
}

async function clearFocusedInput(client) {
    await dispatchControlKey(client, 'rawKeyDown', 'a', 'KeyA', 65);
    await dispatchControlKey(client, 'keyUp', 'a', 'KeyA', 65);
    await client.send('Input.dispatchKeyEvent', {
        code: 'Backspace',
        key: 'Backspace',
        type: 'rawKeyDown',
        windowsVirtualKeyCode: 8
    });
    await client.send('Input.dispatchKeyEvent', {
        code: 'Backspace',
        key: 'Backspace',
        type: 'keyUp',
        windowsVirtualKeyCode: 8
    });
}

async function fillInput(client, selector, value, configuration, description) {
    await trustedClickSelector(client, [ selector ], configuration, description);
    await clearFocusedInput(client);
    await client.send('Input.insertText', { text: value });
}

async function navigate(client, navigationURL, configuration) {
    await client.send('Page.navigate', { url: navigationURL });
    await waitForValue({
        accept: readyState => readyState === 'complete' || readyState === 'interactive',
        description: 'the frontend document',
        errorCode: 'frontend-navigation-timeout',
        read: () => evaluateValue(client, 'document.readyState'),
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
}

async function connectToConfiguredServer(client, configuration) {
    const addServerURL = createFrontendRouteURL(configuration.frontendURL, '/addserver');
    await navigate(client, addServerURL, configuration);
    await fillInput(
        client,
        '#txtServerHost',
        configuration.serverURL,
        configuration,
        'the server address input'
    );
    await trustedClickSelector(
        client,
        [ '.addServerForm .button-submit' ],
        configuration,
        'the connect button'
    );

    await waitForValue({
        accept: state => state?.connecting === false,
        description: 'the server connection result',
        errorCode: 'server-connection-timeout',
        read: () => evaluateValue(client, `(() => {
            const addServerForm = document.querySelector('.addServerForm');
            const style = addServerForm ? getComputedStyle(addServerForm) : null;
            const formVisible = Boolean(addServerForm
                && style?.display !== 'none'
                && style?.visibility !== 'hidden'
                && !addServerForm.classList.contains('hide'));
            return {
                connecting: formVisible && location.hash.includes('addserver')
            };
        })()`),
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
}

async function signInIfRequired(client, configuration) {
    const landingState = await waitForValue({
        accept: state => state?.authenticated === true || state?.loginVisible === true,
        description: 'the connected server landing page',
        errorCode: 'server-landing-timeout',
        read: () => evaluateValue(client, `(() => {
            const loginPage = document.querySelector('#loginPage');
            const loginStyle = loginPage ? getComputedStyle(loginPage) : null;
            const loginVisible = Boolean(loginPage
                && loginPage.getBoundingClientRect().width > 0
                && loginPage.getBoundingClientRect().height > 0
                && loginStyle?.display !== 'none'
                && loginStyle?.visibility !== 'hidden'
                && !loginPage.classList.contains('hide'));
            const route = location.hash.toLowerCase();
            const authenticationRoute = route.includes('login')
                || route.includes('addserver')
                || route.includes('selectserver');
            return {
                authenticated: route.length > 0 && !authenticationRoute,
                loginVisible
            };
        })()`),
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
    if (landingState.authenticated) {
        return false;
    }

    const manualName = await getVisibleElement(client, [ '#txtManualName' ]);
    if (!manualName?.found) {
        await trustedClickSelector(
            client,
            [ '#loginPage .btnManual' ],
            configuration,
            'the manual login button'
        );
    }
    await fillInput(
        client,
        '#txtManualName',
        configuration.username,
        configuration,
        'the username input'
    );
    await fillInput(
        client,
        '#txtManualPassword',
        configuration.password,
        configuration,
        'the password input'
    );
    await trustedClickSelector(
        client,
        [ '#loginPage .manualLoginForm .button-submit' ],
        configuration,
        'the sign-in button'
    );
    await waitForValue({
        accept: descriptor => descriptor?.found === false,
        description: 'login completion',
        errorCode: 'login-timeout',
        read: () => getVisibleElement(client, [ '#loginPage' ]),
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
    return true;
}

async function hasMatchingAuthenticatedServer(client, configuration) {
    const activeServer = await evaluateValue(client, `(() => {
        if (typeof ApiClient !== 'object') {
            return null;
        }
        try {
            return {
                address: ApiClient.serverAddress(),
                authenticated: Boolean(ApiClient.accessToken?.())
                    && Boolean(ApiClient.getCurrentUserId?.())
            };
        } catch {
            return null;
        }
    })()`);
    if (!activeServer?.authenticated || typeof activeServer.address !== 'string') {
        return false;
    }

    return activeServer.address.replace(/\/$/u, '') === configuration.serverURL;
}

function createPlayerCaptureHookExpression(accessKey, restoreKey) {
    return `(() => {
        const events = window.Events;
        if (!events || typeof events.trigger !== 'function') {
            return false;
        }
        const originalTrigger = events.trigger;
        let capturedPlayer = null;
        const eventCounts = {
            error: 0,
            pause: 0,
            playing: 0,
            stopped: 0,
            unpause: 0,
            waiting: 0
        };
        const wrapper = function(target, type, args) {
            if (target === wrapper && type === ${JSON.stringify(accessKey)}) {
                return { eventCounts: { ...eventCounts }, player: capturedPlayer };
            }
            if (target === wrapper && type === ${JSON.stringify(restoreKey)}) {
                capturedPlayer = null;
                events.trigger = originalTrigger;
                return true;
            }
            const argumentPlayer = type === 'playbackstart'
                && Array.isArray(args)
                && args[0]?.id === 'webgpuvideoplayer'
                ? args[0]
                : null;
            if (target?.id === 'webgpuvideoplayer') {
                capturedPlayer = target;
            } else if (argumentPlayer) {
                capturedPlayer = argumentPlayer;
            }
            if (capturedPlayer && target === capturedPlayer
                && Object.hasOwn(eventCounts, type)) {
                eventCounts[type] += 1;
            }
            return Reflect.apply(originalTrigger, this, [ target, type, args ]);
        };
        events.trigger = wrapper;
        return true;
    })()`;
}

function createPlayerSnapshotExpression(accessKey) {
    return `(() => {
        if (!window.Events || typeof window.Events.trigger !== 'function') {
            return { captured: false };
        }
        const capture = window.Events.trigger(
            window.Events.trigger,
            ${JSON.stringify(accessKey)}
        );
        const player = capture?.player;
        if (!player) {
            return {
                captured: false,
                stoppedEventCount: capture?.eventCounts?.stopped ?? 0,
                terminalErrorCount: capture?.eventCounts?.error ?? 0
            };
        }
        const custom = typeof player.getCustomPlaybackTelemetry === 'function'
            ? player.getCustomPlaybackTelemetry()
            : null;
        const presentation = typeof player.getPresentationTelemetry === 'function'
            ? player.getPresentationTelemetry()
            : null;
        const videos = Array.from(document.querySelectorAll('.videoPlayerContainer video'));
        const canvases = Array.from(document.querySelectorAll(
            '.videoPlayerContainer .webgpuVideoPlayerCanvas'
        ));
        const isVisible = element => {
            const rectangle = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rectangle.width > 0
                && rectangle.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && !element.classList.contains('hide');
        };
        const isSourceLess = video => !video.getAttribute('src') && !video.currentSrc;
        let currentSource = null;
        if (typeof player.currentSrc === 'function') {
            currentSource = player.currentSrc();
        }
        const fetchingValue = typeof player.isFetching === 'function'
            ? player.isFetching()
            : player.isFetching;
        return {
            captured: true,
            customPlayback: custom ? {
                activeGeneration: custom.activeGeneration,
                audioPath: custom.audioPath,
                currentTimeMicroseconds: custom.currentTimeMicroseconds,
                durationMicroseconds: custom.durationMicroseconds,
                fallbackCount: custom.fallbackCount,
                fallbackReason: custom.fallbackReason,
                hasLastError: typeof custom.lastErrorMessage === 'string'
                    && custom.lastErrorMessage.length > 0,
                staleEventCount: custom.staleEventCount,
                state: custom.state,
                videoDecode: custom.videoDecode ? {
                    droppedFrameCount: custom.videoDecode.droppedFrameCount,
                    failureKind: custom.videoDecode.failureKind,
                    queuedFrameCount: custom.videoDecode.queuedFrameCount,
                    receivedAudioFrameCount: custom.videoDecode.receivedAudioFrameCount,
                    receivedFrameCount: custom.videoDecode.receivedFrameCount,
                    staleAudioSampleCount: custom.videoDecode.staleAudioSampleCount,
                    staleFrameCount: custom.videoDecode.staleFrameCount,
                    state: custom.videoDecode.state,
                    takenFrameCount: custom.videoDecode.takenFrameCount
                } : null
            } : null,
            dom: {
                canvasCount: canvases.length,
                sourceLessVideoCount: videos.filter(isSourceLess).length,
                sourcedVideoCount: videos.filter(video => !isSourceLess(video)).length,
                videoCount: videos.length,
                visibleCanvasCount: canvases.filter(isVisible).length
            },
            eventCounts: { ...capture.eventCounts },
            hasCurrentSource: typeof currentSource === 'string'
                ? currentSource.length > 0
                : currentSource != null,
            isFetching: Boolean(fetchingValue),
            playerID: String(player.id || ''),
            presentation: presentation ? {
                decodedFrameCount: presentation.decodedFrameCount,
                deviceRecoveryCount: presentation.deviceRecoveryCount,
                fallbackReason: presentation.fallbackReason,
                firstFrameLatencyMicroseconds: presentation.firstFrameLatencyMicroseconds,
                mode: presentation.mode,
                nativeFrameCount: presentation.nativeFrameCount,
                presentationSource: presentation.presentationSource,
                presentedFrameCount: presentation.presentedFrameCount,
                state: presentation.state
            } : null,
            stoppedEventCount: capture.eventCounts.stopped,
            terminalErrorCount: capture.eventCounts.error
        };
    })()`;
}

function createPlayerOperationExpression(accessKey, operation) {
    return `(async () => {
        const capture = window.Events?.trigger?.(
            window.Events.trigger,
            ${JSON.stringify(accessKey)}
        );
        const player = capture?.player;
        if (!player) {
            return false;
        }
        ${operation}
        return true;
    })()`;
}

async function getPlayerSnapshot(client, accessKey) {
    return evaluateValue(client, createPlayerSnapshotExpression(accessKey));
}

async function waitForPlayerSnapshot(options) {
    return waitForValue({
        accept: options.accept,
        description: options.description,
        errorCode: options.errorCode,
        read: () => getPlayerSnapshot(options.client, options.accessKey),
        timeoutMilliseconds: options.timeoutMilliseconds
    });
}

function appendFailures(target, phase, failures) {
    for (const failure of failures) {
        target.push(`${phase}:${failure}`);
    }
}

function calculateSeekTargetMicroseconds(snapshot) {
    const currentTimeMicroseconds = snapshot.customPlayback.currentTimeMicroseconds;
    const durationMicroseconds = snapshot.customPlayback.durationMicroseconds;
    const desiredForwardTarget = currentTimeMicroseconds + (5 * MICROSECONDS_PER_SECOND);
    if (Number.isSafeInteger(durationMicroseconds)
        && durationMicroseconds > 8 * MICROSECONDS_PER_SECOND) {
        const maximumTarget = durationMicroseconds - (2 * MICROSECONDS_PER_SECOND);
        if (desiredForwardTarget <= maximumTarget) {
            return desiredForwardTarget;
        }
        return Math.max(
            MICROSECONDS_PER_SECOND,
            Math.floor(durationMicroseconds * 0.35)
        );
    }
    return desiredForwardTarget;
}

function createBrowserErrorMonitor(client) {
    const MAXIMUM_DIAGNOSTIC_MESSAGES = 20;
    const counts = {
        consoleErrors: 0,
        ignoredUnattributedScriptErrors: 0,
        logErrors: 0,
        runtimeExceptions: 0
    };
    const messages = [];
    const addMessage = message => {
        if (typeof message === 'string'
            && message.length > 0
            && messages.length < MAXIMUM_DIAGNOSTIC_MESSAGES) {
            messages.push(message.slice(0, 512));
        }
    };
    client.on('Runtime.consoleAPICalled', parameters => {
        if (parameters?.type === 'error' || parameters?.type === 'assert') {
            counts.consoleErrors += 1;
        }
        if (parameters?.type === 'error'
            || parameters?.type === 'assert'
            || parameters?.type === 'warning') {
            addMessage(parameters.args?.map(argument => (
                argument.value ?? argument.description ?? ''
            )).join(' '));
        }
    });
    client.on('Runtime.exceptionThrown', parameters => {
        counts.runtimeExceptions += 1;
        addMessage(parameters?.exceptionDetails?.text);
    });
    client.on('Log.entryAdded', parameters => {
        const entry = parameters?.entry;
        const ignoredUnattributedScriptError = entry?.source === 'network'
            && !entry.url
            && entry.text === 'A bad HTTP response code (404) was received when fetching the script.';
        if (ignoredUnattributedScriptError) {
            counts.ignoredUnattributedScriptErrors += 1;
        } else if (entry?.level === 'error') {
            counts.logErrors += 1;
        }
        if (entry?.level === 'error' || entry?.level === 'warning') {
            let resourcePath = '';
            try {
                resourcePath = entry.url ? new URL(entry.url).pathname : '';
            } catch {
                resourcePath = '';
            }
            addMessage(`${entry.source || 'unknown'} ${resourcePath}: ${entry.text}`);
        }
    });
    return {
        counts,
        messages,
        reset: () => {
            counts.consoleErrors = 0;
            counts.ignoredUnattributedScriptErrors = 0;
            counts.logErrors = 0;
            counts.runtimeExceptions = 0;
            messages.length = 0;
        }
    };
}

function attachBrowserDiagnostics(error, browserErrorMonitor) {
    if (!(error instanceof SmokeHarnessError)) {
        return;
    }

    error.diagnostics = {
        browserErrors: { ...browserErrorMonitor.counts },
        browserMessages: [ ...browserErrorMonitor.messages ],
        lastObservation: error.diagnostics
    };
}

async function reloadFreshFrontend(client, configuration) {
    const frontendURL = new URL(configuration.frontendURL);
    frontendURL.searchParams.set('webgpuSmokeRun', String(Date.now()));
    await navigate(client, frontendURL.toString(), configuration);
    await waitForValue({
        accept: state => state?.ready === true,
        description: 'fresh frontend initialization',
        errorCode: 'frontend-initialization-timeout',
        read: () => evaluateValue(client, `({
            ready: typeof ApiClient === 'object'
                || Boolean(document.querySelector('#txtServerHost'))
        })`),
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
}

async function clearFrontendRuntimeCaches(client) {
    await evaluateValue(client, `(async () => {
        const registrations = typeof navigator.serviceWorker?.getRegistrations === 'function'
            ? await navigator.serviceWorker.getRegistrations()
            : [];
        await Promise.all(registrations.map(registration => registration.unregister()));
        const cacheNames = typeof globalThis.caches?.keys === 'function'
            ? await globalThis.caches.keys()
            : [];
        await Promise.all(cacheNames.map(cacheName => globalThis.caches.delete(cacheName)));
        return true;
    })()`);
}

async function runPlaybackExercise(client, configuration, browserErrorMonitor) {
    const serverID = await waitForValue({
        accept: value => typeof value === 'string' && value.length > 0,
        description: 'the active Jellyfin server identifier',
        errorCode: 'server-identifier-timeout',
        read: () => evaluateValue(
            client,
            "typeof ApiClient === 'object' ? ApiClient.serverId() : null"
        ),
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
    const detailsURL = createFrontendRouteURL(
        configuration.frontendURL,
        `/details?id=${encodeURIComponent(configuration.itemID)}`
            + `&serverId=${encodeURIComponent(serverID)}`
    );
    await navigate(client, detailsURL, configuration);
    const playButton = await waitForVisibleElement(
        client,
        [
            '.itemDetailPage .btnReplay:not(.hide)',
            '.itemDetailPage .btnPlay:not(.hide)'
        ],
        configuration,
        'the item play button'
    );

    const accessKey = `webgpu-smoke-access-${crypto.randomUUID()}`;
    const restoreKey = `webgpu-smoke-restore-${crypto.randomUUID()}`;
    let hookInstalled = false;
    let playInvoked = false;
    let stopInvoked = false;
    try {
        hookInstalled = await evaluateValue(
            client,
            createPlayerCaptureHookExpression(accessKey, restoreKey)
        );
        if (!hookInstalled) {
            throw new SmokeHarnessError(
                'events-hook-failed',
                'window.Events.trigger was unavailable before playback'
            );
        }

        browserErrorMonitor.reset();
        await trustedClick(client, playButton);
        playInvoked = true;
        const activeInitial = await waitForPlayerSnapshot({
            accept: snapshot => snapshot?.captured === true
                && snapshot.playerID === 'webgpuvideoplayer'
                && snapshot.customPlayback?.state === 'playing'
                && (snapshot.customPlayback?.videoDecode?.receivedFrameCount ?? 0)
                    >= MINIMUM_ACTIVE_PRESENTED_FRAMES
                && snapshot.presentation?.state === 'presenting'
                && (snapshot.presentation?.presentedFrameCount ?? 0)
                    >= MINIMUM_ACTIVE_PRESENTED_FRAMES,
            accessKey,
            client,
            description: 'active custom-decoded WebGPU playback',
            errorCode: 'custom-playback-timeout',
            timeoutMilliseconds: configuration.timeoutMilliseconds
        });
        await sleep(PLAYBACK_OBSERVATION_MILLISECONDS);
        const activeLater = await getPlayerSnapshot(client, accessKey);

        const pauseResult = await evaluateValue(
            client,
            createPlayerOperationExpression(accessKey, 'player.pause();')
        );
        if (!pauseResult) {
            throw new SmokeHarnessError('pause-failed', 'Unable to invoke player pause');
        }
        const pauseInitial = await waitForPlayerSnapshot({
            accept: snapshot => snapshot?.customPlayback?.state === 'paused',
            accessKey,
            client,
            description: 'the custom playback pause state',
            errorCode: 'pause-timeout',
            timeoutMilliseconds: configuration.timeoutMilliseconds
        });
        await sleep(PAUSE_OBSERVATION_MILLISECONDS);
        const pauseLater = await getPlayerSnapshot(client, accessKey);

        const resumeResult = await evaluateValue(
            client,
            createPlayerOperationExpression(accessKey, 'player.resume();')
        );
        if (!resumeResult) {
            throw new SmokeHarnessError('resume-failed', 'Unable to invoke player resume');
        }
        const resumeInitial = await waitForPlayerSnapshot({
            accept: snapshot => snapshot?.customPlayback?.state === 'playing',
            accessKey,
            client,
            description: 'the custom playback resume state',
            errorCode: 'resume-timeout',
            timeoutMilliseconds: configuration.timeoutMilliseconds
        });
        await sleep(RESUME_OBSERVATION_MILLISECONDS);
        const resumeLater = await getPlayerSnapshot(client, accessKey);

        const seekTargetMicroseconds = calculateSeekTargetMicroseconds(resumeLater);
        const seekTargetMilliseconds = Math.floor(
            seekTargetMicroseconds / MICROSECONDS_PER_MILLISECOND
        );
        const seekResult = await evaluateValue(
            client,
            createPlayerOperationExpression(
                accessKey,
                `player.currentTime(${seekTargetMilliseconds});`
            )
        );
        if (!seekResult) {
            throw new SmokeHarnessError('seek-failed', 'Unable to invoke player seek');
        }
        const seekSnapshot = await waitForPlayerSnapshot({
            accept: snapshot => snapshot?.customPlayback
                && (snapshot.customPlayback.state === 'playing'
                    || snapshot.customPlayback.state === 'paused')
                && Math.abs(
                    snapshot.customPlayback.currentTimeMicroseconds - seekTargetMicroseconds
                ) <= 2 * MICROSECONDS_PER_SECOND
                && snapshot.presentation?.state === 'presenting',
            accessKey,
            client,
            description: 'the custom playback seek target',
            errorCode: 'seek-timeout',
            timeoutMilliseconds: configuration.timeoutMilliseconds
        });

        stopInvoked = true;
        const stopResult = await evaluateValue(
            client,
            createPlayerOperationExpression(
                accessKey,
                'await Promise.resolve(player.stop(false));'
            )
        );
        if (!stopResult) {
            throw new SmokeHarnessError('stop-failed', 'Unable to invoke player stop');
        }
        const stopSnapshot = await waitForPlayerSnapshot({
            accept: snapshot => snapshot?.presentation?.state === 'idle'
                && snapshot.dom?.canvasCount === 0
                && snapshot.hasCurrentSource === false
                && snapshot.isFetching === false
                && snapshot.stoppedEventCount >= 1,
            accessKey,
            client,
            description: 'custom playback stop cleanup',
            errorCode: 'stop-cleanup-timeout',
            timeoutMilliseconds: configuration.timeoutMilliseconds
        });

        const failures = [];
        appendFailures(
            failures,
            'playback',
            validateActivePlaybackSnapshot(activeInitial, activeLater)
        );
        appendFailures(
            failures,
            'pause',
            validatePauseSnapshot(pauseInitial, pauseLater)
        );
        appendFailures(
            failures,
            'resume',
            validateResumeSnapshot(resumeInitial, resumeLater)
        );
        appendFailures(
            failures,
            'seek',
            validateSeekSnapshot(seekSnapshot, seekTargetMicroseconds)
        );
        appendFailures(failures, 'stop', validateStopSnapshot(stopSnapshot));
        if (browserErrorMonitor.counts.runtimeExceptions > 0) {
            failures.push('browser:runtime-exception');
        }
        if (browserErrorMonitor.counts.consoleErrors > 0) {
            failures.push('browser:console-error');
        }
        if (browserErrorMonitor.counts.logErrors > 0) {
            failures.push('browser:log-error');
        }

        return {
            diagnostics: {
                browserErrors: { ...browserErrorMonitor.counts },
                browserMessages: [ ...browserErrorMonitor.messages ],
                eventCounts: stopSnapshot.eventCounts
            },
            failures,
            observations: {
                pause: {
                    clockDeltaMicroseconds:
                        pauseLater.customPlayback.currentTimeMicroseconds
                        - pauseInitial.customPlayback.currentTimeMicroseconds,
                    presentedFrameDelta:
                        pauseLater.presentation.presentedFrameCount
                        - pauseInitial.presentation.presentedFrameCount
                },
                playback: activeLater,
                resume: {
                    clockDeltaMicroseconds:
                        resumeLater.customPlayback.currentTimeMicroseconds
                        - resumeInitial.customPlayback.currentTimeMicroseconds,
                    presentedFrameDelta:
                        resumeLater.presentation.presentedFrameCount
                        - resumeInitial.presentation.presentedFrameCount
                },
                seek: {
                    actualMicroseconds: seekSnapshot.customPlayback.currentTimeMicroseconds,
                    targetMicroseconds: seekTargetMicroseconds
                },
                stop: stopSnapshot
            }
        };
    } finally {
        if (hookInstalled && playInvoked && !stopInvoked) {
            try {
                await evaluateValue(
                    client,
                    createPlayerOperationExpression(
                        accessKey,
                        'await Promise.resolve(player.stop(false));'
                    )
                );
            } catch {
                // Preserve the first failure while making a bounded cleanup attempt
            }
        }
        if (hookInstalled) {
            try {
                await evaluateValue(
                    client,
                    `window.Events?.trigger?.(
                        window.Events.trigger,
                        ${JSON.stringify(restoreKey)}
                    )`
                );
            } catch {
                // The page may have navigated or closed after the primary result
            }
        }
    }
}

async function runSmoke(configuration) {
    const pageTarget = await getBrowserPageTarget(configuration);
    const client = await RawCDPClient.connect(
        pageTarget.webSocketDebuggerUrl,
        configuration.timeoutMilliseconds
    );
    try {
        await Promise.all([
            client.send('Log.enable'),
            client.send('Network.enable'),
            client.send('Page.enable'),
            client.send('Runtime.enable')
        ]);
        await Promise.all([
            client.send('Network.setBypassServiceWorker', { bypass: true }),
            client.send('Network.setCacheDisabled', { cacheDisabled: true })
        ]);
        await client.send('Page.bringToFront');
        await clearFrontendRuntimeCaches(client);
        await reloadFreshFrontend(client, configuration);
        const browserErrorMonitor = createBrowserErrorMonitor(client);
        const alreadyAuthenticated = await hasMatchingAuthenticatedServer(
            client,
            configuration
        );
        if (!alreadyAuthenticated) {
            await connectToConfiguredServer(client, configuration);
        }
        const loginPerformed = alreadyAuthenticated ?
            false :
            await signInIfRequired(client, configuration);
        const browserVersion = await client.send('Browser.getVersion');
        let playbackResult;
        try {
            playbackResult = await runPlaybackExercise(
                client,
                configuration,
                browserErrorMonitor
            );
        } catch (error) {
            attachBrowserDiagnostics(error, browserErrorMonitor);
            throw error;
        }
        return {
            browser: {
                product: browserVersion.product || 'unknown',
                protocolVersion: browserVersion.protocolVersion || 'unknown'
            },
            diagnostics: playbackResult.diagnostics,
            failures: playbackResult.failures,
            loginPerformed,
            observations: playbackResult.observations,
            schemaVersion: 1,
            status: playbackResult.failures.length === 0 ? 'passed' : 'failed'
        };
    } finally {
        client.close();
    }
}

function createFailureReport(error) {
    return {
        diagnostics: error instanceof SmokeHarnessError ? error.diagnostics : null,
        error: {
            code: error instanceof SmokeHarnessError ? error.code : 'unexpected-error',
            message: error instanceof Error ? error.message : 'Unknown browser smoke failure'
        },
        failures: [
            error instanceof SmokeHarnessError ? error.code : 'unexpected-error'
        ],
        schemaVersion: 1,
        status: 'failed'
    };
}

let configuration;
try {
    configuration = parseSmokeConfiguration(process.argv.slice(2), process.env);
    if (configuration.help === true) {
        process.stdout.write(`${SMOKE_USAGE}\n`);
    } else {
        const report = await runSmoke(configuration);
        const sanitizedReport = sanitizeReport(report, [
            configuration.debugURL,
            configuration.frontendURL,
            configuration.password,
            configuration.serverURL,
            configuration.username
        ]);
        process.stdout.write(`${JSON.stringify(sanitizedReport, null, 2)}\n`);
        if (report.status !== 'passed') {
            process.exitCode = 1;
        }
    }
} catch (error) {
    const secrets = configuration?.help === true || !configuration ? [] : [
        configuration.debugURL,
        configuration.frontendURL,
        configuration.password,
        configuration.serverURL,
        configuration.username
    ];
    const sanitizedReport = sanitizeReport(createFailureReport(error), secrets);
    process.stdout.write(`${JSON.stringify(sanitizedReport, null, 2)}\n`);
    process.exitCode = 1;
}

/* eslint-enable compat/compat */
