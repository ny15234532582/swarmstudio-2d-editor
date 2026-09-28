/**
 * 核心业务数据类型定义。
 *
 * 设计原则：这里定义的是「项目事实源」的数据结构，与渲染层 / 界面层无关。
 * PixiJS 的 DisplayObject、选中状态等都不属于此文件。
 */

/** 单个点位。x/y/z 为业务坐标，z 只做保存/导入导出，画布按 XY 显示。 */
export interface Point {
  id: string
  x: number
  y: number
  z: number
  r: number
  g: number
  b: number
  groupId?: string
}

/** RGB 颜色，各通道 0~255 整数。 */
export interface RGB {
  r: number
  g: number
  b: number
}

/** 项目元信息与数据。version 用于后续数据格式迁移。 */
export interface Project {
  /** 数据格式版本，迁移依据 */
  version: number
  /** 项目唯一 id（也是 OPFS 目录名） */
  id: string
  name: string
  createdAt: number
  updatedAt: number
  points: Point[]
}

/** 当前支持的项目数据版本 */
export const PROJECT_VERSION = 1

/** 项目列表项（不加载完整点位，便于列表展示） */
export interface ProjectMeta {
  id: string
  name: string
  version: number
  pointCount: number
  createdAt: number
  updatedAt: number
}

/** 位置更新，用于拖动/移动的增量更新 */
export interface PositionUpdate {
  id: string
  x: number
  y: number
}

/** 世界坐标下的矩形，用于框选 */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface Vec2 {
  x: number
  y: number
}

/** 创建点位时除 id 外的可选字段 */
export type PointInit = Omit<Point, 'id'>
