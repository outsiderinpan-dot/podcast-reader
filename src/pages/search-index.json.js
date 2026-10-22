// 构建时生成 /search-index.json —— 供前端全文搜索
// 两种形态统一成 turns[] 结构，前端 search.astro 无需区分
import { ALL_EPISODES, isArticle } from '../lib/episodes';

export const prerender = true;

export async function GET() {
  const index = ALL_EPISODES.map((e) => {
    let turns;
    if (isArticle(e)) {
      turns = (e.blocks || [])
        .filter((b) => b.text)
        .map((b) => ({
          speaker: 0,
          zh: b.type === 'quote' && b.attr ? `${b.text}——${b.attr}` : b.text,
          en: '',
        }));
    } else {
      turns = (e.turns || []).map((t) => ({ speaker: t.speaker, zh: t.zh, en: t.en }));
    }
    return {
      show: e.show,
      slug: e.slug,
      date: e.date,
      title_zh: e.title_zh,
      title_en: e.title_en,
      turns,
    };
  });
  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
