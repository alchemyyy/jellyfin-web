import { describe, expect, it } from 'vitest';

import {
    SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN,
    SEVEN_POINT_ONE_MAXIMUM_CORRELATED_PEAK,
    SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN,
    downmixFivePointOneToStereo,
    downmixSixPointOneToStereo,
    downmixSevenPointOneToStereo,
    getStereoChannelDataFingerprint
} from './CustomAudioDownmix';

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

describe('downmixSixPointOneToStereo', () => {
    it('maps the back-center channel equally and omits LFE', () => {
        const channelData = [ 1, 2, 3, 40, 5, 6, 7 ].map(value => (
            createConstantChannel(value, 1)
        ));

        const [ outputLeft, outputRight ] = downmixSixPointOneToStereo(channelData);
        const directGain = 1 / (1 + 3 / Math.SQRT2);
        const mixedGain = directGain / Math.SQRT2;

        expect(outputLeft[0]).toBeCloseTo(
            1 * directGain + (3 + 5 + 6) * mixedGain,
            6
        );
        expect(outputRight[0]).toBeCloseTo(
            2 * directGain + (3 + 5 + 7) * mixedGain,
            6
        );
    });

    it('rejects malformed planar input', () => {
        expect(() => downmixSixPointOneToStereo([
            createConstantChannel(0)
        ])).toThrow('6.1 downmix requires exactly 7 input channels');
    });
});

describe('downmixSevenPointOneToStereo', () => {
    it('maps front, center, back, and side channels to the correct stereo side', () => {
        const channelData = [ 1, 2, 3, 40, 5, 6, 7, 8 ].map(value => (
            createConstantChannel(value)
        ));

        const [ outputLeft, outputRight ] = downmixSevenPointOneToStereo(channelData);
        const directGain = SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN;
        const mixedGain = SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN;

        expect(Array.from(outputLeft)).toEqual([
            1 * directGain + (3 + 5 + 7) * mixedGain,
            1 * directGain + (3 + 5 + 7) * mixedGain,
            1 * directGain + (3 + 5 + 7) * mixedGain
        ].map(Math.fround));
        expect(Array.from(outputRight)).toEqual([
            2 * directGain + (3 + 6 + 8) * mixedGain,
            2 * directGain + (3 + 6 + 8) * mixedGain,
            2 * directGain + (3 + 6 + 8) * mixedGain
        ].map(Math.fround));
    });

    it('omits LFE and leaves correlated peaks for the streaming limiter', () => {
        const channelData: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < 8; channelIndex += 1) {
            channelData.push(createConstantChannel(channelIndex === 3 ? 100 : 1, 1));
        }

        const [ outputLeft, outputRight ] = downmixSevenPointOneToStereo(channelData);

        expect(outputLeft[0]).toBeCloseTo(SEVEN_POINT_ONE_MAXIMUM_CORRELATED_PEAK, 6);
        expect(outputRight[0]).toBeCloseTo(SEVEN_POINT_ONE_MAXIMUM_CORRELATED_PEAK, 6);
        expect(Math.abs(outputLeft[0])).toBeGreaterThan(3);
        expect(Math.abs(outputRight[0])).toBeGreaterThan(3);
        expect(Number.isFinite(outputLeft[0])).toBe(true);
        expect(Number.isFinite(outputRight[0])).toBe(true);
    });

    it('maps isolated WAVE-order impulses to the default mpv coefficients', () => {
        const expectedLeft = [
            SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN,
            0,
            SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN,
            0,
            SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN,
            0,
            SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN,
            0
        ];
        const expectedRight = [
            0,
            SEVEN_POINT_ONE_DIRECT_CHANNEL_GAIN,
            SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN,
            0,
            0,
            SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN,
            0,
            SEVEN_POINT_ONE_MIXED_CHANNEL_GAIN
        ];
        for (let inputChannelIndex = 0; inputChannelIndex < 8; inputChannelIndex += 1) {
            const channelData: Float32Array[] = [];
            for (let channelIndex = 0; channelIndex < 8; channelIndex += 1) {
                channelData.push(createConstantChannel(
                    channelIndex === inputChannelIndex ? 1 : 0,
                    1
                ));
            }

            const [ outputLeft, outputRight ] = downmixSevenPointOneToStereo(channelData);

            expect(outputLeft[0]).toBeCloseTo(expectedLeft[inputChannelIndex], 7);
            expect(outputRight[0]).toBeCloseTo(expectedRight[inputChannelIndex], 7);
        }
    });

    it('is sample-exact across arbitrary input chunk boundaries', () => {
        const frameCount = 257;
        const channelData: Float32Array[] = [];
        for (let channelIndex = 0; channelIndex < 8; channelIndex += 1) {
            const channel = new Float32Array(frameCount);
            for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
                channel[frameIndex] = (
                    ((frameIndex + 1) * (channelIndex + 3)) % 31 - 15
                ) / 16;
            }
            channelData.push(channel);
        }
        const contiguous = downmixSevenPointOneToStereo(channelData);
        const splitLeft = new Float32Array(frameCount);
        const splitRight = new Float32Array(frameCount);
        const chunkFrameCounts = [ 1, 17, 3, 64, 5, 91, 76 ];
        let frameOffset = 0;
        for (const chunkFrameCount of chunkFrameCounts) {
            const chunkChannels: Float32Array[] = [];
            for (const channel of channelData) {
                chunkChannels.push(channel.slice(
                    frameOffset,
                    frameOffset + chunkFrameCount
                ));
            }
            const chunkOutput = downmixSevenPointOneToStereo(chunkChannels);
            splitLeft.set(chunkOutput[0], frameOffset);
            splitRight.set(chunkOutput[1], frameOffset);
            frameOffset += chunkFrameCount;
        }

        expect(frameOffset).toBe(frameCount);
        expect(splitLeft).toEqual(contiguous[0]);
        expect(splitRight).toEqual(contiguous[1]);
        expect(getStereoChannelDataFingerprint([ splitLeft, splitRight ])).toBe(
            getStereoChannelDataFingerprint(contiguous)
        );
    });

    it('rejects malformed planar input', () => {
        expect(() => downmixSevenPointOneToStereo([
            createConstantChannel(0)
        ])).toThrow('7.1 downmix requires exactly 8 input channels');
        const unequalChannels = [ 1, 2, 3, 4, 5, 6, 7 ].map(value => (
            createConstantChannel(value)
        ));
        unequalChannels.push(createConstantChannel(8, 2));
        expect(() => downmixSevenPointOneToStereo(unequalChannels)).toThrow(
            '7.1 downmix requires equal-length input channels'
        );
    });
});
