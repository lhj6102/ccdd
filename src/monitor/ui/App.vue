<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import type { MonitorDetail, MonitorLane, MonitorOverview, MonitorProject, MonitorRequest, MonitorSession } from '../types.js';
import { api, requestRoute } from './api';
import { dateLabel, elapsed, kindLabels, statusLabel } from './format';
import RequestDrawer from './RequestDrawer.vue';

const lanes: { id: MonitorLane; label: string; empty: string }[] = [
  { id: 'requested', label: '요청', empty: '대기 중인 요청이 없습니다.' },
  { id: 'running', label: '진행 중', empty: '진행 중인 리뷰가 없습니다.' },
  { id: 'success', label: '성공', empty: '통과한 리뷰가 여기에 모입니다.' },
  { id: 'failure', label: '실패', empty: '기준 미충족과 실행 오류를 확인합니다.' },
];
const projects = ref<MonitorProject[]>([]), project = ref(''), connected = ref(false), observedAt = ref('');
const initialLoading = ref(true), refreshing = ref(false), boardError = ref(''), now = ref(Date.now());
const rows = reactive<Record<MonitorLane, MonitorRequest[]>>({ requested: [], running: [], success: [], failure: [] });
const counts = reactive<Record<MonitorLane, number>>({ requested: 0, running: 0, success: 0, failure: 0 });
const pages = reactive<Record<MonitorLane, number>>({ requested: 1, running: 1, success: 1, failure: 1 });
const more = reactive<Record<MonitorLane, boolean>>({ requested: false, running: false, success: false, failure: false });
const selected = ref<{ projectId: string; id: string } | null>(null), detail = ref<MonitorDetail | null>(null), detailError = ref('');
const session = ref<MonitorSession | null>(null), sessionError = ref('');
const issues = computed(() => projects.value.filter(item => item.issue && (!project.value || item.id === project.value)));
const total = computed(() => Object.values(counts).reduce((sum, value) => sum + value, 0));
const projectName = (id: string): string => projects.value.find(item => item.id === id)?.name ?? '프로젝트';
let boardController: AbortController | undefined, detailController: AbortController | undefined;
let boardVersion = 0, detailVersion = 0, sessionLoading = false, detailLoading = false;
let pollTimer: ReturnType<typeof setInterval>, clockTimer: ReturnType<typeof setInterval>;
let lastFocus: HTMLElement | null = null;

