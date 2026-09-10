<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, reactive, ref } from 'vue';
import type { MonitorDetail, MonitorLane, MonitorOverview, MonitorProject, MonitorRequest, MonitorRun, MonitorRunOverview, MonitorSession } from '../types.js';
import { api, requestRoute } from './api';
import { dateLabel, elapsed, kindLabels, statusLabel } from './format';
import RequestDrawer from './RequestDrawer.vue';
const GraphView = defineAsyncComponent(() => import('./GraphView.vue'));
const ValidationView = defineAsyncComponent(() => import('./ValidationView.vue'));

const lanes: { id: MonitorLane; label: string; empty: string }[] = [
  { id: 'requested', label: 'Requested', empty: 'No requests are waiting.' },
  { id: 'running', label: 'In progress', empty: 'No reviews are in progress.' },
  { id: 'success', label: 'Succeeded', empty: 'Passed reviews appear here.' },
  { id: 'failure', label: 'Failed', empty: 'Review unmet criteria and execution errors here.' },
];
const projects = ref<MonitorProject[]>([]), project = ref(''), connected = ref(false), observedAt = ref('');
type View = 'kanban' | 'graph' | 'validation';
function savedView(): View { try { const value = localStorage.getItem('ccdd.monitor.view'); return value === 'graph' || value === 'kanban' ? value : 'validation'; } catch { return 'validation'; } }
const view = ref<View>(savedView()), run = ref(''), runs = ref<MonitorRun[]>([]), runsLoading = ref(false), runsError = ref(''), runsMore = ref(false);
const graphView = ref<InstanceType<typeof GraphView> | null>(null);
const initialLoading = ref(true), refreshing = ref(false), boardError = ref(''), now = ref(Date.now());
const rows = reactive<Record<MonitorLane, MonitorRequest[]>>({ requested: [], running: [], success: [], failure: [] });
const counts = reactive<Record<MonitorLane, number>>({ requested: 0, running: 0, success: 0, failure: 0 });
const pages = reactive<Record<MonitorLane, number>>({ requested: 1, running: 1, success: 1, failure: 1 });
const more = reactive<Record<MonitorLane, boolean>>({ requested: false, running: false, success: false, failure: false });
const selected = ref<{ projectId: string; id: string } | null>(null), detail = ref<MonitorDetail | null>(null), detailError = ref('');
const session = ref<MonitorSession | null>(null), sessionError = ref('');
const issues = computed(() => projects.value.filter(item => item.issue && (!project.value || item.id === project.value)));
const total = computed(() => Object.values(counts).reduce((sum, value) => sum + value, 0));
const projectName = (id: string): string => projects.value.find(item => item.id === id)?.name ?? 'Project';
let boardController: AbortController | undefined, detailController: AbortController | undefined, runsController: AbortController | undefined;
let boardVersion = 0, detailVersion = 0, runsVersion = 0, runPages = 1, sessionLoading = false, detailLoading = false;
let pollTimer: ReturnType<typeof setInterval>, clockTimer: ReturnType<typeof setInterval>;
let lastFocus: HTMLElement | null = null;

