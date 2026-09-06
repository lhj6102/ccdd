<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import type { MonitorDetail, MonitorHumanTool, MonitorSession, MonitorToolResponse } from '../types.js';
import { api, ApiError, errorMessage, requestRoute } from './api';
import ToolOutput from './ToolOutput.vue';
import { initialToolFields, initialToolJson, parseToolFields, parseToolJson, toolInputForm, validateToolInput } from './tool-input';

const props = defineProps<{ detail: MonitorDetail; session: MonitorSession | null; sessionError: string }>();
const emit = defineEmits<{ updated: [detail: MonitorDetail]; refresh: []; sessionExpired: [] }>();
const busy = ref<'claim' | 'complete' | 'tool' | null>(null), error = ref(''), toolName = ref('');
const fields = ref<Record<string, string>>({}), toolResult = ref<unknown>(null), lastArguments = ref<Record<string, unknown>>({});
const jsonInput = ref('{}'), preferJson = ref(false);
const summary = ref(''), evidence = ref(''), verdict = ref<'GREEN' | 'RED'>('GREEN');
const toolForm = ref<HTMLFormElement | null>(null);
const toolsRegion = ref<HTMLElement | null>(null), focusedArtifact = ref('');
const tool = computed(() => props.detail.tools?.find(item => item.name === toolName.value));
const visibleTools = computed(() => props.detail.tools?.filter(item => !focusedArtifact.value || item.artifactId === focusedArtifact.value) ?? []);
const canAct = computed(() => Boolean(props.session && props.detail.human?.canComplete));
const route = computed(() => requestRoute(props.detail.request.projectId, props.detail.request.id));
const form = computed(() => toolInputForm(tool.value?.inputSchema ?? { type: 'object', additionalProperties: false }));
const definitions = computed(() => form.value.fields);
const jsonMode = computed(() => form.value.json || preferJson.value);
let toolController: AbortController | undefined, alive = true;

function toolLabel(value: MonitorHumanTool): string {
  const action = value.operation === 'read' ? '읽기' : value.operation === 'list' ? '목록' : value.name.startsWith('open_') ? '열기' : value.name.slice(0, -(value.artifactId.length + 1));
  return `${value.artifactId} · ${action}`;
}
function selectTool(value: MonitorHumanTool): void {
  toolName.value = value.name; fields.value = {}; error.value = ''; toolResult.value = null;
  fields.value = initialToolFields(toolInputForm(value.inputSchema).fields, props.detail.artifactPreview !== 'tools');
  jsonInput.value = initialToolJson(value.inputSchema); preferJson.value = false;
}
function showArtifactTools(artifactId: string): void {
  const registered = props.detail.tools?.find(item => item.artifactId === artifactId);
  if (!registered || busy.value) return;
  focusedArtifact.value = artifactId;
  if (tool.value?.artifactId !== artifactId) selectTool(registered);
  void nextTick(() => {
    toolsRegion.value?.scrollIntoView({ block: 'nearest' });
    toolsRegion.value?.focus({ preventScroll: true });
  });
}
defineExpose({ showArtifactTools });
function setField(name: string, event: Event): void {
  if (event.target instanceof HTMLInputElement) fields.value[name] = event.target.value;
}
function clickTool(value: MonitorHumanTool): void {
  if (!canAct.value || busy.value) return;
  selectTool(value);
  if (jsonMode.value || definitions.value.some(field => field.required && !fields.value[field.name])) {
    void nextTick(() => toolForm.value?.querySelector<HTMLElement>('input[required], select[required], textarea, input')?.focus());
    return;
  }
  void executeTool(undefined, value);
}
watch(() => props.detail.tools?.map(item => item.name).join('\0'), () => {
  if (!tool.value && props.detail.tools?.[0]) selectTool(props.detail.tools[0]);
}, { immediate: true });
function report(problem: unknown): void {
  error.value = errorMessage(problem);
  if (problem instanceof ApiError && problem.status === 403) emit('sessionExpired');
  if (problem instanceof ApiError && problem.status === 409) emit('refresh');
}
async function claim(): Promise<void> {
  if (!props.session || busy.value || !props.detail.human?.canClaim) return;
  busy.value = 'claim'; error.value = '';
  try { const value = await api<MonitorDetail>(`${route.value}/claim`, { body: {}, csrfToken: props.session.csrfToken }); if (alive) emit('updated', value); }
  catch (problem) { if (alive) report(problem); }
  finally { busy.value = null; }
}
function toggleJson(): void {
  if (!tool.value) return;
  if (!preferJson.value) {
    try { jsonInput.value = JSON.stringify(parseToolFields(tool.value.inputSchema, definitions.value, fields.value), null, 2); }
    catch { jsonInput.value = initialToolJson(tool.value.inputSchema); }
  } else {
    try {
      const input = parseToolJson(tool.value.inputSchema, jsonInput.value);
      if (Object.keys(input).some(name => !definitions.value.some(field => field.name === name))) throw new Error('추가한 항목은 JSON 입력에서 편집해 주세요.');
      fields.value = initialToolFields(definitions.value.map(field => ({ ...field, default: input[field.name] })));
    } catch (problem) { error.value = errorMessage(problem); return; }
  }
  preferJson.value = !preferJson.value;
}
async function executeTool(arguments_?: Record<string, unknown>, selectedTool = tool.value): Promise<void> {
  if (!selectedTool || !props.session || !canAct.value || busy.value) return;
  error.value = '';
  try {
    const input = arguments_ ? validateToolInput(selectedTool.inputSchema, arguments_) : jsonMode.value
      ? parseToolJson(selectedTool.inputSchema, jsonInput.value)
      : parseToolFields(selectedTool.inputSchema, definitions.value, fields.value);
    busy.value = 'tool'; toolController = new AbortController(); toolResult.value = null;
    const response = await api<MonitorToolResponse>(`${route.value}/tools/${encodeURIComponent(selectedTool.name)}`, { body: { arguments: input }, csrfToken: props.session.csrfToken, signal: toolController.signal });
    if (!alive) return;
    lastArguments.value = input; toolResult.value = response.result;
    emit('refresh');
  } catch (problem) { if (alive) report(problem); }
  finally { busy.value = null; }
}
function nextPage(values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) fields.value[key] = String(value);
  const input = { ...lastArguments.value, ...values };
  jsonInput.value = JSON.stringify(input, null, 2);
  void executeTool(input);
}
function navigate(operation: 'read' | 'list', path: string): void {
  const target = props.detail.tools?.find(item => item.artifactId === tool.value?.artifactId && item.operation === operation);
  if (!target) return;
  selectTool(target); fields.value.path = path;
  void executeTool({ path }, target);
}
async function complete(): Promise<void> {
  if (!props.session || !canAct.value || busy.value) return;
  const entries = evidence.value.split('\n').map(line => line.trim()).filter(Boolean);
  if (!summary.value.trim() || !entries.length) { error.value = '검토 요약과 근거를 입력해 주세요.'; return; }
  if (entries.length > 100 || entries.some(item => item.length > 4_000)) { error.value = '근거는 100개까지, 각 근거는 4,000자 이내로 적어 주세요.'; return; }
  const result = { verdict: verdict.value, summary: summary.value.trim(), evidence: entries };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > 32_768) { error.value = '요약과 근거가 너무 깁니다. 내용을 조금 줄여 주세요.'; return; }
  busy.value = 'complete'; error.value = '';
  try {
    const value = await api<MonitorDetail>(`${route.value}/complete`, { body: result, csrfToken: props.session.csrfToken });
    if (alive) emit('updated', value);
  } catch (problem) { if (alive) report(problem); }
  finally { busy.value = null; }
}
onUnmounted(() => { alive = false; toolController?.abort(); });
</script>

