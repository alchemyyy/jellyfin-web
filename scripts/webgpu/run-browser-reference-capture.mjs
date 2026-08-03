/* eslint-disable compat/compat -- This local harness targets Node 24 and current Chromium */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
    createFrameBoundarySeekMilliseconds,
    isExpectedAudioStreamReady,
    parseReferenceCaptureConfiguration,
    REFERENCE_CAPTURE_USAGE,
    summarizeAudioSignal,
    summarizePacingSamples,
    validateReferenceCapturePlan
} from './browser-reference-capture-helpers.mjs';
import {
    createFrontendRouteURL,
    sanitizeReport
} from './browser-smoke-helpers.mjs';
import {
    clearFrontendRuntimeCaches,
    connectToConfiguredServer,
    createBrowserErrorMonitor,
    createPlayerCaptureHookExpression,
    createPlayerOperationExpression,
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
} from './run-browser-playback-smoke.mjs';

const PLAYBACK_SETTLE_MILLISECONDS = 400;
const CAPTURE_STYLE_ATTRIBUTE = 'data-webgpu-reference-capture-style';
const CAPTURE_PROGRESS_FILENAME = 'browser-progress.json';

async function writeCaptureProgress(configuration, progress) {
    const progressPath = path.join(
        configuration.outputDirectory,
        CAPTURE_PROGRESS_FILENAME
    );
    await writeFile(progressPath, `${JSON.stringify({
        ...progress,
        schemaVersion: 1,
        updatedAt: new Date().toISOString()
    }, null, 2)}\n`);
}

function createActivePlaybackPredicate(plan) {
    return snapshot => snapshot?.customPlayback?.state === 'playing'
        && snapshot.customPlaybackEligibility?.eligible === true
        && snapshot.customPlaybackEligibility.videoDecoderBackend
            === plan.jellyfin.expected.videoDecoder
        && snapshot.customPlaybackEligibility.videoOutputMode
            === plan.jellyfin.expected.videoOutput
        && snapshot.presentation?.state === 'presenting'
        && (snapshot.presentation.presentedFrameCount ?? 0) > 0;
}

async function installCaptureStyle(client) {
    return evaluateValue(client, `(() => {
        document.querySelector(
            'style[${CAPTURE_STYLE_ATTRIBUTE}]'
        )?.remove();
        const style = document.createElement('style');
        style.setAttribute('${CAPTURE_STYLE_ATTRIBUTE}', 'true');
        style.textContent = [
            '.webgpuVideoPlayerCanvas {',
            '  z-index: 2147483647 !important;',
            '  background: #000 !important;',
            '}',
            'html { cursor: none !important; }'
        ].join('\\n');
        document.head.append(style);
        return true;
    })()`);
}

async function removeCaptureStyle(client) {
    return evaluateValue(client, `(() => {
        document.querySelector(
            'style[${CAPTURE_STYLE_ATTRIBUTE}]'
        )?.remove();
        return true;
    })()`);
}

async function captureCanvasRectangle(client) {
    return evaluateValue(client, `(() => {
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
        if (right <= x || bottom <= y) {
            return null;
        }
        return {
            height: bottom - y,
            width: right - x,
            x,
            y
        };
    })()`);
}

async function writeCanvasScreenshot(client, destination) {
    const captureRectangle = await captureCanvasRectangle(client);
    if (!captureRectangle) {
        throw new Error('The WebGPU presentation canvas has no visible capture rectangle');
    }
    const screenshot = await client.send('Page.captureScreenshot', {
        captureBeyondViewport: false,
        clip: {
            ...captureRectangle,
            scale: 1
        },
        format: 'png',
        fromSurface: true
    });
    if (typeof screenshot?.data !== 'string' || screenshot.data.length === 0) {
        throw new Error('Chromium returned no PNG data for the WebGPU canvas');
    }
    await writeFile(destination, Buffer.from(screenshot.data, 'base64'));
    return captureRectangle;
}

