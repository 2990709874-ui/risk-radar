let tasks = [];
let selectedId = null;
let schedulerMs = 30000;
let currentDetail = null;
let ruleDirty = false;

const $ = (sel) => document.querySelector(sel);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const STATUS_META = {
  running: { label: '运行中', cls: 'running' },
  cooldown: { label: '冷却中', cls: 'cooldown' },
  failed: { label: '失败', cls: 'failed' },
  paused: { label: '已暂停', cls: 'paused' },
  recovered: { label: '已恢复', cls: 'recovered' },
  triggered: { label: '触发', cls: 'triggered' },
  deduped: { label: '去重', cls: 'deduped' },
  degraded: { label: '降级', cls: 'degraded' },
  not_triggered: { label: '未触发', cls: 'muted' },
};

function statusLabel(s) {
  return (STATUS_META[s] || {}).label || s;
}

function statusCls(s) {
  return (STATUS_META[s] || {}).cls || 'muted';
}

async function refresh() {
  const data = await api('/api/tasks');
  tasks = data.tasks;
  renderList();
  if (selectedId) await loadDetail(selectedId, { preserve: true });
}

function renderList() {
  const box = $('#task-list');
  if (!tasks.length) {
    box.innerHTML = '<div class="empty">暂无任务，先创建一个</div>';
    return;
  }
  box.innerHTML = tasks
    .map((t) => {
      const active = t.id === selectedId ? 'active' : '';
      const fail = t.failCount ? ` · 失败 ${t.failCount} 次` : '';
      return `<div class="task-item ${active}" data-id="${t.id}">
        <div class="t-name">${escapeHtml(t.name)}</div>
        <div class="t-meta">
          <span class="badge ${statusCls(t.status)}">${statusLabel(t.status)}</span>
          v${t.version} · ${t.conditionCount} 条件 · 结果 ${statusLabel(t.lastResultStatus) || '—'}${fail}
        </div>
      </div>`;
    })
    .join('');
  box.querySelectorAll('.task-item').forEach((el) => {
    el.addEventListener('click', () => loadDetail(el.dataset.id));
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function loadDetail(id, opts = {}) {
  const preserve = opts.preserve && ruleDirty;
  selectedId = id;
  const t = await api(`/api/tasks/${id}`);
  currentDetail = t;
  $('#detail-empty').classList.add('hidden');
  $('#detail').classList.remove('hidden');
  $('#detail-name').textContent = `${t.name}（${t.logic}）`;
  const badge = $('#detail-status');
  badge.textContent = statusLabel(t.status);
  badge.className = `badge ${statusCls(t.status)}`;
  if (!preserve) {
    $('#detail-rule').value = JSON.stringify(t.rule, null, 2);
    ruleDirty = false;
  }
  $('#detail-result').textContent = t.lastResult ? t.lastResult.explanation : '尚未运行';
  renderMeta(t);
  renderStepper(t);
  renderVersions(t);
  renderEvents(t);
  renderList();
}

$('#detail-rule').addEventListener('input', () => {
  ruleDirty = true;
});

function fmt(iso) {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function remaining(ts) {
  if (!ts) return '—';
  const diff = ts - Date.now();
  if (diff <= 0) return '已到期';
  return `${Math.max(1, Math.round(diff / 1000))} 秒`;
}

function renderMeta(t) {
  const rows = [
    ['任务 ID', t.id],
    ['版本', `v${t.version}`],
    ['创建时间', fmt(t.createdAt)],
    ['最近运行', fmt(t.lastRunAt)],
    ['下次评估', `约 ${Math.round(schedulerMs / 1000)} 秒后`],
    ['数据模式', t.dataMode === 'real' ? '真实（扶摇）' : '演示（mock）'],
  ];
  if (t.status === 'cooldown') rows.push(['冷却剩余', remaining(t.cooldownUntil)]);
  if (t.status === 'failed') rows.push(['下次重试', remaining(t.nextRetryAt)]);
  if (t.failCount) rows.push(['失败次数', String(t.failCount)]);
  if (t.recoveredAt) rows.push(['最近恢复', fmt(t.recoveredAt)]);
  $('#detail-meta').innerHTML = rows
    .map(([k, v]) => `<div class="meta-item"><span>${k}</span><strong>${escapeHtml(v)}</strong></div>`)
    .join('');
}

function renderStepper(t) {
  const states = [['running', '运行中'], ['cooldown', '冷却中'], ['failed', '失败'], ['paused', '已暂停']];
  $('#detail-stepper').innerHTML = states
    .map(([k, l]) => `<span class="step ${k}${t.status === k ? ' on' : ''}">${l}</span>`)
    .join('');
}

function renderVersions(t) {
  const vs = t.ruleVersions || [];
  $('#detail-versions').innerHTML = vs.length
    ? vs
        .slice()
        .reverse()
        .map(
          (v) => `<div class="history-item">
            <div class="h-time">v${v.version} · ${fmt(v.changedAt)} · ${escapeHtml(v.reason || '')}</div>
            <button class="ghost small" data-rollback="${v.version}">回滚到 v${v.version}</button>
          </div>`
        )
        .join('')
    : '<div class="empty">无</div>';
  $('#detail-versions').querySelectorAll('[data-rollback]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await rollbackTo(currentDetail, Number(btn.dataset.rollback));
    });
  });
}

async function rollbackTo(t, version) {
  if (!t) return;
  const v = (t.ruleVersions || []).find((x) => x.version === version);
  if (!v) return;
  await api(`/api/tasks/${t.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ rule: v.rule, reason: `回滚到 v${version}` }),
  });
  await loadDetail(t.id);
}

function renderEvents(t) {
  const evs = t.events || [];
  $('#detail-history').innerHTML = evs.length
    ? evs
        .map(
          (e) => `<div class="history-item">
            <div class="h-time">${fmt(e.at)} · <span class="badge ${statusCls(e.status)}">${statusLabel(e.status)}</span></div>
            <div>${escapeHtml(e.explanation)}</div>
          </div>`
        )
        .join('')
    : '<div class="empty">无</div>';
}

$('#create-btn').addEventListener('click', async () => {
  const query = $('#query').value.trim();
  if (!query) return alert('请输入关注点描述');
  try {
    const data = await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({ query }),
    });
    selectedId = data.task.id;
    await refresh();
    $('#query').value = '';
  } catch (err) {
    alert('创建失败：' + err.message);
  }
});

$('#clear-btn').addEventListener('click', () => {
  $('#query').value = '';
});

$('#save-rule').addEventListener('click', async () => {
  if (!selectedId) return;
  try {
    const rule = JSON.parse($('#detail-rule').value);
    await api(`/api/tasks/${selectedId}`, {
      method: 'PATCH',
      body: JSON.stringify({ rule, reason: '用户在界面修改' }),
    });
    await loadDetail(selectedId);
  } catch (err) {
    alert('保存失败：' + err.message);
  }
});

$('#run-now').addEventListener('click', async () => {
  if (!selectedId) return;
  const data = await api(`/api/tasks/${selectedId}/run`, { method: 'POST' });
  await loadDetail(selectedId);
});

$('#run-normal').addEventListener('click', async () => {
  if (!selectedId) return;
  await api(`/api/tasks/${selectedId}/run`, {
    method: 'POST',
    body: JSON.stringify({ force: false }),
  });
  await loadDetail(selectedId);
});

$('#reset-task').addEventListener('click', async () => {
  if (!selectedId) return;
  await api(`/api/tasks/${selectedId}/reset`, { method: 'POST' });
  await loadDetail(selectedId);
});

$('#mock-failure').addEventListener('change', async (e) => {
  await api('/api/mock', { method: 'POST', body: JSON.stringify({ failure: e.target.checked }) });
});
$('#mock-stale').addEventListener('change', async (e) => {
  await api('/api/mock', { method: 'POST', body: JSON.stringify({ stale: e.target.checked }) });
});
$('#mock-mode').addEventListener('change', async (e) => {
  await api('/api/mock', { method: 'POST', body: JSON.stringify({ mode: e.target.value }) });
});
$('#mock-set').addEventListener('click', async () => {
  const instrument = $('#mock-instrument').value;
  const price = Number($('#mock-price').value);
  if (!Number.isFinite(price)) return alert('请输入价格');
  await api('/api/mock', { method: 'POST', body: JSON.stringify({ instrument, price }) });
  $('#mock-price').value = '';
});

async function loadMockState() {
  try {
    const s = await api('/api/mock');
    $('#mock-mode').value = s.mode || 'mock';
    $('#mock-failure').checked = !!s.failure;
    $('#mock-stale').checked = !!s.stale;
  } catch (err) {
    console.error(err);
  }
}

async function checkHealth() {
  const el = $('#health');
  try {
    const data = await api('/api/health');
    schedulerMs = data.schedulerIntervalMs || 30000;
    const mode = data.dataMode === 'real' ? '真实' : '演示';
    el.textContent = `正常 · ${data.taskCount} 个任务 · ${mode}数据 · 每 ${Math.round(schedulerMs / 1000)}s 评估`;
    el.className = 'health ok';
  } catch (err) {
    el.textContent = '服务不可用';
    el.className = 'health err';
  }
}

refresh().catch((e) => console.error(e));
loadMockState();
checkHealth();
setInterval(refresh, 5000);
