'use strict';

const FUYAO_BASE = process.env.FUYAO_BASE_URL || 'https://fuyao.aicubes.cn';

let mode = process.env.FUYAO_API_KEY ? 'real' : 'mock';
let simulateFailure = false;
let simulateStale = false;

const mockQuotes = {
  '600519.SH': { name: '贵州茅台', price: 1650.0, prevClose: 1648.0, hotRank: 5 },
  '000001.SZ': { name: '平安银行', price: 11.2, prevClose: 11.05, hotRank: 12 },
  '300750.SZ': { name: '宁德时代', price: 180.5, prevClose: 179.0, hotRank: 2 },
};

function hoursAgo(h) {
  return new Date(Date.now() - h * 3600 * 1000).toISOString();
}

const mockEvents = [
  { id: 'evt-001', instrument: '600519.SH', type: 'announcement', title: '贵州茅台：关于回购公司股份的进展公告', at: hoursAgo(2) },
  { id: 'evt-002', instrument: '600519.SH', type: 'announcement', title: '贵州茅台：2026 年第三季度报告', at: hoursAgo(20) },
  { id: 'evt-003', instrument: '300750.SZ', type: 'announcement', title: '宁德时代：签订重大合同公告', at: hoursAgo(5) },
];

function currentKey() {
  return process.env.FUYAO_API_KEY || '';
}

function setMode(m) {
  if (m === 'real' || m === 'mock') mode = m;
}

function getMode() {
  return mode;
}

function setSimulation({ failure, stale } = {}) {
  if (typeof failure === 'boolean') simulateFailure = failure;
  if (typeof stale === 'boolean') simulateStale = stale;
}

function getState() {
  return { mode, failure: simulateFailure, stale: simulateStale, quotes: mockQuotes, events: mockEvents };
}

function nudgePrice(instrument, price) {
  if (mockQuotes[instrument] && Number.isFinite(price)) {
    mockQuotes[instrument].price = price;
    return true;
  }
  return false;
}

async function fuyaoGet(pathname, params = {}) {
  const url = new URL(pathname, FUYAO_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { 'X-api-key': currentKey() } });
  if (res.status === 429) return { code: 4001, message: '触发限流', data: null };
  return res.json();
}

async function getPrice(instrument) {
  if (simulateFailure) return { status: 'error', detail: '行情数据源连接超时（模拟故障）' };

  if (mode === 'mock' || !currentKey()) {
    const q = mockQuotes[instrument];
    if (!q) return { status: 'missing', detail: `未找到 ${instrument} 的行情数据` };
    const changePct = ((q.price - q.prevClose) / q.prevClose) * 100;
    if (simulateStale) {
      return { status: 'stale', lastPrice: q.price, prevPrice: q.prevClose, changePct, source: 'mock', detail: '行情数据已过期（模拟）' };
    }
    return { status: 'ok', lastPrice: q.price, prevPrice: q.prevClose, changePct, source: 'mock' };
  }

  try {
    const r = await fuyaoGet('/api/a-share/prices/snapshot', { thscodes: instrument });
    if (!r || r.code !== 0) {
      return { status: 'error', detail: `行情接口返回 code=${r ? r.code : 'unknown'}：${r ? r.message : '无响应'}` };
    }
    const item = (r.data && r.data.item && r.data.item[0]) || null;
    if (!item) return { status: 'missing', detail: `未找到 ${instrument} 的行情快照` };
    return {
      status: simulateStale ? 'stale' : 'ok',
      lastPrice: item.last_price,
      prevPrice: item.prev_price,
      changePct: item.price_change_ratio_pct,
      source: 'fuyao',
      raw: item,
    };
  } catch (err) {
    return { status: 'error', detail: `行情请求失败：${err.message}` };
  }
}

async function getHotRank(instrument) {
  if (simulateFailure) return { status: 'error', detail: '热榜数据源连接超时（模拟故障）' };

  if (mode === 'mock' || !currentKey()) {
    const q = mockQuotes[instrument];
    if (!q) return { status: 'missing', detail: `未找到 ${instrument} 的行情数据` };
    if (simulateStale) return { status: 'stale', rank: q.hotRank, source: 'mock', detail: '热榜数据已过期（模拟）' };
    return { status: 'ok', rank: q.hotRank, source: 'mock' };
  }

  try {
    const r = await fuyaoGet('/api/a-share/special-data/hot-stock-list', { period: 'day', limit: 100 });
    if (!r || r.code !== 0) {
      return { status: 'error', detail: `热榜接口返回 code=${r ? r.code : 'unknown'}：${r ? r.message : '无响应'}` };
    }
    const item = (r.data && r.data.item || []).find((x) => x.thscode === instrument);
    if (!item) return { status: 'ok', rank: null, source: 'fuyao', detail: '不在当日热股榜前 100' };
    return { status: simulateStale ? 'stale' : 'ok', rank: item.rank, source: 'fuyao' };
  } catch (err) {
    return { status: 'error', detail: `热榜请求失败：${err.message}` };
  }
}

async function isTradingDay(dateStr) {
  if (simulateFailure) return { status: 'error', detail: '交易日历数据源连接超时（模拟故障）' };

  if (mode === 'mock' || !currentKey()) {
    const d = new Date(`${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}T00:00:00+08:00`);
    const wd = d.getDay();
    return { status: simulateStale ? 'stale' : 'ok', trading: wd >= 1 && wd <= 5, source: 'mock', detail: '交易日按工作日近似（演示数据）' };
  }

  try {
    const r = await fuyaoGet('/api/a-share/calendar/trading-days', { start_date: dateStr, end_date: dateStr });
    if (!r || r.code !== 0) {
      return { status: 'error', detail: `交易日历接口返回 code=${r ? r.code : 'unknown'}：${r ? r.message : '无响应'}` };
    }
    const trading = ((r.data && r.data.item) || []).length > 0;
    return { status: simulateStale ? 'stale' : 'ok', trading, source: 'fuyao' };
  } catch (err) {
    return { status: 'error', detail: `交易日历请求失败：${err.message}` };
  }
}

async function getEvents(instrument, keyword, withinHours) {
  if (simulateFailure) return { status: 'error', detail: '公告数据源连接超时（模拟故障）' };
  const cutoff = Date.now() - withinHours * 3600 * 1000;
  const hits = mockEvents.filter(
    (e) =>
      e.instrument === instrument &&
      (!keyword || e.title.includes(keyword)) &&
      new Date(e.at).getTime() >= cutoff
  );
  return { status: 'ok', hits, source: 'mock', detail: '公告事件当前使用演示数据' };
}

module.exports = {
  setMode,
  getMode,
  setSimulation,
  getState,
  nudgePrice,
  getPrice,
  getHotRank,
  isTradingDay,
  getEvents,
};
