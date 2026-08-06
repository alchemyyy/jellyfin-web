import layoutManager from 'components/layoutManager';
import { webGPUAudioDownmixAlgorithm } from 'scripts/settings/userSettings';

import 'elements/emby-button/emby-button';
import 'elements/emby-button/paper-icon-button-light';
import 'elements/emby-checkbox/emby-checkbox';
import 'elements/emby-input/emby-input';
import 'elements/emby-select/emby-select';
import 'elements/emby-slider/emby-slider';
import 'material-design-icons-iconfont';

import {
    HDR_RENDER_SETTING_RANGES,
    type RenderSettings
} from '../RenderSettings';
import type WebGPUPlayer from '../WebGPUPlayer';
import {
    createConfiguredHDRRenderSettings,
    createDefaultWebGPUUserSettings,
    loadWebGPUUserSettings,
    normalizeWebGPUUserSettings,
    resetWebGPUAudioSettings,
    resetWebGPURenderSettings,
    saveWebGPUUserSettings,
    type WebGPUUserSettings
} from '../WebGPUUserSettings';
import { AUDIO_DOWNMIX_SETTING_RANGES } from '../custom/CustomAudioDownmix';
import {
    CUSTOM_AUDIO_DOWNMIX_ALGORITHMS,
    DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM,
    normalizeCustomAudioDownmixAlgorithm,
    type CustomAudioDownmixAlgorithm
} from '../custom/CustomAudioDownmixAlgorithm';

import './WebGPUPlaybackSettingsDialog.scss';

type NumericSettingKey =
    | 'brightness'
    | 'centerLevel'
    | 'contrast'
    | 'desaturationStrength'
    | 'exposure'
    | 'inputPeakNits'
    | 'outputGain'
    | 'outputPeakNits'
    | 'paperWhiteNits'
    | 'saturation'
    | 'surroundLevel';

type DefaultSettingKey =
    | NumericSettingKey
    | 'audioDownmixAlgorithm'
    | 'automaticInputPeakNits'
    | 'forceStereoDownmix'
    | 'operator';

type NumericSettingRange = Readonly<{
    maximum: number
    minimum: number
    step: number
}>;

type NumericControlConfiguration = Readonly<{
    description: string
    key: NumericSettingKey
    label: string
    range: NumericSettingRange
    section: 'audio' | 'render'
    unit?: string
}>;

type ActivePanel = {
    element: HTMLElement
    promise: Promise<void>
};

const PLAYBACK_INFO_GAP_PX = 8;
const PLAYBACK_INFO_SELECTOR = '.playerStats';
const PANEL_TOP_PROPERTY = '--webgpu-settings-top';
const AUDIO_DOWNMIX_LIVE_STATUS =
    'Downmix gains applied live and saved for the active WebGPU stereo downmix.';
const AUDIO_DOWNMIX_PENDING_STATUS =
    'Saved. No active compatible WebGPU stereo downmix accepted the live gain change; '
    + 'the gains will apply to the next compatible client-decoded downmix.';
const FORCE_STEREO_RESTART_STATUS =
    'Force stereo is restart-required and applies after restarting playback or '
    + 'starting the next item.';
const AUDIO_DOWNMIX_ALGORITHM_RESTART_STATUS =
    'Downmix algorithm is restart-required and applies after restarting playback or '
    + 'starting the next item.';

