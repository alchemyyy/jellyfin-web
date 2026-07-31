const AGTM_APPLICATION_VERSION = 0;
const AGTM_CUSTOM_CURVE_FLAGS = 0xC0;
const AGTM_SINGLE_ALTERNATE_REC2020_FLAGS = 0x18;
const AGTM_MAX_RGB_COMPONENT_MIX = 0;
const CONTROL_POINT_COUNT = 8;
const BT2390_CONTROL_POINT_COUNT = 16;
const HDR_REFERENCE_WHITE_NITS = 203;
const HDR_SOURCE_PEAK_NITS = 1000;
const MIN_HDR_REFERENCE_WHITE_NITS = 0.2;
const MAX_HDR_REFERENCE_WHITE_NITS = 10000;
const MAX_HDR_HEADROOM_STOPS = 6;
const MAX_LINEAR_HDR_HEADROOM = 2 ** MAX_HDR_HEADROOM_STOPS;
const MIN_THETA_CODE = 1;
const MAX_THETA_CODE = 35999;
const PQ_M1 = 2610 / 16384;
const PQ_M2 = 2523 / 32;
const PQ_C1 = 3424 / 4096;
const PQ_C2 = 2413 / 128;
const PQ_C3 = 2392 / 128;

export interface BT2390ToneMappingParameters {
    kneeOffset: number;
    sourcePeakNits: number;
    targetPeakNits: number;
}

export const DEFAULT_BT2390_TONE_MAPPING_PARAMETERS:
Readonly<BT2390ToneMappingParameters> = {
    kneeOffset: 1,
    sourcePeakNits: HDR_SOURCE_PEAK_NITS,
    targetPeakNits: HDR_REFERENCE_WHITE_NITS
};

export const CLIENT_HDR_TONE_MAPPING_PRESETS = [
    'control',
    'mild',
    'balanced',
    'bright',
    'bt2390'
] as const;

export type ClientHDRToneMappingPreset = typeof CLIENT_HDR_TONE_MAPPING_PRESETS[number];

type CustomCurvePreset = 'mild' | 'balanced' | 'bright';

const PAPER_WHITE_FRACTIONS: Readonly<Record<CustomCurvePreset, number>> = {
    mild: 0.65,
    balanced: 0.75,
    bright: 0.85
};

interface GainCurveControlPoint {
    gain: number;
    gainSlope: number;
    input: number;
}

interface EncodedGainCurveControlPoint {
    gainCode: number;
    inputCode: number;
    thetaCode: number;
}

interface BT2390CurveDefinition {
    kneeNormalizedPQ: number;
    maximumOutputNormalizedPQ: number;
    sourceBlackPQ: number;
    sourcePQRange: number;
}

/**
 * Creates a complete ST 2094-50 payload for the selected SDR tone-mapping
 * preset.
 */
export function createAGTMPayload(
    preset: ClientHDRToneMappingPreset,
    bt2390Parameters: unknown = DEFAULT_BT2390_TONE_MAPPING_PARAMETERS
): Uint8Array {
    switch (preset) {
        case 'control':
            return createReferenceWhiteAGTMPayload(HDR_REFERENCE_WHITE_NITS);
        case 'mild':
        case 'balanced':
        case 'bright':
            return createSDRAGTMPayload(
                HDR_REFERENCE_WHITE_NITS,
                HDR_SOURCE_PEAK_NITS,
                PAPER_WHITE_FRACTIONS[preset]
            );
        case 'bt2390':
            return createBT2390AGTMPayload(
                normalizeBT2390ToneMappingParameters(bt2390Parameters)
            );
    }
}

/**
 * Resolves untrusted browser-local values without imposing tuning ranges.
 * Values outside the AGTM or PQ format domains fall back to the defaults.
 */
