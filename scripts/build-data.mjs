// build-data.mjs — 把 Inside Active 的 EN txt + ZH md + manifest 合成结构化 episode JSON
// 用法: node scripts/build-data.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');            // podcast-site/
const WS = path.resolve(ROOT, '..');                    // workspace/
const EN_DIR = path.join(WS, 'inside_active_transcripts');
const ZH_DIR = path.join(WS, 'inside_active_zh_transcripts');
const OUT_DIR = path.join(ROOT, 'src', 'data', 'episodes', 'inside-active');

const IDS = [342308556, 341580520, 340907563, 340369357, 339933551];

// 每集中文标题（人工翻译）+ 说话人姓名映射（1 通常是主持 David Cohne）
const EP_CONFIG = {
  342308556: {
    title_zh: '彭博 Henry Jim 谈欧洲主动型 ETF 的前景',
    speakers: { 1: 'David Cohne（主持）', 2: 'Henry Jim', 3: '嘉宾' },
  },
  341580520: {
    title_zh: 'GSAM 的 Byron Lake 与 Innovator 的 Graham Day 谈"结果导向"的主动管理',
    speakers: { 1: 'David Cohne（主持）', 2: 'Byron Lake', 3: 'Graham Day' },
  },
  340907563: {
    title_zh: 'Moerus 的 Amit Wadhwaney 谈基于资产的价值投资',
    speakers: { 1: 'David Cohne（主持）', 2: 'Amit Wadhwaney', 3: '嘉宾', 4: '嘉宾' },
  },
  340369357: {
    title_zh: 'Michael Ervolini 谈如何区分投资中的实力与运气',
    speakers: { 1: 'David Cohne（主持）', 2: 'Michael Ervolini' },
  },
  339933551: {
    title_zh: 'Rainwater 的 Joseph Shaposhnik 谈投资"可预测的生意"',
    speakers: { 1: 'David Cohne（主持）', 2: 'Joseph Shaposhnik' },
  },
};

function slugify(id, title, date) {
  const base = title
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-');
  return `${date}-${base}-${id}`;
}

// 按 "Speaker N:" 独立成行拆分 EN
function parseEN(text) {
  const lines = text.split(/\r?\n/);
  const turns = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^\s*Speaker\s+(\d+)\s*:\s*(.*)$/);
    if (m) {
      if (cur) turns.push(cur);
      cur = { speaker: Number(m[1]), text: m[2].trim() };
    } else if (cur && line.trim()) {
      cur.text += (cur.text ? ' ' : '') + line.trim();
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

// 按 "说话人 N：" 独立成行/段拆分 ZH
function parseZH(text) {
  // 去掉可能的 markdown 标题头
  const lines = text.split(/\r?\n/);
  const turns = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^\s*说话人\s*(\d+)\s*[：:]\s*(.*)$/);
    if (m) {
      if (cur) turns.push(cur);
      cur = { speaker: Number(m[1]), text: m[2].trim() };
    } else if (cur && line.trim() && !line.startsWith('#')) {
      cur.text += (cur.text ? '' : '') + line.trim();
    }
  }
  if (cur) turns.push(cur);
  return turns;
}

const manifest = JSON.parse(fs.readFileSync(path.join(EN_DIR, 'manifest.json'), 'utf8'));
fs.mkdirSync(OUT_DIR, { recursive: true });

const index = [];
for (const id of IDS) {
  const meta = manifest.episodes.find((e) => e.episode_id === id);
  if (!meta) { console.error('manifest 缺少', id); continue; }

  // 定位 EN / ZH 文件
  const enFile = fs.readdirSync(EN_DIR).find((f) => f.endsWith(`_${id}.txt`));
  const zhFile = fs.readdirSync(ZH_DIR).find((f) => f.endsWith(`_${id}.zh.md`));
  if (!enFile || !zhFile) { console.error('缺 EN/ZH 文件', id, enFile, zhFile); continue; }

  const enTurns = parseEN(fs.readFileSync(path.join(EN_DIR, enFile), 'utf8'));
  const zhTurns = parseZH(fs.readFileSync(path.join(ZH_DIR, zhFile), 'utf8'));

  const n = Math.min(enTurns.length, zhTurns.length);
  if (enTurns.length !== zhTurns.length) {
    console.warn(`⚠ ${id} 轮次不一致 EN=${enTurns.length} ZH=${zhTurns.length}，按 ${n} 对齐`);
  }

  const cfg = EP_CONFIG[id] || { title_zh: meta.title, speakers: {} };
  const turns = [];
  for (let i = 0; i < n; i++) {
    turns.push({
      i,
      speaker: enTurns[i].speaker,
      speaker_zh: zhTurns[i].speaker,
      ts: null, // 生产环境由 Actions 抓取器回填 Omny SubRip 时间戳
      en: enTurns[i].text,
      zh: zhTurns[i].text,
    });
  }

  const slug = slugify(id, meta.title, meta.date);
  const ep = {
    show: 'inside-active',
    id: String(id),
    guid: meta.guid,
    slug,
    date: meta.date,
    title_en: meta.title,
    title_zh: cfg.title_zh,
    description: meta.description,
    duration: meta.duration,
    duration_seconds: meta.duration_seconds,
    episode_url: meta.episode_url,
    audio_url: null, // 生产环境回填 mp3
    speakers: cfg.speakers,
    turn_count: turns.length,
    turns,
  };

  fs.writeFileSync(path.join(OUT_DIR, `${slug}.json`), JSON.stringify(ep, null, 2));
  index.push({ id: ep.id, slug, date: ep.date, title_en: ep.title_en, title_zh: ep.title_zh, turns: turns.length });
  console.log(`✓ ${id} → ${slug}.json  (${turns.length} turns)`);
}

fs.writeFileSync(path.join(OUT_DIR, '_index.json'), JSON.stringify(index, null, 2));
console.log('\n共写入', index.length, '集');