async function loadSession(): Promise<void> {
  if (sessionLoading || session.value) return;
  sessionLoading = true;
  try { session.value = await api<MonitorSession>('/api/session'); sessionError.value = ''; }
  catch { sessionError.value = 'Unable to connect to the review session. Retrying shortly.'; }
  finally { sessionLoading = false; }
}
async function refreshBoard(force = false): Promise<void> {
  if (refreshing.value && !force) return;
  boardController?.abort(); boardController = new AbortController();
  const version = ++boardVersion, scope = project.value;
  const runScope = run.value;
  refreshing.value = true;
  try {
    const jobs = lanes.flatMap(lane => Array.from({ length: pages[lane.id] }, (_, index) => {
      const query = new URLSearchParams({ lane: lane.id, limit: '50', offset: String(index * 50), ...(scope ? { project: scope, ...(runScope ? { run: runScope } : {}) } : {}) });
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
    ensureGraphScope();
  } catch {
    if (version !== boardVersion) return;
    connected.value = false; boardError.value = 'Checking the connection. Showing the last observed records.';
  } finally { if (version === boardVersion) refreshing.value = false; }
}
async function refreshRuns(force = false): Promise<void> {
  if (!project.value || (runsLoading.value && !force)) return;
  runsController?.abort(); runsController = new AbortController();
  const version = ++runsVersion, scope = project.value;
  runsLoading.value = true;
  try {
    const results = await Promise.all(Array.from({ length: runPages }, (_, index) => {
      const query = new URLSearchParams({ project: scope, limit: '50', offset: String(index * 50) });
      return api<MonitorRunOverview>(`/api/runs?${query}`, { signal: runsController!.signal });
    }));
    if (version !== runsVersion) return;
    runs.value = [...new Map(results.flatMap(result => result.runs).map(item => [item.id, item])).values()];
    runsMore.value = results.at(-1)!.hasMore; runsError.value = '';
    if (view.value === 'graph' && !run.value && runs.value.length) {
      run.value = detail.value?.request.projectId === scope ? detail.value.request.runId : runs.value[0].id;
      resetBoard(); void refreshBoard(true);
    }
  } catch {
    if (version === runsVersion) runsError.value = 'Unable to refresh Runs. The selected Run is still shown.';
  } finally { if (version === runsVersion) runsLoading.value = false; }
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
    if (version === detailVersion) detailError.value = detail.value ? 'Unable to refresh the request. Showing the last observed record.' : 'Unable to load the request. Please try again.';
  } finally { if (version === detailVersion) detailLoading = false; }
}
function acceptDetail(value: MonitorDetail): void {
  if (selected.value?.id !== value.request.id || selected.value.projectId !== value.request.projectId) return;
  detailVersion++; detailController?.abort(); detailLoading = false; detail.value = value; detailError.value = '';
  void refreshBoard(true); void refreshRuns(true); void graphView.value?.refresh(true);
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
function resetBoard(): void {
  for (const lane of lanes) { rows[lane.id] = []; counts[lane.id] = 0; pages[lane.id] = 1; more[lane.id] = false; }
  initialLoading.value = true;
}
function resetRuns(): void {
  runsController?.abort(); runsVersion++; runsLoading.value = false; runs.value = []; runsMore.value = false; runsError.value = ''; runPages = 1;
}
function changeProject(): void {
  closeDetail(); run.value = ''; resetRuns(); resetBoard();
  void refreshBoard(true); void refreshRuns(true);
}
function changeRun(): void { closeDetail(); resetBoard(); void refreshBoard(true); }
function ensureGraphScope(): void {
  if (view.value === 'kanban') return;
  if (!project.value && projects.value.length) {
    project.value = selected.value?.projectId ?? projects.value.find(item => !item.issue)?.id ?? projects.value[0].id;
    resetRuns(); resetBoard(); void refreshBoard(true); void refreshRuns(true);
  } else if (view.value === 'graph' && project.value && !run.value && runs.value.length) {
    run.value = detail.value?.request.projectId === project.value ? detail.value.request.runId : runs.value[0].id;
    resetBoard(); void refreshBoard(true);
  }
}
function changeView(next: View): void {
  view.value = next;
  try { localStorage.setItem('ccdd.monitor.view', next); } catch {}
  ensureGraphScope();
  if (next === 'graph') { void refreshRuns(); void nextTick(() => graphView.value?.refresh()); }
}
function loadMore(lane: MonitorLane): void { pages[lane]++; void refreshBoard(true); }
function loadMoreRuns(): void { runPages++; void refreshRuns(true); }
function refresh(): void { void refreshBoard(); void refreshDetail(); void refreshRuns(); void loadSession(); if (view.value === 'graph') void graphView.value?.refresh(); }
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
  clearInterval(pollTimer); clearInterval(clockTimer); boardController?.abort(); detailController?.abort(); runsController?.abort();
  window.removeEventListener('hashchange', readLocation); document.removeEventListener('visibilitychange', visible);
});
</script>

<template>
  <header class="app-header">
    <a class="brand" href="/" aria-label="CCDD review board home"><span class="brand-mark" aria-hidden="true">c</span><strong>CCDD</strong><span class="brand-divider"></span><span>Monitor</span></a>
    <span class="connection" :class="{ connected }" role="status" :title="observedAt ? `Last checked ${dateLabel(observedAt)}` : undefined"><i></i>{{ connected ? 'Live' : initialLoading ? 'Connecting' : 'Reconnecting' }}</span>
  </header>
  <main class="board-main">
    <div class="page-heading">
      <div><p class="eyebrow">REVIEW REQUESTS</p><h1>Review board</h1><p class="page-caption">{{ project ? projectName(project) : 'All projects' }}<span v-if="!initialLoading"> · {{ total }} {{ total === 1 ? 'request' : 'requests' }}</span></p></div>
      <div class="board-controls">
        <label class="project-picker"><span>Project</span><select v-model="project" @change="changeProject"><option value="">All projects</option><option v-for="item in projects" :key="item.id" :value="item.id">{{ item.name }}{{ projects.filter(other => other.name === item.name).length > 1 ? ` · ${item.path}` : '' }}</option></select></label>
        <label v-if="project && view !== 'validation'" class="project-picker run-picker"><span>Run</span><select v-model="run" @change="changeRun"><option value="" :disabled="view === 'graph'">{{ runsLoading && !runs.length ? 'Loading…' : !runs.length ? 'No saved Runs' : 'All Runs' }}</option><option v-if="run && !runs.some(item => item.id === run)" :value="run">Selected Run · {{ run.slice(0, 8) }}</option><option v-for="item in runs" :key="item.id" :value="item.id">{{ dateLabel(item.createdAt) }} · {{ item.id.slice(0, 8) }}{{ item.scope?.kind === 'critic' ? ' · Selected Critic' : '' }}</option></select></label>
        <button class="icon-button refresh-button" aria-label="Refresh" :disabled="refreshing" @click="refresh"><svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M16.3 8A6.5 6.5 0 1 0 16 13M16.5 3.5V8H12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg></button>
      </div>
    </div>
    <div class="view-toolbar"><div class="view-switch" role="group" aria-label="Monitor view"><button type="button" :aria-pressed="view === 'validation'" @click="changeView('validation')">Current input</button><button type="button" :aria-pressed="view === 'kanban'" @click="changeView('kanban')"><svg viewBox="0 0 18 18" aria-hidden="true" fill="none"><rect x="2.5" y="3" width="5" height="12" rx="1" /><rect x="10.5" y="3" width="5" height="8" rx="1" /></svg>Kanban</button><button type="button" :aria-pressed="view === 'graph'" @click="changeView('graph')"><svg viewBox="0 0 18 18" aria-hidden="true" fill="none"><rect x="1.5" y="6" width="5" height="6" rx="1" /><rect x="11.5" y="1.5" width="5" height="5" rx="1" /><rect x="11.5" y="11.5" width="5" height="5" rx="1" /><path d="M6.5 9h2.5V4h2.5M9 9v5h2.5" /></svg>Graph</button></div><button v-if="project && runsMore" type="button" class="text-button" :disabled="runsLoading" @click="loadMoreRuns">Load earlier Runs</button></div>
    <p v-if="boardError" class="inline-error" role="status">{{ boardError }}</p>
    <p v-if="runsError" class="inline-error" role="status">{{ runsError }}</p>
    <p v-for="issue in issues" :key="issue.id" class="inline-error" role="status">{{ issue.name }}: {{ issue.issue }}</p>
    <div v-if="!initialLoading && projects.length === 0" class="welcome-note"><strong>No projects have been submitted yet.</strong><p>Progress will appear here when a review is submitted.</p></div>
    <div v-show="view === 'kanban'" class="board" aria-label="Review request board" :aria-busy="refreshing && initialLoading">
      <section v-for="lane in lanes" :key="lane.id" class="board-lane" :class="lane.id" :aria-labelledby="`lane-${lane.id}`">
        <header class="lane-heading"><h2 :id="`lane-${lane.id}`"><i aria-hidden="true"></i>{{ lane.label }}</h2><span class="lane-count">{{ counts[lane.id] }}</span></header>
        <p v-if="initialLoading" class="lane-empty">Loading…</p>
        <p v-else-if="!rows[lane.id].length" class="lane-empty">{{ lane.empty }}</p>
        <ul v-else class="card-list">
          <li v-for="request in rows[lane.id]" :key="`${request.projectId}/${request.id}`">
            <button class="request-card" :class="{ selected: selected?.id === request.id && selected.projectId === request.projectId }" :aria-label="`${request.title}, ${statusLabel(request)}`" @click="openDetail(request)">
              <span class="card-project">{{ projectName(request.projectId) }}</span><strong class="card-title">{{ request.title }}</strong>
              <span class="card-status" :class="[request.status.toLowerCase(), { blocked: request.blockedByFailure }]">{{ statusLabel(request) }}</span>
              <span v-if="request.workerState === 'missing' || request.workerState === 'unknown'" class="worker-note">{{ request.workerState === 'missing' ? 'Worker needs attention' : 'Checking worker status' }}</span>
              <span class="card-footer"><span>{{ kindLabels[request.kind] }}</span><span :title="`Submitted ${dateLabel(request.createdAt)}`">{{ request.blockedByFailure ? '—' : elapsed(request.createdAt, request.completedAt, now) }}</span></span>
            </button>
          </li>
        </ul>
        <button v-if="more[lane.id]" class="text-button lane-more" :disabled="refreshing" @click="loadMore(lane.id)">Load earlier requests <span>{{ rows[lane.id].length }} / {{ counts[lane.id] }}</span></button>
      </section>
    </div>
    <ValidationView v-if="view === 'validation'" :project-id="project" :session="session" @open-request="openDetail" @session-expired="renewSession" />
    <GraphView v-if="view === 'graph'" ref="graphView" :project-id="project" :run-id="run" :selected-request-id="selected?.projectId === project ? selected.id : undefined" @open-request="openDetail" />
  </main>
  <RequestDrawer v-if="selected" :key="`${selected.projectId}/${selected.id}`" :selection="selected" :detail="detail" :error="detailError" :session="session" :session-error="sessionError" :project-name="projectName(selected.projectId)" @close="closeDetail()" @refresh="refreshDetail(true)" @updated="acceptDetail" @session-expired="renewSession" />
</template>
