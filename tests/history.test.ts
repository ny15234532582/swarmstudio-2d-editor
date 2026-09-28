import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryManager } from '../src/state/history'
import type { Operation, OperationContext } from '../src/core/operations'
import type { Point, RGB } from '../src/core/types'

function point(id: string, x = 0, y = 0, r = 0, g = 0, b = 0): Point {
  return { id, x, y, z: 0, r, g, b }
}

function createFakeCtx(): { ctx: OperationContext; map: Map<string, Point> } {
  const map = new Map<string, Point>()
  const ctx: OperationContext = {
    addPoints(points) {
      for (const p of points) map.set(p.id, { ...p })
    },
    removePoints(ids) {
      for (const id of ids) map.delete(id)
    },
    setPositions(updates) {
      for (const u of updates) {
        const p = map.get(u.id)
        if (p) {
          p.x = u.x
          p.y = u.y
        }
      }
    },
    setColors(ids: string[], color: RGB) {
      for (const id of ids) {
        const p = map.get(id)
        if (p) {
          p.r = color.r
          p.g = color.g
          p.b = color.b
        }
      }
    },
    addGroup() {},
    removeGroup() {},
    setGroupIds(entries) {
      for (const [id, groupId] of entries) {
        const p = map.get(id)
        if (!p) continue
        if (groupId === null) delete p.groupId
        else p.groupId = groupId
      }
    },
    setLocked(entries) {
      for (const [id, locked] of entries) {
        const p = map.get(id)
        if (!p) continue
        if (locked) p.locked = true
        else delete p.locked
      }
    },
  }
  return { ctx, map }
}

describe('HistoryManager + Operations', () => {
  let ctx: OperationContext
  let map: Map<string, Point>
  let history: HistoryManager

  beforeEach(() => {
    const fake = createFakeCtx()
    ctx = fake.ctx
    map = fake.map
    history = new HistoryManager(ctx, () => {})
  })

  it('新增可撤销可重做', () => {
    history.execute({ kind: 'add', label: '新增点', points: [point('a', 1, 2)] })
    expect(map.has('a')).toBe(true)
    history.undo()
    expect(map.has('a')).toBe(false)
    history.redo()
    expect(map.has('a')).toBe(true)
  })

  it('删除的撤销会恢复完整数据', () => {
    map.set('a', point('a', 5, 6))
    history.execute({ kind: 'remove', label: '删除点', points: [point('a', 5, 6)] })
    expect(map.has('a')).toBe(false)
    history.undo()
    expect(map.get('a')).toEqual(point('a', 5, 6))
  })

  it('移动操作只保存坐标增量', () => {
    map.set('a', point('a', 0, 0))
    const op: Operation = {
      kind: 'move',
      label: '移动点位',
      before: [['a', 0, 0]],
      after: [['a', 10, 20]],
    }
    map.get('a')!.x = 10
    map.get('a')!.y = 20
    history.push(op)

    history.undo()
    expect(map.get('a')).toMatchObject({ x: 0, y: 0 })
    history.redo()
    expect(map.get('a')).toMatchObject({ x: 10, y: 20 })
  })

  it('批量改色可逐点还原原色', () => {
    map.set('a', point('a', 0, 0, 1, 2, 3))
    map.set('b', point('b', 0, 0, 4, 5, 6))
    history.execute({
      kind: 'color',
      label: '修改颜色',
      ids: ['a', 'b'],
      after: { r: 255, g: 255, b: 255 },
      before: [
        ['a', 1, 2, 3],
        ['b', 4, 5, 6],
      ],
    })
    expect(map.get('a')).toMatchObject({ r: 255, g: 255, b: 255 })
    history.undo()
    expect(map.get('a')).toMatchObject({ r: 1, g: 2, b: 3 })
    expect(map.get('b')).toMatchObject({ r: 4, g: 5, b: 6 })
  })

  it('Undo 后执行新操作会清空 Redo 栈', () => {
    history.execute({ kind: 'add', label: '新增点', points: [point('a')] })
    history.undo()
    expect(history.canRedo).toBe(true)
    history.execute({ kind: 'add', label: '新增点', points: [point('b')] })
    expect(history.canRedo).toBe(false)
    expect(map.has('a')).toBe(false)
    expect(map.has('b')).toBe(true)
  })

  it('超过上限时丢弃最旧的记录', () => {
    const onChange = vi.fn()
    const limited = new HistoryManager(ctx, onChange, 2)
    limited.execute({ kind: 'add', label: 'a', points: [point('a')] })
    limited.execute({ kind: 'add', label: 'b', points: [point('b')] })
    limited.execute({ kind: 'add', label: 'c', points: [point('c')] })
    expect(limited.entries).toHaveLength(2)
    limited.undo()
    limited.undo()
    expect(limited.canUndo).toBe(false)
  })

  it('可从持久化条目恢复历史', () => {
    const entries: Operation[] = [
      { kind: 'add', label: '新增点', points: [point('a', 1, 1)] },
    ]
    map.set('a', point('a', 1, 1))
    history.load(entries)
    expect(history.canUndo).toBe(true)
    history.undo()
    expect(map.has('a')).toBe(false)
  })
})
