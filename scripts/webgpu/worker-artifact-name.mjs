const CUSTOM_DECODE_WORKER_ASSET_PATTERN =
    /^CustomDecode\.worker\.[a-f0-9]{8,64}\.bundle\.js$/u;
const LEGACY_CUSTOM_DECODE_WORKER_ASSET_NAME = 'CustomDecode.worker.bundle.js';

/** Selects exactly one content-addressed custom decode worker, with legacy fallback. */
export function selectCustomDecodeWorkerAssetName(fileNames) {
    if (!Array.isArray(fileNames) || fileNames.some(fileName => typeof fileName !== 'string')) {
        throw new TypeError('Worker artifact file names must be a string array');
    }
    const contentAddressedMatches = [];
    for (const fileName of fileNames) {
        if (CUSTOM_DECODE_WORKER_ASSET_PATTERN.test(fileName)) {
            contentAddressedMatches.push(fileName);
        }
    }
    if (contentAddressedMatches.length > 1) {
        return null;
    }
    if (contentAddressedMatches.length === 1) {
        return contentAddressedMatches[0];
    }
    return fileNames.includes(LEGACY_CUSTOM_DECODE_WORKER_ASSET_NAME) ?
        LEGACY_CUSTOM_DECODE_WORKER_ASSET_NAME :
        null;
}
