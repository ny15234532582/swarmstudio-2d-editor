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

interface WorkerScope {
  postMessage(message: unknown): void
  onmessage: ((event: MessageEvent) => void) | null
}

const scope = self as unknown as WorkerScope

let db: Database | null = null
let initInfo: WorkerInitInfo | null = null
const ready: Promise<void> = initialize()

async function initialize(): Promise<void> {
  const sqlite3 = await sqlite3InitModule()
  const sqliteVersion = sqlite3.version.libVersion
  let opened: Database | null = null
  let mode: WorkerInitInfo['mode'] = 'memory'
  let message: string | undefined

  if (typeof sqlite3.installOpfsSAHPoolVfs === 'function') {
    try {
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
    message = '当前环境不支持 OPFS 同步访问句柄，已降级为内存存储（刷新不保留数据）'
  }

  if (!opened) {
    opened = new sqlite3.oo1.DB(':memory:', 'c')
  }

  migrate(opened)
  db = opened
  initInfo = { persistent: mode === 'opfs-sahpool', mode, sqliteVersion, message }
}

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
    case 'applyChanges':
      repo.applyChanges(
        database,
        request.projectId,
        request.mutations,
        request.history,
        request.groups,
      )
      return undefined
    case 'replacePoints':
      repo.replacePoints(
        database,
        request.projectId,
        request.points,
        request.history,
        request.groups,
      )
      return undefined
  }
}

// -------------------------------------------------- 顺序执行队列

const incoming: Request[] = []
let processing = false

scope.onmessage = (event: MessageEvent) => {
  incoming.push(event.data as Request)
  void processLoop()
}

async function processLoop(): Promise<void> {
  if (processing) return
  processing = true
  try {
    await ready
    while (incoming.length > 0) {
      const request = incoming.shift()!
      try {
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
