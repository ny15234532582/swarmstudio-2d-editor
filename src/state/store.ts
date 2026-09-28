/**
 * EditorStore —— 编辑器的运行时事实源（Single Source of Truth）。
 *
 * 职责边界（对应题目 6.1 / 6.2）：
 * - 持有 project 业务数据（普通对象，非响应式，避免两万+ 点的代理开销）。
 * - 维护 id → Point 索引与空间网格缓存（派生数据）。
 * - 维护 selection 选中状态（界面临时状态，不属于项目数据）。
 * - 对外广播两类流：
 *     ① 渲染事件（points:* / selection:*）—— 供 Pixi / UI 增量更新；
 *     ② mutation 流 —— 只包含**已提交**的数据变更，供数据层写 SQL。
 *   拖动过程的瞬时更新只走 ①，不产生 ②，因此不会触发持久化。
 * - 所有可撤销操作都被归一化为 core/operations 的 Operation。
 */
import { Emitter } from './emitter'
import { HistoryManager } from './history'
import { SpatialGrid } from '../core/spatial'
import { createGroup, createPoint } from '../core/factory'
import type {
  GroupEntry,
  LockEntry,
  MoveEntry,
  Mutation,
  Operation,
  OperationContext,
} from '../core/operations'
import type { Group, Point, PointInit, PositionUpdate, Project, RGB } from '../core/types'

export type EditorEvents = {
  'project:load': undefined
  'points:add': { ids: string[] }
  'points:remove': { ids: string[] }
  'points:move': { ids: string[] }
  'points:color': { ids: string[] }
  /** 锁定状态变化（渲染层据此调整明暗） */
  'points:lock': { ids: string[] }
  /** 分组结构 / 归属变化（UI 列表据此刷新） */
  'groups:change': undefined
  'selection:change': undefined
  'history:change': undefined
  /** 已提交的数据变更（用于持久化） */
  'mutation': Mutation
  /** 项目数据发生变化（需要保存） */
  'dirty': undefined
}

export type SelectMode = 'replace' | 'add' | 'toggle'

export class EditorStore {
  project: Project
  readonly selection = new Set<string>()
  readonly history: HistoryManager
  readonly events = new Emitter<EditorEvents>()

  private pointById = new Map<string, Point>()
  private groupById = new Map<string, Group>()
  private spatial = new SpatialGrid(64)
  private spatialDirty = true

  /** 已提交的数据操作入口：先改数据（触发渲染事件），再广播 mutation */
  private readonly ctx: OperationContext = {
    addPoints: (points) => {
      this.mutateAdd(points)
      this.events.emit('mutation', { type: 'add', points })
    },
    removePoints: (ids) => {
      this.mutateRemove(ids)
      this.events.emit('mutation', { type: 'remove', ids })
    },
    setPositions: (updates) => {
      this.mutateMove(updates)
      this.events.emit('mutation', { type: 'move', updates })
    },
    setColors: (ids, color) => {
      this.mutateColor(ids, color)
      this.events.emit('mutation', { type: 'color', ids, color })
    },
    // 分组结构本身通过 applyChanges 的 groups 快照整体落库；
    // 点位的归属变化则是点级 mutation
    addGroup: (group) => this.mutateAddGroup(group),
    removeGroup: (groupId) => this.mutateRemoveGroup(groupId),
    setGroupIds: (entries) => {
      this.mutateSetGroupIds(entries)
      this.events.emit('mutation', { type: 'setGroup', entries })
    },
    setLocked: (entries) => {
      this.mutateSetLocked(entries)
      this.events.emit('mutation', { type: 'setLocked', entries })
    },
  }

  constructor(project: Project) {
    this.project = project
    this.rebuildIndex()
    this.history = new HistoryManager(this.ctx, () => {
      this.events.emit('history:change', undefined)
      this.markDirty()
    })
  }

  // ---------------------------------------------------------------- 载入

  loadProject(project: Project, history: Operation[] = []): void {
    this.project = project
    this.selection.clear()
    this.rebuildIndex()
    this.history.load(history)
    this.events.emit('project:load', undefined)
    this.events.emit('selection:change', undefined)
  }

  setProjectName(name: string): void {
    this.project.name = name
    this.markDirty()
  }

  get pointCount(): number {
    return this.project.points.length
  }

  get selectedCount(): number {
    return this.selection.size
  }

  private rebuildIndex(): void {
    this.pointById.clear()
    for (const p of this.project.points) this.pointById.set(p.id, p)
    if (!Array.isArray(this.project.groups)) this.project.groups = []
    this.groupById.clear()
    for (const g of this.project.groups) this.groupById.set(g.id, g)
    this.spatialDirty = true
  }

  getPoint(id: string): Point | undefined {
    return this.pointById.get(id)
  }

