import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHDRToSDRRenderSettings } from '../RenderSettings';
import type WebGPUPlayer from '../WebGPUPlayer';
import { createDefaultWebGPUUserSettings } from '../WebGPUUserSettings';
import {
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS,
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
} from '../custom/CustomAudioDownmixAlgorithm';

const storageMockState = vi.hoisted(() => ({
    audioDownmixAlgorithm: 'standard-lo-ro',
    value: null as string | null
}));

vi.mock('components/layoutManager', () => ({
    default: { tv: false }
}));

vi.mock('scripts/settings/userSettings', () => ({
    currentSettings: {
        get: vi.fn((): string | null => storageMockState.value),
        set: vi.fn((_name: string, value: string): void => {
            storageMockState.value = value;
        })
    },
    webGPUAudioDownmixAlgorithm: vi.fn((value?: string): string => {
        if (value !== undefined) {
            storageMockState.audioDownmixAlgorithm = value;
        }
        return storageMockState.audioDownmixAlgorithm;
    })
}));

vi.mock('elements/emby-button/emby-button', () => ({}));
vi.mock('elements/emby-button/paper-icon-button-light', () => ({}));
vi.mock('elements/emby-checkbox/emby-checkbox', () => ({}));
vi.mock('elements/emby-input/emby-input', () => ({}));
vi.mock('elements/emby-select/emby-select', () => ({}));
vi.mock('elements/emby-slider/emby-slider', () => ({}));
vi.mock('material-design-icons-iconfont', () => ({}));
vi.mock('./WebGPUPlaybackSettingsDialog.scss', () => ({}));

import { showWebGPUPlaybackSettingsPanel } from './WebGPUPlaybackSettingsDialog';

type AnimationFrameHarness = {
    callbacks: Map<number, FrameRequestCallback>
    nextIdentifier: number
};

function requirePanelElement<ElementType extends Element>(
    panel: HTMLElement,
    selector: string
): ElementType {
    const element = panel.querySelector<ElementType>(selector);
    if (!element) {
        throw new Error(`Expected panel element ${selector}`);
    }
    return element;
}

