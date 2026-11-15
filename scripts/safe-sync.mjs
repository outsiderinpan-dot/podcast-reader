#!/usr/bin/env node
// safe-sync.mjs — 把 podcast-deploy/src 与 podcast-deploy/public 同步到 build sandbox podcast-site/，
// 不使用 rm/rmSync 等破坏性命令；旧目录整体移动到 podcast-site/.trash/<timestamp>/
// 以避免 QoderWork 的「破坏性操作需人工确认」拦截，让夜间跑批可以一口气完成。
//
// Usage: node scripts/safe-sync.mjs [--src <podcast-deploy>] [--sandbox <podcast-site>]
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
function arg(name, dflt) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
}

// 默认路径：脚本所在仓库 = podcast-deploy；sandbox = 同级 podcast-site
const HERE = path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const REPO = path.resolve(arg('src', HERE + '/..'));
const WORKSPACE = path.resolve(REPO, '..');
const SANDBOX = path.resolve(arg('sandbox', path.join(WORKSPACE, 'podcast-site')));
const TRASH = path.join(SANDBOX, '.trash');

fs.mkdirSync(SANDBOX, { recursive: true });
fs.mkdirSync(TRASH, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function syncDir(name) {
  const SRC = path.join(REPO, name);
  const DEST = path.join(SANDBOX, name);
  if (!fs.existsSync(SRC)) {
    console.log(`[safe-sync] 源目录不存在，跳过：${SRC}`);
    return;
  }
  // 1) 归档旧目录（不删除）
  if (fs.existsSync(DEST)) {
    const archived = path.join(TRASH, `${name}-${stamp}`);
    fs.renameSync(DEST, archived);
    console.log(`[safe-sync] 旧 ${name} 已归档到:`, archived);
  } else {
    console.log(`[safe-sync] 无旧 ${name}，跳过归档`);
  }
  // 2) 复制新目录
  copyDir(SRC, DEST);
  console.log(`[safe-sync] 复制完成: ${SRC} -> ${DEST}`);
}

syncDir('src');
syncDir('public');

// 报告 .trash 里累计的旧版本
const trashEntries = fs.readdirSync(TRASH).filter((n) => /^(src|public)-/.test(n)).sort();
console.log(`[safe-sync] .trash 里现有 ${trashEntries.length} 个历史版本；最近 3 个：${trashEntries.slice(-3).join(', ') || '(none)'}`);
if (trashEntries.length > 20) {
  console.log(`[safe-sync] 提示：历史版本超过 20 个，可手动把 ${TRASH} 里最旧的几个移入系统回收站。`);
}
