/**
 * NoteCloud 的 Service Worker。
 *
 * 目标很克制：**让应用外壳能离线打开**，不做数据层离线同步。
 *   * 导航请求：network-first，断网时回退到缓存的 index.html
 *   * 静态资源：cache-first（Vite 产出的文件名带 hash，可以放心长期缓存）
 *   * /api/ 一律不缓存 —— 接口数据必须实时，缓存会造成"看起来保存了其实没保存"
 */

const CACHE = 'notecloud-shell-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => undefined),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // 接口与 WebSocket 不经过缓存
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match('/index.html');
        return cached ?? new Response('离线中，且没有缓存的应用外壳', { status: 503 });
      }),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        // 只缓存同源的 200 响应
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined);
        }
        return response;
      });
    }),
  );
});
