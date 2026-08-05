/*
 * Focused FFmpeg decoder bridge for progressive MPEG-2 Video and VC-1.
 *
 * This file is part of jellyfin-web and is licensed under GPL-2.0-or-later.
 */

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>

#include "libavcodec/avcodec.h"
#include "libavutil/avutil.h"
#include "libavutil/frame.h"
#include "libavutil/mem.h"
#include "libavutil/pixfmt.h"

#define LEGACY_VIDEO_CODEC_MPEG2VIDEO 1
#define LEGACY_VIDEO_CODEC_VC1 2
#define MAXIMUM_EXTRADATA_SIZE (1024 * 1024)

typedef struct LegacyVideoDecoderContext {
    AVCodecContext *codec_context;
    AVPacket *packet;
    AVFrame *frame;
    int opened;
    int draining;
} LegacyVideoDecoderContext;

static void free_decoder(LegacyVideoDecoderContext *decoder) {
    if (!decoder) {
        return;
    }

    av_frame_free(&decoder->frame);
    av_packet_free(&decoder->packet);
    avcodec_free_context(&decoder->codec_context);
    free(decoder);
}

EMSCRIPTEN_KEEPALIVE
LegacyVideoDecoderContext *legacy_video_decoder_create(
    int codec_selector,
    int coded_width,
    int coded_height,
    int extradata_size
) {
    if (
        coded_width <= 0
        || coded_height <= 0
        || extradata_size < 0
        || extradata_size > MAXIMUM_EXTRADATA_SIZE
    ) {
        return NULL;
    }

    enum AVCodecID codec_id;
    switch (codec_selector) {
        case LEGACY_VIDEO_CODEC_MPEG2VIDEO:
            if (extradata_size != 0) {
                return NULL;
            }
            codec_id = AV_CODEC_ID_MPEG2VIDEO;
            break;
        case LEGACY_VIDEO_CODEC_VC1:
            if (extradata_size == 0) {
                return NULL;
            }
            codec_id = AV_CODEC_ID_VC1;
            break;
        default:
            return NULL;
    }

    const AVCodec *codec = avcodec_find_decoder(codec_id);
    if (!codec) {
        return NULL;
    }

    LegacyVideoDecoderContext *decoder = calloc(1, sizeof(LegacyVideoDecoderContext));
    if (!decoder) {
        return NULL;
    }

    decoder->codec_context = avcodec_alloc_context3(codec);
    decoder->packet = av_packet_alloc();
    decoder->frame = av_frame_alloc();
    if (!decoder->codec_context || !decoder->packet || !decoder->frame) {
        free_decoder(decoder);
        return NULL;
    }

    decoder->codec_context->width = coded_width;
    decoder->codec_context->height = coded_height;
    decoder->codec_context->coded_width = coded_width;
    decoder->codec_context->coded_height = coded_height;
    decoder->codec_context->pkt_timebase = (AVRational) { 1, 1000000 };
    decoder->codec_context->thread_count = 1;
    if (extradata_size > 0) {
        decoder->codec_context->extradata = av_mallocz(
            extradata_size + AV_INPUT_BUFFER_PADDING_SIZE
        );
        if (!decoder->codec_context->extradata) {
            free_decoder(decoder);
            return NULL;
        }
        decoder->codec_context->extradata_size = extradata_size;
    }

    return decoder;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *legacy_video_decoder_get_extradata(
    LegacyVideoDecoderContext *decoder
) {
    if (!decoder || !decoder->codec_context || decoder->opened) {
        return NULL;
    }
    return decoder->codec_context->extradata;
}

EMSCRIPTEN_KEEPALIVE
int legacy_video_decoder_open(LegacyVideoDecoderContext *decoder) {
    if (!decoder || !decoder->codec_context || decoder->opened) {
        return AVERROR(EINVAL);
    }

    int result = avcodec_open2(decoder->codec_context, decoder->codec_context->codec, NULL);
    if (result >= 0) {
        decoder->opened = 1;
    }
    return result;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *legacy_video_decoder_configure_packet(
    LegacyVideoDecoderContext *decoder,
    int packet_size
) {
    if (!decoder || !decoder->opened || decoder->draining || packet_size <= 0) {
        return NULL;
    }

    av_packet_unref(decoder->packet);
    if (av_new_packet(decoder->packet, packet_size) < 0) {
        return NULL;
    }
    return decoder->packet->data;
}

EMSCRIPTEN_KEEPALIVE
int legacy_video_decoder_send_packet(
    LegacyVideoDecoderContext *decoder,
    int64_t presentation_timestamp,
    int64_t decode_timestamp,
    int64_t duration,
    int key_frame
) {
    if (!decoder || !decoder->opened || decoder->draining) {
        return AVERROR(EINVAL);
    }

    decoder->packet->pts = presentation_timestamp;
    decoder->packet->dts = decode_timestamp;
    decoder->packet->duration = duration;
    if (key_frame) {
        decoder->packet->flags |= AV_PKT_FLAG_KEY;
    }

    int result = avcodec_send_packet(decoder->codec_context, decoder->packet);
    av_packet_unref(decoder->packet);
    return result;
}

EMSCRIPTEN_KEEPALIVE
int legacy_video_decoder_start_drain(LegacyVideoDecoderContext *decoder) {
    if (!decoder || !decoder->opened) {
        return AVERROR(EINVAL);
    }
    if (decoder->draining) {
        return 0;
    }

    int result = avcodec_send_packet(decoder->codec_context, NULL);
    if (result >= 0 || result == AVERROR_EOF) {
        decoder->draining = 1;
    }
    return result;
}

EMSCRIPTEN_KEEPALIVE
int legacy_video_decoder_receive_frame(LegacyVideoDecoderContext *decoder) {
    if (!decoder || !decoder->opened) {
        return AVERROR(EINVAL);
    }

    av_frame_unref(decoder->frame);
    return avcodec_receive_frame(decoder->codec_context, decoder->frame);
}

EMSCRIPTEN_KEEPALIVE
int legacy_video_decoder_frame_is_i420(LegacyVideoDecoderContext *decoder) {
    if (!decoder || !decoder->frame) {
        return 0;
    }
    return decoder->frame->format == AV_PIX_FMT_YUV420P
        || decoder->frame->format == AV_PIX_FMT_YUVJ420P;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *legacy_video_decoder_get_plane(
    LegacyVideoDecoderContext *decoder,
    int plane
) {
    if (!decoder || !decoder->frame || plane < 0 || plane > 2) {
        return NULL;
    }
    return decoder->frame->data[plane];
}

EMSCRIPTEN_KEEPALIVE
int legacy_video_decoder_get_stride(
    LegacyVideoDecoderContext *decoder,
    int plane
) {
    if (!decoder || !decoder->frame || plane < 0 || plane > 2) {
        return 0;
    }
    return decoder->frame->linesize[plane];
}

#define DEFINE_FRAME_INTEGER_GETTER(name, expression) \
    EMSCRIPTEN_KEEPALIVE \
    int name(LegacyVideoDecoderContext *decoder) { \
        return decoder && decoder->frame ? (expression) : 0; \
    }

DEFINE_FRAME_INTEGER_GETTER(legacy_video_decoder_get_width, decoder->frame->width)
DEFINE_FRAME_INTEGER_GETTER(legacy_video_decoder_get_height, decoder->frame->height)
DEFINE_FRAME_INTEGER_GETTER(legacy_video_decoder_get_crop_left, decoder->frame->crop_left)
DEFINE_FRAME_INTEGER_GETTER(legacy_video_decoder_get_crop_top, decoder->frame->crop_top)
DEFINE_FRAME_INTEGER_GETTER(legacy_video_decoder_get_crop_right, decoder->frame->crop_right)
DEFINE_FRAME_INTEGER_GETTER(legacy_video_decoder_get_crop_bottom, decoder->frame->crop_bottom)
DEFINE_FRAME_INTEGER_GETTER(legacy_video_decoder_get_color_primaries, decoder->frame->color_primaries)
DEFINE_FRAME_INTEGER_GETTER(legacy_video_decoder_get_color_transfer, decoder->frame->color_trc)
DEFINE_FRAME_INTEGER_GETTER(legacy_video_decoder_get_color_matrix, decoder->frame->colorspace)
DEFINE_FRAME_INTEGER_GETTER(legacy_video_decoder_get_color_range, decoder->frame->color_range)
DEFINE_FRAME_INTEGER_GETTER(
    legacy_video_decoder_get_interlaced,
    (decoder->frame->flags & AV_FRAME_FLAG_INTERLACED) != 0
)
DEFINE_FRAME_INTEGER_GETTER(
    legacy_video_decoder_get_top_field_first,
    (decoder->frame->flags & AV_FRAME_FLAG_TOP_FIELD_FIRST) != 0
)
DEFINE_FRAME_INTEGER_GETTER(legacy_video_decoder_get_repeat_picture, decoder->frame->repeat_pict)

EMSCRIPTEN_KEEPALIVE
int64_t legacy_video_decoder_get_timestamp(
    LegacyVideoDecoderContext *decoder
) {
    if (!decoder || !decoder->frame) {
        return AV_NOPTS_VALUE;
    }
    return decoder->frame->best_effort_timestamp;
}

EMSCRIPTEN_KEEPALIVE
int64_t legacy_video_decoder_get_duration(
    LegacyVideoDecoderContext *decoder
) {
    if (!decoder || !decoder->frame) {
        return 0;
    }
    return decoder->frame->duration;
}

EMSCRIPTEN_KEEPALIVE
int legacy_video_decoder_error_again(void) {
    return AVERROR(EAGAIN);
}

EMSCRIPTEN_KEEPALIVE
int legacy_video_decoder_error_eof(void) {
    return AVERROR_EOF;
}

EMSCRIPTEN_KEEPALIVE
void legacy_video_decoder_close(LegacyVideoDecoderContext *decoder) {
    free_decoder(decoder);
}
