import {
    assertValidAudioDownmixSettings,
    type AudioDownmixSettings
} from './CustomAudioDownmix';

export const AUDIO_DOWNMIX_SETTINGS_RAMP_DURATION_MILLISECONDS = 20;

export type AudioDownmixSettingsRamp = Readonly<{
    centerLevelStep: number
    frameCount: number
    initialCenterLevel: number
    initialOutputGain: number
    initialSurroundLevel: number
    outputGainStep: number
    surroundLevelStep: number
}>;

export type StreamingAudioDownmixSettingsBlock = Readonly<{
    ramp: AudioDownmixSettingsRamp | null
    settings: AudioDownmixSettings
}>;

function cloneSettings(settings: AudioDownmixSettings): AudioDownmixSettings {
    return { ...settings };
}

function hasSameSettings(
    left: AudioDownmixSettings,
    right: AudioDownmixSettings
): boolean {
    return left.centerLevel === right.centerLevel
        && left.outputGain === right.outputGain
        && left.surroundLevel === right.surroundLevel
        && left.version === right.version;
}

/** Owns one decode generation's click-safe live downmix gain transition. */
export default class StreamingAudioDownmixSettings {
    private currentSettings: AudioDownmixSettings;
    private remainingRampFrameCount = 0;
    private targetSettings: AudioDownmixSettings;

    private readonly generation: number;
    private readonly rampFrameCount: number;

    public constructor(
        generation: number,
        sourceSampleRate: number,
        initialSettings: AudioDownmixSettings
    ) {
        if (!Number.isSafeInteger(generation) || generation <= 0) {
            throw new RangeError('Audio downmix generation must be a positive safe integer');
        }
        if (!Number.isSafeInteger(sourceSampleRate) || sourceSampleRate <= 0) {
            throw new RangeError('Audio downmix sample rate must be a positive safe integer');
        }
        assertValidAudioDownmixSettings(initialSettings);

        this.currentSettings = cloneSettings(initialSettings);
        this.generation = generation;
        this.rampFrameCount = Math.max(1, Math.ceil(
            sourceSampleRate
                * AUDIO_DOWNMIX_SETTINGS_RAMP_DURATION_MILLISECONDS
                / 1_000
        ));
        this.targetSettings = cloneSettings(initialSettings);
    }

    /** Starts a fresh ramp only when the request belongs to this generation. */
    public update(
        generation: number,
        settings: AudioDownmixSettings
    ): boolean {
        assertValidAudioDownmixSettings(settings);
        if (generation !== this.generation) {
            return false;
        }

        const settingsSnapshot = cloneSettings(settings);
        this.targetSettings = settingsSnapshot;
        if (hasSameSettings(this.currentSettings, settingsSnapshot)) {
            this.currentSettings = cloneSettings(settingsSnapshot);
            this.remainingRampFrameCount = 0;
            return true;
        }
        this.remainingRampFrameCount = this.rampFrameCount;
        return true;
    }

    /** Returns and consumes the gain transition for one contiguous PCM block. */
    public takeBlock(frameCount: number): StreamingAudioDownmixSettingsBlock {
        if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
            throw new RangeError('Audio downmix block frame count must be positive');
        }
        if (this.remainingRampFrameCount === 0) {
            return {
                ramp: null,
                settings: cloneSettings(this.currentSettings)
            };
        }

        const consumedRampFrameCount = Math.min(
            frameCount,
            this.remainingRampFrameCount
        );
        const initialSettings = this.currentSettings;
        const centerLevelStep = (
            this.targetSettings.centerLevel - initialSettings.centerLevel
        ) / this.remainingRampFrameCount;
        const outputGainStep = (
            this.targetSettings.outputGain - initialSettings.outputGain
        ) / this.remainingRampFrameCount;
        const surroundLevelStep = (
            this.targetSettings.surroundLevel - initialSettings.surroundLevel
        ) / this.remainingRampFrameCount;
        const transitionCompletes = consumedRampFrameCount
            === this.remainingRampFrameCount;
        const terminalSettings: AudioDownmixSettings = transitionCompletes ?
            cloneSettings(this.targetSettings) :
            {
                centerLevel: initialSettings.centerLevel
                    + centerLevelStep * consumedRampFrameCount,
                outputGain: initialSettings.outputGain
                    + outputGainStep * consumedRampFrameCount,
                surroundLevel: initialSettings.surroundLevel
                    + surroundLevelStep * consumedRampFrameCount,
                version: initialSettings.version
            };

        this.currentSettings = terminalSettings;
        this.remainingRampFrameCount -= consumedRampFrameCount;
        return {
            ramp: {
                centerLevelStep,
                frameCount: consumedRampFrameCount,
                initialCenterLevel: initialSettings.centerLevel,
                initialOutputGain: initialSettings.outputGain,
                initialSurroundLevel: initialSettings.surroundLevel,
                outputGainStep,
                surroundLevelStep
            },
            settings: cloneSettings(terminalSettings)
        };
    }
}
