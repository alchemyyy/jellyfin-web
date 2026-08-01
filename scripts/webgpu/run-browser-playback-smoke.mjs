/* eslint-disable compat/compat -- This local harness targets Node 24 and a current Chromium browser */

import {
    createPrimarySeekTargetMicroseconds,
    createSeekStormTargetsMicroseconds,
    createFrontendRouteURL,
    deriveRawHDRPlaybackRouteKey,
    parseSmokeConfiguration,
    sanitizeReport,
    SMOKE_USAGE,
    validateActivePlaybackSnapshot,
    validateAudioStreamSwitchSnapshot,
    validateControlEventTransitions,
    validateFullscreenTransitionSnapshots,
    validateInjectedDeviceRecoverySnapshot,
    validateInjectedPresentationFallbackSnapshot,
    validateNaturalEndSnapshots,
    validatePausedDeviceRecoverySnapshots,
    validatePauseSnapshot,
    validatePresentedFrameEvidence,
    validateResizedPresentationSnapshot,
    validateResumeSnapshot,
    validateSeekStormSnapshot,
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
const PRESENTED_FRAME_SAMPLE_HEIGHT = 36;
const PRESENTED_FRAME_SAMPLE_WIDTH = 64;
const DEVICE_RECOVERY_POLL_MILLISECONDS = 25;
const DEVICE_RECOVERY_WAIT_MILLISECONDS = 10_000;
const FULLSCREEN_OBSERVATION_MILLISECONDS = 500;
const MAXIMUM_CAPTURED_CONTROL_EVENTS = 128;
const NATURAL_END_STABILITY_OBSERVATION_MILLISECONDS = 750;
const RESIZE_OBSERVATION_MILLISECONDS = 500;
const PLAY_BUTTON_SELECTORS = Object.freeze([
    '.itemDetailPage .btnReplay:not(.hide)',
    '.itemDetailPage .btnPlay:not(.hide)'
]);
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
            let apiAuthenticated = false;
            try {
                apiAuthenticated = typeof ApiClient === 'object'
                    && Boolean(ApiClient.accessToken?.())
                    && Boolean(ApiClient.getCurrentUserId?.());
            } catch {
                apiAuthenticated = false;
            }
            return {
                authenticated: apiAuthenticated
                    && route.length > 0
                    && !authenticationRoute,
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
        accept: authenticated => authenticated === true,
        description: 'login completion',
        errorCode: 'login-timeout',
        read: () => evaluateValue(client, `(() => {
            try {
                return typeof ApiClient === 'object'
                    && Boolean(ApiClient.accessToken?.())
                    && Boolean(ApiClient.getCurrentUserId?.());
            } catch {
                return false;
            }
        })()`),
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
            ended: 0,
            error: 0,
            fullscreenchange: 0,
            pause: 0,
            playbackstart: 0,
            playing: 0,
            stopped: 0,
            timeupdate: 0,
            unpause: 0,
            volumechange: 0,
            waiting: 0
        };
        const controlEventSequence = [];
        const sequencedEventTypes = new Set([
            'ended',
            'error',
            'fullscreenchange',
            'pause',
            'playbackstart',
            'playing',
            'stopped',
            'unpause',
            'waiting'
        ]);
        const wrapper = function(target, type, args) {
            if (target === wrapper && type === ${JSON.stringify(accessKey)}) {
                return {
                    eventCounts: { ...eventCounts },
                    eventSequence: [ ...controlEventSequence ],
                    player: capturedPlayer
                };
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
                if (sequencedEventTypes.has(type)
                    && controlEventSequence.length
                        < ${MAXIMUM_CAPTURED_CONTROL_EVENTS}) {
                    controlEventSequence.push(type);
                }
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
                eventCounts: { ...(capture?.eventCounts ?? {}) },
                eventSequence: [ ...(capture?.eventSequence ?? []) ],
                stoppedEventCount: capture?.eventCounts?.stopped ?? 0,
                terminalErrorCount: capture?.eventCounts?.error ?? 0
            };
        }
        const custom = typeof player.getCustomPlaybackTelemetry === 'function'
            ? player.getCustomPlaybackTelemetry()
            : null;
        const customEligibility = typeof player.getCustomPlaybackEligibility === 'function'
            ? player.getCustomPlaybackEligibility()
            : null;
        const presentation = typeof player.getPresentationTelemetry === 'function'
            ? player.getPresentationTelemetry()
            : null;
        const rawHDRAuthorization = customEligibility?.eligible === true
            && customEligibility.hdr === true
            && customEligibility.videoOutputMode === 'raw-planes'
            && typeof player.getRawHDRAuthorizationTelemetry === 'function' ?
            player.getRawHDRAuthorizationTelemetry() :
            null;
        const activeRawFrameFormat = player.presenter?.activeRawFrameFormat;
        const activeRawColorMetadata = player.presenter?.activeInputColorMetadata;
        const deriveRouteKey = ${deriveRawHDRPlaybackRouteKey.toString()};
        const rawHDRPlaybackRouteKey = deriveRouteKey(
            activeRawFrameFormat,
            activeRawColorMetadata
        );
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
        const sourcedVideo = videos.find(video => !isSourceLess(video)) ?? null;
        const primaryCanvas = canvases.find(isVisible) ?? canvases[0] ?? null;
        const canvasRectangle = primaryCanvas?.getBoundingClientRect() ?? null;
        const fullscreenElement = document.fullscreenElement;
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
                audioBridge: custom.audioBridge ? {
                    failed: custom.audioBridge.failed,
                    pendingFrameCount: custom.audioBridge.pendingFrameCount,
                    pendingSampleCount: custom.audioBridge.pendingSampleCount,
                    releasedSampleCredits: custom.audioBridge.releasedSampleCredits,
                    staleSampleCount: custom.audioBridge.staleSampleCount,
                    submittedEndMediaTimeMicroseconds:
                        custom.audioBridge.submittedEndMediaTimeMicroseconds,
                    submittedFrameCount: custom.audioBridge.submittedFrameCount,
                    submittedSampleCount: custom.audioBridge.submittedSampleCount
                } : null,
                audioOutput: custom.audioOutput ? {
                    consumedFrames: custom.audioOutput.consumedFrames,
                    droppedFrames: custom.audioOutput.droppedFrames,
                    hasPhysicalOutputTimeCorrelation:
                        custom.audioOutput.hasPhysicalOutputTimeCorrelation,
                    mediaTimeContextTimeMicroseconds:
                        custom.audioOutput.mediaTimeContextTimeMicroseconds,
                    mediaTimeMicroseconds: custom.audioOutput.mediaTimeMicroseconds,
                    overflowEvents: custom.audioOutput.overflowEvents,
                    overflowFrames: custom.audioOutput.overflowFrames,
                    outputFrames: custom.audioOutput.outputFrames,
                    playing: custom.audioOutput.playing,
                    queuedFrames: custom.audioOutput.queuedFrames,
                    staleChunks: custom.audioOutput.staleChunks,
                    underflowEvents: custom.audioOutput.underflowEvents,
                    underflowFrames: custom.audioOutput.underflowFrames
                } : null,
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
                    abandonedRawFrameCount: custom.videoDecode.abandonedRawFrameCount,
                    activeGeneration: custom.videoDecode.activeGeneration,
                    audioCodec: custom.videoDecode.audioCodec,
                    droppedFrameCount: custom.videoDecode.droppedFrameCount,
                    failureKind: custom.videoDecode.failureKind,
                    peakFrameCount: custom.videoDecode.peakFrameCount,
                    pendingFrameCount: custom.videoDecode.pendingFrameCount,
                    queuedFrameCount: custom.videoDecode.queuedFrameCount,
                    receivedAudioFrameCount: custom.videoDecode.receivedAudioFrameCount,
                    receivedFrameCount: custom.videoDecode.receivedFrameCount,
                    recycledRawFrameCount: custom.videoDecode.recycledRawFrameCount,
                    staleAudioSampleCount: custom.videoDecode.staleAudioSampleCount,
                    staleFrameCount: custom.videoDecode.staleFrameCount,
                    state: custom.videoDecode.state,
                    takenFrameCount: custom.videoDecode.takenFrameCount
                } : null
            } : null,
            customPlaybackEligibility: customEligibility ? {
                eligible: customEligibility.eligible,
                hdr: customEligibility.eligible ? customEligibility.hdr : null,
                reason: customEligibility.eligible ? null : customEligibility.reason,
                videoDecoderBackend: customEligibility.eligible
                    ? customEligibility.videoDecoderBackend
                    : null,
                videoOutputMode: customEligibility.eligible
                    ? customEligibility.videoOutputMode
                    : null
            } : null,
            dom: {
                canvasBackingHeight: primaryCanvas?.height ?? null,
                canvasBackingWidth: primaryCanvas?.width ?? null,
                canvasCount: canvases.length,
                canvasCSSHeight: canvasRectangle?.height ?? null,
                canvasCSSWidth: canvasRectangle?.width ?? null,
                devicePixelRatio: window.devicePixelRatio,
                fullscreenActive: fullscreenElement !== null,
                fullscreenContainsCanvas: Boolean(
                    fullscreenElement
                        && primaryCanvas
                        && fullscreenElement.contains(primaryCanvas)
                ),
                nativeVideoPlaying: sourcedVideo ? !sourcedVideo.paused : false,
                nativeVideoTimeMicroseconds: sourcedVideo
                    && Number.isFinite(sourcedVideo.currentTime)
                    ? Math.round(sourcedVideo.currentTime * 1_000_000)
                    : null,
                sourceLessVideoCount: videos.filter(isSourceLess).length,
                sourcedVideoCount: videos.filter(video => !isSourceLess(video)).length,
                videoCount: videos.length,
                viewportHeight: window.innerHeight,
                viewportWidth: window.innerWidth,
                visibleCanvasCount: canvases.filter(isVisible).length
            },
            eventCounts: { ...capture.eventCounts },
            eventSequence: [ ...capture.eventSequence ],
            hasCurrentSource: typeof currentSource === 'string'
                ? currentSource.length > 0
                : currentSource != null,
            isFetching: Boolean(fetchingValue),
            playerID: String(player.id || ''),
            sessionGeneration: Number.isSafeInteger(player.backendSessionGeneration)
                ? player.backendSessionGeneration
                : null,
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
            rawHDRValidation: rawHDRAuthorization ? {
                authorizedRouteKeys: [ ...rawHDRAuthorization.authorizedRouteKeys ],
                failureReasons: { ...rawHDRAuthorization.failureReasons },
                fixtureVersion: rawHDRAuthorization.fixtureVersion,
                pendingRouteKeys: [ ...rawHDRAuthorization.pendingRouteKeys ],
                rejectedRouteKeys: [ ...rawHDRAuthorization.rejectedRouteKeys ],
                renderSettingsVersion: rawHDRAuthorization.renderSettingsVersion,
                status: rawHDRAuthorization.status,
                targetFormat: rawHDRAuthorization.targetFormat
            } : null,
            rawHDRPlaybackRouteKey,
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

