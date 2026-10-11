/**
 * 数据 Worker：SQLite(WASM) + OPFS(opfs-sahpool) 全部在这里运行。
 *
 * 为什么必须在 Worker：
 * - OPFS 的同步访问句柄（FileSystemSyncAccessHandle）只在 Worker 可用；
 * - SQLite 是同步 WASM，放主线程会阻塞渲染。
 *
 * Worker 内还有一层顺序执行队列：接收到的请求按到达顺序逐个处理，
 * 保证不会出现交叉事务（主线程的 TaskQueue 负责合并与调度）。
 */
import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm'
import { migrate } from './schema'
import * as repo from './repository'
import type { Request, Response, WorkerInitInfo } from './protocol'

/** 只用到 postMessage / onmessage 的最小 Worker 全局类型 */
interface WorkerScope {
  postMessage(message: unknown): void
  onmessage: ((event: MessageEvent) => void) | null
}

const scope = self as unknown as WorkerScope

let db: Database | null = null
let initInfo: WorkerInitInfo | null = null
// 初始化立即开始，请求处理前会 await 它，保证第一条请求也拿到已就绪的库
const ready: Promise<void> = initialize()

/**
 * 初始化 SQLite WASM 并尽量挂载 OPFS(opfs-sahpool) 持久化：
 * 优先 OPFS 同步访问句柄；不支持或失败时退化为内存库，并记录降级原因。
 */
async function initialize(): Promise<void> {
  const sqlite3 = await sqlite3InitModule()
  const sqliteVersion = sqlite3.version.libVersion
  let opened: Database | null = null
  let mode: WorkerInitInfo['mode'] = 'memory'
  let message: string | undefined

  if (typeof sqlite3.installOpfsSAHPoolVfs === 'function') {
    try {
      // opfs-sahpool 预分配固定容量，避免 OPFS 反复创建/删除文件的开销
      const pool = await sqlite3.installOpfsSAHPoolVfs({
        name: 'swarmstudio-sahpool',
        directory: 'swarmstudio-sahpool',
        initialCapacity: 6,
      })
      opened = new pool.OpfsSAHPoolDb('/swarmstudio.sqlite3')
      mode = 'opfs-sahpool'
    } catch (err) {
      message = `OPFS(opfs-sahpool) 初始化失败，已降级为内存存储：${(err as Error).message}`
    }
  } else {
    // 例如非安全上下文 / 不支持的浏览器：无同步句柄则无法用 SQLite VFS
    message = '当前环境不支持 OPFS 同步访问句柄，已降级为内存存储（刷新不保留数据）'
  }

  // 兜底：任何原因没能打开 OPFS 库时，用内存库保证功能可用
  if (!opened) {
    opened = new sqlite3.oo1.DB(':memory:', 'c')
  }

  migrate(opened)
  db = opened
  initInfo = { persistent: mode === 'opfs-sahpool', mode, sqliteVersion, message }
}

/** 同步处理单条请求：把协议请求路由到仓储层，返回值由 processLoop 回包 */
function handle(request: Request): unknown {
  const database = db
  const info = initInfo
  if (!database || !info) throw new Error('数据库尚未初始化')

  switch (request.type) {
    case 'init':
      return info
    case 'listProjects':
      return repo.listProjects(database)
    case 'loadProject':
    case 'getProject':
      return repo.loadProject(database, request.projectId)
    case 'createProject':
      repo.insertProject(database, request.project)
      return undefined
    case 'renameProject':
      repo.renameProject(database, request.projectId, request.name)
      return undefined
    case 'deleteProject':
      repo.deleteProject(database, request.projectId)
      return undefined
    case 'listRenders':
      return repo.listRenders(database, request.projectId)
    case 'saveRender':
      repo.saveRender(database, request.projectId, request.render)
      return undefined
    case 'deleteRender':
      repo.deleteRender(database, request.projectId, request.transitionId)
      return undefined
    case 'applyChanges':
      repo.applyChanges(
        database,
        request.projectId,
        request.mutations,
        request.history,
        request.groups,
        request.tracks,
      )
      return undefined
    case 'replaceData':
      repo.replaceData(
        database,
        request.projectId,
        request.points,
        request.history,
        request.groups,
        request.tracks,
      )
      return undefined
  }
}

// -------------------------------------------------- 顺序执行队列

// 请求先进队列，再按到达顺序逐个同步处理，避免并发请求交叉事务
const incoming: Request[] = []
let processing = false

scope.onmessage = (event: MessageEvent) => {
  incoming.push(event.data as Request)
  void processLoop()
}

/** 单飞循环：同一时刻只有一个 loop 在跑，处理完队列再退出 */
async function processLoop(): Promise<void> {
  if (processing) return
  processing = true
  try {
    await ready
    while (incoming.length > 0) {
      const request = incoming.shift()!
      try {
        // 成功与失败都回包，主线程靠 ok 分支 resolve / reject
        const result = handle(request)
        const response: Response = { id: request.id, ok: true, result }
        scope.postMessage(response)
      } catch (err) {
        const response: Response = { id: request.id, ok: false, error: (err as Error).message }
        scope.postMessage(response)
      }
    }
  } finally {
    processing = false
  }
}
