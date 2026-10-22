# Podcast Reader · 金融播客中英精读站

每周自动抓取全球顶级投资播客的最新单集，生成「逐句中文精读 + 英文原文对照 + 音频 + 说话人 + 时间戳」的在线阅读站。个人学习研究用途。

当前收录：Inside Active（Bloomberg Intelligence）最近 5 集。架构支持多节目、多单集横向扩展。

---

## 一、本地跑起来

```bash
npm install          # 依赖仅 astro + @astrojs/rss
npm run build        # 产出静态站 dist/
npm run preview      # http://localhost:4321/
# 或开发模式热更新：
npm run dev
```

已验证：`npm run build` 通过，8 个页面（首页 / 节目页 / 5 个单集页 / 搜索 / RSS / 搜索索引）。

## 二、目录结构

```
podcast-site/
├─ src/
│  ├─ data/
│  │  ├─ shows.json              # 节目注册表（唯一数据源，Astro 与抓取器共用）
│  │  ├─ shows.ts                # 读 shows.json 并加类型
│  │  └─ episodes/{show}/        # 每集一个 JSON + _index.json 索引
│  ├─ lib/episodes.ts            # 数据加载层（import.meta.glob）
│  ├─ layouts/BaseLayout.astro   # 外壳：导航 / 主题切换 / 页脚
│  ├─ styles/global.css          # 三主题（light/dark/sepia）+ 阅读控件
│  └─ pages/
│     ├─ index.astro             # 首页：统计 + 节目卡 + 最新单集
│     ├─ shows/[show].astro      # 节目页：该节目全部单集
│     ├─ ep/[show]/[slug].astro  # 单集页：音频条 + 中文/English/双语 tab + 字号控件
│     ├─ search.astro            # 全文搜索（客户端，读 search-index.json）
│     ├─ search-index.json.js    # 构建期生成搜索索引
│     └─ rss.xml.js              # RSS 订阅
├─ scripts/
│  ├─ build-data.mjs             # 离线：把本地 EN txt + ZH md 合成 episode JSON（MVP 用）
│  └─ scrape.mjs                 # 生产：Actions 里跑，抓新集 + LLM 翻译 + 写 JSON
└─ .github/workflows/weekly-scrape.yml   # 每周一 08:00 UTC 自动抓取
```

单集 JSON schema（`src/data/episodes/{show}/{slug}.json`）：

```jsonc
{
  "show": "inside-active",
  "id": "340369357",
  "guid": "555098e8-...",          // Omny clip id，用于拉字幕
  "slug": "2026-08-05-michael-ervolini-...",
  "date": "2026-08-05",
  "title_en": "...", "title_zh": "...",
  "description": "...",
  "duration": "31:24", "duration_seconds": 1884,
  "episode_url": "https://www.iheart.com/...",
  "audio_url": null,               // 有 mp3 时站内播放，否则跳官方页
  "speakers": { "1": "David Cohne（主持）", "2": "Michael Ervolini" },
  "turn_count": 47,
  "turns": [ { "i":0, "speaker":1, "speaker_zh":1, "ts":null, "en":"...", "zh":"..." } ]
}
```

## 三、部署上线（GitHub + Cloudflare Pages）

### 1. 建 GitHub 仓库并推送

```bash
cd podcast-site
git init
git add -A
git commit -m "init: podcast reader MVP (Inside Active 5 eps)"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

> 仓库可以是 public 也可以是 private。private 更稳妥（见第六节版权说明）；Cloudflare Pages 支持 private 仓库。

### 2. 配置 Actions Secrets（仓库 Settings → Secrets and variables → Actions）

| Secret | 必填 | 说明 |
|---|---|---|
| `LLM_API_KEY` | ✅ | 任意 OpenAI 兼容接口的 key。推荐 DeepSeek（`sk-...`），单集翻译成本约 ¥0.3 |
| `LLM_BASE_URL` | 可选 | 默认 `https://api.deepseek.com/v1`。用 OpenAI 填 `https://api.openai.com/v1` |
| `LLM_MODEL` | 可选 | 默认 `deepseek-chat`。OpenAI 填 `gpt-4o-mini` 等 |

### 3. 接 Cloudflare Pages（自动部署）

1. Cloudflare 控制台 → Workers & Pages → Create → Pages → Connect to Git → 选上面仓库。
2. 构建配置：
   - Framework preset: `Astro`
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Node version: 在仓库根加 `package.json` 里已含 engines 可省略；或在 Pages 环境变量设 `NODE_VERSION=20`
3. 保存并部署。首次部署用 main 分支当前内容。
4. 之后每次 `git push`（包括 Actions 自动提交的新单集）都会触发重新部署。

### 4. 验证自动化

- 仓库 Actions 页 → `weekly-scrape` → Run workflow（手动触发一次）。
- 观察日志：应打印「iHeart API 取到 N 集」「SubRip N 轮」「翻译 x/y」「✓ id → slug.json」。
- 成功后自动 commit + push，Cloudflare 几分钟内更新线上。
- 定时：每周一 08:00 UTC（北京 16:00）自动跑，无需人工。

## 四、加一个新节目

1. 在 `src/data/shows.json` 追加一条（slug / iheartId / omnyOrgId / accent / default_host 等）。
2. `omnyOrgId` 获取方法：打开该节目任一单集页，查看网页源码里 `api.omny.fm/orgs/<这串>/clips/...`。Bloomberg 系节目共用 `e73c998e-6e60-432f-8610-ae210140c5b1`。
3. 推送后，下次 Actions 会自动抓该节目新集；历史集如需补，本地跑 `node scripts/scrape.mjs`（设好 LLM key）或临时调大 `MAX_NEW`。

## 五、成本与限额

- 托管：Cloudflare Pages 免费额度（个人站远远够用）。
- 翻译：DeepSeek 约 ¥0.3 / 集；每周 1–3 集 ≈ 每月 < ¥5。
- Actions：免费仓库每月 2000 分钟，本 workflow 单次 < 5 分钟。

## 六、版权与用途声明

- 转写来自播客官方公开 transcript（Omny RSS 公开分发），中文为个人学习研究性质的翻译与术语校对。
- 站点页脚已注明「内容版权归各播客出品方所有 · 本站为个人学习研究用途」。
- 建议仓库与站点保持 private / 不商用 / 不二次分发音频文件（站内仅链接官方音频，不托管 mp3）。

## 七、已知限制 / 后续可做

- `audio_url` 目前多为 null（iHeart 页不直接暴露 mp3），单集页显示「官方音频」外链；若 Omny RSS 提供 enclosure 可回填实现站内播放。
- 时间戳 `ts` 由 SubRip 回填；MVP 的 5 集为离线合成故为 null（页面自动隐藏时间戳列）。
- 搜索为构建期全量索引的客户端搜索，单集规模上千后再考虑 Pagefind。
- 主题 / 字号 / 时间戳点击跳转音频已实现；PWA 离线缓存可后续加 service worker。