async function loadSession(): Promise<void> {
  if (sessionLoading || session.value) return;
  sessionLoading = true;
  try { session.value = await api<MonitorSession>('/api/session'); sessionError.value = ''; }
  catch { sessionError.value = '검토 세션에 연결하지 못했습니다. 잠시 후 다시 연결합니다.'; }
  finally { sessionLoading = false; }
}
async function refreshBoard(force = false): Promise<void> {
  if (refreshing.value && !force) return;
  boardController?.abort(); boardController = new AbortController();
  const version = ++boardVersion, scope = project.value;
  refreshing.value = true;
  try {
    const jobs = lanes.flatMap(lane => Array.from({ length: pages[lane.id] }, (_, index) => {
      const query = new URLSearchParams({ lane: lane.id, limit: '50', offset: String(index * 50), ...(scope ? { project: scope } : {}) });
      return api<MonitorOverview>(`/api/requests?${query}`, { signal: boardController!.signal }).then(data => ({ lane: lane.id, index, data }));
    }));
    const results = await Promise.all(jobs);
    if (version !== boardVersion) return;
    projects.value = results[0].data.projects;
    for (const lane of lanes) {
      const loaded = results.filter(item => item.lane === lane.id).sort((a, b) => a.index - b.index);
      rows[lane.id] = [...new Map(loaded.flatMap(item => item.data.requests).map(request => [`${request.projectId}/${request.id}`, request])).values()];
      counts[lane.id] = loaded[0].data.total;
      more[lane.id] = loaded.at(-1)!.data.hasMore;
    }
    observedAt.value = results[0].data.observedAt; connected.value = true; boardError.value = ''; initialLoading.value = false;
  } catch {
    if (version !== boardVersion) return;
    connected.value = false; boardError.value = '연결을 확인하고 있습니다. 마지막으로 확인한 기록을 표시합니다.';
  } finally { if (version === boardVersion) refreshing.value = false; }
}
async function refreshDetail(force = false): Promise<void> {
  if (!selected.value || (detailLoading && !force)) return;
  detailController?.abort(); detailController = new AbortController();
  const version = ++detailVersion, choice = { ...selected.value };
  detailLoading = true;
  try {
    const value = await api<MonitorDetail>(requestRoute(choice.projectId, choice.id), { signal: detailController.signal });
    if (version !== detailVersion) return;
    detail.value = value; detailError.value = '';
  } catch {
    if (version === detailVersion) detailError.value = detail.value ? '요청을 갱신하지 못했습니다. 마지막으로 확인한 기록입니다.' : '요청을 불러오지 못했습니다. 다시 시도해 주세요.';
  } finally { if (version === detailVersion) detailLoading = false; }
}
function acceptDetail(value: MonitorDetail): void {
  if (selected.value?.id !== value.request.id || selected.value.projectId !== value.request.projectId) return;
  detailVersion++; detailController?.abort(); detailLoading = false; detail.value = value; detailError.value = '';
  void refreshBoard(true);
}
function openDetail(request: { projectId: string; id: string }, updateHistory = true): void {
  lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  selected.value = { projectId: request.projectId, id: request.id }; detail.value = null; detailError.value = '';
  if (updateHistory) history.replaceState(null, '', `#${encodeURIComponent(request.projectId)}/${encodeURIComponent(request.id)}`);
  void refreshDetail(true);
}
function closeDetail(updateHistory = true): void {
  selected.value = null; detail.value = null; detailVersion++; detailController?.abort(); detailLoading = false;
  if (updateHistory) history.replaceState(null, '', location.pathname + location.search);
  void nextTick(() => lastFocus?.isConnected && lastFocus.focus({ preventScroll: true }));
}
function changeProject(): void {
  closeDetail();
  for (const lane of lanes) { rows[lane.id] = []; counts[lane.id] = 0; pages[lane.id] = 1; more[lane.id] = false; }
  initialLoading.value = true; void refreshBoard(true);
}
function loadMore(lane: MonitorLane): void { pages[lane]++; void refreshBoard(true); }
function refresh(): void { void refreshBoard(); void refreshDetail(); void loadSession(); }
function renewSession(): void { session.value = null; void loadSession(); }
function readLocation(): void {
  const parts = location.hash.slice(1).split('/');
  try {
    if (parts.length === 2 && parts.every(Boolean)) openDetail({ projectId: decodeURIComponent(parts[0]), id: decodeURIComponent(parts[1]) }, false);
    else if (selected.value) closeDetail(false);
  } catch { closeDetail(false); }
}
function visible(): void { if (!document.hidden) refresh(); }
onMounted(() => {
  readLocation(); refresh();
  pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 2000);
  clockTimer = setInterval(() => { now.value = Date.now(); }, 1000);
  window.addEventListener('hashchange', readLocation); document.addEventListener('visibilitychange', visible);
});
onUnmounted(() => {
  clearInterval(pollTimer); clearInterval(clockTimer); boardController?.abort(); detailController?.abort();
  window.removeEventListener('hashchange', readLocation); document.removeEventListener('visibilitychange', visible);
});
</script>

