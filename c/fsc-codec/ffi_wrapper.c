/**
 * FFI Wrapper — 把 by-value struct 参数转为指针，供 bun:ffi 调用
 * 编译: gcc -O2 -shared -fPIC -o libfsc-ffi.so ffi_wrapper.c fsc_codec.c
 */

#include "fsc_codec.h"

/* encode: 原函数已经是指针参数，直接 re-export */

int ffi_encode_result(const fsc_task_result_t *result, fsc_buf_t *out) {
    return fsc_encode_result(result, out);
}

int ffi_encode_heartbeat(const fsc_heartbeat_t *hb, fsc_buf_t *out) {
    return fsc_encode_heartbeat(hb, out);
}

/* decode: 把 fsc_slice_t by-value 转为指针 */

int ffi_decode_result(const fsc_slice_t *input, fsc_task_result_t *result) {
    return fsc_decode_result(*input, result);
}

int ffi_decode_heartbeat(const fsc_slice_t *input, fsc_heartbeat_t *result) {
    return fsc_decode_heartbeat(*input, result);
}

int ffi_decode_result_b64(const fsc_str_t *b64, fsc_buf_t *scratch, fsc_task_result_t *result) {
    return fsc_decode_result_b64(*b64, scratch, result);
}

/* base64: fsc_slice_t by-value → pointer */

int ffi_to_base64(const fsc_slice_t *input, fsc_buf_t *out) {
    return fsc_to_base64(*input, out);
}

/* utils */

size_t ffi_result_max_size(const fsc_task_result_t *r) {
    return fsc_result_max_encoded_size(r);
}

const char* ffi_version(void) {
    return fsc_codec_version();
}
