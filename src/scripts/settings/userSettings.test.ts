import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('hooks/api/useDisplayPreferences', () => ({
    getDisplayPreferencesQuery: vi.fn()
}));
vi.mock('hooks/api/useUser', () => ({
    getUserQuery: vi.fn()
}));
vi.mock('hooks/useUsers', () => ({
    ['QUERY_KEY']: 'User'
}));
vi.mock('lib/jellyfin-apiclient', () => ({
    ServerConnections: {}
}));
vi.mock('utils/query/queryClient', () => ({
    queryClient: {}
}));

import { UserSettings } from './userSettings';

describe('client-side HDR tone-mapping settings', () => {
    beforeEach(() => {
        window.localStorage.clear();
    });

    it('enables client-side HDR tone mapping by default', () => {
        const settings = new UserSettings();

        expect(settings.enableClientHDRToneMapping(undefined)).toBe(true);

        settings.enableClientHDRToneMapping(false);

        expect(settings.enableClientHDRToneMapping(undefined)).toBe(false);
    });

    it('uses BT.2390 as the default preset', () => {
        const settings = new UserSettings();

        expect(settings.clientHDRToneMappingPreset(undefined)).toBe('bt2390');
    });

    it('stores valid presets and rejects invalid presets', () => {
        const settings = new UserSettings();

        settings.clientHDRToneMappingPreset('bright');
        expect(settings.clientHDRToneMappingPreset(undefined)).toBe('bright');

        settings.clientHDRToneMappingPreset('bt2390');
        expect(settings.clientHDRToneMappingPreset(undefined)).toBe('bt2390');

        settings.clientHDRToneMappingPreset('invalid');
        expect(settings.clientHDRToneMappingPreset(undefined)).toBe('bt2390');

        window.localStorage.setItem('clientHDRToneMappingPreset', 'invalid');
        expect(settings.clientHDRToneMappingPreset(undefined)).toBe('bt2390');
    });

    it('stores validated BT.2390 parameters locally', () => {
        const settings = new UserSettings();

        expect(
            settings.clientHDRToneMappingBT2390SourcePeakNits(undefined)
        ).toBe(1000);
        expect(
            settings.clientHDRToneMappingBT2390TargetPeakNits(undefined)
        ).toBe(203);
        expect(
            settings.clientHDRToneMappingBT2390KneeOffset(undefined)
        ).toBe(1);

        settings.clientHDRToneMappingBT2390SourcePeakNits(3629);
        settings.clientHDRToneMappingBT2390TargetPeakNits(180);
        settings.clientHDRToneMappingBT2390KneeOffset(0.75);

        expect(
            window.localStorage.getItem(
                'clientHDRToneMappingBT2390SourcePeakNits'
            )
        ).toBe('3629');
        expect(
            settings.clientHDRToneMappingBT2390SourcePeakNits(undefined)
        ).toBe(3629);
        expect(
            settings.clientHDRToneMappingBT2390TargetPeakNits(undefined)
        ).toBe(180);
        expect(
            settings.clientHDRToneMappingBT2390KneeOffset(undefined)
        ).toBe(0.75);
    });

    it('stores unclamped finite BT.2390 parameters and replaces corrupt values', () => {
        const settings = new UserSettings();

        settings.clientHDRToneMappingBT2390SourcePeakNits(10000);
        settings.clientHDRToneMappingBT2390TargetPeakNits(50);
        settings.clientHDRToneMappingBT2390KneeOffset(3);

        expect(
            settings.clientHDRToneMappingBT2390SourcePeakNits(undefined)
        ).toBe(10000);
        expect(
            settings.clientHDRToneMappingBT2390TargetPeakNits(undefined)
        ).toBe(50);
        expect(
            settings.clientHDRToneMappingBT2390KneeOffset(undefined)
        ).toBe(3);

        window.localStorage.setItem(
            'clientHDRToneMappingBT2390SourcePeakNits',
            'invalid'
        );
        window.localStorage.setItem(
            'clientHDRToneMappingBT2390TargetPeakNits',
            ''
        );
        window.localStorage.setItem(
            'clientHDRToneMappingBT2390KneeOffset',
            'Infinity'
        );

        expect(
            settings.clientHDRToneMappingBT2390SourcePeakNits(undefined)
        ).toBe(1000);
        expect(
            settings.clientHDRToneMappingBT2390TargetPeakNits(undefined)
        ).toBe(203);
        expect(
            settings.clientHDRToneMappingBT2390KneeOffset(undefined)
        ).toBe(1);
    });

    it('stores the unclamped live CSS desaturation strength', () => {
        const settings = new UserSettings();

        expect(
            settings.clientHDRToneMappingDesaturationStrength(undefined)
        ).toBe(100);

        settings.clientHDRToneMappingDesaturationStrength(45);
        expect(
            settings.clientHDRToneMappingDesaturationStrength(undefined)
        ).toBe(45);

        settings.clientHDRToneMappingDesaturationStrength(-20);
        expect(
            settings.clientHDRToneMappingDesaturationStrength(undefined)
        ).toBe(-20);

        settings.clientHDRToneMappingDesaturationStrength(150);
        expect(
            settings.clientHDRToneMappingDesaturationStrength(undefined)
        ).toBe(150);
    });
});
