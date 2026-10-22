// test-parsers.mjs — 本地单测：验证 parseSubRip（有/无说话人）与 parseItems（真实 RSS 样本）
// 用法: node scripts/test-parsers.mjs
import { parseSubRip, parseItems, decodeEntities, parseDuration } from './enqueue.mjs';

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// ---------- 1. Omny 风格：带 Speaker N: 前缀 ----------
console.log('\n[1] parseSubRip — Omny 带说话人');
const omny = `1
00:00:01,000 --> 00:00:04,000
Speaker 1: Welcome back to the show.

2
00:00:04,500 --> 00:00:07,000
Speaker 1: Today we discuss markets.

3
00:00:07,200 --> 00:00:11,000
Speaker 2: Thanks for having me. Great to be here.

4
00:00:11,500 --> 00:00:14,000
Speaker 2: Let me start with rates.

5
00:00:14,200 --> 00:00:17,000
Speaker 1: Sure, go ahead.
`;
const omnyTurns = parseSubRip(omny);
check('合并为 3 轮', omnyTurns.length === 3, `实际 ${omnyTurns.length}`);
check('第 1 轮 speaker=1', omnyTurns[0].speaker === 1);
check('第 1 轮合并两句', omnyTurns[0].text === 'Welcome back to the show. Today we discuss markets.', omnyTurns[0].text);
check('第 2 轮 speaker=2', omnyTurns[1].speaker === 2);
check('第 2 轮合并两句', omnyTurns[1].text === 'Thanks for having me. Great to be here. Let me start with rates.', omnyTurns[1].text);
check('第 3 轮 speaker=1', omnyTurns[2].speaker === 1);
check('ts 取整秒', omnyTurns[0].ts === 1 && omnyTurns[2].ts === 14);

// ---------- 2. Captivate / Whisper 风格：无说话人标签 ----------
console.log('\n[2] parseSubRip — Captivate/Whisper 无说话人（关键回归）');
// 连续短句（间隔小）应合并；长间隔应另起一轮；不会整集塌成 1 轮。
const speakerless = `1
00:00:00,000 --> 00:00:02,000
Hello everyone and welcome

2
00:00:02,300 --> 00:00:04,000
to another episode of the show

3
00:00:04,200 --> 00:00:06,000
where we dig into the markets

4
00:00:30,000 --> 00:00:33,000
After a long pause we resume

5
00:00:33,300 --> 00:00:36,000
talking about something new
`;
const slTurns = parseSubRip(speakerless);
check('不会塌成 1 轮', slTurns.length > 1, `实际 ${slTurns.length} 轮`);
check('按 24 秒间隔分成 2 轮', slTurns.length === 2, `实际 ${slTurns.length}`);
check('第 1 轮合并前 3 句', slTurns[0].text === 'Hello everyone and welcome to another episode of the show where we dig into the markets', slTurns[0].text);
check('null speaker → 1', slTurns.every((t) => t.speaker === 1));

// 长度上限：间隔很小（不触发 gap 规则），但每句很长，只能靠 maxChars 分段
console.log('\n[3] parseSubRip — maxChars 长度上限');
const fmt = (totalSec, ms) => {
  const h = String(Math.floor(totalSec / 3600)).padStart(2, '0');
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, '0');
  const s = String(totalSec % 60).padStart(2, '0');
  return `${h}:${m}:${s},${String(ms).padStart(3, '0')}`;
};
const longish = Array.from({ length: 30 }, (_, i) => {
  const start = i; // 每句间隔 1 秒；end = start + 0.9s → 相邻 gap = 0.1s，远小于 gapSec=5
  return `${i + 1}\n${fmt(start, 0)} --> ${fmt(start, 900)}\nThis is a fairly long sentence number ${i} that adds quite a lot of characters to the buffer\n`;
}).join('\n');
const longTurns = parseSubRip(longish, { gapSec: 5, maxChars: 340 });
check('长度上限触发分段（多轮）', longTurns.length >= 2, `实际 ${longTurns.length} 轮`);
check('约每 3-4 句分一段', longTurns.length >= 6 && longTurns.length <= 12, `实际 ${longTurns.length} 轮`);
check('每轮不超过约 maxChars+一句', longTurns.every((t) => t.text.length < 340 + 90));

// ---------- 4. 噪声过滤 + VTT 小数点时间 + 内联标签 ----------
console.log('\n[4] parseSubRip — 噪声/标签/VTT');
const noisy = `WEBVTT

1
00:00:00.000 --> 00:00:03.000
Privacy and cookie notice from omny.fm

2
00:00:04.000 --> 00:00:07.000
<i>Real content starts here</i>
`;
const noisyTurns = parseSubRip(noisy);
check('过滤 omny 隐私提示', noisyTurns.length === 1, `实际 ${noisyTurns.length}`);
check('去掉 <i> 内联标签', noisyTurns[0] && noisyTurns[0].text === 'Real content starts here', noisyTurns[0]?.text);
check('VTT 点号时间可解析', noisyTurns[0] && noisyTurns[0].ts === 4);

