import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
    buildPermissionMessage,
    assessRisk,
    applyWebhookPrefix,
    buildWebhookPayload,
    buildQuestionErrorMessage,
    shouldStopPolling,
    buildAutonomyLogEntry,
    buildDebugLogEntry,
    diagnoseCause
} from '../hermes-hook.js';

describe('buildPermissionMessage', () => {
    it('generates structured message with sid, pid, header, command, and risk', () => {
        const msg = buildPermissionMessage(
            'ses_abc123', 'per_xyz789', 'shell', 'echo hello', 'low', ''
        );
        expect(msg).toContain('🔴 需要确认 [shell]');
        expect(msg).toContain('命令: echo hello');
        expect(msg).toContain('风险: low');
        expect(msg).toContain('sid: ses_abc123');
        expect(msg).toContain('pid: per_xyz789');
        expect(msg.toLowerCase()).not.toContain('curl');
        expect(msg).not.toContain('http://localhost:4096');
        expect(msg).toContain('请回复：RUN（执行一次）/ ALWAYS（始终允许）/ REJECT（拒绝）');
    });

    it('includes alwaysPattern when provided', () => {
        const msg = buildPermissionMessage('ses_1', 'per_2', 'file', 'cat /etc/passwd', 'medium', '*.txt, *.md');
        expect(msg).toContain('Always 模式: *.txt, *.md');
    });

    it('omits alwaysPattern line when empty', () => {
        const msg = buildPermissionMessage('ses_1', 'per_2', 'shell', 'ls', 'low', '');
        expect(msg).not.toContain('Always 模式');
    });
});

describe('assessRisk', () => {
    it('returns "high" for rm -rf', () => { expect(assessRisk('rm -rf /')).toBe('high'); });
    it('returns "medium" for rm (without -rf)', () => { expect(assessRisk('rm file.txt')).toBe('medium'); });
    it('returns "low" for echo', () => { expect(assessRisk('echo hello')).toBe('low'); });
    it('returns "low" for empty/null command', () => {
        expect(assessRisk('')).toBe('low');
        expect(assessRisk(null)).toBe('low');
    });
});


// --- PBT: buildPermissionMessage ---
describe('buildPermissionMessage — Property-Based Tests', () => {
    const arbAlphaNum = fc.stringMatching(/^[a-zA-Z0-9_-]+$/);
    const arbRisk = fc.constantFrom('low', 'medium', 'high');
    const arbAlwaysPattern = fc.oneof(fc.constant(''), arbAlphaNum);

    it('Property 1: 权限消息完整性与无 curl 保证 (Validates: Requirements 1.1, 1.2, 1.3, 1.4)', () => {
        fc.assert(fc.property(
            arbAlphaNum, arbAlphaNum, arbAlphaNum, arbAlphaNum, arbRisk, arbAlwaysPattern,
            (sessionId, permissionId, permType, command, risk, alwaysPattern) => {
                const msg = buildPermissionMessage(sessionId, permissionId, permType, command, risk, alwaysPattern);
                expect(msg).toContain(`sid: ${sessionId}`);
                expect(msg).toContain(`pid: ${permissionId}`);
                expect(msg).toContain(`命令: ${command}`);
                expect(msg).toContain(`风险: ${risk}`);
                expect(msg).toContain(`🔴 需要确认 [${permType}]`);
                expect(msg.toLowerCase()).not.toContain('curl');
                expect(msg).not.toContain('http://localhost:4096');
                if (alwaysPattern) { expect(msg).toContain(`Always 模式: ${alwaysPattern}`); }
                else { expect(msg).not.toContain('Always 模式'); }
                expect(msg).toContain('请回复：RUN（执行一次）/ ALWAYS（始终允许）/ REJECT（拒绝）');
            }
        ), { numRuns: 100 });
    });
});


// --- PBT: applyWebhookPrefix ---
describe('applyWebhookPrefix — Property-Based Tests', () => {
    const EXPECTED_PREFIX = '[HERMES_WEBHOOK — 转发给用户，不要自己处理] ';
    it('Property 2: HERMES_WEBHOOK 前缀一致性 (Validates: Requirements 2.1, 2.2, 2.3, 2.4)', () => {
        fc.assert(fc.property(fc.string(), (message) => {
            const result = applyWebhookPrefix(message);
            expect(result.startsWith(EXPECTED_PREFIX)).toBe(true);
            expect(result.endsWith(message)).toBe(true);
            expect(result).toBe(EXPECTED_PREFIX + message);
        }), { numRuns: 100 });
    });
});


