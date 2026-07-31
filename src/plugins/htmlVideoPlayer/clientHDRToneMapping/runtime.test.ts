import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserRuntimeInfo = vi.hoisted(() => ({
    chrome: true,
    edgeChromium: false,
    mobile: false,
    tv: false,
    versionMajor: 151,
    windows: true
}));

vi.mock('scripts/browser', () => ({
    default: browserRuntimeInfo
}));

import { isClientHDRToneMappingRuntimeAvailable } from './runtime';

describe('client HDR tone-mapping runtime adapter', () => {
    beforeEach(() => {
        Object.assign(browserRuntimeInfo, {
            chrome: true,
            edgeChromium: false,
            mobile: false,
            tv: false,
            versionMajor: 151,
            windows: true
        });
        setDynamicRangeHigh(false);
    });

    it('accepts Chrome 151 on Windows with an SDR output', () => {
        expect(isClientHDRToneMappingRuntimeAvailable()).toBe(true);
        expect(window.matchMedia).toHaveBeenCalledWith('(dynamic-range: high)');
    });

    it('rejects an HDR output and unsupported browser adapters', () => {
        setDynamicRangeHigh(true);
        expect(isClientHDRToneMappingRuntimeAvailable()).toBe(false);

        setDynamicRangeHigh(false);
        browserRuntimeInfo.edgeChromium = true;
        expect(isClientHDRToneMappingRuntimeAvailable()).toBe(false);

        browserRuntimeInfo.edgeChromium = false;
        browserRuntimeInfo.versionMajor = 150;
        expect(isClientHDRToneMappingRuntimeAvailable()).toBe(false);
    });
});

function setDynamicRangeHigh(matches: boolean): void {
    Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        value: vi.fn(() => ({
            matches
        } as MediaQueryList))
    });
}