function createPacingCaptureExpression(accessKey, durationMilliseconds) {
    return `(async () => {
        const readCapture = window[${JSON.stringify(accessKey)}];
        if (typeof readCapture !== 'function') {
            return null;
        }
        const samples = [];
        const startedAtMilliseconds = performance.now();
        let lastPresentedFrameCount = -1;
        let lastHeartbeatMilliseconds = startedAtMilliseconds;
        return new Promise(resolve => {
            const captureSample = wallTimeMilliseconds => {
                const player = readCapture()?.player;
                const custom = player?.getCustomPlaybackTelemetry?.();
                const presentation = player?.getPresentationTelemetry?.();
                if (!player || !custom || !presentation) {
                    resolve(null);
                    return;
                }
                const frameChanged = presentation.presentedFrameCount
                    !== lastPresentedFrameCount;
                const heartbeatDue = wallTimeMilliseconds - lastHeartbeatMilliseconds >= 1000;
                if (frameChanged || heartbeatDue || samples.length === 0) {
                    samples.push({
                        audioMediaTimeMicroseconds:
                            custom.audioOutput?.mediaTimeMicroseconds ?? null,
                        currentTimeMicroseconds: custom.currentTimeMicroseconds,
                        decodeDroppedFrameCount: custom.videoDecode?.droppedFrameCount ?? null,
                        decodeQueuedFrameCount: custom.videoDecode?.queuedFrameCount ?? null,
                        expectedDisplayTimeMicroseconds:
                            presentation.lastExpectedDisplayTimeMicroseconds,
                        presentedFrameCount: presentation.presentedFrameCount,
                        presentedMediaTimeMicroseconds:
                            presentation.lastPresentedMediaTimeMicroseconds,
                        wallTimeMilliseconds
                    });
                    lastPresentedFrameCount = presentation.presentedFrameCount;
                    if (heartbeatDue) {
                        lastHeartbeatMilliseconds = wallTimeMilliseconds;
                    }
                }
                if (wallTimeMilliseconds - startedAtMilliseconds
                    >= ${durationMilliseconds}) {
                    resolve(samples);
                    return;
                }
                requestAnimationFrame(captureSample);
            };
            requestAnimationFrame(captureSample);
        });
    })()`;
}

