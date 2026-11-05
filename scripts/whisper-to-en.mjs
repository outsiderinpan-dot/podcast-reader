// whisper-to-en.mjs — 把 openai-whisper 的 JSON 输出转成翻译流水线要的 en.json + meta.json。
//
// 用法:
//   node scripts/whisper-to-en.mjs <whisper.json> <outDir> <manifestEntryJson>
//     <whisper.json>       whisper --output_format json 产出的文件（含 segments:[{start,end,text}]）
//     <outDir>             输出目录
//     <manifestEntryJson>  一个 JSON 字符串（或指向 json 文件的路径），含 prefix/show/ep_id/slug/date/title_en/audio_url/guid
//
// 产出:
//   <outDir>/<prefix>.en.json    [{speaker:1, ts:<秒>, text:<英文>}]  —— Whisper 无说话人分轨，speaker 恒为 1，
//                                 说话人归属留给后续 editorial.turn_speakers 从零推断（同 Captivate 无分轨情形）。
//   <outDir>/<prefix>.meta.json  {show,ep_id,guid,slug,date,title_en,duration_sec,episode_url,audio_url,transcript_src}
import fs from 'node:fs';
import path from 'node:path';

const [wjsonPath, outDir, entryArg] = process.argv.slice(2);
if (!wjsonPath || !outDir || !entryArg) {
  console.error('usage: node scripts/whisper-to-en.mjs <whisper.json> <outDir> <manifestEntryJson|path>');
  process.exit(1);
}

const entry = fs.existsSync(entryArg)
  ? JSON.parse(fs.readFileSync(entryArg, 'utf8'))
  : JSON.parse(entryArg);

const wj = JSON.parse(fs.readFileSync(wjsonPath, 'utf8'));
const segs = Array.isArray(wj.segments) ? wj.segments : [];
if (!segs.length) { console.error('no segments in whisper json'); process.exit(1); }

const turns = [];
for (const s of segs) {
  const text = String(s.text || '').replace(/\s+/g, ' ').trim();
  if (!text) continue;
  const start = Number(s.start) || 0;
  turns.push({ speaker: 1, ts: Math.max(0, Math.round(start)), text });
}
if (!turns.length) { console.error('all segments empty'); process.exit(1); }

const lastEnd = Math.round(Number(segs[segs.length - 1]?.end) || 0);

fs.mkdirSync(outDir, { recursive: true });
const prefix = entry.prefix;
fs.writeFileSync(path.join(outDir, `${prefix}.en.json`), JSON.stringify(turns, null, 2));
const meta = {
  record_id: '',
  show: entry.show,
  ep_id: entry.ep_id,
  guid: entry.guid || '',
  slug: entry.slug,
  date: entry.date,
  title_en: entry.title_en,
  duration_sec: lastEnd,
  episode_url: entry.episode_url || '',
  audio_url: entry.audio_url || '',
  iheart_id: entry.iheart_id || '',
  transcript_src: `whisper:${entry.model || 'small'}`,
};
fs.writeFileSync(path.join(outDir, `${prefix}.meta.json`), JSON.stringify(meta, null, 2));
console.log(`OK ${prefix}: ${turns.length} turns, dur=${lastEnd}s -> ${outDir}/${prefix}.en.json + .meta.json`);
