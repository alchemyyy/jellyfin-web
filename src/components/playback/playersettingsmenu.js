import actionsheet from '../actionSheet/actionSheet';
import { playbackManager } from '../playback/playbackmanager';
import globalize from 'lib/globalize';
import { ServerConnections } from 'lib/jellyfin-apiclient';
import qualityoptions from '../qualityOptions';

const builtInMenuItemIds = new Set([
    'aspectratio',
    'playbackrate',
    'quality',
    'repeatmode',
    'stats',
    'suboffset'
]);

function warnInvalidSettingsMenuItem(item, reason) {
    console.warn('[playerSettingsMenu] Ignoring invalid player settings menu item:', reason, item);
}

function getContributedSettingsMenuItems(player) {
    if (!player || typeof player.getSettingsMenuItems !== 'function') {
        return [];
    }

    const contributions = player.getSettingsMenuItems();
    if (!Array.isArray(contributions)) {
        warnInvalidSettingsMenuItem(contributions, 'getSettingsMenuItems() must return an array');
        return [];
    }

    const contributedItems = [];
    const itemIds = new Set(builtInMenuItemIds);

    for (const contribution of contributions) {
        if (!contribution || typeof contribution !== 'object') {
            warnInvalidSettingsMenuItem(contribution, 'the descriptor must be an object');
            continue;
        }

        if (typeof contribution.id !== 'string' || !contribution.id.trim()) {
            warnInvalidSettingsMenuItem(contribution, 'id must be a non-empty string');
            continue;
        }

        if (typeof contribution.name !== 'string' || !contribution.name.trim()) {
            warnInvalidSettingsMenuItem(contribution, 'name must be a non-empty string');
            continue;
        }

        if (contribution.secondaryText !== undefined && typeof contribution.secondaryText !== 'string') {
            warnInvalidSettingsMenuItem(contribution, 'secondaryText must be a string when provided');
            continue;
        }

        if (typeof contribution.onSelect !== 'function') {
            warnInvalidSettingsMenuItem(contribution, 'onSelect must be a function');
            continue;
        }

        if (itemIds.has(contribution.id)) {
            warnInvalidSettingsMenuItem(contribution, 'id must be unique and must not match a built-in item');
            continue;
        }

        itemIds.add(contribution.id);
        contributedItems.push(contribution);
    }

    return contributedItems;
}

function showQualityMenu(player, btn) {
    const videoStream = playbackManager.currentMediaSource(player).MediaStreams.filter(function (stream) {
        return stream.Type === 'Video';
    })[0];

    const videoCodec = videoStream ? videoStream.Codec : null;
    const videoBitRate = videoStream ? videoStream.BitRate : null;

    const options = qualityoptions.getVideoQualityOptions({
        currentMaxBitrate: playbackManager.getMaxStreamingBitrate(player),
        isAutomaticBitrateEnabled: playbackManager.enableAutomaticBitrateDetection(player),
        videoCodec,
        videoBitRate,
        enableAuto: true
    });

    const menuItems = options.map(function (o) {
        const opt = {
            name: o.name,
            id: o.bitrate,
            asideText: o.secondaryText
        };

        if (o.selected) {
            opt.selected = true;
        }

        return opt;
    });

    const selectedId = options.filter(function (o) {
        return o.selected;
    });

    const selectedBitrate = selectedId.length ? selectedId[0].bitrate : null;

    return actionsheet.show({
        items: menuItems,
        positionTo: btn
    }).then(function (id) {
        const bitrate = parseInt(id, 10);
        if (bitrate !== selectedBitrate) {
            playbackManager.setMaxStreamingBitrate({
                enableAutomaticBitrateDetection: !bitrate,
                maxBitrate: bitrate
            }, player);
        }
    });
}

function showRepeatModeMenu(player, btn) {
    const menuItems = [];
    const currentValue = playbackManager.getRepeatMode(player);

    menuItems.push({
        name: globalize.translate('RepeatAll'),
        id: 'RepeatAll',
        selected: currentValue === 'RepeatAll'
    });

    menuItems.push({
        name: globalize.translate('RepeatOne'),
        id: 'RepeatOne',
        selected: currentValue === 'RepeatOne'
    });

    menuItems.push({
        name: globalize.translate('None'),
        id: 'RepeatNone',
        selected: currentValue === 'RepeatNone'
    });

    return actionsheet.show({
        items: menuItems,
        positionTo: btn
    }).then(function (mode) {
        if (mode) {
            playbackManager.setRepeatMode(mode, player);
        }
    });
}

function getQualitySecondaryText(player) {
    const state = playbackManager.getPlayerState(player);

    const videoStream = playbackManager.currentMediaSource(player).MediaStreams.filter(function (stream) {
        return stream.Type === 'Video';
    })[0];

    const videoCodec = videoStream ? videoStream.Codec : null;
    const videoBitRate = videoStream ? videoStream.BitRate : null;
    const videoWidth = videoStream ? videoStream.Width : null;
    const videoHeight = videoStream ? videoStream.Height : null;

    const options = qualityoptions.getVideoQualityOptions({
        currentMaxBitrate: playbackManager.getMaxStreamingBitrate(player),
        isAutomaticBitrateEnabled: playbackManager.enableAutomaticBitrateDetection(player),
        videoCodec,
        videoBitRate,
        videoWidth: videoWidth,
        videoHeight: videoHeight,
        enableAuto: true
    });

    let selectedOption = options.filter(function (o) {
        return o.selected;
    });

    if (!selectedOption.length) {
        return null;
    }

    selectedOption = selectedOption[0];
    let text = selectedOption.name;

    if (selectedOption.autoText) {
        if (state.PlayState && state.PlayState.PlayMethod !== 'Transcode') {
            text += ' - Direct';
        } else {
            text += ' ' + selectedOption.autoText;
        }
    }

    return text;
}

