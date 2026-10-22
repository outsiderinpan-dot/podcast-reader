import rss from '@astrojs/rss';
import { ALL_EPISODES, summary } from '../lib/episodes';
import { getShow } from '../data/shows';

export const prerender = true;

export async function GET(context) {
  const site = context.site?.toString() || 'https://example.pages.dev';
  const root = site.replace(/\/$/, '');            // 去掉结尾斜杠
  const base = import.meta.env.BASE_URL || '/';    // '/repo/' 或 '/'，兼容 GitHub Pages 子路径
  return rss({
    title: 'Podcast Reader · 播客中英精读',
    description: '每周自动更新的播客中文精读（双语对照 + 长文精读）',
    site,
    items: ALL_EPISODES.map((e) => {
      const show = getShow(e.show);
      return {
        title: `${e.title_zh}（${e.title_en}）`,
        description: summary(e),
        pubDate: new Date(e.date),
        link: `${root}${base}ep/${e.show}/${e.slug}/`,
        categories: [show?.publisher || e.show],
      };
    }),
    customData: '<language>zh-CN</language>',
  });
}
