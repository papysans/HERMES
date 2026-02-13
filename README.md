# Hermes

> 众神的信使 — OpenCode ↔ OpenClaw ↔ Telegram 双向通信桥梁

Hermes 让你通过 Telegram 远程控制 [OpenCode](https://opencode.ai) TUI，不在电脑前也能发需求、审批权限、接收进度通知。

## 架构

```
┌─────────────┐         ┌──────────────────┐         ┌──────────────┐
│  Telegram    │ ◄─────► │  OpenClaw        │ ◄─────► │  OpenCode    │
│  (你的手机)  │         │  Gateway :18789  │         │  TUI :4096   │
└─────────────┘         └──────────────────┘         └──────────────┘
       ▲                      │                            │
       │                Hermes Agent                 hermes-hook.js
       │                (SOUL.md)                    (插件)
       │
       │    ┌──────────────────────┐
       └────│  Permission Bot      │◄── permission-listener.js
            │  (直发 Telegram)     │     (长轮询 callback_query + message)
            └──────────────────────┘
```

**方向 A — 用户 → OpenCode：** 你在 Telegram 发消息 → OpenClaw Hermes Agent 通过 `prompt_async` 转发到 OpenCode

**方向 B — OpenCode → 用户（双路径）：**
- 权限请求 + 通知 + 问题：`hermes-hook.js` → Permission Bot → 直发 Telegram（绕过 Agent，避免上下文丢失）
- 回退路径：Permission Bot 未配置时，走 OpenClaw Agent webhook（`deliver: true`）

**权限回调：** 用户点击 Telegram Inline Keyboard → `permission-listener.js` 长轮询接收 → 调用 OpenCode 权限 API

**问题回调：** Agent 提问时推送 Inline Keyboard 到 Telegram → 用户点击选项或输入自定义回答 → `permission-listener.js` 通过官方 Question API（`/question` + `/reply`）回传答案

## 前置条件

- [OpenCode](https://opencode.ai) — AI 编程 TUI，需启用 HTTP Server（默认 `:4096`）
- [OpenClaw](https://openclaw.ai) — AI Agent 框架，需启用 Gateway + Telegram channel
- 一个 Telegram Bot（通过 [@BotFather](https://t.me/BotFather) 创建）
- 一个 Telegram 群组（把 Bot 加进去）

## 目录结构

```
HERMES/
├── opencode/
│   ├── hermes-hook.js              # OpenCode 插件（方向 B）
│   └── lib/
│       ├── pending-store.js        # 待处理请求存储（权限 + 问题，JSON 文件）
│       ├── permission-listener.js  # Telegram 回调监听（权限 + 问题，独立进程）
│       └── hermes-hook.test.js     # 测试（Vitest + fast-check PBT）
├── openclaw/
│   ├── SOUL.md               # Hermes Agent 行为指令
│   ├── TOOLS.md              # Agent 工具使用指南
│   ├── USER.md               # 用户信息模板
│   ├── HERMES_QUICKSTART.md  # 快速启动
│   └── HERMES_REQUIREMENTS.md
└── docs/                     # 开发文档
```

## 安装

### 1. 配置 OpenClaw

#### 1.1 生成 webhook token

```bash
openssl rand -hex 32
# 输出类似: c92123915191b5177b9eba7e00aa38c7...
```

#### 1.2 编辑 OpenClaw 配置

编辑 `~/.openclaw/openclaw.json`（或 `~/.config/openclaw/openclaw.json`）：

```jsonc
{
  // Gateway 配置
  "gateway": {
    "port": 18789,
    "mode": "local",
    "bind": "loopback"
  },

  // 启用 webhook hooks
  "hooks": {
    "enabled": true,
    "token": "<你生成的 token>",
    "path": "/hooks"
  },

  // Telegram 配置
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "<你的 Bot Token>",
      "groupPolicy": "allowlist",
      "groups": {
        "<你的群组 ID>": {
          "requireMention": false
        }
      }
    }
  },

  // 注册 Hermes Agent
  "agents": {
    "list": [
      {
        "id": "hermes",
        "name": "Hermes",
        "workspace": "/path/to/hermes-workspace"
      }
    ]
  },

  // 绑定群组到 Hermes Agent
  "bindings": [
    {
      "agentId": "hermes",
      "match": {
        "channel": "telegram",
        "peer": {
          "kind": "group",
          "id": "<你的群组 ID>"
        }
      }
    }
  ]
}
```

#### 1.3 部署 Agent 文件

把 `openclaw/` 目录下的文件复制到 Hermes Agent 的 workspace：

```bash
cp openclaw/SOUL.md   /path/to/hermes-workspace/
cp openclaw/TOOLS.md  /path/to/hermes-workspace/
cp openclaw/USER.md   /path/to/hermes-workspace/
```

> `SOUL.md` 是 Agent 的核心行为指令，定义了消息路由、权限处理、转发规则等。按需修改其中的 Session ID 和群组 ID。

### 2. 配置 OpenCode 插件

#### 2.1 复制插件

```bash
# 主插件
cp opencode/hermes-hook.js ~/.config/opencode/plugins/

# lib 目录（OpenCode 不递归扫描子目录，所以 lib/ 下的文件不会被当作插件加载）
mkdir -p ~/.config/opencode/plugins/lib
cp opencode/lib/pending-store.js ~/.config/opencode/plugins/lib/
cp opencode/lib/permission-listener.js ~/.config/opencode/plugins/lib/
```

#### 2.2 设置环境变量

在 `~/.zshrc`（或 `~/.bashrc`）中添加：

```bash
export HERMES_HOOK_TOKEN="<和 openclaw.json hooks.token 一致>"
export HERMES_OPENCLAW_URL="http://localhost:18789"
export HERMES_TELEGRAM_CHANNEL="<你的群组 ID>"
export HERMES_PERMISSION_BOT_TOKEN="<Permission Bot Token（推荐，启用直发 Telegram）>"
```

然后 `source ~/.zshrc`。

> ⚠️ 环境变量必须在启动 OpenCode 之前生效，否则插件会静默禁用。

### 3. 启动服务

```bash
# 终端 1: 启动 OpenClaw Gateway
openclaw gateway start

# 终端 2: 启动 Permission Listener（处理 Telegram 按钮回调）
node ~/.config/opencode/plugins/lib/permission-listener.js

# 终端 3: 启动 OpenCode（在你的项目目录下）
opencode
```

> Permission Listener 是独立的 Node.js 长轮询进程，负责接收 Telegram Inline Keyboard 的回调（权限审批 + 问题回答）以及群组文本消息（自定义回答），并调用 OpenCode 相应 API。必须在 OpenCode 之前或同时启动。

### 4. 验证

在 Telegram 群组中发一条消息，Hermes Agent 应该会回复确认。

也可以手动测试 webhook：

```bash
curl -X POST http://localhost:18789/hooks/agent \
  -H "Authorization: Bearer <你的 token>" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "测试消息",
    "name": "Hermes",
    "agentId": "hermes",
    "sessionKey": "hermes-notifications",
    "wakeMode": "now",
    "channel": "telegram",
    "to": "<你的群组 ID>"
  }'
```

## 使用方式

### 发送需求

在 Telegram 群组中直接发消息，Hermes Agent 会转发到 OpenCode：

```
帮我创建一个 REST API
```

### 和 Agent 对话

用括号包裹的内容是跟 Agent 说的，不会转发：

```
（查一下当前 session）
（状态怎么样）
```

### 权限审批

当 OpenCode 需要执行敏感操作时，你会在 Telegram 收到带 Inline Keyboard 的消息：

```
🔴 *需要确认* [shell]

*命令:* `rm -rf node_modules`
*风险:* 🔴 high

点击下方按钮操作：
[🟢 RUN] [🔵 ALWAYS] [🔴 REJECT]
```

点击按钮即可，`permission-listener.js` 会自动调用 OpenCode API 执行对应操作。

> 如果 Permission Bot 未配置，会回退到旧的文本回复模式（通过 OpenClaw Agent）。

### Agent 提问（Question Tool 远程回答）

当 OpenCode Agent 使用 question tool 向用户提问时，你会在 Telegram 收到带选项按钮的消息：

```
❓ *Agent 提问*

*问题标题*

问题内容...

_点击下方按钮回答：_
[选项 A]
[选项 B]
[✏️ 自定义回答]
```

- 点击选项按钮：直接选择对应答案
- 点击「✏️ 自定义回答」：会收到 Permission Bot 的“请回复此消息输入回答”提示，必须在群组里回复该提示消息
- 也支持直接发送普通文本作为回退模式（按最近活跃问题匹配），但推荐优先使用“回复提示消息”的方式，避免误路由

#### Question Tool 正式回传链路（无 throw hack）

从 OpenCode `v1.1.53` 开始，Question Tool 可以走官方 HTTP API 回传：

| API | 用途 |
|-----|------|
| `GET /question` | 拉取待回答问题（含 `id`、`sessionID`、`tool.callID`、题目与选项） |
| `POST /question/{requestID}/reply` | 提交用户答案 |
| `POST /question/{requestID}/reject` | 拒绝/超时关闭问题 |

当前实现流程：

1. `hermes-hook.js` 在 `tool.execute.before` 仅负责把问题推送到 Telegram，不阻塞、不抛错。  
2. `permission-listener.js` 收到 Telegram 按钮/文本回答后，通过 `callID + sessionID` 匹配 `GET /question` 返回的 `requestID`。  
3. 用 `POST /question/{requestID}/reply` 提交答案（格式：`{ "answers": [["A"]] }`）。  
4. OpenCode 将 tool 状态标记为 `completed`，并继续执行后续步骤。

这条链路不再依赖异常通道传值，避免了 `throw Error` 带来的语义和可维护性问题。

#### 自定义回答正确姿势（2026-02-13 实测）

1. 先点击「✏️ 自定义回答」。  
2. 等 Permission Bot 发出“请回复此消息输入回答”。  
3. 直接回复这条提示消息（reply），不要发给 Napsta 业务机器人。  
4. Listener 检测到 `reply_to_message_id` 命中后，立即走 `/question/{requestID}/reply` 回传。

常见误操作：

- 在等待回答时发送 `@Napsta...` 文本，会被当成普通任务转发到 OpenCode，而不是 question answer。  
- 不回复提示消息、只发一条普通文本，可能被并发上下文抢占，表现为 `QUEUED`。

> 历史探索记录仍保留在 [`docs/question-tool-api-exploration_2026-02-11.md`](docs/question-tool-api-exploration_2026-02-11.md)。

最新一次联调问题总结见：[`docs/问题排查_OpenCode队列阻塞与InvalidApiKey_2026-02-13.md`](docs/问题排查_OpenCode队列阻塞与InvalidApiKey_2026-02-13.md)。

Question Tool 官方回传技术文档见：[`docs/技术文档_QuestionTool官方API回传_2026-02-13.md`](docs/技术文档_QuestionTool官方API回传_2026-02-13.md)。

联调关键发现与工程实践文档见：[`docs/技术文档_Hermes联调关键发现与工程实践_2026-02-13.md`](docs/技术文档_Hermes联调关键发现与工程实践_2026-02-13.md)。

### 通知类型

| 消息 | 含义 |
|------|------|
| 📋 PHASE_COMPLETE | OpenCode 完成一个阶段，附带 AI 回复摘要 |
| 🔴 需要确认 | 权限请求，等待你审批 |
| ❓ Agent 提问 | Agent 需要用户输入，带选项按钮 |
| ❌ ERROR | OpenCode 发生错误 |

## 核心概念

### Session 路由

权限消息和通知消息使用不同的 session，避免上下文污染：

- `hermes-permissions` — 权限请求专用 session
- `hermes-notifications` — 通知消息专用 session

### Pending Store

`/tmp/hermes-pending.json` 存储待处理的权限请求和问题，每条记录包含 `type` 字段区分类型：

| type | 用途 | 关键字段 |
|------|------|---------|
| `permission` | 权限审批 | `sid`, `pid`, `command`, `risk` |
| `question` | Agent 提问 | `sid`, `callID`, `options`, `awaitingText` |

TTL 30 分钟，原子写入（tmp+rename），重启后自动清理过期条目。

### 问题回答投递（官方 Question API）

当用户在 Telegram 回答 Agent 提问时，完整流程如下：

```
1. hermes-hook.js 的 tool.execute.before 监听 question tool（不阻塞）
2. 发送问题到 Telegram（带 Inline Keyboard 选项按钮）
3. permission-listener.js 收到用户点击/文字回答
4. 通过 `GET /question` 按 `callID + sessionID` 匹配 requestID
5. 调用 `POST /question/{requestID}/reply` 回传答案
6. question tool 状态变为 completed，AI 按官方链路继续执行
7. 过期条目会尝试 `POST /question/{requestID}/reject` 关闭问题
```

> 历史 throw 方案见 `docs/question-tool-api-exploration_2026-02-11.md`。

### 迁移状态（2026-02-13）

- ✅ 已切换到官方 Question API 回传（`/question`、`/question/{requestID}/reply`、`/question/{requestID}/reject`）
- ✅ `hermes-hook.js` 不再阻塞 question tool，也不再通过 throw 注入答案
- ✅ `permission-listener.js` 使用 `callID + sessionID` 匹配 requestID 并提交答案
- ✅ README 与实现保持一致

快速自检：

```bash
curl -s "http://127.0.0.1:4096/question?directory=$PWD" | jq '.'
```

当存在待回答问题时，返回应包含：
- `id`（requestID）
- `sessionID`
- `tool.callID`

### 风险评估

插件会自动评估命令风险等级：

| 等级 | 匹配规则 | 示例 |
|------|---------|------|
| high | `rm -rf`, `dd`, `mkfs`, `chmod -R 777` | `rm -rf /` |
| medium | `rm`, `mv`, `sed -i`, `kill -9` | `rm file.txt` |
| low | 其他所有命令 | `echo hello` |

### Webhook Payload

`hermes-hook.js` 发送到 OpenClaw 的 payload 格式：

```json
{
  "message": "[HERMES_WEBHOOK — 转发给用户，不要自己处理] 消息内容",
  "name": "Hermes",
  "agentId": "hermes",
  "sessionKey": "hermes-permissions | hermes-notifications",
  "wakeMode": "now",
  "deliver": true,
  "channel": "telegram",
  "to": "<群组 ID>"
}
```

`agentId` 必须与 `openclaw.json` 中 `agents.list[].id` 一致。`deliver: true` 确保 OpenClaw 将 Agent 回复直接投递到目标群组。

## 环境变量参考

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `HERMES_HOOK_TOKEN` | ✅ | — | OpenClaw webhook token |
| `HERMES_PERMISSION_BOT_TOKEN` | 推荐 | — | Permission Bot token（启用直发 Telegram + Inline Keyboard） |
| `HERMES_OPENCLAW_URL` | — | `http://localhost:18789` | OpenClaw Gateway 地址 |
| `HERMES_TELEGRAM_CHANNEL` | — | `-5088310983` | Telegram 群组 ID |
| `HERMES_OPENCODE_PORT` | — | `4096` | OpenCode HTTP Server 端口 |

## 自定义

### 修改 Agent 行为

编辑 `openclaw/SOUL.md`，主要可调整：

- 消息路由规则（括号约定）
- 权限处理流程
- 输出风格（极简 vs 详细）
- 环境信息（Session ID、模型等）

### 修改风险评估规则

编辑 `opencode/hermes-hook.js` 中的 `assessRisk()` 函数，添加自定义的 high/medium 匹配规则。

### 添加新事件

在 `hermes-hook.js` 的 `event` handler 中添加新的 `event.type` 分支。OpenCode 支持的事件类型参考 [OpenCode 插件文档](https://dev.opencode.ai/docs/plugins/)。

## 已知限制

- OpenCode HTTP Server 必须在本地运行（`localhost:4096`）
- `permission-listener.js` 必须作为独立进程运行（不能内嵌到 OpenCode 插件中）
- Hermes Agent 使用的模型（如 MiniMax-M2.1）指令遵循能力有限，架构层面已做防护（权限和通知走直发 Telegram，不经过 Agent）
- `session.idle` 事件的消息获取依赖 OpenCode HTTP API，偶尔可能获取失败
- 待处理请求存储在 `/tmp/hermes-pending.json`，TTL 30 分钟，重启后自动清理过期条目
- Question Tool 远程回答已迁移到官方 `/question` API；如 API 行为变化，需要同步调整 `permission-listener.js` 的 requestID 匹配逻辑（`callID + sessionID`）
- 自定义回答推荐使用“回复 Permission Bot 提示消息”；未 reply 时会走回退匹配，极端并发下仍存在误匹配风险

## License

MIT
