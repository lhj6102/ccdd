<script setup lang="ts">
import { BaseEdge } from '@vue-flow/core';
import type { ArtifactEdgeData } from './graph-flow';

defineProps<{ id: string; data: ArtifactEdgeData; markerEnd?: string }>();
</script>

<template>
  <g class="graph-flow-edge" :class="{ connected: data.connected }">
    <title>{{ data.route.source }} → {{ data.route.target }} · Critic {{ data.route.criticIds.length }}개</title>
    <BaseEdge :id="id" :path="data.route.path" :marker-end="markerEnd" :interaction-width="0" />
    <g v-if="data.connected && data.route.criticIds.length > 1" class="graph-edge-count" aria-hidden="true">
      <rect :x="data.route.labelX - 11" :y="data.route.labelY - 9" width="22" height="18" rx="7" />
      <text :x="data.route.labelX" :y="data.route.labelY + 3">{{ data.route.criticIds.length }}</text>
    </g>
  </g>
</template>
