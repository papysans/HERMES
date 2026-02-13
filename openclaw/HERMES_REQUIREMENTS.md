# KiroHook 项目需求文档

**创建时间**: 2026-02-10 16:17 GMT+8
**版本**: v1.0
**状态**: 待开发

---

## 1. 项目背景

### 1.1 目标

实现 OpenCode TUI 与 OpenClaw 之间的双向通信：
- OpenClaw → OpenCode：接收用户需求并转发
- OpenCode → OpenClaw：通过 Hook + MCP 实时通知任务状态

### 1.2 参与者

| 角色 | 说明 |
|------|------|
| **用户** | Napsta6100k，使用 Telegram 发送需求 |
| **OpenClaw** | 消息网关，转发消息到 TG 群组 |
| **OpenCode TUI** | AI 编程工具，运行在用户 Mac 上 |

### 1.3 通信链路

```
Telegram 用户
      │
      ▼
OpenClaw Gateway (接收消息)
      │
      ▼ (ACP 协议 / HTTP)
OpenCode TUI (执行任务)
      │
      ▼ (Hook + MCP)
OpenClaw Gateway (接收通知)
      │
      ▼
Telegram 群组 (转发结果/确认请求)
```

---

## 2. 系统架构

### 2.1 核心组件

| 组件 | 文件位置 | 职责 |
|------|----------|------|
| **kiro-hook.js** | `~/.config/opencode/plugins/` | OpenCode 插件，监听 events，调用 MCP |
| **kiro-mcp-server** | `~/.config/opencode/plugins/` 或独立 | MCP Server，接收工具调用，发送 HTTP 通知 |
| **OpenClaw Gateway** | `/Users/openclaw/.openclaw/` | 接收 HTTP 通知，转发 TG |

### 2.2 消息流

```
┌─────────────────────────────────────────────────────────────┐
│                      OpenCode TUI                           │
│                                                             │
│  User Input (TUI)                                           │
│      │                                                       │
│      ▼                                                       │
│  Sisyphus Agent 执行任务                                     │
│      │                                                       │
│      ▼                                                       │
│  Hook System 监听 events                                     │
│      │                                                       │
│      ├─▶ session.idle ──▶ 发送 phase_complete              │
│      ├─▶ permission.asked ──▶ 发送 confirm_request        │
│      ├─▶ permission.replied ──▶ 发送 confirm_reply          │
│      └─▶ session.error ──▶ 发送 error                      │
│                                                             │
│      │                                                       │
│      ▼                                                       │
│  Custom MCP Tool (notify_openclaw)                           │
│      │                                                       │
│      ▼                                                       │
│  HTTP POST → OpenClaw Gateway                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                          │
│                                                             │
│  HTTP Server (接收 MCP 通知)                                 │
│      │                                                       │
│      ▼                                                       │
│  Message Parser (解析 format 类型)                            │
│      │                                                       │
│      ├─▶ confirm_request ──▶ 格式化 → TG                    │
│      ├─▶ phase_complete  ──▶ 格式化 → TG                    │
│      ├─▶ confirm_reply   ──▶ 格式化 → TG                    │
│      └─▶ error           ──▶ 格式化 → TG                    │
│                                                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    Telegram 群组 (-5088311083)
```

---

## 3. 消息格式规范

### 3.1 确认请求 (confirm_request)

**触发条件**: Agent 需要执行敏感命令，等待用户批准

**MCP Tool 调用参数**:

```json
{
  "toolName": "notify_openclaw",
  "args": {
    "format": "confirm_request",
    "action": "RUN",
    "command": "rm -rf node_modules",
    "reason": "Deleting node_modules to clean dependencies",
    "risk_level": "high",
    "timestamp": "2026-02-10T16:00:00Z"
  }
}
```

**TG 转发格式**:

```
🔴 RUN: [command]

原因: [reason]
风险: [risk_level]

请回复「RUN」或「REJECT」
```

**示例**:

