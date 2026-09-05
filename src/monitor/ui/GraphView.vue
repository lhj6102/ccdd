<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue';
import type { MonitorGraph } from '../types.js';
import { api } from './api';
import { kindLabels, statusLabel } from './format';
import { layoutGraph } from './graph-layout';

const props = defineProps<{ projectId: string; runId: string; selectedRequestId?: string }>();
const emit = defineEmits<{ 'open-request': [request: { projectId: string; id: string }] }>();
type Graph = NonNullable<MonitorGraph['graph']>;
type Artifact = Graph['artifacts'][number];
type Critic = Graph['critics'][number];
const data = ref<MonitorGraph | null>(null), loading = ref(false), error = ref(''), selectedArtifactId = ref(''), vertical = ref(false);
const arrowId = `graph-arrow-${useId()}`;
let controller: AbortController | undefined, version = 0, media: MediaQueryList | undefined;
const graph = computed(() => data.value?.available ? data.value.graph : null);
const artifacts = computed(() => new Map(graph.value?.artifacts.map(artifact => [artifact.id, artifact]) ?? []));
const requests = computed(() => new Map(data.value?.requests.map(request => [request.id, request]) ?? []));
const selectedArtifact = computed(() => artifacts.value.get(selectedArtifactId.value));
const selectedCritics = computed(() => graph.value?.critics.filter(critic => critic.target === selectedArtifactId.value) ?? []);
const drawing = computed(() => {
  if (!graph.value) return { layout: null, error: '' };
  try { return { layout: layoutGraph(graph.value, vertical.value), error: '' }; }
  catch { return { layout: null, error: '이 실행의 Artifact 관계를 그릴 수 없습니다. 저장된 그래프 구성을 확인해 주세요.' }; }
});
const partial = computed(() => data.value?.run.scope?.kind === 'critic');

function criticLabel(critic: Critic): string {
  if (!critic.requestId || !critic.status) return '이번 실행에 포함되지 않음';
  const request = requests.value.get(critic.requestId);
  if (request) return statusLabel(request);
  if (critic.status === 'WAITING_HUMAN') return critic.claimedBy ? '담당자 검토 중' : '담당자 기다림';
  return { BLOCKED: critic.blockedReason ? '진행 불가' : '선행 리뷰 대기', QUEUED: '실행 대기', RUNNING: '실행 중', GREEN: '통과', RED: '기준 미충족', ERROR: '실행 오류' }[critic.status];
}
function artifactLabel(artifact: Artifact): string {
  if (artifact.status === 'BLOCKED' && graph.value?.critics.some(critic => critic.target === artifact.id && criticBlocked(critic))) return '진행 불가';
  return { BASIS: '기준 Artifact', UNREVIEWED: '미평가', BLOCKED: '선행 리뷰 대기', QUEUED: '실행 대기', RUNNING: '실행 중', WAITING_HUMAN: 'Human 대기', GREEN: '통과', RED: '기준 미충족', ERROR: '실행 오류' }[artifact.status];
}
function artifactAccessibleLabel(artifact: Artifact): string { return `${artifact.id}, ${artifactLabel(artifact)}, ${artifact.total ? `Critic ${artifact.passed}/${artifact.total} 통과` : '평가 Critic 없음'}`; }
function criticBlocked(critic: Critic): boolean {
  return Boolean(critic.requestId && requests.value.get(critic.requestId)?.blockedByFailure);
}
function chooseInitialArtifact(): void {
  if (!graph.value) return;
  if (graph.value.artifacts.some(artifact => artifact.id === selectedArtifactId.value)) return;
  const wanted = graph.value.critics.find(critic => props.selectedRequestId && critic.requestId === props.selectedRequestId)?.target;
  selectedArtifactId.value = wanted ?? graph.value.artifacts.find(artifact => artifact.criticIds.length)?.id ?? graph.value.artifacts[0]?.id ?? '';
}
async function refresh(force = false): Promise<void> {
  if (!props.projectId || !props.runId || (loading.value && !force)) return;
  controller?.abort(); controller = new AbortController();
  const requestVersion = ++version, projectId = props.projectId, runId = props.runId;
  loading.value = true;
  try {
    const value = await api<MonitorGraph>(`/api/graphs/${encodeURIComponent(projectId)}/${encodeURIComponent(runId)}`, { signal: controller.signal });
    if (requestVersion !== version) return;
    if (value.project.id !== projectId || value.run.id !== runId) throw new Error('Graph scope mismatch');
    data.value = value; error.value = ''; chooseInitialArtifact();
  } catch {
    if (requestVersion === version) error.value = data.value ? '그래프를 갱신하지 못했습니다. 마지막으로 확인한 기록입니다.' : '그래프를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.';
  } finally { if (requestVersion === version) loading.value = false; }
}
function openCritic(critic: Critic): void {
  if (critic.requestId && data.value) emit('open-request', { projectId: data.value.project.id, id: critic.requestId });
}
function resize(): void { vertical.value = media?.matches ?? false; }
watch(() => [props.projectId, props.runId], () => {
  controller?.abort(); version++; loading.value = false; data.value = null; error.value = ''; selectedArtifactId.value = '';
  void refresh(true);
}, { immediate: true });
watch(() => props.selectedRequestId, id => {
  const critic = graph.value?.critics.find(item => id && item.requestId === id);
  if (critic) selectedArtifactId.value = critic.target;
});
onMounted(() => { media = matchMedia('(max-width: 700px)'); resize(); media.addEventListener('change', resize); });
onUnmounted(() => { controller?.abort(); version++; media?.removeEventListener('change', resize); });
defineExpose({ refresh });
</script>

