<script setup lang="ts">
/**
 * 通用模态弹窗外壳：遮罩 + 卡片 + 标题栏 + 底部插槽。
 * 通过 v-if 控制显隐（调用方持有 open 状态），点击遮罩或 ✕ 触发 close。
 */
withDefaults(defineProps<{ open: boolean; title?: string; width?: string }>(), {
  title: '',
  width: '760px',
})
const emit = defineEmits<{ (e: 'close'): void }>()
</script>

<template>
  <div v-if="open" class="overlay" @click.self="emit('close')">
    <div class="dialog" :style="{ width }">
      <header class="head">
        <h3>{{ title }}</h3>
        <button class="ghost" @click="emit('close')">✕</button>
      </header>
      <div class="body">
        <slot />
      </div>
      <footer v-if="$slots.footer" class="foot">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.dialog {
  max-width: 92vw;
  max-height: 90vh;
  overflow: auto;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  display: flex;
  flex-direction: column;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.head h3 {
  margin: 0;
  font-size: 15px;
}
.ghost {
  background: transparent;
  border: none;
  font-size: 15px;
}
.body {
  padding: 16px;
}
.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
</style>
