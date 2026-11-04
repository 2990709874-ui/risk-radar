'use strict';

// 当 github.com:443 不可达（例如受限网络）时，走 api.github.com 的 Git Data API 上传代码。
// 用法：node scripts/git-data-push.js [owner] [repo] ["commit message"]
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function ghPath() {
  const candidates = [
    process.env.GH_BIN,
    'C:\\Program Files\\GitHub CLI\\gh.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe'),
  ].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'gh';
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', cwd: ROOT });
}

function token() {
  try {
    return run(ghPath(), ['auth', 'token']).trim();
  } catch {
    throw new Error('无法获取 gh token，请先执行 gh auth login');
  }
}

function parseRemote() {
  try {
    const url = run('git', ['remote', 'get-url', 'origin']).trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (m) return { owner: m[1], repo: m[2] };
  } catch {
    // 忽略
  }
  return null;
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);
const SKIP_FILES = new Set(['.env', '.env.local']);

function collect(root, base = '') {
  const out = [];
  for (const name of fs.readdirSync(path.join(root, base))) {
    const rel = base ? `${base}/${name}` : name;
    const full = path.join(root, rel);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) out.push(...collect(root, rel));
    } else {
      if (SKIP_FILES.has(name) || name.endsWith('.log') || name === '.DS_Store') continue;
      out.push(rel);
    }
  }
  return out;
}

async function api(owner, repo, method, p, body, tok) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${p}`, {
    method,
    headers: {
      Authorization: `Bearer ${tok}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${json.message || JSON.stringify(json)}`);
  return json;
}

async function ensureInitialized(owner, repo, tok) {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/main`, {
    headers: { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (res.status === 200) return false;
  // 空仓库无法直接写 blob，先放一个占位提交初始化仓库
  await api(owner, repo, 'PUT', '/contents/.gitkeep', {
    message: 'init',
    content: Buffer.from('init\n').toString('base64'),
  }, tok);
  return true;
}

async function main() {
  const tok = token();
  const remote = parseRemote();
  const owner = process.argv[2] || (remote && remote.owner);
  const repo = process.argv[3] || (remote && remote.repo);
  const message = process.argv[4] || 'chore: sync via git data api';
  if (!owner || !repo) throw new Error('缺少 owner/repo，请传入或配置 git remote origin');

  await ensureInitialized(owner, repo, tok);

  const files = collect(ROOT);
  const tree = [];
  for (const f of files) {
    const content = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const blob = await api(owner, repo, 'POST', '/git/blobs', { content, encoding: 'utf-8' }, tok);
    tree.push({ path: f.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: blob.sha });
    console.log(`blob ${f} -> ${blob.sha.slice(0, 7)}`);
  }

  const treeRes = await api(owner, repo, 'POST', '/git/trees', { tree }, tok);
  const commit = await api(owner, repo, 'POST', '/git/commits', { message, tree: treeRes.sha, parents: [] }, tok);

  try {
    await api(owner, repo, 'PATCH', '/git/refs/heads/main', { sha: commit.sha, force: true }, tok);
  } catch {
    await api(owner, repo, 'POST', '/git/refs', { ref: 'refs/heads/main', sha: commit.sha }, tok);
  }

  console.log(`已上传 ${files.length} 个文件，commit=${commit.sha}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
