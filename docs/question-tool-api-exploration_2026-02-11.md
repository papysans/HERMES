# Question Tool API 探测结果

> 📅 探测日期: 2026-02-11
> 🎯 目标: 确定如何从 Telegram 远程回答 question tool 的 TUI 选择对话框
> 📌 OpenCode 版本: 1.1.53

---

## 结论

**✅ 可行方案：`tool.execute.before` 中 throw Error（MODE 9）**

在 `tool.execute.before` 钩子中抛出包含用户答案的 Error，question tool 状态变为 `error`，但 AI 会从错误信息中提取答案并继续执行。TUI 选择对话框完全不出现。

```javascript
// 在 tool.execute.before 中：
throw new Error(`User has answered your questions: "${question}"="${selectedLabel}". You can now continue with the user's answers in mind.`);
```

错误信息格式故意模仿 question tool 正常完成时的 output（见下方 SSE 事件），确保 AI 每次都能正确解读。

### 验证结果（MODE 9）

```
08:47:48.231    tool.question → pending
08:47:49.176    tool.question → running
08:47:50.105    tool.question → error
```

- TUI 选择对话框未出现
- AI 读到错误信息后继续执行："看起来系统模拟了用户选择了 Go，Question 工具传达成功！"
- 全程 < 2 秒，无需手动操作

### 完整集成方案

1. `tool.execute.before` 拦截 question tool
2. 发送问题到 Telegram（带 Inline Keyboard）
3. 阻塞轮询 pending-store 等待用户回答
4. 收到答案后 `throw new Error(...)` 跳过 TUI 对话框
5. 超时则不 throw，让 TUI 正常显示

---

## 已排除的方案

### HTTP API 方案（全部不可行）

以下端点均无法回答 question tool 的 TUI 选择对话框：

| 端点 | 结果 |
|------|------|
| `POST /tui/control/response` | 返回 200 但无效果（question 不走 control request 机制） |
| `POST /session/{sid}/prompt_async` | 只追加新用户消息，不回答 question |
| `POST /session/{sid}/message` | 同上 |
| `POST /tui/append-prompt` + `POST /tui/submit-prompt` | 操作主输入框，不影响选择对话框 |

`GET /tui/control/next` 在 question 对话框打开时全程超时，确认 question 不走 control request 机制。SDK 文档中 TUI 部分只有 `appendPrompt`、`submitPrompt`、`clearPrompt`，无 question reply 端点。

### output.args 修改方案（MODE 0-8, 10-11）

在 `tool.execute.before` 中修改 `output.args` 的各种字段，均无法让 question tool 跳过 TUI 对话框：

- MODE 0: dump 确认 `output` 只有 `args` 键（plain Object prototype）
- MODE 1-8, 10-11: 修改 `questions[0].answer`、`selected`、`answers`、`options[0].selected`、`defaultAnswer`、`response`、替换整个 args、设置 `output.result`、`output.skip`、返回值 — 均无效，TUI 对话框仍然出现
- **MODE 9: throw Error — 成功！**

---

## SSE 事件参考

### question.asked 事件

```json
{
  "type": "question.asked",
  "properties": {
    "id": "que_c4bc8422f001FoPlSGGzE963y4",
    "sessionID": "ses_3b56ede3bffenZXG2FjTZZJ6Wv",
    "questions": [{
      "header": "测试",
      "multiple": false,
      "options": [
        {"description": "选项一", "label": "A"},
        {"description": "选项二", "label": "B"},
        {"description": "选项三", "label": "C"}
      ],
      "question": "Question 工具测试？"
    }],
    "tool": {
      "messageID": "msg_c4bc813fd001C9b0GX601tvBVx",
      "callID": "call_function_ez55ms2ff5ok_1"
    }
  }
}
```

### question.replied 事件（正常回答时）

```json
{
  "type": "question.replied",
  "properties": {
    "sessionID": "ses_3b56ede3bffenZXG2FjTZZJ6Wv",
    "requestID": "que_c4bc8422f001FoPlSGGzE963y4",
    "answers": [["A"]]
  }
}
```

### tool completed 时的 output 格式（throw Error 应模仿此格式）

```
User has answered your questions: "请选择要测试的功能？"="Question". You can now continue with the user's answers in mind.
```

### tool.execute.before 的 output.args 结构

```json
{
  "args": {
    "questions": [{
      "header": "项目类型",
      "multiple": false,
      "options": [
        {"description": "Web 应用开发", "label": "Web App"},
        {"description": "命令行工具", "label": "CLI Tool"}
      ],
      "question": "你接下来想做什么类型的项目？"
    }]
  }
}
```

`output` 对象只有 `args` 键，原型为 plain Object。

---

## 测试工具

| 文件 | 用途 |
|------|------|
| `HERMES/opencode/lib/question-inject-test.js` | 12 种注入模式的测试插件（MODE 0-11） |
| `HERMES/opencode/lib/watch-question.js` | SSE 事件监控，测量 asked→replied 时间差 |
| `HERMES/opencode/lib/monitor-tui.js` | 多通道 TUI 实时监控 |
| `HERMES/opencode/lib/run-inject-test.sh` | 测试运行器脚本 |

---

**最后更新**: 2026-02-11 08:50