export function normalizeBT2390ToneMappingParameters(
    parameters: unknown
): BT2390ToneMappingParameters {
    const candidateParameters: Partial<Record<
        keyof BT2390ToneMappingParameters,
        unknown
    >> = typeof parameters === 'object' && parameters !== null ?
        parameters as Partial<Record<
            keyof BT2390ToneMappingParameters,
            unknown
        >> :
        {};

    const normalizedParameters: BT2390ToneMappingParameters = {
        kneeOffset: normalizeNumericParameter(
            candidateParameters.kneeOffset,
            DEFAULT_BT2390_TONE_MAPPING_PARAMETERS.kneeOffset
        ),
        sourcePeakNits: normalizeNumericParameter(
            candidateParameters.sourcePeakNits,
            DEFAULT_BT2390_TONE_MAPPING_PARAMETERS.sourcePeakNits
        ),
        targetPeakNits: normalizeNumericParameter(
            candidateParameters.targetPeakNits,
            DEFAULT_BT2390_TONE_MAPPING_PARAMETERS.targetPeakNits
        )
    };

    const canonicalParameters = canonicalizeBT2390ToneMappingParameters(
        normalizedParameters
    );
    return hasValidBT2390ToneMappingParameters(canonicalParameters) ?
        normalizedParameters :
        { ...DEFAULT_BT2390_TONE_MAPPING_PARAMETERS };
}

/**
 * Creates the smallest current-syntax AGTM payload that overrides HDR
 * reference white and leaves curve generation to Chrome.
 */
export function createReferenceWhiteAGTMPayload(referenceWhiteNits: number): Uint8Array {
    validateReferenceWhiteNits(referenceWhiteNits);

    const referenceWhiteCode = clampInteger(
        Math.round(referenceWhiteNits * 5),
        1,
        50000
    );
    const payload = new Uint8Array(4);
    const payloadView = new DataView(payload.buffer);

    payload[0] = AGTM_APPLICATION_VERSION;
    payload[1] = 0x80;
    payloadView.setUint16(2, referenceWhiteCode);

    return payload;
}

/**
 * Creates a one-alternate explicit gain curve that maps a declared HDR source
 * peak into an SDR destination.
 */
export function createSDRAGTMPayload(
    referenceWhiteNits: number,
    sourcePeakNits: number,
    paperWhiteFraction: number
): Uint8Array {
    validateCurveParameters(referenceWhiteNits, sourcePeakNits, paperWhiteFraction);

    const baselineHeadroom = Math.min(
        Math.log2(sourcePeakNits / referenceWhiteNits),
        MAX_HDR_HEADROOM_STOPS
    );
    const controlPoints = createGainCurveControlPoints(
        baselineHeadroom,
        paperWhiteFraction
    );

    return createCustomCurveAGTMPayload(
        referenceWhiteNits,
        baselineHeadroom,
        controlPoints,
        false
    );
}

/**
 * Creates a BT.2390 EETF-style explicit gain curve for an SDR destination.
 *
 * The black-point lift from BT.2390 is intentionally omitted because an
 * ST 2094-50 down-map may not contain positive gain.
 */
export function createBT2390AGTMPayload(
    parameters: BT2390ToneMappingParameters
): Uint8Array {
    const canonicalParameters = canonicalizeBT2390ToneMappingParameters(
        parameters
    );
    validateBT2390ToneMappingParameters(canonicalParameters);
    const baselineHeadroom = Math.log2(
        canonicalParameters.sourcePeakNits
            / canonicalParameters.targetPeakNits
    );
    const controlPoints = createBT2390GainCurveControlPoints(
        canonicalParameters
    );

    return createCustomCurveAGTMPayload(
        canonicalParameters.targetPeakNits,
        baselineHeadroom,
        controlPoints,
        true
    );
}

/**
 * Evaluates the unquantized BT.2390 EETF-style luminance mapping.
 */
export function mapBT2390Luminance(
    inputLuminanceNits: number,
    parameters: BT2390ToneMappingParameters
): number {
    validateBT2390ToneMappingParameters(parameters);

    if (
        !Number.isFinite(inputLuminanceNits)
        || inputLuminanceNits < 0
        || inputLuminanceNits > parameters.sourcePeakNits
    ) {
        throw new RangeError(
            'Input luminance must be finite and between zero and the source peak'
        );
    }

    const curveDefinition = createBT2390CurveDefinition(parameters);
    return mapBT2390LuminanceWithDefinition(
        inputLuminanceNits,
        curveDefinition
    );
}

