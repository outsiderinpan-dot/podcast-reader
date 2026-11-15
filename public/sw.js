/* Podcast Reader · Service Worker
 * 目标：可离线阅读所有已浏览过的单集，站点资源缓存优先，页面网络优先回退缓存。
 * 只处理同源 GET，音频/外链一律不动，避免误缓存大文件。
 * sw.js 部署在 <BASE>/sw.js，因此默认作用域 = <BASE>/，无需 Service-Worker-Allowed 头。
 */

// BASE 从 sw.js 自身位置反推：GitHub Pages 子路径 '/podcast-reader/'，本地/根域 '/'
const BASE = new URL('.', self.location).pathname;
const VERSION = 'v1';
const CACHE_SHELL  = `${BASE}shell-${VERSION}`;   // 应用外壳（首页/节目/搜索/图标/manifest）
const CACHE_PAGES  = `${BASE}pages-${VERSION}`;   // 已访问过的 HTML 页面
const CACHE_ASSETS = `${BASE}assets-${VERSION}`;  // 同源静态资源（CSS/JS/图片/字体/JSON）
const ALL_CACHES = [CACHE_SHELL, CACHE_PAGES, CACHE_ASSETS];

// 预缓存：核心外壳 + 图标 + manifest（安装即缓存，首次打开就能全离线看到主结构）
const SHELL_URLS = [
  BASE,
  BASE + 'shows/',
  BASE + 'search/',
  BASE + 'manifest.webmanifest',
  BASE + 'rss.xml',
  BASE + 'icon.svg',
  BASE + 'icons/icon-192.png',
  BASE + 'icons/icon-512.png',
  BASE + 'icons/icon-512-maskable.png',
  BASE + 'icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_SHELL);
      // 逐个添加，单个 URL 404 不影响整体安装（例如 rss.xml 若还没生成）
      await Promise.all(
        SHELL_URLS.map((u) =>
          cache.add(new Request(u, { cache: 'reload' })).catch((err) => {
            console.warn('[sw] precache skip', u, err && err.message);
          })
        )
      );
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // 清理旧版本缓存
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith(BASE) && !ALL_CACHES.includes(k))
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// 消息通道：允许页面主动请求"清空缓存/立即更新"
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'CLEAR_CACHES') {
    event.waitUntil(
      Promise.all(ALL_CACHES.map((k) => caches.delete(k))).then(() => self.skipWaiting())
    );
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // 只处理同源；跨源（音频 CDN、外部图片、Google Fonts 等）一律放行
  if (url.origin !== self.location.origin) return;
  // 只处理本站 BASE 范围内的路径
  if (!url.pathname.startsWith(BASE)) return;

  // 导航请求（HTML 页面）：网络优先，失败回退缓存，最后回退首页外壳
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE_PAGES);
          // 只缓存成功响应
          if (fresh && fresh.ok) cache.put(req, fresh.clone());
          return fresh;
        } catch (e) {
          const cached = await caches.match(req, { ignoreSearch: true });
          if (cached) return cached;
          const shell = await caches.match(BASE, { ignoreSearch: true });
          if (shell) return shell;
          return new Response('离线且无本地缓存', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })()
    );
    return;
  }

  // 静态资源（CSS/JS/图片/字体/JSON/manifest/webmanifest）：stale-while-revalidate
  event.respondWith(
    (async () => {
      const cacheKey = new Request(url.pathname + url.search, { method: 'GET' });
      const cache = await caches.open(CACHE_ASSETS);
      const hit = await cache.match(cacheKey, { ignoreSearch: false });
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type !== 'opaque') cache.put(cacheKey, res.clone());
          return res;
        })
        .catch(() => null);
      // 有缓存立刻返回；同时后台刷新
      if (hit) { network.catch(() => {}); return hit; }
      // 无缓存就等网络
      const fresh = await network;
      if (fresh) return fresh;
      // 网络失败也没缓存：给个空 204，避免上层报错
      return new Response(null, { status: 204 });
    })()
  );
});
