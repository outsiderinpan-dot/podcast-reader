# 自动化流水线（方案 B：GitHub Pages 托管 + 零新付费账号）

三段式，不需要任何 LLM API Key。抓取靠 GitHub Actions 的境外出口（含本地 Whisper ASR 兜底），翻译靠
QoderWork（你的 Qoder 额度），队列靠飞书多维表格（你的飞书额度），托管靠 GitHub Pages（免费公开）。

为什么这样分工：iHeart / Omny / Captivate / 各 RSS / 音频文件都是境外源，只有 GitHub Actions（和你本机
Chrome）够得着；飞书妙搭后端在国内云上，连不上这些境外源（已验证）。而 QoderWork 本地能读写飞书、却够不到
github.com，所以用飞书多维表格当「我和 GitHub 之间的中转队列」。

```
① GH Action·抓取（周一 16:00 北京）   →  ② 飞书多维表格「翻译队列」  →  ③ QoderWork·翻译（Qoder 额度）
   scripts/enqueue.mjs                     status=pending 的行              读 pending → 逐段中文精读
   多策略抓英文转写，写英文入队             存 turns_en（英文 JSON）          回写 episode_json，status=translated
   iHeart官方字幕→RSS字幕→Whisper                                          │
                                                                              ▼
                                    ④ GH Action·发布（周日 20:00 北京）  scripts/dequeue.mjs
                                       取回 translated → 写 src/data/episodes/ → commit → npm build → 部署 Pages → status=done
```

## ① 抓取（GitHub Action，已就绪）

- 工作流：`.github/workflows/weekly-scrape.yml`（cron 每周一 08:00 UTC = 北京 16:00，也可手动触发）
- 脚本：`scripts/enqueue.mjs` —— 只抓英文转写，按 `ep_id` 幂等去重，新单集在飞书表格建一行 `status=pending`。
- `source=official` 的 article 类节目（如 lex-fridman，无 iheartId/feedUrl）自动跳过，由 QoderWork 手动补录。

### 多策略解析链（命中即止）

`enqueue.mjs` 对每个单集按下面的顺序尝试，拿到「带时间轴的英文转写」就入队：

1. **iHeart 官方字幕**（`source=iheart`）：走新的两步 API，取 `transcription.transcriptionLocation` 字幕直链下载。
2. **RSS `<podcast:transcript>`**（`source=rss`）：拉 feedUrl，若 item 里有 Podcasting 2.0 的
   `<podcast:transcript url="..." type="application/srt|text/vtt">` 标签，直接下载解析。
3. **Whisper 兜底**（前两步都没有官方字幕时）：下载音频（iHeart `mediaUrl` / RSS `<enclosure url>`），
   在 Actions 里跑本地 `openai-whisper` CLI 转成 SRT 再解析。开源本地模型，不要任何 API Key。

### iHeart 抓取方式（2026-10 已更新，旧方式失效）

旧端点 `api.iheart.com/api/v3/podcast/id/{id}/episodes` 现已返回 404，`enqueue.mjs` 已改用新的两步法：

1. 列表：`GET https://ww.api.iheart.com/api/v3/podcast/podcasts/{iheartId}/episodes?limit=15`
   → `{data:[{id, podcastSlug, title, duration(秒), startDate(epoch ms), transcriptionAvailable, ...}]}`
2. 详情：`GET https://ww.api.iheart.com/api/v3/podcast/episodes/{epId}`
   → `{episode:{mediaUrl, transcriptionAvailable, transcription:{transcriptionLocation, transcriptionType}}}`

当 `transcriptionAvailable=true` 时，`transcription.transcriptionLocation` 就是可直接下载的字幕直链
（Bloomberg 系走 Omny SubRip，Top Traders 等走 Captivate SRT，其它托管商同理）。脚本直接下载并解析，
**不再需要 `omnyOrgId`，也不再扒单集页 HTML 找 guid**。`transcriptionAvailable=false` 时自动落到 Whisper。

`episode_url` 由 `podcastSlug-iheartId/episode/{标题slug}-{epId}` 规则构造（已实测与 iHeart 真实链接一致）。

> 注意：Captivate 等字幕站在浏览器里因 CORS 无法跨域 `fetch`，但 GitHub Actions 是服务端 Node fetch，无 CORS 限制，可正常下载。

### SRT/VTT 解析的说话人分段（关键实现细节）

不同来源的字幕格式不一致，`parseSubRip` 必须都吃下：

- **Omny**（Bloomberg 系）字幕每段带 `Speaker N:` 前缀 → 按说话人合并，多嘉宾能正确区分。
- **Captivate / Whisper** 字幕**没有**说话人标签 → 若沿用「同说话人就合并」，整集会塌成 1 轮。
  已改为：无标签时按「时间间隔 + 长度」分段（相邻 cue 间隔 < `gapSec`（默认 1.2s）且累计长度 < `maxChars`
  （默认 340 字）才并入当前轮），最后把 `null` 说话人归一到 `1`。

`scripts/test-parsers.mjs` 用真实样本（Omny 带说话人 / Captivate 无说话人 / ETF Prime / Buzzsprout RSS）
覆盖了这些分支，本地 `node scripts/test-parsers.mjs` 应 39 项全绿。

### Whisper 兜底与预算节流

Whisper 在 CPU 上远慢于实时（`base` 模型 1 小时音频约 30-60 分钟），首次回填 20 个节目若不加限制会顶穿
Actions 的 6 小时上限。因此：

