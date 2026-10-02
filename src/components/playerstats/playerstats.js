import { PluginType } from 'constants/pluginType';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import Events from 'utils/events';
import { getReadableSize } from 'utils/file';

import layoutManager from '../layoutManager';
import { playbackManager } from '../playback/playbackmanager';
import playMethodHelper from '../playback/playmethodhelper';
import { pluginManager } from '../pluginManager';

import 'elements/emby-button/paper-icon-button-light';

import './playerstats.scss';

const SESSION_CACHE_DURATION_MS = 10000;
const RENDER_THROTTLE_MS = 700;

function init(instance) {
    const parent = document.createElement('div');

    parent.classList.add('playerStats');

    if (layoutManager.tv) {
        parent.classList.add('playerStats-tv');
    }

    parent.classList.add('hide');

    let button;

    if (layoutManager.tv) {
        button = '';
    } else {
        button = '<button type="button" is="paper-icon-button-light" class="playerStats-closeButton"><span class="material-icons close" aria-hidden="true"></span></button>';
    }

    const contentClass = layoutManager.tv ? 'playerStats-content playerStats-content-tv' : 'playerStats-content';

    parent.innerHTML = '<div class="' + contentClass + '">' + button + '<div class="playerStats-stats"></div></div>';

    button = parent.querySelector('.playerStats-closeButton');

    if (button) {
        button.addEventListener('click', onCloseButtonClick.bind(instance));
    }

    document.body.appendChild(parent);

    instance.element = parent;
}

function onCloseButtonClick() {
    this.enabled(false);
}

function renderStats(elem, categories) {
    elem.querySelector('.playerStats-stats').innerHTML = categories.map(function (category) {
        let categoryHtml = '';

        const stats = category.stats;

        if (stats.length && category.name) {
            categoryHtml += '<div class="playerStats-stat playerStats-stat-header">';

            categoryHtml += '<div class="playerStats-stat-label">';
            categoryHtml += category.name;
            categoryHtml += '</div>';

            categoryHtml += '<div class="playerStats-stat-value">';
            categoryHtml += category.subText || '';
            categoryHtml += '</div>';

            categoryHtml += '</div>';
        }

        for (let i = 0, length = stats.length; i < length; i++) {
            categoryHtml += '<div class="playerStats-stat">';

            const stat = stats[i];

            categoryHtml += '<div class="playerStats-stat-label">';
            categoryHtml += stat.label;
            categoryHtml += '</div>';

            categoryHtml += '<div class="playerStats-stat-value">';
            categoryHtml += stat.value;
            categoryHtml += '</div>';

            categoryHtml += '</div>';
        }

        return categoryHtml;
    }).join('');
}

function getPlaybackIdentity(player) {
    const currentItem = playbackManager.currentItem(player) || {};
    const currentMediaSource = playbackManager.currentMediaSource(player) || {};

    return {
        itemId: currentItem.Id,
        mediaSourceId: currentMediaSource.Id,
        playMethod: playbackManager.playMethod(player),
        player: player,
        playSessionId: playbackManager.playSessionId(player),
        serverId: currentItem.ServerId
    };
}

function playbackIdentitiesMatch(firstIdentity, secondIdentity) {
    return Boolean(firstIdentity && secondIdentity)
        && firstIdentity.itemId === secondIdentity.itemId
        && firstIdentity.mediaSourceId === secondIdentity.mediaSourceId
        && firstIdentity.playMethod === secondIdentity.playMethod
        && firstIdentity.player === secondIdentity.player
        && firstIdentity.playSessionId === secondIdentity.playSessionId
        && firstIdentity.serverId === secondIdentity.serverId;
}