<template>
  <header class="app-header">
    <a class="brand" href="/" aria-label="CCDD 리뷰 보드 홈"><span class="brand-mark" aria-hidden="true">c</span><strong>CCDD</strong><span class="brand-divider"></span><span>Monitor</span></a>
    <span class="connection" :class="{ connected }" role="status" :title="observedAt ? `마지막 확인 ${dateLabel(observedAt)}` : undefined"><i></i>{{ connected ? '실시간' : initialLoading ? '연결 중' : '다시 연결 중' }}</span>
  </header>
  <main class="board-main">
    <div class="page-heading">
      <div><p class="eyebrow">REVIEW REQUESTS</p><h1>리뷰 보드</h1><p class="page-caption">{{ project ? projectName(project) : '모든 프로젝트' }}<span v-if="!initialLoading"> · {{ total }}개 요청</span></p></div>
      <div class="board-controls">
        <label class="project-picker"><span>프로젝트</span><select v-model="project" @change="changeProject"><option value="">모든 프로젝트</option><option v-for="item in projects" :key="item.id" :value="item.id">{{ item.name }}{{ projects.filter(other => other.name === item.name).length > 1 ? ` · ${item.path}` : '' }}</option></select></label>
        <button class="icon-button refresh-button" aria-label="새로고침" :disabled="refreshing" @click="refresh"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16.3 8A6.5 6.5 0 1 0 16 13M16.5 3.5V8H12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg></button>
      </div>
    </div>
    <p v-if="boardError" class="inline-error" role="status">{{ boardError }}</p>
    <p v-for="issue in issues" :key="issue.id" class="inline-error" role="status">{{ issue.name }}: {{ issue.issue }}</p>
    <div v-if="!initialLoading && projects.length === 0" class="welcome-note"><strong>아직 접수된 프로젝트가 없습니다.</strong><p>새 리뷰가 접수되면 이곳에서 진행 상황을 볼 수 있습니다.</p></div>
    <div class="board" aria-label="리뷰 요청 보드" :aria-busy="refreshing && initialLoading">
      <section v-for="lane in lanes" :key="lane.id" class="board-lane" :class="lane.id" :aria-labelledby="`lane-${lane.id}`">
        <header class="lane-heading"><h2 :id="`lane-${lane.id}`"><i aria-hidden="true"></i>{{ lane.label }}</h2><span class="lane-count">{{ counts[lane.id] }}</span></header>
        <p v-if="initialLoading" class="lane-empty">불러오는 중…</p>
        <p v-else-if="!rows[lane.id].length" class="lane-empty">{{ lane.empty }}</p>
        <ul v-else class="card-list">
          <li v-for="request in rows[lane.id]" :key="`${request.projectId}/${request.id}`">
            <button class="request-card" :class="{ selected: selected?.id === request.id && selected.projectId === request.projectId }" :aria-label="`${request.title}, ${statusLabel(request)}`" @click="openDetail(request)">
              <span class="card-project">{{ projectName(request.projectId) }}</span><strong class="card-title">{{ request.title }}</strong>
              <span class="card-status" :class="[request.status.toLowerCase(), { blocked: request.blockedByFailure }]">{{ statusLabel(request) }}</span>
              <span v-if="request.workerState === 'missing' || request.workerState === 'unknown'" class="worker-note">{{ request.workerState === 'missing' ? '작업 프로세스 확인 필요' : '실행 여부 확인 중' }}</span>
              <span class="card-footer"><span>{{ kindLabels[request.kind] }}</span><span :title="`접수 ${dateLabel(request.createdAt)}`">{{ request.blockedByFailure ? '—' : elapsed(request.createdAt, request.completedAt, now) }}</span></span>
            </button>
          </li>
        </ul>
        <button v-if="more[lane.id]" class="text-button lane-more" :disabled="refreshing" @click="loadMore(lane.id)">이전 요청 더 보기 <span>{{ rows[lane.id].length }} / {{ counts[lane.id] }}</span></button>
      </section>
    </div>
  </main>
  <RequestDrawer v-if="selected" :key="`${selected.projectId}/${selected.id}`" :selection="selected" :detail="detail" :error="detailError" :session="session" :session-error="sessionError" :project-name="projectName(selected.projectId)" @close="closeDetail()" @refresh="refreshDetail(true)" @updated="acceptDetail" @session-expired="renewSession" />
</template>