describe('WebGPUPlaybackSettingsPanel', () => {
    let animationFrames: AnimationFrameHarness;

    beforeEach(() => {
        vi.clearAllMocks();
        while (document.body.firstChild) {
            document.body.removeChild(document.body.firstChild);
        }
        animationFrames = {
            callbacks: new Map<number, FrameRequestCallback>(),
            nextIdentifier: 1
        };
        vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback): number => {
            const identifier = animationFrames.nextIdentifier;
            animationFrames.nextIdentifier += 1;
            animationFrames.callbacks.set(identifier, callback);
            return identifier;
        }));
        vi.stubGlobal('cancelAnimationFrame', vi.fn((identifier: number): void => {
            animationFrames.callbacks.delete(identifier);
        }));

        const defaults = createDefaultWebGPUUserSettings();
        storageMockState.audioDownmixAlgorithm = DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM;
        storageMockState.value = JSON.stringify({
            ...defaults,
            render: {
                automaticInputPeakNits: false,
                settings: createHDRToSDRRenderSettings({
                    toneMapping: { inputPeakNits: 900 }
                })
            }
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('reuses one non-modal panel below playback info and restores individual defaults', async () => {
        const playbackInfo = document.createElement('div');
        playbackInfo.classList.add('playerStats');
        playbackInfo.getBoundingClientRect = vi.fn(() => ({
            bottom: 320,
            height: 200,
            left: 24,
            right: 424,
            top: 120,
            width: 400,
            x: 24,
            y: 120
        } as DOMRect));
        document.body.appendChild(playbackInfo);

        const activeRenderSettings = createHDRToSDRRenderSettings({
            toneMapping: { inputPeakNits: 900 }
        });
        const player = {
            getDetectedInputPeakNits: vi.fn(() => 4_000),
            getRenderSettings: vi.fn(() => activeRenderSettings),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true)
        } as unknown as WebGPUPlayer;

        const firstOpenPromise = showWebGPUPlaybackSettingsPanel(player);
        const secondOpenPromise = showWebGPUPlaybackSettingsPanel(player);
        expect(secondOpenPromise).toBe(firstOpenPromise);
        const panels = document.querySelectorAll<HTMLElement>('.webgpuSettingsPanel');
        expect(panels).toHaveLength(1);
        const panel = panels[0];
        expect(panel.tagName).toBe('ASIDE');
        expect(panel.style.getPropertyValue('--webgpu-settings-top')).toBe('328px');
        expect(document.querySelector('.dialogBackdrop')).toBeNull();
        expect(document.querySelector('.dialogContainer')).toBeNull();
        const defaultButtons = Array.from(
            panel.querySelectorAll<HTMLButtonElement>('[data-default-setting]')
        );
        expect(defaultButtons).toHaveLength(15);
        expect(new Set(defaultButtons.map(button => button.dataset.defaultSetting)).size).toBe(15);
        expect(defaultButtons.every(button => button.textContent === 'Default')).toBe(true);
        expect(requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-slider="centerLevel"]'
        ).max).toBe('2');
        expect(requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-slider="surroundLevel"]'
        ).max).toBe('2');
        expect(requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-slider="outputGain"]'
        ).max).toBe('10');
        expect(requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-number="outputGain"]'
        ).max).toBe('10');
        expect(player.updateRenderSettings).toHaveBeenCalledWith(
            expect.objectContaining({
                toneMapping: expect.objectContaining({ inputPeakNits: 900 })
            }),
            false
        );

        const brightnessInput = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-number="brightness"]'
        );
        brightnessInput.value = '0.25';
        brightnessInput.dispatchEvent(new Event('change'));

        const automaticInputPeakCheckbox = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-checkbox="automaticInputPeakNits"]'
        );
        automaticInputPeakCheckbox.checked = true;
        automaticInputPeakCheckbox.dispatchEvent(new Event('change'));

        const forceStereoCheckbox = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-checkbox="forceStereoDownmix"]'
        );
        forceStereoCheckbox.checked = true;
        forceStereoCheckbox.dispatchEvent(new Event('change'));

        const pendingCallbacks = Array.from(animationFrames.callbacks.values());
        animationFrames.callbacks.clear();
        for (const callback of pendingCallbacks) {
            callback(0);
        }
        expect(player.updateRenderSettings).toHaveBeenLastCalledWith(
            expect.objectContaining({
                display: expect.objectContaining({ brightness: 0.25 }),
                toneMapping: expect.objectContaining({ inputPeakNits: 4_000 })
            }),
            true
        );

        const savedSettings = JSON.parse(storageMockState.value ?? '{}') as {
            audio?: { forceStereoDownmix?: boolean }
            render?: {
                automaticInputPeakNits?: boolean
                settings?: { display?: { brightness?: number } }
            }
        };
        expect(savedSettings).toMatchObject({
            audio: { forceStereoDownmix: true },
            render: {
                automaticInputPeakNits: true,
                settings: { display: { brightness: 0.25 } }
            }
        });

        const operatorSelect = requirePanelElement<HTMLSelectElement>(
            panel,
            '[data-setting-select="operator"]'
        );
        operatorSelect.value = 'aces';
        operatorSelect.dispatchEvent(new Event('change'));
        automaticInputPeakCheckbox.checked = false;
        automaticInputPeakCheckbox.dispatchEvent(new Event('change'));
        for (const settingKey of [
            'brightness',
            'operator',
            'audioDownmixAlgorithm',
            'automaticInputPeakNits',
            'forceStereoDownmix'
        ]) {
            requirePanelElement<HTMLButtonElement>(
                panel,
                `[data-default-setting="${settingKey}"]`
            ).click();
        }

        const defaultedSettings = JSON.parse(storageMockState.value ?? '{}') as {
            audio?: { forceStereoDownmix?: boolean }
            render?: {
                automaticInputPeakNits?: boolean
                settings?: {
                    display?: { brightness?: number }
                    toneMapping?: { operator?: string }
                }
            }
        };
        expect(defaultedSettings).toMatchObject({
            audio: { forceStereoDownmix: false },
            render: {
                automaticInputPeakNits: true,
                settings: {
                    display: { brightness: 0 },
                    toneMapping: { operator: 'spline' }
                }
            }
        });

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await firstOpenPromise;
        expect(panel.isConnected).toBe(false);

        const thirdOpenPromise = showWebGPUPlaybackSettingsPanel(player);
        const reopenedPanel = requirePanelElement<HTMLElement>(
            document.body,
            '.webgpuSettingsPanel'
        );
        expect(reopenedPanel).not.toBe(panel);
        requirePanelElement<HTMLButtonElement>(
            reopenedPanel,
            '.webgpuSettingsClose'
        ).click();
        await thirdOpenPromise;
    });

    it('applies gains live while keeping output layout and algorithm restart-required', async () => {
        const activeRenderSettings = createHDRToSDRRenderSettings();
        const updateAudioDownmixSettings = vi.fn(() => true);
        const player = {
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => activeRenderSettings),
            updateAudioDownmixSettings,
            updateRenderSettings: vi.fn(() => true)
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const audioStatus = requirePanelElement<HTMLElement>(panel, '[data-audio-status]');

        const gainEdits = [
            { key: 'centerLevel', value: '0.4' },
            { key: 'surroundLevel', value: '0.6' },
            { key: 'outputGain', value: '0.8' }
        ];
        for (const gainEdit of gainEdits) {
            const numberInput = requirePanelElement<HTMLInputElement>(
                panel,
                `[data-setting-number="${gainEdit.key}"]`
            );
            numberInput.value = gainEdit.value;
            numberInput.dispatchEvent(new Event('change'));
            expect(updateAudioDownmixSettings).toHaveBeenLastCalledWith(
                expect.objectContaining({ [gainEdit.key]: Number(gainEdit.value) })
            );
            expect(audioStatus.textContent).toContain('applied live and saved');
        }

        const liveUpdateCount = updateAudioDownmixSettings.mock.calls.length;
        const forceStereoCheckbox = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-checkbox="forceStereoDownmix"]'
        );
        forceStereoCheckbox.checked = true;
        forceStereoCheckbox.dispatchEvent(new Event('change'));
        expect(updateAudioDownmixSettings).toHaveBeenCalledTimes(liveUpdateCount);
        expect(audioStatus.textContent).toContain('Force stereo is restart-required');
        expect(audioStatus.textContent).toContain('Downmix gains are unchanged');

        const audioDownmixAlgorithmSelect = requirePanelElement<HTMLSelectElement>(
            panel,
            '[data-setting-select="audioDownmixAlgorithm"]'
        );
        expect(audioDownmixAlgorithmSelect.value).toBe(
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );
        audioDownmixAlgorithmSelect.value = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845;
        audioDownmixAlgorithmSelect.dispatchEvent(new Event('change'));
        expect(storageMockState.audioDownmixAlgorithm).toBe(
            CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845
        );
        expect(updateAudioDownmixSettings).toHaveBeenCalledTimes(liveUpdateCount);
        expect(audioStatus.textContent).toContain('Downmix algorithm is restart-required');
        expect(audioStatus.textContent).toContain('Downmix gains are unchanged');

        requirePanelElement<HTMLButtonElement>(
            panel,
            '[data-default-setting="audioDownmixAlgorithm"]'
        ).click();
        expect(storageMockState.audioDownmixAlgorithm).toBe(
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );
        expect(audioDownmixAlgorithmSelect.value).toBe(
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );

        requirePanelElement<HTMLButtonElement>(
            panel,
            '[data-default-setting="centerLevel"]'
        ).click();
        expect(updateAudioDownmixSettings).toHaveBeenLastCalledWith(
            expect.objectContaining({ centerLevel: 1 })
        );

        audioDownmixAlgorithmSelect.value = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4;
        audioDownmixAlgorithmSelect.dispatchEvent(new Event('change'));
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAudio').click();
        expect(updateAudioDownmixSettings).toHaveBeenLastCalledWith(
            createDefaultWebGPUUserSettings().audio.downmix
        );
        expect(audioStatus.textContent).toContain('applied live and saved');
        expect(audioStatus.textContent).toContain('Force stereo is restart-required');
        expect(audioStatus.textContent).toContain('Downmix algorithm is restart-required');
        expect(storageMockState.audioDownmixAlgorithm).toBe(
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );

        audioDownmixAlgorithmSelect.value = CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750;
        audioDownmixAlgorithmSelect.dispatchEvent(new Event('change'));
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAll').click();
        expect(updateAudioDownmixSettings).toHaveBeenLastCalledWith(
            createDefaultWebGPUUserSettings().audio.downmix
        );
        expect(storageMockState.audioDownmixAlgorithm).toBe(
            DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
        );

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('reports when no compatible active downmix accepts a live gain update', async () => {
        const activeRenderSettings = createHDRToSDRRenderSettings();
        const updateAudioDownmixSettings = vi.fn(() => false);
        const player = {
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => activeRenderSettings),
            updateAudioDownmixSettings,
            updateRenderSettings: vi.fn(() => true)
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const outputGain = requirePanelElement<HTMLInputElement>(
            panel,
            '[data-setting-slider="outputGain"]'
        );
        outputGain.value = '0.5';
        outputGain.dispatchEvent(new Event('input'));

        expect(updateAudioDownmixSettings).toHaveBeenCalledWith(
            expect.objectContaining({ outputGain: 0.5 })
        );
        expect(requirePanelElement<HTMLElement>(
            panel,
            '[data-audio-status]'
        ).textContent).toContain('No active compatible WebGPU stereo downmix');

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });
});
