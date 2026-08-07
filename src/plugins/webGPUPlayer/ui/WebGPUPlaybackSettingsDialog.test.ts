import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHDRToSDRRenderSettings } from '../RenderSettings';
import type WebGPUPlayer from '../WebGPUPlayer';
import { createDefaultWebGPUUserSettings } from '../WebGPUUserSettings';
import {
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS,
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM
} from '../custom/CustomAudioDownmixAlgorithm';

type AudioOutputSnapshotMock = {
    activeDeviceId: string | null
    devices: Array<{ deviceId: string, label: string }>
    messageCode: string
    pickerAvailable: boolean
    selectedDeviceAvailability: 'active' | 'available' | 'unavailable' | 'unknown'
    selectedDeviceId: string | null
    status: string
};

const storageMockState = vi.hoisted(() => ({
    audioDownmixAlgorithm: 'standard-lo-ro',
    value: null as string | null
}));

const audioOutputManagerMockState = vi.hoisted(() => {
    const listeners = new Set<(snapshot: AudioOutputSnapshotMock) => void>();
    return {
        cancelCount: 0,
        listeners,
        pickerRevision: 0,
        requestPromise: null as Promise<string | null> | null,
        requestResult: null as string | null,
        snapshot: {
            activeDeviceId: null,
            devices: [] as Array<{ deviceId: string, label: string }>,
            messageCode: 'default-saved',
            pickerAvailable: false,
            selectedDeviceAvailability: 'unknown',
            selectedDeviceId: null as string | null,
            status: 'default'
        } as AudioOutputSnapshotMock
    };
});

vi.mock('components/layoutManager', () => ({
    default: { tv: false }
}));

