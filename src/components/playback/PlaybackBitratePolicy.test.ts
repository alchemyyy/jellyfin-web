import { describe, expect, it, vi } from 'vitest';

import {
    getPlayerMaxStreamingBitrate,
    PLAYBACK_SELECTION_BITRATE_PURPOSE,
    shouldUsePostSelectionTranscodeBitrate,
    TRANSCODE_OUTPUT_BITRATE_PURPOSE
} from './PlaybackBitratePolicy';

describe('PlaybackBitratePolicy', () => {
    it('preserves existing player behavior without a bitrate policy hook', () => {
        expect(getPlayerMaxStreamingBitrate(
            {},
            25_000_000,
            PLAYBACK_SELECTION_BITRATE_PURPOSE
        )).toBe(25_000_000);
    });

    it('passes the fallback and explicit purpose to the player policy', () => {
        const getMaxStreamingBitrate = vi.fn(bitrateRequest => (
            bitrateRequest?.purpose === TRANSCODE_OUTPUT_BITRATE_PURPOSE ?
                bitrateRequest.fallbackBitrate :
                null
        ));

        expect(getPlayerMaxStreamingBitrate(
            { getMaxStreamingBitrate },
            25_000_000,
            PLAYBACK_SELECTION_BITRATE_PURPOSE
        )).toBeNull();
        expect(getPlayerMaxStreamingBitrate(
            { getMaxStreamingBitrate },
            25_000_000,
            TRANSCODE_OUTPUT_BITRATE_PURPOSE
        )).toBe(25_000_000);
        expect(getMaxStreamingBitrate).toHaveBeenNthCalledWith(1, {
            fallbackBitrate: 25_000_000,
            purpose: PLAYBACK_SELECTION_BITRATE_PURPOSE
        });
        expect(getMaxStreamingBitrate).toHaveBeenNthCalledWith(2, {
            fallbackBitrate: 25_000_000,
            purpose: TRANSCODE_OUTPUT_BITRATE_PURPOSE
        });
    });

    it('uses output sizing only after a transcode has been selected', () => {
        expect(shouldUsePostSelectionTranscodeBitrate(
            null,
            25_000_000,
            {
                SupportsDirectStream: false,
                SupportsTranscoding: true,
                enableDirectPlay: false
            }
        )).toBe(true);
    });

    it.each([
        [ 'selection already carried bitrate', 25_000_000, 25_000_000, {} ],
        [ 'missing output target', null, null, { SupportsTranscoding: true } ],
        [ 'DirectPlay', null, 25_000_000, {
            SupportsTranscoding: true,
            enableDirectPlay: true
        } ],
        [ 'DirectStream', null, 25_000_000, {
            SupportsDirectStream: true,
            SupportsTranscoding: true
        } ]
    ])('rejects a separate output request for %s', (
        _label,
        selectionBitrate,
        transcodingBitrate,
        mediaSource
    ) => {
        expect(shouldUsePostSelectionTranscodeBitrate(
            selectionBitrate,
            transcodingBitrate,
            mediaSource
        )).toBe(false);
    });
});
