import { createPinia } from 'pinia';
import { createApp } from 'vue';

import App from './App.vue';
import { router } from './router';
import './styles/global.css';

const app = createApp(App);

app.use(createPinia());
app.use(router);

// 全局错误兜底：未捕获的组件异常至少不要静默消失
app.config.errorHandler = (err, _instance, info) => {
  console.error('[NoteCloud] 未捕获异常:', err, info);
};

// Promise 里的异常不会走 errorHandler。之前看板拖拽就是在这里静默失败过一次。
window.addEventListener('unhandledrejection', (event) => {
  console.error('[NoteCloud] 未处理的 Promise 拒绝:', event.reason);
});

// PWA：只在生产构建里注册，开发环境的 HMR 和 SW 缓存会互相打架
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .catch((err: unknown) => console.warn('[pwa] Service Worker 注册失败:', err));
  });
}

app.mount('#app');
