import { describe, expect, it } from 'vitest';

import {
    DecodedVideoGeometryError,
    requireConsistentDecodedVideoGeometry
} from './DecodedVideoGeometry';
import type { RawVideoFrameGeometry } from './RawVideoFrameCopy';

const SELECTED_TRACK_GEOMETRY: RawVideoFrameGeometry = {
    codedHeight: 180,
    codedWidth: 320,
    displayHeight: 180,
    displayWidth: 320
};

describe('requireConsistentDecodedVideoGeometry', () => {
    it('accepts bounded coded-frame padding and locks the actual geometry', () => {
        const decodedGeometry: RawVideoFrameGeometry = {
            codedHeight: 194,
            codedWidth: 320,
            displayHeight: 180,
            displayWidth: 320
        };

        const lockedGeometry = requireConsistentDecodedVideoGeometry(
            decodedGeometry,
            SELECTED_TRACK_GEOMETRY,
            1_920,
            1_080,
            null
        );

        expect(lockedGeometry).toEqual(decodedGeometry);
        expect(lockedGeometry).not.toBe(decodedGeometry);
        expect(requireConsistentDecodedVideoGeometry(
            decodedGeometry,
            SELECTED_TRACK_GEOMETRY,
            1_920,
            1_080,
            lockedGeometry
        )).toBe(lockedGeometry);
    });

    it('accepts a bounded decoder-applied display crop', () => {
        const decodedGeometry: RawVideoFrameGeometry = {
            codedHeight: 180,
            codedWidth: 320,
            displayHeight: 176,
            displayWidth: 320
        };

        expect(requireConsistentDecodedVideoGeometry(
            decodedGeometry,
            SELECTED_TRACK_GEOMETRY,
            1_920,
            1_080,
            null
        )).toEqual(decodedGeometry);
    });

    it('rejects decoded display geometry outside the track tolerance', () => {
        expect(() => requireConsistentDecodedVideoGeometry(
            {
                codedHeight: 260,
                codedWidth: 320,
                displayHeight: 245,
                displayWidth: 320
            },
            SELECTED_TRACK_GEOMETRY,
            1_920,
            1_080,
            null
        )).toThrowError(new DecodedVideoGeometryError(
            'Decoded frame display geometry exceeds the selected video track tolerance'
        ));
    });

    it('rejects decoded coded geometry above the negotiated maximum', () => {
        expect(() => requireConsistentDecodedVideoGeometry(
            {
                codedHeight: 1_088,
                codedWidth: 1_920,
                displayHeight: 180,
                displayWidth: 320
            },
            SELECTED_TRACK_GEOMETRY,
            1_920,
            1_080,
            null
        )).toThrowError(new DecodedVideoGeometryError(
            'Decoded frame coded geometry exceeds its negotiated decode route'
        ));
    });

    it('accepts bounded decoder padding above a full route dimension', () => {
        const selectedTrackGeometry: RawVideoFrameGeometry = {
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        };
        const decodedGeometry: RawVideoFrameGeometry = {
            codedHeight: 1_088,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920
        };

        expect(requireConsistentDecodedVideoGeometry(
            decodedGeometry,
            selectedTrackGeometry,
            1_920,
            1_080,
            null
        )).toEqual(decodedGeometry);
    });

    it('rejects geometry changes after the first decoded frame', () => {
        const lockedGeometry: RawVideoFrameGeometry = {
            codedHeight: 194,
            codedWidth: 320,
            displayHeight: 180,
            displayWidth: 320
        };

        expect(() => requireConsistentDecodedVideoGeometry(
            {
                ...lockedGeometry,
                codedHeight: 196
            },
            SELECTED_TRACK_GEOMETRY,
            1_920,
            1_080,
            lockedGeometry
        )).toThrowError(new DecodedVideoGeometryError(
            'Decoded frame geometry changed after the first decoded frame'
        ));
    });
});
