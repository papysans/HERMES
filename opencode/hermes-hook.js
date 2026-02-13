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

    // 拦截 question tool — Agent 向用户提问时推送到 Telegram，阻塞轮询等待回答
    'tool.execute.before': async (input, output) => {
      if (input.tool !== 'question' || !PERMISSION_BOT_TOKEN) return;

      const startTime = Date.now();
      debugLog(startTime, 'hook_enter', { tool: input.tool });

      try {
        const args = output.args || {};
        const options = (args.questions?.[0]?.options) || [];
        // 提前提取问题文本（避免 output.args 被运行时修改导致后续 .map 失败）
        const questionTexts = Array.isArray(args.questions)
          ? args.questions.map(q => q.question || q.text || q.header || '')
          : [String(args.questions?.[0]?.question || 'question')];

        const crypto = await getCrypto();
        const { addPending, updatePending: updatePendingFn, getPending: getPendingFn, removePending: removePendingFn } = await getPendingStore();
        const uniqueId = crypto.randomUUID().slice(0, 8);

        // 获取 session ID 和 call ID
        const sessionId = input.sessionId || await getActiveSessionId();
        const callID = input.callID || input.callId || '';

        debugLog(startTime, 'params_extracted', { questionCount: questionTexts.length, optionCount: options.length });

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
        let messageId = null;
        debugLog(startTime, 'telegram_send_start');
        try {
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
            messageId = data.result.message_id;
            updatePendingFn(uniqueId, {
              chatId: TELEGRAM_CHANNEL,
              messageId
            });
          }
          debugLog(startTime, 'telegram_send_done', { ok: data.ok, messageId });
          console.log('[Hermes] ✅ question 已推送到 Telegram (interactive)');
        } catch (err) {
          debugLog(startTime, 'telegram_send_done', { ok: false, error: err.message });
          console.error('[Hermes] ❌ question 推送失败:', err.message);
          return; // 发送失败，正常返回让 TUI 显示对话框
        }

        // 阻塞轮询：等待 Telegram 用户回答或超时
        const POLL_INTERVAL = 1000;
        const POLL_TIMEOUT = 5 * 60 * 1000; // 5 分钟

        debugLog(startTime, 'poll_start');
        let iteration = 0;

        while (true) {
          await new Promise(r => setTimeout(r, POLL_INTERVAL));
          iteration++;
          debugLog(startTime, 'poll_iteration', { iteration });

          let entry;
          try {
            entry = getPendingFn(uniqueId);
          } catch (_) {
            entry = null;
          }
          const result = shouldStopPolling(entry, startTime, POLL_TIMEOUT, Date.now());

          if (result.stop) {
            debugLog(startTime, 'poll_exit', { reason: result.reason, iteration });

            if (result.reason === 'answered') {
              // 更新 Telegram 消息：显示已选择的答案，移除键盘
              const answerText = entry?.answer ?? '';
              await editQuestionStatus(messageId, `✅ 已选择: ${answerText}`);
              removePendingFn(uniqueId);
              // 构建错误消息并 throw — AI 从错误信息中提取答案
              throw new Error(buildQuestionErrorMessage(questionTexts, [answerText]));
            }
            if (result.reason === 'timeout') {
              await editQuestionStatus(messageId, '⏰ 已超时，请在本地操作');
              removePendingFn(uniqueId);
              return; // 正常返回，TUI 对话框显示
            }
            if (result.reason === 'expired') {
              return; // 条目被清理，正常返回
            }
          }
        }
      } catch (err) {
        debugLog(startTime, 'catch_error', {
          name: err.name, message: err.message,
          stack: err.stack?.split('\n').slice(0, 3)
        });
        throw err; // 重新抛出（answered 路径的 throw 需要传播）
      } finally {
        debugLog(startTime, 'finally_exit', { totalMs: Date.now() - startTime });
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

  // --- Autonomy Log Helper ---

  async function appendAutonomyLog(entry) {
    try {
      const fs = await import('node:fs');
      fs.appendFileSync('/tmp/hermes-autonomy.log', JSON.stringify(entry) + '\n');
    } catch (err) {
      console.log('[Hermes] autonomy log 写入失败 (non-fatal):', err.message);
    }
  }

  // --- Debug Log Helper ---

  function debugLog(startTime, phase, context = {}) {
    if (!process.env.HERMES_DEBUG) return;
    const entry = buildDebugLogEntry(phase, Date.now() - startTime, context);
    try {
      const fs = require('node:fs');
      fs.appendFileSync('/tmp/hermes-question-debug.log',
        JSON.stringify(entry) + '\n');
    } catch (_) { }
  }

  // --- Event Handlers ---

  async function handleSessionIdle(event) {
    // DEBUG: 打印完整事件结构，用于诊断 sessionId 提取
    try {
      const fs = await import('node:fs');
      fs.appendFileSync('/tmp/hermes-idle-debug.log',
        JSON.stringify({ ts: new Date().toISOString(), event }, null, 2) + '\n---\n');
    } catch (_) { }

    // session.idle 事件不携带消息内容，需要通过 HTTP API 获取最后一条回复
    const sessionId = event.properties?.sessionID
      || event.sessionID || event.sessionId
      || event.session?.id || '';

    console.log(`[Hermes] session.idle 收到: sessionId="${sessionId}" keys=${JSON.stringify(Object.keys(event))}`);

    if (!sessionId) {
      console.log('[Hermes] 跳过 idle 事件：无 sessionId');
      return;
    }

    const startTime = Date.now();
    debugLog(startTime, 'idle_enter', { sessionId });

    // 新增：检查是否有活跃的 question
    const { isQuestionActive, getActiveQuestionId, loadStore: loadPendingStore } = await getPendingStore();
    const questionActive = isQuestionActive(sessionId);

    // 读取 store 摘要用于调试
    const store = loadPendingStore();
    debugLog(startTime, 'idle_check', {
      sessionId, questionActive,
      storeSize: Object.keys(store).length,
      questionEntries: Object.entries(store)
        .filter(([_, e]) => e.type === 'question')
        .map(([id, e]) => ({ id, sid: e.sid, hasAnswer: e.answer !== undefined, age: Date.now() - e.timestamp }))
    });

    console.log(`[Hermes] isQuestionActive("${sessionId}") = ${questionActive}`);
    if (questionActive) {
      const questionId = getActiveQuestionId(sessionId);
      debugLog(startTime, 'idle_suppressed', { questionId });
      console.log(`[Hermes] ⚠️ session.idle 被抑制：question ${questionId} 仍在等待回答`);
      await appendAutonomyLog(buildAutonomyLogEntry(
        new Date().toISOString(),
        'autonomy_suppressed',
        sessionId,
        questionId,
        '' // 不获取消息内容，避免不必要的 API 调用
      ));
      return; // 抑制通知
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

  async function editQuestionStatus(messageId, statusText) {
    if (!messageId) return;
    try {
      await fetch(`https://api.telegram.org/bot${PERMISSION_BOT_TOKEN}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHANNEL,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] }
        })
      });
      await fetch(`https://api.telegram.org/bot${PERMISSION_BOT_TOKEN}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHANNEL,
          message_id: messageId,
          text: statusText
        })
      });
    } catch (err) {
      console.log('[Hermes] editQuestionStatus 失败 (non-fatal):', err.message);
    }
  }

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