```
🔴 RUN: rm -rf node_modules

原因: Deleting node_modules to clean dependencies
风险: high

请回复「RUN」或「REJECT」
```

### 3.2 阶段完成 (phase_complete)

**触发条件**: Agent 完成一个阶段的任务，需要汇报

**MCP Tool 调用参数**:

```json
{
  "toolName": "notify_openclaw",
  "args": {
    "format": "phase_complete",
    "session_id": "ses_abc123",
    "content": "已完成以下任务：\n1. ✅ 初始化项目结构\n2. ✅ 安装依赖",
    "stopReason": "end_turn",
    "next_step_hint": "请输入下一阶段的目标"
  }
}
```

**TG 转发格式**:

```
📋 PHASE_COMPLETE: [summary]

---

[content]

[next_step_hint]
```

**示例**:

```
📋 PHASE_COMPLETE: 第一阶段完成

---

已完成以下任务：
1. ✅ 初始化项目结构
2. ✅ 安装依赖
3. 🔧 修复了 TypeScript 配置错误

请输入下一阶段的目标
```

### 3.3 确认回复 (confirm_reply)

**触发条件**: 用户回复 RUN 或 REJECT 后通知 Agent

**MCP Tool 调用参数**:

```json
{
  "toolName": "notify_openclaw",
  "args": {
    "format": "confirm_reply",
    "action": "RUN",
    "original_command": "rm -rf node_modules",
    "user_id": "1018889184"
  }
}
```

**TG 转发格式**:

```
✅ 你已批准执行：rm -rf node_modules

继续执行中...
```

### 3.4 错误通知 (error)

**触发条件**: 会话发生错误

**MCP Tool 调用参数**:

```json
{
  "toolName": "notify_openclaw",
  "args": {
    "format": "error",
    "error_type": "permission_denied",
    "message": "无法读取文件，权限被拒绝",
    "session_id": "ses_abc123"
  }
}
```

**TG 转发格式**:

```
❌ ERROR: [message]

类型: [error_type]
```

---

## 4. OpenCode 插件详细设计

### 4.1 文件结构

```
~/.config/opencode/plugins/
├── kiro-hook.js           # 主插件文件
├── kiro-mcp-server.js     # MCP Server
└── package.json           # 依赖配置
```

### 4.2 kiro-hook.js 结构

```javascript
// kiro-hook.js

export const KiroHookPlugin = async ({ client, $, project, directory }) => {
  // MCP Server URL，从环境变量读取
  const MCP_SERVER_URL = process.env.KIRO_MCP_SERVER_URL || 'http://localhost:3000';

  return {
    /**
     * Event Hook - 监听所有事件
     */
    'event': async ({ event }) => {
      // session.idle - 阶段完成
      if (event.type === 'session.idle') {
        await notifyOpenClaw('phase_complete', {
          session_id: event.sessionId,
          content: event.message,
          stopReason: event.stopReason
        });
      }

      // permission.asked - 需要确认
      if (event.type === 'permission.asked') {
        await notifyOpenClaw('confirm_request', {
          action: event.permissionType, // 'run' or 'reject'
          command: event.command,
          reason: event.reason,
          risk_level: assessRisk(event.command)
        });
      }

      // session.error - 错误
      if (event.type === 'session.error') {
        await notifyOpenClaw('error', {
          error_type: event.errorType,
          message: event.message
        });
      }
    }
  };

  /**
   * 发送通知到 OpenClaw
   */
  async function notifyOpenClaw(format, data) {
    const payload = JSON.stringify({
      format,
      timestamp: new Date().toISOString(),
      ...data
    });

    await $`curl -X POST ${MCP_SERVER_URL}/notify \
      -H "Content-Type: application/json" \
      -d ${payload}`;
  }

  /**
   * 评估命令风险等级
   */
  function assessRisk(command) {
    const highRiskPatterns = [
      /^rm\s+-rf/,
      /^dd\s+/,
      /^mkfs/,
      /^chmod\s+-R\s+777/,
      /^chown\s+-R/
    ];

    for (const pattern of highRiskPatterns) {
      if (pattern.test(command)) return 'high';
    }
    return 'medium';
  }
};
```

