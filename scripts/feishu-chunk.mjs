// feishu-chunk.mjs — 飞书多维表格「超长文本」分片存取工具。
//
// 背景：飞书 bitable 单个文本单元格有长度上限（实测 ~9 万字符可通过，更长会报
//   TooLargeCell code=1254130）。长播客的英文转写 turns_en、以及翻译回写的 episode_json
//   （含中英双语，更大）都可能超限。
//
// 方案：把一个逻辑字符串按固定大小切成多片，存到同名派生字段：
//   base -> `X`，overflow -> `X_2` `X_3` ...（连续、非空）。
//   读取端按序拼接后再 JSON.parse，得到与原始完全一致的字符串。
//
// 说明：切分按「码点」而非 UTF-16 code unit，避免把 emoji 等代理对切坏；
//   拼接在 JSON.parse 之前完成，因此分片边界不影响解析。
export const CHUNK_SIZE = 60000;

// 把 value 切成若干片（每片 <= size 个码点）。
export function chunkValue(value, size = CHUNK_SIZE) {
  const s = String(value ?? '');
  if (s.length <= size) return [s];
  const cps = Array.from(s); // 按码点拆分，保护代理对
  const out = [];
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(''));
  return out;
}

// 生成写入用的字段对象：{ X: 片0, X_2: 片1, ... }。可直接展开进 record.fields。
export function chunkFields(name, value, size = CHUNK_SIZE) {
  const parts = chunkValue(value, size);
  const o = {};
  parts.forEach((p, i) => { o[i === 0 ? name : `${name}_${i + 1}`] = p; });
  return o;
}

// 默认文本归一化：飞书文本字段可能是字符串，也可能是 [{text,type}] 分段数组。
export function defText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((x) => x?.text ?? '').join('');
  if (typeof v === 'object') return v.text || v.value || '';
  return String(v);
}

// 从 record.fields 里按序拼接分片，还原完整字符串。
export function readChunked(fields, name, textOf = defText) {
  const f = fields || {};
  let out = textOf(f[name]);
  for (let i = 2; ; i++) {
    const key = `${name}_${i}`;
    if (!(key in f)) break;
    const part = textOf(f[key]);
    if (!part) break;
    out += part;
  }
  return out;
}

// 返回某逻辑字段需要用到的所有分片字段名（含 base），便于建表时预建 overflow 字段。
export function chunkFieldNames(name, maxChunks) {
  const arr = [name];
  for (let i = 2; i <= maxChunks; i++) arr.push(`${name}_${i}`);
  return arr;
}
