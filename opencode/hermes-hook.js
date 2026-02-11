/**
 * Hermes Plugin for OpenCode
 *
 * 方向 B: OpenCode → OpenClaw（上报状态）
 * 监听 OpenCode 事件，通过 fetch 发送到 OpenClaw /hooks/agent，最终投递 Telegram。
 *
 * 环境变量:
 *   HERMES_OPENCLAW_URL   - OpenClaw Gateway 地址 (默认 http://localhost:18789)
 *   HERMES_HOOK_TOKEN     - OpenClaw hooks.token (必填)
 *   HERMES_TELEGRAM_CHANNEL - Telegram 目标群组 ID (默认 -5088310983)
 *
 * 参考:
 *   OpenCode 插件文档: https://dev.opencode.ai/docs/plugins/
 *   OpenClaw hooks:    https://docs.openclaw.ai/configuration
 */

export const HermesPlugin = async ({ client, $, project, directory }) => {
  const OPENCLAW_URL = process.env.HERMES_OPENCLAW_URL || 'http://localhost:18789';
  const HOOK_TOKEN = process.env.HERMES_HOOK_TOKEN || '';
  const TELEGRAM_CHANNEL = process.env.HERMES_TELEGRAM_CHANNEL || '-5088310983';

  // 用 client.app.log 做结构化日志（TUI 可见），同时 console.log 兜底
  const log = async (level, message, extra) => {
    try {
      await client.app.log({ body: { service: 'hermes', level, message, extra } });
    } catch (_) { /* fallback */ }
    console.log(`[Hermes] ${message}`);
  };

  if (!HOOK_TOKEN) {
    await log('warn', '⚠️ HERMES_HOOK_TOKEN 未设置，通知功能禁用');
    return {};
  }

  await log('info', '✅ Plugin 初始化完成', { url: OPENCLAW_URL, channel: TELEGRAM_CHANNEL });

  return {
    event: async ({ event }) => {
      try {
        if (event.type === 'session.idle') {
          await handleSessionIdle(event);
        } else if (event.type === 'permission.asked') {
          await handlePermissionAsked(event);
        } else if (event.type === 'session.error') {
          await handleSessionError(event);
        }
      } catch (err) {
        console.error('[Hermes] ❌ 事件处理失败:', err.message);
      }
    }
  };

  // --- Event Handlers ---

  async function handleSessionIdle(event) {
    // session.idle 事件不携带消息内容，需要通过 HTTP API 获取最后一条回复
    const sessionId = event.properties?.sessionID
      || event.sessionID || event.sessionId
      || event.session?.id || '';

    if (!sessionId) {
      console.log('[Hermes] 跳过 idle 事件：无 sessionId');
      return;
    }

    // 通过 OpenCode HTTP API 获取最近消息
    let content = '';
    try {
      const port = process.env.HERMES_OPENCODE_PORT || '4096';
      const res = await fetch(`http://localhost:${port}/session/${sessionId}/message?limit=1`);
      if (res.ok) {
        const messages = await res.json();
        // 找最后一条 assistant 消息
        const last = Array.isArray(messages)
          ? messages.find(m => m.info?.role === 'assistant')
          : null;
        if (last && last.parts) {
          content = last.parts
            .filter(p => p.type === 'text')
            .map(p => p.text)
            .join('\n');
        }
      }
    } catch (err) {
      console.log('[Hermes] 获取消息失败:', err.message);
    }

    if (!content || content.trim().length < 5) {
      console.log('[Hermes] 跳过空 idle 事件');
      return;
    }

    // 截断过长内容（Telegram 消息限制 4096 字符）
    const truncated = content.length > 3500
      ? content.slice(0, 3500) + '\n\n... (已截断)'
      : content;

    const msg = `📋 PHASE_COMPLETE\n\n---\n\n${truncated}`;
    await sendToOpenClaw(msg);
    console.log('[Hermes] ✅ phase_complete 已发送');
  }

  async function handlePermissionAsked(event) {
    const props = event.properties || {};

    // 持久化 event 到文件，方便调试不同类型的 permission
    try {
      const fs = await import('node:fs');
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(`/tmp/hermes-perm-${ts}.json`, JSON.stringify(event, null, 2));
    } catch (_) { }

    const permissionId = props.id || '';
    const sessionId = props.sessionID || '';

    // sid/pid 缺失校验：跳过并记录警告
    if (!sessionId || !permissionId) {
      const missing = [];
      if (!sessionId) missing.push('sessionId');
      if (!permissionId) missing.push('permissionId');
      console.warn(`[Hermes] ⚠️ 跳过 permission 事件：缺少 ${missing.join(', ')}`, { props });
      return;
    }

    const permType = props.permission || 'unknown';
    const command = (props.patterns && props.patterns.length > 0)
      ? props.patterns.join(' ; ')
      : 'Unknown command';
    const alwaysPattern = (props.always && props.always.length > 0)
      ? props.always.join(', ')
      : '';

    const risk = assessRisk(command);
    const msg = buildPermissionMessage(sessionId, permissionId, permType, command, risk, alwaysPattern);
    await sendToOpenClaw(msg);
  }


  async function handleSessionError(event) {
    const props = event.properties || event;
    const errorMsg = props.message || props.error || 'Unknown error';
    const msg = `❌ ERROR: ${errorMsg}`;
    await sendToOpenClaw(msg);
    console.log('[Hermes] ✅ error 已发送');
  }

  // --- Core: 发送到 OpenClaw ---

  async function sendToOpenClaw(message) {
    const payload = buildWebhookPayload(message, TELEGRAM_CHANNEL);

    const url = `${OPENCLAW_URL}/hooks/agent`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HOOK_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`OpenClaw ${response.status}: ${text}`);
    }

    return response;
  }

};

