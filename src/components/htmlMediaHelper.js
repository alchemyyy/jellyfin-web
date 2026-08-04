import appSettings from '../scripts/settings/appSettings' ;
import browser from '../scripts/browser';
import Events from '../utils/events.ts';
import { MediaError } from 'types/mediaError';
import { HLSAppendFailurePolicy } from './HLSAppendFailurePolicy';
import {
    HLSRecoveryPosition,
    HLS_SEEK_CORRELATION_TOLERANCE_SECONDS
} from './HLSRecoveryPosition';

export function getSavedVolume() {
    return appSettings.get('volume') || 1;
}

export function saveVolume(value) {
    if (value) {
        appSettings.set('volume', value);
    }
}

export function getCrossOriginValue(mediaSource) {
    if (mediaSource.IsRemote) {
        return null;
    }

    return 'anonymous';
}

function canPlayNativeHls() {
    const media = document.createElement('video');

    return !!(media.canPlayType('application/x-mpegURL').replace(/no/, '')
            || media.canPlayType('application/vnd.apple.mpegURL').replace(/no/, ''));
}

export function enableHlsJsPlayerForCodecs(mediaSource, mediaType) {
    // Workaround for VP9 HLS support on desktop Safari
    // Force using HLS.js because desktop Safari's native HLS player does not play VP9 over HLS
    // browser.osx will return true on iPad, cannot use
    if (!browser.iOS && browser.safari && mediaSource.MediaStreams.some(x => x.Codec === 'vp9')) {
        return true;
    }
    return enableHlsJsPlayer(mediaSource.RunTimeTicks, mediaType);
}

export function enableHlsJsPlayer(runTimeTicks, mediaType) {
    if (window.MediaSource == null) {
        return false;
    }

    // hls.js is only in beta. needs more testing.
    if (browser.iOS) {
        return false;
    }

    // The native players on these devices support seeking live streams, no need to use hls.js here
    if (browser.tizen || browser.web0s) {
        return false;
    }

    if (canPlayNativeHls()) {
        // Android Webview's native HLS has performance and compatiblity issues
        if (browser.android && (mediaType === 'Audio' || mediaType === 'Video')) {
            return true;
        }

        // Chromium 141+ brings native HLS support that does not support switching HDR/SDR playlists.
        // Always use hls.js to avoid falling back to transcoding from remuxing and client side tone-mapping.
        if (browser.chrome || browser.edgeChromium || browser.opera) {
            return true;
        }

        // simple playback should use the native support
        if (runTimeTicks) {
            return false;
        }
    }

    return true;
}

const hlsMediaRecoveryStates = new WeakMap();
const MAXIMUM_LOGGED_TIME_RANGES = 6;
const MILLISECONDS_PER_SECOND = 1000;
const HAVE_FUTURE_DATA_READY_STATE = 3;

function getHLSPlaybackObservation(element, playing) {
    const monotonicTimeMilliseconds = typeof performance !== 'undefined' ?
        performance.now() :
        Date.now();
    return {
        monotonicTimeSeconds: monotonicTimeMilliseconds / MILLISECONDS_PER_SECOND,
        playbackRate: Number.isFinite(element.playbackRate) ?
            Math.abs(element.playbackRate) :
            1,
        playing
    };
}

function getHLSMediaRecoveryState(hlsPlayer) {
    let recoveryState = hlsMediaRecoveryStates.get(hlsPlayer);
    if (!recoveryState) {
        recoveryState = {
            playbackActive: false,
            position: new HLSRecoveryPosition(),
            recoveryAttempted: false,
            removePositionListeners: null
        };
        hlsMediaRecoveryStates.set(hlsPlayer, recoveryState);
    }

    return recoveryState;
}

/** Records an explicit HLS seek before the media element processes it. */
export function prepareHLSSeek(hlsPlayer, positionSeconds) {
    if (!hlsPlayer || !Number.isFinite(positionSeconds) || positionSeconds < 0) {
        return;
    }

    getHLSMediaRecoveryState(hlsPlayer).position.recordSeekRequest(positionSeconds);
}

/** Returns the latest explicit or monotonic HLS playback position. */
export function getHLSPlaybackPosition(hlsPlayer, currentPositionSeconds) {
    if (!hlsPlayer) {
        return currentPositionSeconds;
    }

    const recoveryState = getHLSMediaRecoveryState(hlsPlayer);
    const media = hlsPlayer.media;
    return recoveryState.position.getRecoveryPosition(
        currentPositionSeconds,
        media ? getHLSPlaybackObservation(media, recoveryState.playbackActive) : undefined,
        media ? getHLSSeekBounds(media) : undefined
    ) ?? currentPositionSeconds;
}

