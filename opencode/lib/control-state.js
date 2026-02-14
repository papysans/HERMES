/**
 * Hermes Control State Store
 *
 * 用于“转发/协同/代决策”模式、Agent 选择、接管状态与里程碑进度追踪。
 * 文件路径: /tmp/hermes-control-state.json（可由 HERMES_CONTROL_STATE_PATH 覆盖）
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  openSync,
  closeSync,
  unlinkSync
} from 'node:fs';

export const CONTROL_STATE_PATH = process.env.HERMES_CONTROL_STATE_PATH || '/tmp/hermes-control-state.json';

export const HERMES_MODES = ['forward', 'copilot', 'delegate'];
export const DEFAULT_MODE = 'forward';
export const DEFAULT_AGENT = 'sisyphus';
export const DEFAULT_SKILL_PROFILE = 'plan';
export const HERMES_SKILL_PROFILES = ['plan', 'execute', 'debug', 'review'];

const CONTROL_STATE_LOCK_WAIT_MS = Number(process.env.HERMES_CONTROL_STATE_LOCK_WAIT_MS || 2_000);
const CONTROL_STATE_FILE_MODE = parseMode(process.env.HERMES_CONTROL_STATE_MODE, 0o660);

const DEFAULT_STATE = {
  chatId: '',
  mode: DEFAULT_MODE,
  selectedAgent: DEFAULT_AGENT,
  selectedSkillProfile: DEFAULT_SKILL_PROFILE,
  takeoverActive: false,
  takeoverGoal: '',
  lastProgressAt: 0,
  activeSessionId: '',
  retryCount: 0,
  blocked: false,
  blockedReason: '',
  updatedAt: 0
};

export function skillProfileToSkill(profile) {
  const p = normalizeSkillProfile(profile);
  const map = {
    plan: 'superpowers/writing-plans',
    execute: 'superpowers/executing-plans',
    debug: 'superpowers/systematic-debugging',
    review: 'superpowers/requesting-code-review'
  };
  return map[p] || map.plan;
}

export function inferSkillProfile(goalText) {
  const t = String(goalText || '').toLowerCase();
  if (!t) return DEFAULT_SKILL_PROFILE;

  if (/(debug|排查|报错|错误|故障|queue|卡住|trace|定位|异常)/i.test(t)) return 'debug';
  if (/(review|审查|评审|code review|检查质量)/i.test(t)) return 'review';
  if (/(执行计划|execute plan|落地计划|实现方案|按计划)/i.test(t)) return 'execute';
  if (/(plan|规划|方案|设计|roadmap|拆解|brainstorm)/i.test(t)) return 'plan';

  return DEFAULT_SKILL_PROFILE;
}

function normalizeMode(mode) {
  const m = String(mode || '').trim().toLowerCase();
  if (m === 'forward') return 'forward';
  if (m === 'copilot') return 'copilot';
  if (m === 'delegate') return 'delegate';
  return DEFAULT_MODE;
}

function normalizeSkillProfile(profile) {
  const p = String(profile || '').trim().toLowerCase();
  return HERMES_SKILL_PROFILES.includes(p) ? p : DEFAULT_SKILL_PROFILE;
}

function parseMode(input, fallback) {
  if (!input) return fallback;
  const v = Number.parseInt(String(input), 8);
  return Number.isInteger(v) ? v : fallback;
}

function stateLockPath() {
  return `${CONTROL_STATE_PATH}.lock`;
}

function sleepSync(ms) {
  const arr = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(arr, 0, 0, Math.max(0, ms));
}

function withStateLock(fn) {
  const start = Date.now();
  while (true) {
    try {
      const fd = openSync(stateLockPath(), 'wx');
      try {
        return fn();
      } finally {
        try { closeSync(fd); } catch { /* ignore */ }
        try { unlinkSync(stateLockPath()); } catch { /* ignore */ }
      }
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      if (Date.now() - start >= CONTROL_STATE_LOCK_WAIT_MS) {
        throw new Error(`control-state lock timeout (${CONTROL_STATE_LOCK_WAIT_MS}ms)`);
      }
      sleepSync(15);
    }
  }
}

function normalizeState(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const merged = {
    ...DEFAULT_STATE,
    ...raw
  };
  merged.mode = normalizeMode(merged.mode);
  merged.selectedAgent = String(merged.selectedAgent || DEFAULT_AGENT);
  merged.selectedSkillProfile = normalizeSkillProfile(merged.selectedSkillProfile);
  merged.takeoverActive = Boolean(merged.takeoverActive);
  merged.takeoverGoal = String(merged.takeoverGoal || '');
  merged.chatId = String(merged.chatId || '');
  merged.activeSessionId = String(merged.activeSessionId || '');
  merged.lastProgressAt = Number(merged.lastProgressAt || 0);
  merged.retryCount = Number(merged.retryCount || 0);
  merged.blocked = Boolean(merged.blocked);
  merged.blockedReason = String(merged.blockedReason || '');
  merged.updatedAt = Number(merged.updatedAt || 0);
  return merged;
}

