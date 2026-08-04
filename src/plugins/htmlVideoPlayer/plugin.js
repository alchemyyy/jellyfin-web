import DOMPurify from 'dompurify';
import webGPUHLSPackage from 'hls.js-webgpu/package.json';
import debounce from 'lodash-es/debounce';
import Screenfull from 'screenfull';

import { useCustomSubtitles } from 'apps/legacy/features/playback/utils/subtitleStyles';
import subtitleAppearanceHelper from 'components/subtitlesettings/subtitleappearancehelper';
import { AppFeature } from 'constants/appFeature';
import { PLAYBACK_SUPERSEDED } from 'constants/playbackResult';
import { PluginType } from 'constants/pluginType';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import { currentSettings as userSettings } from 'scripts/settings/userSettings';
import { MediaError } from 'types/mediaError';

import browser from '../../scripts/browser';
import appSettings from '../../scripts/settings/appSettings';
import { appHost } from '../../components/apphost';
import loading from '../../components/loading/loading';
import dom from '../../utils/dom';
import { playbackManager } from '../../components/playback/playbackmanager';
import { appRouter } from '../../components/router/appRouter';
import {
    bindEventsToHlsPlayer,
    destroyHlsPlayer,
    destroyFlvPlayer,
    destroyCastPlayer,
    getCrossOriginValue,
    enableHlsJsPlayerForCodecs,
    applySrc,
    resetSrc,
    playWithPromise,
    onEndedInternal,
    saveVolume,
    seekOnPlaybackStart,
    onErrorInternal,
    handleHlsJsMediaError,
    getSavedVolume,
    isValidDuration,
    getBufferedRanges,
    getHLSPlaybackPosition,
    prepareHLSSeek
} from '../../components/htmlMediaHelper';
import itemHelper from '../../components/itemHelper';
import globalize from '../../lib/globalize';
import profileBuilder, { canPlaySecondaryAudio } from '../../scripts/browserDeviceProfile';
import { getIncludeCorsCredentials } from '../../scripts/settings/webSettings';
import { setBackdropTransparency, TRANSPARENCY_LEVEL } from '../../components/backdrop/backdrop';
import Events from '../../utils/events.ts';
import { includesAny } from '../../utils/container.ts';
import { isHls } from '../../utils/mediaSource.ts';
import { shouldPreferHDRHLSRendition } from './HLSRenditionPreference';
import { loadHLSRuntime } from './HLSRuntimeLoader';

const HLS_FRAGMENT_TIME_TO_FIRST_BYTE_MS = 20000;
const HLS_MINIMUM_BUFFER_LENGTH_SECONDS = 6;
const HLS_MAXIMUM_BUFFER_LENGTH_SECONDS = 30;
const HLS_WORKER_PATH = 'libraries/hls.worker.js';
const WEBGPU_HLS_WORKER_PATH = `libraries/hls.webgpu-${webGPUHLSPackage.version}.worker.js`;
const MILLISECONDS_PER_SECOND = 1000;
const TICKS_PER_SECOND = 10000000;
const MINIMUM_SUBTITLE_CANVAS_DIMENSION = 1;
const CUSTOM_SUBTITLE_CANVAS_CLASS = 'htmlVideoPlayerCustomSubtitleCanvas';

/**
 * Returns resolved URL.
 * @param {string} url - URL.
 * @returns {string} Resolved URL or `url` if resolving failed.
 */
function resolveUrl(url) {
    return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('HEAD', url, true);
        xhr.onload = function () {
            resolve(xhr.responseURL || url);
        };
        xhr.onerror = function (e) {
            console.error(e);
            resolve(url);
        };
        xhr.send(null);
    });
}

function tryRemoveElement(elem) {
    const parentNode = elem.parentNode;
    if (parentNode) {
        // Seeing crashes in edge webview
        try {
            parentNode.removeChild(elem);
        } catch (err) {
            console.error(`error removing dialog element: ${err}`);
        }
    }
}

function enableNativeTrackSupport(mediaSource, track) {
    if (track?.DeliveryMethod === 'Embed') {
        return true;
    }

    if (browser.firefox && isHls(mediaSource)) {
        return false;
    }

    if (browser.ps4) {
        return false;
    }

    if (browser.web0s) {
        return false;
    }

    // Edge is randomly not rendering subtitles
    if (browser.edge) {
        return false;
    }

    if (browser.iOS && (browser.iosVersion || 10) < 10) {
        // works in the browser but not the native app
        return false;
    }

    if (track) {
        const format = (track.Codec || '').toLowerCase();
        if (NATIVE_UNSUPPORTED_SUBTITLE_CODECS.includes(format)) {
            return false;
        }
    }

    return true;
}

function getHLSFragmentLoadPolicy(HLSRuntime) {
    const fragmentLoadPolicy = HLSRuntime.DefaultConfig.fragLoadPolicy;
    return {
        ...fragmentLoadPolicy,
        default: {
            ...fragmentLoadPolicy.default,
            // Give cold storage enough time to start producing a segment
            maxTimeToFirstByteMs: HLS_FRAGMENT_TIME_TO_FIRST_BYTE_MS
        }
    };
}

function getHLSBufferConfiguration(useWebGPUHLSRuntime) {
    if (useWebGPUHLSRuntime) {
        return {
            backBufferLength: HLS_MINIMUM_BUFFER_LENGTH_SECONDS,
            frontBufferFlushThreshold: HLS_MINIMUM_BUFFER_LENGTH_SECONDS,
            maxBufferLength: HLS_MINIMUM_BUFFER_LENGTH_SECONDS,
            maxMaxBufferLength: HLS_MAXIMUM_BUFFER_LENGTH_SECONDS
        };
    }

    return {
        backBufferLength: Number.POSITIVE_INFINITY,
        liveBackBufferLength: 90,
        maxBufferLength: HLS_MAXIMUM_BUFFER_LENGTH_SECONDS,
        maxMaxBufferLength: HLS_MAXIMUM_BUFFER_LENGTH_SECONDS
    };
}

function getMediaStreamVideoTracks(mediaSource) {
    return mediaSource.MediaStreams.filter(function (s) {
        return s.Type === 'Video';
    });
}

function getMediaStreamAudioTracks(mediaSource) {
    return mediaSource.MediaStreams.filter(function (s) {
        return s.Type === 'Audio';
    });
}

function getMediaStreamTextTracks(mediaSource) {
    return mediaSource.MediaStreams.filter(function (s) {
        return s.Type === 'Subtitle';
    });
}

function zoomIn(elem) {
    return new Promise(resolve => {
        const duration = 240;
        elem.style.animation = `htmlvideoplayer-zoomin ${duration}ms ease-in normal`;
        dom.addEventListener(elem, dom.whichAnimationEvent(), resolve, {
            once: true
        });
    });
}

function normalizeTrackEventText(text, useHtml) {
    const result = text
        .replace(/\\N/gi, '\n') // Correct newline characters
        .replace(/\r/gi, '') // Remove carriage return characters
        .replace(/{\\.*?}/gi, '') // Remove ass/ssa tags
        // Force LTR as the default direction
        .split('\n').map(val => `\u200E${val}`).join('\n');
    return useHtml ? result.replace(/\n/gi, '<br>') : result;
}

function getTextTrackUrl(track, item, format) {
    if (itemHelper.isLocalItem(item) && track.Path) {
        return track.Path;
    }

    let url = playbackManager.getSubtitleUrl(track, item.ServerId);
    if (format) {
        url = url.replace('.vtt', format);
    }

    return url;
}

