import { describe, expect, it, vi } from 'vitest';

import DolbyVisionFramePairQueue, {
    MAXIMUM_DOLBY_VISION_FRAME_PAIR_QUEUE_LENGTH
} from './DolbyVisionFramePairQueue';
import { requireMicroseconds } from './TimeMath';

type TestFrame = {
    id: string
};

function createFrame(id: string): TestFrame {
    return { id };
}

describe('DolbyVisionFramePairQueue', () => {
    it('pairs exact and one-microsecond decoded timestamps', () => {
        const closeBaseFrame = vi.fn();
        const closeEnhancementFrame = vi.fn();
        const queue = new DolbyVisionFramePairQueue(
            closeBaseFrame,
            closeEnhancementFrame
        );
        const firstBase = createFrame('base-1');
        const firstEnhancement = createFrame('enhancement-1');
        const secondBase = createFrame('base-2');
        const secondEnhancement = createFrame('enhancement-2');

        queue.enqueueBaseFrame({
            frame: firstBase,
            mediaTimeMicroseconds: requireMicroseconds(10_000)
        });
        queue.enqueueEnhancementFrame({
            frame: firstEnhancement,
            mediaTimeMicroseconds: requireMicroseconds(10_000)
        });
        queue.enqueueBaseFrame({
            frame: secondBase,
            mediaTimeMicroseconds: requireMicroseconds(20_000)
        });
        queue.enqueueEnhancementFrame({
            frame: secondEnhancement,
            mediaTimeMicroseconds: requireMicroseconds(20_001)
        });

        expect(queue.takeReadyPair()).toEqual({
            baseFrame: firstBase,
            enhancementFrame: firstEnhancement
        });
        expect(queue.takeReadyPair()).toEqual({
            baseFrame: secondBase,
            enhancementFrame: secondEnhancement
        });
        expect(queue.takeReadyPair()).toBeNull();
        expect(closeBaseFrame).not.toHaveBeenCalled();
        expect(closeEnhancementFrame).not.toHaveBeenCalled();
    });

    it('drops older EL and emits BL-only when a newer EL proves a miss', () => {
        const closeBaseFrame = vi.fn();
        const closeEnhancementFrame = vi.fn();
        const queue = new DolbyVisionFramePairQueue(
            closeBaseFrame,
            closeEnhancementFrame
        );
        const olderEnhancement = createFrame('old-enhancement');
        const baseFrame = createFrame('base');
        const newerEnhancement = createFrame('new-enhancement');

        queue.enqueueEnhancementFrame({
            frame: olderEnhancement,
            mediaTimeMicroseconds: requireMicroseconds(9_998)
        });
        queue.enqueueBaseFrame({
            frame: baseFrame,
            mediaTimeMicroseconds: requireMicroseconds(10_000)
        });
        queue.enqueueEnhancementFrame({
            frame: newerEnhancement,
            mediaTimeMicroseconds: requireMicroseconds(10_002)
        });

        expect(queue.takeReadyPair()).toEqual({
            baseFrame,
            enhancementFrame: null
        });
        expect(closeEnhancementFrame).toHaveBeenCalledOnce();
        expect(closeEnhancementFrame).toHaveBeenCalledWith(olderEnhancement);
        queue.close();
        expect(closeEnhancementFrame).toHaveBeenCalledWith(newerEnhancement);
    });

    it('releases all waiting BL frames when EL ends', () => {
        const closeBaseFrame = vi.fn();
        const closeEnhancementFrame = vi.fn();
        const queue = new DolbyVisionFramePairQueue(
            closeBaseFrame,
            closeEnhancementFrame
        );
        const firstBase = createFrame('base-1');
        const secondBase = createFrame('base-2');

        queue.enqueueBaseFrame({
            frame: firstBase,
            mediaTimeMicroseconds: requireMicroseconds(10_000)
        });
        queue.enqueueBaseFrame({
            frame: secondBase,
            mediaTimeMicroseconds: requireMicroseconds(20_000)
        });
        queue.finishEnhancement();

        expect(queue.takeReadyPair()).toEqual({
            baseFrame: firstBase,
            enhancementFrame: null
        });
        expect(queue.takeReadyPair()).toEqual({
            baseFrame: secondBase,
            enhancementFrame: null
        });
        expect(queue.takeReadyPair()).toBeNull();
    });

    it('bounds delayed EL waiting to sixteen BL frames', () => {
        const queue = new DolbyVisionFramePairQueue<TestFrame, TestFrame>(
            (): void => undefined,
            (): void => undefined
        );
        const baseFrames: TestFrame[] = [];
        for (
            let frameIndex = 0;
            frameIndex < MAXIMUM_DOLBY_VISION_FRAME_PAIR_QUEUE_LENGTH;
            frameIndex += 1
        ) {
            const frame = createFrame(`base-${frameIndex}`);
            baseFrames.push(frame);
            queue.enqueueBaseFrame({
                frame,
                mediaTimeMicroseconds: requireMicroseconds(frameIndex * 1_000)
            });
        }

        expect(queue.takeReadyPair()).toEqual({
            baseFrame: baseFrames[0],
            enhancementFrame: null
        });
        expect(queue.takeReadyPair()).toBeNull();
    });

    it('bounds EL ownership while BL decode is delayed', () => {
        const closeEnhancementFrame = vi.fn();
        const queue = new DolbyVisionFramePairQueue<TestFrame, TestFrame>(
            (): void => undefined,
            closeEnhancementFrame
        );
        const enhancementFrames: TestFrame[] = [];
        for (
            let frameIndex = 0;
            frameIndex <= MAXIMUM_DOLBY_VISION_FRAME_PAIR_QUEUE_LENGTH;
            frameIndex += 1
        ) {
            const frame = createFrame(`enhancement-${frameIndex}`);
            enhancementFrames.push(frame);
            queue.enqueueEnhancementFrame({
                frame,
                mediaTimeMicroseconds: requireMicroseconds(frameIndex * 1_000)
            });
        }

        expect(closeEnhancementFrame).toHaveBeenCalledOnce();
        expect(closeEnhancementFrame).toHaveBeenCalledWith(enhancementFrames[0]);
        queue.close();
        expect(closeEnhancementFrame).toHaveBeenCalledTimes(
            MAXIMUM_DOLBY_VISION_FRAME_PAIR_QUEUE_LENGTH + 1
        );
    });

    it('fails closed before the ready-pair ownership queue can grow past its bound', () => {
        const queue = new DolbyVisionFramePairQueue<TestFrame, TestFrame>(
            (): void => undefined,
            (): void => undefined
        );
        queue.finishEnhancement();
        for (
            let frameIndex = 0;
            frameIndex < MAXIMUM_DOLBY_VISION_FRAME_PAIR_QUEUE_LENGTH;
            frameIndex += 1
        ) {
            queue.enqueueBaseFrame({
                frame: createFrame(`base-${frameIndex}`),
                mediaTimeMicroseconds: requireMicroseconds(frameIndex * 1_000)
            });
        }

        expect(() => queue.enqueueBaseFrame({
            frame: createFrame('overflow'),
            mediaTimeMicroseconds: requireMicroseconds(
                MAXIMUM_DOLBY_VISION_FRAME_PAIR_QUEUE_LENGTH * 1_000
            )
        })).toThrow('frame pair queue exceeded its bound');
    });

    it('closes every retained ownership unit exactly once', () => {
        const closeBaseFrame = vi.fn();
        const closeEnhancementFrame = vi.fn();
        const queue = new DolbyVisionFramePairQueue(
            closeBaseFrame,
            closeEnhancementFrame
        );
        const readyBase = createFrame('ready-base');
        const readyEnhancement = createFrame('ready-enhancement');
        const waitingBase = createFrame('waiting-base');
        const unmatchedEnhancement = createFrame('unmatched-enhancement');

        queue.enqueueBaseFrame({
            frame: readyBase,
            mediaTimeMicroseconds: requireMicroseconds(1_000)
        });
        queue.enqueueEnhancementFrame({
            frame: readyEnhancement,
            mediaTimeMicroseconds: requireMicroseconds(1_000)
        });
        queue.enqueueBaseFrame({
            frame: waitingBase,
            mediaTimeMicroseconds: requireMicroseconds(2_000)
        });
        queue.enqueueEnhancementFrame({
            frame: unmatchedEnhancement,
            mediaTimeMicroseconds: requireMicroseconds(3_000)
        });
        queue.close();

        expect(closeBaseFrame).toHaveBeenCalledTimes(2);
        expect(closeBaseFrame).toHaveBeenCalledWith(readyBase);
        expect(closeBaseFrame).toHaveBeenCalledWith(waitingBase);
        expect(closeEnhancementFrame).toHaveBeenCalledTimes(2);
        expect(closeEnhancementFrame).toHaveBeenCalledWith(readyEnhancement);
        expect(closeEnhancementFrame).toHaveBeenCalledWith(unmatchedEnhancement);
    });

    it('rejects decoder output that moves backward in presentation order', () => {
        const queue = new DolbyVisionFramePairQueue<TestFrame, TestFrame>(
            (): void => undefined,
            (): void => undefined
        );
        queue.enqueueBaseFrame({
            frame: createFrame('first'),
            mediaTimeMicroseconds: requireMicroseconds(2)
        });

        expect(() => queue.enqueueBaseFrame({
            frame: createFrame('second'),
            mediaTimeMicroseconds: requireMicroseconds(1)
        })).toThrow('not in presentation order');
    });
});
