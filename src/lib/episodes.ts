// episode 数据加载器：读取 src/data/episodes/**/*.json（已提交到仓库，CI 无需重抓）
// 支持两种内容形态：
//   kind='transcript'（默认）—— 逐句双语对照，数据在 turns[]
//   kind='article'            —— 中文长文精读，数据在 blocks[]
export interface Turn {
  i: number;
  speaker: number;
  speaker_zh: number;
  ts: string | null;
  en: string;
  zh: string;
}

export interface ArticleBlock {
  type: 'h2' | 'p' | 'quote' | 'li';
  text: string;
  attr?: string; // 引用出处（人名）
}

export interface Resource {
  label: string;
  text: string;
  url: string;
}

export interface Episode {
  show: string;
  kind?: 'transcript' | 'article';
  id: string;
  guid?: string;
  slug: string;
  date: string;
  title_en: string;
  title_zh: string;
  description?: string;
  duration?: string;
  duration_seconds?: number;
  episode_url: string;
  audio_url: string | null;
  speakers?: Record<string, string>;
  turn_count?: number;
  turns?: Turn[];

  // —— article 专属 ——
  subtitle_zh?: string;
  guest?: string;
  source_note?: string;
  word_count?: number;
  read_minutes?: number;
  video_url?: string;
  transcript_url?: string;
  resources?: Resource[];
  to_reader?: string;
  blocks?: ArticleBlock[];
}

const modules = import.meta.glob<{ default: Episode }>(
  '../data/episodes/**/*.json',
  { eager: true },
);

function loadAll(): Episode[] {
  const eps: Episode[] = [];
  for (const key in modules) {
    if (key.endsWith('_index.json')) continue;
    const mod = modules[key];
    const ep = (mod.default ?? (mod as unknown as Episode)) as Episode;
    // transcript 需要 turns；article 需要 blocks
    if (ep && ep.slug && (ep.turns || ep.blocks)) eps.push(ep);
  }
  return eps.sort((a, b) => (a.date < b.date ? 1 : -1));
}

export const ALL_EPISODES: Episode[] = loadAll();

export function episodesByShow(show: string): Episode[] {
  return ALL_EPISODES.filter((e) => e.show === show);
}

export function getEpisode(show: string, slug: string): Episode | undefined {
  return ALL_EPISODES.find((e) => e.show === show && e.slug === slug);
}

export function isArticle(ep: Episode): boolean {
  return ep.kind === 'article' || !!ep.blocks;
}

export function speakerLabel(ep: Episode, n: number): string {
  return ep.speakers?.[String(n)] || `Speaker ${n}`;
}

// 估算阅读时长（中文按 400 字/分钟）
export function readingTime(ep: Episode): number {
  if (isArticle(ep)) {
    if (ep.read_minutes) return ep.read_minutes;
    const chars = ep.word_count
      || (ep.blocks || []).reduce((s, b) => s + (b.text?.length || 0), 0);
    return Math.max(1, Math.round(chars / 400));
  }
  const zhChars = (ep.turns || []).reduce((s, t) => s + (t.zh?.length || 0), 0);
  return Math.max(1, Math.round(zhChars / 400));
}

// 列表页右侧的时长/篇幅标签
export function lengthLabel(ep: Episode): string {
  if (isArticle(ep)) return `${readingTime(ep)} 分钟读`;
  return ep.duration || `${readingTime(ep)} 分钟读`;
}

// 副标题/简介（列表与 RSS 用）
export function summary(ep: Episode): string {
  return ep.subtitle_zh || ep.description || ep.title_en || '';
}

/* =========================================================
 * 信息架构增强：日期工具 / 节目频次统计 / 全站时间线分组
 * 这些是纯函数，构建期（Astro SSG）执行，结果随每次 publish 刷新。
 * ========================================================= */

// 以 UTC 解析 'YYYY-MM-DD'，避免本地时区把日期挪一天
function parseUTC(dateStr: string): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, (m || 1) - 1, d || 1));
}

function daysBetween(from: string, to: string): number {
  return Math.round((parseUTC(to).getTime() - parseUTC(from).getTime()) / 86400000);
}

// 构建当天（UTC 日期串），用于"X 天前"这类相对表述
export const BUILD_DATE = new Date().toISOString().slice(0, 10);

// 相对时间中文标签：今天 / 昨天 / N 天前 / N 个月前 / N 年前
export function relDays(dateStr: string, today = BUILD_DATE): string {
  const n = daysBetween(dateStr, today);
  if (n <= 0) return '今天';
  if (n === 1) return '昨天';
  if (n < 30) return `${n} 天前`;
  if (n < 365) return `${Math.round(n / 30)} 个月前`;
  return `${Math.round(n / 365)} 年前`;
}

export interface ShowStats {
  count: number; // 已收录集数
  lastDate: string | null; // 最近一集日期
  daysSince: number | null; // 距今几天
  cadence: string | null; // 周更/双周更/月更/不定期；仅 1 集时为 null（不臆造频次）
  medianGap: number | null; // 相邻两集中位间隔天数
}

// 单档节目的收录统计与更新频次。
// 频次仅在 ≥2 集时按"相邻日期中位间隔"推算；只有 1 集时返回 cadence=null，
// 由页面降级显示"最近更新 X 天前 · 已收录 1 集"，绝不编造更新周期。
export function showStats(slug: string): ShowStats {
  const eps = episodesByShow(slug); // 已按日期倒序
  const count = eps.length;
  const lastDate = eps[0]?.date ?? null;
  const daysSince = lastDate ? daysBetween(lastDate, BUILD_DATE) : null;
  let cadence: string | null = null;
  let medianGap: number | null = null;
  if (count >= 2) {
    const gaps: number[] = [];
    for (let i = 0; i < eps.length - 1; i++) {
      gaps.push(daysBetween(eps[i + 1].date, eps[i].date));
    }
    gaps.sort((a, b) => a - b);
    medianGap = gaps[Math.floor(gaps.length / 2)];
    cadence =
      medianGap <= 9 ? '周更'
      : medianGap <= 19 ? '双周更'
      : medianGap <= 45 ? '月更'
      : '不定期';
  }
  return { count, lastDate, daysSince, cadence, medianGap };
}

export interface MonthGroup {
  key: string; // '2026-10'
  label: string; // '2026 年 10 月'
  items: Episode[];
}

// 全站时间线：把所有单集按"年-月"分组，组内保持日期倒序，组间也倒序。
export function groupByMonth(eps: Episode[] = ALL_EPISODES): MonthGroup[] {
  const map = new Map<string, Episode[]>();
  for (const e of eps) {
    const key = (e.date || '').slice(0, 7) || 'unknown';
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(e);
  }
  return Array.from(map.entries())
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, items]) => {
      const [y, m] = key.split('-');
      const label = m ? `${y} 年 ${Number(m)} 月` : key;
      return { key, label, items: items.sort((a, b) => (a.date < b.date ? 1 : -1)) };
    });
}
