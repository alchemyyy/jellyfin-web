/*
 * Focused FFmpeg E-AC-3 decoder bridge for jellyfin-web.
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

typedef struct JellyfinEAC3Decoder {
    AVCodecContext *codec_context;
    AVPacket *packet;
    AVFrame *frame;
} JellyfinEAC3Decoder;

enum JellyfinEAC3Status {
    JELLYFIN_EAC3_FATAL = -1,
    JELLYFIN_EAC3_NO_OUTPUT = 0,
    JELLYFIN_EAC3_OUTPUT_READY = 1
};

EMSCRIPTEN_KEEPALIVE
JellyfinEAC3Decoder *jellyfin_eac3_create(void) {
    const AVCodec *decoder = avcodec_find_decoder(AV_CODEC_ID_EAC3);
    if (decoder == NULL) {
        return NULL;
    }
    av_log_set_level(AV_LOG_QUIET);

    JellyfinEAC3Decoder *context = calloc(1, sizeof(*context));
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
uint8_t *jellyfin_eac3_configure_packet(JellyfinEAC3Decoder *context, int size) {
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
int jellyfin_eac3_send_packet(JellyfinEAC3Decoder *context, double pts) {
    if (context == NULL) {
        return JELLYFIN_EAC3_FATAL;
    }

    context->packet->pts = (int64_t) pts;
    context->packet->dts = (int64_t) pts;
    const int result = avcodec_send_packet(context->codec_context, context->packet);
    av_packet_unref(context->packet);
    if (result == 0) {
        return JELLYFIN_EAC3_OUTPUT_READY;
    }
    if (result == AVERROR_INVALIDDATA) {
        return JELLYFIN_EAC3_NO_OUTPUT;
    }
    return JELLYFIN_EAC3_FATAL;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_eac3_receive_frame(JellyfinEAC3Decoder *context) {
    if (context == NULL) {
        return JELLYFIN_EAC3_FATAL;
    }

    av_frame_unref(context->frame);
    const int result = avcodec_receive_frame(context->codec_context, context->frame);
    if (result == 0) {
        return JELLYFIN_EAC3_OUTPUT_READY;
    }
    if (result == AVERROR(EAGAIN) || result == AVERROR_EOF || result == AVERROR_INVALIDDATA) {
        return JELLYFIN_EAC3_NO_OUTPUT;
    }
    return JELLYFIN_EAC3_FATAL;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *jellyfin_eac3_get_plane(JellyfinEAC3Decoder *context, int plane) {
    if (context == NULL || plane < 0 || plane >= context->frame->ch_layout.nb_channels) {
        return NULL;
    }
    return context->frame->extended_data[plane];
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_eac3_get_sample_format(JellyfinEAC3Decoder *context) {
    return context == NULL ? AV_SAMPLE_FMT_NONE : context->frame->format;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_eac3_get_sample_count(JellyfinEAC3Decoder *context) {
    return context == NULL ? 0 : context->frame->nb_samples;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_eac3_get_channel_count(JellyfinEAC3Decoder *context) {
    return context == NULL ? 0 : context->frame->ch_layout.nb_channels;
}

EMSCRIPTEN_KEEPALIVE
uint32_t jellyfin_eac3_get_channel_mask(JellyfinEAC3Decoder *context) {
    if (context == NULL || context->frame->ch_layout.order != AV_CHANNEL_ORDER_NATIVE) {
        return 0;
    }
    if ((context->frame->ch_layout.u.mask >> 32) != 0) {
        return 0;
    }
    return (uint32_t) context->frame->ch_layout.u.mask;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_eac3_get_sample_rate(JellyfinEAC3Decoder *context) {
    return context == NULL ? 0 : context->frame->sample_rate;
}

EMSCRIPTEN_KEEPALIVE
double jellyfin_eac3_get_pts(JellyfinEAC3Decoder *context) {
    return context == NULL ? (double) AV_NOPTS_VALUE : (double) context->frame->pts;
}

EMSCRIPTEN_KEEPALIVE
void jellyfin_eac3_clear(JellyfinEAC3Decoder *context) {
    if (context == NULL) {
        return;
    }
    av_packet_unref(context->packet);
    av_frame_unref(context->frame);
    avcodec_flush_buffers(context->codec_context);
}

EMSCRIPTEN_KEEPALIVE
void jellyfin_eac3_destroy(JellyfinEAC3Decoder *context) {
    if (context == NULL) {
        return;
    }
    av_frame_free(&context->frame);
    av_packet_free(&context->packet);
    avcodec_free_context(&context->codec_context);
    free(context);
}

EMSCRIPTEN_KEEPALIVE
unsigned jellyfin_eac3_library_version(void) {
    return avcodec_version();
}
