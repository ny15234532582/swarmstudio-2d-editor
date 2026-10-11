/**
 * 操作（Operation）—— 数据操作层的公共契约。
 *
 * 所有可撤销操作都被归一化成纯数据的 Operation 描述，既可入内存历史栈，
 * 也可序列化进 SQLite 的 history 表，还可通过 postMessage 传输。
 * 每个 Operation 同时携带正向与反向数据，apply / revert 是无副作用的确定性函数。
 *
 * label 用于 UI 展示（如「移动点位」）。
 */
import type { Frame, Group, Point, PositionUpdate, RGB, Transition } from './types'

/** 移动：只存 id → 坐标的增量，避免整份快照 */
export type MoveEntry = [id: string, x: number, y: number]
/** 颜色：id → rgb */
export type ColorEntry = [id: string, r: number, g: number, b: number]
/** 分组归属：id → groupId（null 表示不属于任何组） */
export type GroupEntry = [id: string, groupId: string | null]
/** 锁定状态：id → locked */
export type LockEntry = [id: string, locked: boolean]

/** 历史栈深度上限，同时也是 SQLite history 表保留的最近记录条数 */
export const HISTORY_LIMIT = 100

export type Operation =
  | { kind: 'add'; label: string; points: Point[] }
  | { kind: 'remove'; label: string; points: Point[] }
  | { kind: 'move'; label: string; before: MoveEntry[]; after: MoveEntry[] }
  | { kind: 'color'; label: string; ids: string[]; after: RGB; before: ColorEntry[] }
  /** 成组：新建 group，并把 members 归入该组；before 记录各自原属组 */
  | { kind: 'group'; label: string; group: Group; members: string[]; before: GroupEntry[] }
  /** 取消分组：移除 group 并清空 members 的归属 */
  | { kind: 'ungroup'; label: string; group: Group; members: string[] }
  /** 锁定 / 解锁：entries 为各自修改前的状态 */
  | { kind: 'lock'; label: string; locked: boolean; entries: LockEntry[] }
  /** 新增帧片段（导入图片）：加帧 + 其点位，插入到 index 位置 */
  | { kind: 'addFrame'; label: string; frame: Frame; points: Point[]; index: number }
  /** 删除帧片段：移除帧 + 其点位 */
  | { kind: 'removeFrame'; label: string; frame: Frame; points: Point[]; index: number }
  /** 修改帧（名称/时长/源图/参数）并替换其点位（帧 id 不变，过渡引用不失效） */
  | {
      kind: 'updateFrame'
      label: string
      frameId: string
      before: Frame
      after: Frame
      beforePoints: Point[]
      afterPoints: Point[]
    }
  /** 修改帧停留时长 */
  | { kind: 'setFrameDuration'; label: string; frameId: string; before: number; after: number }
  /** 调整帧顺序 */
  | { kind: 'moveFrame'; label: string; from: number; to: number }
  /** 新增过渡 */
  | { kind: 'addTransition'; label: string; transition: Transition }
  /** 修改过渡（含新建后编辑） */
  | { kind: 'updateTransition'; label: string; before: Transition; after: Transition }
  /** 删除过渡 */
  | { kind: 'removeTransition'; label: string; transition: Transition }

/**
 * 数据操作层的低层接口。EditorStore 实现它，Operation 只依赖这个接口，
 * 从而让「操作描述」与「具体存储」解耦。
 */
export interface OperationContext {
  addPoints(points: Point[]): void
  removePoints(ids: string[]): void
  setPositions(updates: PositionUpdate[]): void
  setColors(ids: string[], color: RGB): void
  addGroup(group: Group): void
  removeGroup(groupId: string): void
  setGroupIds(entries: GroupEntry[]): void
  setLocked(entries: LockEntry[]): void
  addFrame(frame: Frame, points: Point[], index: number): void
  removeFrame(frameId: string): void
  /** 用新的帧字段与点位整体替换某帧内容（帧 id 不变） */
  updateFrame(frame: Frame, points: Point[]): void
  setFrameDuration(frameId: string, duration: number): void
  moveFrame(from: number, to: number): void
  addTransition(transition: Transition): void
  updateTransition(transition: Transition): void
  removeTransition(transitionId: string): void
}

