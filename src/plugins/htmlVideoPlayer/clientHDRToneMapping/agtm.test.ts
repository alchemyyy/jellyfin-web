import { describe, expect, it } from 'vitest';

import {
    createBT2390AGTMPayload,
    createAGTMPayload,
    createReferenceWhiteAGTMPayload,
    createSDRAGTMPayload,
    DEFAULT_BT2390_TONE_MAPPING_PARAMETERS,
    mapBT2390Luminance,
    normalizeBT2390ToneMappingParameters,
    type BT2390ToneMappingParameters
} from './agtm';

const BALANCED_GOLDEN_PAYLOAD = [
    0x00, 0xC0, 0x03, 0xF7, 0x59, 0xDC, 0x18, 0x00, 0x00, 0x00, 0x38,
    0x03, 0xE8, 0x04, 0x6D, 0x05, 0x81, 0x07, 0x23, 0x09, 0x54, 0x0C,
    0x14, 0x0F, 0x62, 0x13, 0x3E, 0x10, 0x36, 0x13, 0xFB, 0x1D, 0x5E,
    0x29, 0x77, 0x36, 0x4C, 0x42, 0xDD, 0x4E, 0xC1, 0x59, 0xDC, 0x46,
    0x50, 0x25, 0xCE, 0x27, 0x78, 0x2C, 0x12, 0x30, 0xE7, 0x35, 0x14,
    0x38, 0x68, 0x3A, 0xFA
];

interface DecodedGainCurveControlPoint {
    gain: number;
    input: number;
    slope: number;
}

