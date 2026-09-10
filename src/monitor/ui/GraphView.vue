<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, useId, watch } from 'vue';
import { MarkerType, VueFlow } from '@vue-flow/core';
import type { Edge, Node, NodeMouseEvent, VueFlowStore } from '@vue-flow/core';
import { Background } from '@vue-flow/background';
import { Maximize, Minus, Plus } from '@lucide/vue';
import type { MonitorGraph } from '../types.js';
import { api } from './api';
import { kindLabels } from './format';
import { criticPresentation } from './critic-presentation';
import { layoutGraph, type GraphLayout } from './graph-layout';
import type { ArtifactEdgeData, ArtifactNodeData } from './graph-flow';
import ArtifactFlowNode from './ArtifactFlowNode.vue';
import GraphFlowEdge from './GraphFlowEdge.vue';

const props = defineProps<{ projectId: string; runId: string; selectedRequestId?: string }>();
const emit = defineEmits<{ 'open-request': [request: { projectId: string; id: string }] }>();
type Graph = NonNullable<MonitorGraph['graph']>;
type Artifact = Graph['artifacts'][number];
type Critic = Graph['critics'][number];
const data = ref<MonitorGraph | null>(null), loading = ref(false), error = ref(''), selectedArtifactId = ref(''), vertical = ref(false);
const drawing = shallowRef<GraphLayout | null>(null), layoutError = ref(''), layingOut = ref(false), layoutVertical = ref(false), layoutAttempt = ref(0);
const flow = shallowRef<VueFlowStore | null>(null);
const flowInstanceId = useId(), flowId = computed(() => `${flowInstanceId}-${props.projectId}-${props.runId}`);
let controller: AbortController | undefined, layoutController: AbortController | undefined;
let version = 0, layoutVersion = 0, fitPending = false, disposed = false, media: MediaQueryList | undefined;
const graph = computed(() => data.value?.available ? data.value.graph : null);
const artifacts = computed(() => new Map(graph.value?.artifacts.map(artifact => [artifact.id, artifact]) ?? []));
const requests = computed(() => new Map(data.value?.requests.map(request => [request.id, request]) ?? []));
const selectedArtifact = computed(() => artifacts.value.get(selectedArtifactId.value));
const selectedCritics = computed(() => graph.value?.critics.filter(critic => critic.target === selectedArtifactId.value) ?? []);
const selectedMembers = computed(() => selectedArtifact.value?.kind === 'group'
  ? selectedArtifact.value.members.flatMap(id => artifacts.value.get(id) ? [artifacts.value.get(id)!] : []) : []);
const containingGroups = computed(() => graph.value?.artifacts.filter(artifact => artifact.kind === 'group' && artifact.members.includes(selectedArtifactId.value)) ?? []);
const groupCount = computed(() => graph.value?.artifacts.filter(artifact => artifact.kind === 'group').length ?? 0);
const partial = computed(() => data.value?.run.scope?.kind === 'critic');
// Request state does not affect layout. Keeping this key stable preserves the user's viewport during polling.
const topologyKey = computed(() => graph.value ? JSON.stringify([
  props.projectId, props.runId, vertical.value,
  [...graph.value.artifacts].sort((a, b) => a.id.localeCompare(b.id)).map(artifact => [artifact.id, artifact.kind ?? 'artifact', [...artifact.criticIds].sort()]),
  [...graph.value.edges].sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)).map(edge => [edge.source, edge.target, [...edge.criticIds].sort()]),
]) : '');
const nodes = computed<Node<ArtifactNodeData>[]>(() => drawing.value?.nodes.flatMap(position => {
  const artifact = artifacts.value.get(position.id);
  if (!artifact || !graph.value) return [];
  return [{
    id: position.id, type: 'artifact', position: { x: position.x, y: position.y }, width: position.width, height: position.height,
    draggable: false, selectable: false, connectable: false, focusable: false, deletable: false,
    data: {
      artifact, critics: graph.value.critics.filter(critic => critic.target === artifact.id), requests: requests.value,
      statusLabel: artifactLabel(artifact), accessibleLabel: artifactAccessibleLabel(artifact),
      selected: selectedArtifactId.value === artifact.id, selectedRequestId: props.selectedRequestId, vertical: layoutVertical.value,
      hasInput: graph.value.edges.some(edge => edge.target === artifact.id), hasOutput: graph.value.edges.some(edge => edge.source === artifact.id),
    },
  }];
}) ?? []);
const edges = computed<Edge<ArtifactEdgeData>[]>(() => drawing.value?.edges.map(route => {
  const connected = route.source === selectedArtifactId.value || route.target === selectedArtifactId.value;
  return {
    id: JSON.stringify([route.source, route.target]), source: route.source, target: route.target,
    sourceHandle: 'source', targetHandle: 'target', type: 'artifact', selectable: false, focusable: false, deletable: false, updatable: false,
    markerEnd: { type: MarkerType.ArrowClosed, color: connected ? '#8da388' : '#bcc5b6', width: 12, height: 12 },
    data: { route, connected },
  };
}) ?? []);

