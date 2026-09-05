<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { ArtifactReference } from '../../contracts.js';
import type { MonitorArtifactPage } from '../types.js';
import { api, errorMessage, requestRoute } from './api';

const props = defineProps<{ projectId: string; requestId: string; artifacts: ArtifactReference[] }>();
interface Choice { id: string; path?: string; operation?: 'read' | 'list'; startLine?: number; offset?: number }
const choice = ref<Choice | null>(null), page = ref<MonitorArtifactPage | null>(null), loading = ref(false), error = ref(''), startLine = ref(1);
let controller: AbortController | undefined, version = 0;
const read = computed(() => page.value && 'content' in page.value.result ? page.value.result : null);
const listing = computed(() => page.value && 'entries' in page.value.result ? page.value.result : null);
const lines = computed(() => { const values = read.value?.content.split('\n') ?? []; if (values.at(-1) === '') values.pop(); return values.map(value => value.replace(/\r$/, '')); });
async function load(next?: Choice): Promise<void> {
  if (next) choice.value = next;
  if (!choice.value) return;
  controller?.abort(); controller = new AbortController(); const currentVersion = ++version;
  const current = { ...choice.value }; loading.value = true; error.value = ''; page.value = null;
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(current)) if (key !== 'id' && value !== undefined) query.set(key, String(value));
  try {
    const result = await api<MonitorArtifactPage>(`${requestRoute(props.projectId, props.requestId)}/artifacts/${encodeURIComponent(current.id)}?${query}`, { signal: controller.signal });
    if (currentVersion !== version) return;
    page.value = result; if ('startLine' in result.result) startLine.value = result.result.startLine;
  } catch (problem) { if (currentVersion === version) error.value = errorMessage(problem); }
  finally { if (currentVersion === version) loading.value = false; }
}
function parent(): void {
  if (!choice.value) return;
  const path = choice.value.path?.split('/').slice(0, -1).join('/');
  void load({ id: choice.value.id, operation: 'list', ...(path ? { path } : {}) });
}
function jump(): void {
  if (!choice.value || !Number.isSafeInteger(startLine.value) || startLine.value < 1) return;
  void load({ id: choice.value.id, operation: 'read', ...(choice.value.path ? { path: choice.value.path } : {}), startLine: startLine.value });
}
watch(() => props.artifacts.map(item => item.id).join('\0'), () => {
  if (!choice.value || !props.artifacts.some(item => item.id === choice.value?.id)) {
    choice.value = props.artifacts[0] ? { id: props.artifacts[0].id } : null;
    void load();
  }
}, { immediate: true });
onUnmounted(() => { version++; controller?.abort(); });
</script>

<template>
  <div class="artifact-browser">
    <p v-if="!artifacts.length" class="muted">제공된 Artifact가 없습니다.</p>
    <div class="artifact-choices" aria-label="Artifact 선택"><button v-for="item in artifacts" :key="item.id" class="artifact-choice" :aria-pressed="choice?.id === item.id" @click="load({ id: item.id })">{{ item.path }}</button></div>
    <p v-if="loading" class="artifact-message" role="status">Artifact를 읽는 중…</p>
    <div v-else-if="error" class="artifact-message"><p class="inline-error" role="alert">{{ error }}</p><button class="text-button" @click="load()">다시 읽기</button></div>
    <template v-else-if="page && choice">
      <p class="artifact-description">{{ page.artifact.description }}</p>
      <div class="artifact-toolbar"><button v-if="choice.path" class="text-button" @click="parent">‹ 상위 폴더</button><span class="artifact-path">{{ choice.path ?? page.artifact.path }}</span>
        <form v-if="read" class="line-jump" @submit.prevent="jump"><label>시작 줄 <input v-model.number="startLine" type="number" min="1" step="1" required aria-label="Artifact 시작 줄" /></label><button class="text-button" type="submit">이동</button></form>
      </div>
      <template v-if="listing">
        <div v-if="listing.entries.length" class="file-list"><button v-for="entry in listing.entries" :key="entry.path" class="file-entry" :disabled="!['file', 'directory'].includes(entry.kind)" @click="load({ id: choice.id, operation: entry.kind === 'directory' ? 'list' : 'read', path: entry.path })"><span aria-hidden="true">{{ entry.kind === 'directory' ? '▱' : '·' }}</span>{{ entry.name }}<span class="file-arrow" aria-hidden="true">›</span></button></div>
        <p v-else class="artifact-message">빈 폴더입니다.</p>
        <div class="artifact-pagination"><span>{{ (choice.offset ?? 0) + listing.entries.length }} / {{ listing.totalEntries }}개</span><button v-if="choice.offset" class="text-button" @click="load({ ...choice, offset: 0 })">처음으로</button><button v-if="listing.nextOffset !== null" class="text-button" @click="load({ ...choice, operation: 'list', offset: listing.nextOffset })">다음 파일</button></div>
      </template>
      <template v-else-if="read">
        <div v-if="lines.length" class="code-view" role="region" aria-label="Artifact 원문" tabindex="0"><div v-for="(line, index) in lines" :key="index" class="code-line"><span class="line-number" aria-hidden="true">{{ read.startLine + index }}</span><span class="line-content">{{ line }}</span></div></div>
        <p v-else class="artifact-message">{{ read.totalLines === 0 ? '빈 파일입니다.' : '이 위치에 더 읽을 내용이 없습니다.' }}</p>
        <div class="artifact-pagination"><span>{{ read.endLine === null ? '읽은 줄 없음' : `${read.startLine}–${read.endLine}줄` }}</span><button v-if="read.startLine > 1" class="text-button" @click="load({ ...choice, operation: 'read', startLine: 1 })">처음으로</button><button v-if="read.nextStartLine !== null" class="text-button" @click="load({ ...choice, operation: 'read', startLine: read.nextStartLine })">다음 줄</button></div>
      </template>
    </template>
  </div>
</template>