function entriesToUpdates(entries: MoveEntry[]): PositionUpdate[] {
  return entries.map(([id, x, y]) => ({ id, x, y }))
}

export function applyOperation(ctx: OperationContext, op: Operation): void {
  switch (op.kind) {
    case 'add':
      ctx.addPoints(op.points)
      break
    case 'remove':
      ctx.removePoints(op.points.map((p) => p.id))
      break
    case 'move':
      ctx.setPositions(entriesToUpdates(op.after))
      break
    case 'color':
      ctx.setColors(op.ids, op.after)
      break
    case 'group':
      ctx.addGroup(op.group)
      ctx.setGroupIds(op.members.map((id) => [id, op.group.id]))
      break
    case 'ungroup':
      ctx.setGroupIds(op.members.map((id) => [id, null]))
      ctx.removeGroup(op.group.id)
      break
    case 'lock':
      ctx.setLocked(op.entries.map(([id]) => [id, op.locked]))
      break
    case 'addFrame':
      ctx.addFrame(op.frame, op.points, op.index)
      break
    case 'removeFrame':
      ctx.removeFrame(op.frame.id)
      break
    case 'updateFrame':
      ctx.updateFrame(op.after, op.afterPoints)
      break
    case 'setFrameDuration':
      ctx.setFrameDuration(op.frameId, op.after)
      break
    case 'moveFrame':
      ctx.moveFrame(op.from, op.to)
      break
    case 'addTransition':
      ctx.addTransition(op.transition)
      break
    case 'updateTransition':
      ctx.updateTransition(op.after)
      break
    case 'removeTransition':
      ctx.removeTransition(op.transition.id)
      break
  }
}

export function revertOperation(ctx: OperationContext, op: Operation): void {
  switch (op.kind) {
    case 'add':
      ctx.removePoints(op.points.map((p) => p.id))
      break
    case 'remove':
      ctx.addPoints(op.points)
      break
    case 'move':
      ctx.setPositions(entriesToUpdates(op.before))
      break
    case 'color': {
      // 原色可能各不相同，按颜色分组后批量还原
      const grouped = new Map<string, string[]>()
      for (const [id, r, g, b] of op.before) {
        const key = `${r},${g},${b}`
        const list = grouped.get(key)
        if (list) list.push(id)
        else grouped.set(key, [id])
      }
      for (const [key, ids] of grouped) {
        const [r, g, b] = key.split(',').map(Number)
        ctx.setColors(ids, { r, g, b })
      }
      break
    }
    case 'group':
      ctx.setGroupIds(op.before)
      ctx.removeGroup(op.group.id)
      break
    case 'ungroup':
      ctx.addGroup(op.group)
      ctx.setGroupIds(op.members.map((id) => [id, op.group.id]))
      break
    case 'lock':
      ctx.setLocked(op.entries)
      break
    case 'addFrame':
      ctx.removeFrame(op.frame.id)
      break
    case 'removeFrame':
      ctx.addFrame(op.frame, op.points, op.index)
      break
    case 'updateFrame':
      ctx.updateFrame(op.before, op.beforePoints)
      break
    case 'setFrameDuration':
      ctx.setFrameDuration(op.frameId, op.before)
      break
    case 'moveFrame':
      ctx.moveFrame(op.to, op.from)
      break
    case 'addTransition':
      ctx.removeTransition(op.transition.id)
      break
    case 'updateTransition':
      ctx.updateTransition(op.before)
      break
    case 'removeTransition':
      ctx.addTransition(op.transition)
      break
  }
}

// ------------------------------------------------------------ 持久化增量

/**
 * Mutation —— 真正落到 SQL 的「数据变化」，由 EditorStore 的低层写操作产生。
 * 与 Operation 的区别：Operation 是「可撤销的用户操作」，
 * Mutation 是「已经发生的数据变更」（apply 和 revert 都会产生）。
 * 帧 / 过渡结构通过整体快照落库，因此不含在此。
 */
export type Mutation =
  | { type: 'add'; points: Point[] }
  | { type: 'remove'; ids: string[] }
  | { type: 'move'; updates: PositionUpdate[] }
  | { type: 'color'; ids: string[]; color: RGB }
  | { type: 'setGroup'; entries: GroupEntry[] }
  | { type: 'setLocked'; entries: LockEntry[] }
