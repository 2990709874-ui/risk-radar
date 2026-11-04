'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const SCHEDULE_INTERVAL_MS = Number(process.env.SCHEDULE_INTERVAL_MS || 30000);

const LLM_API_URL = process.env.LLM_API_URL || '';
const LLM_API_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';

// ---------------- 环境变量（.env，已被 .gitignore 保护） ----------------
function loadEnvFile() {
  try {
    const p = path.join(ROOT, '.env');
    if (!fs.existsSync(p)) return;
    const text = fs.readFileSync(p, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch (err) {
    console.warn('[env] 读取 .env 失败:', err.message);
  }
}
loadEnvFile();

// ---------------- 内存存储 ----------------
const tasks = new Map();
let seq = 0;

// ---------------- 数据提供层（扶摇真实接口 / mock 降级） ----------------
const provider = require('./provider');

// ---------------- 工具函数 ----------------
function nowIso() {
  return new Date().toISOString();
}

function todayYmd() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}

function uid(prefix) {
  seq += 1;
  return `${prefix}-${Date.now().toString(36)}-${seq}`;
}

function compare(left, op, right) {
  switch (op) {
    case '>': return left > right;
    case '>=': return left >= right;
    case '<': return left < right;
    case '<=': return left <= right;
    case '==': return left === right;
    case '!=': return left !== right;
    default: return false;
  }
}

const OPS = ['>', '>=', '<', '<=', '==', '!='];
const COND_TYPES = ['price', 'event', 'calendar', 'heat'];

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('body too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

// ---------------- 规则校验 ----------------
function validateRule(rule) {
  if (!rule || typeof rule !== 'object') return { ok: false, error: '规则不能为空' };
  if (!Array.isArray(rule.conditions) || rule.conditions.length === 0) {
    return { ok: false, error: 'conditions 必须是非空数组' };
  }
  if (rule.conditions.length > 20) return { ok: false, error: '条件数量超过上限(20)' };
  if (rule.logic !== 'AND' && rule.logic !== 'OR') {
    return { ok: false, error: 'logic 必须是 AND 或 OR' };
  }
  for (const cond of rule.conditions) {
    if (!cond || typeof cond !== 'object') return { ok: false, error: '条件必须是对象' };
    if (!COND_TYPES.includes(cond.type)) return { ok: false, error: `未知条件类型: ${cond.type}` };
    if (cond.type !== 'calendar' && !cond.instrument) return { ok: false, error: '条件缺少 instrument' };
    if (cond.type === 'price' || cond.type === 'heat') {
      if (!OPS.includes(cond.op)) return { ok: false, error: `未知运算符: ${cond.op}` };
      if (typeof cond.value !== 'number' || Number.isNaN(cond.value)) {
        return { ok: false, error: '条件 value 必须是数字' };
      }
    }
    if (cond.type === 'calendar' && cond.date && !/^\d{8}$/.test(cond.date)) {
      return { ok: false, error: 'calendar 条件的 date 需为 yyyyMMdd' };
    }
  }
  const cooldown = Number(rule.cooldownSeconds ?? 0);
  const dedup = Number(rule.dedupWindowSeconds ?? 0);
  if (!Number.isFinite(cooldown) || cooldown < 0) return { ok: false, error: 'cooldownSeconds 非法' };
  if (!Number.isFinite(dedup) || dedup < 0) return { ok: false, error: 'dedupWindowSeconds 非法' };
  return { ok: true };
}

function normalizeRule(rule) {
  return {
    name: rule.name || '未命名监控',
    logic: rule.logic,
    cooldownSeconds: Number(rule.cooldownSeconds ?? 0),
    dedupWindowSeconds: Number(rule.dedupWindowSeconds ?? 0),
    conditions: rule.conditions.map((c) => ({ ...c })),
  };
}

// ---------------- 自然语言 → 规则 ----------------
function fallbackParse(query) {
  const text = String(query || '');
  const conditions = [];
  const name = text.slice(0, 24) || '未命名监控';

  const instMap = [
    { key: '茅台', code: '600519.SH' },
    { key: '平安银行', code: '000001.SZ' },
    { key: '宁德时代', code: '300750.SZ' },
  ];
  const inst = instMap.find((m) => text.includes(m.key));
  if (!inst) {
    throw new Error('未识别标的，请使用：茅台 / 平安银行 / 宁德时代');
  }

  const priceMatch = text.match(/(跌破|涨破|高于|低于|跌破|超过)\s*(\d+(?:\.\d+)?)/);
  if (priceMatch) {
    const op = priceMatch[1] === '涨破' || priceMatch[1] === '高于' || priceMatch[1] === '超过' ? '>' : '<';
    conditions.push({
      id: uid('c'),
      type: 'price',
      instrument: inst.code,
      field: 'price',
      op,
      value: Number(priceMatch[2]),
    });
  }

  const heatMatch = text.match(/热榜\s*(前|第)?\s*(\d+)/);
  if (heatMatch) {
    conditions.push({
      id: uid('c'),
      type: 'heat',
      instrument: inst.code,
      field: 'hotRank',
      op: '<=',
      value: Number(heatMatch[2]),
    });
  }

  const eventMatch = text.match(/公告.{0,6}(回购|增持|减持|中标|合同)/);
  if (eventMatch) {
    conditions.push({
      id: uid('c'),
      type: 'event',
      instrument: inst.code,
      keyword: eventMatch[1],
      withinHours: 24,
    });
  }

  if (conditions.length === 0) {
    throw new Error('未识别到可执行条件，请描述价格阈值、热榜名次或公告关键词');
  }

  const logic = conditions.length > 1 && /或/.test(text) ? 'OR' : 'AND';
  const cooldownSeconds = /24\s*小时|一天/.test(text) ? 86400 : 3600;
  return {
    name,
    logic,
    cooldownSeconds,
    dedupWindowSeconds: 3600,
    conditions,
  };
}

async function nlToRule(query) {
  if (LLM_API_URL && LLM_API_KEY) {
    try {
      const res = await fetch(LLM_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${LLM_API_KEY}`,
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          temperature: 0,
          messages: [
            {
              role: 'system',
              content:
                '你是投资监控规则解析器。把用户关注点转成 JSON，只输出 JSON。格式：{"name":string,"logic":"AND"|"OR","cooldownSeconds":number,"dedupWindowSeconds":number,"conditions":[{"type":"price|heat","instrument":string,"field":string,"op":string,"value":number} 或 {"type":"event","instrument":string,"keyword":string,"withinHours":number} 或 {"type":"calendar","date":"yyyyMMdd"}]}。price 支持 field=price|changePct，heat 支持 field=hotRank；calendar 判断该日是否交易日（date 可省略，默认今天）。可用标的代码：600519.SH, 000001.SZ, 300750.SZ。不得输出预测或买卖建议。',
            },
            { role: 'user', content: query },
          ],
        }),
      });
      if (!res.ok) throw new Error(`llm http ${res.status}`);
      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || '';
      const start = content.indexOf('{');
      const end = content.lastIndexOf('}');
      if (start === -1 || end === -1) throw new Error('llm 输出不是 JSON');
      const parsed = JSON.parse(content.slice(start, end + 1));
      const check = validateRule(parsed);
      if (!check.ok) throw new Error(`llm 规则非法: ${check.error}`);
      return normalizeRule(parsed);
    } catch (err) {
      // 外部模型失败时降级到内置解析器，不阻断主链路
      console.warn('[llm] fallback to builtin parser:', err.message);
      return fallbackParse(query);
    }
  }
  return fallbackParse(query);
}

// ---------------- 数据提供层（异步评估） ----------------
async function evaluateCondition(cond) {
  const base = { id: cond.id, type: cond.type, instrument: cond.instrument };

  if (cond.type === 'price') {
    const r = await provider.getPrice(cond.instrument);
    if (r.status === 'ok' || r.status === 'stale') {
      const raw = cond.field === 'changePct' ? r.changePct : r.lastPrice;
      const value = Number(raw.toFixed(3));
      const matched = compare(value, cond.op, cond.value);
      const src = r.source === 'fuyao' ? '扶摇' : '演示数据';
      return {
        ...base,
        field: cond.field || 'price',
        status: r.status,
        value,
        op: cond.op,
        threshold: cond.value,
        matched,
        source: r.source,
        detail: `${cond.instrument} ${cond.field === 'changePct' ? '涨跌幅' : '最新价'} = ${value}（${src}），${cond.op} ${cond.value}${matched ? '：满足' : '：不满足'}`,
      };
    }
    return { ...base, field: cond.field || 'price', status: r.status, matched: false, source: r.source, detail: r.detail };
  }

  if (cond.type === 'heat') {
    const r = await provider.getHotRank(cond.instrument);
    if (r.status === 'ok' || r.status === 'stale') {
      const value = r.rank;
      const matched = value !== null && compare(value, cond.op, cond.value);
      const src = r.source === 'fuyao' ? '扶摇' : '演示数据';
      return {
        ...base,
        field: 'hotRank',
        status: r.status,
        value,
        op: cond.op,
        threshold: cond.value,
        matched,
        source: r.source,
        detail: value === null
          ? `${cond.instrument} 不在当日热股榜前 100（${src}）`
          : `${cond.instrument} 热榜排名 = ${value}（${src}），${cond.op} ${cond.value}${matched ? '：满足' : '：不满足'}`,
      };
    }
    return { ...base, field: 'hotRank', status: r.status, matched: false, source: r.source, detail: r.detail };
  }

  if (cond.type === 'event') {
    const r = await provider.getEvents(cond.instrument, cond.keyword, Number(cond.withinHours ?? 24));
    if (r.status === 'ok') {
      const matched = r.hits.length > 0;
      return {
        ...base,
        status: 'ok',
        matched,
        hits: r.hits,
        source: r.source,
        detail: matched
          ? `命中公告（演示数据）：${r.hits.map((h) => h.title).join('；')}`
          : `近 ${cond.withinHours ?? 24} 小时内无「${cond.keyword}」相关公告（演示数据）`,
      };
    }
    return { ...base, status: r.status, matched: false, source: r.source, detail: r.detail };
  }

  if (cond.type === 'calendar') {
    const dateStr = cond.date || todayYmd();
    const r = await provider.isTradingDay(dateStr);
    if (r.status === 'ok' || r.status === 'stale') {
      const src = r.source === 'fuyao' ? '扶摇' : '演示数据';
      return {
        ...base,
        status: r.status,
        matched: r.trading,
        source: r.source,
        detail: `${dateStr} ${r.trading ? '是' : '不是'}交易日（${src}）`,
      };
    }
    return { ...base, status: r.status, matched: false, source: r.source, detail: r.detail };
  }

  return { ...base, status: 'error', matched: false, detail: `不支持的条件类型: ${cond.type}` };
}

// ---------------- 评估引擎 ----------------
function combineFlags(flags, logic) {
  if (flags.length === 0) return false;
  if (logic === 'OR') return flags.some(Boolean);
  return flags.every(Boolean);
}

function buildExplanation(task, result) {
  const parts = [];
  for (const c of result.conditions) {
    parts.push(`· ${c.detail}`);
  }
  if (result.degraded) {
    const bad = result.conditions.filter((c) => c.status !== 'ok');
    parts.push(`⚠ 降级：${bad.map((c) => c.detail).join('；')}。数据不可靠时不自动触发。`);
  }
  if (result.status === 'triggered') {
    parts.push('✓ 已触发：满足组合条件。');
  } else if (result.status === 'not_triggered') {
    parts.push('○ 未触发：不满足组合条件。');
  } else if (result.status === 'degraded') {
    parts.push('△ 未触发（降级）：存在数据异常，无法确认。');
  }
  return parts.join('\n');
}

function pushEvent(task, status, explanation) {
  task.events = task.events || [];
  task.events.unshift({ id: uid('evt'), at: nowIso(), status, explanation });
  if (task.events.length > 100) task.events.length = 100;
}

async function evaluateTask(task, { force = false } = {}) {
  const now = Date.now();
  const condResults = await Promise.all(task.rule.conditions.map((c) => evaluateCondition(c)));
  const matchedFlags = condResults.map((c) => c.matched);
  const matched = combineFlags(matchedFlags, task.rule.logic);
  const degradedConditions = condResults.filter((c) => c.status !== 'ok');
  const degraded = degradedConditions.length > 0;

  let status;
  if (degraded) status = 'degraded';
  else if (matched) status = 'triggered';
  else status = 'not_triggered';

  const result = {
    evaluatedAt: nowIso(),
    status,
    matched,
    degraded,
    conditions: condResults,
    explanation: '',
  };

  // 失败（全部数据源异常）→ 任务级失败，进入退避重试
  if (condResults.every((c) => c.status === 'error')) {
    task.status = 'failed';
    task.failCount = (task.failCount || 0) + 1;
    task.nextRetryAt = Date.now() + Math.min(60000 * 2 ** (task.failCount - 1), 600000);
    result.status = 'failed';
    result.explanation = buildExplanation(task, result) + `\n任务失败，将在 ${new Date(task.nextRetryAt).toLocaleTimeString()} 自动重试。`;
    task.lastResult = result;
    task.lastRunAt = nowIso();
    pushEvent(task, 'failed', result.explanation);
    return result;
  }

  // 数据部分异常 → 降级，不静默触发
  if (degraded) {
    result.status = 'degraded';
    result.explanation = buildExplanation(task, result);
    task.lastResult = result;
    task.lastRunAt = nowIso();
    const wasFailed = task.status === 'failed';
    task.status = task.status === 'failed' ? 'running' : task.status;
    pushEvent(task, wasFailed ? 'recovered' : 'degraded', result.explanation);
    return result;
  }

  if (!matched) {
    result.explanation = buildExplanation(task, result);
    task.lastResult = result;
    task.lastRunAt = nowIso();
    if (task.status === 'failed') {
      task.status = 'running';
      task.failCount = 0;
      task.recoveredAt = nowIso();
      pushEvent(task, 'recovered', '数据源恢复，任务回到运行中。');
    }
    return result;
  }

  // 命中，去重 / 冷却检查（force 用于演示，绕过）
  const dedupKey = crypto
    .createHash('sha1')
    .update(task.id + '|' + JSON.stringify(condResults.filter((c) => c.matched).map((c) => [c.id, c.type, c.value || c.keyword || c.eventType])))
    .digest('hex');
  const dedupSeen = task.dedupSeen || new Map();
  task.dedupSeen = dedupSeen;
  const seenAt = dedupSeen.get(dedupKey);
  const inDedup = seenAt && now - seenAt < (task.rule.dedupWindowSeconds || 0) * 1000;

  const cooldownUntil = task.cooldownUntil || 0;
  const inCooldown = task.status === 'cooldown' && now < cooldownUntil;

  if (!force && inCooldown) {
    result.status = 'cooldown';
    result.explanation = `已满足条件，但处于冷却期（至 ${new Date(cooldownUntil).toLocaleTimeString()}），避免重复提醒。`;
    task.lastResult = result;
    task.lastRunAt = nowIso();
    pushEvent(task, 'cooldown', result.explanation);
    return result;
  }
  if (!force && inDedup) {
    result.status = 'deduped';
    result.explanation = `已满足条件，但与近期触发理由相同，已在去重窗口内忽略。`;
    task.lastResult = result;
    task.lastRunAt = nowIso();
    pushEvent(task, 'deduped', result.explanation);
    return result;
  }

  // 正常触发
  const entry = {
    id: uid('trig'),
    at: nowIso(),
    status: 'triggered',
    matchedConditions: condResults.filter((c) => c.matched),
    explanation: '',
  };
  result.status = 'triggered';
  result.explanation = buildExplanation(task, result);
  entry.explanation = result.explanation;
  const wasFailed = task.status === 'failed';
  task.triggerHistory = task.triggerHistory || [];
  task.triggerHistory.unshift(entry);
  if (task.triggerHistory.length > 200) task.triggerHistory.length = 200;
  task.lastTriggerAt = nowIso();
  dedupSeen.set(dedupKey, now);
  if (task.rule.cooldownSeconds > 0) {
    task.status = 'cooldown';
    task.cooldownUntil = now + task.rule.cooldownSeconds * 1000;
  } else {
    task.status = 'running';
  }
  if (task.status !== 'failed') {
    task.failCount = 0;
  }
  task.lastResult = result;
  task.lastRunAt = nowIso();
  pushEvent(task, wasFailed ? 'recovered' : 'triggered', result.explanation);
  return result;
}

// ---------------- 调度器 ----------------
async function schedulerTick() {
  for (const task of tasks.values()) {
    if (task.status === 'paused') continue;
    if (task.status === 'cooldown') {
      if (task.cooldownUntil && Date.now() >= task.cooldownUntil) {
        task.status = 'running';
        task.cooldownUntil = 0;
      } else {
        continue;
      }
    }
    if (task.status === 'failed') {
      if (task.nextRetryAt && Date.now() < task.nextRetryAt) continue;
      await evaluateTask(task);
      continue;
    }
    await evaluateTask(task);
  }
}

if (require.main === module) {
  setInterval(() => {
    schedulerTick().catch((err) => console.error('[scheduler]', err));
  }, SCHEDULE_INTERVAL_MS);
}

// ---------------- 序列化 ----------------
function taskSummary(t) {
  return {
    id: t.id,
    name: t.rule.name,
    logic: t.rule.logic,
    status: t.status,
    version: t.version,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    lastRunAt: t.lastRunAt,
    lastTriggerAt: t.lastTriggerAt,
    lastResultStatus: t.lastResult ? t.lastResult.status : null,
    conditionCount: t.rule.conditions.length,
    cooldownUntil: t.cooldownUntil || 0,
    nextRetryAt: t.nextRetryAt || 0,
    failCount: t.failCount || 0,
  };
}

// ---------------- 路由 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function handleRequest(req, res) {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;
  const method = req.method;

  if (p === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      time: nowIso(),
      taskCount: tasks.size,
      schedulerIntervalMs: SCHEDULE_INTERVAL_MS,
      dataMode: provider.getMode(),
    });
  }

  if (p === '/api/tasks' && method === 'GET') {
    return sendJson(res, 200, { tasks: [...tasks.values()].map(taskSummary) });
  }

  if (p === '/api/tasks' && method === 'POST') {
    const body = await readJson(req).catch(() => null);
    if (!body) return sendError(res, 400, '请求体不是合法 JSON');
    try {
      let rule;
      if (body.query) {
        rule = await nlToRule(body.query);
      } else if (body.rule) {
        const check = validateRule(body.rule);
        if (!check.ok) return sendError(res, 400, check.error);
        rule = normalizeRule(body.rule);
      } else {
        return sendError(res, 400, '需要 query 或 rule');
      }
      const task = {
        id: uid('task'),
        rule,
        status: 'running',
        version: 1,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        lastRunAt: null,
        lastTriggerAt: null,
        lastResult: null,
        triggerHistory: [],
        events: [],
        ruleVersions: [{ version: 1, rule: JSON.parse(JSON.stringify(rule)), changedAt: nowIso(), reason: '创建' }],
        dedupSeen: new Map(),
        failCount: 0,
        cooldownUntil: 0,
        nextRetryAt: 0,
      };
      tasks.set(task.id, task);
      return sendJson(res, 201, { task: taskSummary(task) });
    } catch (err) {
      return sendError(res, 422, err.message || '规则解析失败');
    }
  }

  const taskMatch = p.match(/^\/api\/tasks\/([^/]+)(\/.*)?$/);
  if (taskMatch) {
    const task = tasks.get(taskMatch[1]);
    if (!task) return sendError(res, 404, '任务不存在');
    const sub = taskMatch[2] || '';

    if (method === 'GET' && !sub) {
      return sendJson(res, 200, {
        ...taskSummary(task),
        rule: task.rule,
        ruleVersions: task.ruleVersions,
        triggerHistory: task.triggerHistory,
        lastResult: task.lastResult,
        events: task.events,
        cooldownUntil: task.cooldownUntil || 0,
        nextRetryAt: task.nextRetryAt || 0,
        failCount: task.failCount || 0,
        recoveredAt: task.recoveredAt || null,
        dataMode: provider.getMode(),
      });
    }

    if (method === 'PATCH' && !sub) {
      const body = await readJson(req).catch(() => null);
      if (!body) return sendError(res, 400, '请求体不是合法 JSON');
      if (typeof body.enabled === 'boolean') {
        if (body.enabled && task.status === 'paused') task.status = 'running';
        if (!body.enabled) task.status = 'paused';
        task.updatedAt = nowIso();
      }
      if (body.rule) {
        const check = validateRule(body.rule);
        if (!check.ok) return sendError(res, 400, check.error);
        const oldVersion = task.version;
        task.rule = normalizeRule(body.rule);
        task.version = oldVersion + 1;
        task.ruleVersions.push({
          version: task.version,
          rule: JSON.parse(JSON.stringify(task.rule)),
          changedAt: nowIso(),
          reason: body.reason || '规则修改',
        });
        task.updatedAt = nowIso();
        if (task.status === 'cooldown') task.status = 'running';
        task.cooldownUntil = 0;
      }
      return sendJson(res, 200, { task: taskSummary(task) });
    }

    if (method === 'POST' && sub === '/run') {
      const body = await readJson(req).catch(() => null);
      const force = body ? body.force !== false : true;
      const result = await evaluateTask(task, { force });
      return sendJson(res, 200, { task: taskSummary(task), result });
    }

    if (method === 'POST' && sub === '/reset') {
      task.status = 'running';
      task.cooldownUntil = 0;
      task.nextRetryAt = 0;
      task.failCount = 0;
      task.dedupSeen = new Map();
      task.lastResult = null;
      task.triggerHistory = [];
      task.events = [];
      task.updatedAt = nowIso();
      return sendJson(res, 200, { task: taskSummary(task) });
    }

    if (method === 'DELETE' && !sub) {
      tasks.delete(task.id);
      return sendJson(res, 200, { ok: true });
    }
  }

  if (p === '/api/mock' && method === 'GET') {
    return sendJson(res, 200, provider.getState());
  }

  if (p === '/api/mock' && method === 'POST') {
    const body = await readJson(req).catch(() => null);
    if (!body) return sendError(res, 400, '请求体不是合法 JSON');
    if (body.mode) provider.setMode(body.mode);
    provider.setSimulation({ failure: body.failure, stale: body.stale });
    if (body.instrument && typeof body.price === 'number') {
      if (!provider.nudgePrice(body.instrument, body.price)) return sendError(res, 404, '未知标的');
    }
    return sendJson(res, 200, provider.getState());
  }

  // 静态资源
  if (method === 'GET') {
    let filePath = p === '/' ? '/index.html' : p;
    filePath = path.normalize(path.join(PUBLIC_DIR, filePath));
    if (!filePath.startsWith(PUBLIC_DIR)) return sendError(res, 403, 'forbidden');
    fs.readFile(filePath, (err, data) => {
      if (err) return sendError(res, 404, 'not found');
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
    return;
  }

  return sendError(res, 404, 'not found');
}

if (require.main === module) {
  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) sendError(res, 500, err.message || 'internal error');
      else res.end();
    });
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`风险雷达已启动: http://localhost:${PORT}`);
  });
}

module.exports = { validateRule, normalizeRule, fallbackParse, evaluateCondition, combineFlags };