/**
 * 构建 throw Error 的消息字符串，模仿 question tool 正常完成时的输出格式。
 * AI 从错误信息中提取答案并继续执行。
 *
 * @param {string[]} questions - 问题文本列表
 * @param {string[]} answers   - 对应答案列表
 * @returns {string} 格式化的错误消息
 */
export function buildQuestionErrorMessage(questions, answers) {
  const qs = Array.isArray(questions) ? questions : [String(questions || '')];
  const as = Array.isArray(answers) ? answers : [];
  const pairs = qs.map((q, i) => `"${q}"="${as[i] || ''}"`);
  return `User has answered your questions: ${pairs.join(', ')}. You can now continue with the user's answers in mind.`;
}

/**
 * 判断轮询是否应停止。纯函数，不依赖外部状态。
 * 优先级：expired > answered > timeout > continue
 *
 * @param {object|null} entry    - pending store 条目
 * @param {number} startTime     - 轮询开始时间 (Date.now())
 * @param {number} timeout       - 超时时长 (ms)
 * @param {number} [now]         - 当前时间 (可选，默认 Date.now()，方便测试)
 * @returns {{ stop: boolean, reason?: 'answered'|'timeout'|'expired' }}
 */
export function shouldStopPolling(entry, startTime, timeout, now) {
  const currentTime = now ?? Date.now();
  if (!entry) return { stop: true, reason: 'expired' };
  if (entry.answer !== undefined) return { stop: true, reason: 'answered' };
  if (currentTime - startTime >= timeout) return { stop: true, reason: 'timeout' };
  return { stop: false };
}

