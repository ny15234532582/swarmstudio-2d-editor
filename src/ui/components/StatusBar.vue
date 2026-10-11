<script setup lang="ts">
/**
 * 底部状态栏：只读汇总信息展示。
 *
 * 数据全部来自响应式的 ui/editor 与 ui/projects 桥接层，组件本身无状态、
 * 不发事件；FPS 由父组件 App 透传（它来自渲染器 ticker）。
 */
import { activePointCount, droneCount, pointCount, renderInfo, selectedCount } from '../editor'
import { currentProjectId, dirty, lastSavedAt, saving, storageMode } from '../projects'

// 交互方式提示文案（静态，放在此处便于统一维护）
const hint =
  '滚轮缩放 · 中键/空格+左键平移 · 左键拖动移动点位 · 空白拖拽框选 · Alt/Option+拖拽套索 · Shift 加选'

// 父组件传入的实时帧率
defineProps<{ fps: number }>()

/** 把保存时间戳格式化为可读文本；null 表示本次会话尚未保存过 */
function savedText(ts: number | null): string {
  if (!ts) return '本次会话未保存'
  return `上次保存 ${new Date(ts).toLocaleTimeString('zh-CN', { hour12: false })}`
}
</script>

<template>
  <footer class="status">
    <!-- 区域：计数与性能指标 -->
    <span>当前帧点数：<b>{{ activePointCount }}</b> / {{ droneCount }}</span>
    <span>总点数：<b>{{ pointCount }}</b></span>
    <span>已选中：<b>{{ selectedCount }}</b></span>
    <span class="sep">|</span>
    <span>FPS：<b :class="{ low: fps > 0 && fps < 30 }">{{ fps ? fps.toFixed(0) : '—' }}</b></span>
    <span class="sep">|</span>
    <span>分辨率：<b>{{ renderInfo.resolution.toFixed(2) }}x</b></span>
    <span class="sep">|</span>
    <!-- 区域：项目存储标识 -->
    <span>项目：{{ currentProjectId ? 'OPFS' : '未保存' }}</span>
    <span v-if="storageMode" class="mode">存储：{{ storageMode }}</span>
    <!-- 区域：保存状态（保存中 > 有未保存修改 > 上次保存时间） -->
    <span class="state" :class="{ dirty }">
      {{ saving ? '保存中…' : dirty ? '有未保存修改' : savedText(lastSavedAt) }}
    </span>
    <span class="spacer" />
    <!-- 区域：操作提示 -->
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
