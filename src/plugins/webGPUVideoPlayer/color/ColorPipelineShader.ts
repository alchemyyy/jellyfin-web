import {
    assertValidRenderSettings,
    RENDER_SETTINGS_VERSION,
    type HDRToSDRRenderSettings,
    type RenderSettings
} from '../RenderSettings';
import {
    assertValidInputColorMetadata,
    createPQColorMetadata,
    type InputColorMetadata
} from './ColorMetadata';
import { createDolbyVisionColorTransformWGSL } from './DolbyVisionColorTransform';

function toWGSLFloat(value: number): string {
    if (!Number.isFinite(value)) {
        throw new RangeError('WGSL constants must be finite');
    }

    return value.toFixed(9);
}

function createTransferDecodeWGSL(metadata: InputColorMetadata): string {
    switch (metadata.transfer) {
        case 'pq':
            return `
fn applyPQEOTF(encodedValue: f32) -> f32 {
    let inversePower = pow(clamp(encodedValue, 0.0, 1.0), 1.0 / (2523.0 / 32.0));
    let numerator = max(inversePower - (3424.0 / 4096.0), 0.0);
    let denominator = max((2413.0 / 128.0) - (2392.0 / 128.0) * inversePower, 0.0000001);
    return 10000.0 * pow(numerator / denominator, 1.0 / (2610.0 / 16384.0));
}

fn decodeInputTransfer(encodedRGB: vec3f) -> vec3f {
    return vec3f(
        applyPQEOTF(encodedRGB.r),
        applyPQEOTF(encodedRGB.g),
        applyPQEOTF(encodedRGB.b)
    );
}`;
        case 'sdr':
            return `
fn applySDREOTF(encodedValue: f32) -> f32 {
    if (encodedValue < 0.081) {
        return (encodedValue / 4.5) * ${toWGSLFloat(metadata.sdrReferenceWhiteNits)};
    }
    return pow((encodedValue + 0.099) / 1.099, 1.0 / 0.45)
        * ${toWGSLFloat(metadata.sdrReferenceWhiteNits)};
}

fn decodeInputTransfer(encodedRGB: vec3f) -> vec3f {
    return vec3f(
        applySDREOTF(encodedRGB.r),
        applySDREOTF(encodedRGB.g),
        applySDREOTF(encodedRGB.b)
    );
}`;
        case 'hlg': {
            const redCoefficient = metadata.primaries === 'bt709' ? 0.2126 : 0.2627;
            const greenCoefficient = metadata.primaries === 'bt709' ? 0.7152 : 0.6780;
            const blueCoefficient = metadata.primaries === 'bt709' ? 0.0722 : 0.0593;
            const systemGamma = 1.2
                + (0.42 * Math.log10(metadata.nominalPeakNits / 1_000));
            return `
fn applyHLGInverseOETF(encodedValue: f32) -> f32 {
    let clampedValue = clamp(encodedValue, 0.0, 1.0);
    if (clampedValue <= 0.5) {
        return clampedValue * clampedValue / 3.0;
    }
    let hlgA = 0.178832770;
    let hlgB = 1.0 - 4.0 * hlgA;
    let hlgC = 0.5 - hlgA * log(4.0 * hlgA);
    return (exp((clampedValue - hlgC) / hlgA) + hlgB) / 12.0;
}

fn decodeInputTransfer(encodedRGB: vec3f) -> vec3f {
    let sceneRGB = vec3f(
        applyHLGInverseOETF(encodedRGB.r),
        applyHLGInverseOETF(encodedRGB.g),
        applyHLGInverseOETF(encodedRGB.b)
    );
    let sceneLuminance = max(dot(
        sceneRGB,
        vec3f(
            ${toWGSLFloat(redCoefficient)},
            ${toWGSLFloat(greenCoefficient)},
            ${toWGSLFloat(blueCoefficient)}
        )
    ), 0.0);
    if (sceneLuminance == 0.0) {
        return vec3f(0.0);
    }
    let luminanceScale = ${toWGSLFloat(metadata.nominalPeakNits)}
        * pow(sceneLuminance, ${toWGSLFloat(systemGamma - 1)});
    return sceneRGB * luminanceScale;
}`;
        }
    }
}