// SessionInfo omits PlaybackInfo's PlaySessionId, so match its stable route fields instead
function findCurrentSession(sessions, playbackIdentity) {
    const hasStableDiscriminator = Boolean(
        playbackIdentity.itemId
        || playbackIdentity.mediaSourceId
        || playbackIdentity.playMethod
    );

    if (!hasStableDiscriminator) {
        return undefined;
    }

    return sessions.find(function (session) {
        const playState = session.PlayState || {};

        return (!playbackIdentity.itemId || session.NowPlayingItem?.Id === playbackIdentity.itemId)
            && (!playbackIdentity.mediaSourceId || playState.MediaSourceId === playbackIdentity.mediaSourceId)
            && (!playbackIdentity.playMethod || playState.PlayMethod === playbackIdentity.playMethod);
    });
}

function getSession(instance, player, playbackIdentity) {
    const now = Date.now();

    if (playbackIdentitiesMatch(playbackIdentity, instance.lastSessionIdentity)
            && (now - (instance.lastSessionTime || 0)) < SESSION_CACHE_DURATION_MS) {
        return Promise.resolve(instance.lastSession);
    }

    if (!playbackIdentity.serverId) {
        return Promise.resolve({});
    }

    const apiClient = ServerConnections.getApiClient(playbackIdentity.serverId);
    instance.sessionRequestId = (instance.sessionRequestId || 0) + 1;
    const sessionRequestId = instance.sessionRequestId;

    return apiClient.getSessions({
        deviceId: apiClient.deviceId()
    }).then(function (sessions) {
        if (!playbackIdentitiesMatch(playbackIdentity, getPlaybackIdentity(player))) {
            return {};
        }

        const session = findCurrentSession(sessions, playbackIdentity);
        if (!session) {
            return {};
        }

        if (instance.sessionRequestId === sessionRequestId) {
            instance.lastSession = session;
            instance.lastSessionIdentity = playbackIdentity;
            instance.lastSessionTime = Date.now();
        }

        return session;
    }, function () {
        return {};
    });
}

function translateReason(reason) {
    return globalize.translate('' + reason);
}

function getTranscodingStats(session, player, displayPlayMethod) {
    const sessionStats = [];

    let videoCodec;
    let audioCodec;
    let totalBitrate;
    let audioChannels;

    if (session.TranscodingInfo) {
        videoCodec = session.TranscodingInfo.VideoCodec;
        audioCodec = session.TranscodingInfo.AudioCodec;
        totalBitrate = session.TranscodingInfo.Bitrate;
        audioChannels = session.TranscodingInfo.AudioChannels;
    }

    const targetInfos = [];
    const transcodeInfos = [];
    if (videoCodec) {
        targetInfos.push(session.TranscodingInfo.IsVideoDirect ? (`${videoCodec.toUpperCase()} (direct)`) : videoCodec.toUpperCase());
    }
    if (audioCodec) {
        targetInfos.push(session.TranscodingInfo.IsAudioDirect ? (`${audioCodec.toUpperCase()} (direct)`) : audioCodec.toUpperCase());
    }
    if (displayPlayMethod === 'Transcode') {
        if (audioChannels) {
            targetInfos.push(`${audioChannels} Ch`);
        }
        if (totalBitrate) {
            targetInfos.push(getDisplayBitrate(totalBitrate));
        }
        if (session.TranscodingInfo.CompletionPercentage) {
            transcodeInfos.push(`${session.TranscodingInfo.CompletionPercentage.toFixed(1)}%`);
        }
        if (session.TranscodingInfo.Framerate) {
            transcodeInfos.push(getDisplayTranscodeFps(session, player));
        }
    }
    if (targetInfos.length) {
        sessionStats.push({
            label: globalize.translate('LabelTargetCodecs'),
            value: targetInfos.join(',  ')
        });
    }
    if (transcodeInfos.length) {
        sessionStats.push({
            label: globalize.translate('LabelProgressAndSpeed'),
            value: transcodeInfos.join(' / ')
        });
    }
    if (session.TranscodingInfo.TranscodeReasons?.length) {
        sessionStats.push({
            label: globalize.translate('LabelReasons'),
            value: session.TranscodingInfo.TranscodeReasons.map(translateReason).join('<br/>')
        });
    }

    return sessionStats;
}

