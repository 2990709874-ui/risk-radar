'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  validateRule,
  normalizeRule,
  fallbackParse,
  evaluateCondition,
  combineFlags,
} = require('../server');
const provider = require('../provider');

provider.setMode('mock');

test.afterEach(() => {
  provider.setMode('mock');
  provider.setSimulation({ failure: false, stale: false });
});

test('validateRule 接受合法的价格规则', () => {
  const rule = {
    name: '茅台价格',
    logic: 'AND',
    cooldownSeconds: 3600,
    dedupWindowSeconds: 3600,
    conditions: [{ id: 'c1', type: 'price', instrument: '600519.SH', field: 'price', op: '<', value: 1600 }],
  };
  assert.equal(validateRule(rule).ok, true);
});

test('validateRule 拒绝未知条件类型 / 未知运算符 / 非数字阈值', () => {
  const base = {
    name: 'x',
    logic: 'AND',
    cooldownSeconds: 0,
    dedupWindowSeconds: 0,
    conditions: [{ id: 'c1', type: 'price', instrument: '600519.SH', op: '<', value: 1600 }],
  };
  assert.equal(validateRule({ ...base, conditions: [{ ...base.conditions[0], type: 'nope' }] }).ok, false);
  assert.equal(validateRule({ ...base, conditions: [{ ...base.conditions[0], op: 'contains' }] }).ok, false);
  assert.equal(validateRule({ ...base, conditions: [{ ...base.conditions[0], value: 'abc' }] }).ok, false);
  assert.equal(validateRule({ ...base, logic: 'XOR' }).ok, false);
});

test('normalizeRule 复制并规范规则', () => {
  const rule = {
    name: 'x',
    logic: 'OR',
    cooldownSeconds: '86400',
    dedupWindowSeconds: '3600',
    conditions: [{ id: 'c1', type: 'price', instrument: '600519.SH', field: 'price', op: '<', value: 1600 }],
  };
  const n = normalizeRule(rule);
  assert.equal(n.cooldownSeconds, 86400);
  assert.equal(n.dedupWindowSeconds, 3600);
  assert.notStrictEqual(n.conditions, rule.conditions);
});

test('fallbackParse 解析价格关注点', () => {
  const r = fallbackParse('贵州茅台收盘价跌破 1600');
  assert.equal(r.logic, 'AND');
  assert.equal(r.conditions.length, 1);
  assert.equal(r.conditions[0].instrument, '600519.SH');
  assert.equal(r.conditions[0].op, '<');
  assert.equal(r.conditions[0].value, 1600);
});

test('fallbackParse 解析热榜与 OR 组合', () => {
  const r = fallbackParse('宁德时代进入热榜前 3，或跌破 170');
  assert.equal(r.logic, 'OR');
  const types = r.conditions.map((c) => c.type).sort();
  assert.deepEqual(types, ['heat', 'price']);
});

test('evaluateCondition 价格命中与未命中', async () => {
  const below = await evaluateCondition({ id: 'c1', type: 'price', instrument: '600519.SH', field: 'price', op: '<', value: 1600 });
  assert.equal(below.matched, false);
  assert.equal(below.status, 'ok');
  const above = await evaluateCondition({ id: 'c2', type: 'price', instrument: '600519.SH', field: 'price', op: '>', value: 1600 });
  assert.equal(above.matched, true);
});

test('evaluateCondition 热榜命中', async () => {
  const r = await evaluateCondition({ id: 'c1', type: 'heat', instrument: '300750.SZ', field: 'hotRank', op: '<=', value: 3 });
  assert.equal(r.matched, true);
  assert.equal(r.status, 'ok');
});

test('evaluateCondition 公告事件命中', async () => {
  const r = await evaluateCondition({ id: 'c1', type: 'event', instrument: '600519.SH', keyword: '回购', withinHours: 24 });
  assert.equal(r.matched, true);
  assert.equal(r.status, 'ok');
});

test('evaluateCondition 数据缺失时不触发并说明', async () => {
  const r = await evaluateCondition({ id: 'c1', type: 'price', instrument: '999999.XS', field: 'price', op: '<', value: 10 });
  assert.equal(r.matched, false);
  assert.equal(r.status, 'missing');
  assert.match(r.detail, /未找到/);
});

test('evaluateCondition 数据源故障时返回 error', async () => {
  provider.setSimulation({ failure: true });
  const r = await evaluateCondition({ id: 'c1', type: 'price', instrument: '600519.SH', field: 'price', op: '<', value: 1600 });
  assert.equal(r.matched, false);
  assert.equal(r.status, 'error');
  assert.match(r.detail, /故障/);
});

test('evaluateCondition 数据过期时返回 stale', async () => {
  provider.setSimulation({ stale: true });
  const r = await evaluateCondition({ id: 'c1', type: 'price', instrument: '600519.SH', field: 'price', op: '<', value: 1600 });
  assert.equal(r.status, 'stale');
});

test('combineFlags AND/OR 组合正确', () => {
  assert.equal(combineFlags([true, true], 'AND'), true);
  assert.equal(combineFlags([true, false], 'AND'), false);
  assert.equal(combineFlags([true, false], 'OR'), true);
  assert.equal(combineFlags([false, false], 'OR'), false);
  assert.equal(combineFlags([], 'OR'), false);
});