function bindHLSPositionTracking(hlsPlayer, element, hlsRuntime) {
    const recoveryState = getHLSMediaRecoveryState(hlsPlayer);
    if (recoveryState.removePositionListeners) {
        recoveryState.removePositionListeners();
    }

    const recordPlaybackPosition = function () {
        recoveryState.position.recordPlaybackPosition(
            element.currentTime,
            getHLSPlaybackObservation(element, recoveryState.playbackActive),
            getHLSSeekBounds(element)
        );
    };
    const recordSeekCompletion = function () {
        recoveryState.position.recordSeekCompletion(
            element.currentTime,
            getHLSSeekBounds(element),
            getHLSPlaybackObservation(element, recoveryState.playbackActive)
        );
        if (
            !element.paused
            && !element.ended
            && element.readyState >= HAVE_FUTURE_DATA_READY_STATE
        ) {
            recoveryState.playbackActive = true;
            recoveryState.position.recordPlaybackState(
                getHLSPlaybackObservation(element, true)
            );
        }
    };
    const recordPlayingState = function () {
        recoveryState.playbackActive = true;
        recoveryState.position.recordPlaybackState(
            getHLSPlaybackObservation(element, true)
        );
    };
    const recordInactiveState = function () {
        recoveryState.playbackActive = false;
        recoveryState.position.recordPlaybackState(
            getHLSPlaybackObservation(element, false)
        );
    };
    const recordPlaybackRate = function () {
        recoveryState.position.recordPlaybackState(
            getHLSPlaybackObservation(element, recoveryState.playbackActive)
        );
    };
    const removePositionListeners = function () {
        element.removeEventListener('timeupdate', recordPlaybackPosition);
        element.removeEventListener('seeked', recordSeekCompletion);
        element.removeEventListener('playing', recordPlayingState);
        element.removeEventListener('waiting', recordInactiveState);
        element.removeEventListener('seeking', recordInactiveState);
        element.removeEventListener('pause', recordInactiveState);
        element.removeEventListener('ended', recordInactiveState);
        element.removeEventListener('ratechange', recordPlaybackRate);
        if (recoveryState.removePositionListeners === removePositionListeners) {
            recoveryState.removePositionListeners = null;
        }
    };

    recoveryState.removePositionListeners = removePositionListeners;
    element.addEventListener('timeupdate', recordPlaybackPosition);
    element.addEventListener('seeked', recordSeekCompletion);
    element.addEventListener('playing', recordPlayingState);
    element.addEventListener('waiting', recordInactiveState);
    element.addEventListener('seeking', recordInactiveState);
    element.addEventListener('pause', recordInactiveState);
    element.addEventListener('ended', recordInactiveState);
    element.addEventListener('ratechange', recordPlaybackRate);
    recordPlaybackPosition();

    const destroyingEvent = hlsRuntime.Events.DESTROYING;
    if (destroyingEvent) {
        hlsPlayer.on(destroyingEvent, removePositionListeners);
    }
}

function getHLSSeekBounds(element) {
    let minimumPositionSeconds = null;
    let maximumPositionSeconds = null;
    const ranges = [];
    const seekable = element.seekable;
    for (let rangeIndex = 0; rangeIndex < seekable.length; rangeIndex++) {
        const rangeStart = seekable.start(rangeIndex);
        const rangeEnd = seekable.end(rangeIndex);
        if (
            Number.isFinite(rangeStart)
            && Number.isFinite(rangeEnd)
            && rangeEnd >= rangeStart
        ) {
            ranges.push({
                endPositionSeconds: rangeEnd,
                startPositionSeconds: rangeStart
            });
        }
        if (Number.isFinite(rangeStart)) {
            minimumPositionSeconds = minimumPositionSeconds === null ?
                rangeStart :
                Math.min(minimumPositionSeconds, rangeStart);
        }
        if (Number.isFinite(rangeEnd)) {
            maximumPositionSeconds = maximumPositionSeconds === null ?
                rangeEnd :
                Math.max(maximumPositionSeconds, rangeEnd);
        }
    }

    if (minimumPositionSeconds === null && Number.isFinite(element.duration)) {
        minimumPositionSeconds = 0;
    }
    if (maximumPositionSeconds === null && Number.isFinite(element.duration)) {
        maximumPositionSeconds = element.duration;
    }

    if (
        ranges.length === 0
        && minimumPositionSeconds !== null
        && maximumPositionSeconds !== null
    ) {
        ranges.push({
            endPositionSeconds: maximumPositionSeconds,
            startPositionSeconds: minimumPositionSeconds
        });
    }

    return { maximumPositionSeconds, minimumPositionSeconds, ranges };
}

