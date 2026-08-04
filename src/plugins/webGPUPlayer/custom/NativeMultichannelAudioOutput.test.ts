import { describe, expect, it } from 'vitest';

import {
    configureCustomAudioDestination,
    selectCustomAudioOutputChannelCount
} from './NativeMultichannelAudioOutput';

type FakeDestination = {
    channelCount: number
    maxChannelCount: number
};

function createAudioContext(maxChannelCount: number): AudioContext {
    return {
        destination: {
            channelCount: 2,
            maxChannelCount
        } as AudioDestinationNode
    } as AudioContext;
}

describe('native multichannel audio output', () => {
    it.each([
        { expected: 2, maximum: 2, source: 6 },
        { expected: 6, maximum: 6, source: 6 },
        { expected: 6, maximum: 8, source: 6 },
        { expected: 2, maximum: 6, source: 8 },
        { expected: 8, maximum: 8, source: 8 },
        { expected: 2, maximum: 8, source: 7 },
        { expected: 2, maximum: 8, source: 2 }
    ])('selects $expected channels for source $source with hardware max $maximum', ({
        expected,
        maximum,
        source
    }) => {
        expect(selectCustomAudioOutputChannelCount(
            createAudioContext(maximum),
            source
        )).toBe(expected);
    });

    it('uses stereo when an AudioContext capability probe is unavailable', () => {
        expect(selectCustomAudioOutputChannelCount(null, 8)).toBe(2);
        expect(selectCustomAudioOutputChannelCount(
            createAudioContext(Number.NaN),
            6
        )).toBe(2);
    });

    it('configures an exact supported destination channel count', () => {
        const audioContext = createAudioContext(8);

        configureCustomAudioDestination(audioContext, 8);

        expect(audioContext.destination.channelCount).toBe(8);
    });

    it('rejects a requested layout larger than the physical destination', () => {
        expect(() => configureCustomAudioDestination(
            createAudioContext(6),
            8
        )).toThrow('Audio destination exposes 6 channels, not 8');
    });

    it('rejects a destination that ignores channel-count configuration', () => {
        const destination: FakeDestination = {
            channelCount: 2,
            maxChannelCount: 6
        };
        Object.defineProperty(destination, 'channelCount', {
            configurable: true,
            get: (): number => 2,
            set: (): void => undefined
        });
        const audioContext = { destination } as unknown as AudioContext;

        expect(() => configureCustomAudioDestination(
            audioContext,
            6
        )).toThrow('The browser did not apply the requested audio destination channel count');
    });
});