function createGamutConversionWGSL(metadata: InputColorMetadata): string {
    if (metadata.primaries === 'bt709') {
        return `
fn convertToBT709(linearRGB: vec3f) -> vec3f {
    return linearRGB;
}`;
    }

    return `
fn convertToBT709(linearRGB: vec3f) -> vec3f {
    return vec3f(
        1.660491 * linearRGB.r - 0.587641 * linearRGB.g - 0.072850 * linearRGB.b,
        -0.124550 * linearRGB.r + 1.132900 * linearRGB.g - 0.008349 * linearRGB.b,
        -0.018151 * linearRGB.r - 0.100579 * linearRGB.g + 1.118730 * linearRGB.b
    );
}`;
}

function createToneMapWGSL(settings: RenderSettings): string {
    if (settings.mode === 'identity-sdr') {
        return `
fn processColor(encodedRGB: vec3f, pixelCoordinate: vec2f) -> vec3f {
    return encodedRGB;
}`;
    }

    return `
fn evaluateToneMapCurve(normalizedLuminance: f32) -> f32 {
    let value = max(normalizedLuminance, 0.0);
    if (renderSettings.toneMapOperator == 0u) {
        return clamp(
        (value * (2.51 * value + 0.03)) / (value * (2.43 * value + 0.59) + 0.14),
        0.0,
        1.0
        );
    }
    return value / (1.0 + value);
}

fn encodeSRGB(linearValue: f32) -> f32 {
    if (linearValue <= 0.0031308) {
        return 12.92 * linearValue;
    }
    return 1.055 * pow(linearValue, 1.0 / 2.4) - 0.055;
}

fn encodeOutputComponent(componentNits: f32) -> f32 {
    let linearValue = clamp(
        componentNits / renderSettings.outputPeakNits,
        0.0,
        1.0
    );
    return encodeSRGB(linearValue);
}

fn toneMapToSDR(linearBT709Nits: vec3f) -> vec3f {
    let exposedRGB = max(
        linearBT709Nits * pow(2.0, renderSettings.exposure),
        vec3f(0.0)
    );
    let inputLuminance = dot(exposedRGB, vec3f(0.2126, 0.7152, 0.0722));
    if (inputLuminance <= 0.0) {
        return vec3f(0.0);
    }
    let peakCurveValue = evaluateToneMapCurve(
        renderSettings.inputPeakNits / renderSettings.paperWhiteNits
    );
    let inputCurveValue = evaluateToneMapCurve(
        inputLuminance / renderSettings.paperWhiteNits
    );
    let mappedLuminance = renderSettings.outputPeakNits
        * clamp(inputCurveValue / peakCurveValue, 0.0, 1.0);
    let mappedRGB = exposedRGB * (mappedLuminance / inputLuminance);
    let highlightAmount = renderSettings.desaturationStrength * clamp(
        (inputLuminance - renderSettings.paperWhiteNits)
            / max(
                renderSettings.inputPeakNits - renderSettings.paperWhiteNits,
                0.000001
            ),
        0.0,
        1.0
    );
    return clamp(
        mappedRGB + (vec3f(mappedLuminance) - mappedRGB) * highlightAmount,
        vec3f(0.0),
        vec3f(renderSettings.outputPeakNits)
    );
}

fn applyDisplayControls(encodedRGB: vec3f) -> vec3f {
    let luminance = dot(encodedRGB, vec3f(0.2126, 0.7152, 0.0722));
    let saturatedRGB = vec3f(luminance)
        + (encodedRGB - vec3f(luminance)) * renderSettings.saturation;
    let contrastedRGB = (saturatedRGB - vec3f(0.5)) * renderSettings.contrast
        + vec3f(0.5);
    return clamp(
        contrastedRGB + vec3f(renderSettings.brightness),
        vec3f(0.0),
        vec3f(1.0)
    );
}

fn applyOutputDither(encodedRGB: vec3f, pixelCoordinate: vec2f) -> vec3f {
    let noise = fract(
        52.9829189 * fract(dot(pixelCoordinate, vec2f(0.06711056, 0.00583715)))
    ) - 0.5;
    return clamp(encodedRGB + vec3f(noise / 255.0), vec3f(0.0), vec3f(1.0));
}

fn processColor(encodedRGB: vec3f, pixelCoordinate: vec2f) -> vec3f {
    if (renderSettings.version != ${RENDER_SETTINGS_VERSION}u) {
        return vec3f(0.0);
    }
    let linearInputNits = decodeInputTransfer(encodedRGB);
    let linearBT709Nits = convertToBT709(linearInputNits);
    let toneMappedNits = toneMapToSDR(linearBT709Nits);
    let encodedOutputRGB = vec3f(
        encodeOutputComponent(toneMappedNits.r),
        encodeOutputComponent(toneMappedNits.g),
        encodeOutputComponent(toneMappedNits.b)
    );
    return applyOutputDither(
        applyDisplayControls(encodedOutputRGB),
        pixelCoordinate
    );
}`;
}

