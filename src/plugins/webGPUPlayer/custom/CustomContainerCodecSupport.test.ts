import { describe, expect, it } from 'vitest';

import {
    CUSTOM_CONTAINER_CODEC_RULES,
    CUSTOM_PROFILE_VIDEO_CONTAINERS,
    isCustomPlaybackContainer,
    supportsCustomContainerCodecCombination
} from './CustomContainerCodecSupport';

describe('CustomContainerCodecSupport', () => {
    it('accepts the complete audio and video cross product declared by every rule', () => {
        for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
            const containers: readonly string[] = [
                ...rule.profileContainers,
                ...rule.containerAliases
            ];
            for (const container of containers) {
                expect(isCustomPlaybackContainer(container)).toBe(true);
                for (const videoCodec of rule.videoCodecs) {
                    expect(supportsCustomContainerCodecCombination(
                        [ container ],
                        videoCodec,
                        null
                    )).toBe(true);
                    for (const audioCodec of rule.audioCodecs) {
                        expect(supportsCustomContainerCodecCombination(
                            [ container ],
                            videoCodec,
                            audioCodec
                        )).toBe(true);
                    }
                }
            }
        }
    });

    it('derives the unique server profile container set from the same rules', () => {
        const expectedContainers: string[] = [];
        for (const rule of CUSTOM_CONTAINER_CODEC_RULES) {
            for (const container of rule.profileContainers) {
                if (!expectedContainers.includes(container)) {
                    expectedContainers.push(container);
                }
            }
        }

        expect(CUSTOM_PROFILE_VIDEO_CONTAINERS).toEqual(expectedContainers);
    });

    it.each([
        [ 'mkv', 'jpeg2000', 'flac' ],
        [ 'webm', 'h264', 'opus' ],
        [ 'webm', 'vp9', 'ac3' ],
        [ 'ts', 'vc1', 'ac3' ]
    ] as const)(
        'rejects the undeclared %s/%s/%s container combination',
        (container, videoCodec, audioCodec) => {
            expect(supportsCustomContainerCodecCombination(
                [ container ],
                videoCodec,
                audioCodec
            )).toBe(false);
        }
    );
});