function getDisplayBitrate(bitrate) {
    if (bitrate > 1000000) {
        return (bitrate / 1000000).toFixed(1) + ' Mbps';
    } else {
        return Math.floor(bitrate / 1000) + ' Kbps';
    }
}

function getDisplayTranscodeFps(session, player) {
    const mediaSource = playbackManager.currentMediaSource(player) || {};
    const videoStream = (mediaSource.MediaStreams || []).find((s) => s.Type === 'Video') || {};

    const originalFramerate = videoStream.ReferenceFrameRate;
    const transcodeFramerate = session.TranscodingInfo.Framerate;

    if (!originalFramerate) {
        return `${transcodeFramerate} fps`;
    }

    return `${transcodeFramerate} fps (${(transcodeFramerate / originalFramerate).toFixed(2)}x)`;
}

function getMediaSourceStats(session, player) {
    const sessionStats = [];

    const mediaSource = playbackManager.currentMediaSource(player) || {};
    const totalBitrate = mediaSource.Bitrate;
    const mediaFileSize = mediaSource.Size;

    const containerInfos = [];
    if (mediaSource.Container) {
        containerInfos.push(mediaSource.Container);
    }
    if (mediaFileSize) {
        containerInfos.push(getReadableSize(mediaFileSize));
    }
    if (totalBitrate) {
        containerInfos.push(getDisplayBitrate(totalBitrate));
    }
    if (containerInfos.length) {
        sessionStats.push({
            label: globalize.translate('LabelProfileContainer'),
            value: containerInfos.join(',  ')
        });
    }

    const mediaStreams = mediaSource.MediaStreams || [];
    const videoStream = mediaStreams.filter(function (s) {
        return s.Type === 'Video';
    })[0] || {};

    const videoCodec = videoStream.Codec;

    const audioStreamIndex = playbackManager.getAudioStreamIndex(player);
    const audioStream = playbackManager.audioTracks(player).filter(function (s) {
        return s.Type === 'Audio' && s.Index === audioStreamIndex;
    })[0] || {};

    const audioCodec = audioStream.Codec;

    const videoCodecInfos = [];
    if (videoCodec) {
        videoCodecInfos.push(videoCodec.toUpperCase());
    }
    if (videoStream.VideoDoViTitle) {
        videoCodecInfos.push(videoStream.VideoDoViTitle);
    }
    if (videoCodecInfos.length) {
        sessionStats.push({
            label: globalize.translate('LabelVideoCodec'),
            value: videoCodecInfos.join('  ')
        });
    }

    const videoAttributes = [];
    if (videoStream.Profile) {
        videoAttributes.push(videoStream.Profile);
    }
    if (videoStream.Level && videoStream.Level >= 0) {
        videoAttributes.push(`Lv ${videoStream.Level}`);
    }
    if (videoStream.BitRate) {
        videoAttributes.push(getDisplayBitrate(videoStream.BitRate));
    }
    const frameRate = videoStream.AverageFrameRate || videoStream.RealFrameRate;
    if (frameRate) {
        videoAttributes.push(`${frameRate.toFixed(2)} fps`);
    }
    if (videoAttributes.length) {
        sessionStats.push({
            label: globalize.translate('LabelVideoAttributes'),
            value: videoAttributes.join(',  ')
        });
    }

    const videoBitDepthInfos = [];
    if (videoStream.BitDepth) {
        videoBitDepthInfos.push(`${videoStream.BitDepth} Bit`);
    }
    if (videoStream.PixelFormat) {
        videoBitDepthInfos.push(videoStream.PixelFormat);
    }
    if (videoStream.VideoRangeType) {
        videoBitDepthInfos.push(videoStream.VideoRangeType);
    }
    if (videoBitDepthInfos.length) {
        sessionStats.push({
            label: globalize.translate('LabelVideoBitDepth'),
            value: videoBitDepthInfos.join(',  ')
        });
    }

    const videoColorInfos = [];
    if (videoStream.ColorSpace) {
        videoColorInfos.push(`${videoStream.ColorSpace}(m)`);
    }
    if (videoStream.ColorPrimaries) {
        videoColorInfos.push(`${videoStream.ColorPrimaries}(p)`);
    }
    if (videoStream.ColorTransfer) {
        videoColorInfos.push(`${videoStream.ColorTransfer}(t)`);
    }
    if (videoColorInfos.length) {
        sessionStats.push({
            label: globalize.translate('LabelVideoColors'),
            value: videoColorInfos.join(',  ')
        });
    }

    const audioCodecInfos = [];
    if (audioCodec) {
        audioCodecInfos.push(audioCodec.toUpperCase());
    }
    if (audioStream.Profile) {
        audioCodecInfos.push(audioStream.Profile);
    }
    if (audioCodecInfos.length) {
        sessionStats.push({
            label: globalize.translate('LabelAudioCodec'),
            value: audioCodecInfos.join('  ')
        });
    }

    const audioAttributes = [];
    if (audioStream.Channels) {
        audioAttributes.push(`${audioStream.Channels} Ch`);
    }
    if (audioStream.BitRate) {
        audioAttributes.push(getDisplayBitrate(audioStream.BitRate));
    }
    if (audioStream.SampleRate) {
        audioAttributes.push(`${audioStream.SampleRate} Hz`);
    }
    if (audioStream.BitDepth) {
        audioAttributes.push(`${audioStream.BitDepth} Bit`);
    }
    if (audioAttributes.length) {
        sessionStats.push({
            label: globalize.translate('LabelAudioAttributes'),
            value: audioAttributes.join(',  ')
        });
    }

    return sessionStats;
}

