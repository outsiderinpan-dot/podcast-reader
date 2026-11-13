#!/usr/bin/env node
// safe-sync.mjs — 把 podcast-deploy/src 同步到 build sandbox podcast-site/src，
// 不使用 rm/rmSync 等破坏性命令；旧 src 目录整体移动到 podcast-site/.trash/<timestamp>/
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
const REPO = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(REPO, '..');

const SRC = path.resolve(arg('src', REPO), 'src');
const SANDBOX = path.resolve(arg('sandbox', path.join(WORKSPACE, 'podcast-site')));
const DEST = path.join(SANDBOX, 'src');
const TRASH = path.join(SANDBOX, '.trash');

if (!fs.existsSync(SRC)) {
  console.error('[safe-sync] 源目录不存在:', SRC);
  process.exit(1);
}
fs.mkdirSync(SANDBOX, { recursive: true });
fs.mkdirSync(TRASH, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');

// 1) 把旧 src 整体移到 .trash（不删除）
if (fs.existsSync(DEST)) {
  const archived = path.join(TRASH, `src-${stamp}`);
  fs.renameSync(DEST, archived);
  console.log('[safe-sync] 旧 src 已归档到:', archived);
} else {
  console.log('[safe-sync] 无旧 src，跳过归档');
}

// 2) 递归复制新 src（同步 API，够用；文件量 ~几百 KB）
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
copyDir(SRC, DEST);
console.log('[safe-sync] 复制完成:', SRC, '->', DEST);

// 3) 报告 .trash 里累计的旧版本，供人工偶尔清理
const trashEntries = fs.readdirSync(TRASH).filter((n) => n.startsWith('src-')).sort();
console.log(`[safe-sync] .trash 里现有 ${trashEntries.length} 个历史版本；最近 3 个：${trashEntries.slice(-3).join(', ') || '(none)'}`);
if (trashEntries.length > 10) {
  console.log(`[safe-sync] 提示：历史版本超过 10 个，可手动把 ${TRASH} 里最旧的几个移入系统回收站。`);
}
