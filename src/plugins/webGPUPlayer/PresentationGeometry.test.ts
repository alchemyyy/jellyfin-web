import { describe, expect, it } from 'vitest';

import {
    calculateTexturePresentationGeometry,
    type TexturePresentationGeometry,
    type TexturePresentationGeometryInput
} from './PresentationGeometry';

const BASE_INPUT: TexturePresentationGeometryInput = {
    objectFit: 'fill',
    objectPosition: '50% 50%',
    sourceHeight: 1_080,
    sourceWidth: 1_920,
    targetCSSHeight: 1_000,
    targetCSSWidth: 1_000,
    targetPixelHeight: 1_000,
    targetPixelWidth: 1_000
};

function expectGeometry(
    actual: TexturePresentationGeometry,
    expected: TexturePresentationGeometry
): void {
    for (const propertyName of Object.keys(expected) as Array<keyof TexturePresentationGeometry>) {
        expect(actual[propertyName]).toBeCloseTo(expected[propertyName], 8);
    }
}

describe('calculateTexturePresentationGeometry', () => {
    it('uses intrinsic size for scale-down when the source is smaller than the target', () => {
        const geometry = calculateTexturePresentationGeometry({
            ...BASE_INPUT,
            objectFit: 'scale-down',
            sourceHeight: 360,
            sourceWidth: 640
        });

        expectGeometry(geometry, {
            textureOffsetX: 0,
            textureOffsetY: 0,
            textureScaleX: 1,
            textureScaleY: 1,
            viewportHeight: 360,
            viewportWidth: 640,
            viewportX: 180,
            viewportY: 320
        });
    });

    it('contains scale-down sources that are larger than the target', () => {
        const geometry = calculateTexturePresentationGeometry({
            ...BASE_INPUT,
            objectFit: 'scale-down'
        });

        expectGeometry(geometry, {
            textureOffsetX: 0,
            textureOffsetY: 0,
            textureScaleX: 1,
            textureScaleY: 1,
            viewportHeight: 562.5,
            viewportWidth: 1_000,
            viewportX: 0,
            viewportY: 218.75
        });
    });

    it('positions an intrinsic none-sized source with percentages and edge offsets', () => {
        const percentageGeometry = calculateTexturePresentationGeometry({
            ...BASE_INPUT,
            objectFit: 'none',
            objectPosition: '25% 75%',
            sourceHeight: 200,
            sourceWidth: 400,
            targetCSSHeight: 800,
            targetPixelHeight: 800
        });
        const edgeGeometry = calculateTexturePresentationGeometry({
            ...BASE_INPUT,
            objectFit: 'none',
            objectPosition: 'right 40px bottom 20px',
            sourceHeight: 200,
            sourceWidth: 400,
            targetCSSHeight: 800,
            targetPixelHeight: 800
        });

        expect(percentageGeometry.viewportX).toBeCloseTo(150, 8);
        expect(percentageGeometry.viewportY).toBeCloseTo(450, 8);
        expect(percentageGeometry.viewportWidth).toBeCloseTo(400, 8);
        expect(percentageGeometry.viewportHeight).toBeCloseTo(200, 8);
        expect(edgeGeometry.viewportX).toBeCloseTo(560, 8);
        expect(edgeGeometry.viewportY).toBeCloseTo(580, 8);
    });

    it('crops a larger none-sized source from the requested object position', () => {
        const geometry = calculateTexturePresentationGeometry({
            ...BASE_INPUT,
            objectFit: 'none',
            objectPosition: '100% 0%',
            sourceHeight: 1_200,
            sourceWidth: 1_600,
            targetCSSHeight: 800,
            targetPixelHeight: 800
        });

        expectGeometry(geometry, {
            textureOffsetX: 0.375,
            textureOffsetY: 0,
            textureScaleX: 0.625,
            textureScaleY: 2 / 3,
            viewportHeight: 800,
            viewportWidth: 1_000,
            viewportX: 0,
            viewportY: 0
        });
    });

    it('preserves contain, cover, and fill behavior', () => {
        const containGeometry = calculateTexturePresentationGeometry({
            ...BASE_INPUT,
            objectFit: 'contain'
        });
        const coverGeometry = calculateTexturePresentationGeometry({
            ...BASE_INPUT,
            objectFit: 'cover'
        });
        const fillGeometry = calculateTexturePresentationGeometry({
            ...BASE_INPUT,
            objectFit: 'fill'
        });

        expect(containGeometry.viewportY).toBeCloseTo(218.75, 8);
        expect(containGeometry.viewportHeight).toBeCloseTo(562.5, 8);
        expect(containGeometry.textureScaleX).toBeCloseTo(1, 8);
        expect(coverGeometry.textureOffsetX).toBeCloseTo(0.21875, 8);
        expect(coverGeometry.textureScaleX).toBeCloseTo(0.5625, 8);
        expect(coverGeometry.viewportWidth).toBeCloseTo(1_000, 8);
        expectGeometry(fillGeometry, {
            textureOffsetX: 0,
            textureOffsetY: 0,
            textureScaleX: 1,
            textureScaleY: 1,
            viewportHeight: 1_000,
            viewportWidth: 1_000,
            viewportX: 0,
            viewportY: 0
        });
    });

    it('applies object-position to contain and cover free space', () => {
        const containGeometry = calculateTexturePresentationGeometry({
            ...BASE_INPUT,
            objectFit: 'contain',
            objectPosition: 'left bottom'
        });
        const coverGeometry = calculateTexturePresentationGeometry({
            ...BASE_INPUT,
            objectFit: 'cover',
            objectPosition: 'right top'
        });

        expect(containGeometry.viewportX).toBeCloseTo(0, 8);
        expect(containGeometry.viewportY).toBeCloseTo(437.5, 8);
        expect(coverGeometry.textureOffsetX).toBeCloseTo(0.4375, 8);
        expect(coverGeometry.textureOffsetY).toBeCloseTo(0, 8);
    });
});
