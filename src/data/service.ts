/**
 * DataService —— 数据操作层的对外门面（不依赖 Vue）。
 *
 * 职责：持有当前项目会话；订阅 EditorStore 的 mutation / 结构变化，
 * 缓冲 + 防抖后交给 DataClient；提供项目 CRUD / 导入导出 API；
 * 通过事件向外广播状态。
 */
import { Emitter } from '../state/emitter'
import { createProject } from '../core/factory'
import type { Mutation, Operation } from '../core/operations'
import type { Group, Point, Project, ProjectMeta, Track } from '../core/types'
import type { EditorStore } from '../state/store'
import { DataClient } from './client'
import { exportProjectJson, parseAnyProjectFile } from './json'
import type { RenderRecord, WorkerInitInfo } from './protocol'

export interface DataStatus {
  persistent: boolean
  mode: string
  sqliteVersion: string
  notice?: string
  currentProjectId: string | null
  currentProjectName: string
  dirty: boolean
  saving: boolean
  lastSavedAt: number | null
}

export type ServiceEvents = {
  status: DataStatus
  projects: ProjectMeta[]
  info: string
  error: string
  /** 当前项目的过渡产物（打开项目 / 保存后广播） */
  renders: import('./protocol').RenderRecord[]
}

const AUTOSAVE_DELAY = 400