### 4.3 kiro-mcp-server.js 结构

```javascript
// kiro-mcp-server.js

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

// 创建 MCP Server
const server = new McpServer({
  name: 'kiro-notify',
  version: '1.0.0'
});

// 注册 notify_openclaw 工具
server.tool(
  'notify_openclaw',
  'Send notification to OpenClaw Gateway',
  {
    format: z.enum(['confirm_request', 'phase_complete', 'confirm_reply', 'error']),
    action: z.string().optional(),
    command: z.string().optional(),
    reason: z.string().optional(),
    content: z.string().optional(),
    risk_level: z.string().optional(),
    error_type: z.string().optional(),
    message: z.string().optional(),
    session_id: z.string().optional(),
    user_id: z.string().optional()
  },
  async ({ format, ...args }) => {
    // 发送到 OpenClaw Gateway
    const response = await fetch('http://localhost:4000/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ format, ...args })
    });

    return {
      content: [{ type: 'text', text: 'Notification sent' }]
    };
  }
);

// 启动服务器
const transport = new StdioServerTransport();
await server.connect(transport);
```

---

## 5. OpenClaw Gateway 扩展

### 5.1 HTTP Endpoint

```
POST /api/notify
Content-Type: application/json

{
  "format": "confirm_request",
  "action": "RUN",
  "command": "rm -rf node_modules",
  "reason": "Cleaning dependencies",
  "risk_level": "high",
  "timestamp": "2026-02-10T16:00:00Z"
}
```

### 5.2 消息处理器

```javascript
// 伪代码

async function handleNotify(request) {
  const { format, ...data } = request.body;

  switch (format) {
    case 'confirm_request':
      return sendConfirmRequest(data);
    case 'phase_complete':
      return sendPhaseComplete(data);
    case 'confirm_reply':
      return sendConfirmReply(data);
    case 'error':
      return sendError(data);
    default:
      return { status: 'ignored', reason: 'Unknown format' };
  }
}

function sendConfirmRequest(data) {
  const message = `🔴 RUN: ${data.command}\n\n` +
    `原因: ${data.reason}\n` +
    `风险: ${data.risk_level}\n\n` +
    `请回复「RUN」或「REJECT」`;

  return messageGateway.send({
    channel: 'telegram',
    target: '-5088311083',
    message
  });
}

function sendPhaseComplete(data) {
  const message = `📋 PHASE_COMPLETE\n\n---\n\n${data.content}`;

  return messageGateway.send({
    channel: 'telegram',
    target: '-5088311083',
    message
  });
}
```

---

## 6. 配置项

### 6.1 环境变量

在运行 OpenCode 时设置：

```bash
export KIRO_OPENCLAW_URL="http://localhost:18789"
export KIRO_HOOK_TOKEN="your-secret-token"
```

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `KIRO_OPENCLAW_URL` | OpenClaw Gateway 地址 | `http://localhost:18789` |
| `KIRO_HOOK_TOKEN` | OpenClaw Hook Token (必填) | 无 |

### 6.2 OpenCode 配置

在 `~/.config/opencode/opencode.json` 中添加插件：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "kiro-hook"
  ]
}
```

### 6.3 OpenClaw Webhook 配置

在 `~/.config/openclaw/config.json` 中添加 webhook 配置：

```json
{
  "hooks": {
    "enabled": true,
    "token": "your-secret-token",
    "path": "/hooks"
  }
}
```

**获取 OpenClaw Token**：

```bash
# 查看当前配置
openclaw config get hooks.token
```

**测试 webhook**：

```bash
# 测试发送消息
curl -X POST http://localhost:18789/hooks/agent \
  -H "Authorization: Bearer your-secret-token" \
  -H "Content-Type: application/json" \
  -d '{"message": "测试消息", "name": "KiroHook", "sessionKey": "test", "deliver": true}'
