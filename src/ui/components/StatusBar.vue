<script setup lang="ts">
import { computed } from 'vue'
import { pointCount, renderInfo, selectTool, selectedCount } from '../editor'
import { currentProjectId, dirty, lastSavedAt, saving, storageMode } from '../projects'

const hint = computed(() => {
  const select = selectTool.value === 'lasso' ? '套索圈选' : '框选'
  return `滚轮缩放 · 中键/空格+左键平移 · 左键拖动空白${select} · Shift 加选`
})

defineProps<{ fps: number }>()

function savedText(ts: number | null): string {
  if (!ts) return '本次会话未保存'
  return `上次保存 ${new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })}`
}
</script>

<template>
  <footer class="status">
    <span>总点数：<b>{{ pointCount }}</b></span>
    <span>已选中：<b>{{ selectedCount }}</b></span>
    <span class="sep">|</span>
    <span>FPS：<b :class="{ low: fps > 0 && fps < 30 }">{{ fps ? fps.toFixed(0) : '—' }}</b></span>
    <span class="sep">|</span>
    <span>分辨率：<b>{{ renderInfo.resolution.toFixed(2) }}x</b></span>
    <span class="sep">|</span>
    <span>项目：{{ currentProjectId ? 'OPFS' : '未保存' }}</span>
    <span v-if="storageMode" class="mode">存储：{{ storageMode }}</span>
    <span class="state" :class="{ dirty }">
      {{ saving ? '保存中…' : dirty ? '有未保存修改' : savedText(lastSavedAt) }}
    </span>
    <span class="spacer" />
    <span class="hint">{{ hint }}</span>
  </footer>
</template>

<style scoped>
.status {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  background: var(--panel);
  border-top: 1px solid var(--border);
  font-size: 12px;
  color: var(--text-dim);
}
.status b {
  color: var(--text);
}
.low {
  color: var(--danger);
}
.sep {
  opacity: 0.4;
}
.state {
  color: var(--success);
}
.state.dirty {
  color: #f0b429;
}
.spacer {
  flex: 1;
}
.hint {
  opacity: 0.7;
}
</style>