function showAspectRatioMenu(player, btn) {
    // each has a name and id
    const currentId = playbackManager.getAspectRatio(player);
    const menuItems = playbackManager.getSupportedAspectRatios(player)
        .map(({ id, name }) => ({
            id,
            name,
            selected: id === currentId
        }));

    return actionsheet.show({
        items: menuItems,
        positionTo: btn
    }).then(function (id) {
        if (id) {
            playbackManager.setAspectRatio(id, player);
            return Promise.resolve();
        }

        return Promise.reject();
    });
}

function showPlaybackRateMenu(player, btn) {
    // each has a name and id
    const currentId = playbackManager.getPlaybackRate(player);
    const menuItems = playbackManager.getSupportedPlaybackRates(player).map(i => ({
        id: i.id,
        name: i.name,
        selected: i.id === currentId
    }));

    return actionsheet.show({
        items: menuItems,
        positionTo: btn
    }).then(function (id) {
        if (id) {
            playbackManager.setPlaybackRate(id, player);
            return Promise.resolve();
        }

        return Promise.reject();
    });
}

function showWithUser(options, player, user) {
    const supportedCommands = playbackManager.getSupportedCommands(player);

    const menuItems = [];
    if (supportedCommands.indexOf('SetAspectRatio') !== -1) {
        const currentAspectRatioId = playbackManager.getAspectRatio(player);
        const currentAspectRatio = playbackManager.getSupportedAspectRatios(player).filter(function (i) {
            return i.id === currentAspectRatioId;
        })[0];

        menuItems.push({
            name: globalize.translate('AspectRatio'),
            id: 'aspectratio',
            asideText: currentAspectRatio ? currentAspectRatio.name : null
        });
    }

    if (supportedCommands.indexOf('PlaybackRate') !== -1) {
        const currentPlaybackRateId = playbackManager.getPlaybackRate(player);
        const currentPlaybackRate = playbackManager.getSupportedPlaybackRates(player).filter(i => i.id === currentPlaybackRateId)[0];

        menuItems.push({
            name: globalize.translate('PlaybackRate'),
            id: 'playbackrate',
            asideText: currentPlaybackRate ? currentPlaybackRate.name : null
        });
    }

    if (options.quality && supportedCommands.includes('SetMaxStreamingBitrate')
            && user?.Policy?.EnableVideoPlaybackTranscoding) {
        const secondaryQualityText = getQualitySecondaryText(player);

        menuItems.push({
            name: globalize.translate('Quality'),
            id: 'quality',
            asideText: secondaryQualityText
        });
    }

    const repeatMode = playbackManager.getRepeatMode(player);

    if (supportedCommands.indexOf('SetRepeatMode') !== -1 && playbackManager.currentMediaSource(player).RunTimeTicks) {
        menuItems.push({
            name: globalize.translate('RepeatMode'),
            id: 'repeatmode',
            asideText: repeatMode === 'RepeatNone' ? globalize.translate('None') : globalize.translate('' + repeatMode)
        });
    }

    if (options.suboffset) {
        menuItems.push({
            name: globalize.translate('SubtitleOffset'),
            id: 'suboffset',
            asideText: null
        });
    }

    if (options.stats) {
        menuItems.push({
            name: globalize.translate('PlaybackData'),
            id: 'stats',
            asideText: null
        });
    }

    const contributedItemsById = new Map();
    const contributedItems = getContributedSettingsMenuItems(player);
    for (const contributedItem of contributedItems) {
        menuItems.push({
            name: contributedItem.name,
            id: contributedItem.id,
            secondaryText: contributedItem.secondaryText
        });
        contributedItemsById.set(contributedItem.id, contributedItem);
    }

    return actionsheet.show({
        items: menuItems,
        positionTo: options.positionTo
    }).then(function (id) {
        return handleSelectedOption(id, options, player, contributedItemsById);
    });
}

export function show(options) {
    const player = options.player;
    const currentItem = playbackManager.currentItem(player);

    if (!currentItem?.ServerId) {
        return showWithUser(options, player, null);
    }

    const apiClient = ServerConnections.getApiClient(currentItem.ServerId);
    return apiClient.getCurrentUser().then(function (user) {
        return showWithUser(options, player, user);
    });
}

function handleSelectedOption(id, options, player, contributedItemsById) {
    switch (id) {
        case 'quality':
            return showQualityMenu(player, options.positionTo);
        case 'aspectratio':
            return showAspectRatioMenu(player, options.positionTo);
        case 'playbackrate':
            return showPlaybackRateMenu(player, options.positionTo);
        case 'repeatmode':
            return showRepeatModeMenu(player, options.positionTo);
        case 'stats':
            if (options.onOption) {
                options.onOption('stats');
            }
            return Promise.resolve();
        case 'suboffset':
            if (options.onOption) {
                options.onOption('suboffset');
            }
            return Promise.resolve();
        default:
            break;
    }

    const contributedItem = contributedItemsById.get(id);
    if (contributedItem) {
        return contributedItem.onSelect();
    }

    return Promise.reject();
}

export default {
    show: show
};
