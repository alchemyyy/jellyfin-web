import { describe, expect, it } from 'vitest';

import { downmixFivePointOneToStereo } from './CustomAudioDownmix';

function createConstantChannel(value: number, frameCount = 3): Float32Array {
    const channel = new Float32Array(frameCount);
    channel.fill(value);
    return channel;
}

describe('downmixFivePointOneToStereo', () => {
    it('maps front, center, and surround channels to the correct stereo side', () => {
        const channelData = [
            createConstantChannel(1),
            createConstantChannel(2),
            createConstantChannel(3),
            createConstantChannel(4),
            createConstantChannel(5),
            createConstantChannel(6)
        ];

        const [ outputLeft, outputRight ] = downmixFivePointOneToStereo(channelData);

        const directGain = Math.SQRT2 - 1;
        const mixedGain = 1 - (Math.SQRT2 / 2);
        expect(Array.from(outputLeft)).toEqual([
            1 * directGain + 3 * mixedGain + 5 * mixedGain,
            1 * directGain + 3 * mixedGain + 5 * mixedGain,
            1 * directGain + 3 * mixedGain + 5 * mixedGain
        ].map(Math.fround));
        expect(Array.from(outputRight)).toEqual([
            2 * directGain + 3 * mixedGain + 6 * mixedGain,
            2 * directGain + 3 * mixedGain + 6 * mixedGain,
            2 * directGain + 3 * mixedGain + 6 * mixedGain
        ].map(Math.fround));
    });

    it('omits LFE and remains bounded for full-scale nominal input', () => {
        const channelData = [
            createConstantChannel(1, 1),
            createConstantChannel(-1, 1),
            createConstantChannel(1, 1),
            createConstantChannel(100, 1),
            createConstantChannel(1, 1),
            createConstantChannel(-1, 1)
        ];

        const [ outputLeft, outputRight ] = downmixFivePointOneToStereo(channelData);

        expect(outputLeft[0]).toBeCloseTo(1, 6);
        expect(outputRight[0]).toBeCloseTo(-Math.SQRT2 + 1, 6);
        expect(Math.abs(outputLeft[0])).toBeLessThanOrEqual(1);
        expect(Math.abs(outputRight[0])).toBeLessThanOrEqual(1);
    });

    it('does not mutate input planes', () => {
        const channelData = [ 1, 2, 3, 4, 5, 6 ].map(value => (
            createConstantChannel(value)
        ));
        const snapshots = channelData.map(channel => new Float32Array(channel));

        downmixFivePointOneToStereo(channelData);

        for (let channelIndex = 0; channelIndex < channelData.length; channelIndex += 1) {
            expect(channelData[channelIndex]).toEqual(snapshots[channelIndex]);
        }
    });

    it('rejects invalid planar input', () => {
        expect(() => downmixFivePointOneToStereo([
            createConstantChannel(0)
        ])).toThrow('5.1 downmix requires exactly 6 input channels');
        expect(() => downmixFivePointOneToStereo([
            createConstantChannel(0),
            createConstantChannel(0),
            createConstantChannel(0),
            createConstantChannel(0),
            createConstantChannel(0),
            createConstantChannel(0, 2)
        ])).toThrow('5.1 downmix requires equal-length input channels');
    });
});
