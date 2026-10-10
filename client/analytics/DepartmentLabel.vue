<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId } from 'vue'

const props = defineProps<{ name?: string | number | null; fullName?: string | number | null }>()
const tooltipId = useId()
const trigger = ref<HTMLElement>()
const tooltip = ref<HTMLElement>()
const visible = ref(false), focused = ref(false), hovered = ref(false), tooltipHovered = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | undefined
const position = ref({ left: '0px', top: '0px', maxWidth: '360px', maxHeight: '400px' })
const fullName = computed(() => String(props.fullName ?? '').trim())
async function show() {
  clearTimeout(hideTimer)
  const rect = trigger.value?.getBoundingClientRect()
  if (!fullName.value || !rect) return
  if (rect.bottom <= 0 || rect.top >= window.innerHeight || rect.right <= 0 || rect.left >= window.innerWidth) { visible.value = false; return }
  const width = Math.min(360, window.innerWidth - 24)
  position.value = { left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`, top: `${rect.bottom + 8}px`, maxWidth: `${width}px`, maxHeight: `${window.innerHeight - 24}px` }
  visible.value = true
  await nextTick()
  const height = tooltip.value?.getBoundingClientRect().height ?? 0
  const above = rect.top - height - 8
  position.value.top = `${above >= 12 ? above : Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - height - 12))}px`
}
function hide() {
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => { if (!focused.value && !hovered.value && !tooltipHovered.value) visible.value = false }, 120)
}
function dismiss() { clearTimeout(hideTimer); visible.value = false; tooltipHovered.value = false }
function keepOpen() { clearTimeout(hideTimer); tooltipHovered.value = true }
function scrollTooltip(event: KeyboardEvent) {
  const target = tooltip.value
  if (!visible.value || !target || event.altKey || event.ctrlKey || event.metaKey) return
  const steps: Record<string, number> = { ArrowDown: 40, ArrowUp: -40, PageDown: target.clientHeight * .8, PageUp: -target.clientHeight * .8 }
  if (event.key === 'Home') target.scrollTop = 0
  else if (event.key === 'End') target.scrollTop = target.scrollHeight
  else if (event.key in steps) target.scrollTop += steps[event.key]!
  else return
  event.preventDefault(); event.stopPropagation()
}
function reposition(event: Event) { if (visible.value && event.target !== tooltip.value) void show() }
onMounted(() => { window.addEventListener('scroll', reposition, true); window.addEventListener('resize', reposition) })
onBeforeUnmount(() => { clearTimeout(hideTimer); window.removeEventListener('scroll', reposition, true); window.removeEventListener('resize', reposition) })
</script>

<template>
  <span ref="trigger" class="department-label" :class="{ 'has-detail': fullName }" :tabindex="fullName ? 0 : undefined" :aria-describedby="visible ? tooltipId : undefined"
    :aria-description="fullName ? '完整部门显示后，可用方向键和翻页键滚动，按 Escape 关闭。' : undefined"
    @mouseenter="hovered=true;show()" @mouseleave="hovered=false;hide()" @focus="focused=true;show()" @blur="focused=false;hide()" @keydown="scrollTooltip" @keydown.esc.stop="dismiss">
    {{name || '—'}}
  </span>
  <Teleport to="body"><span v-if="visible" :id="tooltipId" ref="tooltip" role="tooltip" class="department-tooltip" :style="position" @mouseenter="keepOpen" @mouseleave="tooltipHovered=false;hide()">{{fullName}}</span></Teleport>
</template>

<style scoped>
.department-label{display:inline-block;max-width:220px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle;white-space:nowrap}.department-label.has-detail{cursor:help;border-bottom:1px dotted var(--text-tertiary)}.department-label:focus-visible{outline:2px solid var(--accent-primary);outline-offset:3px;border-radius:2px}.department-tooltip{position:fixed;z-index:1000;box-sizing:border-box;padding:9px 12px;border:1px solid var(--border-default);border-radius:6px;background:var(--bg-elevated,#fff);box-shadow:0 6px 22px #1e24351a;color:var(--text-primary,#252b3b);font-size:12px;line-height:1.6;overflow-wrap:anywhere;overflow:auto;overscroll-behavior:contain;pointer-events:auto}
</style>