export type RawYUVVideoFrameFormat = 'I420' | 'I420P10' | 'I420P12' | 'NV12';
export type RawDolbyVisionVideoFrameFormat = Extract<
    RawYUVVideoFrameFormat,
    'I420P10' | 'I420P12'
>;

const DOLBY_VISION_OUTPUT_METADATA = createPQColorMetadata({ range: 'full' });

function createRenderSettingsUniformWGSL(
    settings: RenderSettings,
    binding = 3
): string {
    if (settings.mode === 'identity-sdr') {
        return '';
    }

    return `
struct RenderSettingsUniforms {
    version: u32,
    toneMapOperator: u32,
    outputTransfer: u32,
    reserved: u32,
    desaturationStrength: f32,
    exposure: f32,
    inputPeakNits: f32,
    outputPeakNits: f32,
    paperWhiteNits: f32,
    brightness: f32,
    contrast: f32,
    saturation: f32,
}

@group(0) @binding(${binding}) var<uniform> renderSettings: RenderSettingsUniforms;
`;
}

function getRawFormatBitDepth(format: RawYUVVideoFrameFormat): number {
    switch (format) {
        case 'I420':
        case 'NV12':
            return 8;
        case 'I420P10':
            return 10;
        case 'I420P12':
            return 12;
    }
}

function createRawYUVRangeWGSL(metadata: InputColorMetadata): string {
    const codeScale = 2 ** (metadata.bitDepth - 8);
    const maximumCode = (2 ** metadata.bitDepth) - 1;
    if (metadata.range === 'full') {
        return `
fn normalizeRawYUV(rawYUV: vec3f) -> vec3f {
    return vec3f(
        rawYUV.x / ${toWGSLFloat(maximumCode)},
        (rawYUV.y - ${toWGSLFloat(128 * codeScale)}) / ${toWGSLFloat(maximumCode)},
        (rawYUV.z - ${toWGSLFloat(128 * codeScale)}) / ${toWGSLFloat(maximumCode)}
    );
}`;
    }

    return `
fn normalizeRawYUV(rawYUV: vec3f) -> vec3f {
    return vec3f(
        (rawYUV.x - ${toWGSLFloat(16 * codeScale)}) / ${toWGSLFloat(219 * codeScale)},
        (rawYUV.y - ${toWGSLFloat(128 * codeScale)}) / ${toWGSLFloat(224 * codeScale)},
        (rawYUV.z - ${toWGSLFloat(128 * codeScale)}) / ${toWGSLFloat(224 * codeScale)}
    );
}`;
}

function createRawYUVMatrixWGSL(metadata: InputColorMetadata): string {
    switch (metadata.matrix) {
        case 'bt709':
            return `
fn convertRawYUVToEncodedRGB(normalizedYUV: vec3f) -> vec3f {
    return vec3f(
        normalizedYUV.x + 1.5748 * normalizedYUV.z,
        normalizedYUV.x - 0.187324 * normalizedYUV.y - 0.468124 * normalizedYUV.z,
        normalizedYUV.x + 1.8556 * normalizedYUV.y
    );
}`;
        case 'bt2020-ncl':
            return `
fn convertRawYUVToEncodedRGB(normalizedYUV: vec3f) -> vec3f {
    return vec3f(
        normalizedYUV.x + 1.4746 * normalizedYUV.z,
        normalizedYUV.x - 0.164553 * normalizedYUV.y - 0.571353 * normalizedYUV.z,
        normalizedYUV.x + 1.8814 * normalizedYUV.y
    );
}`;
    }
}