function createCustomCurveAGTMPayload(
    referenceWhiteNits: number,
    baselineHeadroom: number,
    controlPoints: readonly GainCurveControlPoint[],
    usePCHIPSlope: boolean
): Uint8Array {
    validateReferenceWhiteNits(referenceWhiteNits);
    validateBaselineHeadroom(baselineHeadroom);
    validateGainCurveControlPoints(controlPoints, usePCHIPSlope);

    const encodedControlPoints = encodeGainCurveControlPoints(controlPoints);
    validateEncodedGainCurveControlPoints(encodedControlPoints);

    const slopeBytes = usePCHIPSlope ?
        0 :
        encodedControlPoints.length * 2;
    const payloadLength = 11
        + encodedControlPoints.length * 4
        + slopeBytes;
    const payload = new Uint8Array(payloadLength);
    const payloadView = new DataView(payload.buffer);
    let writeOffset = 0;

    payload[writeOffset++] = AGTM_APPLICATION_VERSION;
    payload[writeOffset++] = AGTM_CUSTOM_CURVE_FLAGS;
    payloadView.setUint16(
        writeOffset,
        clampInteger(Math.round(referenceWhiteNits * 5), 1, 50000)
    );
    writeOffset += 2;
    payloadView.setUint16(
        writeOffset,
        clampInteger(Math.round(baselineHeadroom * 10000), 0, 60000)
    );
    writeOffset += 2;
    payload[writeOffset++] = AGTM_SINGLE_ALTERNATE_REC2020_FLAGS;
    payloadView.setUint16(writeOffset, 0);
    writeOffset += 2;
    payload[writeOffset++] = AGTM_MAX_RGB_COMPONENT_MIX;
    payload[writeOffset++] = (
        (encodedControlPoints.length - 1) << 3
    ) | (
        usePCHIPSlope ? 0x04 : 0
    );

    for (const controlPoint of encodedControlPoints) {
        payloadView.setUint16(writeOffset, controlPoint.inputCode);
        writeOffset += 2;
    }

    for (const controlPoint of encodedControlPoints) {
        payloadView.setUint16(writeOffset, controlPoint.gainCode);
        writeOffset += 2;
    }

    if (!usePCHIPSlope) {
        for (const controlPoint of encodedControlPoints) {
            payloadView.setUint16(writeOffset, controlPoint.thetaCode);
            writeOffset += 2;
        }
    }

    return payload;
}

function encodeGainCurveControlPoints(
    controlPoints: readonly GainCurveControlPoint[]
): EncodedGainCurveControlPoint[] {
    const encodedControlPoints: EncodedGainCurveControlPoint[] = [];

    for (const controlPoint of controlPoints) {
        const thetaCode = Math.round(
            Math.atan(controlPoint.gainSlope) * 36000 / Math.PI
        ) + 18000;

        encodedControlPoints.push({
            gainCode: clampInteger(
                Math.round(-controlPoint.gain * 10000),
                0,
                60000
            ),
            inputCode: clampInteger(
                Math.round(controlPoint.input * 1000),
                0,
                64000
            ),
            thetaCode: clampInteger(
                thetaCode,
                MIN_THETA_CODE,
                MAX_THETA_CODE
            )
        });
    }

    return encodedControlPoints;
}

function validateEncodedGainCurveControlPoints(
    controlPoints: readonly EncodedGainCurveControlPoint[]
): void {
    for (
        let controlPointIndex = 1;
        controlPointIndex < controlPoints.length;
        controlPointIndex++
    ) {
        const previousControlPoint = controlPoints[controlPointIndex - 1];
        const controlPoint = controlPoints[controlPointIndex];

        if (controlPoint.inputCode < previousControlPoint.inputCode) {
            throw new RangeError(
                'Encoded AGTM control-point inputs must be non-decreasing'
            );
        }

        if (
            controlPoint.inputCode === previousControlPoint.inputCode
            && controlPoint.gainCode !== previousControlPoint.gainCode
        ) {
            throw new RangeError(
                'Equal encoded AGTM inputs must have equal gain'
            );
        }
    }
}

