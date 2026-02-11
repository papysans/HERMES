import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { buildPermissionMessage, assessRisk, applyWebhookPrefix } from '../hermes-hook.js';

describe('buildPermissionMessage', () => {
    it('generates structured message with sid, pid, header, command, and risk', () => {
        const msg = buildPermissionMessage(
            'ses_abc123', 'per_xyz789', 'shell', 'echo hello', 'low', ''
        );

        // Header
        expect(msg).toContain('🔴 需要确认 [shell]');
        expect(msg).toContain('命令: echo hello');
        expect(msg).toContain('风险: low');

        // Structured data fields
        expect(msg).toContain('sid: ses_abc123');
        expect(msg).toContain('pid: per_xyz789');

        // No curl commands
        expect(msg.toLowerCase()).not.toContain('curl');
        expect(msg).not.toContain('http://localhost:4096');

        // Ends with reply prompt
        expect(msg).toContain('请回复：RUN（执行一次）/ ALWAYS（始终允许）/ REJECT（拒绝）');
    });

    it('includes alwaysPattern when provided', () => {
        const msg = buildPermissionMessage(
            'ses_1', 'per_2', 'file', 'cat /etc/passwd', 'medium', '*.txt, *.md'
        );
        expect(msg).toContain('Always 模式: *.txt, *.md');
    });

    it('omits alwaysPattern line when empty', () => {
        const msg = buildPermissionMessage(
            'ses_1', 'per_2', 'shell', 'ls', 'low', ''
        );
        expect(msg).not.toContain('Always 模式');
    });
});

describe('assessRisk', () => {
    it('returns "high" for rm -rf', () => {
        expect(assessRisk('rm -rf /')).toBe('high');
    });

    it('returns "medium" for rm (without -rf)', () => {
        expect(assessRisk('rm file.txt')).toBe('medium');
    });

    it('returns "low" for echo', () => {
        expect(assessRisk('echo hello')).toBe('low');
    });

    it('returns "low" for empty/null command', () => {
        expect(assessRisk('')).toBe('low');
        expect(assessRisk(null)).toBe('low');
    });
});


/**
 * Property-Based Tests for buildPermissionMessage
 *
 * **Validates: Requirements 1.1, 1.2, 1.3, 1.4**
 *
 * Property 1: 权限消息完整性与无 curl 保证
 * For any valid sessionId, permissionId, permType, command, risk, and alwaysPattern,
 * buildPermissionMessage SHALL produce a message containing sid/pid structured fields,
 * human-readable summary (permType, command, risk), reply prompt, and SHALL NOT contain
 * any curl command strings or http://localhost:4096 URLs.
 */
describe('buildPermissionMessage — Property-Based Tests', () => {
    // Smart generators: non-empty alphanumeric strings to avoid trivial edge cases
    const arbAlphaNum = fc.stringMatching(/^[a-zA-Z0-9_-]+$/);
    const arbRisk = fc.constantFrom('low', 'medium', 'high');
    const arbAlwaysPattern = fc.oneof(fc.constant(''), arbAlphaNum);

    it('Property 1: 权限消息完整性与无 curl 保证 — 消息包含结构化数据且不含 curl 命令 (Validates: Requirements 1.1, 1.2, 1.3, 1.4)', () => {
        fc.assert(
            fc.property(
                arbAlphaNum,       // sessionId
                arbAlphaNum,       // permissionId
                arbAlphaNum,       // permType
                arbAlphaNum,       // command
                arbRisk,           // risk
                arbAlwaysPattern,  // alwaysPattern
                (sessionId, permissionId, permType, command, risk, alwaysPattern) => {
                    const msg = buildPermissionMessage(sessionId, permissionId, permType, command, risk, alwaysPattern);

                    // 1. Message contains sid and pid structured fields
                    expect(msg).toContain(`sid: ${sessionId}`);
                    expect(msg).toContain(`pid: ${permissionId}`);

                    // 2. Message contains command and risk fields
                    expect(msg).toContain(`命令: ${command}`);
                    expect(msg).toContain(`风险: ${risk}`);

                    // 3. Message contains header with permType
                    expect(msg).toContain(`🔴 需要确认 [${permType}]`);

                    // 4. Message does NOT contain any curl command (case-insensitive)
                    expect(msg.toLowerCase()).not.toContain('curl');

                    // 5. Message does NOT contain http://localhost:4096
                    expect(msg).not.toContain('http://localhost:4096');

                    // 6. alwaysPattern conditional inclusion
                    if (alwaysPattern) {
                        expect(msg).toContain(`Always 模式: ${alwaysPattern}`);
                    } else {
                        expect(msg).not.toContain('Always 模式');
                    }

                    // 7. Message contains reply prompt
                    expect(msg).toContain('请回复：RUN（执行一次）/ ALWAYS（始终允许）/ REJECT（拒绝）');
                }
            ),
            { numRuns: 100 }
        );
    });
});


