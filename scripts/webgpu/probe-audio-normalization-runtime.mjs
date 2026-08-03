import { pathToFileURL } from 'node:url';

import {
    evaluateValue,
    getBrowserPageTarget,
    RawCDPClient
} from './run-browser-playback-smoke.mjs';

const DEFAULT_DEBUG_URL = 'http://localhost:9224';
const DEFAULT_FRONTEND_URL = 'http://localhost:8096/web/';
const DEFAULT_TIMEOUT_MILLISECONDS = 15_000;

/** Summarizes normalization metadata without retaining catalog identities. */
export function summarizeAudioNormalizationItems(items) {
    const groups = {
        audio: createNormalizationGroup(),
        other: createNormalizationGroup(),
        video: createNormalizationGroup()
    };
    if (!Array.isArray(items)) {
        return { groups, totalItemCount: 0 };
    }

    for (const item of items) {
        let groupName = 'other';
        switch (item?.MediaType) {
            case 'Audio':
                groupName = 'audio';
                break;
            case 'Video':
                groupName = 'video';
                break;
            default:
                break;
        }
        const group = groups[groupName];
        group.itemCount += 1;
        recordGain(group.track, item?.NormalizationGain);
        recordGain(group.album, item?.AlbumNormalizationGain);
    }
    return { groups, totalItemCount: items.length };
}

function createNormalizationGroup() {
    return {
        album: createGainSummary(),
        itemCount: 0,
        track: createGainSummary()
    };
}

function createGainSummary() {
    return {
        finiteCount: 0,
        maximumDecibels: null,
        minimumDecibels: null,
        nonUnityCount: 0
    };
}

function recordGain(summary, value) {
    if (!Number.isFinite(value)) {
        return;
    }
    summary.finiteCount += 1;
    summary.maximumDecibels = summary.maximumDecibels === null ?
        value : Math.max(summary.maximumDecibels, value);
    summary.minimumDecibels = summary.minimumDecibels === null ?
        value : Math.min(summary.minimumDecibels, value);
    if (value !== 0) {
        summary.nonUnityCount += 1;
    }
}

export function createAudioNormalizationProbeExpression() {
    return `(async () => {
        if (typeof ApiClient !== 'object'
            || typeof ApiClient.getCurrentUserId !== 'function'
            || typeof ApiClient.getItems !== 'function') {
            return { authenticated: false, reason: 'api-client-unavailable' };
        }
        const userIdentifier = ApiClient.getCurrentUserId();
        if (!userIdentifier || !ApiClient.accessToken?.()) {
            return { authenticated: false, reason: 'authentication-unavailable' };
        }
        const summarizeAudioNormalizationItems =
            ${summarizeAudioNormalizationItems.toString()};
        const createNormalizationGroup = ${createNormalizationGroup.toString()};
        const createGainSummary = ${createGainSummary.toString()};
        const recordGain = ${recordGain.toString()};
        const response = await ApiClient.getItems(userIdentifier, {
            Fields: 'MediaSources',
            Limit: 10000,
            Recursive: true
        });
        const storedMode = localStorage.getItem(
            userIdentifier + '-selectAudioNormalization'
        );
        const supportedModes = new Set([ 'AlbumGain', 'Off', 'TrackGain' ]);
        return {
            authenticated: true,
            catalog: summarizeAudioNormalizationItems(response?.Items),
            mode: supportedModes.has(storedMode) ? storedMode : 'TrackGain',
            reason: null
        };
    })()`;
}

async function main() {
    const configuration = {
        debugURL: process.argv[2] ?? DEFAULT_DEBUG_URL,
        frontendURL: process.argv[3] ?? DEFAULT_FRONTEND_URL,
        timeoutMilliseconds: DEFAULT_TIMEOUT_MILLISECONDS
    };
    const pageTarget = await getBrowserPageTarget(configuration);
    const client = await RawCDPClient.connect(
        pageTarget.webSocketDebuggerUrl,
        configuration.timeoutMilliseconds
    );
    try {
        await client.send('Runtime.enable');
        const result = await evaluateValue(
            client,
            createAudioNormalizationProbeExpression()
        );
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } finally {
        client.close();
    }
}

const entryURL = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entryURL === import.meta.url) {
    await main();
}