function recordTrustedHLSClockMovement(
    recoveryState,
    hlsRuntime,
    element,
    errorData
) {
    if (errorData.fatal === true) {
        return;
    }

    const errorDetails = hlsRuntime.ErrorDetails;
    const seekOverHole = errorDetails?.BUFFER_SEEK_OVER_HOLE;
    const nudgeOnStall = errorDetails?.BUFFER_NUDGE_ON_STALL;
    if (
        (seekOverHole && errorData.details === seekOverHole)
        || (nudgeOnStall && errorData.details === nudgeOnStall)
    ) {
        recoveryState.position.recordHLSTrustedPosition(
            element.currentTime,
            getHLSPlaybackObservation(element, recoveryState.playbackActive)
        );
    }
}

function getBufferedEnd(element) {
    const buffered = element.buffered;
    let bufferedEnd = 0;
    for (let rangeIndex = 0; rangeIndex < buffered.length; rangeIndex++) {
        bufferedEnd = Math.max(bufferedEnd, buffered.end(rangeIndex));
    }
    return bufferedEnd;
}

function getTimeRangeSnapshot(timeRanges) {
    const rangeIndices = [];
    if (timeRanges.length <= MAXIMUM_LOGGED_TIME_RANGES) {
        for (let rangeIndex = 0; rangeIndex < timeRanges.length; rangeIndex++) {
            rangeIndices.push(rangeIndex);
        }
    } else {
        const edgeRangeCount = MAXIMUM_LOGGED_TIME_RANGES / 2;
        for (let rangeIndex = 0; rangeIndex < edgeRangeCount; rangeIndex++) {
            rangeIndices.push(rangeIndex);
        }
        for (
            let rangeIndex = timeRanges.length - edgeRangeCount;
            rangeIndex < timeRanges.length;
            rangeIndex++
        ) {
            rangeIndices.push(rangeIndex);
        }
    }

    const ranges = [];
    for (const rangeIndex of rangeIndices) {
        ranges.push({
            end: timeRanges.end(rangeIndex),
            start: timeRanges.start(rangeIndex)
        });
    }

    return {
        count: timeRanges.length,
        ranges
    };
}

function getHLSErrorPlaybackState(hlsPlayer, element, data) {
    const currentTime = Number.isFinite(element.currentTime) ? element.currentTime : 0;
    return {
        bufferLength: Number.isFinite(data.buffer) ? data.buffer : null,
        buffered: getTimeRangeSnapshot(element.buffered),
        bufferingEnabled: hlsPlayer.bufferingEnabled ?? null,
        configuredStartPosition: Number.isFinite(hlsPlayer.config?.startPosition) ?
            hlsPlayer.config.startPosition :
            null,
        currentTime,
        duration: Number.isFinite(element.duration) ? element.duration : null,
        hasEnoughToStart: hlsPlayer.hasEnoughToStart ?? null,
        loadingEnabled: hlsPlayer.loadingEnabled ?? null,
        recoveryPosition: getHlsRecoveryPosition(hlsPlayer, currentTime),
        seekable: getTimeRangeSnapshot(element.seekable),
        sourceBufferName: data.sourceBufferName ?? null,
        startPosition: Number.isFinite(hlsPlayer.startPosition) ? hlsPlayer.startPosition : null
    };
}

function getHlsProgress(element) {
    return {
        bufferedEnd: getBufferedEnd(element),
        currentTime: Number.isFinite(element.currentTime) ? element.currentTime : 0
    };
}

function getHlsRecoveryPosition(hlsPlayer, currentTime) {
    const recoveryState = getHLSMediaRecoveryState(hlsPlayer);
    const media = hlsPlayer.media;
    const trackedPosition = recoveryState.position.getRecoveryPosition(
        currentTime,
        media ? getHLSPlaybackObservation(media, recoveryState.playbackActive) : undefined,
        media ? getHLSSeekBounds(media) : undefined
    );
    if (trackedPosition !== null) {
        return trackedPosition;
    }

    if (currentTime > 0) {
        return currentTime;
    }

    const activeStartPosition = hlsPlayer.startPosition;
    if (Number.isFinite(activeStartPosition) && activeStartPosition >= -1) {
        return activeStartPosition;
    }

    const configuredStartPosition = hlsPlayer.config?.startPosition;
    if (Number.isFinite(configuredStartPosition) && configuredStartPosition >= -1) {
        return configuredStartPosition;
    }

    return 0;
}