function createRawYUVTextureBindingsWGSL(format: RawYUVVideoFrameFormat): string {
    if (format === 'NV12') {
        return `
@group(0) @binding(1) var lumaTexture: texture_2d<u32>;
@group(0) @binding(2) var chromaTexture: texture_2d<u32>;

fn sampleLuma(textureCoordinate: vec2f) -> f32 {
    let dimensions = vec2f(textureDimensions(lumaTexture));
    let samplePosition = textureCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = vec2i(textureDimensions(lumaTexture)) - vec2i(1);
    let topLeft = f32(textureLoad(lumaTexture, clamp(basePosition, vec2i(0), maximumPosition), 0).r);
    let topRight = f32(textureLoad(lumaTexture, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition), 0).r);
    let bottomLeft = f32(textureLoad(lumaTexture, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition), 0).r);
    let bottomRight = f32(textureLoad(lumaTexture, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition), 0).r);
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}

fn sampleChroma(textureCoordinate: vec2f) -> vec2f {
    let dimensions = vec2f(textureDimensions(chromaTexture));
    let samplePosition = textureCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = vec2i(textureDimensions(chromaTexture)) - vec2i(1);
    let topLeft = vec2f(textureLoad(chromaTexture, clamp(basePosition, vec2i(0), maximumPosition), 0).rg);
    let topRight = vec2f(textureLoad(chromaTexture, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition), 0).rg);
    let bottomLeft = vec2f(textureLoad(chromaTexture, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition), 0).rg);
    let bottomRight = vec2f(textureLoad(chromaTexture, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition), 0).rg);
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}

fn sampleRawYUV(textureCoordinate: vec2f) -> vec3f {
    let chroma = sampleChroma(textureCoordinate);
    return vec3f(sampleLuma(textureCoordinate), chroma.x, chroma.y);
}`;
    }

    return `
@group(0) @binding(1) var lumaTexture: texture_2d<u32>;
@group(0) @binding(2) var chromaUTexture: texture_2d<u32>;
@group(0) @binding(3) var chromaVTexture: texture_2d<u32>;

fn sampleLuma(textureCoordinate: vec2f) -> f32 {
    let dimensions = vec2f(textureDimensions(lumaTexture));
    let samplePosition = textureCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = vec2i(textureDimensions(lumaTexture)) - vec2i(1);
    let topLeft = f32(textureLoad(lumaTexture, clamp(basePosition, vec2i(0), maximumPosition), 0).r);
    let topRight = f32(textureLoad(lumaTexture, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition), 0).r);
    let bottomLeft = f32(textureLoad(lumaTexture, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition), 0).r);
    let bottomRight = f32(textureLoad(lumaTexture, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition), 0).r);
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}

fn sampleChromaU(textureCoordinate: vec2f) -> f32 {
    let dimensions = vec2f(textureDimensions(chromaUTexture));
    let samplePosition = textureCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = vec2i(textureDimensions(chromaUTexture)) - vec2i(1);
    let topLeft = f32(textureLoad(chromaUTexture, clamp(basePosition, vec2i(0), maximumPosition), 0).r);
    let topRight = f32(textureLoad(chromaUTexture, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition), 0).r);
    let bottomLeft = f32(textureLoad(chromaUTexture, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition), 0).r);
    let bottomRight = f32(textureLoad(chromaUTexture, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition), 0).r);
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}

fn sampleChromaV(textureCoordinate: vec2f) -> f32 {
    let dimensions = vec2f(textureDimensions(chromaVTexture));
    let samplePosition = textureCoordinate * dimensions - vec2f(0.5);
    let basePosition = vec2i(floor(samplePosition));
    let fraction = fract(samplePosition);
    let maximumPosition = vec2i(textureDimensions(chromaVTexture)) - vec2i(1);
    let topLeft = f32(textureLoad(chromaVTexture, clamp(basePosition, vec2i(0), maximumPosition), 0).r);
    let topRight = f32(textureLoad(chromaVTexture, clamp(basePosition + vec2i(1, 0), vec2i(0), maximumPosition), 0).r);
    let bottomLeft = f32(textureLoad(chromaVTexture, clamp(basePosition + vec2i(0, 1), vec2i(0), maximumPosition), 0).r);
    let bottomRight = f32(textureLoad(chromaVTexture, clamp(basePosition + vec2i(1), vec2i(0), maximumPosition), 0).r);
    return mix(mix(topLeft, topRight, fraction.x), mix(bottomLeft, bottomRight, fraction.x), fraction.y);
}

fn sampleRawYUV(textureCoordinate: vec2f) -> vec3f {
    return vec3f(
        sampleLuma(textureCoordinate),
        sampleChromaU(textureCoordinate),
        sampleChromaV(textureCoordinate)
    );
}`;
}