describe('AGTM serialization', () => {
    it('serializes Chromium-compatible reference-white metadata', () => {
        expect(Array.from(createReferenceWhiteAGTMPayload(100)))
            .toEqual([ 0x00, 0x80, 0x01, 0xF4 ]);
        expect(Array.from(createReferenceWhiteAGTMPayload(203)))
            .toEqual([ 0x00, 0x80, 0x03, 0xF7 ]);
        expect(Array.from(createReferenceWhiteAGTMPayload(400)))
            .toEqual([ 0x00, 0x80, 0x07, 0xD0 ]);
        expect(() => createReferenceWhiteAGTMPayload(Number.NaN))
            .toThrow(RangeError);
        expect(() => createReferenceWhiteAGTMPayload(10000.1))
            .toThrow(RangeError);
    });

    it('matches the balanced explicit-curve golden payload', () => {
        expect(Array.from(createAGTMPayload('control')))
            .toEqual([ 0x00, 0x80, 0x03, 0xF7 ]);
        expect(Array.from(createAGTMPayload('balanced')))
            .toEqual(BALANCED_GOLDEN_PAYLOAD);
        expect(createAGTMPayload('bright')).toHaveLength(
            BALANCED_GOLDEN_PAYLOAD.length
        );
        expect(createAGTMPayload('bright')).not.toEqual(
            createAGTMPayload('balanced')
        );
    });

    it('serializes an adjustable BT.2390 curve using PCHIP slopes', () => {
        const parameters: BT2390ToneMappingParameters = {
            ...DEFAULT_BT2390_TONE_MAPPING_PARAMETERS
        };
        const payload = createBT2390AGTMPayload(parameters);
        const payloadView = new DataView(
            payload.buffer,
            payload.byteOffset,
            payload.byteLength
        );
        const controlPoints = decodePCHIPGainCurve(payload);

        expect(payload).toHaveLength(75);
        expect(payloadView.getUint16(2)).toBe(1015);
        expect(payloadView.getUint16(4)).toBeCloseTo(
            Math.log2(1000 / 203) * 10000,
            0
        );
        expect(payload[10]).toBe(0x7C);
        expect(controlPoints).toHaveLength(16);
        expect(controlPoints[0].input).toBe(0);
        expect(Math.abs(controlPoints[0].gain)).toBe(0);
        const lastControlPoint = controlPoints[controlPoints.length - 1];
        expect(lastControlPoint.input).toBeCloseTo(1000 / 203, 3);
        expect(lastControlPoint.gain).toBeCloseTo(
            -Math.log2(1000 / 203),
            3
        );

        let previousOutput = 0;
        const maximumInput = 1000 / 203;
        for (let sampleIndex = 0; sampleIndex <= 4096; sampleIndex++) {
            const input = maximumInput * sampleIndex / 4096;
            const gain = evaluateGainCurve(controlPoints, input);
            const output = input * 2 ** gain;

            expect(gain).toBeLessThanOrEqual(0.0001);
            expect(output).toBeGreaterThanOrEqual(previousOutput - 0.0001);
            expect(output).toBeLessThanOrEqual(1.0002);
            previousOutput = output;
        }
    });

    it('implements the PQ-domain BT.2390 EETF anchors', () => {
        const strictParameters: BT2390ToneMappingParameters = {
            kneeOffset: 0.5,
            sourcePeakNits: 1000,
            targetPeakNits: 203
        };

        expect(mapBT2390Luminance(0, strictParameters)).toBeCloseTo(0, 8);
        expect(mapBT2390Luminance(10, strictParameters)).toBeCloseTo(10, 8);
        expect(mapBT2390Luminance(203, strictParameters)).toBeCloseTo(
            159.04,
            1
        );
        expect(mapBT2390Luminance(1000, strictParameters)).toBeCloseTo(
            203,
            8
        );

        const earlierKneePayload = createAGTMPayload('bt2390', {
            ...strictParameters,
            kneeOffset: 1
        });
        const strictPayload = createAGTMPayload('bt2390', strictParameters);
        expect(earlierKneePayload).not.toEqual(strictPayload);
    });

    it('keeps the quantized BT.2390 curve valid at parameter limits', () => {
        const parameterCases: BT2390ToneMappingParameters[] = [];
        parameterCases.push(
            {
                kneeOffset: 0.5,
                sourcePeakNits: 500,
                targetPeakNits: 400
            },
            {
                kneeOffset: 2,
                sourcePeakNits: 6400,
                targetPeakNits: 100
            },
            {
                kneeOffset: 1,
                sourcePeakNits: 4000,
                targetPeakNits: 203
            }
        );

        for (const parameters of parameterCases) {
            const controlPoints = decodePCHIPGainCurve(
                createBT2390AGTMPayload(parameters)
            );
            expectQuantizedCurveIsValid(
                controlPoints,
                parameters.sourcePeakNits / parameters.targetPeakNits
            );
        }
    });

    it('coalesces control points that share one encoded input', () => {
        const parameters: BT2390ToneMappingParameters = {
            kneeOffset: 2,
            sourcePeakNits: 1950,
            targetPeakNits: 150
        };
        const controlPoints = decodePCHIPGainCurve(
            createBT2390AGTMPayload(parameters)
        );

        expect(controlPoints.length).toBeLessThan(16);
        expect(controlPoints[0].input).toBe(0);
        expect(Math.abs(controlPoints[0].gain)).toBe(0);
        expect(controlPoints[1].input).toBeGreaterThan(0);
        expectQuantizedCurveIsValid(
            controlPoints,
            parameters.sourcePeakNits / parameters.targetPeakNits
        );
    });

    it('normalizes untrusted BT.2390 parameters to safe ranges', () => {
        expect(normalizeBT2390ToneMappingParameters(undefined)).toEqual(
            DEFAULT_BT2390_TONE_MAPPING_PARAMETERS
        );
        expect(normalizeBT2390ToneMappingParameters({
            kneeOffset: '1.25',
            sourcePeakNits: 10000,
            targetPeakNits: 50
        })).toEqual({
            kneeOffset: 1.25,
            sourcePeakNits: 6400,
            targetPeakNits: 100
        });
        expect(normalizeBT2390ToneMappingParameters({
            kneeOffset: Number.NaN,
            sourcePeakNits: '',
            targetPeakNits: null
        })).toEqual(DEFAULT_BT2390_TONE_MAPPING_PARAMETERS);
    });

    it('rejects invalid curve parameters', () => {
        expect(() => createSDRAGTMPayload(0, 1000, 0.75)).toThrow(RangeError);
        expect(() => createSDRAGTMPayload(203, 200, 0.75)).toThrow(RangeError);
        expect(() => createSDRAGTMPayload(203, 1000, 0)).toThrow(RangeError);
        expect(() => createSDRAGTMPayload(203, 1000, 1)).toThrow(RangeError);
        expect(() => createSDRAGTMPayload(203, 1000, 1.1)).toThrow(RangeError);
        expect(() => createSDRAGTMPayload(10000.1, 20000, 0.75))
            .toThrow(RangeError);
        expect(() => createBT2390AGTMPayload({
            kneeOffset: 0.49,
            sourcePeakNits: 1000,
            targetPeakNits: 203
        })).toThrow(RangeError);
        expect(() => createBT2390AGTMPayload({
            kneeOffset: 1,
            sourcePeakNits: 6400,
            targetPeakNits: 99
        })).toThrow(RangeError);
        expect(() => mapBT2390Luminance(
            1001,
            DEFAULT_BT2390_TONE_MAPPING_PARAMETERS
        )).toThrow(RangeError);
    });
});

