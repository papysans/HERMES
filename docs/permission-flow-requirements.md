# Hermes 权限请求流程 (Permission Flow)

> 📅 创建日期: 2026-02-10
> 📌 版本: V1.0
> 🎯 目标: 实现 OpenCode 权限请求 → Telegram 用户确认 → 回传审批 的完整闭环

---

## 背景

Hermes 是 OpenCode ↔ OpenClaw ↔ Telegram 的双向通信桥梁。当 OpenCode agent 需要执行敏感操作（如 bash 命令）时，会触发 `permission.asked` 事件。该事件需要传递到 Telegram 用户，等待用户决策（批准/拒绝），再将决策回传给 OpenCode。

当前状态：
- ✅ 方向 B（OpenCode → Telegram）基础通知已通
- ✅ `permission.asked` 事件能被 hermes-hook.js 捕获
- ✅ 消息能通过 `wakeMode: "now"` 送达 OpenClaw agent session
- ❌ OpenClaw agent 收到 🔴 消息后自作主张（选择 RUN 而非转发给用户）
- ❌ 完整闭环（用户回复 → agent 执行 curl → OpenCode 审批）未验证

---

## 用户故事

### US-1: 权限请求到达 Telegram

**作为** 远程操控 OpenCode 的用户（Napsta6100k），
**我希望** 当 OpenCode 需要执行 bash 命令时，我能在 Telegram 收到确认请求，
**以便** 我可以远程审批或拒绝敏感操作。

**验收标准：**
- [ ] AC-1.1: OpenCode 触发 `permission.asked` 事件时，Telegram 群组收到 🔴 消息
- [ ] AC-1.2: 消息包含命令内容、风险等级、sid、pid
- [ ] AC-1.3: 消息包含三个选项说明（RUN / ALWAYS / REJECT）
- [ ] AC-1.4: 消息在 5 秒内到达 Telegram

### US-2: OpenClaw Agent 纯转发（不自作主张）

**作为** 用户，
**我希望** OpenClaw agent 收到 Hermes 插件发来的 🔴 消息后，原样转发给我，然后等待我的回复，
**以便** 我自己做出批准/拒绝的决定，而不是 agent 替我决定。

**验收标准：**
- [ ] AC-2.1: Agent 收到 🔴 消息后，完整转发给 Telegram 用户，不修改内容
- [ ] AC-2.2: Agent 不自行选择 RUN/ALWAYS/REJECT
- [ ] AC-2.3: Agent 不添加分析、建议、评论
- [ ] AC-2.4: Agent 转发后停止，等待用户回复

### US-3: 用户批准一次（RUN）

**作为** 用户，
**我希望** 在 Telegram 回复 "RUN" 后，OpenClaw agent 立即执行 curl 命令批准该权限请求，
**以便** OpenCode 继续执行被暂停的操作。

**验收标准：**
- [ ] AC-3.1: 用户回复 "RUN" 后，agent 从最近的 🔴 消息中提取 sid 和 pid
- [ ] AC-3.2: Agent 执行 `POST /session/{sid}/permissions/{pid}` with `{"response":"once"}`
- [ ] AC-3.3: OpenCode 收到审批后继续执行
- [ ] AC-3.4: Agent 告知用户审批结果（成功/失败）

### US-4: 用户永久批准（ALWAYS）

**作为** 用户，
**我希望** 在 Telegram 回复 "ALWAYS" 后，OpenClaw agent 批准并记住此类命令，
**以便** 同类命令以后不再需要我确认。

**验收标准：**
- [ ] AC-4.1: Agent 执行 `POST /session/{sid}/permissions/{pid}` with `{"response":"always"}`
- [ ] AC-4.2: OpenCode 收到审批后继续执行
- [ ] AC-4.3: 后续同类命令不再触发 `permission.asked` 事件

### US-5: 用户拒绝（REJECT）

**作为** 用户，
**我希望** 在 Telegram 回复 "REJECT" 后，OpenClaw agent 拒绝该权限请求，
**以便** OpenCode 不执行该敏感操作。

**验收标准：**
- [ ] AC-5.1: Agent 执行 `POST /session/{sid}/permissions/{pid}` with `{"response":"reject"}`
- [ ] AC-5.2: OpenCode 收到拒绝后跳过该操作或报错
- [ ] AC-5.3: Agent 告知用户拒绝结果

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

1. **OpenClaw agent 自主性过强** — agent 可能忽略 SOUL.md 铁律，自行做决定。需要通过消息格式或 prompt 工程解决。
2. **消息格式中的选项文字** — 🔴 消息中包含 "RUN — 批准一次" 等文字，agent 可能将其理解为可选择的选项而非需要转发的内容。
3. **sessionKey 唯一性** — 每次 webhook 调用使用 `hermes-${Date.now()}`，可能导致 agent 在不同 session 中丢失上下文。
4. **OpenCode 权限超时** — 权限请求可能有超时机制，如果用户回复太慢，审批可能失效。

---

## 技术依赖

| 组件 | 状态 | 说明 |
|------|------|------|
| hermes-hook.js 插件 | ✅ 已部署 | `~/.config/opencode/plugins/hermes-hook.js` |
| OpenCode HTTP Server | ✅ 运行中 | `localhost:4096` |
| OpenClaw Gateway | ✅ 运行中 | `localhost:18789` |
| OpenClaw SOUL.md | ⚠️ 需验证 | 铁律是否被 agent 遵守 |
| Telegram 群组 | ✅ 已配置 | `-5088310983` |

---

## 当前阻塞项

**US-2 是关键路径** — 如果 agent 不能纯转发，后续所有用户故事都无法实现。

解决方案优先级：
1. 验证当前 SOUL.md 铁律是否生效
2. 如果不生效，修改消息格式（去掉选项描述，或加前缀标记）
3. 如果仍不生效，考虑改用 `deliver: true` 直接投递 + 单独的回复处理机制
