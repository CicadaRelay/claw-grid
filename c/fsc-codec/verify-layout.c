/**
 * 打印 struct 内存布局 — 用于验证 FFI 绑定的偏移量
 */
#include "fsc_codec.h"
#include <stdio.h>
#include <stddef.h>

#define SHOW(type, field) \
    printf("  %-20s offset=%3zu  size=%3zu\n", #field, offsetof(type, field), sizeof(((type*)0)->field))

int main(void) {
    printf("sizeof(fsc_str_t) = %zu\n", sizeof(fsc_str_t));
    printf("sizeof(fsc_slice_t) = %zu\n", sizeof(fsc_slice_t));
    printf("sizeof(fsc_buf_t) = %zu\n", sizeof(fsc_buf_t));

    printf("\nfsc_task_result_t (size=%zu):\n", sizeof(fsc_task_result_t));
    SHOW(fsc_task_result_t, task_id);
    SHOW(fsc_task_result_t, agent_id);
    SHOW(fsc_task_result_t, status);
    SHOW(fsc_task_result_t, failure_class);
    SHOW(fsc_task_result_t, quality_score);
    SHOW(fsc_task_result_t, tokens_used);
    SHOW(fsc_task_result_t, cost_usd);
    SHOW(fsc_task_result_t, duration_ms);
    SHOW(fsc_task_result_t, timestamp);

    printf("\nfsc_heartbeat_t (size=%zu):\n", sizeof(fsc_heartbeat_t));
    SHOW(fsc_heartbeat_t, agent_id);
    SHOW(fsc_heartbeat_t, node_id);
    SHOW(fsc_heartbeat_t, cpu_percent);
    SHOW(fsc_heartbeat_t, mem_used_mb);
    SHOW(fsc_heartbeat_t, mem_total_mb);
    SHOW(fsc_heartbeat_t, active_tasks);
    SHOW(fsc_heartbeat_t, timestamp);

    return 0;
}