function decodePCHIPGainCurve(
    payload: Uint8Array
): DecodedGainCurveControlPoint[] {
    const payloadView = new DataView(
        payload.buffer,
        payload.byteOffset,
        payload.byteLength
    );
    const controlPointCount = (payload[10] >> 3) + 1;
    const usesPCHIP = (payload[10] & 0x04) !== 0;
    const controlPoints: DecodedGainCurveControlPoint[] = [];
    let readOffset = 11;

    expect(usesPCHIP).toBe(true);

    for (
        let controlPointIndex = 0;
        controlPointIndex < controlPointCount;
        controlPointIndex++
    ) {
        controlPoints.push({
            gain: 0,
            input: payloadView.getUint16(readOffset) / 1000,
            slope: 0
        });
        readOffset += 2;
    }

    for (
        let controlPointIndex = 0;
        controlPointIndex < controlPointCount;
        controlPointIndex++
    ) {
        controlPoints[controlPointIndex].gain =
            -payloadView.getUint16(readOffset) / 10000;
        readOffset += 2;
    }

    for (
        let controlPointIndex = 1;
        controlPointIndex < controlPoints.length;
        controlPointIndex++
    ) {
        const previousControlPoint = controlPoints[controlPointIndex - 1];
        const controlPoint = controlPoints[controlPointIndex];

        expect(controlPoint.input).toBeGreaterThanOrEqual(
            previousControlPoint.input
        );
        if (controlPoint.input === previousControlPoint.input) {
            expect(controlPoint.gain).toBe(previousControlPoint.gain);
        }
    }

    populatePCHIPSlopes(controlPoints);
    return controlPoints;
}

function expectQuantizedCurveIsValid(
    controlPoints: readonly DecodedGainCurveControlPoint[],
    maximumInput: number
): void {
    let previousOutput = 0;

    for (let sampleIndex = 0; sampleIndex <= 4096; sampleIndex++) {
        const input = maximumInput * sampleIndex / 4096;
        const gain = evaluateGainCurve(controlPoints, input);
        const output = input * 2 ** gain;

        expect(Number.isFinite(gain)).toBe(true);
        expect(gain).toBeLessThanOrEqual(0.0001);
        expect(output).toBeGreaterThanOrEqual(previousOutput - 0.0001);
        expect(output).toBeLessThanOrEqual(1.0005);
        previousOutput = output;
    }
}