function recoverHlsMediaOnce(hlsPlayer, element) {
    const recoveryState = getHLSMediaRecoveryState(hlsPlayer);
    if (recoveryState.recoveryAttempted) {
        return false;
    }

    recoveryState.recoveryAttempted = true;
    const currentTime = Number.isFinite(element.currentTime) ? element.currentTime : 0;
    const recoveryPosition = getHlsRecoveryPosition(hlsPlayer, currentTime);
    try {
        hlsPlayer.stopLoad();
        hlsPlayer.recoverMediaError();
        const recoveryStartedAtCurrentPosition = hlsPlayer.loadingEnabled === true;
        const recoveryRequiresRetarget = Math.abs(currentTime - recoveryPosition)
            > HLS_SEEK_CORRELATION_TOLERANCE_SECONDS;
        if (recoveryStartedAtCurrentPosition && recoveryRequiresRetarget) {
            hlsPlayer.stopLoad();
        }
        if (hlsPlayer.loadingEnabled !== true) {
            hlsPlayer.startLoad(recoveryPosition);
        }
        return true;
    } catch (error) {
        console.error('HLS MediaSource recovery failed', error);
        return false;
    }
}

export function handleHlsJsMediaError(instance, reject) {
    const hlsPlayer = instance._hlsPlayer;

    if (!hlsPlayer) {
        return;
    }

    const element = hlsPlayer.media || instance._mediaElement;
    if (element && recoverHlsMediaOnce(hlsPlayer, element)) {
        console.debug('try to recover media Error ...');
        return;
    }

    console.error('cannot recover, HLS MediaSource recovery budget exhausted ...');
    destroyHlsPlayer(instance);
    if (reject) {
        reject(MediaError.MEDIA_DECODE_ERROR);
    } else {
        onErrorInternal(instance, MediaError.MEDIA_DECODE_ERROR);
    }
}

export function onErrorInternal(instance, type) {
    // Needed for video
    if (instance.destroyCustomTrack) {
        instance.destroyCustomTrack(instance._mediaElement);
    }

    Events.trigger(instance, 'error', [{ type }]);
}

export function isValidDuration(duration) {
    return duration
            && !isNaN(duration)
            && duration !== Number.POSITIVE_INFINITY
            && duration !== Number.NEGATIVE_INFINITY;
}

function setCurrentTimeIfNeeded(element, seconds) {
    // If it's worth skipping (1 sec or less of a difference)
    if (Math.abs((element.currentTime || 0) - seconds) >= 1) {
        element.currentTime = seconds;
    }
}

export function seekOnPlaybackStart(instance, element, ticks, onMediaReady) {
    const seconds = (ticks || 0) / 10000000;

    if (seconds) {
        // Appending #t=xxx to the query string doesn't seem to work with HLS
        // For plain video files, not all browsers support it either

        if (element.duration >= seconds) {
            // media is ready, seek immediately
            setCurrentTimeIfNeeded(element, seconds);
            if (onMediaReady) onMediaReady();
        } else {
            // update video player position when media is ready to be sought
            const events = ['durationchange', 'loadeddata', 'play', 'loadedmetadata'];
            const onMediaChange = function(e) {
                if (element.currentTime === 0 && element.duration >= seconds) {
                    // seek only when video position is exactly zero,
                    // as this is true only if video hasn't started yet or
                    // user rewound to the very beginning
                    // (but rewinding cannot happen as the first event with media of non-empty duration)
                    console.debug(`seeking to ${seconds} on ${e.type} event`);
                    setCurrentTimeIfNeeded(element, seconds);
                    events.forEach(name => {
                        element.removeEventListener(name, onMediaChange);
                    });
                    if (onMediaReady) onMediaReady();
                }
            };
            events.forEach(name => {
                element.addEventListener(name, onMediaChange);
            });
        }
    }
}