// --- PBT: buildWebhookPayload ---
describe('buildWebhookPayload — Property-Based Tests', () => {
    const EXPECTED_PREFIX = '[HERMES_WEBHOOK — 转发给用户，不要自己处理] ';
    it('Property 5: Webhook Payload 固定字段与路由 (Validates: Requirements 5.4, 3.1, 3.2)', () => {
        fc.assert(fc.property(
            fc.string(), fc.string(), fc.constantFrom('permission', 'notification'),
            (message, telegramChannel, messageType) => {
                const payload = buildWebhookPayload(message, telegramChannel, messageType);
                expect(payload.to).toBe(telegramChannel);
                expect(payload.channel).toBe('telegram');
                expect(payload.agentId).toBe('hermes');
                expect(payload.wakeMode).toBe('now');
                expect(payload.deliver).toBe(true);
                expect(payload.message).toBe(EXPECTED_PREFIX + message);
            }
        ), { numRuns: 100 });
    });

    it('Property 3 (default): payload.to 等于 "-5088310983" (Validates: Requirements 5.3)', () => {
        fc.assert(fc.property(fc.string(), (message) => {
            const payload = buildWebhookPayload(message, '-5088310983');
            expect(payload.to).toBe('-5088310983');
        }), { numRuns: 100 });
    });
});


// --- PBT: Session Key routing ---
describe('buildWebhookPayload — Session Key 路由', () => {
    it('Property 2: permission/notification 使用不同 sessionKey (Validates: Requirements 3.1, 3.2, 3.3)', () => {
        fc.assert(fc.property(
            fc.string(), fc.string(), fc.constantFrom('permission', 'notification'),
            (message, channel, messageType) => {
                const payload = buildWebhookPayload(message, channel, messageType);
                if (messageType === 'permission') expect(payload.sessionKey).toBe('hermes-permissions');
                else expect(payload.sessionKey).toBe('hermes-notifications');
            }
        ), { numRuns: 100 });
    });
});


// --- PBT: assessRisk 值域 ---
describe('assessRisk — 值域 Property-Based Tests', () => {
    it('Property 3: 对任意命令返回 low/medium/high 之一 (Validates: Requirements 4.3)', () => {
        fc.assert(fc.property(
            fc.oneof(fc.string(), fc.constant(''), fc.constant(null)),
            (command) => { expect(['low', 'medium', 'high']).toContain(assessRisk(command)); }
        ), { numRuns: 100 });
    });
});


// --- PBT: Agent 路由一致性 ---
describe('Agent 路由一致性 — Property-Based Tests', () => {
    it('Property 4a: agentId === "hermes" 且 deliver === true (Validates: Requirements 4.7)', () => {
        fc.assert(fc.property(fc.string(), fc.string(), (message, chatId) => {
            const payload = buildWebhookPayload(message, chatId);
            expect(payload.agentId).toBe('hermes');
            expect(payload.deliver).toBe(true);
        }), { numRuns: 100 });
    });
});


// --- Unit: buildQuestionErrorMessage ---
describe('buildQuestionErrorMessage', () => {
    it('single question-answer pair', () => {
        const msg = buildQuestionErrorMessage(['你想做什么？'], ['Web App']);
        expect(msg).toBe('User has answered your questions: "你想做什么？"="Web App". You can now continue with the user\'s answers in mind.');
    });
    it('multiple pairs', () => {
        const msg = buildQuestionErrorMessage(['问题1', '问题2'], ['答案1', '答案2']);
        expect(msg).toBe('User has answered your questions: "问题1"="答案1", "问题2"="答案2". You can now continue with the user\'s answers in mind.');
    });
    it('missing answer uses empty string', () => {
        expect(buildQuestionErrorMessage(['q1', 'q2'], ['a1'])).toContain('"q2"=""');
    });
    it('empty arrays', () => {
        expect(buildQuestionErrorMessage([], [])).toBe('User has answered your questions: . You can now continue with the user\'s answers in mind.');
    });
});


