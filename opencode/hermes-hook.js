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
  const PERMISSION_BOT_TOKEN = process.env.HERMES_PERMISSION_BOT_TOKEN || '';

  // Lazy imports — 避免顶层 import 导致 OpenCode 插件加载失败
  let _pendingStore = null;
  let _crypto = null;
  async function getPendingStore() {
    if (!_pendingStore) _pendingStore = await import('./lib/pending-store.js');
    return _pendingStore;
  }
  async function getCrypto() {
    if (!_crypto) _crypto = await import('node:crypto');
    return _crypto;
  }

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
        // DEBUG: 记录所有事件到文件
        try {
          const fs = await import('node:fs');
          const line = `${new Date().toISOString()} | ${event.type} | ${JSON.stringify(event).slice(0, 500)}\n`;
          fs.appendFileSync('/tmp/hermes-events.log', line);
        } catch (_) { }

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
    },

    // 拦截 question tool — Agent 向用户提问时推送到 Telegram（交互式 Inline Keyboard）
    'tool.execute.before': async (input, output) => {
      if (input.tool === 'question' && PERMISSION_BOT_TOKEN) {
        try {
          const args = output.args || {};
          const options = (args.questions?.[0]?.options) || [];

          // DEBUG: dump question tool args
          try {
            const fs = await import('node:fs');
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            fs.writeFileSync(`/tmp/hermes-question-${ts}.json`, JSON.stringify({ input, output }, null, 2));
          } catch (_) { }

          const crypto = await getCrypto();
          const { addPending, updatePending: updatePendingFn } = await getPendingStore();
          const uniqueId = crypto.randomUUID().slice(0, 8);

          // 获取 session ID 和 call ID
          const sessionId = input.sessionId || await getActiveSessionId();
          const callID = input.callID || input.callId || '';

          // 存入 pending store
          addPending(uniqueId, {
            type: 'question',
            sid: sessionId,
            callID,
            options: options.map(o => ({ label: o.label || o.text || o.value || '', value: o.value || o.label || '' })),
            timestamp: Date.now()
          });

          // 构建消息和键盘
          const text = buildQuestionMessage(args);
          const keyboard = buildQuestionInlineKeyboard(options, uniqueId);

          // 发送到 Telegram
          const res = await fetch(`https://api.telegram.org/bot${PERMISSION_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: TELEGRAM_CHANNEL,
              text,
              parse_mode: 'Markdown',
              reply_markup: keyboard
            })
          });
          const data = await res.json();
          if (data.ok) {
            updatePendingFn(uniqueId, {
              chatId: TELEGRAM_CHANNEL,
              messageId: data.result.message_id
            });
          }
          console.log('[Hermes] ✅ question 已推送到 Telegram (interactive)');
        } catch (err) {
          console.error('[Hermes] ❌ question 推送失败:', err.message);
        }
      }
    }
  };

  // --- Helpers ---

  async function getActiveSessionId() {
    try {
      const port = process.env.HERMES_OPENCODE_PORT || '4096';
      const res = await fetch(`http://localhost:${port}/session`);
      if (res.ok) {
        const sessions = await res.json();
        if (Array.isArray(sessions) && sessions.length > 0) {
          return sessions[0].id;
        }
      }
    } catch (err) {
      console.log('[Hermes] getActiveSessionId 失败:', err.message);
    }
    return '';
  }

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

    // 优先直发 Telegram（绕过 Agent），回退到 OpenClaw
    if (PERMISSION_BOT_TOKEN) {
      await sendNotificationToTelegram(msg);
      console.log('[Hermes] ✅ phase_complete 已直发 Telegram');
    } else {
      await sendToOpenClaw(msg);
      console.log('[Hermes] ✅ phase_complete 已发送 (via OpenClaw)');
    }
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

    // 直接发送到 Telegram（不走 OpenClaw Agent）
    if (PERMISSION_BOT_TOKEN) {
      await sendPermissionToTelegram(sessionId, permissionId, permType, command, risk, alwaysPattern);
      console.log('[Hermes] ✅ permission 已直发 Telegram');
    } else {
      // 回退：Permission Bot 未配置时走旧路径
      const msg = buildPermissionMessage(sessionId, permissionId, permType, command, risk, alwaysPattern);
      await sendToOpenClaw(msg, 'permission');
      console.log('[Hermes] ⚠️ PERMISSION_BOT_TOKEN 未设置，走 OpenClaw 旧路径');
    }
  }


  async function sendPermissionToTelegram(sessionId, permissionId, permType, command, risk, alwaysPattern) {
    const crypto = await getCrypto();
    const { addPending, updatePending: updatePendingFn } = await getPendingStore();
    const uniqueId = crypto.randomUUID().slice(0, 8);

    // 1. 存入 pending store
    addPending(uniqueId, {
      type: 'permission',
      sid: sessionId,
      pid: permissionId,
      command,
      timestamp: Date.now()
    });

    // 2. 构建消息文本和键盘
    const text = buildTelegramPermissionMessage(permType, command, risk, alwaysPattern);
    const keyboard = buildInlineKeyboard(uniqueId);

    // 3. 调用 Telegram Bot API
    const res = await fetch(`https://api.telegram.org/bot${PERMISSION_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHANNEL,
        text,
        parse_mode: 'Markdown',
        reply_markup: keyboard
      })
    });

    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);

    // 4. 更新 store 中的 messageId（用于后续编辑消息）
    updatePendingFn(uniqueId, {
      chatId: TELEGRAM_CHANNEL,
      messageId: data.result.message_id
    });
  }

  async function handleSessionError(event) {
    const props = event.properties || event;
    const errorMsg = props.message || props.error || 'Unknown error';
    const msg = `❌ ERROR: ${errorMsg}`;

    // 优先直发 Telegram（绕过 Agent），回退到 OpenClaw
    if (PERMISSION_BOT_TOKEN) {
      await sendNotificationToTelegram(msg);
      console.log('[Hermes] ✅ error 已直发 Telegram');
    } else {
      await sendToOpenClaw(msg);
      console.log('[Hermes] ✅ error 已发送 (via OpenClaw)');
    }
  }

  // --- Core: 直发 Telegram（通知类消息，纯文本，不走 Agent） ---

  async function sendNotificationToTelegram(text) {
    const res = await fetch(`https://api.telegram.org/bot${PERMISSION_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHANNEL,
        text
      })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(`Telegram API error: ${data.description}`);
    return data;
  }

  // --- Core: 发送到 OpenClaw ---

  async function sendToOpenClaw(message, messageType = 'notification') {
    const payload = buildWebhookPayload(message, TELEGRAM_CHANNEL, messageType);

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
 * 构建结构化权限确认消息（不含 curl 命令）。
 *
 * @param {string} sessionId    - OpenCode session ID
 * @param {string} permissionId - OpenCode permission ID
 * @param {string} permType     - 权限类型 (e.g. "shell", "bash", "file")
 * @param {string} command      - 待审批的命令
 * @param {string} risk         - 风险等级 ("low" | "medium" | "high")
 * @param {string} alwaysPattern - always 模式匹配串（可为空）
 * @returns {string} 结构化权限消息，不含 curl 命令
 */
export function buildPermissionMessage(sessionId, permissionId, permType, command, risk, alwaysPattern) {
  const lines = [
    `🔴 需要确认 [${permType}]`,
    '',
    `命令: ${command}`,
    `风险: ${risk}`,
    `sid: ${sessionId}`,
    `pid: ${permissionId}`,
  ];

  if (alwaysPattern) {
    lines.push(`Always 模式: ${alwaysPattern}`);
  }

  lines.push(
    '',
    '---',
    '',
    '请回复：RUN（执行一次）/ ALWAYS（始终允许）/ REJECT（拒绝）'
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
 * @param {string} messageType      - 消息类型: "permission" | "notification"
 * @returns {object} 完整的 webhook payload
 */
export function buildWebhookPayload(message, telegramChannel, messageType = 'notification') {
  const sessionKey = messageType === 'permission'
    ? 'hermes-permissions'
    : 'hermes-notifications';

  return {
    message: applyWebhookPrefix(message),
    name: 'Hermes',
    agentId: 'hermes',
    sessionKey,
    wakeMode: 'now',
    deliver: true,
    channel: 'telegram',
    to: telegramChannel
  };
}




/**
 * 构建 Telegram 权限消息文本（Markdown 格式，纯函数，可测试）。
 *
 * @param {string} permType      - 权限类型 (e.g. "shell", "bash", "file")
 * @param {string} command       - 待审批的命令
 * @param {string} risk          - 风险等级 ("low" | "medium" | "high")
 * @param {string} alwaysPattern - always 模式匹配串（可为空）
 * @returns {string} Markdown 格式的权限消息文本
 */
export function buildTelegramPermissionMessage(permType, command, risk, alwaysPattern) {
  const riskEmoji = { high: '🔴', medium: '🟡', low: '🟢' }[risk] || '⚪';
  const lines = [
    `🔴 *需要确认* \\[${permType}]`,
    '',
    `*命令:* \`${command}\``,
    `*风险:* ${riskEmoji} ${risk}`,
  ];
  if (alwaysPattern) {
    lines.push(`*Always 模式:* ${escapeMd(alwaysPattern)}`);
  }
  lines.push('', '点击下方按钮操作：');
  return lines.join('\n');
}

/**
 * 构建 Telegram Inline Keyboard 对象（纯函数，可测试）。
 *
 * @param {string} uniqueId - 用于 callback_data 的唯一标识
 * @returns {object} Telegram inline_keyboard 对象，包含 RUN/ALWAYS/REJECT 三个按钮
 */
export function buildInlineKeyboard(uniqueId) {
  return {
    inline_keyboard: [[
      { text: '🟢 RUN', callback_data: `run:${uniqueId}` },
      { text: '🔵 ALWAYS', callback_data: `always:${uniqueId}` },
      { text: '🔴 REJECT', callback_data: `reject:${uniqueId}` }
    ]]
  };
}

/**
 * 构建 Telegram 问题通知消息（Markdown 格式，纯函数，可测试）。
 * 当 Agent 调用 question tool 向用户提问时，将问题和选项格式化为 Telegram 消息。
 *
 * @param {object} args - question tool 的参数
 * @param {Array<object>} [args.questions] - 问题列表，每个包含 header, question, options
 * @returns {string} Markdown 格式的问题通知消息
 */
export function buildTelegramQuestionMessage(args) {
  const questions = args.questions || [];
  if (questions.length === 0) return '❓ Agent 提问（无内容）';

  const lines = ['❓ *Agent 提问*'];

  for (const q of questions) {
    if (q.header) lines.push('', `*${escapeMd(q.header)}*`);
    if (q.question) lines.push('', escapeMd(q.question));

    const opts = q.options || [];
    if (opts.length > 0) {
      lines.push('');
      opts.forEach((opt, i) => {
        const label = escapeMd(opt.label || opt.text || opt.value || '');
        const desc = opt.description ? ` — ${escapeMd(opt.description)}` : '';
        lines.push(`${i + 1}. ${label}${desc}`);
      });
      // question tool 总是追加一个自由输入选项
      lines.push(`${opts.length + 1}. Type your own answer`);
    }
  }

  lines.push('', '_请在 OpenCode TUI 中回答_');
  return lines.join('\n');
}

/**
 * 构建问题 Inline Keyboard
 * 每个选项一行一个按钮，末尾追加"✏️ 自定义回答"按钮。
 *
 * @param {Array} options - 选项数组 [{label, text, value, ...}, ...]
 * @param {string} uniqueId - 8 字符唯一标识
 * @returns {object} Telegram inline_keyboard 对象
 */
export function buildQuestionInlineKeyboard(options, uniqueId) {
  const rows = [];
  for (let i = 0; i < options.length; i++) {
    const label = options[i].label || options[i].text || options[i].value || `选项 ${i + 1}`;
    rows.push([{ text: label, callback_data: `qopt:${uniqueId}:${i}` }]);
  }
  rows.push([{ text: '✏️ 自定义回答', callback_data: `qcustom:${uniqueId}` }]);
  return { inline_keyboard: rows };
}


/**
 * 构建问题消息文本（不含选项列表，选项由 Inline Keyboard 承载）
 * @param {object} args - question tool 参数
 * @returns {string} Markdown 格式消息文本
 */
export function buildQuestionMessage(args) {
  const questions = args.questions || [];
  if (questions.length === 0) return '❓ Agent 提问（无内容）';
  const lines = ['❓ *Agent 提问*'];
  for (const q of questions) {
    if (q.header) lines.push('', `*${escapeMd(q.header)}*`);
    if (q.question) lines.push('', escapeMd(q.question));
  }
  lines.push('', '_点击下方按钮回答：_');
  return lines.join('\n');
}


/**
 * 转义 Telegram MarkdownV1 特殊字符（纯函数，可测试）。
 * MarkdownV1 中 * _ ` [ 需要转义。
 *
 * @param {string} text - 原始文本
 * @returns {string} 转义后的文本
 */
export function escapeMd(text) {
  if (!text) return '';
  return String(text).replace(/([*_`\[])/g, '\\$1');
}
