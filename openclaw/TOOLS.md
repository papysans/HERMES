# TOOLS.md - Hermes Agent 工具配置

## 需要的工具权限

Hermes Agent 需要 `exec` 工具来调用 curl 与 OpenCode HTTP Server 通信。
在 `（接管: ...）` 流程中，`exec` 只允许用于调用 OpenCode API（`prompt_async`），不允许本地执行业务命令来“代替 OpenCode 完成任务”。

确保 OpenClaw 配置中允许 exec：
```json5
{
  tools: {
    profile: "coding"  // 包含 group:runtime (exec, bash, process)
  }
}
```

或者最小权限：
```json5
{
  tools: {
    allow: ["exec", "group:memory", "group:sessions"]
  }
}
```

## OpenCode HTTP Server

| 端点 | 方法 | 用途 |
|------|------|------|
| `/session` | GET | 列出所有 session |
| `/session` | POST | 创建新 session |
| `/session/:id/message` | POST | 发送消息（同步等待响应）⚠️ 会阻塞，不推荐 |
| `/session/:id/prompt_async` | POST | 发送消息（异步，返回 204）✅ 推荐使用 |
| `/session/:id/abort` | POST | 中止运行中的 session |
| `/session/:id/permissions/:pid` | POST | 回复权限请求 |

## 常用命令

### 列出 session
```bash
curl -s http://localhost:4096/session
```

### 发送消息（异步，推荐）
```bash
code=$(curl -sS -o /tmp/hermes_prompt_async_resp.txt -w "%{http_code}" \
  -X POST "http://localhost:4096/session/{SESSION_ID}/prompt_async" \
  -H "Content-Type: application/json" \
  -d '{"agent":"{AGENT_KEY}","parts":[{"type":"text","text":"消息内容"}]}')
if [ "$code" = "204" ]; then
  echo "PROMPT_ASYNC_OK"
else
  echo "PROMPT_ASYNC_FAIL status=$code body=$(cat /tmp/hermes_prompt_async_resp.txt)"
  exit 1
fi
```
返回 204 No Content，不阻塞。OpenCode 处理完后通过 hermes-hook.js 推送结果到 Telegram。
`{AGENT_KEY}` 必须来自当前控制状态的 `selectedAgent`，例如 `sisyphus` / `hephaestus`。

### 读取接管控制状态
```bash
cat /tmp/hermes-control-state.json
```

### 更新控制模式（示例）
```bash
node -e 'const fs=require("fs");const p="/tmp/hermes-control-state.json";const s=JSON.parse(fs.readFileSync(p,"utf8"));s.mode="copilot";s.updatedAt=Date.now();fs.writeFileSync(p,JSON.stringify(s,null,2));'
```

### 接管模式任务封装（示例）
```text
[HERMES_TASK_ENVELOPE]
HERMES_MODE: copilot
HERMES_AGENT: hephaestus
HERMES_SKILL: superpowers/executing-plans
HERMES_GOAL: 重构支付模块并补齐回归测试
HERMES_CONSTRAINTS:
1. 高风险操作必须通过 Permission Bot 按钮确认
2. 遇到 Question Tool 不能代答
3. 里程碑汇报
HERMES_ACCEPTANCE:
1. 先给出执行计划
2. 每阶段有可验证结果
3. 阻塞时提供最小下一步建议
```

### 发送消息（同步，会阻塞）
```bash
curl -s -X POST http://localhost:4096/session/{SESSION_ID}/message \
  -H "Content-Type: application/json" \
  -d '{"parts":[{"type":"text","text":"消息内容"}]}'
```
⚠️ 同步接口，等待 AI 完成才返回。如果触发 permission 请求会永远挂起，不推荐使用。

### 发送消息（指定模型）
```bash
curl -s -X POST http://localhost:4096/session/{SESSION_ID}/prompt_async \
  -H "Content-Type: application/json" \
  -d '{"agent":"{AGENT_KEY}","model":{"providerID":"opencode","modelID":"minimax-m2.1-free"},"parts":[{"type":"text","text":"消息内容"}]}'
```

### 批准权限请求（一次）
```bash
curl -s -X POST http://localhost:4096/session/{SESSION_ID}/permissions/{PERMISSION_ID} \
  -H "Content-Type: application/json" \
  -d '{"response":"once"}'
```

### 批准权限请求（记住）
```bash
curl -s -X POST http://localhost:4096/session/{SESSION_ID}/permissions/{PERMISSION_ID} \
  -H "Content-Type: application/json" \
  -d '{"response":"always"}'
```

### 拒绝权限请求
```bash
curl -s -X POST http://localhost:4096/session/{SESSION_ID}/permissions/{PERMISSION_ID} \
  -H "Content-Type: application/json" \
  -d '{"response":"reject"}'
```
