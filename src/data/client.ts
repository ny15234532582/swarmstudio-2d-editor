/**
 * 数据客户端：主线程侧访问数据层的唯一入口。
 *
 * 业务代码 → DataClient（类型化 API）→ TaskQueue（串行 + 合并）→ postMessage → Worker。
 */
import { TaskQueue } from './queue'
import type { Mutation, Operation } from '../core/operations'
import type { Group, Point, ProjectMeta, Track } from '../core/types'
import type {
  LoadedProject,
  ProjectRecord,
  RenderRecord,
  Request,
  RequestResultMap,
  Response,
  WorkerInitInfo,
} from './protocol'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/** 数据访问入口：类型化 API + 以请求 id 为键的 Promise 配对表 */
export class DataClient {
  private readonly worker: Worker
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  readonly queue = new TaskQueue(1)
  private readonly initPromise: Promise<WorkerInitInfo>

  constructor() {
    this.worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })
    this.worker.onmessage = (event: MessageEvent<Response>) => this.onMessage(event.data)
    this.worker.onerror = (event) => {
      const error = new Error(`数据 Worker 错误：${event.message || '未知错误'}`)
      for (const entry of this.pending.values()) entry.reject(error)
      this.pending.clear()
    }
    this.initPromise = this.send('init', {})
  }

  /** Worker/数据库初始化信息（是否落盘、SQLite 版本等） */
  ready(): Promise<WorkerInitInfo> {
    return this.initPromise
  }

  /** 按 id 找到等待者并结算 */
  private onMessage(response: Response): void {
    const entry = this.pending.get(response.id)
    if (!entry) return
    this.pending.delete(response.id)
    if (response.ok) entry.resolve(response.result)
    else entry.reject(new Error(response.error))
  }

  /** 真正发消息：先登记 id → Promise，再 postMessage，等 onMessage 回包 */
  private dispatch(request: Request): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject })
      this.worker.postMessage(request)
    })
  }

  /** 生成带 id 的请求，经 TaskQueue 串行执行（不合并） */
  private send<K extends keyof RequestResultMap>(type: K, params: object = {}): Promise<RequestResultMap[K]> {
    const request = { id: this.nextId++, type, ...params } as Request
    return this.queue.enqueue<RequestResultMap[K], Request>({
      payload: request,
      run: (r) => this.dispatch(r) as Promise<RequestResultMap[K]>,
    })
  }

  listProjects(): Promise<ProjectMeta[]> {
    return this.send('listProjects')
  }

  loadProject(projectId: string): Promise<LoadedProject | null> {
    return this.send('loadProject', { projectId })
  }

  getProject(projectId: string): Promise<LoadedProject | null> {
    return this.send('getProject', { projectId })
  }

  createProject(project: ProjectRecord): Promise<void> {
    return this.send('createProject', { project })
  }

  renameProject(projectId: string, name: string): Promise<void> {
    return this.send('renameProject', { projectId, name })
  }

  deleteProject(projectId: string): Promise<void> {
    return this.send('deleteProject', { projectId })
  }

  listRenders(projectId: string): Promise<RenderRecord[]> {
    return this.send('listRenders', { projectId })
  }

  saveRender(projectId: string, render: RenderRecord): Promise<void> {
    return this.send('saveRender', { projectId, render })
  }

  deleteRender(projectId: string, transitionId: string): Promise<void> {
    return this.send('deleteRender', { projectId, transitionId })
  }

  /** 全量替换项目数据（导入 / 载入） */
  replaceData(
    projectId: string,
    points: Point[],
    history: Operation[],
    groups: Group[],
    tracks: Track[],
  ): Promise<void> {
    return this.send('replaceData', { projectId, points, history, groups, tracks })
  }

  /**
   * 增量持久化：提交一批 mutation + 覆盖当前历史 / 分组 / 轨道结构。
   * 使用固定 key 做合并，连续保存会合并为有限次写库。
   */
  persistChanges(
    projectId: string,
    mutations: Mutation[],
    history: Operation[],
    groups: Group[],
    tracks: Track[],
  ): Promise<void> {
    return this.queue.enqueue<void, ChangePayload>({
      key: `changes:${projectId}`,
      payload: { mutations, history, groups, tracks },
      merge: (prev, next) => ({
        // mutation 累加；history/groups/tracks 是快照，后到的整体覆盖即可
        mutations: [...prev.mutations, ...next.mutations],
        history: next.history,
        groups: next.groups,
        tracks: next.tracks,
      }),
      run: (payload) =>
        this.dispatch({
          id: this.nextId++,
          type: 'applyChanges',
          projectId,
          mutations: payload.mutations,
          history: payload.history,
          groups: payload.groups,
          tracks: payload.tracks,
        }) as Promise<void>,
    })
  }

  /** 终止 Worker 并清空等待表；调用后本实例不可再用 */
  destroy(): void {
    this.worker.terminate()
    this.pending.clear()
  }
}

interface ChangePayload {
  mutations: Mutation[]
  history: Operation[]
  groups: Group[]
  tracks: Track[]
}
