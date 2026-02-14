/**
 * Pending Permission Store
 *
 * 基于 JSON 文件的跨进程共享存储，用于 hermes-hook.js 和 permission-listener.js
 * 之间共享待处理的权限请求数据（sid, pid, command 等）。
 *
 * 文件路径: /tmp/hermes-pending.json（可由 HERMES_PENDING_STORE_PATH 覆盖）
 * 写入策略: 文件锁 + 直接写入，避免 /tmp sticky 目录 rename EACCES 与并发覆盖
 * TTL: 30 分钟
 */

import {
    readFileSync,
    writeFileSync,
    existsSync,
    chmodSync,
    openSync,
    closeSync,
    unlinkSync
} from 'node:fs';

let STORE_PATH = process.env.HERMES_PENDING_STORE_PATH || '/tmp/hermes-pending.json';
const STORE_LOCK_WAIT_MS = Number(process.env.HERMES_PENDING_STORE_LOCK_WAIT_MS || 2_000);
const STORE_FILE_MODE = parseMode(process.env.HERMES_PENDING_STORE_MODE, 0o600);
const TTL_MS = 30 * 60 * 1000; // 30 minutes
export const QUESTION_TTL_MS = 30 * 60 * 1000; // 30 分钟（与主 TTL 对齐）

function parseMode(input, fallback) {
    if (!input) return fallback;
    const v = Number.parseInt(String(input), 8);
    return Number.isInteger(v) ? v : fallback;
}

function lockPath() {
    return `${STORE_PATH}.lock`;
}

function sleepSync(ms) {
    const arr = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(arr, 0, 0, Math.max(0, ms));
}

function withStoreLock(fn) {
    const start = Date.now();
    while (true) {
        try {
            const fd = openSync(lockPath(), 'wx');
            try {
                return fn();
            } finally {
                try { closeSync(fd); } catch { /* ignore */ }
                try { unlinkSync(lockPath()); } catch { /* ignore */ }
            }
        } catch (err) {
            if (err?.code !== 'EEXIST') throw err;
            if (Date.now() - start >= STORE_LOCK_WAIT_MS) {
                throw new Error(`pending-store lock timeout (${STORE_LOCK_WAIT_MS}ms)`);
            }
            sleepSync(15);
        }
    }
}

function readStoreFromDisk() {
    if (!existsSync(STORE_PATH)) return {};
    try {
        const raw = readFileSync(STORE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

function writeStoreToDisk(store) {
    const payload = JSON.stringify(store, null, 2);
    writeFileSync(STORE_PATH, payload, { mode: STORE_FILE_MODE });
    try {
        chmodSync(STORE_PATH, STORE_FILE_MODE);
    } catch {
        // ignore permission hardening failures
    }
}

function mutateStore(mutator) {
    return withStoreLock(() => {
        const store = readStoreFromDisk();
        const result = mutator(store);
        writeStoreToDisk(store);
        return result;
    });
}

export function loadStore() {
    return readStoreFromDisk();
}

export function saveStore(store) {
    withStoreLock(() => writeStoreToDisk(store || {}));
}

export function addPending(uniqueId, data) {
    mutateStore((store) => {
        store[uniqueId] = data;
    });
}

export function getPending(uniqueId) {
    const store = loadStore();
    return store[uniqueId] || null;
}

export function removePending(uniqueId) {
    mutateStore((store) => {
        delete store[uniqueId];
    });
}

export function updatePending(uniqueId, updates) {
    mutateStore((store) => {
        if (store[uniqueId]) {
            Object.assign(store[uniqueId], updates);
        }
    });
}

export function isQuestionActive(sessionId) {
    const store = loadStore();
    const now = Date.now();
    for (const entry of Object.values(store)) {
        if (entry.type === 'question'
            && entry.sid === sessionId
            && entry.answer === undefined
            && (now - entry.timestamp) < QUESTION_TTL_MS) {
            return true;
        }
    }
    return false;
}

export function getActiveQuestionId(sessionId) {
    const store = loadStore();
    const now = Date.now();
    let latest = null;
    let latestTs = 0;
    for (const [id, entry] of Object.entries(store)) {
        if (entry.type === 'question'
            && entry.sid === sessionId
            && entry.answer === undefined
            && (now - entry.timestamp) < QUESTION_TTL_MS
            && entry.timestamp > latestTs) {
            latest = id;
            latestTs = entry.timestamp;
        }
    }
    return latest;
}

export function cleanExpired() {
    return mutateStore((store) => {
        const now = Date.now();
        const expired = [];
        for (const [id, entry] of Object.entries(store)) {
            const ttl = (entry.type === 'question' && entry.answer === undefined)
                ? QUESTION_TTL_MS
                : TTL_MS;
            if (now - entry.timestamp > ttl) {
                expired.push({ id, ...entry });
                delete store[id];
            }
        }
        return expired;
    });
}

export function __setPendingStorePathForTest(path) {
    STORE_PATH = String(path || '').trim() || '/tmp/hermes-pending.json';
}

export function __getPendingStorePath() {
    return STORE_PATH;
}
