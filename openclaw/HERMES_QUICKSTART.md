# Hermes 快速启动指南

## 1. OpenClaw Webhook 配置

### 1.1 编辑配置文件

```bash
# 配置文件位置
~/.config/openclaw/openclaw.json
```

### 1.2 添加 webhook 配置

```json5
{
  gateway: {
    port: 18789
  },
  hooks: {
    enabled: true,
    token: "hermes-abc123xyz",  # 替换成你的 token
    path: "/hooks"
  }
}
```

**生成随机 token：**
```bash
openssl rand -hex 32
```

### 1.3 重启 OpenClaw Gateway

```bash
# 开发模式
openclaw gateway --port 18789 --verbose
```

### 1.4 测试 webhook

```bash
curl -X POST http://localhost:18789/hooks/agent \
  -H "Authorization: Bearer hermes-abc123xyz" \
  -H "Content-Type: application/json" \
  -d '{"message": "测试", "name": "Hermes", "sessionKey": "test", "deliver": true}'
```

---

## 2. OpenCode 插件配置

### 2.1 复制插件文件

```bash
cp /Users/openclaw/.openclaw/agents/kiro/hermes-hook.js ~/.config/opencode/plugins/
```

### 2.2 设置环境变量

```bash
export HERMES_OPENCLAW_URL="http://localhost:18789"
export HERMES_HOOK_TOKEN="hermes-abc123xyz"
```

---

## 3. tmux 部署

```bash
tmux new-session -s hermes -d
# 然后在 tmux 中运行 OpenCode
```

---

## 4. 验证

如果收到 Telegram 测试消息，说明配置成功！

---

## 文件清单

| 文件 | 用途 |
|------|------|
| `hermes-hook.js` | OpenCode 插件 |
| `HERMES_REQUIREMENTS.md` | 完整需求文档 |
| `HERMES_QUICKSTART.md` | 快速启动 |

**名称来源**：Hermes - 希腊神话中众神的使者
