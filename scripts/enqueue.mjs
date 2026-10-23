// enqueue.mjs — 第一段：只抓英文转写，写入飞书多维表格「翻译队列」。在 GitHub Actions 里跑（有外网）。
//
// 为什么这样拆：
//   - GitHub Actions 能访问 iheart/omny/captivate/rss/音频等外网，但没有你的 Qoder/飞书翻译额度；
//   - QoderWork（我）能访问飞书，但本地网络到不了 github/omny；
//   - 所以让 Actions 只负责「抓英文原文 + 入队」，把英文塞进飞书多维表格；
//     再由我从飞书队列取英文、用你的 Qoder 额度翻译、建站、发布、回写 done。
//   - 全程不需要任何 LLM API Key（Whisper 是本地开源 ASR，也不要 key）。
//
// ============ 多策略解析链（按顺序尝试，命中即止） ============
//   每个节目在 shows.json 里带 source 字段：
//     source="iheart"   → 走 iHeart 两步 API（列表 + 详情），拿 transcription.transcriptionLocation 字幕直链
//     source="rss"      → 拉 RSS，优先用 <podcast:transcript> 标签里的字幕直链（Podcasting 2.0）
//     source="official" → 跳过（article 类节目，如 lex-fridman，由 QoderWork 手动补录）
//   任一来源拿不到「带时间轴的官方字幕」时，统一兜底到 Whisper：
//     下载音频（iHeart mediaUrl / RSS enclosure）→ whisper CLI 转写 → 解析 SRT → 入队
//   Whisper 有预算上限（WHISPER_MAX_PER_RUN），避免首次回填 20 个节目把 6 小时 Actions 跑爆。
//
// ⚠️ 2026-10 iHeart API 变更（旧抓取方式已失效）：
//   旧 `api.iheart.com/api/v3/podcast/id/{id}/episodes` 现返回 404。
//   新两步法（本脚本已用）：
//     ① 列表：GET https://ww.api.iheart.com/api/v3/podcast/podcasts/{iheartId}/episodes?limit=N
//        → { data:[ { id, podcastSlug, title, duration(秒), startDate(epoch ms), transcriptionAvailable, ... } ] }
//     ② 详情：GET https://ww.api.iheart.com/api/v3/podcast/episodes/{epId}
//        → { episode:{ mediaUrl, transcriptionAvailable,
//                      transcription:{ transcriptionLocation, transcriptionType, languageCode } } }
//   transcriptionAvailable=true 时，transcriptionLocation 就是可直接下载的字幕直链
//   （Bloomberg 系 = Omny SubRip；Top Traders 等 = Captivate SRT）。无需 omnyOrgId、无需扒 HTML 找 guid。
//
// 多维表格每行字段：
//   show / ep_id / status(pending) / title_en / date / duration_sec / episode_url(超链接)
//   audio_url / guid / word_count / turns_en(JSON:[{speaker,ts,text}]) / slug / transcript_src / enqueued_at
//
// 环境变量（GitHub Actions Secrets / Variables）：
//   FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BITABLE_TOKEN / FEISHU_TABLE_ID   （必需）
//   MAX_NEW              可选，每个节目每次最多入队几集，默认 3
//   WHISPER_ENABLED      可选，"0"/"false" 关闭 Whisper 兜底，默认 true
//   WHISPER_MODEL        可选，Whisper 模型，默认 small（tiny/base/small/medium）
//   WHISPER_MAX_PER_RUN  可选，本次运行最多 Whisper 转写几集，默认 3
//
// 用法: node scripts/enqueue.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { chunkFields } from './feishu-chunk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOWS_ALL = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'data', 'shows.json'), 'utf8'));
// SHOWS_FILTER：可选，逗号分隔的 show.slug 白名单。用于把一次全量回填拆成多个互不重叠的子集，
// 并行触发多个 Actions run（各自只处理自己那几档），避免串行等待十几个小时的 Whisper CPU 时间，
// 也避免并发 run 争抢同一批节目导致重复入队。未设置时处理全部节目（周更常态）。
const SHOWS_FILTER = (process.env.SHOWS_FILTER || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const SHOWS = SHOWS_FILTER.length
  ? SHOWS_ALL.filter((s) => SHOWS_FILTER.includes(s.slug))
  : SHOWS_ALL;
if (SHOWS_FILTER.length) {
  console.log(`[enqueue] SHOWS_FILTER 命中 ${SHOWS.length}/${SHOWS_ALL.length} 档: ${SHOWS.map((s) => s.slug).join(', ')}`);
  const missed = SHOWS_FILTER.filter((f) => !SHOWS_ALL.some((s) => s.slug === f));
  if (missed.length) console.log(`[enqueue] ⚠ SHOWS_FILTER 中未匹配到 shows.json 的 slug: ${missed.join(', ')}`);
}

const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const BITABLE = process.env.FEISHU_BITABLE_TOKEN || '';
const TABLE = process.env.FEISHU_TABLE_ID || '';
const MAX_NEW = Number(process.env.MAX_NEW || 3);

const WHISPER_ENABLED = !/^(0|false|no)$/i.test(process.env.WHISPER_ENABLED || 'true');
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'small';
const WHISPER_MAX_PER_RUN = Number(process.env.WHISPER_MAX_PER_RUN || 3);
let whisperUsed = 0;

const IHEART_API = 'https://ww.api.iheart.com/api/v3';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

function log(...a) {
  console.log('[enqueue]', ...a);
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

async function downloadFile(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} 下载失败 ${url}`);
  if (!res.body) throw new Error(`响应无 body ${url}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  const size = fs.statSync(dest).size;
  if (size < 1024) throw new Error(`下载文件过小 (${size}B)，疑似失败 ${url}`);
  return size;
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} 退出码 ${code}: ${stderr.slice(-600)}`));
    });
  });
}

// ---------- 飞书 tenant_access_token ----------
// ⚠️ tenant_access_token 有效期仅 ~2 小时。Whisper 兜底单轮要跑 3-5h，早期把 token 永久缓存
//    导致运行中途 token 过期、后续 bitableCreate 全部报 99991663（Invalid access token）。
//    这里改为记录过期时间戳，剩余 < 5 分钟即自动重取。
let TOKEN = '';
let TOKEN_EXP = 0; // epoch ms，token 过期时刻
async function feishuToken() {
  if (TOKEN && Date.now() < TOKEN_EXP - 5 * 60 * 1000) return TOKEN;
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`飞书取 token 失败: ${j.msg} (code=${j.code})`);
  TOKEN = j.tenant_access_token;
  // expire 单位秒；缺失时保守按 100 分钟计。
  TOKEN_EXP = Date.now() + (Number(j.expire) > 0 ? Number(j.expire) : 6000) * 1000;
  return TOKEN;
}

async function bitableSearch() {
  const token = await feishuToken();
  // 分页拉全量：队列随周更不断增长，只取首页会在超过 500 行后漏掉旧记录、再次触发重复入队。
  const out = [];
  let pageToken = '';
  do {
    const url =
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${BITABLE}/tables/${TABLE}/records/search` +
      `?page_size=500${pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ automatic_fields: false }),
    });
    const j = await res.json();
    if (j.code !== 0) throw new Error(`飞书查询记录失败: ${j.msg} (code=${j.code})`);
    out.push(...(j.data?.items || []).map((r) => ({ record_id: r.record_id, fields: r.fields })));
    pageToken = j.data?.has_more ? (j.data?.page_token || '') : '';
  } while (pageToken);
  return out;
}

async function bitableCreate(fields) {
  const token = await feishuToken();
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BITABLE}/tables/${TABLE}/records`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`飞书写入记录失败: ${j.msg} (code=${j.code})`);
  return j.data?.record?.record_id;
}

