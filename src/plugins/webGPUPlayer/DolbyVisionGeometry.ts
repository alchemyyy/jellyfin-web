const DOLBY_VISION_ENHANCEMENT_FULL_RESOLUTION_MAXIMUM_WIDTH = 1_920;

export type DolbyVisionEnhancementDimensions = {
    height: number
    width: number
};

/** Returns the coded EL dimensions required by the supported Profile 7 route. */
export function getDolbyVisionEnhancementDimensions(
    baseLayerWidth: number,
    baseLayerHeight: number
): DolbyVisionEnhancementDimensions {
    const resolutionDivisor = baseLayerWidth
        > DOLBY_VISION_ENHANCEMENT_FULL_RESOLUTION_MAXIMUM_WIDTH ? 2 : 1;
    return {
        height: Math.ceil(baseLayerHeight / resolutionDivisor),
        width: Math.ceil(baseLayerWidth / resolutionDivisor)
    };
}
