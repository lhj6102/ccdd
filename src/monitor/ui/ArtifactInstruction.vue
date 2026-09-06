<script setup lang="ts">
import { computed } from 'vue';
import type { ArtifactGroupReference } from '../../contracts.js';
import { artifactInstructionMembers, parseArtifactInstruction } from '../../artifacts/instruction.js';

const props = defineProps<{
  instruction: string;
  artifacts: readonly { id: string }[];
  artifactGroups?: readonly ArtifactGroupReference[];
  tools: readonly { artifactId: string }[];
  active: boolean;
}>();
const emit = defineEmits<{ artifact: [artifactId: string] }>();
const parts = computed(() => parseArtifactInstruction(props.instruction, props.artifacts, props.artifactGroups));
const available = computed(() => {
  const toolArtifacts = new Set(props.tools.map(tool => tool.artifactId));
  return new Set([...props.artifacts, ...props.artifactGroups ?? []].filter(item =>
    artifactInstructionMembers(item.id, props.artifacts, props.artifactGroups).some(id => toolArtifacts.has(id))).map(item => item.id));
});
</script>

<template>
  <p class="instruction"><template v-for="(part, index) in parts" :key="index"><template v-if="part.type === 'text'">{{ part.text }}</template><button v-else-if="active && available.has(part.artifactId)" type="button" class="instruction-artifact" :aria-label="`${part.artifactId}의 Human 도구 보기`" @click="emit('artifact', part.artifactId)">{{ part.artifactId }}</button><span v-else class="instruction-artifact static" :title="`${part.artifactId} Artifact${active ? ' · 제공된 Human 도구 없음' : ''}`">{{ part.artifactId }}</span></template></p>
</template>
