<script setup lang="ts">
/**
 * 分组面板：列出当前所有分组，提供选中、锁定/解锁、重命名、解散操作。
 *
 * 列表数据来自响应式的 groups 快照（revision 驱动），所有写操作都走
 * editor 单例的语义化方法，天然支持撤销/重做。
 */
import { editor, groups } from '../editor'
import { toast } from '../toast'

/** 点击分组元信息：选中该组所有未锁定点 */
function selectGroup(id: string): void {
  editor.selectGroup(id)
}

/** 切换组锁定状态：传入的是「切换前」状态，取反后执行 */
function toggleLock(id: string, locked: boolean): void {
  editor.setLockedForGroup(id, !locked)
  toast(locked ? '已解锁该组' : '已锁定该组', 'info')
}

/** 解散分组（组内点归属清空，可撤销） */
function ungroup(id: string): void {
  editor.ungroup(id)
}

/** 弹窗重命名：空输入视为取消，不改动原名 */
function rename(id: string, current: string): void {
  const name = window.prompt('分组名称', current)
  if (name) editor.renameGroup(id, name)
}
</script>

<template>
  <div class="section group-panel">
    <!-- 标题与分组计数 -->
    <div class="section-title">
      分组
      <span class="count">{{ groups.length }}</span>
    </div>
    <!-- 空态提示 -->
    <div v-if="groups.length === 0" class="empty">选中点位后点「成组」</div>
    <!-- 分组列表：色点 + 名称/统计 + 锁定/重命名/解散 -->
    <ul v-else class="list">
      <li v-for="g in groups" :key="g.id">
        <span class="dot" :style="{ background: `rgb(${g.color.r},${g.color.g},${g.color.b})` }" />
        <div class="meta" @click="selectGroup(g.id)">
          <div class="g-name">{{ g.name }}</div>
          <div class="g-sub">{{ g.count }} 点 · {{ g.locked ? '已锁定' : '可编辑' }}</div>
        </div>
        <button class="small" :title="g.locked ? '解锁' : '锁定'" @click="toggleLock(g.id, g.locked)">
          {{ g.locked ? '🔒' : '🔓' }}
        </button>
        <button class="small" title="重命名" @click="rename(g.id, g.name)">✎</button>
        <button class="small danger" title="取消分组" @click="ungroup(g.id)">✕</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.section {
  padding: 12px;
  border-bottom: 1px solid var(--border);
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
.empty {
  color: var(--text-dim);
  font-size: 13px;
  padding: 4px 0;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 180px;
  overflow-y: auto;
}
.list li {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-radius: 6px;
}
.list li:hover {
  background: var(--panel-2);
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}
.meta {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.g-name {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.g-sub {
  font-size: 11px;
  color: var(--text-dim);
}
.small {
  padding: 2px 6px;
  font-size: 12px;
}
</style>
