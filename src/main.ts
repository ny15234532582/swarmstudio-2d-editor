/**
 * 应用入口：创建 Vue 应用并挂载到 index.html 中的 #app 根节点。
 * 全局样式在此统一引入，保证挂载前 CSS 已就绪。
 */
import { createApp } from 'vue'
import App from './App.vue'
import './ui/styles.css'

createApp(App).mount('#app')