const NUMERIC_CONTROL_CONFIGURATIONS: NumericControlConfiguration[] = [];
NUMERIC_CONTROL_CONFIGURATIONS.push(
    {
        description: 'Manual HDR source peak used when metadata tracking is off.',
        key: 'inputPeakNits',
        label: 'Manual input peak',
        range: HDR_RENDER_SETTING_RANGES.inputPeakNits,
        section: 'render',
        unit: 'nits'
    },
    {
        description: 'Peak luminance of the SDR output transform.',
        key: 'outputPeakNits',
        label: 'Output peak',
        range: HDR_RENDER_SETTING_RANGES.outputPeakNits,
        section: 'render',
        unit: 'nits'
    },
    {
        description: 'Reference white used by the HDR-to-SDR transform.',
        key: 'paperWhiteNits',
        label: 'Paper white',
        range: HDR_RENDER_SETTING_RANGES.paperWhiteNits,
        section: 'render',
        unit: 'nits'
    },
    {
        description: 'Exposure adjustment before tone mapping.',
        key: 'exposure',
        label: 'Exposure',
        range: HDR_RENDER_SETTING_RANGES.exposure,
        section: 'render',
        unit: 'stops'
    },
    {
        description: 'Reduces saturation near the brightest mapped values.',
        key: 'desaturationStrength',
        label: 'Highlight desaturation',
        range: HDR_RENDER_SETTING_RANGES.desaturationStrength,
        section: 'render'
    },
    {
        description: 'Adds or removes display brightness after tone mapping.',
        key: 'brightness',
        label: 'Brightness',
        range: HDR_RENDER_SETTING_RANGES.brightness,
        section: 'render'
    },
    {
        description: 'Scales display contrast after tone mapping.',
        key: 'contrast',
        label: 'Contrast',
        range: HDR_RENDER_SETTING_RANGES.contrast,
        section: 'render'
    },
    {
        description: 'Scales display saturation after tone mapping.',
        key: 'saturation',
        label: 'Saturation',
        range: HDR_RENDER_SETTING_RANGES.saturation,
        section: 'render'
    },
    {
        description: 'Scales the center channel contribution; values above 1 boost it.',
        key: 'centerLevel',
        label: 'Center level',
        range: AUDIO_DOWNMIX_SETTING_RANGES.centerLevel,
        section: 'audio'
    },
    {
        description: 'Scales back and side channel contributions; values above 1 boost them.',
        key: 'surroundLevel',
        label: 'Surround level',
        range: AUDIO_DOWNMIX_SETTING_RANGES.surroundLevel,
        section: 'audio'
    },
    {
        description: 'Boosts the completed stereo downmix before peak limiting.',
        key: 'outputGain',
        label: 'Downmix output gain',
        range: AUDIO_DOWNMIX_SETTING_RANGES.outputGain,
        section: 'audio'
    }
);

let activePanel: ActivePanel | null = null;

function getNumericSetting(
    settings: WebGPUUserSettings,
    key: NumericSettingKey
): number {
    switch (key) {
        case 'brightness':
            return settings.render.settings.display.brightness;
        case 'centerLevel':
            return settings.audio.downmix.centerLevel;
        case 'contrast':
            return settings.render.settings.display.contrast;
        case 'desaturationStrength':
            return settings.render.settings.toneMapping.desaturationStrength;
        case 'exposure':
            return settings.render.settings.toneMapping.exposure;
        case 'inputPeakNits':
            return settings.render.settings.toneMapping.inputPeakNits;
        case 'outputGain':
            return settings.audio.downmix.outputGain;
        case 'outputPeakNits':
            return settings.render.settings.toneMapping.outputPeakNits;
        case 'paperWhiteNits':
            return settings.render.settings.toneMapping.paperWhiteNits;
        case 'saturation':
            return settings.render.settings.display.saturation;
        case 'surroundLevel':
            return settings.audio.downmix.surroundLevel;
    }
}

function updateNumericSetting(
    settings: WebGPUUserSettings,
    key: NumericSettingKey,
    value: number
): WebGPUUserSettings {
    const renderSettings = settings.render.settings;
    switch (key) {
        case 'brightness':
        case 'contrast':
        case 'saturation':
            return normalizeWebGPUUserSettings({
                ...settings,
                render: {
                    ...settings.render,
                    settings: {
                        ...renderSettings,
                        display: {
                            ...renderSettings.display,
                            [key]: value
                        }
                    }
                }
            });
        case 'desaturationStrength':
        case 'exposure':
        case 'inputPeakNits':
        case 'outputPeakNits':
        case 'paperWhiteNits':
            return normalizeWebGPUUserSettings({
                ...settings,
                render: {
                    ...settings.render,
                    settings: {
                        ...renderSettings,
                        toneMapping: {
                            ...renderSettings.toneMapping,
                            [key]: value
                        }
                    }
                }
            });
        case 'centerLevel':
        case 'outputGain':
        case 'surroundLevel':
            return normalizeWebGPUUserSettings({
                ...settings,
                audio: {
                    ...settings.audio,
                    downmix: {
                        ...settings.audio.downmix,
                        [key]: value
                    }
                }
            });
    }
}

