/**
 * 主线程 ↔ Worker 的消息协议。
 *
 * 所有请求都带自增 id，Worker 按 id 回包；result 类型由 client 侧做断言。
 * 请求体里的数据都是可结构化克隆的纯对象（Point / Operation / Mutation / Track）。
 */
import type { Mutation, Operation } from '../core/operations'
import type { Group, Point, ProjectMeta, Track } from '../core/types'

/** 项目元信息（写库用，不含点位/轨道） */
export interface ProjectRecord {
  id: string
  name: string
  version: number
  droneCount: number
  maxSpeed: number
  maxAccel: number
  createdAt: number
  updatedAt: number
}

/** 从库中取出的完整项目：元信息 + 点位/分组/轨道 + 可复用的历史栈 */
export interface LoadedProject {
  project: {
    id: string
    name: string
    version: number
    droneCount: number
    droneLimits: { maxSpeed: number; maxAccel: number }
    createdAt: number
    updatedAt: number
    points: Point[]
    groups: Group[]
    tracks: Track[]
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

/** 过渡产物记录（存 transition_renders 表） */
export interface RenderRecord {
  transitionId: string
  signature: string
  algorithm: string
  payload: string
  elapsedMs: number
  createdAt: number
}

/**
 * 主线程 → Worker 的请求联合类型。
 */
export type Request =
  | { id: number; type: 'init' }
  | { id: number; type: 'listProjects' }
  | { id: number; type: 'loadProject'; projectId: string }
  | { id: number; type: 'getProject'; projectId: string }
  | { id: number; type: 'createProject'; project: ProjectRecord }
  | { id: number; type: 'renameProject'; projectId: string; name: string }
  | { id: number; type: 'deleteProject'; projectId: string }
  | { id: number; type: 'listRenders'; projectId: string }
  | { id: number; type: 'saveRender'; projectId: string; render: RenderRecord }
  | { id: number; type: 'deleteRender'; projectId: string; transitionId: string }
  // 增量落盘：应用一批 mutation，并整体覆盖历史 / 分组 / 轨道结构（同一事务）
  | {
      id: number
      type: 'applyChanges'
      projectId: string
      mutations: Mutation[]
      history: Operation[]
      groups: Group[]
      tracks: Track[]
    }
  // 全量替换项目数据（导入 / 打开），同时重置历史 / 分组 / 轨道
  | {
      id: number
      type: 'replaceData'
      projectId: string
      points: Point[]
      history: Operation[]
      groups: Group[]
      tracks: Track[]
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
  listRenders: RenderRecord[]
  saveRender: void
  deleteRender: void
  applyChanges: void
  replaceData: void
}

/**
 * Worker → 主线程的响应联合类型。
 */
export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