// --- PBT: Property 1 — buildQuestionErrorMessage 消息格式完整性 ---
describe('buildQuestionErrorMessage — Property-Based Tests', () => {
    const arbQ = fc.stringMatching(/^[^"]{1,50}$/);
    const arbA = fc.stringMatching(/^[^"]{1,50}$/);
    it('Property 1: 前缀、后缀、键值对格式和分隔符 (Validates: Requirements 2.1, 2.2, 2.3, 2.4)', () => {
        fc.assert(fc.property(
            fc.array(arbQ, { minLength: 1, maxLength: 10 }),
            fc.array(arbA, { minLength: 1, maxLength: 10 }),
            (questions, answers) => {
                const msg = buildQuestionErrorMessage(questions, answers);
                const PREFIX = 'User has answered your questions: ';
                const SUFFIX = '. You can now continue with the user\'s answers in mind.';
                expect(msg.startsWith(PREFIX)).toBe(true);
                expect(msg.endsWith(SUFFIX)).toBe(true);
                for (let i = 0; i < questions.length; i++) {
                    expect(msg).toContain(`"${questions[i]}"="${answers[i] || ''}"`);
                }
                const middle = msg.slice(PREFIX.length, msg.length - SUFFIX.length);
                const expected = questions.map((q, i) => `"${q}"="${answers[i] || ''}"`);
                expect(middle).toBe(expected.join(', '));
            }
        ), { numRuns: 100 });
    });
});


// --- PBT: Property 2 — shouldStopPolling 决策正确性 ---
describe('shouldStopPolling — Property-Based Tests', () => {
    const arbStart = fc.integer({ min: 0, max: 1e12 });
    const arbTimeout = fc.integer({ min: 1, max: 1e9 });

    it('Property 2a: null/undefined → expired (Validates: Requirement 3.5)', () => {
        fc.assert(fc.property(
            fc.constantFrom(null, undefined), arbStart, arbTimeout, fc.integer({ min: 0, max: 1e12 }),
            (entry, s, t, now) => {
                expect(shouldStopPolling(entry, s, t, now)).toEqual({ stop: true, reason: 'expired' });
            }
        ), { numRuns: 100 });
    });

    it('Property 2b: entry with answer → answered (Validates: Requirement 3.2)', () => {
        fc.assert(fc.property(
            fc.record({ answer: fc.oneof(fc.string(), fc.constant(''), fc.constant(0)), type: fc.constant('question') }),
            arbStart, arbTimeout, fc.integer({ min: 0, max: 1e12 }),
            (entry, s, t, now) => {
                expect(shouldStopPolling(entry, s, t, now)).toEqual({ stop: true, reason: 'answered' });
            }
        ), { numRuns: 100 });
    });

    it('Property 2c: no answer + timed out → timeout (Validates: Requirement 3.3)', () => {
        fc.assert(fc.property(
            fc.record({ type: fc.constant('question') }), arbStart, arbTimeout,
            (entry, s, t) => {
                const now = s + t;
                expect(shouldStopPolling(entry, s, t, now)).toEqual({ stop: true, reason: 'timeout' });
            }
        ), { numRuns: 100 });
    });

    it('Property 2d: no answer + not timed out → continue (Validates: Requirement 3.4)', () => {
        fc.assert(fc.property(
            fc.record({ type: fc.constant('question') }), arbStart, fc.integer({ min: 2, max: 1e9 }),
            (entry, s, t) => {
                const now = s + Math.floor(t / 2);
                expect(shouldStopPolling(entry, s, t, now)).toEqual({ stop: false });
            }
        ), { numRuns: 100 });
    });

    it('Property 2e: expired beats timeout (Validates: Requirements 3.2-3.5)', () => {
        fc.assert(fc.property(arbStart, arbTimeout, (s, t) => {
            expect(shouldStopPolling(null, s, t, s + t + 1000).reason).toBe('expired');
        }), { numRuns: 100 });
    });
});


// --- PBT: Property 4 — 回调数据路由互斥性 ---
import { parseCallbackData, actionToResponse, isQuestionCallback, parseQuestionCallback } from './permission-listener.js';

describe('回调数据路由互斥性 — Property-Based Tests', () => {
    it('Property 4: 权限回调和问题回调路由不冲突 (Validates: Requirement 7.2)', () => {
        fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 100 }), (data) => {
            const isQuestion = isQuestionCallback(data);
            const parsed = parseCallbackData(data);
            const isPermission = parsed !== null && actionToResponse(parsed.action) !== null;
            // They should never both be true
            expect(isQuestion && isPermission).toBe(false);
        }), { numRuns: 100 });
    });

    it('Property 4b: 已知权限前缀不触发问题路由', () => {
        fc.assert(fc.property(
            fc.constantFrom('run', 'always', 'reject'),
            fc.stringMatching(/^[a-zA-Z0-9_-]+$/),
            (action, id) => {
                const data = `${action}:${id}`;
                expect(isQuestionCallback(data)).toBe(false);
                expect(parseQuestionCallback(data)).toBeNull();
            }
        ), { numRuns: 100 });
    });

    it('Property 4c: 已知问题前缀不触发权限路由', () => {
        fc.assert(fc.property(fc.stringMatching(/^[a-zA-Z0-9_-]+$/), (id) => {
            const optData = `qopt:${id}:0`;
            const customData = `qcustom:${id}`;
            for (const data of [optData, customData]) {
                const parsed = parseCallbackData(data);
                if (parsed) expect(actionToResponse(parsed.action)).toBeNull();
            }
        }), { numRuns: 100 });
    });
});


