// scrape.mjs — 生产抓取器（在 GitHub Actions 里跑，有外网）
//
// 流程（对 shows.json 里每个节目）：
//   1. 拉最新单集列表（iHeart API → 失败回退节目页 HTML 正则）
//   2. 跳过 _index.json 里已存在的单集（幂等）
//   3. 对每个新单集：拿 Omny clip guid + mp3（单集页 HTML 正则）
//   4. 拉 Omny SubRip 字幕 → 解析成带时间戳的说话人轮次
//   5. 调 LLM（OpenAI 兼容接口）生成中文标题/说话人名 + 逐段中文精读
//   6. 写 src/data/episodes/{show}/{slug}.json 并重建 _index.json
//
// 环境变量：
//   LLM_API_KEY   必填（DeepSeek / OpenAI 等任意 OpenAI 兼容 key）
//   LLM_BASE_URL  可选，默认 https://api.deepseek.com/v1
//   LLM_MODEL     可选，默认 deepseek-chat
//   MAX_NEW       可选，每次最多处理几集新单集，默认 3
//
// 用法: node scripts/scrape.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOWS = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'shows.json'), 'utf8'));

const LLM_BASE = (process.env.LLM_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
const LLM_KEY = process.env.LLM_API_KEY || '';
const LLM_MODEL = process.env.LLM_MODEL || 'deepseek-chat';
const MAX_NEW = Number(process.env.MAX_NEW || 3);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function log(...a) {
  console.log('[scrape]', ...a);
}

async function getJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}

