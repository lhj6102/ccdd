<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref } from 'vue';
import type { MonitorDetail, MonitorSession } from '../types.js';
import { dateLabel, kindLabels, statusLabel } from './format';
import ArtifactBrowser from './ArtifactBrowser.vue';
import HumanReview from './HumanReview.vue';

defineProps<{ selection: { projectId: string; id: string }; detail: MonitorDetail | null; error: string; session: MonitorSession | null; sessionError: string; projectName: string }>();
const emit = defineEmits<{ close: []; refresh: []; updated: [detail: MonitorDetail]; sessionExpired: [] }>();
const dialog = ref<HTMLDialogElement | null>(null), closeButton = ref<HTMLButtonElement | null>(null), tab = ref<'review' | 'artifacts'>('review');
function keyTab(event: KeyboardEvent): void {
  if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
  event.preventDefault(); tab.value = tab.value === 'review' ? 'artifacts' : 'review';
  void nextTick(() => dialog.value?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus());
}
onMounted(() => { dialog.value?.showModal(); document.body.classList.add('drawer-open'); closeButton.value?.focus({ preventScroll: true }); });
onUnmounted(() => { dialog.value?.close(); document.body.classList.remove('drawer-open'); });
</script>

<template>
  <dialog ref="dialog" class="request-drawer" aria-labelledby="request-title" @cancel.prevent="emit('close')" @click="event => { if (event.target === dialog) emit('close'); }">
    <div class="drawer-content">
      <div class="detail-top"><span class="detail-project">{{ projectName }}</span><button ref="closeButton" class="icon-button" aria-label="요청 상세 닫기" @click="emit('close')"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg></button></div>
      <h2 id="request-title">{{ detail?.request.title ?? '리뷰 요청' }}</h2>
      <p v-if="error" class="inline-error" role="status">{{ error }} <button class="text-button" @click="emit('refresh')">다시 확인</button></p>
      <p v-if="!detail && !error" class="artifact-message">요청을 불러오는 중…</p>
      <template v-if="detail">
        <div class="detail-meta"><span class="card-status" :class="detail.request.status.toLowerCase()">{{ statusLabel(detail.request) }}</span><span>{{ kindLabels[detail.profile.kind] }}</span><span v-if="detail.human?.claimedByMe" class="assigned-mark">내가 담당</span></div>
        <div class="detail-tabs" role="tablist" aria-label="요청 정보"><button id="review-tab" role="tab" :aria-selected="tab === 'review'" :tabindex="tab === 'review' ? 0 : -1" aria-controls="review-panel" @click="tab = 'review'" @keydown="keyTab">검토</button><button id="artifacts-tab" role="tab" :aria-selected="tab === 'artifacts'" :tabindex="tab === 'artifacts' ? 0 : -1" aria-controls="artifacts-panel" @click="tab = 'artifacts'" @keydown="keyTab">Artifact</button></div>
        <div v-show="tab === 'review'" id="review-panel" role="tabpanel" aria-labelledby="review-tab">
          <template v-if="detail.result || detail.error"><p v-if="detail.request.status === 'ERROR'" class="result-label error">ERROR · 리뷰를 실행하지 못했습니다.</p><p v-else-if="detail.request.status === 'RED'" class="result-label red">RED · 검토 기준을 충족하지 못했습니다.</p><p v-else class="result-label green">GREEN · 검토 기준을 충족했습니다.</p><p class="outcome" :class="{ error: detail.error }">{{ detail.error ?? detail.result?.summary }}</p><details v-if="detail.result?.evidence.length" class="evidence" open><summary>근거 {{ detail.result.evidence.length }}개</summary><ul><li v-for="(item, index) in detail.result.evidence" :key="index">{{ item }}</li></ul></details></template>
          <p v-else-if="detail.request.waitingReason && detail.profile.kind !== 'human'" class="outcome">{{ detail.request.waitingReason }}</p>
          <p v-else-if="detail.request.workerState === 'missing' || detail.request.workerState === 'unknown'" class="inline-error">{{ detail.request.waitingReason }}</p>
          <section class="request-instruction"><h3 class="section-title">요청 내용</h3><p class="instruction">{{ detail.instruction }}</p><p v-if="detail.profile.kind === 'agent'" class="profile-description">{{ detail.profile.provider }} · {{ detail.profile.model }} · {{ detail.profile.reasoning }}</p></section>
          <HumanReview v-if="detail.profile.kind === 'human' && detail.request.status === 'WAITING_HUMAN'" :detail="detail" :session="session" :session-error="sessionError" @updated="value => emit('updated', value)" @refresh="emit('refresh')" @session-expired="emit('sessionExpired')" />
          <section v-if="detail.timeline.length" class="detail-section"><h3 class="section-title">진행 기록</h3><ol class="timeline"><li v-for="(item, index) in detail.timeline" :key="`${item.label}/${index}`"><span>{{ item.label }}</span><time :datetime="item.at">{{ dateLabel(item.at) }}</time></li></ol></section>
        </div>
        <div v-if="tab === 'artifacts'" id="artifacts-panel" role="tabpanel" aria-labelledby="artifacts-tab"><ArtifactBrowser :project-id="selection.projectId" :request-id="selection.id" :artifacts="detail.artifacts" :preview="detail.artifactPreview" :human-review="detail.profile.kind === 'human' && detail.request.status === 'WAITING_HUMAN'" @review="tab = 'review'" /></div>
      </template>
    </div>
  </dialog>
</template>
