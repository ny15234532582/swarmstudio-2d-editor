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

export interface WorkerInitInfo {
  /** 是否落盘到 OPFS */
  persistent: boolean
  /** 实际使用的存储后端 */
  mode: 'opfs-sahpool' | 'memory'
  sqliteVersion: string
  /** 降级时的说明信息 */
  message?: string
}

export type Request =
  | { id: number; type: 'init' }
  | { id: number; type: 'listProjects' }
  | { id: number; type: 'loadProject'; projectId: string }
  | { id: number; type: 'getProject'; projectId: string }
  | { id: number; type: 'createProject'; project: ProjectRecord }
  | { id: number; type: 'renameProject'; projectId: string; name: string }
  | { id: number; type: 'deleteProject'; projectId: string }
  | {
      id: number
      type: 'applyChanges'
      projectId: string
      mutations: Mutation[]
      history: Operation[]
      groups: Group[]
    }
  | {
      id: number
      type: 'replacePoints'
      projectId: string
      points: Point[]
      history: Operation[]
      groups: Group[]
    }

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

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string }
