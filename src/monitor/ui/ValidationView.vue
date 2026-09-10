<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue';
import type { MonitorSession, MonitorValidation } from '../types.js';
import { api, ApiError, errorMessage } from './api';
import { dateLabel } from './format';

const props = defineProps<{ projectId: string; session: MonitorSession | null }>();
const emit = defineEmits<{ 'open-request': [request: { projectId: string; id: string }]; 'session-expired': [] }>();
const result = ref<MonitorValidation | null>(null), loading = ref(false), error = ref('');
let controller: AbortController | undefined, version = 0;
watch(() => props.projectId, () => { version++; controller?.abort(); result.value = null; loading.value = false; error.value = ''; });
onUnmounted(() => { version++; controller?.abort(); });
async function inspect(): Promise<void> {
  if (!props.projectId || !props.session || loading.value) return;
  controller = new AbortController(); const current = ++version;
  loading.value = true; error.value = '';
  try {
    const value = await api<MonitorValidation>(`/api/projects/${encodeURIComponent(props.projectId)}/validation`, { body: {}, csrfToken: props.session.csrfToken, signal: controller.signal });
    if (current === version) result.value = value;
  } catch (value) {
    if (current !== version) return;
    error.value = errorMessage(value);
    if (value instanceof ApiError && value.status === 403) emit('session-expired');
  } finally { if (current === version) loading.value = false; }
}
const actionLabels = { REUSE: 'Reuse verdict', EXECUTE: 'Ready to review', WAIT: 'Dependencies need review', ACTIVE: 'In progress', FAILED: 'Execution needs attention' };
</script>

<template>
  <section class="validation-view" aria-label="Current input validation status" :aria-busy="loading">
    <div class="validation-heading">
      <div><h2>Current input</h2><p>Read the project's current configuration and files to determine the reviews needed.</p></div>
      <button type="button" class="inspect-button" :disabled="!projectId || !session || loading" @click="inspect">{{ loading ? 'Inspecting input…' : 'Inspect current input' }}</button>
    </div>
    <p v-if="!projectId">Select a project to inspect.</p>
    <p v-else-if="!result && !error" class="validation-empty">Select Inspect current input to see reusable verdicts and required reviews.</p>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <template v-if="result">
      <p class="validation-summary" role="status"><strong>{{ result.plan.satisfied ? 'PASS · All required reviews are satisfied.' : 'More reviews are needed.' }}</strong><span>Observed at {{ dateLabel(result.observedAt) }} · Inspect again after editing files or completing reviews.</span></p>
      <p class="validation-counts">Reuse {{ result.plan.counts.reuse }} · Ready to review {{ result.plan.counts.execute }} · Awaiting dependencies {{ result.plan.counts.wait }}</p>
      <div class="validation-table-wrap"><table>
        <thead><tr><th scope="col">Critic / Target</th><th scope="col">Status</th><th scope="col">Next action and reason</th></tr></thead>
        <tbody><tr v-for="critic in result.plan.items" :key="critic.id">
          <th scope="row">{{ critic.title }}<small>{{ critic.id }} → {{ critic.target }}</small></th>
          <td><span :class="['validation-status', { passed: critic.status === 'PASS' }]">{{ critic.status }}</span></td>
          <td><strong>{{ actionLabels[critic.action] }}</strong><p>{{ critic.reason }}</p><button v-if="critic.result" type="button" class="text-button" @click="emit('open-request', { projectId, id: critic.result.requestId })">View recorded verdict · {{ dateLabel(critic.result.completedAt) }}</button></td>
        </tr></tbody>
      </table></div>
    </template>
  </section>
</template>

<style scoped>
.validation-view { background: #fff; border: 1px solid #e4e7e6; border-radius: 14px; padding: 24px; }
.validation-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
h2 { margin: 0 0 8px; font-size: 19px; } p { line-height: 1.65; } .validation-heading p, .validation-empty { color: #67716c; }
.inspect-button { border: 0; border-radius: 8px; padding: 11px 18px; background: #264d40; color: white; cursor: pointer; white-space: nowrap; }
.inspect-button:disabled { opacity: .55; cursor: default; }
.validation-summary { padding-top: 16px; border-top: 1px solid #e4e7e6; } .validation-summary span { display: block; color: #67716c; font-size: 12px; }
.validation-counts { font-size: 13px; }.validation-table-wrap { overflow-x: auto; } table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
th, td { border-bottom: 1px solid #e8ecea; padding: 15px 12px; vertical-align: top; } thead th { color: #67716c; font-size: 12px; } td p { margin: 6px 0; }
small { display: block; color: #67716c; font-weight: normal; margin-top: 7px; }.validation-status { display: inline-block; padding: 4px 7px; background: #f3efe3; border-radius: 5px; font-size: 11px; }.validation-status.passed { background: #e6f1e9; color: #246740; }
@media (max-width: 650px) { .validation-view { padding: 16px; }.validation-heading { align-items: flex-start; flex-direction: column; } }
</style>
