# Hermes — OpenCode ↔ OpenClaw ↔ Telegram 双向通信桥梁

Hermes 实现 OpenCode TUI 与 Telegram 之间的双向通信，让用户可以远程监控和审批 OpenCode 的操作。

## 目录结构

```
HERMES/
├── README.md
├── opencode/                    # OpenCode 侧（插件）
│   └── hermes-hook.js           # OpenCode 事件监听插件，推送到 OpenClaw
├── openclaw/                    # OpenClaw 侧（Agent 配置）
│   ├── SOUL.md                  # Agent 行为指令
│   ├── TOOLS.md                 # Agent 工具使用指南
│   ├── HERMES_REQUIREMENTS.md   # 项目需求文档
│   └── HERMES_QUICKSTART.md     # 快速开始指南
└── docs/                        # 文档
    ├── permission-flow-requirements.md  # 权限流程需求规格
    └── 问题排查_Hermes推送失败_2026-02-10.md
```

## 架构

```
Telegram 用户
      ↕
OpenClaw Gateway (localhost:18789)
      ↕
OpenCode TUI (localhost:4096) + hermes-hook.js 插件
```

- 方向 A: 用户 → OpenClaw agent → curl → OpenCode (`prompt_async`)
- 方向 B: OpenCode 事件 → hermes-hook.js → OpenClaw webhook → Telegram

## 环境变量

```bash
export HERMES_HOOK_TOKEN="<openclaw hooks.token>"
export HERMES_OPENCLAW_URL="http://localhost:18789"
export HERMES_TELEGRAM_CHANNEL="-5088310983"
```

## 当前状态

- ✅ 方向 B 通知已通（permission.asked → Telegram）
- ⚠️ 方向 A 回复（RUN/REJECT）闭环待修复
- ⚠️ 环境变量需确保 OpenCode 启动前 source ~/.zshrc
