// dequeue.mjs — 第三段：在 GitHub Actions 里跑。把 QoderWork 翻译好的单集从飞书队列取回，
// 写进 src/data/episodes/，重建索引，然后把队列行标记为 done。
//
// 前置：QoderWork（我）已经消费过 pending 行，把最终单集 JSON 写回队列的 episode_json 字段，
//       并把 status 改成 translated。
//
// 飞书队列每行字段（dequeue 关心的）：
//   show          节目 slug
//   slug          文件名 slug
//   ep_id         单集唯一 id
//   status        pending / translating / translated / done / failed
//   episode_json  多行文本，QoderWork 写回的完整单集 JSON 字符串（transcript 或 article kind）
//   fail_note     失败原因（可选）
//
// 环境变量：
//   FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BITABLE_TOKEN / FEISHU_TABLE_ID
//
// 用法: node scripts/dequeue.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChunked } from './feishu-chunk.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const BITABLE = process.env.FEISHU_BITABLE_TOKEN || '';
const TABLE = process.env.FEISHU_TABLE_ID || '';

function log(...a) {
  console.log('[dequeue]', ...a);
}

let TOKEN = '';
let TOKEN_EXP = 0;
async function feishuToken() {
  // 与 enqueue 一致：token 有效期 ~2h，剩余 <5min 自动重取，避免长任务中途 99991663。
  if (TOKEN && Date.now() < TOKEN_EXP - 5 * 60 * 1000) return TOKEN;
  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`飞书取 token 失败: ${j.msg} (code=${j.code})`);
  TOKEN = j.tenant_access_token;
  TOKEN_EXP = Date.now() + (Number(j.expire) > 0 ? Number(j.expire) : 6000) * 1000;
  return TOKEN;
}

// 拉全量记录（翻页），前端再按 status 过滤
async function listAllRecords() {
  const token = await feishuToken();
  const out = [];
  let pageToken = '';
  do {
    const url =
      `https://open.feishu.cn/open-apis/bitable/v1/apps/${BITABLE}/tables/${TABLE}/records/search?page_size=200` +
      (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ automatic_fields: false }),
    });
    const j = await res.json();
    if (j.code !== 0) throw new Error(`飞书查询记录失败: ${j.msg} (code=${j.code})`);
    out.push(...(j.data?.items || []));
    pageToken = j.data?.has_more ? j.data?.page_token || '' : '';
  } while (pageToken);
  return out;
}

async function updateRecord(recordId, fields) {
  const token = await feishuToken();
  const url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${BITABLE}/tables/${TABLE}/records/${recordId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ fields }),
  });
  const j = await res.json();
  if (j.code !== 0) throw new Error(`飞书更新记录失败: ${j.msg} (code=${j.code})`);
}

// 从字段值里取纯文本（飞书多行文本可能是字符串，也可能是 [{text,type}] 结构）
function textOf(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => x?.text ?? '').join('');
  if (typeof v === 'object') return v.text || v.value || '';
  return String(v);
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

async function main() {
  if (!APP_ID || !APP_SECRET || !BITABLE || !TABLE) {
    console.error('[dequeue] 缺少飞书配置（FEISHU_APP_ID/APP_SECRET/BITABLE_TOKEN/TABLE_ID）。');
    process.exit(1);
  }
  const records = await listAllRecords();
  const todo = records.filter((r) => textOf(r.fields?.status) === 'translated');
  log(`队列共 ${records.length} 行，其中待发布(translated) ${todo.length} 行`);

  let written = 0;
  const touchedShows = new Set();
  for (const r of todo) {
    const f = r.fields || {};
    const show = textOf(f.show);
    const slug = textOf(f.slug);
    const raw = readChunked(f, 'episode_json', textOf);
    try {
      if (!show || !slug || !raw) throw new Error('show/slug/episode_json 有空值');
      const doc = JSON.parse(raw);
      if (!doc.slug) doc.slug = slug;
      const showDir = path.join(ROOT, 'src', 'data', 'episodes', show);
      fs.mkdirSync(showDir, { recursive: true });
      fs.writeFileSync(path.join(showDir, `${slug}.json`), JSON.stringify(doc, null, 2));
      touchedShows.add(show);
      await updateRecord(r.record_id, { status: 'done' });
      log(`  ✓ ${show}/${slug} 写入并标记 done`);
      written++;
    } catch (err) {
      log(`  ✗ ${show}/${slug} 发布失败: ${err.message}`);
      try {
        await updateRecord(r.record_id, { status: 'failed', fail_note: String(err.message).slice(0, 200) });
      } catch {}
    }
  }

  for (const show of touchedShows) {
    const n = rebuildIndex(path.join(ROOT, 'src', 'data', 'episodes', show));
    log(`${show}: _index.json 重建，共 ${n} 集`);
  }
  log(`完成，本次发布 ${written} 集`);
  // 把「本次是否有新内容」写进 GITHUB_OUTPUT，供后续步骤决定是否 commit/部署
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `written=${written}\n`);
  }
}

main();