```

### 6.4 简化架构（推荐）

不需要额外的 MCP Server，直接使用 OpenClaw Webhook：

```
OpenCode Plugin (kiro-hook.js)
      │
      ▼ HTTP POST
OpenClaw /hooks/agent
      │
      ▼
Telegram (-5088311083)
```

### 6.5 在 tmux 中运行 OpenCode（Mac 休眠保持）

创建 tmux session：

```bash
# 创建新 session
tmux new-session -s opencode -d

# 在 session 中运行 OpenCode
tmux send-keys -t opencode 'export KIRO_OPENCLAW_URL="http://localhost:18789"' Enter
tmux send-keys -t opencode 'export KIRO_HOOK_TOKEN="your-secret-token"' Enter
tmux send-keys -t opencode 'opencode' Enter

# 查看输出
tmux attach-session -t opencode
```

或使用 systemd service（Linux）：

```ini
[Unit]
Description=OpenCode with KiroHook
After=network.target

[Service]
Type=simple
User=napstablook
Environment=KIRO_OPENCLAW_URL=http://localhost:18789
Environment=KIRO_HOOK_TOKEN=your-secret-token
ExecStart=/usr/local/bin/opencode
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

---

## 7. 用户交互流程

### 7.1 完整交互示例

```
1. 用户 (TG): "帮我初始化一个 Node.js 项目"

2. OpenClaw → OpenCode: "初始化一个 Node.js 项目"

3. OpenCode TUI:
   - Sisyphus 规划任务
   - 执行 npm init
   - 安装依赖
   - 创建基础文件

4. 第一个确认点:
   ```
   🔴 RUN: npm install express mongoose
   
   原因: Installing project dependencies
   风险: medium
   
   请回复「RUN」或「REJECT」
   ```

5. 用户 (TG): "RUN"

6. OpenClaw → OpenCode: RUN

7. OpenCode TUI 继续执行...

8. 阶段完成:
   ```
   📋 PHASE_COMPLETE
   
   ---
   
   已完成：
   1. ✅ 初始化 package.json
   2. ✅ 安装 express 和 mongoose
   3. ✅ 创建项目结构
   
   请输入下一阶段的目标
   ```

9. 用户 (TG): "创建一个 REST API 框架"

10. 继续循环...
```

---

## 8. 待办事项

### 阶段 1: OpenCode 插件开发 ✅ (已完成)

- [x] 创建 `kiro-hook.js` 插件框架
- [x] 实现 event listener (session.idle, permission.asked, session.error)
- [x] 实现 notifyOpenClaw HTTP 发送（使用 webhook）
- [x] 实现 risk assessment（命令风险评估）

### 阶段 2: OpenClaw 配置

- [ ] 在 OpenClaw 配置中启用 webhook
- [ ] 生成并保存 hook token
- [ ] 测试 webhook 连通性

### 阶段 3: 部署与测试

- [ ] 复制插件到 `~/.config/opencode/plugins/`
- [ ] 设置环境变量（KIRO_OPENCLAW_URL, KIRO_HOOK_TOKEN）
- [ ] 重启 OpenCode
- [ ] 测试完整交互流程
- [ ] 配置 tmux 保持 24/7 运行

---

## 9. 已知限制

1. **模型切换限制**: ACP 模式下无法切换模型，使用默认 `big-pickle`
2. **卷宗权限**: 需要给 openclaw 用户完全磁盘访问权限
3. **Mac 休眠**: 休眠后网络连接可能中断（但用户说不会断网）
4. **实时性**: 依赖 MCP Server 的 HTTP 响应速度

---

## 10. 参考文档

- [OpenCode Plugins Documentation](https://opencode.ai/docs/plugins/)
- [ACP Protocol](https://agentclientprotocol.com/llms.txt)
- [OhMyOpenCode](https://github.com/code-yeongyu/oh-my-opencode)
- [OpenCode ACP](https://opencode.ai/docs/acp/)
