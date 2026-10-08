<script setup lang="ts">
/**
 * Toast 展示宿主：订阅全局 toasts 列表并渲染。
 *
 * 只做展示与交互（点击关闭），提示的创建/超时由 ui/toast 负责；
 * TransitionGroup 让新增/移除带有滑入滑出动画。
 */
import { dismiss, toasts } from '../toast'
</script>

<template>
  <div class="toast-host">
    <TransitionGroup name="toast">
      <!-- 以 id 作为 key：保证动画与列表项一一对应 -->
      <div v-for="t in toasts" :key="t.id" class="toast" :class="t.type" @click="dismiss(t.id)">
        <span class="icon">{{ t.type === 'error' ? '⚠' : t.type === 'success' ? '✓' : 'ℹ' }}</span>
        <span>{{ t.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-host {
  position: fixed;
  right: 16px;
  bottom: 44px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 100;
  max-width: 360px;
}
.toast {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  font-size: 13px;
  cursor: pointer;
}
.toast.error {
  border-color: var(--danger);
}
.toast.success {
  border-color: var(--success);
}
.icon {
  flex-shrink: 0;
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(20px);
}
</style>