function getSyncPlayStats() {
    const SyncPlay = pluginManager.firstOfType(PluginType.SyncPlay)?.instance;

    if (!SyncPlay?.Manager.isSyncPlayEnabled()) {
        return [];
    }

    const syncStats = [];
    const stats = SyncPlay.Manager.getStats();

    syncStats.push({
        label: globalize.translate('LabelSyncPlayTimeSyncDevice'),
        value: stats.TimeSyncDevice
    });

    syncStats.push({
        label: globalize.translate('LabelSyncPlayTimeSyncOffset'),
        value: stats.TimeSyncOffset + ' ' + globalize.translate('MillisecondsUnit')
    });

    syncStats.push({
        label: globalize.translate('LabelSyncPlayPlaybackDiff'),
        value: stats.PlaybackDiff + ' ' + globalize.translate('MillisecondsUnit')
    });

    syncStats.push({
        label: globalize.translate('LabelSyncPlaySyncMethod'),
        value: stats.SyncMethod
    });

    return syncStats;
}

function getStats(instance, player, playbackIdentity) {
    const statsPromise = player.getStats ? player.getStats() : Promise.resolve({});
    const sessionPromise = getSession(instance, player, playbackIdentity);

    return Promise.all([statsPromise, sessionPromise]).then(function (responses) {
        const playerStatsResult = responses[0];
        const playerStats = playerStatsResult.categories || [];
        const session = responses[1];

        const displayPlayMethod = playMethodHelper.getDisplayPlayMethod(session);
        let localizedDisplayMethod = displayPlayMethod;

        if (displayPlayMethod === 'DirectPlay') {
            localizedDisplayMethod = globalize.translate('DirectPlaying');
        } else if (displayPlayMethod === 'Remux') {
            localizedDisplayMethod = globalize.translate('Remuxing');
        } else if (displayPlayMethod === 'DirectStream') {
            localizedDisplayMethod = globalize.translate('DirectStreaming');
        } else if (displayPlayMethod === 'Transcode') {
            localizedDisplayMethod = globalize.translate('Transcoding');
        }

        const baseCategory = {
            stats: [],
            name: globalize.translate('LabelPlaybackInfo')
        };

        const playerInfos = [];
        playerInfos.push(player.name);
        if (localizedDisplayMethod) {
            playerInfos.push(`(${localizedDisplayMethod})`);
        }
        baseCategory.stats.push({
            label: globalize.translate('LabelPlayer'),
            value: playerInfos.join('  ')
        });

        const categories = [];
        categories.push(baseCategory);
        for (let i = 0, length = playerStats.length; i < length; i++) {
            const category = playerStats[i];
            categories.push(category);
        }

        let localizedTranscodingInfo = globalize.translate('LabelTranscodingInfo');
        if (displayPlayMethod === 'Remux') {
            localizedTranscodingInfo = globalize.translate('LabelRemuxingInfo');
        } else if (displayPlayMethod === 'DirectStream') {
            localizedTranscodingInfo = globalize.translate('LabelDirectStreamingInfo');
        }

        if (session.TranscodingInfo) {
            categories.push({
                stats: getTranscodingStats(session, player, displayPlayMethod),
                name: localizedTranscodingInfo
            });
        }

        categories.push({
            stats: getMediaSourceStats(session, player),
            name: globalize.translate('LabelOriginalMediaInfo')
        });

        const syncPlayStats = getSyncPlayStats();
        if (syncPlayStats.length > 0) {
            categories.push({
                stats: syncPlayStats,
                name: globalize.translate('LabelSyncPlayInfo')
            });
        }

        return Promise.resolve(categories);
    });
}