function getSubtitleFileNameHint(track) {
    const candidates = [track?.Path, track?.DeliveryUrl];
    for (const candidate of candidates) {
        if (!candidate) {
            continue;
        }

        const sanitized = candidate.split(/[?#]/)[0];
        const fileName = sanitized.split(/[\\/]/).pop();
        if (fileName) {
            return fileName;
        }
    }

    const codec = (track?.Codec || '').toLowerCase();
    if (VOBSUB_SUBTITLE_CODECS.includes(codec)) {
        return 'subtitle.mks';
    }

    return undefined;
}

function getBitmapSubtitleDisplaySettings() {
    const aspectMode = userSettings.getSubtitleAppearanceSettings()?.aspectMode;
    const normalizedAspectMode = typeof aspectMode === 'string' ? aspectMode.toLowerCase() : 'stretch';

    if (BITMAP_SUBTITLE_ASPECT_MODES.includes(normalizedAspectMode)) {
        return {
            aspectMode: normalizedAspectMode
        };
    }

    return {
        aspectMode: 'contain'
    };
}

function getSubtitleTimeOffset(playOptions, subtitleOffset = 0) {
    return ((playOptions?.transcodingOffsetTicks || 0) / 10000000) + subtitleOffset;
}

function getDefaultProfile() {
    return profileBuilder({});
}

const PRIMARY_TEXT_TRACK_INDEX = 0;
const VOBSUB_DEBAND_THRESHOLD = 64;
const VOBSUB_DEBAND_RANGE = 15;
const SECONDARY_TEXT_TRACK_INDEX = 1;

export class HtmlVideoPlayer {
    /**
     * @type {string}
     */
    name;
    /**
     * @type {string}
     */
    type = PluginType.MediaPlayer;
    /**
     * @type {string}
     */
    id = 'htmlvideoplayer';
    /**
     * Let any players created by plugins take priority
     *
     * @type {number}
     */
    priority = 1;
    /**
     * @type {boolean}
     */
    isFetching = false;
    /**
     * @type {HTMLDivElement | null | undefined}
     */
    #videoDialog;
    /**
     * Player identity owned by PlaybackManager. This differs from `this` when
     * HtmlVideoPlayer is composed inside another local player.
     *
     * @type {object}
     */
    #playbackManagerPlayer;
    /**
     * @type {boolean}
     */
    #forceCustomSubtitleElements;
    /**
     * Selects the isolated hls.js runtime used by the owned WebGPU fallback.
     * @type {boolean}
     */
    #useWebGPUHLSRuntime;
    /**
     * @type {number | undefined}
     */
    #subtitleTrackIndexToSetOnPlaying;
    /**
     * @type {number | undefined}
     */
    #secondarySubtitleTrackIndexToSetOnPlaying;
    /**
     * @type {number | null}
     */
    #audioTrackIndexToSetOnPlaying;
    /**
     * @type {any | null | undefined}
     */
    #currentAssRenderer;
    /**
     * @type {HTMLCanvasElement | null | undefined}
     */
    #currentAssCanvas;
    /**
     * @type {any | null | undefined}
     */
    #currentBitmapSubRenderer;
    /**
     * @type {HTMLCanvasElement | null | undefined}
     */
    #currentPgsCanvas;
    /**
     * @type {(EventTarget & { currentTime: number }) | null | undefined}
     */
    #currentPgsClock;
    /**
     * @type {number | undefined}
     */
    #customTrackIndex;
    /**
     * @type {number | undefined}
     */
    #customSecondaryTrackIndex;
    /**
     * @type {boolean | undefined}
     */
    #showTrackOffset;
    /**
     * @type {number | undefined}
     */
    #currentTrackOffset;
    /**
     * @type {HTMLElement | null | undefined}
     */
    #secondaryTrackOffset;
    /**
     * @type {HTMLElement | null | undefined}
     */
    #videoSubtitlesElem;
    /**
     * @type {HTMLElement | null | undefined}
     */
    #videoSecondarySubtitlesElem;
    /**
     * @type {any | null | undefined}
     */
    #currentTrackEvents;
    /**
     * @type {any | null | undefined}
     */
    #currentSecondaryTrackEvents;
    /**
     * @type {string[] | undefined}
     */
    #supportedFeatures;
    /**
     * @type {HTMLVideoElement | null | undefined}
     */
    #mediaElement;
    /**
     * @type {number}
     */
    #fetchQueue = 0;
    /**
     * @type {number}
     */
    #fetchQueueGeneration = 0;
    /**
     * @type {string | undefined}
     */
    #currentSrc;
    /**
     * @type {boolean | undefined}
     */
    #started;
    /**
     * @type {boolean | undefined}
     */
    #timeUpdated;
    /**
     * @type {boolean}
     */
    #customPlaybackActive = false;
    /**
     * @type {boolean}
     */
    #customPlaybackPaused = true;
    /**
     * @type {number | null | undefined}
     */
    #currentTime;
    /**
     * @type {number | null}
     */
    #detectedAspectRatio = null;
    /**
     * @type {number}
     */
    #playSessionGeneration = 0;
    /**
     * @type {{ generation: number, mediaElement?: HTMLVideoElement, resolve: () => void } | null}
     */
    #pendingPlay = null;
    /**
     * @type {number}
     */
    #subtitleSessionGeneration = 0;
    /**
     * @type {number}
     */
    #primarySubtitleSelectionGeneration = 0;
    /**
     * @type {number}
     */
    #secondarySubtitleSelectionGeneration = 0;
    /**
     * @type {number}
     */
    #primarySubtitleRenderGeneration = 0;
    /**
     * @type {number}
     */
    #secondarySubtitleRenderGeneration = 0;

    /**
     * @private (used in other files)
     * @type {any | undefined}
     */
    _flvPlayer;

    /**
     * @private (used in other files)
     * @type {any | undefined}
     */
    _hlsPlayer;
    /**
     * @private (used in other files)
     * @type {any | null | undefined}
     */
    _castPlayer;
    /**
     * @private (used in other files)
     * @type {any | undefined}
     */
    _currentPlayOptions;
    /**
     * @type {any | undefined}
     */
    #lastProfile;

    constructor(
        playbackManagerPlayer,
        forceCustomSubtitleElements = false,
        useWebGPUHLSRuntime = false
    ) {
        this.#playbackManagerPlayer = playbackManagerPlayer || this;
        this.#forceCustomSubtitleElements = forceCustomSubtitleElements;
        this.#useWebGPUHLSRuntime = useWebGPUHLSRuntime;

        if (browser.edgeUwp) {
            this.name = 'Windows Video Player';
        } else {
            this.name = 'Html Video Player';
        }
    }

    /**
     * Returns the presentation surface owned by this player instance.
     *
     * @returns {{ container: HTMLDivElement, video: HTMLVideoElement } | null}
     */
    getPresentationSurface() {
        const container = this.#videoDialog;
        const video = this.#mediaElement;

        if (!container || !video || video.parentElement !== container) {
            return null;
        }

        return { container, video };
    }

    /**
     * Invalidates and resolves the current asynchronous playback setup.
     * @param {boolean} pauseSource Whether to pause a source already assigned by setup.
     */
    cancelPendingPlay(pauseSource = true) {
        const pendingPlay = this.#pendingPlay;
        if (!pendingPlay) {
            return;
        }

        this.#playSessionGeneration++;
        this.#pendingPlay = null;
        this.#customPlaybackActive = false;
        if (pauseSource && pendingPlay.mediaElement === this.#mediaElement) {
            pendingPlay.mediaElement.pause();
        }
        pendingPlay.resolve(PLAYBACK_SUPERSEDED);

        // These players can retain callbacks that would otherwise start stale media.
        destroyHlsPlayer(this);
        destroyFlvPlayer(this);
    }

    /**
     * Invalidates the current playback generation, including established sessions.
     * @private
     */
    #invalidatePlaySession(pauseSource = true) {
        const playSessionGeneration = this.#playSessionGeneration;
        this.cancelPendingPlay(pauseSource);
        if (this.#playSessionGeneration === playSessionGeneration) {
            this.#playSessionGeneration++;
        }
    }

    /**
     * Checks whether asynchronous playback setup still owns this player and element.
     * @private
     */
    #isPlaySessionCurrent(playSessionGeneration, mediaElement) {
        if (playSessionGeneration !== this.#playSessionGeneration) {
            return false;
        }

        return mediaElement === undefined || mediaElement === this.#mediaElement;
    }

    /**
     * Records the element whose source has started for the pending play.
     * @private
     */
    #markPendingPlaySource(playSessionGeneration, mediaElement) {
        if (
            this.#pendingPlay?.generation === playSessionGeneration
            && this.#isPlaySessionCurrent(playSessionGeneration, mediaElement)
        ) {
            this.#pendingPlay.mediaElement = mediaElement;
        }
    }

    /**
     * Invalidates every pending subtitle operation from the current source.
     * @private
     */
    #invalidateSubtitleSession() {
        this.#subtitleSessionGeneration++;
        this.#fetchQueue = 0;
        this.#fetchQueueGeneration = this.#subtitleSessionGeneration;
        this.isFetching = false;
        this.setSubtitleOffset.cancel();
    }

    /**
     * Starts an asynchronous subtitle selection for one displayed track.
     * @private
     */
    #beginSubtitleSelection(targetTextTrackIndex) {
        let selectionGeneration;
        if (this.isSecondaryTrack(targetTextTrackIndex)) {
            this.#secondarySubtitleSelectionGeneration++;
            selectionGeneration = this.#secondarySubtitleSelectionGeneration;
        } else {
            this.#primarySubtitleSelectionGeneration++;
            selectionGeneration = this.#primarySubtitleSelectionGeneration;
        }

        return {
            selectionGeneration,
            sessionGeneration: this.#subtitleSessionGeneration,
            targetTextTrackIndex
        };
    }

    /**
     * Checks whether an asynchronous subtitle selection still targets this source.
     * @private
     */
    #isSubtitleSelectionCurrent(subtitleSelection) {
        if (subtitleSelection.sessionGeneration !== this.#subtitleSessionGeneration) {
            return false;
        }

        if (this.isSecondaryTrack(subtitleSelection.targetTextTrackIndex)) {
            return subtitleSelection.selectionGeneration === this.#secondarySubtitleSelectionGeneration;
        }

        return subtitleSelection.selectionGeneration === this.#primarySubtitleSelectionGeneration;
    }

    /**
     * Starts asynchronous rendering for one displayed subtitle track.
     * @private
     */
    #beginSubtitleRender(targetTextTrackIndex) {
        let renderGeneration;
        if (this.isSecondaryTrack(targetTextTrackIndex)) {
            this.#secondarySubtitleRenderGeneration++;
            renderGeneration = this.#secondarySubtitleRenderGeneration;
        } else {
            this.#primarySubtitleRenderGeneration++;
            renderGeneration = this.#primarySubtitleRenderGeneration;
        }

        return {
            renderGeneration,
            sessionGeneration: this.#subtitleSessionGeneration,
            targetTextTrackIndex
        };
    }

    /**
     * Captures the current render generation without starting new work.
     * @private
     */
    #captureSubtitleRender(targetTextTrackIndex) {
        const renderGeneration = this.isSecondaryTrack(targetTextTrackIndex) ?
            this.#secondarySubtitleRenderGeneration :
            this.#primarySubtitleRenderGeneration;

        return {
            renderGeneration,
            sessionGeneration: this.#subtitleSessionGeneration,
            targetTextTrackIndex
        };
    }

    /**
     * Invalidates pending rendering for one subtitle track, or both when omitted.
     * @private
     */
    #invalidateSubtitleRender(targetTextTrackIndex) {
        if (this.isPrimaryTrack(targetTextTrackIndex)) {
            this.#primarySubtitleRenderGeneration++;
            return;
        }

        if (this.isSecondaryTrack(targetTextTrackIndex)) {
            this.#secondarySubtitleRenderGeneration++;
            return;
        }

        this.#primarySubtitleRenderGeneration++;
        this.#secondarySubtitleRenderGeneration++;
    }

    /**
     * Checks whether asynchronous subtitle rendering still targets this source and element.
     * @private
     */
    #isSubtitleRenderCurrent(subtitleRender, videoElement) {
        if (
            subtitleRender.sessionGeneration !== this.#subtitleSessionGeneration
            || videoElement !== this.#mediaElement
        ) {
            return false;
        }

        if (this.isSecondaryTrack(subtitleRender.targetTextTrackIndex)) {
            return subtitleRender.renderGeneration === this.#secondarySubtitleRenderGeneration;
        }

        return subtitleRender.renderGeneration === this.#primarySubtitleRenderGeneration;
    }

    currentSrc() {
        return this.#currentSrc;
    }

    /**
     * @private
     */
    incrementFetchQueue(sessionGeneration) {
        if (sessionGeneration !== this.#subtitleSessionGeneration) {
            return;
        }

        if (this.#fetchQueueGeneration !== sessionGeneration) {
            this.#fetchQueue = 0;
            this.#fetchQueueGeneration = sessionGeneration;
        }

        if (this.#fetchQueue <= 0) {
            this.isFetching = true;
            Events.trigger(this, 'beginFetch');
        }

        this.#fetchQueue++;
    }

    /**
     * @private
     */
    decrementFetchQueue(sessionGeneration) {
        if (
            sessionGeneration !== this.#subtitleSessionGeneration
            || this.#fetchQueueGeneration !== sessionGeneration
        ) {
            return;
        }

        this.#fetchQueue--;

        if (this.#fetchQueue <= 0) {
            this.isFetching = false;
            Events.trigger(this, 'endFetch');
        }
    }

    /**
     * @private
     */
    updateVideoUrl(streamInfo, playSessionGeneration = this.#playSessionGeneration) {
        if (!this.#isPlaySessionCurrent(playSessionGeneration)) {
            return Promise.resolve();
        }

        const mediaSource = streamInfo.mediaSource;
        const item = streamInfo.item;

        // Huge hack alert. Safari doesn't seem to like if the segments aren't available right away when playback starts
        // This will start the transcoding process before actually feeding the video url into the player
        // Edit: Also seeing stalls from hls.js
        if (mediaSource && item && !mediaSource.RunTimeTicks && isHls(mediaSource) && streamInfo.playMethod === 'Transcode' && (browser.iOS || browser.osx)) {
            const hlsPlaylistUrl = streamInfo.url.replace('master.m3u8', 'live.m3u8');

            loading.show();

            console.debug(`prefetching hls playlist: ${hlsPlaylistUrl}`);

            return ServerConnections.getApiClient(item.ServerId).ajax({

                type: 'GET',
                url: hlsPlaylistUrl

            }).then(() => {
                if (!this.#isPlaySessionCurrent(playSessionGeneration)) {
                    return;
                }

                console.debug(`completed prefetching hls playlist: ${hlsPlaylistUrl}`);

                loading.hide();
                streamInfo.url = hlsPlaylistUrl;
            }, () => {
                if (!this.#isPlaySessionCurrent(playSessionGeneration)) {
                    return;
                }

                console.error(`error prefetching hls playlist: ${hlsPlaylistUrl}`);

                loading.hide();
            });
        } else {
            return Promise.resolve();
        }
    }

    async play(options) {
        this.#customPlaybackActive = false;
        this.#customPlaybackPaused = true;
        this.#invalidatePlaySession();
        const playSessionGeneration = this.#playSessionGeneration;
        let resolveCancellation;
        const cancellationPromise = new Promise((resolve) => {
            resolveCancellation = resolve;
        });
        const pendingPlay = {
            generation: playSessionGeneration,
            resolve: resolveCancellation
        };
        this.#pendingPlay = pendingPlay;

        const setupPromise = this.#setUpPlay(options, playSessionGeneration).catch((error) => {
            if (this.#isPlaySessionCurrent(playSessionGeneration)) {
                this.#playSessionGeneration++;
                destroyHlsPlayer(this);
                destroyFlvPlayer(this);
            }

            throw error;
        });
        try {
            return await Promise.race([setupPromise, cancellationPromise]);
        } finally {
            if (this.#pendingPlay?.generation === playSessionGeneration) {
                this.#pendingPlay = null;
            }
        }
    }

    /**
     * Creates the normal video, subtitle, and OSD surface without assigning a
     * native media source. A composed player can then own demux and decode.
     *
     * @param {any} options
     * @returns {Promise<{ container: HTMLDivElement, video: HTMLVideoElement } | string | null>}
     */
    async prepareCustomPlayback(options) {
        this.#invalidatePlaySession();
        this.#customPlaybackActive = true;
        this.#customPlaybackPaused = true;
        const playSessionGeneration = this.#playSessionGeneration;
        let resolveCancellation;
        const cancellationPromise = new Promise((resolve) => {
            resolveCancellation = resolve;
        });
        const pendingPlay = {
            generation: playSessionGeneration,
            resolve: resolveCancellation
        };
        this.#pendingPlay = pendingPlay;

        const setupPromise = this.#setUpCustomPlayback(options, playSessionGeneration).catch((error) => {
            if (this.#isPlaySessionCurrent(playSessionGeneration)) {
                this.#playSessionGeneration++;
                this.#customPlaybackActive = false;
            }
            throw error;
        });
        try {
            return await Promise.race([setupPromise, cancellationPromise]);
        } finally {
            if (this.#pendingPlay?.generation === playSessionGeneration) {
                this.#pendingPlay = null;
            }
        }
    }

    /**
     * @private
     */
    async #setUpCustomPlayback(options, playSessionGeneration) {
        this.#invalidateSubtitleSession();
        this.destroyCustomTrack(this.#mediaElement);
        this.#started = false;
        this.#timeUpdated = false;
        this.#currentTime = null;
        this.#detectedAspectRatio = this.#getDetectedAspectRatio(options);

        if (options.resetSubtitleOffset !== false) this.resetSubtitleOffset();

        const elem = await this.createMediaElement(options, playSessionGeneration);
        if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
            return null;
        }

        this.#markPendingPlaySource(playSessionGeneration, elem);
        elem.removeEventListener('error', this.onError);
        destroyHlsPlayer(this);
        destroyFlvPlayer(this);
        destroyCastPlayer(this);
        resetSrc(elem);
        this.#configureTrackSelection(options, true);
        this._currentPlayOptions = options;
        this.#currentSrc = options.url;
        this.#applyAspectRatio(options.aspectRatio || this.getAspectRatio());
        return this.getPresentationSurface();
    }

    /**
     * Sets up one playback generation.
     * @private
     */
    async #setUpPlay(options, playSessionGeneration) {
        this.#invalidateSubtitleSession();
        this.#started = false;
        this.#timeUpdated = false;

        this.#currentTime = null;
        this.#detectedAspectRatio = this.#getDetectedAspectRatio(options);

        if (options.resetSubtitleOffset !== false) this.resetSubtitleOffset();

        const elem = await this.createMediaElement(options, playSessionGeneration);
        if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
            return;
        }

        this.#applyAspectRatio(options.aspectRatio || this.getAspectRatio());

        await this.updateVideoUrl(options, playSessionGeneration);
        if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
            return;
        }

        return this.setCurrentSrc(elem, options, playSessionGeneration);
    }

    /**
     * @private
     */
    setSrcWithFlvJs(elem, options, url, playSessionGeneration) {
        return import('flv.js').then(({ default: flvjs }) => {
            if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                return;
            }

            const flvPlayer = flvjs.createPlayer({
                type: 'flv',
                url: url
            },
            {
                seekType: 'range',
                lazyLoad: false
            });
            if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                flvPlayer.destroy();
                return;
            }

            this.#markPendingPlaySource(playSessionGeneration, elem);
            this._flvPlayer = flvPlayer;
            flvPlayer.attachMediaElement(elem);
            if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                return;
            }

            flvPlayer.load();
            if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                return;
            }

            // This is needed in setCurrentTrackElement
            this.#currentSrc = url;

            return flvPlayer.play();
        });
    }

    /**
     * @private
     */
    setSrcWithHlsJs(elem, options, url, playSessionGeneration) {
        return new Promise((resolve, reject) => {
            let sourceRejected = false;
            let sourceResolved = false;
            const resolveSource = (value) => {
                sourceResolved = true;
                resolve(value);
            };
            const rejectSource = (error) => {
                if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                    resolve();
                    return;
                }

                if (!sourceResolved) {
                    sourceRejected = true;
                    reject(error);
                    return;
                }

                this.#invalidatePlaySession(false);
                destroyHlsPlayer(this);
                onErrorInternal(this, error || MediaError.FATAL_HLS_ERROR);
            };

            loadHLSRuntime(this.#useWebGPUHLSRuntime).then(async ({
                HLSRuntime,
                useWebGPUHLSRuntime
            }) => {
                try {
                    if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                        resolve();
                        return;
                    }

                    const includeCorsCredentials = await getIncludeCorsCredentials();
                    if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                        resolve();
                        return;
                    }

                    const hls = new HLSRuntime({
                        ...getHLSBufferConfiguration(this.#useWebGPUHLSRuntime),
                        startPosition: options.playerStartPositionTicks / 10000000,
                        manifestLoadingTimeOut: 20000,
                        fragLoadPolicy: getHLSFragmentLoadPolicy(HLSRuntime),
                        lowLatencyMode: false,
                        videoPreference: {
                            preferHDR: shouldPreferHDRHLSRendition(options)
                        },
                        workerPath: useWebGPUHLSRuntime ?
                            WEBGPU_HLS_WORKER_PATH :
                            HLS_WORKER_PATH,
                        xhrSetup(xhr) {
                            xhr.withCredentials = includeCorsCredentials;
                        }
                    });
                    if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                        hls.destroy();
                        resolve();
                        return;
                    }

                    this.#markPendingPlaySource(playSessionGeneration, elem);
                    this._hlsPlayer = hls;
                    hls.loadSource(url);
                    if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                        resolve();
                        return;
                    }

                    hls.attachMedia(elem);
                    if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                        resolve();
                        return;
                    }

                    bindEventsToHlsPlayer(
                        this,
                        hls,
                        elem,
                        this.onError,
                        resolveSource,
                        rejectSource,
                        {
                            hlsRuntime: HLSRuntime,
                            isCurrent: () => this.#isPlaySessionCurrent(playSessionGeneration, elem)
                                && this._hlsPlayer === hls,
                            onEstablishedError: rejectSource
                        }
                    );
                    if (sourceRejected || !this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                        return;
                    }

                    // This is needed in setCurrentTrackElement
                    this.#currentSrc = url;
                } catch (error) {
                    if (this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                        reject(error);
                    } else {
                        resolve();
                    }
                }
            }, (error) => {
                if (this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                    reject(error);
                } else {
                    resolve();
                }
            });
        });
    }

    /**
     * @private
     */
    #configureTrackSelection(options, customAudio) {
        let secondaryTrackValid = true;

        this.#subtitleTrackIndexToSetOnPlaying = options.mediaSource.DefaultSubtitleStreamIndex == null ? -1 : options.mediaSource.DefaultSubtitleStreamIndex;
        if (this.#subtitleTrackIndexToSetOnPlaying != null && this.#subtitleTrackIndexToSetOnPlaying >= 0) {
            const initialSubtitleStream = options.mediaSource.MediaStreams[this.#subtitleTrackIndexToSetOnPlaying];
            if (!initialSubtitleStream || initialSubtitleStream.DeliveryMethod === 'Encode') {
                this.#subtitleTrackIndexToSetOnPlaying = -1;
                secondaryTrackValid = false;
            }
            // secondary track should not be shown if primary track is no longer a valid pair
            if (initialSubtitleStream && !playbackManager.trackHasSecondarySubtitleSupport(initialSubtitleStream, this.#playbackManagerPlayer)) {
                secondaryTrackValid = false;
            }
        } else {
            secondaryTrackValid = false;
        }

        this.#audioTrackIndexToSetOnPlaying = customAudio || options.playMethod === 'Transcode' ? null : options.mediaSource.DefaultAudioStreamIndex;

        if (secondaryTrackValid) {
            this.#secondarySubtitleTrackIndexToSetOnPlaying = options.mediaSource.DefaultSecondarySubtitleStreamIndex == null ? -1 : options.mediaSource.DefaultSecondarySubtitleStreamIndex;
            if (this.#secondarySubtitleTrackIndexToSetOnPlaying != null && this.#secondarySubtitleTrackIndexToSetOnPlaying >= 0) {
                const initialSecondarySubtitleStream = options.mediaSource.MediaStreams[this.#secondarySubtitleTrackIndexToSetOnPlaying];
                if (!initialSecondarySubtitleStream || !playbackManager.trackHasSecondarySubtitleSupport(initialSecondarySubtitleStream, this.#playbackManagerPlayer)) {
                    this.#secondarySubtitleTrackIndexToSetOnPlaying = -1;
                }
            }
        } else {
            this.#secondarySubtitleTrackIndexToSetOnPlaying = -1;
        }
    }

    /**
     * @private
     */
    async setCurrentSrc(elem, options, playSessionGeneration = this.#playSessionGeneration) {
        if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
            return;
        }

        elem.removeEventListener('error', this.onError);

        let val = options.url;
        console.debug(`playing url: ${val}`);

        // Convert to seconds
        const seconds = (options.playerStartPositionTicks || 0) / 10000000;
        if (seconds) {
            val += `#t=${seconds}`;
        }

        destroyHlsPlayer(this);
        destroyFlvPlayer(this);
        destroyCastPlayer(this);
        this.#configureTrackSelection(options, false);
        this._currentPlayOptions = options;

        const crossOrigin = getCrossOriginValue(options.mediaSource);
        if (crossOrigin) {
            elem.crossOrigin = crossOrigin;
        }

        if (enableHlsJsPlayerForCodecs(options.mediaSource, 'Video') && isHls(options.mediaSource)) {
            return this.setSrcWithHlsJs(elem, options, val, playSessionGeneration);
        } else if (options.playMethod !== 'Transcode' && options.mediaSource.Container?.toUpperCase() === 'FLV') {
            return this.setSrcWithFlvJs(elem, options, val, playSessionGeneration);
        } else {
            elem.autoplay = true;

            const includeCorsCredentials = await getIncludeCorsCredentials();
            if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                return;
            }

            if (includeCorsCredentials) {
                // Safari will not send cookies without this
                elem.crossOrigin = 'use-credentials';
            }

            const player = this;
            const guardedSourceElement = {
                set src(source) {
                    if (player.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                        player.#markPendingPlaySource(playSessionGeneration, elem);
                        elem.src = source;
                    }
                }
            };
            await applySrc(guardedSourceElement, val, options);
            if (!this.#isPlaySessionCurrent(playSessionGeneration, elem)) {
                return;
            }

            this.#currentSrc = val;
            return playWithPromise(elem, this.onError);
        }
    }

    setSubtitleStreamIndex(index) {
        this.setCurrentTrackElement(index);
    }

    setSecondarySubtitleStreamIndex(index) {
        this.setCurrentTrackElement(index, SECONDARY_TEXT_TRACK_INDEX);
    }

    resetSubtitleOffset() {
        this.#currentTrackOffset = 0;
        this.#secondaryTrackOffset = 0;
        this.#showTrackOffset = false;
    }

    enableShowingSubtitleOffset() {
        this.#showTrackOffset = true;
    }

    disableShowingSubtitleOffset() {
        this.#showTrackOffset = false;
    }

    isShowingSubtitleOffsetEnabled() {
        return this.#showTrackOffset;
    }

    /**
     * @private
     */
    getTextTracks() {
        const videoElement = this.#mediaElement;
        if (videoElement) {
            return Array.from(videoElement.textTracks)
                .filter(function (trackElement) {
                    // get showing .vtt textTack
                    return trackElement.mode === 'showing';
                });
        } else {
            return null;
        }
    }

    setSubtitleOffset = debounce(this._setSubtitleOffset, 100);

    /**
     * @private
     */
    _setSubtitleOffset(offset) {
        const offsetValue = parseFloat(offset);

        // if .ass currently rendering
        if (this.#currentAssRenderer) {
            this.updateCurrentTrackOffset(offsetValue);
            if (this.#customPlaybackActive) {
                this.#currentAssRenderer.resetRenderAheadCache?.(false);
                this.#renderCustomSpecializedSubtitles();
            } else {
                this.#currentAssRenderer.timeOffset = (this._currentPlayOptions.transcodingOffsetTicks || 0) / TICKS_PER_SECOND + offsetValue;
            }
        } else if (this.#currentPgsRenderer) {
            this.updateCurrentTrackOffset(offsetValue);
            if (this.#customPlaybackActive) {
                this.#renderCustomSpecializedSubtitles();
            } else {
                this.#currentPgsRenderer.timeOffset = (this._currentPlayOptions.transcodingOffsetTicks || 0) / TICKS_PER_SECOND + offsetValue;
            }
        } else {
            const trackElements = this.getTextTracks();
            // if .vtt currently rendering
            if (trackElements?.length > 0) {
                trackElements.forEach((trackElement, index) => {
                    this.setTextTrackSubtitleOffset(trackElement, offsetValue, index);
                });
            } else if (this.#currentTrackEvents || this.#currentSecondaryTrackEvents) {
                this.#currentTrackEvents && this.setTrackEventsSubtitleOffset(this.#currentTrackEvents, offsetValue, PRIMARY_TEXT_TRACK_INDEX);
                this.#currentSecondaryTrackEvents && this.setTrackEventsSubtitleOffset(this.#currentSecondaryTrackEvents, offsetValue, SECONDARY_TEXT_TRACK_INDEX);
            } else {
                this.updateCurrentTrackOffset(offsetValue);
                console.debug('No available track, cannot apply offset: ', offsetValue);
            }
        }
    }

    /**
     * @private
     */
    updateCurrentTrackOffset(offsetValue, currentTrackIndex = PRIMARY_TEXT_TRACK_INDEX) {
        let offsetToCompare = this.#currentTrackOffset;
        if (this.isSecondaryTrack(currentTrackIndex)) {
            offsetToCompare = this.#secondaryTrackOffset;
        }

        let relativeOffset = offsetValue;
        const newTrackOffset = offsetValue;

        if (offsetToCompare) {
            relativeOffset -= offsetToCompare;
        }

        if (this.isSecondaryTrack(currentTrackIndex)) {
            this.#secondaryTrackOffset = newTrackOffset;
        } else {
            this.#currentTrackOffset = newTrackOffset;
        }

        // relative to currentTrackOffset
        return relativeOffset;
    }

    /**
     * @private
     * These browsers will not clear the existing active cue when setting an offset
     * for native TextTracks.
     * Any previous text tracks that are on the screen when the offset changes will remain next
     * to the new tracks until they reach the end time of the new offset's instance of the track.
     */
    requiresHidingActiveCuesOnOffsetChange() {
        return !!browser.firefox;
    }

    /**
     * @private
     */
    hideTextTrackWithActiveCues(currentTrack) {
        if (currentTrack.activeCues) {
            currentTrack.mode = 'hidden';
        }
    }

    /**
     * Forces the active cue to clear by disabling then re-enabling the track.
     * The track mode is reverted inside of a 0ms timeout to free up the track
     * and allow it to disable and clear the active cue.
     * @private
     */
    forceClearTextTrackActiveCues(currentTrack, currentTrackIndex) {
        if (currentTrack.activeCues) {
            const subtitleRender = this.#captureSubtitleRender(currentTrackIndex);
            const videoElement = this.#mediaElement;
            currentTrack.mode = 'disabled';
            setTimeout(() => {
                if (!this.#isSubtitleRenderCurrent(subtitleRender, videoElement)) {
                    return;
                }

                currentTrack.mode = 'showing';
            }, 0);
        }
    }

    /**
     * @private
     */
    setTextTrackSubtitleOffset(currentTrack, offsetValue, currentTrackIndex) {
        if (currentTrack.cues) {
            offsetValue = this.updateCurrentTrackOffset(offsetValue, currentTrackIndex);
            if (offsetValue === 0) {
                return;
            }

            const shouldClearActiveCues = this.requiresHidingActiveCuesOnOffsetChange();
            if (shouldClearActiveCues) {
                this.hideTextTrackWithActiveCues(currentTrack);
            }

            Array.from(currentTrack.cues)
                .forEach(function (cue) {
                    cue.startTime -= offsetValue;
                    cue.endTime -= offsetValue;
                });

            if (shouldClearActiveCues) {
                this.forceClearTextTrackActiveCues(currentTrack, currentTrackIndex);
            }
        }
    }

    /**
     * @private
     */
    setTrackEventsSubtitleOffset(trackEvents, offsetValue, currentTrackIndex) {
        if (Array.isArray(trackEvents)) {
            offsetValue = this.updateCurrentTrackOffset(offsetValue, currentTrackIndex) * 1e7; // ticks
            if (offsetValue === 0) {
                return;
            }
            trackEvents.forEach(function (trackEvent) {
                trackEvent.StartPositionTicks -= offsetValue;
                trackEvent.EndPositionTicks -= offsetValue;
            });
        }
    }

    getSubtitleOffset() {
        return this.#currentTrackOffset;
    }

    isPrimaryTrack(textTrackIndex) {
        return textTrackIndex === PRIMARY_TEXT_TRACK_INDEX;
    }

    isSecondaryTrack(textTrackIndex) {
        return textTrackIndex === SECONDARY_TEXT_TRACK_INDEX;
    }

    /**
     * @private
     */
    isAudioStreamSupported(stream, deviceProfile, container) {
        const codec = (stream.Codec || '').toLowerCase();

        if (!codec) {
            return true;
        }

        if (!deviceProfile) {
            // This should never happen
            return true;
        }

        const profiles = deviceProfile.DirectPlayProfiles || [];

        return profiles.some(function (p) {
            return p.Type === 'Video'
                    && includesAny((p.Container || '').toLowerCase(), container)
                    && includesAny((p.AudioCodec || '').toLowerCase(), codec);
        });
    }

    /**
     * @private
     */
    getSupportedAudioStreams() {
        const profile = this.#lastProfile;

        const mediaSource = this._currentPlayOptions.mediaSource;
        const container = mediaSource.Container.toLowerCase();

        return getMediaStreamAudioTracks(mediaSource).filter((stream) => {
            return this.isAudioStreamSupported(stream, profile, container);
        });
    }

    setAudioStreamIndex(index) {
        const streams = this.getSupportedAudioStreams();

        if (streams.length < 2) {
            // If there's only one supported stream then trust that the player will handle it on it's own
            return;
        }

        let audioIndex = -1;

        for (const stream of streams) {
            audioIndex++;

            if (stream.Index === index) {
                break;
            }
        }

        if (audioIndex === -1) {
            return;
        }

        const elem = this.#mediaElement;
        if (!elem) {
            return;
        }

        // https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/audioTracks

        /**
         * @type {ArrayLike<any>|any[]}
         */
        const elemAudioTracks = elem.audioTracks || [];
        console.debug(`found ${elemAudioTracks.length} audio tracks`);

        for (const [i, audioTrack] of Array.from(elemAudioTracks).entries()) {
            if (audioIndex === i) {
                console.debug(`setting audio track ${i} to enabled`);
                audioTrack.enabled = true;
            } else {
                console.debug(`setting audio track ${i} to disabled`);
                audioTrack.enabled = false;
            }
        }
    }

    stop(destroyPlayer) {
        this.#customPlaybackActive = false;
        this.#customPlaybackPaused = true;
        this.#invalidatePlaySession(false);
        this.#invalidateSubtitleSession();
        const elem = this.#mediaElement;
        const src = this.#currentSrc;

        if (elem) {
            if (src) {
                elem.pause();
            }

            onEndedInternal(this, elem, this.onError);
            this.#currentSrc = undefined;
            this.#currentTime = null;
        }

        this.destroyCustomTrack(elem);

        if (destroyPlayer) {
            this.destroy();
        }

        return Promise.resolve();
    }

    destroy() {
        this.#customPlaybackActive = false;
        this.#customPlaybackPaused = true;
        this.#invalidatePlaySession();
        this.#invalidateSubtitleSession();
        this.setSubtitleOffset.cancel();
        this.#stopClientHDRToneMappingPostProcessing();

        destroyHlsPlayer(this);
        destroyFlvPlayer(this);

        setBackdropTransparency(TRANSPARENCY_LEVEL.None);
        document.body.classList.remove('hide-scroll');

        this.#detectedAspectRatio = null;

        const videoElement = this.#mediaElement;

        if (videoElement) {
            this.#mediaElement = null;

            this.destroyCustomTrack(videoElement);
            videoElement.removeEventListener('timeupdate', this.onTimeUpdate);
            videoElement.removeEventListener('ended', this.onEnded);
            videoElement.removeEventListener('volumechange', this.onVolumeChange);
            videoElement.removeEventListener('pause', this.onPause);
            videoElement.removeEventListener('playing', this.onPlaying);
            videoElement.removeEventListener('play', this.onPlay);
            videoElement.removeEventListener('click', this.onClick);
            videoElement.removeEventListener('dblclick', this.onDblClick);
            videoElement.removeEventListener('waiting', this.onWaiting);
            videoElement.removeEventListener('error', this.onError); // bound in htmlMediaHelper

            resetSrc(videoElement);

            videoElement.parentNode.removeChild(videoElement);
        }

        this.#currentSrc = undefined;
        this.#currentTime = null;
        this._currentPlayOptions = null;

        const dlg = this.#videoDialog;
        if (dlg) {
            this.#videoDialog = null;
            dlg.parentNode.removeChild(dlg);
        }

        if (Screenfull.isEnabled) {
            Screenfull.exit();
        } else if (document.webkitIsFullScreen && document.webkitCancelFullscreen) {
            // iOS Safari
            document.webkitCancelFullscreen();
        }
    }

    /**
     * Applies curve-derived global desaturation and follows strength changes
     * without restarting the active stream.
     * @private
     */
    #startClientHDRToneMappingPostProcessing(
        videoElement,
        preset,
        bt2390Parameters
    ) {
        this.#stopClientHDRToneMappingPostProcessing();

        const resolvedPreset = resolveClientHDRToneMappingPreset(preset);
        const updateSaturation = () => {
            const saturation = calculateClientHDRToneMappingSaturation(
                resolvedPreset,
                bt2390Parameters,
                userSettings.clientHDRToneMappingDesaturationStrength()
            );

            if (
                this.#clientHDRToneMappingPostProcessingElement !== videoElement
                || this.#clientHDRToneMappingPostProcessingSaturation
                    === saturation
            ) {
                return;
            }

            this.#clientHDRToneMappingPostProcessingSaturation = saturation;
            videoElement.style.setProperty(
                CLIENT_HDR_TONE_MAPPING_SATURATION_PROPERTY,
                saturation.toFixed(6)
            );
            videoElement.classList.toggle(
                CLIENT_HDR_TONE_MAPPING_POST_PROCESSING_CLASS,
                saturation < 1
            );
            console.debug(
                `client HDR tone-mapping CSS saturation: ${saturation.toFixed(3)}`
            );
        };

        this.#clientHDRToneMappingPostProcessingElement = videoElement;
        updateSaturation();
        this.#clientHDRToneMappingPostProcessingInterval = window.setInterval(
            updateSaturation,
            CLIENT_HDR_TONE_MAPPING_POST_PROCESSING_INTERVAL_MS
        );
    }

    /**
     * Removes the post-processing state from the current video element.
     * @private
     */
    #stopClientHDRToneMappingPostProcessing() {
        if (this.#clientHDRToneMappingPostProcessingInterval !== undefined) {
            window.clearInterval(
                this.#clientHDRToneMappingPostProcessingInterval
            );
            this.#clientHDRToneMappingPostProcessingInterval = undefined;
        }

        const videoElement =
            this.#clientHDRToneMappingPostProcessingElement;
        if (videoElement) {
            videoElement.classList.remove(
                CLIENT_HDR_TONE_MAPPING_POST_PROCESSING_CLASS
            );
            videoElement.style.removeProperty(
                CLIENT_HDR_TONE_MAPPING_SATURATION_PROPERTY
            );
        }

        this.#clientHDRToneMappingPostProcessingElement = undefined;
        this.#clientHDRToneMappingPostProcessingSaturation = undefined;
    }

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onEnded = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        this.#invalidatePlaySession(false);
        this.#invalidateSubtitleSession();
        this.destroyCustomTrack(elem);
        onEndedInternal(this, elem, this.onError);
        this.#currentSrc = undefined;
        this.#currentTime = null;
    };

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onTimeUpdate = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        // get the player position and the transcoding offset
        const time = getHLSPlaybackPosition(this._hlsPlayer, elem.currentTime);

        if (time && !this.#timeUpdated) {
            this.#timeUpdated = true;
            this.ensureValidVideo(elem);
        }

        this.#currentTime = time;

        const currentPlayOptions = this._currentPlayOptions;
        // Not sure yet how this is coming up null since we never null it out, but it is causing app crashes
        if (currentPlayOptions) {
            let timeMs = time * 1000;
            timeMs += ((currentPlayOptions.transcodingOffsetTicks || 0) / 10000);
            this.updateSubtitleText(timeMs);
        }

        Events.trigger(this, 'timeupdate');
    };

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onVolumeChange = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        saveVolume(elem.volume);
        Events.trigger(this, 'volumechange');
    };

    /**
     * @private
     */
    onNavigatedToOsd = () => {
        const dlg = this.#videoDialog;
        if (dlg) {
            dlg.classList.remove('videoPlayerContainer-onTop');

            this.onStartedAndNavigatedToOsd();
        }
    };

    /**
     * @private
     */
    onStartedAndNavigatedToOsd() {
        // If this causes a failure during navigation we end up in an awkward UI state
        this.setCurrentTrackElement(this.#subtitleTrackIndexToSetOnPlaying);

        if (this.#audioTrackIndexToSetOnPlaying != null && this.canSetAudioStreamIndex()) {
            this.setAudioStreamIndex(this.#audioTrackIndexToSetOnPlaying);
        }

        if (this.#secondarySubtitleTrackIndexToSetOnPlaying != null && this.#secondarySubtitleTrackIndexToSetOnPlaying >= 0) {
            const secondarySubtitleTrackIndex = this.#secondarySubtitleTrackIndexToSetOnPlaying;
            const subtitleSessionGeneration = this.#subtitleSessionGeneration;
            const videoElement = this.#mediaElement;
            /**
             * Using a 0ms timeout to set the secondary subtitles because of some weird race condition when
             * setting both primary and secondary tracks at the same time.
             * The `TextTrack` content and cues will somehow get mixed up and each track will play a mix of both languages.
             * Putting this in a timeout fixes it completely.
             */
            setTimeout(() => {
                if (
                    subtitleSessionGeneration !== this.#subtitleSessionGeneration
                    || videoElement !== this.#mediaElement
                ) {
                    return;
                }

                this.setSecondarySubtitleStreamIndex(secondarySubtitleTrackIndex);
            }, 0);
        }
    }

    /**
     * Activates the existing Jellyfin playback UI for a source decoded by a
     * composed player rather than by the owned video element.
     *
     * @param {boolean} emitUnpause
     * @returns {boolean}
     */
    notifyCustomPlaybackPlaying(emitUnpause = true) {
        if (!this.#customPlaybackActive || !this.#mediaElement) {
            return false;
        }

        this.#customPlaybackPaused = false;
        if (emitUnpause) {
            Events.trigger(this, 'unpause');
        }
        this.#startPlaybackPresentation(this.#mediaElement, false);
        this.#updateCustomAssPlaybackState();
        Events.trigger(this, 'playing');
        return true;
    }

    /** Updates DOM subtitles and forwards one custom-clock time event. */
    notifyCustomPlaybackTimeUpdate(timeMilliseconds) {
        if (!this.#customPlaybackActive || !Number.isFinite(timeMilliseconds)) {
            return false;
        }

        this.#currentTime = timeMilliseconds / 1000;
        const transcodingOffsetMilliseconds = (this._currentPlayOptions?.transcodingOffsetTicks || 0) / 10000;
        this.updateSubtitleText(timeMilliseconds + transcodingOffsetMilliseconds);
        this.#renderCustomSpecializedSubtitles(timeMilliseconds);
        Events.trigger(this, 'timeupdate');
        return true;
    }

    /** Forwards a custom-clock pause without touching the source-less video. */
    notifyCustomPlaybackPaused() {
        if (!this.#customPlaybackActive) {
            return false;
        }

        this.#customPlaybackPaused = true;
        this.#updateCustomAssPlaybackState();
        Events.trigger(this, 'pause');
        return true;
    }

    /** Forwards custom decoder starvation to the normal Jellyfin event path. */
    notifyCustomPlaybackWaiting() {
        if (!this.#customPlaybackActive) {
            return false;
        }

        this.#customPlaybackPaused = true;
        this.#updateCustomAssPlaybackState();
        Events.trigger(this, 'waiting');
        return true;
    }

    /** Forwards custom output gain changes through the normal player event. */
    notifyCustomPlaybackVolumeChange() {
        if (!this.#customPlaybackActive) {
            return false;
        }

        Events.trigger(this, 'volumechange');
        return true;
    }

    /** Ends a custom source exactly once through the HTML player's stop path. */
    notifyCustomPlaybackEnded() {
        const elem = this.#mediaElement;
        if (!this.#customPlaybackActive || !elem) {
            return false;
        }

        this.#customPlaybackActive = false;
        this.#customPlaybackPaused = true;
        this.#invalidatePlaySession(false);
        this.#invalidateSubtitleSession();
        this.destroyCustomTrack(elem);
        onEndedInternal(this, elem, this.onError);
        this.#currentSrc = undefined;
        this.#currentTime = null;
        return true;
    }

    /** Returns the exact custom-clock time expected by specialized renderers. */
    #getCustomSubtitleTimeSeconds(timeMilliseconds = (this.#currentTime || 0) * MILLISECONDS_PER_SECOND) {
        const transcodingOffsetSeconds = (this._currentPlayOptions?.transcodingOffsetTicks || 0)
            / TICKS_PER_SECOND;
        const subtitleOffsetSeconds = Number.isFinite(this.#currentTrackOffset) ?
            this.#currentTrackOffset :
            0;
        return timeMilliseconds / MILLISECONDS_PER_SECOND
            + transcodingOffsetSeconds
            + subtitleOffsetSeconds;
    }

    /** Creates a canvas owned by one source-less subtitle renderer. */
    #createCustomSubtitleCanvas(videoElement) {
        const canvas = document.createElement('canvas');
        canvas.classList.add(CUSTOM_SUBTITLE_CANVAS_CLASS);
        canvas.setAttribute('aria-hidden', 'true');
        videoElement.parentElement?.appendChild(canvas);
        this.#synchronizeCustomSubtitleCanvas(canvas, videoElement);
        return canvas;
    }

    /** Creates the minimal media clock consumed by libpgs. */
    #createCustomPgsClock() {
        const clock = /** @type {EventTarget & { currentTime: number }} */ (new EventTarget());
        Object.defineProperty(clock, 'currentTime', {
            configurable: false,
            enumerable: true,
            value: this.#getCustomSubtitleTimeSeconds(),
            writable: true
        });
        return clock;
    }

    /** Aligns a source-less subtitle canvas with the owned video surface. */
    #synchronizeCustomSubtitleCanvas(canvas, videoElement) {
        const container = videoElement.parentElement;
        if (!container) {
            return null;
        }

        const containerRectangle = container.getBoundingClientRect();
        const videoRectangle = videoElement.getBoundingClientRect();
        const containerScaleX = container.clientWidth > 0 ?
            containerRectangle.width / container.clientWidth :
            1;
        const containerScaleY = container.clientHeight > 0 ?
            containerRectangle.height / container.clientHeight :
            1;
        const normalizedScaleX = containerScaleX > 0 ? containerScaleX : 1;
        const normalizedScaleY = containerScaleY > 0 ? containerScaleY : 1;
        const fallbackWidth = videoElement.clientWidth || container.clientWidth;
        const fallbackHeight = videoElement.clientHeight || container.clientHeight;
        const width = Math.max(
            MINIMUM_SUBTITLE_CANVAS_DIMENSION,
            videoRectangle.width > 0 ? videoRectangle.width / normalizedScaleX : fallbackWidth
        );
        const height = Math.max(
            MINIMUM_SUBTITLE_CANVAS_DIMENSION,
            videoRectangle.height > 0 ? videoRectangle.height / normalizedScaleY : fallbackHeight
        );
        const left = videoRectangle.width > 0 ?
            (videoRectangle.left - containerRectangle.left) / normalizedScaleX :
            videoElement.offsetLeft;
        const top = videoRectangle.height > 0 ?
            (videoRectangle.top - containerRectangle.top) / normalizedScaleY :
            videoElement.offsetTop;

        canvas.style.left = `${left}px`;
        canvas.style.top = `${top}px`;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        return { height, width };
    }

    /** Keeps source-less subtitle canvases aligned after aspect or viewport changes. */
    #synchronizeCustomSubtitleCanvases() {
        if (!this.#customPlaybackActive || !this.#mediaElement) {
            return;
        }

        if (this.#currentAssCanvas) {
            const geometry = this.#synchronizeCustomSubtitleCanvas(
                this.#currentAssCanvas,
                this.#mediaElement
            );
            if (geometry && this.#currentAssRenderer?.resize) {
                const pixelRatio = Math.max(window.devicePixelRatio || 1, 1);
                const width = Math.max(
                    MINIMUM_SUBTITLE_CANVAS_DIMENSION,
                    Math.round(geometry.width * pixelRatio)
                );
                const height = Math.max(
                    MINIMUM_SUBTITLE_CANVAS_DIMENSION,
                    Math.round(geometry.height * pixelRatio)
                );
                this.#currentAssRenderer.resize(width, height, 0, 0);
            }
        }

        if (this.#currentPgsCanvas) {
            this.#synchronizeCustomSubtitleCanvas(this.#currentPgsCanvas, this.#mediaElement);
        }
    }

    /** Advances ASS/SSA and PGS renderers from the source-less custom clock. */
    #renderCustomSpecializedSubtitles(
        timeMilliseconds = (this.#currentTime || 0) * MILLISECONDS_PER_SECOND
    ) {
        if (!this.#customPlaybackActive) {
            return;
        }

        this.#synchronizeCustomSubtitleCanvases();
        const timeSeconds = this.#getCustomSubtitleTimeSeconds(timeMilliseconds);
        if (this.#currentAssRenderer?.setCurrentTime) {
            this.#currentAssRenderer.setCurrentTime(timeSeconds);
        }
        if (this.#currentPgsClock) {
            this.#currentPgsClock.currentTime = timeSeconds;
            this.#currentPgsClock.dispatchEvent(new Event('timeupdate'));
        } else if (this.#currentPgsRenderer?.renderAtTimestamp) {
            this.#currentPgsRenderer.renderAtTimestamp(timeSeconds);
        }
    }

    /** Keeps libass animations and render-ahead state aligned with playback. */
    #updateCustomAssPlaybackState() {
        if (!this.#customPlaybackActive || !this.#currentAssRenderer?.setIsPaused) {
            return;
        }

        this.#currentAssRenderer.setIsPaused(
            this.#customPlaybackPaused,
            this.#getCustomSubtitleTimeSeconds()
        );
    }

    /**
     * @private
     */
    #startPlaybackPresentation(elem, seekNativeSource) {
        if (this.#started) {
            return;
        }

        this.#started = true;
        elem.removeAttribute('controls');
        loading.hide();

        if (seekNativeSource) {
            seekOnPlaybackStart(this, elem, this._currentPlayOptions.playerStartPositionTicks, () => {
                if (this.#currentAssRenderer) {
                    this.#currentAssRenderer.timeOffset = (this._currentPlayOptions.transcodingOffsetTicks || 0) / 10000000 + this.#currentTrackOffset;
                    this.#currentAssRenderer.resize();
                    this.#currentAssRenderer.resetRenderAheadCache(false);
                }
            });
        }

        if (this._currentPlayOptions.fullscreen) {
            const subtitleSessionGeneration = this.#subtitleSessionGeneration;
            const videoElement = this.#mediaElement;
            appRouter.showVideoOsd().then(() => {
                if (
                    subtitleSessionGeneration !== this.#subtitleSessionGeneration
                    || videoElement !== this.#mediaElement
                ) {
                    return;
                }

                this.onNavigatedToOsd();
            });
        } else {
            setBackdropTransparency(TRANSPARENCY_LEVEL.Backdrop);
            this.#videoDialog.classList.remove('videoPlayerContainer-onTop');
            this.onStartedAndNavigatedToOsd();
        }
    }

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onPlaying = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        this.#startPlaybackPresentation(elem, true);
        // Reapply detected aspect ratio now that video dimensions are available
        if (this.getAspectRatio() === 'detected') {
            this.#applyAspectRatio('detected');
        }
        Events.trigger(this, 'playing');
    };

    /**
     * @private
     */
    onPlay = () => {
        if (this._currentPlayOptions?.suppressInitialUnpause === true) {
            this._currentPlayOptions.suppressInitialUnpause = false;
            return;
        }
        Events.trigger(this, 'unpause');
    };

    /**
     * @private
     */
    ensureValidVideo(elem) {
        if (elem !== this.#mediaElement) {
            return;
        }

        if (elem.videoWidth === 0 && elem.videoHeight === 0) {
            const mediaSource = this._currentPlayOptions?.mediaSource;

            // Only trigger this if there is media info
            // Avoid triggering in situations where it might not actually have a video stream (audio only live tv channel)
            if (!mediaSource || mediaSource.RunTimeTicks) {
                this.#invalidatePlaySession(false);
                onErrorInternal(this, MediaError.NO_MEDIA_ERROR);
            }
        }
    }

    /**
     * @private
     */
    onClick = () => {
        Events.trigger(this, 'click');
    };

    /**
     * @private
     */
    onDblClick = () => {
        Events.trigger(this, 'dblclick');
    };

    /**
     * @private
     */
    onPause = () => {
        Events.trigger(this, 'pause');
    };

    onWaiting = () => {
        Events.trigger(this, 'waiting');
    };

    /**
     * @private
     * @param e {Event} The event received from the `<video>` element
     */
    onError = (e) => {
        /**
         * @type {HTMLMediaElement}
         */
        const elem = e.target;
        const errorCode = elem.error ? (elem.error.code || 0) : 0;
        const errorMessage = elem.error ? (elem.error.message || '') : '';
        console.error(`media element error: ${errorCode} ${errorMessage}`);

        let type;

        switch (errorCode) {
            case 1:
                // MEDIA_ERR_ABORTED
                // This will trigger when changing media while something is playing
                return;
            case 2:
                // MEDIA_ERR_NETWORK
                type = MediaError.NETWORK_ERROR;
                break;
            case 3:
                // MEDIA_ERR_DECODE
                if (this._hlsPlayer) {
                    handleHlsJsMediaError(this);
                    return;
                } else {
                    type = MediaError.MEDIA_DECODE_ERROR;
                }
                break;
            case 4:
                // MEDIA_ERR_SRC_NOT_SUPPORTED
                type = MediaError.MEDIA_NOT_SUPPORTED;
                break;
            default:
                // seeing cases where Edge is firing error events with no error code
                // example is start playing something, then immediately change src to something else
                return;
        }

        this.#invalidatePlaySession(false);
        this.#invalidateSubtitleSession();
        onErrorInternal(this, type);
    };

    /**
     * @private
     */
    destroyCustomRenderedTrackElements(targetTrackIndex) {
        if (this.isPrimaryTrack(targetTrackIndex)) {
            if (this.#videoSubtitlesElem) {
                tryRemoveElement(this.#videoSubtitlesElem);
                this.#videoSubtitlesElem = null;
            }
        } else if (this.isSecondaryTrack(targetTrackIndex)) {
            if (this.#videoSecondarySubtitlesElem) {
                tryRemoveElement(this.#videoSecondarySubtitlesElem);
                this.#videoSecondarySubtitlesElem = null;
            }
        } else if (this.#videoSubtitlesElem) {
            // destroy all
            const subtitlesContainer = this.#videoSubtitlesElem.parentNode;
            if (subtitlesContainer) {
                tryRemoveElement(subtitlesContainer);
            }
            this.#videoSubtitlesElem = null;
            this.#videoSecondarySubtitlesElem = null;
        }
    }

    /**
     * @private
     */
    destroyNativeTracks(videoElement, targetTrackIndex) {
        if (videoElement) {
            const destroySingleTrack = typeof targetTrackIndex === 'number';
            const allTracks = videoElement.textTracks || []; // get list of tracks
            for (let index = 0; index < allTracks.length; index++) {
                const track = allTracks[index];
                // Skip all other tracks if we are targeting just one
                if (destroySingleTrack && targetTrackIndex !== index) {
                    continue;
                }
                if (track.label.includes('manualTrack')) {
                    track.mode = 'disabled';
                }
            }
        }
    }

    /**
     * @private
     */
    destroyStoredTrackInfo(targetTrackIndex) {
        if (this.isPrimaryTrack(targetTrackIndex)) {
            this.#customTrackIndex = -1;
            this.#currentTrackEvents = null;
        } else if (this.isSecondaryTrack(targetTrackIndex)) {
            this.#customSecondaryTrackIndex = -1;
            this.#currentSecondaryTrackEvents = null;
        } else { // destroy all
            this.#customTrackIndex = -1;
            this.#customSecondaryTrackIndex = -1;
            this.#currentTrackEvents = null;
            this.#currentSecondaryTrackEvents = null;
        }
    }

    /**
     * @private
     */
    destroyCustomTrack(videoElement, targetTrackIndex) {
        this.#invalidateSubtitleRender(targetTrackIndex);
        this.destroyCustomRenderedTrackElements(targetTrackIndex);
        this.destroyNativeTracks(videoElement, targetTrackIndex);
        this.destroyStoredTrackInfo(targetTrackIndex);

        const octopus = this.#currentAssRenderer;
        this.#currentAssRenderer = null;
        const assCanvas = this.#currentAssCanvas;
        this.#currentAssCanvas = null;
        if (octopus) {
            octopus.dispose();
        }
        assCanvas?.remove();

        const pgsRenderer = this.#currentPgsRenderer;
        this.#currentPgsRenderer = null;
        const pgsCanvas = this.#currentPgsCanvas;
        this.#currentPgsCanvas = null;
        this.#currentPgsClock = null;
        if (pgsRenderer) {
            pgsRenderer.dispose();
        }
        pgsCanvas?.remove();
    }

    /**
     * @private
     */
    fetchSubtitlesUwp(track) {
        return Windows.Storage.StorageFile.getFileFromPathAsync(track.Path).then(function (storageFile) {
            return Windows.Storage.FileIO.readTextAsync(storageFile);
        }).then(function (text) {
            return JSON.parse(text);
        });
    }

    /**
     * @private
     */
    async fetchSubtitles(track, item, subtitleRender) {
        if (window.Windows && itemHelper.isLocalItem(item)) {
            return this.fetchSubtitlesUwp(track, item);
        }

        const sessionGeneration = subtitleRender.sessionGeneration;
        this.incrementFetchQueue(sessionGeneration);
        try {
            const response = await fetch(getTextTrackUrl(track, item, '.js'));

            if (!response.ok) {
                throw new Error(response);
            }

            return response.json();
        } finally {
            this.decrementFetchQueue(sessionGeneration);
        }
    }

    /**
     * @private
     */
    setTrackForDisplay(videoElement, track, targetTextTrackIndex = PRIMARY_TEXT_TRACK_INDEX, subtitleSelection) {
        if (subtitleSelection && !this.#isSubtitleSelectionCurrent(subtitleSelection)) {
            return;
        }

        if (!track) {
            // Destroy all tracks by passing undefined if there is no valid primary track
            this.destroyCustomTrack(videoElement, this.isSecondaryTrack(targetTextTrackIndex) ? targetTextTrackIndex : undefined);
            return;
        }

        let targetTrackIndex = this.#customTrackIndex;
        if (this.isSecondaryTrack(targetTextTrackIndex)) {
            targetTrackIndex = this.#customSecondaryTrackIndex;
        }

        // skip if already playing this track
        if (targetTrackIndex === track.Index) {
            return;
        }

        this.resetSubtitleOffset();
        const item = this._currentPlayOptions.item;

        this.destroyCustomTrack(videoElement, targetTextTrackIndex);

        if (this.isSecondaryTrack(targetTextTrackIndex)) {
            this.#customSecondaryTrackIndex = track.Index;
        } else {
            this.#customTrackIndex = track.Index;
        }
        const subtitleRender = this.#beginSubtitleRender(targetTextTrackIndex);
        this.renderTracksEvents(videoElement, track, item, targetTextTrackIndex, subtitleRender);
    }

    /** Installs one generation-owned ASS renderer. */
    #installAssRenderer(SubtitlesOctopus, options, videoElement, subtitleRender) {
        if (!this.#isSubtitleRenderCurrent(subtitleRender, videoElement)) {
            return;
        }

        const customCanvas = this.#customPlaybackActive ?
            this.#createCustomSubtitleCanvas(videoElement) :
            null;
        const rendererOptions = customCanvas ? {
            ...options,
            canvas: customCanvas,
            renderAhead: 0,
            timeOffset: 0
        } : {
            ...options,
            video: videoElement
        };
        let renderer;
        try {
            renderer = new SubtitlesOctopus(rendererOptions);
        } catch (error) {
            customCanvas?.remove();
            throw error;
        }

        if (!this.#isSubtitleRenderCurrent(subtitleRender, videoElement)) {
            renderer.dispose();
            customCanvas?.remove();
            return;
        }

        this.#currentAssRenderer = renderer;
        this.#currentAssCanvas = customCanvas;
        if (customCanvas) {
            this.#synchronizeCustomSubtitleCanvases();
            this.#renderCustomSpecializedSubtitles();
            this.#updateCustomAssPlaybackState();
        }
    }

    /**
     * @private
     */
    renderSsaAss(videoElement, track, item, subtitleRender) {
        const supportedFonts = ['application/vnd.ms-opentype', 'application/x-truetype-font', 'font/otf', 'font/ttf', 'font/woff', 'font/woff2'];
        const availableFonts = [];
        const mediaSource = this._currentPlayOptions.mediaSource;
        const attachments = mediaSource.MediaAttachments || [];
        const transcodingOffsetTicks = this._currentPlayOptions.transcodingOffsetTicks || 0;
        const apiClient = ServerConnections.getApiClient(item);
        attachments.forEach(i => {
            // we only require font files and ignore embedded media attachments like covers as there are cases where ffmpeg fails to extract those
            if (supportedFonts.includes(i.MimeType)) {
                // embedded font url
                availableFonts.push(apiClient.getUrl(i.DeliveryUrl));
            }
        });
        const fallbackFontList = apiClient.getUrl('/FallbackFont/Fonts', {
            ApiKey: apiClient.accessToken()
        });
        const htmlVideoPlayer = this;
        import('@jellyfin/libass-wasm').then(({ default: SubtitlesOctopus }) => {
            if (!this.#isSubtitleRenderCurrent(subtitleRender, videoElement)) {
                return;
            }

            const videoStream = getMediaStreamVideoTracks(mediaSource)[0];

            const options = {
                subUrl: getTextTrackUrl(track, item),
                fonts: availableFonts,
                workerUrl: `${appRouter.baseUrl()}/libraries/subtitles-octopus-worker.js`,
                legacyWorkerUrl: `${appRouter.baseUrl()}/libraries/subtitles-octopus-worker-legacy.js`,
                onError() {
                    if (!htmlVideoPlayer.#isSubtitleRenderCurrent(subtitleRender, videoElement)) {
                        return;
                    }

                    // HACK: Clear JavascriptSubtitlesOctopus: it gets disposed when an error occurs
                    htmlVideoPlayer.#currentAssRenderer = null;
                    const assCanvas = htmlVideoPlayer.#currentAssCanvas;
                    htmlVideoPlayer.#currentAssCanvas = null;
                    assCanvas?.remove();

                    // HACK: Give JavascriptSubtitlesOctopus time to dispose itself
                    setTimeout(() => {
                        if (!htmlVideoPlayer.#isSubtitleRenderCurrent(subtitleRender, videoElement)) {
                            return;
                        }

                        onErrorInternal(htmlVideoPlayer, MediaError.ASS_RENDER_ERROR);
                    }, 0);
                },
                timeOffset: transcodingOffsetTicks / 10000000,

                // new octopus options; override all, even defaults
                renderMode: 'wasm-blend',
                dropAllAnimations: false,
                libassMemoryLimit: 40,
                libassGlyphLimit: 40,
                targetFps: videoStream?.ReferenceFrameRate || 24,
                prescaleFactor: 0.8,
                prescaleHeightLimit: 1080,
                maxRenderHeight: 2160,
                resizeVariation: 0.2,
                renderAhead: 90
            };

            Promise.all([
                apiClient.getNamedConfiguration('encoding'),
                // Worker in Tizen 5 doesn't resolve relative path with async request
                resolveUrl(options.workerUrl),
                resolveUrl(options.legacyWorkerUrl)
            ]).then(([config, workerUrl, legacyWorkerUrl]) => {
                if (!this.#isSubtitleRenderCurrent(subtitleRender, videoElement)) {
                    return;
                }

                options.workerUrl = workerUrl;
                options.legacyWorkerUrl = legacyWorkerUrl;

                if (config.EnableFallbackFont) {
                    apiClient.getJSON(fallbackFontList).then((fontFiles = []) => {
                        if (!this.#isSubtitleRenderCurrent(subtitleRender, videoElement)) {
                            return;
                        }

                        fontFiles.forEach(font => {
                            const fontUrl = apiClient.getUrl(`/FallbackFont/Fonts/${encodeURIComponent(font.Name)}`, {
                                ApiKey: apiClient.accessToken()
                            });
                            availableFonts.push(fontUrl);
                        });
                        this.#installAssRenderer(
                            SubtitlesOctopus,
                            options,
                            videoElement,
                            subtitleRender
                        );
                    });
                } else {
                    this.#installAssRenderer(
                        SubtitlesOctopus,
                        options,
                        videoElement,
                        subtitleRender
                    );
                }
            });
        });
    }

    /**
     * @private
     */
    renderPgs(videoElement, track, item, subtitleRender) {
        const selectedAspectRatio = this.getAspectRatio();
        const transcodingOffsetTicks = this._currentPlayOptions.transcodingOffsetTicks || 0;
        import('libpgs').then((libpgs) => {
            if (!this.#isSubtitleRenderCurrent(subtitleRender, videoElement)) {
                return;
            }

            const aspectRatio = selectedAspectRatio === 'auto' || selectedAspectRatio === 'detected' ? 'contain' : selectedAspectRatio;
            const customCanvas = this.#customPlaybackActive ?
                this.#createCustomSubtitleCanvas(videoElement) :
                null;
            const customClock = customCanvas ? this.#createCustomPgsClock() : null;
            const options = {
                subUrl: getTextTrackUrl(track, item),
                workerUrl: `${appRouter.baseUrl()}/libraries/libpgs.worker.js`,
                timeOffset: customCanvas ? 0 : transcodingOffsetTicks / TICKS_PER_SECOND,
                aspectRatio
            };
            if (customCanvas) {
                options.canvas = customCanvas;
                // libpgs re-renders when async subtitle timestamps arrive by reading
                // this clock, while Jellyfin remains the sole owner of its updates.
                options.video = customClock;
            } else {
                options.video = videoElement;
            }

            let renderer;
            try {
                renderer = new libpgs.PgsRenderer(options);
            } catch (error) {
                customCanvas?.remove();
                throw error;
            }

            if (!this.#isSubtitleRenderCurrent(subtitleRender, videoElement)) {
                renderer.dispose();
                customCanvas?.remove();
                return;
            }

            this.#currentPgsRenderer = renderer;
            this.#currentPgsCanvas = customCanvas;
            this.#currentPgsClock = customClock;
            if (customCanvas) {
                this.#synchronizeCustomSubtitleCanvases();
                this.#renderCustomSpecializedSubtitles();
            }
        });
    }

    /**
     * @private
     */
    renderSubtitlesWithCustomElement(videoElement, track, item, targetTextTrackIndex, subtitleRender) {
        this.fetchSubtitles(track, item, subtitleRender).then((subtitleData) => {
            if (!this.#isSubtitleRenderCurrent(subtitleRender, videoElement)) {
                return;
            }

            const subtitleAppearance = userSettings.getSubtitleAppearanceSettings();
            const subtitleVerticalPosition = parseInt(subtitleAppearance.verticalPosition, 10);

            if (!this.#videoSubtitlesElem && !this.isSecondaryTrack(targetTextTrackIndex)) {
                let subtitlesContainer = this.#videoDialog?.querySelector('.videoSubtitles');
                if (!subtitlesContainer) {
                    subtitlesContainer = document.createElement('div');
                    subtitlesContainer.classList.add('videoSubtitles');
                }
                const subtitlesElement = document.createElement('div');
                subtitlesElement.classList.add('videoSubtitlesInner');
                subtitlesContainer.appendChild(subtitlesElement);
                this.#videoSubtitlesElem = subtitlesElement;
                this.setSubtitleAppearance(subtitlesContainer, this.#videoSubtitlesElem);
                videoElement.parentNode.appendChild(subtitlesContainer);
                this.#currentTrackEvents = subtitleData.TrackEvents;
            } else if (!this.#videoSecondarySubtitlesElem && this.isSecondaryTrack(targetTextTrackIndex)) {
                const subtitlesContainer = this.#videoDialog?.querySelector('.videoSubtitles');
                if (!subtitlesContainer) return;
                const secondarySubtitlesElement = document.createElement('div');
                secondarySubtitlesElement.classList.add('videoSecondarySubtitlesInner');
                // determine the order of the subtitles
                if (subtitleVerticalPosition < 0) {
                    subtitlesContainer.insertBefore(secondarySubtitlesElement, subtitlesContainer.firstChild);
                } else {
                    subtitlesContainer.appendChild(secondarySubtitlesElement);
                }
                this.#videoSecondarySubtitlesElem = secondarySubtitlesElement;
                this.setSubtitleAppearance(subtitlesContainer, this.#videoSecondarySubtitlesElem);
                this.#currentSecondaryTrackEvents = subtitleData.TrackEvents;
            }
        });
    }

    /**
     * @private
     */
    setSubtitleAppearance(elem, innerElem) {
        subtitleAppearanceHelper.applyStyles({
            text: innerElem,
            window: elem
        }, userSettings.getSubtitleAppearanceSettings());
    }

    /**
     * @private
     */
    getCueCss(appearance, selector) {
        return `${selector}::cue {
                ${appearance.text.map((s) => s.value !== undefined && s.value !== '' ? `${s.name}:${s.value}!important;` : '').join('')}
            }`;
    }

    /**
     * @private
     */
    setCueAppearance() {
        const elementId = `${this.id}-cuestyle`;

        let styleElem = document.querySelector(`#${elementId}`);
        if (!styleElem) {
            styleElem = document.createElement('style');
            styleElem.id = elementId;
            document.getElementsByTagName('head')[0].appendChild(styleElem);
        }

        styleElem.innerHTML = this.getCueCss(subtitleAppearanceHelper.getStyles(userSettings.getSubtitleAppearanceSettings()), '.htmlvideoplayer');
    }

    /**
     * @private
     */
    async renderTracksEvents(videoElement, track, item, targetTextTrackIndex = PRIMARY_TEXT_TRACK_INDEX, subtitleRender) {
        const supportsSpecializedRenderer = !itemHelper.isLocalItem(item) || track.IsExternal;
        if (supportsSpecializedRenderer) {
            const format = (track.Codec || '').toLowerCase();
            if (format === 'ssa' || format === 'ass') {
                this.renderSsaAss(videoElement, track, item, subtitleRender);
                return;
            }
            if (format === 'pgssub') {
                this.renderPgs(videoElement, track, item, subtitleRender);
                return;
            }
        }

        if (this.#forceCustomSubtitleElements || (supportsSpecializedRenderer && useCustomSubtitles(userSettings))) {
            this.renderSubtitlesWithCustomElement(videoElement, track, item, targetTextTrackIndex, subtitleRender);
            return;
        }

        let trackElement = null;
        const updatingTrack = videoElement.textTracks && videoElement.textTracks.length > (this.isSecondaryTrack(targetTextTrackIndex) ? 1 : 0);
        if (updatingTrack) {
            trackElement = videoElement.textTracks[targetTextTrackIndex];
            // This throws an error in IE, but is fine in chrome
            // In IE it's not necessary anyway because changing the src seems to be enough
            try {
                trackElement.mode = 'showing';
                while (trackElement.cues.length) {
                    trackElement.removeCue(trackElement.cues[0]);
                }
            } catch (e) {
                console.error('error removing cue from textTrack', e);
            }

            trackElement.mode = 'disabled';
        } else {
            // There is a function addTextTrack but no function for removeTextTrack
            // Therefore we add ONE element and replace its cue data
            trackElement = videoElement.addTextTrack('subtitles', 'manualTrack', 'und');
        }

        // download the track json
        this.fetchSubtitles(track, item, subtitleRender).then(data => {
            if (!this.#isSubtitleRenderCurrent(subtitleRender, videoElement)) {
                return;
            }

            console.debug(`downloaded ${data.TrackEvents.length} track events`);

            const subtitleAppearance = userSettings.getSubtitleAppearanceSettings();
            const cueLine = parseInt(subtitleAppearance.verticalPosition, 10);

            // add some cues to show the text
            // in safari, the cues need to be added before setting the track mode to showing
            for (const trackEvent of data.TrackEvents) {
                const TrackCue = window.VTTCue || window.TextTrackCue;
                const text = normalizeTrackEventText(trackEvent.Text, false);
                const cue = new TrackCue(trackEvent.StartPositionTicks / 10000000, trackEvent.EndPositionTicks / 10000000, text);

                if (cue.line === 'auto') {
                    if (cueLine < 0) {
                        const lineCount = (text.match(/\n/g) || []).length;
                        cue.line = cueLine - lineCount;
                    } else {
                        cue.line = cueLine;
                    }
                }

                trackElement.addCue(cue);
            }

            trackElement.mode = 'showing';
        });
    }

    /**
     * @private
     */
    updateSubtitleText(timeMs) {
        const allTrackEvents = [this.#currentTrackEvents, this.#currentSecondaryTrackEvents];
        const subtitleTextElements = [this.#videoSubtitlesElem, this.#videoSecondarySubtitlesElem];

        for (let i = 0; i < allTrackEvents.length; i++) {
            const trackEvents = allTrackEvents[i];
            const subtitleTextElement = subtitleTextElements[i];

            if (trackEvents && subtitleTextElement) {
                const ticks = timeMs * 10000;
                let selectedTrackEvent;
                for (const trackEvent of trackEvents) {
                    if (trackEvent.StartPositionTicks <= ticks && trackEvent.EndPositionTicks >= ticks) {
                        selectedTrackEvent = trackEvent;
                        break;
                    }
                }

                if (selectedTrackEvent?.Text) {
                    subtitleTextElement.innerHTML = DOMPurify.sanitize(
                        normalizeTrackEventText(selectedTrackEvent.Text, true));
                    subtitleTextElement.classList.remove('hide');
                } else {
                    subtitleTextElement.classList.add('hide');
                }
            }
        }
    }

    /**
     * @private
     */
    setCurrentTrackElement(streamIndex, targetTextTrackIndex) {
        console.debug(`setting new text track index to: ${streamIndex}`);

        const normalizedTargetTextTrackIndex = this.isSecondaryTrack(targetTextTrackIndex) ? SECONDARY_TEXT_TRACK_INDEX : PRIMARY_TEXT_TRACK_INDEX;
        const subtitleSelection = this.#beginSubtitleSelection(normalizedTargetTextTrackIndex);
        const videoElement = this.#mediaElement;
        const mediaStreamTextTracks = getMediaStreamTextTracks(this._currentPlayOptions.mediaSource);

        let track = streamIndex === -1 ? null : mediaStreamTextTracks.filter(function (t) {
            return t.Index === streamIndex;
        })[0];

        // This play method can only check if it is real direct play, and will mark Remux as Transcode as well
        const isDirectPlay = this._currentPlayOptions.playMethod === 'DirectPlay';
        const burnInWhenTranscoding = appSettings.alwaysBurnInSubtitleWhenTranscoding();

        let sessionPromise;
        if (!isDirectPlay && burnInWhenTranscoding) {
            const apiClient = ServerConnections.getApiClient(this._currentPlayOptions.item.ServerId);
            sessionPromise = apiClient.getSessions({
                deviceId: apiClient.deviceId()
            }).then(function (sessions) {
                return sessions[0] || {};
            }, function () {
                return Promise.resolve({});
            });
        } else {
            sessionPromise = Promise.resolve({});
        }

        const player = this;

        sessionPromise.then((s) => {
            if (!player.#isSubtitleSelectionCurrent(subtitleSelection) || videoElement !== player.#mediaElement) {
                return;
            }

            if (!s.TranscodingInfo || s.TranscodingInfo.IsVideoDirect) {
                // restore recorded delivery method if any
                mediaStreamTextTracks.forEach((t) => {
                    t.DeliveryMethod = t.realDeliveryMethod ?? t.DeliveryMethod;
                });
                player.setTrackForDisplay(videoElement, track, normalizedTargetTextTrackIndex, subtitleSelection);
                if (enableNativeTrackSupport(player._currentPlayOptions?.mediaSource, track)) {
                    if (streamIndex !== -1) {
                        player.setCueAppearance();
                    }
                } else {
                    // null these out to disable the player's native display (handled below)
                    streamIndex = -1;
                    track = null;
                }
            } else {
                // record the original delivery method and set all delivery method to encode
                // this is needed for subtitle track switching to properly reload the video stream
                mediaStreamTextTracks.forEach((t) => {
                    t.realDeliveryMethod = t.DeliveryMethod;
                    t.DeliveryMethod = 'Encode';
                });
                // unset stream when switching to transcode
                player.setTrackForDisplay(videoElement, null, -1, subtitleSelection);
            }
        });
    }

    /**
     * @private
     */
    createMediaElement(options, playSessionGeneration = this.#playSessionGeneration) {
        if (!this.#isPlaySessionCurrent(playSessionGeneration)) {
            return Promise.resolve(null);
        }

        const dlg = this.#videoDialog;

        if (!dlg) {
            return import('./style.scss').then(() => {
                if (!this.#isPlaySessionCurrent(playSessionGeneration)) {
                    return null;
                }

                if (options.fullscreen) loading.show();

                const playerDlg = document.createElement('div');
                playerDlg.setAttribute('dir', 'ltr');
                playerDlg.classList.add('videoPlayerContainer');
                if (options.fullscreen) {
                    playerDlg.classList.add('videoPlayerContainer-onTop');
                }

                let html = '';
                const cssClass = 'htmlvideoplayer';

                // Can't autoplay in these browsers so we need to use the full controls, at least until playback starts
                if (!appHost.supports(AppFeature.HtmlVideoAutoplay)) {
                    html += '<video class="' + cssClass + '" preload="metadata" autoplay="autoplay" controls="controls" webkit-playsinline playsinline>';
                } else if (browser.web0s) {
                    // in webOS, setting preload auto allows resuming videos
                    html += '<video class="' + cssClass + '" preload="auto" autoplay="autoplay" webkit-playsinline playsinline>';
                } else {
                    // Chrome 35 won't play with preload none
                    html += '<video class="' + cssClass + '" preload="metadata" autoplay="autoplay" webkit-playsinline playsinline>';
                }

                html += '</video>';

                playerDlg.innerHTML = html;
                const videoElement = playerDlg.querySelector('video');

                // TODO: Move volume control to PlaybackManager. Player should just be a wrapper that translates commands into API calls.
                if (!appHost.supports(AppFeature.PhysicalVolumeControl)) {
                    videoElement.volume = getSavedVolume();
                }

                videoElement.addEventListener('timeupdate', this.onTimeUpdate);
                videoElement.addEventListener('ended', this.onEnded);
                videoElement.addEventListener('volumechange', this.onVolumeChange);
                videoElement.addEventListener('pause', this.onPause);
                videoElement.addEventListener('playing', this.onPlaying);
                videoElement.addEventListener('play', this.onPlay);
                videoElement.addEventListener('click', this.onClick);
                videoElement.addEventListener('dblclick', this.onDblClick);
                videoElement.addEventListener('waiting', this.onWaiting);
                if (options.backdropUrl) {
                    videoElement.poster = options.backdropUrl;
                }

                document.body.insertBefore(playerDlg, document.body.firstChild);
                this.#videoDialog = playerDlg;
                this.#mediaElement = videoElement;

                delete this.forcedFullscreen;

                if (options.fullscreen) {
                    // At this point, we must hide the scrollbar placeholder, so it's not being displayed while the item is being loaded
                    document.body.classList.add('hide-scroll');

                    // Enter fullscreen in the webOS browser to hide the top bar
                    if (!window.NativeShell && browser.web0s && Screenfull.isEnabled) {
                        Screenfull.request().then(() => {
                            if (this.#isPlaySessionCurrent(playSessionGeneration, videoElement)) {
                                this.forcedFullscreen = true;
                            }
                        });
                        return videoElement;
                    }

                    // don't animate on smart tv's, too slow
                    if (
                        !this.#customPlaybackActive
                        && !browser.slow
                        && browser.supportsCssAnimation()
                    ) {
                        return zoomIn(playerDlg).then(() => {
                            return this.#isPlaySessionCurrent(playSessionGeneration, videoElement) ? videoElement : null;
                        });
                    }
                }

                return videoElement;
            });
        } else {
            if (options.fullscreen) {
                // we need to hide scrollbar when starting playback from page with animated background
                document.body.classList.add('hide-scroll');

                // Enter fullscreen in the webOS browser to hide the top bar
                if (!this.forcedFullscreen && !window.NativeShell && browser.web0s && Screenfull.isEnabled) {
                    Screenfull.request().then(() => {
                        if (this.#isPlaySessionCurrent(playSessionGeneration, this.#mediaElement)) {
                            this.forcedFullscreen = true;
                        }
                    });
                }
            }

            const videoElement = this.#mediaElement;
            if (!videoElement) {
                return Promise.reject(new Error('Owned video element is missing'));
            }
            if (options.backdropUrl) {
                // update backdrop image
                videoElement.poster = options.backdropUrl;
            }

            return Promise.resolve(videoElement);
        }
    }

    /**
     * @private
     */
    canPlayMediaType(mediaType) {
        return (mediaType || '').toLowerCase() === 'video';
    }

    /**
     * @private
     */
    supportsPlayMethod(playMethod, item) {
        if (appHost.supportsPlayMethod) {
            return appHost.supportsPlayMethod(playMethod, item);
        }

        return true;
    }

    /**
     * @private
     */
    getDeviceProfile(item, options) {
        return HtmlVideoPlayer.getDeviceProfileInternal(item, options).then((profile) => {
            this.#lastProfile = profile;
            return profile;
        });
    }

    /**
     * @private
     */
    static getDeviceProfileInternal(item, options) {
        if (appHost.getDeviceProfile) {
            return appHost.getDeviceProfile(item, options);
        }

        return getDefaultProfile();
    }

    /**
     * @private
     */
    static getSupportedFeatures() {
        const list = [];

        const video = document.createElement('video');
        if (
            // Check non-standard Safari PiP support
            typeof video.webkitSupportsPresentationMode === 'function' && video.webkitSupportsPresentationMode('picture-in-picture') && typeof video.webkitSetPresentationMode === 'function'
            // Check non-standard Windows PiP support
            || (window.Windows
                && Windows.UI.ViewManagement.ApplicationView.getForCurrentView()
                    .isViewModeSupported(Windows.UI.ViewManagement.ApplicationViewMode.compactOverlay))
            // Check standard PiP support
            || document.pictureInPictureEnabled
        ) {
            list.push('PictureInPicture');
        }

        if (browser.safari || browser.iOS || browser.iPad) {
            list.push('AirPlay');
        }

        if (typeof video.playbackRate === 'number') {
            list.push('PlaybackRate');
        }

        list.push('SetBrightness');
        list.push('SetAspectRatio');
        list.push('SecondarySubtitles');

        return list;
    }

    supports(feature) {
        if (!this.#supportedFeatures) {
            this.#supportedFeatures = HtmlVideoPlayer.getSupportedFeatures();
        }

        return this.#supportedFeatures.includes(feature);
    }

    // Save this for when playback stops, because querying the time at that point might return 0
    currentTime(val) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            if (val != null) {
                if (this.#customPlaybackActive) {
                    this.#currentTime = val / MILLISECONDS_PER_SECOND;
                    this.#currentAssRenderer?.resetRenderAheadCache?.(false);
                    this.#renderCustomSpecializedSubtitles(val);
                    this.#updateCustomAssPlaybackState();
                    return;
                }

                const targetTimeSeconds = val / MILLISECONDS_PER_SECOND;
                this.#currentTime = targetTimeSeconds;
                prepareHLSSeek(this._hlsPlayer, targetTimeSeconds);
                mediaElement.currentTime = targetTimeSeconds;
                return;
            }

            const currentTime = this.#currentTime;
            if (currentTime != null) {
                return currentTime * 1000;
            }

            return (mediaElement.currentTime || 0) * 1000;
        }
    }

    duration() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            const duration = mediaElement.duration;
            if (isValidDuration(duration)) {
                return duration * 1000;
            }
        }

        return null;
    }

    canSetAudioStreamIndex() {
        const video = this.#mediaElement;
        if (video) {
            return canPlaySecondaryAudio(video);
        }

        return false;
    }

    static onPictureInPictureError(err) {
        console.error(`Picture in picture error: ${err}`);
    }

    setPictureInPictureEnabled(isEnabled) {
        const video = this.#mediaElement;

        if (document.pictureInPictureEnabled) {
            if (video) {
                if (isEnabled) {
                    video.requestPictureInPicture().catch(HtmlVideoPlayer.onPictureInPictureError);
                } else {
                    document.exitPictureInPicture().catch(HtmlVideoPlayer.onPictureInPictureError);
                }
            }
        } else if (window.Windows) {
            this.isPip = isEnabled;
            if (isEnabled) {
                Windows.UI.ViewManagement.ApplicationView.getForCurrentView().tryEnterViewModeAsync(Windows.UI.ViewManagement.ApplicationViewMode.compactOverlay);
            } else {
                Windows.UI.ViewManagement.ApplicationView.getForCurrentView().tryEnterViewModeAsync(Windows.UI.ViewManagement.ApplicationViewMode.default);
            }
        } else if (video?.webkitSupportsPresentationMode && typeof video.webkitSetPresentationMode === 'function') {
            video.webkitSetPresentationMode(isEnabled ? 'picture-in-picture' : 'inline');
        }
    }

    isPictureInPictureEnabled() {
        if (document.pictureInPictureEnabled) {
            return !!document.pictureInPictureElement;
        } else if (window.Windows) {
            return this.isPip || false;
        } else {
            const video = this.#mediaElement;
            if (video) {
                return video.webkitPresentationMode === 'picture-in-picture';
            }
        }

        return false;
    }

    isAirPlayEnabled() {
        if (document.AirPlayEnabled) {
            return !!document.AirplayElement;
        }

        return false;
    }

    setAirPlayEnabled(isEnabled) {
        const video = this.#mediaElement;

        if (document.AirPlayEnabled) {
            if (video) {
                if (isEnabled) {
                    video.requestAirPlay().catch(function(err) {
                        console.error('Error requesting AirPlay', err);
                    });
                } else {
                    document.exitAirPLay().catch(function(err) {
                        console.error('Error exiting AirPlay', err);
                    });
                }
            }
        } else {
            video.webkitShowPlaybackTargetPicker();
        }
    }

    setBrightness(val) {
        const elem = this.#mediaElement;

        if (elem) {
            val = Math.max(0, val);
            val = Math.min(100, val);

            let rawValue = val;
            rawValue = Math.max(20, rawValue);

            const cssValue = rawValue >= 100 ? 'none' : (rawValue / 100);
            elem.style['-webkit-filter'] = `brightness(${cssValue})`;
            elem.style.filter = `brightness(${cssValue})`;
            elem.brightnessValue = val;
            Events.trigger(this, 'brightnesschange');
        }
    }

    getBrightness() {
        const elem = this.#mediaElement;
        if (elem) {
            const val = elem.brightnessValue;
            return val == null ? 100 : val;
        }
    }

    seekable() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            const seekable = mediaElement.seekable;
            if (seekable?.length) {
                let start = seekable.start(0);
                let end = seekable.end(0);

                if (!isValidDuration(start)) {
                    start = 0;
                }
                if (!isValidDuration(end)) {
                    end = 0;
                }

                return (end - start) > 0;
            }

            return false;
        }
    }

    pause() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.pause();
        }
    }

    // This is a retry after error
    resume() {
        this.unpause();
    }

    unpause() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.play();
        }
    }

    paused() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return mediaElement.paused;
        }

        return false;
    }

    setPlaybackRate(value) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.playbackRate = value;
        }
    }

    getPlaybackRate() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return mediaElement.playbackRate;
        }
        return null;
    }

    getSupportedPlaybackRates() {
        return [{
            name: '0.5x',
            id: 0.5
        }, {
            name: '0.75x',
            id: 0.75
        }, {
            name: '1x',
            id: 1.0
        }, {
            name: '1.25x',
            id: 1.25
        }, {
            name: '1.5x',
            id: 1.5
        }, {
            name: '1.75x',
            id: 1.75
        }, {
            name: '2x',
            id: 2.0
        }, {
            name: '2.5x',
            id: 2.5
        }, {
            name: '3x',
            id: 3.0
        }, {
            name: '3.5x',
            id: 3.5
        }, {
            name: '4.0x',
            id: 4.0
        }];
    }

    setVolume(val) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.volume = Math.pow(val / 100, 3);
        }
    }

    getVolume() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return Math.min(Math.round(Math.pow(mediaElement.volume, 1 / 3) * 100), 100);
        }
    }

    volumeUp() {
        this.setVolume(Math.min(this.getVolume() + 2, 100));
    }

    volumeDown() {
        this.setVolume(Math.max(this.getVolume() - 2, 0));
    }

    setMute(mute) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            mediaElement.muted = mute;
        }
    }

    isMuted() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return mediaElement.muted;
        }
        return false;
    }

    #applyAspectRatio(val = this.getAspectRatio()) {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            if (val === 'detected' && typeof this.#detectedAspectRatio === 'number' && this.#detectedAspectRatio > 0) {
                const ar = this.#detectedAspectRatio;
                // Viewport-unit sizing: element takes the content's aspect ratio,
                // constrained to fit the viewport. Fully responsive to any window shape.
                // object-fit:cover then crops exactly the baked-in black bars.
                mediaElement.style.width = `min(100vw, calc(100vh * ${ar}))`;
                mediaElement.style.height = `min(100vh, calc(100vw / ${ar}))`;
                mediaElement.style['object-fit'] = 'cover';
                mediaElement.style.setProperty('margin', 'auto', 'important');
            } else {
                // Restore default sizing for non-detected modes
                mediaElement.style.width = '100%';
                mediaElement.style.height = '100%';
                mediaElement.style.setProperty('margin', '0', 'important');
                if (val === 'auto' || val === 'detected') {
                    mediaElement.style.removeProperty('object-fit');
                } else {
                    mediaElement.style['object-fit'] = val;
                }
            }
        }

        if (this.#currentPgsRenderer) {
            this.#currentPgsRenderer.aspectRatio = val === 'auto' || val === 'detected' ? 'contain' : val;
        }

        this.#synchronizeCustomSubtitleCanvases();
    }

    setAspectRatio(val) {
        appSettings.aspectRatio(val);
        this.#applyAspectRatio(this.getAspectRatio());
    }

    getAspectRatio() {
        const saved = appSettings.aspectRatio() || 'auto';
        // Prefer detected cropping when Auto has trickplay analysis available
        if (saved === 'auto' && this.#detectedAspectRatio !== null) {
            return 'detected';
        }
        // Fall back to auto if detected was saved but isn't available for this file
        if (saved === 'detected' && this.#detectedAspectRatio === null) {
            return 'auto';
        }
        return saved;
    }

    getSupportedAspectRatios() {
        const ratios = [{
            name: globalize.translate('Auto'),
            id: 'auto'
        }];

        if (this.#detectedAspectRatio !== null) {
            ratios.push({
                name: globalize.translate('AspectRatioDetected'),
                id: 'detected'
            });
        }

        ratios.push({
            name: globalize.translate('AspectRatioCover'),
            id: 'cover'
        }, {
            name: globalize.translate('AspectRatioFill'),
            id: 'fill'
        });

        return ratios;
    }

    #getDetectedAspectRatio(options) {
        const item = options?.item;
        const mediaSourceId = options?.mediaSource?.Id;
        if (!item?.Trickplay || !mediaSourceId) {
            return null;
        }

        const trickplayResolutions = item.Trickplay[mediaSourceId];
        if (!trickplayResolutions) {
            return null;
        }

        for (const [, info] of Object.entries(trickplayResolutions)) {
            if (info.DetectedAspectRatioSnapped != null) {
                return parseFloat(info.DetectedAspectRatioSnapped);
            }
            // DetectedAspectRatioSnapped is null when no black bars are detected;
            // fall back to the raw value (0 = native aspect ratio, no cropping needed)
            if (info.DetectedAspectRatio != null) {
                return parseFloat(info.DetectedAspectRatio);
            }
        }

        return null;
    }

    togglePictureInPicture() {
        return this.setPictureInPictureEnabled(!this.isPictureInPictureEnabled());
    }

    toggleAirPlay() {
        return this.setAirPlayEnabled(!this.isAirPlayEnabled());
    }

    getBufferedRanges() {
        const mediaElement = this.#mediaElement;
        if (mediaElement) {
            return getBufferedRanges(this, mediaElement);
        }

        return [];
    }

    getStats() {
        const mediaElement = this.#mediaElement;
        const playOptions = this._currentPlayOptions || [];

        const categories = [];

        if (!mediaElement) {
            return Promise.resolve({
                categories: categories
            });
        }

        const mediaCategory = {
            stats: [],
            type: 'media'
        };
        categories.push(mediaCategory);

        const mediaInfos = [];
        mediaInfos.push(this._hlsPlayer ? 'HLS' : 'Video');
        if (playOptions.url) {
            //  create an anchor element (note: no need to append this element to the document)
            let link = document.createElement('a');
            //  set href to any path
            link.setAttribute('href', playOptions.url);
            const protocol = (link.protocol || '').replace(':', '');

            if (protocol) {
                mediaInfos.push(`(${protocol})`);
            }

            link = null;
        }
        if (mediaInfos.length) {
            mediaCategory.stats.push({
                label: globalize.translate('LabelStreamType'),
                value: mediaInfos.join('  ')
            });
        }

        const videoCategory = {
            stats: [],
            type: 'video'
        };
        categories.push(videoCategory);

        const devicePixelRatio = window.devicePixelRatio || 1;
        const rect = mediaElement.getBoundingClientRect ? mediaElement.getBoundingClientRect() : {};
        let height = Math.round(rect.height * devicePixelRatio);
        let width = Math.round(rect.width * devicePixelRatio);

        const viewInfos = [];
        // Don't show player dimensions on smart TVs because the app UI could be lower
        // resolution than the video and this causes users to think there is a problem
        if (width && height && !browser.tv) {
            viewInfos.push(`${width}x${height}`);
        }

        height = mediaElement.videoHeight;
        width = mediaElement.videoWidth;
        if (width && height) {
            viewInfos.push(`${width}x${height}`);
        }
        if (viewInfos.length) {
            videoCategory.stats.push({
                label: globalize.translate('LabelPlayerSizes'),
                value: viewInfos.join(' / ')
            });
        }

        if (mediaElement.getVideoPlaybackQuality) {
            const playbackQuality = mediaElement.getVideoPlaybackQuality();
            const droppedVideoFrames = playbackQuality.droppedVideoFrames || 0;
            const corruptedVideoFrames = playbackQuality.corruptedVideoFrames || 0;

            const qualityInfos = [];
            qualityInfos.push(droppedVideoFrames);
            qualityInfos.push(corruptedVideoFrames);

            videoCategory.stats.push({
                label: globalize.translate('LabelPlaybackQuality'),
                value: qualityInfos.join(' / ')
            });
        }

        const audioCategory = {
            stats: [],
            type: 'audio'
        };
        categories.push(audioCategory);

        const sinkId = mediaElement.sinkId;
        if (sinkId) {
            audioCategory.stats.push({
                label: 'Sink Id:',
                value: sinkId
            });
        }

        return Promise.resolve({
            categories: categories
        });
    }
}

export default HtmlVideoPlayer;