// --- PBT: Property 3 — Pending Store answer round-trip ---
import { addPending, updatePending, getPending, removePending } from './pending-store.js';

describe('Pending Store answer round-trip — Property-Based Tests', () => {
    it('Property 3: addPending → updatePending(answer) → getPending 返回相同 answer (Validates: Requirements 5.2, 5.5)', () => {
        fc.assert(fc.property(
            fc.stringMatching(/^[a-zA-Z0-9_-]{1,30}$/),
            fc.string({ minLength: 1, maxLength: 100 }),
            (uniqueId, answer) => {
                const testId = `test_prop3_${uniqueId}`;
                try {
                    addPending(testId, { type: 'question', timestamp: Date.now() });
                    updatePending(testId, { answer });
                    const entry = getPending(testId);
                    expect(entry).not.toBeNull();
                    expect(entry.answer).toBe(answer);
                } finally {
                    removePending(testId);
                }
            }
        ), { numRuns: 100 });
    });
});

// --- PBT: Property 1 (hermes-agent-question-autonomy) — isQuestionActive/getActiveQuestionId consistency ---
import { isQuestionActive, getActiveQuestionId, QUESTION_TTL_MS, loadStore, saveStore } from './pending-store.js';

describe('isQuestionActive/getActiveQuestionId consistency — Property-Based Tests', () => {
    const now = Date.now();

    // Arbitrary: generate a store entry that is either question or permission type
    const arbSessionId = fc.constantFrom('ses_aaa', 'ses_bbb', 'ses_ccc');

    const arbQuestionEntry = fc.record({
        type: fc.constant('question'),
        sid: arbSessionId,
        answer: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1, maxLength: 20 })),
        timestamp: fc.integer({ min: now - QUESTION_TTL_MS * 2, max: now + 60000 }),
    });

    const arbPermissionEntry = fc.record({
        type: fc.constant('permission'),
        sid: arbSessionId,
        command: fc.string({ minLength: 1, maxLength: 30 }),
        timestamp: fc.integer({ min: now - 40 * 60 * 1000, max: now + 60000 }),
    });

    const arbEntry = fc.oneof(arbQuestionEntry, arbPermissionEntry);

    const arbStore = fc.array(
        fc.tuple(fc.stringMatching(/^[a-z0-9]{4,8}$/), arbEntry),
        { minLength: 0, maxLength: 10 }
    ).map(pairs => Object.fromEntries(pairs));

    /**
     * **Validates: Requirements 1.3, 1.4, 6.2**
     *
     * Property 1: isQuestionActive/getActiveQuestionId consistency
     * For any store state and sessionId, isQuestionActive(sid) === true ⟺ getActiveQuestionId(sid) !== null
     */
    it('Property 1: isQuestionActive(sid) === true ⟺ getActiveQuestionId(sid) !== null', () => {
        fc.assert(fc.property(
            arbStore, arbSessionId,
            (store, sessionId) => {
                // Write the generated store state
                saveStore(store);
                try {
                    const active = isQuestionActive(sessionId);
                    const activeId = getActiveQuestionId(sessionId);

                    // Core consistency property
                    if (active) {
                        expect(activeId).not.toBeNull();
                    } else {
                        expect(activeId).toBeNull();
                    }
                } finally {
                    // Clean up
                    saveStore({});
                }
            }
        ), { numRuns: 100 });
    });
});



// --- PBT: Property 5 (hermes-agent-question-autonomy) — cleanExpired question TTL ---
import { vi } from 'vitest';
import { cleanExpired } from './pending-store.js';