/** Generates a complete external-texture shader with the reference color stages. */
export function createColorPipelineWGSL(
    metadata: InputColorMetadata,
    settings: RenderSettings
): string {
    assertValidInputColorMetadata(metadata);
    assertValidRenderSettings(settings);

    return /* wgsl */ `
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) textureCoordinate: vec2f,
}

struct PresentationUniforms {
    textureScale: vec2f,
    textureOffset: vec2f,
}

@group(0) @binding(0) var videoSampler: sampler;
@group(0) @binding(1) var videoTexture: texture_external;
@group(0) @binding(2) var<uniform> presentation: PresentationUniforms;
${createRenderSettingsUniformWGSL(settings)}

// texture_external sampling has already converted any underlying YUV planes to RGB
${createTransferDecodeWGSL(metadata)}
${createGamutConversionWGSL(metadata)}
${createToneMapWGSL(settings)}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    let positions = array<vec2f, 6>(
        vec2f(-1.0, 1.0),
        vec2f(1.0, 1.0),
        vec2f(-1.0, -1.0),
        vec2f(-1.0, -1.0),
        vec2f(1.0, 1.0),
        vec2f(1.0, -1.0),
    );
    let textureCoordinates = array<vec2f, 6>(
        vec2f(0.0, 0.0),
        vec2f(1.0, 0.0),
        vec2f(0.0, 1.0),
        vec2f(0.0, 1.0),
        vec2f(1.0, 0.0),
        vec2f(1.0, 1.0),
    );

    var output: VertexOutput;
    output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
    output.textureCoordinate = textureCoordinates[vertexIndex];
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    let textureCoordinate = input.textureCoordinate * presentation.textureScale
        + presentation.textureOffset;
    let encodedRGB = textureSampleBaseClampToEdge(
        videoTexture,
        videoSampler,
        textureCoordinate
    ).rgb;
    return vec4f(processColor(encodedRGB, input.position.xy), 1.0);
}
`;
}

/** Generates a manual YUV sampling shader for copyable custom-decoder frames. */
export function createRawYUVColorPipelineWGSL(
    metadata: InputColorMetadata,
    settings: HDRToSDRRenderSettings,
    format: RawYUVVideoFrameFormat
): string {
    assertValidInputColorMetadata(metadata);
    assertValidRenderSettings(settings);
    if (metadata.bitDepth !== getRawFormatBitDepth(format)) {
        throw new RangeError('Raw frame format bit depth does not match color metadata');
    }

    const renderSettingsBinding = format === 'NV12' ? 3 : 4;
    return /* wgsl */ `
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) textureCoordinate: vec2f,
}

struct PresentationUniforms {
    textureScale: vec2f,
    textureOffset: vec2f,
}

@group(0) @binding(0) var<uniform> presentation: PresentationUniforms;
${createRawYUVTextureBindingsWGSL(format)}
${createRenderSettingsUniformWGSL(settings, renderSettingsBinding)}
${createRawYUVRangeWGSL(metadata)}
${createRawYUVMatrixWGSL(metadata)}
${createTransferDecodeWGSL(metadata)}
${createGamutConversionWGSL(metadata)}
${createToneMapWGSL(settings)}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    let positions = array<vec2f, 6>(
        vec2f(-1.0, 1.0),
        vec2f(1.0, 1.0),
        vec2f(-1.0, -1.0),
        vec2f(-1.0, -1.0),
        vec2f(1.0, 1.0),
        vec2f(1.0, -1.0),
    );
    let textureCoordinates = array<vec2f, 6>(
        vec2f(0.0, 0.0),
        vec2f(1.0, 0.0),
        vec2f(0.0, 1.0),
        vec2f(0.0, 1.0),
        vec2f(1.0, 0.0),
        vec2f(1.0, 1.0),
    );

    var output: VertexOutput;
    output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
    output.textureCoordinate = textureCoordinates[vertexIndex];
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    let textureCoordinate = input.textureCoordinate * presentation.textureScale
        + presentation.textureOffset;
    let normalizedYUV = normalizeRawYUV(sampleRawYUV(textureCoordinate));
    let encodedRGB = convertRawYUVToEncodedRGB(normalizedYUV);
    return vec4f(processColor(encodedRGB, input.position.xy), 1.0);
}
`;
}

