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
    MAX_DECODED_FRAME_CREDITS,
    MAX_DECODED_RAW_FRAME_CREDITS
} from './DecodeWorkerProtocol';
import {
    DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION,
    MAXIMUM_DOLBY_VISION_RPU_NAL_UNIT_COUNT
} from './DolbyVisionEncodedMetadataProtocol';
import {
    DOLBY_VISION_RPU_PARSER_REVISION_PREFIX,
    DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH,
    DOLBY_VISION_RPU_SCHEMA_MAGIC,
    DOLBY_VISION_RPU_SCHEMA_VERSION
} from './DolbyVisionRPUParser';
import { MAXIMUM_NATIVE_AUDIO_SEGMENT_BYTE_LENGTH } from './NativeMediaAudioLimits';
import type { TransferableRawVideoFrame } from './RawVideoFrameCopy';

const DOLBY_VISION_RPU_PARSER_WASM_URL =
    'https://example.test/libraries/libdovi/dovi-rpu-parser.wasm';

function createPackedRPUData(): ArrayBuffer {
    const data = new ArrayBuffer(DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH);
    const view = new DataView(data);
    view.setUint32(0, DOLBY_VISION_RPU_SCHEMA_MAGIC, true);
    view.setUint32(4, DOLBY_VISION_RPU_SCHEMA_VERSION, true);
    view.setUint32(8, DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH, true);
    view.setUint32(16, DOLBY_VISION_RPU_PARSER_REVISION_PREFIX, true);
    return data;
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

describe('DecodeWorkerProtocol', () => {
    it('selects acceleration for native raw output and the bundled HEVC backend', () => {
        expect(getCustomDecodeHardwareAcceleration('raw-planes')).toBe('prefer-software');
        expect(getCustomDecodeHardwareAcceleration('video-frame')).toBe('prefer-hardware');
        expect(getCustomDecodeHardwareAcceleration('video-frame', 'bundled-hevc'))
            .toBe('prefer-software');
    });

    it('accepts integer-microsecond start and frame messages', () => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
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

    it('accepts a bounded raw-plane frame descriptor and two-credit start', () => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 2,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
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
                enhancementLayerData: new ArrayBuffer(32),
                hasEnhancementLayerVCL: true,
                parsedRPUData: [ createPackedRPUData() ],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerData: null,
                hasEnhancementLayerVCL: false,
                parsedRPUData: [ createPackedRPUData() ],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(true);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerData: null,
                hasEnhancementLayerVCL: false,
                parsedRPUData: [],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerData: null,
                hasEnhancementLayerVCL: false,
                parsedRPUData: [ new ArrayBuffer(DOLBY_VISION_RPU_SCHEMA_BYTE_LENGTH) ],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            ...baseFrame,
            encodedDolbyVisionMetadata: {
                enhancementLayerData: null,
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
                enhancementLayerData: null,
                hasEnhancementLayerVCL: true,
                parsedRPUData: [ createPackedRPUData() ],
                schemaVersion: DOLBY_VISION_ENCODED_METADATA_SCHEMA_VERSION
            }
        })).toBe(false);
    });

    it('requires a raw format that matches the selected output mode', () => {
        const baseRequest = {
            audioSampleCredits: 0,
            audioTrackIndex: null,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 2,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_840,
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

    it('requires the exact raw buffer-pool credit count and bounded layouts', () => {
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
        expect(isDecodeWorkerRequest({
            audioSampleCredits: 0,
            audioTrackIndex: null,
            frameCredits: MAX_DECODED_RAW_FRAME_CREDITS,
            generation: 1,
            maximumCodedHeight: 2_160,
            maximumCodedWidth: 3_841,
            rawVideoFrameFormat: 'I420P10',
            startTimeMicroseconds: 0,
            type: 'start',
            url: 'http://localhost/video.mkv',
            videoDecoderBackend: 'bundled-hevc',
            videoOutputMode: 'raw-planes',
            videoTrackIndex: 0
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 2_161,
            codedWidth: 3_840,
            displayHeight: 2_160,
            displayWidth: 3_840,
            generation: 1,
            type: 'ready'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            audio: null,
            codec: 'hvc1.2.4.L153.B0',
            codedHeight: 2_160,
            codedWidth: 3_840,
            displayHeight: 2_160,
            displayWidth: 3_841,
            generation: 1,
            type: 'ready'
        })).toBe(false);
        expect(isDecodeWorkerResponse({
            failureKind: 'unknown',
            generation: 1,
            message: 'failed',
            type: 'error'
        })).toBe(false);
    });

    it('validates bounded planar PCM and independent audio credits', () => {
        expect(isDecodeWorkerRequest({
            audioSampleCredits: MAX_DECODED_AUDIO_SAMPLE_CREDITS,
            audioTrackIndex: 1,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
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
        })).toBe(true);
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
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
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
    });

    it('validates exact native-media routes and transferred fMP4 segments', () => {
        const nativeStartRequest = {
            audioOutputMode: 'native-media',
            audioSampleCredits: 2,
            audioTrackIndex: 1,
            dolbyVisionRPUParserWASMURL: DOLBY_VISION_RPU_PARSER_WASM_URL,
            frameCredits: 1,
            generation: 4,
            maximumCodedHeight: 1_080,
            maximumCodedWidth: 1_920,
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
