const CSS_CALC_POSITION_PATTERN = /^calc\(\s*([-\d.]+)%\s*([+-])\s*([\d.]+)px\s*\)$/i;
const CSS_LENGTH_PATTERN = /^([-\d.]+)px$/i;
const CSS_PERCENTAGE_PATTERN = /^([-\d.]+)%$/;

type ObjectPositionCoordinate = {
    lengthPixels: number
    percentage: number
};

type ObjectPosition = {
    x: ObjectPositionCoordinate
    y: ObjectPositionCoordinate
};

export type TexturePresentationGeometry = {
    textureOffsetX: number
    textureOffsetY: number
    textureScaleX: number
    textureScaleY: number
    viewportHeight: number
    viewportWidth: number
    viewportX: number
    viewportY: number
};

export type TexturePresentationGeometryInput = {
    objectFit: string
    objectPosition: string
    sourceHeight: number
    sourceWidth: number
    targetCSSHeight: number
    targetCSSWidth: number
    targetPixelHeight: number
    targetPixelWidth: number
};

const CENTER_POSITION_COORDINATE: ObjectPositionCoordinate = {
    lengthPixels: 0,
    percentage: 0.5
};

function tokenizeCSSPosition(value: string): string[] {
    const tokens: string[] = [];
    let currentToken = '';
    let parenthesisDepth = 0;
    for (const character of value) {
        switch (character) {
            case '(':
                parenthesisDepth += 1;
                currentToken += character;
                break;
            case ')':
                parenthesisDepth = Math.max(parenthesisDepth - 1, 0);
                currentToken += character;
                break;
            case ' ':
            case '\n':
            case '\r':
            case '\t':
                if (parenthesisDepth > 0) {
                    currentToken += character;
                    break;
                }
                if (currentToken) {
                    tokens.push(currentToken);
                    currentToken = '';
                }
                break;
            default:
                currentToken += character;
                break;
        }
    }
    if (currentToken) {
        tokens.push(currentToken);
    }
    return tokens;
}

function parseFiniteNumber(value: string): number | null {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : null;
}

function parseKeywordCoordinate(
    value: string,
    axis: 'x' | 'y'
): ObjectPositionCoordinate | null {
    switch (value) {
        case 'center':
            return CENTER_POSITION_COORDINATE;
        case 'left':
            return axis === 'x' ? { lengthPixels: 0, percentage: 0 } : null;
        case 'right':
            return axis === 'x' ? { lengthPixels: 0, percentage: 1 } : null;
        case 'top':
            return axis === 'y' ? { lengthPixels: 0, percentage: 0 } : null;
        case 'bottom':
            return axis === 'y' ? { lengthPixels: 0, percentage: 1 } : null;
        case '0':
            return { lengthPixels: 0, percentage: 0 };
        default:
            return null;
    }
}

function parsePercentageCoordinate(value: string): ObjectPositionCoordinate | null {
    const percentageMatch = CSS_PERCENTAGE_PATTERN.exec(value);
    const percentage = percentageMatch ? parseFiniteNumber(percentageMatch[1]) : null;
    if (percentage === null) {
        return null;
    }
    return { lengthPixels: 0, percentage: percentage / 100 };
}

function parseLengthCoordinate(value: string): ObjectPositionCoordinate | null {
    const lengthMatch = CSS_LENGTH_PATTERN.exec(value);
    const lengthPixels = lengthMatch ? parseFiniteNumber(lengthMatch[1]) : null;
    if (lengthPixels === null) {
        return null;
    }
    return { lengthPixels, percentage: 0 };
}

function parseCalculationCoordinate(value: string): ObjectPositionCoordinate | null {
    const calculationMatch = CSS_CALC_POSITION_PATTERN.exec(value);
    if (!calculationMatch) {
        return null;
    }
    const percentage = parseFiniteNumber(calculationMatch[1]);
    const lengthPixels = parseFiniteNumber(calculationMatch[3]);
    if (percentage === null || lengthPixels === null) {
        return null;
    }
    const lengthSign = calculationMatch[2] === '-' ? -1 : 1;
    return {
        lengthPixels: lengthSign * lengthPixels,
        percentage: percentage / 100
    };
}

function parsePositionCoordinate(
    value: string,
    axis: 'x' | 'y'
): ObjectPositionCoordinate | null {
    const normalizedValue = value.toLowerCase();
    return parseKeywordCoordinate(normalizedValue, axis)
        ?? parsePercentageCoordinate(normalizedValue)
        ?? parseLengthCoordinate(normalizedValue)
        ?? parseCalculationCoordinate(normalizedValue);
}

