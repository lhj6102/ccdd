<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import type { MonitorDetail, MonitorHumanTool, MonitorSession, MonitorToolResponse } from '../types.js';
import { api, ApiError, errorMessage, requestRoute } from './api';
import ToolOutput from './ToolOutput.vue';

const props = defineProps<{ detail: MonitorDetail; session: MonitorSession | null; sessionError: string }>();
const emit = defineEmits<{ updated: [detail: MonitorDetail]; refresh: []; sessionExpired: [] }>();
const busy = ref<'claim' | 'complete' | 'tool' | null>(null), error = ref(''), toolName = ref('');
const fields = ref<Record<string, string>>({}), toolResult = ref<unknown>(null), lastArguments = ref<Record<string, unknown>>({});
const summary = ref(''), evidence = ref(''), verdict = ref<'GREEN' | 'RED'>('GREEN');
const toolForm = ref<HTMLFormElement | null>(null);
const tool = computed(() => props.detail.tools?.find(item => item.name === toolName.value));
const canAct = computed(() => Boolean(props.session && props.detail.human?.canComplete));
const route = computed(() => requestRoute(props.detail.request.projectId, props.detail.request.id));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const fieldLabels: Record<string, string> = { path: '내부 경로', startLine: '시작 줄', lineCount: '읽을 줄 수', offset: '시작 항목', limit: '항목 수' };
const defaults: Record<string, string> = { path: '', startLine: '1', lineCount: '80', offset: '0', limit: '100' };
const definitions = computed(() => {
  const schema = tool.value?.inputSchema;
  if (!schema || !record(schema.properties)) return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(schema.properties).flatMap(([name, value]) => record(value) ? [{
    name, label: fieldLabels[name] ?? name, numeric: value.type === 'integer' || value.type === 'number', required: required.includes(name),
    minimum: typeof value.minimum === 'number' ? value.minimum : undefined, maximum: typeof value.maximum === 'number' ? value.maximum : undefined,
  }] : []);
});
let toolController: AbortController | undefined, alive = true;

function toolLabel(value: MonitorHumanTool): string {
  const action = value.operation === 'read' ? '읽기' : value.operation === 'list' ? '목록' : value.name.startsWith('open_') ? '열기' : value.name.slice(0, -(value.artifactId.length + 1));
  return `${value.artifactId} · ${action}`;
}
function selectTool(value: MonitorHumanTool): void {
  toolName.value = value.name; fields.value = {}; error.value = ''; toolResult.value = null;
  const properties = value.inputSchema.properties;
  if (record(properties)) for (const [name, schema] of Object.entries(properties)) fields.value[name] = record(schema) && (typeof schema.default === 'string' || typeof schema.default === 'number') ? String(schema.default) : defaults[name] ?? '';
}
function clickTool(value: MonitorHumanTool): void {
  if (!canAct.value || busy.value) return;
  selectTool(value);
  if (definitions.value.some(field => field.required && !fields.value[field.name]?.trim())) {
    void nextTick(() => toolForm.value?.querySelector<HTMLInputElement>('input[required]')?.focus());
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
function argumentsFromFields(): Record<string, unknown> {
  const arguments_: Record<string, unknown> = {};
  for (const field of definitions.value) {
    const value = fields.value[field.name]?.trim() ?? '';
    if (!value) { if (field.required) throw new Error(`${field.label}을 입력해 주세요.`); continue; }
    if (field.numeric) {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || (field.minimum !== undefined && parsed < field.minimum) || (field.maximum !== undefined && parsed > field.maximum)) throw new Error(`${field.label}의 범위를 확인해 주세요.`);
      arguments_[field.name] = parsed;
    } else arguments_[field.name] = value;
  }
  return arguments_;
}
async function executeTool(arguments_?: Record<string, unknown>, selectedTool = tool.value): Promise<void> {
  if (!selectedTool || !props.session || !canAct.value || busy.value) return;
  error.value = '';
  try {
    const input = arguments_ ?? argumentsFromFields();
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
  void executeTool({ ...lastArguments.value, ...values });
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
    <template v-else>
      <div class="human-heading"><span class="assigned-mark">✓ 내가 담당</span><span class="muted">검토 후 결과를 제출해 주세요.</span></div>
      <p v-if="!detail.human?.canComplete" class="inline-error" role="status">{{ detail.request.waitingReason ?? '리뷰가 준비되면 도구와 결과 제출을 사용할 수 있습니다.' }}</p>
      <section class="review-tools" aria-labelledby="human-tools-title">
        <h3 id="human-tools-title" class="section-title">제공된 도구</h3>
        <p v-if="detail.toolIssue" class="inline-error" role="status">{{ detail.toolIssue }}</p>
        <p v-else-if="!detail.tools?.length" class="muted">등록된 도구가 없습니다.</p>
        <div class="tool-choices"><button v-for="item in detail.tools" :key="item.name" class="artifact-choice" :aria-pressed="item.name === toolName" :disabled="!canAct || !!busy" @click="clickTool(item)">{{ toolLabel(item) }}</button></div>
        <form v-if="tool" ref="toolForm" class="tool-form" @submit.prevent="executeTool()">
          <p class="artifact-description">{{ tool.description }}</p>
          <div v-if="definitions.length" class="tool-fields"><label v-for="field in definitions" :key="field.name" :class="{ wide: !field.numeric }"><span>{{ field.label }}<small v-if="!field.required && !field.numeric">선택</small></span><input v-model="fields[field.name]" :type="field.numeric ? 'number' : 'text'" :min="field.minimum" :max="field.maximum" :step="field.numeric ? 1 : undefined" :required="field.required" :placeholder="field.name === 'path' ? 'Artifact 안의 경로' : undefined" :disabled="!!busy" /></label></div>
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
