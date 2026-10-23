import rss from '@astrojs/rss';
import { ALL_EPISODES, summary } from '../lib/episodes';
import { getShow } from '../data/shows';

export const prerender = true;

export async function GET(context) {
  const site = context.site?.toString() || 'https://example.pages.dev';
  // context.site 已经包含 base 子路径（例如 https://user.github.io/podcast-reader/），
  // 去掉结尾斜杠即可作为根，切勿再拼 import.meta.env.BASE_URL，否则会得到
  // /podcast-reader/podcast-reader/ep/... 这样的重复路径死链。
  const root = site.replace(/\/$/, '');
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
        link: `${root}/ep/${e.show}/${e.slug}/`,
        categories: [show?.publisher || e.show],
      };
    }),
    customData: '<language>zh-CN</language>',
  });
}
