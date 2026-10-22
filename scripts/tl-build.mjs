// tl-build.mjs <prefix>
// 翻译期工具②：把 <prefix>.meta.json + <prefix>.en.json + 中文译文 + <prefix>.editorial.json
// 组装成站点单集 JSON <prefix>.episode.json，并做发布前校验（段数 1:1、无空译、说话人全标注）。
//
// 中文译文来源二选一：
//   - 分块文件 <prefix>.zh.000.json / .001.json ...（每个是 JSON 字符串数组，按名排序拼接）——适合长集
//   - 单文件   <prefix>.zh.json（一个 JSON 字符串数组）
// 数组长度必须与 <prefix>.en.json 的段数完全一致。
//
// <prefix>.editorial.json：
//   { "title_zh": "...", "subtitle_zh": "...", "speakers": {"1":"Name（主持）","2":"Name"},
//     "turn_speakers": [<可选，与段数等长的整数数组，用于逐段重指派说话人>] }
//   说话人重指派用于：Captivate 字幕无分轨（全归 1）、Omny 过度分轨（切成多个）时按内容归并。
import fs from 'node:fs';

const prefix = process.argv[2];
if (!prefix) { console.error('usage: node scripts/tl-build.mjs <prefix>'); process.exit(1); }

const meta = JSON.parse(fs.readFileSync(`${prefix}.meta.json`, 'utf8'));
const en = JSON.parse(fs.readFileSync(`${prefix}.en.json`, 'utf8'));

let zh;
const chunkFiles = fs.readdirSync('.').filter((f) => f.startsWith(`${prefix}.zh.`) && f.endsWith('.json')).sort();
if (chunkFiles.length) {
  zh = [];
  for (const cf of chunkFiles) {
    const part = JSON.parse(fs.readFileSync(cf, 'utf8'));
    if (!Array.isArray(part)) { console.error(`${cf} must be an array`); process.exit(1); }
    zh.push(...part);
  }
  console.log(`zh chunks: ${chunkFiles.join(', ')} -> ${zh.length} strings`);
} else {
  zh = JSON.parse(fs.readFileSync(`${prefix}.zh.json`, 'utf8'));
}
const ed = JSON.parse(fs.readFileSync(`${prefix}.editorial.json`, 'utf8'));

if (!Array.isArray(zh)) { console.error('zh must be an array'); process.exit(1); }
if (en.length !== zh.length) { console.error(`TURN COUNT MISMATCH en=${en.length} zh=${zh.length}`); process.exit(1); }

const mmss = (sec) => { const s = Math.max(0, Math.round(Number(sec) || 0)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

const empties = zh.map((z, i) => (!z || !String(z).trim()) ? i : null).filter((x) => x !== null);
if (empties.length) { console.error('EMPTY zh at turns:', empties.join(',')); process.exit(1); }

let spkOverride = null;
if (Array.isArray(ed.turn_speakers)) {
  if (ed.turn_speakers.length !== en.length) { console.error(`turn_speakers length ${ed.turn_speakers.length} != turns ${en.length}`); process.exit(1); }
  spkOverride = ed.turn_speakers;
}
const turns = en.map((t, i) => {
  const sp = spkOverride ? Number(spkOverride[i]) : t.speaker;
  return { i, speaker: sp, speaker_zh: sp, ts: t.ts == null ? null : mmss(t.ts), en: t.text, zh: zh[i] };
});

const durSec = Number(meta.duration_sec) || 0;
const dur = `${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, '0')}`;

if (!ed.speakers || typeof ed.speakers !== 'object') { console.error('editorial.speakers missing'); process.exit(1); }
const seenSpeakers = [...new Set(turns.map((t) => t.speaker))];
const missingSp = seenSpeakers.filter((s) => !ed.speakers[String(s)]);
if (missingSp.length) { console.error(`speakers map missing labels for: ${missingSp.join(',')}`); process.exit(1); }

const doc = {
  show: meta.show, kind: 'transcript', id: meta.ep_id,
  ...(meta.guid ? { guid: meta.guid } : {}),
  slug: meta.slug, date: meta.date,
  title_en: meta.title_en, title_zh: ed.title_zh, subtitle_zh: ed.subtitle_zh,
  description: meta.title_en, duration: dur, duration_seconds: durSec,
  episode_url: meta.episode_url || null, audio_url: meta.audio_url || null,
  speakers: ed.speakers, turn_count: turns.length, turns,
};

fs.writeFileSync(`${prefix}.episode.json`, JSON.stringify(doc, null, 2));
const zhChars = turns.reduce((s, t) => s + (t.zh?.length || 0), 0);
console.log(`OK ${prefix}.episode.json | turns=${turns.length} | zh chars=${zhChars} | ~read ${Math.max(1, Math.round(zhChars / 400))} min | dur=${dur}`);
console.log(`  title_zh: ${doc.title_zh}`);
console.log(`  speakers: ${JSON.stringify(doc.speakers)}`);
