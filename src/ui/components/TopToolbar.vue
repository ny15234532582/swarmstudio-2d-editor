<script setup lang="ts">
/**
 * 顶部工具栏：编辑操作的集中入口。
 *
 * 大部分操作直接调用共享的 editor 单例；仅「适配视图 / 生成测试数据 /
 * 导入图片」这三个需要访问渲染器或弹窗的能力，通过 emit 上调给 App 处理，
 * 从而让本组件保持为纯 UI、不依赖 Pixi 与项目数据层。
 */
import { ref } from 'vue'
import {
  addPointAtViewCenter,
  canRedo,
  canUndo,
  editor,
  redoLabel,
  renderQuality,
  selectedCount,
  setRenderQuality,
  undoLabel,
} from '../editor'
import type { RenderQuality } from '../../render/renderer'
import { toast } from '../toast'

// 向上冒泡的交互意图（由 App 承接需要渲染器/弹窗支持的操作）
const emit = defineEmits<{
  (e: 'fit'): void
  (e: 'generate', count: number): void
  (e: 'import-image'): void
}>()

// 取色器当前颜色，默认主题蓝；仅在选择点位后「应用」才有意义
const color = ref('#4ea1ff')

/** 画质下拉变更：把 DOM 的字符串值收窄为 RenderQuality 后交给桥接层 */
function onQualityChange(e: Event): void {
  setRenderQuality((e.target as HTMLSelectElement).value as RenderQuality)
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

    <!-- 区域：画质档位与测试数据 / 图片导入入口 -->
    <div class="group">
      <label class="label">画质</label>
      <select :value="renderQuality" @change="onQualityChange">
        <option value="auto">自动（动态分辨率）</option>
        <option value="high">高（原生）</option>
        <option value="balanced">均衡（75%）</option>
        <option value="fast">流畅（50%）</option>
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
