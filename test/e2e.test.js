'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 3197;
const BASE = `http://127.0.0.1:${PORT}`;
let child;

async function api(p, options = {}) {
  const res = await fetch(BASE + p, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function waitHealthy(timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const { status } = await api('/api/health');
      if (status === 200) return;
    } catch {
      // 等待启动
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('服务未能在超时前就绪');
}

function priceRule(name, cooldownSeconds, dedupWindowSeconds) {
  return {
    name,
    logic: 'AND',
    cooldownSeconds,
    dedupWindowSeconds,
    conditions: [{ id: 'c1', type: 'price', instrument: '600519.SH', field: 'price', op: '<', value: 2000 }],
  };
}

test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), SCHEDULE_INTERVAL_MS: '1000' },
    stdio: 'ignore',
  });
  await waitHealthy();
  await api('/api/mock', { method: 'POST', body: JSON.stringify({ mode: 'mock' }) });
});

test.after(() => {
  if (child) child.kill();
});

test('e2e: 首页与静态资源可访问', async () => {
  const home = await fetch(BASE + '/');
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /风险雷达/);
  const appJs = await fetch(BASE + '/app.js');
  assert.equal(appJs.status, 200);
});

test('e2e: 自然语言创建任务并解析为规则', async () => {
  const { status, data } = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ query: '贵州茅台收盘价跌破 1600' }),
  });
  assert.equal(status, 201);
  assert.ok(data.task.id);
  const detail = await api(`/api/tasks/${data.task.id}`);
  assert.equal(detail.data.rule.conditions[0].type, 'price');
  assert.equal(detail.data.rule.conditions[0].op, '<');
});

test('e2e: 调整行情后触发并写入触发历史', async () => {
  const created = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ query: '贵州茅台收盘价跌破 1600' }),
  });
  const id = created.data.task.id;

  await api('/api/mock', { method: 'POST', body: JSON.stringify({ instrument: '600519.SH', price: 1590 }) });
  const run = await api(`/api/tasks/${id}/run`, { method: 'POST' });
  assert.equal(run.data.result.status, 'triggered');
  assert.equal(run.data.result.conditions[0].value, 1590);
  const detail = await api(`/api/tasks/${id}`);
  assert.equal(detail.data.triggerHistory.length, 1);
});

test('e2e: 数据源故障时任务失败且不静默触发', async () => {
  const created = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ query: '贵州茅台收盘价跌破 1600' }),
  });
  const id = created.data.task.id;

  await api('/api/mock', { method: 'POST', body: JSON.stringify({ failure: true }) });
  const run = await api(`/api/tasks/${id}/run`, { method: 'POST' });
  assert.equal(run.data.result.status, 'failed');
  assert.match(run.data.result.explanation, /故障/);
  await api('/api/mock', { method: 'POST', body: JSON.stringify({ failure: false }) });
});

test('e2e: 规则修改产生新版本并保留历史', async () => {
  const created = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ rule: priceRule('版本测试', 0, 0) }),
  });
  const id = created.data.task.id;
  await api(`/api/tasks/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      rule: { name: '版本测试v2', logic: 'OR', cooldownSeconds: 60, dedupWindowSeconds: 0, conditions: [{ id: 'c1', type: 'heat', instrument: '600519.SH', field: 'hotRank', op: '<=', value: 3 }] },
      reason: '改为热榜条件',
    }),
  });
  const detail = await api(`/api/tasks/${id}`);
  assert.equal(detail.data.version, 2);
  assert.equal(detail.data.ruleVersions.length, 2);
  assert.equal(detail.data.ruleVersions[1].reason, '改为热榜条件');
});

test('e2e: 同一触发理由在去重窗口内只记录一次', async () => {
  const created = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ rule: priceRule('去重测试', 0, 3600) }),
  });
  const id = created.data.task.id;
  const first = await api(`/api/tasks/${id}/run`, { method: 'POST', body: JSON.stringify({ force: true }) });
  assert.equal(first.data.result.status, 'triggered');
  const second = await api(`/api/tasks/${id}/run`, { method: 'POST', body: JSON.stringify({ force: false }) });
  assert.equal(second.data.result.status, 'deduped');
});

test('e2e: 触发后进入冷却期', async () => {
  const created = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ rule: priceRule('冷却测试', 60, 0) }),
  });
  const id = created.data.task.id;
  const first = await api(`/api/tasks/${id}/run`, { method: 'POST', body: JSON.stringify({ force: true }) });
  assert.equal(first.data.result.status, 'triggered');
  assert.equal(first.data.task.status, 'cooldown');
  const second = await api(`/api/tasks/${id}/run`, { method: 'POST', body: JSON.stringify({ force: false }) });
  assert.equal(second.data.result.status, 'cooldown');
});

test('e2e: 数据源故障后恢复', async () => {
  const created = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ rule: priceRule('恢复测试', 0, 0) }),
  });
  const id = created.data.task.id;
  await api('/api/mock', { method: 'POST', body: JSON.stringify({ failure: true }) });
  const failed = await api(`/api/tasks/${id}/run`, { method: 'POST', body: JSON.stringify({ force: true }) });
  assert.equal(failed.data.result.status, 'failed');
  await api('/api/mock', { method: 'POST', body: JSON.stringify({ failure: false }) });
  const recovered = await api(`/api/tasks/${id}/run`, { method: 'POST', body: JSON.stringify({ force: true }) });
  assert.equal(recovered.data.result.status, 'triggered');
  assert.notEqual(recovered.data.task.status, 'failed');
});