function criticLabel(critic: Critic): string {
  return criticPresentation(critic, critic.requestId ? requests.value.get(critic.requestId) : undefined).label;
}
function artifactLabel(artifact: Artifact): string {
  if (artifact.validationStatus === 'STALE') return 'Needs revalidation';
  if (artifact.status === 'BLOCKED' && graph.value?.critics.some(critic => critic.target === artifact.id && criticBlocked(critic))) return 'Blocked by failure';
  return { BASIS: 'Basis Artifact', UNREVIEWED: 'Unreviewed', BLOCKED: 'Awaiting dependencies', QUEUED: 'Queued', RUNNING: 'Running', WAITING_HUMAN: 'Awaiting Human', GREEN: 'Passed', RED: 'Criteria not met', ERROR: 'Execution error' }[artifact.status];
}
function artifactAccessibleLabel(artifact: Artifact): string { return `${artifact.id}${artifact.kind === 'group' ? `, group, members: ${artifact.members.length}` : ''}, ${artifactLabel(artifact)}, ${artifact.total ? `Critics passed: ${artifact.passed}/${artifact.total}` : 'No Critics'}`; }
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
    if (requestVersion === version) error.value = data.value ? 'Unable to refresh the graph. Showing the last observed record.' : 'Unable to load the graph. Please try again shortly.';
  } finally { if (requestVersion === version) loading.value = false; }
}
function openCritic(critic: Critic): void {
  if (critic.requestId && data.value) {
    selectedArtifactId.value = critic.target;
    emit('open-request', { projectId: data.value.project.id, id: critic.requestId });
  }
}
function selectArtifactNode({ node }: NodeMouseEvent): void {
  if (artifacts.value.has(node.id)) selectedArtifactId.value = node.id;
}
function resize(): void { vertical.value = media?.matches ?? false; }
async function fitGraph(automatic = false): Promise<void> {
  const currentLayout = drawing.value, currentVersion = layoutVersion;
  await nextTick();
  if (disposed || currentVersion !== layoutVersion || !currentLayout || !flow.value || flow.value.id !== flowId.value) return;
  const instance = flow.value;
  if (automatic) {
    const { width, height } = instance.dimensions.value;
    if (!width || !height) return;
    const padding = 28, zoom = Math.max(0.8, Math.min(1, (width - padding * 2) / currentLayout.width, (height - padding * 2) / currentLayout.height));
    const selected = currentLayout.nodes.find(node => node.id === selectedArtifactId.value);
    const position = (viewport: number, extent: number, selectedCenter?: number): number => {
      if (extent * zoom <= viewport - padding * 2) return (viewport - extent * zoom) / 2;
      const centered = viewport / 2 - (selectedCenter ?? extent / 2) * zoom;
      return Math.min(padding, Math.max(viewport - padding - extent * zoom, centered));
    };
    fitPending = false;
    // Keep labels readable on first display; the explicit fit action can show the entire graph at a smaller scale.
    await instance.setViewport({
      x: position(width, currentLayout.width, selected ? selected.x + selected.width / 2 : undefined),
      y: position(height, currentLayout.height, selected ? selected.y + selected.height / 2 : undefined),
      zoom,
    }, { duration: 0 });
    return;
  }
  fitPending = false;
  // Include routed edges, since a long dependency can extend beyond the node bounds.
  await instance.fitBounds({ x: 0, y: 0, width: currentLayout.width, height: currentLayout.height }, { padding: '28px', duration: 0 });
}
function onPaneReady(instance: VueFlowStore): void {
  if (disposed || instance.id !== flowId.value || !drawing.value) return;
  flow.value = instance; if (fitPending) void fitGraph(true);
}
function zoom(direction: 1 | -1): void {
  const duration = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 160;
  if (direction === 1) void flow.value?.zoomIn({ duration });
  else void flow.value?.zoomOut({ duration });
}
watch([topologyKey, layoutAttempt], async ([key]) => {
  layoutController?.abort(); layoutController = new AbortController();
  const requestVersion = ++layoutVersion, value = graph.value, direction = vertical.value;
  layoutError.value = '';
  if (!key || !value) { drawing.value = null; flow.value = null; layingOut.value = false; return; }
  layingOut.value = true;
  try {
    const result = await layoutGraph(value, direction, layoutController.signal);
    if (disposed || requestVersion !== layoutVersion || key !== topologyKey.value) return;
    drawing.value = result; layoutVertical.value = direction; fitPending = true;
    void fitGraph(true);
  } catch (cause) {
    if (!disposed && requestVersion === layoutVersion) {
      console.warn('CCDD graph layout failed:', cause);
      drawing.value = null; flow.value = null; fitPending = false;
      layoutError.value = 'Unable to lay out the graph. Please try again.';
    }
  } finally { if (!disposed && requestVersion === layoutVersion) layingOut.value = false; }
});
watch(() => [props.projectId, props.runId], () => {
  controller?.abort(); layoutController?.abort(); version++; layoutVersion++; loading.value = false; data.value = null; error.value = ''; selectedArtifactId.value = '';
  drawing.value = null; layoutError.value = ''; fitPending = false; flow.value = null;
  void refresh(true);
}, { immediate: true });
watch(() => props.selectedRequestId, id => {
  const critic = graph.value?.critics.find(item => id && item.requestId === id);
  if (critic) selectedArtifactId.value = critic.target;
});
onMounted(() => { media = matchMedia('(max-width: 700px)'); resize(); media.addEventListener('change', resize); });
onUnmounted(() => { disposed = true; controller?.abort(); layoutController?.abort(); version++; layoutVersion++; media?.removeEventListener('change', resize); flow.value = null; });
defineExpose({ refresh });
</script>

