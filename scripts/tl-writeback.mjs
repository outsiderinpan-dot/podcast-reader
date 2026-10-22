// tl-writeback.mjs <prefix>
// 翻译期工具③：把 <prefix>.episode.json 写回飞书对应行（用 <prefix>.meta.json 里的 record_id），
// 并置 status=translated。随后由 publish.yml 的 dequeue 步骤取回、写入站点、构建部署并回标 done。
// 凭证从环境变量读取（切勿硬编码）：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_BITABLE_TOKEN / FEISHU_TABLE_ID
import fs from 'node:fs';

const APP_ID = process.env.FEISHU_APP_ID || '';
const APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const BT = process.env.FEISHU_BITABLE_TOKEN || '';
const TBL = process.env.FEISHU_TABLE_ID || '';
const prefix = process.argv[2];

if (!APP_ID || !APP_SECRET || !BT || !TBL) {
  console.error('缺少环境变量 FEISHU_APP_ID/APP_SECRET/BITABLE_TOKEN/TABLE_ID');
  process.exit(1);
}
if (!prefix) { console.error('usage: node scripts/tl-writeback.mjs <prefix>'); process.exit(1); }

const meta = JSON.parse(fs.readFileSync(`${prefix}.meta.json`, 'utf8'));
const docStr = fs.readFileSync(`${prefix}.episode.json`, 'utf8');
const rid = meta.record_id;
if (!rid) { console.error(`${prefix}.meta.json 缺少 record_id`); process.exit(1); }

(async () => {
  const t = await (await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  })).json();
  if (t.code !== 0) throw new Error(`取 token 失败: ${t.msg}`);
  const r = await (await fetch(
    `https://open.feishu.cn/open-apis/bitable/v1/apps/${BT}/tables/${TBL}/records/${rid}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t.tenant_access_token}` },
      body: JSON.stringify({ fields: { episode_json: docStr, status: 'translated' } }),
    },
  )).json();
  if (r.code !== 0) { console.error(`WRITEBACK FAIL ${prefix} code=${r.code} msg=${r.msg}`); process.exit(1); }
  console.log(`WRITEBACK OK ${prefix} (rid=${rid}) len=${docStr.length} status=translated`);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