/**
 * Property-Based Tests for applyWebhookPrefix
 *
 * **Validates: Requirements 2.1, 2.2, 2.3, 2.4**
 *
 * Property 2: HERMES_WEBHOOK 前缀一致性
 * For any message string passed to sendToOpenClaw, the output payload.message
 * SHALL start with `[HERMES_WEBHOOK — 转发给用户，不要自己处理]` followed by
 * the original message content.
 */
describe('applyWebhookPrefix — Property-Based Tests', () => {
    const EXPECTED_PREFIX = '[HERMES_WEBHOOK — 转发给用户，不要自己处理] ';

    it('Property 2: HERMES_WEBHOOK 前缀一致性 — 输出始终以固定前缀开头并保留原始消息 (Validates: Requirements 2.1, 2.2, 2.3, 2.4)', () => {
        fc.assert(
            fc.property(
                fc.string(),
                (message) => {
                    const result = applyWebhookPrefix(message);

                    // 1. Result starts with the fixed HERMES_WEBHOOK prefix
                    expect(result.startsWith(EXPECTED_PREFIX)).toBe(true);

                    // 2. Result ends with the original message
                    expect(result.endsWith(message)).toBe(true);

                    // 3. Result equals prefix + message exactly
                    expect(result).toBe(EXPECTED_PREFIX + message);
                }
            ),
            { numRuns: 100 }
        );
    });
});



/**
 * Property-Based Tests for buildWebhookPayload
 *
 * **Validates: Requirements 5.1, 5.3, 5.4, 3.1, 3.2**
 *
 * Property 3: Telegram 群组绑定
 * Property 5: Webhook Payload 固定字段与路由
 * For any webhook payload sent via sendToOpenClaw, the `to` field SHALL equal
 * the configured TELEGRAM_CHANNEL value (default `-5088310983`), the
 * `channel` field SHALL equal `"telegram"`, `agentId` SHALL equal `"hermes"`,
 * `wakeMode` SHALL equal `"now"`, and `message` SHALL start with HERMES_WEBHOOK prefix,
 * regardless of messageType.
 */
import { buildWebhookPayload } from '../hermes-hook.js';

describe('buildWebhookPayload — Property-Based Tests', () => {
    const EXPECTED_PREFIX = '[HERMES_WEBHOOK — 转发给用户，不要自己处理] ';
    const DEFAULT_TELEGRAM_CHANNEL = '-5088310983';

    it('Property 5: Webhook Payload 固定字段与路由 — agentId/wakeMode/channel/to/message 前缀在任意 messageType 下保持正确 (Validates: Requirements 5.4, 3.1, 3.2)', () => {
        fc.assert(
            fc.property(
                fc.string(),   // random message
                fc.string(),   // random telegramChannel
                fc.constantFrom('permission', 'notification'),  // messageType
                (message, telegramChannel, messageType) => {
                    const payload = buildWebhookPayload(message, telegramChannel, messageType);

                    // 1. payload.to equals the provided telegramChannel
                    expect(payload.to).toBe(telegramChannel);

                    // 2. payload.channel is always "telegram"
                    expect(payload.channel).toBe('telegram');

                    // 3. payload.agentId is always "hermes" (matches openclaw agent config)
                    expect(payload.agentId).toBe('hermes');

                    // 4. payload.wakeMode is always "now"
                    expect(payload.wakeMode).toBe('now');

                    // 5. payload.message starts with the HERMES_WEBHOOK prefix
                    expect(payload.message.startsWith(EXPECTED_PREFIX)).toBe(true);

                    // 6. payload.message contains the original message after the prefix
                    expect(payload.message).toBe(EXPECTED_PREFIX + message);
                }
            ),
            { numRuns: 100 }
        );
    });

    it('Property 3 (default): 当使用默认值时，payload.to 等于 "-5088310983" (Validates: Requirements 5.3)', () => {
        fc.assert(
            fc.property(
                fc.string(),   // random message
                (message) => {
                    const payload = buildWebhookPayload(message, DEFAULT_TELEGRAM_CHANNEL);

                    // Default TELEGRAM_CHANNEL is -5088310983
                    expect(payload.to).toBe('-5088310983');
                    expect(payload.channel).toBe('telegram');
                }
            ),
            { numRuns: 100 }
        );
    });
});


