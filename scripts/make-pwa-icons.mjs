// make-pwa-icons.mjs — 从 public/icon.svg 生成 PWA 需要的 PNG 图标
// 输出：public/icons/icon-192.png, icon-512.png, icon-512-maskable.png, apple-touch-icon.png (180)
// 用法（从 podcast-deploy/ 目录）：node scripts/make-pwa-icons.mjs
// 依赖：podcast-site/node_modules 里的 sharp；用 --experimental-loader 不需要，直接 import 路径解析
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire('C:/Users/10171/.qoderwork/workspace/mtjtuustn8ugfw99/podcast-site/');
const sharp = require('sharp');

const PUB = 'C:/Users/10171/.qoderwork/workspace/mtjtuustn8ugfw99/podcast-deploy/public';
const OUT = path.join(PUB, 'icons');
fs.mkdirSync(OUT, { recursive: true });

const svg = fs.readFileSync(path.join(PUB, 'icon.svg'));

// maskable 版本：加内边距，避免被圆形/圆角遮罩裁掉主体（安全区约 20%）
async function render(size, { pad = 0, file } = {}) {
  const inner = Math.round(size * (1 - pad * 2));
  const buf = await sharp(svg, { density: 300 })
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  if (pad === 0) {
    await sharp(buf).resize(size, size).png().toFile(path.join(OUT, file));
  } else {
    // 在透明画布上居中放置带内边距的图；底色用主题色填 maskable 背景
    const bg = await sharp({
      create: { width: size, height: size, channels: 4, background: { r: 79, g: 70, b: 229, alpha: 1 } },
    }).png().toBuffer();
    await sharp(bg)
      .composite([{ input: buf, gravity: 'center' }])
      .png()
      .toFile(path.join(OUT, file));
  }
  console.log('  wrote', file, `${size}x${size}`);
}

await render(192, { file: 'icon-192.png' });
await render(512, { file: 'icon-512.png' });
await render(512, { pad: 0.2, file: 'icon-512-maskable.png' });
await render(180, { file: 'apple-touch-icon.png' });
console.log('done');
