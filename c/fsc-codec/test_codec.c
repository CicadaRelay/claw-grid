/**
 * FSC-Codec 测试 — 编码 → 解码 往返验证
 */

#include "fsc_codec.h"
#include <stdio.h>
#include <string.h>
#include <assert.h>

#define STR(s) ((fsc_str_t){s, (uint32_t)strlen(s)})

static void test_roundtrip_result(void) {
    printf("  test_roundtrip_result... ");

    fsc_task_result_t input = {
        .task_id = STR("task-001"),
        .agent_id = STR("agent-epyc-sv-01"),
        .status = STR("success"),
        .failure_class = {0},
        .quality_score = 85,
        .tokens_used = 2048,
        .cost_usd = 0.0032,
        .duration_ms = 4500,
        .timestamp = 1741123456789ULL,
    };

    /* 编码 */
    uint8_t buf[2048];
    fsc_buf_t out = { buf, sizeof(buf), 0 };
    fsc_error_t err = fsc_encode_result(&input, &out);
    assert(err == FSC_OK);
    assert(out.used > 0);
    printf("encoded %zu bytes, ", out.used);

    /* 解码 */
    fsc_task_result_t decoded;
    fsc_slice_t slice = { buf, out.used };
    err = fsc_decode_result(slice, &decoded);
    assert(err == FSC_OK);

    /* 验证 */
    assert(decoded.task_id.len == 8 && memcmp(decoded.task_id.ptr, "task-001", 8) == 0);
    assert(decoded.agent_id.len == 16 && memcmp(decoded.agent_id.ptr, "agent-epyc-sv-01", 16) == 0);
    assert(decoded.status.len == 7 && memcmp(decoded.status.ptr, "success", 7) == 0);
    assert(decoded.quality_score == 85);
    assert(decoded.tokens_used == 2048);
    assert(decoded.duration_ms == 4500);
    assert(decoded.timestamp == 1741123456789ULL);
    /* double 精度检查 */
    assert(decoded.cost_usd > 0.003199 && decoded.cost_usd < 0.003201);

    printf("OK\n");
}

static void test_base64_roundtrip(void) {
    printf("  test_base64_roundtrip... ");

    /* 先编码一个 result */
    fsc_task_result_t input = {
        .task_id = STR("t-42"),
        .agent_id = STR("a-1"),
        .status = STR("failure"),
        .failure_class = STR("RESOURCE"),
        .quality_score = 30,
        .tokens_used = 500,
        .cost_usd = 0.001,
        .duration_ms = 1200,
        .timestamp = 1741100000000ULL,
    };

    uint8_t msgpack_buf[2048];
    fsc_buf_t mp_out = { msgpack_buf, sizeof(msgpack_buf), 0 };
    assert(fsc_encode_result(&input, &mp_out) == FSC_OK);

    /* msgpack → base64 */
    uint8_t b64_buf[4096];
    fsc_buf_t b64_out = { b64_buf, sizeof(b64_buf), 0 };
    fsc_slice_t mp_slice = { msgpack_buf, mp_out.used };
    assert(fsc_to_base64(mp_slice, &b64_out) == FSC_OK);
    printf("b64 %zu bytes, ", b64_out.used);

    /* base64 → decode */
    uint8_t scratch[2048];
    fsc_buf_t scratch_buf = { scratch, sizeof(scratch), 0 };
    fsc_str_t b64_str = { (const char *)b64_buf, (uint32_t)b64_out.used };
    fsc_task_result_t decoded;
    assert(fsc_decode_result_b64(b64_str, &scratch_buf, &decoded) == FSC_OK);

    assert(decoded.quality_score == 30);
    assert(decoded.failure_class.len == 8 && memcmp(decoded.failure_class.ptr, "RESOURCE", 8) == 0);

    printf("OK\n");
}

static void test_heartbeat(void) {
    printf("  test_heartbeat... ");

    fsc_heartbeat_t hb = {
        .agent_id = STR("worker-sv-01"),
        .node_id = STR("10.10.0.2"),
        .cpu_percent = 45.7,
        .mem_used_mb = 1536,
        .mem_total_mb = 8192,
        .active_tasks = 8,
        .timestamp = 1741123456789ULL,
    };

    uint8_t buf[1024];
    fsc_buf_t out = { buf, sizeof(buf), 0 };
    assert(fsc_encode_heartbeat(&hb, &out) == FSC_OK);

    fsc_heartbeat_t decoded;
    fsc_slice_t slice = { buf, out.used };
    assert(fsc_decode_heartbeat(slice, &decoded) == FSC_OK);

    assert(decoded.agent_id.len == 12);
    assert(decoded.mem_used_mb == 1536);
    assert(decoded.active_tasks == 8);

    printf("OK\n");
}

static void test_version(void) {
    printf("  test_version... %s OK\n", fsc_codec_version());
}

int main(void) {
    printf("FSC-Codec Tests:\n");
    test_roundtrip_result();
    test_base64_roundtrip();
    test_heartbeat();
    test_version();
    printf("\nAll tests passed!\n");
    return 0;
}
