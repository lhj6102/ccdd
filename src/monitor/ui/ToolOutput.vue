<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ result: unknown; canRead: boolean; canList: boolean; busy: boolean }>();
const emit = defineEmits<{ page: [arguments_: Record<string, unknown>]; navigate: [operation: 'read' | 'list', path: string] }>();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const result = computed(() => record(props.result) ? props.result : null);
const read = computed(() => result.value && typeof result.value.content === 'string' && typeof result.value.startLine === 'number' ? {
  content: result.value.content, startLine: result.value.startLine,
  endLine: typeof result.value.endLine === 'number' ? result.value.endLine : null,
  nextStartLine: typeof result.value.nextStartLine === 'number' ? result.value.nextStartLine : null,
} : null);
const entries = computed(() => Array.isArray(result.value?.entries) ? result.value.entries.filter(record).flatMap(entry => typeof entry.path === 'string' && typeof entry.name === 'string' && typeof entry.kind === 'string' ? [{ path: entry.path, name: entry.name, kind: entry.kind }] : []) : null);
const nextOffset = computed(() => typeof result.value?.nextOffset === 'number' ? result.value.nextOffset : null);
const lines = computed(() => { const values = read.value?.content.split('\n') ?? []; if (values.at(-1) === '') values.pop(); return values.map(value => value.replace(/\r$/, '')); });
</script>

<template>
  <div class="tool-output" aria-live="polite">
    <template v-if="read">
      <div v-if="lines.length" class="code-view" role="region" aria-label="도구로 읽은 Artifact" tabindex="0"><div v-for="(line, index) in lines" :key="index" class="code-line"><span class="line-number" aria-hidden="true">{{ read.startLine + index }}</span><span class="line-content">{{ line }}</span></div></div>
      <p v-else class="artifact-message">읽은 내용이 없습니다.</p>
      <div class="artifact-pagination"><span>{{ read.endLine === null ? '읽은 줄 없음' : `${read.startLine}–${read.endLine}줄` }}</span><button v-if="read.nextStartLine !== null" class="text-button" :disabled="busy" @click="emit('page', { startLine: read.nextStartLine })">다음 줄 읽기</button></div>
    </template>
    <template v-else-if="entries">
      <div v-if="entries.length" class="file-list"><button v-for="entry in entries" :key="entry.path" class="file-entry" :disabled="busy || (entry.kind === 'directory' ? !canList : entry.kind !== 'file' || !canRead)" @click="emit('navigate', entry.kind === 'directory' ? 'list' : 'read', entry.path)"><span aria-hidden="true">{{ entry.kind === 'directory' ? '▱' : '·' }}</span>{{ entry.name }}<span class="file-arrow" aria-hidden="true">›</span></button></div>
      <p v-else class="artifact-message">빈 폴더입니다.</p>
      <div class="artifact-pagination"><span>{{ entries.length }}개 항목</span><button v-if="nextOffset !== null" class="text-button" :disabled="busy" @click="emit('page', { offset: nextOffset })">다음 파일 보기</button></div>
    </template>
    <p v-else-if="result?.kind === 'launch' && result.launched === true" class="tool-notice">등록된 프로그램을 실행했습니다. 내용을 확인한 뒤 검토 결과를 제출해 주세요.</p>
    <p v-else class="tool-notice">도구 실행을 마쳤습니다.</p>
  </div>
</template>