function createBT2390GainCurveControlPoints(
    parameters: BT2390ToneMappingParameters
): GainCurveControlPoint[] {
    const curveDefinition = createBT2390CurveDefinition(parameters);
    const kneeLuminanceNits = normalizedPQToLuminance(
        curveDefinition.kneeNormalizedPQ,
        curveDefinition
    );
    const kneeInput = kneeLuminanceNits / parameters.targetPeakNits;
    const includeKneePoint = Math.round(kneeInput * 1000) > 0;
    const shoulderControlPointCount = includeKneePoint ?
        BT2390_CONTROL_POINT_COUNT - 1 :
        BT2390_CONTROL_POINT_COUNT;
    const controlPoints: GainCurveControlPoint[] = [];

    controlPoints.push({
        gain: 0,
        gainSlope: 0,
        input: 0
    });

    for (
        let shoulderPointIndex = includeKneePoint ? 0 : 1;
        shoulderPointIndex < shoulderControlPointCount;
        shoulderPointIndex++
    ) {
        const shoulderPosition = shoulderPointIndex
            / (shoulderControlPointCount - 1);
        const inputNormalizedPQ = curveDefinition.kneeNormalizedPQ
            + shoulderPosition * (
                1 - curveDefinition.kneeNormalizedPQ
            );
        const inputLuminanceNits = normalizedPQToLuminance(
            inputNormalizedPQ,
            curveDefinition
        );
        const outputLuminanceNits = mapBT2390LuminanceWithDefinition(
            inputLuminanceNits,
            curveDefinition
        );
        const input = Math.min(
            inputLuminanceNits / parameters.targetPeakNits,
            MAX_LINEAR_HDR_HEADROOM
        );
        const output = outputLuminanceNits / parameters.targetPeakNits;
        const gain = input > 0 ?
            Math.min(Math.log2(output / input), 0) :
            0;

        controlPoints.push({
            gain,
            gainSlope: 0,
            input
        });
    }

    return canonicalizeBT2390GainCurveControlPoints(controlPoints);
}

function canonicalizeBT2390GainCurveControlPoints(
    controlPoints: readonly GainCurveControlPoint[]
): GainCurveControlPoint[] {
    const canonicalControlPoints: GainCurveControlPoint[] = [];

    for (
        let controlPointIndex = 0;
        controlPointIndex < controlPoints.length;
        controlPointIndex++
    ) {
        const encodedControlPoint = encodeGainCurveControlPoints([
            controlPoints[controlPointIndex]
        ])[0];
        const canonicalControlPoint: GainCurveControlPoint = {
            gain: encodedControlPoint.gainCode === 0 ?
                0 :
                -encodedControlPoint.gainCode / 10000,
            gainSlope: 0,
            input: encodedControlPoint.inputCode / 1000
        };
        const previousControlPoint =
            canonicalControlPoints[canonicalControlPoints.length - 1];

        if (
            previousControlPoint
            && previousControlPoint.input === canonicalControlPoint.input
        ) {
            const isLastControlPoint =
                controlPointIndex === controlPoints.length - 1;
            if (isLastControlPoint) {
                canonicalControlPoints[
                    canonicalControlPoints.length - 1
                ] = canonicalControlPoint;
            }
            continue;
        }

        canonicalControlPoints.push(canonicalControlPoint);
    }

    return canonicalControlPoints;
}

function createBT2390CurveDefinition(
    parameters: BT2390ToneMappingParameters
): BT2390CurveDefinition {
    const sourceBlackPQ = pqOETF(0);
    const sourcePeakPQ = pqOETF(parameters.sourcePeakNits);
    const sourcePQRange = sourcePeakPQ - sourceBlackPQ;
    const maximumOutputNormalizedPQ = (
        pqOETF(parameters.targetPeakNits) - sourceBlackPQ
    ) / sourcePQRange;
    const kneeNormalizedPQ = Math.max(
        (1 + parameters.kneeOffset) * maximumOutputNormalizedPQ
            - parameters.kneeOffset,
        0
    );

    return {
        kneeNormalizedPQ,
        maximumOutputNormalizedPQ,
        sourceBlackPQ,
        sourcePQRange
    };
}

function mapBT2390LuminanceWithDefinition(
    inputLuminanceNits: number,
    curveDefinition: BT2390CurveDefinition
): number {
    const inputNormalizedPQ = (
        pqOETF(inputLuminanceNits) - curveDefinition.sourceBlackPQ
    ) / curveDefinition.sourcePQRange;
    const outputNormalizedPQ = evaluateBT2390HermiteSpline(
        inputNormalizedPQ,
        curveDefinition.kneeNormalizedPQ,
        curveDefinition.maximumOutputNormalizedPQ
    );

    return normalizedPQToLuminance(
        outputNormalizedPQ,
        curveDefinition
    );
}

function evaluateBT2390HermiteSpline(
    inputNormalizedPQ: number,
    kneeNormalizedPQ: number,
    maximumOutputNormalizedPQ: number
): number {
    if (inputNormalizedPQ <= kneeNormalizedPQ) {
        return inputNormalizedPQ;
    }

    const interpolationPosition = (
        inputNormalizedPQ - kneeNormalizedPQ
    ) / (
        1 - kneeNormalizedPQ
    );
    const interpolationSquared = interpolationPosition
        * interpolationPosition;
    const interpolationCubed = interpolationSquared
        * interpolationPosition;

    return (
        2 * interpolationCubed - 3 * interpolationSquared + 1
    ) * kneeNormalizedPQ + (
        interpolationCubed
            - 2 * interpolationSquared
            + interpolationPosition
    ) * (
        1 - kneeNormalizedPQ
    ) + (
        -2 * interpolationCubed + 3 * interpolationSquared
    ) * maximumOutputNormalizedPQ;
}