function loadControlStateUnsafe() {
  if (!existsSync(CONTROL_STATE_PATH)) return { ...DEFAULT_STATE };
  try {
    const parsed = JSON.parse(readFileSync(CONTROL_STATE_PATH, 'utf-8'));
    return normalizeState(parsed);
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function loadControlState() {
  return loadControlStateUnsafe();
}

function saveControlStateUnsafe(state) {
  const next = normalizeState({
    ...state,
    updatedAt: Date.now()
  });
  const payload = JSON.stringify(next, null, 2);
  writeFileSync(CONTROL_STATE_PATH, payload, { mode: CONTROL_STATE_FILE_MODE });
  try {
    chmodSync(CONTROL_STATE_PATH, CONTROL_STATE_FILE_MODE);
  } catch {
    // ignore permission hardening failures
  }
  return next;
}

export function saveControlState(state) {
  return withStateLock(() => saveControlStateUnsafe(state));
}

export function updateControlState(patch) {
  return withStateLock(() => {
    const current = loadControlStateUnsafe();
    return saveControlStateUnsafe({ ...current, ...(patch || {}) });
  });
}

export function setMode(mode) {
  return updateControlState({ mode: normalizeMode(mode) });
}

export function setSelectedAgent(agent) {
  return updateControlState({ selectedAgent: String(agent || DEFAULT_AGENT) });
}

export function setSelectedSkillProfile(profile) {
  return updateControlState({ selectedSkillProfile: normalizeSkillProfile(profile) });
}

export function startTakeover(goal, patch = {}) {
  const text = String(goal || '').trim();
  const skillProfile = normalizeSkillProfile(patch.selectedSkillProfile || inferSkillProfile(text));
  return updateControlState({
    takeoverActive: true,
    takeoverGoal: text,
    selectedSkillProfile: skillProfile,
    lastProgressAt: Date.now(),
    activeSessionId: patch.activeSessionId ?? '',
    retryCount: 0,
    blocked: false,
    blockedReason: '',
    ...patch
  });
}

export function stopTakeover(patch = {}) {
  return updateControlState({
    takeoverActive: false,
    takeoverGoal: '',
    retryCount: 0,
    blocked: false,
    blockedReason: '',
    ...patch
  });
}

export function markProgress(sessionId, patch = {}) {
  const sid = String(sessionId || '');
  return updateControlState({
    lastProgressAt: Date.now(),
    activeSessionId: sid || patch.activeSessionId || '',
    blocked: false,
    blockedReason: '',
    ...patch
  });
}

export function markBlocked(reason, patch = {}) {
  return updateControlState({
    blocked: true,
    blockedReason: String(reason || 'unknown'),
    ...patch
  });
}

export function buildTaskEnvelope({
  mode,
  selectedAgent,
  selectedSkillProfile,
  goal,
  constraints,
  acceptance
}) {
  const profile = selectedSkillProfile || inferSkillProfile(goal);
  const skill = skillProfileToSkill(profile);
  const safeMode = normalizeMode(mode);
  const agent = String(selectedAgent || DEFAULT_AGENT);
  const targetGoal = String(goal || '').trim();

  const defaultConstraints = [
    '高风险操作必须通过 Permission Bot 按钮确认，不可绕过',
    '遇到 question tool 必须等待用户回答，不可代答',
    '以里程碑方式汇报进度，发生阻塞要明确说明'
  ];
  const defaultAcceptance = [
    '先给出简短执行计划，再开始执行',
    '每个阶段完成后输出可验证结果',
    '若阻塞请给出最小下一步建议'
  ];

  const cons = Array.isArray(constraints) && constraints.length > 0 ? constraints : defaultConstraints;
  const acc = Array.isArray(acceptance) && acceptance.length > 0 ? acceptance : defaultAcceptance;

  return [
    '[HERMES_TASK_ENVELOPE]',
    `HERMES_MODE: ${safeMode}`,
    `HERMES_AGENT: ${agent}`,
    `HERMES_SKILL: ${skill}`,
    `HERMES_GOAL: ${targetGoal}`,
    'HERMES_CONSTRAINTS:',
    ...cons.map((x, i) => `${i + 1}. ${x}`),
    'HERMES_ACCEPTANCE:',
    ...acc.map((x, i) => `${i + 1}. ${x}`),
    '',
    `请显式使用技能：${skill}`,
    '完成后按里程碑汇报。'
  ].join('\n');
}
