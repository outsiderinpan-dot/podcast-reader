// inject-summaries.mjs <manifest.json>
// 把已生成的 summary_zh 注入现有 episode.json（补全历史集用）。
// manifest 格式：扁平对象 { "<show>/<slug>": "<200-500字中文摘要>", ... }
// 只新增/覆盖 summary_zh 字段，其余字段原样保留；并把 summary_zh 放到 subtitle_zh 之后，保持与 tl-build 输出一致的字段顺序。
import fs from 'node:fs';
import path from 'node:path';

const EPROOT = 'C:/Users/10171/.qoderwork/workspace/mtjtuustn8ugfw99/podcast-deploy/src/data/episodes';
const manifestPath = process.argv[2];
if (!manifestPath) { console.error('usage: node inject-summaries.mjs <manifest.json>'); process.exit(1); }

const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
let ok = 0; const warn = []; const miss = [];
for (const [key, summary] of Object.entries(man)) {
  if (typeof summary !== 'string' || !summary.trim()) { warn.push(`${key} EMPTY`); continue; }
  const f = path.join(EPROOT, key + '.json');
  if (!fs.existsSync(f)) { miss.push(key); continue; }
  const d = JSON.parse(fs.readFileSync(f, 'utf8'));
  delete d.summary_zh;
  const ordered = {};
  let inserted = false;
  for (const k of Object.keys(d)) {
    ordered[k] = d[k];
    if (k === 'subtitle_zh') { ordered.summary_zh = summary; inserted = true; }
  }
  if (!inserted) ordered.summary_zh = summary; // 旧格式无 subtitle_zh 时追加
  fs.writeFileSync(f, JSON.stringify(ordered, null, 2));
  const zhChars = (summary.match(/[\u4e00-\u9fff]/g) || []).length;
  if (zhChars < 200 || zhChars > 500) warn.push(`${key} zhChars=${zhChars}`);
  ok++;
}
console.log(`injected ${ok} summaries | missing ${miss.length} | out-of-range/empty ${warn.length}`);
miss.forEach((m) => console.log('  MISSING', m));
warn.forEach((w) => console.log('  WARN', w));