async function capturePresentedFrameEvidence(client) {
    const captureRectangle = await evaluateValue(client, `(() => {
        const canvases = Array.from(document.querySelectorAll(
            '.videoPlayerContainer .webgpuVideoPlayerCanvas'
        ));
        const canvas = canvases.find(candidate => {
            const rectangle = candidate.getBoundingClientRect();
            const style = getComputedStyle(candidate);
            return rectangle.width > 0
                && rectangle.height > 0
                && style.display !== 'none'
                && style.visibility !== 'hidden'
                && !candidate.classList.contains('hide');
        }) ?? null;
        if (!canvas) {
            return null;
        }
        const rectangle = canvas.getBoundingClientRect();
        const x = Math.max(0, rectangle.left);
        const y = Math.max(0, rectangle.top);
        const right = Math.min(window.innerWidth, rectangle.right);
        const bottom = Math.min(window.innerHeight, rectangle.bottom);
        const width = right - x;
        const height = bottom - y;
        if (width <= 0 || height <= 0) {
            return null;
        }
        return { height, width, x, y };
    })()`);
    if (!captureRectangle) {
        return { status: 'unavailable' };
    }

    let screenshot;
    try {
        screenshot = await client.send('Page.captureScreenshot', {
            captureBeyondViewport: false,
            clip: {
                ...captureRectangle,
                scale: 1
            },
            format: 'png',
            fromSurface: true
        });
    } catch (error) {
        return {
            errorName: typeof error?.name === 'string' ? error.name : 'Error',
            status: 'failed'
        };
    }
    if (typeof screenshot?.data !== 'string' || screenshot.data.length === 0) {
        return { status: 'unavailable' };
    }

    const screenshotDataURL = `data:image/png;base64,${screenshot.data}`;
    return evaluateValue(client, `(async () => {
        const sampleWidth = ${PRESENTED_FRAME_SAMPLE_WIDTH};
        const sampleHeight = ${PRESENTED_FRAME_SAMPLE_HEIGHT};
        if (typeof createImageBitmap !== 'function') {
            return { status: 'unavailable' };
        }

        let bitmap = null;
        try {
            const response = await fetch(${JSON.stringify(screenshotDataURL)});
            bitmap = await createImageBitmap(await response.blob());
            const readbackCanvas = document.createElement('canvas');
            readbackCanvas.width = sampleWidth;
            readbackCanvas.height = sampleHeight;
            const context = readbackCanvas.getContext('2d', {
                alpha: true,
                willReadFrequently: true
            });
            if (!context) {
                return { status: 'unavailable' };
            }
            context.drawImage(bitmap, 0, 0, sampleWidth, sampleHeight);
            const pixels = context.getImageData(
                0,
                0,
                sampleWidth,
                sampleHeight
            ).data;
            const channelMinimums = [ 255, 255, 255 ];
            const channelMaximums = [ 0, 0, 0 ];
            let chromaticPixelCount = 0;
            let hash = 2_166_136_261;
            let nonBlackPixelCount = 0;
            let opaquePixelCount = 0;
            for (let pixelOffset = 0; pixelOffset < pixels.length; pixelOffset += 4) {
                const red = pixels[pixelOffset];
                const green = pixels[pixelOffset + 1];
                const blue = pixels[pixelOffset + 2];
                const alpha = pixels[pixelOffset + 3];
                channelMinimums[0] = Math.min(channelMinimums[0], red);
                channelMinimums[1] = Math.min(channelMinimums[1], green);
                channelMinimums[2] = Math.min(channelMinimums[2], blue);
                channelMaximums[0] = Math.max(channelMaximums[0], red);
                channelMaximums[1] = Math.max(channelMaximums[1], green);
                channelMaximums[2] = Math.max(channelMaximums[2], blue);
                const maximumChannel = Math.max(red, green, blue);
                const minimumChannel = Math.min(red, green, blue);
                if (maximumChannel > 8) {
                    nonBlackPixelCount += 1;
                }
                if (maximumChannel - minimumChannel >= 16) {
                    chromaticPixelCount += 1;
                }
                if (alpha >= 250) {
                    opaquePixelCount += 1;
                }
                hash = Math.imul((hash ^ red) >>> 0, 16_777_619) >>> 0;
                hash = Math.imul((hash ^ green) >>> 0, 16_777_619) >>> 0;
                hash = Math.imul((hash ^ blue) >>> 0, 16_777_619) >>> 0;
            }

            const horizontalSamples = [];
            const sampleRow = Math.floor(sampleHeight / 2);
            for (let sampleIndex = 0; sampleIndex < 8; sampleIndex += 1) {
                const sampleColumn = Math.min(
                    sampleWidth - 1,
                    Math.floor((sampleIndex + 0.5) * sampleWidth / 8)
                );
                const sampleOffset = ((sampleRow * sampleWidth) + sampleColumn) * 4;
                horizontalSamples.push([
                    pixels[sampleOffset],
                    pixels[sampleOffset + 1],
                    pixels[sampleOffset + 2]
                ]);
            }
            return {
                channelMaximums,
                channelMinimums,
                chromaticPixelCount,
                hash,
                horizontalSamples,
                nonBlackPixelCount,
                opaquePixelCount,
                pixelCount: pixels.length / 4,
                sampleHeight,
                sampleWidth,
                status: 'captured'
            };
        } catch (error) {
            return {
                errorName: typeof error?.name === 'string' ? error.name : 'Error',
                status: 'failed'
            };
        } finally {
            bitmap?.close?.();
        }
    })()`);
}