  getSpatial(): SpatialGrid {
    if (this.spatialDirty) {
      this.spatial.rebuild(this.project.points)
      this.spatialDirty = false
    }
    return this.spatial
  }

  getSelectedPoints(): Point[] {
    const result: Point[] = []
    for (const id of this.selection) {
      const p = this.pointById.get(id)
      if (p) result.push(p)
    }
    return result
  }

  // ---------------------------------------------------------------- 分组

  get groups(): Group[] {
    return this.project.groups
  }

  getGroup(id: string): Group | undefined {
    return this.groupById.get(id)
  }

  getGroupMembers(groupId: string): Point[] {
    return this.project.points.filter((p) => p.groupId === groupId)
  }

  getGroupMemberCount(groupId: string): number {
    let count = 0
    for (const p of this.project.points) if (p.groupId === groupId) count++
    return count
  }

  /** 组内是否所有点都已锁定（用于 UI 显示组锁状态） */
  isGroupLocked(groupId: string): boolean {
    const members = this.getGroupMembers(groupId)
    return members.length > 0 && members.every((p) => p.locked === true)
  }

  // --------------------------------------------------- 低层数据操作（不改历史）

  private mutateAdd(points: Point[]): void {
    for (const p of points) {
      if (this.pointById.has(p.id)) continue
      this.project.points.push(p)
      this.pointById.set(p.id, p)
    }
    this.spatialDirty = true
    this.events.emit('points:add', { ids: points.map((p) => p.id) })
  }

  private mutateRemove(ids: string[]): void {
    const idSet = new Set(ids)
    this.project.points = this.project.points.filter((p) => !idSet.has(p.id))
    for (const id of ids) {
      this.pointById.delete(id)
      this.selection.delete(id)
    }
    this.spatialDirty = true
    this.events.emit('points:remove', { ids })
    this.events.emit('selection:change', undefined)
  }

  private mutateMove(updates: PositionUpdate[]): void {
    const ids: string[] = []
    for (const u of updates) {
      const p = this.pointById.get(u.id)
      if (!p) continue
      p.x = u.x
      p.y = u.y
      ids.push(u.id)
    }
    this.spatialDirty = true
    this.events.emit('points:move', { ids })
  }

  private mutateColor(ids: string[], color: RGB): void {
    for (const id of ids) {
      const p = this.pointById.get(id)
      if (!p) continue
      p.r = color.r
      p.g = color.g
      p.b = color.b
    }
    this.events.emit('points:color', { ids })
  }

  private mutateAddGroup(group: Group): void {
    if (this.groupById.has(group.id)) return
    this.project.groups.push(group)
    this.groupById.set(group.id, group)
    this.events.emit('groups:change', undefined)
  }

  private mutateRemoveGroup(groupId: string): void {
    this.project.groups = this.project.groups.filter((g) => g.id !== groupId)
    this.groupById.delete(groupId)
    this.events.emit('groups:change', undefined)
  }

  private mutateSetGroupIds(entries: GroupEntry[]): void {
    for (const [id, groupId] of entries) {
      const p = this.pointById.get(id)
      if (!p) continue
      if (groupId === null) delete p.groupId
      else p.groupId = groupId
    }
    this.events.emit('groups:change', undefined)
  }

  private mutateSetLocked(entries: LockEntry[]): void {
    const ids: string[] = []
    for (const [id, locked] of entries) {
      const p = this.pointById.get(id)
      if (!p) continue
      if (locked) p.locked = true
      else delete p.locked
      ids.push(id)
      // 锁定的点立即移出选择，避免被后续删除/改色影响
      if (locked) this.selection.delete(id)
    }
    this.events.emit('points:lock', { ids })
    if (ids.length > 0) this.events.emit('selection:change', undefined)
  }

  // ------------------------------------------------------------- 可撤销操作

  addPoint(init: PointInit): Point {
    const point = createPoint(init)
    this.history.execute({ kind: 'add', label: '新增点', points: [point] })
    this.select(point.id, 'replace')
    return point
  }

  addPoints(points: Point[]): void {
    this.history.execute({
      kind: 'add',
      label: `新增 ${points.length} 个点`,
      points,
    })
  }

  deletePoints(ids: string[]): void {
    const points = ids
      .map((id) => this.pointById.get(id))
      // 锁定的点不允许删除
      .filter((p): p is Point => p !== undefined && p.locked !== true)
    if (points.length === 0) return
    this.history.execute({
      kind: 'remove',
      label: points.length > 1 ? `删除 ${points.length} 个点` : '删除点',
      points,
    })
  }

  deleteSelected(): void {
    if (this.selection.size === 0) return
    this.deletePoints([...this.selection])
  }

  setColorForSelection(color: RGB): void {
    if (this.selection.size === 0) return
    const ids = [...this.selection]
    const before: [string, number, number, number][] = []
    for (const id of ids) {
      const p = this.pointById.get(id)
      if (p) before.push([id, p.r, p.g, p.b])
    }
    this.history.execute({ kind: 'color', label: '修改颜色', ids, after: color, before })
  }

