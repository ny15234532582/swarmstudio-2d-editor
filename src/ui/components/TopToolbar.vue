<script setup lang="ts">
/**
 * 顶部工具栏：编辑操作的集中入口。
 *
 * 大部分操作直接调用共享的 editor 单例；仅「适配视图」需要访问渲染器，
 * 通过 emit 上调给 App 处理，从而让本组件保持为纯 UI、不依赖 Pixi 与项目数据层。
 */
import { ref } from 'vue'
import {
  addPointAtViewCenter,
  canRedo,
  canUndo,
  droneCount,
  editor,
  pointRadius,
  redoLabel,
  selectedCount,
  setDroneCount,
  setPointRadius,
  undoLabel,
} from '../editor'
import { toast } from '../toast'

// 向上冒泡的交互意图（由 App 承接需要渲染器支持的操作）
const emit = defineEmits<{
  (e: 'fit'): void
}>()

// 取色器当前颜色，默认主题蓝；仅在选择点位后「应用」才有意义
const color = ref('#4ea1ff')

/** 无人机总数变更（写入项目参数） */
function onDroneCountChange(e: Event): void {
  const value = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(value) && value > 0) setDroneCount(value)
}

/** 点半径变更（世界单位/米） */
function onPointRadiusChange(e: Event): void {
  const value = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(value) && value > 0) setPointRadius(value)
}

/** 将取色器颜色应用到当前选中点；未选中时给出提示而非静默失败 */
function applyColor(): void {
  if (selectedCount.value === 0) {
    toast('请先选择点位再修改颜色', 'info')
    return
  }
  // #RRGGBB → 各通道分量
  const r = parseInt(color.value.slice(1, 3), 16)
  const g = parseInt(color.value.slice(3, 5), 16)
  const b = parseInt(color.value.slice(5, 7), 16)
  editor.setColorForSelection({ r, g, b })
}
</script>

<template>
  <header class="toolbar">
    <!-- 区域：新增 / 删除 -->
    <div class="group">
      <button class="primary" @click="addPointAtViewCenter">+ 新增点</button>
      <button :disabled="selectedCount === 0" @click="editor.deleteSelected()">删除选中</button>
    </div>

    <div class="divider" />

    <!-- 区域：分组与锁定 -->
    <div class="group">
      <button :disabled="selectedCount === 0" @click="editor.groupSelection()">成组</button>
      <button :disabled="selectedCount === 0" @click="editor.setLockedForSelection(true)">锁定选中</button>
      <button @click="editor.unlockAll()">解锁全部</button>
    </div>

    <div class="divider" />

    <!-- 区域：撤销 / 重做（tooltip 显示具体操作名） -->
    <div class="group">
      <button :disabled="!canUndo" :title="undoLabel ? `撤销：${undoLabel}` : '撤销'" @click="editor.undo()">
        ↶ 撤销
      </button>
      <button :disabled="!canRedo" :title="redoLabel ? `重做：${redoLabel}` : '重做'" @click="editor.redo()">
        ↷ 重做
      </button>
    </div>

    <div class="divider" />

    <!-- 区域：批量改色 -->
    <div class="group">
      <label class="label">颜色</label>
      <input v-model="color" type="color" />
      <button :disabled="selectedCount === 0" @click="applyColor">应用到选中</button>
    </div>

    <div class="divider" />

    <!-- 区域：视图适配 / 取消选择 -->
    <div class="group">
      <button @click="emit('fit')">适配视图</button>
      <button @click="editor.clearSelection()">取消选择</button>
    </div>

    <div class="spacer" />

    <!-- 区域：无人机总数 / 点半径（画质固定自动，不暴露给用户） -->
    <div class="group">
      <label class="label">无人机总数</label>
      <input
        class="num"
        type="number"
        min="1"
        step="1"
        :value="droneCount"
        @change="onDroneCountChange"
      />
      <label class="label">点半径(米)</label>
      <input
        class="num"
        type="number"
        min="0.05"
        step="0.1"
        :value="pointRadius"
        @change="onPointRadiusChange"
      />
    </div>
  </header>
</template>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.group {
  display: flex;
  align-items: center;
  gap: 6px;
}
.label {
  color: var(--text-dim);
  font-size: 13px;
}
.num {
  width: 76px;
}
.divider {
  width: 1px;
  height: 22px;
  background: var(--border);
}
.spacer {
  flex: 1;
}
</style>