function normalizedPQToLuminance(
    normalizedPQ: number,
    curveDefinition: BT2390CurveDefinition
): number {
    return pqEOTF(
        curveDefinition.sourceBlackPQ
            + normalizedPQ * curveDefinition.sourcePQRange
    );
}

function pqOETF(luminanceNits: number): number {
    const normalizedLuminance = luminanceNits / 10000;
    const poweredLuminance = normalizedLuminance ** PQ_M1;

    return (
        (PQ_C1 + PQ_C2 * poweredLuminance)
            / (1 + PQ_C3 * poweredLuminance)
    ) ** PQ_M2;
}

function pqEOTF(encodedLuminance: number): number {
    const poweredLuminance = encodedLuminance ** (1 / PQ_M2);
    const numerator = Math.max(poweredLuminance - PQ_C1, 0);
    const denominator = PQ_C2 - PQ_C3 * poweredLuminance;

    return 10000 * (
        numerator / denominator
    ) ** (1 / PQ_M1);
}

function createGainCurveControlPoints(
    baselineHeadroom: number,
    paperWhiteFraction: number
): GainCurveControlPoint[] {
    const kneeInput = 1;
    const kneeOutput = paperWhiteFraction;
    const maximumInput = 2 ** baselineHeadroom;
    const maximumOutput = 1;
    const interpolationWeight = 0.65;
    const middleInput = (1 - interpolationWeight) * kneeInput
        + interpolationWeight * kneeInput * maximumOutput / kneeOutput;
    const middleOutput = (1 - interpolationWeight) * kneeOutput
        + interpolationWeight * maximumOutput;

    const inputQuadratic = kneeInput - 2 * middleInput + maximumInput;
    const inputLinear = 2 * middleInput - 2 * kneeInput;
    const outputQuadratic = kneeOutput - 2 * middleOutput + maximumOutput;
    const outputLinear = 2 * middleOutput - 2 * kneeOutput;

    const controlPoints: GainCurveControlPoint[] = [];
    for (
        let controlPointIndex = 0;
        controlPointIndex < CONTROL_POINT_COUNT;
        controlPointIndex++
    ) {
        const interpolationPosition = controlPointIndex / (CONTROL_POINT_COUNT - 1);
        const input = kneeInput + interpolationPosition * (
            inputLinear + interpolationPosition * inputQuadratic
        );
        const output = kneeOutput + interpolationPosition * (
            outputLinear + interpolationPosition * outputQuadratic
        );
        const outputSlope = (
            2 * outputQuadratic * interpolationPosition + outputLinear
        ) / (
            2 * inputQuadratic * interpolationPosition + inputLinear
        );
        const gain = Math.log2(output / input);
        const gainSlope = (
            input * outputSlope - output
        ) / (
            Math.LN2 * input * output
        );

        controlPoints.push({
            gain,
            gainSlope,
            input
        });
    }

    return controlPoints;
}

function validateBT2390ToneMappingParameters(
    parameters: BT2390ToneMappingParameters
): void {
    if (
        !Number.isFinite(parameters.sourcePeakNits)
        || parameters.sourcePeakNits <= 0
        || parameters.sourcePeakNits > MAX_HDR_REFERENCE_WHITE_NITS
    ) {
        throw new RangeError(
            'HDR source peak must be greater than zero and at most 10000 nits'
        );
    }

    validateReferenceWhiteNits(parameters.targetPeakNits);

    if (!Number.isFinite(parameters.kneeOffset) || parameters.kneeOffset < 0) {
        throw new RangeError(
            'BT.2390 knee offset must be finite and non-negative'
        );
    }

    if (parameters.sourcePeakNits <= parameters.targetPeakNits) {
        throw new RangeError(
            'HDR source peak must be greater than SDR target peak'
        );
    }

    validateBaselineHeadroom(Math.log2(
        parameters.sourcePeakNits / parameters.targetPeakNits
    ));
}

