<script setup lang="ts">
import { computed } from 'vue';
import { toolContent } from './tool-content';

const props = defineProps<{ result: unknown; canRead: boolean; canList: boolean; busy: boolean }>();
const emit = defineEmits<{ page: [arguments_: Record<string, unknown>]; navigate: [operation: 'read' | 'list', path: string] }>();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const result = computed(() => record(props.result) ? props.result : null);
const content = computed(() => toolContent(props.result));
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
    <template v-if="content">
      <p v-if="!content.length" class="tool-notice">The tool finished without returning content.</p>
      <template v-for="(item, index) in content" :key="index">
        <pre v-if="item.type === 'text' || item.type === 'json'" class="tool-content-text" tabindex="0" :aria-label="item.type === 'json' ? 'Tool output data' : 'Tool output text'">{{ item.text }}</pre>
        <figure v-else-if="item.type === 'image'" class="tool-content-image"><img :src="item.src" alt="Image returned by the Artifact tool" /></figure>
        <p v-else-if="item.type === 'launch'" class="tool-notice">The registered program was launched. Inspect the content, then submit your review result.</p>
        <p v-else class="inline-error">This result format cannot be displayed.</p>
      </template>
    </template>
    <template v-else-if="read">
      <div v-if="lines.length" class="code-view" role="region" aria-label="Artifact read by the tool" tabindex="0"><div v-for="(line, index) in lines" :key="index" class="code-line"><span class="line-number" aria-hidden="true">{{ read.startLine + index }}</span><span class="line-content">{{ line }}</span></div></div>
      <p v-else class="artifact-message">No content was read.</p>
      <div class="artifact-pagination"><span>{{ read.endLine === null ? 'No lines read' : `Lines ${read.startLine}–${read.endLine}` }}</span><button v-if="read.nextStartLine !== null" class="text-button" :disabled="busy" @click="emit('page', { startLine: read.nextStartLine })">Read next lines</button></div>
    </template>
    <template v-else-if="entries">
      <div v-if="entries.length" class="file-list"><button v-for="entry in entries" :key="entry.path" class="file-entry" :disabled="busy || (entry.kind === 'directory' ? !canList : entry.kind !== 'file' || !canRead)" @click="emit('navigate', entry.kind === 'directory' ? 'list' : 'read', entry.path)"><span aria-hidden="true">{{ entry.kind === 'directory' ? '▱' : '·' }}</span>{{ entry.name }}<span class="file-arrow" aria-hidden="true">›</span></button></div>
      <p v-else class="artifact-message">This folder is empty.</p>
      <div class="artifact-pagination"><span>Entries: {{ entries.length }}</span><button v-if="nextOffset !== null" class="text-button" :disabled="busy" @click="emit('page', { offset: nextOffset })">View next files</button></div>
    </template>
    <p v-else-if="result?.kind === 'launch' && result.launched === true" class="tool-notice">The registered program was launched. Inspect the content, then submit your review result.</p>
    <p v-else class="tool-notice">The tool finished.</p>
  </div>
</template>
