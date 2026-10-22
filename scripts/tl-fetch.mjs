// tl-fetch.mjs <record_id> <prefix>
// 翻译期工具①：从飞书「翻译队列」取一集待译记录，落地为本地文件，供翻译子流程使用。
//   <prefix>.meta.json  单集元数据（show/ep_id/slug/date/title_en/duration/episode_url/audio_url/guid）
//   <prefix>.en.json    英文转写数组 [{speaker, ts, text}]
// 凭证从环境变量读取（切勿硬编码）：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BITABLE_TOKEN / FEISHU_TABLE_ID
import fs from 'node:fs';

const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const BT = process.env.FEISHU_BITABLE_TOKEN || '';
const TBL = process.env.FEISHU_TABLE_ID || '';
const rid = process.argv[2];
const prefix = process.argv[3];

if (!APP_ID || !APP_SECRET || !BT || !TBL) {
  console.error('缺少环境变量 FEISHU_APP_ID/APP_SECRET/BITABLE_TOKEN/TABLE_ID');
  process.exit(1);
}
if (!rid || !prefix) {
  console.error('usage: node scripts/tl-fetch.mjs <record_id> <prefix>');
  process.exit(1);
}

const T = (v) =>
  v == null ? '' : typeof v === 'string' ? v
  : Array.isArray(v) ? v.map((x) => (x && x.text) || '').join('')
  : String(v);

async function token() {
  const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const j = await r.json();
  if (j.code !== 0) throw new Error(`取 token 失败: ${j.msg} (code=${j.code})`);
  return j.tenant_access_token;
}

(async () => {
  const tok = await token();
  const res = await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BT}/tables/${TBL}/records/${rid}`,
    { headers: { Authorization: `Bearer ${tok}` } },
  );
  const r = await res.json();
  if (r.code !== 0) { console.error('fetch fail', r.code, r.msg); process.exit(1); }
  const f = r.data.record.fields;
  const eu = f.episode_url; // 超链接字段：{link, text}
  const meta = {
    record_id: rid,
    show: T(f.show), ep_id: T(f.ep_id), slug: T(f.slug), date: T(f.date),
    title_en: T(f.title_en), duration_sec: Number(f.duration_sec) || 0,
    episode_url: (eu && eu.link) || (Array.isArray(eu) && eu[0] && eu[0].link) || '',
    audio_url: T(f.audio_url), guid: T(f.guid), transcript_src: T(f.transcript_src),
  };
  const turns = JSON.parse(T(f.turns_en));
  fs.writeFileSync(`${prefix}.meta.json`, JSON.stringify(meta, null, 2));
  fs.writeFileSync(`${prefix}.en.json`, JSON.stringify(turns, null, 2));
  console.log(
    `${prefix}: show=${meta.show} ep_id=${meta.ep_id} date=${meta.date} turns=${turns.length} ` +
    `speakers=[${[...new Set(turns.map((x) => x.speaker))].join(',')}] dur=${meta.duration_sec}s`,
  );
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
