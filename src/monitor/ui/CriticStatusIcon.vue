<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, useId, watch } from 'vue';
import { Bot, Check, Circle, CircleAlert, Ellipsis, LockKeyhole, Minus, Terminal, UserRound, X } from '@lucide/vue';
import type { GraphCriticState } from '../../broker/graph.js';
import type { MonitorRequest } from '../types.js';
import { kindLabels } from './format';
import { criticPresentation } from './critic-presentation';

const props = defineProps<{ critic: GraphCriticState; request?: MonitorRequest; selected?: boolean }>();
const emit = defineEmits<{ open: [] }>();
const state = computed(() => criticPresentation(props.critic, props.request));
const kindIcon = computed(() => ({ agent: Bot, human: UserRound, runtime: Terminal })[props.critic.kind]);
const statusIcon = computed(() => ({ waiting: Circle, running: Ellipsis, success: Check, failure: X, error: CircleAlert, blocked: LockKeyhole, omitted: Minus })[state.value.mark]);
const tooltipId = `critic-tip-${useId()}`, shown = ref(false), anchor = ref<HTMLButtonElement>(), tooltip = ref<HTMLDivElement>();
const location = ref({ left: '0px', top: '0px' });
let revision = 0;
async function show(): Promise<void> {
  shown.value = true;
  const current = ++revision;
  await nextTick();
  if (!shown.value || current !== revision || !anchor.value || !tooltip.value) return;
  const rect = anchor.value.getBoundingClientRect(), bounds = tooltip.value.getBoundingClientRect();
  const left = Math.max(8, Math.min(rect.left + rect.width / 2 - bounds.width / 2, window.innerWidth - bounds.width - 8));
  const preferredTop = rect.top - bounds.height - 9;
  const top = preferredTop >= 8 ? preferredTop : Math.max(8, Math.min(rect.bottom + 9, window.innerHeight - bounds.height - 8));
  location.value = { left: `${left}px`, top: `${top}px` };
}
function hide(): void { shown.value = false; revision++; }
function open(): void { if (state.value.actionable) { hide(); emit('open'); } else void show(); }
function leave(): void { if (document.activeElement !== anchor.value) hide(); }
function blur(): void { hide(); }
function outsideKey(event: KeyboardEvent): void { if (event.key === 'Escape') hide(); }
function outsidePointer(event: PointerEvent): void { if (event.target instanceof Node && !anchor.value?.contains(event.target)) hide(); }
function removeListeners(): void {
  window.removeEventListener('resize', hide); window.removeEventListener('scroll', hide, true); window.removeEventListener('wheel', hide, true); window.removeEventListener('keydown', outsideKey); window.removeEventListener('pointerdown', outsidePointer, true);
}
watch(shown, value => {
  removeListeners();
  if (value) { window.addEventListener('resize', hide); window.addEventListener('scroll', hide, true); window.addEventListener('wheel', hide, true); window.addEventListener('keydown', outsideKey); window.addEventListener('pointerdown', outsidePointer, true); }
});
watch(() => state.value.accessibleLabel, () => { if (shown.value) void show(); });
onUnmounted(() => { revision++; removeListeners(); });
</script>

<template>
  <button ref="anchor" type="button" class="critic-status-icon nodrag nopan" :class="[state.tone, { selected }]" :data-critic-id="critic.id" :data-state="state.tone" :aria-label="state.accessibleLabel" :aria-disabled="!state.actionable" :aria-pressed="Boolean(selected)" :aria-describedby="shown ? tooltipId : undefined" @pointerenter="show" @pointerleave="leave" @focus="show" @blur="blur" @click.stop="open">
    <component :is="kindIcon" class="critic-kind-icon" :size="20" :stroke-width="1.6" aria-hidden="true" />
    <component :is="statusIcon" class="critic-status-mark" :size="9" :stroke-width="1.9" aria-hidden="true" />
  </button>
  <Teleport to="body">
    <div v-if="shown" :id="tooltipId" ref="tooltip" role="tooltip" class="critic-icon-tooltip" :style="location"><strong>{{ critic.title }}</strong><span>{{ kindLabels[critic.kind] }} · {{ state.label }}</span></div>
  </Teleport>
</template>

<style scoped>
.critic-status-icon{position:relative;display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;flex:0 0 30px;padding:5px;border:1px solid transparent;border-radius:7px;vertical-align:middle;--critic-color:#7a8376;color:var(--critic-color);transition:background .15s,border-color .15s}
.critic-status-icon.running{--critic-color:#4e7ca1}.critic-status-icon.success{--critic-color:#4b7553}.critic-status-icon.failure{--critic-color:#a25d51}.critic-status-icon.omitted{--critic-color:#9bA391;border:1px dashed #d3dacb;cursor:default}
.critic-status-icon:hover,.critic-status-icon.selected{background:color-mix(in srgb,var(--critic-color) 8%,white);border-color:color-mix(in srgb,var(--critic-color) 30%,white)}
.critic-status-icon:focus-visible{outline:2px solid #6e9167;outline-offset:3px}
.critic-kind-icon{width:20px;height:20px;flex:none}.critic-status-mark{position:absolute;bottom:-2px;right:-2px;width:10px;height:10px;background:#fff;border-radius:3px;box-shadow:0 0 0 1px #fff;flex:none}
.critic-icon-tooltip{position:fixed;z-index:2000;display:grid;gap:4px;max-width:min(270px,calc(100vw - 16px));padding:10px 12px;border:1px solid #dfe5d7;border-radius:8px;background:#fff;color:#4f6242;box-shadow:0 4px 18px #263c1817;pointer-events:none;font-size:11px;line-height:1.6;overflow-wrap:anywhere}
.critic-icon-tooltip strong{font-weight:500}.critic-icon-tooltip span{color:#7c8b70;font-size:10px}
@media(prefers-reduced-motion:reduce){.critic-status-icon{transition:none}}
</style>
