# Hermes 权限请求流程 (Permission Flow)

> 📅 创建日期: 2026-02-10
> 📌 版本: V1.1
> 🎯 目标: 实现 OpenCode 权限请求 → Telegram 用户确认 → 回传审批 的完整闭环

---

## 背景

Hermes 是 OpenCode ↔ OpenClaw ↔ Telegram 的双向通信桥梁。当 OpenCode agent 需要执行敏感操作（如 bash 命令）时，会触发 `permission.asked` 事件。该事件需要传递到 Telegram 用户，等待用户决策（批准/拒绝），再将决策回传给 OpenCode。

当前状态：
- ✅ 方向 B（OpenCode → Telegram）基础通知已通
- ✅ `permission.asked` 事件能被 hermes-hook.js 捕获
- ✅ 消息能通过 `wakeMode: "now"` 送达 OpenClaw agent session
- ✅ Webhook 路由到正确的 Hermes agent（`agentId: "hermes"`）
- ✅ SOUL.md 更新：Agent 只发摘要给用户，自己执行 curl 命令
- ✅ 消息路由规则：括号 = 跟 Agent 说话，无括号 = 转发 OpenCode
- ⚠️ 完整闭环（用户回复 → Agent 执行 curl → OpenCode 审批）待端到端验证

---

## 用户故事

### US-1: 权限请求到达 Telegram

**作为** 远程操控 OpenCode 的用户（Napsta6100k），
**我希望** 当 OpenCode 需要执行 bash 命令时，我能在 Telegram 收到确认请求，
**以便** 我可以远程审批或拒绝敏感操作。

**验收标准：**
- [x] AC-1.1: OpenCode 触发 `permission.asked` 事件时，Telegram 群组收到 🔴 消息
- [x] AC-1.2: 消息包含命令内容、风险等级（sid/pid 内嵌在预构建 curl 命令中）
- [x] AC-1.3: 消息包含三个选项说明（RUN / ALWAYS / REJECT）及对应 curl 命令
- [ ] AC-1.4: 消息在 5 秒内到达 Telegram（待端到端验证）

### US-2: OpenClaw Agent 纯转发（不自作主张）

**作为** 用户，
**我希望** OpenClaw agent 收到 Hermes 插件发来的 🔴 消息后，原样转发给我，然后等待我的回复，
**以便** 我自己做出批准/拒绝的决定，而不是 agent 替我决定。

**验收标准：**
- [x] AC-2.1: Agent 收到 🔴 消息后，提取人类可读摘要转发给 Telegram 用户（不发 curl 命令原文）
- [x] AC-2.2: Agent 不自行选择 RUN/ALWAYS/REJECT（SOUL.md 铁律）
- [x] AC-2.3: Agent 不添加分析、建议、评论
- [x] AC-2.4: Agent 转发后停止，等待用户回复

### US-3: 用户批准一次（RUN）

**作为** 用户，
**我希望** 在 Telegram 回复 "RUN" 后，OpenClaw agent 立即执行 curl 命令批准该权限请求，
**以便** OpenCode 继续执行被暂停的操作。

**验收标准：**
- [x] AC-3.1: 用户回复 "RUN" 后，Agent 从上下文中找到对应 curl 命令
- [x] AC-3.2: Agent 自己执行 `POST /session/{sid}/permissions/{pid}` with `{"response":"once"}`
- [ ] AC-3.3: OpenCode 收到审批后继续执行（待端到端验证）
- [x] AC-3.4: Agent 告知用户审批结果（成功/失败）

### US-4: 用户永久批准（ALWAYS）

**作为** 用户，
**我希望** 在 Telegram 回复 "ALWAYS" 后，OpenClaw agent 批准并记住此类命令，
**以便** 同类命令以后不再需要我确认。

**验收标准：**
- [x] AC-4.1: Agent 执行 `POST /session/{sid}/permissions/{pid}` with `{"response":"always"}`
- [ ] AC-4.2: OpenCode 收到审批后继续执行（待端到端验证）
- [ ] AC-4.3: 后续同类命令不再触发 `permission.asked` 事件（待验证）

### US-5: 用户拒绝（REJECT）

**作为** 用户，
**我希望** 在 Telegram 回复 "REJECT" 后，OpenClaw agent 拒绝该权限请求，
**以便** OpenCode 不执行该敏感操作。

**验收标准：**
- [x] AC-5.1: Agent 执行 `POST /session/{sid}/permissions/{pid}` with `{"response":"reject"}`
- [ ] AC-5.2: OpenCode 收到拒绝后跳过该操作或报错（待验证）
- [x] AC-5.3: Agent 告知用户拒绝结果

### US-6: 连续权限请求处理

**作为** 用户，
**我希望** 当 OpenCode 连续触发多个权限请求时，每个请求都能独立到达 Telegram 并独立处理，
**以便** 我不会遗漏任何确认请求。

**验收标准：**
- [ ] AC-6.1: 多个 `permission.asked` 事件各自独立发送到 Telegram
- [ ] AC-6.2: 每个请求有独立的 pid，不会混淆
- [ ] AC-6.3: 用户可以按顺序逐个回复

---

## 已知风险和约束

1. ~~**OpenClaw agent 自主性过强**~~ ✅ 已通过 SOUL.md 铁律 + Agent 自执行 curl 模式解决
2. ~~**消息格式中的选项文字**~~ ✅ Agent 只发摘要给用户，curl 命令不暴露
3. **sessionKey 唯一性** — 使用固定 `hermes-notifications` sessionKey，所有权限消息在同一 session 中，Agent 可从上下文找到历史 curl 命令
4. **OpenCode 权限超时** — 权限请求可能有超时机制，如果用户回复太慢，审批可能失效

---

## 技术依赖

| 组件 | 状态 | 说明 |
|------|------|------|
| hermes-hook.js 插件 | ✅ 已部署 | `~/.config/opencode/plugins/hermes-hook.js` |
| OpenCode HTTP Server | ✅ 运行中 | `localhost:4096` |
| OpenClaw Gateway | ✅ 运行中 | `localhost:18789` |
| OpenClaw SOUL.md | ✅ 已更新 | 铁律强化 + Agent 自执行 curl + 括号路由规则 |
| Telegram 群组 | ✅ 已配置 | `-5088310983` |

---

## 当前阻塞项

**端到端验证是关键路径** — 代码和 SOUL.md 已全部更新，需要重启 OpenCode 后实际触发 permission.asked 验证完整闭环。

验证步骤：
1. 重启 OpenCode 加载新插件
2. 执行一个需要权限的命令（如 `echo hello`）
3. 确认消息到达 hermes agent 群组 `-5088310983`（不是 coder 群组）
4. 确认 Agent 只发摘要（不发 curl 命令）
5. 回复 RUN，确认 Agent 自己执行 curl
6. 确认 OpenCode 收到审批并继续执行
