<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core';
import { Layers } from '@lucide/vue';
import type { GraphCriticState } from '../../broker/graph.js';
import type { ArtifactNodeData } from './graph-flow';
import CriticStatusIcon from './CriticStatusIcon.vue';

defineProps<{ data: ArtifactNodeData }>();
const emit = defineEmits<{ select: [id: string]; 'open-critic': [critic: GraphCriticState] }>();
</script>

<template>
  <article class="graph-artifact" :class="{ selected: data.selected, 'graph-artifact-group': data.artifact.kind === 'group' }">
    <Handle id="target" type="target" :position="data.vertical ? Position.Top : Position.Left" :connectable="false" :class="{ 'graph-port-hidden': !data.hasInput }" />
    <button type="button" class="graph-artifact-heading nodrag nopan" :aria-pressed="data.selected" :aria-label="data.accessibleLabel" @click="emit('select', data.artifact.id)">
      <span v-if="data.artifact.kind === 'group'" class="graph-group-label"><Layers :size="12" :stroke-width="1.5" aria-hidden="true" />그룹 · {{ data.artifact.members.length }}개</span>
      <strong class="graph-artifact-name" :title="data.artifact.id">{{ data.artifact.id }}</strong>
      <span class="card-status" :class="data.artifact.status.toLowerCase()">{{ data.statusLabel }}</span>
    </button>
    <div v-if="data.critics.length" class="graph-node-critics nodrag nopan" :aria-label="`${data.artifact.id} 평가 Critic`">
      <CriticStatusIcon v-for="critic in data.critics" :key="critic.id" :critic="critic" :request="critic.requestId ? data.requests.get(critic.requestId) : undefined" :selected="Boolean(critic.requestId && critic.requestId === data.selectedRequestId)" @open="emit('open-critic', critic)" />
    </div>
    <span v-else class="graph-node-basis">{{ data.artifact.basis ? '평가의 출발점' : '등록된 Critic 없음' }}</span>
    <Handle id="source" type="source" :position="data.vertical ? Position.Bottom : Position.Right" :connectable="false" :class="{ 'graph-port-hidden': !data.hasOutput }" />
  </article>
</template>
