/**
 * 数据客户端：主线程侧访问数据层的唯一入口。
 *
 * 结构：
 *   业务代码 → DataClient（类型化 API）
 *                 └─ TaskQueue（串行 + 合并）→ postMessage → Worker
 *
 * 所有请求都经过 TaskQueue，因此：
 * - 请求天然串行，Worker 侧不会交叉；
 * - 连续保存会被合并（见 persistChanges 的 key/merge）。
 */
import { TaskQueue } from './queue'
import type { Mutation, Operation } from '../core/operations'
import type { Group, Point, ProjectMeta } from '../core/types'
import type { LoadedProject, ProjectRecord, Request, Response, WorkerInitInfo } from './protocol'

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

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

  private onMessage(response: Response): void {
    const entry = this.pending.get(response.id)
    if (!entry) return
    this.pending.delete(response.id)
    if (response.ok) entry.resolve(response.result)
    else entry.reject(new Error(response.error))
  }

 /** 把请求交给队列，队列保证串行执行 */
  private dispatch(request: Request): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.set(request.id, { resolve, reject })
      this.worker.postMessage(request)
    })
  }

  private send<K extends keyof ResultTypes>(type: K, params: object = {}): Promise<ResultTypes[K]> {
    const request = { id: this.nextId++, type, ...params } as Request
    return this.queue.enqueue<ResultTypes[K], Request>({
      payload: request,
      run: (r) => this.dispatch(r) as Promise<ResultTypes[K]>,
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

  /** 全量替换（导入 / 载入测试数据） */
  replacePoints(
    projectId: string,
    points: Point[],
    history: Operation[],
    groups: Group[],
  ): Promise<void> {
    return this.send('replacePoints', { projectId, points, history, groups })
  }

  /**
   * 增量持久化：提交一批 mutation + 覆盖当前历史与分组。
   * 使用固定 key 做合并——若上一次保存还没发出去，新的 mutation 会并进去，
   * 于是「连续拖动 / 连续改色」只会产生有限次写库。
   */
  persistChanges(
    projectId: string,
    mutations: Mutation[],
    history: Operation[],
    groups: Group[],
  ): Promise<void> {
    return this.queue.enqueue<void, { mutations: Mutation[]; history: Operation[]; groups: Group[] }>({
      key: `changes:${projectId}`,
      payload: { mutations, history, groups },
      merge: (prev, next) => ({
        mutations: [...prev.mutations, ...next.mutations],
        history: next.history,
        groups: next.groups,
      }),
      run: (payload) =>
        this.dispatch({
          id: this.nextId++,
          type: 'applyChanges',
          projectId,
          mutations: payload.mutations,
          history: payload.history,
          groups: payload.groups,
        }) as Promise<void>,
    })
  }

  destroy(): void {
    this.worker.terminate()
    this.pending.clear()
  }
}

/** 请求 → 返回类型映射 */
interface ResultTypes {
  init: WorkerInitInfo
  listProjects: ProjectMeta[]
  loadProject: LoadedProject | null
  getProject: LoadedProject | null
  createProject: void
  renameProject: void
  deleteProject: void
  applyChanges: void
  replacePoints: void
}