// ---------- 单集列表 ----------
// 返回 [{ id, title, description, date, duration_seconds, episode_url, guid? }]
async function fetchEpisodeList(show) {
  const candidates = [
    `https://api.iheart.com/api/v3/podcast/id/${show.iheartId}/episodes?limit=15&offset=0`,
    `https://api.iheart.com/api/v3/podcast/id/${show.iheartId}?limit=15`,
  ];
  for (const url of candidates) {
    try {
      const j = await getJson(url);
      const arr = Array.isArray(j) ? j : j.episodes || j.data || j.content || [];
      if (!Array.isArray(arr) || !arr.length) continue;
      const eps = arr
        .map((e) => normalizeIheartEp(e, show))
        .filter((e) => e && e.id && e.title);
      if (eps.length) {
        log(`${show.slug}: iHeart API 取到 ${eps.length} 集`);
        return eps;
      }
    } catch (err) {
      log(`${show.slug}: API 候选失败 ${url} → ${err.message}`);
    }
  }
  // 回退：节目页 HTML 正则抓 episode 链接（只有 id/slug，其余字段后续补）
  const html = await getText(show.homeUrl);
  const re = /\/episode\/([^"']+?-)(\d{6,12})\/?"/g;
  const seen = new Map();
  let m;
  while ((m = re.exec(html))) {
    const slugPart = m[1];
    const id = m[2];
    if (!seen.has(id)) {
      seen.set(id, {
        id,
        title: slugPart.replace(/-+$/, '').replace(/-/g, ' '),
        description: '',
        date: null,
        duration_seconds: null,
        episode_url: `https://www.iheart.com/podcast/${show.homeUrl.split('/podcast/')[1]}/episode/${slugPart}${id}/`,
        guid: null,
      });
    }
  }
  const eps = [...seen.values()].slice(0, 15);
  log(`${show.slug}: 节目页回退取到 ${eps.length} 集`);
  return eps;
}

function normalizeIheartEp(e, show) {
  const id = String(e.id ?? e.episodeId ?? '');
  if (!id) return null;
  const published = e.publishedAt || e.startDate || e.updatedDate || e.releaseDate || null;
  const date = published ? String(published).slice(0, 10) : null;
  let secs = e.duration ?? e.durationInSeconds ?? null;
  if (secs && secs > 100000) secs = Math.round(secs / 1000); // ms → s
  return {
    id,
    title: e.title || '',
    description: e.description || '',
    date,
    duration_seconds: secs,
    episode_url:
      e.url ||
      e.episodeUrl ||
      `https://www.iheart.com/podcast/${show.iheartId}/episode/${(e.slug || '').replace(/\/$/, '')}-${id}/`,
    guid: e.guid || e.omnyId || e.contentGuid || null,
  };
}

// ---------- 单集页：guid + mp3 ----------
async function enrichFromPage(ep, show) {
  if (ep.guid && ep.audio_url) return ep;
  try {
    const html = await getText(ep.episode_url);
    if (!ep.guid) {
      const g = html.match(/api\.omny\.fm\/orgs\/([0-9a-f-]+)\/clips\/([0-9a-f-]+)/i);
      if (g) ep.guid = g[2];
      else {
        const g2 = html.match(/"guid"\s*:\s*"([0-9a-f-]{36})"/i);
        if (g2) ep.guid = g2[1];
      }
    }
    if (!ep.audio_url) {
      const a = html.match(/https?:\/\/[^"'\s]+?\.mp3[^"'\s]*/i);
      if (a) ep.audio_url = a[0].replace(/&amp;/g, '&');
    }
    if (!ep.description) {
      const d = html.match(/<meta[^>]+name="description"[^>]+content="([^"]+)"/i);
      if (d) ep.description = d[1];
    }
  } catch (err) {
    log(`  ⚠ 单集页抓取失败 ${ep.id}: ${err.message}`);
  }
  return ep;
}

// ---------- Omny SubRip ----------
function subripUrl(show, guid) {
  const t = Math.floor(Date.now() / 1000);
  return `https://api.omny.fm/orgs/${show.omnyOrgId}/clips/${guid}/transcript?format=SubRip&t=${t}`;
}

function tsToSec(ts) {
  // 00:01:02,345 → 3723.345
  const m = ts.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
}

const PRIVACY_RE = /omny\.fm|privacy|cookie/i;

// 解析 SubRip → 轮次 [{ speaker, ts, text }]（合并同说话人连续 cue）
function parseSubRip(srt) {
  const blocks = srt.replace(/\r/g, '').split(/\n\n+/);
  const turns = [];
  let cur = null;
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const [start] = timeLine.split('-->');
    const textLines = lines.slice(lines.indexOf(timeLine) + 1);
    let text = textLines.join(' ').trim();
    if (!text || PRIVACY_RE.test(text) && text.length < 160) continue;
    const sm = text.match(/^\s*Speaker\s+(\d+)\s*[:：]\s*(.*)$/);
    let speaker = null;
    if (sm) {
      speaker = Number(sm[1]);
      text = sm[2].trim();
    }
    if (!text) continue;
    if (cur && cur.speaker === speaker) {
      cur.text += (cur.text ? ' ' : '') + text;
    } else {
      cur = { speaker: speaker ?? 1, ts: Math.round(tsToSec(start.trim())), text };
      turns.push(cur);
    }
  }
  return turns;
}

// ---------- LLM ----------
async function llmJson(system, user, maxTokens = 4000) {
  const res = await fetch(`${LLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${LLM_KEY}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      temperature: 0.3,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content || '';
  const clean = content.replace(/```json/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('LLM 未返回 JSON: ' + content.slice(0, 200));
  return JSON.parse(clean.slice(start, end + 1));
}

async function llmMeta(ep, turns, show) {
  const sample = turns.slice(0, 6).map((t) => `Speaker ${t.speaker}: ${t.text.slice(0, 400)}`).join('\n');
  const sys =
    '你是金融播客中文编辑。只输出 JSON，不要解释。字段：title_zh（中文标题，简洁、含嘉宾姓名与机构、保留人名/机构英文）、speakers（对象，键为说话人编号字符串，值为显示名；主持加"（主持）"后缀，人名保留英文）。';
  const user = `节目：${show.title}（${show.publisher}）。默认主持名：${show.default_host || '主持'}。\n英文标题：${ep.title}\n简介：${ep.description}\n开头转写：\n${sample}\n请输出 JSON。`;
  return llmJson(sys, user, 800);
}

async function llmTranslateBatch(batch) {
  const sys =
    '你是金融播客中文精读译者。把每段英文口语转写译成流畅中文：口语自然、不书面腔；专业术语首次出现时括注英文（如 投资流程（investment process））；人名/机构名/书名保留英文；不增删观点。只输出 JSON 数组 [{"i":编号,"zh":"中文"}]，与输入一一对应。';
  const user = JSON.stringify(batch.map((t) => ({ i: t.i, en: t.text })));
  const out = await llmJson(sys, user, 8000);
  const arr = Array.isArray(out) ? out : out.zh || out.turns || [];
  if (!Array.isArray(arr)) throw new Error('翻译返回非数组');
  return arr;
}

// ---------- slug / index ----------
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

function rebuildIndex(showDir) {
  const files = fs.readdirSync(showDir).filter((f) => f.endsWith('.json') && f !== '_index.json');
  const idx = files
    .map((f) => JSON.parse(fs.readFileSync(path.join(showDir, f), 'utf8')))
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .map((e) => ({
      id: e.id,
      slug: e.slug,
      date: e.date,
      title_en: e.title_en,
      title_zh: e.title_zh,
      turns: e.turn_count,
    }));
  fs.writeFileSync(path.join(showDir, '_index.json'), JSON.stringify(idx, null, 2));
  return idx.length;
}

// ---------- 主流程 ----------
async function processShow(show) {
  const showDir = path.join(ROOT, 'src', 'data', 'episodes', show.slug);
  fs.mkdirSync(showDir, { recursive: true });
  const indexPath = path.join(showDir, '_index.json');
  const existing = fs.existsSync(indexPath)
    ? new Set(JSON.parse(fs.readFileSync(indexPath, 'utf8')).map((e) => String(e.id)))
    : new Set();

  const list = await fetchEpisodeList(show);
  const fresh = list.filter((e) => !existing.has(String(e.id))).slice(0, MAX_NEW);
  if (!fresh.length) {
    log(`${show.slug}: 无新单集`);
    return 0;
  }
  log(`${show.slug}: 发现 ${fresh.length} 集新单集 → ${fresh.map((e) => e.id).join(', ')}`);

  let done = 0;
  for (const ep of fresh) {
    try {
      await enrichFromPage(ep, show);
      if (!ep.guid) {
        log(`  ✗ ${ep.id} 拿不到 Omny guid，跳过`);
        continue;
      }
      const srt = await getText(subripUrl(show, ep.guid));
      const turns = parseSubRip(srt);
      if (turns.length < 4) {
        log(`  ✗ ${ep.id} SubRip 轮次过少 (${turns.length})，跳过`);
        continue;
      }
      log(`  · ${ep.id} SubRip ${turns.length} 轮`);

      // 中文标题 + 说话人名
      const meta = await llmMeta(ep, turns, show);
      const speakers = meta.speakers || {};
      if (!speakers['1']) speakers['1'] = show.default_host || '主持';

      // 分批翻译
      const translated = [];
      const BATCH = 6;
      for (let s = 0; s < turns.length; s += BATCH) {
        const batch = turns.slice(s, s + BATCH).map((t, k) => ({ ...t, i: s + k }));
        const zhArr = await llmTranslateBatch(batch);
        const byI = new Map(zhArr.map((z) => [Number(z.i), z.zh]));
        for (const t of batch) translated.push({ ...t, zh: byI.get(t.i) ?? '' });
        log(`    翻译 ${Math.min(s + BATCH, turns.length)}/${turns.length}`);
      }
      if (translated.some((t) => !t.zh)) {
        log(`  ✗ ${ep.id} 翻译有空段，跳过本集`);
        continue;
      }

      const date = ep.date || new Date().toISOString().slice(0, 10);
      const slug = slugify(ep.id, ep.title, date);
      const doc = {
        show: show.slug,
        id: String(ep.id),
        guid: ep.guid,
        slug,
        date,
        title_en: ep.title,
        title_zh: meta.title_zh || ep.title,
        description: ep.description,
        duration: ep.duration_seconds ? fmtDur(ep.duration_seconds) : null,
        duration_seconds: ep.duration_seconds,
        episode_url: ep.episode_url,
        audio_url: ep.audio_url || null,
        speakers,
        turn_count: translated.length,
        turns: translated.map((t, i) => ({
          i,
          speaker: t.speaker,
          speaker_zh: t.speaker,
          ts: t.ts,
          en: t.text,
          zh: t.zh,
        })),
      };
      fs.writeFileSync(path.join(showDir, `${slug}.json`), JSON.stringify(doc, null, 2));
      log(`  ✓ ${ep.id} → ${slug}.json (${translated.length} turns)`);
      done++;
    } catch (err) {
      log(`  ✗ ${ep.id} 处理失败: ${err.message}`);
    }
  }
  const n = rebuildIndex(showDir);
  log(`${show.slug}: _index.json 重建，共 ${n} 集`);
  return done;
}

function fmtDur(s) {
  const m = Math.round(s / 60);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}

async function main() {
  if (!LLM_KEY) {
    console.error('[scrape] 缺少 LLM_API_KEY，无法翻译。请在 Actions Secrets 配置后重试。');
    process.exit(1);
  }
  let total = 0;
  for (const show of SHOWS) {
    try {
      total += await processShow(show);
    } catch (err) {
      log(`${show.slug} 整体失败: ${err.message}`);
    }
  }
  log(`完成，新增 ${total} 集`);
}

export { parseSubRip, slugify, tsToSec };

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
