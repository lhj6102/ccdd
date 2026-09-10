<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue';
import type { ArtifactReference } from '../../contracts.js';
import type { MonitorArtifactPage } from '../types.js';
import { api, errorMessage, requestRoute } from './api';

const props = defineProps<{ projectId: string; requestId: string; artifacts: ArtifactReference[]; preview?: 'legacy' | 'tools'; humanReview?: boolean }>();
const emit = defineEmits<{ review: [] }>();
interface Choice { id: string; path?: string; operation?: 'read' | 'list'; startLine?: number; offset?: number }
const choice = ref<Choice | null>(null), page = ref<MonitorArtifactPage | null>(null), loading = ref(false), error = ref(''), startLine = ref(1);
let controller: AbortController | undefined, version = 0;
const read = computed(() => page.value && 'content' in page.value.result ? page.value.result : null);
const listing = computed(() => page.value && 'entries' in page.value.result ? page.value.result : null);
const lines = computed(() => { const values = read.value?.content.split('\n') ?? []; if (values.at(-1) === '') values.pop(); return values.map(value => value.replace(/\r$/, '')); });
async function load(next?: Choice): Promise<void> {
  if (props.preview === 'tools') return;
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
watch(() => `${props.preview}:${props.projectId}:${props.requestId}:${props.artifacts.map(item => item.id).join('\0')}`, () => {
  if (props.preview === 'tools') { version++; controller?.abort(); choice.value = null; page.value = null; loading.value = false; error.value = ''; return; }
  choice.value = props.artifacts[0] ? { id: props.artifacts[0].id } : null;
  void load();
}, { immediate: true });
onUnmounted(() => { version++; controller?.abort(); });
</script>

<template>
  <div class="artifact-browser">
    <p v-if="!artifacts.length" class="muted">No Artifacts were provided.</p>
    <template v-else-if="preview === 'tools'">
      <ul class="artifact-references"><li v-for="item in artifacts" :key="item.id"><strong>{{ item.id }}</strong><span>{{ item.path }}</span><small>{{ item.type }}</small></li></ul>
      <p class="artifact-message">Inspect Artifacts with the tools provided to the reviewer. These tools can also open animations and images.</p>
      <button v-if="humanReview" class="secondary-button" @click="emit('review')">Go to review tools</button>
    </template>
    <template v-else>
    <p v-if="artifacts.length" class="artifact-description">This is a preview of the stored text. Human review tools are available in the Review tab.</p>
    <div class="artifact-choices" aria-label="Select Artifact"><button v-for="item in artifacts" :key="item.id" class="artifact-choice" :aria-pressed="choice?.id === item.id" @click="load({ id: item.id })">{{ item.path }}</button></div>
    <p v-if="loading" class="artifact-message" role="status">Reading Artifact…</p>
    <div v-else-if="error" class="artifact-message"><p class="inline-error" role="alert">{{ error }}</p><button class="text-button" @click="load()">Read again</button></div>
    <template v-else-if="page && choice">
      <p class="artifact-description">{{ page.artifact.description }}</p>
      <div class="artifact-toolbar"><button v-if="choice.path" class="text-button" @click="parent">‹ Parent folder</button><span class="artifact-path">{{ choice.path ?? page.artifact.path }}</span>
        <form v-if="read" class="line-jump" @submit.prevent="jump"><label>Start line <input v-model.number="startLine" type="number" min="1" step="1" required aria-label="Artifact start line" /></label><button class="text-button" type="submit">Go</button></form>
      </div>
      <template v-if="listing">
        <div v-if="listing.entries.length" class="file-list"><button v-for="entry in listing.entries" :key="entry.path" class="file-entry" :disabled="!['file', 'directory'].includes(entry.kind)" @click="load({ id: choice.id, operation: entry.kind === 'directory' ? 'list' : 'read', path: entry.path })"><span aria-hidden="true">{{ entry.kind === 'directory' ? '▱' : '·' }}</span>{{ entry.name }}<span class="file-arrow" aria-hidden="true">›</span></button></div>
        <p v-else class="artifact-message">This folder is empty.</p>
        <div class="artifact-pagination"><span>{{ (choice.offset ?? 0) + listing.entries.length }} / {{ listing.totalEntries }} entries</span><button v-if="choice.offset" class="text-button" @click="load({ ...choice, offset: 0 })">Back to start</button><button v-if="listing.nextOffset !== null" class="text-button" @click="load({ ...choice, operation: 'list', offset: listing.nextOffset })">Next files</button></div>
      </template>
      <template v-else-if="read">
        <div v-if="lines.length" class="code-view" role="region" aria-label="Artifact source" tabindex="0"><div v-for="(line, index) in lines" :key="index" class="code-line"><span class="line-number" aria-hidden="true">{{ read.startLine + index }}</span><span class="line-content">{{ line }}</span></div></div>
        <p v-else class="artifact-message">{{ read.totalLines === 0 ? 'This file is empty.' : 'No more content at this position.' }}</p>
        <div class="artifact-pagination"><span>{{ read.endLine === null ? 'No lines read' : `Lines ${read.startLine}–${read.endLine}` }}</span><button v-if="read.startLine > 1" class="text-button" @click="load({ ...choice, operation: 'read', startLine: 1 })">Back to start</button><button v-if="read.nextStartLine !== null" class="text-button" @click="load({ ...choice, operation: 'read', startLine: read.nextStartLine })">Next lines</button></div>
      </template>
    </template>
    </template>
  </div>
</template>
