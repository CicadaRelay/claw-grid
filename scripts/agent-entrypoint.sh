#!/bin/bash
# FSC Agent 单任务入口脚本
# 执行任务 → 调用 LLM → 通过 HTTP 上报结果到 Redis

set -euo pipefail

PROXY_HOST="${REDIS_HOST:-10.10.0.1}"
PROXY_PORT="3002"
PROXY_URL="http://${PROXY_HOST}:${PROXY_PORT}"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

START_TIME=$(date +%s%3N 2>/dev/null || date +%s)

# 1. 上报 Agent 启动
log "Agent ${AGENT_ID:-$$} starting, model=${MODEL:-minimax-2.5}"
curl -sf -X POST "${PROXY_URL}/v1/report" \
  -H "Content-Type: application/json" \
  -d "{\"task_id\":\"${TASK_ID:-unknown}\",\"agent_id\":\"${AGENT_ID:-$$}\",\"status\":\"started\",\"model\":\"${MODEL:-minimax-2.5}\",\"exit_code\":0}" \
  > /dev/null 2>&1 || true

# 2. 克隆代码库 (如果指定了 GIT_REPO)
if [ -n "${GIT_REPO:-}" ]; then
  log "Cloning ${GIT_REPO} branch=${GIT_BRANCH:-main}"
  git clone --depth 1 --branch "${GIT_BRANCH:-main}" "${GIT_REPO}" /workspace/repo 2>&1 | tail -1
  cd /workspace/repo
fi

# 3. 构建任务 prompt
TASK_FILE="/workspace/task.txt"
echo "${TASK_DESCRIPTION:-No task provided}" > "$TASK_FILE"

# 4. 执行任务
EXIT_CODE=0
RESULT_CONTENT=""

case "${AGENT_TYPE:-api}" in
  claude)
    log "Running Claude Code"
    npx -y claude-code --print < "$TASK_FILE" > /workspace/result.txt 2>&1 || EXIT_CODE=$?
    RESULT_CONTENT=$(head -c 2000 /workspace/result.txt 2>/dev/null || echo "")
    ;;
  gemini)
    log "Running Gemini CLI"
    npx -y gemini-cli --prompt-file "$TASK_FILE" > /workspace/result.txt 2>&1 || EXIT_CODE=$?
    RESULT_CONTENT=$(head -c 2000 /workspace/result.txt 2>/dev/null || echo "")
    ;;
  *)
    # 通过 LLM Proxy 调用廉价模型
    log "Running via API (${MODEL:-minimax-2.5})"

    # 安全地 JSON 编码任务内容
    TASK_CONTENT=$(cat "$TASK_FILE")
    JSON_PAYLOAD=$(cat <<JSONEOF
{
  "model": "${MODEL:-minimax-2.5}",
  "messages": [{"role": "user", "content": $(printf '%s' "$TASK_CONTENT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))' 2>/dev/null || echo '"task"')}],
  "max_tokens": ${MAX_TOKENS:-4000}
}
JSONEOF
)

    # 调用 LLM Proxy，带重试
    for attempt in 1 2 3; do
      HTTP_CODE=$(curl -s -o /workspace/result.json -w '%{http_code}' \
        -X POST "${PROXY_URL}/v1/chat/completions" \
        -H "Content-Type: application/json" \
        -d "$JSON_PAYLOAD" 2>/dev/null || echo "000")

      if [ "$HTTP_CODE" = "200" ]; then
        break
      elif [ "$HTTP_CODE" = "429" ]; then
        log "Rate limited (attempt $attempt/3), waiting..."
        sleep $((attempt * 2))
      else
        log "API error $HTTP_CODE (attempt $attempt/3)"
        sleep 1
      fi
    done

    if [ "$HTTP_CODE" = "200" ]; then
      # 提取 LLM 响应内容
      RESULT_CONTENT=$(python3 -c "
import json,sys
try:
    d = json.load(open('/workspace/result.json'))
    c = d.get('choices',[{}])[0].get('message',{}).get('content','')
    print(c[:2000])
except: print('parse error')
" 2>/dev/null || cat /workspace/result.json 2>/dev/null | head -c 2000)
      echo "$RESULT_CONTENT" > /workspace/result.txt
    else
      EXIT_CODE=1
      RESULT_CONTENT="LLM API failed with HTTP $HTTP_CODE after 3 retries"
      echo "$RESULT_CONTENT" > /workspace/result.txt
    fi
    ;;
esac

# 5. 收集 git diff (如果有代码变更)
DIFF=""
if [ -d "/workspace/repo/.git" ]; then
  cd /workspace/repo
  DIFF=$(git diff 2>/dev/null | head -c 5000 || echo "")
fi

# 6. 计算耗时
END_TIME=$(date +%s%3N 2>/dev/null || date +%s)
DURATION=$((END_TIME - START_TIME))

# 7. 通过 HTTP 上报结果到 Redis
STATUS="success"
[ "$EXIT_CODE" -ne 0 ] && STATUS="failure"

# 截取预览 (避免 JSON 转义问题)
PREVIEW=$(echo "$RESULT_CONTENT" | head -c 400 | tr '\n' ' ' | tr '"' "'" | tr '\\' '/')

REPORT_JSON=$(cat <<REPORTEOF
{
  "task_id": "${TASK_ID:-unknown}",
  "agent_id": "${AGENT_ID:-$$}",
  "status": "$STATUS",
  "exit_code": $EXIT_CODE,
  "model": "${MODEL:-minimax-2.5}",
  "result_preview": "$PREVIEW",
  "duration_ms": $DURATION
}
REPORTEOF
)

curl -sf -X POST "${PROXY_URL}/v1/report" \
  -H "Content-Type: application/json" \
  -d "$REPORT_JSON" \
  > /dev/null 2>&1 || log "Warning: result report failed"

log "Task complete: status=${STATUS}, exit_code=${EXIT_CODE}, duration=${DURATION}ms"
exit $EXIT_CODE
