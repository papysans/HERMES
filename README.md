# Hermes

> 众神的信使 — OpenCode ↔ OpenClaw ↔ Telegram 双向通信桥梁

Hermes 让你通过 Telegram 远程控制 [OpenCode](https://opencode.ai) TUI，不在电脑前也能发需求、审批权限、接收进度通知。

## 架构

```
┌─────────────┐         ┌──────────────────┐         ┌──────────────┐
│  Telegram    │ ◄─────► │  OpenClaw        │ ◄─────► │  OpenCode    │
│  (你的手机)  │         │  Gateway :18789  │         │  TUI :4096   │
└─────────────┘         └──────────────────┘         └──────────────┘
                              │                            │
                        Hermes Agent                 hermes-hook.js
                        (SOUL.md)                    (插件)
```

**方向 A — 用户 → OpenCode：** 你在 Telegram 发消息 → OpenClaw Hermes Agent 通过 `prompt_async` 转发到 OpenCode

**方向 B — OpenCode → 用户：** OpenCode 事件触发 → `hermes-hook.js` 插件通过 webhook 发到 OpenClaw → 投递到 Telegram

## 前置条件

- [OpenCode](https://opencode.ai) — AI 编程 TUI，需启用 HTTP Server（默认 `:4096`）
- [OpenClaw](https://openclaw.ai) — AI Agent 框架，需启用 Gateway + Telegram channel
- 一个 Telegram Bot（通过 [@BotFather](https://t.me/BotFather) 创建）
- 一个 Telegram 群组（把 Bot 加进去）

## 目录结构

```
HERMES/
├── opencode/
│   └── hermes-hook.js        # OpenCode 插件（方向 B）
├── openclaw/
│   ├── SOUL.md               # Hermes Agent 行为指令
│   ├── TOOLS.md              # Agent 工具使用指南
│   ├── USER.md               # 用户信息模板
│   ├── HERMES_QUICKSTART.md  # 快速启动
│   └── HERMES_REQUIREMENTS.md
└── docs/                     # 开发文档（可选）
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
cp opencode/hermes-hook.js ~/.config/opencode/plugins/
```

#### 2.2 设置环境变量

在 `~/.zshrc`（或 `~/.bashrc`）中添加：

```bash
export HERMES_HOOK_TOKEN="<和 openclaw.json hooks.token 一致>"
export HERMES_OPENCLAW_URL="http://localhost:18789"
export HERMES_TELEGRAM_CHANNEL="<你的群组 ID>"
```

然后 `source ~/.zshrc`。

> ⚠️ 环境变量必须在启动 OpenCode 之前生效，否则插件会静默禁用。

### 3. 启动服务

```bash
# 终端 1: 启动 OpenClaw Gateway
openclaw gateway

# 终端 2: 启动 OpenCode（在你的项目目录下）
opencode
```

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

当 OpenCode 需要执行敏感操作时，你会收到类似消息：

```
🔴 需要确认 [shell]
命令: rm -rf node_modules
风险: high
sid: ses_abc123
pid: per_xyz789

请回复：RUN（执行一次）/ ALWAYS（始终允许）/ REJECT（拒绝）
```

回复 `RUN`、`ALWAYS` 或 `REJECT`，Agent 会自动执行对应操作。

### 通知类型

| 消息 | 含义 |
|------|------|
| 📋 PHASE_COMPLETE | OpenCode 完成一个阶段，附带 AI 回复摘要 |
| 🔴 需要确认 | 权限请求，等待你审批 |
| ❌ ERROR | OpenCode 发生错误 |

## 核心概念

### Session 路由

权限消息和通知消息使用不同的 session，避免上下文污染：

- `hermes-permissions` — 权限请求专用 session
- `hermes-notifications` — 通知消息专用 session

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
  "channel": "telegram",
  "to": "<群组 ID>"
}
```

`agentId` 必须与 `openclaw.json` 中 `agents.list[].id` 一致，否则消息会路由到错误的 Agent。

## 环境变量参考

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `HERMES_HOOK_TOKEN` | ✅ | — | OpenClaw webhook token |
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
- Hermes Agent 使用的模型（如 MiniMax-M2.1）指令遵循能力有限，架构层面已做防护（权限消息不含可执行命令）
- `session.idle` 事件的消息获取依赖 OpenCode HTTP API，偶尔可能获取失败

## License

MIT