describe('cleanExpired question TTL — Property-Based Tests', () => {
    const QUESTION_TTL = 6 * 60 * 1000;   // 6 minutes
    const PERMISSION_TTL = 30 * 60 * 1000; // 30 minutes

    const arbSessionId = fc.constantFrom('ses_aaa', 'ses_bbb', 'ses_ccc');

    // Unanswered question entry (uses 6 min TTL)
    const arbUnansweredQuestion = fc.record({
        type: fc.constant('question'),
        sid: arbSessionId,
        timestamp: fc.integer({ min: 1, max: 2e12 }),
    });

    // Answered question entry (uses 30 min TTL)
    const arbAnsweredQuestion = fc.record({
        type: fc.constant('question'),
        sid: arbSessionId,
        answer: fc.string({ minLength: 1, maxLength: 20 }),
        timestamp: fc.integer({ min: 1, max: 2e12 }),
    });

    // Permission entry (uses 30 min TTL)
    const arbPermissionEntry = fc.record({
        type: fc.constant('permission'),
        sid: arbSessionId,
        command: fc.string({ minLength: 1, maxLength: 30 }),
        timestamp: fc.integer({ min: 1, max: 2e12 }),
    });

    const arbEntry = fc.oneof(arbUnansweredQuestion, arbAnsweredQuestion, arbPermissionEntry);

    const arbStore = fc.array(
        fc.tuple(fc.stringMatching(/^[a-z0-9]{4,8}$/), arbEntry),
        { minLength: 0, maxLength: 10 }
    ).map(pairs => Object.fromEntries(pairs));

    // "now" relative to entry timestamps — pick a time that makes some entries expired and some not
    const arbNow = fc.integer({ min: 1, max: 2e12 + PERMISSION_TTL + 60000 });

    /**
     * **Validates: Requirements 6.1**
     *
     * Property 5: cleanExpired question TTL
     * For any store state and current time:
     * - Unanswered question entries (type=question, answer=undefined) older than 6 min are removed
     * - Answered question entries use 30 min TTL
     * - Permission entries use 30 min TTL
     * - Entries within their respective TTL are preserved
     */
    it('Property 5: cleanExpired correctly differentiates question (6 min) vs permission (30 min) TTL', () => {
        fc.assert(fc.property(
            arbStore, arbNow,
            (store, now) => {
                // Write the generated store state
                saveStore(store);

                // Mock Date.now to control "current time"
                const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
                try {
                    cleanExpired();
                    const remaining = loadStore();

                    for (const [id, entry] of Object.entries(store)) {
                        const isUnansweredQuestion = entry.type === 'question' && entry.answer === undefined;
                        const ttl = isUnansweredQuestion ? QUESTION_TTL : PERMISSION_TTL;
                        const age = now - entry.timestamp;

                        if (age > ttl) {
                            // Should have been removed
                            expect(remaining).not.toHaveProperty(id);
                        } else {
                            // Should be preserved
                            expect(remaining).toHaveProperty(id);
                            expect(remaining[id]).toEqual(entry);
                        }
                    }
                } finally {
                    spy.mockRestore();
                    saveStore({});
                }
            }
        ), { numRuns: 100 });
    });
});

// --- PBT: Property 2 (hermes-agent-question-autonomy) — session.idle suppression correctness ---
describe('session.idle suppression correctness — Property-Based Tests', () => {
    const arbSessionId = fc.constantFrom('ses_aaa', 'ses_bbb', 'ses_ccc', 'ses_ddd');

    const arbQuestionEntry = fc.record({
        type: fc.constant('question'),
        sid: arbSessionId,
        answer: fc.oneof(fc.constant(undefined), fc.string({ minLength: 1, maxLength: 20 })),
        timestamp: fc.integer({ min: Date.now() - QUESTION_TTL_MS * 2, max: Date.now() + 60000 }),
    });

    const arbPermissionEntry = fc.record({
        type: fc.constant('permission'),
        sid: arbSessionId,
        command: fc.string({ minLength: 1, maxLength: 30 }),
        timestamp: fc.integer({ min: Date.now() - 40 * 60 * 1000, max: Date.now() + 60000 }),
    });

    const arbEntry = fc.oneof(arbQuestionEntry, arbPermissionEntry);

    const arbStore = fc.array(
        fc.tuple(fc.stringMatching(/^[a-z0-9]{4,8}$/), arbEntry),
        { minLength: 0, maxLength: 10 }
    ).map(pairs => Object.fromEntries(pairs));

    /**
     * **Validates: Requirements 2.1, 2.3**
     *
     * Property 2: session.idle suppression correctness
     * For any store state and sessionId, the suppression decision (isQuestionActive)
     * returns true ⟺ there exists an unanswered, non-expired question entry matching that sessionId.
     * This is the exact condition used by handleSessionIdle to suppress PHASE_COMPLETE notifications.
     */
    it('Property 2: suppression decision equals manual computation of active question existence', () => {
        fc.assert(fc.property(
            arbStore, arbSessionId,
            (store, sessionId) => {
                saveStore(store);
                try {
                    const now = Date.now();

                    // Manual computation: should suppress iff there exists an active question
                    const manualShouldSuppress = Object.values(store).some(entry =>
                        entry.type === 'question'
                        && entry.sid === sessionId
                        && entry.answer === undefined
                        && (now - entry.timestamp) < QUESTION_TTL_MS
                    );

                    // Actual suppression decision
                    const actualSuppression = isQuestionActive(sessionId);

                    expect(actualSuppression).toBe(manualShouldSuppress);
                } finally {
                    saveStore({});
                }
            }
        ), { numRuns: 100 });
    });
});



