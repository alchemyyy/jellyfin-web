import { describe, expect, it } from 'vitest';

import {
    CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
    CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT,
    prepareCustomAudioOutputChannelData
} from './CustomAudioChannelLayout';
import {
    AUDIO_DOWNMIX_SETTINGS_VERSION,
    type AudioDownmixSettings
} from './CustomAudioDownmix';
import StreamingAudioDownmixSettings from './StreamingAudioDownmixSettings';

function createSettings(
    centerLevel: number,
    outputGain: number,
    surroundLevel: number
): AudioDownmixSettings {
    return {
        centerLevel,
        outputGain,
        surroundLevel,
        version: AUDIO_DOWNMIX_SETTINGS_VERSION
    };
}

describe('StreamingAudioDownmixSettings', () => {
    it('clones boundary snapshots and ignores a stale generation', () => {
        const initialSettings: {
            centerLevel: number
            outputGain: number
            surroundLevel: number
            version: typeof AUDIO_DOWNMIX_SETTINGS_VERSION
        } = {
            centerLevel: 1,
            outputGain: 1,
            surroundLevel: 1,
            version: AUDIO_DOWNMIX_SETTINGS_VERSION
        };
        const streamingSettings = new StreamingAudioDownmixSettings(
            7,
            48_000,
            initialSettings
        );
        initialSettings.centerLevel = 0;

        expect(streamingSettings.update(6, createSettings(0, 2, 0))).toBe(false);
        expect(streamingSettings.takeBlock(32)).toEqual({
            ramp: null,
            settings: createSettings(1, 1, 1)
        });
    });

    it('consumes a 20 ms linear transition across PCM block boundaries', () => {
        const streamingSettings = new StreamingAudioDownmixSettings(
            9,
            1_000,
            createSettings(1, 1, 1)
        );
        const targetSettings: {
            centerLevel: number
            outputGain: number
            surroundLevel: number
            version: typeof AUDIO_DOWNMIX_SETTINGS_VERSION
        } = {
            centerLevel: 0,
            outputGain: 2,
            surroundLevel: 0.5,
            version: AUDIO_DOWNMIX_SETTINGS_VERSION
        };

        expect(streamingSettings.update(9, targetSettings)).toBe(true);
        targetSettings.outputGain = 10;
        const firstBlock = streamingSettings.takeBlock(10);
        const secondBlock = streamingSettings.takeBlock(15);

        expect(firstBlock.ramp).toMatchObject({
            centerLevelStep: -0.05,
            frameCount: 10,
            initialCenterLevel: 1,
            initialOutputGain: 1,
            initialSurroundLevel: 1,
            outputGainStep: 0.05,
            surroundLevelStep: -0.025
        });
        expect(firstBlock.settings).toEqual(createSettings(0.5, 1.5, 0.75));
        expect(secondBlock.ramp).toMatchObject({
            frameCount: 10,
            initialCenterLevel: 0.5,
            initialOutputGain: 1.5,
            initialSurroundLevel: 0.75
        });
        expect(secondBlock.settings).toEqual(createSettings(0, 2, 0.5));
        expect(streamingSettings.takeBlock(5)).toEqual({
            ramp: null,
            settings: createSettings(0, 2, 0.5)
        });
    });

    it('applies the transition per frame instead of stepping one PCM block', () => {
        const frameCount = 20;
        const inputChannelData: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < 6; channelIndex += 1) {
            inputChannelData.push(new Float32Array(frameCount));
        }
        inputChannelData[2].fill(1);
        const streamingSettings = new StreamingAudioDownmixSettings(
            11,
            1_000,
            createSettings(1, 1, 1)
        );
        streamingSettings.update(11, createSettings(0, 1, 1));
        const settingsBlock = streamingSettings.takeBlock(frameCount);

        const output = prepareCustomAudioOutputChannelData(
            inputChannelData,
            CUSTOM_FIVE_POINT_ONE_CHANNEL_LAYOUT,
            CUSTOM_STEREO_OUTPUT_CHANNEL_COUNT,
            undefined,
            settingsBlock.settings,
            settingsBlock.ramp
        );
        const outputLeft = output[0];

        expect(outputLeft[0]).toBeGreaterThan(0.6);
        expect(outputLeft[frameCount - 1]).toBe(0);
        for (let frameIndex = 1; frameIndex < frameCount; frameIndex += 1) {
            expect(outputLeft[frameIndex]).toBeLessThan(outputLeft[frameIndex - 1]);
            expect(outputLeft[frameIndex - 1] - outputLeft[frameIndex])
                .toBeLessThan(0.04);
        }
    });
});