vi.mock('lib/globalize', () => {
    const translations: Record<string, string> = {
        ButtonChooseAudioOutput: 'Choose output',
        Default: 'Default',
        LabelAudioOutput: 'Audio output',
        WebGPUAudioOutputAndDownmix: 'Audio output and downmix',
        WebGPUAudioOutputDescription: 'System default follows operating-system output changes.',
        WebGPUAudioOutputPickerUnavailable: 'This browser does not expose the audio output picker',
        WebGPUAudioOutputPickerUnavailableHelp: 'The browser output picker is unavailable; already permitted outputs remain usable.',
        WebGPUAuthorizeAudioOutput: 'Authorize an audio output through the browser',
        WebGPUAudioOutputStatusDefaultActive: 'Using the system default audio output.',
        WebGPUAudioOutputStatusDefaultSaved: 'The system default audio output is saved.',
        WebGPUAudioOutputStatusPickerNotAllowed: 'Audio output selection is blocked.',
        WebGPUAudioOutputStatusSelectedActive: 'Using the selected audio output.',
        WebGPUAudioOutputStatusSelectedEnumerationFailed: 'Available outputs could not be refreshed; the selected output remains active.',
        WebGPUAudioOutputStatusSelectedSaved: 'The selected audio output is saved.',
        WebGPUAudioOutputStatusSelectedUnavailableDefault: 'The saved output is unavailable; using the system default.',
        WebGPUPreviouslySelectedAudioOutputUnavailable: 'Previously selected output (unavailable)',
        WebGPUSelectedAudioOutputActive: 'Selected output (active)',
        WebGPUSelectedAudioOutputAvailabilityUnknown: 'Selected output (availability unknown)',
        WebGPUSelectedAudioOutputAvailable: 'Selected output (permitted)',
        WebGPUUnnamedAudioOutput: 'Audio output {0}'
    };
    return {
        default: {
            translate: (key: string, ...values: Array<string | number>): string => {
                let translatedValue = translations[key] ?? key;
                for (const [ index, value ] of values.entries()) {
                    translatedValue = translatedValue.replace(`{${index}}`, String(value));
                }
                return translatedValue;
            }
        }
    };
});

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
vi.mock('../WebGPUAudioOutputManager', () => ({
    getWebGPUAudioOutputManager: (): object => ({
        cancelAudioOutputSelectionRequest: vi.fn((): void => {
            audioOutputManagerMockState.cancelCount += 1;
            audioOutputManagerMockState.pickerRevision += 1;
        }),
        getSnapshot: vi.fn(() => ({
            ...audioOutputManagerMockState.snapshot,
            devices: audioOutputManagerMockState.snapshot.devices.map(device => ({ ...device }))
        })),
        requestAudioOutputSelection: vi.fn((): Promise<string | null> => {
            const requestRevision = audioOutputManagerMockState.pickerRevision + 1;
            audioOutputManagerMockState.pickerRevision = requestRevision;
            const requestPromise = audioOutputManagerMockState.requestPromise
                ?? Promise.resolve(audioOutputManagerMockState.requestResult);
            return requestPromise.then((deviceId): string | null => (
                audioOutputManagerMockState.pickerRevision === requestRevision ?
                    deviceId :
                    null
            )).catch((): null => {
                if (audioOutputManagerMockState.pickerRevision === requestRevision) {
                    audioOutputManagerMockState.snapshot.messageCode = 'picker-not-allowed';
                    audioOutputManagerMockState.snapshot.status = 'error';
                    for (const listener of audioOutputManagerMockState.listeners) {
                        listener(audioOutputManagerMockState.snapshot);
                    }
                }
                return null;
            });
        }),
        setSelectedDeviceId: vi.fn((deviceId: string | null): Promise<void> => {
            audioOutputManagerMockState.pickerRevision += 1;
            audioOutputManagerMockState.snapshot.selectedDeviceId = deviceId;
            audioOutputManagerMockState.snapshot.activeDeviceId = deviceId;
            audioOutputManagerMockState.snapshot.selectedDeviceAvailability = deviceId ?
                'active' :
                'unknown';
            audioOutputManagerMockState.snapshot.status = deviceId ? 'selected' : 'default';
            audioOutputManagerMockState.snapshot.messageCode = deviceId ?
                'selected-active' :
                'default-active';
            for (const listener of audioOutputManagerMockState.listeners) {
                listener({
                    ...audioOutputManagerMockState.snapshot,
                    devices: audioOutputManagerMockState.snapshot.devices.map(
                        device => ({ ...device })
                    )
                });
            }
            return Promise.resolve();
        }),
        subscribe: vi.fn((listener: (snapshot: typeof audioOutputManagerMockState.snapshot) => void) => {
            audioOutputManagerMockState.listeners.add(listener);
            listener(audioOutputManagerMockState.snapshot);
            return (): void => {
                audioOutputManagerMockState.listeners.delete(listener);
            };
        })
    })
}));

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
        audioOutputManagerMockState.cancelCount = 0;
        audioOutputManagerMockState.pickerRevision = 0;
        audioOutputManagerMockState.listeners.clear();
        audioOutputManagerMockState.requestPromise = null;
        audioOutputManagerMockState.requestResult = null;
        audioOutputManagerMockState.snapshot = {
            activeDeviceId: null,
            devices: [],
            messageCode: 'default-saved',
            pickerAvailable: false,
            selectedDeviceAvailability: 'unknown',
            selectedDeviceId: null,
            status: 'default'
        };
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

    it('focuses the first opened panel and restores its invoking element on close', async () => {
        const invokingButton = document.createElement('button');
        invokingButton.type = 'button';
        document.body.appendChild(invokingButton);
        invokingButton.focus();
        const player = {
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true)
        } as unknown as WebGPUPlayer;

        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const closeButton = requirePanelElement<HTMLButtonElement>(
            panel,
            '.webgpuSettingsClose'
        );
        expect(document.activeElement).toBe(closeButton);

        closeButton.click();
        await panelPromise;

        expect(document.activeElement).toBe(invokingButton);
        expect(audioOutputManagerMockState.cancelCount).toBe(1);
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

    it('lists permitted outputs, persists live choices, and reflects hotplug fallback', async () => {
        const defaults = createDefaultWebGPUUserSettings();
        storageMockState.value = JSON.stringify({
            ...defaults,
            audio: { ...defaults.audio, outputDeviceId: 'speaker-a' }
        });
        audioOutputManagerMockState.snapshot = {
            activeDeviceId: 'speaker-a',
            devices: [
                { deviceId: 'speaker-a', label: '' },
                { deviceId: 'speaker-b', label: 'Headphones' }
            ],
            messageCode: 'selected-active',
            pickerAvailable: true,
            selectedDeviceAvailability: 'active',
            selectedDeviceId: 'speaker-a',
            status: 'selected'
        };
        const player = {
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true)
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const outputSelect = requirePanelElement<HTMLSelectElement>(
            panel,
            '[data-audio-output-select]'
        );
        expect(Array.from(outputSelect.options).map(option => option.textContent)).toEqual([
            'Default',
            'Audio output 1',
            'Headphones'
        ]);
        expect(outputSelect.value).toBe('speaker-a');

        outputSelect.value = 'speaker-b';
        outputSelect.dispatchEvent(new Event('change'));
        expect(JSON.parse(storageMockState.value ?? '{}')).toMatchObject({
            audio: { outputDeviceId: 'speaker-b' }
        });

        audioOutputManagerMockState.snapshot = {
            activeDeviceId: null,
            devices: [ { deviceId: 'speaker-a', label: '' } ],
            messageCode: 'selected-unavailable-default',
            pickerAvailable: true,
            selectedDeviceAvailability: 'unavailable',
            selectedDeviceId: 'speaker-b',
            status: 'fallback'
        };
        for (const listener of audioOutputManagerMockState.listeners) {
            listener(audioOutputManagerMockState.snapshot);
        }
        expect(outputSelect.selectedOptions[0]?.textContent).toBe(
            'Previously selected output (unavailable)'
        );
        expect(requirePanelElement<HTMLElement>(
            panel,
            '[data-audio-output-status]'
        ).textContent).toContain('saved output is unavailable');

        audioOutputManagerMockState.requestResult = 'rotated-output';
        requirePanelElement<HTMLButtonElement>(panel, '[data-audio-output-picker]').click();
        await vi.waitFor(() => expect(
            JSON.parse(storageMockState.value ?? '{}')
        ).toMatchObject({ audio: { outputDeviceId: 'rotated-output' } }));

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
        expect(audioOutputManagerMockState.listeners.size).toBe(0);
    });

    it('invalidates late picker success and rejection after dropdown changes', async () => {
        const defaults = createDefaultWebGPUUserSettings();
        storageMockState.value = JSON.stringify(defaults);
        audioOutputManagerMockState.snapshot = {
            activeDeviceId: null,
            devices: [
                { deviceId: 'speaker-a', label: 'Speakers' },
                { deviceId: 'speaker-b', label: 'Headphones' }
            ],
            messageCode: 'default-active',
            pickerAvailable: true,
            selectedDeviceAvailability: 'unknown',
            selectedDeviceId: null,
            status: 'default'
        };
        let resolvePicker: (deviceId: string | null) => void = (
            deviceId: string | null
        ): void => {
            throw new Error(`Missing picker resolver for ${deviceId ?? 'default'}`);
        };
        audioOutputManagerMockState.requestPromise = new Promise<string | null>((resolve): void => {
            resolvePicker = resolve;
        });
        const player = {
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true)
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const outputSelect = requirePanelElement<HTMLSelectElement>(
            panel,
            '[data-audio-output-select]'
        );
        const pickerButton = requirePanelElement<HTMLButtonElement>(
            panel,
            '[data-audio-output-picker]'
        );

        pickerButton.click();
        outputSelect.value = 'speaker-b';
        outputSelect.dispatchEvent(new Event('change'));
        resolvePicker('late-success');
        await Promise.resolve();
        await Promise.resolve();
        expect(JSON.parse(storageMockState.value ?? '{}')).toMatchObject({
            audio: { outputDeviceId: 'speaker-b' }
        });
        expect(requirePanelElement<HTMLElement>(
            panel,
            '[data-audio-output-status]'
        ).textContent).toContain('Using the selected audio output');

        let rejectPicker: (error: unknown) => void = (error: unknown): void => {
            throw new Error(`Missing picker rejecter for ${String(error)}`);
        };
        audioOutputManagerMockState.requestPromise = new Promise<string | null>(
            (_resolve, reject): void => {
                rejectPicker = reject;
            }
        );
        pickerButton.click();
        outputSelect.value = 'speaker-a';
        outputSelect.dispatchEvent(new Event('change'));
        rejectPicker(new DOMException('Late denial', 'NotAllowedError'));
        await Promise.resolve();
        await Promise.resolve();
        expect(JSON.parse(storageMockState.value ?? '{}')).toMatchObject({
            audio: { outputDeviceId: 'speaker-a' }
        });
        expect(requirePanelElement<HTMLElement>(
            panel,
            '[data-audio-output-status]'
        ).textContent).not.toContain('blocked');
        expect(audioOutputManagerMockState.cancelCount).toBe(2);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('invalidates late picker success and rejection after audio resets', async () => {
        const defaults = createDefaultWebGPUUserSettings();
        storageMockState.value = JSON.stringify({
            ...defaults,
            audio: { ...defaults.audio, outputDeviceId: 'speaker-a' }
        });
        audioOutputManagerMockState.snapshot = {
            activeDeviceId: 'speaker-a',
            devices: [ { deviceId: 'speaker-a', label: 'Speakers' } ],
            messageCode: 'selected-active',
            pickerAvailable: true,
            selectedDeviceAvailability: 'active',
            selectedDeviceId: 'speaker-a',
            status: 'selected'
        };
        let resolvePicker: (deviceId: string | null) => void = (
            deviceId: string | null
        ): void => {
            throw new Error(`Missing picker resolver for ${deviceId ?? 'default'}`);
        };
        audioOutputManagerMockState.requestPromise = new Promise<string | null>((resolve): void => {
            resolvePicker = resolve;
        });
        const player = {
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true)
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const pickerButton = requirePanelElement<HTMLButtonElement>(
            panel,
            '[data-audio-output-picker]'
        );

        pickerButton.click();
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAudio').click();
        resolvePicker('late-success');
        await Promise.resolve();
        await Promise.resolve();
        expect(JSON.parse(storageMockState.value ?? '{}')).toMatchObject({
            audio: { outputDeviceId: null }
        });

        let rejectPicker: (error: unknown) => void = (error: unknown): void => {
            throw new Error(`Missing picker rejecter for ${String(error)}`);
        };
        audioOutputManagerMockState.requestPromise = new Promise<string | null>(
            (_resolve, reject): void => {
                rejectPicker = reject;
            }
        );
        pickerButton.click();
        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAll').click();
        rejectPicker(new DOMException('Late denial', 'NotAllowedError'));
        await Promise.resolve();
        await Promise.resolve();
        expect(JSON.parse(storageMockState.value ?? '{}')).toMatchObject({
            audio: { outputDeviceId: null }
        });
        expect(requirePanelElement<HTMLElement>(
            panel,
            '[data-audio-output-status]'
        ).textContent).not.toContain('blocked');
        expect(audioOutputManagerMockState.cancelCount).toBe(2);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('labels an unenumerated active selection without claiming it is unavailable', async () => {
        const defaults = createDefaultWebGPUUserSettings();
        storageMockState.value = JSON.stringify({
            ...defaults,
            audio: { ...defaults.audio, outputDeviceId: 'speaker-a' }
        });
        audioOutputManagerMockState.snapshot = {
            activeDeviceId: 'speaker-a',
            devices: [],
            messageCode: 'selected-enumeration-failed',
            pickerAvailable: true,
            selectedDeviceAvailability: 'active',
            selectedDeviceId: 'speaker-a',
            status: 'selected'
        };
        const player = {
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true)
        } as unknown as WebGPUPlayer;
        const panelPromise = showWebGPUPlaybackSettingsPanel(player);
        const panel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        const outputSelect = requirePanelElement<HTMLSelectElement>(
            panel,
            '[data-audio-output-select]'
        );

        expect(outputSelect.selectedOptions[0]?.textContent).toBe('Selected output (active)');
        expect(outputSelect.selectedOptions[0]?.disabled).toBe(false);
        expect(requirePanelElement<HTMLElement>(
            panel,
            '[data-audio-output-status]'
        ).textContent).toContain('selected output remains active');

        audioOutputManagerMockState.snapshot = {
            ...audioOutputManagerMockState.snapshot,
            activeDeviceId: null,
            messageCode: 'selected-saved',
            selectedDeviceAvailability: 'unknown',
            status: 'inactive'
        };
        for (const listener of audioOutputManagerMockState.listeners) {
            listener(audioOutputManagerMockState.snapshot);
        }
        expect(outputSelect.selectedOptions[0]?.textContent).toBe(
            'Selected output (availability unknown)'
        );
        expect(outputSelect.selectedOptions[0]?.disabled).toBe(false);

        requirePanelElement<HTMLButtonElement>(panel, '.webgpuSettingsClose').click();
        await panelPromise;
    });

    it('ignores a picker completion after close and does not mutate a reopened panel', async () => {
        let resolvePicker: (deviceId: string | null) => void = (
            deviceId: string | null
        ): void => {
            throw new Error(`Missing picker resolver for ${deviceId ?? 'default'}`);
        };
        audioOutputManagerMockState.requestPromise = new Promise<string | null>((resolve): void => {
            resolvePicker = resolve;
        });
        audioOutputManagerMockState.snapshot.pickerAvailable = true;
        const player = {
            getDetectedInputPeakNits: vi.fn(() => 1_000),
            getRenderSettings: vi.fn(() => createHDRToSDRRenderSettings()),
            updateAudioDownmixSettings: vi.fn(() => true),
            updateRenderSettings: vi.fn(() => true)
        } as unknown as WebGPUPlayer;

        const firstPanelPromise = showWebGPUPlaybackSettingsPanel(player);
        const firstPanel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        requirePanelElement<HTMLButtonElement>(firstPanel, '[data-audio-output-picker]').click();
        requirePanelElement<HTMLButtonElement>(firstPanel, '.webgpuSettingsClose').click();
        await firstPanelPromise;

        audioOutputManagerMockState.requestPromise = null;
        const secondPanelPromise = showWebGPUPlaybackSettingsPanel(player);
        const secondPanel = requirePanelElement<HTMLElement>(document.body, '.webgpuSettingsPanel');
        resolvePicker('late-output');
        await Promise.resolve();
        await Promise.resolve();

        expect(JSON.parse(storageMockState.value ?? '{}')).toMatchObject({
            audio: { outputDeviceId: null }
        });
        expect(requirePanelElement<HTMLSelectElement>(
            secondPanel,
            '[data-audio-output-select]'
        ).value).toBe('');
        requirePanelElement<HTMLButtonElement>(secondPanel, '.webgpuSettingsClose').click();
        await secondPanelPromise;
    });
});