// --- PBT: Property 4 (hermes-agent-question-autonomy) — autonomy log entry format ---
describe('buildAutonomyLogEntry — Property-Based Tests', () => {
    const arbTimestamp = fc.oneof(
        fc.date().map(d => d.toISOString()),
        fc.string({ minLength: 0, maxLength: 50 })
    );
    const arbEventType = fc.string({ minLength: 0, maxLength: 50 });
    const arbSessionId = fc.oneof(fc.string({ minLength: 0, maxLength: 50 }), fc.constant(null), fc.constant(undefined), fc.constant(''));
    const arbQuestionId = fc.oneof(fc.string({ minLength: 1, maxLength: 50 }), fc.constant(null), fc.constant(undefined), fc.constant(''));
    const arbContentPreview = fc.oneof(
        fc.string({ minLength: 0, maxLength: 50 }),
        fc.string({ minLength: 200, maxLength: 500 }),
        fc.constant(null),
        fc.constant(undefined),
        fc.constant('')
    );

    /**
     * **Validates: Requirements 5.1, 5.3**
     *
     * Property 4: autonomy log entry format
     * For any input parameters, buildAutonomyLogEntry produces a valid object that:
     * - Can be serialized to JSON via JSON.stringify
     * - Has all required fields: timestamp, event, sessionId, questionId, contentPreview
     * - contentPreview length is ≤ 200 characters
     * - sessionId is always a string (never null/undefined)
     * - questionId is either a string or null (never undefined)
     */
    it('Property 4: output is valid JSON with all required fields and contentPreview ≤ 200 chars', () => {
        fc.assert(fc.property(
            arbTimestamp, arbEventType, arbSessionId, arbQuestionId, arbContentPreview,
            (timestamp, eventType, sessionId, questionId, contentPreview) => {
                const entry = buildAutonomyLogEntry(timestamp, eventType, sessionId, questionId, contentPreview);

                // Must be serializable to valid JSON
                const json = JSON.stringify(entry);
                expect(json).toBeDefined();
                const parsed = JSON.parse(json);
                expect(parsed).toEqual(entry);

                // All required fields must exist
                expect(entry).toHaveProperty('timestamp');
                expect(entry).toHaveProperty('event');
                expect(entry).toHaveProperty('sessionId');
                expect(entry).toHaveProperty('questionId');
                expect(entry).toHaveProperty('contentPreview');

                // contentPreview ≤ 200 characters
                expect(entry.contentPreview.length).toBeLessThanOrEqual(200);

                // sessionId is always a string (never null/undefined)
                expect(typeof entry.sessionId).toBe('string');

                // questionId is either a string or null (never undefined)
                expect(entry.questionId === null || typeof entry.questionId === 'string').toBe(true);
                expect(entry.questionId).not.toBe(undefined);
            }
        ), { numRuns: 100 });
    });
});


// --- PBT: Property 3 (hermes-agent-question-autonomy) — question callback no prompt_async ---
describe('question callback no prompt_async — Property-Based Tests', () => {
    const arbUniqueId = fc.stringMatching(/^[a-zA-Z0-9_-]{1,30}$/);
    const arbOptionIndex = fc.integer({ min: 0, max: 99 });

    // Generator for valid qopt callback data: qopt:<uniqueId>:<optionIndex>
    const arbQoptData = fc.tuple(arbUniqueId, arbOptionIndex).map(
        ([uid, idx]) => ({ data: `qopt:${uid}:${idx}`, uniqueId: uid, optionIndex: idx, type: 'option' })
    );

    // Generator for valid qcustom callback data: qcustom:<uniqueId>
    const arbQcustomData = arbUniqueId.map(
        uid => ({ data: `qcustom:${uid}`, uniqueId: uid, type: 'custom' })
    );

    // Combined: either qopt or qcustom
    const arbQuestionCallback = fc.oneof(arbQoptData, arbQcustomData);

    /**
     * **Validates: Requirements 3.1, 3.2**
     *
     * Property 3: question callback no prompt_async
     * For any valid question callback data (qopt:* or qcustom:*):
     * - isQuestionCallback returns true
     * - parseQuestionCallback returns a non-null result with correct type and fields
     * - qopt callbacks have type 'option', correct uniqueId, and valid optionIndex
     * - qcustom callbacks have type 'custom' and correct uniqueId
     */
    it('Property 3: valid question callbacks are correctly identified and parsed', () => {
        fc.assert(fc.property(arbQuestionCallback, (cb) => {
            // isQuestionCallback must return true for valid question callback data
            expect(isQuestionCallback(cb.data)).toBe(true);

            // parseQuestionCallback must return a non-null result
            const parsed = parseQuestionCallback(cb.data);
            expect(parsed).not.toBeNull();

            // Type must match
            expect(parsed.type).toBe(cb.type);

            // UniqueId must match
            expect(parsed.uniqueId).toBe(cb.uniqueId);

            if (cb.type === 'option') {
                // Option callbacks must have correct optionIndex
                expect(parsed.optionIndex).toBe(cb.optionIndex);
            }
            // Custom callbacks only need type and uniqueId (already verified above)
        }), { numRuns: 100 });
    });
});