async function pauseCapturedPlayer(client, accessKey, configuration) {
    const pauseResult = await evaluateValue(
        client,
        createPlayerOperationExpression(accessKey, 'player.pause();')
    );
    if (!pauseResult) {
        throw new Error('Unable to pause the captured WebGPU player');
    }
    return waitForPlayerSnapshot({
        accept: snapshot => snapshot?.customPlayback?.state === 'paused',
        accessKey,
        client,
        description: 'the paused WebGPU reference state',
        errorCode: 'reference-pause-timeout',
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
}

async function resumeCapturedPlayer(client, accessKey, configuration) {
    const resumeResult = await evaluateValue(
        client,
        createPlayerOperationExpression(accessKey, 'player.resume();')
    );
    if (!resumeResult) {
        throw new Error('Unable to resume the captured WebGPU player');
    }
    return waitForPlayerSnapshot({
        accept: snapshot => snapshot?.customPlayback?.state === 'playing',
        accessKey,
        client,
        description: 'the resumed WebGPU reference state',
        errorCode: 'reference-resume-timeout',
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
}

async function seekPausedPlayer(
    client,
    accessKey,
    configuration,
    targetMicroseconds,
    toleranceMicroseconds
) {
    const targetMilliseconds = createFrameBoundarySeekMilliseconds(targetMicroseconds);
    const seekResult = await evaluateValue(
        client,
        createPlayerOperationExpression(
            accessKey,
            `player.currentTime(${targetMilliseconds});`
        )
    );
    if (!seekResult) {
        throw new Error(`Unable to seek to ${targetMicroseconds} microseconds`);
    }
    return waitForPlayerSnapshot({
        accept: snapshot => snapshot?.customPlayback?.state === 'paused'
            && snapshot.presentation?.state === 'presenting'
            && Number.isSafeInteger(
                snapshot.presentation.lastPresentedMediaTimeMicroseconds
            )
            && Math.abs(
                snapshot.presentation.lastPresentedMediaTimeMicroseconds
                    - targetMicroseconds
            ) <= toleranceMicroseconds,
        accessKey,
        client,
        description: `the paused frame near ${targetMicroseconds} microseconds`,
        errorCode: 'reference-seek-timeout',
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
}

async function selectAudioStream(client, accessKey, configuration, plan, snapshot) {
    const targetIndex = plan.jellyfin.audioStreamIndex;
    if (snapshot.customPlayback?.jellyfinAudioStreamIndex === targetIndex) {
        return waitForPlayerSnapshot({
            accept: candidate => isExpectedAudioStreamReady(candidate, plan),
            accessKey,
            client,
            description: `Jellyfin audio stream ${targetIndex} initialization`,
            errorCode: 'reference-audio-initialization-timeout',
            timeoutMilliseconds: configuration.timeoutMilliseconds
        });
    }

    const previousGeneration = snapshot.customPlayback?.activeGeneration;
    const switchResult = await evaluateValue(
        client,
        createPlayerOperationExpression(
            accessKey,
            `player.setAudioStreamIndex(${targetIndex});`
        )
    );
    if (!switchResult) {
        throw new Error(`Unable to select Jellyfin audio stream ${targetIndex}`);
    }
    return waitForPlayerSnapshot({
        accept: candidate => isExpectedAudioStreamReady(candidate, plan)
            && (!Number.isSafeInteger(previousGeneration)
                || !Number.isSafeInteger(candidate.customPlayback?.activeGeneration)
                || candidate.customPlayback.activeGeneration > previousGeneration),
        accessKey,
        client,
        description: `Jellyfin audio stream ${targetIndex}`,
        errorCode: 'reference-audio-switch-timeout',
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
}

async function startCapturedPlayback(client, configuration, plan, accessKey, restoreKey) {
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
        `/details?id=${encodeURIComponent(plan.jellyfin.itemID)}`
            + `&serverId=${encodeURIComponent(serverID)}`
    );
    await navigate(client, detailsURL, configuration);
    const playButton = await waitForVisibleElement(
        client,
        PLAY_BUTTON_SELECTORS,
        configuration,
        'the item play button'
    );
    const hookInstalled = await evaluateValue(
        client,
        createPlayerCaptureHookExpression(accessKey, restoreKey)
    );
    if (!hookInstalled) {
        throw new Error('Unable to install the WebGPU player capture hook');
    }
    await trustedClick(client, playButton);
    return waitForPlayerSnapshot({
        accept: createActivePlaybackPredicate(plan),
        accessKey,
        client,
        description: 'active WebGPU A/B playback',
        errorCode: 'reference-playback-timeout',
        timeoutMilliseconds: configuration.timeoutMilliseconds
    });
}

async function capturePacingSegment(client, accessKey, configuration, plan) {
    await pauseCapturedPlayer(client, accessKey, configuration);
    const beforeSnapshot = await seekPausedPlayer(
        client,
        accessKey,
        configuration,
        plan.pacing.startTimeMicroseconds,
        plan.visual.captureToleranceMicroseconds
    );
    await resumeCapturedPlayer(client, accessKey, configuration);
    const samples = await evaluateValue(
        client,
        createPacingCaptureExpression(accessKey, plan.pacing.durationMilliseconds)
    );
    if (!Array.isArray(samples) || samples.length < 2) {
        throw new Error('The browser returned insufficient frame-pacing samples');
    }
    await pauseCapturedPlayer(client, accessKey, configuration);
    const afterSnapshot = await getPlayerSnapshot(client, accessKey);
    return {
        afterSnapshot,
        audioSignal: summarizeAudioSignal(afterSnapshot.customPlayback?.audioOutput?.signal),
        beforeSnapshot,
        samples,
        summary: summarizePacingSamples(samples)
    };
}

async function captureVisualCheckpoints(
    client,
    accessKey,
    configuration,
    plan,
    outputDirectory
) {
    const captures = [];
    for (const timestampMicroseconds of plan.visual.timestampsMicroseconds) {
        const snapshot = await seekPausedPlayer(
            client,
            accessKey,
            configuration,
            timestampMicroseconds,
            plan.visual.captureToleranceMicroseconds
        );
        await sleep(PLAYBACK_SETTLE_MILLISECONDS);
        const filename = `${plan.caseID}-webgpu-${timestampMicroseconds}.png`;
        const destination = path.join(outputDirectory, filename);
        const rectangle = await writeCanvasScreenshot(client, destination);
        captures.push({
            actualMediaTimeMicroseconds:
                snapshot.presentation.lastPresentedMediaTimeMicroseconds,
            filename,
            rectangle,
            requestedMediaTimeMicroseconds: timestampMicroseconds,
            snapshot
        });
    }
    return captures;
}

async function runReferenceCapture(configuration, plan, progress) {
    await mkdir(configuration.outputDirectory, { recursive: true });
    progress.phase = 'locating-browser-page';
    await writeCaptureProgress(configuration, progress);
    const pageTarget = await getBrowserPageTarget(configuration);
    const client = await RawCDPClient.connect(
        pageTarget.webSocketDebuggerUrl,
        configuration.timeoutMilliseconds
    );
    const accessKey = `webgpu-reference-access-${crypto.randomUUID()}`;
    const restoreKey = `webgpu-reference-restore-${crypto.randomUUID()}`;
    progress.accessKey = accessKey;
    progress.restoreKey = restoreKey;
    let configurationInterceptor = null;
    let metricsOverrideActive = false;
    try {
        progress.phase = 'initializing-browser';
        await writeCaptureProgress(configuration, progress);
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
        await client.send('Emulation.setDeviceMetricsOverride', {
            deviceScaleFactor: 1,
            height: plan.visual.height,
            mobile: false,
            screenHeight: plan.visual.height,
            screenWidth: plan.visual.width,
            width: plan.visual.width
        });
        metricsOverrideActive = true;
        progress.phase = 'loading-frontend';
        await writeCaptureProgress(configuration, progress);
        await ensureBrowserPageVisible(client, pageTarget, configuration);
        await clearFrontendRuntimeCaches(client);
        configurationInterceptor = await createStartupConfigurationInterceptor(
            client,
            configuration
        );
        configurationInterceptor.setMode('custom');
        await reloadFreshFrontend(client, configuration);
        configurationInterceptor.requireHealthy();
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
        browserErrorMonitor.reset();

        progress.phase = 'starting-playback';
        await writeCaptureProgress(configuration, progress);
        const activeSnapshot = await startCapturedPlayback(
            client,
            configuration,
            plan,
            accessKey,
            restoreKey
        );
        progress.phase = 'selecting-audio';
        await writeCaptureProgress(configuration, progress);
        const initialSnapshot = await selectAudioStream(
            client,
            accessKey,
            configuration,
            plan,
            activeSnapshot
        );
        progress.phase = 'configuring-playback';
        await writeCaptureProgress(configuration, progress);
        const volumeResult = await evaluateValue(
            client,
            createPlayerOperationExpression(
                accessKey,
                'player.setMute(false); player.setVolume(100);'
            )
        );
        if (!volumeResult) {
            throw new Error('Unable to set the controlled browser reference volume');
        }
        await installCaptureStyle(client);

        progress.phase = 'capturing-pacing';
        await writeCaptureProgress(configuration, progress);
        const pacing = await capturePacingSegment(
            client,
            accessKey,
            configuration,
            plan
        );
        progress.phase = 'capturing-visuals';
        await writeCaptureProgress(configuration, progress);
        const visualCaptures = await captureVisualCheckpoints(
            client,
            accessKey,
            configuration,
            plan,
            configuration.outputDirectory
        );
        const browserVersion = await client.send('Browser.getVersion');
        progress.phase = 'capture-complete';
        progress.status = 'captured';
        await writeCaptureProgress(configuration, progress);
        return {
            browser: {
                product: browserVersion.product ?? 'unknown',
                protocolVersion: browserVersion.protocolVersion ?? 'unknown'
            },
            caseID: plan.caseID,
            diagnostics: {
                browserErrors: { ...browserErrorMonitor.counts },
                browserMessages: [ ...browserErrorMonitor.messages ]
            },
            initialSnapshot,
            loginPerformed,
            pacing,
            schemaVersion: 1,
            status: 'captured',
            visualCaptures
        };
    } catch (error) {
        progress.status = 'failed';
        await writeCaptureProgress(configuration, progress);
        throw error;
    } finally {
        try {
            await evaluateValue(
                client,
                createPlayerOperationExpression(
                    accessKey,
                    'await Promise.resolve(player.stop(false));'
                )
            );
        } catch {
            // Preserve the primary failure while making a bounded cleanup attempt
        }
        try {
            await removeCaptureStyle(client);
        } catch {
            // The page may have closed after the primary result
        }
        try {
            await evaluateValue(client, `(() => {
                const result = window[${JSON.stringify(restoreKey)}]?.();
                delete window[${JSON.stringify(accessKey)}];
                delete window[${JSON.stringify(restoreKey)}];
                return result;
            })()`);
        } catch {
            // The page may have closed after the primary result
        }
        if (metricsOverrideActive) {
            try {
                await client.send('Emulation.clearDeviceMetricsOverride');
            } catch {
                // Preserve the primary failure while restoring browser metrics
            }
        }
        if (configurationInterceptor) {
            try {
                await configurationInterceptor.close();
            } catch {
                // Preserve the primary result while disabling request interception
            }
        }
        client.close();
    }
}

async function main() {
    let configuration;
    const progress = {
        phase: 'configuration',
        status: 'running'
    };
    try {
        configuration = parseReferenceCaptureConfiguration(
            process.argv.slice(2),
            process.env
        );
        if (configuration.help) {
            process.stdout.write(`${REFERENCE_CAPTURE_USAGE}\n`);
            return;
        }
        const planValue = JSON.parse(await readFile(configuration.planPath, 'utf8'));
        const plan = validateReferenceCapturePlan(planValue);
        const report = await runReferenceCapture(configuration, plan, progress);
        const sanitizedReport = sanitizeReport(report, [
            configuration.debugURL,
            configuration.frontendURL,
            configuration.password,
            configuration.serverURL,
            configuration.username
        ]);
        const reportPath = path.join(configuration.outputDirectory, 'browser-report.json');
        await writeFile(reportPath, `${JSON.stringify(sanitizedReport, null, 2)}\n`);
        process.stdout.write(`${JSON.stringify({
            reportPath,
            status: report.status,
            visualCaptureCount: report.visualCaptures.length
        }, null, 2)}\n`);
    } catch (error) {
        const failure = sanitizeReport({
            diagnostics: error && typeof error === 'object'
                && 'diagnostics' in error ? error.diagnostics : null,
            error: error instanceof Error ? error.message : 'Unknown browser capture failure',
            errorCode: error && typeof error === 'object'
                && 'code' in error ? error.code : null,
            phase: progress.phase,
            schemaVersion: 1,
            status: 'failed'
        }, configuration ? [
            configuration.debugURL,
            configuration.frontendURL,
            configuration.password,
            configuration.serverURL,
            configuration.username
        ] : []);
        if (configuration?.outputDirectory) {
            await mkdir(configuration.outputDirectory, { recursive: true });
            await writeFile(
                path.join(configuration.outputDirectory, 'browser-report.json'),
                `${JSON.stringify(failure, null, 2)}\n`
            );
        }
        process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`);
        process.exitCode = 1;
    }
}

await main();

/* eslint-enable compat/compat */