function createDefaultButtonHTML(
    settingKey: DefaultSettingKey,
    label: string
): string {
    return `
        <button
            aria-label="Restore ${label} default"
            class="raised webgpuSettingsDefaultButton"
            data-default-setting="${settingKey}"
            is="emby-button"
            type="button"
        >Default</button>`;
}

function createNumericControlHTML(configuration: NumericControlConfiguration): string {
    const settingKey = configuration.key;
    const range = configuration.range;
    const unitText = configuration.unit ? ` (${configuration.unit})` : '';
    return `
        <div
            class="webgpuSettingsNumericControl"
            data-setting="${settingKey}"
            title="${configuration.description}"
        >
            <div class="webgpuSettingsNumericRow">
                <label class="webgpuSettingsControlLabel" for="webgpu-${settingKey}-slider">
                    ${configuration.label}${unitText}
                </label>
                <div class="webgpuSettingsSliderContainer">
                    <input
                        aria-describedby="webgpu-${settingKey}-description"
                        id="webgpu-${settingKey}-slider"
                        class="webgpuSettingsSlider"
                        data-setting-slider="${settingKey}"
                        is="emby-slider"
                        max="${range.maximum}"
                        min="${range.minimum}"
                        step="${range.step}"
                        type="range"
                    />
                </div>
                <div class="webgpuSettingsNumberContainer">
                    <input
                        aria-describedby="webgpu-${settingKey}-description"
                        aria-label="${configuration.label} numeric value"
                        class="webgpuSettingsNumber"
                        data-setting-number="${settingKey}"
                        is="emby-input"
                        max="${range.maximum}"
                        min="${range.minimum}"
                        step="${range.step}"
                        type="number"
                    />
                </div>
                ${createDefaultButtonHTML(settingKey, configuration.label)}
            </div>
            <div
                class="webgpuSettingsControlDescription"
                id="webgpu-${settingKey}-description"
            >${configuration.description}</div>
        </div>`;
}

function createSectionControlsHTML(section: 'audio' | 'render'): string {
    let controlsHTML = '';
    for (const configuration of NUMERIC_CONTROL_CONFIGURATIONS) {
        if (configuration.section === section) {
            controlsHTML += createNumericControlHTML(configuration);
        }
    }
    return controlsHTML;
}

