/**
 * Pending Permission Store
 *
 * 基于 JSON 文件的跨进程共享存储，用于 hermes-hook.js 和 permission-listener.js
 * 之间共享待处理的权限请求数据（sid, pid, command 等）。
 *
 * 文件路径: /tmp/hermes-pending.json
 * 原子写入: 先写 .tmp.json 再 rename，避免并发读写损坏
 * TTL: 30 分钟
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

const STORE_PATH = '/tmp/hermes-pending.json';
const STORE_TMP = '/tmp/hermes-pending.tmp.json';
const TTL_MS = 30 * 60 * 1000; // 30 minutes

export function loadStore() {
    if (!existsSync(STORE_PATH)) return {};
    try {
        return JSON.parse(readFileSync(STORE_PATH, 'utf-8'));
    } catch {
        return {};
    }
}

export function saveStore(store) {
    writeFileSync(STORE_TMP, JSON.stringify(store, null, 2));
    renameSync(STORE_TMP, STORE_PATH);
}

export function addPending(uniqueId, data) {
    const store = loadStore();
    store[uniqueId] = data;
    saveStore(store);
}

export function getPending(uniqueId) {
    const store = loadStore();
    return store[uniqueId] || null;
}

export function removePending(uniqueId) {
    const store = loadStore();
    delete store[uniqueId];
    saveStore(store);
}

export function updatePending(uniqueId, updates) {
    const store = loadStore();
    if (store[uniqueId]) {
        Object.assign(store[uniqueId], updates);
        saveStore(store);
    }
}

export function cleanExpired() {
    const store = loadStore();
    const now = Date.now();
    const expired = [];
    for (const [id, entry] of Object.entries(store)) {
        if (now - entry.timestamp > TTL_MS) {
            expired.push({ id, ...entry });
            delete store[id];
        }
    }
    if (expired.length > 0) saveStore(store);
    return expired;
}
