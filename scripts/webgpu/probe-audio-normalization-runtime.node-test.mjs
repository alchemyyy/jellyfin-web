import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createAudioNormalizationProbeExpression,
    summarizeAudioNormalizationItems
} from './probe-audio-normalization-runtime.mjs';

test('summarizes finite non-unity normalization metadata by media type', () => {
    assert.deepEqual(summarizeAudioNormalizationItems([
        {
            AlbumNormalizationGain: -2,
            MediaType: 'Audio',
            NormalizationGain: 3
        },
        {
            AlbumNormalizationGain: 0,
            MediaType: 'Audio',
            NormalizationGain: Number.NaN
        },
        {
            MediaType: 'Video',
            NormalizationGain: -6
        },
        { MediaType: 'Photo' }
    ]), {
        groups: {
            audio: {
                album: {
                    finiteCount: 2,
                    maximumDecibels: 0,
                    minimumDecibels: -2,
                    nonUnityCount: 1
                },
                itemCount: 2,
                track: {
                    finiteCount: 1,
                    maximumDecibels: 3,
                    minimumDecibels: 3,
                    nonUnityCount: 1
                }
            },
            other: {
                album: {
                    finiteCount: 0,
                    maximumDecibels: null,
                    minimumDecibels: null,
                    nonUnityCount: 0
                },
                itemCount: 1,
                track: {
                    finiteCount: 0,
                    maximumDecibels: null,
                    minimumDecibels: null,
                    nonUnityCount: 0
                }
            },
            video: {
                album: {
                    finiteCount: 0,
                    maximumDecibels: null,
                    minimumDecibels: null,
                    nonUnityCount: 0
                },
                itemCount: 1,
                track: {
                    finiteCount: 1,
                    maximumDecibels: -6,
                    minimumDecibels: -6,
                    nonUnityCount: 1
                }
            }
        },
        totalItemCount: 4
    });
});

test('returns an empty bounded summary for an invalid catalog', () => {
    assert.deepEqual(summarizeAudioNormalizationItems(null), {
        groups: {
            audio: {
                album: {
                    finiteCount: 0,
                    maximumDecibels: null,
                    minimumDecibels: null,
                    nonUnityCount: 0
                },
                itemCount: 0,
                track: {
                    finiteCount: 0,
                    maximumDecibels: null,
                    minimumDecibels: null,
                    nonUnityCount: 0
                }
            },
            other: {
                album: {
                    finiteCount: 0,
                    maximumDecibels: null,
                    minimumDecibels: null,
                    nonUnityCount: 0
                },
                itemCount: 0,
                track: {
                    finiteCount: 0,
                    maximumDecibels: null,
                    minimumDecibels: null,
                    nonUnityCount: 0
                }
            },
            video: {
                album: {
                    finiteCount: 0,
                    maximumDecibels: null,
                    minimumDecibels: null,
                    nonUnityCount: 0
                },
                itemCount: 0,
                track: {
                    finiteCount: 0,
                    maximumDecibels: null,
                    minimumDecibels: null,
                    nonUnityCount: 0
                }
            }
        },
        totalItemCount: 0
    });
});

test('probe expression retains no catalog identity fields in its result', () => {
    const expression = createAudioNormalizationProbeExpression();

    assert.match(expression, /NormalizationGain/);
    assert.doesNotMatch(expression, /\.Name\b|\.Path\b|\.Id\b|accessToken\(\)\s*[,}]/);
});
