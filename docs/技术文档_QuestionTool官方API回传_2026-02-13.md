# 技术文档：Question Tool 官方 API 回传链路

> 更新时间：2026-02-13  
> 适用版本：OpenCode `v1.1.53`，Hermes 当前实现

## 1. 目标

在 Telegram 远程场景下，为 OpenCode Question Tool 提供可维护的回答回传能力，使用官方 API 完成闭环，不依赖异常通道注入。

## 2. 架构组件

1. `hermes-hook.js`  
   监听 `tool.execute.before`（仅 `question`），将问题推送到 Telegram。
2. `permission-listener.js`  
   监听 Telegram 回调与文本消息，将用户答案回传 OpenCode Question API。
3. `pending-store.js`  
   跨进程状态缓存（`/tmp/hermes-pending.json`），保存 `sessionID/callID/options` 等路由信息。

## 3. API 契约

### 3.1 拉取待回答问题

- Method: `GET`
- Path: `/question`
- Query: `directory=<project_dir>`
- 返回关键字段：
  - `id`（requestID）
  - `sessionID`
  - `tool.callID`
  - `questions[]`（问题与选项）

### 3.2 提交答案

- Method: `POST`
- Path: `/question/{requestID}/reply`
- Query: `directory=<project_dir>`
- Body:

```json
{
  "answers": [["A"]]
}
```

说明：
- `answers` 是二维字符串数组。
- 当前实现单题单选，使用第一项字符串作为答案。

### 3.3 拒绝/关闭问题

- Method: `POST`
- Path: `/question/{requestID}/reject`
- Query: `directory=<project_dir>`

## 4. 时序流程

1. Agent 调用 `question` 工具。  
2. `hermes-hook.js` 读取 `input.callID`、`sessionID`、问题选项，写入 pending store。  
3. `hermes-hook.js` 将按钮消息发送到 Telegram（`qopt:*` / `qcustom:*`）。  
4. 用户点击按钮或输入文本。  
5. `permission-listener.js` 根据 `uniqueId` 读取 pending。  
6. Listener 调用 `GET /question`，按 `callID + sessionID` 匹配 requestID。  
7. Listener 调用 `POST /question/{requestID}/reply`。  
8. 成功后编辑 Telegram 消息并清理 pending。  
9. OpenCode question tool 状态变为 `completed`，会话继续执行。

### 4.1 自定义回答分支（Telegram 群组）

1. 用户点击 `qcustom:<uniqueId>`。  
2. Listener 将 pending 标记为 `awaitingText=true`，并发送 `force_reply` 提示消息。  
3. 用户必须 reply 这条提示消息输入文本答案。  
4. Listener 优先用 `reply_to_message.message_id` 匹配 `customPromptMessageId`。  
5. 匹配成功后执行 `/question/{requestID}/reply`，并清理 pending。  

回退逻辑：

1. 若没有 reply 关系，仍可按“最近活跃 question + 文本消息”做回退匹配。  
2. 但在并发会话下存在误命中风险，因此文档与交互均推荐 reply 模式。

## 5. 数据模型（pending-store）

`type=question` 关键字段：

1. `sid`：sessionID  
2. `callID`：tool callID  
3. `directory`：项目目录（用于 `/question` 查询）  
4. `options`：按钮选项（`label/value`）  
5. `chatId/messageId`：用于回写 Telegram 消息  
6. `awaitingText`：自定义输入等待标记  
7. `timestamp`：TTL 清理依据

TTL：

1. `QUESTION_TTL_MS = 30min`
2. 过期时尝试调用 `/question/{requestID}/reject`

## 6. 匹配策略

requestID 解析策略（按优先级）：

1. 已缓存 `requestID` 时直接使用。  
2. 使用 `callID` 精确匹配 `question.tool.callID`。  
3. 回退：同 session 的唯一 question。  

重试策略：

1. 默认最多 20 次  
2. 每次间隔 300ms  
3. 总等待窗口约 6 秒

## 7. 错误处理

1. `GET /question` 失败：记录错误并提示 Telegram 用户“回传失败，请稍后重试”。  
2. 匹配不到 requestID：视为暂态失败，不删除 pending。  
3. `reply` 非 2xx：回传失败，保留上下文并输出错误消息。  
4. `reject` 失败：仅告警，不影响主轮询。  

补充（自定义回答）：

1. 用户把文本发给业务机器人（如 `@Napsta...`）而非 reply Permission Bot，会被当作普通任务转发，question 保持 pending。  
2. 群组启用隐私模式且未正确放行消息时，Listener 只能收到 callback，收不到文本消息。  
3. 出现 `fetch failed` 时先区分链路：若 callback 已成功回传 question，则该错误通常为非致命网络抖动。

## 8. 实现边界

1. `hermes-hook.js` 不阻塞 question 工具执行，不抛出业务异常。  
2. 当前回答模型为单题/单值；若启用多题或多选，需扩展 `answers` 组装逻辑。  
3. 并发多个 question 依赖 `callID` 稳定性；上游字段变化需同步调整匹配器。

## 9. 运维检查

### 9.1 基础检查

```bash
curl -s "http://127.0.0.1:4096/question?directory=$PWD" | jq '.'
```

### 9.2 关键观察点

1. question 列表是否包含 `id/sessionID/tool.callID`。  
2. 回答后 question 是否从列表移除。  
3. 对应 assistant message 的 tool 状态是否为 `completed`。

### 9.3 Telegram 自定义回答排障日志

以下日志可作为最小证据链：

1. 收到按钮：`[PermListener] 📥 收到 callback_query: data=qcustom:<id>`  
2. pending 命中：`[PermListener] 📋 getPending(<id>): type=question`  
3. 收到文本：`[PermListener] 📨 收到 message: ... replyTo=<promptMessageId>`  
4. 回传成功：`[PermListener] ✅ question 已回传 OpenCode: requestID=...`

## 10. 关联文件

1. `/Users/napstablook/.config/opencode/HERMES/opencode/hermes-hook.js`  
2. `/Users/napstablook/.config/opencode/HERMES/opencode/lib/permission-listener.js`  
3. `/Users/napstablook/.config/opencode/HERMES/opencode/lib/pending-store.js`  
4. `/Users/napstablook/.config/opencode/HERMES/README.md`
