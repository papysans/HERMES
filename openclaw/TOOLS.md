# TOOLS.md - Hermes Agent 工具配置

## 需要的工具权限

Hermes Agent 需要 `exec` 工具来调用 curl 与 OpenCode HTTP Server 通信。

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
curl -s -X POST http://localhost:4096/session/{SESSION_ID}/prompt_async \
  -H "Content-Type: application/json" \
  -d '{"parts":[{"type":"text","text":"消息内容"}]}'
```
返回 204 No Content，不阻塞。OpenCode 处理完后通过 hermes-hook.js 推送结果到 Telegram。

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
  -d '{"model":{"providerID":"opencode","modelID":"minimax-m2.1-free"},"parts":[{"type":"text","text":"消息内容"}]}'
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