function createPanelHTML(): string {
    return `
        <button
            aria-label="Close WebGPU Settings"
            class="webgpuSettingsClose"
            is="paper-icon-button-light"
            title="Close"
            type="button"
        ><span class="material-icons close" aria-hidden="true"></span></button>
        <div class="webgpuSettingsContent">
                <h2 class="webgpuSettingsTitle" id="webgpu-settings-title">WebGPU Settings</h2>
                <section class="webgpuSettingsSection" aria-labelledby="webgpu-tone-mapping-title">
                    <h3 class="webgpuSettingsSectionTitle" id="webgpu-tone-mapping-title">
                        Tone mapping and display
                    </h3>
                    <div class="webgpuSettingsSelectRow">
                        <div class="selectContainer webgpuSettingsSelectContainer">
                            <select
                                data-setting-select="operator"
                                id="webgpu-tone-map-operator"
                                is="emby-select"
                                label="Tone map operator"
                            >
                                <option value="spline">Spline</option>
                                <option value="aces">ACES</option>
                                <option value="reinhard">Reinhard</option>
                            </select>
                        </div>
                        ${createDefaultButtonHTML('operator', 'tone map operator')}
                    </div>
                    <div class="webgpuSettingsCheckboxRow">
                        <label class="checkboxContainer">
                            <input
                                data-setting-checkbox="automaticInputPeakNits"
                                is="emby-checkbox"
                                type="checkbox"
                            />
                            <span>Track source peak metadata</span>
                        </label>
                        ${createDefaultButtonHTML(
                            'automaticInputPeakNits',
                            'source peak metadata tracking'
                        )}
                    </div>
                    <div class="fieldDescription webgpuSettingsCheckboxDescription">
                        When enabled, valid stream metadata replaces the manual input peak.
                    </div>
                    ${createSectionControlsHTML('render')}
                    <div class="webgpuSettingsStatus" data-render-status role="status"></div>
                    <button
                        class="raised webgpuSettingsResetRender"
                        is="emby-button"
                        type="button"
                    >Reset tone mapping and display</button>
                </section>

                <section class="webgpuSettingsSection" aria-labelledby="webgpu-audio-title">
                    <h3 class="webgpuSettingsSectionTitle" id="webgpu-audio-title">
                        Audio downmix
                    </h3>
                    <div class="webgpuSettingsSelectRow">
                        <div class="selectContainer webgpuSettingsSelectContainer">
                            <select
                                data-setting-select="audioDownmixAlgorithm"
                                id="webgpu-audio-downmix-algorithm"
                                is="emby-select"
                                label="Downmix algorithm"
                            >
                                <option value="${CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.StandardLORO}">
                                    Standard Lo/Ro with lookahead limiter
                                </option>
                                <option value="${CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.PeakNormalizedLORO}">
                                    Peak-normalized Lo/Ro without lookahead
                                </option>
                                <option value="${CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.AC4}">AC-4</option>
                                <option value="${CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.RFC7845}">
                                    RFC 7845
                                </option>
                                <option value="${CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.Dave750}">
                                    Dave750
                                </option>
                                <option value="${CUSTOM_AUDIO_DOWNMIX_ALGORITHMS.NightModeDialogue}">
                                    Night mode dialogue
                                </option>
                            </select>
                        </div>
                        ${createDefaultButtonHTML(
                            'audioDownmixAlgorithm',
                            'downmix algorithm'
                        )}
                    </div>
                    <div class="webgpuSettingsCheckboxRow">
                        <label class="checkboxContainer">
                            <input
                                data-setting-checkbox="forceStereoDownmix"
                                is="emby-checkbox"
                                type="checkbox"
                            />
                            <span>Force stereo for WebGPU client-decoded audio</span>
                        </label>
                        ${createDefaultButtonHTML('forceStereoDownmix', 'force stereo')}
                    </div>
                    <div class="fieldDescription webgpuSettingsCheckboxDescription">
                        Otherwise complete client-decoded 5.1 or 7.1 audio can use a matching
                        native speaker output.
                    </div>
                    ${createSectionControlsHTML('audio')}
                    <div class="fieldDescription webgpuSettingsSafetyDescription">
                        Values above 1 amplify the selected contribution. Boosted multichannel
                        stereo downmixes are peak-limited; the selected WebGPU downmix algorithm
                        still controls the base matrix. Native-media audio and HTML fallback
                        playback do not consume these settings.
                    </div>
                    <div class="webgpuSettingsStatus" data-audio-status role="status">
                        Downmix gain changes apply live to an active compatible WebGPU stereo
                        downmix. Force stereo and downmix algorithm changes are restart-required.
                    </div>
                    <button
                        class="raised webgpuSettingsResetAudio"
                        is="emby-button"
                        type="button"
                    >Reset audio downmix</button>
                </section>

                <div class="webgpuSettingsFooter">
                    <button
                        class="raised webgpuSettingsResetAll"
                        is="emby-button"
                        type="button"
                    >Reset all</button>
                </div>
        </div>`;
}

function requireElement<ElementType extends Element>(
    parent: ParentNode,
    selector: string
): ElementType {
    const element = parent.querySelector<ElementType>(selector);
    if (!element) {
        throw new Error(`WebGPU settings panel is missing ${selector}`);
    }
    return element;
}

function setStatus(element: HTMLElement, message: string): void {
    element.textContent = message;
}