// --- PBT: Feature hermes-question-throw-timing, Property 1 — Debug Log 条目格式完整性 ---
describe('buildDebugLogEntry — Property-Based Tests (hermes-question-throw-timing)', () => {
    /**
     * **Validates: Requirements 1.1, 1.2**
     *
     * Feature: hermes-question-throw-timing, Property 1: Debug Log 条目格式完整性
     *
     * For any non-empty phase string, non-negative integer elapsedMs, and any context object,
     * buildDebugLogEntry(phase, elapsedMs, context) SHALL:
     * - contain a `ts` field that is a valid ISO 8601 timestamp
     * - contain a `phase` field equal to the input phase
     * - contain an `elapsedMs` field equal to the input elapsedMs
     * - preserve all key-value pairs from the context object in the output
     */
    it('Feature: hermes-question-throw-timing, Property 1: Debug Log 条目格式完整性', () => {
        const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

        fc.assert(fc.property(
            fc.string({ minLength: 1 }),
            fc.nat(),
            fc.dictionary(
                fc.stringMatching(/^[a-zA-Z_][a-zA-Z0-9_]{0,20}$/),
                fc.jsonValue()
            ),
            (phase, elapsedMs, context) => {
                const entry = buildDebugLogEntry(phase, elapsedMs, context);

                // ts is a valid ISO 8601 timestamp
                expect(entry).toHaveProperty('ts');
                expect(typeof entry.ts).toBe('string');
                expect(ISO_8601_REGEX.test(entry.ts)).toBe(true);
                expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);

                // phase equals input
                expect(entry.phase).toBe(phase);

                // elapsedMs equals input
                expect(entry.elapsedMs).toBe(elapsedMs);

                // all context key-value pairs are preserved
                for (const [key, value] of Object.entries(context)) {
                    // skip keys that collide with built-in fields
                    if (key === 'ts' || key === 'phase' || key === 'elapsedMs') continue;
                    expect(entry[key]).toEqual(value);
                }
            }
        ), { numRuns: 100 });
    });
});


// --- PBT: Feature hermes-question-throw-timing, Property 2 — 诊断分类正确性 ---
describe('diagnoseCause — Property-Based Tests (hermes-question-throw-timing)', () => {
    const ALL_PHASES = [
        'hook_enter', 'params_extracted', 'telegram_send_start', 'telegram_send_done',
        'poll_start', 'poll_iteration', 'poll_exit', 'catch_error', 'finally_exit', 'idle_check'
    ];

    const VALID_DIAGNOSES = new Set([
        'fetch_post_error', 'hook_timeout', 'external_abort', 'code_error', 'normal'
    ]);

    /**
     * **Validates: Requirements 2.2, 2.3, 2.4**
     *
     * Feature: hermes-question-throw-timing, Property 2: 诊断分类正确性
     *
     * For any subset of known debug log phases, diagnoseCause(phases) SHALL:
     * - Always return a value in {'fetch_post_error', 'hook_timeout', 'external_abort', 'code_error', 'normal'}
     * - Classify according to priority-ordered rules:
     *   1. telegram_send_done ∈ phases AND poll_start ∉ phases AND finally_exit ∈ phases → 'fetch_post_error'
     *   2. poll_start ∈ phases AND poll_iteration ∉ phases AND finally_exit ∈ phases → 'hook_timeout'
     *   3. finally_exit ∈ phases AND catch_error ∉ phases → 'external_abort'
     *   4. catch_error ∈ phases → 'code_error'
     *   5. otherwise → 'normal'
     */
    it('Feature: hermes-question-throw-timing, Property 2: 诊断分类正确性', () => {
        fc.assert(fc.property(
            fc.subarray(ALL_PHASES),
            (phases) => {
                const result = diagnoseCause(phases);

                // Return value is always one of the 5 valid diagnoses
                expect(VALID_DIAGNOSES.has(result)).toBe(true);

                // Compute expected diagnosis using priority-ordered rules
                const has = (p) => phases.includes(p);
                let expected;
                if (has('telegram_send_done') && !has('poll_start') && has('finally_exit')) {
                    expected = 'fetch_post_error';
                } else if (has('poll_start') && !has('poll_iteration') && has('finally_exit')) {
                    expected = 'hook_timeout';
                } else if (has('finally_exit') && !has('catch_error')) {
                    expected = 'external_abort';
                } else if (has('catch_error')) {
                    expected = 'code_error';
                } else {
                    expected = 'normal';
                }

                expect(result).toBe(expected);
            }
        ), { numRuns: 100 });
    });
});