<template>
  <section class="graph-view" aria-label="Artifact 평가 그래프" :aria-busy="loading && !data">
    <p v-if="error" class="inline-error" role="status">{{ error }}</p>
    <div v-if="!projectId || !runId" class="graph-placeholder"><strong>실행을 선택해 주세요.</strong><p>하나의 실행에 포함된 Artifact 관계와 Critic 판정을 함께 봅니다.</p></div>
    <p v-else-if="loading && !data" class="graph-placeholder">Artifact 관계를 불러오는 중…</p>
    <div v-else-if="data && !data.available" class="graph-placeholder"><strong>이 실행에는 GraphView를 제공할 수 없습니다.</strong><p>{{ data.unavailableReason || 'Artifact의 평가 대상과 참조 관계가 저장되지 않은 이전 기록입니다.' }}</p><p>Kanban에서 개별 요청과 Artifact를 확인할 수 있습니다.</p></div>
    <p v-else-if="drawing.error" class="inline-error" role="status">{{ drawing.error }}</p>
    <template v-else-if="graph && drawing.layout">
      <header class="graph-context">
        <span>Artifact {{ graph.artifacts.length }}개 <span class="graph-separator">·</span> Critic {{ graph.critics.length }}개</span>
        <span class="muted"><span v-if="partial" class="graph-partial">선택 Critic 실행</span>snapshot <span :title="data?.run.snapshotHash ?? undefined">{{ data?.run.snapshotHash?.slice(0, 10) ?? '확인 불가' }}</span></span>
      </header>
      <div class="graph-viewport" tabindex="0" aria-label="Artifact 관계도. 공간이 부족하면 스크롤하여 다른 Artifact를 볼 수 있습니다.">
        <div class="graph-canvas" :style="{ width: `${drawing.layout.width}px`, height: `${drawing.layout.height}px` }">
          <svg class="graph-edges" :viewBox="`0 0 ${drawing.layout.width} ${drawing.layout.height}`" aria-hidden="true">
            <defs><marker :id="arrowId" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M 0 0 L 10 5 L 0 10 Z" /></marker></defs>
            <g v-for="edge in drawing.layout.edges" :key="`${edge.source}/${edge.target}`" :class="{ connected: edge.source === selectedArtifactId || edge.target === selectedArtifactId }">
              <path class="graph-edge" :d="edge.path" :marker-end="`url(#${arrowId})`"><title>{{ edge.source }} → {{ edge.target }} · Critic {{ edge.criticIds.length }}개</title></path>
              <g v-if="edge.criticIds.length > 1" class="graph-edge-count"><rect :x="edge.labelX - 11" :y="edge.labelY - 9" width="22" height="18" rx="5" /><text :x="edge.labelX" :y="edge.labelY + 3">{{ edge.criticIds.length }}</text></g>
            </g>
          </svg>
          <button v-for="position in drawing.layout.nodes" :key="position.id" type="button" class="graph-artifact" :aria-pressed="selectedArtifactId === position.id" :aria-label="artifactAccessibleLabel(artifacts.get(position.id)!)" :style="{ left: `${position.x}px`, top: `${position.y}px`, width: `${position.width}px`, height: `${position.height}px` }" @click="selectedArtifactId = position.id">
            <strong class="graph-artifact-name" :title="position.id">{{ position.id }}</strong>
            <span class="card-status" :class="artifacts.get(position.id)!.status.toLowerCase()">{{ artifactLabel(artifacts.get(position.id)!) }}</span>
            <span class="graph-artifact-count">{{ artifacts.get(position.id)!.total ? `Critic ${artifacts.get(position.id)!.passed}/${artifacts.get(position.id)!.total} 통과` : '평가 Critic 없음' }}<span v-if="artifacts.get(position.id)!.included < artifacts.get(position.id)!.total"> · {{ artifacts.get(position.id)!.total - artifacts.get(position.id)!.included }}개 미실행</span></span>
          </button>
        </div>
      </div>
      <p class="graph-legend">참조 Artifact <span aria-hidden="true">→</span><span class="sr-only">에서</span> 평가 대상 <span class="graph-separator">·</span> 연결선 숫자는 해당 관계를 사용하는 Critic 수입니다.</p>
      <section v-if="selectedArtifact" class="graph-detail" :aria-label="`${selectedArtifact.id} 평가 Critic`">
        <header class="graph-detail-heading"><div><h2>{{ selectedArtifact.id }} <span>평가 Critic</span></h2><p>{{ selectedArtifact.path }} <span class="graph-separator">·</span> {{ selectedArtifact.type }}</p></div><span class="graph-detail-count">{{ selectedArtifact.total ? `${selectedArtifact.passed} / ${selectedArtifact.total} 통과` : '평가 Critic 없음' }}</span></header>
        <p v-if="!selectedCritics.length" class="graph-basis-note">이 Artifact를 평가하는 Critic이 등록되어 있지 않습니다.</p>
        <ul v-else class="graph-critic-list">
          <li v-for="critic in selectedCritics" :key="critic.id">
            <button type="button" class="graph-critic" :class="{ 'not-included': !critic.requestId, selected: critic.requestId && critic.requestId === selectedRequestId }" :disabled="!critic.requestId" @click="openCritic(critic)">
              <span class="graph-critic-main"><strong>{{ critic.title }}</strong><span>{{ kindLabels[critic.kind] }} <span class="graph-separator">·</span> 평가 {{ critic.target }} <span class="graph-separator">·</span> 참조 {{ critic.deps.length ? critic.deps.join(', ') : '없음' }}</span></span>
              <span class="graph-critic-status"><span class="card-status" :class="[critic.status?.toLowerCase() ?? 'unreviewed', { blocked: criticBlocked(critic) }]">{{ criticLabel(critic) }}</span><span v-if="critic.requestId" class="graph-open-label">요청 상세 <span aria-hidden="true">↗</span></span></span>
            </button>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>