function parseEdgeOffset(value: string): number | null {
    if (value === '0') {
        return 0;
    }
    const lengthMatch = CSS_LENGTH_PATTERN.exec(value);
    return lengthMatch ? parseFiniteNumber(lengthMatch[1]) : null;
}

function createEdgeCoordinate(edge: string, offsetPixels: number): ObjectPositionCoordinate {
    switch (edge) {
        case 'right':
        case 'bottom':
            return { lengthPixels: -offsetPixels, percentage: 1 };
        case 'left':
        case 'top':
        default:
            return { lengthPixels: offsetPixels, percentage: 0 };
    }
}

function getEdgeAxis(value: string): 'x' | 'y' | null {
    switch (value) {
        case 'left':
        case 'right':
            return 'x';
        case 'top':
        case 'bottom':
            return 'y';
        default:
            return null;
    }
}

function setEdgeCoordinate(
    position: { x: ObjectPositionCoordinate | null, y: ObjectPositionCoordinate | null },
    axis: 'x' | 'y',
    coordinate: ObjectPositionCoordinate
): boolean {
    if (position[axis]) {
        return false;
    }
    position[axis] = coordinate;
    return true;
}

type ParsedEdgeToken = {
    axis: 'x' | 'y' | null
    coordinate: ObjectPositionCoordinate | null
    nextTokenIndex: number
};

function parseEdgeToken(
    tokens: readonly string[],
    tokenIndex: number
): ParsedEdgeToken | null {
    const token = tokens[tokenIndex].toLowerCase();
    if (token === 'center') {
        return { axis: null, coordinate: null, nextTokenIndex: tokenIndex };
    }
    const axis = getEdgeAxis(token);
    if (!axis) {
        return null;
    }
    const nextOffset = tokenIndex + 1 < tokens.length ?
        parseEdgeOffset(tokens[tokenIndex + 1].toLowerCase()) :
        null;
    return {
        axis,
        coordinate: createEdgeCoordinate(token, nextOffset ?? 0),
        nextTokenIndex: nextOffset === null ? tokenIndex : tokenIndex + 1
    };
}

function completeEdgePosition(
    position: { x: ObjectPositionCoordinate | null, y: ObjectPositionCoordinate | null },
    pendingCenterCount: number
): ObjectPosition | null {
    let remainingCenterCount = pendingCenterCount;
    if (!position.x && remainingCenterCount > 0) {
        position.x = CENTER_POSITION_COORDINATE;
        remainingCenterCount -= 1;
    }
    if (!position.y && remainingCenterCount > 0) {
        position.y = CENTER_POSITION_COORDINATE;
        remainingCenterCount -= 1;
    }
    return remainingCenterCount > 0 ? null : {
        x: position.x ?? CENTER_POSITION_COORDINATE,
        y: position.y ?? CENTER_POSITION_COORDINATE
    };
}

function parseEdgeObjectPosition(tokens: readonly string[]): ObjectPosition | null {
    if (tokens.length < 3 || tokens.length > 4) {
        return null;
    }

    const position: {
        x: ObjectPositionCoordinate | null
        y: ObjectPositionCoordinate | null
    } = { x: null, y: null };
    let pendingCenterCount = 0;
    let tokenIndex = 0;
    while (tokenIndex < tokens.length) {
        const parsedToken = parseEdgeToken(tokens, tokenIndex);
        if (!parsedToken) {
            return null;
        }
        tokenIndex = parsedToken.nextTokenIndex + 1;
        if (!parsedToken.axis || !parsedToken.coordinate) {
            pendingCenterCount += 1;
            continue;
        }
        if (!setEdgeCoordinate(position, parsedToken.axis, parsedToken.coordinate)) {
            return null;
        }
    }
    return completeEdgePosition(position, pendingCenterCount);
}

