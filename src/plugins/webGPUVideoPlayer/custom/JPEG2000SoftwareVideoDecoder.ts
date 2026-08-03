import type { EncodedPacket } from 'mediabunny';

import { type Microseconds } from '../MediaTime';
import { type RawVideoFrameGeometry } from './RawVideoFrameCopy';
import { requireMicroseconds } from './TimeMath';

const JPEG2000_DECODER_GLUE_ASSET = 'libraries/openjpeg/openjpeg-decode.js';
const JPEG2000_DECODER_WASM_ASSET = 'libraries/openjpeg/openjpeg-decode.wasm';
const JPEG2000_MAXIMUM_CODED_HEIGHT = 2_160;
const JPEG2000_MAXIMUM_CODED_WIDTH = 3_840;
const JPEG2000_MAXIMUM_COMPRESSED_PACKET_BYTE_LENGTH = 64 * 1024 * 1024;
const JPEG2000_MAXIMUM_DECODED_RGBA_BYTE_LENGTH =
    JPEG2000_MAXIMUM_CODED_WIDTH * JPEG2000_MAXIMUM_CODED_HEIGHT * 4;
const OPENJPEG_COLOR_SPACE_SRGB = 1;
const OPENJPEG_COLOR_SPACE_GRAY = 2;

export type OpenJPEGFrameInfo = {
    bitsPerSample: number
    componentCount: number
    height: number
    isSigned: boolean
    width: number
};

export type OpenJPEGPoint = {
    x: number
    y: number
};

export type OpenJPEGDecoder = {
    decode: () => void
    delete: () => void
    getColorSpace: () => number
    getDecodedBuffer: () => Uint8ClampedArray
    getEncodedBuffer: (byteLength: number) => Uint8Array
    getFrameInfo: () => OpenJPEGFrameInfo
    getImageOffset: () => OpenJPEGPoint
};

export type OpenJPEGModule = {
    J2KDecoder: new() => OpenJPEGDecoder
};

type OpenJPEGModuleOptions = {
    locateFile: (path: string, prefix: string) => string
    print: (...values: unknown[]) => void
    printErr: (...values: unknown[]) => void
};

type OpenJPEGModuleFactory = (
    options: OpenJPEGModuleOptions
) => Promise<OpenJPEGModule>;

type ClassicWorkerGlobal = typeof globalThis & {
    OpenJPEGWASM?: unknown
    importScripts?: (...urls: string[]) => void
    location?: { href?: unknown }
};

export type JPEG2000DecodedImage = {
    codedHeight: number
    codedWidth: number
    rgba: Uint8Array
};

export type JPEG2000SoftwareVideoDecoderDependencies = {
    createModule: (wasmURL: string) => Promise<OpenJPEGModule>
    createVideoFrame: (
        data: AllowSharedBufferSource,
        init: VideoFrameBufferInit
    ) => VideoFrame
    loadDecoderGlue: (url: string) => void
    resolveAssetURL: (path: string) => string
};

function isPositiveSafeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value > 0;
}

function checkedRGBAByteLength(width: number, height: number): number {
    if (
        !isPositiveSafeInteger(width)
        || !isPositiveSafeInteger(height)
        || width > JPEG2000_MAXIMUM_CODED_WIDTH
        || height > JPEG2000_MAXIMUM_CODED_HEIGHT
    ) {
        throw new TypeError('The JPEG 2000 decoded dimensions are unsupported');
    }
    const byteLength = width * height * 4;
    if (
        !Number.isSafeInteger(byteLength)
        || byteLength > JPEG2000_MAXIMUM_DECODED_RGBA_BYTE_LENGTH
    ) {
        throw new TypeError('The JPEG 2000 decoded frame exceeds its allocation bound');
    }
    return byteLength;
}

function requireMatchingGeometry(
    frameInfo: OpenJPEGFrameInfo,
    expectedGeometry: RawVideoFrameGeometry
): void {
    if (
        frameInfo.width !== expectedGeometry.codedWidth
        || frameInfo.height !== expectedGeometry.codedHeight
        || expectedGeometry.displayWidth <= 0
        || expectedGeometry.displayHeight <= 0
    ) {
        throw new TypeError('The JPEG 2000 decoded geometry changed or did not match its track');
    }
}

function copyRGBToRGBA(
    source: Uint8ClampedArray,
    pixelCount: number
): Uint8Array {
    if (source.byteLength !== pixelCount * 3) {
        throw new TypeError('The JPEG 2000 RGB output has an invalid byte length');
    }
    const rgba = new Uint8Array(pixelCount * 4);
    let sourceOffset = 0;
    let destinationOffset = 0;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
        rgba[destinationOffset] = source[sourceOffset];
        rgba[destinationOffset + 1] = source[sourceOffset + 1];
        rgba[destinationOffset + 2] = source[sourceOffset + 2];
        rgba[destinationOffset + 3] = 255;
        sourceOffset += 3;
        destinationOffset += 4;
    }
    return rgba;
}