describe('diagnoseCause — Unit Tests (hermes-question-throw-timing)', () => {
    // --- Edge cases: non-array / empty inputs ---

    it('returns "normal" for empty array', () => {
        expect(diagnoseCause([])).toBe('normal');
    });

    it('returns "normal" for null', () => {
        expect(diagnoseCause(null)).toBe('normal');
    });

    it('returns "normal" for undefined', () => {
        expect(diagnoseCause(undefined)).toBe('normal');
    });

    it('returns "normal" for non-array inputs (string, number, object)', () => {
        expect(diagnoseCause('hook_enter')).toBe('normal');
        expect(diagnoseCause(42)).toBe('normal');
        expect(diagnoseCause({ phase: 'hook_enter' })).toBe('normal');
    });

    // --- Only hook_enter (no finally_exit, no catch_error) ---

    it('returns "normal" when only hook_enter is present', () => {
        expect(diagnoseCause(['hook_enter'])).toBe('normal');
    });

    // --- Sequence without finally_exit and without catch_error → normal ---

    it('returns "normal" for sequence without finally_exit and without catch_error', () => {
        expect(diagnoseCause([
            'hook_enter', 'params_extracted', 'telegram_send_start',
            'telegram_send_done', 'poll_start', 'poll_iteration', 'poll_exit'
        ])).toBe('normal');
    });

    // --- fetch_post_error: has telegram_send_done + finally_exit, no poll_start ---

    it('returns "fetch_post_error" when telegram_send_done + finally_exit but no poll_start', () => {
        expect(diagnoseCause([
            'hook_enter', 'params_extracted', 'telegram_send_start',
            'telegram_send_done', 'finally_exit'
        ])).toBe('fetch_post_error');
    });

    // --- hook_timeout: has poll_start + finally_exit, no poll_iteration ---

    it('returns "hook_timeout" when poll_start + finally_exit but no poll_iteration', () => {
        expect(diagnoseCause([
            'hook_enter', 'params_extracted', 'telegram_send_done',
            'poll_start', 'finally_exit'
        ])).toBe('hook_timeout');
    });

    // --- external_abort: has finally_exit, no catch_error ---

    it('returns "external_abort" when finally_exit present but no catch_error', () => {
        expect(diagnoseCause([
            'hook_enter', 'params_extracted', 'telegram_send_done',
            'poll_start', 'poll_iteration', 'finally_exit'
        ])).toBe('external_abort');
    });

    // --- code_error: has catch_error ---

    it('returns "code_error" when catch_error is present (no finally_exit)', () => {
        expect(diagnoseCause(['hook_enter', 'catch_error'])).toBe('code_error');
    });

    // --- code_error with finally_exit: catch_error present, but no telegram_send_done/poll_start ---

    it('returns "code_error" when catch_error + finally_exit but no telegram_send_done/poll_start', () => {
        expect(diagnoseCause(['hook_enter', 'catch_error', 'finally_exit'])).toBe('code_error');
    });

    // --- Priority: fetch_post_error takes precedence over code_error ---

    it('returns "fetch_post_error" over "code_error" when both conditions match', () => {
        // Has telegram_send_done, no poll_start, has finally_exit → fetch_post_error (rule 1)
        // Also has catch_error → would be code_error (rule 4) but rule 1 wins
        expect(diagnoseCause([
            'telegram_send_done', 'catch_error', 'finally_exit'
        ])).toBe('fetch_post_error');
    });
});