function renderPlayerStats(instance, player) {
    if (!instance._enabled) {
        return;
    }

    const now = Date.now();
    const playbackIdentity = getPlaybackIdentity(player);
    const playbackChanged = !playbackIdentitiesMatch(playbackIdentity, instance.lastRenderIdentity);

    if (!playbackChanged && (now - (instance.lastRender || 0)) < RENDER_THROTTLE_MS) {
        return;
    }

    instance.lastRender = now;
    instance.lastRenderIdentity = playbackIdentity;
    instance.renderRequestId = (instance.renderRequestId || 0) + 1;
    const renderRequestId = instance.renderRequestId;

    getStats(instance, player, playbackIdentity).then(function (stats) {
        if (!instance._enabled
                || instance.renderRequestId !== renderRequestId
                || instance.options?.player !== player
                || !playbackIdentitiesMatch(playbackIdentity, getPlaybackIdentity(player))) {
            return;
        }

        const elem = instance.element;
        if (!elem) {
            return;
        }

        renderStats(elem, stats);
    });
}

function bindEvents(instance, player) {
    const localOnTimeUpdate = function () {
        renderPlayerStats(instance, player);
    };

    instance.onTimeUpdate = localOnTimeUpdate;
    Events.on(player, 'timeupdate', localOnTimeUpdate);
}

function unbindEvents(instance, player) {
    const localOnTimeUpdate = instance.onTimeUpdate;

    if (localOnTimeUpdate) {
        Events.off(player, 'timeupdate', localOnTimeUpdate);
    }
}

function invalidateStatsRequests(instance) {
    instance.lastRender = 0;
    instance.lastRenderIdentity = null;
    instance.renderRequestId = (instance.renderRequestId || 0) + 1;
}

function clearRenderedStats(instance) {
    const statsElement = instance.element?.querySelector('.playerStats-stats');
    if (statsElement) {
        statsElement.innerHTML = '';
    }
}

class PlayerStats {
    constructor(options) {
        this.options = options;

        init(this);

        this.enabled(true);
    }

    enabled(enabled) {
        if (enabled == null) {
            return this._enabled;
        }

        const options = this.options;

        if (!options) {
            return;
        }

        if (this._enabled === enabled) {
            return;
        }

        this._enabled = enabled;
        invalidateStatsRequests(this);
        if (enabled) {
            this.element.classList.remove('hide');
            bindEvents(this, options.player);
        } else {
            this.element.classList.add('hide');
            unbindEvents(this, options.player);
            clearRenderedStats(this);
        }
    }

    toggle() {
        this.enabled(!this.enabled());
    }

    destroy() {
        const options = this.options;

        invalidateStatsRequests(this);
        this._enabled = false;

        if (options) {
            this.options = null;
            unbindEvents(this, options.player);
        }

        const elem = this.element;
        if (elem) {
            elem.parentNode.removeChild(elem);
            this.element = null;
        }
    }
}

export default PlayerStats;