function copyGrayToRGBA(
    source: Uint8ClampedArray,
    pixelCount: number
): Uint8Array {
    if (source.byteLength !== pixelCount) {
        throw new TypeError('The JPEG 2000 grayscale output has an invalid byte length');
    }
    const rgba = new Uint8Array(pixelCount * 4);
    let destinationOffset = 0;
    for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
        const value = source[pixelIndex];
        rgba[destinationOffset] = value;
        rgba[destinationOffset + 1] = value;
        rgba[destinationOffset + 2] = value;
        rgba[destinationOffset + 3] = 255;
        destinationOffset += 4;
    }
    return rgba;
}

function resolveDefaultAssetURL(path: string): string {
    const workerGlobal = globalThis as ClassicWorkerGlobal;
    const locationHref = workerGlobal.location?.href;
    if (typeof locationHref !== 'string' || locationHref.length === 0) {
        return path;
    }
    return new URL(path, locationHref).href;
}

function loadDefaultDecoderGlue(url: string): void {
    const workerGlobal = globalThis as ClassicWorkerGlobal;
    if (typeof workerGlobal.OpenJPEGWASM === 'function') {
        return;
    }
    if (typeof workerGlobal.importScripts !== 'function') {
        throw new Error('The JPEG 2000 decoder requires a classic Web Worker');
    }
    workerGlobal.importScripts(url);
    if (typeof workerGlobal.OpenJPEGWASM !== 'function') {
        throw new Error('The JPEG 2000 decoder glue did not expose its module factory');
    }
}

async function createDefaultModule(wasmURL: string): Promise<OpenJPEGModule> {
    const workerGlobal = globalThis as ClassicWorkerGlobal;
    const factory = workerGlobal.OpenJPEGWASM as OpenJPEGModuleFactory | undefined;
    if (typeof factory !== 'function') {
        throw new Error('The JPEG 2000 decoder module factory is unavailable');
    }
    return factory({
        locateFile: (): string => wasmURL,
        // OpenJPEG reports every tile through stdout; keep ordinary playback quiet
        print: (): void => undefined,
        printErr: (): void => undefined
    });
}

function createDefaultVideoFrame(
    data: AllowSharedBufferSource,
    init: VideoFrameBufferInit
): VideoFrame {
    // eslint-disable-next-line compat/compat -- Custom decode is capability-gated
    return new VideoFrame(data, init);
}

const DEFAULT_DEPENDENCIES: JPEG2000SoftwareVideoDecoderDependencies = {
    createModule: createDefaultModule,
    createVideoFrame: createDefaultVideoFrame,
    loadDecoderGlue: loadDefaultDecoderGlue,
    resolveAssetURL: resolveDefaultAssetURL
};

/** Calculates a stable FNV-1a fingerprint over an exact decoded RGBA frame. */
export function getJPEG2000RGBAFingerprint(rgba: Uint8Array): number {
    let fingerprint = 2_166_136_261;
    for (const value of rgba) {
        fingerprint ^= value;
        fingerprint = Math.imul(fingerprint, 16_777_619) >>> 0;
    }
    return fingerprint;
}

/** Owns one bounded OpenJPEG decoder and converts qualified 8-bit sRGB output to VideoFrame. */
export default class JPEG2000SoftwareVideoDecoder {
    private closed = false;
    private decoder: OpenJPEGDecoder | null = null;
    private module: OpenJPEGModule | null = null;

    public constructor(
        private readonly dependencies: JPEG2000SoftwareVideoDecoderDependencies =
        DEFAULT_DEPENDENCIES
    ) {}

    /** Loads the pinned OpenJPEG WASM module and creates one reusable decoder. */
    public async init(): Promise<void> {
        if (this.closed) {
            throw new Error('The JPEG 2000 decoder is closed');
        }
        if (this.decoder) {
            throw new Error('The JPEG 2000 decoder is already initialized');
        }
        const glueURL = this.dependencies.resolveAssetURL(JPEG2000_DECODER_GLUE_ASSET);
        const wasmURL = this.dependencies.resolveAssetURL(JPEG2000_DECODER_WASM_ASSET);
        this.dependencies.loadDecoderGlue(glueURL);
        const module = await this.dependencies.createModule(wasmURL);
        if (this.closed) {
            return;
        }
        this.module = module;
        this.decoder = new module.J2KDecoder();
    }