// ================= SRT/VTT 解析 =================
function tsToSec(ts) {
  const m = String(ts).trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (m) return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
  const m2 = String(ts).trim().match(/(\d+):(\d+)[,.](\d+)/); // 少数 VTT 只有 MM:SS.mmm
  if (m2) return (+m2[1]) * 60 + (+m2[2]) + (+m2[3]) / 1000;
  return 0;
}

// 过滤片头隐私/Cookie/订阅提示等噪声短 cue
const PRIVACY_RE = /omny\.fm|privacy|cookie|subscribe to our|terms of use|listen ad-free/i;

// 兼容 SRT（1,234）与 VTT（1.234）；把 --> 行拆成 [start, end] 秒。
function parseTimeLine(line) {
  const parts = String(line).split('-->');
  if (parts.length < 2) return null;
  return { start: tsToSec(parts[0]), end: tsToSec(parts[1]) };
}

// 把字幕块解析成「说话人轮次」。
// 关键：Omny 字幕带 `Speaker N:` 前缀，可按说话人合并；Captivate / Whisper 字幕【没有】说话人标签，
//       若沿用旧的「同说话人就合并」逻辑，整集会塌成 1 轮。因此这里对 speaker=null 的情况改为
//       「按时间间隔 + 长度」分段：相邻 cue 间隔 < gapSec 且累计长度 < maxChars 才并入当前轮。
function parseSubRip(srt, { gapSec = 1.2, maxChars = 340 } = {}) {
  const blocks = String(srt)
    .replace(/\r/g, '')
    .replace(/^\uFEFF/, '')
    .split(/\n\n+/);
  const turns = [];
  let cur = null; // { speaker, ts, end, text }
  for (const b of blocks) {
    const lines = b.split('\n').filter((l) => l.trim() !== '');
    const timeLine = lines.find((l) => l.includes('-->'));
    if (!timeLine) continue;
    const tl = parseTimeLine(timeLine);
    if (!tl) continue;
    const textLines = lines.slice(lines.indexOf(timeLine) + 1);
    let text = textLines.join(' ').replace(/<[^>]+>/g, '').trim(); // 去掉 <i>/<b> 等内联标签
    if (!text || (PRIVACY_RE.test(text) && text.length < 160)) continue;
    const sm = text.match(/^\s*Speaker\s+(\d+)\s*[:：]\s*(.*)$/i);
    let speaker = null;
    if (sm) {
      speaker = Number(sm[1]);
      text = sm[2].trim();
    }
    if (!text) continue;

    if (cur && speaker !== null && cur.speaker === speaker) {
      // 有说话人标签：同一说话人连续 cue 直接合并
      cur.text += (cur.text ? ' ' : '') + text;
      cur.end = Math.max(cur.end, tl.end);
    } else if (cur && speaker === null && cur.speaker === null && tl.start - cur.end < gapSec && cur.text.length + text.length < maxChars) {
      // 无说话人标签：靠时间间隔 + 长度分段
      cur.text += (cur.text ? ' ' : '') + text;
      cur.end = Math.max(cur.end, tl.end);
    } else {
      cur = { speaker, ts: Math.round(tl.start), end: tl.end, text };
      turns.push(cur);
    }
  }
  // finalize：null speaker → 1（单人叙述/未区分），并去掉内部 end 字段
  return turns.map((t) => ({ speaker: t.speaker ?? 1, ts: t.ts, text: t.text }));
}