<template>
  <section class="graph-view" aria-label="Artifact review graph" :aria-busy="(loading && !data) || (layingOut && !drawing)">
    <p v-if="error" class="inline-error" role="status">{{ error }}</p>
    <div v-if="!projectId || !runId" class="graph-placeholder"><strong>Select a Run.</strong><p>View Artifact relationships and Critic verdicts for a Run.</p></div>
    <p v-else-if="loading && !data" class="graph-placeholder">Loading Artifact relationships…</p>
    <div v-else-if="data && !data.available" class="graph-placeholder"><strong>The graph is unavailable for this Run.</strong><p>{{ data.unavailableReason || 'This historical Run has no stored Artifact targets or dependency relationships.' }}</p><p>Use Kanban to inspect individual requests and Artifacts.</p></div>
    <div v-else-if="layoutError" class="graph-placeholder"><p class="inline-error" role="status">{{ layoutError }}</p><button type="button" class="text-button" @click="layoutAttempt++">Retry layout</button></div>
    <p v-else-if="layingOut && !drawing" class="graph-placeholder">Laying out Artifact relationships…</p>
    <template v-else-if="graph && drawing">
      <header class="graph-context">
        <span>Artifacts: {{ graph.artifacts.length - groupCount }} <template v-if="groupCount"><span class="graph-separator">·</span> Groups: {{ groupCount }} </template><span class="graph-separator">·</span> Critics: {{ graph.critics.length }}</span>
        <span class="muted"><span v-if="partial" class="graph-partial">Selected Critic Run</span>snapshot <span :title="data?.run.snapshotHash ?? undefined">{{ data?.run.snapshotHash?.slice(0, 10) ?? 'Unavailable' }}</span></span>
      </header>
      <div class="graph-viewport" role="region" aria-label="Artifact graph. Drag to pan and use the zoom buttons to change the scale.">
        <VueFlow :id="flowId" :key="flowId" class="graph-flow" :nodes="nodes" :edges="edges" :nodes-draggable="false" :nodes-connectable="false" :elements-selectable="false" :nodes-focusable="false" :edges-focusable="false" :delete-key-code="null" :selection-key-code="false" :multi-selection-key-code="null" :disable-keyboard-a11y="true" :pan-on-drag="true" :pan-on-scroll="true" :zoom-on-scroll="false" :zoom-on-double-click="false" :zoom-on-pinch="true" :min-zoom="0.2" :max-zoom="1.8" @pane-ready="onPaneReady" @node-click="selectArtifactNode">
          <Background variant="dots" :gap="20" :size="1" color="#dce2d5" />
          <template #node-artifact="nodeProps"><ArtifactFlowNode :data="nodeProps.data" @select="selectedArtifactId = $event" @open-critic="openCritic" /></template>
          <template #edge-artifact="edgeProps"><GraphFlowEdge :id="edgeProps.id" :data="edgeProps.data" :marker-end="edgeProps.markerEnd" /></template>
        </VueFlow>
        <div class="graph-controls" aria-label="Graph view controls">
          <button type="button" title="Zoom in" aria-label="Zoom in on graph" @click="zoom(1)"><Plus aria-hidden="true" :size="16" :stroke-width="1.5" /></button>
          <button type="button" title="Zoom out" aria-label="Zoom out of graph" @click="zoom(-1)"><Minus aria-hidden="true" :size="16" :stroke-width="1.5" /></button>
          <span aria-hidden="true" />
          <button type="button" title="Fit view" aria-label="Fit entire graph" @click="fitGraph()"><Maximize aria-hidden="true" :size="15" :stroke-width="1.5" /></button>
        </div>
      </div>
      <div class="graph-legend"><span>Dependency Artifact <span aria-hidden="true">→</span><span class="sr-only">to</span> Review target</span><span class="graph-state-legend"><span class="requested">Requested</span><span class="running">In review</span><span class="success">Succeeded</span><span class="failure">Failed</span></span></div>
      <section v-if="selectedArtifact" class="graph-detail" :aria-label="`${selectedArtifact.id} Critics`">
        <header class="graph-detail-heading"><div><h2>{{ selectedArtifact.id }} <span>Critics</span></h2><p v-if="selectedArtifact.kind === 'group'">Artifact group <span class="graph-separator">·</span> Members: {{ selectedArtifact.members.length }}</p><p v-else>{{ selectedArtifact.path }} <span class="graph-separator">·</span> {{ selectedArtifact.type }}</p></div><span class="graph-detail-count">{{ selectedArtifact.total ? `${selectedArtifact.passed} / ${selectedArtifact.total} passed` : 'No Critics' }}</span></header>
        <div v-if="selectedMembers.length" class="graph-members" aria-label="Group members"><span>Members</span><button v-for="member in selectedMembers" :key="member.id" type="button" class="graph-member" @click="selectedArtifactId = member.id"><strong>{{ member.id }}</strong><span v-if="member.kind === 'group'">Group</span><span class="card-status" :class="member.status.toLowerCase()">{{ artifactLabel(member) }}</span></button><p>Verdicts for the group and its members are tracked independently.</p></div>
        <div v-if="containingGroups.length" class="graph-members graph-memberships" aria-label="Member of"><span>Member of</span><button v-for="group in containingGroups" :key="group.id" type="button" class="graph-member" @click="selectedArtifactId = group.id">{{ group.id }}</button></div>
        <p v-if="!selectedCritics.length" class="graph-basis-note">No Critics are registered to review this Artifact.</p>
        <ul v-else class="graph-critic-list">
          <li v-for="critic in selectedCritics" :key="critic.id">
            <button type="button" class="graph-critic" :class="{ 'not-included': !critic.requestId, selected: critic.requestId && critic.requestId === selectedRequestId }" :disabled="!critic.requestId" @click="openCritic(critic)">
              <span class="graph-critic-main"><strong>{{ critic.title }}</strong><span>{{ kindLabels[critic.kind] }} <span class="graph-separator">·</span> Target {{ critic.target }} <span class="graph-separator">·</span> Dependencies {{ critic.deps.length ? critic.deps.join(', ') : 'None' }}</span></span>
              <span class="graph-critic-status"><span class="card-status" :class="[critic.status?.toLowerCase() ?? 'unreviewed', { blocked: criticBlocked(critic) }]">{{ criticLabel(critic) }}</span><span v-if="critic.requestId" class="graph-open-label">Request details <span aria-hidden="true">↗</span></span></span>
            </button>
          </li>
        </ul>
      </section>
    </template>
  </section>
</template>
