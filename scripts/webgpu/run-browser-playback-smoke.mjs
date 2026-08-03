/* eslint-disable compat/compat -- This local harness targets Node 24 and a current Chromium browser */

import { pathToFileURL } from 'node:url';

import {
    areEquivalentServerURLs,
    createFrontendAssetURL,
    createPrimarySeekTargetMicroseconds,
    createSeekStormTargetsMicroseconds,
    createFrontendRouteURL,
    createStartupSampleModeOrder,
    deriveRawHDRPlaybackRouteKey,
    getExpectedServerLogSessionCount,
    getStartupComparisonModes,
    getStartupModeFeatureFlags,
    hasAuthorizedHDRPlaybackRoute,
    hasConsumedCustomAudio,
    hasExpectedPresentationRoute,
    hasReadyNativeMediaAudio,
    isFrontendInitializationReady,
    isVideoSampleOwnershipWarning,
    parseSmokeConfiguration,
    resolveServerConnectionLandingAction,
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
    validatePlaybackDecisionEvidence,
    validatePresentedFrameEvidence,
    validateResizedPresentationSnapshot,
    validateResumeSnapshot,
    validateSeekStormSnapshot,
    validateSeekSnapshot,
    validateStaticHDRMetadataSnapshot,
    validateStopSnapshot
} from './browser-smoke-helpers.mjs';
import { collectCDPRetentionSnapshot } from './cdp-retention-snapshot.mjs';
import {
    getExpectedRetentionAudioObjectCounts,
    validateDOMAndObjectCountSeries,
    validateHTMLVersusCustomStartupSamples,
    validateHTMLVersusPresentationStartupSamples,
    validateReleaseMemorySoakSeries
} from './release-validation-metrics.mjs';
import {
    beginServerLogCapture,
    finishServerLogCapture,
    ServerLogEvidenceError,
    validateServerLogEvidence
} from './server-log-evidence.mjs';

const COMMAND_TIMEOUT_MILLISECONDS = 15_000;
const INPUT_CONTROL_MODIFIER = 2;
const PAGE_POLL_INTERVAL_MILLISECONDS = 100;
const PAUSE_OBSERVATION_MILLISECONDS = 900;
const PLAYBACK_OBSERVATION_MILLISECONDS = 750;
const RESUME_OBSERVATION_MILLISECONDS = 750;
const MINIMUM_RESUME_CLOCK_ADVANCE_MICROSECONDS = 250_000;
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
const RETENTION_SETTLE_MILLISECONDS = 250;
const RETENTION_FINALIZER_DRAIN_MILLISECONDS = 100;
const MAXIMUM_CLEAN_STOP_DURATION_MICROSECONDS = 900_000;
const STARTUP_MILESTONE_POLL_MILLISECONDS = 10;
const BROWSER_VISIBILITY_RESTORE_MILLISECONDS = 250;
const STARTUP_RESULT_MODES = Object.freeze([ 'html', 'presentation', 'custom' ]);
const RETENTION_PERFORMANCE_RESOURCE_METRICS = Object.freeze([
    Object.freeze({ code: 'array-buffer-contents', name: 'ArrayBufferContents' }),
    Object.freeze({ code: 'audio-handlers', name: 'AudioHandlers' }),
    Object.freeze({ code: 'audio-worklet-processors', name: 'AudioWorkletProcessors' }),
    Object.freeze({ code: 'worker-global-scopes', name: 'WorkerGlobalScopes' })
]);
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

function copyDefinedProperties(source, propertyNames) {
    const result = {};
    for (const propertyName of propertyNames) {
        const value = source?.[propertyName];
        if (value !== undefined && value !== null) {
            result[propertyName] = value;
        }
    }
    return result;
}

async function readBrowserTargets(configuration) {
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

    return targets;
}