/**
 * 构建自主行为检测日志条目。纯函数，用于 autonomy log (JSONL)。
 *
 * @param {string} timestamp       - ISO 8601 时间戳
 * @param {string} eventType       - 事件类型 (e.g. 'autonomy_suppressed')
 * @param {string} sessionId       - OpenCode session ID
 * @param {string|null} questionId - 活跃 question 的 uniqueId
 * @param {string} contentPreview  - 被抑制内容的预览（截断到 200 字符）
 * @returns {{ timestamp: string, event: string, sessionId: string, questionId: string|null, contentPreview: string }}
 */
export function buildAutonomyLogEntry(timestamp, eventType, sessionId, questionId, contentPreview) {
  return {
    timestamp,
    event: eventType,
    sessionId: sessionId || '',
    questionId: questionId || null,
    contentPreview: (contentPreview || '').slice(0, 200)
  };
}

/**
 * 构建调试日志条目（纯函数，可测试）。
 *
 * @param {string} phase     - 阶段名称（如 'hook_enter', 'poll_start'）
 * @param {number} elapsedMs - 距进入钩子的毫秒数
 * @param {Object} context   - 阶段特定的上下文数据
 * @returns {{ ts: string, phase: string, elapsedMs: number, [key: string]: any }}
 */
export function buildDebugLogEntry(phase, elapsedMs, context = {}) {
  return {
    ts: new Date().toISOString(),
    phase: phase ?? '',
    elapsedMs: elapsedMs ?? 0,
    ...((context && typeof context === 'object' && !Array.isArray(context)) ? context : {})
  };
}



/**
 * 根据调试日志阶段序列诊断 throw 提前发生的根因。
 *
 * 分类规则（按优先级顺序）：
 * 1. fetch_post_error — Telegram 发送完成但轮询未开始就退出
 * 2. hook_timeout    — 轮询开始但第一次迭代未完成就退出
 * 3. external_abort  — finally 执行但无 catch（非 JS 异常中止）
 * 4. code_error      — catch 块捕获到异常
 * 5. normal          — 以上均不匹配
 *
 * @param {string[]} phases - 阶段名称字符串数组
 * @returns {'fetch_post_error' | 'hook_timeout' | 'external_abort' | 'code_error' | 'normal'}
 */
export function diagnoseCause(phases) {
  if (!Array.isArray(phases)) return 'normal';

  const has = (p) => phases.includes(p);

  if (has('telegram_send_done') && !has('poll_start') && has('finally_exit')) return 'fetch_post_error';
  if (has('poll_start') && !has('poll_iteration') && has('finally_exit')) return 'hook_timeout';
  if (has('finally_exit') && !has('catch_error')) return 'external_abort';
  if (has('catch_error')) return 'code_error';

  return 'normal';
}