function positionPanelBelowPlaybackInfo(panel: HTMLElement): void {
    let playbackInfoBottom: number | null = null;
    const playbackInfoElements = document.querySelectorAll<HTMLElement>(
        PLAYBACK_INFO_SELECTOR
    );
    for (const playbackInfoElement of playbackInfoElements) {
        if (playbackInfoElement.classList.contains('hide')) {
            continue;
        }
        const playbackInfoBounds = playbackInfoElement.getBoundingClientRect();
        if (playbackInfoBounds.width <= 0 || playbackInfoBounds.height <= 0) {
            continue;
        }
        playbackInfoBottom = Math.max(
            playbackInfoBottom ?? 0,
            playbackInfoBounds.bottom
        );
    }

    if (playbackInfoBottom === null) {
        panel.style.removeProperty(PANEL_TOP_PROPERTY);
        return;
    }
    panel.style.setProperty(
        PANEL_TOP_PROPERTY,
        `${Math.ceil(playbackInfoBottom + PLAYBACK_INFO_GAP_PX)}px`
    );
}

function createPanelController(player: WebGPUPlayer): ActivePanel {
    const panel = document.createElement('aside');
    panel.classList.add('webgpuSettingsPanel');
    if (layoutManager.tv) {
        panel.classList.add('webgpuSettingsPanel-tv');
    }
    panel.setAttribute('aria-labelledby', 'webgpu-settings-title');
    panel.innerHTML = createPanelHTML();

    const cleanupCallbacks: Array<() => void> = [];
    const renderStatus = requireElement<HTMLElement>(panel, '[data-render-status]');
    const audioStatus = requireElement<HTMLElement>(panel, '[data-audio-status]');
    const automaticInputPeakCheckbox = requireElement<HTMLInputElement>(
        panel,
        '[data-setting-checkbox="automaticInputPeakNits"]'
    );
    const forceStereoCheckbox = requireElement<HTMLInputElement>(
        panel,
        '[data-setting-checkbox="forceStereoDownmix"]'
    );
    const operatorSelect = requireElement<HTMLSelectElement>(
        panel,
        '[data-setting-select="operator"]'
    );
    const audioDownmixAlgorithmSelect = requireElement<HTMLSelectElement>(
        panel,
        '[data-setting-select="audioDownmixAlgorithm"]'
    );
    let settings = loadWebGPUUserSettings();
    let audioDownmixAlgorithm: CustomAudioDownmixAlgorithm =
        webGPUAudioDownmixAlgorithm();
    let renderFrameRequest: number | null = null;

    const synchronizeControls = (): void => {
        for (const configuration of NUMERIC_CONTROL_CONFIGURATIONS) {
            const value = getNumericSetting(settings, configuration.key).toString();
            const slider = requireElement<HTMLInputElement>(
                panel,
                `[data-setting-slider="${configuration.key}"]`
            );
            const numberInput = requireElement<HTMLInputElement>(
                panel,
                `[data-setting-number="${configuration.key}"]`
            );
            slider.value = value;
            numberInput.value = value;
        }
        automaticInputPeakCheckbox.checked = settings.render.automaticInputPeakNits;
        forceStereoCheckbox.checked = settings.audio.forceStereoDownmix;
        audioDownmixAlgorithmSelect.value = audioDownmixAlgorithm;
        operatorSelect.value = settings.render.settings.toneMapping.operator;
        const inputPeakSlider = requireElement<HTMLInputElement>(
            panel,
            '[data-setting-slider="inputPeakNits"]'
        );
        const inputPeakNumber = requireElement<HTMLInputElement>(
            panel,
            '[data-setting-number="inputPeakNits"]'
        );
        inputPeakSlider.disabled = settings.render.automaticInputPeakNits;
        inputPeakNumber.disabled = settings.render.automaticInputPeakNits;
    };

    const applyRenderSettings = (): void => {
        renderFrameRequest = null;
        const currentRenderSettings: RenderSettings = player.getRenderSettings();
        if (currentRenderSettings.mode !== 'hdr-to-sdr') {
            setStatus(
                renderStatus,
                'Saved. Controls apply when an HDR-to-SDR WebGPU presentation is active.'
            );
            return;
        }
        const detectedInputPeakNits = player.getDetectedInputPeakNits();
        if (settings.render.automaticInputPeakNits && detectedInputPeakNits === null) {
            setStatus(
                renderStatus,
                'Saved. The detected source peak is unavailable; '
                    + 'automatic tracking will apply to the next HDR presentation.'
            );
            return;
        }
        const configuredRenderSettings = createConfiguredHDRRenderSettings(
            settings,
            detectedInputPeakNits ?? currentRenderSettings.toneMapping.inputPeakNits
        );
        if (player.updateRenderSettings(
            configuredRenderSettings,
            settings.render.automaticInputPeakNits
        )) {
            setStatus(renderStatus, 'Applied live and saved.');
            return;
        }
        setStatus(
            renderStatus,
            'Saved. The current presentation could not apply the change; '
                + 'it will apply to the next HDR presentation.'
        );
    };

    const scheduleRenderSettings = (): void => {
        if (renderFrameRequest !== null) {
            cancelAnimationFrame(renderFrameRequest);
        }
        renderFrameRequest = requestAnimationFrame(applyRenderSettings);
    };

    const persistSettings = (): void => {
        settings = saveWebGPUUserSettings(settings);
        synchronizeControls();
    };

    const applyAudioDownmixSettings = (
        includeForceStereoStatus: boolean,
        includeAlgorithmStatus = false
    ): void => {
        const appliedLive = player.updateAudioDownmixSettings(settings.audio.downmix);
        const downmixStatus = appliedLive ?
            AUDIO_DOWNMIX_LIVE_STATUS :
            AUDIO_DOWNMIX_PENDING_STATUS;
        const statusMessages: string[] = [ downmixStatus ];
        if (includeForceStereoStatus) {
            statusMessages.push(FORCE_STEREO_RESTART_STATUS);
        }
        if (includeAlgorithmStatus) {
            statusMessages.push(AUDIO_DOWNMIX_ALGORITHM_RESTART_STATUS);
        }
        setStatus(audioStatus, statusMessages.join(' '));
    };

    const commitSectionSettings = (section: 'audio' | 'render'): void => {
        persistSettings();
        switch (section) {
            case 'audio':
                applyAudioDownmixSettings(false);
                break;
            case 'render':
                scheduleRenderSettings();
                break;
        }
    };

    const bindDefaultButton = (
        settingKey: DefaultSettingKey,
        onClick: () => void
    ): void => {
        const button = requireElement<HTMLButtonElement>(
            panel,
            `[data-default-setting="${settingKey}"]`
        );
        button.addEventListener('click', onClick);
        cleanupCallbacks.push((): void => {
            button.removeEventListener('click', onClick);
        });
    };

    for (const configuration of NUMERIC_CONTROL_CONFIGURATIONS) {
        const slider = requireElement<HTMLInputElement>(
            panel,
            `[data-setting-slider="${configuration.key}"]`
        );
        const numberInput = requireElement<HTMLInputElement>(
            panel,
            `[data-setting-number="${configuration.key}"]`
        );
        const onSliderInput = (): void => {
            settings = updateNumericSetting(settings, configuration.key, Number(slider.value));
            commitSectionSettings(configuration.section);
        };
        const onNumberChange = (): void => {
            settings = updateNumericSetting(
                settings,
                configuration.key,
                Number(numberInput.value)
            );
            commitSectionSettings(configuration.section);
        };
        slider.addEventListener('input', onSliderInput);
        numberInput.addEventListener('change', onNumberChange);
        cleanupCallbacks.push((): void => {
            slider.removeEventListener('input', onSliderInput);
            numberInput.removeEventListener('change', onNumberChange);
        });
        bindDefaultButton(configuration.key, (): void => {
            const defaults = createDefaultWebGPUUserSettings();
            settings = updateNumericSetting(
                settings,
                configuration.key,
                getNumericSetting(defaults, configuration.key)
            );
            commitSectionSettings(configuration.section);
        });
    }

    const onAutomaticInputPeakChange = (): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            render: {
                ...settings.render,
                automaticInputPeakNits: automaticInputPeakCheckbox.checked
            }
        });
        commitSectionSettings('render');
    };
    automaticInputPeakCheckbox.addEventListener('change', onAutomaticInputPeakChange);
    cleanupCallbacks.push((): void => {
        automaticInputPeakCheckbox.removeEventListener('change', onAutomaticInputPeakChange);
    });
    bindDefaultButton('automaticInputPeakNits', (): void => {
        automaticInputPeakCheckbox.checked =
            createDefaultWebGPUUserSettings().render.automaticInputPeakNits;
        onAutomaticInputPeakChange();
    });

    const onForceStereoChange = (): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            audio: {
                ...settings.audio,
                forceStereoDownmix: forceStereoCheckbox.checked
            }
        });
        persistSettings();
        setStatus(
            audioStatus,
            `Saved. ${FORCE_STEREO_RESTART_STATUS} Downmix gains are unchanged.`
        );
    };
    forceStereoCheckbox.addEventListener('change', onForceStereoChange);
    cleanupCallbacks.push((): void => {
        forceStereoCheckbox.removeEventListener('change', onForceStereoChange);
    });
    bindDefaultButton('forceStereoDownmix', (): void => {
        forceStereoCheckbox.checked =
            createDefaultWebGPUUserSettings().audio.forceStereoDownmix;
        onForceStereoChange();
    });

    const persistAudioDownmixAlgorithm = (value: unknown): void => {
        audioDownmixAlgorithm = normalizeCustomAudioDownmixAlgorithm(value);
        webGPUAudioDownmixAlgorithm(audioDownmixAlgorithm);
        audioDownmixAlgorithmSelect.value = audioDownmixAlgorithm;
        setStatus(
            audioStatus,
            `Saved. ${AUDIO_DOWNMIX_ALGORITHM_RESTART_STATUS} Downmix gains are unchanged.`
        );
    };
    const onAudioDownmixAlgorithmChange = (): void => {
        persistAudioDownmixAlgorithm(audioDownmixAlgorithmSelect.value);
    };
    audioDownmixAlgorithmSelect.addEventListener(
        'change',
        onAudioDownmixAlgorithmChange
    );
    cleanupCallbacks.push((): void => {
        audioDownmixAlgorithmSelect.removeEventListener(
            'change',
            onAudioDownmixAlgorithmChange
        );
    });
    bindDefaultButton('audioDownmixAlgorithm', (): void => {
        persistAudioDownmixAlgorithm(DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM);
    });

    const onOperatorChange = (): void => {
        settings = normalizeWebGPUUserSettings({
            ...settings,
            render: {
                ...settings.render,
                settings: {
                    ...settings.render.settings,
                    toneMapping: {
                        ...settings.render.settings.toneMapping,
                        operator: operatorSelect.value
                    }
                }
            }
        });
        commitSectionSettings('render');
    };
    operatorSelect.addEventListener('change', onOperatorChange);
    cleanupCallbacks.push((): void => {
        operatorSelect.removeEventListener('change', onOperatorChange);
    });
    bindDefaultButton('operator', (): void => {
        operatorSelect.value =
            createDefaultWebGPUUserSettings().render.settings.toneMapping.operator;
        onOperatorChange();
    });

    const resetRenderButton = requireElement<HTMLButtonElement>(
        panel,
        '.webgpuSettingsResetRender'
    );
    const onResetRender = (): void => {
        settings = resetWebGPURenderSettings(settings);
        commitSectionSettings('render');
    };
    resetRenderButton.addEventListener('click', onResetRender);
    cleanupCallbacks.push((): void => {
        resetRenderButton.removeEventListener('click', onResetRender);
    });

    const resetAudioButton = requireElement<HTMLButtonElement>(
        panel,
        '.webgpuSettingsResetAudio'
    );
    const onResetAudio = (): void => {
        settings = resetWebGPUAudioSettings(settings);
        audioDownmixAlgorithm = DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM;
        webGPUAudioDownmixAlgorithm(audioDownmixAlgorithm);
        persistSettings();
        applyAudioDownmixSettings(true, true);
    };
    resetAudioButton.addEventListener('click', onResetAudio);
    cleanupCallbacks.push((): void => {
        resetAudioButton.removeEventListener('click', onResetAudio);
    });

    const resetAllButton = requireElement<HTMLButtonElement>(panel, '.webgpuSettingsResetAll');
    const onResetAll = (): void => {
        settings = createDefaultWebGPUUserSettings();
        audioDownmixAlgorithm = DEFAULT_CUSTOM_AUDIO_DOWNMIX_ALGORITHM;
        webGPUAudioDownmixAlgorithm(audioDownmixAlgorithm);
        persistSettings();
        scheduleRenderSettings();
        applyAudioDownmixSettings(true, true);
    };
    resetAllButton.addEventListener('click', onResetAll);
    cleanupCallbacks.push((): void => {
        resetAllButton.removeEventListener('click', onResetAll);
    });

    synchronizeControls();
    applyRenderSettings();

    let resolved = false;
    let resolvePanel: (() => void) | null = null;
    const promise = new Promise<void>((resolve): void => {
        resolvePanel = resolve;
    });
    const finish = (): void => {
        if (resolved) {
            return;
        }
        resolved = true;
        if (renderFrameRequest !== null) {
            cancelAnimationFrame(renderFrameRequest);
            applyRenderSettings();
        }
        for (const cleanupCallback of cleanupCallbacks) {
            cleanupCallback();
        }
        resolvePanel?.();
        resolvePanel = null;
    };

    const closePanel = (): void => {
        panel.remove();
        finish();
    };
    const closeButton = requireElement<HTMLButtonElement>(panel, '.webgpuSettingsClose');
    closeButton.addEventListener('click', closePanel);
    cleanupCallbacks.push((): void => {
        closeButton.removeEventListener('click', closePanel);
    });

    const onPanelKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        closePanel();
    };
    panel.addEventListener('keydown', onPanelKeyDown);
    cleanupCallbacks.push((): void => {
        panel.removeEventListener('keydown', onPanelKeyDown);
    });

    const updatePanelPosition = (): void => {
        positionPanelBelowPlaybackInfo(panel);
    };
    window.addEventListener('resize', updatePanelPosition);
    cleanupCallbacks.push((): void => {
        window.removeEventListener('resize', updatePanelPosition);
    });

    let playbackInfoResizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver === 'function') {
        playbackInfoResizeObserver = new ResizeObserver(updatePanelPosition);
        const playbackInfoElements = document.querySelectorAll<HTMLElement>(
            PLAYBACK_INFO_SELECTOR
        );
        for (const playbackInfoElement of playbackInfoElements) {
            playbackInfoResizeObserver.observe(playbackInfoElement);
        }
        cleanupCallbacks.push((): void => {
            playbackInfoResizeObserver?.disconnect();
            playbackInfoResizeObserver = null;
        });
    }

    const playbackPage = document.getElementById('videoOsdPage');
    if (playbackPage) {
        playbackPage.addEventListener('viewbeforehide', closePanel);
        cleanupCallbacks.push((): void => {
            playbackPage.removeEventListener('viewbeforehide', closePanel);
        });
    }

    document.body.appendChild(panel);
    updatePanelPosition();

    return { element: panel, promise };
}

/** Opens or focuses the one active plugin-owned playback settings panel. */
export function showWebGPUPlaybackSettingsPanel(player: WebGPUPlayer): Promise<void> {
    if (activePanel) {
        const focusTarget = activePanel.element.querySelector<HTMLElement>(
            '.webgpuSettingsClose'
        );
        focusTarget?.focus();
        return activePanel.promise;
    }

    const createdPanel = createPanelController(player);
    const promise = createdPanel.promise.finally((): void => {
        if (activePanel?.element === createdPanel.element) {
            activePanel = null;
        }
    });
    activePanel = {
        element: createdPanel.element,
        promise
    };
    return promise;
}