// ================= RSS 解析 =================
function decodeEntities(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // 最后处理，避免二次解码
}

// 从一段 item XML 里取某标签的文本内容（自动去 CDATA + 实体解码）
function tagText(item, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = item.match(re);
  if (!m) return '';
  return decodeEntities(m[1]).trim();
}

// 取标签属性，如 <enclosure url="..." type="...">
function tagAttr(item, tag, attr) {
  const re = new RegExp(`<${tag}\\b[^>]*?\\b${attr}\\s*=\\s*"([^"]*)"`, 'i');
  const m = item.match(re);
  return m ? decodeEntities(m[1]).trim() : '';
}

// itunes:duration 有两种格式：H:MM:SS（或 MM:SS）与纯秒数
function parseDuration(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (s.includes(':')) {
    const parts = s.split(':').map((x) => parseInt(x, 10) || 0);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return null;
  }
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function parseDateToYmd(pubDate) {
  if (!pubDate) return null;
  const d = new Date(pubDate);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

// 解析 RSS 的所有 <item>，返回统一结构数组
function parseItems(xml) {
  const raw = String(xml).replace(/\r/g, '');
  const itemBlocks = raw.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const items = [];
  for (const item of itemBlocks) {
    const title = tagText(item, 'title');
    const guid = tagText(item, 'guid') || tagText(item, 'link');
    const link = tagText(item, 'link') || guid;
    const pubDate = tagText(item, 'pubDate');
    const enclosureUrl = tagAttr(item, 'enclosure', 'url');
    const duration = parseDuration(tagText(item, 'itunes:duration'));
    // Podcasting 2.0：<podcast:transcript url="..." type="..." />
    const transcriptUrl = tagAttr(item, 'podcast:transcript', 'url');
    const transcriptType = tagAttr(item, 'podcast:transcript', 'type');
    const description = tagText(item, 'description') || tagText(item, 'itunes:summary');
    if (!guid && !title) continue;
    items.push({
      title,
      guid,
      link,
      date: parseDateToYmd(pubDate),
      audio_url: enclosureUrl,
      duration_seconds: duration,
      transcript_url: transcriptUrl || null,
      transcript_type: transcriptType || null,
      description,
    });
  }
  return items;
}

async function fetchFeed(feedUrl) {
  const xml = await getText(feedUrl);
  return parseItems(xml);
}

// ================= 通用工具 =================
function slugifyTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function slugify(idPart, title, date) {
  const base = slugifyTitle(title).split('-').slice(0, 6).join('-');
  return `${date}-${base}-${idPart}`;
}

// RSS guid 可能是 URL 或短 id（Buzzsprout-XXXX），取一段稳定的短 hash 作 ep_id 组成部分
function shortHash(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);
}

// ================= Whisper 兜底 =================
async function transcribeWithWhisper(audioUrl, idPart) {
  if (!WHISPER_ENABLED) return null;
  if (whisperUsed >= WHISPER_MAX_PER_RUN) {
    log(`  ⏭ Whisper 预算已用完 (${whisperUsed}/${WHISPER_MAX_PER_RUN})，${idPart} 本次跳过`);
    return null;
  }
  if (!audioUrl) {
    log(`  ✗ ${idPart} 无音频地址，无法 Whisper`);
    return null;
  }
  whisperUsed++;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'whisper-'));
  const ext = /\.(mp3|m4a|aac|wav|ogg)(\?|$)/i.test(audioUrl) ? audioUrl.match(/\.(mp3|m4a|aac|wav|ogg)/i)[0] : '.mp3';
  const audioPath = path.join(dir, `audio${ext}`);
  try {
    const size = await downloadFile(audioUrl, audioPath);
    log(`  🎧 Whisper 转写中 (${(size / 1048576).toFixed(1)}MB, model=${WHISPER_MODEL}) ${idPart} ...`);
    await runCmd('whisper', [
      audioPath,
      '--model', WHISPER_MODEL,
      '--language', 'en',
      '--task', 'transcribe',
      '--output_format', 'srt',
      '--output_dir', dir,
      '--fp16', 'False',
      '--verbose', 'False',
    ]);
    const srtPath = path.join(dir, 'audio.srt');
    if (!fs.existsSync(srtPath)) throw new Error(`Whisper 未产出 ${srtPath}`);
    return fs.readFileSync(srtPath, 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ================= iHeart 策略 =================
function normalizeIheartEp(e, show) {
  const id = String(e.id ?? e.episodeId ?? '');
  if (!id) return null;
  let date = null;
  const sd = e.startDate ?? e.publishedAt ?? e.releaseDate ?? null;
  if (typeof sd === 'number') date = new Date(sd).toISOString().slice(0, 10);
  else if (typeof sd === 'string' && sd) date = sd.slice(0, 10);
  let secs = e.duration ?? e.durationInSeconds ?? null;
  if (secs && secs > 100000) secs = Math.round(secs / 1000);
  const podSlug = e.podcastSlug || '';
  const epSlug = `${slugifyTitle(e.title)}-${id}`;
  return {
    id,
    title: e.title || '',
    description: e.description || '',
    date,
    duration_seconds: secs,
    transcriptionAvailable: !!e.transcriptionAvailable,
    episode_url: podSlug
      ? `https://www.iheart.com/podcast/${podSlug}-${show.iheartId}/episode/${epSlug}`
      : `https://www.iheart.com/podcast/${show.iheartId}/episode/${epSlug}`,
  };
}

async function fetchEpisodeList(show) {
  if (!show.iheartId) return [];
  const url = `${IHEART_API}/podcast/podcasts/${show.iheartId}/episodes?limit=15&offset=0`;
  const j = await getJson(url);
  const arr = Array.isArray(j) ? j : j.data || j.episodes || j.content || [];
  if (!Array.isArray(arr) || !arr.length) return [];
  const eps = arr.map((e) => normalizeIheartEp(e, show)).filter((e) => e && e.id && e.title);
  log(`${show.slug}: iHeart 列表取到 ${eps.length} 集`);
  return eps;
}

async function fetchEpisodeDetail(epId) {
  const j = await getJson(`${IHEART_API}/podcast/episodes/${epId}`);
  return j.episode || j.data || j;
}

// 归一化 iHeart 单集为统一的 candidate：{ ep_id, title, date, duration_seconds, episode_url, audio_url, guid, transcript_url, transcript_src }
async function resolveIheartEp(show, ep) {
  const detail = await fetchEpisodeDetail(ep.id);
  const tr = detail && detail.transcription;
  const audio_url = (detail && detail.mediaUrl) || '';
  let transcript_url = '';
  let transcript_src = '';
  let guid = '';
  if (detail && detail.transcriptionAvailable && tr && tr.transcriptionLocation) {
    transcript_url = tr.transcriptionLocation;
    try {
      transcript_src = new URL(transcript_url).host;
    } catch (_) {
      transcript_src = 'iheart';
    }
    const gm = String(transcript_url).match(/clips\/([0-9a-f-]{36})/i);
    if (gm) guid = gm[1];
  }
  return {
    ep_id: String(ep.id),
    idPart: String(ep.id),
    title: ep.title,
    date: ep.date,
    duration_seconds: ep.duration_seconds,
    episode_url: ep.episode_url,
    audio_url,
    guid,
    transcript_url,
    transcript_src,
    transcript_type: (tr && tr.transcriptionType) || 'srt',
  };
}

// 归一化 RSS 单集为统一 candidate
function resolveRssEp(show, item) {
  const idPart = shortHash(item.guid || item.link || item.title);
  return {
    ep_id: `${show.slug}-${idPart}`,
    idPart,
    title: item.title,
    date: item.date,
    duration_seconds: item.duration_seconds,
    episode_url: item.link || show.homeUrl || '',
    audio_url: item.audio_url || '',
    guid: item.guid || '',
    transcript_url: item.transcript_url || '',
    transcript_src: item.transcript_url ? safeHost(item.transcript_url) : '',
    transcript_type: item.transcript_type || 'srt',
  };
}

function safeHost(u) {
  try {
    return new URL(u).host;
  } catch (_) {
    return 'rss';
  }
}

// ================= 取转写（官方直链 → Whisper 兜底） =================
async function obtainTurns(cand) {
  // 1) 官方带时间轴字幕（iHeart transcriptionLocation / RSS podcast:transcript）
  if (cand.transcript_url) {
    try {
      const raw = await getText(cand.transcript_url);
      const turns = parseSubRip(raw);
      if (turns.length >= 4) return { turns, src: cand.transcript_src || 'official' };
      log(`  ⚠ ${cand.ep_id} 官方字幕解析轮次过少 (${turns.length})，尝试 Whisper 兜底`);
    } catch (err) {
      log(`  ⚠ ${cand.ep_id} 官方字幕下载/解析失败 (${err.message})，尝试 Whisper 兜底`);
    }
  }
  // 2) Whisper 兜底
  const srt = await transcribeWithWhisper(cand.audio_url, cand.ep_id);
  if (srt) {
    const turns = parseSubRip(srt);
    if (turns.length >= 4) return { turns, src: `whisper:${WHISPER_MODEL}` };
    log(`  ✗ ${cand.ep_id} Whisper 结果轮次过少 (${turns.length})`);
  }
  return { turns: [], src: '' };
}

// ================= 主流程 =================
function makeFields(show, cand, turns, src) {
  const date = cand.date || new Date().toISOString().slice(0, 10);
  const slug = slugify(cand.idPart, cand.title, date);
  const turnsJson = JSON.stringify(turns);
  const wordCount = turns.reduce((n, t) => n + t.text.split(/\s+/).length, 0);
  // turns_en 可能超过飞书单元格上限（TooLargeCell），统一走分片字段：turns_en / turns_en_2 / ...
  const turnsFields = chunkFields('turns_en', turnsJson);
  const nChunks = Object.keys(turnsFields).length;
  if (nChunks > 1) {
    log(`  ℹ ${cand.ep_id} 英文转写 ${turnsJson.length} 字符，分 ${nChunks} 片写入 turns_en*`);
  }
  return {
    fields: {
      show: show.slug,
      ep_id: String(cand.ep_id),
      status: 'pending',
      title_en: cand.title,
      date,
      duration_sec: cand.duration_seconds || 0,
      episode_url: { link: cand.episode_url || show.homeUrl || '', text: (cand.title || '').slice(0, 40) },
      audio_url: cand.audio_url || '',
      guid: cand.guid || '',
      word_count: wordCount,
      ...turnsFields,
      slug,
      transcript_src: src || '',
      enqueued_at: new Date().toISOString().slice(0, 10),
    },
    slug,
    wordCount,
    turnsJson,
  };
}

async function enqueueCandidate(show, cand, existingIds) {
  if (existingIds.has(String(cand.ep_id))) return 0;
  const { turns, src } = await obtainTurns(cand);
  if (!turns.length) {
    log(`  ✗ ${cand.ep_id} 无可用转写（官方字幕缺失且 Whisper 未产出），跳过`);
    return 0;
  }
  const { fields, slug, wordCount } = makeFields(show, cand, turns, src);
  const rid = await bitableCreate(fields);
  log(`  ✓ ${cand.ep_id} 入队 (${turns.length} 轮, ${wordCount} 词, 来源=${src}) slug=${slug} record=${rid}`);
  return 1;
}

async function processShow(show, existingIds) {
  const source = show.source || (show.iheartId ? 'iheart' : show.feedUrl ? 'rss' : 'official');
  if (source === 'official' || (!show.iheartId && !show.feedUrl)) {
    log(`${show.slug}: source=${source}（article/官方类），跳过自动入队，由 QoderWork 手动补录`);
    return 0;
  }

  let candidates = [];
  if (source === 'iheart') {
    const list = await fetchEpisodeList(show);
    // 只对未入队的最新几集取详情，控制请求量
    const fresh = list.filter((e) => !existingIds.has(String(e.id))).slice(0, MAX_NEW);
    if (!fresh.length) {
      log(`${show.slug}: 无新单集`);
      return 0;
    }
    log(`${show.slug}: 发现 ${fresh.length} 集新单集 → ${fresh.map((e) => e.id).join(', ')}`);
    for (const ep of fresh) {
      try {
        candidates.push(await resolveIheartEp(show, ep));
      } catch (err) {
        log(`  ✗ ${ep.id} 取详情失败: ${err.message}`);
      }
    }
  } else if (source === 'rss') {
    const items = await fetchFeed(show.feedUrl);
    log(`${show.slug}: RSS 取到 ${items.length} 集`);
    const fresh = items
      .map((it) => resolveRssEp(show, it))
      .filter((c) => !existingIds.has(String(c.ep_id)))
      .slice(0, MAX_NEW);
    if (!fresh.length) {
      log(`${show.slug}: 无新单集`);
      return 0;
    }
    log(`${show.slug}: 发现 ${fresh.length} 集新单集`);
    candidates = fresh;
  }

  let done = 0;
  for (const cand of candidates) {
    try {
      done += await enqueueCandidate(show, cand, existingIds);
    } catch (err) {
      log(`  ✗ ${cand.ep_id} 入队失败: ${err.message}`);
    }
  }
  return done;
}

async function main() {
  if (!APP_ID || !APP_SECRET || !BITABLE || !TABLE) {
    console.error('[enqueue] 缺少飞书配置（FEISHU_APP_ID/APP_SECRET/BITABLE_TOKEN/TABLE_ID），无法入队。');
    process.exit(1);
  }
  const existing = await bitableSearch();
  // 飞书文本字段（如 ep_id）API 返回的可能是数组分段 [{text:"..."}]，直接 String() 会得到
  // "[object Object]"，导致每行塌成同一个值、去重彻底失效（历史 bug：已 done 的集被重复入队）。
  // 统一归一化：字符串直接用；数组拼接每段 text（或元素本身）。
  const txt = (v) =>
    v == null ? '' : typeof v === 'string' ? v
    : Array.isArray(v) ? v.map((x) => (x && (x.text ?? x)) || '').join('')
    : String(v);
  const existingIds = new Set(existing.map((r) => txt(r.fields?.ep_id).trim()).filter(Boolean));
  log(`队列已有 ${existingIds.size} 行；Whisper 兜底=${WHISPER_ENABLED}（model=${WHISPER_MODEL}, 上限=${WHISPER_MAX_PER_RUN}/次）`);

  let total = 0;
  for (const show of SHOWS) {
    try {
      total += await processShow(show, existingIds);
    } catch (err) {
      log(`${show.slug} 整体失败: ${err.message}`);
    }
  }
  log(`完成，新入队 ${total} 集（Whisper 实际用了 ${whisperUsed} 次），等待 QoderWork 翻译`);
}

export {
  parseSubRip,
  parseItems,
  decodeEntities,
  parseDuration,
  tsToSec,
  slugify,
  slugifyTitle,
  normalizeIheartEp,
  shortHash,
};

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) main();
