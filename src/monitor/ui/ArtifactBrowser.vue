<script setup lang="ts">
import type { ArtifactReferenceMetadata } from '../../artifacts/index.js';
defineProps<{ projectId: string; requestId: string; artifacts: ArtifactReferenceMetadata[]; preview?: 'tools'; humanReview?: boolean }>();
const emit = defineEmits<{ review: [] }>();
</script>

<template>
  <div class="artifact-browser">
    <p v-if="!artifacts.length" class="muted">No Artifacts were provided.</p>
    <ul v-else class="artifact-references"><li v-for="item in artifacts" :key="item.id"><strong>{{ item.id }}</strong><span>{{ item.path || '.' }}</span></li></ul>
    <p class="artifact-message">Inspect these folders with their Artifact-owned review tools.</p>
    <button v-if="humanReview && preview === 'tools'" class="secondary-button" @click="emit('review')">Go to review tools</button>
  </div>
</template>