- `WHISPER_MODEL`（默认 `base`）：`tiny` 最快最粗，`small`/`medium` 更准更慢。
- `WHISPER_MAX_PER_RUN`（默认 2）：单次运行最多 Whisper 转写几集，超过的集本次跳过、下次再排。
- `WHISPER_ENABLED`：设 `false` 可完全关闭兜底（只走官方字幕）。
- 工作流 `timeout-minutes: 330`，并缓存 `~/.cache/whisper` 模型，避免每次重新下载。

因为按 `ep_id` 幂等去重，回填是**渐进**的：每周跑掉 2 集，未处理的集下周自动接着排。想一次性多回填，
在 Actions 手动触发（workflow_dispatch）时把 `whisper_max` 调大即可。注意预算按 `shows.json` 顺序消耗，
排在前面的节目优先。

### 覆盖矩阵（22 档节目，均已接入自动链）

| 类别 | 节目 | 转写来源 |
|---|---|---|
| iHeart 官方字幕（实测最新集可抓） | Inside Active、Trillions、Odd Lots、Money Stuff、Top Traders Unplugged | Omny / Captivate 直链 |
| iHeart 无字幕 → Whisper | The Rational Reminder、The BID、Invest Like the Best、Capital Allocators、ETF Edge、Macro Voices、Without Boundaries、Behind the Ticker、Exchanges、Swimming with Allocators | mediaUrl + Whisper |
| RSS → 字幕或 Whisper | The Long View、ETF Prime、Resonanz Spotlight、Alpha Exchange、The Derivative、Absolute Return、Alternative Fund Insight | `<podcast:transcript>` 或 enclosure + Whisper |
| article（手动补录） | Lex Fridman | QoderWork 手动整理成长文 |

`shows.json` 里每档的 `transcript_quality` 标注了预期来源（`official` / `rss-or-whisper` / `whisper`），仅供人读，脚本以运行时实际命中为准，并把结果写进 `transcript_src` 字段。

## ② 飞书多维表格（队列）

一张数据表，字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| show | 单行文本 | 节目 slug |
| ep_id | 单行文本 | 单集唯一 id（幂等键） |
| status | 单选 | pending / translating / translated / done / failed |
| title_en | 单行文本 | 英文标题 |
| date | 日期 | 发布日期 |
| duration_sec | 数字 | 时长（秒） |
| episode_url | 超链接 | 单集页 |
| audio_url | 单行文本 | mp3 / iHeart mediaUrl |
| guid | 单行文本 | Omny clip guid（非 Omny 来源为 RSS guid 或留空） |
| word_count | 数字 | 英文词数 |
| turns_en | 多行文本 | 英文转写 JSON `[{speaker,ts,text}]` |
| slug | 单行文本 | 文件名 slug |
| transcript_src | 单行文本 | 转写实际来源（如 `api.omny.fm` / `transcripts.captivate.fm` / `whisper:base`），便于事后核对质量 |
| episode_json | 多行文本 | QoderWork 翻译后写回的完整单集 JSON |
| fail_note | 多行文本 | 失败原因 |
| enqueued_at | 日期 | 入队时间 |

把 ① 里的自建应用加为该表格协作者（可编辑）。
超长转写（>9 万字符）建议改存飞书云文档、表格里放链接。

## ③ QoderWork·翻译（用 Qoder 额度，由我执行）

可挂 QoderWork 定时任务，每周日晚（在 ④ 发布之前）跑一次：

1. 取 pending 行（lark-cli bitable 记录搜索，filter status=pending）。
2. 逐行：读 `turns_en` → 生成中文标题 + 说话人显示名 + 逐段中文精读
   （规范：口语自然、术语首次括注英文、人名/机构/书名保留英文、不增删观点、主持加「（主持）」）。
3. 组装成最终单集 JSON（transcript kind），写回该行 `episode_json`，并把 `status` 改成 `translated`。
4. 失败则 `status=failed` + `fail_note`。

## ④ 发布（GitHub Action，已就绪）

- 工作流：`.github/workflows/publish.yml`（cron 每周日 12:00 UTC = 北京 20:00）
- 脚本：`scripts/dequeue.mjs` —— 取回所有 `status=translated` 行，把 `episode_json` 写成
  `src/data/episodes/{show}/{slug}.json`，重建 `_index.json`，回写 `status=done`。
- 随后 commit 新单集回仓库 → `npm run build` → 部署到 GitHub Pages。
- 构建用仓库 Variables：`SITE_URL`（站点域名）、`BASE_PATH`（普通项目页填 `/<repo>`，根站/自定义域名留空）。

## 需要在 GitHub 仓库配置的东西

Secrets（Settings → Secrets and variables → Actions → Secrets）：
`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_BITABLE_TOKEN`、`FEISHU_TABLE_ID`（可选 `FEISHU_WEBHOOK`）。

Variables（同页 → Variables）：`SITE_URL`、`BASE_PATH`。

Pages（Settings → Pages）：Source 选「GitHub Actions」。

Whisper 相关参数（`WHISPER_MODEL` / `WHISPER_MAX_PER_RUN` / `WHISPER_ENABLED`）已作为 `weekly-scrape.yml`
里 workflow_dispatch 的输入项，带默认值，无需在仓库另配 Secrets/Variables；手动触发时可临时调整。

飞书多维表格建表时，记得把 `transcript_src` 也建成一个「单行文本」字段（其余字段见 ②）。
