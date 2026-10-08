/**
 * 主线程 ↔ Worker 的消息协议。
 *
 * 所有请求都带自增 id，Worker 按 id 回包；result 类型由 client 侧做断言。
 * 请求体里的数据都是可结构化克隆的纯对象（Point / Operation / Mutation）。
 */
import type { Mutation, Operation } from '../core/operations'
import type { Group, Point, ProjectMeta } from '../core/types'

/** 项目元信息（写库用，不含 points） */
export interface ProjectRecord {
  id: string
  name: string
  version: number
  createdAt: number
  updatedAt: number
}

/** 从库中取出的完整项目：元信息 + 点位/分组 + 可复用的历史栈 */
export interface LoadedProject {
  project: {
    id: string
    name: string
    version: number
    createdAt: number
    updatedAt: number
    points: Point[]
    groups: Group[]
  }
  history: Operation[]
}

/** Worker 初始化完成后回报给主线程的存储后端信息 */
export interface WorkerInitInfo {
  /** 是否落盘到 OPFS */
  persistent: boolean
  /** 实际使用的存储后端 */
  mode: 'opfs-sahpool' | 'memory'
  sqliteVersion: string
  /** 降级时的说明信息 */
  message?: string
}

/**
 * 主线程 → Worker 的请求联合类型。
 *
 * id 为自增序号，Worker 原样带回，主线程据此把响应配对到对应的 Promise。
 * 除 init / listProjects 外都以 projectId 定位目标项目。
 */
export type Request =
  | { id: number; type: 'init' } // 初始化数据库，返回存储后端信息
  | { id: number; type: 'listProjects' } // 项目摘要列表（含点位数）
  | { id: number; type: 'loadProject'; projectId: string } // 打开项目：读元信息 + 点位 + 分组 + 历史
  | { id: number; type: 'getProject'; projectId: string } // 只读取项目，语义同 loadProject
  | { id: number; type: 'createProject'; project: ProjectRecord } // 插入项目元信息
  | { id: number; type: 'renameProject'; projectId: string; name: string } // 重命名并刷新 updated_at
  | { id: number; type: 'deleteProject'; projectId: string } // 删除项目（子表级联清除）
  // 增量落盘：应用一批 mutation，并整体覆盖历史与分组（同一事务）
  | {
      id: number
      type: 'applyChanges'
      projectId: string
      mutations: Mutation[]
      history: Operation[]
      groups: Group[]
    }
  // 全量替换点位（导入 / 载入测试数据），同时重置历史与分组
  | {
      id: number
      type: 'replacePoints'
      projectId: string
      points: Point[]
      history: Operation[]
      groups: Group[]
    }

/** 请求类型 → 返回结果类型的映射（client 侧据此推断类型） */
export interface RequestResultMap {
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

/**
 * Worker → 主线程的响应联合类型。
 * ok 为 true 时携带 result（具体类型由发起方按 Request 断言），
 * 否则携带 error 文本；两种情况都带同一个 id 供配对。
 */
export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