    /** Decodes one independent JPEG 2000 picture into owned, full-range 8-bit RGBA. */
    public decodeToRGBA(
        packetData: Uint8Array,
        expectedGeometry: RawVideoFrameGeometry
    ): JPEG2000DecodedImage {
        const decoder = this.requireDecoder();
        if (
            packetData.byteLength === 0
            || packetData.byteLength > JPEG2000_MAXIMUM_COMPRESSED_PACKET_BYTE_LENGTH
        ) {
            throw new TypeError('The JPEG 2000 packet size is unsupported');
        }
        const encodedBuffer = decoder.getEncodedBuffer(packetData.byteLength);
        if (encodedBuffer.byteLength !== packetData.byteLength) {
            throw new Error('The JPEG 2000 decoder returned an invalid input buffer');
        }
        encodedBuffer.set(packetData);
        decoder.decode();

        const frameInfo = decoder.getFrameInfo();
        requireMatchingGeometry(frameInfo, expectedGeometry);
        const rgbaByteLength = checkedRGBAByteLength(frameInfo.width, frameInfo.height);
        const imageOffset = decoder.getImageOffset();
        if (imageOffset.x !== 0 || imageOffset.y !== 0) {
            throw new TypeError('JPEG 2000 non-zero image origins require an unsupported crop transform');
        }
        if (frameInfo.bitsPerSample !== 8 || frameInfo.isSigned) {
            throw new TypeError('Only unsigned 8-bit JPEG 2000 output is qualified');
        }

        const decodedBuffer = decoder.getDecodedBuffer();
        const pixelCount = rgbaByteLength / 4;
        let rgba: Uint8Array;
        switch (frameInfo.componentCount) {
            case 1:
                if (decoder.getColorSpace() !== OPENJPEG_COLOR_SPACE_GRAY) {
                    throw new TypeError('The JPEG 2000 grayscale color space is ambiguous');
                }
                rgba = copyGrayToRGBA(decodedBuffer, pixelCount);
                break;
            case 3:
                if (decoder.getColorSpace() !== OPENJPEG_COLOR_SPACE_SRGB) {
                    throw new TypeError('Only decoded sRGB JPEG 2000 color is qualified');
                }
                rgba = copyRGBToRGBA(decodedBuffer, pixelCount);
                break;
            default:
                throw new TypeError('The JPEG 2000 component layout is unsupported');
        }
        return {
            codedHeight: frameInfo.height,
            codedWidth: frameInfo.width,
            rgba
        };
    }

    /** Decodes one packet and transfers ownership of a timestamped VideoFrame to the caller. */
    public decode(
        packet: EncodedPacket,
        expectedGeometry: RawVideoFrameGeometry
    ): VideoFrame {
        if (packet.isMetadataOnly) {
            throw new TypeError('The JPEG 2000 decoder cannot decode a metadata-only packet');
        }
        const timestampMicroseconds = requireMicroseconds(
            packet.microsecondTimestamp,
            'JPEG 2000 packet timestamp'
        );
        const durationMicroseconds = requireMicroseconds(
            packet.microsecondDuration,
            'JPEG 2000 packet duration'
        );
        return this.createVideoFrame(
            this.decodeToRGBA(packet.data, expectedGeometry),
            timestampMicroseconds,
            durationMicroseconds,
            expectedGeometry
        );
    }

    /** Creates one full-range sRGB VideoFrame and transfers its ownership to the caller. */
    public createVideoFrame(
        image: JPEG2000DecodedImage,
        timestampMicroseconds: Microseconds,
        durationMicroseconds: Microseconds,
        displayGeometry: RawVideoFrameGeometry
    ): VideoFrame {
        requireMicroseconds(timestampMicroseconds, 'JPEG 2000 frame timestamp');
        requireMicroseconds(durationMicroseconds, 'JPEG 2000 frame duration');
        if (durationMicroseconds < 0) {
            throw new TypeError('The JPEG 2000 frame duration cannot be negative');
        }
        if (
            image.codedWidth !== displayGeometry.codedWidth
            || image.codedHeight !== displayGeometry.codedHeight
        ) {
            throw new TypeError('The JPEG 2000 VideoFrame geometry is inconsistent');
        }
        return this.dependencies.createVideoFrame(image.rgba, {
            codedHeight: image.codedHeight,
            codedWidth: image.codedWidth,
            colorSpace: {
                fullRange: true,
                matrix: 'rgb',
                primaries: 'bt709',
                transfer: 'iec61966-2-1'
            },
            displayHeight: displayGeometry.displayHeight,
            displayWidth: displayGeometry.displayWidth,
            duration: durationMicroseconds,
            format: 'RGBA',
            timestamp: timestampMicroseconds
        });
    }

    /** Releases the Emscripten decoder exactly once. */
    public close(): void {
        if (this.closed) {
            return;
        }
        this.closed = true;
        const decoder = this.decoder;
        this.decoder = null;
        this.module = null;
        decoder?.delete();
    }

    private requireDecoder(): OpenJPEGDecoder {
        if (this.closed) {
            throw new Error('The JPEG 2000 decoder is closed');
        }
        if (!this.decoder || !this.module) {
            throw new Error('The JPEG 2000 decoder is not initialized');
        }
        return this.decoder;
    }
}