async function getBrowserPageTarget(configuration) {
    const targets = await readBrowserTargets(configuration);
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

async function getRetentionWorkerTargetScope(client, pageTarget, configuration) {
    if (configuration.soakSessionCount === 0) {
        return null;
    }
    const pageTargetID = pageTarget.id ?? pageTarget.targetId;
    if (typeof pageTargetID !== 'string' || pageTargetID.length === 0) {
        throw new SmokeHarnessError(
            'debug-page-id-missing',
            'The controlled Chromium page target has no target identifier'
        );
    }
    const targetInformationResponse = await client.send('Target.getTargetInfo', {
        targetId: pageTargetID
    });
    const targetInformation = targetInformationResponse?.targetInfo;
    if (targetInformation?.targetId !== pageTargetID) {
        throw new SmokeHarnessError(
            'debug-page-info-missing',
            'Chromium did not return target information for the controlled page'
        );
    }
    const browserContextID = targetInformation.browserContextId;
    return {
        ...(typeof browserContextID === 'string' && browserContextID.length > 0 ?
            { browserContextID } :
            {}),
        pageTargetID
    };
}

async function getBrowserWebSocketDebuggerURL(configuration) {
    let response;
    try {
        const versionURL = new URL('/json/version', `${configuration.debugURL}/`);
        response = await fetch(versionURL, {
            signal: AbortSignal.timeout(configuration.timeoutMilliseconds)
        });
    } catch {
        throw new SmokeHarnessError(
            'debug-browser-target-failed',
            'Unable to read the browser remote-debugging endpoint'
        );
    }
    if (!response.ok) {
        throw new SmokeHarnessError(
            'debug-browser-target-failed',
            'Browser remote-debugging endpoint returned an error'
        );
    }
    const browserVersion = await response.json();
    if (typeof browserVersion?.webSocketDebuggerUrl !== 'string') {
        throw new SmokeHarnessError(
            'debug-browser-target-missing',
            'No browser-level Chromium debugging target is available'
        );
    }
    return browserVersion.webSocketDebuggerUrl;
}

async function collectCDPGPUEvidence(configuration) {
    const browserWebSocketDebuggerURL = await getBrowserWebSocketDebuggerURL(configuration);
    const browserClient = await RawCDPClient.connect(
        browserWebSocketDebuggerURL,
        configuration.timeoutMilliseconds
    );
    try {
        const systemInformation = await browserClient.send('SystemInfo.getInfo');
        const GPUInformation = systemInformation?.gpu;
        if (!GPUInformation || !Array.isArray(GPUInformation.devices)) {
            throw new SmokeHarnessError(
                'gpu-environment-unavailable',
                'Chromium did not expose bounded GPU system information'
            );
        }
        return {
            devices: GPUInformation.devices.map(device => copyDefinedProperties(device, [
                'deviceId',
                'deviceString',
                'driverVendor',
                'driverVersion',
                'revision',
                'subSysId',
                'vendorId',
                'vendorString'
            ])),
            driverBugWorkarounds: Array.isArray(GPUInformation.driverBugWorkarounds) ?
                [ ...GPUInformation.driverBugWorkarounds ].sort() :
                [],
            featureStatus: GPUInformation.featureStatus
                && typeof GPUInformation.featureStatus === 'object' ?
                { ...GPUInformation.featureStatus } :
                {}
        };
    } finally {
        browserClient.close();
    }
}

async function collectPageRuntimeEnvironment(client) {
    const expression = String.raw`(async () => {
        let adapterRecord = null;
        if (navigator.gpu) {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) {
                const adapterInfo = adapter.info ?? {};
                adapterRecord = {
                    architecture: adapterInfo.architecture || 'not-exposed',
                    description: adapterInfo.description || 'not-exposed',
                    device: adapterInfo.device || 'not-exposed',
                    features: Array.from(adapter.features).sort(),
                    isFallbackAdapter: adapterInfo.isFallbackAdapter === true,
                    limits: {
                        maxBufferSize: Number(adapter.limits.maxBufferSize),
                        maxComputeInvocationsPerWorkgroup:
                            Number(adapter.limits.maxComputeInvocationsPerWorkgroup),
                        maxStorageBufferBindingSize:
                            Number(adapter.limits.maxStorageBufferBindingSize),
                        maxTextureDimension2D: Number(adapter.limits.maxTextureDimension2D)
                    },
                    vendor: adapterInfo.vendor || 'not-exposed'
                };
            }
        }
        let authenticatedSystemInformation = null;
        try {
            if (typeof ApiClient === 'object'
                && typeof ApiClient.getSystemInfo === 'function') {
                authenticatedSystemInformation = await ApiClient.getSystemInfo();
            }
        } catch {
            if (typeof ApiClient === 'object'
                && typeof ApiClient.getPublicSystemInfo === 'function') {
                authenticatedSystemInformation = await ApiClient.getPublicSystemInfo();
            }
        }
        const selectedServerInformation = typeof ApiClient === 'object'
            && typeof ApiClient.serverInfo === 'function' ?
            ApiClient.serverInfo() :
            null;
        const readServerField = name => authenticatedSystemInformation?.[name]
            ?? selectedServerInformation?.[name]
            ?? 'unknown';
        return {
            browser: {
                language: navigator.language || 'unknown',
                platform: navigator.userAgentData?.platform || navigator.platform || 'unknown',
                userAgent: navigator.userAgent || 'unknown'
            },
            gpu: {
                adapter: adapterRecord,
                canvasFormat: navigator.gpu?.getPreferredCanvasFormat?.() ?? 'unavailable',
                display: {
                    colorDepth: screen.colorDepth,
                    devicePixelRatio,
                    HDRDynamicRange: matchMedia('(dynamic-range: high)').matches,
                    height: screen.height,
                    pixelDepth: screen.pixelDepth,
                    width: screen.width
                },
                secureContext: isSecureContext,
                webGPUAvailable: Boolean(navigator.gpu)
            },
            server: {
                architecture: readServerField('Architecture'),
                operatingSystem: readServerField('OperatingSystem'),
                productName: readServerField('ProductName'),
                version: readServerField('Version')
            }
        };
    })()`;
    const evidence = await evaluateValue(client, expression);
    if (!evidence
        || typeof evidence !== 'object'
        || typeof evidence.browser !== 'object'
        || typeof evidence.gpu !== 'object'
        || typeof evidence.server !== 'object') {
        throw new SmokeHarnessError(
            'runtime-environment-unavailable',
            'The browser did not return bounded runtime environment evidence'
        );
    }
    return evidence;
}

async function collectRuntimeEnvironmentEvidence(
    client,
    browserVersion,
    configuration
) {
    const [ pageEvidence, CDPGPUEvidence ] = await Promise.all([
        collectPageRuntimeEnvironment(client),
        collectCDPGPUEvidence(configuration)
    ]);
    const customFeatureFlags = getStartupModeFeatureFlags('custom');
    return {
        browser: {
            ...pageEvidence.browser,
            product: browserVersion.product || 'unknown',
            protocolVersion: browserVersion.protocolVersion || 'unknown'
        },
        featureFlags: {
            ...customFeatureFlags,
            comparisonModes: configuration.startupSampleCount > 0 ?
                [ 'html', 'presentation', 'custom' ] :
                [ 'custom' ],
            source: 'request-interceptor'
        },
        gpu: {
            ...pageEvidence.gpu,
            CDP: CDPGPUEvidence
        },
        server: pageEvidence.server
    };
}

async function collectPrivateServerLogMatch(client, configuration) {
    if (configuration.serverLogDirectory === null) {
        return null;
    }
    const match = await evaluateValue(client, `(async () => {
        if (typeof ApiClient !== 'object'
            || typeof ApiClient.getCurrentUser !== 'function'
            || typeof ApiClient.getCurrentUserId !== 'function'
            || typeof ApiClient.getItem !== 'function') {
            return null;
        }
        const [ item, user ] = await Promise.all([
            ApiClient.getItem(
                ApiClient.getCurrentUserId(),
                ${JSON.stringify(configuration.itemID)}
            ),
            ApiClient.getCurrentUser()
        ]);
        return {
            itemName: typeof item?.Name === 'string' ? item.Name : null,
            userName: typeof user?.Name === 'string' ? user.Name : null
        };
    })()`);
    if (typeof match?.itemName !== 'string'
        || match.itemName.length === 0
        || typeof match.userName !== 'string'
        || match.userName.length === 0) {
        throw new SmokeHarnessError(
            'server-log-match-unavailable',
            'Unable to resolve the private Jellyfin server-log match values'
        );
    }
    return match;
}

async function beginConfiguredServerLogCapture(client, configuration) {
    const match = await collectPrivateServerLogMatch(client, configuration);
    if (match === null) {
        return null;
    }
    try {
        return {
            capture: await beginServerLogCapture(configuration.serverLogDirectory),
            match
        };
    } catch (error) {
        if (error instanceof ServerLogEvidenceError) {
            throw new SmokeHarnessError(error.code, error.message);
        }
        throw error;
    }
}

async function finishConfiguredServerLogCapture(configuredCapture, configuration) {
    if (configuredCapture === null) {
        return null;
    }
    const expectedSessionCount = getExpectedServerLogSessionCount(configuration);
    let evidence;
    try {
        evidence = await finishServerLogCapture(
            configuredCapture.capture,
            configuredCapture.match,
            expectedSessionCount
        );
    } catch (error) {
        if (error instanceof ServerLogEvidenceError) {
            throw new SmokeHarnessError(error.code, error.message);
        }
        throw error;
    }
    return {
        evidence,
        failures: validateServerLogEvidence(evidence, {
            expectedPlayMethod: configuration.expectedPlayMethod,
            expectedSessionCount
        })
    };
}

async function waitForBrowserTargetByID(configuration, targetID) {
    return waitForValue({
        accept: target => typeof target?.webSocketDebuggerUrl === 'string',
        description: `browser target ${targetID}`,
        errorCode: 'debug-created-target-timeout',
        read: async () => {
            const targets = await readBrowserTargets(configuration);
            return targets.find(target => target?.id === targetID) ?? null;
        },
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
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
        await sleep(options.pollIntervalMilliseconds ?? PAGE_POLL_INTERVAL_MILLISECONDS);
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
        const createDiagnostics = () => {
            const visiblePage = Array.from(document.querySelectorAll(
                '.mainAnimatedPage, [data-role="page"]'
            )).find(isVisible);
            const visibleButtons = Array.from(document.querySelectorAll(
                'button, a[href], [role="button"]'
            )).filter(isVisible).slice(0, 20);
            return {
                locationHash: location.hash,
                matchedElementCount: selectors.reduce(
                    (count, selector) => count + document.querySelectorAll(selector).length,
                    0
                ),
                visibleButtonSummaries: visibleButtons.map(element => ({
                    className: String(element.className).slice(0, 160),
                    text: String(element.textContent).trim().slice(0, 80)
                })),
                visiblePageClassName: visiblePage ?
                    String(visiblePage.className).slice(0, 200) : null,
                visiblePageIdentifier: visiblePage?.id || null
            };
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
                        ...createDiagnostics(),
                        found: true,
                        x: horizontalCoordinate,
                        y: verticalCoordinate
                    };
                }
            }
        }
        return { ...createDiagnostics(), found: false, x: 0, y: 0 };
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

async function trustedStartupClick(client, descriptor, accessKey) {
    const result = await evaluateValue(client, `(() => {
        const hitTarget = document.elementFromPoint(
            ${JSON.stringify(descriptor.x)},
            ${JSON.stringify(descriptor.y)}
        );
        const interactiveTarget = hitTarget?.closest?.(
            'button, input, select, textarea, a[href], [role="button"]'
        ) ?? hitTarget;
        if (!interactiveTarget) {
            return { activated: false, invokedAtMilliseconds: null };
        }
        const invokedAtMilliseconds = performance.now();
        window[${JSON.stringify(accessKey)}]?.({
            playInvokedAtMilliseconds: invokedAtMilliseconds
        });
        interactiveTarget.focus?.({ preventScroll: true });
        interactiveTarget.click?.();
        return { activated: true, invokedAtMilliseconds };
    })()`, true, true);
    if (result?.activated !== true || !Number.isFinite(result.invokedAtMilliseconds)) {
        throw new SmokeHarnessError(
            'startup-ui-activation-failed',
            'Unable to activate the startup comparison play button'
        );
    }
    return result.invokedAtMilliseconds;
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
    const landingState = await waitForValue({
        accept: state => resolveServerConnectionLandingAction(state) !== null,
        description: 'the configured server connection page',
        errorCode: 'server-connection-page-timeout',
        read: () => evaluateValue(client, `(() => {
            const isVisible = element => {
                if (!element) {
                    return false;
                }
                const rectangle = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return rectangle.width > 0
                    && rectangle.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            };
            return {
                addServerButtonAvailable: isVisible(document.querySelector('.btnAddServer')),
                loginPageAvailable: isVisible(document.querySelector('#loginPage')),
                locationHash: location.hash,
                serverHostInputAvailable: isVisible(document.querySelector('#txtServerHost'))
            };
        })()`),
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
    const landingAction = resolveServerConnectionLandingAction(landingState);
    if (landingAction === 'use-selected-server') {
        return;
    }
    if (landingAction === 'open-add-server') {
        await trustedClickSelector(
            client,
            [ '.btnAddServer' ],
            configuration,
            'the add server button'
        );
    }
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

    const loginEntry = await waitForValue({
        accept: entry => entry?.manualName?.found === true
            || entry?.manualButton?.found === true,
        description: 'the manual login form or user-selection button',
        errorCode: 'login-entry-timeout',
        read: async () => ({
            manualButton: await getVisibleElement(client, [ '#loginPage .btnManual' ]),
            manualName: await getVisibleElement(client, [ '#txtManualName' ])
        }),
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
    if (loginEntry.manualName.found !== true) {
        await trustedClick(client, loginEntry.manualButton);
        await waitForVisibleElement(
            client,
            [ '#txtManualName' ],
            configuration,
            'the username input after selecting manual login'
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

    return areEquivalentServerURLs(activeServer.address, configuration.serverURL);
}

function createPlayerCaptureHookExpression(
    accessKey,
    restoreKey,
    captureStartupMilestones = false,
    expectedPlayerID = 'webgpuvideoplayer'
) {
    return `(() => {
        const events = window.Events;
        if (!events || typeof events.trigger !== 'function') {
            return false;
        }
        const originalTrigger = events.trigger;
        const captureStateKey = ${JSON.stringify(accessKey)};
        const restoreStateKey = ${JSON.stringify(restoreKey)};
        const captureStartupMilestones = ${JSON.stringify(captureStartupMilestones)};
        const supportedPlayerIDs = new Set([ ${JSON.stringify(expectedPlayerID)} ]);
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
        const milestones = {
            canvasAttachedAtMilliseconds: null,
            nativeMediaPlayingAtMilliseconds: null,
            nativeVideoFrameAtMilliseconds: null,
            playInvokedAtMilliseconds: null,
            playbackStartAtMilliseconds: null,
            playerPlayingAtMilliseconds: null
        };
        const cleanupCallbacks = [];
        const observedVideos = new Set();
        const originalAppendChild = Node.prototype.appendChild;
        const appendChildWrapper = function(child) {
            if (captureStartupMilestones
                && milestones.canvasAttachedAtMilliseconds === null
                && child instanceof Element
                && child.matches('.webgpuVideoPlayerCanvas')) {
                milestones.canvasAttachedAtMilliseconds = performance.now();
            }
            return Reflect.apply(originalAppendChild, this, [ child ]);
        };
        if (captureStartupMilestones) {
            Node.prototype.appendChild = appendChildWrapper;
            cleanupCallbacks.push(() => {
                if (Node.prototype.appendChild === appendChildWrapper) {
                    Node.prototype.appendChild = originalAppendChild;
                }
            });
        }
        const recordVideo = video => {
            if (!captureStartupMilestones || observedVideos.has(video)) {
                return;
            }
            observedVideos.add(video);
            const handlePlaying = () => {
                milestones.nativeMediaPlayingAtMilliseconds ??= performance.now();
            };
            video.addEventListener('playing', handlePlaying);
            cleanupCallbacks.push(() => video.removeEventListener('playing', handlePlaying));
            if (typeof video.requestVideoFrameCallback === 'function') {
                const callbackIdentifier = video.requestVideoFrameCallback(callbackTime => {
                    milestones.nativeVideoFrameAtMilliseconds ??= callbackTime;
                });
                cleanupCallbacks.push(() => {
                    if (typeof video.cancelVideoFrameCallback === 'function') {
                        video.cancelVideoFrameCallback(callbackIdentifier);
                    }
                });
            }
        };
        const inspectPresentationElements = () => {
            for (const video of document.querySelectorAll('.videoPlayerContainer video')) {
                recordVideo(video);
            }
            if (milestones.canvasAttachedAtMilliseconds === null
                && document.querySelector(
                    '.videoPlayerContainer .webgpuVideoPlayerCanvas'
                )) {
                milestones.canvasAttachedAtMilliseconds = performance.now();
            }
        };
        let presentationObserver = null;
        if (captureStartupMilestones) {
            inspectPresentationElements();
            presentationObserver = new MutationObserver(inspectPresentationElements);
            presentationObserver.observe(document.documentElement, {
                childList: true,
                subtree: true
            });
        }
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
            const argumentPlayer = type === 'playbackstart'
                && Array.isArray(args)
                && supportedPlayerIDs.has(args[0]?.id)
                ? args[0]
                : null;
            if (supportedPlayerIDs.has(target?.id)) {
                capturedPlayer = target;
            } else if (argumentPlayer) {
                capturedPlayer = argumentPlayer;
            }
            const belongsToCapturedPlayer = capturedPlayer
                && (target === capturedPlayer || argumentPlayer === capturedPlayer);
            if (belongsToCapturedPlayer
                && Object.hasOwn(eventCounts, type)) {
                eventCounts[type] += 1;
                if (sequencedEventTypes.has(type)
                    && controlEventSequence.length
                        < ${MAXIMUM_CAPTURED_CONTROL_EVENTS}) {
                    controlEventSequence.push(type);
                }
                if (captureStartupMilestones) {
                    if (type === 'playbackstart') {
                        milestones.playbackStartAtMilliseconds ??= performance.now();
                    } else if (type === 'playing') {
                        milestones.playerPlayingAtMilliseconds ??= performance.now();
                    }
                }
            }
            return Reflect.apply(originalTrigger, this, [ target, type, args ]);
        };
        window[captureStateKey] = command => {
            if (captureStartupMilestones
                && Number.isFinite(command?.playInvokedAtMilliseconds)
                && milestones.playInvokedAtMilliseconds === null) {
                milestones.playInvokedAtMilliseconds = command.playInvokedAtMilliseconds;
            }
            return {
                eventCounts: { ...eventCounts },
                eventSequence: [ ...controlEventSequence ],
                hookActive: events.trigger === wrapper,
                milestones: { ...milestones },
                player: capturedPlayer
            };
        };
        window[restoreStateKey] = () => {
            capturedPlayer = null;
            presentationObserver?.disconnect();
            while (cleanupCallbacks.length > 0) {
                cleanupCallbacks.pop()();
            }
            if (events.trigger === wrapper) {
                events.trigger = originalTrigger;
            }
            return true;
        };
        events.trigger = wrapper;
        return true;
    })()`;
}

function createPlayerSnapshotExpression(accessKey) {
    return `(() => {
        const readCapture = window[${JSON.stringify(accessKey)}];
        if (typeof readCapture !== 'function') {
            return { captured: false };
        }
        const capture = readCapture();
        const player = capture?.player;
        if (!player) {
            return {
                captured: false,
                eventCounts: { ...(capture?.eventCounts ?? {}) },
                eventSequence: [ ...(capture?.eventSequence ?? []) ],
                hookActive: capture?.hookActive === true,
                milestones: { ...(capture?.milestones ?? {}) },
                performanceNowMilliseconds: performance.now(),
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
        const customPlaybackSetup =
            typeof player.getCustomPlaybackSetupTelemetry === 'function'
                ? player.getCustomPlaybackSetupTelemetry()
                : null;
        const customDecodeCapabilities = typeof player.getCustomDecodeCapabilities === 'function'
            ? player.getCustomDecodeCapabilities()
            : null;
        const customDeviceProfile = typeof player.getCustomDeviceProfileTelemetry === 'function'
            ? player.getCustomDeviceProfileTelemetry()
            : null;
        const nativeMediaAudioCapabilities =
            typeof player.getNativeMediaAudioCapabilities === 'function'
                ? player.getNativeMediaAudioCapabilities()
                : null;
        const presentation = typeof player.getPresentationTelemetry === 'function'
            ? player.getPresentationTelemetry()
            : null;
        const renderSettings = typeof player.getRenderSettings === 'function'
            ? player.getRenderSettings()
            : null;
        const presentationInputMode = player.presenter?.activeInputMode ?? null;
        const dolbyVisionProfile = player.presenter?.activeDolbyVisionProfile ?? null;
        const profile7DolbyVisionAuthorization =
            typeof player.getProfile7DolbyVisionAuthorizationTelemetry === 'function' ?
                player.getProfile7DolbyVisionAuthorizationTelemetry() :
                null;
        const profile7FELDolbyVisionAuthorization =
            typeof player.getProfile7FELDolbyVisionAuthorizationTelemetry === 'function' ?
                player.getProfile7FELDolbyVisionAuthorizationTelemetry() :
                null;
        const externalDolbyVisionAuthorization =
            typeof player.getExternalDolbyVisionAuthorizationTelemetry === 'function' ?
                player.getExternalDolbyVisionAuthorizationTelemetry() :
                null;
        const externalHDRAuthorization =
            typeof player.getExternalHDRAuthorizationTelemetry === 'function' ?
                player.getExternalHDRAuthorizationTelemetry() :
                null;
        const rawHDRAuthorization = presentationInputMode === 'raw-yuv'
            && customEligibility?.eligible === true
            && customEligibility.hdr === true
            && customEligibility.videoOutputMode === 'raw-planes'
            && typeof player.getRawHDRAuthorizationTelemetry === 'function' ?
            player.getRawHDRAuthorizationTelemetry() :
            null;
        let dolbyVisionAuthorization = null;
        if (presentationInputMode === 'raw-dolby-vision'
            && customEligibility?.eligible === true
            && customEligibility.hdr === true) {
            if (dolbyVisionProfile === 7
                && typeof player.getProfile7DolbyVisionAuthorizationTelemetry
                    === 'function') {
                dolbyVisionAuthorization =
                    player.getProfile7DolbyVisionAuthorizationTelemetry();
            } else if (dolbyVisionProfile !== 7
                && typeof player.getDolbyVisionAuthorizationTelemetry === 'function') {
                dolbyVisionAuthorization = player.getDolbyVisionAuthorizationTelemetry();
            }
        }
        const activeRawFrameFormat = player.presenter?.activeRawFrameFormat;
        const activeRawColorMetadata = player.presenter?.activeInputColorMetadata;
        const deriveRouteKey = ${deriveRawHDRPlaybackRouteKey.toString()};
        const rawHDRPlaybackRouteKey = deriveRouteKey(
            activeRawFrameFormat,
            activeRawColorMetadata
        );
        const videos = Array.from(document.querySelectorAll('.videoPlayerContainer video'));
        const ownedNativeAudioElements = Array.from(document.querySelectorAll(
            'audio.webgpuOwnedNativeAudio'
        ));
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
        const playbackStreamInfo = player.streamInfo ?? null;
        const playbackMediaSource = playbackStreamInfo?.mediaSource ?? null;
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
                    signal: custom.audioOutput.signal ? {
                        analyzedFrameCount: custom.audioOutput.signal.analyzedFrameCount,
                        analyzedSampleCount: custom.audioOutput.signal.analyzedSampleCount,
                        clippedSampleCount: custom.audioOutput.signal.clippedSampleCount,
                        nonFiniteSampleCount: custom.audioOutput.signal.nonFiniteSampleCount,
                        samplePeak: custom.audioOutput.signal.samplePeak,
                        sampleSquareSum: custom.audioOutput.signal.sampleSquareSum
                    } : null,
                    staleChunks: custom.audioOutput.staleChunks,
                    underflowEvents: custom.audioOutput.underflowEvents,
                    underflowFrames: custom.audioOutput.underflowFrames
                } : null,
                audioPath: custom.audioPath,
                jellyfinAudioStreamIndex:
                    player.getCustomPlaybackSelectedAudioStreamIndex?.() ?? null,
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
                    audioChannelCount: custom.videoDecode.audioChannelCount,
                    audioCodec: custom.videoDecode.audioCodec,
                    audioSampleRate: custom.videoDecode.audioSampleRate,
                    audioSourceChannelCount: custom.videoDecode.audioSourceChannelCount,
                    audioSourceSampleRate: custom.videoDecode.audioSourceSampleRate,
                    droppedFrameCount: custom.videoDecode.droppedFrameCount,
                    failureKind: custom.videoDecode.failureKind,
                    nativeAudioClockReady: custom.videoDecode.nativeAudioClockReady,
                    peakFrameCount: custom.videoDecode.peakFrameCount,
                    pendingFrameCount: custom.videoDecode.pendingFrameCount,
                    queuedFrameCount: custom.videoDecode.queuedFrameCount,
                    receivedAudioFrameCount: custom.videoDecode.receivedAudioFrameCount,
                    receivedDolbyVisionEnhancementFrameCount:
                        custom.videoDecode.receivedDolbyVisionEnhancementFrameCount,
                    receivedDolbyVisionFrameCount:
                        custom.videoDecode.receivedDolbyVisionFrameCount,
                    receivedDolbyVisionRPUCount:
                        custom.videoDecode.receivedDolbyVisionRPUCount,
                    receivedFrameCount: custom.videoDecode.receivedFrameCount,
                    receivedNativeAudioSegmentCount:
                        custom.videoDecode.receivedNativeAudioSegmentCount,
                    recycledRawFrameCount: custom.videoDecode.recycledRawFrameCount,
                    staleAudioSampleCount: custom.videoDecode.staleAudioSampleCount,
                    staleFrameCount: custom.videoDecode.staleFrameCount,
                    state: custom.videoDecode.state,
                    staticHDRMetadataFirstAccessUnitIndex:
                        custom.videoDecode.staticHDRMetadataFirstAccessUnitIndex,
                    staticHDRMetadataScanAccessUnitCount:
                        custom.videoDecode.staticHDRMetadataScanAccessUnitCount,
                    staticHDRMetadataStatus: custom.videoDecode.staticHDRMetadataStatus,
                    takenFrameCount: custom.videoDecode.takenFrameCount
                } : null
            } : null,
            customPlaybackEligibility: customEligibility ? {
                audioOutputMode: customEligibility.eligible
                    ? customEligibility.audioOutputMode
                    : null,
                eligible: customEligibility.eligible,
                hdr: customEligibility.eligible ? customEligibility.hdr : null,
                nativeHDRTransfer: customEligibility.eligible
                    ? customEligibility.nativeHDRTransfer ?? null
                    : null,
                neutralizeHDRColorMetadata: customEligibility.eligible
                    ? customEligibility.neutralizeHDRColorMetadata
                    : null,
                reason: customEligibility.eligible ? null : customEligibility.reason,
                videoDecoderBackend: customEligibility.eligible
                    ? customEligibility.videoDecoderBackend
                    : null,
                videoOutputMode: customEligibility.eligible
                    ? customEligibility.videoOutputMode
                    : null
            } : null,
            customPlaybackSetup,
            customDecodeCapabilities: customDecodeCapabilities ? {
                audio: customDecodeCapabilities.audio,
                bundledHEVC: customDecodeCapabilities.bundledHEVC,
                nativeDolbyVisionHEVC: customDecodeCapabilities.nativeDolbyVisionHEVC,
                nativeSurroundAudio: customDecodeCapabilities.nativeSurroundAudio,
                nativeUltraHDVideo: customDecodeCapabilities.nativeUltraHDVideo,
                rawHDRHEVC: customDecodeCapabilities.rawHDRVideo?.hevc ?? null,
                telemetry: customDecodeCapabilities.telemetry,
                video: customDecodeCapabilities.video,
                videoHEVC: customDecodeCapabilities.video?.hevc ?? null
            } : null,
            customDeviceProfile: customDeviceProfile ? {
                addedAudioProfileCount: customDeviceProfile.addedAudioProfileCount,
                addedProfileCount: customDeviceProfile.addedProfileCount,
                addedVideoProfileCount: customDeviceProfile.addedVideoProfileCount,
                reason: customDeviceProfile.reason,
                supportedAudioCodecs: [ ...customDeviceProfile.supportedAudioCodecs ],
                supportedVideoCodecs: [ ...customDeviceProfile.supportedVideoCodecs ],
                widenedHDRCodecProfileCount:
                    customDeviceProfile.widenedHDRCodecProfileCount
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
                ownedNativeAudioCount: ownedNativeAudioElements.length,
                ownedNativeAudioPlaying: ownedNativeAudioElements.some(audio => !audio.paused),
                ownedNativeAudioSourcedCount: ownedNativeAudioElements.filter(
                    audio => Boolean(audio.getAttribute('src') || audio.currentSrc)
                ).length,
                ownedNativeAudioTimeMicroseconds: (() => {
                    const audio = ownedNativeAudioElements[0];
                    return audio && Number.isFinite(audio.currentTime)
                        ? Math.round(audio.currentTime * 1_000_000)
                        : null;
                })(),
                sourceLessVideoCount: videos.filter(isSourceLess).length,
                sourcedVideoCount: videos.filter(video => !isSourceLess(video)).length,
                videoCount: videos.length,
                viewportHeight: window.innerHeight,
                viewportWidth: window.innerWidth,
                visibleCanvasCount: canvases.filter(isVisible).length
            },
            dolbyVisionProfile,
            eventCounts: { ...capture.eventCounts },
            eventSequence: [ ...capture.eventSequence ],
            externalDolbyVisionValidation: externalDolbyVisionAuthorization ? {
                failureReason: externalDolbyVisionAuthorization.failureReason,
                fixtureVersion: externalDolbyVisionAuthorization.fixtureVersion,
                maximumChannelError:
                    externalDolbyVisionAuthorization.maximumChannelError,
                maximumInputChannelError:
                    externalDolbyVisionAuthorization.maximumInputChannelError,
                renderSettingsVersion:
                    externalDolbyVisionAuthorization.renderSettingsVersion,
                routeKey: externalDolbyVisionAuthorization.routeKey,
                sampleCount: externalDolbyVisionAuthorization.sampleCount,
                status: externalDolbyVisionAuthorization.status,
                targetFormat: externalDolbyVisionAuthorization.targetFormat
            } : null,
            externalHDRValidation: externalHDRAuthorization ? {
                authorizedRouteKeys: [ ...externalHDRAuthorization.authorizedRouteKeys ],
                failureReasons: { ...externalHDRAuthorization.failureReasons },
                fixtureVersion: externalHDRAuthorization.fixtureVersion,
                maximumChannelErrors: {
                    ...externalHDRAuthorization.maximumChannelErrors
                },
                pendingRouteKeys: [ ...externalHDRAuthorization.pendingRouteKeys ],
                rejectedRouteKeys: [ ...externalHDRAuthorization.rejectedRouteKeys ],
                renderSettingsVersion: externalHDRAuthorization.renderSettingsVersion,
                sampleCounts: { ...externalHDRAuthorization.sampleCounts },
                status: externalHDRAuthorization.status,
                targetFormat: externalHDRAuthorization.targetFormat
            } : null,
            hasCurrentSource: typeof currentSource === 'string'
                ? currentSource.length > 0
                : currentSource != null,
            isFetching: Boolean(fetchingValue),
            milestones: { ...(capture.milestones ?? {}) },
            nativeMediaAudioCapabilities,
            performanceNowMilliseconds: performance.now(),
            playbackDecision: {
                hasMediaSourceIdentifier:
                    typeof playbackMediaSource?.Id === 'string'
                    && playbackMediaSource.Id.length > 0,
                hasTranscodingURL:
                    typeof playbackMediaSource?.TranscodingUrl === 'string'
                    && playbackMediaSource.TranscodingUrl.length > 0,
                playMethod: typeof playbackStreamInfo?.playMethod === 'string'
                    ? playbackStreamInfo.playMethod
                    : null,
                supportsDirectPlay: playbackMediaSource?.SupportsDirectPlay === true,
                supportsDirectStream: playbackMediaSource?.SupportsDirectStream === true,
                supportsTranscoding: playbackMediaSource?.SupportsTranscoding === true
            },
            playerID: String(player.id || ''),
            presentationInputColorMetadata: activeRawColorMetadata ? {
                matrix: activeRawColorMetadata.matrix,
                nominalPeakNits: activeRawColorMetadata.nominalPeakNits,
                primaries: activeRawColorMetadata.primaries,
                range: activeRawColorMetadata.range,
                transfer: activeRawColorMetadata.transfer,
                version: activeRawColorMetadata.version
            } : null,
            presentationInputMode,
            renderSettings,
            sessionGeneration: Number.isSafeInteger(player.backendSessionGeneration)
                ? player.backendSessionGeneration
                : null,
            presentation: presentation ? {
                decodedFrameCount: presentation.decodedFrameCount,
                deviceRecoveryCount: presentation.deviceRecoveryCount,
                dolbyVisionProfile7FELBaseFallbackPresentedFrameCount:
                    presentation.dolbyVisionProfile7FELBaseFallbackPresentedFrameCount,
                dolbyVisionProfile7FELPresentedFrameCount:
                    presentation.dolbyVisionProfile7FELPresentedFrameCount,
                dolbyVisionProfile7MELPresentedFrameCount:
                    presentation.dolbyVisionProfile7MELPresentedFrameCount,
                fallbackReason: presentation.fallbackReason,
                firstFrameLatencyMicroseconds: presentation.firstFrameLatencyMicroseconds,
                lastCallbackTimeMicroseconds: presentation.lastCallbackTimeMicroseconds,
                lastExpectedDisplayTimeMicroseconds:
                    presentation.lastExpectedDisplayTimeMicroseconds,
                lastPresentedMediaTimeMicroseconds:
                    presentation.lastPresentedMediaTimeMicroseconds,
                sessionStartedMicroseconds: presentation.sessionStartedMicroseconds,
                mode: presentation.mode,
                nativeFrameCount: presentation.nativeFrameCount,
                presentationSource: presentation.presentationSource,
                presentedFrameCount: presentation.presentedFrameCount,
                state: presentation.state
            } : null,
            profile7DolbyVisionValidation: profile7DolbyVisionAuthorization ? {
                failureReason: profile7DolbyVisionAuthorization.failureReason,
                fixtureVersion: profile7DolbyVisionAuthorization.fixtureVersion,
                maximumChannelError:
                    profile7DolbyVisionAuthorization.maximumChannelError,
                renderSettingsVersion:
                    profile7DolbyVisionAuthorization.renderSettingsVersion,
                routeKey: profile7DolbyVisionAuthorization.routeKey,
                sampleCount: profile7DolbyVisionAuthorization.sampleCount,
                status: profile7DolbyVisionAuthorization.status,
                targetFormat: profile7DolbyVisionAuthorization.targetFormat
            } : null,
            profile7FELDolbyVisionValidation: profile7FELDolbyVisionAuthorization ? {
                failureReason: profile7FELDolbyVisionAuthorization.failureReason,
                fixtureVersion: profile7FELDolbyVisionAuthorization.fixtureVersion,
                maximumChannelError:
                    profile7FELDolbyVisionAuthorization.maximumChannelError,
                renderSettingsVersion:
                    profile7FELDolbyVisionAuthorization.renderSettingsVersion,
                routeKey: profile7FELDolbyVisionAuthorization.routeKey,
                sampleCount: profile7FELDolbyVisionAuthorization.sampleCount,
                status: profile7FELDolbyVisionAuthorization.status,
                targetFormat: profile7FELDolbyVisionAuthorization.targetFormat
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
            dolbyVisionValidation: dolbyVisionAuthorization ? {
                failureReason: dolbyVisionAuthorization.failureReason,
                fixtureVersion: dolbyVisionAuthorization.fixtureVersion,
                maximumChannelError: dolbyVisionAuthorization.maximumChannelError,
                renderSettingsVersion: dolbyVisionAuthorization.renderSettingsVersion,
                routeKey: dolbyVisionAuthorization.routeKey,
                sampleCount: dolbyVisionAuthorization.sampleCount,
                status: dolbyVisionAuthorization.status,
                targetFormat: dolbyVisionAuthorization.targetFormat
            } : null,
            rawHDRPlaybackRouteKey,
            stoppedEventCount: capture.eventCounts.stopped,
            terminalErrorCount: capture.eventCounts.error
        };
    })()`;
}

function createPlayerOperationExpression(accessKey, operation) {
    return `(async () => {
        const capture = window[${JSON.stringify(accessKey)}]?.();
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

function createPlaybackDecisionExpression(accessKey, expectedItemID) {
    return `(async () => {
        const capture = window[${JSON.stringify(accessKey)}]?.();
        const player = capture?.player;
        const streamInfo = player?.streamInfo ?? null;
        const mediaSource = streamInfo?.mediaSource ?? null;
        const item = streamInfo?.item ?? null;
        const clientMediaSourceID = typeof mediaSource?.Id === 'string'
            ? mediaSource.Id
            : null;
        const expectedItemID = ${JSON.stringify(expectedItemID)};
        const client = {
            hasMediaSourceIdentifier: clientMediaSourceID !== null
                && clientMediaSourceID.length > 0,
            hasTranscodingURL: typeof mediaSource?.TranscodingUrl === 'string'
                && mediaSource.TranscodingUrl.length > 0,
            itemMatched: item?.Id === expectedItemID,
            playMethod: typeof streamInfo?.playMethod === 'string'
                ? streamInfo.playMethod
                : null,
            supportsDirectPlay: mediaSource?.SupportsDirectPlay === true,
            supportsDirectStream: mediaSource?.SupportsDirectStream === true,
            supportsTranscoding: mediaSource?.SupportsTranscoding === true
        };
        if (!player
            || typeof ApiClient !== 'object'
            || typeof ApiClient.getSessions !== 'function'
            || typeof ApiClient.deviceId !== 'function') {
            return {
                client,
                server: {
                    itemMatched: false,
                    mediaSourceMatched: false,
                    playMethod: null,
                    requestSucceeded: false,
                    sessionMatched: false,
                    transcodeReasons: [],
                    transcodingActive: false
                }
            };
        }

        let sessions;
        try {
            sessions = await ApiClient.getSessions({
                deviceId: ApiClient.deviceId()
            });
        } catch {
            return {
                client,
                server: {
                    itemMatched: false,
                    mediaSourceMatched: false,
                    playMethod: null,
                    requestSucceeded: false,
                    sessionMatched: false,
                    transcodeReasons: [],
                    transcodingActive: false
                }
            };
        }
        const sessionList = Array.isArray(sessions) ? sessions : [];
        const itemSessions = sessionList.filter(session => (
            session?.NowPlayingItem?.Id === expectedItemID
        ));
        const session = itemSessions.find(candidate => (
            clientMediaSourceID !== null
            && candidate?.PlayState?.MediaSourceId === clientMediaSourceID
        )) ?? itemSessions[0] ?? null;
        const transcodingInfo = session?.TranscodingInfo ?? null;
        const transcodeReasons = Array.isArray(transcodingInfo?.TranscodeReasons)
            ? Array.from(new Set(transcodingInfo.TranscodeReasons.filter(reason => (
                typeof reason === 'string' && reason.length > 0
            )))).sort()
            : [];
        return {
            client,
            server: {
                isAudioDirect: typeof transcodingInfo?.IsAudioDirect === 'boolean'
                    ? transcodingInfo.IsAudioDirect
                    : null,
                isVideoDirect: typeof transcodingInfo?.IsVideoDirect === 'boolean'
                    ? transcodingInfo.IsVideoDirect
                    : null,
                itemMatched: session?.NowPlayingItem?.Id === expectedItemID,
                mediaSourceMatched: clientMediaSourceID !== null
                    && session?.PlayState?.MediaSourceId === clientMediaSourceID,
                playMethod: typeof session?.PlayState?.PlayMethod === 'string'
                    ? session.PlayState.PlayMethod
                    : null,
                requestSucceeded: true,
                sessionMatched: session !== null,
                transcodeReasons,
                transcodingActive: transcodingInfo !== null
            }
        };
    })()`;
}

async function collectPlaybackDecisionEvidence(client, accessKey, configuration) {
    return waitForValue({
        accept: evidence => evidence?.client?.itemMatched === true
            && typeof evidence.client.playMethod === 'string'
            && evidence.server?.requestSucceeded === true
            && evidence.server.sessionMatched === true
            && typeof evidence.server.playMethod === 'string',
        description: 'the bounded Jellyfin playback decision evidence',
        errorCode: 'playback-decision-timeout',
        read: () => evaluateValue(
            client,
            createPlaybackDecisionExpression(accessKey, configuration.itemID)
        ),
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
}

function createDeviceProfileDiagnosticsExpression(accessKey) {
    return `(async () => {
        const capture = window[${JSON.stringify(accessKey)}]?.();
        const player = capture?.player;
        const item = player?.streamInfo?.item ?? null;
        if (!player || !item || typeof player.getDeviceProfile !== 'function') {
            return null;
        }
        const profile = await player.getDeviceProfile(item, { isRetry: false });
        const mediaSource = player.streamInfo?.mediaSource ?? null;
        const mediaStreams = Array.isArray(mediaSource?.MediaStreams)
            ? mediaSource.MediaStreams
            : [];
        const hasToken = (value, token) => typeof value === 'string'
            && value.toLowerCase().split(',').map(part => part.trim()).includes(token);
        const container = typeof mediaSource?.Container === 'string'
            ? mediaSource.Container.toLowerCase().split(',')[0].trim()
            : null;
        const videoCodec = mediaStreams.find(stream => (
            String(stream?.Type).toLowerCase() === 'video'
        ))?.Codec?.toLowerCase() ?? null;
        const audioCodecs = Array.from(new Set(mediaStreams.filter(stream => (
            String(stream?.Type).toLowerCase() === 'audio'
            && typeof stream.Codec === 'string'
        )).map(stream => stream.Codec.toLowerCase())));
        const matchesContainer = value => {
            if (!container || typeof value !== 'string' || !value.trim()) {
                return true;
            }
            const normalizedValue = value.toLowerCase().trim();
            const isNegative = normalizedValue.startsWith('-');
            const tokens = (isNegative ? normalizedValue.slice(1) : normalizedValue)
                .split(',')
                .map(part => part.trim());
            return isNegative ? !tokens.includes(container) : tokens.includes(container);
        };
        const matchesCodec = (value, codec) => !codec || !value || hasToken(value, codec);
        return {
            audioCodecProfiles: (profile?.CodecProfiles ?? []).filter(codecProfile => (
                codecProfile?.Type === 'VideoAudio'
                && matchesContainer(codecProfile.Container)
                && (audioCodecs.length === 0 || audioCodecs.some(codec => (
                    matchesCodec(codecProfile.Codec, codec)
                )))
            )),
            directPlayProfiles: (profile?.DirectPlayProfiles ?? []).filter(directPlayProfile => (
                directPlayProfile?.Type === 'Video'
                && matchesContainer(directPlayProfile.Container)
                && matchesCodec(directPlayProfile.VideoCodec, videoCodec)
            )),
            media: { audioCodecs, container, videoCodec },
            videoCodecProfiles: (profile?.CodecProfiles ?? []).filter(codecProfile => (
                codecProfile?.Type === 'Video'
                && matchesContainer(codecProfile.Container)
                && matchesCodec(codecProfile.Codec, videoCodec)
            ))
        };
    })()`;
}

async function attachPlaybackDecisionFailureDiagnostics(
    error,
    client,
    accessKey,
    configuration
) {
    if (!(error instanceof SmokeHarnessError)) {
        return;
    }
    try {
        const [ playbackDecision, deviceProfile ] = await Promise.all([
            evaluateValue(
                client,
                createPlaybackDecisionExpression(accessKey, configuration.itemID)
            ),
            evaluateValue(
                client,
                createDeviceProfileDiagnosticsExpression(accessKey)
            ).catch(() => null)
        ]);
        error.diagnostics = {
            deviceProfile,
            playbackDecision,
            snapshot: error.diagnostics
        };
    } catch {
        // Preserve the primary failure when decision evidence is unavailable
    }
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

function createActivePlaybackExpectations(configuration) {
    return {
        expectedAudioPath: configuration.expectedAudioPath,
        expectedPlayMethod: configuration.expectedPlayMethod,
        expectedPresentationRoute: configuration.expectedPresentationRoute,
        expectedStaticHDRMetadataStatus: configuration.expectedStaticHDRMetadataStatus,
        expectedStaticHDRPeakNits: configuration.expectedStaticHDRPeakNits,
        expectedVideoDecoderBackend: configuration.expectedVideoDecoderBackend,
        expectedVideoOutputMode: configuration.expectedVideoOutputMode
    };
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
        runtimeExceptions: 0,
        videoSampleOwnershipWarnings: 0
    };
    const messages = [];
    const addMessage = message => {
        if (isVideoSampleOwnershipWarning(message)) {
            counts.videoSampleOwnershipWarnings += 1;
        }
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
            counts.videoSampleOwnershipWarnings = 0;
            messages.length = 0;
        }
    };
}

function summarizeBrowserErrorMonitors(browserErrorMonitors) {
    const counts = {
        consoleErrors: 0,
        ignoredUnattributedScriptErrors: 0,
        logErrors: 0,
        runtimeExceptions: 0,
        videoSampleOwnershipWarnings: 0
    };
    const messages = [];
    for (const browserErrorMonitor of browserErrorMonitors) {
        for (const countName of Object.keys(counts)) {
            counts[countName] += browserErrorMonitor.counts[countName];
        }
        messages.push(...browserErrorMonitor.messages);
    }
    return { counts, messages };
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

async function reloadFreshFrontend(client, configuration, searchParameters = {}) {
    const frontendURL = new URL(configuration.frontendURL);
    frontendURL.searchParams.set('webgpuSmokeRun', String(Date.now()));
    for (const [ name, value ] of Object.entries(searchParameters)) {
        frontendURL.searchParams.set(name, value);
    }
    await navigate(client, frontendURL.toString(), configuration);
    await waitForValue({
        accept: isFrontendInitializationReady,
        description: 'fresh frontend initialization',
        errorCode: 'frontend-initialization-timeout',
        read: () => evaluateValue(client, `(() => {
            const isVisible = element => {
                if (!element) {
                    return false;
                }
                const rectangle = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                return rectangle.width > 0
                    && rectangle.height > 0
                    && style.display !== 'none'
                    && style.visibility !== 'hidden';
            };
            const apiClientAvailable = typeof ApiClient === 'object';
            return {
                apiClientAvailable,
                apiClientLandingAvailable: apiClientAvailable && (
                    isVisible(document.querySelector('#indexPage'))
                    || isVisible(document.querySelector('#loginPage'))
                ),
                documentReadyState: document.readyState,
                locationHash: location.hash,
                serverHostInputAvailable: isVisible(document.querySelector('#txtServerHost')),
                serverSelectionPageAvailable:
                    isVisible(document.querySelector('#selectServerPage'))
            };
        })()`),
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

async function ensureBrowserPageVisible(client, pageTarget, configuration) {
    await client.send('Page.bringToFront');
    const initialVisibility = await evaluateValue(
        client,
        '({ hidden: document.hidden, visibilityState: document.visibilityState })',
        false
    );
    if (initialVisibility?.hidden === false
        && initialVisibility.visibilityState === 'visible') {
        return;
    }

    const windowDescriptor = await client.send('Browser.getWindowForTarget', {
        targetId: pageTarget.id
    });
    const windowIdentifier = windowDescriptor.windowId;
    if (!Number.isSafeInteger(windowIdentifier)) {
        throw new SmokeHarnessError(
            'browser-window-unavailable',
            'Unable to identify the browser window required for visible playback validation'
        );
    }

    if (windowDescriptor.bounds?.windowState !== 'minimized') {
        await client.send('Browser.setWindowBounds', {
            bounds: { windowState: 'minimized' },
            windowId: windowIdentifier
        });
        await sleep(BROWSER_VISIBILITY_RESTORE_MILLISECONDS);
    }
    await client.send('Browser.setWindowBounds', {
        bounds: { windowState: 'normal' },
        windowId: windowIdentifier
    });
    await client.send('Page.bringToFront');
    await waitForValue({
        accept: visibility => visibility?.hidden === false
            && visibility.visibilityState === 'visible',
        description: 'a visible browser page for hardware presentation validation',
        errorCode: 'browser-page-hidden',
        read: () => evaluateValue(
            client,
            '({ hidden: document.hidden, visibilityState: document.visibilityState })',
            false
        ),
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
}

async function readFrontendConfiguration(configuration) {
    const configurationURL = new URL(createFrontendAssetURL(
        configuration.frontendURL,
        'config.json'
    ));
    let response;
    try {
        response = await fetch(configurationURL, {
            cache: 'no-store',
            signal: AbortSignal.timeout(configuration.timeoutMilliseconds)
        });
    } catch {
        throw new SmokeHarnessError(
            'startup-config-fetch-failed',
            'Unable to read the frontend configuration for startup comparison'
        );
    }
    if (!response.ok) {
        throw new SmokeHarnessError(
            'startup-config-fetch-failed',
            'The frontend configuration request failed for startup comparison'
        );
    }
    let frontendConfiguration;
    try {
        frontendConfiguration = await response.json();
    } catch {
        throw new SmokeHarnessError(
            'startup-config-invalid',
            'The frontend configuration was not valid JSON'
        );
    }
    if (!frontendConfiguration
        || typeof frontendConfiguration !== 'object'
        || Array.isArray(frontendConfiguration)) {
        throw new SmokeHarnessError(
            'startup-config-invalid',
            'The frontend configuration was not an object'
        );
    }
    return {
        configuration: frontendConfiguration,
        url: configurationURL.toString()
    };
}

async function createStartupConfigurationInterceptor(client, configuration) {
    const frontendConfiguration = await readFrontendConfiguration(configuration);
    let activeMode = null;
    let closePromise = null;
    let closed = false;
    let fetchEnabled = false;
    let interceptionFailure = null;
    const pendingOperations = new Set();
    const removeListener = client.on('Fetch.requestPaused', parameters => {
        const operation = (async () => {
            if (parameters.request?.url !== frontendConfiguration.url || activeMode === null) {
                await client.send('Fetch.continueRequest', {
                    requestId: parameters.requestId
                });
                return;
            }
            const featureFlags = getStartupModeFeatureFlags(activeMode);
            const responseBody = Buffer.from(JSON.stringify({
                ...frontendConfiguration.configuration,
                ...featureFlags
            }), 'utf8').toString('base64');
            await client.send('Fetch.fulfillRequest', {
                body: responseBody,
                responseCode: 200,
                responseHeaders: [
                    { name: 'Cache-Control', value: 'no-store' },
                    { name: 'Content-Type', value: 'application/json; charset=utf-8' }
                ],
                requestId: parameters.requestId
            });
        })().catch(async error => {
            interceptionFailure ??= new SmokeHarnessError(
                'startup-config-interception-failed',
                'Unable to apply the startup comparison configuration overlay',
                {
                    causeName: typeof error?.name === 'string' ? error.name : 'Error'
                }
            );
            try {
                await client.send('Fetch.continueRequest', {
                    requestId: parameters.requestId
                });
            } catch {
                // The request may already have completed before the interception failed
            }
        }).finally(() => {
            pendingOperations.delete(operation);
        });
        pendingOperations.add(operation);
    });
    try {
        await client.send('Fetch.enable', {
            patterns: [ {
                requestStage: 'Request',
                urlPattern: frontendConfiguration.url
            } ]
        });
        fetchEnabled = true;
    } catch (error) {
        removeListener();
        throw error;
    }
    return {
        async close() {
            if (closePromise) {
                return closePromise;
            }
            activeMode = null;
            closed = true;
            removeListener();
            closePromise = (async () => {
                // No operation can be added after listener removal, so this
                // snapshot is a complete drain before interception is disabled
                await Promise.allSettled([ ...pendingOperations ]);
                let disableFailure = null;
                if (fetchEnabled) {
                    try {
                        await client.send('Fetch.disable');
                    } catch (error) {
                        disableFailure = error;
                    }
                    fetchEnabled = false;
                }
                if (interceptionFailure !== null) {
                    throw interceptionFailure;
                }
                if (disableFailure !== null) {
                    throw disableFailure;
                }
            })();
            return closePromise;
        },
        requireHealthy() {
            if (interceptionFailure !== null) {
                throw interceptionFailure;
            }
        },
        setMode(mode) {
            getStartupModeFeatureFlags(mode);
            if (closed) {
                throw new SmokeHarnessError(
                    'startup-config-interceptor-closed',
                    'The startup comparison configuration interceptor is closed'
                );
            }
            if (interceptionFailure !== null) {
                throw interceptionFailure;
            }
            activeMode = mode;
        }
    };
}

function getExpectedControllerAudioPath(expectedAudioPath) {
    return expectedAudioPath === 'native-media' ? 'ready' : expectedAudioPath;
}

function hasExpectedCustomAudio(snapshot, expectedAudioPath) {
    switch (expectedAudioPath) {
        case 'disabled':
            return snapshot?.customPlayback?.audioPath === 'disabled';
        case 'ready':
            return snapshot?.customPlayback?.audioPath === 'ready';
        case 'native-media':
            return hasReadyNativeMediaAudio(snapshot);
        default:
            return false;
    }
}

function isExpectedCustomPlaybackActive(snapshot, configuration, previousGeneration = null) {
    const generationAdvanced = previousGeneration === null
        || (Number.isSafeInteger(snapshot?.sessionGeneration)
            && snapshot.sessionGeneration > previousGeneration);
    return snapshot?.captured === true
        && snapshot.playerID === 'webgpuvideoplayer'
        && generationAdvanced
        && snapshot.customPlayback?.state === 'playing'
        && hasExpectedCustomAudio(snapshot, configuration.expectedAudioPath)
        && snapshot.customPlaybackEligibility?.videoOutputMode
            === configuration.expectedVideoOutputMode
        && (configuration.expectedVideoDecoderBackend === null
            || snapshot.customPlaybackEligibility?.videoDecoderBackend
                === configuration.expectedVideoDecoderBackend)
        && hasExpectedPresentationRoute(
            snapshot,
            configuration.expectedPresentationRoute
        )
        && (snapshot.customPlaybackEligibility?.hdr !== true
            || hasAuthorizedHDRPlaybackRoute(snapshot))
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

function isExpectedStartupModeActive(snapshot, mode, configuration) {
    const commonActive = snapshot?.captured === true
        && snapshot.terminalErrorCount === 0
        && (configuration.expectedPlayMethod === null
            || snapshot.playbackDecision?.playMethod === configuration.expectedPlayMethod)
        && Number.isFinite(snapshot.milestones?.playInvokedAtMilliseconds)
        && Number.isFinite(snapshot.milestones?.playbackStartAtMilliseconds)
        && Number.isFinite(snapshot.milestones?.playerPlayingAtMilliseconds);
    if (!commonActive) {
        return false;
    }
    switch (mode) {
        case 'html':
            return snapshot.playerID === 'htmlvideoplayer'
                && Number.isFinite(snapshot.milestones.nativeVideoFrameAtMilliseconds)
                && (configuration.expectedAudioPath === 'disabled'
                    || Number.isFinite(
                        snapshot.milestones.nativeMediaPlayingAtMilliseconds
                    ));
        case 'presentation':
            return snapshot.playerID === 'webgpuvideoplayer'
                && snapshot.customPlayback === null
                && snapshot.presentation?.state === 'presenting'
                && snapshot.presentation.fallbackReason === null
                && snapshot.presentation.presentationSource === 'native'
                && snapshot.presentation.presentedFrameCount > 0
                && Number.isSafeInteger(
                    snapshot.presentation.firstFrameLatencyMicroseconds
                )
                && Number.isSafeInteger(
                    snapshot.presentation.sessionStartedMicroseconds
                )
                && Number.isFinite(snapshot.milestones.canvasAttachedAtMilliseconds)
                && Number.isFinite(snapshot.milestones.nativeVideoFrameAtMilliseconds)
                && (configuration.expectedAudioPath === 'disabled'
                    || Number.isFinite(
                        snapshot.milestones.nativeMediaPlayingAtMilliseconds
                    ));
        case 'custom':
            return snapshot.playerID === 'webgpuvideoplayer'
                && snapshot.customPlayback?.state === 'playing'
                && snapshot.customPlayback.audioPath
                    === getExpectedControllerAudioPath(configuration.expectedAudioPath)
                && snapshot.customPlayback.fallbackReason === null
                && snapshot.customPlayback.videoDecode?.receivedFrameCount > 0
                && snapshot.customPlaybackEligibility?.eligible === true
                && snapshot.customPlaybackEligibility.videoOutputMode
                    === configuration.expectedVideoOutputMode
                && (configuration.expectedVideoDecoderBackend === null
                    || snapshot.customPlaybackEligibility.videoDecoderBackend
                        === configuration.expectedVideoDecoderBackend)
                && hasExpectedPresentationRoute(
                    snapshot,
                    configuration.expectedPresentationRoute
                )
                && snapshot.presentation?.state === 'presenting'
                && snapshot.presentation.fallbackReason === null
                && snapshot.presentation.presentationSource === 'decoded'
                && snapshot.presentation.presentedFrameCount > 0
                && Number.isSafeInteger(
                    snapshot.presentation.firstFrameLatencyMicroseconds
                )
                && Number.isSafeInteger(
                    snapshot.presentation.sessionStartedMicroseconds
                )
                && Number.isFinite(snapshot.milestones.canvasAttachedAtMilliseconds)
                && (configuration.expectedAudioPath === 'disabled'
                    || configuration.expectedAudioPath === 'ready'
                        && hasConsumedCustomAudio(snapshot)
                    || configuration.expectedAudioPath === 'native-media'
                        && hasReadyNativeMediaAudio(snapshot)
                        && Number.isFinite(
                            snapshot.observedMilestones?.firstCustomAudioAtMilliseconds
                        ))
                && (snapshot.customPlaybackEligibility?.hdr !== true
                    || hasAuthorizedHDRPlaybackRoute(snapshot));
        default:
            return false;
    }
}

function requireStartupElapsedMilliseconds(startedAtMilliseconds, endedAtMilliseconds, label) {
    if (!Number.isFinite(startedAtMilliseconds)
        || !Number.isFinite(endedAtMilliseconds)
        || endedAtMilliseconds < startedAtMilliseconds) {
        throw new SmokeHarnessError(
            'startup-milestone-invalid',
            `The ${label} startup milestone was missing or out of order`
        );
    }
    return endedAtMilliseconds - startedAtMilliseconds;
}

function summarizeStartupSample(
    snapshot,
    mode,
    sampleNumber,
    orderPosition,
    measured,
    audioExpected
) {
    const milestones = snapshot.milestones;
    const playInvokedAtMilliseconds = milestones.playInvokedAtMilliseconds;
    const firstPresentedAtMilliseconds = mode === 'html' ?
        milestones.nativeVideoFrameAtMilliseconds :
        (snapshot.presentation.sessionStartedMicroseconds
            + snapshot.presentation.firstFrameLatencyMicroseconds)
            / MICROSECONDS_PER_MILLISECOND;
    const firstVisibleFrameAtMilliseconds = firstPresentedAtMilliseconds;
    let firstAudioAtMilliseconds = null;
    if (audioExpected) {
        firstAudioAtMilliseconds = mode === 'custom' ?
            snapshot.observedMilestones.firstCustomAudioAtMilliseconds :
            milestones.nativeMediaPlayingAtMilliseconds;
    }
    const firstDecodedFrameAtMilliseconds = mode === 'custom' ?
        snapshot.observedMilestones.firstCustomDecodedFrameAtMilliseconds :
        milestones.nativeVideoFrameAtMilliseconds;
    return {
        measured,
        milestones: {
            firstAudioMilliseconds: Number.isFinite(firstAudioAtMilliseconds) ?
                requireStartupElapsedMilliseconds(
                    playInvokedAtMilliseconds,
                    firstAudioAtMilliseconds,
                    'first audio'
                ) :
                null,
            firstDecodedFrameMilliseconds: Number.isFinite(firstDecodedFrameAtMilliseconds) ?
                requireStartupElapsedMilliseconds(
                    playInvokedAtMilliseconds,
                    firstDecodedFrameAtMilliseconds,
                    'first decoded frame'
                ) :
                null,
            firstVisibleFrameMilliseconds: requireStartupElapsedMilliseconds(
                playInvokedAtMilliseconds,
                firstVisibleFrameAtMilliseconds,
                'first visible frame'
            ),
            playInvocationToPlaybackStartMilliseconds:
                requireStartupElapsedMilliseconds(
                    playInvokedAtMilliseconds,
                    milestones.playbackStartAtMilliseconds,
                    'playback start'
                ),
            playInvocationToPlayingMilliseconds: requireStartupElapsedMilliseconds(
                playInvokedAtMilliseconds,
                milestones.playerPlayingAtMilliseconds,
                'playing'
            ),
            presentationAttachToFrameMilliseconds: mode === 'html' ?
                null :
                requireStartupElapsedMilliseconds(
                    milestones.canvasAttachedAtMilliseconds,
                    firstVisibleFrameAtMilliseconds,
                    'presentation attach-to-frame'
                )
        },
        mode,
        orderPosition,
        route: {
            audioPath: snapshot.customPlayback?.audioPath ?? (
                snapshot.milestones.nativeMediaPlayingAtMilliseconds === null ?
                    'unobserved' :
                    'native-media'
            ),
            decoderBackend:
                snapshot.customPlaybackEligibility?.videoDecoderBackend ?? 'native-html',
            outputMode:
                snapshot.customPlaybackEligibility?.videoOutputMode ?? 'native-html',
            playMethod: snapshot.playbackDecision?.playMethod ?? null,
            playerID: snapshot.playerID,
            presentationSource: snapshot.presentation?.presentationSource ?? 'native-video',
            staticHDRMetadata: mode === 'custom' ? {
                firstAccessUnitIndex:
                    snapshot.customPlayback?.videoDecode
                        ?.staticHDRMetadataFirstAccessUnitIndex ?? null,
                scanAccessUnitCount:
                    snapshot.customPlayback?.videoDecode
                        ?.staticHDRMetadataScanAccessUnitCount ?? null,
                status:
                    snapshot.customPlayback?.videoDecode?.staticHDRMetadataStatus ?? null,
                toneMappingPeakNits:
                    snapshot.renderSettings?.toneMapping?.inputPeakNits ?? null
            } : null
        },
        sampleNumber
    };
}

async function stopStartupSample(client, accessKey, configuration) {
    const stopResult = await evaluateValue(
        client,
        createPlayerOperationExpression(
            accessKey,
            'await Promise.resolve(player.stop(false));'
        )
    );
    if (!stopResult) {
        throw new SmokeHarnessError(
            'startup-stop-failed',
            'Unable to stop a startup comparison sample'
        );
    }
    return waitForPlayerSnapshot({
        accept: snapshot => snapshot?.stoppedEventCount === 1
            && snapshot.dom?.canvasCount === 0
            && snapshot.dom?.sourcedVideoCount === 0,
        accessKey,
        client,
        description: 'startup comparison sample cleanup',
        errorCode: 'startup-stop-timeout',
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
}

async function navigateToStartupItem(client, configuration) {
    const serverID = await waitForValue({
        accept: value => typeof value === 'string' && value.length > 0,
        description: 'the startup comparison server identifier',
        errorCode: 'startup-server-identifier-timeout',
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
    return waitForVisibleElement(
        client,
        PLAY_BUTTON_SELECTORS,
        configuration,
        'the startup comparison play button'
    );
}

async function closeStartupModeRuntime(browserClient, runtime) {
    let cleanupFailure = null;
    if (runtime.configurationInterceptor) {
        try {
            await runtime.configurationInterceptor.close();
        } catch (error) {
            cleanupFailure = error;
        }
    }
    runtime.client?.close();
    if (runtime.targetID) {
        try {
            await browserClient.send('Target.closeTarget', { targetId: runtime.targetID });
        } catch (error) {
            cleanupFailure ??= error;
        }
    }
    if (runtime.browserContextID) {
        try {
            await browserClient.send('Target.disposeBrowserContext', {
                browserContextId: runtime.browserContextID
            });
        } catch (error) {
            cleanupFailure ??= error;
        }
    }
    if (cleanupFailure !== null) {
        throw cleanupFailure;
    }
}

async function createStartupModeRuntime(browserClient, mode, configuration) {
    const runtime = {
        browserContextID: null,
        browserErrorMonitor: null,
        client: null,
        configurationInterceptor: null,
        mode,
        targetID: null
    };
    try {
        const createdBrowserContext = await browserClient.send('Target.createBrowserContext');
        if (typeof createdBrowserContext?.browserContextId !== 'string') {
            throw new SmokeHarnessError(
                'startup-browser-context-creation-failed',
                `Chromium did not return a browser context for ${mode} startup measurements`
            );
        }
        runtime.browserContextID = createdBrowserContext.browserContextId;
        const createdTarget = await browserClient.send('Target.createTarget', {
            background: true,
            browserContextId: runtime.browserContextID,
            url: 'about:blank'
        });
        if (typeof createdTarget?.targetId !== 'string') {
            throw new SmokeHarnessError(
                'startup-target-creation-failed',
                `Chromium did not return a target for ${mode} startup measurements`
            );
        }
        runtime.targetID = createdTarget.targetId;
        const pageTarget = await waitForBrowserTargetByID(configuration, runtime.targetID);
        runtime.client = await RawCDPClient.connect(
            pageTarget.webSocketDebuggerUrl,
            configuration.timeoutMilliseconds
        );
        await Promise.all([
            runtime.client.send('Log.enable'),
            runtime.client.send('Network.enable'),
            runtime.client.send('Page.enable'),
            runtime.client.send('Performance.enable'),
            runtime.client.send('Runtime.enable')
        ]);
        await Promise.all([
            runtime.client.send('Network.setBypassServiceWorker', { bypass: true }),
            runtime.client.send('Network.setCacheDisabled', { cacheDisabled: false })
        ]);
        runtime.configurationInterceptor = await createStartupConfigurationInterceptor(
            runtime.client,
            configuration
        );
        runtime.configurationInterceptor.setMode(mode);
        await reloadFreshFrontend(runtime.client, configuration, {
            webgpuStartupMode: mode
        });
        runtime.configurationInterceptor.requireHealthy();
        const alreadyAuthenticated = await hasMatchingAuthenticatedServer(
            runtime.client,
            configuration
        );
        if (!alreadyAuthenticated) {
            await connectToConfiguredServer(runtime.client, configuration);
            await signInIfRequired(runtime.client, configuration);
        }
        await waitForValue({
            accept: authenticated => authenticated === true,
            description: `${mode} startup comparison authentication`,
            errorCode: 'startup-authentication-timeout',
            read: () => hasMatchingAuthenticatedServer(runtime.client, configuration),
            timeoutMilliseconds: configuration.timeoutMilliseconds
        });
        return runtime;
    } catch (error) {
        await closeStartupModeRuntime(browserClient, runtime).catch(() => undefined);
        throw error;
    }
}

async function prepareStartupModeRuntime(runtime, configuration) {
    await reloadFreshFrontend(runtime.client, configuration, {
        webgpuStartupMode: runtime.mode
    });
    runtime.configurationInterceptor.requireHealthy();
    await waitForValue({
        accept: authenticated => authenticated === true,
        description: `${runtime.mode} synchronized startup authentication`,
        errorCode: 'startup-authentication-timeout',
        read: () => hasMatchingAuthenticatedServer(runtime.client, configuration),
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
    await navigateToStartupItem(runtime.client, configuration);
    runtime.browserErrorMonitor = createBrowserErrorMonitor(runtime.client);
}

async function runStartupModeSample(options) {
    await options.client.send('Page.bringToFront');
    const playButton = await waitForVisibleElement(
        options.client,
        PLAY_BUTTON_SELECTORS,
        options.configuration,
        `the ${options.mode} startup comparison play button`
    );
    const accessKey = `webgpu-startup-access-${crypto.randomUUID()}`;
    const restoreKey = `webgpu-startup-restore-${crypto.randomUUID()}`;
    let hookInstalled = false;
    let playbackStarted = false;
    try {
        hookInstalled = await evaluateValue(
            options.client,
            createPlayerCaptureHookExpression(
                accessKey,
                restoreKey,
                true,
                options.mode === 'html' ? 'htmlvideoplayer' : 'webgpuvideoplayer'
            )
        );
        if (!hookInstalled) {
            throw new SmokeHarnessError(
                'startup-events-hook-failed',
                'window.Events.trigger was unavailable before a startup sample'
            );
        }
        await trustedStartupClick(options.client, playButton, accessKey);
        playbackStarted = true;
        const observedMilestones = {
            firstCustomAudioAtMilliseconds: null,
            firstCustomDecodedFrameAtMilliseconds: null
        };
        let nativeAudioBaselineTimeMicroseconds = null;
        const activeSnapshot = await waitForValue({
            accept: snapshot => isExpectedStartupModeActive(
                snapshot,
                options.mode,
                options.configuration
            ),
            description: `${options.mode} startup milestones`,
            errorCode: 'startup-sample-timeout',
            pollIntervalMilliseconds: STARTUP_MILESTONE_POLL_MILLISECONDS,
            read: async () => {
                const snapshot = await getPlayerSnapshot(options.client, accessKey);
                if (snapshot.customPlayback?.videoDecode?.receivedFrameCount > 0) {
                    observedMilestones.firstCustomDecodedFrameAtMilliseconds
                        ??= snapshot.performanceNowMilliseconds;
                }
                if (hasConsumedCustomAudio(snapshot)) {
                    observedMilestones.firstCustomAudioAtMilliseconds
                        ??= snapshot.performanceNowMilliseconds;
                } else if (hasReadyNativeMediaAudio(snapshot)) {
                    const nativeAudioTimeMicroseconds =
                        snapshot.dom?.ownedNativeAudioTimeMicroseconds;
                    if (nativeAudioBaselineTimeMicroseconds === null) {
                        nativeAudioBaselineTimeMicroseconds = nativeAudioTimeMicroseconds;
                    } else if (
                        Number.isSafeInteger(nativeAudioTimeMicroseconds)
                        && nativeAudioTimeMicroseconds > nativeAudioBaselineTimeMicroseconds
                    ) {
                        observedMilestones.firstCustomAudioAtMilliseconds
                            ??= snapshot.performanceNowMilliseconds;
                    }
                }
                snapshot.observedMilestones = { ...observedMilestones };
                return snapshot;
            },
            timeoutMilliseconds: options.configuration.timeoutMilliseconds
        });
        const playbackDecision = await collectPlaybackDecisionEvidence(
            options.client,
            accessKey,
            options.configuration
        );
        const playbackDecisionFailures = validatePlaybackDecisionEvidence(
            playbackDecision,
            options.configuration.expectedPlayMethod
        );
        if (playbackDecisionFailures.length > 0) {
            throw new SmokeHarnessError(
                'startup-playback-decision-mismatch',
                `The ${options.mode} startup sample selected an unexpected playback method`,
                { failures: playbackDecisionFailures, playbackDecision }
            );
        }
        if (options.mode === 'custom') {
            const staticHDRMetadataFailures = validateStaticHDRMetadataSnapshot(
                activeSnapshot,
                options.configuration.expectedStaticHDRMetadataStatus,
                options.configuration.expectedStaticHDRPeakNits
            );
            if (staticHDRMetadataFailures.length > 0) {
                throw new SmokeHarnessError(
                    'startup-static-hdr-metadata-mismatch',
                    'The custom startup sample did not match its static HDR metadata contract',
                    { failures: staticHDRMetadataFailures }
                );
            }
        }
        const sample = summarizeStartupSample(
            activeSnapshot,
            options.mode,
            options.sampleNumber,
            options.orderPosition,
            options.measured,
            options.configuration.expectedAudioPath !== 'disabled'
        );
        sample.playbackDecision = playbackDecision;
        await stopStartupSample(options.client, accessKey, options.configuration);
        playbackStarted = false;
        return sample;
    } finally {
        if (hookInstalled && playbackStarted) {
            try {
                await evaluateValue(
                    options.client,
                    createPlayerOperationExpression(
                        accessKey,
                        'await Promise.resolve(player.stop(false));'
                    )
                );
            } catch {
                // Preserve the first startup measurement or route failure
            }
        }
        if (hookInstalled) {
            try {
                await evaluateValue(options.client, `(() => {
                    const result = window[${JSON.stringify(restoreKey)}]?.();
                    delete window[${JSON.stringify(accessKey)}];
                    delete window[${JSON.stringify(restoreKey)}];
                    return result;
                })()`);
            } catch {
                // A failed sample may have navigated away before hook cleanup
            }
        }
    }
}

function createStartupValidationSamples(samples) {
    const samplesByMode = Object.fromEntries(STARTUP_RESULT_MODES.map(mode => [
        mode,
        samples.filter(sample => sample.mode === mode)
    ]));
    const readMilestone = (mode, name) => samplesByMode[mode].map(sample => ({
        sampleNumber: sample.sampleNumber,
        value: sample.milestones[name]
    }));
    return {
        custom: {
            customFirstAudioMilliseconds:
                readMilestone('custom', 'firstAudioMilliseconds'),
            customFirstVisibleFrameMilliseconds:
                readMilestone('custom', 'firstVisibleFrameMilliseconds'),
            htmlFirstAudioMilliseconds:
                readMilestone('html', 'firstAudioMilliseconds'),
            customPlayingMilliseconds:
                readMilestone('custom', 'playInvocationToPlayingMilliseconds'),
            htmlFirstVisibleFrameMilliseconds:
                readMilestone('html', 'firstVisibleFrameMilliseconds'),
            htmlPlayingMilliseconds:
                readMilestone('html', 'playInvocationToPlayingMilliseconds')
        },
        presentation: {
            htmlFirstAudioMilliseconds:
                readMilestone('html', 'firstAudioMilliseconds'),
            htmlFirstVisibleFrameMilliseconds:
                readMilestone('html', 'firstVisibleFrameMilliseconds'),
            htmlPlayingMilliseconds:
                readMilestone('html', 'playInvocationToPlayingMilliseconds'),
            presentationAttachToFrameMilliseconds:
                readMilestone('presentation', 'presentationAttachToFrameMilliseconds'),
            presentationFirstAudioMilliseconds:
                readMilestone('presentation', 'firstAudioMilliseconds'),
            presentationFirstVisibleFrameMilliseconds:
                readMilestone('presentation', 'firstVisibleFrameMilliseconds'),
            presentationPlayingMilliseconds:
                readMilestone('presentation', 'playInvocationToPlayingMilliseconds')
        }
    };
}

function validateApplicableStartupPresentationSamples(
    validationSamples,
    startupModes,
    configuration
) {
    if (!startupModes.includes('presentation')) {
        return null;
    }
    return validateHTMLVersusPresentationStartupSamples(
        validationSamples.presentation,
        {
            requiredSampleCount: configuration.startupSampleCount,
            validateFirstAudio: configuration.expectedAudioPath !== 'disabled'
        }
    );
}

async function runStartupComparison(
    configuration,
    beginServerLogCaptureAfterPreparation
) {
    const startupModes = getStartupComparisonModes(
        configuration.expectedPresentationRoute
    );
    const browserWebSocketDebuggerURL = await getBrowserWebSocketDebuggerURL(configuration);
    const browserClient = await RawCDPClient.connect(
        browserWebSocketDebuggerURL,
        configuration.timeoutMilliseconds
    );
    const measuredSamples = [];
    const modeRuntimes = [];
    const warmupSamples = [];
    let comparisonFailure = null;
    let comparisonResult = null;
    try {
        for (const mode of startupModes) {
            modeRuntimes.push(await createStartupModeRuntime(
                browserClient,
                mode,
                configuration
            ));
        }
        for (const runtime of modeRuntimes) {
            await prepareStartupModeRuntime(runtime, configuration);
        }
        await beginServerLogCaptureAfterPreparation();
        const runtimeByMode = Object.fromEntries(modeRuntimes.map(runtime => [
            runtime.mode,
            runtime
        ]));
        for (let modeIndex = 0; modeIndex < startupModes.length; modeIndex++) {
            const mode = startupModes[modeIndex];
            const runtime = runtimeByMode[mode];
            warmupSamples.push(await runStartupModeSample({
                client: runtime.client,
                configuration,
                measured: false,
                mode,
                orderPosition: modeIndex + 1,
                sampleNumber: 0
            }));
        }
        for (
            let sampleNumber = 1;
            sampleNumber <= configuration.startupSampleCount;
            sampleNumber++
        ) {
            const modeOrder = createStartupSampleModeOrder(sampleNumber).filter(
                mode => startupModes.includes(mode)
            );
            for (let modeIndex = 0; modeIndex < modeOrder.length; modeIndex++) {
                const mode = modeOrder[modeIndex];
                const runtime = runtimeByMode[mode];
                measuredSamples.push(await runStartupModeSample({
                    client: runtime.client,
                    configuration,
                    measured: true,
                    mode,
                    orderPosition: modeIndex + 1,
                    sampleNumber
                }));
            }
        }
        const validationSamples = createStartupValidationSamples(measuredSamples);
        const presentationValidation = validateApplicableStartupPresentationSamples(
            validationSamples,
            startupModes,
            configuration
        );
        const customValidation = validateHTMLVersusCustomStartupSamples(
            validationSamples.custom,
            {
                requiredSampleCount: configuration.startupSampleCount,
                validateFirstAudio: configuration.expectedAudioPath !== 'disabled'
            }
        );
        const failures = [];
        const browserDiagnostics = summarizeBrowserErrorMonitors(
            modeRuntimes.map(runtime => runtime.browserErrorMonitor)
        );
        appendFailures(
            failures,
            'startup-presentation',
            presentationValidation?.failures ?? []
        );
        appendFailures(failures, 'startup-custom', customValidation.failures);
        appendBrowserErrorFailures(failures, browserDiagnostics.counts);
        comparisonResult = {
            diagnostics: {
                browserErrors: { ...browserDiagnostics.counts },
                browserMessages: [ ...browserDiagnostics.messages ]
            },
            failures,
            observations: {
                startupComparison: {
                    customValidation: customValidation.metrics,
                    measuredSamples,
                    modes: [ ...startupModes ],
                    presentationValidation: presentationValidation?.metrics ?? null,
                    sampleCountPerMode: configuration.startupSampleCount,
                    warmupSamples
                }
            }
        };
    } catch (error) {
        comparisonFailure = error;
        const browserDiagnostics = summarizeBrowserErrorMonitors(
            modeRuntimes
                .filter(runtime => runtime.browserErrorMonitor !== null)
                .map(runtime => runtime.browserErrorMonitor)
        );
        if (error instanceof SmokeHarnessError) {
            error.diagnostics = {
                browserErrors: { ...browserDiagnostics.counts },
                browserMessages: [ ...browserDiagnostics.messages ],
                lastObservation: error.diagnostics
            };
        }
    }

    let cleanupFailure = null;
    for (let runtimeIndex = modeRuntimes.length - 1; runtimeIndex >= 0; runtimeIndex--) {
        try {
            await closeStartupModeRuntime(browserClient, modeRuntimes[runtimeIndex]);
        } catch (error) {
            cleanupFailure ??= error;
        }
    }
    if (comparisonFailure !== null) {
        browserClient.close();
        throw comparisonFailure;
    }
    if (cleanupFailure !== null) {
        browserClient.close();
        throw cleanupFailure;
    }
    browserClient.close();
    return comparisonResult;
}

async function collectPostStopRetentionSnapshot(client, sessionNumber, workerTargetScope) {
    await sleep(RETENTION_SETTLE_MILLISECONDS);
    await client.send('HeapProfiler.collectGarbage');
    return collectCDPRetentionSnapshot(client, sessionNumber, {
        forceGarbageCollection: true,
        queryWorkerTargets: () => client.send('Target.getTargets'),
        workerTargetScope
    });
}

async function drainPostRetentionBrowserEvents(client) {
    await client.send('HeapProfiler.collectGarbage');
    await evaluateValue(
        client,
        `new Promise(resolve => setTimeout(resolve, ${RETENTION_FINALIZER_DRAIN_MILLISECONDS}))`
    );
    // Let console/log protocol notifications cross the CDP socket before counts are copied
    await sleep(RETENTION_FINALIZER_DRAIN_MILLISECONDS);
}

function summarizeSoakPlaybackSnapshot(snapshot) {
    return {
        audioPath: snapshot.customPlayback?.audioPath ?? null,
        currentTimeMicroseconds: snapshot.customPlayback?.currentTimeMicroseconds ?? null,
        decoderBackend: snapshot.customPlaybackEligibility?.videoDecoderBackend ?? null,
        outputMode: snapshot.customPlaybackEligibility?.videoOutputMode ?? null,
        presentedFrameCount: snapshot.presentation?.presentedFrameCount ?? null,
        receivedFrameCount: snapshot.customPlayback?.videoDecode?.receivedFrameCount ?? null,
        sessionGeneration: snapshot.sessionGeneration ?? null
    };
}

function summarizeSoakStopSnapshot(snapshot) {
    return {
        canvasCount: snapshot.dom?.canvasCount ?? null,
        customPlaybackState: snapshot.customPlayback?.state ?? null,
        hasCurrentSource: snapshot.hasCurrentSource ?? null,
        presenterState: snapshot.presentation?.state ?? null,
        stoppedEventCount: snapshot.stoppedEventCount ?? null
    };
}

function createRequiredRetentionSeries(sessionObservations, readValue, failureCode, failures) {
    const observations = [];
    for (const sessionObservation of sessionObservations) {
        const value = readValue(sessionObservation.retention);
        if (!Number.isSafeInteger(value) || value < 0) {
            failures.push(failureCode);
            return null;
        }
        observations.push({
            session: sessionObservation.sessionNumber,
            value
        });
    }
    return observations;
}

function collectLiveObjectObservations(sessionObservations, liveObjectName) {
    const observations = [];
    for (const sessionObservation of sessionObservations) {
        const liveObject = sessionObservation.retention.liveObjects[liveObjectName];
        if (liveObject?.available !== true) {
            continue;
        }
        if (!Number.isSafeInteger(liveObject.count) || liveObject.count < 0) {
            return { invalid: true, observations };
        }
        observations.push({
            session: sessionObservation.sessionNumber,
            value: liveObject.count
        });
    }
    return { invalid: false, observations };
}

function createAvailableLiveObjectSeries(sessionObservations, failures) {
    const liveObjectCounts = {};
    const firstLiveObjects = sessionObservations[0]?.retention?.liveObjects ?? {};
    for (const liveObjectName of Object.keys(firstLiveObjects)) {
        const result = collectLiveObjectObservations(sessionObservations, liveObjectName);
        if (result.invalid) {
            failures.push('retention:live-object-count-invalid');
            continue;
        }
        if (result.observations.length === 0) {
            continue;
        }
        if (result.observations.length !== sessionObservations.length) {
            failures.push('retention:live-object-availability-changed');
            continue;
        }
        liveObjectCounts[liveObjectName] = result.observations;
    }
    return liveObjectCounts;
}

function createAvailablePerformanceObjectSeries(sessionObservations, failures) {
    const performanceObjectCounts = {};
    for (const metric of RETENTION_PERFORMANCE_RESOURCE_METRICS) {
        const observations = [];
        let availableCount = 0;
        let invalid = false;
        for (const sessionObservation of sessionObservations) {
            const value = sessionObservation.retention.performanceMetrics.counts[metric.name];
            if (value === undefined) {
                continue;
            }
            availableCount += 1;
            if (!Number.isSafeInteger(value) || value < 0) {
                invalid = true;
                break;
            }
            observations.push({
                session: sessionObservation.sessionNumber,
                value
            });
        }
        if (invalid) {
            failures.push(`retention:performance-count-${metric.code}-invalid`);
            continue;
        }
        if (availableCount === 0) {
            continue;
        }
        if (availableCount !== sessionObservations.length) {
            failures.push(
                `retention:performance-count-${metric.code}-availability-changed`
            );
            continue;
        }
        performanceObjectCounts[metric.name] = observations;
    }
    return performanceObjectCounts;
}

function validateRetentionSoakObservations(
    sessionObservations,
    requiredSessionCount,
    expectedAudioContextCount,
    expectedAudioWorkletNodeCount,
    expectedAudioWorkletProcessorCount
) {
    const failures = [];
    const memorySeries = {
        backingStorageBytes: createRequiredRetentionSeries(
            sessionObservations,
            retention => retention.heapUsage.backingStorageSizeBytes,
            'retention:backing-storage-unavailable',
            failures
        ),
        embedderHeapBytes: createRequiredRetentionSeries(
            sessionObservations,
            retention => retention.heapUsage.embedderHeapUsedSizeBytes,
            'retention:embedder-heap-unavailable',
            failures
        ),
        jsUsedHeapBytes: createRequiredRetentionSeries(
            sessionObservations,
            retention => retention.heapUsage.usedSizeBytes,
            'retention:js-used-heap-unavailable',
            failures
        )
    };
    let memoryValidation = null;
    if (Object.values(memorySeries).every(series => series !== null)) {
        memoryValidation = validateReleaseMemorySoakSeries(memorySeries, {
            requiredSessionCount
        });
        appendFailures(failures, 'retention-memory', memoryValidation.failures);
    }

    const DOMSeries = {
        documentCount: createRequiredRetentionSeries(
            sessionObservations,
            retention => retention.DOMCounters.documents,
            'retention:document-count-unavailable',
            failures
        ),
        listenerCount: createRequiredRetentionSeries(
            sessionObservations,
            retention => retention.DOMCounters.eventListeners,
            'retention:listener-count-unavailable',
            failures
        ),
        liveObjectCounts: createAvailableLiveObjectSeries(sessionObservations, failures),
        nodeCount: createRequiredRetentionSeries(
            sessionObservations,
            retention => retention.DOMCounters.nodes,
            'retention:node-count-unavailable',
            failures
        ),
        performanceObjectCounts: createAvailablePerformanceObjectSeries(
            sessionObservations,
            failures
        ),
        workerCount: createRequiredRetentionSeries(
            sessionObservations,
            retention => retention.workerTargets.customDecodeWorkerTargetCount,
            'retention:worker-count-unavailable',
            failures
        )
    };
    let DOMValidation = null;
    const requiredDOMSeries = [
        DOMSeries.documentCount,
        DOMSeries.listenerCount,
        DOMSeries.nodeCount,
        DOMSeries.workerCount
    ];
    if (requiredDOMSeries.every(series => series !== null)) {
        DOMValidation = validateDOMAndObjectCountSeries(DOMSeries, {
            expectedAudioContextCount: expectedAudioContextCount ?? undefined,
            expectedAudioWorkletNodeCount: expectedAudioWorkletNodeCount ?? undefined,
            expectedAudioWorkletProcessorCount:
                expectedAudioWorkletProcessorCount ?? undefined,
            requiredSessionCount
        });
        appendFailures(failures, 'retention-dom', DOMValidation.failures);
    }
    return {
        failures,
        metrics: {
            DOM: DOMValidation?.metrics ?? null,
            memory: memoryValidation?.metrics ?? null
        }
    };
}

async function runRetentionSoak(options) {
    const failures = [];
    const sessionObservations = [];
    let latestSessionGeneration = null;
    let latestStopSnapshot = null;
    const prePlaybackRetentionSnapshot = await collectPostStopRetentionSnapshot(
        options.client,
        0,
        options.workerTargetScope
    );
    const baselineCustomWorkerCount =
        prePlaybackRetentionSnapshot.workerTargets.customDecodeWorkerTargetCount;
    if (baselineCustomWorkerCount === null) {
        failures.push('retention-baseline:worker-target-count-unavailable');
    } else if (baselineCustomWorkerCount !== 0) {
        failures.push('retention-baseline:custom-decode-worker-active');
    }
    const {
        expectedAudioContextCount,
        expectedAudioWorkletNodeCount,
        expectedAudioWorkletProcessorCount
    } = getExpectedRetentionAudioObjectCounts(
        options.configuration.expectedAudioPath
    );
    for (
        let sessionNumber = 1;
        sessionNumber <= options.configuration.soakSessionCount;
        sessionNumber += 1
    ) {
        const playButton = sessionNumber === 1 ?
            options.initialPlayButton :
            await waitForVisibleElement(
                options.client,
                PLAY_BUTTON_SELECTORS,
                options.configuration,
                `the retention soak session ${sessionNumber} play button`
            );
        await trustedClick(options.client, playButton);
        const hookStateAvailable = await evaluateValue(
            options.client,
            `typeof window[${JSON.stringify(options.accessKey)}] === 'function'`
        );
        if (!hookStateAvailable) {
            throw new SmokeHarnessError(
                'events-hook-state-lost',
                `The player event hook state was lost while starting soak session ${sessionNumber}`
            );
        }
        options.cleanupState.required = true;
        const activeInitial = await waitForPlayerSnapshot({
            accept: snapshot => isExpectedCustomPlaybackActive(
                snapshot,
                options.configuration,
                latestSessionGeneration
            ),
            accessKey: options.accessKey,
            client: options.client,
            description: `active retention soak session ${sessionNumber}`,
            errorCode: 'soak-session-timeout',
            timeoutMilliseconds: options.configuration.timeoutMilliseconds
        });
        await sleep(PLAYBACK_OBSERVATION_MILLISECONDS);
        const activeLater = await getPlayerSnapshot(options.client, options.accessKey);
        const playbackDecision = await collectPlaybackDecisionEvidence(
            options.client,
            options.accessKey,
            options.configuration
        );
        appendFailures(
            failures,
            `soak-${sessionNumber}-playback`,
            validateActivePlaybackSnapshot(
                activeInitial,
                activeLater,
                createActivePlaybackExpectations(options.configuration)
            )
        );
        appendFailures(
            failures,
            `soak-${sessionNumber}-playback-decision`,
            validatePlaybackDecisionEvidence(
                playbackDecision,
                options.configuration.expectedPlayMethod
            )
        );

        const stopStartedAtNanoseconds = process.hrtime.bigint();
        const stopSnapshot = await stopCapturedPlayback(
            options.client,
            options.accessKey,
            options.configuration,
            sessionNumber,
            `retention soak session ${sessionNumber}`,
            'soak-stop-failed'
        );
        const stopDurationMicroseconds = Number(
            (process.hrtime.bigint() - stopStartedAtNanoseconds) / 1_000n
        );
        options.cleanupState.required = false;
        appendFailures(
            failures,
            `soak-${sessionNumber}-stop`,
            validateStopSnapshot(stopSnapshot, sessionNumber)
        );
        if (stopDurationMicroseconds > MAXIMUM_CLEAN_STOP_DURATION_MICROSECONDS) {
            failures.push(`soak-${sessionNumber}:stop-acknowledgement-timeout`);
        }

        const retentionSnapshot = await collectPostStopRetentionSnapshot(
            options.client,
            sessionNumber,
            options.workerTargetScope
        );
        const customWorkerCount =
            retentionSnapshot.workerTargets.customDecodeWorkerTargetCount;
        if (customWorkerCount === null) {
            failures.push(`soak-${sessionNumber}:worker-target-count-unavailable`);
        } else if (customWorkerCount !== 0) {
            failures.push(`soak-${sessionNumber}:custom-decode-worker-retained`);
        }

        sessionObservations.push({
            playback: summarizeSoakPlaybackSnapshot(activeLater),
            playbackDecision,
            retention: retentionSnapshot,
            sessionNumber,
            stop: summarizeSoakStopSnapshot(stopSnapshot),
            stopDurationMicroseconds
        });
        latestSessionGeneration = activeLater.sessionGeneration;
        latestStopSnapshot = stopSnapshot;
    }

    await drainPostRetentionBrowserEvents(options.client);

    const retentionValidation = validateRetentionSoakObservations(
        sessionObservations,
        options.configuration.soakSessionCount,
        expectedAudioContextCount,
        expectedAudioWorkletNodeCount,
        expectedAudioWorkletProcessorCount
    );
    failures.push(...retentionValidation.failures);
    if (options.browserErrorMonitor.counts.videoSampleOwnershipWarnings > 0) {
        failures.push('retention:videosample-ownership-warning');
    }
    appendBrowserErrorFailures(failures, options.browserErrorMonitor.counts);
    return {
        diagnostics: {
            browserErrors: { ...options.browserErrorMonitor.counts },
            browserMessages: [ ...options.browserErrorMonitor.messages ],
            eventCounts: latestStopSnapshot.eventCounts
        },
        failures,
        observations: {
            retentionSoak: {
                baseline: prePlaybackRetentionSnapshot,
                metrics: retentionValidation.metrics,
                sessionCount: sessionObservations.length,
                sessions: sessionObservations
            },
            stop: summarizeSoakStopSnapshot(latestStopSnapshot)
        }
    };
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
        validateActivePlaybackSnapshot(
            options.activeInitial,
            options.activeLater,
            createActivePlaybackExpectations(options.configuration)
        )
    );
    appendFailures(
        failures,
        'playback-decision',
        validatePlaybackDecisionEvidence(
            options.playbackDecision,
            options.configuration.expectedPlayMethod
        )
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
            playbackDecision: options.playbackDecision,
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
        const playbackDecision = await collectPlaybackDecisionEvidence(
            options.client,
            options.accessKey,
            options.configuration
        );
        appendFailures(
            options.failures,
            `repeat-${sessionNumber}`,
            validateActivePlaybackSnapshot(
                initialSnapshot,
                laterSnapshot,
                createActivePlaybackExpectations(options.configuration)
            )
        );
        appendFailures(
            options.failures,
            `repeat-${sessionNumber}-playback-decision`,
            validatePlaybackDecisionEvidence(
                playbackDecision,
                options.configuration.expectedPlayMethod
            )
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
            playbackDecision,
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
            && (snapshot.customPlaybackEligibility?.hdr !== true
                || hasAuthorizedHDRPlaybackRoute(snapshot)),
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

async function runPlaybackExercise(
    client,
    configuration,
    browserErrorMonitor,
    workerTargetScope
) {
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
        const hookStateInstalled = await evaluateValue(
            client,
            `typeof window[${JSON.stringify(accessKey)}] === 'function'`
        );
        if (!hookStateInstalled) {
            throw new SmokeHarnessError(
                'events-hook-state-missing',
                'The player event hook state was unavailable immediately after installation'
            );
        }

        browserErrorMonitor.reset();
        if (configuration.soakSessionCount > 0) {
            // Await here so the finally block keeps the capture hook for the complete soak
            const retentionSoakResult = await runRetentionSoak({
                accessKey,
                browserErrorMonitor,
                cleanupState,
                client,
                configuration,
                initialPlayButton: playButton,
                workerTargetScope
            });
            return retentionSoakResult;
        }
        await trustedClick(client, playButton);
        cleanupState.required = true;
        const activeInitial = await waitForPlayerSnapshot({
            accept: snapshot => isExpectedCustomPlaybackActive(snapshot, configuration),
            accessKey,
            client,
            description: 'active custom-decoded WebGPU playback',
            errorCode: 'custom-playback-timeout',
            timeoutMilliseconds: configuration.timeoutMilliseconds
        }).catch(async error => {
            await attachPlaybackDecisionFailureDiagnostics(
                error,
                client,
                accessKey,
                configuration
            );
            throw error;
        });
        const initialFrameEvidence = await captureExpectedPresentedFrameEvidence(
            client,
            configuration.expectedFrameEvidence
        );
        await sleep(PLAYBACK_OBSERVATION_MILLISECONDS);
        const activeLater = await getPlayerSnapshot(client, accessKey);
        const playbackDecision = await collectPlaybackDecisionEvidence(
            client,
            accessKey,
            configuration
        );
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
                laterFrameEvidence,
                playbackDecision
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
        const resumeLater = await waitForPlayerSnapshot({
            accept: snapshot => snapshot?.customPlayback?.state === 'playing'
                && snapshot.customPlayback.currentTimeMicroseconds
                    - resumeInitial.customPlayback.currentTimeMicroseconds
                    >= MINIMUM_RESUME_CLOCK_ADVANCE_MICROSECONDS
                && snapshot.presentation?.presentedFrameCount
                    > resumeInitial.presentation?.presentedFrameCount,
            accessKey,
            client,
            description: 'advancing custom playback after resume',
            errorCode: 'resume-progress-timeout',
            timeoutMilliseconds: configuration.timeoutMilliseconds
        });

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
            validateActivePlaybackSnapshot(
                activeInitial,
                activeLater,
                createActivePlaybackExpectations(configuration)
            )
        );
        appendFailures(
            failures,
            'playback-decision',
            validatePlaybackDecisionEvidence(
                playbackDecision,
                configuration.expectedPlayMethod
            )
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
                    configuration.expectedAudioCodec,
                    configuration.expectedAudioPath,
                    configuration.expectedAudioConfiguration
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
                playbackDecision,
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
                    `(() => {
                        const result = window[${JSON.stringify(restoreKey)}]?.();
                        delete window[${JSON.stringify(accessKey)}];
                        delete window[${JSON.stringify(restoreKey)}];
                        return result;
                    })()`
                );
            } catch {
                // The page may have navigated or closed after the primary result
            }
        }
    }
}

async function runConfiguredPlayback(
    client,
    configuration,
    browserErrorMonitor,
    workerTargetScope
) {
    let configuredServerLogCapture = null;
    const beginConfiguredCapture = async () => {
        configuredServerLogCapture = await beginConfiguredServerLogCapture(
            client,
            configuration
        );
    };
    if (configuration.startupSampleCount > 0) {
        return {
            playbackResult: await runStartupComparison(
                configuration,
                beginConfiguredCapture
            ),
            serverLogCapture: configuredServerLogCapture
        };
    }
    await beginConfiguredCapture();
    return {
        playbackResult: await runPlaybackExercise(
            client,
            configuration,
            browserErrorMonitor,
            workerTargetScope
        ),
        serverLogCapture: configuredServerLogCapture
    };
}

async function runSmoke(configuration) {
    const pageTarget = await getBrowserPageTarget(configuration);
    const client = await RawCDPClient.connect(
        pageTarget.webSocketDebuggerUrl,
        configuration.timeoutMilliseconds
    );
    let configurationInterceptor = null;
    try {
        await Promise.all([
            client.send('Log.enable'),
            client.send('Network.enable'),
            client.send('Page.enable'),
            client.send('Performance.enable'),
            client.send('Runtime.enable')
        ]);
        await Promise.all([
            client.send('Network.setBypassServiceWorker', { bypass: true }),
            client.send('Network.setCacheDisabled', { cacheDisabled: true })
        ]);
        await client.send('Network.clearBrowserCache');
        const workerTargetScope = await getRetentionWorkerTargetScope(
            client,
            pageTarget,
            configuration
        );
        await ensureBrowserPageVisible(client, pageTarget, configuration);
        await clearFrontendRuntimeCaches(client);
        if (configuration.startupSampleCount === 0) {
            configurationInterceptor = await createStartupConfigurationInterceptor(
                client,
                configuration
            );
            configurationInterceptor.setMode('custom');
        }
        await reloadFreshFrontend(client, configuration);
        configurationInterceptor?.requireHealthy();
        await ensureBrowserPageVisible(client, pageTarget, configuration);
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
        let configuredPlayback;
        try {
            configuredPlayback = await runConfiguredPlayback(
                client,
                configuration,
                browserErrorMonitor,
                workerTargetScope
            );
        } catch (error) {
            attachBrowserDiagnostics(error, browserErrorMonitor);
            throw error;
        }
        const playbackResult = configuredPlayback.playbackResult;
        const serverLogResult = await finishConfiguredServerLogCapture(
            configuredPlayback.serverLogCapture,
            configuration
        );
        if (serverLogResult !== null) {
            appendFailures(
                playbackResult.failures,
                'server-log',
                serverLogResult.failures
            );
            playbackResult.observations.serverLog = serverLogResult.evidence;
        }
        const runtimeEnvironment = await collectRuntimeEnvironmentEvidence(
            client,
            browserVersion,
            configuration
        );
        return {
            browser: runtimeEnvironment.browser,
            diagnostics: playbackResult.diagnostics,
            expectations: {
                audioStreamIndex: configuration.audioStreamIndex,
                completionMode: configuration.completionMode,
                expectedAudioCodec: configuration.expectedAudioCodec,
                expectedAudioConfiguration: configuration.expectedAudioConfiguration,
                audioPath: configuration.expectedAudioPath,
                failureInjection: configuration.failureInjection,
                playMethod: configuration.expectedPlayMethod,
                presentationRoute: configuration.expectedPresentationRoute,
                staticHDRMetadataStatus: configuration.expectedStaticHDRMetadataStatus,
                staticHDRPeakNits: configuration.expectedStaticHDRPeakNits,
                repeatSessionCount: configuration.repeatSessionCount,
                seekStormCount: configuration.seekStormCount,
                serverLogEvidence: configuration.serverLogDirectory !== null,
                soakSessionCount: configuration.soakSessionCount,
                startupSampleCount: configuration.startupSampleCount,
                videoDecoderBackend: configuration.expectedVideoDecoderBackend,
                videoOutputMode: configuration.expectedVideoOutputMode
            },
            failures: playbackResult.failures,
            featureFlags: runtimeEnvironment.featureFlags,
            gpu: runtimeEnvironment.gpu,
            loginPerformed,
            observations: playbackResult.observations,
            schemaVersion: 1,
            server: runtimeEnvironment.server,
            status: playbackResult.failures.length === 0 ? 'passed' : 'failed'
        };
    } finally {
        try {
            await configurationInterceptor?.close();
        } finally {
            client.close();
        }
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

export {
    clearFrontendRuntimeCaches,
    collectPlaybackDecisionEvidence,
    connectToConfiguredServer,
    createBrowserErrorMonitor,
    createPlaybackDecisionExpression,
    createPlayerCaptureHookExpression,
    createPlayerOperationExpression,
    createPlayerSnapshotExpression,
    createStartupConfigurationInterceptor,
    ensureBrowserPageVisible,
    evaluateValue,
    getBrowserPageTarget,
    getPlayerSnapshot,
    hasMatchingAuthenticatedServer,
    navigate,
    PLAY_BUTTON_SELECTORS,
    RawCDPClient,
    reloadFreshFrontend,
    signInIfRequired,
    sleep,
    trustedClick,
    waitForPlayerSnapshot,
    waitForValue,
    waitForVisibleElement
};

export async function runSmokeCLI(
    commandArguments = process.argv.slice(2),
    environment = process.env
) {
    let configuration;
    try {
        configuration = parseSmokeConfiguration(commandArguments, environment);
        if (configuration.help === true) {
            process.stdout.write(`${SMOKE_USAGE}\n`);
            return;
        }

        const report = await runSmoke(configuration);
        const sanitizedReport = sanitizeReport(report, [
            configuration.debugURL,
            configuration.frontendURL,
            configuration.itemID,
            configuration.password,
            configuration.serverLogDirectory,
            configuration.serverURL,
            configuration.username
        ]);
        process.stdout.write(`${JSON.stringify(sanitizedReport, null, 2)}\n`);
        if (report.status !== 'passed') {
            process.exitCode = 1;
        }
    } catch (error) {
        const secrets = configuration?.help === true || !configuration ? [] : [
            configuration.debugURL,
            configuration.frontendURL,
            configuration.itemID,
            configuration.password,
            configuration.serverLogDirectory,
            configuration.serverURL,
            configuration.username
        ];
        const sanitizedReport = sanitizeReport(createFailureReport(error), secrets);
        process.stdout.write(`${JSON.stringify(sanitizedReport, null, 2)}\n`);
        process.exitCode = 1;
    }
}

const invokedModuleURL = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedModuleURL === import.meta.url) {
    await runSmokeCLI();
}

/* eslint-enable compat/compat */