<template>
  <section class="human-review" aria-label="Human 검토">
    <p v-if="sessionError" class="inline-error" role="status">{{ sessionError }}</p>
    <div v-if="detail.human?.canClaim" class="claim-callout"><div><strong>이 리뷰를 맡아 주세요.</strong><p>담당한 뒤 제공된 도구로 내용을 확인하고 결과를 제출합니다.</p></div><button class="primary-button" :disabled="!session || !!busy" @click="claim">{{ busy === 'claim' ? '담당하는 중…' : '맡아서 검토' }}</button></div>
    <p v-else-if="!detail.human?.claimedByMe" class="other-reviewer">{{ detail.request.claimedBy ? '다른 검토자가 담당하고 있습니다.' : '리뷰가 준비되기를 기다리고 있습니다.' }}</p>
    <section v-if="!detail.human?.claimedByMe && focusedArtifact" ref="toolsRegion" class="artifact-tool-preview" tabindex="-1" aria-labelledby="artifact-preview-title">
      <h3 id="artifact-preview-title" class="section-title">{{ focusedArtifact }} · 제공된 도구</h3>
      <p class="muted">{{ detail.human?.canClaim ? '검토를 맡은 후 아래 도구를 실행할 수 있습니다.' : '담당한 검토자만 도구를 실행할 수 있습니다.' }}</p>
      <ul><li v-for="item in visibleTools" :key="item.name"><strong>{{ toolLabel(item) }}</strong><p>{{ item.description }}</p></li></ul>
    </section>
    <template v-if="detail.human?.claimedByMe">
      <div class="human-heading"><span class="assigned-mark">✓ 내가 담당</span><span class="muted">검토 후 결과를 제출해 주세요.</span></div>
      <p v-if="!detail.human?.canComplete" class="inline-error" role="status">{{ detail.request.waitingReason ?? '리뷰가 준비되면 도구와 결과 제출을 사용할 수 있습니다.' }}</p>
      <section ref="toolsRegion" class="review-tools" tabindex="-1" aria-labelledby="human-tools-title">
        <div class="artifact-tool-heading"><h3 id="human-tools-title" class="section-title">{{ focusedArtifact ? `${focusedArtifact} · 제공된 도구` : '제공된 도구' }}</h3><button v-if="focusedArtifact" type="button" class="text-button" @click="focusedArtifact = ''">전체 도구</button></div>
        <p v-if="detail.toolIssue" class="inline-error" role="status">{{ detail.toolIssue }}</p>
        <p v-else-if="!detail.tools?.length" class="muted">등록된 도구가 없습니다.</p>
        <div class="tool-choices"><button v-for="item in visibleTools" :key="item.name" class="artifact-choice" :aria-pressed="item.name === toolName" :disabled="!canAct || !!busy" @click="clickTool(item)">{{ toolLabel(item) }}</button></div>
        <form v-if="tool" ref="toolForm" class="tool-form" @submit.prevent="executeTool()">
          <p class="artifact-description">{{ tool.description }}</p>
          <label v-if="jsonMode" class="form-label"><span>도구 입력 · JSON</span><textarea v-model="jsonInput" class="tool-json-input" rows="7" required spellcheck="false" :disabled="!!busy" /></label>
          <div v-else-if="definitions.length" class="tool-fields">
            <label v-for="field in definitions" :key="field.name" :class="{ wide: field.kind === 'string' }">
              <span>{{ field.label }}<small v-if="!field.required">선택</small></span>
              <select v-if="field.kind === 'enum'" v-model="fields[field.name]" :required="field.required" :disabled="!!busy"><option value="">선택하세요</option><option v-for="(option, index) in field.options" :key="index" :value="String(index)">{{ typeof option === 'string' ? option : JSON.stringify(option) }}</option></select>
              <select v-else-if="field.kind === 'boolean'" v-model="fields[field.name]" :required="field.required" :disabled="!!busy"><option value="">선택하세요</option><option value="true">예</option><option value="false">아니요</option></select>
              <input v-else :value="fields[field.name]" :type="field.kind === 'string' ? 'text' : 'number'" :min="field.minimum" :max="field.maximum" :step="field.kind === 'integer' ? 1 : field.kind === 'number' ? 'any' : undefined" :minlength="field.minLength" :maxlength="field.maxLength" :required="field.required && (field.kind !== 'string' || !!field.minLength)" :placeholder="field.name === 'path' ? 'Artifact 안의 경로' : undefined" :disabled="!!busy" @input="setField(field.name, $event)" />
              <span v-if="field.description" class="tool-field-description">{{ field.description }}</span>
            </label>
          </div>
          <details v-if="jsonMode" class="tool-schema"><summary>입력 형식 보기</summary><pre>{{ JSON.stringify(tool.inputSchema, null, 2) }}</pre></details>
          <button v-if="!form.json && (definitions.length || tool.inputSchema.additionalProperties !== false)" class="text-button tool-input-mode" type="button" :disabled="!!busy" @click="toggleJson">{{ preferJson ? '입력 필드로 전환' : 'JSON으로 입력' }}</button>
          <button class="secondary-button" type="submit" :disabled="!canAct || !!busy">{{ busy === 'tool' ? '실행 중…' : tool.operation === 'read' ? '읽기' : tool.operation === 'list' ? '목록 보기' : '도구 실행' }}</button>
        </form>
        <ToolOutput v-if="toolResult !== null" :result="toolResult" :can-read="!!detail.tools?.some(item => item.artifactId === tool?.artifactId && item.operation === 'read')" :can-list="!!detail.tools?.some(item => item.artifactId === tool?.artifactId && item.operation === 'list')" :busy="!!busy" @page="nextPage" @navigate="navigate" />
      </section>
      <form class="verdict-form" @submit.prevent="complete">
        <h3 class="section-title">검토 결과</h3>
        <fieldset class="verdict-options" :disabled="!canAct || !!busy"><legend class="sr-only">판정</legend><label :class="{ chosen: verdict === 'GREEN' }"><input v-model="verdict" type="radio" value="GREEN" /><span><strong>GREEN</strong> 기준 충족</span></label><label :class="{ chosen: verdict === 'RED' }"><input v-model="verdict" type="radio" value="RED" /><span><strong>RED</strong> 기준 미충족</span></label></fieldset>
        <label class="form-label"><span>검토 요약</span><textarea v-model="summary" rows="3" required maxlength="12000" placeholder="판정한 이유를 간단히 적어 주세요." :disabled="!canAct || !!busy"></textarea></label>
        <label class="form-label"><span>근거 <small>한 줄에 하나씩</small></span><textarea v-model="evidence" rows="3" required maxlength="24000" placeholder="확인한 내용이나 관련 위치를 적어 주세요." :disabled="!canAct || !!busy"></textarea></label>
        <div class="submit-row"><p>제출한 판정은 이 요청의 결과로 저장됩니다.</p><button class="primary-button" type="submit" :disabled="!canAct || !!busy">{{ busy === 'complete' ? '제출 중…' : '결과 제출' }}</button></div>
      </form>
    </template>
    <p v-if="error" class="inline-error action-error" role="alert">{{ error }}</p>
  </section>
</template>
