<script setup lang="ts">
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';
import { NAlert, NButton, NSpin } from 'naive-ui';
import { computed, onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';

import { getSharedNote } from '@/api/share';
import type { SharedNoteDto } from '@/api/share';
import { errorMessage } from '@/utils/error';

import 'highlight.js/styles/github.css';

const route = useRoute();

const note = ref<SharedNoteDto | null>(null);
const loading = ref(true);
const error = ref('');

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(str, { language: lang, ignoreIllegals: true }).value}</code></pre>`;
      } catch {
        /* fallthrough */
      }
    }
    return `<pre class="hljs"><code>${md.utils.escapeHtml(str)}</code></pre>`;
  },
});

const html = computed(() => (note.value ? DOMPurify.sanitize(md.render(note.value.content)) : ''));

onMounted(async () => {
  try {
    const res = await getSharedNote(String(route.params.token ?? ''));
    note.value = res.note;
  } catch (err) {
    error.value = errorMessage(err);
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="nc-shared">
    <div class="nc-shared__bar">
      <span class="nc-shared__brand">📚 NoteCloud</span>
      <span v-if="note" class="nc-muted">
        来自「{{ note.workspaceName }}」· {{ note.author }} 分享
      </span>
    </div>

    <n-spin v-if="loading" style="display: block; margin: 96px auto" />

    <div v-else-if="error" class="nc-shared__card">
      <n-alert type="error" :bordered="false">{{ error }}</n-alert>
      <div style="margin-top: 16px">
        <n-button @click="$router.push('/')">回到首页</n-button>
      </div>
    </div>

    <article v-else-if="note" class="nc-shared__card nc-shared__content">
      <h1 class="nc-shared__title">{{ note.title || '未命名笔记' }}</h1>
      <div class="nc-muted" style="margin-bottom: 20px">
        最后更新 {{ new Date(note.updatedAt).toLocaleString('zh-CN') }}
      </div>
      <div class="markdown-body" v-html="html" />
    </article>

    <div class="nc-shared__foot nc-muted">只读分享 · 由 NoteCloud 提供</div>
  </div>
</template>

<style scoped>
.nc-shared {
  min-height: 100vh;
  background: #f7f9fb;
  padding: 0 16px 48px;
}

.nc-shared__bar {
  max-width: 820px;
  margin: 0 auto;
  padding: 16px 0;
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
}

.nc-shared__brand {
  font-weight: 600;
  font-size: 14px;
}

.nc-shared__card {
  max-width: 820px;
  margin: 0 auto;
  background: #fff;
  border-radius: 12px;
  padding: 32px 40px;
  box-shadow: 0 1px 3px rgb(0 0 0 / 4%);
}

.nc-shared__title {
  margin: 0 0 6px;
  font-size: 26px;
  line-height: 1.3;
}

.nc-shared__content {
  line-height: 1.8;
  font-size: 15px;
}

.nc-shared__content :deep(pre.hljs) {
  background: #f6f8fa;
  padding: 14px 16px;
  border-radius: 8px;
  overflow-x: auto;
}

.nc-shared__content :deep(code) {
  background: #f2f4f7;
  padding: 0.15em 0.35em;
  border-radius: 4px;
  font-size: 0.9em;
}

.nc-shared__content :deep(pre.hljs code) {
  background: transparent;
  padding: 0;
}

.nc-shared__content :deep(blockquote) {
  margin: 1em 0;
  padding: 0.2em 1em;
  border-left: 3px solid #d9dee5;
  color: #6b7280;
}

.nc-shared__content :deep(img) {
  max-width: 100%;
}

.nc-shared__content :deep(table) {
  border-collapse: collapse;
}

.nc-shared__content :deep(th),
.nc-shared__content :deep(td) {
  border: 1px solid #e5e7eb;
  padding: 6px 10px;
}

.nc-shared__foot {
  max-width: 820px;
  margin: 24px auto 0;
  text-align: center;
  font-size: 12px;
}
</style>