function populatePCHIPSlopes(
    controlPoints: DecodedGainCurveControlPoint[]
): void {
    const intervalWidths: number[] = [];
    const linearSlopes: number[] = [];

    for (
        let controlPointIndex = 0;
        controlPointIndex < controlPoints.length - 1;
        controlPointIndex++
    ) {
        const intervalWidth = controlPoints[controlPointIndex + 1].input
            - controlPoints[controlPointIndex].input;
        intervalWidths.push(intervalWidth);
        linearSlopes.push(intervalWidth === 0 ?
            0 :
            (
                controlPoints[controlPointIndex + 1].gain
                    - controlPoints[controlPointIndex].gain
            ) / intervalWidth
        );
    }

    for (
        let controlPointIndex = 0;
        controlPointIndex < controlPoints.length;
        controlPointIndex++
    ) {
        const hasPreviousPoint = controlPointIndex > 0;
        const hasNextPoint = controlPointIndex + 1 < controlPoints.length;

        if (hasPreviousPoint && hasNextPoint) {
            const previousSlope = linearSlopes[controlPointIndex - 1];
            const nextSlope = linearSlopes[controlPointIndex];
            if (
                haveDifferentSigns(previousSlope, nextSlope)
                || previousSlope === 0
                || nextSlope === 0
            ) {
                controlPoints[controlPointIndex].slope = 0;
                continue;
            }

            const previousWidth = intervalWidths[controlPointIndex - 1];
            const nextWidth = intervalWidths[controlPointIndex];
            controlPoints[controlPointIndex].slope = (
                3 * (previousWidth + nextWidth)
                    * previousSlope * nextSlope
            ) / (
                (2 * previousWidth + nextWidth) * previousSlope
                    + (previousWidth + 2 * nextWidth) * nextSlope
            );
            continue;
        }

        if (hasNextPoint) {
            controlPoints[controlPointIndex].slope =
                calculateEndpointPCHIPSlope(
                    intervalWidths[0],
                    intervalWidths[1],
                    linearSlopes[0],
                    linearSlopes[1]
                );
            continue;
        }

        controlPoints[controlPointIndex].slope =
            calculateEndpointPCHIPSlope(
                intervalWidths[intervalWidths.length - 1],
                intervalWidths[intervalWidths.length - 2],
                linearSlopes[linearSlopes.length - 1],
                linearSlopes[linearSlopes.length - 2]
            );
    }
}

function calculateEndpointPCHIPSlope(
    firstWidth: number,
    secondWidth: number,
    firstSlope: number,
    secondSlope: number
): number {
    let slope = (
        (2 * firstWidth + secondWidth) * firstSlope
            - firstWidth * secondSlope
    ) / (
        firstWidth + secondWidth
    );

    if (haveDifferentSigns(slope, firstSlope)) {
        slope = 0;
    } else if (
        haveDifferentSigns(slope, secondSlope)
        && Math.abs(slope) > 3 * Math.abs(firstSlope)
    ) {
        slope = 3 * firstSlope;
    }

    return slope;
}

function haveDifferentSigns(firstValue: number, secondValue: number): boolean {
    return (
        firstValue < 0 || Object.is(firstValue, -0)
    ) !== (
        secondValue < 0 || Object.is(secondValue, -0)
    );
}

function evaluateGainCurve(
    controlPoints: readonly DecodedGainCurveControlPoint[],
    input: number
): number {
    const firstControlPoint = controlPoints[0];
    if (input <= firstControlPoint.input) {
        return firstControlPoint.gain;
    }

    const lastControlPoint = controlPoints[controlPoints.length - 1];
    if (input >= lastControlPoint.input) {
        return lastControlPoint.gain + Math.log2(
            lastControlPoint.input / input
        );
    }

    let lowerControlPointIndex = 0;
    while (
        controlPoints[lowerControlPointIndex + 1].input < input
    ) {
        lowerControlPointIndex++;
    }

    const lowerControlPoint = controlPoints[lowerControlPointIndex];
    const upperControlPoint = controlPoints[lowerControlPointIndex + 1];
    const intervalWidth = upperControlPoint.input - lowerControlPoint.input;
    const interpolationPosition = (
        input - lowerControlPoint.input
    ) / intervalWidth;
    const lowerScaledSlope = lowerControlPoint.slope * intervalWidth;
    const upperScaledSlope = upperControlPoint.slope * intervalWidth;
    const cubicCoefficient = 2 * lowerControlPoint.gain
        + lowerScaledSlope
        - 2 * upperControlPoint.gain
        + upperScaledSlope;
    const quadraticCoefficient = -3 * lowerControlPoint.gain
        + 3 * upperControlPoint.gain
        - 2 * lowerScaledSlope
        - upperScaledSlope;

    return (
        (
            cubicCoefficient * interpolationPosition
                + quadraticCoefficient
        ) * interpolationPosition + lowerScaledSlope
    ) * interpolationPosition + lowerControlPoint.gain;
}
