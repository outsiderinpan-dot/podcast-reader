// @ts-check
import { defineConfig } from 'astro/config';

// GitHub Pages 部署配置（全部可用环境变量覆盖，见 .github/workflows/publish.yml）
//   SITE : 站点最终域名。自定义域名填 https://你的域名；用户名站填 https://<user>.github.io
//   BASE : 子路径。普通项目页 https://<user>.github.io/<repo>/ 填 '/<repo>'；
//          自定义域名或 <user>.github.io 根站留空即可（默认 ''）。
const site = process.env.SITE || 'https://YOUR-USERNAME.github.io';
// 规范化 base：非空时补全前导和结尾斜杠，保证 import.meta.env.BASE_URL 拼接不出错
let base = process.env.BASE || '';
if (base) {
  if (!base.startsWith('/')) base = '/' + base;
  if (!base.endsWith('/')) base = base + '/';
}

export default defineConfig({
  site,
  base,
  build: { inlineStylesheets: 'auto' },
  vite: { build: { chunkSizeWarningLimit: 1200 } },
});
