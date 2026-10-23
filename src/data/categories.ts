// 节目内容主题分类 —— 首页/节目页按此分组浏览。
// 唯一新增数据源；shows.json 里每档节目通过 category 字段引用这里的 id。
export interface Category {
  id: string;
  label: string; // 中文名
  en: string; // 英文短标签（用于副标题/无障碍）
  blurb: string; // 一句话说明这个分类装的是什么
  accent: string; // 分类主题色（区别于单档节目的 accent）
}

// 顺序即展示顺序：从"看市场"到"选管理人"到"配置"再到"长谈"。
export const CATEGORIES: Category[] = [
  {
    id: 'macro-markets',
    label: '宏观与市场',
    en: 'Macro & Markets',
    blurb: '利率、通胀、能源、市场结构与金融怪现状——先看清脚下的市场在发生什么。',
    accent: '#0f766e',
  },
  {
    id: 'active-investing',
    label: '主动投资与选股',
    en: 'Active Investing',
    blurb: '主动管理人、投资框架与选股逻辑，以及行为金融提醒你别踩的认知坑。',
    accent: '#4f46e5',
  },
  {
    id: 'etf-passive',
    label: 'ETF 与被动投资',
    en: 'ETF & Passive',
    blurb: 'ETF 产品设计、指数化投资与被动生态的一手动态。',
    accent: '#c2410c',
  },
  {
    id: 'alts-derivatives',
    label: '对冲 · 另类 · 衍生品',
    en: 'Alts & Derivatives',
    blurb: '对冲基金、期权与量化、多元另类策略——收益从哪儿来、风险长什么样。',
    accent: '#7c3aed',
  },
  {
    id: 'institutional',
    label: '机构配置',
    en: 'Institutional',
    blurb: 'LP/GP 视角的组合构建、管理人遴选与机构运作内参。',
    accent: '#0e7490',
  },
  {
    id: 'long-form',
    label: '深度长谈',
    en: 'Long Form',
    blurb: '三小时级别的跨界长谈，整理成一篇能静心读完的中文长文。',
    accent: '#0ea5e9',
  },
];

export function getCategory(id?: string): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}

// 未分类兜底（理论上不应出现，出现时归到这里，避免节目"消失"）
export const UNCATEGORIZED: Category = {
  id: 'other',
  label: '其他',
  en: 'Other',
  blurb: '暂未归类的节目。',
  accent: '#64748b',
};
