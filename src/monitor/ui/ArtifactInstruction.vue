<script setup lang="ts">
import { computed } from 'vue';
import { parseArtifactInstruction } from '../../artifacts/instruction.js';

const props = defineProps<{
  instruction: string;
  artifacts: readonly { id: string }[];
  references?: Record<string, string>;
  tools: readonly { artifactId: string }[];
  active: boolean;
}>();
const emit = defineEmits<{ artifact: [artifactId: string] }>();
const parts = computed(() => parseArtifactInstruction(props.instruction, props.artifacts, props.references));
const available = computed(() => new Set(props.tools.map(tool => tool.artifactId)));
</script>

<template>
  <p class="instruction"><template v-for="(part, index) in parts" :key="index"><template v-if="part.type === 'text'">{{ part.text }}</template><button v-else-if="active && available.has(part.artifactId)" type="button" class="instruction-artifact" :aria-label="`Show Human tools for ${part.artifactId}`" @click="emit('artifact', part.artifactId)">{{ part.artifactId }}</button><span v-else class="instruction-artifact static" :title="`${part.artifactId} Artifact${active ? ' · No Human tools available' : ''}`">{{ part.artifactId }}</span></template></p>
</template>
