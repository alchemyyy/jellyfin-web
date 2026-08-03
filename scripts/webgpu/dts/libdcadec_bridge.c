/*
 * Jellyfin WebGPU bounded libdcadec bridge.
 *
 * This file is GPL-2.0-or-later as part of jellyfin-web. libdcadec remains
 * LGPL-2.1-or-later and is built as a replaceable WebAssembly module.
 */

#include <emscripten.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "dca_context.h"
#include "dca_frame.h"

#define DTS_MAXIMUM_PACKET_SIZE (2U * 1024U * 1024U)

typedef struct {
    struct dcadec_context *decoder;
    uint8_t *packet_buffer;
    size_t packet_capacity;
    int **samples;
    int sample_count;
    int channel_mask;
    int sample_rate;
    int bits_per_sample;
    int profile;
    int parse_status;
    int filter_status;
} JellyfinDTSDecoder;

static void clear_output(JellyfinDTSDecoder *decoder)
{
    decoder->samples = NULL;
    decoder->sample_count = 0;
    decoder->channel_mask = 0;
    decoder->sample_rate = 0;
    decoder->bits_per_sample = 0;
    decoder->profile = DCADEC_PROFILE_UNKNOWN;
    decoder->parse_status = 0;
    decoder->filter_status = 0;
}

EMSCRIPTEN_KEEPALIVE
JellyfinDTSDecoder *jellyfin_dts_create(void)
{
    JellyfinDTSDecoder *decoder = calloc(1, sizeof(*decoder));
    if (!decoder) {
        return NULL;
    }

    decoder->decoder = dcadec_context_create(DCADEC_FLAG_STRICT);
    if (!decoder->decoder) {
        free(decoder);
        return NULL;
    }

    clear_output(decoder);
    return decoder;
}

EMSCRIPTEN_KEEPALIVE
uint8_t *jellyfin_dts_configure_packet(JellyfinDTSDecoder *decoder, size_t size)
{
    if (!decoder || size == 0 || size > DTS_MAXIMUM_PACKET_SIZE) {
        return NULL;
    }

    size_t required_capacity = dcadec_frame_buffer_size(size);
    if (required_capacity < size || required_capacity > DTS_MAXIMUM_PACKET_SIZE + 64U) {
        return NULL;
    }
    if (required_capacity > decoder->packet_capacity) {
        uint8_t *packet_buffer = realloc(decoder->packet_buffer, required_capacity);
        if (!packet_buffer) {
            return NULL;
        }
        decoder->packet_buffer = packet_buffer;
        decoder->packet_capacity = required_capacity;
    }

    memset(decoder->packet_buffer + size, 0, decoder->packet_capacity - size);
    clear_output(decoder);
    return decoder->packet_buffer;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_dts_decode_packet(JellyfinDTSDecoder *decoder, size_t size)
{
    if (!decoder || !decoder->decoder || !decoder->packet_buffer
        || size == 0 || size > DTS_MAXIMUM_PACKET_SIZE) {
        return -DCADEC_EINVAL;
    }

    size_t converted_size = size;
    int bitstream_format = dcadec_frame_convert_bitstream(
        decoder->packet_buffer,
        &converted_size,
        decoder->packet_buffer,
        size
    );
    if (bitstream_format < 0) {
        return bitstream_format;
    }
    if (converted_size == 0 || converted_size > decoder->packet_capacity) {
        return -DCADEC_EOVERFLOW;
    }
    memset(
        decoder->packet_buffer + converted_size,
        0,
        decoder->packet_capacity - converted_size
    );

    decoder->parse_status = dcadec_context_parse(
        decoder->decoder,
        decoder->packet_buffer,
        converted_size
    );
    if (decoder->parse_status < 0) {
        return decoder->parse_status;
    }

    decoder->filter_status = dcadec_context_filter(
        decoder->decoder,
        &decoder->samples,
        &decoder->sample_count,
        &decoder->channel_mask,
        &decoder->sample_rate,
        &decoder->bits_per_sample,
        &decoder->profile
    );
    if (decoder->filter_status < 0) {
        clear_output(decoder);
        return decoder->filter_status;
    }

    return 0;
}

EMSCRIPTEN_KEEPALIVE
int *jellyfin_dts_get_plane(JellyfinDTSDecoder *decoder, int plane)
{
    if (!decoder || !decoder->samples || plane < 0 || plane >= 32) {
        return NULL;
    }
    return decoder->samples[plane];
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_dts_get_sample_count(JellyfinDTSDecoder *decoder)
{
    return decoder ? decoder->sample_count : 0;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_dts_get_channel_mask(JellyfinDTSDecoder *decoder)
{
    return decoder ? decoder->channel_mask : 0;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_dts_get_sample_rate(JellyfinDTSDecoder *decoder)
{
    return decoder ? decoder->sample_rate : 0;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_dts_get_bits_per_sample(JellyfinDTSDecoder *decoder)
{
    return decoder ? decoder->bits_per_sample : 0;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_dts_get_profile(JellyfinDTSDecoder *decoder)
{
    return decoder ? decoder->profile : DCADEC_PROFILE_UNKNOWN;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_dts_get_parse_status(JellyfinDTSDecoder *decoder)
{
    return decoder ? decoder->parse_status : -DCADEC_EINVAL;
}

EMSCRIPTEN_KEEPALIVE
int jellyfin_dts_get_filter_status(JellyfinDTSDecoder *decoder)
{
    return decoder ? decoder->filter_status : -DCADEC_EINVAL;
}

EMSCRIPTEN_KEEPALIVE
void jellyfin_dts_clear(JellyfinDTSDecoder *decoder)
{
    if (!decoder || !decoder->decoder) {
        return;
    }
    dcadec_context_clear(decoder->decoder);
    clear_output(decoder);
}

EMSCRIPTEN_KEEPALIVE
void jellyfin_dts_destroy(JellyfinDTSDecoder *decoder)
{
    if (!decoder) {
        return;
    }
    dcadec_context_destroy(decoder->decoder);
    free(decoder->packet_buffer);
    free(decoder);
}

EMSCRIPTEN_KEEPALIVE
unsigned int jellyfin_dts_library_version(void)
{
    return dcadec_version();
}