function parseObjectPosition(value: string): ObjectPosition {
    const tokens = tokenizeCSSPosition(value.trim());
    const edgePosition = parseEdgeObjectPosition(tokens);
    if (edgePosition) {
        return edgePosition;
    }

    if (tokens.length === 1) {
        const horizontalCoordinate = parsePositionCoordinate(tokens[0], 'x');
        if (horizontalCoordinate) {
            return { x: horizontalCoordinate, y: CENTER_POSITION_COORDINATE };
        }
        const verticalCoordinate = parsePositionCoordinate(tokens[0], 'y');
        if (verticalCoordinate) {
            return { x: CENTER_POSITION_COORDINATE, y: verticalCoordinate };
        }
    }
    if (tokens.length === 2) {
        const horizontalCoordinate = parsePositionCoordinate(tokens[0], 'x');
        const verticalCoordinate = parsePositionCoordinate(tokens[1], 'y');
        if (horizontalCoordinate && verticalCoordinate) {
            return { x: horizontalCoordinate, y: verticalCoordinate };
        }
        const reversedHorizontalCoordinate = parsePositionCoordinate(tokens[1], 'x');
        const reversedVerticalCoordinate = parsePositionCoordinate(tokens[0], 'y');
        if (reversedHorizontalCoordinate && reversedVerticalCoordinate) {
            return { x: reversedHorizontalCoordinate, y: reversedVerticalCoordinate };
        }
    }
    return {
        x: CENTER_POSITION_COORDINATE,
        y: CENTER_POSITION_COORDINATE
    };
}

function requirePositiveDimension(value: number, name: string): void {
    if (!Number.isFinite(value) || value <= 0) {
        throw new RangeError(`${name} must be a positive finite number`);
    }
}

/** Computes CSS object-fit and object-position as a GPU viewport and source crop. */
export function calculateTexturePresentationGeometry(
    input: TexturePresentationGeometryInput
): TexturePresentationGeometry {
    requirePositiveDimension(input.sourceWidth, 'Source width');
    requirePositiveDimension(input.sourceHeight, 'Source height');
    requirePositiveDimension(input.targetCSSWidth, 'Target CSS width');
    requirePositiveDimension(input.targetCSSHeight, 'Target CSS height');
    requirePositiveDimension(input.targetPixelWidth, 'Target pixel width');
    requirePositiveDimension(input.targetPixelHeight, 'Target pixel height');

    const containScale = Math.min(
        input.targetCSSWidth / input.sourceWidth,
        input.targetCSSHeight / input.sourceHeight
    );
    let objectWidth: number;
    let objectHeight: number;
    switch (input.objectFit) {
        case 'contain':
            objectWidth = input.sourceWidth * containScale;
            objectHeight = input.sourceHeight * containScale;
            break;
        case 'cover': {
            const coverScale = Math.max(
                input.targetCSSWidth / input.sourceWidth,
                input.targetCSSHeight / input.sourceHeight
            );
            objectWidth = input.sourceWidth * coverScale;
            objectHeight = input.sourceHeight * coverScale;
            break;
        }
        case 'none':
            objectWidth = input.sourceWidth;
            objectHeight = input.sourceHeight;
            break;
        case 'scale-down': {
            const scaleDown = Math.min(containScale, 1);
            objectWidth = input.sourceWidth * scaleDown;
            objectHeight = input.sourceHeight * scaleDown;
            break;
        }
        case 'fill':
        default:
            objectWidth = input.targetCSSWidth;
            objectHeight = input.targetCSSHeight;
            break;
    }

    const objectPosition = parseObjectPosition(input.objectPosition || '50% 50%');
    const objectX = (
        (input.targetCSSWidth - objectWidth) * objectPosition.x.percentage
    ) + objectPosition.x.lengthPixels;
    const objectY = (
        (input.targetCSSHeight - objectHeight) * objectPosition.y.percentage
    ) + objectPosition.y.lengthPixels;
    const visibleLeft = Math.max(objectX, 0);
    const visibleTop = Math.max(objectY, 0);
    const visibleRight = Math.min(objectX + objectWidth, input.targetCSSWidth);
    const visibleBottom = Math.min(objectY + objectHeight, input.targetCSSHeight);
    const visibleWidth = Math.max(visibleRight - visibleLeft, 0);
    const visibleHeight = Math.max(visibleBottom - visibleTop, 0);

    return {
        textureOffsetX: (visibleLeft - objectX) / objectWidth,
        textureOffsetY: (visibleTop - objectY) / objectHeight,
        textureScaleX: visibleWidth / objectWidth,
        textureScaleY: visibleHeight / objectHeight,
        viewportHeight: visibleHeight * input.targetPixelHeight / input.targetCSSHeight,
        viewportWidth: visibleWidth * input.targetPixelWidth / input.targetCSSWidth,
        viewportX: visibleLeft * input.targetPixelWidth / input.targetCSSWidth,
        viewportY: visibleTop * input.targetPixelHeight / input.targetCSSHeight
    };
}
