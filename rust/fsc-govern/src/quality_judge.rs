//! Quality Judge — Layer 1+2 纯计算
//!
//! Layer 1 (自动化检查) 和 Layer 2 (结构分析) 的计算逻辑在 Rust 中执行，
//! 不依赖 Redis，纯 CPU 运算。

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct QualityScore {
    pub layer1: u32,
    pub layer2: u32,
    pub layer3_estimate: u32,
    pub total: u32,
    pub decision: String,
}

/// 快速质量评估 (Layer 1 + Layer 2)
pub fn evaluate_quality(
    lint_ok: bool,
    tests_ok: bool,
    typecheck_ok: bool,
    no_security_issues: bool,
    diff_lines: u32,
    in_scope: bool,
    no_new_deps: bool,
    commit_msg_ok: bool,
    risk_level: &str,
) -> QualityScore {
    // Layer 1: 自动化检查 (0-40)
    let mut l1: u32 = 0;
    if lint_ok {
        l1 += 10;
    }
    if tests_ok {
        l1 += 15;
    }
    if typecheck_ok {
        l1 += 10;
    }
    if no_security_issues {
        l1 += 5;
    }

    // Layer 2: 结构分析 (0-30)
    let mut l2: u32 = 0;

    // diff 大小
    if diff_lines <= 500 {
        l2 += 5;
    } else {
        l2 += 5u32.saturating_sub((diff_lines - 500) / 100);
    }

    // 文件范围
    l2 += if in_scope { 10 } else { 0 };

    // 依赖
    l2 += if no_new_deps { 10 } else { 5 };

    // commit message
    l2 += if commit_msg_ok { 5 } else { 2 };

    // Layer 3 估算 (非高风险时按比例)
    let l3 = if risk_level == "high" || risk_level == "critical" {
        0 // 需要 LLM judge, sidecar 不处理
    } else {
        ((l1 + l2) as f64 / 70.0 * 30.0).round() as u32
    };

    let total = l1 + l2 + l3;
    let decision = if total >= 70 {
        "APPROVE"
    } else if total >= 40 {
        "REVIEW"
    } else {
        "REJECT"
    };

    QualityScore {
        layer1: l1,
        layer2: l2,
        layer3_estimate: l3,
        total,
        decision: decision.to_string(),
    }
}
