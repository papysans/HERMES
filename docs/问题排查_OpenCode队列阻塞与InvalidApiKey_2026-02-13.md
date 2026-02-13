# 问题排查：OpenCode 队列阻塞与 `invalid api key`

> 时间：2026-02-13  
> 范围：Telegram -> OpenClaw -> OpenCode（Question Tool 测试链路）

## 结论摘要

本次异常由多因素叠加触发，核心是「模型配置不匹配 + 凭据/provider 选择不一致」。
当前状态已恢复正常。

## 发现的问题清单

1. `ProviderModelNotFoundError` 导致会话在 OpenCode 侧看起来卡住/排队。
2. `invalid api key`（MiniMax Coding Plan）导致模型调用失败。
3. 误启动多个 `opencode --port 4096` 进程，造成“看似启动但不可用”的假象。
4. OpenClaw 日志出现 `Non-fatal unhandled rejection: TypeError: fetch failed`（非致命，需监控）。

## 详细记录

### 问题 1：模型 ID 不存在（高优先级）

- 现象：
  - TG 消息已被 Hermes 转发到新 session，但 OpenCode 不继续执行，表现为 Queue/卡住。
- 证据：
  - 日志报错：`ProviderModelNotFoundError`
  - 错误参数：`providerID: "opencode"`，`modelID: "minimax-m2.1-free"`
- 根因：
  - 配置中的模型 ID 不在当前 provider 的可用模型列表中。
- 修复动作：
  - 统一模型配置到有效模型（例如 `MiniMax-M2.5` 对应的 provider/model 组合）。
  - 避免混用旧模型名（如 `minimax-m2.1-free`）。

### 问题 2：`invalid api key`（高优先级）

- 现象：
  - 模型选择后立刻报 `invalid api key`。
- 关键背景：
  - MiniMax Coding Plan 有两条 provider 线路：
    - `minimax-cn-coding-plan`（`minimaxi.com`）
    - `minimax-coding-plan`（`minimax.io`）
  - 两条线路都使用 `MINIMAX_API_KEY`，但 key 与线路需要匹配。
- 根因：
  - key 与实际使用的 provider 线路不一致，或环境变量中的旧 key 覆盖了本地凭据。
- 修复动作：
  - 明确使用 `minimaxi.com` 线路时，provider 固定为 `minimax-cn-coding-plan`。
  - 重新登录该 provider，刷新凭据。
  - 检查并清理冲突的 `MINIMAX_API_KEY`（尤其是 shell 启动脚本中的旧值）。

### 问题 3：重复进程占用同端口（中优先级）

- 现象：
  - 再次执行 `opencode --port 4096` 时只看到插件初始化日志，不进入可交互状态。
- 根因：
  - 旧进程已经监听 `127.0.0.1:4096`，新进程无法正常接管。
- 修复动作：
  - 只保留一个 `opencode` 实例监听目标端口。
  - 启动前先确认端口占用状态。

### 问题 4：OpenClaw `fetch failed` 非致命异常（低优先级）

- 现象：
  - 日志出现 `Non-fatal unhandled rejection (continuing): TypeError: fetch failed`。
- 影响：
  - 本次链路中未导致主流程中断，但可能影响回调稳定性。
- 建议：
  - 持续观察 `/private/tmp/openclaw/openclaw-2026-02-13.log` 是否重复出现。
  - 若高频复现，单独做网络连通性/超时重试策略排查。

## 回归验证清单

1. `opencode auth list` 显示目标 provider 已登录且与模型线路一致。  
2. `opencode models <provider>` 能列出目标模型（如 `MiniMax-M2.5`）。  
3. `oh-my-opencode.json` 中 agent/category 使用的模型与 provider 对应。  
4. 仅存在一个 `opencode` 进程监听 `4096`。  
5. TG 发起新 session 后，OpenCode 能继续执行并可触发 Question Tool 回调。

## 经验与防再发

1. provider 改动时，必须同步检查三处：模型字符串、auth provider、环境变量 key。  
2. 当出现 Queue 卡住时，优先排查模型是否可用，再看凭据是否有效。  
3. 端口固定部署时，启动脚本加入“端口占用/旧进程检测”可减少误判。