  /** 拖动中的瞬时预览：只改数据 + 重绘，不写历史、不产生 mutation */
  previewMove(updates: PositionUpdate[]): void {
    this.mutateMove(updates)
  }

  /** 拖动结束：把本次位移作为一条 move Operation 入历史 */
  commitMove(before: Map<string, { x: number; y: number }>): void {
    const beforeEntries: MoveEntry[] = []
    const afterEntries: MoveEntry[] = []
    let moved = false
    for (const [id, prev] of before) {
      const p = this.pointById.get(id)
      if (!p) continue
      if (p.x !== prev.x || p.y !== prev.y) moved = true
      beforeEntries.push([id, prev.x, prev.y])
      afterEntries.push([id, p.x, p.y])
    }
    if (!moved) return
    // 拖动过程走的是 previewMove（不产生 mutation），
    // 因此这里需要显式广播最终位移，供数据层增量写库。
    this.events.emit('mutation', {
      type: 'move',
      updates: afterEntries.map(([id, x, y]) => ({ id, x, y })),
    })
    this.history.push({ kind: 'move', label: '移动点位', before: beforeEntries, after: afterEntries })
  }

  undo(): void {
    this.history.undo()
  }

  redo(): void {
    this.history.redo()
  }

  // ------------------------------------------------------------ 分组 / 锁定

  /** 把当前选中的点归为一个新组（可撤销） */
  groupSelection(name?: string): Group | null {
    if (this.selection.size === 0) return null
    const members = [...this.selection]
    const group = createGroup(name ?? `分组 ${this.project.groups.length + 1}`, this.project.groups.length)
    const before: GroupEntry[] = members.map((id) => [id, this.pointById.get(id)?.groupId ?? null])
    this.history.execute({ kind: 'group', label: '成组', group, members, before })
    return group
  }

  /** 解散一个组：清空组内点的归属并移除该组（可撤销） */
  ungroup(groupId: string): void {
    const group = this.groupById.get(groupId)
    if (!group) return
    const members = this.getGroupMembers(groupId).map((p) => p.id)
    this.history.execute({ kind: 'ungroup', label: '取消分组', group, members })
  }

  renameGroup(groupId: string, name: string): void {
    const group = this.groupById.get(groupId)
    if (!group || !name.trim()) return
    group.name = name.trim()
    this.events.emit('groups:change', undefined)
    this.markDirty()
  }

  /** 批量设置锁定状态（锁定的点会自动移出选择） */
  setLocked(ids: string[], locked: boolean): void {
    const entries: LockEntry[] = []
    for (const id of ids) {
      const p = this.pointById.get(id)
      if (!p) continue
      if ((p.locked === true) === locked) continue
      entries.push([id, p.locked === true])
    }
    if (entries.length === 0) return
    this.history.execute({
      kind: 'lock',
      label: locked ? '锁定点位' : '解锁点位',
      locked,
      entries,
    })
  }

  setLockedForSelection(locked: boolean): void {
    if (this.selection.size === 0) return
    this.setLocked([...this.selection], locked)
  }

  /** 组锁定 = 批量锁定组内所有点 */
  setLockedForGroup(groupId: string, locked: boolean): void {
    const ids = this.getGroupMembers(groupId).map((p) => p.id)
    this.setLocked(ids, locked)
  }

  /** 解锁全部锁定点 */
  unlockAll(): void {
    const ids: string[] = []
    for (const p of this.project.points) if (p.locked) ids.push(p.id)
    this.setLocked(ids, false)
  }

  /** 选中某个组的所有未锁定点 */
  selectGroup(groupId: string, mode: SelectMode = 'replace'): void {
    this.selectMany(
      this.getGroupMembers(groupId).map((p) => p.id),
      mode,
    )
  }

  // ---------------------------------------------------------------- 选中

  select(id: string, mode: SelectMode = 'replace'): void {
    this.selectMany([id], mode)
  }

  selectMany(ids: string[], mode: SelectMode = 'replace'): void {
    if (mode === 'replace') this.selection.clear()
    for (const id of ids) {
      const p = this.pointById.get(id)
      // 锁定点永远不可选（因此也不会被拖动/删除/改色）
      if (!p || p.locked === true) continue
      if (mode === 'toggle' && this.selection.has(id)) this.selection.delete(id)
      else this.selection.add(id)
    }
    this.events.emit('selection:change', undefined)
  }

  clearSelection(): void {
    if (this.selection.size === 0) return
    this.selection.clear()
    this.events.emit('selection:change', undefined)
  }

  private markDirty(): void {
    this.project.updatedAt = Date.now()
    this.events.emit('dirty', undefined)
  }
}