export function applySrc(elem, src, options) {
    if (window.Windows && options.mediaSource?.IsLocal) {
        return Windows.Storage.StorageFile.getFileFromPathAsync(options.url).then(function (file) {
            const playlist = new Windows.Media.Playback.MediaPlaybackList();

            const source1 = Windows.Media.Core.MediaSource.createFromStorageFile(file);
            const startTime = (options.playerStartPositionTicks || 0) / 10000;
            playlist.items.append(new Windows.Media.Playback.MediaPlaybackItem(source1, startTime));
            elem.src = URL.createObjectURL(playlist, { oneTimeOnly: true });
            return Promise.resolve();
        });
    } else {
        elem.src = src;
    }

    return Promise.resolve();
}

export function resetSrc(elem) {
    elem.src = '';
    elem.innerHTML = '';
    elem.removeAttribute('src');
}

function onSuccessfulPlay(elem, onErrorFn) {
    elem.addEventListener('error', onErrorFn);
}

export function playWithPromise(elem, onErrorFn) {
    try {
        return elem.play()
            .catch((e) => {
                const errorName = (e.name || '').toLowerCase();
                // safari uses aborterror
                if (errorName === 'notallowederror'
                        || errorName === 'aborterror') {
                    // swallow this error because the user can still click the play button on the video element
                    return Promise.resolve();
                }
                return Promise.reject(e);
            })
            .then(() => {
                onSuccessfulPlay(elem, onErrorFn);
                return Promise.resolve();
            });
    } catch (err) {
        console.error('error calling video.play: ' + err);
        return Promise.reject();
    }
}

export function destroyCastPlayer(instance) {
    const player = instance._castPlayer;
    if (player) {
        try {
            player.unload();
        } catch (err) {
            console.error(err);
        }

        instance._castPlayer = null;
    }
}

export function destroyHlsPlayer(instance) {
    const player = instance._hlsPlayer;
    if (player) {
        try {
            player.destroy();
        } catch (err) {
            console.error(err);
        }

        instance._hlsPlayer = null;
    }
}

export function destroyFlvPlayer(instance) {
    const player = instance._flvPlayer;
    if (player) {
        try {
            player.unload();
            player.detachMediaElement();
            player.destroy();
        } catch (err) {
            console.error(err);
        }

        instance._flvPlayer = null;
    }
}

