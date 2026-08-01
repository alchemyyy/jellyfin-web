import { describe, expect, it } from 'vitest';

import { millisecondsToMicroseconds } from '../MediaTime';
import { createPQColorMetadata, createSDRColorMetadata } from './ColorMetadata';
import { convertLinearRGBGamut } from './ColorPipeline';
import {
    createTransferValidationRamp,
    validateColorRamp,
    type ColorRampObservation,
    type ColorValidationRamp
} from './ColorValidation';

function observeExpected(ramp: ColorValidationRamp): ColorRampObservation[] {
    const observations: ColorRampObservation[] = [];
    for (const sample of ramp.samples) {
        observations.push({
            linearRGB: sample.expectedLinearRGB,
            timestampMicroseconds: sample.timestampMicroseconds
        });
    }
    return observations;
}

describe('ColorValidation', () => {
    it('builds a deterministic integer-microsecond transfer ramp', () => {
        const ramp = createTransferValidationRamp(createSDRColorMetadata(), {
            frameIntervalMicroseconds: millisecondsToMicroseconds(20),
            startTimestampMicroseconds: millisecondsToMicroseconds(5)
        });

        expect(ramp.samples).toHaveLength(5);
        expect(ramp.samples.map(sample => sample.timestampMicroseconds))
            .toEqual([ 5_000, 25_000, 45_000, 65_000, 85_000 ]);
        expect(ramp.samples.every(sample => Number.isInteger(sample.timestampMicroseconds)))
            .toBe(true);
    });

    it('accepts observations within both error tolerances', () => {
        const ramp = createTransferValidationRamp(createPQColorMetadata());
        const observations = observeExpected(ramp);
        observations[2] = {
            ...observations[2],
            linearRGB: observations[2].linearRGB.map(
                (component: number): number => component + 0.001
            ) as [number, number, number]
        };

        expect(validateColorRamp(ramp, observations)).toMatchObject({
            accepted: true,
            classification: 'valid',
            sampleCount: 5
        });
    });

    it('builds explicit chromatic samples without changing scalar compatibility', () => {
        const encodedRGBTriplets = [
            [ 0.25, 0.25, 0.25 ],
            [ 0.75, 0.25, 0.25 ],
            [ 0.25, 0.75, 0.25 ],
            [ 0.25, 0.25, 0.75 ]
        ] as const;
        const ramp = createTransferValidationRamp(createPQColorMetadata(), {
            encodedRGBTriplets
        });

        expect(ramp.samples.map(sample => sample.encodedInputRGB))
            .toEqual(encodedRGBTriplets);
        expect(createTransferValidationRamp(createPQColorMetadata(), {
            encodedSignalLevels: [ 0, 0.5, 1 ]
        }).samples.map(sample => sample.encodedInputRGB)).toEqual([
            [ 0, 0, 0 ],
            [ 0.5, 0.5, 0.5 ],
            [ 1, 1, 1 ]
        ]);
    });

    it('rejects a primaries-converted chromatic observation', () => {
        const ramp = createTransferValidationRamp(createPQColorMetadata(), {
            encodedRGBTriplets: [
                [ 0.25, 0.25, 0.25 ],
                [ 0.75, 0.25, 0.25 ],
                [ 0.25, 0.75, 0.25 ],
                [ 0.25, 0.25, 0.75 ]
            ]
        });
        const primariesConvertedObservations: ColorRampObservation[] = [];
        for (const sample of ramp.samples) {
            primariesConvertedObservations.push({
                linearRGB: convertLinearRGBGamut(
                    sample.expectedLinearRGB,
                    'bt2020',
                    'bt709'
                ),
                timestampMicroseconds: sample.timestampMicroseconds
            });
        }

        expect(validateColorRamp(ramp, primariesConvertedObservations)).toMatchObject({
            accepted: false,
            classification: 'mismatch'
        });
    });

    it('rejects ambiguous or malformed explicit sample options', () => {
        expect(() => createTransferValidationRamp(createPQColorMetadata(), {
            encodedRGBTriplets: [
                [ 0, 0, 0 ],
                [ 0.5, 0.5, 0.5 ],
                [ 1, 1, 1 ]
            ],
            encodedSignalLevels: [ 0, 0.5, 1 ]
        })).toThrow('not both');
        expect(() => createTransferValidationRamp(createPQColorMetadata(), {
            encodedRGBTriplets: [
                [ 0, 0, 0 ],
                [ 0.5, Number.NaN, 0.5 ],
                [ 1, 1, 1 ]
            ]
        })).toThrow('finite encoded RGB triplets');
    });

    it('rejects an HDR ramp clamped to normalized SDR range', () => {
        const ramp = createTransferValidationRamp(createPQColorMetadata());
        const observations: ColorRampObservation[] = [];
        for (const sample of ramp.samples) {
            observations.push({
                linearRGB: sample.expectedLinearRGB.map(
                    (component: number): number => Math.min(Math.max(component, 0), 1)
                ) as [number, number, number],
                timestampMicroseconds: sample.timestampMicroseconds
            });
        }

        expect(validateColorRamp(ramp, observations)).toMatchObject({
            accepted: false,
            classification: 'clamped'
        });
    });

    it('rejects a ramp with a second transfer decode', () => {
        const ramp = createTransferValidationRamp(createSDRColorMetadata());
        const observations: ColorRampObservation[] = [];
        for (const sample of ramp.samples) {
            observations.push({
                linearRGB: sample.doubleTransformedLinearRGB,
                timestampMicroseconds: sample.timestampMicroseconds
            });
        }

        expect(validateColorRamp(ramp, observations)).toMatchObject({
            accepted: false,
            classification: 'double-transformed'
        });
    });

    it('rejects missing, duplicated, and unexplained observations', () => {
        const ramp = createTransferValidationRamp(createSDRColorMetadata());
        const expectedObservations = observeExpected(ramp);
        const mismatchedObservations = observeExpected(ramp);
        mismatchedObservations[2] = {
            ...mismatchedObservations[2],
            linearRGB: [ 0.123, 0.456, 0.789 ]
        };

        expect(validateColorRamp(ramp, expectedObservations.slice(1)).classification)
            .toBe('invalid-samples');
        expect(validateColorRamp(ramp, [
            expectedObservations[0],
            expectedObservations[0],
            ...expectedObservations.slice(2)
        ]).classification).toBe('invalid-samples');
        expect(validateColorRamp(ramp, mismatchedObservations).classification).toBe('mismatch');
    });
});
