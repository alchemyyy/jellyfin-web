import browser from 'scripts/browser';

import { isClientHDRToneMappingRuntimeSupported } from './compatibility';

const HIGH_DYNAMIC_RANGE_QUERY = '(dynamic-range: high)';

interface BrowserRuntimeInfo {
    chrome?: boolean;
    edgeChromium?: boolean;
    mobile?: boolean;
    tv?: boolean;
    versionMajor?: number;
    windows?: boolean;
}

/**
 * Returns whether the current browser and output can consume the experimental
 * timed AGTM metadata path.
 */
export function isClientHDRToneMappingRuntimeAvailable(): boolean {
    const browserRuntimeInfo = browser as BrowserRuntimeInfo;
    const dynamicRangeHigh = typeof window.matchMedia === 'function'
        && window.matchMedia(HIGH_DYNAMIC_RANGE_QUERY).matches;

    return isClientHDRToneMappingRuntimeSupported({
        chromeVersion: browserRuntimeInfo.versionMajor ?? 0,
        dynamicRangeHigh,
        isChrome: browserRuntimeInfo.chrome === true,
        isDesktop: browserRuntimeInfo.mobile !== true
            && browserRuntimeInfo.tv !== true,
        isEdgeChromium: browserRuntimeInfo.edgeChromium === true,
        isWindows: browserRuntimeInfo.windows === true
    });
}