// ---------- 5. RSS parseItems —— ETF Prime 真实样本 ----------
console.log('\n[5] parseItems — ETF Prime (WordPress/blubrry, H:MM:SS)');
const etfPrimeXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel><title>ETF Prime</title>
<item>
  <title>The AI Trade: Opportunity, Risk &#038; What Comes Next</title>
  <link>https://etfprime.com/?p=50647</link>
  <guid isPermaLink="false">https://etfprime.com/?p=50647</guid>
  <pubDate>Tue, 20 Oct 2026 19:27:11 +0000</pubDate>
  <enclosure url="https://media.blubrry.com/etf_store/content.blubrry.com/etf_store/etf_prime_102026.mp3" length="125832805" type="audio/mpeg" />
  <itunes:duration>1:05:28</itunes:duration>
  <description><![CDATA[Nate Geraci discusses the AI trade.]]></description>
</item>
<item>
  <title>Older Episode With Transcript</title>
  <guid isPermaLink="false">https://etfprime.com/?p=40000</guid>
  <pubDate>Tue, 13 Oct 2026 19:00:00 +0000</pubDate>
  <enclosure url="https://media.blubrry.com/etf_store/older.mp3" length="100" type="audio/mpeg" />
  <itunes:duration>58:10</itunes:duration>
  <podcast:transcript url="https://etfprime.com/transcripts/older.srt" type="application/srt" />
</item>
</channel></rss>`;
const etfItems = parseItems(etfPrimeXml);
check('解析出 2 个 item', etfItems.length === 2, `实际 ${etfItems.length}`);
const it0 = etfItems[0];
check('标题实体解码 &#038; → &', it0.title === 'The AI Trade: Opportunity, Risk & What Comes Next', it0.title);
check('guid 为 URL', it0.guid === 'https://etfprime.com/?p=50647', it0.guid);
check('pubDate → 2026-10-20', it0.date === '2026-10-20', it0.date);
check('enclosure url 提取', it0.audio_url === 'https://media.blubrry.com/etf_store/content.blubrry.com/etf_store/etf_prime_102026.mp3');
check('H:MM:SS 时长 → 3928s', it0.duration_seconds === 3928, `实际 ${it0.duration_seconds}`);
check('CDATA description', it0.description === 'Nate Geraci discusses the AI trade.', it0.description);
check('最新集无 transcript', it0.transcript_url === null);
check('旧集有 podcast:transcript', etfItems[1].transcript_url === 'https://etfprime.com/transcripts/older.srt');
check('transcript type', etfItems[1].transcript_type === 'application/srt');

// ---------- 6. RSS parseItems —— Behind the Ticker (Buzzsprout, 纯秒) ----------
console.log('\n[6] parseItems — Behind the Ticker (Buzzsprout, 纯秒 duration)');
const bttXml = `<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel>
<item>
  <title><![CDATA[The $7 Trillion Market Most Advisors Can&#39;t Actually Access | Chris Getter, Simplify]]></title>
  <guid isPermaLink="false">Buzzsprout-19947158</guid>
  <pubDate>Wed, 15 Oct 2026 10:00:00 -0400</pubDate>
  <enclosure url="https://www.buzzsprout.com/2162961/episodes/19947158-simplify.mp3" type="audio/mpeg" />
  <itunes:duration>1337</itunes:duration>
</item>
</channel></rss>`;
const bttItems = parseItems(bttXml);
check('解析出 1 个 item', bttItems.length === 1);
check('CDATA + 实体 → 撇号', bttItems[0].title === "The $7 Trillion Market Most Advisors Can't Actually Access | Chris Getter, Simplify", bttItems[0].title);
check('短 guid Buzzsprout-19947158', bttItems[0].guid === 'Buzzsprout-19947158');
check('纯秒 duration → 1337', bttItems[0].duration_seconds === 1337, `实际 ${bttItems[0].duration_seconds}`);
check('pubDate 带时区可解析', bttItems[0].date === '2026-10-15', bttItems[0].date);

// ---------- 7. decodeEntities / parseDuration 边界 ----------
console.log('\n[7] decodeEntities / parseDuration 边界');
check('decodeEntities 数字实体', decodeEntities('a&#65;b') === 'aAb', decodeEntities('a&#65;b'));
check('decodeEntities 十六进制', decodeEntities('&#x41;') === 'A');
check('decodeEntities 顺序（&amp;lt; 不误解）', decodeEntities('&amp;lt;') === '&lt;', decodeEntities('&amp;lt;'));
check('parseDuration MM:SS', parseDuration('58:10') === 3490, String(parseDuration('58:10')));
check('parseDuration H:MM:SS', parseDuration('1:05:28') === 3928);
check('parseDuration 纯秒字符串', parseDuration('1337') === 1337);
check('parseDuration 空 → null', parseDuration('') === null);

console.log(`\n==== 结果: ${pass} 通过, ${fail} 失败 ====`);
process.exit(fail ? 1 : 0);