async function captureExpectedPresentedFrameEvidence(client, expectation) {
    if (expectation === 'none') {
        return null;
    }
    return capturePresentedFrameEvidence(client);
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

function appendBrowserErrorFailures(target, counts) {
    const failureDefinitions = [
        [ 'runtimeExceptions', 'browser:runtime-exception' ],
        [ 'consoleErrors', 'browser:console-error' ],
        [ 'logErrors', 'browser:log-error' ]
    ];
    for (const [ countName, failureCode ] of failureDefinitions) {
        if ((counts[countName] ?? 0) > 0) {
            target.push(failureCode);
        }
    }
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

function hasAuthorizedRawHDRPlaybackRoute(snapshot) {
    const authorization = snapshot?.rawHDRValidation;
    const routeKey = snapshot?.rawHDRPlaybackRouteKey;
    return authorization?.status === 'authorized'
        && (authorization.targetFormat === 'bgra8unorm'
            || authorization.targetFormat === 'rgba8unorm')
        && Number.isSafeInteger(authorization.fixtureVersion)
        && authorization.fixtureVersion > 0
        && Number.isSafeInteger(authorization.renderSettingsVersion)
        && authorization.renderSettingsVersion > 0
        && typeof routeKey === 'string'
        && Array.isArray(authorization.authorizedRouteKeys)
        && authorization.authorizedRouteKeys.includes(routeKey);
}

function isExpectedCustomPlaybackActive(snapshot, configuration, previousGeneration = null) {
    const generationAdvanced = previousGeneration === null
        || (Number.isSafeInteger(snapshot?.sessionGeneration)
            && snapshot.sessionGeneration > previousGeneration);
    return snapshot?.captured === true
        && snapshot.playerID === 'webgpuvideoplayer'
        && generationAdvanced
        && snapshot.customPlayback?.state === 'playing'
        && snapshot.customPlayback?.audioPath === configuration.expectedAudioPath
        && snapshot.customPlaybackEligibility?.videoOutputMode
            === configuration.expectedVideoOutputMode
        && (configuration.expectedVideoDecoderBackend === null
            || snapshot.customPlaybackEligibility?.videoDecoderBackend
                === configuration.expectedVideoDecoderBackend)
        && (configuration.expectedVideoOutputMode !== 'raw-planes'
            || hasAuthorizedRawHDRPlaybackRoute(snapshot))
        && (snapshot.customPlayback?.videoDecode?.receivedFrameCount ?? 0)
            >= MINIMUM_ACTIVE_PRESENTED_FRAMES
        && snapshot.presentation?.state === 'presenting'
        && (snapshot.presentation?.presentedFrameCount ?? 0)
            >= MINIMUM_ACTIVE_PRESENTED_FRAMES;
}

function isStoppedSnapshot(snapshot, expectedStoppedEventCount) {
    return snapshot?.presentation?.state === 'idle'
        && snapshot.dom?.canvasCount === 0
        && snapshot.hasCurrentSource === false
        && snapshot.isFetching === false
        && snapshot.stoppedEventCount >= expectedStoppedEventCount;
}

async function selectConfiguredAudioStream(
    client,
    accessKey,
    configuration,
    initialSnapshot
) {
    if (configuration.audioStreamIndex === null) {
        return null;
    }

    const audioSwitchResult = await evaluateValue(
        client,
        createPlayerOperationExpression(
            accessKey,
            `player.setAudioStreamIndex(${configuration.audioStreamIndex});`
        )
    );
    if (!audioSwitchResult) {
        throw new SmokeHarnessError(
            'audio-switch-failed',
            'Unable to select the configured audio stream'
        );
    }

    const previousAudioGeneration = initialSnapshot.customPlayback?.activeGeneration;
    await waitForPlayerSnapshot({
        accept: snapshot => Number.isSafeInteger(previousAudioGeneration)
            && Number.isSafeInteger(snapshot?.customPlayback?.activeGeneration)
            && snapshot.customPlayback.activeGeneration > previousAudioGeneration
            && snapshot.customPlayback.state === 'playing'
            && snapshot.customPlayback.audioPath === 'ready'
            && snapshot.customPlayback.videoDecode?.audioCodec
                === configuration.expectedAudioCodec
            && (snapshot.customPlayback.videoDecode?.receivedAudioFrameCount ?? 0) > 0
            && snapshot.presentation?.state === 'presenting',
        accessKey,
        client,
        description: 'the selected custom audio decoder stream',
        errorCode: 'audio-switch-timeout',
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
    await sleep(PLAYBACK_OBSERVATION_MILLISECONDS);
    return getPlayerSnapshot(client, accessKey);
}

function calculateResizeOverride(snapshot) {
    const initialWidth = snapshot.dom?.viewportWidth;
    const initialHeight = snapshot.dom?.viewportHeight;
    const initialDevicePixelRatio = snapshot.dom?.devicePixelRatio;
    if (!Number.isSafeInteger(initialWidth)
        || initialWidth <= 0
        || !Number.isSafeInteger(initialHeight)
        || initialHeight <= 0
        || !Number.isFinite(initialDevicePixelRatio)
        || initialDevicePixelRatio <= 0) {
        throw new SmokeHarnessError(
            'surface-geometry-unavailable',
            'The active page did not expose valid viewport geometry'
        );
    }

    return {
        devicePixelRatio: Math.abs(initialDevicePixelRatio - 1.5) < 0.01 ? 2 : 1.5,
        height: initialHeight >= 640 ? initialHeight - 91 : initialHeight + 91,
        width: initialWidth >= 960 ? initialWidth - 137 : initialWidth + 137
    };
}

async function runFullscreenExercise(options, initialSnapshot) {
    const requestObservation = await evaluateValue(
        options.client,
        `(async () => {
            const canvas = document.querySelector(
                '.videoPlayerContainer .webgpuVideoPlayerCanvas-visible'
            );
            const container = canvas?.closest('.videoPlayerContainer') ?? null;
            if (!container || typeof container.requestFullscreen !== 'function') {
                return {
                    attempted: false,
                    entered: false,
                    preexisting: false,
                    supported: false
                };
            }
            if (document.fullscreenElement) {
                return {
                    attempted: false,
                    entered: false,
                    preexisting: true,
                    supported: true
                };
            }
            try {
                await container.requestFullscreen({ navigationUI: 'hide' });
            } catch {
                return {
                    attempted: true,
                    entered: false,
                    preexisting: false,
                    supported: true
                };
            }
            return {
                attempted: true,
                entered: document.fullscreenElement === container,
                preexisting: false,
                supported: true
            };
        })()`,
        true,
        true
    );
    if (requestObservation?.entered !== true) {
        let skippedReason = 'fullscreen-request-rejected';
        if (requestObservation?.supported === false) {
            skippedReason = 'fullscreen-api-unavailable';
        } else if (requestObservation?.preexisting === true) {
            skippedReason = 'fullscreen-preexisting';
        }
        return {
            request: requestObservation,
            skippedReason
        };
    }

    let exitRequested = false;
    try {
        await waitForPlayerSnapshot({
            accept: snapshot => snapshot?.dom?.fullscreenActive === true
                && snapshot.dom.fullscreenContainsCanvas === true
                && snapshot.presentation?.state === 'presenting',
            accessKey: options.accessKey,
            client: options.client,
            description: 'the player container Fullscreen API state',
            errorCode: 'fullscreen-enter-timeout',
            timeoutMilliseconds: options.configuration.timeoutMilliseconds
        });
        await sleep(FULLSCREEN_OBSERVATION_MILLISECONDS);
        const fullscreenLater = await getPlayerSnapshot(options.client, options.accessKey);
        const exitResult = await evaluateValue(
            options.client,
            `(async () => {
                if (!document.fullscreenElement
                    || typeof document.exitFullscreen !== 'function') {
                    return false;
                }
                await document.exitFullscreen();
                return true;
            })()`
        );
        exitRequested = exitResult === true;
        if (!exitResult) {
            throw new SmokeHarnessError(
                'fullscreen-exit-failed',
                'Unable to exit the Fullscreen API state entered by the harness'
            );
        }
        await waitForPlayerSnapshot({
            accept: snapshot => snapshot?.dom?.fullscreenActive === false
                && snapshot.presentation?.state === 'presenting',
            accessKey: options.accessKey,
            client: options.client,
            description: 'the restored non-fullscreen player state',
            errorCode: 'fullscreen-exit-timeout',
            timeoutMilliseconds: options.configuration.timeoutMilliseconds
        });
        await sleep(FULLSCREEN_OBSERVATION_MILLISECONDS);
        const exitedLater = await getPlayerSnapshot(options.client, options.accessKey);
        appendFailures(
            options.failures,
            'fullscreen',
            validateFullscreenTransitionSnapshots(
                initialSnapshot,
                fullscreenLater,
                exitedLater
            )
        );
        return {
            entered: fullscreenLater,
            exited: exitedLater,
            request: requestObservation,
            skippedReason: null
        };
    } finally {
        if (!exitRequested) {
            try {
                await evaluateValue(
                    options.client,
                    `document.fullscreenElement
                        ? document.exitFullscreen().then(() => true, () => false)
                        : true`
                );
            } catch {
                // Preserve the primary exercise failure while restoring page state
            }
        }
    }
}

async function runResizeExercise(options, initialSnapshot) {
    const requestedViewport = calculateResizeOverride(initialSnapshot);
    let overrideActive = false;
    try {
        await options.client.send('Emulation.setDeviceMetricsOverride', {
            deviceScaleFactor: requestedViewport.devicePixelRatio,
            height: requestedViewport.height,
            mobile: false,
            screenHeight: requestedViewport.height,
            screenWidth: requestedViewport.width,
            width: requestedViewport.width
        });
        overrideActive = true;
        await waitForPlayerSnapshot({
            accept: snapshot => snapshot?.dom?.viewportWidth === requestedViewport.width
                && snapshot.dom.viewportHeight === requestedViewport.height
                && Math.abs(
                    snapshot.dom.devicePixelRatio - requestedViewport.devicePixelRatio
                ) < 0.01
                && snapshot.presentation?.state === 'presenting',
            accessKey: options.accessKey,
            client: options.client,
            description: 'the overridden viewport and device-pixel-ratio',
            errorCode: 'surface-resize-timeout',
            timeoutMilliseconds: options.configuration.timeoutMilliseconds
        });
        await sleep(RESIZE_OBSERVATION_MILLISECONDS);
        const resizedLater = await getPlayerSnapshot(options.client, options.accessKey);
        appendFailures(
            options.failures,
            'resize',
            validateResizedPresentationSnapshot(
                initialSnapshot,
                resizedLater,
                requestedViewport
            )
        );
        return {
            requestedViewport,
            resized: resizedLater
        };
    } finally {
        if (overrideActive) {
            await options.client.send('Emulation.clearDeviceMetricsOverride');
            await waitForPlayerSnapshot({
                accept: snapshot => snapshot?.dom?.viewportWidth
                        === initialSnapshot.dom.viewportWidth
                    && snapshot.dom.viewportHeight === initialSnapshot.dom.viewportHeight
                    && Math.abs(
                        snapshot.dom.devicePixelRatio
                            - initialSnapshot.dom.devicePixelRatio
                    ) < 0.01
                    && snapshot.presentation?.state === 'presenting',
                accessKey: options.accessKey,
                client: options.client,
                description: 'the restored browser viewport',
                errorCode: 'surface-resize-restore-timeout',
                timeoutMilliseconds: options.configuration.timeoutMilliseconds
            });
        }
    }
}

async function runPresentationSurfaceExercise(options, initialSnapshot) {
    const fullscreenObservation = await runFullscreenExercise(options, initialSnapshot);
    const resizeBaseline = await getPlayerSnapshot(options.client, options.accessKey);
    const resizeObservation = await runResizeExercise(options, resizeBaseline);
    await sleep(RESIZE_OBSERVATION_MILLISECONDS);
    const restoredSnapshot = await getPlayerSnapshot(options.client, options.accessKey);
    return {
        fullscreen: fullscreenObservation,
        latestSnapshot: restoredSnapshot,
        resize: {
            ...resizeObservation,
            restored: restoredSnapshot
        }
    };
}

async function runSeekStorm(options, initialSnapshot) {
    if (options.configuration.seekStormCount === 0) {
        return {
            latestSnapshot: initialSnapshot,
            observation: {
                count: 0,
                skippedReason: 'disabled'
            }
        };
    }

    const targetsMicroseconds = createSeekStormTargetsMicroseconds(
        initialSnapshot.customPlayback?.durationMicroseconds,
        options.configuration.seekStormCount
    );
    if (targetsMicroseconds.length !== options.configuration.seekStormCount) {
        throw new SmokeHarnessError(
            'seek-storm-media-too-short',
            'Seek storm requires a finite media duration of at least eight seconds'
        );
    }
    const targetsMilliseconds = targetsMicroseconds.map(targetMicroseconds => (
        Math.floor(targetMicroseconds / MICROSECONDS_PER_MILLISECOND)
    ));
    const seekResult = await evaluateValue(
        options.client,
        createPlayerOperationExpression(
            options.accessKey,
            `for (const targetMilliseconds of ${JSON.stringify(targetsMilliseconds)}) {
                player.currentTime(targetMilliseconds);
            }`
        )
    );
    if (!seekResult) {
        throw new SmokeHarnessError('seek-storm-failed', 'Unable to invoke the seek storm');
    }

    const initialGeneration = initialSnapshot.customPlayback?.activeGeneration;
    const finalTargetMicroseconds = targetsMicroseconds.at(-1);
    await waitForPlayerSnapshot({
        accept: snapshot => Number.isSafeInteger(initialGeneration)
            && snapshot?.customPlayback?.activeGeneration
                === initialGeneration + targetsMicroseconds.length
            && snapshot.customPlayback.videoDecode?.activeGeneration
                === snapshot.customPlayback.activeGeneration
            && snapshot.customPlayback.state === 'playing'
            && Math.abs(
                snapshot.customPlayback.currentTimeMicroseconds - finalTargetMicroseconds
            ) <= 2 * MICROSECONDS_PER_SECOND
            && snapshot.presentation?.state === 'presenting'
            && (snapshot.customPlayback.videoDecode?.receivedFrameCount ?? 0) > 0,
        accessKey: options.accessKey,
        client: options.client,
        description: 'the final rapid-seek generation',
        errorCode: 'seek-storm-timeout',
        timeoutMilliseconds: options.configuration.timeoutMilliseconds
    });
    await sleep(PLAYBACK_OBSERVATION_MILLISECONDS);
    const laterSnapshot = await getPlayerSnapshot(options.client, options.accessKey);
    appendFailures(
        options.failures,
        'seek-storm',
        validateSeekStormSnapshot(
            initialSnapshot,
            laterSnapshot,
            targetsMicroseconds
        )
    );
    return {
        latestSnapshot: laterSnapshot,
        observation: {
            finalActualMicroseconds: laterSnapshot.customPlayback.currentTimeMicroseconds,
            generationDelta: laterSnapshot.customPlayback.activeGeneration - initialGeneration,
            staleAudioSampleCount:
                laterSnapshot.customPlayback.videoDecode?.staleAudioSampleCount ?? null,
            staleControllerEventCount: laterSnapshot.customPlayback.staleEventCount,
            staleFrameCount: laterSnapshot.customPlayback.videoDecode?.staleFrameCount ?? null,
            targetsMicroseconds
        }
    };
}

async function stopCapturedPlayback(
    client,
    accessKey,
    configuration,
    expectedStoppedEventCount,
    description,
    failureCode
) {
    const stopResult = await evaluateValue(
        client,
        createPlayerOperationExpression(
            accessKey,
            'await Promise.resolve(player.stop(false));'
        )
    );
    if (!stopResult) {
        throw new SmokeHarnessError(failureCode, `Unable to stop ${description}`);
    }

    return waitForPlayerSnapshot({
        accept: snapshot => isStoppedSnapshot(snapshot, expectedStoppedEventCount),
        accessKey,
        client,
        description: `${description} cleanup`,
        errorCode: `${failureCode.replace(/-failed$/u, '')}-cleanup-timeout`,
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
}

async function finishNaturalEndExercise(options) {
    const endedSnapshot = await waitForPlayerSnapshot({
        accept: snapshot => snapshot?.customPlayback?.state === 'ended',
        accessKey: options.accessKey,
        client: options.client,
        description: 'natural custom playback completion after decoder EOF',
        errorCode: 'natural-end-timeout',
        timeoutMilliseconds: options.configuration.timeoutMilliseconds
    });
    await sleep(NATURAL_END_STABILITY_OBSERVATION_MILLISECONDS);
    const stableEndedSnapshot = await getPlayerSnapshot(
        options.client,
        options.accessKey
    );
    const failures = [];
    appendFailures(
        failures,
        'playback',
        validateActivePlaybackSnapshot(options.activeInitial, options.activeLater, {
            expectedAudioPath: options.configuration.expectedAudioPath,
            expectedVideoDecoderBackend:
                options.configuration.expectedVideoDecoderBackend,
            expectedVideoOutputMode: options.configuration.expectedVideoOutputMode
        })
    );
    appendFailures(
        failures,
        'frame-evidence',
        validatePresentedFrameEvidence(
            options.initialFrameEvidence,
            options.laterFrameEvidence,
            options.configuration.expectedFrameEvidence
        )
    );
    appendFailures(
        failures,
        'natural-end',
        validateNaturalEndSnapshots(
            options.activeLater,
            endedSnapshot,
            stableEndedSnapshot,
            options.configuration.expectedAudioPath
        )
    );
    const stopSnapshot = await stopCapturedPlayback(
        options.client,
        options.accessKey,
        options.configuration,
        1,
        'naturally ended custom playback',
        'natural-end-stop-failed'
    );
    options.cleanupState.required = false;
    appendFailures(failures, 'stop', validateStopSnapshot(stopSnapshot));
    appendBrowserErrorFailures(failures, options.browserErrorMonitor.counts);

    return {
        diagnostics: {
            browserErrors: { ...options.browserErrorMonitor.counts },
            browserMessages: [ ...options.browserErrorMonitor.messages ],
            eventCounts: stopSnapshot.eventCounts
        },
        failures,
        observations: {
            frameEvidence: {
                initial: options.initialFrameEvidence,
                later: options.laterFrameEvidence
            },
            naturalEnd: {
                ended: endedSnapshot,
                stable: stableEndedSnapshot
            },
            playback: options.activeLater,
            stop: stopSnapshot
        }
    };
}

async function runRepeatedPlaybackSessions(options) {
    const observations = [];
    let expectedStoppedEventCount = options.expectedStoppedEventCount;
    let latestSessionGeneration = options.latestSessionGeneration;
    let latestStopSnapshot = options.latestStopSnapshot;
    for (
        let sessionNumber = 2;
        sessionNumber <= options.configuration.repeatSessionCount;
        sessionNumber += 1
    ) {
        const playButton = await waitForVisibleElement(
            options.client,
            PLAY_BUTTON_SELECTORS,
            options.configuration,
            `the session ${sessionNumber} play button`
        );
        await trustedClick(options.client, playButton);
        options.cleanupState.required = true;
        const initialSnapshot = await waitForPlayerSnapshot({
            accept: snapshot => isExpectedCustomPlaybackActive(
                snapshot,
                options.configuration,
                latestSessionGeneration
            ),
            accessKey: options.accessKey,
            client: options.client,
            description: `active custom playback session ${sessionNumber}`,
            errorCode: 'repeat-session-timeout',
            timeoutMilliseconds: options.configuration.timeoutMilliseconds
        });
        await sleep(PLAYBACK_OBSERVATION_MILLISECONDS);
        const laterSnapshot = await getPlayerSnapshot(options.client, options.accessKey);
        appendFailures(
            options.failures,
            `repeat-${sessionNumber}`,
            validateActivePlaybackSnapshot(initialSnapshot, laterSnapshot, {
                expectedAudioPath: options.configuration.expectedAudioPath,
                expectedVideoDecoderBackend:
                    options.configuration.expectedVideoDecoderBackend,
                expectedVideoOutputMode: options.configuration.expectedVideoOutputMode
            })
        );
        if (laterSnapshot.customPlayback?.staleEventCount !== 0) {
            options.failures.push(`repeat-${sessionNumber}:stale-session-event`);
        }

        expectedStoppedEventCount += 1;
        const stopSnapshot = await stopCapturedPlayback(
            options.client,
            options.accessKey,
            options.configuration,
            expectedStoppedEventCount,
            `custom playback session ${sessionNumber}`,
            'repeat-stop-failed'
        );
        options.cleanupState.required = false;
        appendFailures(
            options.failures,
            `repeat-${sessionNumber}-stop`,
            validateStopSnapshot(stopSnapshot, expectedStoppedEventCount)
        );
        latestSessionGeneration = laterSnapshot.sessionGeneration;
        latestStopSnapshot = stopSnapshot;
        observations.push({
            playback: laterSnapshot,
            sessionNumber,
            stop: stopSnapshot
        });
    }

    return {
        expectedStoppedEventCount,
        latestSessionGeneration,
        latestStopSnapshot,
        observations
    };
}

async function runPresentationFailureInjection(options) {
    if (options.configuration.failureInjection !== 'presentation') {
        return null;
    }

    const playButton = await waitForVisibleElement(
        options.client,
        PLAY_BUTTON_SELECTORS,
        options.configuration,
        'the failure-injection play button'
    );
    await trustedClick(options.client, playButton);
    options.cleanupState.required = true;
    const activeSnapshot = await waitForPlayerSnapshot({
        accept: snapshot => isExpectedCustomPlaybackActive(
            snapshot,
            options.configuration,
            options.latestSessionGeneration
        ),
        accessKey: options.accessKey,
        client: options.client,
        description: 'active playback before presenter failure injection',
        errorCode: 'failure-injection-start-timeout',
        timeoutMilliseconds: options.configuration.timeoutMilliseconds
    });
    const failureInjected = await evaluateValue(
        options.client,
        createPlayerOperationExpression(options.accessKey, `
            const presenter = player.presenter;
            const generation = presenter?.activeGeneration;
            if (!Number.isSafeInteger(generation)
                || typeof presenter?.fallback !== 'function') {
                return false;
            }
            presenter.fallback(generation, 'frame-render-failed');
        `)
    );
    if (!failureInjected) {
        throw new SmokeHarnessError(
            'failure-injection-unavailable',
            'The active player did not expose the presenter test seam'
        );
    }
    const fallbackInitial = await waitForPlayerSnapshot({
        accept: snapshot => snapshot?.presentation?.fallbackReason
                === 'frame-render-failed'
            && snapshot.presentation?.state === 'idle'
            && snapshot.dom?.canvasCount === 0
            && snapshot.dom?.sourcedVideoCount > 0
            && snapshot.dom?.nativeVideoPlaying === true
            && snapshot.hasCurrentSource === true,
        accessKey: options.accessKey,
        client: options.client,
        description: 'same-session native presentation fallback',
        errorCode: 'failure-injection-recovery-timeout',
        timeoutMilliseconds: options.configuration.timeoutMilliseconds
    });
    await sleep(RESUME_OBSERVATION_MILLISECONDS);
    const fallbackLater = await getPlayerSnapshot(options.client, options.accessKey);
    appendFailures(
        options.failures,
        'failure-injection',
        validateInjectedPresentationFallbackSnapshot(fallbackInitial, fallbackLater)
    );

    const expectedStoppedEventCount = options.expectedStoppedEventCount + 1;
    const stopSnapshot = await stopCapturedPlayback(
        options.client,
        options.accessKey,
        options.configuration,
        expectedStoppedEventCount,
        'failure-injection playback',
        'failure-injection-stop-failed'
    );
    options.cleanupState.required = false;
    appendFailures(
        options.failures,
        'failure-injection-stop',
        validateStopSnapshot(stopSnapshot, expectedStoppedEventCount)
    );
    return {
        expectedStoppedEventCount,
        latestStopSnapshot: stopSnapshot,
        observation: {
            active: activeSnapshot,
            fallback: fallbackLater,
            stop: stopSnapshot
        }
    };
}

async function runDeviceLossRecoveryInjection(options) {
    const pausedDeviceLoss = options.configuration.failureInjection === 'paused-device-loss';
    if (!pausedDeviceLoss && options.configuration.failureInjection !== 'device-loss') {
        return null;
    }

    const playButton = await waitForVisibleElement(
        options.client,
        PLAY_BUTTON_SELECTORS,
        options.configuration,
        'the device-loss injection play button'
    );
    await trustedClick(options.client, playButton);
    options.cleanupState.required = true;
    const activeSnapshot = await waitForPlayerSnapshot({
        accept: snapshot => isExpectedCustomPlaybackActive(
            snapshot,
            options.configuration,
            options.latestSessionGeneration
        ),
        accessKey: options.accessKey,
        client: options.client,
        description: 'active playback before WebGPU device destruction',
        errorCode: 'device-loss-injection-start-timeout',
        timeoutMilliseconds: options.configuration.timeoutMilliseconds
    });
    let recoveryStartSnapshot = activeSnapshot;
    if (pausedDeviceLoss) {
        const pauseResult = await evaluateValue(
            options.client,
            createPlayerOperationExpression(options.accessKey, 'player.pause();')
        );
        if (!pauseResult) {
            throw new SmokeHarnessError(
                'paused-device-loss-pause-failed',
                'Unable to pause playback before WebGPU device destruction'
            );
        }
        await waitForPlayerSnapshot({
            accept: snapshot => snapshot?.customPlayback?.state === 'paused',
            accessKey: options.accessKey,
            client: options.client,
            description: 'paused custom playback before WebGPU device destruction',
            errorCode: 'paused-device-loss-pause-timeout',
            timeoutMilliseconds: options.configuration.timeoutMilliseconds
        });
        await sleep(PAUSE_OBSERVATION_MILLISECONDS);
        recoveryStartSnapshot = await getPlayerSnapshot(
            options.client,
            options.accessKey
        );
    }
    const injectionObservation = await evaluateValue(
        options.client,
        createPlayerOperationExpression(options.accessKey, `
            const presenter = player.presenter;
            const previousDevice = presenter?.device;
            const recoveryCountBefore = presenter?.getTelemetry?.().deviceRecoveryCount;
            if (!previousDevice
                || typeof previousDevice.destroy !== 'function'
                || !Number.isSafeInteger(recoveryCountBefore)) {
                return {
                    available: false,
                    destroyInvoked: false,
                    recoveryCountAfter: null,
                    replacementDevice: false
                };
            }
            previousDevice.destroy();
            const recoveryDeadline = performance.now()
                + ${DEVICE_RECOVERY_WAIT_MILLISECONDS};
            while (performance.now() < recoveryDeadline) {
                const currentDevice = presenter.device;
                const currentTelemetry = presenter.getTelemetry?.();
                if (currentDevice
                    && currentDevice !== previousDevice
                    && currentTelemetry?.deviceRecoveryCount
                        === recoveryCountBefore + 1) {
                    return {
                        available: true,
                        destroyInvoked: true,
                        recoveryCountAfter: currentTelemetry.deviceRecoveryCount,
                        replacementDevice: true
                    };
                }
                await new Promise(resolve => setTimeout(
                    resolve,
                    ${DEVICE_RECOVERY_POLL_MILLISECONDS}
                ));
            }
            return {
                available: true,
                destroyInvoked: true,
                recoveryCountAfter: presenter.getTelemetry?.().deviceRecoveryCount ?? null,
                replacementDevice: Boolean(
                    presenter.device && presenter.device !== previousDevice
                )
            };
        `)
    );
    if (injectionObservation?.available !== true
        || injectionObservation.destroyInvoked !== true) {
        throw new SmokeHarnessError(
            'device-loss-injection-unavailable',
            'The active player did not expose a destroyable presentation device'
        );
    }
    await waitForPlayerSnapshot({
        accept: snapshot => snapshot?.presentation?.state === 'presenting'
            && snapshot.presentation.fallbackReason === null
            && snapshot.presentation.deviceRecoveryCount
                === (activeSnapshot.presentation?.deviceRecoveryCount ?? 0) + 1
            && snapshot.customPlayback?.state
                === (pausedDeviceLoss ? 'paused' : 'playing')
            && snapshot.customPlayback.activeGeneration
                === (recoveryStartSnapshot.customPlayback?.activeGeneration ?? 0)
                    + (pausedDeviceLoss ? 1 : 0)
            && snapshot.sessionGeneration === activeSnapshot.sessionGeneration
            && snapshot.dom?.visibleCanvasCount > 0
            && (!pausedDeviceLoss
                || (snapshot.presentation?.presentedFrameCount ?? 0)
                    > (recoveryStartSnapshot.presentation?.presentedFrameCount ?? 0))
            && (options.configuration.expectedVideoOutputMode !== 'raw-planes'
                || hasAuthorizedRawHDRPlaybackRoute(snapshot)),
        accessKey: options.accessKey,
        client: options.client,
        description: 'presentation on the replacement WebGPU device',
        errorCode: 'device-loss-recovery-timeout',
        timeoutMilliseconds: options.configuration.timeoutMilliseconds
    });
    await sleep(RESUME_OBSERVATION_MILLISECONDS);
    const recoveredSnapshot = await getPlayerSnapshot(
        options.client,
        options.accessKey
    );
    let resumedSnapshot = null;
    if (pausedDeviceLoss) {
        const resumeResult = await evaluateValue(
            options.client,
            createPlayerOperationExpression(options.accessKey, 'player.resume();')
        );
        if (!resumeResult) {
            throw new SmokeHarnessError(
                'paused-device-loss-resume-failed',
                'Unable to resume playback after WebGPU device recovery'
            );
        }
        await waitForPlayerSnapshot({
            accept: snapshot => snapshot?.customPlayback?.state === 'playing'
                && (snapshot.customPlayback.currentTimeMicroseconds ?? 0)
                    - (recoveredSnapshot.customPlayback?.currentTimeMicroseconds ?? 0)
                    >= 250_000
                && (snapshot.presentation?.presentedFrameCount ?? 0)
                    > (recoveredSnapshot.presentation?.presentedFrameCount ?? 0),
            accessKey: options.accessKey,
            client: options.client,
            description: 'resumed custom playback after paused device recovery',
            errorCode: 'paused-device-loss-resume-timeout',
            timeoutMilliseconds: options.configuration.timeoutMilliseconds
        });
        await sleep(RESUME_OBSERVATION_MILLISECONDS);
        resumedSnapshot = await getPlayerSnapshot(options.client, options.accessKey);
        appendFailures(
            options.failures,
            'paused-device-loss-injection',
            validatePausedDeviceRecoverySnapshots(
                activeSnapshot,
                recoveryStartSnapshot,
                recoveredSnapshot,
                resumedSnapshot,
                injectionObservation
            )
        );
    } else {
        appendFailures(
            options.failures,
            'device-loss-injection',
            validateInjectedDeviceRecoverySnapshot(
                activeSnapshot,
                recoveredSnapshot,
                injectionObservation
            )
        );
    }

    const expectedStoppedEventCount = options.expectedStoppedEventCount + 1;
    const stopSnapshot = await stopCapturedPlayback(
        options.client,
        options.accessKey,
        options.configuration,
        expectedStoppedEventCount,
        'device-loss recovery playback',
        'device-loss-stop-failed'
    );
    options.cleanupState.required = false;
    appendFailures(
        options.failures,
        'device-loss-stop',
        validateStopSnapshot(stopSnapshot, expectedStoppedEventCount)
    );
    return {
        expectedStoppedEventCount,
        latestStopSnapshot: stopSnapshot,
        observation: {
            active: activeSnapshot,
            injection: injectionObservation,
            paused: pausedDeviceLoss ? recoveryStartSnapshot : null,
            recovered: recoveredSnapshot,
            resumed: resumedSnapshot,
            stop: stopSnapshot
        }
    };
}

async function runConfiguredFailureInjection(options) {
    switch (options.configuration.failureInjection) {
        case 'device-loss':
        case 'paused-device-loss':
            return runDeviceLossRecoveryInjection(options);
        case 'presentation':
            return runPresentationFailureInjection(options);
        case 'none':
        default:
            return null;
    }
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
        PLAY_BUTTON_SELECTORS,
        configuration,
        'the item play button'
    );

    const accessKey = `webgpu-smoke-access-${crypto.randomUUID()}`;
    const restoreKey = `webgpu-smoke-restore-${crypto.randomUUID()}`;
    const cleanupState = { required: false };
    let hookInstalled = false;
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
        cleanupState.required = true;
        const activeInitial = await waitForPlayerSnapshot({
            accept: snapshot => isExpectedCustomPlaybackActive(snapshot, configuration),
            accessKey,
            client,
            description: 'active custom-decoded WebGPU playback',
            errorCode: 'custom-playback-timeout',
            timeoutMilliseconds: configuration.timeoutMilliseconds
        });
        const initialFrameEvidence = await captureExpectedPresentedFrameEvidence(
            client,
            configuration.expectedFrameEvidence
        );
        await sleep(PLAYBACK_OBSERVATION_MILLISECONDS);
        const activeLater = await getPlayerSnapshot(client, accessKey);
        const laterFrameEvidence = await captureExpectedPresentedFrameEvidence(
            client,
            configuration.expectedFrameEvidence
        );
        if (configuration.completionMode === 'natural-end') {
            const naturalEndResult = await finishNaturalEndExercise({
                accessKey,
                activeInitial,
                activeLater,
                browserErrorMonitor,
                cleanupState,
                client,
                configuration,
                initialFrameEvidence,
                laterFrameEvidence
            });
            return naturalEndResult;
        }
        const audioSwitchSnapshot = await selectConfiguredAudioStream(
            client,
            accessKey,
            configuration,
            activeLater
        );
        const failures = [];
        const surfaceObservation = await runPresentationSurfaceExercise({
            accessKey,
            client,
            configuration,
            failures
        }, audioSwitchSnapshot ?? activeLater);
        const beforePauseSnapshot = surfaceObservation.latestSnapshot;

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

        const seekTargetMicroseconds = createPrimarySeekTargetMicroseconds(
            resumeLater.customPlayback.currentTimeMicroseconds,
            resumeLater.customPlayback.durationMicroseconds
        );
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

        const seekStormResult = await runSeekStorm({
            accessKey,
            client,
            configuration,
            failures
        }, seekSnapshot);
        const beforeStopSnapshot = seekStormResult.latestSnapshot;

        const stopSnapshot = await stopCapturedPlayback(
            client,
            accessKey,
            configuration,
            1,
            'custom playback',
            'stop-failed'
        );
        cleanupState.required = false;

        appendFailures(
            failures,
            'playback',
            validateActivePlaybackSnapshot(activeInitial, activeLater, {
                expectedAudioPath: configuration.expectedAudioPath,
                expectedVideoDecoderBackend: configuration.expectedVideoDecoderBackend,
                expectedVideoOutputMode: configuration.expectedVideoOutputMode
            })
        );
        appendFailures(
            failures,
            'frame-evidence',
            validatePresentedFrameEvidence(
                initialFrameEvidence,
                laterFrameEvidence,
                configuration.expectedFrameEvidence
            )
        );
        if (audioSwitchSnapshot !== null) {
            appendFailures(
                failures,
                'audio-switch',
                validateAudioStreamSwitchSnapshot(
                    activeLater,
                    audioSwitchSnapshot,
                    configuration.expectedAudioCodec
                )
            );
        }
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
        appendFailures(
            failures,
            'events',
            validateControlEventTransitions(
                beforePauseSnapshot,
                pauseLater,
                resumeLater,
                beforeStopSnapshot,
                stopSnapshot
            )
        );
        appendFailures(failures, 'stop', validateStopSnapshot(stopSnapshot));
        const repeatedSessionResult = await runRepeatedPlaybackSessions({
            accessKey,
            cleanupState,
            client,
            configuration,
            expectedStoppedEventCount: 1,
            failures,
            latestSessionGeneration: activeLater.sessionGeneration,
            latestStopSnapshot: stopSnapshot
        });
        const failureInjectionResult = await runConfiguredFailureInjection({
            accessKey,
            cleanupState,
            client,
            configuration,
            expectedStoppedEventCount: repeatedSessionResult.expectedStoppedEventCount,
            failures,
            latestSessionGeneration: repeatedSessionResult.latestSessionGeneration
        });
        const failureInjectionObservation = failureInjectionResult?.observation ?? null;
        const latestStopSnapshot = failureInjectionResult?.latestStopSnapshot
            ?? repeatedSessionResult.latestStopSnapshot;
        const repeatedSessionObservations = repeatedSessionResult.observations;
        appendBrowserErrorFailures(failures, browserErrorMonitor.counts);

        return {
            diagnostics: {
                browserErrors: { ...browserErrorMonitor.counts },
                browserMessages: [ ...browserErrorMonitor.messages ],
                eventCounts: latestStopSnapshot.eventCounts
            },
            failures,
            observations: {
                audioSwitch: audioSwitchSnapshot,
                pause: {
                    clockDeltaMicroseconds:
                        pauseLater.customPlayback.currentTimeMicroseconds
                        - pauseInitial.customPlayback.currentTimeMicroseconds,
                    presentedFrameDelta:
                        pauseLater.presentation.presentedFrameCount
                        - pauseInitial.presentation.presentedFrameCount
                },
                playback: activeLater,
                failureInjection: failureInjectionObservation,
                frameEvidence: {
                    initial: initialFrameEvidence,
                    later: laterFrameEvidence
                },
                repeatedSessions: repeatedSessionObservations,
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
                seekStorm: seekStormResult.observation,
                stop: latestStopSnapshot,
                surface: surfaceObservation
            }
        };
    } finally {
        if (hookInstalled && cleanupState.required) {
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
            expectations: {
                audioStreamIndex: configuration.audioStreamIndex,
                completionMode: configuration.completionMode,
                expectedAudioCodec: configuration.expectedAudioCodec,
                audioPath: configuration.expectedAudioPath,
                failureInjection: configuration.failureInjection,
                repeatSessionCount: configuration.repeatSessionCount,
                seekStormCount: configuration.seekStormCount,
                videoDecoderBackend: configuration.expectedVideoDecoderBackend,
                videoOutputMode: configuration.expectedVideoOutputMode
            },
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
