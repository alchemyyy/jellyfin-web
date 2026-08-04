import { describe, expect, it, vi } from 'vitest';

import {
    millisecondsToMicroseconds,
    secondsToMicroseconds
} from '../MediaTime';
import {
    getCustomDecodeHardwareAcceleration,
    isDecodeWorkerRequest,
    isDecodeWorkerResponse,
    MAX_DECODED_AUDIO_SAMPLE_CREDITS,
    MAX_DECODED_AUDIO_SAMPLE_RATE,
    MIN_DECODED_AUDIO_SAMPLE_RATE,
    MAX_DECODED_FRAME_CREDITS,
    MAX_DECODED_RAW_FRAME_CREDITS,
    MAXIMUM_VIDEO_STARTUP_PROGRESS_PACKET_COUNT
} from './DecodeWorkerProtocol';
import {
    DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION,
    MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_COUNT
} from './DolbyVisionEncodedMetadataProtocol';
import {
    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH
} from './DolbyVisionRPUParser';
import { MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH } from './NativeMediaAudioLimits';
import {
    MAXIMUM_COMPOUND_RAW_FRAME_COPY_BYTE_LENGTH,
    MAXIMUM_OUTSTANDING_RAW_FRAME_TRANSFER_COUNT,
    MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH,
    type TransferableRawVideoFrame
} from './RawVideoFrameCopy';
import { createDolbyVisionAuthorizationRPUFixture } from '../validation/DolbyVisionAuthorizationFixture';
import { createHDR10PlusHEVCFixture } from '../validation/HDR10PlusFixture';
import { parseHEVCHDR10PlusMetadata } from './HDR10PlusMetadata';

const DOLBY_VISION_RPU_PARSER_WASM_URL =
    'https://example.test/libraries/libdovi/dovi-rpu-parser.wasm';

function createPackedRPUData(): ArrayBuffer {
    return createDolbyVisionAuthorizationRPUFixture();
}

function createRawFrame(): TransferableRawVideoFrame {
    return {
        bitDepth: 8,
        codedHeight: 2,
        codedWidth: 4,
        colorSpace: {
            fullRange: false,
            matrix: 'bt709',
            primaries: 'bt709',
            transfer: 'bt709'
        },
        data: new ArrayBuffer(1_024),
        displayHeight: 2,
        displayWidth: 4,
        durationMicroseconds: millisecondsToMicroseconds(41.708),
        format: 'I420',
        planes: [
            {
                byteLength: 512,
                byteOffset: 0,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 2,
                kind: 'y',
                rowByteLength: 4,
                width: 4
            },
            {
                byteLength: 256,
                byteOffset: 512,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 1,
                kind: 'u',
                rowByteLength: 2,
                width: 2
            },
            {
                byteLength: 256,
                byteOffset: 768,
                bytesPerComponent: 1,
                bytesPerRow: 256,
                componentsPerTexel: 1,
                height: 1,
                kind: 'v',
                rowByteLength: 2,
                width: 2
            }
        ],
        timestampMicroseconds: secondsToMicroseconds(-0.5),
        visibleRectangle: { height: 2, width: 4, x: 0, y: 0 }
    };
}

function createCompoundRawFrames(): {
    baseFrame: TransferableRawVideoFrame
    enhancementFrame: TransferableRawVideoFrame
} {
    const baseFrame = createRawFrame();
    const enhancementFrame = createRawFrame();
    const data = new ArrayBuffer(2_048);
    baseFrame.data = data;
    enhancementFrame.data = data;
    enhancementFrame.planes = enhancementFrame.planes.map(plane => ({
        ...plane,
        byteOffset: plane.byteOffset + 1_024
    }));
    return { baseFrame, enhancementFrame };
}

