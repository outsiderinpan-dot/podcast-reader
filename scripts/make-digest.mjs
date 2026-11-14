// make-digest.mjs <show> <slug> [maxChars]
// 为"补写 summary_zh"输出一集的有界摘要素材：标题/副标题/说话人/时长 + 按说话人合并的中文正文（超过 maxChars 则头+均匀采样+尾，保留首尾与主干）。
// 供子任务读取后撰写 200-500 字 summary_zh。默认 maxChars=5200。
import fs from 'node:fs';
import path from 'node:path';

const EPROOT = 'C:/Users/10171/.qoderwork/workspace/mtjtuustn8ugfw99/podcast-deploy/src/data/episodes';
const [show, slug] = process.argv.slice(2);
const maxChars = Number(process.argv[4]) || 5200;
if (!show || !slug) { console.error('usage: node make-digest.mjs <show> <slug> [maxChars]'); process.exit(1); }

const f = path.join(EPROOT, show, `${slug}.json`);
const d = JSON.parse(fs.readFileSync(f, 'utf8'));
const spk = d.speakers || {};
const nameOf = (s) => (spk[String(s)] || `说话人${s}`).replace(/（.*?）/g, '');

// 合并连续同说话人
const merged = [];
for (const t of d.turns || []) {
  const nm = nameOf(t.speaker);
  const txt = (t.zh || '').trim();
  if (!txt) continue;
  if (merged.length && merged[merged.length - 1].nm === nm) merged[merged.length - 1].txt += ' ' + txt;
  else merged.push({ nm, txt });
}
let body = merged.map((m) => `【${m.nm}】${m.txt}`).join('\n');

// 有界采样：超长则 头40% + 中段均匀抽样 + 尾25%
if (body.length > maxChars) {
  const headN = Math.floor(maxChars * 0.4);
  const tailN = Math.floor(maxChars * 0.25);
  const head = body.slice(0, headN);
  const tail = body.slice(body.length - tailN);
  const mid = body.slice(headN, body.length - tailN);
  const midBudget = maxChars - headN - tailN;
  // 从 mid 里按步长取样若干片段
  const pieces = [];
  const step = Math.max(1, Math.floor(mid.length / Math.max(1, Math.floor(midBudget / 220))));
  for (let i = 0; i < mid.length && pieces.join('').length < midBudget; i += step) pieces.push(mid.slice(i, i + 200));
  body = head + '\n…［中段采样］…\n' + pieces.join('\n…\n') + '\n…［结尾］…\n' + tail;
}

const zhTotal = (d.turns || []).reduce((s, t) => s + (t.zh || '').length, 0);
console.log(`SHOW: ${show}`);
console.log(`SLUG: ${slug}`);
console.log(`DATE: ${d.date} | DURATION: ${d.duration} | TURNS: ${d.turn_count} | 中文总字数≈${zhTotal}`);
console.log(`TITLE_ZH: ${d.title_zh}`);
console.log(`TITLE_EN: ${d.title_en}`);
console.log(`SUBTITLE_ZH: ${d.subtitle_zh || d.description || ''}`);
console.log(`SPEAKERS: ${JSON.stringify(spk)}`);
console.log(`---- 正文（合并同说话人，已采样至≤${maxChars}字）----`);
console.log(body);
