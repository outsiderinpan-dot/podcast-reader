// 节目注册表 —— 唯一数据源是 ./shows.json（Astro 与 scripts/scrape.mjs 共用）
import raw from './shows.json';

export interface Show {
  slug: string;
  title: string;
  title_zh: string;
  publisher: string;
  source: 'iheart' | 'official';
  iheartId?: number;
  appleId?: number;
  omnyOrgId?: string;
  homeUrl: string;
  rssUrl?: string;
  description_zh: string;
  accent: string; // 主题色
  default_host?: string;
  content_style?: 'transcript' | 'article'; // 节目默认内容形态
}

export const SHOWS: Show[] = raw as Show[];

export function getShow(slug: string): Show | undefined {
  return SHOWS.find((s) => s.slug === slug);
}