function hasValidBT2390ToneMappingParameters(
    parameters: BT2390ToneMappingParameters
): boolean {
    if (
        !Number.isFinite(parameters.sourcePeakNits)
        || parameters.sourcePeakNits <= 0
        || parameters.sourcePeakNits > MAX_HDR_REFERENCE_WHITE_NITS
        || !Number.isFinite(parameters.targetPeakNits)
        || parameters.targetPeakNits < MIN_HDR_REFERENCE_WHITE_NITS
        || parameters.targetPeakNits > MAX_HDR_REFERENCE_WHITE_NITS
        || !Number.isFinite(parameters.kneeOffset)
        || parameters.kneeOffset < 0
        || parameters.sourcePeakNits <= parameters.targetPeakNits
    ) {
        return false;
    }

    const baselineHeadroom = Math.log2(
        parameters.sourcePeakNits / parameters.targetPeakNits
    );
    return Number.isFinite(baselineHeadroom)
        && baselineHeadroom > 0
        && baselineHeadroom <= MAX_HDR_HEADROOM_STOPS;
}

function canonicalizeBT2390ToneMappingParameters(
    parameters: BT2390ToneMappingParameters
): BT2390ToneMappingParameters {
    return {
        ...parameters,
        targetPeakNits: Math.round(parameters.targetPeakNits * 5) / 5
    };
}

function validateBaselineHeadroom(baselineHeadroom: number): void {
    if (
        !Number.isFinite(baselineHeadroom)
        || baselineHeadroom <= 0
        || baselineHeadroom > MAX_HDR_HEADROOM_STOPS
    ) {
        throw new RangeError(
            'Baseline HDR headroom must be greater than zero and at most 6 stops'
        );
    }
}

function validateGainCurveControlPoints(
    controlPoints: readonly GainCurveControlPoint[],
    usePCHIPSlope: boolean
): void {
    if (controlPoints.length < 1 || controlPoints.length > 32) {
        throw new RangeError(
            'AGTM gain curves must contain between 1 and 32 control points'
        );
    }

    let previousInput = 0;
    for (
        let controlPointIndex = 0;
        controlPointIndex < controlPoints.length;
        controlPointIndex++
    ) {
        const controlPoint = controlPoints[controlPointIndex];
        if (
            !Number.isFinite(controlPoint.input)
            || controlPoint.input < 0
            || controlPoint.input > MAX_LINEAR_HDR_HEADROOM
            || (
                controlPointIndex > 0
                && controlPoint.input < previousInput
            )
        ) {
            throw new RangeError(
                'AGTM control-point inputs must be non-decreasing within [0, 64]'
            );
        }

        if (
            !Number.isFinite(controlPoint.gain)
            || controlPoint.gain < -MAX_HDR_HEADROOM_STOPS
            || controlPoint.gain > 0
        ) {
            throw new RangeError(
                'AGTM down-map gain must be within [-6, 0]'
            );
        }

        if (!usePCHIPSlope && !Number.isFinite(controlPoint.gainSlope)) {
            throw new RangeError('AGTM gain slopes must be finite');
        }

        previousInput = controlPoint.input;
    }
}

function validateCurveParameters(
    referenceWhiteNits: number,
    sourcePeakNits: number,
    paperWhiteFraction: number
): void {
    validateReferenceWhiteNits(referenceWhiteNits);

    if (
        !Number.isFinite(sourcePeakNits)
        || sourcePeakNits <= referenceWhiteNits
    ) {
        throw new RangeError('HDR source peak must be greater than reference white');
    }

    if (
        !Number.isFinite(paperWhiteFraction)
        || paperWhiteFraction <= 0
        || paperWhiteFraction >= 1
    ) {
        throw new RangeError('Paper-white fraction must be greater than zero and less than one');
    }
}

function validateReferenceWhiteNits(referenceWhiteNits: number): void {
    if (
        !Number.isFinite(referenceWhiteNits)
        || referenceWhiteNits < MIN_HDR_REFERENCE_WHITE_NITS
        || referenceWhiteNits > MAX_HDR_REFERENCE_WHITE_NITS
    ) {
        throw new RangeError('HDR reference white must be between 0.2 and 10000 nits');
    }
}

function normalizeNumericParameter(
    value: unknown,
    fallback: number
): number {
    if (
        typeof value !== 'number'
        && typeof value !== 'string'
    ) {
        return fallback;
    }

    if (typeof value === 'string' && value.trim() === '') {
        return fallback;
    }

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) {
        return fallback;
    }

    return numericValue;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}
