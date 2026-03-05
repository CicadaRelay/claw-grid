/**
 * FSC-Codec — 零拷贝 msgpack 编解码 (C 共享库)
 *
 * 所有语言通过 FFI 调用同一份实现:
 *   - Rust:  extern "C" + link
 *   - Bun:   Bun.FFI
 *   - Mojo:  C interop
 *   - Go:    cgo
 *
 * 设计原则:
 *   1. 零堆分配 — 解码指针直接指向输入缓冲区
 *   2. 编码写入调用者提供的缓冲区
 *   3. 线程安全 — 无全局状态
 */

#ifndef FSC_CODEC_H
#define FSC_CODEC_H

#include <stdint.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/* ============ 基本类型 ============ */

/** 不可变缓冲区引用 (零拷贝) */
typedef struct {
    const uint8_t *data;
    size_t len;
} fsc_slice_t;

/** 可写缓冲区 */
typedef struct {
    uint8_t *data;
    size_t len;      /* 缓冲区总容量 */
    size_t used;     /* 已写入字节数 */
} fsc_buf_t;

/** 字符串切片 (非 NUL 结尾, 指向输入缓冲区) */
typedef struct {
    const char *ptr;
    uint32_t len;
} fsc_str_t;

/** 错误码 */
typedef enum {
    FSC_OK = 0,
    FSC_ERR_INVALID_INPUT = -1,
    FSC_ERR_BUFFER_TOO_SMALL = -2,
    FSC_ERR_MALFORMED_MSGPACK = -3,
    FSC_ERR_MISSING_FIELD = -4,
} fsc_error_t;

/* ============ 任务结果结构 (零拷贝解码) ============ */

typedef struct {
    fsc_str_t task_id;
    fsc_str_t agent_id;
    fsc_str_t status;         /* "success" | "failure" */
    fsc_str_t failure_class;  /* nullable */
    uint32_t  quality_score;
    uint32_t  tokens_used;
    double    cost_usd;
    uint64_t  duration_ms;
    uint64_t  timestamp;
} fsc_task_result_t;

/** 心跳数据 */
typedef struct {
    fsc_str_t agent_id;
    fsc_str_t node_id;
    double    cpu_percent;
    uint64_t  mem_used_mb;
    uint64_t  mem_total_mb;
    uint32_t  active_tasks;
    uint64_t  timestamp;
} fsc_heartbeat_t;

/* ============ 编码 API ============ */

/**
 * 编码 task result 为 msgpack
 * @param result  输入结构体
 * @param out     输出缓冲区 (调用者分配, 推荐 1024 字节)
 * @return FSC_OK 成功, FSC_ERR_BUFFER_TOO_SMALL 需要更大缓冲区
 */
fsc_error_t fsc_encode_result(const fsc_task_result_t *result, fsc_buf_t *out);

/**
 * 编码 heartbeat 为 msgpack
 */
fsc_error_t fsc_encode_heartbeat(const fsc_heartbeat_t *hb, fsc_buf_t *out);

/**
 * 将 msgpack 缓冲区转为 base64 (用于 Redis Stream 写入)
 * @param input   msgpack 数据
 * @param out     base64 输出缓冲区 (需要 input.len * 4/3 + 4 字节)
 */
fsc_error_t fsc_to_base64(fsc_slice_t input, fsc_buf_t *out);

/* ============ 解码 API (零拷贝) ============ */

/**
 * 解码 msgpack 为 task result (零拷贝: 字符串指向输入缓冲区)
 * @param input   msgpack 数据 (必须在 result 使用期间保持有效)
 * @param result  输出结构体
 */
fsc_error_t fsc_decode_result(fsc_slice_t input, fsc_task_result_t *result);

/**
 * 解码 base64 编码的 msgpack (先 base64 解码, 再 msgpack 解码)
 * @param b64     base64 字符串
 * @param scratch 临时缓冲区 (base64 解码后的二进制数据, 调用者分配)
 * @param result  输出结构体
 */
fsc_error_t fsc_decode_result_b64(fsc_str_t b64, fsc_buf_t *scratch, fsc_task_result_t *result);

/**
 * 解码 heartbeat
 */
fsc_error_t fsc_decode_heartbeat(fsc_slice_t input, fsc_heartbeat_t *hb);

/* ============ 工具函数 ============ */

/** 获取编码 task result 需要的最大字节数 */
size_t fsc_result_max_encoded_size(const fsc_task_result_t *result);

/** base64 编码后长度 */
size_t fsc_base64_encoded_size(size_t input_len);

/** 版本字符串 */
const char* fsc_codec_version(void);

#ifdef __cplusplus
}
#endif

#endif /* FSC_CODEC_H */
