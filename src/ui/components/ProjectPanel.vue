<script setup lang="ts">
/**
 * 左侧项目面板：当前项目信息、分组面板、新建项目、OPFS 项目列表。
 *
 * 所有持久化相关的状态与动作都来自 ui/projects 桥接层；本组件只负责触发
 * 与呈现。切换/导入项目时，projects 层内部处理「未保存修改」的确认流程，
 * 因此这里无需自行弹确认框，只需 await 返回结果。
 */
import { ref } from 'vue'
import {
  createNewProject,
  currentProjectId,
  deleteProject,
  dirty,
  exportCurrent,
  importFromFile,
  loading,
  openProject,
  openingId,
  opfsSupported,
  projects,
  saveProject,
  saving,
} from '../projects'
import { projectName } from '../editor'
import GroupPanel from './GroupPanel.vue'

// 新建项目的名称输入（空则回退为默认名）
const newName = ref('')
// 隐藏的文件选择框，供「导入 JSON」按钮间接触发
const fileInput = ref<HTMLInputElement>()

/** 创建新项目：空名称使用默认名，成功后清空输入框 */
async function onCreate(): Promise<void> {
  await createNewProject(newName.value || '未命名项目')
  newName.value = ''
}

/** 触发隐藏的 file input（浏览器要求由用户手势直接触发点击） */
function pickFile(): void {
  fileInput.value?.click()
}

/** 处理选中的 JSON 文件并导入；无论成功与否都重置 input，便于重复选择同一文件 */
async function onFileChange(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  if (file) await importFromFile(file)
  input.value = ''
}

/** 时间戳格式化；0/无效值显示占位符 */
function formatTime(ts: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}
</script>

<template>
  <aside class="panel">
    <!-- 区域：当前项目 —— 名称/脏标记 + 保存/导出/导入操作 -->
    <div class="section">
      <div class="section-title">当前项目</div>
      <div class="current">
        <span class="name">{{ projectName }}</span>
        <span v-if="dirty" class="badge">未保存</span>
        <span v-else class="badge saved">已保存</span>
      </div>
      <div class="actions">
        <button class="primary" :disabled="saving || !opfsSupported" @click="saveProject">
          {{ saving ? '保存中…' : '保存到 OPFS' }}
        </button>
        <button @click="exportCurrent">导出 JSON</button>
        <button @click="pickFile">导入 JSON/轨迹</button>
        <input ref="fileInput" type="file" accept="application/json,.json,.jsdm" hidden @change="onFileChange" />
      </div>
      <p v-if="!opfsSupported" class="warn">当前浏览器不支持 OPFS，存储功能不可用（建议 Chrome/Edge）。</p>
    </div>

    <!-- 区域：分组管理（独立子组件） -->
    <GroupPanel />

    <!-- 区域：新建项目 -->
    <div class="section">
      <div class="section-title">新建项目</div>
      <div class="actions">
        <input v-model="newName" placeholder="项目名称" @keyup.enter="onCreate" />
        <button @click="onCreate">创建</button>
      </div>
    </div>

    <!-- 区域：OPFS 项目列表（可滚动，点击打开、✕ 删除） -->
    <div class="section grow">
      <div class="section-title">
        OPFS 项目列表
        <span class="count">{{ loading ? '⟳' : projects.length }}</span>
      </div>
      <div v-if="projects.length === 0" class="empty">
        {{ loading ? '读取中…' : '暂无已保存项目' }}
      </div>
      <ul v-else class="list">
        <li
          v-for="p in projects"
          :key="p.id"
          :class="{ active: p.id === currentProjectId, opening: p.id === openingId }"
        >
          <div class="meta" @click="openProject(p.id)">
            <div class="p-name">{{ p.name }}</div>
            <div class="p-sub">
              {{ p.pointCount }} 点 · v{{ p.version }}<br />
              {{ formatTime(p.updatedAt) }}
            </div>
          </div>
          <button class="danger small" title="删除" @click="deleteProject(p.id)">✕</button>
        </li>
      </ul>
    </div>
  </aside>
</template>

<style scoped>
.panel {
  width: 280px;
  flex-shrink: 0;
  background: var(--panel);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.section {
  padding: 12px;
  border-bottom: 1px solid var(--border);
}
.section.grow {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-bottom: none;
}
.section-title {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 8px;
  display: flex;
  justify-content: space-between;
}
.count {
  color: var(--accent);
}
.current {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
.name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.badge {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 10px;
  background: #3a2d12;
  color: #f0b429;
  flex-shrink: 0;
}
.badge.saved {
  background: #123626;
  color: var(--success);
}
.actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.actions input {
  flex: 1;
  min-width: 100px;
}
.warn {
  color: #f0b429;
  font-size: 12px;
  margin: 8px 0 0;
}
.empty {
  color: var(--text-dim);
  font-size: 13px;
  padding: 8px 0;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
}
.list li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
}
.list li:hover {
  background: var(--panel-2);
}
.list li.active {
  background: #12303f;
  border: 1px solid var(--accent);
}
.list li.opening .p-name::after {
  content: ' ⟳';
  color: var(--accent);
}
.meta {
  flex: 1;
  min-width: 0;
}
.p-name {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.p-sub {
  font-size: 11px;
  color: var(--text-dim);
  margin-top: 2px;
  line-height: 1.4;
}
.small {
  padding: 2px 6px;
}
</style>
