/**
 * UI 侧的存储状态桥接。
 *
 * 真正的数据操作全在 src/data（不依赖 Vue）。这里只做两件事：
 * - 把 DataService 的事件映射成 Vue ref，供组件渲染；
 * - 把组件的动作转发给 DataService，并把结果显示成 toast。
 */
import { ref } from 'vue'
import { editor, projectName } from './editor'
import { toast } from './toast'
import { DataService } from '../data/service'
import type { Point, ProjectMeta } from '../core/types'

export const service = new DataService(editor)

export const projects = ref<ProjectMeta[]>([])
export const currentProjectId = ref<string | null>(null)
export const dirty = ref(false)
export const saving = ref(false)
export const loading = ref(false)
export const lastSavedAt = ref<number | null>(null)
/** 是否真正落盘到 OPFS（Worker 初始化后确定） */
export const opfsSupported = ref(true)
/** 实际存储后端：opfs-sahpool / memory */
export const storageMode = ref<string>('')

service.events.on('status', (status) => {
  currentProjectId.value = status.currentProjectId
  dirty.value = status.dirty
  saving.value = status.saving
  lastSavedAt.value = status.lastSavedAt
  opfsSupported.value = status.persistent
  storageMode.value = status.mode
})
service.events.on('projects', (list) => {
  projects.value = list
})
service.events.on('info', (message) => toast(message, 'info'))
service.events.on('error', (message) => toast(message, 'error', 5000))

// 启动即初始化数据库 Worker
void service.init()

export async function refreshProjects(): Promise<void> {
  await service.refreshProjects()
}

/**
 * 切换/覆盖当前项目前的保护：有未保存修改时先询问是否保存。
 * 返回 false 表示用户放弃本次操作（保留当前编辑内容）。
 */
async function ensureSaved(): Promise<boolean> {
  if (!dirty.value) return true
  if (window.confirm('当前项目有未保存的修改，是否先保存？')) {
    await saveProject()
    return !dirty.value // 保存流程被取消（如没填项目名）则中止
  }
  return window.confirm('不保存并继续？未保存的修改将丢失')
}

export async function createNewProject(name: string): Promise<void> {
  if (!(await ensureSaved())) return
  loading.value = true
  try {
    await service.createProject(name)
  } finally {
    loading.value = false
  }
}

/** 正在打开的项目 id，用于在列表项上显示忙碌态（不整体隐藏列表） */
export const openingId = ref<string | null>(null)

export async function openProject(id: string): Promise<void> {
  if (!(await ensureSaved())) return
  openingId.value = id
  try {
    await service.openProject(id)
  } finally {
    openingId.value = null
  }
}

export async function deleteProject(id: string): Promise<void> {
  if (!window.confirm('确定删除该项目？此操作不可恢复')) return
  await service.deleteProject(id)
}

export async function saveProject(): Promise<void> {
  if (!currentProjectId.value) {
    const name = window.prompt('项目名称', projectName.value || '未命名项目')
    if (!name) return
    await service.saveNow(name)
    return
  }
  await service.saveNow()
}

export function exportCurrent(): void {
  service.exportCurrent()
}

export async function importFromFile(file: File): Promise<void> {
  if (!(await ensureSaved())) return
  await service.importFile(file)
}

/** 载入一批点作为新项目。返回是否已应用（供调用方决定是否关闭弹窗）。 */
export async function loadPointsAsProject(points: Point[], name: string): Promise<boolean> {
  if (!(await ensureSaved())) return false
  loading.value = true
  try {
    await service.loadPointsAsProject(points, name)
    return true
  } finally {
    loading.value = false
  }
}
