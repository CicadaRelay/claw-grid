/**
 * FSC-Codec — 零拷贝 msgpack 编解码实现
 *
 * 内联 msgpack 解析 (无依赖, ~300 行 C)
 * 目标: 单文件编译, 零外部依赖, <50KB .so
 *
 * 编译:
 *   gcc -O2 -shared -fPIC -o libfsc-codec.so fsc_codec.c
 *   # 或 musl 静态链接:
 *   musl-gcc -O2 -shared -fPIC -o libfsc-codec.so fsc_codec.c
 */

#include "fsc_codec.h"
#include <string.h>

#define FSC_CODEC_VERSION "0.1.0"

/* ============ Base64 编解码 (RFC 4648) ============ */

static const char b64_table[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static const uint8_t b64_decode_table[256] = {
    ['A']=0, ['B']=1, ['C']=2, ['D']=3, ['E']=4, ['F']=5, ['G']=6, ['H']=7,
    ['I']=8, ['J']=9, ['K']=10,['L']=11,['M']=12,['N']=13,['O']=14,['P']=15,
    ['Q']=16,['R']=17,['S']=18,['T']=19,['U']=20,['V']=21,['W']=22,['X']=23,
    ['Y']=24,['Z']=25,
    ['a']=26,['b']=27,['c']=28,['d']=29,['e']=30,['f']=31,['g']=32,['h']=33,
    ['i']=34,['j']=35,['k']=36,['l']=37,['m']=38,['n']=39,['o']=40,['p']=41,
    ['q']=42,['r']=43,['s']=44,['t']=45,['u']=46,['v']=47,['w']=48,['x']=49,
    ['y']=50,['z']=51,
    ['0']=52,['1']=53,['2']=54,['3']=55,['4']=56,['5']=57,['6']=58,['7']=59,
    ['8']=60,['9']=61,['+']=62,['/']=63,
};

size_t fsc_base64_encoded_size(size_t input_len) {
    return ((input_len + 2) / 3) * 4;
}

fsc_error_t fsc_to_base64(fsc_slice_t input, fsc_buf_t *out) {
    size_t needed = fsc_base64_encoded_size(input.len);
    if (out->len < needed) return FSC_ERR_BUFFER_TOO_SMALL;

    size_t i = 0, j = 0;
    for (; i + 2 < input.len; i += 3) {
        uint32_t v = ((uint32_t)input.data[i] << 16) |
                     ((uint32_t)input.data[i+1] << 8) |
                     (uint32_t)input.data[i+2];
        out->data[j++] = b64_table[(v >> 18) & 0x3F];
        out->data[j++] = b64_table[(v >> 12) & 0x3F];
        out->data[j++] = b64_table[(v >> 6) & 0x3F];
        out->data[j++] = b64_table[v & 0x3F];
    }
    if (i < input.len) {
        uint32_t v = (uint32_t)input.data[i] << 16;
        if (i + 1 < input.len) v |= (uint32_t)input.data[i+1] << 8;
        out->data[j++] = b64_table[(v >> 18) & 0x3F];
        out->data[j++] = b64_table[(v >> 12) & 0x3F];
        out->data[j++] = (i + 1 < input.len) ? b64_table[(v >> 6) & 0x3F] : '=';
        out->data[j++] = '=';
    }
    out->used = j;
    return FSC_OK;
}

static size_t base64_decode_inplace(const uint8_t *src, size_t src_len, uint8_t *dst) {
    size_t j = 0;
    for (size_t i = 0; i < src_len; ) {
        uint32_t a = (i < src_len && src[i] != '=') ? b64_decode_table[src[i++]] : (i++, 0);
        uint32_t b = (i < src_len && src[i] != '=') ? b64_decode_table[src[i++]] : (i++, 0);
        uint32_t c = (i < src_len && src[i] != '=') ? b64_decode_table[src[i++]] : (i++, 0);
        uint32_t d = (i < src_len && src[i] != '=') ? b64_decode_table[src[i++]] : (i++, 0);
        uint32_t v = (a << 18) | (b << 12) | (c << 6) | d;
        dst[j++] = (v >> 16) & 0xFF;
        if (i >= 3 && src[i-2] != '=') dst[j++] = (v >> 8) & 0xFF;
        if (i >= 4 && src[i-1] != '=') dst[j++] = v & 0xFF;
    }
    return j;
}

/* ============ Msgpack 写入器 (零分配) ============ */

typedef struct {
    uint8_t *buf;
    size_t cap;
    size_t pos;
} mp_writer_t;

static int mp_ensure(mp_writer_t *w, size_t n) {
    return (w->pos + n <= w->cap) ? 0 : -1;
}

static void mp_write_map(mp_writer_t *w, uint32_t count) {
    if (count <= 15) {
        w->buf[w->pos++] = 0x80 | (uint8_t)count;
    } else {
        w->buf[w->pos++] = 0xDE;
        w->buf[w->pos++] = (count >> 8) & 0xFF;
        w->buf[w->pos++] = count & 0xFF;
    }
}

static void mp_write_str(mp_writer_t *w, const char *s, uint32_t len) {
    if (len <= 31) {
        w->buf[w->pos++] = 0xA0 | (uint8_t)len;
    } else if (len <= 255) {
        w->buf[w->pos++] = 0xD9;
        w->buf[w->pos++] = (uint8_t)len;
    } else {
        w->buf[w->pos++] = 0xDA;
        w->buf[w->pos++] = (len >> 8) & 0xFF;
        w->buf[w->pos++] = len & 0xFF;
    }
    memcpy(w->buf + w->pos, s, len);
    w->pos += len;
}

static void mp_write_fsc_str(mp_writer_t *w, fsc_str_t s) {
    mp_write_str(w, s.ptr, s.len);
}

static void mp_write_uint32(mp_writer_t *w, uint32_t v) {
    if (v <= 127) {
        w->buf[w->pos++] = (uint8_t)v;
    } else if (v <= 255) {
        w->buf[w->pos++] = 0xCC;
        w->buf[w->pos++] = (uint8_t)v;
    } else if (v <= 65535) {
        w->buf[w->pos++] = 0xCD;
        w->buf[w->pos++] = (v >> 8) & 0xFF;
        w->buf[w->pos++] = v & 0xFF;
    } else {
        w->buf[w->pos++] = 0xCE;
        w->buf[w->pos++] = (v >> 24) & 0xFF;
        w->buf[w->pos++] = (v >> 16) & 0xFF;
        w->buf[w->pos++] = (v >> 8) & 0xFF;
        w->buf[w->pos++] = v & 0xFF;
    }
}

static void mp_write_uint64(mp_writer_t *w, uint64_t v) {
    if (v <= 0xFFFFFFFF) {
        mp_write_uint32(w, (uint32_t)v);
    } else {
        w->buf[w->pos++] = 0xCF;
        for (int i = 7; i >= 0; i--)
            w->buf[w->pos++] = (v >> (i * 8)) & 0xFF;
    }
}

static void mp_write_double(mp_writer_t *w, double v) {
    w->buf[w->pos++] = 0xCB;
    uint64_t bits;
    memcpy(&bits, &v, 8);
    for (int i = 7; i >= 0; i--)
        w->buf[w->pos++] = (bits >> (i * 8)) & 0xFF;
}

/* ============ Msgpack 读取器 (零拷贝) ============ */

typedef struct {
    const uint8_t *data;
    size_t len;
    size_t pos;
} mp_reader_t;

static int mp_read_map_size(mp_reader_t *r, uint32_t *out) {
    if (r->pos >= r->len) return -1;
    uint8_t b = r->data[r->pos++];
    if ((b & 0xF0) == 0x80) { *out = b & 0x0F; return 0; }
    if (b == 0xDE) {
        if (r->pos + 2 > r->len) return -1;
        *out = ((uint32_t)r->data[r->pos] << 8) | r->data[r->pos+1];
        r->pos += 2;
        return 0;
    }
    return -1;
}

static int mp_read_str(mp_reader_t *r, fsc_str_t *out) {
    if (r->pos >= r->len) return -1;
    uint8_t b = r->data[r->pos++];
    uint32_t len;
    if ((b & 0xE0) == 0xA0) {
        len = b & 0x1F;
    } else if (b == 0xD9) {
        if (r->pos >= r->len) return -1;
        len = r->data[r->pos++];
    } else if (b == 0xDA) {
        if (r->pos + 2 > r->len) return -1;
        len = ((uint32_t)r->data[r->pos] << 8) | r->data[r->pos+1];
        r->pos += 2;
    } else if (b == 0xC0) {
        /* nil → empty string */
        out->ptr = "";
        out->len = 0;
        return 0;
    } else {
        return -1;
    }
    if (r->pos + len > r->len) return -1;
    out->ptr = (const char *)(r->data + r->pos);
    out->len = len;
    r->pos += len;
    return 0;
}

static int mp_read_uint64(mp_reader_t *r, uint64_t *out) {
    if (r->pos >= r->len) return -1;
    uint8_t b = r->data[r->pos++];
    if (b <= 0x7F) { *out = b; return 0; }
    if (b == 0xCC) { *out = r->data[r->pos++]; return 0; }
    if (b == 0xCD) {
        *out = ((uint64_t)r->data[r->pos] << 8) | r->data[r->pos+1];
        r->pos += 2; return 0;
    }
    if (b == 0xCE) {
        *out = ((uint64_t)r->data[r->pos] << 24) | ((uint64_t)r->data[r->pos+1] << 16) |
               ((uint64_t)r->data[r->pos+2] << 8) | r->data[r->pos+3];
        r->pos += 4; return 0;
    }
    if (b == 0xCF) {
        *out = 0;
        for (int i = 0; i < 8; i++) *out = (*out << 8) | r->data[r->pos++];
        return 0;
    }
    return -1;
}

static int mp_read_double(mp_reader_t *r, double *out) {
    if (r->pos >= r->len) return -1;
    uint8_t b = r->data[r->pos++];

    /* Integer types → cast to double */
    if (b <= 0x7F) { *out = (double)b; return 0; }
    if (b == 0xCC) { *out = (double)r->data[r->pos++]; return 0; }
    if (b == 0xCD) {
        *out = (double)(((uint16_t)r->data[r->pos] << 8) | r->data[r->pos+1]);
        r->pos += 2; return 0;
    }

    /* Float32 */
    if (b == 0xCA) {
        uint32_t bits = ((uint32_t)r->data[r->pos] << 24) | ((uint32_t)r->data[r->pos+1] << 16) |
                        ((uint32_t)r->data[r->pos+2] << 8) | r->data[r->pos+3];
        float f; memcpy(&f, &bits, 4);
        *out = (double)f;
        r->pos += 4; return 0;
    }

    /* Float64 */
    if (b == 0xCB) {
        uint64_t bits = 0;
        for (int i = 0; i < 8; i++) bits = (bits << 8) | r->data[r->pos++];
        memcpy(out, &bits, 8);
        return 0;
    }

    return -1;
}

static void mp_skip(mp_reader_t *r) {
    if (r->pos >= r->len) return;
    uint8_t b = r->data[r->pos++];

    /* fixstr */
    if ((b & 0xE0) == 0xA0) { r->pos += (b & 0x1F); return; }
    /* fixmap */
    if ((b & 0xF0) == 0x80) {
        uint32_t n = b & 0x0F;
        for (uint32_t i = 0; i < n * 2; i++) mp_skip(r);
        return;
    }
    /* fixarray */
    if ((b & 0xF0) == 0x90) {
        uint32_t n = b & 0x0F;
        for (uint32_t i = 0; i < n; i++) mp_skip(r);
        return;
    }
    /* positive fixint, nil, false, true */
    if (b <= 0x7F || b == 0xC0 || b == 0xC2 || b == 0xC3) return;
    /* uint8, int8 */ if (b == 0xCC || b == 0xD0) { r->pos += 1; return; }
    /* uint16, int16 */ if (b == 0xCD || b == 0xD1) { r->pos += 2; return; }
    /* uint32, int32, float32 */ if (b == 0xCE || b == 0xD2 || b == 0xCA) { r->pos += 4; return; }
    /* uint64, int64, float64 */ if (b == 0xCF || b == 0xD3 || b == 0xCB) { r->pos += 8; return; }
    /* str8 */ if (b == 0xD9) { r->pos += 1 + r->data[r->pos]; return; }
    /* str16 */ if (b == 0xDA) {
        uint32_t n = ((uint32_t)r->data[r->pos] << 8) | r->data[r->pos+1];
        r->pos += 2 + n; return;
    }
    /* negative fixint */
    if ((b & 0xE0) == 0xE0) return;
}

/* ============ 公开 API 实现 ============ */

size_t fsc_result_max_encoded_size(const fsc_task_result_t *result) {
    /* map header(3) + 9 key-value pairs: key(3+15) + value header(3+9) = ~30 per pair */
    return 3 + 9 * 30 + result->task_id.len + result->agent_id.len +
           result->status.len + result->failure_class.len;
}

fsc_error_t fsc_encode_result(const fsc_task_result_t *result, fsc_buf_t *out) {
    size_t needed = fsc_result_max_encoded_size(result);
    if (out->len < needed) return FSC_ERR_BUFFER_TOO_SMALL;

    mp_writer_t w = { out->data, out->len, 0 };

    uint32_t field_count = 8; /* task_id..timestamp */
    if (result->failure_class.len > 0) field_count++;

    mp_write_map(&w, field_count);

    mp_write_str(&w, "task_id", 7);      mp_write_fsc_str(&w, result->task_id);
    mp_write_str(&w, "agent_id", 8);     mp_write_fsc_str(&w, result->agent_id);
    mp_write_str(&w, "status", 6);       mp_write_fsc_str(&w, result->status);
    mp_write_str(&w, "quality_score", 13); mp_write_uint32(&w, result->quality_score);
    mp_write_str(&w, "tokens_used", 11);   mp_write_uint32(&w, result->tokens_used);
    mp_write_str(&w, "cost_usd", 8);     mp_write_double(&w, result->cost_usd);
    mp_write_str(&w, "duration_ms", 11); mp_write_uint64(&w, result->duration_ms);
    mp_write_str(&w, "timestamp", 9);    mp_write_uint64(&w, result->timestamp);

    if (result->failure_class.len > 0) {
        mp_write_str(&w, "failure_class", 13);
        mp_write_fsc_str(&w, result->failure_class);
    }

    out->used = w.pos;
    return FSC_OK;
}

fsc_error_t fsc_encode_heartbeat(const fsc_heartbeat_t *hb, fsc_buf_t *out) {
    if (out->len < 512) return FSC_ERR_BUFFER_TOO_SMALL;

    mp_writer_t w = { out->data, out->len, 0 };
    mp_write_map(&w, 7);

    mp_write_str(&w, "agent_id", 8);     mp_write_fsc_str(&w, hb->agent_id);
    mp_write_str(&w, "node_id", 7);      mp_write_fsc_str(&w, hb->node_id);
    mp_write_str(&w, "cpu_percent", 11); mp_write_double(&w, hb->cpu_percent);
    mp_write_str(&w, "mem_used_mb", 11); mp_write_uint64(&w, hb->mem_used_mb);
    mp_write_str(&w, "mem_total_mb", 12); mp_write_uint64(&w, hb->mem_total_mb);
    mp_write_str(&w, "active_tasks", 12); mp_write_uint32(&w, hb->active_tasks);
    mp_write_str(&w, "timestamp", 9);    mp_write_uint64(&w, hb->timestamp);

    out->used = w.pos;
    return FSC_OK;
}

fsc_error_t fsc_decode_result(fsc_slice_t input, fsc_task_result_t *result) {
    if (!input.data || input.len == 0) return FSC_ERR_INVALID_INPUT;

    mp_reader_t r = { input.data, input.len, 0 };
    memset(result, 0, sizeof(*result));

    uint32_t map_size;
    if (mp_read_map_size(&r, &map_size) != 0) return FSC_ERR_MALFORMED_MSGPACK;

    for (uint32_t i = 0; i < map_size; i++) {
        fsc_str_t key;
        if (mp_read_str(&r, &key) != 0) return FSC_ERR_MALFORMED_MSGPACK;

        if (key.len == 7 && memcmp(key.ptr, "task_id", 7) == 0) {
            if (mp_read_str(&r, &result->task_id) != 0) return FSC_ERR_MALFORMED_MSGPACK;
        } else if (key.len == 8 && memcmp(key.ptr, "agent_id", 8) == 0) {
            if (mp_read_str(&r, &result->agent_id) != 0) return FSC_ERR_MALFORMED_MSGPACK;
        } else if (key.len == 6 && memcmp(key.ptr, "status", 6) == 0) {
            if (mp_read_str(&r, &result->status) != 0) return FSC_ERR_MALFORMED_MSGPACK;
        } else if (key.len == 13 && memcmp(key.ptr, "quality_score", 13) == 0) {
            uint64_t v; if (mp_read_uint64(&r, &v) != 0) return FSC_ERR_MALFORMED_MSGPACK;
            result->quality_score = (uint32_t)v;
        } else if (key.len == 11 && memcmp(key.ptr, "tokens_used", 11) == 0) {
            uint64_t v; if (mp_read_uint64(&r, &v) != 0) return FSC_ERR_MALFORMED_MSGPACK;
            result->tokens_used = (uint32_t)v;
        } else if (key.len == 8 && memcmp(key.ptr, "cost_usd", 8) == 0) {
            if (mp_read_double(&r, &result->cost_usd) != 0) return FSC_ERR_MALFORMED_MSGPACK;
        } else if (key.len == 11 && memcmp(key.ptr, "duration_ms", 11) == 0) {
            if (mp_read_uint64(&r, &result->duration_ms) != 0) return FSC_ERR_MALFORMED_MSGPACK;
        } else if (key.len == 9 && memcmp(key.ptr, "timestamp", 9) == 0) {
            if (mp_read_uint64(&r, &result->timestamp) != 0) return FSC_ERR_MALFORMED_MSGPACK;
        } else if (key.len == 13 && memcmp(key.ptr, "failure_class", 13) == 0) {
            if (mp_read_str(&r, &result->failure_class) != 0) return FSC_ERR_MALFORMED_MSGPACK;
        } else {
            mp_skip(&r);
        }
    }

    return FSC_OK;
}

fsc_error_t fsc_decode_result_b64(fsc_str_t b64, fsc_buf_t *scratch, fsc_task_result_t *result) {
    if (b64.len == 0) return FSC_ERR_INVALID_INPUT;

    size_t decoded_len = base64_decode_inplace(
        (const uint8_t *)b64.ptr, b64.len, scratch->data);

    fsc_slice_t input = { scratch->data, decoded_len };
    return fsc_decode_result(input, result);
}

fsc_error_t fsc_decode_heartbeat(fsc_slice_t input, fsc_heartbeat_t *hb) {
    if (!input.data || input.len == 0) return FSC_ERR_INVALID_INPUT;

    mp_reader_t r = { input.data, input.len, 0 };
    memset(hb, 0, sizeof(*hb));

    uint32_t map_size;
    if (mp_read_map_size(&r, &map_size) != 0) return FSC_ERR_MALFORMED_MSGPACK;

    for (uint32_t i = 0; i < map_size; i++) {
        fsc_str_t key;
        if (mp_read_str(&r, &key) != 0) return FSC_ERR_MALFORMED_MSGPACK;

        if (key.len == 8 && memcmp(key.ptr, "agent_id", 8) == 0) {
            mp_read_str(&r, &hb->agent_id);
        } else if (key.len == 7 && memcmp(key.ptr, "node_id", 7) == 0) {
            mp_read_str(&r, &hb->node_id);
        } else if (key.len == 11 && memcmp(key.ptr, "cpu_percent", 11) == 0) {
            mp_read_double(&r, &hb->cpu_percent);
        } else if (key.len == 11 && memcmp(key.ptr, "mem_used_mb", 11) == 0) {
            mp_read_uint64(&r, &hb->mem_used_mb);
        } else if (key.len == 12 && memcmp(key.ptr, "mem_total_mb", 12) == 0) {
            mp_read_uint64(&r, &hb->mem_total_mb);
        } else if (key.len == 12 && memcmp(key.ptr, "active_tasks", 12) == 0) {
            uint64_t v; mp_read_uint64(&r, &v); hb->active_tasks = (uint32_t)v;
        } else if (key.len == 9 && memcmp(key.ptr, "timestamp", 9) == 0) {
            mp_read_uint64(&r, &hb->timestamp);
        } else {
            mp_skip(&r);
        }
    }

    return FSC_OK;
}

const char* fsc_codec_version(void) {
    return FSC_CODEC_VERSION;
}
