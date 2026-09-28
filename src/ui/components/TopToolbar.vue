<script setup lang="ts">
import { ref } from 'vue'
import {
  addPointAtViewCenter,
  canRedo,
  canUndo,
  editor,
  redoLabel,
  renderQuality,
  selectTool,
  selectedCount,
  setRenderQuality,
  setSelectTool,
  undoLabel,
} from '../editor'
import type { RenderQuality } from '../../render/renderer'
import type { SelectTool } from '../../render/interaction'
import { toast } from '../toast'

const emit = defineEmits<{
  (e: 'fit'): void
  (e: 'generate', count: number): void
  (e: 'import-image'): void
}>()

const color = ref('#4ea1ff')

function onQualityChange(e: Event): void {
  setRenderQuality((e.target as HTMLSelectElement).value as RenderQuality)
}

function onToolChange(e: Event): void {
  setSelectTool((e.target as HTMLSelectElement).value as SelectTool)
}

function applyColor(): void {
  if (selectedCount.value === 0) {
    toast('请先选择点位再修改颜色', 'info')
    return
  }
  const r = parseInt(color.value.slice(1, 3), 16)
  const g = parseInt(color.value.slice(3, 5), 16)
  const b = parseInt(color.value.slice(5, 7), 16)
  editor.setColorForSelection({ r, g, b })
}
</script>

<template>
  <header class="toolbar">
    <div class="group">
      <button class="primary" @click="addPointAtViewCenter">+ 新增点</button>
      <button :disabled="selectedCount === 0" @click="editor.deleteSelected()">删除选中</button>
    </div>

    <div class="divider" />

    <div class="group">
      <button :disabled="!canUndo" :title="undoLabel ? `撤销：${undoLabel}` : '撤销'" @click="editor.undo()">
        ↶ 撤销
      </button>
      <button :disabled="!canRedo" :title="redoLabel ? `重做：${redoLabel}` : '重做'" @click="editor.redo()">
        ↷ 重做
      </button>
    </div>

    <div class="divider" />

    <div class="group">
      <label class="label">颜色</label>
      <input v-model="color" type="color" />
      <button :disabled="selectedCount === 0" @click="applyColor">应用到选中</button>
    </div>

    <div class="divider" />

    <div class="group">
      <label class="label">选择</label>
      <select :value="selectTool" @change="onToolChange">
        <option value="box">框选</option>
        <option value="lasso">套索</option>
      </select>
      <button @click="emit('fit')">适配视图</button>
      <button @click="editor.clearSelection()">取消选择</button>
    </div>

    <div class="spacer" />

    <div class="group">
      <label class="label">画质</label>
      <select :value="renderQuality" @change="onQualityChange">
        <option value="auto">自动（动态分辨率）</option>
        <option value="high">高</option>
        <option value="balanced">均衡</option>
        <option value="fast">流畅</option>
      </select>
      <button @click="emit('generate', 20000)">生成 20,000 点测试数据</button>
      <button @click="emit('import-image')">导入图片生成点位</button>
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
.divider {
  width: 1px;
  height: 22px;
  background: var(--border);
}
.spacer {
  flex: 1;
}
</style>
