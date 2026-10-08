/**
 * DataService —— 数据操作层的对外门面（不依赖 Vue）。
 *
 * 职责：
 * - 持有当前项目会话（projectId / dirty / saving / 存储后端状态）；
 * - 订阅 EditorStore 的 mutation 与 history 流，缓冲 + 防抖后交给 DataClient；
 * - 提供项目 CRUD、导入导出、测试数据载入等用例级 API；
 * - 通过事件向外（UI 层）广播状态，UI 只负责把它映射成 ref / toast。
 *
 * 这样 UI 层与 SQLite / Worker / OPFS 之间完全解耦。
 */
import { Emitter } from '../state/emitter'
import { createProject } from '../core/factory'
import type { Mutation, Operation } from '../core/operations'
import type { Point, Project, ProjectMeta } from '../core/types'
import type { EditorStore } from '../state/store'
import { DataClient } from './client'
import { exportProjectJson, parseProjectFile } from './json'
import type { WorkerInitInfo } from './protocol'

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
}

const AUTOSAVE_DELAY = 400

/** 从运行时 Project 中抽出只用于项目表的元信息字段 */
function toRecord(project: Project) {
  return {
    id: project.id,
    name: project.name,
    version: project.version,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

/**
 * 数据服务门面：UI 只与它交互，它负责编排 DataClient、EditorStore 与导入导出，
 * 并对外广播 status / projects / info / error 事件。
 */
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
  /** 打开/新建项目时置位，屏蔽 store 回灌产生的事件，避免误触发自动保存 */
  private suppress = false
  /** 是否有待落盘的变更（可能是 mutation，也可能只有分组结构/历史变化） */
  private pending = false

  constructor(private store: EditorStore) {
    // 已提交的数据变更 → 缓冲（拖动预览不会走到这里）
    this.store.events.on('mutation', (mutation) => {
      if (this.suppress) return
      this.pendingMutations.push(mutation)
      this.scheduleFlush()
    })
    // 历史变化（新增/撤销/重做）也要同步到 SQLite
    this.store.events.on('history:change', () => {
      if (this.suppress) return
      this.scheduleFlush()
    })
    // 分组结构变化可能不带点级 mutation（如单纯成组/拆组），也要触发落盘
    this.store.events.on('groups:change', () => {
      if (this.suppress) return
      this.scheduleFlush()
    })
    // 页面隐藏 / 关闭前立刻落盘，尽量不丢防抖窗口内的最后一笔变更
    document.addEventListener('visibilitychange', this.onVisibilityChange)
    window.addEventListener('pagehide', this.onPageHide)
  }

  private onVisibilityChange = (): void => {
    // 切到后台可能被系统回收，立即落盘
    if (document.visibilityState === 'hidden') void this.flush()
  }

  private onPageHide = (): void => {
    // 关闭 / 刷新页面时最后一搏
    void this.flush()
  }

  // ------------------------------------------------------------- 生命周期

  /** 等待 Worker 就绪，同步存储后端状态并拉取项目列表 */
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

  /** 返回状态快照（拷贝，防止外部直接改内部状态） */
  getStatus(): DataStatus {
    return { ...this.status }
  }

  /** 以 patch 合并方式更新状态并广播 status 事件 */
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

  // ------------------------------------------------------------- 自动保存

  /**
   * 计划一次防抖落盘：标记 dirty 并重置 400ms 计时器；
   * 没有当前项目时只置 dirty，等真正有项目（另存为）时再写。
   */
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

  /** 立刻把缓冲的变更写库（可能只有分组结构 / 历史变化，没有点级 mutation） */
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
        this.store.project.groups,
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

  /** 新建项目：名字去空格，空则回退为「未命名项目」，然后建库并打开 */
  async createProject(name: string): Promise<void> {
    const project = createProject(name.trim() || '未命名项目')
    await this.insertAndOpen(project)
    this.emit('info', `已创建项目「${project.name}」`)
  }

  /** 打开项目：读库 → 回灌 EditorStore（屏蔽事件）→ 同步状态 */
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
        points: loaded.project.points,
        groups: loaded.project.groups,
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
    } catch (err) {
      this.emit('error', (err as Error).message)
    }
  }

  /** 删除项目；若删的是当前项目，则重置编辑器为空项目并清空缓冲 */
  async deleteProject(id: string): Promise<void> {
    try {
      await this.client.deleteProject(id)
      if (this.status.currentProjectId === id) {
        // 删的是当前项目：清掉缓冲，并把编辑器重置为空项目，
        // 否则画布上还会留着已删除项目的点位
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

  /** 重命名当前项目：先改库，再同步内存与状态栏 */
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

  /** 保存：已有项目则 flush；否则把当前画面内容另存为新项目 */
  async saveNow(name?: string): Promise<void> {
    if (this.status.currentProjectId) {
      if (this.flushTimer !== null) {
        window.clearTimeout(this.flushTimer)
        this.flushTimer = null
      }
      await this.flush()
      await this.refreshProjects()
      this.emit('info', '项目已保存到 OPFS')
      return
    }
    const project = createProject(name?.trim() || this.store.project.name || '未命名项目')
    project.points = this.store.project.points
    await this.insertAndOpen(project, this.store.history.entries)
    this.emit('info', '项目已保存到 OPFS')
  }

  /** 载入测试数据并直接落库为一个新项目 */
  async loadPointsAsProject(points: Point[], name: string): Promise<void> {
    const project = createProject(name)
    project.points = points
    await this.insertAndOpen(project, [])
    this.emit('info', `已载入 ${points.length} 个测试点`)
  }

  // ------------------------------------------------------------- 导入导出

  /** 把当前项目导出为 JSON 文件（updatedAt 取当前时刻） */
  exportCurrent(): void {
    const p = this.store.project
    const project: Project = {
      version: p.version,
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: Date.now(),
      points: p.points,
      groups: p.groups,
    }
    exportProjectJson(project)
  }

  /** 解析校验导入文件，并作为新项目打开（导入数据不覆盖当前项目） */
  async importFile(file: File): Promise<void> {
    try {
      const parsed = await parseProjectFile(file)
      const project = createProject(parsed.name || '导入的项目')
      project.points = parsed.points
      await this.insertAndOpen(project, [])
      this.emit('info', `已导入「${project.name}」（${project.points.length} 点）`)
    } catch (err) {
      this.emit('error', (err as Error).message)
    }
  }

  // ------------------------------------------------------------- 内部

  /**
   * 载入项目到编辑器并持久化：先回灌 store（屏蔽事件），
   * 再在持久化后端建项目/写全量点位；非持久化模式只载入不落库。
   */
  private async insertAndOpen(project: Project, history: Operation[] = []): Promise<void> {
    const points = project.points
    this.suppress = true
    this.store.loadProject(project, history)
    this.suppress = false
    this.pendingMutations = []
    this.pending = false
    this.patchStatus({
      currentProjectId: project.id,
      currentProjectName: project.name,
      dirty: false,
      lastSavedAt: null,
    })

    if (!this.status.persistent) return
    try {
      await this.client.createProject(toRecord(project))
      if (points.length > 0) {
        await this.client.replacePoints(project.id, points, history, project.groups)
      }
      this.patchStatus({ lastSavedAt: Date.now() })
      await this.refreshProjects()
    } catch (err) {
      // 写库失败：项目并未真正存在，清掉 id，避免后续自动保存往一个
      // 不存在的项目写（会因外键约束反复失败）
      this.patchStatus({ currentProjectId: null, dirty: true })
      this.emit('error', `写入 OPFS 失败：${(err as Error).message}`)
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