/** Generates Profile 5 reconstruction from Chromium's opaque BT.709 texture. */
export function createExternalDolbyVisionColorPipelineWGSL(
    settings: HDRToSDRRenderSettings
): string {
    assertValidRenderSettings(settings);

    return /* wgsl */ `
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) textureCoordinate: vec2f,
}

struct PresentationUniforms {
    textureScale: vec2f,
    textureOffset: vec2f,
}

@group(0) @binding(0) var videoSampler: sampler;
@group(0) @binding(1) var videoTexture: texture_external;
@group(0) @binding(2) var<uniform> presentation: PresentationUniforms;
${createRenderSettingsUniformWGSL(settings, 3)}
${createDolbyVisionColorTransformWGSL(4)}
${createTransferDecodeWGSL(DOLBY_VISION_OUTPUT_METADATA)}
${createGamutConversionWGSL(DOLBY_VISION_OUTPUT_METADATA)}
${createToneMapWGSL(settings)}

fn recoverDolbyVisionBaseSignal(encodedBT709RGB: vec3f) -> vec3f {
    let normalizedLuma = dot(encodedBT709RGB, vec3f(0.2126, 0.7152, 0.0722));
    let normalizedChromaBlue = (encodedBT709RGB.b - normalizedLuma) / 1.8556;
    let normalizedChromaRed = (encodedBT709RGB.r - normalizedLuma) / 1.5748;
    return vec3f(
        (normalizedLuma * 876.0) + 64.0,
        (normalizedChromaBlue * 896.0) + 512.0,
        (normalizedChromaRed * 896.0) + 512.0
    );
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    let positions = array<vec2f, 6>(
        vec2f(-1.0, 1.0),
        vec2f(1.0, 1.0),
        vec2f(-1.0, -1.0),
        vec2f(-1.0, -1.0),
        vec2f(1.0, 1.0),
        vec2f(1.0, -1.0),
    );
    let textureCoordinates = array<vec2f, 6>(
        vec2f(0.0, 0.0),
        vec2f(1.0, 0.0),
        vec2f(0.0, 1.0),
        vec2f(0.0, 1.0),
        vec2f(1.0, 0.0),
        vec2f(1.0, 1.0),
    );

    var output: VertexOutput;
    output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
    output.textureCoordinate = textureCoordinates[vertexIndex];
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    let textureCoordinate = input.textureCoordinate * presentation.textureScale
        + presentation.textureOffset;
    let encodedBT709RGB = textureSampleBaseClampToEdge(
        videoTexture,
        videoSampler,
        textureCoordinate
    ).rgb;
    let encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(
        recoverDolbyVisionBaseSignal(encodedBT709RGB)
    );
    return vec4f(processColor(encodedBT2020PQ, input.position.xy), 1.0);
}
`;
}

/** Generates the per-frame RPU reconstruction and HDR-to-SDR presentation shader. */
export function createRawDolbyVisionColorPipelineWGSL(
    settings: HDRToSDRRenderSettings,
    format: RawDolbyVisionVideoFrameFormat
): string {
    assertValidRenderSettings(settings);

    return /* wgsl */ `
struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) textureCoordinate: vec2f,
}

struct PresentationUniforms {
    textureScale: vec2f,
    textureOffset: vec2f,
}

@group(0) @binding(0) var<uniform> presentation: PresentationUniforms;
${createRawYUVTextureBindingsWGSL(format)}
${createRenderSettingsUniformWGSL(settings, 4)}
${createDolbyVisionColorTransformWGSL(5)}
${createTransferDecodeWGSL(DOLBY_VISION_OUTPUT_METADATA)}
${createGamutConversionWGSL(DOLBY_VISION_OUTPUT_METADATA)}
${createToneMapWGSL(settings)}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    let positions = array<vec2f, 6>(
        vec2f(-1.0, 1.0),
        vec2f(1.0, 1.0),
        vec2f(-1.0, -1.0),
        vec2f(-1.0, -1.0),
        vec2f(1.0, 1.0),
        vec2f(1.0, -1.0),
    );
    let textureCoordinates = array<vec2f, 6>(
        vec2f(0.0, 0.0),
        vec2f(1.0, 0.0),
        vec2f(0.0, 1.0),
        vec2f(0.0, 1.0),
        vec2f(1.0, 0.0),
        vec2f(1.0, 1.0),
    );

    var output: VertexOutput;
    output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
    output.textureCoordinate = textureCoordinates[vertexIndex];
    return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    let textureCoordinate = input.textureCoordinate * presentation.textureScale
        + presentation.textureOffset;
    let encodedBT2020PQ = reconstructDolbyVisionBT2020PQ(
        sampleRawYUV(textureCoordinate)
    );
    return vec4f(processColor(encodedBT2020PQ, input.position.xy), 1.0);
}
`;
}