/**
 * Feature: hermes-agent-taming, Property 2: Session Key 按消息类型路由
 * Validates: Requirements 3.1, 3.2, 3.3
 */
describe('buildWebhookPayload — Session Key 路由 Property-Based Tests', () => {
    it('Property 2: Session Key 按消息类型路由 — permission 和 notification 使用不同 sessionKey (Validates: Requirements 3.1, 3.2, 3.3)', () => {
        fc.assert(
            fc.property(
                fc.string(),
                fc.string(),
                fc.constantFrom('permission', 'notification'),
                (message, channel, messageType) => {
                    const payload = buildWebhookPayload(message, channel, messageType);

                    if (messageType === 'permission') {
                        expect(payload.sessionKey).toBe('hermes-permissions');
                    } else {
                        expect(payload.sessionKey).toBe('hermes-notifications');
                    }
                }
            ),
            { numRuns: 100 }
        );
    });

    it('Property 2b: permission 和 notification 的 sessionKey 始终不同 (Validates: Requirements 3.3)', () => {
        fc.assert(
            fc.property(
                fc.string(),
                fc.string(),
                (message, channel) => {
                    const permPayload = buildWebhookPayload(message, channel, 'permission');
                    const notifPayload = buildWebhookPayload(message, channel, 'notification');
                    expect(permPayload.sessionKey).not.toBe(notifPayload.sessionKey);
                }
            ),
            { numRuns: 100 }
        );
    });
});


/**
 * Feature: hermes-agent-taming, Property 3: 风险评估值域
 * Validates: Requirements 4.3
 */
describe('assessRisk — 值域 Property-Based Tests', () => {
    it('Property 3: 风险评估值域 — 对任意命令字符串返回 low/medium/high 之一 (Validates: Requirements 4.3)', () => {
        fc.assert(
            fc.property(
                fc.oneof(fc.string(), fc.constant(''), fc.constant(null)),
                (command) => {
                    const result = assessRisk(command);
                    expect(['low', 'medium', 'high']).toContain(result);
                }
            ),
            { numRuns: 100 }
        );
    });
});


/**
 * Property-Based Tests for Agent 路由一致性
 *
 * **Validates: Requirements 4.7 (updated)**
 *
 * Property 4: Agent 路由一致性
 * buildWebhookPayload's agentId field SHALL equal "hermes" (matching openclaw.json agent config),
 * and models.json provider key "kiro" SHALL be preserved for API routing.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Agent 路由一致性 — Property-Based Tests', () => {
    it('Property 4a: buildWebhookPayload 始终生成 agentId === "hermes" (Validates: Requirements 4.7)', () => {
        fc.assert(
            fc.property(
                fc.string(),   // arbitrary message
                fc.string(),   // arbitrary chatId / telegramChannel
                (message, chatId) => {
                    const payload = buildWebhookPayload(message, chatId);

                    // agentId must be 'hermes' — matching openclaw.json agents.list[].id
                    // so webhook messages are routed to the Hermes agent, not Default/Coder
                    expect(payload.agentId).toBe('hermes');
                }
            ),
            { numRuns: 100 }
        );
    });

    it('Property 4b: models.json 保留 provider key "kiro" 用于 API 路由 (Validates: Requirements 4.7)', () => {
        const modelsPath = resolve(__dirname, '..', '..', '..', 'HERMES_openclaw', 'agent', 'models.json');
        const modelsContent = JSON.parse(readFileSync(modelsPath, 'utf-8'));

        // The top-level providers object must have a "kiro" key (API routing to localhost:10086)
        expect(modelsContent.providers).toHaveProperty('kiro');
    });
});
