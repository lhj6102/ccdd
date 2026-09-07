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
const actionLabels = { REUSE: '판정 재사용', EXECUTE: '검증 가능', WAIT: '의존성 검증 필요', ACTIVE: '진행 중', FAILED: '실행 확인 필요' };
</script>

<template>
  <section class="validation-view" aria-label="현재 입력 검증 상태" :aria-busy="loading">
    <div class="validation-heading">
      <div><h2>현재 입력</h2><p>프로젝트의 현재 설정과 파일을 읽어 필요한 검증을 계산합니다.</p></div>
      <button type="button" class="inspect-button" :disabled="!projectId || !session || loading" @click="inspect">{{ loading ? '입력 확인 중…' : '현재 입력 확인' }}</button>
    </div>
    <p v-if="!projectId">확인할 프로젝트를 선택하세요.</p>
    <p v-else-if="!result && !error" class="validation-empty">현재 입력 확인을 누르면 재사용할 판정과 필요한 검증을 볼 수 있습니다.</p>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <template v-if="result">
      <p class="validation-summary" role="status"><strong>{{ result.plan.satisfied ? 'PASS · 필요한 검증이 충족되었습니다.' : '검증이 더 필요합니다.' }}</strong><span>확인 시각 {{ dateLabel(result.observedAt) }} · 파일을 수정했거나 검증이 끝나면 다시 확인하세요.</span></p>
      <p class="validation-counts">재사용 {{ result.plan.counts.reuse }} · 검증 가능 {{ result.plan.counts.execute }} · 의존성 대기 {{ result.plan.counts.wait }}</p>
      <div class="validation-table-wrap"><table>
        <thead><tr><th scope="col">Critic / 대상</th><th scope="col">상태</th><th scope="col">다음 작업과 근거</th></tr></thead>
        <tbody><tr v-for="critic in result.plan.items" :key="critic.id">
          <th scope="row">{{ critic.title }}<small>{{ critic.id }} → {{ critic.target }}</small></th>
          <td><span :class="['validation-status', { passed: critic.status === 'PASS' }]">{{ critic.status }}</span></td>
          <td><strong>{{ actionLabels[critic.action] }}</strong><p>{{ critic.reason }}</p><button v-if="critic.result" type="button" class="text-button" @click="emit('open-request', { projectId, id: critic.result.requestId })">실제 판정 보기 · {{ dateLabel(critic.result.completedAt) }}</button></td>
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