// --- Utils (module-level pure functions, exported for testing) ---

export function assessRisk(command) {
  if (!command) return 'low';
  const cmd = String(command).toLowerCase();

  const high = [/^rm\s+-rf/, /^dd\s+/, /^mkfs/, /^chmod\s+-R\s+777/, /^chown\s+-R/, /^format\s+/, /^fdisk/];
  const medium = [/^rm\s+/, /^mv\s+/, /^sed\s+-i/, /^kill\s+-9/, /^pkill/, /^killall/];

  for (const p of high) { if (p.test(cmd)) return 'high'; }
  for (const p of medium) { if (p.test(cmd)) return 'medium'; }
  return 'low';
}

/**
 * 构建包含预构建 curl 命令的权限确认消息（纯函数）。
 *
 * @param {string} sessionId   - OpenCode session ID
 * @param {string} permissionId - OpenCode permission ID
 * @param {string} permType    - 权限类型 (e.g. "shell", "file")
 * @param {string} command     - 待审批的命令
 * @param {string} risk        - 风险等级 ("low" | "medium" | "high")
 * @param {string} alwaysPattern - always 模式匹配串（可为空）
 * @returns {string} 格式化的权限消息，包含 RUN/ALWAYS/REJECT curl 命令
 */
export function buildPermissionMessage(sessionId, permissionId, permType, command, risk, alwaysPattern) {
  const OPENCODE_URL = 'http://localhost:4096';

  const lines = [
    `🔴 需要确认 [${permType}]`,
    '',
    `命令: ${command}`,
    `风险: ${risk}`,
  ];

  if (alwaysPattern) {
    lines.push(`Always 模式: ${alwaysPattern}`);
  }

  lines.push(
    '',
    '---',
    '',
    '回复 RUN / ALWAYS / REJECT，我会执行对应命令：',
    '',
    '**RUN（批准一次）:**',
    '```',
    `curl -s -X POST ${OPENCODE_URL}/session/${sessionId}/permissions/${permissionId} -H "Content-Type: application/json" -d '{"response":"once"}'`,
    '```',
    '',
    '**ALWAYS（批准并记住）:**',
    '```',
    `curl -s -X POST ${OPENCODE_URL}/session/${sessionId}/permissions/${permissionId} -H "Content-Type: application/json" -d '{"response":"always"}'`,
    '```',
    '',
    '**REJECT（拒绝）:**',
    '```',
    `curl -s -X POST ${OPENCODE_URL}/session/${sessionId}/permissions/${permissionId} -H "Content-Type: application/json" -d '{"response":"reject"}'`,
    '```'
  );

  return lines.join('\n');
}

/**
 * 为 webhook 消息添加 HERMES_WEBHOOK 前缀（纯函数，可测试）。
 *
 * @param {string} message - 原始消息内容
 * @returns {string} 带前缀的消息
 */
export function applyWebhookPrefix(message) {
  return `[HERMES_WEBHOOK — 转发给用户，不要自己处理] ${message}`;
}

/**
 * 构建 webhook payload 对象（纯函数，可测试）。
 *
 * @param {string} message          - 原始消息内容（未加前缀）
 * @param {string} telegramChannel  - Telegram 目标群组 ID
 * @returns {object} 完整的 webhook payload
 */
export function buildWebhookPayload(message, telegramChannel) {
  return {
    message: applyWebhookPrefix(message),
    name: 'Hermes',
    agentId: 'hermes',
    sessionKey: 'hermes-notifications',
    wakeMode: 'now',
    channel: 'telegram',
    to: telegramChannel
  };
}


