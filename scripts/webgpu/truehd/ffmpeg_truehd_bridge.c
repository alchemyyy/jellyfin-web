/*
 * Focused FFmpeg TrueHD/MLP decoder bridge for jellyfin-web.
 *
 * This file is part of jellyfin-web and is licensed under GPL-2.0-or-later.
 */

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>

#include "libavcodec/avcodec.h"
#include "libavutil/channel_layout.h"
#include "libavutil/error.h"
#include "libavutil/log.h"
#include "libavutil/samplefmt.h"

typedef struct JellyfinTrueHDDecoder {
    AVCodecContext *codec_context;
    AVPacket *packet;
    AVFrame *frame;
} JellyfinTrueHDDecoder;

enum JellyfinTrueHDCodec {
    JELLYFIN_MLP_CODEC = 0,
    JELLYFIN_TRUEHD_CODEC = 1
};

enum JellyfinTrueHDStatus {
    JELLYFIN_TRUEHD_FATAL = -1,
    JELLYFIN_TRUEHD_NO_OUTPUT = 0,
    JELLYFIN_TRUEHD_OUTPUT_READY = 1
};

static enum AVCodecID get_codec_id(int codec) {
    switch (codec) {
        case JELLYFIN_MLP_CODEC:
            return AV_CODEC_ID_MLP;
        case JELLYFIN_TRUEHD_CODEC:
            return AV_CODEC_ID_TRUEHD;
        default:
            return AV_CODEC_ID_NONE;
    }
}

EMSCRIPTEN_KEEPALIVE
JellyfinTrueHDDecoder *jellyfin_truehd_create(int codec) {
    const enum AVCodecID codec_id = get_codec_id(codec);
    if (codec_id == AV_CODEC_ID_NONE) {
        return NULL;
    }

    const AVCodec *decoder = avcodec_find_decoder(codec_id);
    if (decoder == NULL) {
        return NULL;
    }
    av_log_set_level(AV_LOG_QUIET);

    JellyfinTrueHDDecoder *context = calloc(1, sizeof(*context));
    if (context == NULL) {
        return NULL;
    }

    context->codec_context = avcodec_alloc_context3(decoder);
    context->packet = av_packet_alloc();
    context->frame = av_frame_alloc();
    if (context->codec_context == NULL || context->packet == NULL || context->frame == NULL) {
        av_frame_free(&context->frame);
        av_packet_free(&context->packet);
        avcodec_free_context(&context->codec_context);
        free(context);
        return NULL;
    }

    context->codec_context->pkt_timebase = (AVRational) { 1, 1000000 };
    if (avcodec_open2(context->codec_context, decoder, NULL) < 0) {
        av_frame_free(&context->frame);
        av_packet_free(&context->packet);
        avcodec_free_context(&context->codec_context);
        free(context);
        return NULL;
    }

    return context;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *jellyfin_truehd_configure_packet(JellyfinTrueHDDecoder *context, int size) {
    if (context == NULL || size <= 0) {
        return NULL;
    }
    av_packet_unref(context->packet);
    if (av_new_packet(context->packet, size) < 0) {
        return NULL;
    }
    return context->packet->data;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_truehd_send_packet(JellyfinTrueHDDecoder *context, double pts) {
    if (context == NULL) {
        return JELLYFIN_TRUEHD_FATAL;
    }

    context->packet->pts = (int64_t) pts;
    context->packet->dts = (int64_t) pts;
    const int result = avcodec_send_packet(context->codec_context, context->packet);
    av_packet_unref(context->packet);
    if (result == 0) {
        return JELLYFIN_TRUEHD_OUTPUT_READY;
    }
    if (result == AVERROR_INVALIDDATA) {
        return JELLYFIN_TRUEHD_NO_OUTPUT;
    }
    return JELLYFIN_TRUEHD_FATAL;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_truehd_receive_frame(JellyfinTrueHDDecoder *context) {
    if (context == NULL) {
        return JELLYFIN_TRUEHD_FATAL;
    }

    av_frame_unref(context->frame);
    const int result = avcodec_receive_frame(context->codec_context, context->frame);
    if (result == 0) {
        return JELLYFIN_TRUEHD_OUTPUT_READY;
    }
    if (result == AVERROR(EAGAIN) || result == AVERROR_EOF || result == AVERROR_INVALIDDATA) {
        return JELLYFIN_TRUEHD_NO_OUTPUT;
    }
    return JELLYFIN_TRUEHD_FATAL;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *jellyfin_truehd_get_interleaved_data(JellyfinTrueHDDecoder *context) {
    if (context == NULL || context->frame == NULL) {
        return NULL;
    }
    return context->frame->data[0];
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_truehd_get_sample_format(JellyfinTrueHDDecoder *context) {
    return context == NULL ? AV_SAMPLE_FMT_NONE : context->frame->format;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_truehd_get_bytes_per_sample(JellyfinTrueHDDecoder *context) {
    if (context == NULL) {
        return 0;
    }
    return av_get_bytes_per_sample(context->frame->format);
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_truehd_get_sample_count(JellyfinTrueHDDecoder *context) {
    return context == NULL ? 0 : context->frame->nb_samples;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_truehd_get_channel_count(JellyfinTrueHDDecoder *context) {
    return context == NULL ? 0 : context->frame->ch_layout.nb_channels;
}

EMSCRIPTEN_KEEPALIVE
uint32_t jellyfin_truehd_get_channel_mask(JellyfinTrueHDDecoder *context) {
    if (context == NULL || context->frame->ch_layout.order != AV_CHANNEL_ORDER_NATIVE) {
        return 0;
    }
    return (uint32_t) context->frame->ch_layout.u.mask;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_truehd_get_sample_rate(JellyfinTrueHDDecoder *context) {
    return context == NULL ? 0 : context->frame->sample_rate;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_truehd_get_bits_per_raw_sample(JellyfinTrueHDDecoder *context) {
    return context == NULL ? 0 : context->codec_context->bits_per_raw_sample;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_truehd_get_profile(JellyfinTrueHDDecoder *context) {
    return context == NULL ? AV_PROFILE_UNKNOWN : context->codec_context->profile;
}

EMSCRIPTEN_KEEPALIVE
double jellyfin_truehd_get_pts(JellyfinTrueHDDecoder *context) {
    return context == NULL ? (double) AV_NOPTS_VALUE : (double) context->frame->pts;
}

EMSCRIPTEN_KEEPALIVE
void jellyfin_truehd_clear(JellyfinTrueHDDecoder *context) {
    if (context == NULL) {
        return;
    }
    av_packet_unref(context->packet);
    av_frame_unref(context->frame);
    avcodec_flush_buffers(context->codec_context);
}

EMSCRIPTEN_KEEPALIVE
void jellyfin_truehd_destroy(JellyfinTrueHDDecoder *context) {
    if (context == NULL) {
        return;
    }
    av_frame_free(&context->frame);
    av_packet_free(&context->packet);
    avcodec_free_context(&context->codec_context);
    free(context);
}

EMSCRIPTEN_KEEPALIVE
unsigned jellyfin_truehd_library_version(void) {
    return avcodec_version();
}