export function bindEventsToHlsPlayer(
    instance,
    hls,
    elem,
    onErrorFn,
    resolve,
    reject,
    sessionCallbacks
) {
    const isCurrent = sessionCallbacks?.isCurrent;
    const onEstablishedError = sessionCallbacks?.onEstablishedError;
    const hlsRuntime = sessionCallbacks?.hlsRuntime;
    if (!hlsRuntime) {
        throw new TypeError('The owning hls.js runtime is required');
    }
    const appendFailurePolicy = new HLSAppendFailurePolicy(getHlsProgress(elem));
    bindHLSPositionTracking(hls, elem, hlsRuntime);
    let fatalNetworkRecoveryAttempted = false;
    let startupSettled = false;
    let terminalErrorSignaled = false;
    const isCurrentHlsSession = function () {
        if (typeof isCurrent === 'function') {
            return isCurrent();
        }
        return instance._hlsPlayer === hls;
    };
    const signalTerminalError = function (errorType) {
        if (terminalErrorSignaled || !isCurrentHlsSession()) {
            return;
        }

        terminalErrorSignaled = true;
        const rejectCurrentSource = !startupSettled ? reject : null;
        startupSettled = true;
        reject = null;
        try {
            hls.destroy();
        } catch (error) {
            console.error('Failed to destroy terminal HLS session', error);
        } finally {
            if (instance._hlsPlayer === hls) {
                instance._hlsPlayer = null;
            }
            if (rejectCurrentSource) {
                rejectCurrentSource(errorType);
            } else if (typeof onEstablishedError === 'function') {
                onEstablishedError(errorType);
            } else {
                onErrorInternal(instance, errorType);
            }
        }
    };

    hls.on(hlsRuntime.Events.MANIFEST_PARSED, function () {
        if (!isCurrentHlsSession() || terminalErrorSignaled) {
            return;
        }
        playWithPromise(elem, onErrorFn).then(function () {
            if (isCurrentHlsSession() && !terminalErrorSignaled) {
                startupSettled = true;
                reject = null;
                resolve();
            }
        }, function () {
            if (!isCurrentHlsSession() || terminalErrorSignaled || !reject) {
                return;
            }
            const rejectCurrentSource = reject;
            startupSettled = true;
            reject = null;
            rejectCurrentSource();
        });
    });

    hls.on(hlsRuntime.Events.ERROR, function (event, data) {
        if (!isCurrentHlsSession() || terminalErrorSignaled) {
            return;
        }

        recordTrustedHLSClockMovement(
            getHLSMediaRecoveryState(hls),
            hlsRuntime,
            elem,
            data
        );

        console.error(
            'HLS Error: Type: ' + data.type + ' Details: ' + (data.details || '') + ' Fatal: ' + (data.fatal || false),
            getHLSErrorPlaybackState(hls, elem, data)
        );

        const appendFailureAction = appendFailurePolicy.recordFailure(data, getHlsProgress(elem));
        if (appendFailureAction === 'recover') {
            console.warn('Repeated HLS coded-frame append failures; resetting MediaSource once');
            if (!recoverHlsMediaOnce(hls, elem)) {
                signalTerminalError(MediaError.MEDIA_DECODE_ERROR);
            }
            return;
        }
        if (appendFailureAction === 'terminate') {
            console.error('Repeated HLS coded-frame append failures after recovery; ending session');
            signalTerminalError(MediaError.MEDIA_DECODE_ERROR);
            return;
        }

        // try to recover network error
        if (data.type === hlsRuntime.ErrorTypes.NETWORK_ERROR
                && data.response?.code && data.response.code >= 400
        ) {
            console.debug('hls.js response error code: ' + data.response.code);

            // Trigger failure differently depending on whether this is prior to start of playback, or after
            signalTerminalError(MediaError.SERVER_ERROR);

            return;
        }

        if (data.fatal) {
            switch (data.type) {
                case hlsRuntime.ErrorTypes.NETWORK_ERROR:

                    if (data.response && data.response.code === 0) {
                        // This could be a CORS error related to access control response headers

                        console.debug('hls.js response error code: ' + data.response.code);

                        // Trigger failure differently depending on whether this is prior to start of playback, or after
                        signalTerminalError(MediaError.NETWORK_ERROR);
                    } else {
                        if (fatalNetworkRecoveryAttempted) {
                            console.error('fatal network error recovery budget exhausted');
                            signalTerminalError(MediaError.NETWORK_ERROR);
                            break;
                        }

                        fatalNetworkRecoveryAttempted = true;
                        console.debug('fatal network error encountered, try to recover once');
                        try {
                            hls.startLoad();
                        } catch (error) {
                            console.error('fatal network error recovery failed', error);
                            signalTerminalError(MediaError.NETWORK_ERROR);
                        }
                    }

                    break;
                case hlsRuntime.ErrorTypes.MEDIA_ERROR:
                    console.debug('fatal media error encountered, try to recover');
                    if (!recoverHlsMediaOnce(hls, elem)) {
                        signalTerminalError(MediaError.MEDIA_DECODE_ERROR);
                    }
                    break;
                default:

                    console.debug('Cannot recover from hls error - destroy and trigger error');
                    // cannot recover
                    // Trigger failure differently depending on whether this is prior to start of playback, or after
                    signalTerminalError(MediaError.FATAL_HLS_ERROR);
                    break;
            }
        }
    });
}

export function onEndedInternal(instance, elem, onErrorFn) {
    elem.removeEventListener('error', onErrorFn);

    resetSrc(elem);

    destroyHlsPlayer(instance);
    destroyFlvPlayer(instance);
    destroyCastPlayer(instance);

    const stopInfo = {
        src: typeof instance.currentSrc === 'function' ?
            instance.currentSrc() :
            instance._currentSrc
    };

    Events.trigger(instance, 'stopped', [stopInfo]);

    instance._currentTime = null;
    instance._currentSrc = null;
    instance._currentPlayOptions = null;
}

export function getBufferedRanges(instance, elem) {
    const ranges = [];
    const seekable = elem.buffered || [];

    let offset;
    const currentPlayOptions = instance._currentPlayOptions;
    if (currentPlayOptions) {
        offset = currentPlayOptions.transcodingOffsetTicks;
    }

    offset = offset || 0;

    for (let i = 0, length = seekable.length; i < length; i++) {
        let start = seekable.start(i);
        let end = seekable.end(i);

        if (!isValidDuration(start)) {
            start = 0;
        }
        if (!isValidDuration(end)) {
            // eslint-disable-next-line sonarjs/no-dead-store
            end = 0;
            continue;
        }

        ranges.push({
            start: (start * 10000000) + offset,
            end: (end * 10000000) + offset
        });
    }

    return ranges;
}
