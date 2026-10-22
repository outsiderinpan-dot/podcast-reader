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