/** 从运行时 Project 中抽出只用于项目表的元信息字段 */
function toRecord(project: Project) {
  return {
    id: project.id,
    name: project.name,
    version: project.version,
    droneCount: project.droneCount,
    maxSpeed: project.droneLimits?.maxSpeed ?? 0,
    maxAccel: project.droneLimits?.maxAccel ?? 0,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

export class DataService {
  readonly events = new Emitter<ServiceEvents>()
  private readonly client = new DataClient()

  private status: DataStatus = {
    persistent: false,
    mode: 'memory',
    sqliteVersion: '',
    currentProjectId: null,
    currentProjectName: '未命名项目',
    dirty: false,
    saving: false,
    lastSavedAt: null,
  }

  private pendingMutations: Mutation[] = []
  private flushTimer: number | null = null
  /** 已存在产物的过渡 id（用于孤儿清理） */
  private renderedIds = new Set<string>()
  /** 打开/新建项目时置位，屏蔽 store 回灌产生的事件，避免误触发自动保存 */
  private suppress = false
  /** 是否有待落盘的变更（可能是 mutation，也可能只有结构/历史变化） */
  private pending = false

  constructor(private store: EditorStore) {
    this.store.events.on('mutation', (mutation) => {
      if (this.suppress) return
      this.pendingMutations.push(mutation)
      this.scheduleFlush()
    })
    // 历史 / 结构 / 元信息变化也要同步到 SQLite
    this.store.events.on('history:change', () => {
      if (!this.suppress) this.scheduleFlush()
    })
    this.store.events.on('groups:change', () => {
      if (!this.suppress) this.scheduleFlush()
    })
    this.store.events.on('frames:change', () => {
      if (!this.suppress) this.scheduleFlush()
    })
    this.store.events.on('transitions:change', () => {
      if (!this.suppress) this.scheduleFlush()
    })
    this.store.events.on('meta:change', () => {
      if (!this.suppress) this.scheduleFlush()
    })
    // 过渡被移除（删帧 / 撤销）时，清掉不再存在的产物
    this.store.events.on('transitions:change', () => {
      if (!this.suppress) this.cleanupRenders()
    })
    // 页面隐藏 / 关闭前立刻落盘
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('pagehide', this.onPageHide)
  }

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') void this.flush()
  }

  private onPageHide = (): void => {
    void this.flush()
  }

  // ------------------------------------------------------------- 生命周期

  async init(): Promise<void> {
    let info: WorkerInitInfo
    try {
      info = await this.client.ready()
    } catch (err) {
      this.emit('error', `数据库初始化失败：${(err as Error).message}`)
      return
    }
    this.patchStatus({
      persistent: info.persistent,
      mode: info.mode,
      sqliteVersion: info.sqliteVersion,
      notice: info.message,
    })
    if (info.message) this.emit('info', info.message)
    await this.refreshProjects()
  }

  getStatus(): DataStatus {
    return { ...this.status }
  }

  private patchStatus(patch: Partial<DataStatus>): void {
    this.status = { ...this.status, ...patch }
    this.events.emit('status', this.getStatus())
  }

  private emit(event: 'info' | 'error', message: string): void {
    this.events.emit(event, message)
  }

  // ------------------------------------------------------------- 项目列表

  async refreshProjects(): Promise<void> {
    if (!this.status.persistent) return
    try {
      const projects = await this.client.listProjects()
      this.events.emit('projects', projects)
    } catch (err) {
      this.emit('error', (err as Error).message)
    }
  }

  // ------------------------------------------------------------- 过渡产物

  /** 重新从库读取当前项目的全部过渡产物并广播 */
  async reloadRenders(): Promise<void> {
    const projectId = this.status.currentProjectId
    if (!projectId || !this.status.persistent) {
      this.renderedIds = new Set()
      this.events.emit('renders', [])
      return
    }
    try {
      const renders = await this.client.listRenders(projectId)
      this.renderedIds = new Set(renders.map((r) => r.transitionId))
      this.events.emit('renders', renders)
    } catch (err) {
      this.emit('error', (err as Error).message)
    }
  }

  /** 保存 / 覆盖一条过渡产物到 OPFS */
  async saveRender(render: RenderRecord): Promise<void> {
    const projectId = this.status.currentProjectId
    if (!projectId || !this.status.persistent) return
    try {
      await this.client.saveRender(projectId, render)
      this.renderedIds.add(render.transitionId)
    } catch (err) {
      this.emit('error', `保存产物失败：${(err as Error).message}`)
    }
  }

  /** 删除某过渡的产物 */
  async deleteRender(transitionId: string): Promise<void> {
    const projectId = this.status.currentProjectId
    if (!projectId || !this.status.persistent) return
    try {
      await this.client.deleteRender(projectId, transitionId)
      this.renderedIds.delete(transitionId)
    } catch (err) {
      this.emit('error', (err as Error).message)
    }
  }

  /** 清理「过渡已不存在」的孤儿产物 */
  private cleanupRenders(): void {
    const projectId = this.status.currentProjectId
    if (!projectId || !this.status.persistent) return
    const alive = new Set<string>()
    for (const track of this.store.project.tracks) for (const tr of track.transitions) alive.add(tr.id)
    for (const id of [...this.renderedIds]) {
      if (!alive.has(id)) {
        this.renderedIds.delete(id)
        void this.client.deleteRender(projectId, id)
      }
    }
  }

  // ------------------------------------------------------------- 自动保存

  private scheduleFlush(): void {
    this.pending = true
    this.patchStatus({ dirty: true })
    if (!this.status.currentProjectId) return
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer)
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, AUTOSAVE_DELAY)
  }

  async flush(): Promise<void> {
    const projectId = this.status.currentProjectId
    if (!projectId) return
    if (!this.pending) return
    this.pending = false
    const mutations = this.pendingMutations
    this.pendingMutations = []

    this.patchStatus({ saving: true })
    try {
      await this.client.persistChanges(
        projectId,
        mutations,
        this.store.history.entries,
        this.store.groups,
        this.store.project.tracks,
      )
      this.patchStatus({
        saving: false,
        dirty: this.pending || this.pendingMutations.length > 0,
        lastSavedAt: Date.now(),
      })
    } catch (err) {
      // 失败时把变更放回缓冲，等待下次保存
      this.pending = true
      this.pendingMutations = [...mutations, ...this.pendingMutations]
      this.patchStatus({ saving: false, dirty: true })
      this.emit('error', `保存失败：${(err as Error).message}`)
    }
  }

  // ------------------------------------------------------------- 项目操作

  async createProject(name: string): Promise<void> {
    const project = createProject(name.trim() || '未命名项目')
    await this.insertAndOpen(project)
    this.emit('info', `已创建项目「${project.name}」`)
  }

  async openProject(id: string): Promise<void> {
    try {
      const loaded = await this.client.loadProject(id)
      if (!loaded) throw new Error('项目不存在或已被删除')
      const project: Project = {
        version: loaded.project.version,
        id: loaded.project.id,
        name: loaded.project.name,
        createdAt: loaded.project.createdAt,
        updatedAt: loaded.project.updatedAt,
        droneCount: loaded.project.droneCount,
        droneLimits: loaded.project.droneLimits,
        points: loaded.project.points,
        groups: loaded.project.groups,
        tracks: loaded.project.tracks,
      }
      this.suppress = true
      this.store.loadProject(project, loaded.history)
      this.suppress = false
      this.pendingMutations = []
      this.pending = false
      this.patchStatus({
        currentProjectId: id,
        currentProjectName: project.name,
        dirty: false,
        lastSavedAt: Date.now(),
      })
      this.emit('info', `已打开「${project.name}」（${project.points.length} 点）`)
      await this.reloadRenders()
    } catch (err) {
      this.emit('error', (err as Error).message)
    }
  }

  async deleteProject(id: string): Promise<void> {
    try {
      await this.client.deleteProject(id)
      if (this.status.currentProjectId === id) {
        this.pendingMutations = []
        this.pending = false
        if (this.flushTimer !== null) {
          window.clearTimeout(this.flushTimer)
          this.flushTimer = null
        }
        this.suppress = true
        this.store.loadProject(createProject('未命名项目'), [])
        this.suppress = false
        this.patchStatus({
          currentProjectId: null,
          currentProjectName: '未命名项目',
          dirty: false,
          lastSavedAt: null,
        })
      }
      await this.refreshProjects()
      this.emit('info', '项目已删除')
    } catch (err) {
      this.emit('error', (err as Error).message)
    }
  }

  async renameCurrent(name: string): Promise<void> {
    const id = this.status.currentProjectId
    if (!id) return
    try {
      await this.client.renameProject(id, name)
      this.store.project.name = name
      this.patchStatus({ currentProjectName: name })
      await this.refreshProjects()
    } catch (err) {
      this.emit('error', (err as Error).message)
    }
  }

  /**
   * 保存：已有项目则 flush；否则把当前画面内容另存为新项目。
   * 也用于「首次导入图片前确保项目已落库」。
   */
  async saveNow(name?: string): Promise<void> {
    if (this.status.currentProjectId) {
      if (this.flushTimer !== null) {
        window.clearTimeout(this.flushTimer)
        this.flushTimer = null
      }
      await this.flush()
      await this.refreshProjects()
      return
    }
    const project = createProject(name?.trim() || this.store.project.name || '未命名项目')
    project.points = this.store.project.points
    project.groups = this.store.project.groups
    project.tracks = this.store.project.tracks
    project.droneCount = this.store.project.droneCount
    project.droneLimits = this.store.project.droneLimits
    await this.insertAndOpen(project, this.store.history.entries)
  }

  // ------------------------------------------------------------- 导入导出

  exportCurrent(): void {
    const p = this.store.project
    const project: Project = {
      version: p.version,
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: Date.now(),
      droneCount: p.droneCount,
      droneLimits: p.droneLimits,
      points: p.points,
      groups: p.groups,
      tracks: p.tracks,
    }
    exportProjectJson(project)
  }

  async importFile(file: File): Promise<void> {
    try {
      const parsed = await parseAnyProjectFile(file)
      const project = createProject(parsed.name || '导入的项目')
      project.droneCount = parsed.droneCount
      project.droneLimits = parsed.droneLimits
      project.points = parsed.points
      project.groups = parsed.groups
      project.tracks = parsed.tracks
      await this.insertAndOpen(project, [])
      this.emit('info', `已导入「${project.name}」（${project.points.length} 点）`)
    } catch (err) {
      this.emit('error', (err as Error).message)
    }
  }

  // ------------------------------------------------------------- 内部

  /** 载入项目到编辑器并在持久化后端建立（或在内存模式只载入） */
  private async insertAndOpen(project: Project, history: Operation[] = []): Promise<void> {
    const points: Point[] = project.points
    const groups: Group[] = project.groups
    const tracks: Track[] = project.tracks
    this.suppress = true
    this.store.loadProject(project, history)
    this.suppress = false
    this.pendingMutations = []
    this.pending = false
    this.renderedIds = new Set()
    this.events.emit('renders', [])
    this.patchStatus({
      currentProjectId: project.id,
      currentProjectName: project.name,
      dirty: false,
      lastSavedAt: null,
    })

    if (!this.status.persistent) return
    try {
      await this.client.createProject(toRecord(project))
      await this.client.replaceData(project.id, points, history, groups, tracks)
      this.patchStatus({ lastSavedAt: Date.now() })
      await this.refreshProjects()
    } catch (err) {
      // 写库失败：项目并未真正存在，清掉 id，刷新列表避免 UI 停留旧状态
      this.patchStatus({ currentProjectId: null, dirty: true })
      this.emit('error', `写入 OPFS 失败：${(err as Error).message}`)
      await this.refreshProjects()
    }
  }

  /** 清理计时器与全局监听，并终止 Worker */
  destroy(): void {
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer)
    document.removeEventListener('visibilitychange', this.onVisibilityChange)
    window.removeEventListener('pagehide', this.onPageHide)
    this.client.destroy()
  }
}
