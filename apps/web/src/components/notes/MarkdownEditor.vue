<script setup lang="ts">
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  bracketMatching,
  defaultHighlightStyle,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  keymap,
  lineNumbers,
  placeholder as cmPlaceholder,
} from '@codemirror/view';
import DOMPurify from 'dompurify';
// 用 lib/common 而不是全量 highlight.js：带上 ~35 种常用语言，
// 体积从 ~1MB 降到 ~80KB。需要冷门语言时再单独注册。
import hljs from 'highlight.js/lib/common';
import MarkdownIt from 'markdown-it';
import { NButton, NButtonGroup, NTooltip, useMessage } from 'naive-ui';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import { uploadAttachment } from '@/api/attachments';
import { errorMessage } from '@/utils/error';

import 'highlight.js/styles/github.css';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    readonly?: boolean;
    placeholder?: string;
    /** 有 workspaceId 才能上传附件 */
    workspaceId?: string;
  }>(),
  { readonly: false, placeholder: '开始写点什么…（支持 Markdown）', workspaceId: '' },
);

const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const message = useMessage();

// ─────────────────────────────────────────────────────────────────
// Markdown 渲染
// ─────────────────────────────────────────────────────────────────

/** 自己实现转义，避免在 MarkdownIt 的初始化器里引用 md 自身（会导致类型推断成 any） */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const md = new MarkdownIt({
  // 关键：关闭原始 HTML 渲染。开启等于把 XSS 入口直接敞开。
  html: false,
  linkify: true,
  breaks: true,
  highlight(str: string, lang: string): string {
    if (lang && hljs.getLanguage(lang)) {
      try {
        const out = hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
        return `<pre class="hljs"><code>${out}</code></pre>`;
      } catch {
        /* 落到下面的转义分支 */
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(str)}</code></pre>`;
  },
});

const html = computed(() => DOMPurify.sanitize(md.render(props.modelValue || '')));

// ─────────────────────────────────────────────────────────────────
// 编辑器
// ─────────────────────────────────────────────────────────────────

type Mode = 'split' | 'edit' | 'preview';
const mode = ref<Mode>('split');

const host = ref<HTMLElement | null>(null);
const previewEl = ref<HTMLElement | null>(null);
let view: EditorView | null = null;
/** 防止 "父组件回写 modelValue → 又触发 dispatch" 的死循环 */
let applyingExternal = false;

function buildExtensions() {
  return [
    lineNumbers(),
    history(),
    bracketMatching(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    markdown({ base: markdownLanguage, codeLanguages: languages }),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.lineWrapping,
    cmPlaceholder(props.placeholder),
    EditorState.readOnly.of(props.readonly),
    EditorView.theme({
      '&': { height: '100%', fontSize: '14px' },
      '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.7' },
      '.cm-content': { padding: '12px 0' },
      '&.cm-focused': { outline: 'none' },
    }),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged || applyingExternal) return;
      emit('update:modelValue', update.state.doc.toString());
    }),
  ];
}

onMounted(() => {
  if (!host.value) return;
  view = new EditorView({
    state: EditorState.create({ doc: props.modelValue ?? '', extensions: buildExtensions() }),
    parent: host.value,
  });
  attachScrollSync();
  attachFileHandlers();
});

onBeforeUnmount(() => {
  detachFileHandlers();
  view?.destroy();
  view = null;
});

// 外部内容变化（切换笔记 / 接受服务端版本）时同步进编辑器
watch(
  () => props.modelValue,
  (next) => {
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === (next ?? '')) return;
    applyingExternal = true;
    view.dispatch({ changes: { from: 0, to: current.length, insert: next ?? '' } });
    applyingExternal = false;
  },
);

// ─────────────────────────────────────────────────────────────────
// 滚动同步
// ─────────────────────────────────────────────────────────────────

let syncing = false;

function ratioOf(el: HTMLElement) {
  const max = el.scrollHeight - el.clientHeight;
  return max <= 0 ? 0 : el.scrollTop / max;
}

function attachScrollSync() {
  const scroller = host.value?.querySelector('.cm-scroller') as HTMLElement | null;
  if (!scroller) return;

  scroller.addEventListener('scroll', () => {
    if (syncing || mode.value !== 'split' || !previewEl.value) return;
    syncing = true;
    const target = previewEl.value;
    target.scrollTop = ratioOf(scroller) * (target.scrollHeight - target.clientHeight);
    requestAnimationFrame(() => (syncing = false));
  });

  previewEl.value?.addEventListener('scroll', () => {
    if (syncing || mode.value !== 'split') return;
    syncing = true;
    scroller.scrollTop = ratioOf(previewEl.value!) * (scroller.scrollHeight - scroller.clientHeight);
    requestAnimationFrame(() => (syncing = false));
  });
}

// ─────────────────────────────────────────────────────────────────
// 工具栏命令
// ─────────────────────────────────────────────────────────────────

function focusEditor() {
  view?.focus();
}

function wrapSelection(before: string, after = before, fallback = '文字') {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to) || fallback;
  view.dispatch({
    changes: { from, to, insert: `${before}${selected}${after}` },
    selection: { anchor: from + before.length, head: from + before.length + selected.length },
  });
  focusEditor();
}

function toggleLinePrefix(prefix: string) {
  const v = view;
  if (!v) return;
  const { from, to } = v.state.selection.main;
  const startLine = v.state.doc.lineAt(from);
  const endLine = v.state.doc.lineAt(to);

  const lines: string[] = [];
  for (let n = startLine.number; n <= endLine.number; n += 1) lines.push(v.state.doc.line(n).text);

  const allPrefixed = lines.every((l) => l.startsWith(prefix));
  const changes = lines.map((_text, i) => {
    const line = v.state.doc.line(startLine.number + i);
    return allPrefixed
      ? { from: line.from, to: line.from + prefix.length, insert: '' }
      : { from: line.from, to: line.from, insert: prefix };
  });

  v.dispatch({ changes });
  focusEditor();
}

function insertBlock(text: string) {
  if (!view) return;
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  view.dispatch({ changes: { from: line.from, to: line.from, insert: `${text}\n` } });
  focusEditor();
}

/** 在光标处插入一段文本（图片语法就走这里） */
function insertText(text: string, selectAfter = true) {
  const v = view;
  if (!v) return;
  const { from, to } = v.state.selection.main;
  v.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + (selectAfter ? text.length : 0) },
  });
  focusEditor();
}

function insertLink() {
  if (!view) return;
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to) || '链接文字';
  const insert = `[${selected}](https://)`;
  view.dispatch({
    changes: { from, to, insert },
    // 光标落在 URL 里，方便直接粘贴
    selection: { anchor: from + selected.length + 3, head: from + selected.length + 11 },
  });
  focusEditor();
}

// ─────────────────────────────────────────────────────────────────
// 附件上传（粘贴 / 拖拽 / 工具栏按钮）
// ─────────────────────────────────────────────────────────────────

const uploading = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
let attachedEl: HTMLElement | null = null;

function pickFile(): void {
  fileInput.value?.click();
}

function onFilePicked(event: Event): void {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = ''; // 允许再次选同一个文件
  if (file) void uploadFiles([file]);
}

async function uploadFiles(files: File[]): Promise<void> {
  if (!props.workspaceId || props.readonly) return;

  for (const file of files) {
    uploading.value = true;
    try {
      const { attachment } = await uploadAttachment(props.workspaceId, file);
      const isImage = attachment.mimeType.startsWith('image/');
      // 文件名里的方括号会破坏 Markdown 语法，先去掉
      const label = attachment.filename.replace(/[[\]]/g, '');
      insertText(isImage ? `![${label}](${attachment.url})\n` : `[${label}](${attachment.url})\n`);
    } catch (err) {
      message.error(errorMessage(err));
    } finally {
      uploading.value = false;
    }
  }
}

function onPaste(event: ClipboardEvent): void {
  const files = Array.from(event.clipboardData?.files ?? []);
  if (files.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  void uploadFiles(files);
}

function onDrop(event: DragEvent): void {
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (files.length === 0) return;
  event.preventDefault();
  event.stopPropagation();
  void uploadFiles(files);
}

function onDragOver(event: DragEvent): void {
  if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
}

function attachFileHandlers(): void {
  attachedEl = host.value;
  if (!attachedEl) return;
  // 用捕获阶段：CodeMirror 自己也监听 paste，必须先拦下来
  attachedEl.addEventListener('paste', onPaste, true);
  attachedEl.addEventListener('drop', onDrop, true);
  attachedEl.addEventListener('dragover', onDragOver);
}

function detachFileHandlers(): void {
  if (!attachedEl) return;
  attachedEl.removeEventListener('paste', onPaste, true);
  attachedEl.removeEventListener('drop', onDrop, true);
  attachedEl.removeEventListener('dragover', onDragOver);
  attachedEl = null;
}

const tools: Array<{ label: string; title: string; run: () => void }> = [
  { label: 'H1', title: '一级标题', run: () => toggleLinePrefix('# ') },
  { label: 'H2', title: '二级标题', run: () => toggleLinePrefix('## ') },
  { label: 'B', title: '加粗 (Ctrl+B)', run: () => wrapSelection('**') },
  { label: 'I', title: '斜体 (Ctrl+I)', run: () => wrapSelection('*') },
  { label: 'S', title: '删除线', run: () => wrapSelection('~~') },
  { label: '`', title: '行内代码', run: () => wrapSelection('`', '`', 'code') },
  { label: '•', title: '无序列表', run: () => toggleLinePrefix('- ') },
  { label: '1.', title: '有序列表', run: () => toggleLinePrefix('1. ') },
  { label: '☑', title: '任务清单', run: () => toggleLinePrefix('- [ ] ') },
  { label: '“', title: '引用', run: () => toggleLinePrefix('> ') },
  { label: '</>', title: '代码块', run: () => insertBlock('```\n\n```') },
  { label: '🔗', title: '链接', run: insertLink },
  { label: '—', title: '分隔线', run: () => insertBlock('---') },
];

defineExpose({ focus: focusEditor });
</script>

<template>
  <div class="nc-md">
    <input
      ref="fileInput"
      type="file"
      style="display: none"
      accept="image/*,.pdf,.txt,.md,.csv,.json,.zip,.docx,.xlsx,.pptx"
      @change="onFilePicked"
    />

    <div class="nc-md__bar">
      <n-button-group size="tiny">
        <n-tooltip v-for="t in tools" :key="t.title" trigger="hover" :delay="400">
          <template #trigger>
            <n-button quaternary :disabled="readonly || mode === 'preview'" @click="t.run">
              {{ t.label }}
            </n-button>
          </template>
          {{ t.title }}
        </n-tooltip>

        <n-tooltip trigger="hover" :delay="400">
          <template #trigger>
            <n-button
              quaternary
              :disabled="readonly || mode === 'preview' || !workspaceId || uploading"
              @click="pickFile"
            >
              {{ uploading ? '…' : '🖼' }}
            </n-button>
          </template>
          插入图片（也可以直接粘贴或把文件拖进来）
        </n-tooltip>
      </n-button-group>

      <div v-if="uploading" class="nc-md__uploading">正在上传…</div>

      <div class="nc-md__modes">
        <n-button-group size="tiny">
          <n-button :type="mode === 'edit' ? 'primary' : 'default'" quaternary @click="mode = 'edit'">
            编辑
          </n-button>
          <n-button :type="mode === 'split' ? 'primary' : 'default'" quaternary @click="mode = 'split'">
            分栏
          </n-button>
          <n-button :type="mode === 'preview' ? 'primary' : 'default'" quaternary @click="mode = 'preview'">
            预览
          </n-button>
        </n-button-group>
      </div>
    </div>

    <div class="nc-md__body" :class="`is-${mode}`">
      <div v-show="mode !== 'preview'" ref="host" class="nc-md__editor" />
      <div
        v-show="mode !== 'edit'"
        ref="previewEl"
        class="nc-md__preview markdown-body"
        v-html="html"
      />
    </div>
  </div>
</template>

<style scoped>
.nc-md {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.nc-md__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid #eee;
  flex: 0 0 auto;
  overflow-x: auto;
}

.nc-md__uploading {
  font-size: 11px;
  color: #18a058;
  white-space: nowrap;
}

.nc-md__body {
  flex: 1 1 auto;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
}

.nc-md__body.is-edit {
  grid-template-columns: 1fr;
}

.nc-md__body.is-preview {
  grid-template-columns: 1fr;
}

.nc-md__editor {
  min-width: 0;
  overflow: hidden;
  border-right: 1px solid #eee;
}

.nc-md__body.is-edit .nc-md__editor {
  border-right: none;
}

.nc-md__preview {
  min-width: 0;
  overflow-y: auto;
  padding: 12px 20px;
  line-height: 1.75;
  font-size: 14px;
}

/* 预览区排版（不引全局样式库，保持可控） */
.nc-md__preview :deep(h1),
.nc-md__preview :deep(h2),
.nc-md__preview :deep(h3) {
  margin: 1.2em 0 0.6em;
  line-height: 1.3;
}

.nc-md__preview :deep(h1) {
  font-size: 1.7em;
  border-bottom: 1px solid #eee;
  padding-bottom: 0.3em;
}

.nc-md__preview :deep(h2) {
  font-size: 1.35em;
}

.nc-md__preview :deep(p) {
  margin: 0.8em 0;
}

.nc-md__preview :deep(ul),
.nc-md__preview :deep(ol) {
  padding-left: 1.6em;
  margin: 0.8em 0;
}

.nc-md__preview :deep(blockquote) {
  margin: 0.8em 0;
  padding: 0.2em 1em;
  border-left: 3px solid #d9dee5;
  color: #6b7280;
  background: #fafbfc;
}

.nc-md__preview :deep(code) {
  background: #f2f4f7;
  padding: 0.15em 0.35em;
  border-radius: 4px;
  font-size: 0.9em;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.nc-md__preview :deep(pre.hljs) {
  background: #f6f8fa;
  padding: 12px 14px;
  border-radius: 6px;
  overflow-x: auto;
}

.nc-md__preview :deep(pre.hljs code) {
  background: transparent;
  padding: 0;
}

.nc-md__preview :deep(table) {
  border-collapse: collapse;
  margin: 0.8em 0;
}

.nc-md__preview :deep(th),
.nc-md__preview :deep(td) {
  border: 1px solid #e5e7eb;
  padding: 6px 10px;
}

.nc-md__preview :deep(img) {
  max-width: 100%;
}

.nc-md__preview :deep(hr) {
  border: none;
  border-top: 1px solid #eee;
  margin: 1.5em 0;
}
</style>