describe('DecodeWorkerProtocol', () => {
    it('selects acceleration for native raw output and the bundled HEVC backend', () => {
        expect(getCustomDecodeHardwareAcceleration('raw-planes')).toBe('prefer-software');
        expect(getCustomDecodeHardwareAcceleration('video-frame')).toBe('prefer-hardware');
        expect(getCustomDecodeHardwareAcceleration('video-frame', 'bundled-hevc'))
            .toBe('prefer-software');
        expect(getCustomDecodeHardwareAcceleration('video-frame', 'openjpeg'))
            .toBe('prefer-software');
        expect(getCustomDecodeHardwareAcceleration('video-frame', 'legacy-software'))
            .toBe('prefer-software');
    });

    it('accepts only the SDR VideoFrame shape for legacy software video', () => {
        const request = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'legacy-software',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;

        expect(isDecodeWorkerRequest(request)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...request,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...request,
            dolbyVisionProfile: 8
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...request,
            nativeHDRTransfer: 'pq'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...request,
            neutralizeHDRColorMetadata: true
        })).toBe(false);
    });

    it('accepts only the SDR VideoFrame shape for OpenJPEG', () => {
        const request = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 540,
            maximumCodedWidth: 960,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mj2',
            videoDecoderBackend: 'openjpeg',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;

        expect(isDecodeWorkerRequest(request)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...request,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...request,
            dolbyVisionProfile: 8
        })).toBe(false);
    });

    it('accepts integer-microsecond start and frame messages', () => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: -1_000_000,
            type: 'start',
            url: 'http://localhost/video.mp4',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        })).toBe(true);

        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            frame: { close: vi.fn() },
            generation: 1,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'video-frame',
            type: 'frame'
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            buffer: new ArrayBuffer(1_024),
            generation: 2,
            type: 'recycle-frame'
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            buffer: new ArrayBuffer(0),
            generation: 2,
            type: 'recycle-frame'
        })).toBe(false);
    });

    it('accepts bounded owned-video startup progress', () => {
        expect(isDecodeWorkerResponse({
            generation: 2,
            mediaTimeMicroseconds: 2_733_022_000,
            packetCount: 0,
            phase: 'video-key-packet-ready',
            type: 'progress'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            generation: 2,
            mediaTimeMicroseconds: 2_733_063_708,
            packetCount: 1,
            phase: 'video-packet-started',
            type: 'progress'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            generation: 2,
            mediaTimeMicroseconds: 0.5,
            packetCount: 1,
            phase: 'video-packet-decoded',
            type: 'progress'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            generation: 2,
            mediaTimeMicroseconds: null,
            packetCount: MAXIMUM_VIDEO_STARTUP_PROGRESS_PACKET_COUNT + 1,
            phase: 'video-packet-decoded',
            type: 'progress'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            generation: 2,
            mediaTimeMicroseconds: null,
            packetCount: 1,
            phase: 'video-demuxing',
            type: 'progress'
        })).toBe(false);
    });

    it('accepts a bounded raw-plane frame descriptor and two-credit start', () => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: 7,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 2,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: -500_000,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            frame: createRawFrame(),
            generation: 2,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(true);
    });

    it('accepts only supported Dolby Vision profile values', () => {
        const baseRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 2,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        } as const;
        const supportedProfiles: readonly unknown[] = [ null, 5, 7, 8 ];
        const unsupportedProfiles: readonly unknown[] = [ undefined, 0, 6, '7' ];

        for (const supportedProfile of supportedProfiles) {
            expect(isDecodeWorkerRequest({
                ...baseRequest,
                dolbyVisionProfile: supportedProfile
            })).toBe(true);
        }
        for (const unsupportedProfile of unsupportedProfiles) {
            expect(isDecodeWorkerRequest({
                ...baseRequest,
                dolbyVisionProfile: unsupportedProfile
            })).toBe(false);
        }
    });

    it('accepts one shared and bounded BL/EL raw-frame ownership unit', () => {
        const { baseFrame, enhancementFrame } = createCompoundRawFrames();

        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            enhancementFrame,
            frame: baseFrame,
            generation: 2,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(true);

        const baseOnlyFrames = createCompoundRawFrames();
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            enhancementFrame: null,
            frame: baseOnlyFrames.baseFrame,
            generation: 2,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(true);
    });

    it('rejects non-atomic or mistimed compound raw frames', () => {
        const separateFrames = createCompoundRawFrames();
        separateFrames.enhancementFrame.data = new ArrayBuffer(2_048);
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            enhancementFrame: separateFrames.enhancementFrame,
            frame: separateFrames.baseFrame,
            generation: 2,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(false);

        const mistimedFrames = createCompoundRawFrames();
        mistimedFrames.enhancementFrame.timestampMicroseconds = secondsToMicroseconds(-0.499998);
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            enhancementFrame: mistimedFrames.enhancementFrame,
            frame: mistimedFrames.baseFrame,
            generation: 2,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(false);

        const undeclaredCompoundFrames = createCompoundRawFrames();
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            frame: undeclaredCompoundFrames.baseFrame,
            generation: 2,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(false);
    });

    it('accepts only versioned and bounded encoded Dolby Vision frame metadata', () => {
        const baseFrame = {
            durationMicroseconds: 41_708,
            frame: { close: vi.fn() },
            generation: 1,
            mediaTimeMicroseconds: 500_000,
            outputMode: 'video-frame',
            type: 'frame'
        } as const;
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerDisposition: 'discarded-mel',
                hasEnhancementLayerVCL: true,
                parsedRPUData: [
                    createDolbyVisionAuthorizationRPUFixture(7, 'mel')
                ],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerDisposition: 'absent',
                hasEnhancementLayerVCL: false,
                parsedRPUData: [ createPackedRPUData() ],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerDisposition: 'absent',
                hasEnhancementLayerVCL: false,
                parsedRPUData: [],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerDisposition: 'absent',
                hasEnhancementLayerVCL: false,
                parsedRPUData: [ new ArrayBuffer(DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH) ],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerDisposition: 'absent',
                hasEnhancementLayerVCL: false,
                parsedRPUData: Array.from(
                    { length: MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_COUNT + 1 },
                    createPackedRPUData
                ),
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerDisposition: 'absent',
                hasEnhancementLayerVCL: true,
                parsedRPUData: [ createPackedRPUData() ],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(false);
    });

    it('accepts explicit bounded HDR10+ states and rejects malformed metadata', () => {
        const baseFrame = {
            durationMicroseconds: 41_708,
            frame: { close: vi.fn() },
            generation: 1,
            mediaTimeMicroseconds: 500_000,
            outputMode: 'video-frame',
            type: 'frame'
        } as const;
        const validMetadata = parseHEVCHDR10PlusMetadata(
            createHDR10PlusHEVCFixture('valid'),
            { kind: 'annex-b' }
        );
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            HDR10PlusMetadata: validMetadata
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            HDR10PlusMetadata: { metadata: null, status: 'conflicting' }
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            HDR10PlusMetadata: {
                metadata: {
                    ...validMetadata.metadata,
                    averageMaxRGBNits: Number.NaN
                },
                status: 'valid'
            }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            HDR10PlusMetadata: { metadata: validMetadata.metadata, status: 'absent' }
        })).toBe(false);
    });

    it('requires a raw format that matches the selected output mode', () => {
        const baseRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 2,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoTrackIndex: 0
        } as const;
        expect(isDecodeWorkerRequest({
            ...baseRequest,
            rawVideoFrameFormat: 'I420P12',
            videoOutputMode: 'raw-planes'
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            ...baseRequest,
            rawVideoFrameFormat: null,
            videoOutputMode: 'raw-planes'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...baseRequest,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'video-frame'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...baseRequest,
            rawVideoFrameFormat: null,
            videoOutputMode: 'video-frame'
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            ...baseRequest,
            dolbyVisionRPUParserWASMURL: 'https://user:secret@example.test/parser.wasm',
            rawVideoFrameFormat: null,
            videoOutputMode: 'video-frame'
        })).toBe(false);
    });

    it('permits HDR metadata neutralization only for native non-Dolby video frames', () => {
        const nativeFrameRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 3,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: true,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;

        expect(isDecodeWorkerRequest(nativeFrameRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            nativeHDRTransfer: null
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            nativeHDRTransfer: 'sdr'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            nativeHDRTransfer: 'pq',
            neutralizeHDRColorMetadata: false
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            videoDecoderBackend: 'bundled-hevc'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            dolbyVisionProfile: 5
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            rawVideoFrameFormat: 'I420P10',
            videoOutputMode: 'raw-planes'
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeFrameRequest,
            neutralizeHDRColorMetadata: 'true'
        })).toBe(false);
    });

    it('rejects floating-point timestamps and invalid frame credits', () => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            frameCredits: MAX_DECODED_FRAME_CREDITS + 1,
            generation: 1,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mp4',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            frameCredits: 1,
            generation: 1,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0.5,
            type: 'start',
            url: 'http://localhost/video.mp4',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            frame: { close: vi.fn() },
            generation: 1,
            mediaTimeMicroseconds: 0.25,
            outputMode: 'video-frame',
            type: 'frame'
        })).toBe(false);
    });

    it('requires two in-flight raw transfer credits independently of each transfer byte bound', () => {
        expect(MAX_DECODED_RAW_FRAME_CREDITS).toBe(2);
        expect(MAX_DECODED_RAW_FRAME_CREDITS)
            .toBe(MAXIMUM_OUTSTANDING_RAW_FRAME_TRANSFER_COUNT);
        expect(MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH).toBe(128 * 1_024 * 1_024);
        expect(MAXIMUM_COMPOUND_RAW_FRAME_COPY_BYTE_LENGTH)
            .toBe(MAXIMUM_RAW_FRAME_COPY_BYTE_LENGTH);
        expect(
            MAXIMUM_COMPOUND_RAW_FRAME_COPY_BYTE_LENGTH
            * MAX_DECODED_RAW_FRAME_CREDITS
        ).toBe(256 * 1_024 * 1_024);
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS - 1,
            generation: 3,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS + 1,
            generation: 3,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        })).toBe(false);

        const rawFrame = createRawFrame();
        rawFrame.planes[0].bytesPerRow = 4;
        expect(isDecodeWorkerResponse({
            durationMicroseconds: 41_708,
            frame: rawFrame,
            generation: 3,
            mediaTimeMicroseconds: -500_000,
            outputMode: 'raw-planes',
            type: 'frame'
        })).toBe(false);
    });

    it('accepts 8K raw geometry within one transfer budget and rejects an oversized transfer', () => {
        const rawStartRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 4_320,
            maximumCodedWidth: 7_680,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        } as const;

        expect(isDecodeWorkerRequest(rawStartRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...rawStartRequest,
            maximumCodedHeight: 8_640,
            maximumCodedWidth: 15_360
        })).toBe(false);
    });

    it('charges both Profile 7 layers to each compound transfer budget', () => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionProfile: 7,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 4_320,
            maximumCodedWidth: 7_680,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        })).toBe(false);
    });

    it('rejects malformed generations, dimensions, and failures', () => {
        expect(isDecodeWorkerRequest({ generation: 0, type: 'stop' })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: null,
            codec: 'avc1.640028',
            codedHeight: 1080,
            codedWidth: 0,
            displayHeight: 1080,
            displayWidth: 1920,
            generation: 1,
            type: 'ready'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: Number.NaN,
            codedWidth: 7_680,
            displayHeight: 2_160,
            displayWidth: 3_840,
            generation: 1,
            type: 'ready'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 4_320,
            codedWidth: 7_680,
            displayHeight: 2_160,
            displayWidth: 3_840,
            generation: 1,
            type: 'ready'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            failureKind: 'unknown',
            generation: 1,
            message: 'failed',
            type: 'error'
        })).toBe(false);
    });

    it('validates bounded optional static HDR metadata', () => {
        const staticHDRMetadata = {
            masteringDisplayMaximumLuminanceNits: 4_000,
            masteringDisplayMinimumLuminanceNits: 0.005,
            maximumContentLightLevelNits: 500,
            maximumFrameAverageLightLevelNits: 200
        };
        const readyResponse = {
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 2_160,
            codedWidth: 3_840,
            displayHeight: 2_160,
            displayWidth: 3_840,
            generation: 1,
            staticHDRMetadataScan: {
                accessUnitCount: 16,
                firstMetadataAccessUnitIndex: 1,
                metadata: staticHDRMetadata,
                status: 'valid'
            },
            type: 'ready'
        };
        expect(isDecodeWorkerResponse(readyResponse)).toBe(true);
        expect(isDecodeWorkerResponse({
            ...readyResponse,
            staticHDRMetadataScan: {
                ...readyResponse.staticHDRMetadataScan,
                metadata: {
                    ...staticHDRMetadata,
                    masteringDisplayMaximumLuminanceNits: 10_001
                }
            }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...readyResponse,
            staticHDRMetadataScan: {
                accessUnitCount: 16,
                firstMetadataAccessUnitIndex: null,
                metadata: staticHDRMetadata,
                status: 'malformed'
            }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...readyResponse,
            staticHDRMetadataScan: {
                accessUnitCount: 16,
                firstMetadataAccessUnitIndex: null,
                metadata: null,
                status: 'conflicting'
            }
        })).toBe(true);
    });

    it('validates bounded planar PCM and independent audio credits', () => {
        const decodedAudioStartRequest = {
            audioSampleCredits: MAX_DECODED_AUDIO_SAMPLE_CREDITS,
            audioTrackIndex: 1,
            decodedAudioOutputChannelCount: 8,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: 1,
            generation: 2,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        } as const;
        expect(isDecodeWorkerRequest(decodedAudioStartRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...decodedAudioStartRequest,
            decodedAudioOutputChannelCount: 7
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 2,
            generation: 2,
            type: 'pull-audio'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            channelCount: 2,
            channelData: [ new Float32Array(1_024), new Float32Array(1_024) ],
            durationMicroseconds: 21_333,
            frameCount: 1_024,
            generation: 2,
            mediaTimeMicroseconds: -21_333,
            sampleRate: 48_000,
            type: 'audio'
        })).toBe(true);

        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: 1,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: 1,
            generation: 2,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        })).toBe(true);
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 1,
            audioTrackIndex: null,
            frameCredits: 1,
            generation: 2,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            channelCount: 2,
            channelData: [ new Float32Array(1_024), new Float32Array(512) ],
            durationMicroseconds: 21_333,
            frameCount: 1_024,
            generation: 2,
            mediaTimeMicroseconds: 0,
            sampleRate: 48_000,
            type: 'audio'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            channelCount: 2,
            channelData: [ new Float32Array(1_024), new Float32Array(1_024) ],
            durationMicroseconds: 5_333,
            frameCount: 1_024,
            generation: 2,
            mediaTimeMicroseconds: 0,
            sampleRate: MAX_DECODED_AUDIO_SAMPLE_RATE + 1,
            type: 'audio'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            channelCount: 2,
            channelData: [ new Float32Array(1_024), new Float32Array(1_024) ],
            durationMicroseconds: 5_333,
            frameCount: 1_024,
            generation: 2,
            mediaTimeMicroseconds: 0,
            sampleRate: MIN_DECODED_AUDIO_SAMPLE_RATE - 1,
            type: 'audio'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: {
                channelCount: 2,
                codec: 'opus',
                sampleRate: MAX_DECODED_AUDIO_SAMPLE_RATE + 1
            },
            codec: 'avc1.640028',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 2,
            type: 'ready'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: {
                channelCount: 2,
                codec: 'opus',
                sampleRate: 48_000,
                sourceSampleRate: MIN_DECODED_AUDIO_SAMPLE_RATE - 1
            },
            codec: 'avc1.640028',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 2,
            type: 'ready'
        })).toBe(false);
    });

    it('validates exact native-media routes and transferred fMP4 segments', () => {
        const nativeStartRequest = {
            audioOutputMode: 'native-media',
            audioSampleCredits: 2,
            audioTrackIndex: 1,
            dolbyVisionProfile: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: 1,
            generation: 4,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
            nativeHDRTransfer: null,
            neutralizeHDRColorMetadata: false,
            rawVideoFrameFormat: null,
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'native',
            videoOutputMode: 'video-frame',
            videoTrackIndex: 0
        };
        expect(isDecodeWorkerRequest(nativeStartRequest)).toBe(true);
        expect(isDecodeWorkerRequest({
            ...nativeStartRequest,
            decodedAudioOutputChannelCount: 6
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeStartRequest,
            audioTrackIndex: null
        })).toBe(false);
        expect(isDecodeWorkerRequest({
            ...nativeStartRequest,
            audioOutputMode: 'unknown'
        })).toBe(false);

        expect(isDecodeWorkerResponse({
            audio: {
                channelCount: 6,
                codec: 'ec-3',
                mimeType: 'audio/mp4; codecs="ec-3"',
                outputMode: 'native-media',
                sampleRate: 48_000
            },
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 4,
            type: 'ready'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            audio: {
                channelCount: 8,
                codec: 'ec-3',
                mimeType: 'audio/mp4; codecs="ec-3"',
                outputMode: 'native-media',
                sampleRate: 48_000
            },
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 1_080,
            codedWidth: 1_920,
            displayHeight: 1_080,
            displayWidth: 1_920,
            generation: 4,
            type: 'ready'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            data: new ArrayBuffer(128),
            generation: 4,
            type: 'native-audio-init'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            data: new ArrayBuffer(128),
            endTimeMicroseconds: 1_500_000,
            generation: 4,
            startTimeMicroseconds: 1_000_000,
            type: 'native-audio-media'
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            data: new ArrayBuffer(MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH + 1),
            endTimeMicroseconds: 1_500_000,
            generation: 4,
            startTimeMicroseconds: 1_000_000,
            type: 'native-audio-media'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            data: new ArrayBuffer(128),
            endTimeMicroseconds: 3_500_000,
            generation: 4,
            startTimeMicroseconds: 1_000_000,
            type: 'native-audio-media'
        })).toBe(false);
    });
});
